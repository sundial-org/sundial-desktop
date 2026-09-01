'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BlobFileNotice } from '@/components/workspace/diff-review/blob-file-notice';
import { CopyLinkButton } from '@/components/workspace/copy-link-button';
import { DiffSummaryBar } from '@/components/workspace/diff-review/diff-summary-bar';
import { InlineDocDiff } from '@/components/workspace/diff-review/inline-doc-diff';
import { ChatEditCards } from '@/components/workspace/diff-review/chat-edit-cards';
import { Spinner } from '@/components/ui/spinner';
import {
  OversizedFileNotice,
  StaticChunk,
  formatTurnFileSummary,
} from '@/components/workspace/diff-review/turn-edit-helpers';
import { readJsonResponse } from '@/lib/http/read-json-response';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import type { TurnEditFile, TurnEditsResponse } from '@/lib/workspace/turn-edits';
import {
  fetchTurnEdits,
  getCachedTurnEdits,
  setCachedTurnEdits,
  setCachedTurnEditsForScope,
  subscribeTurnEdits,
  turnEditsCacheScope,
} from '@/lib/workspace/turn-edits-cache';

export { StaticChunk, formatTurnFileSummary };

export function TurnEditsCard({
  assistantMessageId,
  initialCount = null,
  initialPayload = null,
  restrictToPaths = null,
  defaultExpanded = false,
  variant = 'card',
  isLatestTurn = true,
  workspaceId,
  onPayloadChange,
  hideBulkActions = false,
  onOpenFile,
}: {
  assistantMessageId: string;
  initialCount?: number | null;
  /**
   * Pre-fetched diff to seed the card with — used by the Review panel for
   * local-agent / human suggestion runs (`human-<rowId>` ids), which the
   * agent-only `/turn-edits` GET can't resolve. When set, the auto-load is
   * skipped; Keep/Undo still route through the shared endpoints by reviewId.
   */
  initialPayload?: TurnEditsResponse | null;
  /**
   * Restrict the visible files (and Keep/Undo-All) to these paths — used by the
   * Review panel under a file/folder scope so the detail can't show or act on
   * files outside the scope. The shared cache still holds the full turn; only
   * this card's view and bulk actions are constrained. Omit = show every file.
   */
  restrictToPaths?: readonly string[] | null;
  defaultExpanded?: boolean;
  variant?: 'card' | 'panel' | 'inline';
  isLatestTurn?: boolean;
  /** Required for `human-local-*` ledger review ids (the Review panel passes it);
   *  the keep/undo routes resolve those by id and have no backing row for the
   *  workspace. Harmless for agent / `human-<rowId>` ids, which resolve it server-side. */
  workspaceId?: string;
  onPayloadChange?: (payload: TurnEditsResponse) => void;
  /** Hide the in-card Keep all / Undo all (the host owns change-level keep/undo,
   *  e.g. the Review panel's verb bar). The single-file summary bar collapses too. */
  hideBulkActions?: boolean;
  /** Render an "Open in editor" action on each file's header. */
  onOpenFile?: (path: string) => void;
}) {
  const isPanelVariant = variant === 'panel';
  const isInlineVariant = variant === 'inline';
  const autoExpand = isPanelVariant || isInlineVariant || defaultExpanded;
  const [expanded, setExpanded] = useState(autoExpand);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<TurnEditsResponse | null>(
    () => getCachedTurnEdits(assistantMessageId) ?? initialPayload ?? null,
  );
  const [activeUndoKey, setActiveUndoKey] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');
  const didAutoExpandRef = useRef(false);

  // Subscribe to shared-cache updates so changes from other surfaces
  // (file editor decorations, etc.) reflect here immediately.
  useEffect(() => {
    return subscribeTurnEdits(assistantMessageId, (next) => {
      setPayload(next);
      onPayloadChange?.(next);
    });
  }, [assistantMessageId, onPayloadChange]);

  const apiFetch = useApiFetch();
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Through the shared loader, never a private fetch: it dedupes in-flight
      // requests and refuses to cache OR deliver an answer authorized under a
      // share scope that has since changed — a private load skipped the cache
      // but still rendered the wider-grant payload (Codex, PR #1104 round 32).
      const nextPayload = await fetchTurnEdits(apiFetch, assistantMessageId);
      if (!nextPayload) {
        throw new Error('Failed to load turn edits');
      }
      setPayload(nextPayload);
      onPayloadChange?.(nextPayload);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load turn edits');
    } finally {
      setLoading(false);
    }
  }, [assistantMessageId, onPayloadChange, apiFetch]);

  useEffect(() => {
    if (!autoExpand || didAutoExpandRef.current) return;
    didAutoExpandRef.current = true;
    setExpanded(true);
    if (!payload && !loading) {
      void load();
    }
  }, [autoExpand, load, loading, payload]);

  useEffect(() => {
    setExpanded(autoExpand);
    setError(null);
    setPayload(getCachedTurnEdits(assistantMessageId) ?? initialPayload ?? null);
    setActiveUndoKey(null);
    setSelectedFilePath('');
    didAutoExpandRef.current = false;
  }, [assistantMessageId, autoExpand]);

  const toggleExpanded = useCallback(() => {
    if (isPanelVariant || isInlineVariant) return;
    setExpanded((current) => {
      const next = !current;
      if (next && !payload && !loading) {
        void load();
      }
      return next;
    });
  }, [isPanelVariant, isInlineVariant, load, loading, payload]);

  const persistKeep = useCallback(
    async (filePath: string, chunkIds: string[] | '*') => {
      const scope = turnEditsCacheScope();
      const response = await apiFetch('/api/workspace/turn-edits/keep-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistantMessageId, filePath, chunkIds, workspaceId }),
      });
      const next = await readJsonResponse<TurnEditsResponse & { error?: string }>(response);
      if (!response.ok) {
        throw new Error(next?.error || `Failed to keep change (${response.status})`);
      }
      if (!next) throw new Error('Failed to keep change');
      setCachedTurnEditsForScope(scope, assistantMessageId, next);
      // Same rule for LOCAL state: an answer from a superseded share scope is
      // not delivered either (Codex, PR #1104 round 32).
      if (turnEditsCacheScope() !== scope) throw new Error('The share link changed. Reload to continue');
      onPayloadChange?.(next);
    },
    [assistantMessageId, workspaceId, onPayloadChange, apiFetch],
  );

  // Keep is whole-FILE: a suggest-mode turn stores one suggestion-mark group per
  // file (one tool_call_id), so accepting resolves every mark in the file at once
  // — the chat card therefore shows ONE Keep/Undo per file (block-level review
  // stays in the editor). The `chunkId` arg is the still-pending member the user
  // clicked; we flip all pending chunks in that file to match the server.
  const keepChunk = useCallback(
    (filePath: string, _chunkId: string) => {
      const current = getCachedTurnEdits(assistantMessageId) ?? payload;
      const ids =
        current?.files.find((f) => f.filePath === filePath)?.chunks
          .filter((c) => c.status === 'pending')
          .map((c) => c.id) ?? [];
      if (ids.length === 0) return;
      if (current) {
        // Optimistic — flip the whole file immediately, rollback on failure.
        setCachedTurnEdits(assistantMessageId, {
          ...current,
          files: current.files.map((file) =>
            file.filePath === filePath
              ? { ...file, chunks: file.chunks.map((c) => (c.status === 'pending' ? { ...c, status: 'kept' } : c)) }
              : file,
          ),
        });
      }
      void persistKeep(filePath, ids).catch((nextError) => {
        if (current) setCachedTurnEdits(assistantMessageId, current);
        setError(nextError instanceof Error ? nextError.message : 'Failed to keep change');
      });
    },
    [assistantMessageId, payload, persistKeep],
  );

  const requestUndo = useCallback(
    async (filePath: string, chunkId: string) => {
      const scope = turnEditsCacheScope();
      const response = await apiFetch('/api/workspace/turn-edits/undo-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistantMessageId, filePath, chunkId, workspaceId }),
      });
      const nextPayload = await readJsonResponse<
        | (TurnEditsResponse & { error?: string })
        | { stale?: boolean; error?: string; payload?: TurnEditsResponse }
      >(response);

      if (!response.ok) {
        if (nextPayload && 'payload' in nextPayload && nextPayload.payload) {
          setCachedTurnEditsForScope(scope, assistantMessageId, nextPayload.payload);
          if (turnEditsCacheScope() === scope) onPayloadChange?.(nextPayload.payload);
        }
        throw new Error(nextPayload?.error || `Failed to undo change (${response.status})`);
      }
      if (!nextPayload) {
        throw new Error('Failed to undo change');
      }

      const payload = nextPayload as TurnEditsResponse;
      setCachedTurnEditsForScope(scope, assistantMessageId, payload);
      if (turnEditsCacheScope() !== scope) throw new Error('The share link changed. Reload to continue');
      onPayloadChange?.(payload);
      return payload;
    },
    [assistantMessageId, workspaceId, onPayloadChange, apiFetch],
  );

  // Undo is whole-FILE too (mirror of keepChunk): reject every still-pending
  // chunk in the file. For a marks-backed turn the first revert resolves all the
  // file's marks at once and the route records the rest undone, so the loop
  // settles after one pass; a legacy text turn reverts chunk-by-chunk.
  const undoChunk = useCallback(
    async (filePath: string, _chunkId: string) => {
      if (activeUndoKey) return;
      setActiveUndoKey(`__file__:${filePath}`);
      setError(null);
      try {
        let nextPayload = getCachedTurnEdits(assistantMessageId) ?? payload;
        const tried = new Set<string>();
        while (nextPayload) {
          const target = nextPayload.files
            .find((f) => f.filePath === filePath)
            ?.chunks.find((c) => c.status === 'pending');
          if (!target || tried.has(target.id)) break;
          tried.add(target.id);
          nextPayload = await requestUndo(filePath, target.id);
          setPayload(nextPayload);
        }
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Failed to undo change');
      } finally {
        setActiveUndoKey(null);
      }
    },
    [activeUndoKey, assistantMessageId, payload, requestUndo],
  );

  const scopeSet = useMemo(
    () => (restrictToPaths && restrictToPaths.length > 0 ? new Set(restrictToPaths) : null),
    [restrictToPaths],
  );
  const inScope = useCallback((filePath: string) => !scopeSet || scopeSet.has(filePath), [scopeSet]);
  // Files this card may show / act on. Identical to `payload.files` (same ref)
  // when unscoped, so chat-side cards behave exactly as before.
  const visibleFiles = useMemo(
    () => (payload ? (scopeSet ? payload.files.filter((f) => scopeSet.has(f.filePath)) : payload.files) : []),
    [payload, scopeSet],
  );

  const keepAll = useCallback(() => {
    const current = getCachedTurnEdits(assistantMessageId) ?? payload;
    if (!current) return;
    // Flip only in-scope files, but keep the rest of the cached payload intact
    // so other surfaces still see the full turn.
    setCachedTurnEdits(assistantMessageId, {
      ...current,
      files: current.files.map((file) =>
        inScope(file.filePath)
          ? { ...file, chunks: file.chunks.map((c) => (c.status === 'pending' ? { ...c, status: 'kept' } : c)) }
          : file,
      ),
    });
    // Keep the chunks the user actually saw (their rendered ids), not "*". With
    // "*" the server keeps whatever is pending NOW, so a hunk another
    // collaborator re-edited since this card rendered would be accepted unseen.
    // Chunk ids are content-derived, so a re-edited hunk's id no longer matches
    // the rendered one and it stays pending for review instead.
    const filesWithPending = current.files
      .filter((f) => inScope(f.filePath))
      .map((f) => ({
        filePath: f.filePath,
        ids: f.chunks.filter((c) => c.status === 'pending').map((c) => c.id),
      }))
      .filter((f) => f.ids.length > 0);
    void Promise.all(filesWithPending.map((f) => persistKeep(f.filePath, f.ids))).catch((nextError) => {
      setCachedTurnEdits(assistantMessageId, current);
      setError(nextError instanceof Error ? nextError.message : 'Failed to keep all changes');
    });
  }, [assistantMessageId, payload, persistKeep, inScope]);

  // Undo every in-scope pending chunk — or, with `onlyFilePath`, just that
  // file's (the chat card's whole-file ✗).
  const undoAll = useCallback(async (onlyFilePath?: string) => {
    if (activeUndoKey) return;
    setActiveUndoKey(onlyFilePath ? `__file__:${onlyFilePath}` : '__all__');
    setError(null);
    try {
      let nextPayload = payload;
      // A no-op revert (the chunk's text is no longer in the file) returns the
      // chunk still `pending`, so "first pending chunk" can repeat forever.
      // Tracking attempted chunks keeps the loop strictly advancing.
      const tried = new Set<string>();
      while (nextPayload) {
        // Stale turns are undoable via the route's text-based revert path, and
        // deleted files via the restore path — undo every file in scope.
        const nextUndoTarget = nextPayload.files
          .filter((file) => inScope(file.filePath) && (!onlyFilePath || file.filePath === onlyFilePath))
          .flatMap((file) => {
            // The scoped call serves two card actions with different reach:
            // DISCARD (pending chunks exist) touches pending only — a
            // partially reviewed suggest file keeps its already-accepted
            // chunks (Codex P1 on #1039). REVERT (nothing pending) unwinds
            // the KEPT chunks (applied edits are born kept; the undo route
            // re-derives chunks from live text, so a kept chunk whose text
            // still matches reverts cleanly and no-ops safely otherwise).
            // "Undo all" (unscoped) stays pending-only.
            const hasPending = file.chunks.some((chunk) => chunk.status === 'pending');
            return file.chunks
              .filter(
                (chunk) =>
                  chunk.status === 'pending' ||
                  (onlyFilePath && !hasPending && chunk.status === 'kept'),
              )
              .map((chunk) => ({ filePath: file.filePath, chunkId: chunk.id }));
          })[0];
        if (!nextUndoTarget) break;
        const triedKey = `${nextUndoTarget.filePath}:${nextUndoTarget.chunkId}`;
        if (tried.has(triedKey)) break;
        tried.add(triedKey);
        nextPayload = await requestUndo(nextUndoTarget.filePath, nextUndoTarget.chunkId);
        setPayload(nextPayload);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to undo all changes');
    } finally {
      setActiveUndoKey(null);
    }
  }, [activeUndoKey, payload, requestUndo, inScope]);

  useEffect(() => {
    if (!visibleFiles.length) {
      setSelectedFilePath('');
      return;
    }
    setSelectedFilePath((current) =>
      current && visibleFiles.some((file) => file.filePath === current)
        ? current
        : visibleFiles[0]!.filePath,
    );
  }, [visibleFiles]);

  const fileCountLabel = useMemo(() => {
    if (payload) return visibleFiles.length;
    return typeof initialCount === 'number' ? initialCount : null;
  }, [initialCount, payload, visibleFiles]);

  const selectedFile = useMemo(
    () =>
      visibleFiles.find((file) => file.filePath === selectedFilePath) ??
      visibleFiles[0] ??
      null,
    [visibleFiles, selectedFilePath],
  );

  // Whole-file controls for the panel's selected file (per-block stays in editor).
  const selectedFilePending = useMemo(
    () => selectedFile?.chunks.find((c) => c.status === 'pending')?.id,
    [selectedFile],
  );
  const fileActionActive = activeUndoKey === `__file__:${selectedFile?.filePath ?? ''}`;
  const content = (
    <div className={isPanelVariant ? '' : 'border-t border-stone-200'}>
      {loading ? <div className="px-4 py-4 text-sm"><Spinner label="Loading changes…" /></div> : null}
      {!loading && error ? <div className="px-4 pt-4 text-sm text-red-600">{error}</div> : null}
      {!loading && payload?.allUndone ? (
        <div className="px-4 py-4 text-sm text-stone-500">All tracked text changes from this turn were undone.</div>
      ) : null}
      {!loading && payload && !payload.allUndone && visibleFiles.length === 0 ? (
        <div className="px-4 py-4 text-sm text-stone-500">This turn did not produce a reviewable text diff.</div>
      ) : null}
      {!loading && visibleFiles.length && selectedFile ? (
        <div>
          {!hideBulkActions || visibleFiles.length > 1 ? (
            <DiffSummaryBar
              files={visibleFiles}
              onKeepAll={keepAll}
              onUndoAll={() => void undoAll()}
              onSelectFile={setSelectedFilePath}
              selectedFilePath={selectedFile.filePath}
              hideBulkActions={hideBulkActions}
              extraAction={
                <CopyLinkButton
                  url={typeof window === 'undefined' ? '' : `${window.location.origin}/d/${assistantMessageId}`}
                  label="Copy diff link"
                />
              }
            />
          ) : null}
          <div className={isPanelVariant ? 'p-0' : 'p-4'}>
            {/* Panel (Review surface) flattens onto the stone-50 surface instead
                of a stark white card; the chat card keeps its white background. */}
            <div
              className={
                isPanelVariant
                  ? 'overflow-hidden rounded-xl border border-stone-200'
                  : 'rounded-xl border border-stone-200 bg-white'
              }
            >
              <div className="flex items-center gap-3 border-b border-stone-100 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-stone-800">
                    {selectedFile.filePath}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-stone-500">
                    {formatTurnFileSummary(selectedFile) ? (
                      <span className="rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 font-medium">
                        {formatTurnFileSummary(selectedFile)}
                      </span>
                    ) : null}
                    {selectedFile.isNew ? (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                        New file
                      </span>
                    ) : null}
                    {selectedFile.isDeleted ? (
                      <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 font-medium text-red-700">
                        Deleted file
                      </span>
                    ) : null}
                  </div>
                </div>
                {onOpenFile ? (
                  <button
                    type="button"
                    data-testid="open-in-editor"
                    onClick={() => onOpenFile(selectedFile.filePath)}
                    title="Open this file in the editor"
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 py-1 text-[12px] font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-800"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    Open in editor
                  </button>
                ) : null}
                {/* Accept/reject is whole-FILE (one mark group per file); per-block
                    review stays in the editor. */}
                {selectedFilePending ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void undoChunk(selectedFile.filePath, selectedFilePending)}
                      disabled={fileActionActive}
                      className="rounded-md border border-stone-200 px-2 py-1 text-[11px] font-medium text-stone-600 transition-colors hover:bg-stone-50 disabled:opacity-50"
                    >
                      Reject file
                    </button>
                    <button
                      type="button"
                      onClick={() => keepChunk(selectedFile.filePath, selectedFilePending)}
                      disabled={fileActionActive}
                      className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                    >
                      Keep file
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="space-y-3 px-4 py-4">
                {selectedFile.oversized ? <OversizedFileNotice file={selectedFile} /> : null}
                {selectedFile.blob ? (
                  <BlobFileNotice file={selectedFile} projectId={payload?.projectId ?? workspaceId} />
                ) : null}
                {selectedFile.chunks.map((chunk) => (
                  <div
                    key={chunk.id}
                    className={fileActionActive || activeUndoKey === '__all__' ? 'pointer-events-none opacity-60' : ''}
                  >
                    <InlineDocDiff
                      chunk={chunk}
                      filePath={selectedFile.filePath}
                      renderAsMarks={!isPanelVariant}
                      hideButtons
                      onKeep={() => keepChunk(selectedFile.filePath, chunk.id)}
                      onUndo={() => void undoChunk(selectedFile.filePath, chunk.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (isInlineVariant) {
    if (loading && !payload) {
      return (
        <div className="mt-1 flex h-6 w-fit max-w-full items-center text-[12px]">
          <Spinner label="Loading changes…" size={12} />
        </div>
      );
    }
    if (error) {
      // Quiet grey, no red banner (chat design rules).
      return (
        <div className="mt-1 flex h-6 items-center text-[14px] text-stone-500">{error}</div>
      );
    }
    if (!payload || visibleFiles.length === 0) {
      return null;
    }
    // Per-file edit cards (2026-08-01 design) — keep/undo is whole-file, same
    // semantics as the old InlineTurnReview (one mark group per file).
    return (
      <ChatEditCards
        files={visibleFiles}
        assistantMessageId={assistantMessageId}
        projectId={payload?.projectId ?? workspaceId}
        activeUndoKey={activeUndoKey}
        defaultExpanded={defaultExpanded}
        onKeepFile={(filePath) => keepChunk(filePath, '')}
        onUndoFile={(filePath) => void undoAll(filePath)}
        onOpenFile={onOpenFile}
      />
    );
  }

  if (isPanelVariant) {
    return content;
  }

  const cardFiles = visibleFiles;
  const chipFiles = cardFiles.slice(0, 3);
  const moreFiles = Math.max(0, cardFiles.length - chipFiles.length);
  const allReviewed =
    cardFiles.some((file) => file.chunks.length > 0) &&
    cardFiles.every((file) => file.chunks.every((chunk) => chunk.status !== 'pending'));
  const titleText =
    cardFiles.length === 1
      ? `Edited ${baseName(cardFiles[0]!.filePath)}`
      : fileCountLabel !== null
        ? `Edited ${fileCountLabel} ${fileCountLabel === 1 ? 'file' : 'files'}`
        : 'Edited files';

  return (
    <div className="mt-3 rounded-2xl border border-stone-200 bg-stone-50/80">
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-stone-100/80"
      >
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-600">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-stone-800">{titleText}</span>
            {allReviewed ? (
              <span className="shrink-0 rounded-full border border-stone-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-stone-400">
                Reviewed
              </span>
            ) : null}
          </div>
          {chipFiles.length ? (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {chipFiles.map((file) => (
                <span
                  key={file.filePath}
                  className="max-w-[160px] truncate rounded border border-stone-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-stone-500"
                  title={file.filePath}
                >
                  {baseName(file.filePath)}
                </span>
              ))}
              {moreFiles > 0 ? (
                <span className="text-[10px] text-stone-400">+{moreFiles} more</span>
              ) : null}
            </div>
          ) : (
            <div className="text-xs text-stone-500">
              {fileCountLabel !== null ? 'Tap to review changes' : 'Load turn changes'}
            </div>
          )}
        </div>
        <svg
          className={`h-4 w-4 shrink-0 text-stone-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {expanded ? content : null}
    </div>
  );
}

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
