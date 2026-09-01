'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import { ChatEditCard } from '@/components/workspace/diff-review/chat-edit-cards';
import { TurnEditsCard } from '@/components/workspace/turn-edits-card';
import { Spinner } from '@/components/ui/spinner';
import type { ChatTurnEditSummary } from '@/lib/workspace/chat-turn-edits';
import {
  groupTurnsByFile,
  mergeFileAcrossTurns,
  turnsWithFileChunks,
} from '@/lib/workspace/chat-file-edits';
import type { TurnEditsResponse } from '@/lib/workspace/turn-edits';
import {
  fetchTurnEdits,
  getCachedTurnEdits,
  setCachedTurnEdits,
  setCachedTurnEditsForScope,
  subscribeTurnEdits,
  turnEditsCacheScope,
} from '@/lib/workspace/turn-edits-cache';
import { readJsonResponse } from '@/lib/http/read-json-response';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';

/** The chat-turn-edits route's hard cap (its builder clamps limit to 100). */
const TURN_LIMIT = 100;

/**
 * Mounts its child only once the placeholder scrolls near the viewport — a long
 * chat's cards each fetch a heavy `/api/workspace/turn-edits` reconstruction,
 * so mounting them all at once fanned out dozens of requests per click (Codex,
 * PR #1104 round 4). The reserved min-height keeps the scrollbar from jumping.
 */
function LazyCard({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || show) return;
    // No IntersectionObserver (jsdom/older shells): render immediately rather
    // than leaving the panel permanently blank.
    if (typeof IntersectionObserver === 'undefined') {
      setShow(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShow(true);
          observer.disconnect();
        }
      },
      // Start a screen early so scrolling rarely meets an empty slot.
      { rootMargin: '600px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [show]);
  return (
    <div ref={ref} className={show ? undefined : 'min-h-[120px]'}>
      {show ? children : null}
    </div>
  );
}

/**
 * Close row for the no-tabs shell — the tabbed shell closes these surfaces at
 * the tab's own ×, so the host omits `onClose` there and no row renders.
 *
 * The × sits at the window's top-LEFT in the same h-11 row, chrome and weight
 * as the chat header's × and the file view's (macOS convention — 2026-08-06
 * founder feedback: floating loose in the top-right padding, it read as a
 * stray, lighter glyph). `insetLeft` clears the floating Home/Sidebar cluster
 * when this surface is the leftmost pane with the rail collapsed.
 */
function PanelHeader({ onClose, insetLeft = 0 }: { onClose?: () => void; insetLeft?: number }) {
  if (!onClose) return null;
  return (
    <div
      className="flex h-11 shrink-0 items-center px-2"
      style={insetLeft ? { paddingLeft: insetLeft } : undefined}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        data-testid="diff-panel-close"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
      >
        <X weight="bold" className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * One card per FILE — every chunk this chat wrote to it, across all of its
 * turns, in chat order (2026-08-06 founder feedback: per-turn cards repeated
 * each file and read as phantom extra edits). Same card component the chat
 * transcript renders, same shared turn-edits cache, so Keep/Undo here and in
 * the chat reflect each other instantly. Keep/Undo fan out to the turns that
 * actually own the chunks.
 */
function ChatFileEditCard({
  filePath,
  turnIds,
  workspaceId,
  onOpenFile,
  refreshToken,
}: {
  filePath: string;
  turnIds: string[];
  workspaceId?: string | null;
  onOpenFile?: (path: string) => void;
  refreshToken?: string | number | null;
}) {
  const apiFetch = useApiFetch();
  const [payloads, setPayloads] = useState<Record<string, TurnEditsResponse | undefined>>({});
  const [settled, setSettled] = useState(false);
  // Token of the last load this card STARTED. `undefined` only before the
  // first one, which rides the shared in-flight dedupe rather than forcing a
  // duplicate turn reconstruction per file card (round 22). Every later token
  // change forces — including one that arrives while the first load is still
  // in flight, which would otherwise adopt a request that predates the new
  // edits (round 31).
  const requestedTokenRef = useRef<string | number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSettled(false);
    const record = (turnId: string, payload: TurnEditsResponse | null) => {
      if (cancelled || !payload) return;
      setPayloads((prev) => (prev[turnId] === payload ? prev : { ...prev, [turnId]: payload }));
    };
    // `settled` distinguishes "still loading" from "every turn answered and
    // none carried this file" — otherwise a failed fetch left a spinner up
    // forever.
    const force =
      requestedTokenRef.current !== undefined && requestedTokenRef.current !== refreshToken;
    requestedTokenRef.current = refreshToken;
    void Promise.all(
      turnIds.map((turnId) =>
        fetchTurnEdits(apiFetch, turnId, { force }).then((p) => record(turnId, p)),
      ),
    ).finally(() => {
      if (!cancelled) setSettled(true);
    });
    // Keep/Undo from any surface (chat card, editor marks) rewrites the cache.
    const unsubscribes = turnIds.map((turnId) =>
      subscribeTurnEdits(turnId, (payload) => record(turnId, payload)),
    );
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [turnIds, apiFetch, refreshToken]);

  const file = useMemo(
    () => mergeFileAcrossTurns(filePath, turnIds, payloads),
    [filePath, turnIds, payloads],
  );

  const post = useCallback(
    async (route: 'keep-chunk' | 'undo-chunk', body: Record<string, unknown>) => {
      // The answer is authorized under THIS scope; if a narrower share link
      // opens mid-flight it must not be cached under the new one.
      const scope = turnEditsCacheScope();
      const res = await apiFetch(`/api/workspace/turn-edits/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, filePath, workspaceId }),
      });
      const next = await readJsonResponse<
        (TurnEditsResponse & { error?: string }) | { payload?: TurnEditsResponse; error?: string }
      >(res);
      // A stale undo answers 4xx WITH the refreshed payload — adopt it either way.
      const payload = next && 'files' in next ? (next as TurnEditsResponse) : (next as { payload?: TurnEditsResponse })?.payload;
      if (payload && typeof body.assistantMessageId === 'string') {
        setCachedTurnEditsForScope(scope, body.assistantMessageId, payload);
      }
      if (!res.ok) throw new Error((next as { error?: string })?.error || `Request failed (${res.status})`);
      return payload ?? null;
    },
    [apiFetch, filePath, workspaceId],
  );

  // Accept every still-pending chunk this chat left in the file, turn by turn —
  // the chunk ids the user actually saw, never "*" (a hunk re-edited since this
  // card rendered keeps its review).
  const keepFile = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const targets = turnsWithFileChunks(filePath, turnIds, payloads, (s) => s === 'pending').map(
      (turnId) => ({
        turnId,
        ids:
          payloads[turnId]?.files
            .find((entry) => entry.filePath === filePath)
            ?.chunks.filter((chunk) => chunk.status === 'pending')
            .map((chunk) => chunk.id) ?? [],
      }),
    );
    void Promise.all(
      targets.map(({ turnId, ids }) =>
        post('keep-chunk', { assistantMessageId: turnId, chunkIds: ids }),
      ),
    )
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to keep changes'))
      .finally(() => setBusy(false));
  }, [busy, filePath, turnIds, payloads, post]);

  // Mirror of the chat card's ✗ / revert: discard what's pending, or — when the
  // turn has nothing pending — unwind what it applied. Newest turn first so the
  // later text comes out before the edit it was layered on, and one chunk at a
  // time (each undo re-derives the rest from live text).
  const undoFile = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Decided ONCE for the whole CARD, from the state before any undo: with
    // anything pending anywhere in the file this ✕ is a DISCARD and touches
    // pending chunks only — every accepted chunk stays in the document,
    // whichever turn wrote it. Only a fully settled file reverts. Deciding per
    // iteration let draining the pending chunks flip the loop into revert mode
    // (round 15); deciding per TURN let one pending turn's ✕ unwind the
    // settled turns beside it (round 22).
    const chunksOf = (turnId: string) =>
      getCachedTurnEdits(turnId)?.files.find((entry) => entry.filePath === filePath)?.chunks ?? [];
    const discardOnly = turnIds.some((turnId) =>
      chunksOf(turnId).some((chunk) => chunk.status === 'pending'),
    );
    void (async () => {
      try {
        for (const turnId of [...turnIds].reverse()) {
          if (chunksOf(turnId).length === 0) continue;
          const tried = new Set<string>();
          for (;;) {
            const target = chunksOf(turnId).find(
              (chunk) => chunk.status === 'pending' || (!discardOnly && chunk.status === 'kept'),
            );
            // A no-op revert leaves the chunk as it was — `tried` keeps the loop
            // strictly advancing instead of spinning on it.
            if (!target || tried.has(target.id)) break;
            tried.add(target.id);
            await post('undo-chunk', { assistantMessageId: turnId, chunkId: target.id });
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to undo changes');
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, filePath, turnIds, post]);

  if (!file) {
    // Quiet grey either way — a diff that can't load is not an error banner.
    return (
      <div className="my-1.5 flex h-8 items-center px-2.5 text-[13px] text-stone-400">
        {settled ? <span>{filePath}</span> : <Spinner label={filePath} size={12} />}
      </div>
    );
  }
  return (
    <div data-testid="chat-file-edit-card" data-file-path={filePath}>
      <ChatEditCard
        file={file}
        // Diff links are per turn — point at the latest turn that touched it.
        assistantMessageId={turnIds[turnIds.length - 1]!}
        projectId={workspaceId ?? undefined}
        busy={busy}
        onKeepFile={keepFile}
        onUndoFile={undoFile}
        onOpenFile={onOpenFile}
      />
      {error ? <div className="px-2.5 pb-1 text-[11px] text-stone-500">{error}</div> : null}
    </div>
  );
}

/**
 * Every edit a chat ever made, grouped by file, in the SAME cards the chat
 * transcript renders. Deliberately headerless beyond the close row: the pane
 * tab already names the chat, and the cards carry their own file names and
 * counts (2026-08-05 founder direction — no wordy headers, no second diff
 * dialect).
 */
export function ChatDiffPanel({
  chatId,
  workspaceId,
  onOpenFile,
  onClose,
  headerInsetLeft,
  refreshToken,
}: {
  chatId: string;
  workspaceId?: string | null;
  onOpenFile?: (path: string) => void;
  /** No-tabs shell only — the tabbed shell closes at the tab's ×. */
  onClose?: () => void;
  /** Left padding for the close row when the floating Home/Sidebar cluster
   *  would cover it (leftmost pane, rail collapsed). */
  headerInsetLeft?: number;
  /** Bumps when new edits land (Realtime INSERT / turn fingerprint). A tab
   *  left open while the chat keeps writing refreshes instead of pinning the
   *  file list and Keep/Undo set to the moment it opened (Codex, PR #1104
   *  round 19). */
  refreshToken?: string | number | null;
}) {
  const [turns, setTurns] = useState<ChatTurnEditSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The workspace's data plane, not bare fetch: local/sidecar workspaces route
  // /api/workspace reads through an emulated fetch (Codex, PR #1104 round 5).
  const apiFetch = useApiFetch();

  const loadedChatRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Only a different chat blanks the list — a refresh updates in place, so
    // the open tab never flashes its spinner while the chat streams.
    if (loadedChatRef.current !== chatId) {
      loadedChatRef.current = chatId;
      setTurns(null);
    }
    setError(null);
    void (async () => {
      try {
        // 100 is the server's hard cap (chat-turn-edits-query clamps there);
        // the truncation notice below keeps a longer history honest.
        const res = await apiFetch(
          `/api/workspace/chat-turn-edits?chatId=${encodeURIComponent(chatId)}&limit=${TURN_LIMIT}`,
          { cache: 'no-store' },
        );
        const data = await readJsonResponse<{ turns?: ChatTurnEditSummary[]; error?: string }>(res);
        if (!res.ok || !data) throw new Error(data?.error || `Failed to load chat edits (${res.status})`);
        if (cancelled) return;
        // Oldest first — each file's chunks then read as the chat's work in
        // order, and the LAST turn is the file's current state. An undated turn
        // is one still streaming (its doc_edits landed before the assistant
        // message row), so it sorts LAST, never first: treating null as ''
        // made the in-flight turn look oldest and ran file undo backwards
        // (Codex, PR #1104 round 14). Sort is stable, so same-instant turns
        // keep the server's order.
        setTurns(
          [...(data.turns ?? [])].sort((a, b) =>
            a.createdAt && b.createdAt
              ? a.createdAt.localeCompare(b.createdAt)
              : (a.createdAt ? 0 : 1) - (b.createdAt ? 0 : 1),
          ),
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load chat edits');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, apiFetch, refreshToken]);

  const fileGroups = useMemo(() => groupTurnsByFile(turns ?? []), [turns]);

  return (
    <div data-testid="chat-diff-panel" className="flex min-h-0 flex-1 flex-col bg-white">
      <PanelHeader onClose={onClose} insetLeft={headerInsetLeft} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto w-full max-w-3xl px-6 pb-6 ${onClose ? 'pt-1' : 'pt-4'}`}>
          {error ? (
            <div className="py-16 text-center text-[13px] text-red-600">{error}</div>
          ) : turns === null ? (
            <Spinner label="Loading edits…" center className="py-16" />
          ) : fileGroups.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-stone-500">
              This chat hasn&rsquo;t edited any files yet.
            </div>
          ) : (
            <div className="space-y-1">
              {/* No silent caps: the route clamps at TURN_LIMIT turns, so a
                  longer chat says what's missing instead of implying this is
                  everything (Codex, PR #1104). */}
              {turns.length >= TURN_LIMIT ? (
                <div data-testid="chat-diff-truncation-notice" className="pb-1 text-[12px] text-stone-500">
                  Showing this chat&rsquo;s latest {TURN_LIMIT} editing turns. Older edits are in the
                  history dock.
                </div>
              ) : null}
              {fileGroups.map((group) => (
                <LazyCard key={group.filePath}>
                  <ChatFileEditCard
                    filePath={group.filePath}
                    turnIds={group.turnIds}
                    workspaceId={workspaceId}
                    onOpenFile={onOpenFile}
                    refreshToken={refreshToken}
                  />
                </LazyCard>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One turn's edits as a tab — the same card the chat shows, full width. */
export function TurnDiffPanel({
  assistantMessageId,
  workspaceId,
  onOpenFile,
  onClose,
  headerInsetLeft,
}: {
  assistantMessageId: string;
  workspaceId?: string | null;
  onOpenFile?: (path: string) => void;
  /** No-tabs shell only — the tabbed shell closes at the tab's ×. */
  onClose?: () => void;
  /** See `ChatDiffPanel`. */
  headerInsetLeft?: number;
}) {
  return (
    <div data-testid="turn-diff-panel" className="flex min-h-0 flex-1 flex-col bg-white">
      <PanelHeader onClose={onClose} insetLeft={headerInsetLeft} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto w-full max-w-3xl px-6 pb-6 ${onClose ? 'pt-1' : 'pt-4'}`}>
          <TurnEditsCard
            assistantMessageId={assistantMessageId}
            variant="inline"
            defaultExpanded
            workspaceId={workspaceId ?? undefined}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>
    </div>
  );
}
