'use client';
// useSundialChat — thin wrapper over the AI SDK's `useChat`.
//
// One source of truth for the chat: `UIMessage[]` end-to-end. We seed
// useChat from REST history (DB rows → UIMessages via rowsToUIMessages on
// mount), then useChat owns the live state. The transcript renders
// UIMessages directly; no back-conversion to ChatMessage[].

import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { rowsToUIMessages } from '@/lib/agent/rows-to-ui-messages';
import {
  SundialChatTransport,
  isQueuedNotice,
  isSendStartFailure,
  isTransportStreamFailure,
  type SundialSendMetadata,
  type TurnAnchor,
} from '@/lib/agent/sundial-chat-transport';
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
  /** Re-check the live turn against persisted rows and settle it if — and only
   *  if — the reload proves it terminal. The speculative pass the focus/online
   *  listeners run, exposed so a Stop that comes back `active:false` (the brain
   *  has no such run) can end the turn honestly instead of pretending it
   *  stopped one. A healthy in-flight run is left untouched. */
  settleIfTerminal: () => void;
  /** Debounced "the stream dropped and hasn't come back" flag. A drop that
   *  self-heals within a few seconds never sets it, so the reconnecting line
   *  doesn't flash on every hiccup of a long turn. */
  reconnecting: boolean;
  /** Settle the live view from persisted terminal state: the chat's assistant
   *  row was UPDATEd with `streaming` cleared (Realtime) while this hook still
   *  reports an in-flight stream. A half-open socket never errors the reader,
   *  so without this the tab shows "working" forever (Sean's 17h incident) —
   *  sever the stale reader and complete the turn from canonical rows. */
  settleFromPersistedRun: (assistantRowId: string | null, rowSequence?: number | null) => void;
  /** Last error from the transport, or undefined. */
  error: Error | undefined;
  /** The latest turn ended in a PERMANENT model decline (content-filter
   *  refusal that the brain's cross-model fallback couldn't rescue) — the
   *  `run_error` text, or null. Unlike other terminal failures (silent turn
   *  end; re-sending recovers), re-sending reproduces this one exactly, so
   *  the chat pane shows a quiet banner. Derived from message metadata, so it
   *  works live (finish-chunk metadata) and after a reload (persisted row). */
  modelDeclined: string | null;
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
export function mergeCanonicalMessages(prev: UIMessage[], reconciled: UIMessage[]): UIMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of reconciled) {
    const existing = byId.get(m.id);
    if (existing && uiMessageHasContent(existing)) {
      if (!uiMessageHasContent(m)) continue;
      // A mid-run checkpoint (`streaming: true`) is by definition not newer
      // than the live view of the same message — the row was persisted before
      // whatever the live stream has rendered since. Replacing would regress
      // the live tail to the last persist: a stale focus-reload snapshot
      // surviving in the parent's initialMessages did exactly that through
      // the ready-status catch-up after the run completed ("par" overwrote
      // the finished reply — Codex P1 on PR #1217). Terminal rows (streaming
      // cleared) still replace as before; a checkpoint can still fill a hole
      // (message absent from live state).
      if ((m.metadata as { streaming?: unknown } | null | undefined)?.streaming === true) continue;
    }
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
/** Fill in a turn whose middle falls outside BOTH the live stream and the
 *  history page.
 *
 *  A reload fetches the newest N rows. An uncapped turn persists far more than
 *  that (tool loops run to thousands of rows), so after a cold reattach past
 *  the replay-window eviction, the turn's earlier announcements and tool rows
 *  are in neither place — the transcript would be missing its middle for good,
 *  even though the outcome classifies correctly from the newest page.
 *
 *  Two ways in, depending on whether we know where the turn STARTED:
 *
 *  - `fromSequence` (the sequence the submit POST minted): page FORWARD from
 *    it until the rows meet the page we already hold.
 *  - `findTurnStart` (no anchor in memory — a page mounted mid-run has a fresh
 *    transport that never ran a submit, so nothing recorded one): page
 *    BACKWARD from the oldest row we hold until a user row appears. That row
 *    IS the turn's start, so the same walk both recovers the anchor and
 *    collects the prefix it was needed for.
 *
 *  Either way the union comes back ordered by sequence and deduped by message
 *  id (the identity the reconcile merges on), so nothing already rendered is
 *  duplicated. Bounded: the page budget caps the read, a page that doesn't
 *  advance the cursor stops the walk, and any failure returns what we had — a
 *  short transcript beats a hung reconcile.
 */
export async function backfillTurnRows(
  rows: ChatMessage[],
  opts: {
    chatId: string;
    fetchImpl: typeof fetch;
    /** Page forward from this sequence (the submitted user row's). */
    fromSequence?: number;
    /** No anchor known: page backward until the turn's user row is found. */
    findTurnStart?: boolean;
    normalize?: (row: ChatMessage) => ChatMessage;
    pageSize?: number;
    /** Safety ceiling on ROWS read, not pages: a turn is uncapped, so the
     *  budget has to be expressed in the thing that actually varies. The walk
     *  normally stops the moment the pages meet — this only bites on a turn
     *  longer than the ceiling, and it is what keeps a pathological chat from
     *  issuing thousands of requests. */
    maxRows?: number;
  },
): Promise<ChatMessage[]> {
  const pageSize = opts.pageSize ?? 200;
  const maxRows = opts.maxRows ?? 20_000;
  const maxPages = Math.max(1, Math.ceil(maxRows / pageSize));
  const sequences = rows.map((r) => r.sequence).filter((n): n is number => typeof n === 'number');
  const oldest = sequences.length > 0 ? Math.min(...sequences) : undefined;
  const seen = new Set(rows.map((r) => r.id));
  const extra: ChatMessage[] = [];
  const take = (chunk: ChatMessage[]) => {
    for (const row of chunk) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      extra.push(opts.normalize ? opts.normalize(row) : row);
    }
  };
  const read = async (params: string): Promise<ChatMessage[] | null> => {
    const res = await opts.fetchImpl(
      `/api/workspace/messages?chatId=${encodeURIComponent(opts.chatId)}${params}&limit=${pageSize}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { messages?: ChatMessage[] };
    return Array.isArray(body.messages) ? body.messages : [];
  };
  try {
    if (typeof opts.fromSequence === 'number') {
      // Nothing to bridge when the page already reaches back to the anchor.
      if (oldest !== undefined && oldest <= opts.fromSequence) return rows;
      let after = opts.fromSequence;
      for (let page = 0; page < maxPages; page += 1) {
        const chunk = await read(`&afterSequence=${after}`);
        if (chunk === null || chunk.length === 0) break;
        take(chunk);
        const last = chunk.at(-1)?.sequence;
        // No cursor progress (a backend that ignores afterSequence) would loop
        // forever on the same page — stop instead.
        if (typeof last !== 'number' || last <= after) break;
        after = last;
        if (oldest !== undefined && last >= oldest) break; // met the page we hold
        if (chunk.length < pageSize) break; // rows ran out
      }
      // `afterSequence` is exclusive, so the prompt itself — the row AT the
      // anchor — is not in anything above. Without it the canonical cache
      // holds the turn's replies with no user message above them, and any
      // reseed from that cache renders a turn nobody appears to have asked
      // for. One bounded read (beforeSequence is always >= 2, so it is a legal
      // cursor even for the chat's first row).
      const haveAnchor = (list: ChatMessage[]) => list.some((r) => r.sequence === opts.fromSequence);
      if (!haveAnchor(rows) && !haveAnchor(extra)) {
        const anchorRow = await read(`&beforeSequence=${opts.fromSequence + 1}`);
        if (anchorRow) take(anchorRow.filter((r) => r.sequence === opts.fromSequence));
      }
    } else if (opts.findTurnStart && oldest !== undefined && !rows.some((r) => r.role === 'user')) {
      let before = oldest;
      for (let page = 0; page < maxPages; page += 1) {
        const chunk = await read(`&beforeSequence=${before}`);
        if (chunk === null || chunk.length === 0) break;
        take(chunk);
        const first = chunk[0]?.sequence; // pages come back oldest-first
        if (typeof first !== 'number' || first >= before) break; // no progress
        before = first;
        if (chunk.some((r) => r.role === 'user')) break; // the turn's start
        if (chunk.length < pageSize) break; // start of the chat
      }
    }
  } catch {
    // Network trouble mid-backfill: keep what we have rather than rejecting.
  }
  if (extra.length === 0) return rows;
  return [...extra, ...rows].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

export function latestTurnOutcome(
  rows: ChatMessage[],
  lastUserId: string | undefined,
  /** The sequence the submitted user row's POST minted, when the transport
   *  knows it. Runs are uncapped, so a tool-heavy turn can persist more rows
   *  than a history page holds and push its own user row off the newest page
   *  — the outcome would then read 'none' forever even though the reply
   *  merged. The minted sequence is anchor enough: every row above it
   *  provably postdates our submit, which is exactly what the row lookup was
   *  establishing. A stale pre-turn snapshot still has no such rows. */
  anchorSequence?: number,
): 'none' | 'failed' | 'completed' {
  // No anchor, or the anchor is missing from the reload (a stale pre-turn
  // snapshot, or a reconcile that fired before the live list was seeded):
  // the reloaded rows say NOTHING about the turn we lost — never 'completed'.
  if (!lastUserId) return 'none';
  const userSeq = rows.find((r) => r.id === lastUserId)?.sequence ?? anchorSequence;
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
  // An explicitly in-flight row is never terminal proof, however contentful.
  // The local runner persists PRE-TOOL announcement text as its own assistant
  // row mid-run ("I'll edit it now."), and the brain inserts its assistant row
  // up front — both carry `streaming: true` until the turn actually ends. A
  // run that evicted a reconnecting client is still producing, so treating
  // that text as a finished reply would stop the recovery loop and strand the
  // rest of the turn until a manual reload.
  // `resume_pending` counts as in-flight too: a deploy checkpointed the turn
  // and the aborted row is a handoff marker, not terminal proof — the resumed
  // leg's own row decides. The brain's sweep clears the flag on every verdict
  // that means no resume is coming, which re-terminalizes the row.
  const inFlight = (r: ChatMessage) => {
    const m = r.metadata as { streaming?: unknown; resume_pending?: unknown } | null;
    return m?.streaming === true || m?.resume_pending === true;
  };
  const replies = rows.filter(
    (r) =>
      r.role === 'assistant' &&
      inTurn(r) &&
      !inFlight(r) &&
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

/** Truthful replacement for a stale transport banner once a reload proves the
 *  turn terminally failed: the transcript renders no failure marker (silent
 *  turn end), so this synthesized error drives the hard banner copy. Scoped to
 *  the LATEST turn's slice — an older failed turn's run_error must not be
 *  reported as this one's cause. */
export function terminalRunError(
  rows: ChatMessage[],
  lastUserId: string | undefined,
  /** Same fallback anchor as `latestTurnOutcome` — a turn big enough to page
   *  its own user row out still deserves its real run_error, not the generic. */
  anchorSequence?: number,
): Error {
  const generic = new Error('the run ended before finishing.');
  const userSeq = (lastUserId ? rows.find((r) => r.id === lastUserId)?.sequence : undefined) ?? anchorSequence;
  if (typeof userSeq !== 'number') return generic;
  // Same in-turn bounds as latestTurnOutcome: stop at the next user turn so a
  // later (collaborator/replacement) turn can't lend this one its run_error.
  const nextUserSeq = rows.reduce(
    (min, r) =>
      r.role === 'user' && typeof r.sequence === 'number' && r.sequence > userSeq && r.sequence < min
        ? r.sequence
        : min,
    Number.POSITIVE_INFINITY,
  );
  const withErr = rows.find(
    (r) =>
      typeof r.sequence === 'number' &&
      r.sequence > userSeq &&
      r.sequence < nextUserSeq &&
      typeof (r.metadata as { run_error?: unknown } | null)?.run_error === 'string',
  );
  const reason = withErr ? String((withErr.metadata as { run_error?: string }).run_error) : null;
  return reason ? new Error(`the run ended before finishing (${reason}).`) : generic;
}

/** The latest turn's permanent model decline (content-filter refusal), or
 *  null. Scoped to the slice after the last user message so an older declined
 *  turn can't resurface once a newer turn owns the surface; the metadata flag
 *  arrives identically via the live finish chunk and the persisted row, so no
 *  string-matching on the error text. Exported for unit tests. */
export function latestTurnPermanentDecline(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'user') return null;
    if (m.role !== 'assistant') continue;
    const meta = m.metadata as
      | { run_error?: unknown; run_error_permanent?: unknown }
      | null
      | undefined;
    if (meta?.run_error_permanent === true && typeof meta.run_error === 'string') {
      return meta.run_error;
    }
  }
  return null;
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
 * it live. Unbounded — runs are uncapped — with capped exponential backoff
 * between consecutive resumes (see autoResumeDelayMs).
 */
export function shouldAutoResume(args: {
  isAbort: boolean;
  isError: boolean;
  isDisconnect: boolean;
  finishReason: unknown;
  resumePending?: boolean;
}): boolean {
  // A deploy checkpointed this turn: the brain stamped `resume_pending` on
  // the finish chunk (stream-only) and a healthy machine is resuming it
  // under a FRESH stream id. Positive signal — reattach even though the
  // abort finished cleanly, or the resumed leg streams unseen until reload.
  if (args.resumePending) return true;
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

// Auto-resume is UNBOUNDED: agent runs have no step cap and the brain now
// recovers from the gateway's ~13-min stream ceiling, so a turn can
// legitimately outlast any fixed resume budget (the old AUTO_RESUME_MAX=20
// froze the live view of runs past ~100 min). Resume only fires when no
// terminal `finish` chunk arrived, and each cycle costs one relay window
// (Vercel caps the agent-stream proxy at maxDuration=300s), so an unbounded
// loop can't spin hot — but consecutive resumes still back off exponentially
// (capped) so a stream that genuinely can't replay retries gently. The
// counter resets on a clean finish, a fresh send, and a chat switch.
const AUTO_RESUME_BACKOFF_BASE_MS = 1_000;
const AUTO_RESUME_BACKOFF_MAX_MS = 30_000;

/** Live statuses whose view can still be settled from persisted rows.
 *  'error' is in here on purpose: the SDK's resume path can flip the chat to
 *  'error' (a hard stream-open failure, or any error path that skips onFinish)
 *  while the run carries on happily on the brain. Its reply then lands as an
 *  assistant-row UPDATE that no live channel consumes, so gating the settle on
 *  streaming/submitted alone stranded the finished answer behind a bare
 *  "Thinking…" until reload. A terminal persisted row is authoritative
 *  whatever the client status says. */
const SETTLEABLE_STATUSES = new Set(['streaming', 'submitted', 'error']);

/** How long a transport drop must stay unresolved before the reconnecting line
 *  appears. Resume normally reattaches within a second, and flashing the notice
 *  on every hiccup of a long turn reads as breakage. */
const RECONNECT_NOTICE_DELAY_MS = 3_000;

/** Delay before the `attempts`-th consecutive auto-resume (1-based). The first
 *  reattach is immediate — a severed relay window on a healthy run should
 *  continue seamlessly; only repeats back off. Exported for unit tests. */
export function autoResumeDelayMs(attempts: number): number {
  if (attempts <= 1) return 0;
  return Math.min(AUTO_RESUME_BACKOFF_MAX_MS, AUTO_RESUME_BACKOFF_BASE_MS * 2 ** (attempts - 2));
}

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
  reloadHistory?: (
    chatId: string,
    opts?: { fromSequence?: number; findTurnStart?: boolean },
  ) => Promise<ChatMessage[]>;
  /** Data-plane override for local (sidecar-served) workspaces. */
  fetchImpl?: typeof fetch;
}): UseSundialChatResult {
  // useChat requires a stable id. We give it a sentinel when disabled so
  // the hook still runs but isolated from any real chat.
  const activeChatId = enabled && chatId ? chatId : NO_OP_TRANSPORT_KEY;

  // Reconcile a turn whose live stream vanished mid-render (SSE severed + run
  // finished server-side). Read through a ref so the transport — created once —
  // always calls the latest closure over `chat`/`reloadHistory`.
  const reconcileGoneRef = useRef<
    (
      goneChatId: string,
      goneStreamId: string,
      turnAnchor?: TurnAnchor,
      // Speculative settle-check (focus/online with no authoritative event):
      // sever a still-"streaming" reader only when the reload PROVES the turn
      // terminal, and don't arm the recovery loop on a 'none' outcome — a
      // healthy in-flight run must stay untouched.
      settle?: { severOnTerminal: boolean },
    ) => void
  >(() => {});
  // Same indirection for the bounded recovery loop: `onError` below is wired
  // into useChat before the loop is defined, and must always call the latest
  // closure.
  const scheduleRecoveryRef = useRef<(chatId: string) => void>(() => {});
  // The sequence the submitted user row's POST minted, remembered per chat so
  // every RETRY of a recovery keeps it (the transport only reports it on the
  // first gone). Tagged with the user row it belongs to: an older turn's
  // anchor must never bound a newer turn's window.
  const turnAnchorById = useRef<Map<string, { userId: string; sequence: number }>>(new Map());
  // A terminal failure surfaced after a dropped stream: the stale transport
  // error is replaced by this truthful hard error (Codex P2, PR #1019).
  // Bound to the failed turn's user id — it surfaces only while that turn is
  // still the latest, so a collaborator's new turn (which never goes through
  // send()) retires it naturally. Also cleared on chat switch, on send, and
  // by a clean completion.
  const [terminalFailure, setTerminalFailure] = useState<{
    forUserId: string | undefined;
    error: Error;
  } | null>(null);
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
  // A persisted-terminal settle that arrived while a reconcile was already in
  // flight parks here; that reconcile's completion re-runs it. Severing the
  // reader immediately and letting the settle's own reconcile hit the
  // in-flight guard would drop the recovery on the floor — the running pass
  // may be a STALE speculative reload (outcome 'none', schedules nothing),
  // leaving a dead reader and a frozen partial with no path out.
  const pendingSettleRef = useRef<{
    chatId: string;
    assistantRowId: string | null;
    rowSequence: number | null;
  } | null>(null);
  const settleRef = useRef<(assistantRowId: string | null, rowSequence?: number | null) => void>(() => {});
  // Initial-open failure recovery attempts (goneStreamId === ''): with no
  // cursor, nothing external ever re-triggers recovery, so the reconcile
  // self-schedules until the turn is terminal — bounded here.
  const recoveryRetries = useRef<Map<string, number>>(new Map());
  // Highest persisted sequence any recovery poll has seen for a chat. New rows
  // prove the run is ALIVE, so they refund the attempt budget above — a flat
  // wall abandoned turns that legitimately outlive it (a reasoning-heavy run
  // that drops early and then works for half an hour). Silence still exhausts
  // the budget, so a genuinely dead chat stops polling.
  const recoveryProgress = useRef<Map<string, number>>(new Map());
  // Pending recovery timers, cleared on unmount — a scheduled retry must not
  // drive resumes/reloads/setMessages on an unmounted useChat instance.
  const recoveryTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = recoveryTimers.current;
    const retries = recoveryRetries.current;
    const progress = recoveryProgress.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      retries.clear();
      progress.clear();
    };
  }, []);

  // Stateless transport, reused.
  const transport = useMemo(
    () =>
      new SundialChatTransport({
        fetchImpl,
        onReconnectStreamGone: (goneChatId, goneStreamId, turnAnchor) =>
          reconcileGoneRef.current(goneChatId, goneStreamId, turnAnchor),
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
    onFinish: ({ message, isAbort, isError, isDisconnect, finishReason }) => {
      const resumePending =
        (message?.metadata as { resume_pending?: unknown } | undefined)?.resume_pending === true;
      if (!shouldAutoResume({ isAbort, isError, isDisconnect, finishReason, resumePending })) {
        autoResumeAttempts.current = 0;
        // NB: the spent cursor is dropped by the transport when the stream's own
        // terminal `finish` chunk passes through (keyed by that stream's chat
        // id) — NOT here. A background chat's request can finish after the user
        // switches away, and `@ai-sdk/react` dispatches it through the latest
        // onFinish closure, whose `chatId` is now the *other* chat; clearing by
        // that id would wipe the wrong chat's resume offset mid-stream.
        return;
      }
      // A deploy-checkpointed finish needs no special vehicle here: the
      // transport KEEPS that stream's cursor (isResumePending), so this
      // reattach — 404 while the sweep is still claiming the checkpoint —
      // fires the normal gone-recovery, which reconciles from rows and arms
      // the bounded retry loop until the resumed leg's fresh stream attaches.
      // Keyed by the gone stream's own chat, unlike anything we could scope
      // from this closure (see the chat-drift note above).
      autoResumeAttempts.current += 1;
      const delay = autoResumeDelayMs(autoResumeAttempts.current);
      if (delay === 0) {
        void chat.resumeStream();
        return;
      }
      // Backed-off resume. Scheduled on the shared timer set (cleared on
      // unmount) and re-checked at fire time: a chat switch or a stream that
      // reattached in the meantime (send/recovery) owns the turn now.
      const scheduledFor = liveChatIdRef.current;
      const timer = setTimeout(() => {
        recoveryTimers.current.delete(timer);
        if (liveChatIdRef.current !== scheduledFor) return;
        if (liveStatusRef.current === 'streaming' || liveStatusRef.current === 'submitted') return;
        void chat.resumeStream();
      }, delay);
      recoveryTimers.current.add(timer);
    },
    // Belt and braces for every error path that SKIPS onFinish — the resume
    // one above all: for trigger 'resume-stream' the SDK calls
    // reconnectToStream outside the try block that wraps the rest of the turn,
    // so a rejection lands here, sets status 'error', and RETURNS — onFinish
    // never runs and the auto-resume loop above never fires again. Arming the
    // bounded gone-recovery here means the reply is still reconciled from
    // persisted rows instead of the turn being lost from the UI.
    // Send/start failures are excluded: no run exists (credit gate, sign-in
    // gate, brain unreachable), so polling history would be pure noise.
    onError: (error: Error) => {
      const errored = liveChatIdRef.current;
      if (!enabled || !errored || isSendStartFailure(error)) return;
      scheduleRecoveryRef.current(errored);
    },
  });

  liveLatestUserIdRef.current = latestUserMessageId(chat.messages);
  liveStatusRef.current = chat.status;

  // The transport calls this when a resume reconnect finds the turn already
  // finished server-side (no live stream to replay). Pull the canonical rows
  // and complete the frozen half-rendered turn from them. Resets the resume
  // counter — the turn is resolved.
  reconcileGoneRef.current = (
    goneChatId: string,
    goneStreamId: string,
    turnAnchor?: TurnAnchor,
    settle?: { severOnTerminal: boolean },
  ) => {
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
    // Only when the anchor names the very row this reconcile is about. A
    // resume-only or foreign turn mints no anchor, so the transport's entry
    // can describe an EARLIER turn — binding it to whatever user row is now
    // latest would page from the wrong turn and could retire recovery before
    // the real reply is restored.
    if (turnAnchor && lastUserId && turnAnchor.userMessageId === lastUserId) {
      turnAnchorById.current.set(goneChatId, { userId: lastUserId, sequence: turnAnchor.sequence });
    }
    const stored = turnAnchorById.current.get(goneChatId);
    const anchorSequence = stored && stored.userId === lastUserId ? stored.sequence : undefined;
    // The anchor also bounds the READ: without it the reload is the newest
    // page only, and a turn longer than that page loses its middle for good.
    // With no anchor in memory — a page mounted mid-run has a fresh transport
    // that never ran a submit — the reload searches BACKWARD for the turn's
    // user row instead, which recovers the anchor and the prefix in one walk.
    void reloadHistory(
      goneChatId,
      anchorSequence === undefined ? { findTurnStart: true } : { fromSequence: anchorSequence },
    )
      .then((rows) => {
        // Drop if the user switched chats mid-fetch (live ref, not the captured
        // render value) or the fetch came back empty.
        if (liveChatIdRef.current !== goneChatId) return 'switched' as const;
        if (!Array.isArray(rows) || rows.length === 0) return 'none' as const;
        // Outcome BEFORE merge — a speculative (focus/online) pass must not
        // touch a healthy live transcript. Local runners persist pre-tool
        // announcement rows mid-run whose text the live message already
        // renders, and a stale non-empty row sharing the live message's id
        // can replace a newer partial — merging those on a 'none' outcome
        // duplicates/regresses content for nothing (Codex P2 on PR #1213).
        // A backward search puts the user row back in reach: adopt its
        // sequence so every later retry for this turn is anchored outright.
        const found = rows.find((r) => r.id === lastUserId)?.sequence;
        const recovered = typeof found === 'number' ? found : undefined;
        if (anchorSequence === undefined && recovered !== undefined && lastUserId) {
          turnAnchorById.current.set(goneChatId, { userId: lastUserId, sequence: recovered });
        }
        const outcome = latestTurnOutcome(rows, lastUserId, anchorSequence ?? recovered);
        // Progress refunds the recovery budget so a long turn is not abandoned
        // at the flat wall — but ONLY rows inside THIS turn count. A busy chat
        // persists rows constantly (a collaborator's message, a scheduled
        // task, the next turn), and counting those would refund forever and
        // poll a dead turn without end. With no anchor to bound the window
        // (a scheduled/foreign turn) nothing is refundable and the flat cap
        // stands, which is the safe direction.
        const refundFrom = anchorSequence ?? recovered;
        if (typeof refundFrom === 'number') {
          const nextTurnSeq = rows.reduce(
            (min, r) =>
              r.role === 'user' && typeof r.sequence === 'number' && r.sequence > refundFrom && r.sequence < min
                ? r.sequence
                : min,
            Number.POSITIVE_INFINITY,
          );
          const maxSeq = rows.reduce(
            (max, r) =>
              typeof r.sequence === 'number' && r.sequence > max && r.sequence < nextTurnSeq
                ? r.sequence
                : max,
            refundFrom,
          );
          const seenSeq = recoveryProgress.current.get(goneChatId);
          if (seenSeq === undefined || maxSeq > seenSeq) {
            recoveryProgress.current.set(goneChatId, maxSeq);
            recoveryRetries.current.delete(goneChatId);
          }
        }
        if (settle?.severOnTerminal && outcome === 'none') {
          // Healthy in-flight run: leave the live turn alone, but do two
          // things the plain early-return would miss.
          // 1) Backfill rows from BEFORE the live turn (a chat seeded with []
          //    may owe its prior history to exactly this reload). The
          //    in-flight turn's own rows — mid-run announcements, stale
          //    checkpoints of the live message — stay out.
          const turnStart = anchorSequence ?? recovered;
          const prior =
            typeof turnStart === 'number'
              ? rows.filter((r) => typeof r.sequence === 'number' && r.sequence < turnStart)
              : lastUserId
                ? rows // reload predates the live turn entirely — none of it in there
                : []; // no user anchor (scheduled/foreign turn): can't bound, don't touch
          if (prior.length > 0) {
            chat.setMessages((prev) => mergeCanonicalMessages(prev, rowsToUIMessages(prior)));
          }
          // 2) Mark the reload applied: reloadHistory also repopulated the
          //    parent's initialMessages, and on a chat first seeded with []
          //    the seed effect would otherwise REPLACE the healthy live
          //    transcript with the stale in-flight rows this branch just
          //    declined to merge.
          initializedFor.current = { chatId: goneChatId, appliedLen: rows.length };
          return outcome;
        }
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
        // Cursor: any terminal outcome clears it — plus the legacy no-anchor
        // fallback (a turn with no preceding user message, e.g. a scheduled
        // task; the reload being non-empty was the pre-existing signal).
        if (outcome !== 'none' || (!lastUserId && rows.length > 0)) {
          // Guarded by the gone stream's id so we don't wipe a newer turn's
          // cursor if one started for this chat during the reload.
          transport.clearResumeCursor(goneChatId, goneStreamId);
          // A CLEAN completion retires the error banner. A FAILED outcome
          // swaps a stale TRANSPORT error ("reply will appear" — provably
          // false now) for a truthful hard failure: the transcript renders no
          // failure marker (silent turn end), so the banner is the one
          // visible surface saying the run didn't finish. Guarded like the
          // cursor: a turn sent while the reload was in flight owns the
          // current error state (live ref, not the stale capture).
          if (liveLatestUserIdRef.current === lastUserId) {
            if (outcome === 'completed') {
              chat.clearError();
              setTerminalFailure(null);
            } else if (outcome === 'failed') {
              // Synthesize the hard failure whenever THIS turn failed — the
              // gone-stream path (404/410 finished stream) often reconciles
              // with no chat.error at all, and the transcript renders no
              // run_status marker. A genuine non-transport chat.error stays
              // (it's already the truth); a stale transport one is replaced.
              // The queued notice counts as stale too: it PREDICTED a reply,
              // and history has now proven the turn failed instead.
              const staleTransport =
                chat.error && (isTransportStreamFailure(chat.error) || isQueuedNotice(chat.error));
              if (staleTransport) chat.clearError();
              if (!chat.error || staleTransport) {
                setTerminalFailure({
                forUserId: lastUserId,
                error: terminalRunError(rows, lastUserId, anchorSequence ?? recovered),
              });
              }
            }
          }
        }
        return outcome;
      })
      // A rejected reload (the same transient that killed the SSE often kills
      // this fetch too) counts as "not terminal yet" — recovery must retry.
      .catch(() => 'none' as const)
      .then((outcome) => {
        if (outcome === 'switched') return;
        if (settle?.severOnTerminal) {
          // Speculative settle-check: only a PROVEN-terminal turn severs a
          // reader that still claims to stream (the half-open-socket wedge —
          // rejecting its pending read is the only thing that can end it).
          // The abort can race a late throttled flush of the stale partial
          // over the merge above, so arm one recovery round to re-merge from
          // rows after the reader unwinds; its next terminal outcome stops
          // the loop. A 'none' outcome is a healthy in-flight run: leave it
          // alone entirely — no sever, no recovery loop.
          if (
            (outcome === 'completed' || outcome === 'failed') &&
            liveChatIdRef.current === goneChatId &&
            // The outcome proves the turn we RECONCILED terminal — if a newer
            // user turn started while the reload was in flight, the attached
            // reader belongs to that replacement run and must not be severed
            // on the older turn's verdict (Codex P2 on PR #1209).
            liveLatestUserIdRef.current === lastUserId &&
            (liveStatusRef.current === 'streaming' || liveStatusRef.current === 'submitted')
          ) {
            transport.abortAttachedReaders(goneChatId);
            scheduleCursorlessRecovery(goneChatId, 'none', '');
          }
          return;
        }
        // Any non-terminal reconcile must keep the recovery loop alive — not
        // just the cursorless (initial-open) path. A REAL-id gone can land
        // mid-run too (an active run's replay window evicted our offset →
        // 410): with the turn still in flight, nothing else re-triggers
        // recovery, so the rest of the run would stay invisible until a
        // manual reload. scheduleCursorlessRecovery already no-ops on a
        // terminal outcome; each round retries the live stream and then
        // re-reconciles from rows until terminal / reattach / chat switch.
        scheduleCursorlessRecovery(goneChatId, outcome ?? 'none', goneStreamId);
      })
      .finally(() => {
        reconcileInFlight.current.delete(goneChatId);
        // A settle parked while this reconcile ran: re-run it now that the
        // guard is free. Its own checks re-evaluate against live state (chat
        // still active, still streaming, row still the live turn's), so a
        // pass that already resolved things makes this a no-op.
        const pending = pendingSettleRef.current;
        if (pending && pending.chatId === goneChatId && liveChatIdRef.current === goneChatId) {
          pendingSettleRef.current = null;
          settleRef.current(pending.assistantRowId, pending.rowSequence);
        }
      });
  };
  // Self-rescheduling for non-terminal gone-reconciles — the cursorless
  // (initial-open failure) path and real-id mid-run gones alike: 5s checks,
  // budgeted at ~10 min of SILENCE (each poll that observes new persisted rows
  // refunds the budget, so a long-running turn is never abandoned mid-run).
  // Each round first retries the live stream — a healed
  // proxy resumes real tokens (full replay, no cursor) — then re-reconciles
  // from history; a terminal outcome stops the loop via the reset below. The
  // originating stream id rides into the first retry so its now-unserviceable
  // cursor is dropped there (see the timer) — an ''-guarded clear would leave
  // the real cursor dangling, resending its stale offset forever.
  const RECOVERY_RETRY_MS = 5_000;
  const RECOVERY_MAX_ATTEMPTS = 120;
  const scheduleCursorlessRecovery = (
    goneChatId: string,
    outcome: 'none' | 'failed' | 'completed',
    goneStreamId = '',
  ) => {
    if (outcome !== 'none') {
      recoveryRetries.current.delete(goneChatId);
      recoveryProgress.current.delete(goneChatId);
      turnAnchorById.current.delete(goneChatId); // the turn resolved; its anchor is spent
      return;
    }
    const attempts = recoveryRetries.current.get(goneChatId) ?? 0;
    if (attempts >= RECOVERY_MAX_ATTEMPTS) {
      // Budget spent. Clear the bookkeeping, or the exhausted counter would
      // bar this chat from EVERY later recovery (a fresh send, a new drop) for
      // the lifetime of the page.
      recoveryRetries.current.delete(goneChatId);
      recoveryProgress.current.delete(goneChatId);
      return;
    }
    recoveryRetries.current.set(goneChatId, attempts + 1);
    const timer = setTimeout(() => {
      recoveryTimers.current.delete(timer);
      if (liveChatIdRef.current !== goneChatId) return;
      // A prior round's resumeStream reattached the live stream: don't reopen
      // it (duplicate chunks) — but KEEP reconciling from rows. A mid-stream
      // cold attach only carries the tail, and its prefix merge can race
      // persistence (stale reload); without further reconciles a clean finish
      // would leave the evicted prefix missing until a manual reload. The
      // merge preserves the live tail, and a terminal outcome still stops
      // the loop.
      if (liveStatusRef.current === 'streaming' || liveStatusRef.current === 'submitted') {
        reconcileGoneRef.current(goneChatId, '');
        return;
      }
      // A real-id cursor that reached gone-recovery is provably unserviceable
      // (the transport only signals gone after its resume already failed —
      // 404, DONE stream, or the replay window evicted the offset). Keeping
      // it would make every retry resend the same stale Last-Event-ID and
      // 410 forever instead of reattaching. Drop it now so resumeStream
      // opens cold — full replay / live tail, exactly like the cursorless
      // path's healed-proxy resume — and recover cursorless from here on.
      if (goneStreamId !== '') transport.clearResumeCursor(goneChatId, goneStreamId);
      void chat.resumeStream();
      reconcileGoneRef.current(goneChatId, '');
    }, RECOVERY_RETRY_MS);
    recoveryTimers.current.add(timer);
  };
  // The SPECULATIVE arm (onError). Unlike a gone signal, this says only "the
  // SDK errored without running onFinish" — it does not prove the turn lost
  // its delivery channel. A plain drop can arm this AND have the SDK's own
  // auto-resume reattach a healthy stream a moment later, and entering the
  // recovery loop then would re-merge canonical rows over that live stream
  // every 5s — the duplicate/regressed content of Codex P2 on PR #1213. So it
  // waits one round and stands down if a stream is live by then; only a chat
  // still without one is handed to the real loop.
  scheduleRecoveryRef.current = (recoverChatId: string) => {
    const timer = setTimeout(() => {
      recoveryTimers.current.delete(timer);
      if (liveChatIdRef.current !== recoverChatId) return;
      if (liveStatusRef.current === 'streaming' || liveStatusRef.current === 'submitted') return;
      scheduleCursorlessRecovery(recoverChatId, 'none');
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
    // A stream error is stale once the history carries a CLEAN finished
    // reply to the latest user turn. A FAILED outcome swaps a stale
    // TRANSPORT error for the truthful hard failure (the transcript renders
    // no failure marker — silent turn end).
    if (chat.error) {
      const outcome = latestTurnOutcome(initialMessages, latestUserMessageId(chat.messages));
      if (outcome === 'completed') {
        chat.clearError();
        setTerminalFailure(null);
      } else if (
        outcome === 'failed' &&
        (isTransportStreamFailure(chat.error) || isQueuedNotice(chat.error))
      ) {
        const lastUserId = latestUserMessageId(chat.messages);
        chat.clearError();
        setTerminalFailure({ forUserId: lastUserId, error: terminalRunError(initialMessages, lastUserId) });
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
  // Separate one-shot: history can arrive AFTER activation (the chat seeds with
  // `[]`), so the resume-pending arm below can't hide behind the reconnect's
  // guard — it has to re-evaluate as initialMessages fills in.
  const armedResumePendingFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !chatId) {
      resumedFor.current = null;
      armedResumePendingFor.current = null;
      return;
    }
    if (resumedFor.current !== chatId) {
      resumedFor.current = chatId;
      // The arm below is per ACTIVATION, not per chat: leaving a chat cancels
      // its pending recovery timer (the timer no-ops once liveChatIdRef moves),
      // so coming back has to be able to arm again — otherwise the truncated
      // bubble sits there until a full reload.
      armedResumePendingFor.current = null;
      autoResumeAttempts.current = 0;
      // This activation runs on a BRAND-NEW useChat instance for the chat (the
      // SDK mints one per id change), and switching away never stopped the
      // previous one's SSE reader. Hand the chat over before resuming, or the
      // transport — which allows only one reader per chat, so two response
      // states can't fight over one message — would refuse this instance's
      // resume and leave a mid-run reply frozen until reload.
      transport.handOffAttachedReaders(chatId);
      void chat.resumeStream();
    }
    // A RELOAD landing inside the deploy handoff window: history carries the
    // interrupted row with `resume_pending`, but this client never watched the
    // stream that flagged it, so the transport holds no cursor — the reconnect
    // above 404s, returns null in silence, and nothing arms recovery (realtime
    // only fans in user inserts). The row itself is the signal: enter the same
    // bounded loop — retry the stream, then reconcile from rows — so the
    // resumed leg attaches when it registers, instead of stranding the
    // truncated bubble until another manual reload.
    // Gated on the LATEST turn still being open, not merely on a marker
    // existing: once the resumed leg lands, its terminal row stays in history
    // next to the interrupted one forever, and arming on that would retry the
    // stream on every activation of the chat from then on. latestTurnOutcome
    // reads the marker as in-flight and the resumed leg's row as terminal, so
    // 'none' is exactly "a leg is still owed".
    if (armedResumePendingFor.current !== chatId) {
      const pending = initialMessages.some(
        (r) => (r.metadata as { resume_pending?: unknown } | null)?.resume_pending === true,
      );
      const lastUserId = [...initialMessages].reverse().find((r) => r.role === 'user')?.id;
      if (pending && latestTurnOutcome(initialMessages, lastUserId) === 'none') {
        armedResumePendingFor.current = chatId;
        scheduleCursorlessRecovery(chatId, 'none');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, enabled, initialMessages]);

  // A new turn (or a chat switch) owns the error surface — the previous
  // turn's terminal-failure banner must not linger over it.
  useEffect(() => {
    setTerminalFailure(null);
  }, [chatId]);

  // Realtime delivered the run's TERMINAL persisted state (assistant row
  // UPDATEd with `streaming` cleared) while this hook still reports an
  // in-flight stream. That reader is wedged on a half-open socket — it will
  // never error, and its attach mark blocks every resume — or it is about to
  // deliver the same finish; either way the canonical rows own the turn now.
  // Sever first (so no late flush can overwrite the reconcile), then complete
  // the turn from history. If the settle mis-fires early (a replacement run
  // is live), the reconcile's 'none' outcome re-enters the recovery loop and
  // reattaches — self-healing, no state forged.
  const settleFromPersistedRun = (assistantRowId: string | null, rowSequence?: number | null) => {
    if (!enabled || !chatId) return;
    if (!SETTLEABLE_STATUSES.has(liveStatusRef.current)) return;
    // Only the LIVE turn's own row can settle it. A late realtime redelivery
    // of an earlier turn's terminal UPDATE (or an edit to an old assistant
    // row) lands while a newer send is in flight — severing that send on it
    // would kill a healthy turn. A row we've never seen is allowed through:
    // the wedge can predate the stream's `start` chunk (stuck 'submitted').
    if (!assistantRowId) return;
    const msgs = chat.messages;
    const rowIdx = msgs.findIndex((m) => m.id === assistantRowId);
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]?.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (rowIdx !== -1 && rowIdx < lastUserIdx) return;
    // An id we've never seen can only be the live turn's row while that turn
    // has no assistant bubble yet (the stuck-'submitted' wedge — the start
    // chunk never arrived). Once an assistant renders after the latest user
    // row, the live turn's row id IS in the list, so an unknown id is some
    // older row's late update — e.g. the resume sweep clearing an ancient
    // page-evicted row — and must not sever the healthy stream (Codex P2).
    if (rowIdx === -1) {
      if (msgs.some((m, i) => m.role === 'assistant' && i > lastUserIdx)) return;
      // Nothing has rendered for this turn yet (stuck 'submitted'): only a row
      // NEWER than everything we hold can be the live turn's own. An old
      // page-evicted row's late UPDATE (its sequence predates the loaded page)
      // must not sever a fresh submit — and with no sequence to judge by,
      // stay conservative and skip (Codex P2).
      const maxSeq = latestUIMessageSequence(msgs);
      if (typeof rowSequence !== 'number' || (maxSeq !== null && rowSequence <= maxSeq)) return;
    }
    // A reconcile is already running (e.g. a speculative focus pass whose
    // reload predates the terminal row): park the settle instead of aborting
    // now — the abort would sever the reader while our own reconcile bounces
    // off the in-flight guard, and a stale 'none' outcome schedules nothing.
    if (reconcileInFlight.current.has(chatId)) {
      pendingSettleRef.current = { chatId, assistantRowId, rowSequence: rowSequence ?? null };
      return;
    }
    transport.abortAttachedReaders(chatId);
    reconcileGoneRef.current(chatId, '');
  };
  settleRef.current = settleFromPersistedRun;

  // The Realtime settle above only works while its socket is alive.
  // `postgres_changes` has no replay: a terminal UPDATE that lands while the
  // laptop sleeps is lost forever, and the wedged reader pins "working" until
  // reload. Re-check against persisted state on the same wake signals the
  // presence system already uses (focus/online/visibilitychange) — purely
  // event-driven, and inert unless the hook believes a run is in flight.
  const settleIfTerminal = () => {
    if (!enabled || !chatId) return;
    if (!SETTLEABLE_STATUSES.has(liveStatusRef.current)) return;
    reconcileGoneRef.current(chatId, '', undefined, { severOnTerminal: true });
  };
  const settleIfTerminalRef = useRef(settleIfTerminal);
  settleIfTerminalRef.current = settleIfTerminal;
  useEffect(() => {
    if (!enabled || !chatId) return;
    const check = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      settleIfTerminalRef.current();
    };
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [chatId, enabled]);

  const send = async (text: string, metadata?: SundialSendMetadata) => {
    setTerminalFailure(null);
    if (!enabled || !chatId) return;
    autoResumeAttempts.current = 0;
    // A new turn owns the chat: the previous one's recovery bookkeeping must
    // not carry over (a spent budget would bar this turn's recovery, and a
    // stale progress mark would suppress its first refund).
    recoveryRetries.current.delete(chatId);
    recoveryProgress.current.delete(chatId);
    const attachments = metadata?.attachments ?? [];
    await chat.sendMessage(
      {
        text,
        // The transcript renders attachment chips from message metadata, so the
        // optimistic message must carry them too — otherwise a sent attachment
        // is invisible until a reload swaps in the persisted row (which can
        // never happen if the turn is interrupted first).
        ...(attachments.length > 0 ? { metadata: { attachments } } : {}),
      },
      { body: (metadata ?? {}) as Record<string, unknown> },
    );
  };

  // Debounced reconnect notice. A drop that resume heals in a second must stay
  // invisible — the banner firing on every hiccup of a long turn is what users
  // read as breakage. Only a transport drop still standing after the delay
  // earns the line; anything that clears the error (a resumed stream, a
  // completed reconcile) disarms the timer before it fires.
  const [reconnectNoticeDue, setReconnectNoticeDue] = useState(false);
  const transportDrop = Boolean(chat.error && isTransportStreamFailure(chat.error));
  useEffect(() => {
    if (!transportDrop) return;
    const timer = setTimeout(() => setReconnectNoticeDue(true), RECONNECT_NOTICE_DELAY_MS);
    // Disarming on cleanup covers both exits: the error cleared (recovery
    // landed, a resume reattached) and unmount.
    return () => {
      clearTimeout(timer);
      setReconnectNoticeDue(false);
    };
    // `chatId` too: switching between two chats that are both dropped keeps
    // `transportDrop` true across the swap, and without a re-arm the new
    // chat's line would appear instantly, skipping its own debounce.
  }, [transportDrop, chatId]);

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

  const appendForeignUserMessage = (row: ChatMessage, opts: { replace?: boolean; remove?: boolean } = {}) => {
    // Dedup by id. Realtime can fire the same INSERT twice on resubscribe;
    // useChat sometimes has the row already if we just sent it ourselves
    // and didn't filter early enough. Checked inside the updater — with
    // experimental_throttle, `chat.messages` can lag live state by a flush.
    // `replace` refreshes an existing row in place (metadata can be annotated
    // after insert, e.g. a blocked comment delivery); `remove` drops it (the
    // server retracted the row — a blocked delivery deleted post-insert).
    chat.setMessages((prev) => {
      if (opts.remove) return prev.some((m) => m.id === row.id) ? prev.filter((m) => m.id !== row.id) : prev;
      const idx = prev.findIndex((m) => m.id === row.id);
      if (idx === -1) return [...prev, rowsToUIMessages([row])[0]!];
      if (!opts.replace) return prev;
      const copy = [...prev];
      copy[idx] = rowsToUIMessages([row])[0]!;
      return copy;
    });
  };

  return {
    messages: chat.messages,
    status,
    send,
    stop: chat.stop,
    setMessages,
    appendForeignUserMessage,
    resumeStream: () => chat.resumeStream(),
    settleFromPersistedRun,
    settleIfTerminal,
    reconnecting: transportDrop && reconnectNoticeDue,
    error:
      chat.error ??
      // Surface the synthesized failure only while its turn is still the
      // latest — a newer (possibly foreign) user turn owns the surface.
      (terminalFailure && terminalFailure.forUserId === liveLatestUserIdRef.current
        ? terminalFailure.error
        : undefined),
    modelDeclined: latestTurnPermanentDecline(chat.messages),
  };
}
