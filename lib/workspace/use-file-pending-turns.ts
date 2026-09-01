'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { readJsonResponse } from '@/lib/http/read-json-response';
import type { ChatTurnEditSummary } from '@/lib/workspace/chat-turn-edits';
import type { FilePendingEditsResponse } from '@/lib/workspace/api-shared-types';
import type { TurnEditsResponse } from '@/lib/workspace/turn-edits';
import { withPathShareToken } from '@/lib/workspace/path-share-token-client';

// Keep/Undo must carry the sticky ?pshare= token for path-share editors.
const pshareFetch = withPathShareToken((input, init) => fetch(input, init));
import {
  getCachedTurnEdits,
  setCachedTurnEdits,
  subscribeTurnEdits,
  subscribeTurnEditsCache,
} from '@/lib/workspace/turn-edits-cache';
// Bundled payloads from `/api/workspace/file-pending-edits` are scoped to one
// `filePath` and intentionally NOT written to the shared cache — that cache
// holds full multi-file `TurnEditsResponse` from the chat-side card, and a
// single-file payload would clobber the other files. We only touch the cache
// for optimistic keep/undo, and we merge into the existing cached entry so
// other files survive.

export type FilePendingTurn = {
  assistantMessageId: string;
  chatId: string | null;
  /** Transcript message id for the author chip's jump, when it differs from
   *  `assistantMessageId` (local sessions). Absent → the id itself. */
  jumpMessageId?: string | null;
  authorId: string | null;
  createdAt: string | null;
  messagePreview: string;
  payload: TurnEditsResponse | null;
  error: string | null;
};

export type UseFilePendingTurns = {
  turns: FilePendingTurn[];
  /** Y.Doc suggestion mark id → the turn that wrote it. Agent marks only. */
  suggestionTurns: Record<string, string>;
  loading: boolean;
  error: string | null;
  activeUndoKey: string | null;
  keepChunk: (assistantMessageId: string, filePath: string, chunkId: string) => void;
  undoChunk: (assistantMessageId: string, filePath: string, chunkId: string) => Promise<void>;
};

function scopePayloadToFile(payload: TurnEditsResponse, fp: string): TurnEditsResponse | null {
  const fileEntry = payload.files.find((file) => file.filePath === fp);
  if (!fileEntry) return null;
  return { ...payload, files: [fileEntry] };
}

function mapPayloadChunk(
  payload: TurnEditsResponse,
  filePath: string,
  chunkId: string,
  status: 'kept' | 'undone',
): TurnEditsResponse {
  return {
    ...payload,
    files: payload.files.map((file) =>
      file.filePath === filePath
        ? {
            ...file,
            chunks: file.chunks.map((chunk) =>
              chunk.id === chunkId ? { ...chunk, status } : chunk,
            ),
          }
        : file,
    ),
  };
}

/** Optimistic flip for a whole-run Accept/Reject (`chunkId === '*'`): mark
 *  every still-pending chunk in `filePath` with the new status. */
function mapAllPendingChunks(
  payload: TurnEditsResponse,
  filePath: string,
  status: 'kept' | 'undone',
): TurnEditsResponse {
  return {
    ...payload,
    files: payload.files.map((file) =>
      file.filePath === filePath
        ? {
            ...file,
            chunks: file.chunks.map((chunk) =>
              chunk.status === 'pending' ? { ...chunk, status } : chunk,
            ),
          }
        : file,
    ),
  };
}

function hasPendingChunks(payload: TurnEditsResponse): boolean {
  return payload.files.some((file) => file.chunks.some((chunk) => chunk.status === 'pending'));
}

function mergeCachePayloadIntoState(
  filePath: string,
  assistantMessageId: string,
  payload: TurnEditsResponse,
  setSummaries: Dispatch<SetStateAction<ChatTurnEditSummary[]>>,
  setPayloadsByTurn: Dispatch<SetStateAction<Record<string, TurnEditsResponse>>>,
) {
  const scoped = scopePayloadToFile(payload, filePath);
  if (!scoped || (!hasPendingChunks(scoped) && !scoped.allUndone)) return;
  setPayloadsByTurn((prev) =>
    prev[assistantMessageId] === scoped ? prev : { ...prev, [assistantMessageId]: scoped },
  );
  setSummaries((prev) => {
    if (prev.some((turn) => turn.assistantMessageId === assistantMessageId)) return prev;
    return [
      {
        assistantMessageId,
        chatId: null,
        authorId: null,
        createdAt: null,
        editedFileCount: 1,
        filePaths: [filePath],
        messagePreview: '',
      },
      ...prev,
    ];
  });
}

/**
 * Returns every assistant turn that has pending edits for `filePath` in the
 * workspace — across all chats. Cross-chat by design so the inline diff
 * overlay surfaces edits from other collaborators / other chats.
 *
 * Refetch triggers:
 *  - `workspaceId` / `filePath` change (mount or file switch — clears state)
 *  - `invalidationToken` change (any upstream signal: realtime INSERT,
 *    visibility/focus, chat-side message metadata flip, etc.)
 *
 * Bundled response: the server ships every turn's payload alongside the
 * summary, so one fetch gets everything. No per-turn round-trips.
 */
export function useFilePendingTurns(
  workspaceId: string | null,
  filePath: string | null,
  invalidationToken: string = '',
  // Local (sidecar) workspaces pass the page's shimmed apiFetch; cloud callers
  // omit it and keep the pshare-token fetch. Must be referentially stable.
  fetcher: typeof fetch = pshareFetch,
): UseFilePendingTurns {
  const [summaries, setSummaries] = useState<ChatTurnEditSummary[]>([]);
  const [payloadsByTurn, setPayloadsByTurn] = useState<Record<string, TurnEditsResponse>>({});
  const [errorsByTurn, setErrorsByTurn] = useState<Record<string, string | null>>({});
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [activeUndoKey, setActiveUndoKey] = useState<string | null>(null);
  const [suggestionTurns, setSuggestionTurns] = useState<Record<string, string>>({});
  // Tracks the (workspace, path) pair we last fetched for, so we can drop
  // stale state synchronously when the user navigates between files.
  const lastFetchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!workspaceId || !filePath) {
      lastFetchKeyRef.current = null;
      setSummaries([]);
      setPayloadsByTurn({});
      setErrorsByTurn({});
      setSuggestionTurns({});
      return;
    }
    const fetchKey = `${workspaceId}:${filePath}`;
    const isFileSwitch = lastFetchKeyRef.current !== fetchKey;
    if (isFileSwitch) {
      // Only clear local state on a true file/workspace switch. Otherwise
      // the existing overlay stays visible during refresh (stale-while-
      // revalidate), avoiding flicker on every realtime nudge.
      lastFetchKeyRef.current = fetchKey;
      setSummaries([]);
      setPayloadsByTurn({});
      setErrorsByTurn({});
      setSuggestionTurns({});
    }
    let cancelled = false;
    setSummaryLoading(true);
    setSummaryError(null);
    void (async () => {
      try {
        const response = await fetcher(
          `/api/workspace/file-pending-edits?workspaceId=${encodeURIComponent(workspaceId)}&filePath=${encodeURIComponent(filePath)}`,
          { cache: 'no-store' },
        );
        const next = await readJsonResponse<FilePendingEditsResponse & { error?: string }>(response);
        if (cancelled) return;
        if (!response.ok) throw new Error(next?.error || `Failed to load pending edits (${response.status})`);
        if (!next) throw new Error('Failed to load pending edits');
        const bundled = next.payloads ?? {};
        const turnIds = new Set(next.turns.map((t) => t.assistantMessageId));
        setPayloadsByTurn((prev) => {
          const merged: Record<string, TurnEditsResponse> = {};
          for (const [id, payload] of Object.entries(prev)) {
            if (turnIds.has(id) && !bundled[id]) merged[id] = payload;
          }
          for (const [id, payload] of Object.entries(bundled)) {
            merged[id] = payload;
          }
          return merged;
        });
        // Keep the prior array identity when the turn list is unchanged: the
        // subscribe effect below depends on `summaries`, so a fresh array on
        // every poll would tear down and rebuild every subscription.
        setSummaries((prev) =>
          JSON.stringify(prev) === JSON.stringify(next.turns) ? prev : next.turns,
        );
        // Same identity-preserving compare: this map feeds a ProseMirror
        // decoration rebuild, so a fresh object per poll would repaint the
        // gutter controls on every 1s realtime nudge.
        setSuggestionTurns((prev) => {
          const incoming = next.suggestionTurns ?? {};
          return JSON.stringify(prev) === JSON.stringify(incoming) ? prev : incoming;
        });
      } catch (err) {
        if (cancelled) return;
        setSummaryError(err instanceof Error ? err.message : 'Failed to load pending edits');
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath, invalidationToken, fetcher]);

  // Chat-side TurnEditsCard loads `/api/workspace/turn-edits` and writes the
  // full payload to the shared cache before `file-pending-edits` returns.
  // Hydrate immediately so the inline overlay can paint in the same tick.
  useEffect(() => {
    if (!filePath) return;
    return subscribeTurnEditsCache((assistantMessageId, payload) => {
      mergeCachePayloadIntoState(filePath, assistantMessageId, payload, setSummaries, setPayloadsByTurn);
    });
  }, [filePath]);

  // Pick up cross-component updates from chat-side TurnEditsCard
  // (Keep/Undo from the chat panel reflects in the inline overlay).
  useEffect(() => {
    const unsubs = summaries.map((turn) =>
      subscribeTurnEdits(turn.assistantMessageId, (payload) => {
        const scoped = scopePayloadToFile(payload, filePath ?? '') ?? payload;
        setPayloadsByTurn((prev) =>
          prev[turn.assistantMessageId] === scoped
            ? prev
            : { ...prev, [turn.assistantMessageId]: scoped },
        );
      }),
    );
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [summaries, filePath]);

  const keepChunk = useCallback(
    (assistantMessageId: string, fp: string, chunkId: string) => {
      // Update the local single-file payload so the inline overlay reflects
      // the keep immediately. Mirror the optimistic flip into the shared
      // cache too — but onto the existing (possibly multi-file) cached entry
      // if present, so other files don't disappear from the chat card.
      const all = chunkId === '*';
      const flip = (p: TurnEditsResponse) =>
        all ? mapAllPendingChunks(p, fp, 'kept') : mapPayloadChunk(p, fp, chunkId, 'kept');
      const localCached = payloadsByTurn[assistantMessageId];
      if (localCached) {
        setPayloadsByTurn((prev) => ({
          ...prev,
          [assistantMessageId]: flip(localCached),
        }));
      }
      const sharedCached = getCachedTurnEdits(assistantMessageId);
      if (sharedCached) {
        setCachedTurnEdits(assistantMessageId, flip(sharedCached));
      }
      void (async () => {
        try {
          const response = await fetcher('/api/workspace/turn-edits/keep-chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              assistantMessageId,
              filePath: fp,
              chunkIds: all ? '*' : [chunkId],
              // Ledger-id (`human-local-*`) resolution needs the workspace; no
              // backing doc_edits row to derive it from server-side.
              workspaceId,
            }),
          });
          const next = await readJsonResponse<TurnEditsResponse & { error?: string }>(response);
          if (!response.ok) {
            if (sharedCached) setCachedTurnEdits(assistantMessageId, sharedCached);
            if (localCached)
              setPayloadsByTurn((prev) => ({ ...prev, [assistantMessageId]: localCached }));
            throw new Error(next?.error || `Failed to keep change (${response.status})`);
          }
          // Server returns the full multi-file payload — safe to write to the
          // shared cache. Local payload stays single-file (filter to fp).
          if (next) {
            setCachedTurnEdits(assistantMessageId, next);
            const fileEntry = next.files.find((f) => f.filePath === fp);
            setPayloadsByTurn((prev) => ({
              ...prev,
              [assistantMessageId]: {
                ...next,
                files: fileEntry ? [fileEntry] : [],
              },
            }));
          }
        } catch (err) {
          setErrorsByTurn((prev) => ({
            ...prev,
            [assistantMessageId]: err instanceof Error ? err.message : 'Failed to keep change',
          }));
        }
      })();
    },
    [payloadsByTurn, workspaceId, fetcher],
  );

  const undoChunk = useCallback(
    async (assistantMessageId: string, fp: string, chunkId: string) => {
      if (activeUndoKey) return;
      setActiveUndoKey(`${assistantMessageId}:${fp}:${chunkId}`);
      try {
        const response = await fetcher('/api/workspace/turn-edits/undo-chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assistantMessageId, filePath: fp, chunkId, workspaceId }),
        });
        const next = await readJsonResponse<TurnEditsResponse & { error?: string }>(response);
        if (!response.ok) throw new Error(next?.error || `Failed to undo change (${response.status})`);
        if (!next) throw new Error('Failed to undo change');
        // Server returns full multi-file payload — safe for shared cache.
        // Project to single-file for our local state.
        setCachedTurnEdits(assistantMessageId, next);
        const fileEntry = next.files.find((f) => f.filePath === fp);
        setPayloadsByTurn((prev) => ({
          ...prev,
          [assistantMessageId]: { ...next, files: fileEntry ? [fileEntry] : [] },
        }));
      } catch (err) {
        setErrorsByTurn((prev) => ({
          ...prev,
          [assistantMessageId]: err instanceof Error ? err.message : 'Failed to undo change',
        }));
      } finally {
        setActiveUndoKey(null);
      }
    },
    [activeUndoKey, workspaceId, fetcher],
  );

  const turns = useMemo<FilePendingTurn[]>(
    () =>
      summaries.map((summary) => ({
        assistantMessageId: summary.assistantMessageId,
        jumpMessageId: summary.jumpMessageId ?? null,
        chatId: summary.chatId ?? null,
        authorId: summary.authorId ?? null,
        createdAt: summary.createdAt ?? null,
        messagePreview: summary.messagePreview,
        payload: payloadsByTurn[summary.assistantMessageId] ?? null,
        error: errorsByTurn[summary.assistantMessageId] ?? null,
      })),
    [summaries, payloadsByTurn, errorsByTurn],
  );

  return {
    turns,
    suggestionTurns,
    loading: summaryLoading,
    error: summaryError,
    activeUndoKey,
    keepChunk,
    undoChunk,
  };
}
