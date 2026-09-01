'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowSquareOut,
  ArrowsClockwise,
  File as FileIcon,
  X,
} from '@phosphor-icons/react';
import {
  DiffAwareFileView,
  type DiffAwareFileViewHandle,
} from '@/components/workspace/diff-review/diff-aware-file-view';
import { BlobFileNotice } from '@/components/workspace/diff-review/blob-file-notice';
import { OversizedFileNotice } from '@/components/workspace/diff-review/turn-edit-helpers';
import type { FilePendingTurn } from '@/lib/workspace/use-file-pending-turns';
import type { TurnEditFile, TurnEditsResponse } from '@/lib/workspace/turn-edits';
import { useAuth } from '@/lib/auth/optional-auth';
import { usePathShareRealtimeAuthReady } from '@/lib/workspace/use-path-share-realtime-ready';
import { createBrowserClient } from '@/lib/supabase/browser';
import { withPathShareToken } from '@/lib/workspace/path-share-token-client';

// Review actions must carry the sticky ?pshare= token for path-share editors.
const pshareFetch = withPathShareToken((input, init) => fetch(input, init));
import {
  getCachedTurnEdits,
  setCachedTurnEdits,
  subscribeTurnEdits,
} from '@/lib/workspace/turn-edits-cache';

interface FileDiffPageProps {
  assistantMessageId: string;
  chatId: string;
  initialPayload: TurnEditsResponse;
  latestAssistantMessageIdInChat: string | null;
  workspaceHref?: string | null;
  workspaceTitle: string;
  isAnonReadOnly: boolean;
}

type ToastState = {
  msg: string;
  retry?: () => void;
} | null;

const POLL_INTERVAL_MS = 30_000;

function payloadToPendingTurns(
  payload: TurnEditsResponse,
  assistantMessageId: string,
): FilePendingTurn[] {
  return [
    {
      assistantMessageId,
      chatId: null,
      authorId: null,
      createdAt: null,
      messagePreview: '',
      payload,
      error: null,
    },
  ];
}

function fileCounts(file: TurnEditFile) {
  let adds = 0;
  let dels = 0;
  let pending = 0;
  let kept = 0;
  let undone = 0;
  for (const chunk of file.chunks) {
    if (chunk.status === 'pending') pending += 1;
    else if (chunk.status === 'kept') kept += 1;
    else if (chunk.status === 'undone') undone += 1;
    for (const line of chunk.lines) {
      if (line.type === 'addition') adds += 1;
      else if (line.type === 'deletion') dels += 1;
    }
  }
  return { adds, dels, pending, kept, undone };
}

function totals(payload: TurnEditsResponse) {
  let total = 0;
  let kept = 0;
  let undone = 0;
  let pending = 0;
  for (const file of payload.files) {
    for (const chunk of file.chunks) {
      total += 1;
      if (chunk.status === 'kept') kept += 1;
      else if (chunk.status === 'undone') undone += 1;
      else pending += 1;
    }
  }
  return { total, kept, undone, pending };
}

function sanitizeWorkspaceHref(workspaceHref: string | null | undefined) {
  if (!workspaceHref) return null;
  const url = new URL(workspaceHref, 'https://sundial.local');
  url.searchParams.delete('chatId');
  url.searchParams.delete('review');
  return `${url.pathname}${url.search}${url.hash}`;
}

function buildWorkspaceFileHref(
  workspaceHref: string | null | undefined,
  file: Pick<TurnEditFile, 'fileId' | 'filePath' | 'isDeleted'>,
) {
  if (!workspaceHref || file.isDeleted) return null;
  const sanitized = sanitizeWorkspaceHref(workspaceHref);
  if (!sanitized) return null;
  const url = new URL(sanitized, 'https://sundial.local');
  if (file.fileId) {
    url.searchParams.set('fileId', file.fileId);
  } else {
    url.searchParams.set('filePath', file.filePath);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function FileDiffPage({
  assistantMessageId,
  chatId,
  initialPayload,
  latestAssistantMessageIdInChat,
  workspaceHref,
  workspaceTitle,
  isAnonReadOnly,
}: FileDiffPageProps) {
  const [payload, setPayload] = useState<TurnEditsResponse>(initialPayload);
  const [latestId, setLatestId] = useState<string | null>(latestAssistantMessageIdInChat);
  const [activeUndoKey, setActiveUndoKey] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const fileRefs = useRef(new Map<string, DiffAwareFileViewHandle | null>());
  const lastSyncRef = useRef(0);
  const sanitizedWorkspaceHref = useMemo(
    () => sanitizeWorkspaceHref(workspaceHref),
    [workspaceHref],
  );

  const isLatest = latestId === assistantMessageId;
  const t = useMemo(() => totals(payload), [payload]);

  // Hydrate the shared cache so /w side stays in sync if both surfaces are open.
  useEffect(() => {
    setCachedTurnEdits(assistantMessageId, payload);
  }, [assistantMessageId, payload]);

  // Listen for cache updates from the workspace side (chat-side TurnEditsCard).
  useEffect(() => {
    return subscribeTurnEdits(assistantMessageId, (next) => {
      setPayload((prev) => (prev === next ? prev : next));
    });
  }, [assistantMessageId]);

  const refetch = useCallback(async () => {
    try {
      const res = await pshareFetch(
        `/api/workspace/turn-edits?assistantMessageId=${encodeURIComponent(assistantMessageId)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) return;
      const next = (await res.json()) as TurnEditsResponse;
      setPayload(next);
      setCachedTurnEdits(assistantMessageId, next);
      lastSyncRef.current = Date.now();
    } catch {
      /* swallow — visibility-poll will retry */
    }
  }, [assistantMessageId]);

  const refetchLatestId = useCallback(async () => {
    try {
      const res = await pshareFetch(
        `/api/workspace/messages?chatId=${encodeURIComponent(chatId)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages: Array<{ id: string; role: string }>;
      };
      const latest = (data.messages ?? [])
        .filter((m) => m.role === 'assistant')
        .map((m) => m.id)
        .pop() ?? null;
      setLatestId(latest);
    } catch {
      /* swallow */
    }
  }, [chatId]);

  // ── Realtime: new turn detection + chunk-decision sync from other surfaces.
  // Clerk-only ON PURPOSE (not useAuthReady): sd_ desktop credentials carry
  // no Supabase JWT, so this postgres_changes subscribe would join as anon
  // and receive nothing. Desktop parity is an sd_ -> Realtime-token follow-up.
  const { isLoaded: isClerkLoaded } = useAuth();
  const pshareRealtimeReady = usePathShareRealtimeAuthReady();
  useEffect(() => {
    if (!isClerkLoaded || !pshareRealtimeReady) return; // realtime needs the Clerk or pshare JWT
    const supabase = createBrowserClient();
    if (!supabase) return;
    const channel = supabase.channel(
      `diff:${chatId}:${assistantMessageId}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- realtime overloads
    ) as any;
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `chat_id=eq.${chatId}`,
      },
      (msg: { new: { id: string; role: string } }) => {
        if (msg.new?.role !== 'assistant') return;
        if (!msg.new?.id) return;
        // A new assistant turn just landed in this chat. If it's not us, we're
        // no longer the latest — flip to read-only by updating latestId.
        if (msg.new.id !== assistantMessageId) {
          setLatestId(msg.new.id);
        }
      },
    );
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'activity_events',
        filter: `assistant_message_id=eq.${assistantMessageId}`,
      },
      () => {
        void refetch();
      },
    );
    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [chatId, assistantMessageId, refetch, isClerkLoaded, pshareRealtimeReady]);

  // Visibility-gated polling fallback. Catches Realtime disconnects, tab
  // restores, offline → online transitions.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastSyncRef.current < POLL_INTERVAL_MS) return;
      void refetch();
      void refetchLatestId();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refetch, refetchLatestId]);

  // Mutations — optimistic locally, reconcile with server.

  const updateChunkStatus = useCallback(
    (filePath: string, chunkId: string, status: 'kept' | 'undone' | 'pending') => {
      setPayload((prev) => ({
        ...prev,
        files: prev.files.map((file) =>
          file.filePath === filePath
            ? {
                ...file,
                chunks: file.chunks.map((chunk) =>
                  chunk.id === chunkId ? { ...chunk, status } : chunk,
                ),
              }
            : file,
        ),
      }));
    },
    [],
  );

  const keepChunk = useCallback(
    async (turnAssistantMessageId: string, filePath: string, chunkId: string) => {
      // Optimistic: card unmounts immediately because DiffAwareFileView filters
      // status === 'pending'. We mark it 'kept' before the server call.
      updateChunkStatus(filePath, chunkId, 'kept');
      const tryRequest = async () => {
        const res = await pshareFetch('/api/workspace/turn-edits/keep-chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assistantMessageId: turnAssistantMessageId,
            filePath,
            chunkIds: [chunkId],
          }),
        });
        if (!res.ok) throw new Error(`Keep failed (${res.status})`);
        const next = (await res.json()) as TurnEditsResponse;
        setPayload(next);
        setCachedTurnEdits(turnAssistantMessageId, next);
      };
      try {
        await tryRequest();
        setToast(null);
      } catch (err) {
        // Revert and offer retry.
        updateChunkStatus(filePath, chunkId, 'pending');
        setToast({
          msg: err instanceof Error ? err.message : 'Couldn\u2019t save your decision',
          retry: () => {
            setToast(null);
            void keepChunk(turnAssistantMessageId, filePath, chunkId);
          },
        });
      }
    },
    [updateChunkStatus],
  );

  const undoChunk = useCallback(
    async (turnAssistantMessageId: string, filePath: string, chunkId: string) => {
      const undoKey = `${turnAssistantMessageId}:${filePath}:${chunkId}`;
      setActiveUndoKey(undoKey);
      try {
        const res = await pshareFetch('/api/workspace/turn-edits/undo-chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assistantMessageId: turnAssistantMessageId,
            filePath,
            chunkId,
          }),
        });
        if (res.status === 409) {
          // Stale — file changed since the turn. Refetch to get the truth.
          await refetch();
          setToast({
            msg: 'This change is stale. The file changed since the turn.',
          });
          return;
        }
        if (!res.ok) throw new Error(`Undo failed (${res.status})`);
        const next = (await res.json()) as TurnEditsResponse;
        setPayload(next);
        setCachedTurnEdits(turnAssistantMessageId, next);
        setToast(null);
      } catch (err) {
        setToast({
          msg: err instanceof Error ? err.message : 'Couldn\u2019t undo',
          retry: () => {
            setToast(null);
            void undoChunk(turnAssistantMessageId, filePath, chunkId);
          },
        });
      } finally {
        setActiveUndoKey(null);
      }
    },
    [refetch],
  );

  const scrollToFirstPending = useCallback(
    (file: TurnEditFile) => {
      const firstPending = file.chunks.find((c) => c.status === 'pending');
      if (!firstPending) return;
      const handle = fileRefs.current.get(file.filePath);
      handle?.scrollToChunk(assistantMessageId, firstPending.id);
    },
    [assistantMessageId],
  );

  const pendingTurns = useMemo(
    () => payloadToPendingTurns(payload, assistantMessageId),
    [payload, assistantMessageId],
  );

  // Show the full diff history for this turn, including chunks the reviewer
  // explicitly kept, so the page still reflects the full set of edits.
  const visibleFiles = payload.files;
  // Oversized/blob placeholders carry no chunks but are real edits — they must
  // not collapse the page into the "No diff" empty state.
  const hasOversized = payload.files.some((file) => file.oversized || file.blob);
  const isNoDiff = t.total === 0 && !payload.allUndone && !hasOversized;
  const isAllUndone = t.total === 0 && payload.allUndone;
  const isEmpty = visibleFiles.length === 0;
  const summaryLabel = isAllUndone
    ? 'Changes undone'
    : isNoDiff
      ? 'No diff'
      : t.total === 0 && hasOversized
        ? `${payload.files.length} ${payload.files.length === 1 ? 'file' : 'files'}`
        : `${t.total} ${t.total === 1 ? 'change' : 'changes'}`;
  const summaryDetail = isAllUndone
    ? 'Every tracked change in this turn was undone.'
    : isNoDiff
      ? 'This turn did not produce a reviewable text diff.'
      : [
          `${payload.files.length} ${payload.files.length === 1 ? 'file' : 'files'}`,
          t.kept > 0 ? `${t.kept} kept` : null,
          t.undone > 0 ? `${t.undone} undone` : null,
          t.pending > 0 ? `${t.pending} unreviewed` : null,
        ]
          .filter(Boolean)
          .join(' · ');
  const summaryStatus = !isLatest
    ? 'read-only (newer turn)'
    : isAnonReadOnly
      ? 'sign in to keep / undo'
      : null;

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-stone-100 px-4">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wide text-stone-400">
            Diff
          </div>
          <div className="truncate text-sm font-semibold text-stone-800">
            {workspaceTitle}
          </div>
        </div>
        {sanitizedWorkspaceHref ? (
          <a
            href={sanitizedWorkspaceHref}
            aria-label="Open workspace"
            className="-mr-1 flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 active:bg-stone-100"
          >
            <ArrowSquareOut className="h-5 w-5" weight="bold" />
          </a>
        ) : null}
      </header>

      <main className="flex-1 overflow-auto px-3 py-4 lg:px-6 lg:py-6">
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="space-y-1 px-1">
            <div className="text-[10px] font-medium uppercase tracking-wide text-stone-400">
              {summaryLabel}
            </div>
            <div className="text-sm text-stone-600">
              {summaryDetail}
              {summaryStatus ? ` · ${summaryStatus}` : ''}
            </div>
          </div>

          {isEmpty ? (
            <EmptyState
              mode={isNoDiff ? 'no_diff' : isAllUndone ? 'all_undone' : 'reviewed'}
              kept={t.kept}
              undone={t.undone}
              workspaceHref={sanitizedWorkspaceHref}
            />
          ) : (
            visibleFiles.map((file) => {
              const counts = fileCounts(file);
              const fileHref = buildWorkspaceFileHref(sanitizedWorkspaceHref, file);
              return (
                <section key={file.id} className="space-y-2">
                  {fileHref ? (
                    <Link
                      href={fileHref}
                      className="flex w-full items-center gap-2 px-1 text-left text-stone-700 transition-colors hover:text-stone-900 active:opacity-80"
                      aria-label={`Open ${file.filePath} in workspace`}
                    >
                      <FileIcon
                        className="h-3.5 w-3.5 shrink-0 text-stone-500"
                        weight="regular"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                        {file.filePath}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
                        {counts.adds > 0 ? (
                          <span className="text-emerald-600">+{counts.adds}</span>
                        ) : null}
                        {counts.dels > 0 ? (
                          <span className="text-red-500">−{counts.dels}</span>
                        ) : null}
                        {counts.pending > 0 ? (
                          <span className="rounded-full border border-orange-200 bg-orange-50 px-1.5 text-[10px] font-medium text-orange-700">
                            {counts.pending} unreviewed
                          </span>
                        ) : null}
                        {counts.kept > 0 ? (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 text-[10px] font-medium text-emerald-700">
                            {counts.kept} kept
                          </span>
                        ) : null}
                        {file.isNew ? (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 text-[10px] font-medium text-emerald-700">
                            new
                          </span>
                        ) : null}
                        <ArrowSquareOut className="h-3.5 w-3.5 text-stone-400" weight="bold" />
                      </span>
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => scrollToFirstPending(file)}
                      disabled={counts.pending === 0}
                      className="flex w-full items-center gap-2 px-1 text-left text-stone-700 active:opacity-80 disabled:cursor-default disabled:opacity-100"
                    >
                      <FileIcon
                        className="h-3.5 w-3.5 shrink-0 text-stone-500"
                        weight="regular"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                        {file.filePath}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
                        {counts.adds > 0 ? (
                          <span className="text-emerald-600">+{counts.adds}</span>
                        ) : null}
                        {counts.dels > 0 ? (
                          <span className="text-red-500">−{counts.dels}</span>
                        ) : null}
                        {counts.pending > 0 ? (
                          <span className="rounded-full border border-orange-200 bg-orange-50 px-1.5 text-[10px] font-medium text-orange-700">
                            {counts.pending} unreviewed
                          </span>
                        ) : null}
                        {counts.kept > 0 ? (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 text-[10px] font-medium text-emerald-700">
                            {counts.kept} kept
                          </span>
                        ) : null}
                        {file.isNew ? (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 text-[10px] font-medium text-emerald-700">
                            new
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )}
                  <div className="[&_.rounded-xl]:rounded-2xl">
                    {file.oversized ? (
                      <OversizedFileNotice file={file} />
                    ) : file.blob ? (
                      <BlobFileNotice file={file} projectId={payload.projectId} />
                    ) : (
                      <DiffAwareFileView
                        ref={(node) => {
                          fileRefs.current.set(file.filePath, node);
                        }}
                        filePath={file.filePath}
                        pendingTurns={pendingTurns}
                        latestAssistantMessageIdInChat={
                          isAnonReadOnly ? null : latestId
                        }
                        canResolve={!isAnonReadOnly}
                        activeUndoKey={activeUndoKey}
                        onKeepChunk={keepChunk}
                        onUndoChunk={undoChunk}
                        showResolvedChunks
                      />
                    )}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </main>

      {toast ? (
        <Toast toast={toast} onDismiss={() => setToast(null)} />
      ) : null}
    </div>
  );
}

function EmptyState({
  mode,
  kept,
  undone,
  workspaceHref,
}: {
  mode: 'reviewed' | 'all_undone' | 'no_diff';
  kept: number;
  undone: number;
  workspaceHref: string | null;
}) {
  const heading = mode === 'no_diff'
    ? 'No diff'
    : mode === 'all_undone'
      ? 'All changes undone'
      : 'All edits reviewed';
  const title = mode === 'no_diff'
    ? 'Nothing to review'
    : mode === 'all_undone'
      ? 'Everything was undone'
      : 'Nothing left to review';
  const description = mode === 'no_diff'
    ? 'This turn did not produce a reviewable text diff.'
    : mode === 'all_undone'
      ? 'Every tracked change in this turn was undone.'
      : `Every change in this turn has been ${
          kept > 0 && undone === 0
            ? `kept (${kept})`
            : undone > 0 && kept === 0
              ? `undone (${undone})`
              : kept > 0 && undone > 0
                ? `decided: ${kept} kept · ${undone} undone`
                : 'reviewed'
        }.`;
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-stone-200 bg-white px-5 py-8 text-stone-700">
      <div className="text-[10px] font-medium uppercase tracking-wide text-stone-400">
        {heading}
      </div>
      <div className="text-[15px] font-semibold text-stone-900">
        {title}
      </div>
      <div className="text-sm text-stone-600">
        {description}
      </div>
      {workspaceHref ? (
        <a
          href={workspaceHref}
          className="mt-1 inline-flex h-9 items-center gap-1 rounded-full border border-stone-200 bg-white px-4 text-[13px] font-medium text-stone-700 active:bg-stone-50"
        >
          Open workspace
          <ArrowSquareOut className="h-3.5 w-3.5" weight="bold" />
        </a>
      ) : null}
    </div>
  );
}

function Toast({
  toast,
  onDismiss,
}: {
  toast: { msg: string; retry?: () => void };
  onDismiss: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-6">
      <div className="pointer-events-auto flex max-w-md items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-[12px] text-white shadow-lg">
        <span className="min-w-0 flex-1 truncate">{toast.msg}</span>
        {toast.retry ? (
          <button
            type="button"
            onClick={toast.retry}
            className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium text-white active:opacity-80"
          >
            <ArrowsClockwise className="h-3 w-3" weight="bold" />
            Retry
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded-full p-0.5 text-white/70 hover:text-white"
        >
          <X className="h-3 w-3" weight="bold" />
        </button>
      </div>
    </div>
  );
}
