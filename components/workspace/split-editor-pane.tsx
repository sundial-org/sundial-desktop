'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { CollabEditor, type PendingAddition } from '@/components/workspace/collab-editor';
import { buildActionableWorkspacePendingAdditions } from '@/lib/workspace/pending-additions';
import { useFilePendingTurns, type FilePendingTurn } from '@/lib/workspace/use-file-pending-turns';
import { CollabCodeEditor } from '@/components/workspace/collab-code-editor';
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
  onKeepAddition?: (key: string) => void;
  onUndoAddition?: (key: string) => void;
  onJumpToTurn?: (assistantMessageId: string, chatId: string | null) => void;
}

/**
 * The body of a SECONDARY editor pane: a self-sufficient collab editor without
 * the primary pane's chrome (toolbars, comment lane, LaTeX preview, viewers).
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
  user,
  readOnly,
  editMode,
  canResolveSuggestions,
  forceSuggesting,
  pendingAdditions,
  onKeepAddition,
  onUndoAddition,
  onJumpToTurn,
}: SplitEditorPaneBodyProps) {
  const docAlignLeft = useDocAlignLeft();
  if (!file || file.type === 'folder' || isBinary) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-stone-400">
        {file ? 'This file type has no split view yet' : 'Drag a tab here'}
      </div>
    );
  }
  if (isMarkdown) {
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-white">
        <div className={docAlignLeft ? 'max-w-3xl pl-12 pr-6 py-6' : 'mx-auto max-w-3xl px-6 py-6'}>
          <CollabEditor
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
            onKeepAddition={onKeepAddition}
            onUndoAddition={onUndoAddition}
            onJumpToTurn={onJumpToTurn}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <CollabCodeEditor
        key={file.id}
        fileId={file.id}
        filePath={file.path}
        collabPath={collabPath ?? file.path}
        workspaceId={workspaceId}
        user={user}
        readOnly={readOnly}
        editMode={editMode}
        canResolveSuggestions={canResolveSuggestions}
        pendingAdditions={pendingAdditions}
        onKeepAddition={onKeepAddition}
        onUndoAddition={onUndoAddition}
        onJumpToTurn={onJumpToTurn}
        bare
      />
    </div>
  );
});

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
  reviewInvalidationToken,
  resolveAuthorLabel,
  onJumpToTurn,
  ...bodyProps
}: Omit<SplitEditorPaneBodyProps, 'pendingAdditions' | 'onKeepAddition' | 'onUndoAddition'> & {
  /** Cloud workspace id for the pending-turns fetch (null → no review rail). */
  reviewWorkspaceId: string | null;
  reviewInvalidationToken: string;
  resolveAuthorLabel?: (turn: FilePendingTurn) => string;
}) {
  const filePath = bodyProps.file && bodyProps.file.type !== 'folder' ? bodyProps.file.path : null;
  const pendingTurns = useFilePendingTurns(reviewWorkspaceId, filePath, reviewInvalidationToken);
  const pendingAdditions = useMemo(
    () =>
      buildActionableWorkspacePendingAdditions({
        turns: pendingTurns.turns,
        filePath,
        resolveAuthorLabel,
      }),
    [pendingTurns.turns, filePath, resolveAuthorLabel],
  );
  const onKeepAddition = useCallback(
    (key: string) => {
      const [id, chunk] = parseAdditionKey(key);
      if (id && chunk && filePath) pendingTurns.keepChunk(id, filePath, chunk);
    },
    [pendingTurns, filePath],
  );
  const onUndoAddition = useCallback(
    (key: string) => {
      const [id, chunk] = parseAdditionKey(key);
      if (id && chunk && filePath) void pendingTurns.undoChunk(id, filePath, chunk);
    },
    [pendingTurns, filePath],
  );
  return (
    <SplitEditorPaneBody
      {...bodyProps}
      pendingAdditions={pendingAdditions}
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
      // Mounted at PANE level, starting below the tab strip (h-9) so the
      // strip's own reorder/adopt drop targets stay reachable during a drag.
      className="absolute inset-x-0 bottom-0 top-9 z-20"
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
          // -top-9 reaches back up over the strip row (the overlay starts
          // below it) so the preview spans the full future pane, top to bottom.
          className="pointer-events-none absolute -top-9 bottom-1 rounded-lg border-2 border-orange-400/90 bg-orange-400/10 transition-all duration-100"
          style={{
            left: zone === 'right' ? '50%' : '0.25rem',
            right: zone === 'left' ? '50%' : '0.25rem',
          }}
        />
      ) : null}
    </div>
  );
}
