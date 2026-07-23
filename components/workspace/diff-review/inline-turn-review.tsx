'use client';

import { useMemo, useState } from 'react';
import { File as FileIcon, CaretDown, CaretRight, X } from '@phosphor-icons/react';
import { InlineDocDiff } from '@/components/workspace/diff-review/inline-doc-diff';
import { CopyLinkButton } from '@/components/workspace/copy-link-button';
import { BlobFileNotice } from '@/components/workspace/diff-review/blob-file-notice';
import {
  OversizedFileNotice,
  StaticChunk,
  countFileWords,
  formatTurnFileSummary,
} from '@/components/workspace/diff-review/turn-edit-helpers';
import type { TurnEditChunk, TurnEditFile } from '@/lib/workspace/turn-edits';

export interface InlineTurnReviewProps {
  files: TurnEditFile[];
  activeUndoKey: string | null;
  isLatestTurn: boolean;
  assistantMessageId?: string;
  /** Workspace id — lets blob entries fetch their image preview. */
  projectId?: string | null;
  onKeepChunk: (filePath: string, chunkId: string) => void;
  onUndoChunk: (filePath: string, chunkId: string) => void;
  onKeepAll: () => void;
  onUndoAll: () => void;
  onReExpand?: () => void;
  /** Open the diff body expanded (used when this turn is the ?diff= deep-link). */
  defaultDiffExpanded?: boolean;
}

// Once a turn touches more than this many files, the chat would otherwise
// render a wall of fully-expanded diffs (e.g. clone-a-repo turns). Collapse
// each file by default and paginate beyond INITIAL_VISIBLE_FILES.
const COLLAPSE_FILES_THRESHOLD = 5;
const INITIAL_VISIBLE_FILES = 20;

function countPending(files: TurnEditFile[]) {
  let count = 0;
  for (const file of files) {
    for (const chunk of file.chunks) {
      if (chunk.status === 'pending') count += 1;
    }
  }
  return count;
}

function countTotalWords(files: TurnEditFile[]) {
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    const w = countFileWords(file);
    added += w.added;
    deleted += w.deleted;
  }
  return { added, deleted };
}

function countFilePending(file: TurnEditFile) {
  return file.chunks.filter((chunk) => chunk.status === 'pending').length;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function LineCountBadge({ added, deleted }: { added: number; deleted: number }) {
  if (added === 0 && deleted === 0) return null;
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      {added > 0 ? <span className="text-emerald-600">+{added}</span> : null}
      {added > 0 && deleted > 0 ? ' ' : null}
      {deleted > 0 ? <span className="text-stone-400">−{deleted}</span> : null}
    </span>
  );
}

// Whole-turn accept/reject as a ✓/✕ box — the same small bordered control the
// editor's suggestion review uses, so the chat card and the doc read as one
// system (replaces the old "Undo all · Keep all" text links).
function IconAction({
  glyph,
  title,
  onClick,
  disabled,
  loading,
  variant,
}: {
  glyph: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant: 'accept' | 'reject';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      aria-label={title}
      className={`inline-flex h-[18px] w-[18px] items-center justify-center rounded-md border bg-white text-[11px] leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        variant === 'accept'
          ? 'border-[var(--diff-add-border)] text-[var(--diff-add-text)] hover:bg-[var(--diff-add-bg)]'
          : 'border-[var(--diff-del-border)] text-[var(--diff-del-text)] hover:bg-[var(--diff-del-bg)]'
      }`}
    >
      {loading ? (
        <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent opacity-60" />
      ) : (
        glyph
      )}
    </button>
  );
}

function FileStatusPill({ file }: { file: TurnEditFile }) {
  if (file.isDeleted) {
    return (
      <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700">
        Deleted
      </span>
    );
  }
  return null;
}

function FileBlock({
  file,
  isMulti,
  activeUndoKey,
  defaultCollapsed = false,
  readOnly = false,
  showHeaderRow = true,
  projectId,
  onKeepChunk,
  onUndoChunk,
}: {
  file: TurnEditFile;
  isMulti: boolean;
  activeUndoKey: string | null;
  defaultCollapsed?: boolean;
  readOnly?: boolean;
  showHeaderRow?: boolean;
  projectId?: string | null;
  onKeepChunk: (filePath: string, chunkId: string) => void;
  onUndoChunk: (filePath: string, chunkId: string) => void;
}) {
  const pending = countFilePending(file);
  const firstPending = file.chunks.find((c) => c.status === 'pending')?.id;
  const fileUndoActive = activeUndoKey === `__file__:${file.filePath}`;
  const allActive = activeUndoKey === '__all__';
  const summary = formatTurnFileSummary(file);
  // Read-only renders the proposed diff via StaticChunk (no Keep/Undo) — used
  // for a fully-rejected turn expanded from its chip. Every other file (edits,
  // new files, and now deletions) is actionable: Undo restores a deleted file.
  const actionable = !readOnly;
  // Single-file turns: file row is informational only (always expanded, no
  // duplicated pills/icons — the header counter + per-chunk buttons cover it).
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // When the turn card already shows the file path in its summary bar
  // (single-file turns), suppress the per-file header to avoid duplication and
  // keep the body always visible.
  const effectiveCollapsed = showHeaderRow ? collapsed : false;

  const headerRow = !showHeaderRow ? null : isMulti ? (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      onClick={() => setCollapsed((v) => !v)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setCollapsed((v) => !v);
        }
      }}
      className="flex w-full cursor-pointer items-center gap-1.5 px-2 pb-1 pt-2 text-left transition-colors hover:bg-stone-50/80"
    >
      <CaretRight
        weight="bold"
        className={`h-3 w-3 shrink-0 text-stone-400 transition-transform ${collapsed ? '' : 'rotate-90'}`}
      />
      <FileIcon weight="duotone" className="h-3.5 w-3.5 shrink-0 text-stone-400" />
      <span className="min-w-0 truncate text-[12px] text-stone-700">
        {file.filePath}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {pending > 0 ? (
          <span className="text-[10px] text-stone-400">{pending} pending</span>
        ) : null}
        <FileStatusPill file={file} />
        {summary ? (
          <span className="text-[10px] text-stone-400">{summary}</span>
        ) : null}
      </div>
      {actionable && pending > 0 && firstPending ? (
        <div className="ml-auto flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <IconAction glyph="✕" title="Reject file" onClick={() => onUndoChunk(file.filePath, firstPending)} loading={fileUndoActive} variant="reject" />
          <IconAction glyph="✓" title="Keep file" onClick={() => onKeepChunk(file.filePath, firstPending)} disabled={fileUndoActive} variant="accept" />
        </div>
      ) : null}
    </div>
  ) : (
    <div className="flex w-full items-center gap-1.5 px-2 pb-1 pt-2">
      <FileIcon weight="duotone" className="h-3.5 w-3.5 shrink-0 text-stone-400" />
      <span className="min-w-0 truncate text-[12px] text-stone-700">
        {file.filePath}
      </span>
      <FileStatusPill file={file} />
      {summary ? (
        <span className="text-[10px] text-stone-400">{summary}</span>
      ) : null}
    </div>
  );

  return (
    <div className="group/file" data-testid="turn-edit-file-block" data-file-path={file.filePath}>
      {headerRow}
      {!effectiveCollapsed ? (
        <div className="space-y-1.5 overflow-x-auto px-3 pb-2 text-[12px] leading-5 sm:text-[13px]">
          {file.oversized ? <OversizedFileNotice file={file} /> : null}
          {file.blob ? <BlobFileNotice file={file} projectId={projectId} /> : null}
          {file.chunks.map((chunk) => {
            const dimmed = allActive || fileUndoActive;
            if (!actionable) {
              return (
                <div key={chunk.id} className={dimmed ? 'opacity-60' : ''}>
                  <StaticChunk chunk={chunk} />
                </div>
              );
            }
            // Accept/reject is whole-FILE (the per-file ✓/✕ in the header, or the
            // turn's Keep all for a single-file turn) — a suggest turn is one
            // mark group per file, so per-block review stays in the editor. The
            // chunks render read-only here (`hideButtons`).
            return (
              <div
                key={chunk.id}
                className={`prose prose-sm max-w-none transition-opacity ${dimmed ? 'opacity-60' : ''}`}
              >
                <InlineDocDiff
                  chunk={chunk}
                  filePath={file.filePath}
                  renderAsMarks
                  hideButtons
                  onKeep={() => onKeepChunk(file.filePath, chunk.id)}
                  onUndo={() => onUndoChunk(file.filePath, chunk.id)}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function InlineTurnReview({
  files,
  activeUndoKey,
  isLatestTurn,
  assistantMessageId,
  projectId,
  onKeepChunk,
  onUndoChunk,
  onKeepAll,
  onUndoAll,
  onReExpand,
  defaultDiffExpanded = false,
}: InlineTurnReviewProps) {
  const pendingCount = useMemo(() => countPending(files), [files]);
  const { added: totalAdded, deleted: totalDeleted } = useMemo(
    () => countTotalWords(files),
    [files],
  );
  const allActive = activeUndoKey === '__all__';
  const [showAllFiles, setShowAllFiles] = useState(false);
  // The diff body is also rendered inline in the editor, so the chat keeps it
  // collapsed by default — the summary bar (file, counts, Undo/Keep all) is
  // enough to act on, and the caret expands the full diff on demand. A diff
  // deep-link (`?diff=`) opens it expanded so the link lands on the changes.
  const [diffExpanded, setDiffExpanded] = useState(defaultDiffExpanded);

  const allUndone = useMemo(() => {
    // Oversized/blob placeholders have no chunks and can't be undone, so a turn
    // that still touches one is never fully undone. Only count files with chunks.
    if (files.some((file) => file.oversized || file.blob)) return false;
    const reviewable = files.filter((file) => file.chunks.length > 0);
    return (
      reviewable.length > 0 &&
      reviewable.every((file) => file.chunks.every((chunk) => chunk.status === 'undone'))
    );
  }, [files]);

  if (files.length === 0) return null;

  const isMulti = files.length > 1;
  const manyFiles = files.length > COLLAPSE_FILES_THRESHOLD;
  const overflows = files.length > INITIAL_VISIBLE_FILES;
  const visibleFiles = overflows && !showAllFiles ? files.slice(0, INITIAL_VISIBLE_FILES) : files;
  const hiddenCount = files.length - visibleFiles.length;
  const summaryLabel = isMulti
    ? `Edited ${files.length} files`
    : (files[0]?.filePath ?? '');
  const singleFile = !isMulti ? files[0] : undefined;

  const toggleDiff = () => {
    // `onReExpand` triggers a parent setState (TurnEditsCard.load), so it must
    // run in the event handler — not inside the setDiffExpanded updater, which
    // executes during render and would update the parent mid-render.
    const next = !diffExpanded;
    setDiffExpanded(next);
    if (next) onReExpand?.();
  };

  return (
    <div
      data-testid="inline-turn-review"
      className="group/turn mt-2 w-fit max-w-full overflow-hidden rounded-lg border border-stone-200 bg-stone-50/60 text-[12px] text-stone-600"
    >
      {files.map((file) => (
        <span
          key={file.filePath}
          hidden
          data-testid="turn-edit-file"
          data-file-path={file.filePath}
        />
      ))}
      <div className="flex min-w-0 items-center gap-2 px-2 py-1">
        <button
          type="button"
          onClick={toggleDiff}
          aria-expanded={diffExpanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-stone-800"
        >
          <CaretRight
            weight="bold"
            className={`h-3 w-3 shrink-0 text-stone-400 transition-transform ${diffExpanded ? 'rotate-90' : ''}`}
          />
          <span
            className="min-w-0 truncate text-stone-700"
            title={isMulti ? undefined : summaryLabel}
          >
            {isMulti ? summaryLabel : basename(summaryLabel)}
          </span>
          <LineCountBadge added={totalAdded} deleted={totalDeleted} />
          {singleFile ? <FileStatusPill file={singleFile} /> : null}
          {/* Only label "Reviewed/Rejected" when there were chunks to act on —
              an oversized-only turn has nothing to review. */}
          {pendingCount === 0 && files.some((file) => file.chunks.length > 0) ? (
            <span className="shrink-0 text-[11px] text-stone-400">
              {allUndone ? 'Rejected' : 'Reviewed'}
            </span>
          ) : null}
        </button>
        {pendingCount > 0 ? (
          <div className="flex shrink-0 items-center gap-1 border-l border-stone-200/80 pl-2">
            <IconAction glyph="✕" title="Reject all" onClick={onUndoAll} loading={allActive} variant="reject" />
            <IconAction glyph="✓" title="Keep all" onClick={onKeepAll} disabled={allActive} variant="accept" />
          </div>
        ) : null}
        {assistantMessageId ? (
          <div className="shrink-0 border-l border-stone-200/80 pl-2">
            <CopyLinkButton
              url={typeof window === 'undefined' ? '' : `${window.location.origin}/d/${assistantMessageId}`}
              label="Copy diff link"
            />
          </div>
        ) : null}
      </div>

      {diffExpanded ? (
        <>
          <div className="divide-y divide-stone-200/80 border-t border-stone-200/80 bg-white/50">
            {visibleFiles.map((file) => (
              <FileBlock
                key={file.filePath}
                file={file}
                isMulti={isMulti}
                activeUndoKey={activeUndoKey}
                defaultCollapsed={manyFiles}
                readOnly={allUndone}
                showHeaderRow={isMulti}
                projectId={projectId}
                onKeepChunk={onKeepChunk}
                onUndoChunk={onUndoChunk}
              />
            ))}
          </div>

          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAllFiles(true)}
              className="flex w-full items-center justify-center gap-1 border-t border-stone-200/80 px-2 py-1.5 text-[11px] font-medium text-stone-500 transition-colors hover:bg-stone-100/80 hover:text-stone-700"
            >
              <CaretDown className="h-3 w-3" weight="bold" />
              {hiddenCount} more {hiddenCount === 1 ? 'file' : 'files'}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => setDiffExpanded(false)}
            className="flex w-full items-center justify-center gap-1 border-t border-stone-200/80 px-2 py-1.5 text-[11px] font-medium text-stone-400 transition-colors hover:bg-stone-100/80 hover:text-stone-600"
          >
            <X className="h-3 w-3" weight="bold" />
            Hide diff
          </button>
        </>
      ) : null}
    </div>
  );
}

// Re-export so consumers can pull the component + helpers from one place.
export type { TurnEditChunk, TurnEditFile };
