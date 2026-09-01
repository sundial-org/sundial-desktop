'use client';

import { memo, useCallback, useEffect, useRef, useState, type Dispatch, type DragEvent, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { ArrowsInSimpleIcon, CaretLeftIcon, CaretRightIcon, ChatTeardropIcon, CopyIcon, DotsThreeVerticalIcon, DownloadSimpleIcon, EyeIcon, EyeSlashIcon, FilePlusIcon, FolderMinusIcon, FolderPlusIcon, LightningIcon, LinkIcon, LockSimpleIcon, LockSimpleOpenIcon, PencilSimpleIcon, PlusIcon, PlusSquareIcon, PushPinIcon, ShareNetworkIcon, SparkleIcon, SquareSplitHorizontalIcon, TrashSimpleIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { SidebarSectionHeader } from '@/components/workspace/sidebar-section-header';
import { AnchoredDropdown } from '@/components/workspace/anchored-dropdown';
import { ensureUniquePath, sanitizeFilename } from '@/lib/workspace/uploads';
import { pathShareCoverage } from '@/lib/workspace/path-grants';
import type { PendingUpload } from '@/components/workspace/use-workspace-uploads';
import { ROOT_ORDER_KEY, sortByManualOrder, type FileOrderMap } from '@/lib/workspace/file-order';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { LinkedRepoBadge } from '@/components/workspace/linked-repo-badge';
import type { LinkedRepoSummary } from '@/lib/workspace/use-linked-repos';
import {
  formatFileName,
  getFileName,
  getFolderPath,
  getSidebarListItemStateClasses,
  SIDEBAR_ACTION_MENU_CLASSES,
  SIDEBAR_DRAFT_ROW_CLASSES,
  SIDEBAR_ENTRY_ROW_CLASSES,
  LocalRootGlyph,
  setSidebarDragGhost,
  WORKSPACE_ACTIONS_MENU_PATH,
  WorkspaceEntryIcon,
} from './workspace-file-helpers';

// Sentinel openMenuPath for the Files header's ＋ menu (like
// WORKSPACE_ACTIONS_MENU_PATH for the ⋮ menu — only one menu open at a time).
const NEW_ENTRY_MENU_PATH = '__files_new_menu__';

type DraftEntry = {
  id: string;
  type: 'text' | 'folder';
  parentPath: string | null;
  name: string;
};
type RenameEntry = {
  path: string;
  name: string;
  source: 'header' | 'list' | 'tab';
  fileId?: string;
  paneId?: string;
};

function LockedBadge({ locked }: { locked?: boolean }) {
  if (!locked) return null;
  return (
    <LockSimpleIcon
      className="h-3 w-3 flex-shrink-0 text-stone-400"
      weight="fill"
      role="img"
      aria-label="Locked for agents"
    />
  );
}

type FilesTabPanelProps = {
  canWrite: boolean;
  /** Section header title — the workspace/root identity (name + switcher)
      replaces the plain "Files" label. Per-root: a second local root stacks
      its own header below when multi-root lands. */
  title?: ReactNode;
  /** Accordion state: when collapsed, only the Files section header renders. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Connect entry point in the header's ⋮ actions menu; renders only when
      supplied. (GitHub/Overleaf linking moved to the "Open with …" modal.) */
  onConnectLocalAgent?: () => void;
  /** Opens the "Add skill" dialog (install a SKILL.md from a URL or upload). */
  onAddSkill?: () => void;
  /** "+ Add folder…" under the tree: open an OUTSIDE folder as extra context
      (desktop local projects). Absent = the row renders disabled + tooltip. */
  onAddContextFolder?: () => void;
  /** Local multi-root projects: every root (primary first, prefix ''). Extra
      roots render as their own top-level sections in the tree body. */
  localRoots?: { prefix: string; root: string; name: string }[];
  /** Root-row menu: detach a mounted folder (non-destructive, confirm-free). */
  onRemoveRootFolder?: (prefix: string) => void;
  /** Folder menus: start a new chat scoped to that folder. */
  onNewChatInFolder?: (folder: string) => void;
  /** Focus-mode notifications: the page filters the chat rail to the focused
      folder (wireframe chat↔folder placement). Null = focus cleared. */
  onFocusedFolderChange?: (folder: string | null) => void;
  /** Outside-in focus request (doc-header breadcrumb click): scope the tree
      to this folder. The nonce re-fires focus for a repeat click. */
  focusFolderIntent?: { path: string; nonce: number } | null;
  showMetaFiles: boolean;
  setShowMetaFiles: Dispatch<SetStateAction<boolean>>;
  /** Eye toggle: whether agent metadata files (AGENTS.md, skills/, logs/) show in the tree. */
  showAgentMetaFiles?: boolean;
  /** When supplied, renders the eye toggle in the section header. */
  onToggleAgentMetaFiles?: () => void;
  /** Toggle a file's agent lock. Owner-only server-side; errors surface as a toast. */
  onToggleLock?: (file: WorkspaceFileRow) => void | Promise<void>;
  /** Whether the current user can manage locks (workspace owner). */
  canLockFiles?: boolean;
  workspaceFiles: WorkspaceFileRow[];
  selectedFilePath: string;
  setSelectedFilePath: Dispatch<SetStateAction<string>>;
  setExpandedFolders: Dispatch<SetStateAction<Set<string>>>;
  fileUploadInputRef: MutableRefObject<HTMLInputElement | null>;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  /** Whether the create target (the active file's folder / the root) accepts
   *  new entries — an exact-file grant must not surface a no-op ＋ menu. */
  canCreateEntries?: boolean;
  /** The header ＋ menu's target folder (the active file's folder), so its
   *  Upload lands beside New file — not silently at the root. */
  createParentPath?: string | null;
  onQueueFileUploads: (files: File[], targetFolder: string | null) => void;
  isFilesDropActive: boolean;
  setIsFilesDropActive: Dispatch<SetStateAction<boolean>>;
  dragOverPath: string | null;
  setDragOverPath: Dispatch<SetStateAction<string | null>>;
  onDropToFolder: (event: DragEvent<HTMLDivElement>, targetFolder: string | null) => void;
  fileUploads: PendingUpload[];
  onRemoveUpload: (uploadId: string) => void;
  draftEntry: DraftEntry | null;
  setDraftEntry: Dispatch<SetStateAction<DraftEntry | null>>;
  draftInputRef: MutableRefObject<HTMLInputElement | null>;
  draftIdRef: MutableRefObject<number>;
  buildDraftName: (type: DraftEntry['type'], folder: string | null) => string;
  onCommitDraft: () => Promise<void>;
  onCancelDraft: () => void;
  foldersByParent: Record<string, string[]>;
  filesByFolder: Record<string, WorkspaceFileRow[]>;
  rootFiles: WorkspaceFileRow[];
  filesLoaded: boolean;
  renameEntry: RenameEntry | null;
  setRenameEntry: Dispatch<SetStateAction<RenameEntry | null>>;
  renameInputRef: MutableRefObject<HTMLInputElement | null>;
  onBeginRename: (path: string, source: RenameEntry['source'], opts?: { fileId?: string; clickEvent?: React.MouseEvent }) => void;
  onMovePath: (sourcePath: string, targetPath: string, options?: { skipReload?: boolean }) => Promise<void>;
  existingPaths: Set<string>;
  workspaceFileByPath: Map<string, WorkspaceFileRow>;
  selectedPaths: Set<string>;
  setSelectedPaths: Dispatch<SetStateAction<Set<string>>>;
  lastClickedPathRef: MutableRefObject<string | null>;
  flatVisiblePaths: string[];
  onOpenFile: (file: WorkspaceFileRow) => void;
  /** Starts the real collab-provider sync before a likely click. */
  onPrefetchFile?: (file: WorkspaceFileRow) => void;
  /** Editor tabs/splits (desktop only — omitted on mobile hides the items). */
  onOpenInNewTab?: (file: WorkspaceFileRow) => void;
  onOpenToSide?: (file: WorkspaceFileRow) => void;
  openMenuPath: string | null;
  setOpenMenuPath: Dispatch<SetStateAction<string | null>>;
  fileMenuRef: MutableRefObject<HTMLDivElement | null>;
  onCopyFileLink: (file: WorkspaceFileRow) => void | Promise<void>;
  onDownloadFile: (file: WorkspaceFileRow) => void;
  onDownloadFolder: (folderPath: string) => void;
  /** Whole-workspace zip export — cloud only (meaningless for a local folder). */
  onDownloadWorkspace?: () => void;
  onDeletePaths: (paths: string[]) => Promise<void>;
  /** Restore the most recently deleted file(s) — bound to Cmd/Ctrl+Z. */
  onUndoDelete: () => Promise<void> | void;
  /** Whether there is a deletion to undo (gates the Cmd/Ctrl+Z handler). */
  canUndoDelete: boolean;
  /** Count of processed delete batches — exposed as data-delete-seq for e2e. */
  deleteSeq?: number;
  onDuplicatePath: (path: string) => Promise<void>;
  expandedFolders: Set<string>;
  onFileDragStart: (event: DragEvent<HTMLDivElement>, filePath: string) => void;
  /** Drag-to-reorder siblings (Obsidian-style manual order). When supplied,
      dragging over the edge of a same-parent, same-kind row shows an insertion
      line and dropping reorders instead of moving. */
  onReorderEntries?: (draggedPaths: string[], targetPath: string, position: 'before' | 'after') => void;
  /** Per-parent manual child order (basenames). Folders and files interleave
      by it, so a file can sit above a folder; without it folders render first. */
  childOrder?: FileOrderMap;
  findRepoForPath?: (path: string) => LinkedRepoSummary | null;
  /** Local projects: share this file/folder to a cloud workspace. The menu
      item renders only when supplied. */
  onShareEntry?: (path: string, kind: 'file' | 'folder') => void;
  /** Workspace-level share (the whole project) — lives in the ⋮ Workspace
      actions menu; renders only when supplied. */
  onShareWorkspace?: () => void;
  /** Scope paths currently live-synced (with their recorded kind — a FILE
      scope never covers a same-named directory) — those rows get a badge. */
  sharedScopePaths?: ReadonlyMap<string, 'file' | 'folder'>;
  /** Namespace (project id) for the pinned-files localStorage key. */
  pinStorageKey?: string;
  /** Badge tooltip/aria text; defaults to the local live-sync wording. */
  sharedBadgeLabel?: string;
  /** Per-row write capability (path-share grants can elevate a subtree past
      the workspace-wide `canWrite` baseline). Defaults to `canWrite`. */
  canWritePath?: (path: string) => boolean;
  /** Whether any path grant actually confers write — keeps write affordances
      (New, delete/undo keys) hidden for pure viewers even though the page
      always passes `canWritePath`. Defaults to the callback's presence. */
  hasWriteGrants?: boolean;
};

export const FilesTabPanel = memo(function FilesTabPanel({
  canWrite,
  title,
  canWritePath,
  hasWriteGrants,
  sharedBadgeLabel,
  collapsed,
  onToggleCollapsed,
  onConnectLocalAgent,
  onAddSkill,
  onAddContextFolder,
  localRoots,
  onRemoveRootFolder,
  onNewChatInFolder,
  onFocusedFolderChange,
  focusFolderIntent = null,
  showMetaFiles,
  showAgentMetaFiles = true,
  onToggleAgentMetaFiles,
  onToggleLock,
  canLockFiles = false,
  workspaceFiles,
  selectedFilePath,
  setSelectedFilePath,
  setExpandedFolders,
  fileUploadInputRef,
  onCreateFile,
  onCreateFolder,
  canCreateEntries,
  createParentPath,
  onQueueFileUploads,
  isFilesDropActive,
  setIsFilesDropActive,
  dragOverPath,
  setDragOverPath,
  onDropToFolder,
  fileUploads,
  onRemoveUpload,
  draftEntry,
  setDraftEntry,
  draftInputRef,
  draftIdRef,
  buildDraftName,
  onCommitDraft,
  onCancelDraft,
  foldersByParent,
  filesByFolder,
  rootFiles,
  filesLoaded,
  renameEntry,
  setRenameEntry,
  renameInputRef,
  onBeginRename,
  onMovePath,
  existingPaths,
  workspaceFileByPath,
  selectedPaths,
  setSelectedPaths,
  lastClickedPathRef,
  flatVisiblePaths,
  onOpenFile,
  onPrefetchFile,
  onOpenInNewTab,
  onOpenToSide,
  openMenuPath,
  setOpenMenuPath,
  fileMenuRef,
  onCopyFileLink,
  onDownloadFile,
  onDownloadFolder,
  onDownloadWorkspace,
  onDeletePaths,
  onUndoDelete,
  canUndoDelete,
  deleteSeq,
  onDuplicatePath,
  expandedFolders,
  onFileDragStart,
  onReorderEntries,
  childOrder,
  findRepoForPath,
  onShareEntry,
  onShareWorkspace,
  sharedScopePaths,
  pinStorageKey,
}: FilesTabPanelProps) {
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null);
  // Wireframe focus scope: double-clicking a folder scopes the tree to just it
  // (breadcrumb + its children); transient, never persisted.
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
  useEffect(() => {
    if (!focusedFolder) return;
    const exists = workspaceFiles.some(
      (file) => file.path === focusedFolder || file.path.startsWith(`${focusedFolder}/`),
    );
    if (!exists) setFocusedFolder(null);
  }, [focusedFolder, workspaceFiles]);
  // Mirror focus to the page (chat-rail filter); cleanup clears it on unmount.
  useEffect(() => {
    onFocusedFolderChange?.(focusedFolder);
    return () => onFocusedFolderChange?.(null);
  }, [focusedFolder, onFocusedFolderChange]);
  // Outside-in focus (doc-header breadcrumb): same scope as a double-clicked
  // folder row; the nonce lets a repeat click on the same crumb re-focus.
  useEffect(() => {
    if (focusFolderIntent?.path) setFocusedFolder(focusFolderIntent.path);
  }, [focusFolderIntent]);
  // Pinned files surface in a distinct area at the top of the tree (wireframe
  // pin behavior); persisted per-project in localStorage.
  const [pinnedPaths, setPinnedPaths] = useState<ReadonlySet<string>>(new Set());
  const pinKey = pinStorageKey ? `sundial:pinned-files:${pinStorageKey}` : null;
  useEffect(() => {
    if (!pinKey) return;
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(pinKey) ?? '[]');
      setPinnedPaths(new Set(Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : []));
    } catch {
      setPinnedPaths(new Set());
    }
  }, [pinKey]);
  const togglePin = useCallback(
    (path: string) => {
      setPinnedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        if (pinKey) {
          try {
            localStorage.setItem(pinKey, JSON.stringify([...next]));
          } catch {}
        }
        return next;
      });
    },
    [pinKey],
  );
  // In-tree drag being tracked for reorder. dataTransfer is unreadable during
  // dragover, so the payload is mirrored here at dragstart; null for OS drags.
  const draggingRef = useRef<{ paths: string[] } | null>(null);
  const [dropHint, setDropHint] = useState<{ path: string; position: 'before' | 'after' } | null>(null);
  const parentKeyOf = (path: string) => getFolderPath(path) ?? ROOT_ORDER_KEY;
  /** Insertion position when this dragover should reorder, else null (→ the
      existing move-into-folder behavior). Same parent only — files and folders
      reorder freely past each other; folder rows reserve their middle band
      for "move into". */
  const reorderPosition = (
    event: DragEvent<HTMLDivElement>,
    path: string,
    isFolder: boolean,
  ): 'before' | 'after' | null => {
    const dragging = draggingRef.current;
    if (!onReorderEntries || !dragging) return null;
    // OS drags (Finder files) always upload, never reorder — guards a stale
    // draggingRef when a move remounted the source row before its dragend.
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) return null;
    if (dragging.paths.includes(path)) return null;
    if (!dragging.paths.every((dragged) => parentKeyOf(dragged) === parentKeyOf(path))) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / Math.max(rect.height, 1);
    if (isFolder) return fraction < 0.3 ? 'before' : fraction > 0.7 ? 'after' : null;
    return fraction < 0.5 ? 'before' : 'after';
  };
  // `reorderable: false` for rows whose order childOrder doesn't render
  // (mounted extra roots follow localRoots) — edge drops fall through to move.
  const handleRowDragOver = (event: DragEvent<HTMLDivElement>, path: string, isFolder: boolean, reorderable = true): void => {
    event.preventDefault();
    const position = reorderable ? reorderPosition(event, path, isFolder) : null;
    setDropHint(position ? { path, position } : null);
    setDragOverPath(position ? null : isFolder ? path : getFolderPath(path));
  };
  /** True when the drop was consumed as a reorder. */
  const handleRowDrop = (event: DragEvent<HTMLDivElement>, path: string, isFolder: boolean, reorderable = true): boolean => {
    const position = reorderable ? reorderPosition(event, path, isFolder) : null;
    const dragged = draggingRef.current?.paths ?? [];
    // Any drop ends the tracked drag — a move-into can remount the source row
    // before its dragend reaches React, which would leave the ref stale.
    endRowDrag();
    if (!position) return false;
    event.preventDefault();
    event.stopPropagation();
    setDragOverPath(null);
    onReorderEntries?.(dragged, path, position);
    return true;
  };
  const endRowDrag = () => {
    draggingRef.current = null;
    setDropHint(null);
  };
  const dropHintStyle = (path: string) =>
    dropHint?.path === path
      ? { boxShadow: `inset 0 ${dropHint.position === 'before' ? '2px' : '-2px'} 0 0 var(--color-orange)` }
      : undefined;
  // Row hover is tracked in JS, not CSS :hover — Chromium strands :hover on
  // the row under the pointer when the window loses focus (alt-tab behind
  // another window) and never clears it, so a stale row stayed highlighted
  // alongside the truly hovered one. One hover key ⇒ one lit row, cleared on
  // window blur and on the pointer leaving the tree.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const prefetchedHoverKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const clear = () => setHoverKey(null);
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, []);
  /** Row spread props: identifies the row for the container's pointerover
      delegation and flags it for the group-data-[hovered] icon reveals. */
  const rowHover = (key: string) => ({
    'data-hover-key': key,
    'data-hovered': hoverKey === key ? '' : undefined,
  });
  // Multi-root (local): every root — the primary included — renders as its
  // own top-level section on equal footing (wireframe: open contexts are
  // sibling rows under the Workspace title). Extra roots' prefix folders
  // leave the ordinary top-level list; the primary root's tree nests under
  // its own collapsible section row instead of rendering bare.
  const extraRootByPrefix = new Map((localRoots ?? []).filter((entry) => entry.prefix).map((entry) => [entry.prefix, entry]));
  const [primaryRootCollapsed, setPrimaryRootCollapsed] = useState(false);
  // A root-level draft (any entry point: section row, empty-area menu, ⌘N)
  // must be visible to name — reopen a collapsed primary section for it.
  useEffect(() => {
    if (draftEntry && draftEntry.parentPath === null) setPrimaryRootCollapsed(false);
  }, [draftEntry]);
  const rootFolders = (foldersByParent.__root__ ?? []).filter((folder) => !extraRootByPrefix.has(folder));
  const hasVisibleRootContent = rootFolders.length > 0 || rootFiles.length > 0 || extraRootByPrefix.size > 0;
  // Pins referencing since-deleted files simply don't render (state keeps them
  // in case the file comes back via undo).
  const pinnedFiles = [...pinnedPaths]
    .map((path) => workspaceFileByPath.get(path))
    .filter((file): file is WorkspaceFileRow => Boolean(file));

  useEffect(() => {
    if (!emptyMenu) return;
    const close = () => setEmptyMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEmptyMenu(null);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [emptyMenu]);

  // Row/header menus and the empty-area menu are mutually exclusive. Their
  // openers stopPropagation (right-click or the ⋮/＋ buttons), so the document
  // click closer above never fires — mirror openCreateContextMenu's
  // setOpenMenuPath(null) by closing this menu whenever one of them opens.
  useEffect(() => {
    if (openMenuPath !== null) setEmptyMenu(null);
  }, [openMenuPath]);

  // Shared anchor for the row/folder/workspace action menus — only one is open
  // at a time, so the open trigger claims this ref and the fixed-positioned
  // AnchoredDropdown escapes the section's overflow clipping.
  const fileMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Target folder for the NEXT shared-input upload: the header ＋ uploads
  // beside the active file, the empty-area menu at the root. Reset on change.
  const uploadTargetRef = useRef<string | null>(null);
  // The scrollable tree container. Cmd+Z (undo delete) is scoped to focus inside
  // it, and a delete refocuses it so undo stays reachable after the row unmounts.
  const treeRef = useRef<HTMLDivElement | null>(null);
  const focusTree = useCallback(() => treeRef.current?.focus({ preventScroll: true }), []);
  const rowCanWrite = useCallback(
    (path: string) => (canWritePath ? canWritePath(path) : canWrite),
    [canWritePath, canWrite],
  );
  // Affordances stay live for path-share EDITORS (per-path checks and the
  // page-level handlers decide what actually runs) — but not for pure
  // viewers, who would otherwise see an enabled New button that no-ops.
  const hasAnyWrite = canWrite || (hasWriteGrants ?? Boolean(canWritePath));

  // Empty-area right-click: actions are ROOT-scoped, so the menu needs the
  // workspace-wide write — except in folder-focus mode, where actions target
  // the focused folder, so a path-share editor's grant on it suffices.
  const canUseEmptyMenu = focusedFolder ? rowCanWrite(focusedFolder) : canWrite;
  const openCreateContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!canUseEmptyMenu) return;
      // Draft/rename inputs keep the native menu (right-click → Paste).
      if ((event.target as HTMLElement).closest('input, textarea')) return;
      event.preventDefault();
      event.stopPropagation();
      setOpenMenuPath(null);
      // Clamp so a click near the viewport edge keeps all three items visible.
      setEmptyMenu({
        x: Math.min(event.clientX, window.innerWidth - 184),
        y: Math.min(event.clientY, window.innerHeight - 128),
      });
    },
    [canUseEmptyMenu, setOpenMenuPath],
  );

  const requestDelete = useCallback(
    (path: string) => {
      const targets =
        selectedPaths.has(path) && selectedPaths.size > 1
          ? Array.from(selectedPaths)
          : [path];
      const result = onDeletePaths(targets);
      focusTree(); // keep focus in the tree so Cmd+Z can undo
      return result;
    },
    [focusTree, onDeletePaths, selectedPaths],
  );

  useEffect(() => {
    if (!hasAnyWrite || collapsed) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      if (selectedPaths.size > 0) {
        if (![...selectedPaths].every((path) => rowCanWrite(path))) return;
        event.preventDefault();
        void onDeletePaths(Array.from(selectedPaths));
        focusTree();
        return;
      }
      // Cmd/Ctrl+Delete on a focused file/folder row deletes it, Finder-style.
      if (!(event.metaKey || event.ctrlKey)) return;
      const focusedPath = (document.activeElement as HTMLElement | null)
        ?.closest?.('[data-files-entry]')
        ?.getAttribute('data-files-entry');
      if (!focusedPath || !rowCanWrite(focusedPath)) return;
      event.preventDefault();
      void onDeletePaths([focusedPath]);
      focusTree(); // the row is about to unmount — keep focus in the tree for Cmd+Z
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasAnyWrite, collapsed, focusTree, onDeletePaths, selectedPaths, rowCanWrite]);

  // Cmd/Ctrl+Z restores the last file(s) deleted from the tree. Gated on having
  // something to undo, scoped to focus inside the files tree (a delete refocuses
  // it), and skipped inside inputs/the editor — so it never steals the shortcut
  // from the editor, chat, or a focused control elsewhere on the page.
  useEffect(() => {
    if (!hasAnyWrite || !canUndoDelete) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'z') return;
      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return;
      }
      if (!active?.closest?.('[data-files-panel]')) return;
      event.preventDefault();
      void onUndoDelete();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasAnyWrite, canUndoDelete, onUndoDelete]);

  // Cmd/Ctrl-C then Cmd/Ctrl-V duplicates the selected file(s) in place, like a
  // file manager. Scoped to the tree — a focused row or an active multi-select —
  // so it never steals copy/paste from the editor or a real text selection.
  const copiedPathsRef = useRef<string[]>([]);
  useEffect(() => {
    if (!canWrite || collapsed) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'c' && key !== 'v') return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      const focusedRow = (document.activeElement as HTMLElement | null)?.closest?.('[data-files-entry]') ?? null;
      if (!focusedRow && selectedPaths.size === 0) return;
      if (key === 'c') {
        // Defer to a genuine text selection (e.g. selected filename) over copy.
        if (!(window.getSelection()?.isCollapsed ?? true)) return;
        const focusedPath = focusedRow?.getAttribute('data-files-entry') ?? null;
        const paths = selectedPaths.size > 0 ? Array.from(selectedPaths) : focusedPath ? [focusedPath] : [];
        if (paths.length === 0) return;
        copiedPathsRef.current = paths;
        event.preventDefault();
      } else {
        const paths = copiedPathsRef.current;
        if (paths.length === 0) return;
        event.preventDefault();
        void (async () => {
          for (const path of paths) await onDuplicatePath(path);
        })();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canWrite, collapsed, onDuplicatePath, selectedPaths]);

  const commitListRename = useCallback(async () => {
    if (!renameEntry) return;
    // Per-path: a path-share editor commits renames inside the granted
    // subtree (the same capability that opened the rename control).
    if (!(canWritePath ? canWritePath(renameEntry.path) : canWrite)) return;
    const sourcePath = renameEntry.path;
    const sourceFile = workspaceFileByPath.get(sourcePath);
    const hasChildren = workspaceFiles.some((file) => file.path.startsWith(`${sourcePath}/`));
    const sourceType = sourceFile?.type ?? (hasChildren ? 'folder' : 'text');

    let name = sanitizeFilename(renameEntry.name.trim());
    if (!name) {
      setRenameEntry(null);
      return;
    }
    if (sourceType !== 'folder' && !name.includes('.')) {
      name = `${name}.md`;
    }
    const parentPath = getFolderPath(sourcePath);
    const rawTargetPath = parentPath ? `${parentPath}/${name}` : name;
    if (rawTargetPath === sourcePath) {
      setRenameEntry(null);
      return;
    }

    const targetPath = ensureUniquePath(rawTargetPath, existingPaths);
    await onMovePath(sourcePath, targetPath);
    setRenameEntry(null);
  }, [canWrite, canWritePath, existingPaths, onMovePath, renameEntry, setRenameEntry, workspaceFileByPath, workspaceFiles]);

  const cancelListRename = useCallback(() => {
    setRenameEntry(null);
  }, [setRenameEntry]);

  // Focus + select the rename input the instant it mounts. A stable callback
  // ref fires exactly once on attach, so it can't lose the focus race against
  // the file-open re-render the way the prior requestAnimationFrame did (which
  // intermittently left the input unfocused → next click committed it away).
  const attachRenameInput = useCallback((el: HTMLInputElement | null) => {
    renameInputRef.current = el;
    if (el) {
      el.focus();
      el.select();
    }
  }, [renameInputRef]);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
  }, [setSelectedPaths]);

  const toggleSelection = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, [setSelectedPaths]);

  // flatVisiblePaths (from the page) doesn't know the local primary-section
  // collapse — drop its hidden rows so a shift-range can't sweep up (and
  // bulk-delete) files that aren't on screen.
  const isRowOnScreen = (path: string) =>
    extraRootByPrefix.size === 0 || !primaryRootCollapsed || extraRootByPrefix.has(path.split('/', 1)[0]);
  const handleFileSelect = useCallback((file: WorkspaceFileRow, event: React.MouseEvent) => {
    if (event.shiftKey) {
      event.preventDefault();
      const anchor = lastClickedPathRef.current ?? selectedFilePath;
      if (anchor) {
        const anchorIdx = flatVisiblePaths.indexOf(anchor);
        const targetIdx = flatVisiblePaths.indexOf(file.path);
        if (anchorIdx !== -1 && targetIdx !== -1) {
          const start = Math.min(anchorIdx, targetIdx);
          const end = Math.max(anchorIdx, targetIdx);
          const rangePaths = flatVisiblePaths.slice(start, end + 1).filter(isRowOnScreen);
          if (event.metaKey || event.ctrlKey) {
            setSelectedPaths((prev) => {
              const next = new Set(prev);
              rangePaths.forEach((p) => next.add(p));
              return next;
            });
          } else {
            setSelectedPaths(new Set(rangePaths));
          }
          return;
        }
      }
      setSelectedPaths(new Set([file.path]));
      lastClickedPathRef.current = file.path;
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      toggleSelection(file.path);
      lastClickedPathRef.current = file.path;
      return;
    }
    clearSelection();
    onOpenFile(file);
    lastClickedPathRef.current = file.path;
  }, [clearSelection, flatVisiblePaths, isRowOnScreen, lastClickedPathRef, onOpenFile, selectedFilePath, setSelectedPaths, toggleSelection]);

  // Root-level draft (parentPath null) — shared by the primary-root section
  // row and the empty-area context menu; the effect above reveals it.
  // Both starters carry the page's beginDraft pending-guard: an open draft may
  // be mid-commit (blur fires the async commit, which clears the entry when it
  // resolves) — replacing it now would get wiped by that resolution.
  const beginRootDraft = useCallback((type: DraftEntry['type']) => {
    if (draftEntry) return;
    setDraftEntry({
      id: `draft-${draftIdRef.current++}`,
      type,
      parentPath: null,
      name: buildDraftName(type, null),
    });
  }, [buildDraftName, draftEntry, draftIdRef, setDraftEntry]);

  const beginFolderDraft = useCallback((parentPath: string, type: DraftEntry['type']) => {
    if (draftEntry) return;
    setDraftEntry({
      id: `draft-${draftIdRef.current++}`,
      type,
      parentPath,
      name: buildDraftName(type, parentPath),
    });
    setExpandedFolders((prev) => new Set(prev).add(parentPath));
  }, [buildDraftName, draftEntry, draftIdRef, setDraftEntry, setExpandedFolders]);

  function renderDraftRow(parentPath: string | null) {
    if (!draftEntry || draftEntry.parentPath !== parentPath) return null;

    return (
      <div className={SIDEBAR_DRAFT_ROW_CLASSES}>
        <span className="w-3.5 flex-shrink-0" aria-hidden />
        <WorkspaceEntryIcon
          path={draftEntry.name}
          isFolder={draftEntry.type === 'folder'}
          className="h-[18px] w-[18px] flex-shrink-0"
        />
        <input
          ref={draftInputRef}
          data-testid="files-draft-input"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={draftEntry.name}
          onChange={(event) => setDraftEntry({ ...draftEntry, name: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void onCommitDraft();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onCancelDraft();
            }
          }}
          onBlur={() => void onCommitDraft()}
          className="min-w-0 flex-1 bg-transparent text-left text-stone-800 outline-none placeholder:text-stone-400"
          aria-label={draftEntry.type === 'folder' ? 'New folder name' : 'New file name'}
        />
      </div>
    );
  }

  // 'covered' rows only ride an ancestor scope, most often the whole-project
  // share, where marking every single row says nothing about any one of them.
  const shareCoverage = (path: string): 'scope' | 'covered' | null => {
    if (!sharedScopePaths) return null;
    // Extra-root mounts never sync (the sidecar excludes them from bridges and
    // ledger uploads) — a project-wide scope ('') must not badge them.
    if (extraRootByPrefix.has(path.split('/', 1)[0])) return null;
    return pathShareCoverage(sharedScopePaths, path);
  };
  // Share status rides the entry's OWN icon as a muted corner dot, costing no
  // row width. Persistent on what was actually shared; hover-only on rows
  // merely covered by an ancestor scope, so a project-wide share doesn't
  // stamp the whole tree. Managing the share stays in the ⋮ menu.
  const shareDot = (path: string) => {
    const coverage = shareCoverage(path);
    if (!coverage) return null;
    return (
      <span
        aria-label={sharedBadgeLabel ?? 'Shared'}
        data-testid="shared-entry-badge"
        data-share-coverage={coverage}
        className={`absolute -bottom-px -right-px h-1.5 w-1.5 rounded-full bg-indigo-300 ring-1 ring-white transition-opacity ${
          coverage === 'scope' ? '' : 'opacity-0 group-data-[hovered]:opacity-100 group-focus-within:opacity-100'
        }`}
      />
    );
  };
  // Wraps a row's icon so the share dot can anchor to its corner, and so
  // hovering the icon names what it means (origin and/or share status).
  const entryIcon = (path: string, icon: ReactNode, originLabel?: string) => {
    const coverage = shareCoverage(path);
    const shareLabel = coverage
      ? coverage === 'scope'
        ? (sharedBadgeLabel ?? 'Shared')
        : 'Shared via parent folder'
      : null;
    const label = [originLabel, shareLabel].filter(Boolean).join(' · ');
    return (
      <span className="relative flex flex-shrink-0 items-center">
        {icon}
        {shareDot(path)}
        {label ? <IconTooltip label={label} align="left" /> : null}
      </span>
    );
  };
  // Unpin affordance on the pinned-area rows (pinning a tree row moved into
  // the row's ⋮ menu — data-testid="pin-file" there).
  const pinButton = (path: string) => {
    const isPinned = pinnedPaths.has(path);
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          togglePin(path);
        }}
        aria-label={isPinned ? 'Unpin' : 'Pin to top'}
        aria-pressed={isPinned}
        data-testid="unpin-file"
        className={`relative group/tip leading-none transition-opacity ${
          isPinned
            ? 'text-stone-500 hover:text-stone-700'
            : 'text-stone-400 opacity-0 hover:text-stone-600 group-data-[hovered]:opacity-100 group-focus-within:opacity-100'
        }`}
      >
        <PushPinIcon className="h-3.5 w-3.5" weight={isPinned ? 'fill' : 'regular'} aria-hidden />
        <IconTooltip label={isPinned ? 'Unpin' : 'Pin to top'} />
      </button>
    );
  };
  const shareMenuItem = (path: string, kind: 'file' | 'folder') =>
    // Extra-root entries can't share to cloud workspaces (shares cover the
    // primary root only) — hide the affordance rather than surface the error.
    onShareEntry && !extraRootByPrefix.has(path.split('/', 1)[0]) ? (
      <button
        onClick={(event) => {
          event.stopPropagation();
          setOpenMenuPath(null);
          onShareEntry(path, kind);
        }}
        data-testid="share-entry"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
      >
        <ShareNetworkIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
        {/* The menu answers "is this shared?" too — the row glyph is hover-only
            for anything covered by a folder-wide or project-wide share. */}
        <span>{shareCoverage(path) ? 'Manage sharing' : 'Share'}</span>
      </button>
    ) : null;

  function renderFileActionMenu(file: WorkspaceFileRow) {
    return (
      <div className="relative ml-auto flex items-center gap-0.5" ref={openMenuPath === file.path ? fileMenuRef : null}>
        {/* Hover affordance is copy-link (pin lives in the ⋮ menu now). */}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void onCopyFileLink(file);
          }}
          aria-label="Copy link"
          data-testid="copy-entry-link"
          className="relative group/tip leading-none text-stone-400 opacity-0 transition-opacity hover:text-stone-600 group-data-[hovered]:opacity-100 group-focus-within:opacity-100"
        >
          <LinkIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
          <IconTooltip label="Copy link" />
        </button>
        <button
          type="button"
          ref={openMenuPath === file.path ? fileMenuTriggerRef : undefined}
          onClick={(event) => {
            event.stopPropagation();
            setOpenMenuPath((prev) => (prev === file.path ? null : file.path));
          }}
          aria-label="File options"
          className="relative group/tip opacity-0 group-data-[hovered]:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 hover:text-stone-600 transition-opacity"
        >
          <DotsThreeVerticalIcon className="h-4 w-4" weight="bold" aria-hidden />
          <IconTooltip label="File actions" open={openMenuPath === file.path} />
        </button>
        <AnchoredDropdown
          open={openMenuPath === file.path}
          anchorRef={fileMenuTriggerRef}
          align="right"
          className={SIDEBAR_ACTION_MENU_CLASSES}
        >
            {onOpenInNewTab && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPath(null);
                  onOpenInNewTab(file);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                <PlusSquareIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                <span>Open in new tab</span>
              </button>
            )}
            {onOpenToSide && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPath(null);
                  onOpenToSide(file);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                <SquareSplitHorizontalIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                <span>Open to the side</span>
              </button>
            )}
            <button
              onClick={(event) => {
                event.stopPropagation();
                void onCopyFileLink(file);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              <LinkIcon className="h-3.5 w-3.5 flex-shrink-0" weight="bold" aria-hidden />
              <span>Copy link</span>
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                void navigator.clipboard.writeText(file.path);
                setOpenMenuPath(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              <CopyIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
              <span>Copy path</span>
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                setOpenMenuPath(null);
                togglePin(file.path);
              }}
              data-testid="pin-file"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              <PushPinIcon
                className="h-3.5 w-3.5 flex-shrink-0"
                weight={pinnedPaths.has(file.path) ? 'fill' : 'regular'}
                aria-hidden
              />
              <span>{pinnedPaths.has(file.path) ? 'Unpin' : 'Pin to top'}</span>
            </button>
            {shareMenuItem(file.path, 'file')}
            <button
              onClick={(event) => {
                event.stopPropagation();
                onDownloadFile(file);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              <DownloadSimpleIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
              <span>Download</span>
            </button>
            {canWrite && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPath(null);
                  void onDuplicatePath(file.path);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                <CopyIcon className="h-3.5 w-3.5 flex-shrink-0" weight="bold" aria-hidden />
                <span>Duplicate</span>
              </button>
            )}
            {canLockFiles && onToggleLock && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPath(null);
                  void onToggleLock(file);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                {file.is_locked ? (
                  <LockSimpleOpenIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                ) : (
                  <LockSimpleIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                )}
                <span>{file.is_locked ? 'Unlock file' : 'Lock file'}</span>
              </button>
            )}
            {rowCanWrite(file.path) && (() => {
              const isMulti = selectedPaths.has(file.path) && selectedPaths.size > 1;
              return (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void requestDelete(file.path);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-rose-600 transition-colors hover:bg-rose-50"
                >
                  <TrashSimpleIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                  <span>{isMulti ? `Delete ${selectedPaths.size} items` : 'Delete'}</span>
                </button>
              );
            })()}
        </AnchoredDropdown>
      </div>
    );
  }

  /** One parent's folders + files interleaved per its manual order, so a file
      can sit above a folder. Unordered names keep folders-first. */
  function renderChildren(parentKey: string, folders: string[], files: WorkspaceFileRow[]): React.ReactNode[] {
    return sortByManualOrder(
      [
        ...folders.map((path) => ({ name: getFileName(path), node: renderFolder(path) })),
        ...files.map((file) => ({ name: getFileName(file.path), node: renderFileRow(file) })),
      ],
      (child) => child.name,
      childOrder?.[parentKey],
    ).map((child) => child.node);
  }

  function renderFolder(folder: string): React.ReactNode {
    const folderFiles = filesByFolder[folder] ?? [];
    const childFolders = foldersByParent[folder] ?? [];
    // An extra mounted root's row: labeled with the folder's real name, not
    // renamable/movable/deletable — its menu detaches instead.
    const rootEntry = extraRootByPrefix.get(folder) ?? null;
    const isRenaming = !rootEntry && renameEntry?.path === folder && renameEntry.source === 'list';
    const isExpanded = expandedFolders.has(folder);
    const folderLabel = rootEntry ? rootEntry.name : formatFileName(getFileName(folder));
    const folderRowClasses =
      dragOverPath === folder
        ? 'bg-stone-200/80 text-stone-800'
        : getSidebarListItemStateClasses(false, hoverKey === folder);

    return (
      <div key={folder}>
        <div
          onClick={(event) => {
            if (isRenaming) return;
            // ⌥-click opens the folder as a focus scope (also in the ⋮ menu);
            // plain click toggles expansion. Focus needs no write.
            if (event.altKey) {
              setFocusedFolder(folder);
              return;
            }
            setExpandedFolders((prev) => {
              const next = new Set(prev);
              if (next.has(folder)) next.delete(folder);
              else next.add(folder);
              return next;
            });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!rowCanWrite(folder) || rootEntry) return;
              onBeginRename(folder, 'list');
            }
          }}
          role="button"
          tabIndex={0}
          onDragOver={(event) => {
            if (!rowCanWrite(folder)) return;
            handleRowDragOver(event, folder, true, !rootEntry);
          }}
          onDragLeave={() => {
            setDragOverPath(null);
            setDropHint((prev) => (prev?.path === folder ? null : prev));
          }}
          onDrop={(event) => {
            if (handleRowDrop(event, folder, true, !rootEntry)) return;
            onDropToFolder(event, folder);
          }}
          draggable={rowCanWrite(folder) && !rootEntry}
          onDragStart={(event) => {
            if (!rowCanWrite(folder) || rootEntry) return;
            event.dataTransfer.setData('text/plain', folder);
            event.dataTransfer.effectAllowed = 'move';
            setSidebarDragGhost(event, getFileName(folder));
            draggingRef.current = { paths: [folder] };
          }}
          onDragEnd={endRowDrag}
          style={dropHintStyle(folder)}
          onContextMenu={(event) => {
            if (!rowCanWrite(folder)) return;
            event.preventDefault();
            event.stopPropagation();
            setOpenMenuPath((prev) => (prev === folder ? null : folder));
          }}
          data-files-entry={folder}
          {...rowHover(folder)}
          className={`${SIDEBAR_ENTRY_ROW_CLASSES} ${folderRowClasses}`}
        >
          <span className="flex flex-shrink-0 items-center">
            <CaretRightIcon
              className={`h-3.5 w-3.5 text-stone-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              weight="bold"
              aria-hidden
            />
          </span>
          {entryIcon(
            folder,
            rootEntry ? (
              // Wireframe origin icon: a mounted local folder is "on this device".
              <LocalRootGlyph className="h-[15px] w-[15px] flex-shrink-0 text-stone-400" />
            ) : (
              <WorkspaceEntryIcon path={folder} isFolder className="h-[18px] w-[18px] flex-shrink-0" />
            ),
            rootEntry ? 'Local folder · on this device' : undefined,
          )}
          {isRenaming ? (
            <input
              ref={attachRenameInput}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={renameEntry?.name ?? ''}
              onChange={(event) => setRenameEntry({ path: folder, name: event.target.value, source: 'list' })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void commitListRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelListRename();
                }
              }}
              onBlur={() => void commitListRename()}
              className="min-w-0 flex-1 bg-transparent text-left text-stone-700 outline-none placeholder:text-stone-400"
              aria-label="Rename folder"
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-left" title={rootEntry?.root}>
              <span className="truncate">{folderLabel}</span>
              {(() => {
                const repo = findRepoForPath?.(folder);
                return repo && repo.importedPath.replace(/\/$/, '') === folder ? (
                  <LinkedRepoBadge repo={repo} />
                ) : null;
              })()}
            </span>
          )}
          {rowCanWrite(folder) && (
            // Wireframe row-hover icons (no terminal): new file here + new
            // chat scoped to this folder.
            <div className="ml-auto flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPath(null);
                  beginFolderDraft(folder, 'text');
                }}
                aria-label="New file here"
                className="relative group/tip opacity-0 group-data-[hovered]:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 transition-opacity hover:text-stone-600"
              >
                <FilePlusIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                <IconTooltip label="New file here" />
              </button>
              {onNewChatInFolder ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuPath(null);
                    onNewChatInFolder(folder);
                  }}
                  aria-label="New chat here"
                  data-testid="folder-new-chat"
                  className="relative group/tip opacity-0 group-data-[hovered]:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 transition-opacity hover:text-stone-600"
                >
                  <ChatTeardropIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                  <IconTooltip label="New chat here" />
                </button>
              ) : null}
            </div>
          )}
          {rowCanWrite(folder) && (
            <div className="relative flex items-center" ref={openMenuPath === folder ? fileMenuRef : null}>
              <button
                type="button"
                ref={openMenuPath === folder ? fileMenuTriggerRef : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPath((prev) => (prev === folder ? null : folder));
                }}
                aria-label="Folder options"
                className="relative group/tip opacity-0 group-data-[hovered]:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 hover:text-stone-600 transition-opacity"
              >
                <DotsThreeVerticalIcon className="h-4 w-4" weight="bold" aria-hidden />
                <IconTooltip label="Folder actions" open={openMenuPath === folder} />
              </button>
              <AnchoredDropdown
                open={openMenuPath === folder}
                anchorRef={fileMenuTriggerRef}
                align="right"
                className={SIDEBAR_ACTION_MENU_CLASSES}
              >
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath(null);
                      setFocusedFolder(folder);
                    }}
                    data-testid="focus-folder"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <ArrowsInSimpleIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                    <span className="flex-1">Focus</span>
                    <span className="text-[10px] text-stone-400">⌥ click</span>
                  </button>
                  <div className="my-1 border-t border-stone-100" />
                  {/* Create INSIDE this folder — the same menu serves the ⋮
                      button and the row's right-click. */}
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath(null);
                      beginFolderDraft(folder, 'text');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <FilePlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                    <span>New file</span>
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath(null);
                      beginFolderDraft(folder, 'folder');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <FolderPlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                    <span>New folder</span>
                  </button>
                  {onNewChatInFolder ? (
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenMenuPath(null);
                        onNewChatInFolder(folder);
                      }}
                      data-testid="new-chat-in-folder"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                    >
                      <ChatTeardropIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                      <span>New chat in this folder</span>
                    </button>
                  ) : null}
                  <div className="my-1 border-t border-stone-100" />
                  {rootEntry ? null : (
                  // Rename lives here (and Enter) — double-click now opens the
                  // folder as a focus scope, per the wireframe.
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath(null);
                      onBeginRename(folder, 'list');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <PencilSimpleIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                    <span>Rename</span>
                  </button>
                  )}
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void navigator.clipboard.writeText(folder);
                      setOpenMenuPath(null);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <CopyIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                    <span>Copy path</span>
                  </button>
                  {rootEntry ? null : shareMenuItem(folder, 'folder')}
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onDownloadFolder(folder);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <DownloadSimpleIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                    <span>Download</span>
                  </button>
                  {rootEntry || !rowCanWrite(folder) ? null : (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath(null);
                      void onDuplicatePath(folder);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <CopyIcon className="h-3.5 w-3.5 flex-shrink-0" weight="bold" aria-hidden />
                    <span>Duplicate</span>
                  </button>
                  )}
                  {rootEntry && onRemoveRootFolder ? (
                    // Detaches the mount — never deletes from disk, so no confirm.
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenMenuPath(null);
                        onRemoveRootFolder(folder);
                      }}
                      data-testid="remove-root-folder"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                    >
                      <FolderMinusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                      <span>Remove folder from workspace</span>
                    </button>
                  ) : null}
                  {rootEntry ? null : (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void requestDelete(folder);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-rose-600 transition-colors hover:bg-rose-50"
                  >
                    <TrashSimpleIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                    <span>
                      {selectedPaths.has(folder) && selectedPaths.size > 1
                        ? `Delete ${selectedPaths.size} items`
                        : 'Delete'}
                    </span>
                  </button>
                  )}
              </AnchoredDropdown>
            </div>
          )}
        </div>

        {isExpanded && (
          <div className="ml-5">
            {renderDraftRow(folder)}
            {renderChildren(folder, childFolders, folderFiles)}
          </div>
        )}
      </div>
    );
  }

  /** The primary root as a top-level section — visually the extra-root row
      (caret + device glyph + name + hover creates + ⋮ menu), with its tree
      indented beneath. Only rendered when extra roots exist; a single-root
      project keeps the bare tree. */
  function renderPrimaryRootSection(entry: { prefix: string; root: string; name: string }): React.ReactNode {
    const MENU_KEY = '__primary_root__';
    const isExpanded = !primaryRootCollapsed;
    return (
      <div key={MENU_KEY}>
        <div
          onClick={() => {
            // Collapsing hides every primary-root row — drop them from the
            // selection so a later bulk Delete can't reach invisible files.
            if (!primaryRootCollapsed) {
              setSelectedPaths((sel) => {
                const kept = [...sel].filter((p) => extraRootByPrefix.has(p.split('/', 1)[0]));
                return kept.length === sel.size ? sel : new Set(kept);
              });
            }
            setPrimaryRootCollapsed((prev) => !prev);
          }}
          role="button"
          tabIndex={0}
          onDragOver={(event) => {
            if (!canWrite) return;
            event.preventDefault();
          }}
          onDrop={(event) => onDropToFolder(event, null)}
          onContextMenu={(event) => {
            if (!canWrite) return;
            event.preventDefault();
            event.stopPropagation();
            setOpenMenuPath((prev) => (prev === MENU_KEY ? null : MENU_KEY));
          }}
          data-testid="primary-root-section"
          {...rowHover(MENU_KEY)}
          className={`${SIDEBAR_ENTRY_ROW_CLASSES} ${getSidebarListItemStateClasses(false, hoverKey === MENU_KEY)}`}
        >
          <CaretRightIcon
            className={`h-3.5 w-3.5 flex-shrink-0 text-stone-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            weight="bold"
            aria-hidden
          />
          <LocalRootGlyph className="h-[15px] w-[15px] flex-shrink-0 text-stone-400" />
          <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-left" title={entry.root}>
            <span className="truncate">{entry.name}</span>
          </span>
          {canWrite && (
            <div className="ml-auto flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPath(null);
                  beginRootDraft('text');
                }}
                aria-label="New file here"
                className="relative group/tip opacity-0 group-data-[hovered]:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 transition-opacity hover:text-stone-600"
              >
                <FilePlusIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                <IconTooltip label="New file here" />
              </button>
              {onNewChatInFolder ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuPath(null);
                    onNewChatInFolder('');
                  }}
                  aria-label="New chat here"
                  data-testid="folder-new-chat"
                  className="relative group/tip opacity-0 group-data-[hovered]:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 transition-opacity hover:text-stone-600"
                >
                  <ChatTeardropIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                  <IconTooltip label="New chat here" />
                </button>
              ) : null}
            </div>
          )}
          {canWrite && (
            <div className="relative flex items-center" ref={openMenuPath === MENU_KEY ? fileMenuRef : null}>
              <button
                type="button"
                ref={openMenuPath === MENU_KEY ? fileMenuTriggerRef : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPath((prev) => (prev === MENU_KEY ? null : MENU_KEY));
                }}
                aria-label="Folder options"
                className="relative group/tip opacity-0 group-data-[hovered]:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 hover:text-stone-600 transition-opacity"
              >
                <DotsThreeVerticalIcon className="h-4 w-4" weight="bold" aria-hidden />
                <IconTooltip label="Folder actions" open={openMenuPath === MENU_KEY} />
              </button>
              <AnchoredDropdown
                open={openMenuPath === MENU_KEY}
                anchorRef={fileMenuTriggerRef}
                align="right"
                className={SIDEBAR_ACTION_MENU_CLASSES}
              >
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuPath(null);
                    beginRootDraft('text');
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                >
                  <FilePlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                  <span>New file</span>
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuPath(null);
                    beginRootDraft('folder');
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                >
                  <FolderPlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                  <span>New folder</span>
                </button>
                {onNewChatInFolder ? (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath(null);
                      onNewChatInFolder('');
                    }}
                    data-testid="new-chat-in-folder"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <ChatTeardropIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                    <span>New chat in this folder</span>
                  </button>
                ) : null}
              </AnchoredDropdown>
            </div>
          )}
        </div>
        {isExpanded && (
          <div className="ml-5">
            {renderDraftRow(null)}
            {renderChildren(ROOT_ORDER_KEY, rootFolders, rootFiles)}
          </div>
        )}
      </div>
    );
  }

  function renderFileRow(file: WorkspaceFileRow): React.ReactNode {
    const isFileRenaming = renameEntry?.path === file.path && renameEntry.source === 'list';
    const isSelected = selectedPaths.has(file.path);
    const isActiveFile = selectedFilePath === file.path;
    return (
      <div
        key={file.id}
        onClick={(event) => {
          if (isFileRenaming) return;
          handleFileSelect(file, event);
        }}
        onDoubleClick={(event) => {
          if (!rowCanWrite(file.path) || isFileRenaming) return;
          event.stopPropagation();
          onBeginRename(file.path, 'list');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (!rowCanWrite(file.path)) return;
            onBeginRename(file.path, 'list');
          }
        }}
        role="button"
        tabIndex={0}
        onContextMenu={(event) => {
          if (!rowCanWrite(file.path)) return;
          event.preventDefault();
          event.stopPropagation();
          setOpenMenuPath((prev) => (prev === file.path ? null : file.path));
        }}
        onDragOver={(event) => {
          if (!rowCanWrite(file.path)) return;
          // Dropping mid-row on a file lands in its folder — the row
          // edges reorder among siblings instead.
          handleRowDragOver(event, file.path, false);
        }}
        onDragLeave={() => {
          setDragOverPath(null);
          setDropHint((prev) => (prev?.path === file.path ? null : prev));
        }}
        onDrop={(event) => {
          if (handleRowDrop(event, file.path, false)) return;
          onDropToFolder(event, getFolderPath(file.path));
        }}
        draggable={rowCanWrite(file.path)}
        onDragStart={(event) => {
          onFileDragStart(event, file.path);
          draggingRef.current = {
            paths: selectedPaths.has(file.path) ? Array.from(selectedPaths) : [file.path],
          };
        }}
        onDragEnd={endRowDrag}
        style={dropHintStyle(file.path)}
        data-files-entry={file.path}
        {...rowHover(file.path)}
        className={`${SIDEBAR_ENTRY_ROW_CLASSES} ${
          isSelected
            ? 'bg-stone-200/80 text-stone-800'
            : getSidebarListItemStateClasses(isActiveFile, hoverKey === file.path)
        }`}
      >
        {/* Caret-width spacer: keeps file names on the same grid as folder
            names, whose rows start with the expand caret. */}
        <span className="w-3.5 flex-shrink-0" aria-hidden />
        {entryIcon(
          file.path,
          <WorkspaceEntryIcon path={file.path} className="h-[18px] w-[18px] flex-shrink-0" />,
        )}
        {isFileRenaming ? (
          <input
            ref={attachRenameInput}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={renameEntry?.name ?? ''}
            onChange={(event) =>
              setRenameEntry({ path: file.path, name: event.target.value, source: 'list' })
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commitListRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelListRename();
              }
            }}
            onBlur={() => void commitListRename()}
            className="min-w-0 flex-1 bg-transparent text-left text-stone-700 outline-none placeholder:text-stone-400"
            aria-label="Rename file"
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-left">
            <span className="truncate">{formatFileName(getFileName(file.path))}</span>
          </span>
        )}
        <LockedBadge locked={file.is_locked} />
        {renderFileActionMenu(file)}
      </div>
    );
  }

  return (
    <>
      {/* Sticky within the rail's files scroller: the workspace identity (or
          focus breadcrumb) stays visible while a long tree scrolls under it.
          bg matches the rail (bg-stone-50) so rows don't show through. */}
      <div className="sticky top-0 z-10 bg-stone-50">
      <SidebarSectionHeader
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        label={
          focusedFolder ? (
            // Focus scope swaps the workspace identity header for the folder
            // itself: a back caret (one level up) + its name.
            <span data-testid="focus-breadcrumb" className="flex min-w-0 flex-1 items-center gap-1">
              <button
                type="button"
                onClick={(event) => {
                  // Defensive: if a caller ever wires onToggleCollapsed into
                  // this header, Back must not double as a section collapse.
                  event.stopPropagation();
                  const parent = focusedFolder.split('/').slice(0, -1).join('/');
                  setFocusedFolder(parent || null);
                }}
                aria-label="Back"
                className="relative group/tip flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-200/60 hover:text-stone-600"
              >
                <CaretLeftIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
                <IconTooltip label="Back" />
              </button>
              <span
                className="min-w-0 truncate text-[12px] font-semibold text-stone-600"
                // The folder name is identity, not blank header area — a click
                // on it must not collapse the section (matches the root title).
                onClick={(event) => event.stopPropagation()}
              >
                {extraRootByPrefix.get(focusedFolder)?.name ?? getFileName(focusedFolder)}
              </span>
            </span>
          ) : (
            title ?? 'Files'
          )
        }
        actions={
        <div className="flex items-center gap-1">
          {onToggleAgentMetaFiles ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleAgentMetaFiles();
              }}
              aria-label={showAgentMetaFiles ? 'Hide metadata files' : 'Show metadata files'}
              aria-pressed={!showAgentMetaFiles}
              className={`relative group/tip flex h-7 w-7 items-center justify-center rounded transition-all ${
                showAgentMetaFiles
                  ? // Founder: only surface the eye while the pointer is over the
                    // left rail (group/rail) — but keep it keyboard-reachable.
                    'text-stone-400 opacity-0 hover:bg-stone-200/50 hover:text-stone-600 focus-visible:opacity-100 group-hover/rail:opacity-100'
                  : 'bg-stone-200/70 text-stone-700'
              }`}
            >
              {showAgentMetaFiles ? (
                <EyeIcon className="h-4 w-4" weight="regular" aria-hidden />
              ) : (
                <EyeSlashIcon className="h-4 w-4" weight="regular" aria-hidden />
              )}
              <IconTooltip
                label={showAgentMetaFiles ? 'Hide metadata files' : 'Show metadata files'}
                align="right"
              />
            </button>
          ) : null}
          {/* The header ＋: the one always-visible create entry point. The
              web shell has no tab-strip ＋ and right-click is undiscoverable,
              so without this row-less workspaces can't create anything. */}
          {canCreateEntries ?? hasAnyWrite ? (
            <div className="relative flex items-center" ref={openMenuPath === NEW_ENTRY_MENU_PATH ? fileMenuRef : null}>
              <button
                type="button"
                ref={openMenuPath === NEW_ENTRY_MENU_PATH ? fileMenuTriggerRef : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPath((prev) => (prev === NEW_ENTRY_MENU_PATH ? null : NEW_ENTRY_MENU_PATH));
                }}
                aria-label="New file or folder"
                aria-haspopup="menu"
                aria-expanded={openMenuPath === NEW_ENTRY_MENU_PATH}
                data-testid="files-new-button"
                className="relative group/tip flex h-7 w-7 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-200/50 hover:text-stone-600"
              >
                <PlusIcon className="h-4 w-4" weight="bold" aria-hidden />
                <IconTooltip label="New file or folder" align="right" open={openMenuPath === NEW_ENTRY_MENU_PATH} />
              </button>
              <AnchoredDropdown
                open={openMenuPath === NEW_ENTRY_MENU_PATH}
                anchorRef={fileMenuTriggerRef}
                align="right"
                className={SIDEBAR_ACTION_MENU_CLASSES}
              >
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuPath(null);
                    onCreateFile();
                  }}
                  data-testid="files-new-file"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                >
                  <FilePlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                  New file
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuPath(null);
                    onCreateFolder();
                  }}
                  data-testid="files-new-folder"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                >
                  <FolderPlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                  New folder
                </button>
                {/* Same gate as the menu: the upload now carries the same
                    folder target as New file, so a folder-scoped editor is
                    authorized for it even while workspace canWrite is false. */}
                <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath(null);
                      uploadTargetRef.current = createParentPath ?? null;
                      fileUploadInputRef.current?.click();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <UploadSimpleIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                    Upload files
                  </button>
                {onAddSkill ? (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath(null);
                      // The new skill is revealed in the (gated) tree body, so
                      // expand first or it lands somewhere the user can't see.
                      if (collapsed) onToggleCollapsed?.();
                      onAddSkill();
                    }}
                    data-testid="files-add-skill"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <SparkleIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                    Add skill
                  </button>
                ) : null}
              </AnchoredDropdown>
            </div>
          ) : null}
          {onShareWorkspace || onDownloadWorkspace || (canWrite && onConnectLocalAgent) ? (
          <div className="relative flex items-center" ref={openMenuPath === WORKSPACE_ACTIONS_MENU_PATH ? fileMenuRef : null}>
            <button
              type="button"
              ref={openMenuPath === WORKSPACE_ACTIONS_MENU_PATH ? fileMenuTriggerRef : undefined}
              onClick={(event) => {
                event.stopPropagation();
                setOpenMenuPath((prev) => (prev === WORKSPACE_ACTIONS_MENU_PATH ? null : WORKSPACE_ACTIONS_MENU_PATH));
              }}
              aria-label="Workspace actions"
              className="relative group/tip flex h-7 w-7 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-200/50 hover:text-stone-600"
            >
              <DotsThreeVerticalIcon className="h-4 w-4" weight="bold" aria-hidden />
              <IconTooltip
                label="Workspace actions"
                align="right"
                open={openMenuPath === WORKSPACE_ACTIONS_MENU_PATH}
              />
            </button>
            <AnchoredDropdown
              open={openMenuPath === WORKSPACE_ACTIONS_MENU_PATH}
              anchorRef={fileMenuTriggerRef}
              align="right"
              className={SIDEBAR_ACTION_MENU_CLASSES}
            >
              {onShareWorkspace ? (
                <button
                  data-testid="workspace-actions-share"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuPath(null);
                    onShareWorkspace();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                >
                  <ShareNetworkIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                  Share workspace
                </button>
              ) : null}
              {canWrite && onConnectLocalAgent ? (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuPath(null);
                    onConnectLocalAgent();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                >
                  <LightningIcon className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" weight="fill" aria-hidden />
                  Connect local agent
                </button>
              ) : null}
              {onDownloadWorkspace ? (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onDownloadWorkspace();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                >
                  <DownloadSimpleIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
                  <span>Download zip</span>
                </button>
              ) : null}
            </AnchoredDropdown>
          </div>
          ) : null}
          <input
            ref={fileUploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = event.target.files;
              if (!files || files.length === 0) return;
              onQueueFileUploads(Array.from(files), uploadTargetRef.current);
              uploadTargetRef.current = null;
              event.target.value = '';
            }}
          />
        </div>
        }
      />
      </div>
      {collapsed ? null : (
      <>
      {showMetaFiles && (
        <div className="mx-3 mb-1.5 flex items-start gap-2 rounded-lg border border-stone-300/70 bg-stone-200/60 px-3 py-2 text-[11px] text-stone-600">
          <svg className="mt-px h-3.5 w-3.5 flex-shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>Showing files for advanced customization</span>
        </div>
      )}
      <div
        ref={treeRef}
        data-files-panel=""
        // Observable undo state for e2e specs: whether Cmd+Z has a pending
        // delete to restore, and how many delete batches have been processed
        // (the tests otherwise race the DELETE response handling).
        data-undo-ready={canUndoDelete ? '1' : '0'}
        data-delete-seq={deleteSeq ?? 0}
        tabIndex={-1}
        className="flex-1 overflow-auto px-2 outline-none"
        onPointerOver={(event) => {
          const row = (event.target as HTMLElement).closest('[data-hover-key]') as HTMLElement | null;
          const key = row?.dataset.hoverKey ?? null;
          setHoverKey(key);
          if (key && key !== prefetchedHoverKeyRef.current) {
            prefetchedHoverKeyRef.current = key;
            const path = key.startsWith('pin:') ? key.slice(4) : key;
            const file = workspaceFileByPath.get(path);
            if (file && file.type !== 'folder') onPrefetchFile?.(file);
          }
        }}
        onPointerLeave={() => {
          prefetchedHoverKeyRef.current = null;
          setHoverKey(null);
        }}
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse') return;
          const row = (event.target as HTMLElement).closest('[data-hover-key]') as HTMLElement | null;
          const key = row?.dataset.hoverKey ?? '';
          const path = key.startsWith('pin:') ? key.slice(4) : key;
          const file = workspaceFileByPath.get(path);
          if (file && file.type !== 'folder') onPrefetchFile?.(file);
        }}
        onDragOver={(event) => {
          if (!canWrite) return;
          const types = Array.from(event.dataTransfer.types ?? []);
          if (types.includes('Files')) {
            event.preventDefault();
            setIsFilesDropActive(true);
            return;
          }
          // Just allow the drop; rows own dragOverPath. Setting it here would
          // clobber the folder highlight the row's handler set in this same
          // bubbling event.
          event.preventDefault();
        }}
        onDragLeave={(event) => {
          setDragOverPath(null);
          if (!isFilesDropActive) return;
          const currentTarget = event.currentTarget;
          const relatedTarget = event.relatedTarget as Node | null;
          if (relatedTarget && currentTarget.contains(relatedTarget)) return;
          setIsFilesDropActive(false);
        }}
        onDrop={(event) => {
          endRowDrag(); // root-area drops end the tracked drag too
          onDropToFolder(event, null);
        }}
        onContextMenu={openCreateContextMenu}
      >
        {fileUploads.length > 0 && (
          <div className="px-2 py-2 space-y-1">
            {fileUploads.map((upload) => (
              <div key={upload.id} className="flex items-center gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">
                <span className="truncate">{upload.name}</span>
                {upload.status === 'error' ? (
                  <span className="ml-auto flex items-center gap-2 text-rose-500">
                    {upload.error ?? 'Upload failed'}
                    <button
                      type="button"
                      onClick={() => onRemoveUpload(upload.id)}
                      aria-label="Dismiss"
                      className="relative group/tip text-stone-400 hover:text-stone-600"
                    >
                      ✕
                      <IconTooltip label="Dismiss" />
                    </button>
                  </span>
                ) : (
                  <div className="ml-auto flex items-center gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-stone-200">
                      <div
                        className="h-full bg-stone-500 transition-all"
                        style={{ width: `${Math.round(upload.progress * 100)}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-stone-400">{Math.round(upload.progress * 100)}%</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {focusedFolder ? (
          <>
            {/* Focus scope: the section header carries the folder identity +
                back caret; the body is just this folder's rows. */}
            {renderDraftRow(focusedFolder)}
            {renderChildren(focusedFolder, foldersByParent[focusedFolder] ?? [], filesByFolder[focusedFolder] ?? [])}
            {(foldersByParent[focusedFolder] ?? []).length === 0 &&
              (filesByFolder[focusedFolder] ?? []).length === 0 && (
                <div className="px-2 text-xs text-stone-400">Empty folder.</div>
              )}
          </>
        ) : (
          <>
        {pinnedFiles.length > 0 && (
          // Pinned files surface above the tree (wireframe pin area).
          <div data-testid="pinned-files" className="mb-1">
            {pinnedFiles.map((file) => (
              <div
                key={`pin-${file.id}`}
                role="button"
                tabIndex={0}
                onClick={(event) => handleFileSelect(file, event)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpenFile(file);
                  }
                }}
                {...rowHover(`pin:${file.path}`)}
                className={`${SIDEBAR_ENTRY_ROW_CLASSES} ${getSidebarListItemStateClasses(selectedFilePath === file.path, hoverKey === `pin:${file.path}`)}`}
              >
                <span className="w-3.5 flex-shrink-0" aria-hidden />
                <WorkspaceEntryIcon path={file.path} className="h-[18px] w-[18px] flex-shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">{formatFileName(getFileName(file.path))}</span>
                <span className="ml-auto flex items-center">{pinButton(file.path)}</span>
              </div>
            ))}
          </div>
        )}
        {extraRootByPrefix.size > 0 ? (
          // Multi-root: every root is a sibling top-level section under the
          // Workspace title, primary first (wireframe: equal-footing contexts,
          // no separators). Single-root projects keep the bare tree below.
          (localRoots ?? []).map((entry) =>
            entry.prefix ? renderFolder(entry.prefix) : renderPrimaryRootSection(entry),
          )
        ) : (
          <>
            {renderDraftRow(null)}
            {renderChildren(ROOT_ORDER_KEY, rootFolders, rootFiles)}
          </>
        )}

        {!hasVisibleRootContent && filesLoaded && (
          <div className="px-2 text-xs text-stone-400">No files yet.</div>
        )}
          </>
        )}
        {!focusedFolder && canWrite && (localRoots || onAddContextFolder) && (
          // "+ Add folder…" under the tree: open a folder from ANYWHERE on
          // the computer as extra context (Cowork-style). Local projects only
          // — cloud workspaces have no disk to mount, so no row at all; a
          // local project in a plain browser shows it disabled with the
          // desktop-app hint. Create/upload live in right-click menus.
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onAddContextFolder?.();
            }}
            disabled={!onAddContextFolder}
            title={
              onAddContextFolder
                ? 'Open a folder from your computer as additional context'
                : 'Adding outside folders as context needs a local project in the desktop app'
            }
            data-testid="add-context-row"
            className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-stone-400 enabled:hover:bg-stone-100 enabled:hover:text-stone-600 disabled:cursor-default disabled:opacity-50"
          >
            <PlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
            <span className="truncate">Add context…</span>
          </button>
        )}
      </div>
      {emptyMenu && canUseEmptyMenu && (
        <div
          data-testid="files-empty-context-menu"
          className="fixed z-50 w-44 rounded-lg border border-stone-200 bg-white py-1 text-xs shadow-lg"
          style={{ top: emptyMenu.y, left: emptyMenu.x }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {/* Root scope — except in folder-focus mode, where the whole panel
              IS that folder, so creates land inside it. */}
          <button
            onClick={() => {
              setEmptyMenu(null);
              if (focusedFolder) beginFolderDraft(focusedFolder, 'text');
              else beginRootDraft('text');
            }}
            className="w-full px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
          >
            New file
          </button>
          <button
            onClick={() => {
              setEmptyMenu(null);
              if (focusedFolder) beginFolderDraft(focusedFolder, 'folder');
              else beginRootDraft('folder');
            }}
            className="w-full px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
          >
            New folder
          </button>
          <button
            onClick={() => {
              setEmptyMenu(null);
              // Same scope as the creates — and overwrites a stale target left
              // by a cancelled header-＋ picker (cancel fires no change event).
              uploadTargetRef.current = focusedFolder;
              fileUploadInputRef.current?.click();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
          >
            <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Upload files
          </button>
        </div>
      )}
      </>
      )}
    </>
  );
});
