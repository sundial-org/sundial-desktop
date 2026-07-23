'use client';

import { memo, useCallback, useEffect, useRef, useState, type Dispatch, type DragEvent, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { CaretLeftIcon, CaretRightIcon, ChatTeardropIcon, CopyIcon, DownloadSimpleIcon, EyeIcon, EyeSlashIcon, FilePlusIcon, FileTextIcon, FolderMinusIcon, FolderPlusIcon, GithubLogoIcon, LightningIcon, LinkIcon, LockSimpleIcon, LockSimpleOpenIcon, PencilSimpleIcon, PlusIcon, PlusSquareIcon, PushPinIcon, ShareNetworkIcon, SquareSplitHorizontalIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { SidebarSectionHeader } from '@/components/workspace/sidebar-section-header';
import { AnchoredDropdown } from '@/components/workspace/anchored-dropdown';
import { ensureUniquePath, sanitizeFilename } from '@/lib/workspace/uploads';
import type { PendingUpload } from '@/components/workspace/use-workspace-uploads';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { LinkedRepoBadge } from '@/components/workspace/linked-repo-badge';
import { CopyLinkButton } from '@/components/workspace/copy-link-button';
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
  SharedLiveGlyph,
  WORKSPACE_ACTIONS_MENU_PATH,
  WorkspaceEntryIcon,
} from './workspace-file-helpers';

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

function MoreVerticalIcon({ className }: { className: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6h.01M12 12h.01M12 18h.01" />
    </svg>
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
  /** Connect entry points, folded into the header's ⋮ actions menu. Each
      renders only when its handler is supplied. */
  onAddRepo?: () => void;
  /** Warm the repo list before the add-repo modal opens (hover/focus). */
  onAddRepoHover?: () => void;
  onAddOverleaf?: () => void;
  onConnectLocalAgent?: () => void;
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
  /** Editor tabs/splits (desktop only — omitted on mobile hides the items). */
  onOpenInNewTab?: (file: WorkspaceFileRow) => void;
  onOpenToSide?: (file: WorkspaceFileRow) => void;
  openMenuPath: string | null;
  setOpenMenuPath: Dispatch<SetStateAction<string | null>>;
  fileMenuRef: MutableRefObject<HTMLDivElement | null>;
  onCopyFileLink: (file: WorkspaceFileRow) => void | Promise<void>;
  buildFileUrl: (file: WorkspaceFileRow) => string;
  onDownloadFile: (file: WorkspaceFileRow) => void;
  onDownloadFolder: (folderPath: string) => void;
  /** Whole-workspace zip export — cloud only (meaningless for a local folder). */
  onDownloadWorkspace?: () => void;
  onDeletePaths: (paths: string[]) => Promise<void>;
  /** Restore the most recently deleted file(s) — bound to Cmd/Ctrl+Z. */
  onUndoDelete: () => Promise<void> | void;
  /** Whether there is a deletion to undo (gates the Cmd/Ctrl+Z handler). */
  canUndoDelete: boolean;
  onDuplicatePath: (path: string) => Promise<void>;
  expandedFolders: Set<string>;
  onFileDragStart: (event: DragEvent<HTMLDivElement>, filePath: string) => void;
  /** Drag-to-reorder siblings (Obsidian-style manual order). When supplied,
      dragging over the edge of a same-parent, same-kind row shows an insertion
      line and dropping reorders instead of moving. */
  onReorderEntries?: (draggedPaths: string[], targetPath: string, position: 'before' | 'after') => void;
  findRepoForPath?: (path: string) => LinkedRepoSummary | null;
  /** Local projects: share this file/folder to a cloud workspace. The menu
      item renders only when supplied. */
  onShareEntry?: (path: string, kind: 'file' | 'folder') => void;
  /** Exact scope paths currently live-synced — those rows get a shared badge. */
  sharedScopePaths?: Set<string>;
  /** Namespace (project id) for the pinned-files localStorage key. */
  pinStorageKey?: string;
};

export const FilesTabPanel = memo(function FilesTabPanel({
  canWrite,
  title,
  collapsed,
  onToggleCollapsed,
  onAddRepo,
  onAddRepoHover,
  onAddOverleaf,
  onConnectLocalAgent,
  onAddContextFolder,
  localRoots,
  onRemoveRootFolder,
  onNewChatInFolder,
  onFocusedFolderChange,
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
  onOpenInNewTab,
  onOpenToSide,
  openMenuPath,
  setOpenMenuPath,
  fileMenuRef,
  onCopyFileLink,
  buildFileUrl,
  onDownloadFile,
  onDownloadFolder,
  onDownloadWorkspace,
  onDeletePaths,
  onUndoDelete,
  canUndoDelete,
  onDuplicatePath,
  expandedFolders,
  onFileDragStart,
  onReorderEntries,
  findRepoForPath,
  onShareEntry,
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
  const draggingRef = useRef<{ paths: string[]; kind: 'file' | 'folder' } | null>(null);
  const [dropHint, setDropHint] = useState<{ path: string; position: 'before' | 'after' } | null>(null);
  const parentKeyOf = (path: string) => getFolderPath(path) ?? '__root__';
  /** Insertion position when this dragover should reorder, else null (→ the
      existing move-into-folder behavior). Same parent + same kind only; folder
      rows reserve their middle band for "move into". */
  const reorderPosition = (
    event: DragEvent<HTMLDivElement>,
    path: string,
    isFolder: boolean,
  ): 'before' | 'after' | null => {
    const dragging = draggingRef.current;
    if (!onReorderEntries || !dragging || dragging.kind !== (isFolder ? 'folder' : 'file')) return null;
    if (dragging.paths.includes(path)) return null;
    if (!dragging.paths.every((dragged) => parentKeyOf(dragged) === parentKeyOf(path))) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / Math.max(rect.height, 1);
    if (isFolder) return fraction < 0.3 ? 'before' : fraction > 0.7 ? 'after' : null;
    return fraction < 0.5 ? 'before' : 'after';
  };
  const handleRowDragOver = (event: DragEvent<HTMLDivElement>, path: string, isFolder: boolean): void => {
    event.preventDefault();
    const position = reorderPosition(event, path, isFolder);
    setDropHint(position ? { path, position } : null);
    setDragOverPath(position ? null : isFolder ? path : getFolderPath(path));
  };
  /** True when the drop was consumed as a reorder. */
  const handleRowDrop = (event: DragEvent<HTMLDivElement>, path: string, isFolder: boolean): boolean => {
    const position = reorderPosition(event, path, isFolder);
    setDropHint(null);
    if (!position) return false;
    event.preventDefault();
    event.stopPropagation();
    setDragOverPath(null);
    onReorderEntries?.(draggingRef.current?.paths ?? [], path, position);
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

  // Shared anchor for the row/folder/workspace action menus — only one is open
  // at a time, so the open trigger claims this ref and the fixed-positioned
  // AnchoredDropdown escapes the section's overflow clipping.
  const fileMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The scrollable tree container. Cmd+Z (undo delete) is scoped to focus inside
  // it, and a delete refocuses it so undo stays reachable after the row unmounts.
  const treeRef = useRef<HTMLDivElement | null>(null);
  const focusTree = useCallback(() => treeRef.current?.focus({ preventScroll: true }), []);

  const openCreateContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!canWrite) return;
      event.preventDefault();
      event.stopPropagation();
      setOpenMenuPath(null);
      setEmptyMenu({ x: event.clientX, y: event.clientY });
    },
    [canWrite, setOpenMenuPath],
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
    if (!canWrite || collapsed) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      if (selectedPaths.size > 0) {
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
      if (!focusedPath) return;
      event.preventDefault();
      void onDeletePaths([focusedPath]);
      focusTree(); // the row is about to unmount — keep focus in the tree for Cmd+Z
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canWrite, collapsed, focusTree, onDeletePaths, selectedPaths]);

  // Cmd/Ctrl+Z restores the last file(s) deleted from the tree. Gated on having
  // something to undo, scoped to focus inside the files tree (a delete refocuses
  // it), and skipped inside inputs/the editor — so it never steals the shortcut
  // from the editor, chat, or a focused control elsewhere on the page.
  useEffect(() => {
    if (!canWrite || !canUndoDelete) return;
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
  }, [canWrite, canUndoDelete, onUndoDelete]);

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
    if (!canWrite) return;
    if (!renameEntry) return;
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
  }, [canWrite, existingPaths, onMovePath, renameEntry, setRenameEntry, workspaceFileByPath, workspaceFiles]);

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

  const beginFolderDraft = useCallback((parentPath: string, type: DraftEntry['type']) => {
    setDraftEntry({
      id: `draft-${draftIdRef.current++}`,
      type,
      parentPath,
      name: buildDraftName(type, parentPath),
    });
    setExpandedFolders((prev) => new Set(prev).add(parentPath));
  }, [buildDraftName, draftIdRef, setDraftEntry, setExpandedFolders]);

  function renderDraftRow(parentPath: string | null) {
    if (!draftEntry || draftEntry.parentPath !== parentPath) return null;

    return (
      <div className={SIDEBAR_DRAFT_ROW_CLASSES}>
        <WorkspaceEntryIcon
          path={draftEntry.name}
          isFolder={draftEntry.type === 'folder'}
          className="h-[18px] w-[18px] flex-shrink-0"
        />
        <input
          ref={draftInputRef}
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

  // A path is live-syncing when any enabled scope COVERS it — its own row, an
  // ancestor folder scope, or the whole-project scope (''). Exact-equality
  // badges would show nothing for a project-wide share, which is exactly when
  // the "this is uploading" signal matters most.
  const isSharedPath = (path: string) => {
    if (!sharedScopePaths || sharedScopePaths.size === 0) return false;
    // Extra-root mounts never sync (the sidecar excludes them from bridges and
    // ledger uploads) — a project-wide scope ('') must not badge them.
    if (extraRootByPrefix.has(path.split('/', 1)[0])) return false;
    if (sharedScopePaths.has('') || sharedScopePaths.has(path)) return true;
    for (let idx = path.lastIndexOf('/'); idx > 0; idx = path.lastIndexOf('/', idx - 1)) {
      if (sharedScopePaths.has(path.slice(0, idx))) return true;
    }
    return false;
  };
  // Always-visible share glyph (wireframe icon language: person + filled dot
  // = live-synced). Clicking opens the share surface for that entry.
  const sharedBadge = (path: string, kind: 'file' | 'folder') =>
    isSharedPath(path) ? (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onShareEntry?.(path, kind);
        }}
        aria-label="Shared — manage access"
        data-testid="shared-entry-badge"
        className="relative group/tip shrink-0 leading-none text-stone-500 hover:text-stone-700"
      >
        <SharedLiveGlyph className="h-3.5 w-3.5" />
        <IconTooltip label="Shared — manage access" />
      </button>
    ) : null;
  // Hover pin on file rows; pinned files show the pin always, filled
  // (wireframe: `.ricon.onpin`), and surface in the pinned area up top.
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
        data-testid="pin-file"
        className={`relative group/tip leading-none transition-opacity ${
          isPinned
            ? 'text-stone-500 hover:text-stone-700'
            : 'text-stone-400 opacity-0 hover:text-stone-600 group-hover:opacity-100 group-focus-within:opacity-100'
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
        <span>{isSharedPath(path) ? 'Sharing…' : 'Share…'}</span>
      </button>
    ) : null;

  function renderFileActionMenu(file: WorkspaceFileRow) {
    const fileUrl = buildFileUrl(file);
    return (
      <div className="relative ml-auto flex items-center gap-0.5" ref={openMenuPath === file.path ? fileMenuRef : null}>
        {pinButton(file.path)}
        {fileUrl ? (
          <span className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            <CopyLinkButton url={fileUrl} label="Copy file link" tooltip="Copy file link" className="h-5 w-5" iconClassName="h-3 w-3" />
          </span>
        ) : null}
        <button
          type="button"
          ref={openMenuPath === file.path ? fileMenuTriggerRef : undefined}
          onClick={(event) => {
            event.stopPropagation();
            setOpenMenuPath((prev) => (prev === file.path ? null : file.path));
          }}
          aria-label="File options"
          className="relative group/tip opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 hover:text-stone-600 transition-opacity"
        >
          <MoreVerticalIcon className="h-4 w-4" />
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
            {canWrite && (() => {
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
      dragOverPath === folder ? 'bg-stone-200/80 text-stone-800' : getSidebarListItemStateClasses(false);

    return (
      <div key={folder}>
        <div
          onClick={() => {
            if (isRenaming) return;
            setExpandedFolders((prev) => {
              const next = new Set(prev);
              if (next.has(folder)) next.delete(folder);
              else next.add(folder);
              return next;
            });
          }}
          onDoubleClick={(event) => {
            // Wireframe: double-click opens the folder as a focus scope
            // (rename moved to Enter / the ⋮ menu).
            if (isRenaming) return;
            event.stopPropagation();
            setFocusedFolder(folder);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!canWrite || rootEntry) return;
              onBeginRename(folder, 'list');
            }
          }}
          role="button"
          tabIndex={0}
          onDragOver={(event) => {
            if (!canWrite) return;
            handleRowDragOver(event, folder, true);
          }}
          onDragLeave={() => {
            setDragOverPath(null);
            setDropHint((prev) => (prev?.path === folder ? null : prev));
          }}
          onDrop={(event) => {
            if (handleRowDrop(event, folder, true)) return;
            onDropToFolder(event, folder);
          }}
          draggable={canWrite && !rootEntry}
          onDragStart={(event) => {
            if (!canWrite || rootEntry) return;
            event.dataTransfer.setData('text/plain', folder);
            event.dataTransfer.effectAllowed = 'move';
            setSidebarDragGhost(event, getFileName(folder));
            draggingRef.current = { paths: [folder], kind: 'folder' };
          }}
          onDragEnd={endRowDrag}
          style={dropHintStyle(folder)}
          onContextMenu={(event) => {
            if (!canWrite) return;
            event.preventDefault();
            event.stopPropagation();
            setOpenMenuPath((prev) => (prev === folder ? null : folder));
          }}
          data-files-entry={folder}
          className={`${SIDEBAR_ENTRY_ROW_CLASSES} ${folderRowClasses}`}
        >
          <CaretRightIcon
            className={`h-3.5 w-3.5 flex-shrink-0 text-stone-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            weight="bold"
            aria-hidden
          />
          {rootEntry ? (
            // Wireframe origin icon: a mounted local folder is "on this device".
            <LocalRootGlyph className="h-[15px] w-[15px] flex-shrink-0 text-stone-400" />
          ) : (
            <WorkspaceEntryIcon path={folder} isFolder className="h-[18px] w-[18px] flex-shrink-0" />
          )}
          {isRenaming ? (
            <input
              ref={attachRenameInput}
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
              {sharedBadge(folder, 'folder')}
              {(() => {
                const repo = findRepoForPath?.(folder);
                return repo && repo.importedPath.replace(/\/$/, '') === folder ? (
                  <LinkedRepoBadge repo={repo} />
                ) : null;
              })()}
            </span>
          )}
          {canWrite && (
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
                className="relative group/tip opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 transition-opacity hover:text-stone-600"
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
                  className="relative group/tip opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 transition-opacity hover:text-stone-600"
                >
                  <ChatTeardropIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                  <IconTooltip label="New chat here" />
                </button>
              ) : null}
            </div>
          )}
          {canWrite && (
            <div className="relative flex items-center" ref={openMenuPath === folder ? fileMenuRef : null}>
              <button
                type="button"
                ref={openMenuPath === folder ? fileMenuTriggerRef : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPath((prev) => (prev === folder ? null : folder));
                }}
                aria-label="Folder options"
                className="relative group/tip opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 hover:text-stone-600 transition-opacity"
              >
                <MoreVerticalIcon className="h-4 w-4" />
                <IconTooltip label="Folder actions" open={openMenuPath === folder} />
              </button>
              <AnchoredDropdown
                open={openMenuPath === folder}
                anchorRef={fileMenuTriggerRef}
                align="right"
                className={SIDEBAR_ACTION_MENU_CLASSES}
              >
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
                  {rootEntry ? null : (
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
          <div className="ml-3.5">
            {renderDraftRow(folder)}
            {childFolders.map((child) => renderFolder(child))}
            {folderFiles.map((file) => renderFileRow(file))}
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
    // Root-level draft (parentPath null) — the effect above reveals it.
    const beginRootDraft = (type: DraftEntry['type']) => {
      setDraftEntry({
        id: `draft-${draftIdRef.current++}`,
        type,
        parentPath: null,
        name: buildDraftName(type, null),
      });
    };
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
          className={`${SIDEBAR_ENTRY_ROW_CLASSES} ${getSidebarListItemStateClasses(false)}`}
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
                className="relative group/tip opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 transition-opacity hover:text-stone-600"
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
                  className="relative group/tip opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 transition-opacity hover:text-stone-600"
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
                className="relative group/tip opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 leading-none text-stone-400 hover:text-stone-600 transition-opacity"
              >
                <MoreVerticalIcon className="h-4 w-4" />
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
          <div className="ml-3.5">
            {renderDraftRow(null)}
            {rootFolders.map((folder) => renderFolder(folder))}
            {rootFiles.map((file) => renderFileRow(file))}
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
          if (!canWrite || isFileRenaming) return;
          event.stopPropagation();
          onBeginRename(file.path, 'list');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (!canWrite) return;
            onBeginRename(file.path, 'list');
          }
        }}
        role="button"
        tabIndex={0}
        onContextMenu={(event) => {
          if (!canWrite) return;
          event.preventDefault();
          event.stopPropagation();
          setOpenMenuPath((prev) => (prev === file.path ? null : file.path));
        }}
        onDragOver={(event) => {
          if (!canWrite) return;
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
        draggable={canWrite}
        onDragStart={(event) => {
          onFileDragStart(event, file.path);
          draggingRef.current = {
            paths: selectedPaths.has(file.path) ? Array.from(selectedPaths) : [file.path],
            kind: 'file',
          };
        }}
        onDragEnd={endRowDrag}
        style={dropHintStyle(file.path)}
        data-files-entry={file.path}
        className={`${SIDEBAR_ENTRY_ROW_CLASSES} ${
          isSelected ? 'bg-stone-200/80 text-stone-800' : getSidebarListItemStateClasses(isActiveFile)
        }`}
      >
        <WorkspaceEntryIcon
          path={file.path}
          className="h-[18px] w-[18px] flex-shrink-0"
        />
        {isFileRenaming ? (
          <input
            ref={attachRenameInput}
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
            {sharedBadge(file.path, 'file')}
          </span>
        )}
        <LockedBadge locked={file.is_locked} />
        {renderFileActionMenu(file)}
      </div>
    );
  }

  return (
    <>
      <SidebarSectionHeader
        label={title ?? 'Files'}
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
          {/* The header "+ New" button is gone (PR: one entry point per
              action) — creation lives in the tree's right-click menus, and
              the connect entry points moved into this ⋮ actions menu. */}
          {onDownloadWorkspace || (canWrite && (onAddRepo || onAddOverleaf || onConnectLocalAgent)) ? (
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
              <MoreVerticalIcon className="h-4 w-4" />
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
              {canWrite && onAddRepo ? (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuPath(null);
                    onAddRepo();
                  }}
                  onMouseEnter={onAddRepoHover}
                  onFocus={onAddRepoHover}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                >
                  <GithubLogoIcon className="h-3.5 w-3.5 flex-shrink-0" weight="fill" aria-hidden />
                  Add GitHub repo
                </button>
              ) : null}
              {canWrite && onAddOverleaf ? (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMenuPath(null);
                    onAddOverleaf();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
                >
                  <FileTextIcon className="h-3.5 w-3.5 flex-shrink-0 text-emerald-700" weight="fill" aria-hidden />
                  Add Overleaf project
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
              onQueueFileUploads(Array.from(files), null);
              event.target.value = '';
            }}
          />
        </div>
        }
      />
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
        tabIndex={-1}
        className="flex-1 overflow-auto px-2 outline-none"
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
        onDrop={(event) => onDropToFolder(event, null)}
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
            {/* Wireframe focus scope: breadcrumb + just this folder's rows. */}
            <div
              data-testid="focus-breadcrumb"
              className="group flex items-center gap-0.5 px-1 pb-1.5 pt-0.5 text-xs text-stone-500"
            >
              <button
                type="button"
                onClick={() => setFocusedFolder(null)}
                aria-label="Back to all files"
                className="relative group/tip rounded p-0.5 text-stone-400 hover:bg-stone-200/60 hover:text-stone-600"
              >
                <CaretLeftIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
                <IconTooltip label="Back to all files" />
              </button>
              {focusedFolder.split('/').map((segment, index, segments) => {
                const prefix = segments.slice(0, index + 1).join('/');
                const isLast = index === segments.length - 1;
                const label = index === 0 ? (extraRootByPrefix.get(segment)?.name ?? segment) : segment;
                return (
                  <span key={prefix} className="flex min-w-0 items-center gap-0.5">
                    {index > 0 ? <span className="text-stone-300">/</span> : null}
                    <button
                      type="button"
                      onClick={() => setFocusedFolder(prefix)}
                      className={`truncate rounded px-0.5 hover:bg-stone-200/60 ${isLast ? 'font-semibold text-stone-700' : ''}`}
                    >
                      {label}
                    </button>
                  </span>
                );
              })}
              <span className="flex-1" />
              {canWrite ? (
                <button
                  type="button"
                  onClick={() => beginFolderDraft(focusedFolder, 'text')}
                  aria-label="New file here"
                  className="relative group/tip rounded p-0.5 text-stone-400 opacity-0 transition-opacity hover:text-stone-600 group-hover:opacity-100"
                >
                  <FilePlusIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                  <IconTooltip label="New file here" />
                </button>
              ) : null}
              {canWrite && onNewChatInFolder ? (
                <button
                  type="button"
                  onClick={() => onNewChatInFolder(focusedFolder)}
                  aria-label="New chat here"
                  className="relative group/tip rounded p-0.5 text-stone-400 opacity-0 transition-opacity hover:text-stone-600 group-hover:opacity-100"
                >
                  <ChatTeardropIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                  <IconTooltip label="New chat here" />
                </button>
              ) : null}
            </div>
            {renderDraftRow(focusedFolder)}
            {(foldersByParent[focusedFolder] ?? []).map((child) => renderFolder(child))}
            {(filesByFolder[focusedFolder] ?? []).map((file) => renderFileRow(file))}
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
                className={`${SIDEBAR_ENTRY_ROW_CLASSES} ${getSidebarListItemStateClasses(selectedFilePath === file.path)}`}
              >
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
            {rootFolders.map((folder) => renderFolder(folder))}
            {rootFiles.map((file) => renderFileRow(file))}
          </>
        )}

        {!hasVisibleRootContent && filesLoaded && (
          <div className="px-2 text-xs text-stone-400">No files yet.</div>
        )}
          </>
        )}
        {!focusedFolder && canWrite && (
          // "+ Add folder…" under the tree: open a folder from ANYWHERE on
          // the computer as extra context (Cowork-style). Only the desktop
          // shell's native picker can do this — elsewhere the row is
          // disabled with a tooltip. Create/upload live in right-click menus.
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
            <span className="truncate">Add folder…</span>
          </button>
        )}
      </div>
      {emptyMenu && canWrite && (
        <div
          className="fixed z-50 w-44 rounded-lg border border-stone-200 bg-white py-1 text-xs shadow-lg"
          style={{ top: emptyMenu.y, left: emptyMenu.x }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            onClick={() => {
              setEmptyMenu(null);
              onCreateFile();
            }}
            className="w-full px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
          >
            New file
          </button>
          <button
            onClick={() => {
              setEmptyMenu(null);
              onCreateFolder();
            }}
            className="w-full px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
          >
            New folder
          </button>
          <button
            onClick={() => {
              setEmptyMenu(null);
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
