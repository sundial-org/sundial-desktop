'use client';

import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, DotsThreeIcon, DotsThreeVerticalIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { AnchoredDropdown, isInFloatingActionMenu } from '@/components/workspace/anchored-dropdown';
import { FindReplacePanel } from './find-replace';
import { foldAll, unfoldAll } from '@/lib/tiptap/fold';
import { setDocStylePreference, useDocStyle } from '@/lib/doc-style';
import { isMarkdownFile } from '@/lib/sync/policy';
import { appendPathShareTokenToUrl } from '@/lib/workspace/path-share-token-client';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import { EDIT_MODE_LABEL, type WorkspaceEditMode } from '@/lib/workspace/edit-mode';
import { printPage } from '@/lib/desktop';

type DocumentActionsFile = {
  id: string;
  path: string;
  type: string;
};

interface DocumentActionsMenuProps {
  editor: Editor | null;
  readOnly?: boolean;
  file?: DocumentActionsFile | null;
  projectId?: string | null;
  /** Deep link to this file. Share opens the share modal now, so copy-link
   *  lives here — it is a file action, not a share flow. */
  fileUrl?: string | null;
  /** Local (sidecar) workspace: /api/workspace/* is served by the shim, so a
   *  plain anchor navigation would leave the app for the cloud. */
  localWorkspace?: boolean;
  /** View toggles folded out of the header row (they lead the menu). */
  rawMarkdown?: { active: boolean; onToggle: () => void } | null;
  richViewer?: { active: boolean; onToggle: () => void } | null;
  /** Obsidian-style inline title: show the file name as the doc's H1. */
  inlineTitle?: { active: boolean; onToggle: () => void } | null;
  /** A squished header collapses its always-on controls in here (leading
   *  section, own divider): edit-mode picker, Share, formatting toolbar,
   *  comments. */
  collapsed?: {
    editMode?: { mode: WorkspaceEditMode; modes: WorkspaceEditMode[]; onChange: (mode: WorkspaceEditMode) => void } | null;
    /** Anonymous commenter link: suggesting needs an identity. */
    signIn?: { onSelect: () => void } | null;
    share?: { onSelect: () => void } | null;
    formatToolbar?: { active: boolean; onToggle: () => void } | null;
    comments?: { count: number; onToggle: () => void } | null;
  } | null;
  /** Docs style: the condensed formatting bar's hidden tiers fold in here
   *  (ToolbarOverflowItems) — ONE combined ⋯ menu on the pill instead of a
   *  second dots trigger beside this one. Render prop so the items can close
   *  the menu after running. */
  formattingItems?: (close: () => void) => ReactNode;
  /** Trigger glyph. The desktop Docs pill uses horizontal ⋯ (it IS the one
   *  combined dots menu there — Belinda, 2026-08-07); everywhere the toolbar
   *  keeps its own ⋯ overflow, this stays ⋮ so the two menus don't read as
   *  identical twins. */
  horizontalDots?: boolean;
  /** PDF preview URL — "Open in new tab" lives here, not as a header icon. */
  pdfPreviewUrl?: string | null;
  /** Panel edge that hugs the trigger — 'left' when the trigger sits at the
   *  window's left corner (the no-tabs shell beside the ×). */
  menuAlign?: 'left' | 'right';
  /** Split panes are print:hidden — printing from them would print the primary. */
  hidePrint?: boolean;
  /** Owns the global ⌘F / ⌘⇧H shortcuts. With several panes mounted only the
   *  focused pane's menu should answer, or every pane opens Find at once. */
  findShortcuts?: boolean;
  onRename?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  /** Local (sidecar) projects only: reveal the file on disk in the OS file
   *  manager (Finder / Explorer). The sidecar owns the disk path, so the
   *  page wires this to POST /projects/:id/reveal. */
  onRevealInFinder?: (() => void) | null;
}

/** "Show in Finder" reads wrong everywhere but macOS. */
function revealLabel(): string {
  if (typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? '')) return 'Show in Finder';
  return 'Show in file manager';
}

function Item({
  label,
  disabled,
  selected,
  onSelect,
}: {
  label: string;
  disabled?: boolean;
  /** Trailing check — for collapsed toggles/pickers surfaced in the menu. */
  selected?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item={label}
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
        disabled ? 'cursor-not-allowed text-stone-400' : 'text-stone-700 hover:bg-stone-50'
      }`}
    >
      <span>{label}</span>
      {selected ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-stone-500" weight="bold" aria-hidden /> : null}
    </button>
  );
}

/** The document's own actions (download/export/print, copy/rename/trash, find)
 *  — everything the formatting toolbar and the header chrome don't already
 *  expose. One icon button in the file header row, not a menu bar. */
export function DocumentActionsMenu({
  editor,
  readOnly = false,
  file = null,
  projectId = null,
  fileUrl = null,
  localWorkspace = false,
  rawMarkdown = null,
  richViewer = null,
  inlineTitle = null,
  collapsed = null,
  formattingItems,
  horizontalDots = false,
  pdfPreviewUrl = null,
  menuAlign = 'right',
  onRename,
  onDuplicate,
  onDelete,
  onRevealInFinder,
  hidePrint = false,
  findShortcuts = true,
}: DocumentActionsMenuProps) {
  const apiFetch = useApiFetch();
  // Docs ↔ IDE lives in menus now (the top-left icon switch is gone —
  // floating icons read as chrome bolted onto the page, founder). This menu
  // is reachable from BOTH styles, so one toggle item covers both directions;
  // the Docs menu bar's View → IDE view and Settings → Appearance are the
  // other two doors.
  const docStyle = useDocStyle();
  const [open, setOpen] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [findOpen, setFindOpen] = useState<false | 'find' | 'replace'>(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Outside click / Escape dismissal. The panel is portaled to document.body,
  // so clicks inside it are recognized by the floating-menu marker — a click
  // on a menu item counts as inside and its onClick still fires.
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (isInFloatingActionMenu(event.target)) return;
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // ⌘F opens in-document find; ⌘⇧H the full Find & Replace. This menu only
  // mounts while a document surface is showing, so with a chat-only pane the
  // browser's native find is untouched. Raw-markdown and rich-viewer modes
  // hide the Tiptap view the decorations live in — fall through there too.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.defaultPrevented) return;
      const k = event.key.toLowerCase();
      const wantsFind = k === 'f' && !event.shiftKey;
      const wantsReplace = k === 'h' && event.shiftKey;
      if (!wantsFind && !wantsReplace) return;
      if (!editor || editor.isDestroyed || rawMarkdown?.active || richViewer?.active) return;
      event.preventDefault();
      // ⌘F never downgrades an open replace panel; ⌘⇧H upgrades a find bar.
      setFindOpen((prev) => (wantsReplace ? 'replace' : prev || 'find'));
    };
    if (!findShortcuts) return;
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor, rawMarkdown?.active, richViewer?.active, findShortcuts]);

  const select = useCallback((fn: () => void) => {
    setOpen(false);
    // Deferred a tick, deliberately: Rename mounts an autoFocus input, and
    // running it in the same tick raced this dropdown's teardown — the
    // unmount took focus back, the input's blur-commit fired, and the rename
    // field disappeared the instant it appeared.
    setTimeout(fn, 0);
  }, []);

  // A destroyed editor counts as absent: the menu renders against the last
  // (frozen) editor during file switches, and v3 throws when anything runs on a
  // destroyed editor — so Find & Replace (the only editor-backed item) inerts.
  const liveEditor = editor && !editor.isDestroyed ? editor : null;
  const canDownload = Boolean(file && projectId && file.type !== 'folder');
  const canDuplicate = Boolean(file && onDuplicate && !readOnly && file.type !== 'folder');
  const canRename = Boolean(file && onRename && !readOnly);
  const canDelete = Boolean(file && onDelete && !readOnly);

  const clickDownloadAnchor = (href: string, name: string) => {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const downloadBlobAs = async (url: string, name: string, label: string) => {
    try {
      // apiFetch, not a plain anchor: in a LOCAL workspace the data plane is
      // the sidecar shim, and an anchor navigation would go straight to the
      // cloud app, which has never heard of this project. It also means the
      // response is a blob, so a failure surfaces as a message instead of
      // downloading a broken file.
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(`${label} failed (${res.status})`);
      const objectUrl = URL.createObjectURL(await res.blob());
      clickDownloadAnchor(objectUrl, name);
      // Deferred, like the workspace's own downloadBlob: WKWebView (the
      // desktop shell) and Firefox start the anchor's navigation
      // asynchronously, so revoking on the next line hands them a dead URL and
      // nothing downloads.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      console.error(`[${label}]`, error);
      window.alert(`Could not ${label} this document. Please try again.`);
    }
  };

  const downloadCurrentFile = () => {
    if (!file || !projectId) return;
    const params = new URLSearchParams({ projectId, fileId: file.id });
    // Path-share guests carry no headers on the eventual anchor — keep ?pshare=.
    const url = appendPathShareTokenToUrl(`/api/workspace/files/download?${params.toString()}`);
    const name = file.path.split('/').pop() ?? 'download';
    // Cloud keeps the ANCHOR: the browser streams it to disk, where buffering
    // the whole file through res.blob() would hold it in renderer memory. The
    // local shim can't be reached by an anchor at all, and its files come off
    // the user's own disk over loopback.
    if (!localWorkspace) {
      clickDownloadAnchor(url, name);
      return;
    }
    void downloadBlobAs(url, name, 'download');
  };

  const exportCurrentFile = (format: 'pdf' | 'docx') => {
    if (!file || !projectId) return;
    const params = new URLSearchParams({ projectId, fileId: file.id, format });
    void downloadBlobAs(
      appendPathShareTokenToUrl(`/api/workspace/files/export?${params.toString()}`),
      `${(file.path.split('/').pop() ?? 'document').replace(/\.[^.]+$/, '')}.${format}`,
      `export as ${format.toUpperCase()}`,
    );
  };

  return (
    <>
      <div ref={wrapRef} className="shrink-0">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-label="Document actions"
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="doc-actions-menu"
          // stone-200/60, not stone-100: in the Docs style this trigger rides
          // ON the stone-100 toolbar pill, where a stone-100 hover/open state
          // is invisible. Same tone the toolbar's own buttons use, and still
          // a quiet hover against the IDE header's white.
          className={`relative group/tip inline-flex h-7 w-7 items-center justify-center rounded hover:bg-stone-200/60 ${
            open ? 'bg-stone-200/70 text-stone-700' : 'text-stone-400 hover:text-stone-600'
          }`}
        >
          {horizontalDots ? (
            <DotsThreeIcon className="h-4 w-4" weight="bold" aria-hidden />
          ) : (
            <DotsThreeVerticalIcon className="h-4 w-4" weight="bold" aria-hidden />
          )}
          <IconTooltip label="Document actions" open={open} />
        </button>
        <AnchoredDropdown
          open={open}
          anchorRef={triggerRef}
          align={menuAlign}
          // Folded formatting tiers widen the panel to their w-64 items and
          // can make it tall — cap and scroll instead of running offscreen.
          className={`${
            formattingItems ? 'max-h-[80vh] w-[17rem] overflow-y-auto' : 'w-56'
          } rounded-xl border border-stone-200 bg-white py-1 shadow-lg`}
        >
          <div role="menu" aria-label="Document actions">
            {formattingItems ? (
              <>
                {formattingItems(() => setOpen(false))}
                <div className="my-1 border-t border-stone-200" />
              </>
            ) : null}
            {collapsed ? (
              <>
                {collapsed.editMode
                  ? collapsed.editMode.modes.map((option) => (
                      <Item
                        key={option}
                        label={EDIT_MODE_LABEL[option]}
                        selected={option === collapsed.editMode!.mode}
                        onSelect={() => select(() => collapsed.editMode!.onChange(option))}
                      />
                    ))
                  : null}
                {collapsed.signIn ? (
                  <Item
                    label="Sign in to suggest edits"
                    onSelect={() => select(collapsed.signIn!.onSelect)}
                  />
                ) : null}
                {collapsed.formatToolbar ? (
                  <Item
                    label="Formatting toolbar"
                    selected={collapsed.formatToolbar.active}
                    onSelect={() => select(collapsed.formatToolbar!.onToggle)}
                  />
                ) : null}
                {collapsed.comments ? (
                  <Item
                    label={`Comments (${collapsed.comments.count})`}
                    onSelect={() => select(collapsed.comments!.onToggle)}
                  />
                ) : null}
                {collapsed.share ? (
                  <Item label="Share" onSelect={() => select(collapsed.share!.onSelect)} />
                ) : null}
                <div className="my-1 border-t border-stone-200" />
              </>
            ) : null}
            {rawMarkdown ? (
              <Item
                label={rawMarkdown.active ? 'Rendered view' : 'Raw markdown'}
                onSelect={() => select(rawMarkdown.onToggle)}
              />
            ) : null}
            {richViewer ? (
              <Item
                label={richViewer.active ? 'View source' : 'Preview'}
                onSelect={() => select(richViewer.onToggle)}
              />
            ) : null}
            {inlineTitle ? (
              <Item
                label={inlineTitle.active ? 'Hide file title' : 'Show file title'}
                onSelect={() => select(inlineTitle.onToggle)}
              />
            ) : null}
            {/* Markdown only (rawMarkdown is this menu's markdown signal):
                the style is a markdown-surface choice. */}
            {rawMarkdown ? (
              <Item
                label="Google Docs view"
                selected={docStyle === 'docs'}
                onSelect={() =>
                  select(() => setDocStylePreference(docStyle === 'docs' ? 'obsidian' : 'docs'))
                }
              />
            ) : null}
            {pdfPreviewUrl ? (
              <Item
                label="Open in new tab"
                onSelect={() => {
                  // Synchronous, NOT via select(): its setTimeout defers past
                  // the click's user activation and popup blockers eat the tab.
                  window.open(pdfPreviewUrl, '_blank', 'noreferrer');
                  setOpen(false);
                }}
              />
            ) : null}
            {rawMarkdown || richViewer || pdfPreviewUrl ? (
              <div className="my-1 border-t border-stone-200" />
            ) : null}
            {canDownload ? (
              <Item label="Download" onSelect={() => select(downloadCurrentFile)} />
            ) : null}
            {/* Export is a cloud route: the local shim has no case for it and
                answers 501, so a local workspace must not offer it at all. */}
            {canDownload && !localWorkspace && isMarkdownFile(file?.path) ? (
              <>
                <Item
                  label="Download as PDF"
                  onSelect={() => select(() => void exportCurrentFile('pdf'))}
                />
                <Item
                  label="Download as Word (.docx)"
                  onSelect={() => select(() => void exportCurrentFile('docx'))}
                />
              </>
            ) : null}
            {!hidePrint ? (
              <Item
                label="Print"
                onSelect={() => select(() => printPage())}
              />
            ) : null}
            <Item
              label="Find and replace"
              disabled={!liveEditor}
              onSelect={() => select(() => setFindOpen('replace'))}
            />
            <Item
              label="Collapse all"
              disabled={!liveEditor}
              onSelect={() => select(() => liveEditor && foldAll(liveEditor))}
            />
            <Item
              label="Expand all"
              disabled={!liveEditor}
              onSelect={() => select(() => liveEditor && unfoldAll(liveEditor))}
            />
            {fileUrl ? (
              // Share now opens the share modal directly, and that modal's
              // copy-link is the WORKSPACE invite — this is the only place
              // left that copies a link to the open file itself.
              <Item
                label={copiedLink ? 'Link copied' : 'Copy link to file'}
                onSelect={() => {
                  void navigator.clipboard.writeText(fileUrl).then(() => setCopiedLink(true), () => {});
                  setOpen(false);
                }}
              />
            ) : null}
            {onRevealInFinder ? (
              <Item label={revealLabel()} onSelect={() => select(onRevealInFinder)} />
            ) : null}
            {canDuplicate || canRename || canDelete ? (
              <div className="my-1 border-t border-stone-200" />
            ) : null}
            {canDuplicate ? (
              <Item label="Make a copy" onSelect={() => select(onDuplicate!)} />
            ) : null}
            {canRename ? <Item label="Rename" onSelect={() => select(onRename!)} /> : null}
            {canDelete ? <Item label="Move to trash" onSelect={() => select(onDelete!)} /> : null}
          </div>
        </AnchoredDropdown>
      </div>
      {/* Deliberately outside `wrapRef`: an outside-click on the bar must not
          read as a click on the ⋮ trigger. The bar portals to the body and
          anchors on the editor pane, so this mount point's box is irrelevant. */}
      {findOpen && liveEditor ? (
        <FindReplacePanel
          editor={liveEditor}
          readOnly={readOnly}
          showReplace={findOpen === 'replace'}
          onClose={() => setFindOpen(false)}
        />
      ) : null}
    </>
  );
}
