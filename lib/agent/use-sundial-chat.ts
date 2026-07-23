'use client';
// useSundialChat — thin wrapper over the AI SDK's `useChat`.
//
// One source of truth for the chat: `UIMessage[]` end-to-end. We seed
// useChat from REST history (DB rows → UIMessages via rowsToUIMessages on
// mount), then useChat owns the live state. The transcript renders
// UIMessages directly; no back-conversion to ChatMessage[].

import { useEffect, useMemo, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { rowsToUIMessages } from '@/lib/agent/rows-to-ui-messages';
import { SundialChatTransport, isTransportStreamFailure, type SundialSendMetadata } from '@/lib/agent/sundial-chat-transport';
import type { ChatMessage } from '@/app/w/[slug]/_components/workspace-chat-model';

export type SundialChatStatus = 'idle' | 'submitted' | 'streaming' | 'error';

export type UseSundialChatResult = {
  /** Live UIMessage[] view — what the transcript renders. */
  messages: UIMessage[];
  /** useChat's status, mapped to Sundial-friendly names. */
  status: SundialChatStatus;
  /** Send a new user message. POST happens inside the transport. */
  send: (text: string, metadata?: SundialSendMetadata) => Promise<void>;
  /** Abort the currently-streaming reply (does not delete partial output). */
  stop: () => void;
  /** Replace the message list — e.g. when external history (re)loads. */
  setMessages: (next: ChatMessage[]) => void;
  /** Append a foreign user message (from another collaborator) without
   *  clobbering anything useChat already knows about. No-op if the id is
   *  already present. */
  appendForeignUserMessage: (row: ChatMessage) => void;
  /** Reconnect to the chat's currently-active resumable stream — used to
   *  pick up the assistant reply for a foreign user message we just learned
   *  about via Realtime. */
  resumeStream: () => void;
  /** Last error from the transport, or undefined. */
  error: Error | undefined;
};

const NO_OP_TRANSPORT_KEY = '__sundial_chat_idle__';

function latestRowSequence(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const sequence = messages[i]?.sequence;
    if (typeof sequence === 'number') return sequence;
  }
  return null;
}

function latestUIMessageSequence(messages: UIMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const metadata = messages[i]?.metadata as Record<string, unknown> | null | undefined;
    const sequence = metadata?.sequence;
    if (typeof sequence === 'number') return sequence;
  }
  return null;
}

/** Sort key for a UIMessage: its persisted sequence, or +Infinity for an
 *  unsequenced (optimistic) message so it sorts last — the newest. Used to keep
 *  a reconcile merge chronological. */
function uiMessageSequence(message: UIMessage): number {
  const sequence = (message.metadata as Record<string, unknown> | null | undefined)?.sequence;
  return typeof sequence === 'number' ? sequence : Number.POSITIVE_INFINITY;
}

/** Whether a UIMessage carries renderable content — used so a reconcile never
 *  downgrades a live part to an emptier reloaded one (the runner inserts the
 *  assistant row empty and fills it on finish; a mid-flight/stale reload can
 *  carry that empty row). */
function uiMessageHasContent(message: UIMessage): boolean {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.some((p) => {
    const t = (p as { type?: string }).type;
    if (t === 'text' || t === 'reasoning') {
      const text = (p as { text?: string }).text;
      return typeof text === 'string' && text.trim().length > 0;
    }
    if (typeof t !== 'string') return false;
    // Tools and renderable data-* parts (e.g. data-compile-status LaTeX progress)
    // are visible content too — an empty reloaded row must not erase them.
    return t === 'dynamic-tool' || t.startsWith('tool-') || t.startsWith('data-');
  });
}

/** Whether a persisted row is a finalized (non-empty) reply — content text or
 *  any persisted parts. An assistant row inserted up-front (before streaming)
 *  has neither. */
function rowHasContent(row: ChatMessage): boolean {
  if (typeof row.content === 'string' && row.content.trim().length > 0) return true;
  const meta = row.metadata as { parts?: unknown } | null | undefined;
  return Array.isArray(meta?.parts) && meta.parts.length > 0;
}

/** Merge canonical (reloaded) messages into the live list by id: shared ids
 *  take the canonical version unless that would downgrade content, live-only
 *  messages are kept, and the result re-sorts by sequence. Shared by the
 *  gone-stream reconcile and the late-history catch-up so neither path can
 *  clobber an in-flight tail. */
function mergeCanonicalMessages(prev: UIMessage[], reconciled: UIMessage[]): UIMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of reconciled) {
    const existing = byId.get(m.id);
    if (existing && uiMessageHasContent(existing) && !uiMessageHasContent(m)) continue;
    byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => uiMessageSequence(a) - uiMessageSequence(b));
}

/** Last user message id in the live list — the turn whose reply we're
 *  waiting on. Reverse loop, no copy. */
function latestUserMessageId(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i]?.id;
  }
  return undefined;
}

/** Terminal state of the latest live user turn in the reloaded rows.
 *  'none'      — no non-empty assistant reply after the user row yet (the
 *                runner inserts the assistant row empty up front, so
 *                [user, empty assistant] is still in flight);
 *  'failed'    — the reply persisted with run_status error/incomplete
 *                (partial text before a stall/crash) — terminal, but NOT a
 *                success: an error banner over it is still telling the truth;
 *  'completed' — a clean finished reply. */
export function latestTurnOutcome(
  rows: ChatMessage[],
  lastUserId: string | undefined,
): 'none' | 'failed' | 'completed' {
  // No anchor, or the anchor is missing from the reload (a stale pre-turn
  // snapshot, or a reconcile that fired before the live list was seeded):
  // the reloaded rows say NOTHING about the turn we lost — never 'completed'.
  if (!lastUserId) return 'none';
  const userSeq = rows.find((r) => r.id === lastUserId)?.sequence;
  if (typeof userSeq !== 'number') return 'none';
  // THIS turn only: rows from any later user turn (a collaborator send that
  // landed while recovery reconciled) must not decide this turn's outcome.
  const nextUserSeq = rows.reduce(
    (min, r) =>
      r.role === 'user' && typeof r.sequence === 'number' && r.sequence > userSeq && r.sequence < min
        ? r.sequence
        : min,
    Number.POSITIVE_INFINITY,
  );
  const inTurn = (r: ChatMessage) =>
    typeof r.sequence === 'number' && r.sequence > userSeq && r.sequence < nextUserSeq;
  // Local tool-only turns end with an EMPTY assistant anchor row written
  // AFTER the tool rows (it carries the turn id; the reply was all tool
  // activity). That is a finished turn. It cannot be confused with the
  // cloud runner's empty up-front assistant row, which is inserted
  // BEFORE any tool rows — ordering is the discriminator.
  const lastToolSeq = rows.reduce((max, r) => {
    const type = (r.metadata as { type?: string } | null)?.type;
    return r.role === 'system' &&
      (type === 'tool_use' || type === 'tool_result') &&
      inTurn(r) &&
      r.sequence! > max
      ? r.sequence!
      : max;
  }, -1);
  const replies = rows.filter(
    (r) =>
      r.role === 'assistant' &&
      inTurn(r) &&
      (rowHasContent(r) ||
        // A terminal run_status marks the turn finished even with NO content:
        // a run that dies at startup persists an empty assistant row with
        // run_status:'error'. The finalizer only writes run_status on
        // non-clean outcomes, and the in-flight up-front row never carries
        // one, so its presence alone is a terminal marker.
        typeof (r.metadata as { run_status?: unknown } | null)?.run_status === 'string' ||
        (lastToolSeq >= 0 && r.sequence! > lastToolSeq)),
  );
  if (replies.length === 0) return 'none';
  // A failure marker ANYWHERE in the turn wins: a turn that announced text,
  // ran tools, then died persists that announcement as a plain assistant row
  // ahead of the final run_status:'error' row — the first contentful reply
  // saying nothing about the outcome must not make the turn read 'completed'.
  const failed = replies.some((r) => {
    const status = (r.metadata as { run_status?: unknown } | null | undefined)?.run_status;
    return status === 'error' || status === 'incomplete';
  });
  return failed ? 'failed' : 'completed';
}

/**
 * Decide whether to (re-)apply `initialMessages` into useChat for this chat.
 * Exported for direct unit testing — see tests/ui/sundial-chat-identity.test.ts.
 *
 * Two cases return true:
 *   - chat swap: `prev` is null or for a different chatId.
 *   - history caught up: same chat, prev applied 0 items (mount race with
 *     the parent's REST fetch), and now `initLen > 0`.
 *
 * Returns false once we've ever applied a non-empty list for this chat —
 * after that useChat is canonical and we must not overwrite live state.
 */
export function shouldApplyInitialMessages(
  prev: { chatId: string; appliedLen: number } | null,
  chatId: string,
  initLen: number,
): boolean {
  if (!prev || prev.chatId !== chatId) return true;
  return prev.appliedLen === 0 && initLen > 0;
}

/**
 * Decide whether a finished turn actually *completed* or was severed mid-stream
 * and should be auto-resumed. Exported for direct unit testing.
 *
 * The brain always closes a real turn with a terminal `finish` chunk (which
 * populates `finishReason`). When the SSE connection drops mid-turn — a long
 * agentic turn outliving the platform's stream-duration limit, or a model stall
 * with no keep-alive bytes — the browser reaches end-of-stream WITHOUT that
 * finish: the SDK flips to `ready`/`error` and freezes a half-rendered bubble
 * that, today, only a manual reload repairs. Resuming from the consumed offset
 * lets resumable-stream replay the un-seen tail into the SAME message and finish
 * it live. Bounded so a stream that genuinely can't complete can't spin.
 */
export function shouldAutoResume(args: {
  isAbort: boolean;
  isError: boolean;
  isDisconnect: boolean;
  finishReason: unknown;
  attempts: number;
  maxAttempts: number;
}): boolean {
  if (args.attempts >= args.maxAttempts) return false;
  // User stop / interrupt / replacement — terminal by intent, don't fight it.
  if (args.isAbort) return false;
  // A finishReason means the terminal `finish` chunk arrived: the turn ended
  // cleanly, or with a real error it has already surfaced. Nothing to resume.
  if (args.finishReason != null) return false;
  // No finish chunk ⇒ the connection ended mid-turn. An abrupt network drop is
  // always recoverable; a graceful close with no error flagged is the silent
  // freeze we're fixing. A non-network error without a finish is a genuine
  // processing failure — leave it surfaced rather than loop on it.
  if (args.isDisconnect) return true;
  return !args.isError;
}

// Cap consecutive auto-resumes per turn so a never-finishing stream can't spin.
// Vercel caps the agent-stream proxy at maxDuration=300s, so a long *silent*
// think (a frontier model reasoning for many minutes with no streamed bytes —
// the gateway forwards none) severs the SSE every ~5 min; each severance costs
// one auto-resume to keep the live "Thinking…" view alive. 20 windows ≈ 100 min,
// comfortably above the brain's silent-think budget (reasoningStallTimeoutMs,
// ~12 min, itself under the gateway's ~13 min stream cap) which bounds the
// actual run — so this can't truly spin. Even past the cap the answer is never
// lost: it's persisted, so it appears on the next poll.
const AUTO_RESUME_MAX = 20;

export function useSundialChat({
  chatId,
  initialMessages,
  enabled,
  reloadHistory,
  fetchImpl,
}: {
  /** The chat to wire. Pass null to render an idle hook (no SSE, no state). */
  chatId: string | null;
  /** Initial history; ignored once useChat has been mounted for this chatId. */
  initialMessages: ChatMessage[];
  /** When false the hook is fully inert: no transport, no SSE, no resume. */
  enabled: boolean;
  /** Force-fetch the chat's canonical persisted rows. Used to recover a turn
   *  whose SSE was severed and finished server-side before we could resume —
   *  resumable-stream can't replay a DONE stream, so we reconcile from the DB
   *  instead of leaving the half-rendered bubble frozen until reload. */
  reloadHistory?: (chatId: string) => Promise<ChatMessage[]>;
  /** Data-plane override for local (sidecar-served) workspaces. */
  fetchImpl?: typeof fetch;
}): UseSundialChatResult {
  // useChat requires a stable id. We give it a sentinel when disabled so
  // the hook still runs but isolated from any real chat.
  const activeChatId = enabled && chatId ? chatId : NO_OP_TRANSPORT_KEY;

  // Reconcile a turn whose live stream vanished mid-render (SSE severed + run
  // finished server-side). Read through a ref so the transport — created once —
  // always calls the latest closure over `chat`/`reloadHistory`.
  const reconcileGoneRef = useRef<(goneChatId: string, goneStreamId: string) => void>(() => {});
  // Live view of the active chat so an async reconcile can tell whether the
  // user has since switched away (the captured render value can't — it's the
  // chat we started the reconcile for).
  const liveChatIdRef = useRef<string | null>(chatId);
  liveChatIdRef.current = chatId;
  // Live view of the latest user turn, for the same reason: a turn sent while
  // a reconcile's reload is in flight owns the current error state, and the
  // reconcile must not clear it based on its stale capture. (Assigned after
  // `chat` below.)
  const liveLatestUserIdRef = useRef<string | undefined>(undefined);
  // Live view of the stream status for the same stale-closure reason — the
  // cursorless recovery loop must stand down while a reattached stream is
  // actually streaming (reopening it would replay duplicate chunks).
  const liveStatusRef = useRef<string>('ready');
  // Guards against a burst of overlapping reconciles for the SAME chat (the
  // auto-resume may signal stream-gone more than once before the first reload
  // returns). Per-chat so one chat's pending reconcile can't suppress another's.
  const reconcileInFlight = useRef<Set<string>>(new Set());
  // Initial-open failure recovery attempts (goneStreamId === ''): with no
  // cursor, nothing external ever re-triggers recovery, so the reconcile
  // self-schedules until the turn is terminal — bounded here.
  const recoveryRetries = useRef<Map<string, number>>(new Map());
  // Pending recovery timers, cleared on unmount — a scheduled retry must not
  // drive resumes/reloads/setMessages on an unmounted useChat instance.
  const recoveryTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = recoveryTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Stateless transport, reused.
  const transport = useMemo(
    () =>
      new SundialChatTransport({
        fetchImpl,
        onReconnectStreamGone: (goneChatId, goneStreamId) =>
          reconcileGoneRef.current(goneChatId, goneStreamId),
      }),
    [fetchImpl],
  );

  // Track what we've already pushed into useChat for this chat so we know
  // when to re-apply. Two cases need a reapply:
  //   (a) chat swap — different chatId.
  //   (b) history caught up — same chat, but the parent first rendered us
  //       with an empty list (REST fetch hadn't returned yet) and now has
  //       real history. Without this, the parent loads history AFTER mount,
  //       useChat stays empty on a freshly-opened chat with prior turns,
  //       and those turns never appear in the UI.
  const initializedFor = useRef<{ chatId: string; appliedLen: number } | null>(null);
  // Consecutive auto-resume attempts for the in-flight turn; reset on a clean
  // finish, a fresh send, or a chat switch (see below).
  const autoResumeAttempts = useRef(0);

  const initial = useMemo<UIMessage[]>(() => {
    if (!enabled || !chatId) return [];
    return rowsToUIMessages(initialMessages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, enabled]);

  const chat = useChat({
    id: activeChatId,
    transport,
    messages: initial,
    // UUIDs (vs the SDK's default nanoid) so the optimistic message id is also
    // a valid `messages.id` value — POST /api/workspace/messages persists with
    // id = clientId (the UUID_RE gate in the route), giving the optimistic and
    // persisted rows a shared identity. Without it, dedup/reconcile-by-id miss
    // across reseed + resumeStream + foreign-message append, producing
    // duplicate bubbles and out-of-order turns (CoT above its user message).
    // DO NOT remove — the route's reconciliation contract depends on it.
    generateId: () => crypto.randomUUID(),
    // Coalesce stream chunks into at most one React commit per 50ms. Reasoning
    // models emit hundreds of deltas/sec; unthrottled, each one forces a full
    // transcript commit and the cascading effects can trip React's update-depth
    // limit mid-stream (minified error #185, rendered as a fake agent error).
    experimental_throttle: 50,
    // We own resume (see effect below). useChat's built-in `resume` only fires
    // once on mount — its effect deps are [resume, chatRef] and chatRef is
    // identity-stable — so it never reattaches when the chat id swaps.
    resume: false,
    // Self-heal a turn whose SSE connection dropped mid-stream. Without this a
    // severed stream leaves a frozen, half-rendered assistant bubble until the
    // user reloads (the reply is safe in Postgres; only the live view is lost).
    // resumeStream → reconnectToStream resumes from the consumed offset and the
    // SDK continues the SAME assistant message (createStreamingUIMessageState
    // keeps the last assistant message), so the tail streams in with no dup.
    onFinish: ({ isAbort, isError, isDisconnect, finishReason }) => {
      if (
        !shouldAutoResume({
          isAbort,
          isError,
          isDisconnect,
          finishReason,
          attempts: autoResumeAttempts.current,
          maxAttempts: AUTO_RESUME_MAX,
        })
      ) {
        autoResumeAttempts.current = 0;
        // NB: the spent cursor is dropped by the transport when the stream's own
        // terminal `finish` chunk passes through (keyed by that stream's chat
        // id) — NOT here. A background chat's request can finish after the user
        // switches away, and `@ai-sdk/react` dispatches it through the latest
        // onFinish closure, whose `chatId` is now the *other* chat; clearing by
        // that id would wipe the wrong chat's resume offset mid-stream.
        return;
      }
      autoResumeAttempts.current += 1;
      void chat.resumeStream();
    },
  });

  liveLatestUserIdRef.current = latestUserMessageId(chat.messages);
  liveStatusRef.current = chat.status;

  // The transport calls this when a resume reconnect finds the turn already
  // finished server-side (no live stream to replay). Pull the canonical rows
  // and complete the frozen half-rendered turn from them. Resets the resume
  // counter — the turn is resolved.
  reconcileGoneRef.current = (goneChatId: string, goneStreamId: string) => {
    if (!enabled || !reloadHistory || goneChatId !== chatId) return;
    if (reconcileInFlight.current.has(goneChatId)) return;
    reconcileInFlight.current.add(goneChatId);
    autoResumeAttempts.current = 0;
    // The lost turn is the reply to the latest user message. Recovery has landed
    // only when the reload actually contains THAT user row — a stable freshness
    // check that, unlike "any assistant arrived", isn't fooled by a stale reload
    // that still holds an older assistant (or by an early drop where no assistant
    // rendered at all). The user row is persisted before the stream opens, so a
    // fresh reload always has it; a stale pre-turn snapshot never does.
    const lastUserId = latestUserMessageId(chat.messages);
    void reloadHistory(goneChatId)
      .then((rows) => {
        // Drop if the user switched chats mid-fetch (live ref, not the captured
        // render value) or the fetch came back empty.
        if (liveChatIdRef.current !== goneChatId) return 'switched' as const;
        if (!Array.isArray(rows) || rows.length === 0) return 'none' as const;
        // Merge by id rather than replace, then re-order by sequence. Shared
        // ids take the canonical (complete + sequenced) version; live-only
        // messages are kept — a turn sent during the fetch window, or (if the
        // reload came back stale because the same blip that severed the SSE
        // also failed the refetch) the half-rendered turn itself. So a stale
        // reload is non-destructive (the partial bubble stays put, never wiped),
        // a fresh reload swaps in the completed turn, and sorting by sequence
        // keeps everything chronological even when live state holds messages
        // outside the reload's page window (canonical rows are capped at 200).
        const reconciled = rowsToUIMessages(rows);
        chat.setMessages((prev) => mergeCanonicalMessages(prev, reconciled));
        // Mark canonical history applied so the seed effect doesn't re-fire:
        // reloadHistory also repopulated the parent's initialMessages, and on a
        // chat first seeded with `[]` that effect would otherwise replace state
        // with ONLY the fetched rows, dropping the concurrent send this merge
        // just preserved (Codex P2). Unconditional — any reload triggers it; a
        // later legitimate catch-up still flows via the seed effect's
        // historyIsNewer branch.
        initializedFor.current = { chatId: goneChatId, appliedLen: reconciled.length };
        // Clear the cursor only once the lost turn actually reached a
        // TERMINAL state in the reload — a stale reload leaves the partial
        // bubble intact and keeps the cursor to retry.
        const outcome = latestTurnOutcome(rows, lastUserId);
        // Cursor: any terminal outcome clears it — plus the legacy no-anchor
        // fallback (a turn with no preceding user message, e.g. a scheduled
        // task; the reload being non-empty was the pre-existing signal).
        if (outcome !== 'none' || (!lastUserId && rows.length > 0)) {
          // Guarded by the gone stream's id so we don't wipe a newer turn's
          // cursor if one started for this chat during the reload.
          transport.clearResumeCursor(goneChatId, goneStreamId);
          // A CLEAN completion retires the error banner. A FAILED outcome
          // retires only a lingering TRANSPORT error: its "reply will appear"
          // copy is now provably false (the merged run_status metadata renders
          // the failure in the transcript instead). A genuine run error stays
          // — its message is still the truth. Guarded like the cursor: a turn
          // sent while the reload was in flight owns the current error state
          // (live ref, not the stale capture), so this reconcile must not
          // clear it.
          if (
            liveLatestUserIdRef.current === lastUserId &&
            (outcome === 'completed' ||
              (outcome === 'failed' && chat.error && isTransportStreamFailure(chat.error)))
          ) {
            chat.clearError();
          }
        }
        return outcome;
      })
      // A rejected reload (the same transient that killed the SSE often kills
      // this fetch too) counts as "not terminal yet" — recovery must retry.
      .catch(() => 'none' as const)
      .then((outcome) => {
        if (goneStreamId === '' && outcome !== 'switched') {
          scheduleCursorlessRecovery(goneChatId, outcome ?? 'none');
        }
      })
      .finally(() => {
        reconcileInFlight.current.delete(goneChatId);
      });
  };
  // Bounded self-rescheduling for the cursorless (initial-open failure) path:
  // ~10 min of 5s checks. Each round first retries the live stream — a healed
  // proxy resumes real tokens (full replay, no cursor) — then re-reconciles
  // from history; a terminal outcome stops the loop via the reset below.
  const RECOVERY_RETRY_MS = 5_000;
  const RECOVERY_MAX_ATTEMPTS = 120;
  const scheduleCursorlessRecovery = (goneChatId: string, outcome: 'none' | 'failed' | 'completed') => {
    if (outcome !== 'none') {
      recoveryRetries.current.delete(goneChatId);
      return;
    }
    const attempts = recoveryRetries.current.get(goneChatId) ?? 0;
    if (attempts >= RECOVERY_MAX_ATTEMPTS) return;
    recoveryRetries.current.set(goneChatId, attempts + 1);
    const timer = setTimeout(() => {
      recoveryTimers.current.delete(timer);
      if (liveChatIdRef.current !== goneChatId) return;
      // A prior round's resumeStream reattached the live stream: its own
      // machinery owns the turn now (finish → done; drop → a cursor exists and
      // the standard gone-recovery takes over). Reopening it every 5s would
      // replay duplicate chunks — stand down.
      if (liveStatusRef.current === 'streaming' || liveStatusRef.current === 'submitted') return;
      void chat.resumeStream();
      reconcileGoneRef.current(goneChatId, '');
    }, RECOVERY_RETRY_MS);
    recoveryTimers.current.add(timer);
  };

  // Refill useChat's message list whenever:
  //   (a) the chat swaps (different chatId) — always pull the new chat's
  //       history in.
  //   (b) the history fetch arrives late (same chat, we initialized with
  //       an empty list, parent now has real history).
  // Once `appliedLen > 0`, the hook is canonical for the current chat —
  // any further updates to `initialMessages` are stale parent state and
  // we ignore them (overwriting now would clobber an in-flight stream).
  useEffect(() => {
    if (!enabled || !chatId) return;
    const initLen = initialMessages.length;
    const prev = initializedFor.current;
    const initialLastSequence = latestRowSequence(initialMessages);
    const liveLastSequence = latestUIMessageSequence(chat.messages);
    // `error` counts too: after a dead stream (transport retries exhausted)
    // the run often completes server-side anyway, and the polled history is
    // the only channel that can deliver the reply — gating on `ready` alone
    // froze the errored chat forever. `>=` (not `>`): the empty up-front
    // assistant row carries the turn's final sequence, so once a merge adopts
    // it the finished reply arrives at the SAME max sequence — a strict `>`
    // would block that content upgrade forever.
    const historyIsNewer =
      (chat.status === 'ready' || chat.status === 'error') &&
      initLen > 0 &&
      (liveLastSequence === null || (initialLastSequence !== null && initialLastSequence >= liveLastSequence));
    const isSeed = shouldApplyInitialMessages(prev, chatId, initLen);
    if (!isSeed && !historyIsNewer) return;
    const reconciled = rowsToUIMessages(initialMessages);
    if (isSeed) {
      chat.setMessages(reconciled);
    } else {
      // Late catch-up on an already-canonical chat: merge, don't replace — a
      // wholesale replace would clobber a live in-flight tail (unsequenced,
      // so absent from the snapshot's sequence horizon).
      chat.setMessages((prevMessages) => mergeCanonicalMessages(prevMessages, reconciled));
    }
    // A stream error is stale once the history carries the finished reply to
    // the latest user turn: cleared on a CLEAN completion, and on a FAILED
    // outcome when the lingering error is a TRANSPORT one (its "reply will
    // appear" copy is provably false; the merged run_status metadata renders
    // the failure instead). A genuine run error stays — it's still the truth.
    if (chat.error) {
      const outcome = latestTurnOutcome(initialMessages, latestUserMessageId(chat.messages));
      if (
        outcome === 'completed' ||
        (outcome === 'failed' && isTransportStreamFailure(chat.error))
      ) {
        chat.clearError();
      }
    }
    initializedFor.current = { chatId, appliedLen: initLen };
    // `chat` is stable per id; including the object would loop, but status and
    // error are safe and REQUIRED: when the finished history is already in
    // hand as the stream flips to 'error', no initialMessages change follows —
    // the status flip itself must re-run the catch-up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, enabled, initialMessages, chat.status, chat.error]);

  // Reattach to the resumable SSE stream once per chat activation — including
  // every switch back to a chat whose run is still in flight. useChat's own
  // resume can't do this (deps never change on id swap), so a switched-away
  // reply would otherwise only reappear after it finished and was persisted.
  // reconnectToStream resolves null (idle) when there's no active stream, so
  // this is a no-op for chats that aren't mid-run. Runs after the seed effect
  // above so the streamed `start` chunk replaces the seeded assistant row
  // (same id) instead of appending a duplicate.
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !chatId) {
      resumedFor.current = null;
      return;
    }
    if (resumedFor.current === chatId) return;
    resumedFor.current = chatId;
    autoResumeAttempts.current = 0;
    void chat.resumeStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, enabled]);

  const send = async (text: string, metadata?: SundialSendMetadata) => {
    if (!enabled || !chatId) return;
    autoResumeAttempts.current = 0;
    await chat.sendMessage(
      { text },
      { body: (metadata ?? {}) as Record<string, unknown> },
    );
  };

  const status: SundialChatStatus = (() => {
    switch (chat.status) {
      case 'submitted':
        return 'submitted';
      case 'streaming':
        return 'streaming';
      case 'error':
        return 'error';
      case 'ready':
      default:
        return 'idle';
    }
  })();

  const setMessages = (next: ChatMessage[]) => {
    chat.setMessages(rowsToUIMessages(next));
  };

  const appendForeignUserMessage = (row: ChatMessage) => {
    // Dedup by id. Realtime can fire the same INSERT twice on resubscribe;
    // useChat sometimes has the row already if we just sent it ourselves
    // and didn't filter early enough. Checked inside the updater — with
    // experimental_throttle, `chat.messages` can lag live state by a flush.
    chat.setMessages((prev) =>
      prev.some((m) => m.id === row.id) ? prev : [...prev, rowsToUIMessages([row])[0]!],
    );
  };

  return {
    messages: chat.messages,
    status,
    send,
    stop: chat.stop,
    setMessages,
    appendForeignUserMessage,
    resumeStream: () => chat.resumeStream(),
    error: chat.error,
  };
}
