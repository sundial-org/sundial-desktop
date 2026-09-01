'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { CollabEditor, type PendingAddition } from '@/components/workspace/collab-editor';
import { MarkdownEditorFrame, type MarkdownPageChrome } from '@/components/workspace/markdown-editor-frame';
import {
  MarkdownToolbar,
  toolbarTierFlags,
  type ToolbarTierFlags,
} from '@/components/workspace/markdown-toolbar';
import { useElementWidth } from '@/components/workspace/doc-pane-header';
import {
  buildActionableWorkspacePendingAdditions,
  buildSuggestionAuthors,
  type SuggestionAuthorInfo,
  type SuggestionAuthorVisual,
} from '@/lib/workspace/pending-additions';
import { useFilePendingTurns, type FilePendingTurn } from '@/lib/workspace/use-file-pending-turns';
import { CollabCodeEditor } from '@/components/workspace/collab-code-editor';
import { useDocStyle } from '@/lib/doc-style';
import {
  EDITOR_TAB_MIME,
  parseTabDragPayload,
  resolveDropZone,
  type DropZone,
  type TabDragPayload,
} from '@/lib/workspace/editor-panes';

type CollabUser = { name: string; color: string };

/** Dev experiment: localStorage `sundial:doc-align` = 'left' left-aligns the
 *  markdown document column (fixed left padding) instead of centering it.
 *  Read after mount so SSR/hydration stay deterministic; flip the key in
 *  devtools and reload. No settings UI. */
export function useDocAlignLeft(): boolean {
  const [left, setLeft] = useState(false);
  useEffect(() => {
    try {
      setLeft(window.localStorage.getItem('sundial:doc-align') === 'left');
    } catch {}
  }, []);
  return left;
}

type SplitPaneFile = {
  id: string;
  path: string;
  type: string;
};

interface SplitEditorPaneBodyProps {
  file: SplitPaneFile | null;
  /** Yjs room override while a move of this file is in flight (page-level
   *  pendingPaneMove freeze); defaults to the file's live path. */
  collabPath?: string;
  isMarkdown: boolean;
  isBinary: boolean;
  workspaceId: string;
  /** The page's workspace fetch (sidecar shim on local workspaces) for the
   *  code editor's LaTeX completion context. */
  apiFetch?: typeof fetch;
  user: CollabUser;
  readOnly: boolean;
  /** Workspace-global edit mode, mirrored from the primary surfaces so a
   *  Suggesting workspace stages split-pane code edits into the same ledger. */
  editMode: 'edit' | 'suggest';
  /** Commenter permissions, mirrored from the primary surfaces: commenters
   *  (canWrite=false, canSuggest=true) may propose but never resolve. */
  canResolveSuggestions: boolean;
  forceSuggesting: boolean;
  /** Inline review state — provided when this pane shows the file whose
   *  pending edits the page tracks (the selected file), so Sunny's diffs stay
   *  reviewable when that file is only visible in a split (chat-first first-
   *  edit reveal). */
  pendingAdditions?: PendingAddition[];
  /** Markdown gutter attribution: suggestion mark id → author + turn. */
  suggestionAuthors?: Record<string, SuggestionAuthorInfo>;
  onKeepAddition?: (key: string) => void;
  onUndoAddition?: (key: string) => void;
  onJumpToTurn?: (assistantMessageId: string, chatId: string | null) => void;
  /** This pane's editor gained focus — presence broadcasts its file. */
  onEditorFocused?: (path: string) => void;
  /** The file's header row (name, share status, controls) — page-built so
   *  every pane reads like the primary. */
  header?: ReactNode;
  /** Controls at the formatting toolbar's right end (mode picker, ⋮). Gets
   *  the bar's live tier flags so the Docs ⋮ can fold the hidden tiers in. */
  toolbarTrailing?: (flags: ToolbarTierFlags) => ReactNode;
  showToolbar?: boolean;
  /** Tabs shell + IDE style: the formatting bar leads the pane, above the
   *  file-title row (mirrors the primary's order-first). */
  toolbarFirst?: boolean;
  /** Formatting commands are gated separately from typing: commenters type
   *  suggestions but can't run untracked formatting. */
  toolbarReadOnly?: boolean;
  /** Receives this pane's live markdown editor (drives page-built chrome). */
  onMarkdownEditor?: (editor: Editor | null) => void;
}

/**
 * The body of a SECONDARY editor pane: a self-sufficient collab editor without
 * the primary pane's page chrome (comment lane, LaTeX preview, viewers) — a
 * markdown split keeps its own formatting toolbar.
 * Markdown gets the rich editor; anything else text-y gets the code editor.
 * Memoized so the collab-editor subtree stays inert while the workspace page
 * re-renders at chat-streaming rate.
 */
export const SplitEditorPaneBody = memo(function SplitEditorPaneBody({
  file,
  collabPath,
  isMarkdown,
  isBinary,
  workspaceId,
  apiFetch,
  user,
  readOnly,
  editMode,
  canResolveSuggestions,
  forceSuggesting,
  pendingAdditions,
  suggestionAuthors,
  onKeepAddition,
  onUndoAddition,
  onJumpToTurn,
  onEditorFocused,
  header,
  toolbarTrailing,
  showToolbar = true,
  toolbarFirst = false,
  toolbarReadOnly,
  onMarkdownEditor,
}: SplitEditorPaneBodyProps) {
  const docAlignLeft = useDocAlignLeft();
  // Document ⋯ menu → "Google Docs style": 'docs' paints the gray desk behind
  // the frame's white page card.
  const docsPage = useDocStyle() === 'docs';
  // This pane's own markdown editor instance — drives its formatting toolbar.
  const [markdownEditor, setMarkdownEditor] = useState<Editor | null>(null);
  const onReady = useCallback(({ editor }: { editor: Editor }) => {
    setMarkdownEditor(editor);
    // Drop it on teardown (file switch): the page-built menus must never
    // bind to a destroyed instance.
    editor.on('destroy', () => setMarkdownEditor((cur) => (cur === editor ? null : cur)));
  }, []);
  useEffect(() => {
    onMarkdownEditor?.(markdownEditor);
  }, [markdownEditor, onMarkdownEditor]);
  // Per-pane view state behind the toolbar (the primary keeps its own).
  const [zoom, setZoom] = useState(100);
  const [lineHeight, setLineHeight] = useState(1.5);
  const [pageChrome, setPageChrome] = useState<MarkdownPageChrome>({
    margin: 'normal',
    header: false,
    footer: false,
  });
  const [toolbarRowRef, toolbarRowWidth] = useElementWidth();
  const [toolbarTrailingRef, toolbarTrailingWidth] = useElementWidth();
  const onFocused = useMemo(
    () => (onEditorFocused && file ? () => onEditorFocused(file.path) : undefined),
    [onEditorFocused, file],
  );
  if (!file || file.type === 'folder' || isBinary) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-stone-400">
        {file ? 'This file type has no split view yet' : 'Drag a tab here'}
      </div>
    );
  }
  if (isMarkdown) {
    // Same pill as the primary: formatting tiers + the controls at its right
    // end (mode picker; ⋮ in the Docs style), which get the width first.
    const toolbarWidth = Math.max(0, toolbarRowWidth - toolbarTrailingWidth);
    const trailing = toolbarTrailing?.(toolbarTierFlags(toolbarWidth));
    const toolbarRow = showToolbar ? (
      <div ref={toolbarRowRef} className={`px-3 shrink-0 ${docsPage ? 'pb-1 pt-0.5' : 'py-1'}`}>
        <div className="flex items-stretch rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.05)]">
          <div className="min-w-0 flex-1">
            {markdownEditor ? (
              <MarkdownToolbar
                editor={markdownEditor}
                readOnly={toolbarReadOnly ?? readOnly}
                containerWidth={toolbarWidth}
                // Docs style: the condensed tiers live in the ⋮ at this
                // pill's right end — no second dots trigger on the bar.
                hideOverflowMenu={docsPage}
                zoom={zoom}
                onZoomChange={setZoom}
                lineHeight={lineHeight}
                onLineHeightChange={setLineHeight}
                pageChrome={pageChrome}
                onPageChromeChange={setPageChrome}
                // The pane is print:hidden — Print would print the primary doc.
                hidePrint
              />
            ) : (
              // Reserve the height while the editor is briefly null on a
              // file switch so the chrome never collapses.
              <div className="h-9" aria-hidden />
            )}
          </div>
          {trailing ? (
            <div ref={toolbarTrailingRef} className="flex shrink-0 items-center gap-1 pr-1.5">
              {trailing}
            </div>
          ) : null}
        </div>
      </div>
    ) : null;
    return (
      // Docs style: the desk color runs under ALL the doc chrome (title row,
      // toolbar strip) — a white band above the gray desk reads as a seam.
      <div className={`flex min-h-0 flex-1 flex-col ${docsPage ? 'bg-stone-50' : 'bg-white'}`}>
        {toolbarFirst ? toolbarRow : null}
        {header}
        {toolbarFirst ? null : toolbarRow}
        <div className="min-h-0 flex-1 overflow-auto px-3 lg:px-6 pt-1 pb-4 lg:pb-8">
          <div className={`${docAlignLeft ? '' : 'mx-auto '}max-w-3xl`}>
            <MarkdownEditorFrame
              editor={markdownEditor}
              showToolbar={false}
              hidePrint
              zoom={zoom}
              lineHeight={lineHeight}
              pageChrome={pageChrome}
            >
              <SplitPaneMarkdownEditor
                key={file.id}
                fileId={file.id}
                filePath={file.path}
                collabPath={collabPath ?? file.path}
                workspaceId={workspaceId}
                user={user}
                readOnly={readOnly}
                canResolveSuggestions={canResolveSuggestions}
                forceSuggesting={forceSuggesting}
                pendingAdditions={pendingAdditions}
                suggestionAuthors={suggestionAuthors}
                onKeepAddition={onKeepAddition}
                onUndoAddition={onUndoAddition}
                onJumpToTurn={onJumpToTurn}
                onReady={onReady}
                onFocused={onFocused}
              />
            </MarkdownEditorFrame>
          </div>
        </div>
      </div>
    );
  }
  return (
    <>
      {header}
      <div className="min-h-0 flex-1 overflow-hidden">
        <SplitPaneCodeEditor
          key={file.id}
          fileId={file.id}
          filePath={file.path}
          collabPath={collabPath ?? file.path}
          workspaceId={workspaceId}
          apiFetch={apiFetch}
          user={user}
          readOnly={readOnly}
          editMode={editMode}
          canResolveSuggestions={canResolveSuggestions}
          pendingAdditions={pendingAdditions}
          onKeepAddition={onKeepAddition}
          onUndoAddition={onUndoAddition}
          onJumpToTurn={onJumpToTurn}
          onFocused={onFocused}
          bare
        />
      </div>
    </>
  );
});

/** Memoized editor leaves: the page-built header/toolbar chrome re-renders
 *  the pane body at chat-streaming rate, but the collab editors only see
 *  primitive/stable props and stay inert. */
const SplitPaneMarkdownEditor = memo(CollabEditor);
const SplitPaneCodeEditor = memo(CollabCodeEditor);

/** `${reviewId}:${chunkId}` — the reviewId never contains a colon. */
function parseAdditionKey(key: string): [string, string] {
  const idx = key.indexOf(':');
  return idx >= 0 ? [key.slice(0, idx), key.slice(idx + 1)] : ['', ''];
}

/**
 * SplitEditorPaneBody with its OWN inline-review state: each split pane
 * fetches pending turns for its file, so Sunny's diffs stay reviewable in
 * panes showing a file other than the page's selection.
 */
export const SplitEditorPaneReviewBody = memo(function SplitEditorPaneReviewBody({
  reviewWorkspaceId,
  reviewApiFetch,
  reviewInvalidationToken,
  resolveAuthorLabel,
  resolveAuthorVisual,
  onJumpToTurn,
  ...bodyProps
}: Omit<
  SplitEditorPaneBodyProps,
  'pendingAdditions' | 'suggestionAuthors' | 'onKeepAddition' | 'onUndoAddition'
> & {
  /** Workspace id for the pending-turns fetch (null → no review rail). */
  reviewWorkspaceId: string | null;
  /** The page's workspace fetch — the sidecar shim on local workspaces. */
  reviewApiFetch?: typeof fetch;
  reviewInvalidationToken: string;
  resolveAuthorLabel?: (turn: FilePendingTurn) => string;
  resolveAuthorVisual?: (turn: FilePendingTurn) => SuggestionAuthorVisual | null;
}) {
  const filePath = bodyProps.file && bodyProps.file.type !== 'folder' ? bodyProps.file.path : null;
  const pendingTurns = useFilePendingTurns(reviewWorkspaceId, filePath, reviewInvalidationToken, reviewApiFetch);
  const pendingAdditions = useMemo(
    () =>
      buildActionableWorkspacePendingAdditions({
        turns: pendingTurns.turns,
        filePath,
        resolveAuthorLabel,
        resolveAuthorVisual,
      }),
    [pendingTurns.turns, filePath, resolveAuthorLabel, resolveAuthorVisual],
  );
  const suggestionAuthors = useMemo(
    () =>
      buildSuggestionAuthors({
        turns: pendingTurns.turns,
        suggestionTurns: pendingTurns.suggestionTurns,
        resolveAuthorLabel,
        resolveAuthorVisual,
      }),
    [pendingTurns.turns, pendingTurns.suggestionTurns, resolveAuthorLabel, resolveAuthorVisual],
  );
  // Depend on the stable callbacks, not the hook's per-render result object,
  // so the memoized editor leaves keep their props across page re-renders.
  const { keepChunk, undoChunk } = pendingTurns;
  const onKeepAddition = useCallback(
    (key: string) => {
      const [id, chunk] = parseAdditionKey(key);
      if (id && chunk && filePath) keepChunk(id, filePath, chunk);
    },
    [keepChunk, filePath],
  );
  const onUndoAddition = useCallback(
    (key: string) => {
      const [id, chunk] = parseAdditionKey(key);
      if (id && chunk && filePath) void undoChunk(id, filePath, chunk);
    },
    [undoChunk, filePath],
  );
  return (
    <SplitEditorPaneBody
      {...bodyProps}
      apiFetch={reviewApiFetch}
      pendingAdditions={pendingAdditions}
      suggestionAuthors={suggestionAuthors}
      onKeepAddition={onKeepAddition}
      onUndoAddition={onUndoAddition}
      onJumpToTurn={onJumpToTurn}
    />
  );
});

interface PaneDropOverlayProps {
  /** Rendered only while a tab drag is in flight; owns dragover/drop. */
  onDropTab: (payload: TabDragPayload, zone: DropZone) => void;
  /** Splits are refused at the pane cap — the preview collapses to 'center'. */
  canSplit: boolean;
  /** Fires on zone transitions so the pane can squash its content aside,
   *  previewing the post-split layout (null on leave/drop/dragend). */
  onZoneChange?: (zone: DropZone | null) => void;
}

/**
 * Obsidian-style drop preview covering a pane body during a tab drag: the
 * hovered zone (left quarter / center / right quarter) fills with a translucent
 * indigo outline showing exactly where the tab would land.
 */
export function PaneDropOverlay({ onDropTab, canSplit, onZoneChange }: PaneDropOverlayProps) {
  const [zone, setZoneState] = useState<DropZone | null>(null);
  const zoneRef = useRef<DropZone | null>(null);
  const setZone = (next: DropZone | null) => {
    if (zoneRef.current === next) return;
    zoneRef.current = next;
    setZoneState(next);
    onZoneChange?.(next);
  };

  const zoneFromEvent = (event: DragEvent<HTMLDivElement>): DropZone => {
    const rect = event.currentTarget.getBoundingClientRect();
    const resolved = resolveDropZone(event.clientX - rect.left, rect.width);
    return canSplit ? resolved : 'center';
  };

  return (
    <div
      data-testid="pane-drop-overlay"
      // Mounted at PANE level, starting below the tab strip (h-11) so the
      // strip's own reorder/adopt drop targets stay reachable during a drag —
      // top-9 under the h-11 strip covered its bottom 8px, so dragover
      // flickered between the strip and the overlay along that band.
      className="absolute inset-x-0 bottom-0 top-11 z-20"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(EDITOR_TAB_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setZone(zoneFromEvent(event));
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setZone(null);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(EDITOR_TAB_MIME)) return;
        event.preventDefault();
        setZone(null);
        const payload = parseTabDragPayload(event.dataTransfer.getData(EDITOR_TAB_MIME));
        if (payload) onDropTab(payload, zoneFromEvent(event));
      }}
    >
      {zone ? (
        <div
          data-testid={`pane-drop-preview-${zone}`}
          // -top-11 reaches back up over the strip row (the overlay starts
          // below it) so the preview spans the full future pane, top to bottom.
          className="pointer-events-none absolute -top-11 bottom-1 rounded-lg border-2 border-orange-400/90 bg-orange-400/10 transition-all duration-100"
          style={{
            left: zone === 'right' ? '50%' : '0.25rem',
            right: zone === 'left' ? '50%' : '0.25rem',
          }}
        />
      ) : null}
    </div>
  );
}
