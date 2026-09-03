'use client';
// Custom ChatTransport for Sundial.
//
// useChat is designed around a single endpoint that takes the latest user
// message and streams the assistant response. Sundial's flow is split:
// POST /api/workspace/messages does the user-message INSERT (with all the
// existing Sundial-specific bits — clientId dedup, RLS, attachments, anon
// auth) and kicks the agent harness. Streaming is then served from a
// separate GET /api/workspace/agent-stream that proxies the SDK's UI
// Message Stream from the Fly harness.
//
// This transport wires those two endpoints into the single contract that
// useChat expects.
//
// Why a custom transport (vs. DefaultChatTransport): we can't change the
// existing POST /messages contract without breaking the iMessage inbound
// path that already uses it. Keeping the two endpoints split is
// cheaper than collapsing them.

import type { ChatTransport, UIMessage, UIMessageChunk, ChatRequestOptions } from 'ai';
import type { WorkspaceEditMode } from '@/lib/workspace/edit-mode';
import { sseBodyToChunks, repairResumedPartBoundaries } from './use-agent-stream';

/** The submitted user row a recovery should anchor on: the sequence bounds the
 *  turn's window, and the id proves the sequence belongs to THAT turn. A
 *  resume-only or FOREIGN turn (a collaborator posting in the same chat) never
 *  mints one, so a stale entry must never be adopted by whatever user row
 *  happens to be latest. */
export type TurnAnchor = { sequence: number; userMessageId?: string };

export type SundialSendMetadata = {
  attachments?: unknown[];
  openFilePath?: string | null;
  sendMode?: string;
  /** Composer Edit/Suggest/View mode at send time; persisted to
   *  messages.metadata so the brain can run read-only in Viewing mode. */
  editMode?: WorkspaceEditMode;
};

export type SundialChatTransportOptions = {
  /** Data-plane override — local (sidecar-served) workspaces pass the
   *  emulated workspace fetch so send/stream hit the sidecar. */
  fetchImpl?: typeof fetch;
  /** Fired when a resume reconnect finds no live stream for a turn we were
   *  mid-tail of — i.e. the SSE was severed and the run finished server-side
   *  before we could reconnect (resumable-stream returns no handle once a
   *  stream is DONE). The half-rendered bubble can't be completed from the
   *  stream store, so the client reconciles it from persisted history instead
   *  of freezing until reload. `streamId` is the gone stream's id, so the
   *  recovery can clear exactly that cursor (not a newer turn's).
   *  `turnAnchor`, when known, is the submitted user row's id AND the sequence
   *  its POST minted. The sequence bounds the turn (an uncapped turn can
   *  persist more rows than a history page holds, so the reload's newest page
   *  may not contain the user row the outcome anchors on); the id proves it
   *  describes the turn being reconciled and not an earlier one. */
  onReconnectStreamGone?: (chatId: string, streamId: string, turnAnchor?: TurnAnchor) => void;
};

// Gateway/proxy statuses that mean "transient infra hiccup", not "this turn
// failed". A 504 the user sees comes from Vercel/Fly (edge timeout, cold start,
// machine drain) — the Next proxy itself only ever emits 404 (no stream) or 502
// (upstream unreachable). The brain's run is independent of the SSE GET and the
// stream is resumable, so these are safe to retry-then-resume.
const TRANSIENT_STREAM_STATUSES = new Set([408, 429, 502, 503, 504, 522, 524]);

/** Whether a chat error is a TRANSPORT failure (the SSE connection died —
 *  retries exhausted or the fetch itself failed) rather than the run failing.
 *  The brain's run is independent of the SSE GET: on these errors the reply
 *  usually still completes server-side and arrives via history catch-up, so
 *  the UI should say "connection lost", not "Sunny couldn't reply".
 *  Matches our own `agent-stream failed (<status>)` throw below plus the
 *  browsers' native fetch-failure messages (Chrome/Safari/Firefox). Sibling
 *  of `isTransientFetchError` (lib/transient-fetch.ts), which classifies the
 *  SERVER-side undici/Node strings — add new network-error cases there for
 *  server fetches and here for browser ones. */
/** Errors thrown BEFORE any run exists (send POST failed, sign-in/credit
 *  gate, brain couldn't start). Tagged structurally at the throw site so the
 *  chat UI can show their authored, user-facing copy — unlike terminal run
 *  failures, which end the turn silently. */
export function sendStartFailure(message: string): Error {
  const e = new Error(message);
  e.name = 'SendStartFailure';
  return e;
}

export function isSendStartFailure(error: Error): boolean {
  return error.name === 'SendStartFailure';
}

/** The no-stream-after-submit failure. Tagged as a send/start failure: the
 *  turn produced ZERO output, so the quiet status line is the user's only
 *  signal (silent turn end is for runs that visibly ran). The distinctive
 *  "no active stream after submit" phrase is load-bearing for
 *  tests/diagnostics — keep it. */
const MISSING_STREAM_PHRASE = 'no active stream after submit';

/** The accepted-but-not-yet-streaming notice (a deploy checkpointed the send).
 *  Authored copy, so it renders through the send/start banner — but unlike a
 *  real start failure it is a PREDICTION, and history proving the turn failed
 *  must be allowed to replace it. */
const QUEUED_PHRASE = 'Your message is queued';

export function isQueuedNotice(error: Error): boolean {
  return error.message.includes(QUEUED_PHRASE);
}

/** The out-of-credits gate copy's distinctive phrase — load-bearing: the chat
 *  pane matches it to raise the reach-out modal in front of the plain banner. */
const OUT_OF_CREDITS_PHRASE = 'out of AI credits';

export function isOutOfCreditsFailure(error: Error): boolean {
  return isSendStartFailure(error) && error.message.includes(OUT_OF_CREDITS_PHRASE);
}

function missingStreamFallback(): Error {
  return sendStartFailure(
    `Sundial Agent didn't reply (${MISSING_STREAM_PHRASE}) - try sending again.`,
  );
}

/** True for the GENERIC dead-send error above — i.e. the history read-back
 *  proved nothing either way. Every other outcome of missingStreamError is
 *  evidence (a persisted run_error, a proven finish) and owns the banner. */
function isMissingStreamFallback(error: Error): boolean {
  return error.message.includes(MISSING_STREAM_PHRASE);
}

/** Hard (non-transient) stream-open failure — 401/403/500… from the SSE
 *  route. Retrying won't help (unlike a transport drop), but a run may exist
 *  server-side (unlike a send/start failure), so the UI should hint at
 *  reloading rather than stay silent. */
export function isHardStreamOpenFailure(error: Error): boolean {
  const status = /^agent-stream failed \((\d+)\)$/.exec(error.message);
  return Boolean(status) && !TRANSIENT_STREAM_STATUSES.has(Number(status![1]));
}

export function isTransportStreamFailure(error: Error): boolean {
  // Only TRANSIENT statuses count: a 401/403 (not authorized) or 500 (broken
  // route) is a real failure — telling the user the reply will appear once
  // reconnected would be a lie. Same status set the retry loop treats as
  // transient, so the banner and the retries can't disagree.
  const status = /^agent-stream failed \((\d+)\)$/.exec(error.message);
  if (status) return TRANSIENT_STREAM_STATUSES.has(Number(status[1]));
  return /^(Failed to fetch|Load failed|NetworkError)/.test(error.message);
}

function extractText(message: UIMessage): string {
  if (!Array.isArray(message.parts)) return '';
  let out = '';
  for (const part of message.parts) {
    if (part.type === 'text' && typeof (part as { text?: string }).text === 'string') {
      out += (part as { text: string }).text;
    }
  }
  return out;
}

export class SundialChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  // Per-chat resume cursor for the turn we're currently tailing: the active
  // stream's id (the harness `streamId`, surfaced via the `X-Stream-Id`
  // response header) plus the SSE character count we've consumed of it. Sent
  // back on reconnect so resumable-stream resumes from the offset instead of
  // replaying the whole turn — a replay re-delivers everything already
  // rendered, which the SDK appends as a duplicate turn (the "qweqwe"
  // cascade).
  //
  // The offset is meaningful ONLY for the stream it was counted against. A
  // later run for the same chat (a foreign-user reply, a scheduled-task turn,
  // or a replacement after interrupt) is a DIFFERENT stream, so we tag the
  // offset with `streamId` and send it as a guard: the server discards the
  // offset when it no longer matches the chat's active stream, serving the new
  // turn from its start instead of skipping into the middle of it. Without the
  // guard a stale offset makes the server skip the first N characters of the
  // new reply (Codex P1).
  private resumeCursor = new Map<string, { streamId: string; chars: number }>();
  // Chats whose last stream-open attempt hit a 410 (active id → DONE stream):
  // the post-turn persist window. Lets reconnectToStream fire gone-recovery
  // even with no cursor (fresh mount/reload) so the reply isn't stranded
  // until a manual refresh. The submit path never treats it as SUCCESS — a
  // submit-side 410 can be the previous turn's stream or our own run's
  // startup window, so only the history read-back proves a finish — but it
  // does use it to ARM the cursorless recovery before erroring. Per-chat (a
  // background chat's reconnect and the active chat's submit can be in
  // flight at once).
  private finished410Chats = new Set<string>();
  // The sequence the latest submit's POST minted for each chat. EVERY
  // gone-recovery hands it to the client: the reconcile bounds the turn by
  // finding the submitted user row in the reloaded page, and an uncapped turn
  // can persist more rows than a page holds, pushing its own user row out —
  // the outcome would then read 'none' forever and recovery would poll to its
  // limit over a reply that already landed. Kept here rather than passed
  // through each call path because the RESUME paths (reconnectToStream) have
  // no POST of their own yet face the same turn. It carries the user row's ID
  // too: a resume-only or FOREIGN turn (a collaborator posting in this chat)
  // mints no anchor of its own, so this entry can outlive the turn it
  // describes — only the id can prove which turn a sequence belongs to.
  private submittedTurnSeq = new Map<string, TurnAnchor>();
  // Chats with an SSE reader attached (or an attach in flight) right now.
  //
  // `useChat`'s makeRequest has NO concurrency guard: a `resume-stream` fired
  // while a stream is already being consumed installs a SECOND activeResponse
  // whose state was seeded from a SNAPSHOT of the message, and both readers
  // then write their own diverging snapshot of the same assistant message into
  // the store. On screen that is text and "Thinking…" flickering on and off,
  // plus the resumed tail landing in a second text part under a frozen prefix
  // (the duplicated bubble reported 2026-08-10). And the tickles are routine:
  // the realtime fan-in fires one on EVERY assistant-row INSERT — including our
  // own turn's, inserted up front — plus another 1.5s later, and each chat
  // activation fires one too.
  //
  // So the attach is tracked here and `reconnectToStream` no-ops while it is
  // held: the SDK bails before touching status or activeResponse when
  // reconnectToStream resolves null, which makes a redundant tickle free.
  // A SET of release handles rather than a flag, because a replacement send
  // opens its stream while the superseded one is still draining. Each handle
  // fires on ANY end of its reader — clean finish, error, abort, cancel — so a
  // severed stream is resumable the moment it stops delivering.
  private attachedChats = new Map<string, Set<() => void>>();
  // One AbortController per attached reader. A half-open socket (no FIN/RST)
  // hangs `reader.read()` forever without erroring — the reader then pins
  // useChat at 'streaming' AND its attach mark blocks every later resume, so
  // the tab shows "working" until reload (Sean's 17-hour incident). The resume
  // path passes no caller signal at all, so without these controllers such a
  // reader is structurally unkillable.
  private attachAborts = new Map<string, Set<AbortController>>();
  // Chats whose in-flight resume stood down because a submit attached while its
  // GET was still open. Read once by reconnectToStream so it doesn't mistake the
  // null for a vanished stream and start recovering a turn that is streaming.
  private supersededResumes = new Set<string>();

  /** Mark a reader as attached for `chatId`. The returned release is idempotent
   *  and scoped to its own set: a reader handed off below still ends later and
   *  releases again, and that second call must not wipe the claim of whatever
   *  reader has since taken the chat over. */
  private markAttached(chatId: string): () => void {
    const held = this.attachedChats.get(chatId) ?? new Set<() => void>();
    this.attachedChats.set(chatId, held);
    const release = () => {
      if (!held.delete(release)) return; // already released
      if (held.size === 0 && this.attachedChats.get(chatId) === held) {
        this.attachedChats.delete(chatId);
      }
    };
    held.add(release);
    return release;
  }

  private attachedCount(chatId: string): number {
    return this.attachedChats.get(chatId)?.size ?? 0;
  }

  /** Hand this chat's turn over to a new `useChat` instance: drop the marks any
   *  reader still attached for it holds.
   *
   *  `useChat` mints a BRAND-NEW Chat on every id change, and switching away
   *  doesn't stop the discarded one's reader — it keeps consuming into state
   *  nothing renders. Its mark would then block the new instance from resuming
   *  and the reply would sit frozen until a reload (issue #347). Called by the
   *  hook's per-activation effect, which is exactly when a new instance takes
   *  over the id. The abandoned reader is left to drain (it ends with the run);
   *  only its claim on the chat is released, and only one reader per instance is
   *  what the guard is actually for. */
  handOffAttachedReaders(chatId: string): void {
    for (const release of [...(this.attachedChats.get(chatId) ?? [])]) release();
  }

  /** Sever every reader attached for `chatId` — the settle path for a run whose
   *  persisted row is already terminal while a reader still claims the chat.
   *
   *  Aborting the fetch rejects the pending `read()` (the only thing that can
   *  break a half-open socket), which errors the SDK's consumed stream with an
   *  AbortError: `makeRequest` maps that to status `ready` + `onFinish({isAbort})`,
   *  which `shouldAutoResume` declines — the wedge unwinds through the SDK's own
   *  abort path, no state is forged. The marks are released here too (the
   *  reader's async close re-release is idempotent) so the follow-up reconcile
   *  can reattach immediately if a newer run is actually live. */
  abortAttachedReaders(chatId: string): void {
    for (const controller of [...(this.attachAborts.get(chatId) ?? [])]) controller.abort();
    this.handOffAttachedReaders(chatId);
  }

  private readonly onReconnectStreamGone?: (
    chatId: string,
    streamId: string,
    turnAnchor?: TurnAnchor,
  ) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: SundialChatTransportOptions) {
    this.onReconnectStreamGone = options?.onReconnectStreamGone;
    this.fetchImpl = options?.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Drop a chat's resume cursor once a turn reaches a terminal state (clean
   *  finish / recovered): the offset is spent, so a later idle reconnect
   *  (mount/foreign resume) must not mistake the leftover for a severed tail.
   *  Guarded by `streamId` when given so a stale terminal callback can't wipe a
   *  cursor a newer turn already stored for the same chat. */
  clearResumeCursor(chatId: string, streamId?: string): void {
    const cursor = this.resumeCursor.get(chatId);
    if (!cursor) return;
    if (streamId !== undefined && cursor.streamId !== streamId) return;
    this.resumeCursor.delete(chatId);
    // The turn is done, so its anchor is spent — the next submit records its
    // own. Dropped here rather than left to accumulate one entry per chat.
    this.submittedTurnSeq.delete(chatId);
  }

  async sendMessages(
    options: {
      trigger: 'submit-message' | 'regenerate-message';
      chatId: string;
      messageId: string | undefined;
      messages: UI_MESSAGE[];
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    // Claim the chat from BEFORE the POST, not just for the stream open: the
    // brain starts the run inside that POST, so a resume tickle landing in the
    // window would find our own brand-new stream, attach to it, and then be
    // joined by our own reader — the two-reader race again (Codex P2). Released
    // once the attach below is done; the reader it returns holds its own mark.
    const claim = this.markAttached(options.chatId);
    try {
      return await this.submitAndAttach(options);
    } finally {
      claim();
    }
  }

  private async submitAndAttach(
    options: {
      trigger: 'submit-message' | 'regenerate-message';
      chatId: string;
      messageId: string | undefined;
      messages: UI_MESSAGE[];
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    // On a fresh user submit, persist the user message via Sundial's existing
    // POST endpoint. Regenerations skip the POST — there's no new user row.
    let persistedUserSeq: number | undefined;
    // The brain checkpointed this submit instead of running it (a deploy caught
    // the machine mid-drain). Read below, where the missing stream is expected
    // rather than a failure.
    let rescued = false;
    if (options.trigger !== 'submit-message') {
      // …and therefore no anchor is valid for THIS run. A leftover one (an
      // earlier submit whose recovery is still pending) would let a failed
      // regenerate reconcile against that attempt's rows and read the previous
      // reply as this run's success — hiding the failure entirely.
      this.submittedTurnSeq.delete(options.chatId);
    }
    if (options.trigger === 'submit-message') {
      const last = options.messages[options.messages.length - 1];
      if (!last || last.role !== 'user') {
        throw new Error('SundialChatTransport: submit-message without trailing user message');
      }
      const meta = (options.body ?? {}) as SundialSendMetadata;
      const content = extractText(last);
      // A native fetch failure HERE means the message was never persisted and
      // no run started — wrap it so isTransportStreamFailure can't read it as
      // a severed stream (whose soft "reply will appear" copy would be a lie).
      const postRes = await this.fetchImpl('/api/workspace/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...((options.headers as Record<string, string>) ?? {}) },
        body: JSON.stringify({
          chatId: options.chatId,
          content,
          sendMode: meta.sendMode ?? 'fullsend',
          // Use the SDK-assigned message id as Sundial's client_id so dedup +
          // history round-trips work without a separate id.
          clientId: last.id,
          attachments: meta.attachments ?? [],
          openFilePath: meta.openFilePath ?? null,
          editMode: meta.editMode ?? 'suggest',
        }),
        signal: options.abortSignal,
      }).catch((err: unknown) => {
        // An intentional Stop must stay an AbortError — the SDK's abort
        // handling (no error banner) keys on the name. Checked by name, not
        // instanceof: a DOMException from another realm fails instanceof.
        if ((err as { name?: unknown } | null)?.name === 'AbortError') throw err;
        throw sendStartFailure(`message send failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      if (!postRes.ok) {
        const text = await postRes.text().catch(() => '');
        throw sendStartFailure(`POST /api/workspace/messages failed (${postRes.status}): ${text}`);
      }
      // Credit gate: the message was stored but Sunny was not started (no
      // credits / not signed in). Surface a friendly reason now instead of
      // spinning on the never-arriving reply stream. The error renders in the
      // chat error banner; the user's message is preserved server-side.
      const postBody = (await postRes.json().catch(() => null)) as {
        agentStart?: {
          ok?: boolean;
          status?: string;
          reason?: string;
          error?: string;
          rescued?: boolean;
        };
        message?: { id?: string; sequence?: number };
      } | null;
      // The persisted user row's sequence anchors the missing-stream recovery
      // read below: a fast tool loop can persist more rows than any fixed
      // newest-N page before our first GET gives up, paging our user row out.
      if (typeof postBody?.message?.sequence === 'number') {
        persistedUserSeq = postBody.message.sequence;
        // …and every OTHER recovery path for this chat, including the resume
        // ones that have no POST of their own (see `submittedTurnSeq`). The
        // row's id rides along so no later turn can adopt this sequence.
        const userMessageId =
          typeof postBody.message.id === 'string'
            ? postBody.message.id
            : [...options.messages].reverse().find((m) => m.role === 'user')?.id;
        this.submittedTurnSeq.set(options.chatId, { sequence: persistedUserSeq, userMessageId });
      }
      const gate = postBody?.agentStart;
      // ONLY an explicit rescue ack counts. A deduped resend also arrives with
      // no agentStart and no stream, and its first attempt may equally have
      // been rescued by a deploy — but it may just as easily have been
      // gate-blocked (out of credits, signed out) or have failed to start at
      // all, and "your message is queued" over a reply that can never come is
      // the worse lie. The bare duplicate keeps the honest dead-send error.
      rescued = gate?.rescued === true;
      if (gate?.status === 'blocked') {
        throw sendStartFailure(
          gate.reason === 'signin_required'
            ? 'Sign in to chat with Sundial Agent.'
            : "You're out of AI credits. Add credits or upgrade in Settings → Billing to keep going.",
        );
      }
      // Startup failure (brain unreachable / /agent/run rejected): the route
      // returns 200 with agentStart.ok=false and only logs. NO run or stream
      // exists — opening the SSE would 502 and masquerade as a recoverable
      // "Connection lost". Fail now with the real reason instead.
      if (gate && gate.ok === false && gate.status !== 'blocked') {
        throw sendStartFailure(`Sundial Agent couldn't start${gate.error ? `: ${gate.error}` : '.'}`);
      }
    }

    // Now open the SSE stream for the assistant reply. A fresh submit starts a
    // new run/stream, so drop any prior cursor and count this one from 0. Brief
    // retry on 404 to cover the race between POST returning and the harness
    // writing the active_stream_id key into Redis. resumable-stream resolves to
    // a real body once registered.
    this.resumeCursor.delete(options.chatId);
    this.finished410Chats.delete(options.chatId);
    const stream = await this.openStream(options.chatId, options.abortSignal, { retries: 5, resume: false }).catch(
      (err: unknown) => {
        // The stream never OPENED (transient budget exhausted before any
        // body). ONLY for the transient failures that get the soft banner —
        // a hard 401/500 or an abort is unrecoverable and must not start
        // recovery. Two hooks re-attach this turn to the standard machinery:
        //  - a SENTINEL cursor (empty stream id, zero chars), so any later
        //    resumeStream — a chat switch-back, the recovery loop — goes
        //    through reconnectToStream and its 404 fires the gone-recovery
        //    exactly like a severed stream (the sentinel sends no offset, so
        //    a live stream replays from 0 with real tokens);
        //  - an immediate gone-recovery, so a run that already finished has
        //    its reply merged from history right away. The recovery's cursor
        //    clear ('' matches the sentinel) retires it once the turn is
        //    terminal.
        if (err instanceof Error && isTransportStreamFailure(err)) {
          this.resumeCursor.set(options.chatId, { streamId: '', chars: 0 });
          // The submitted sequence rides along here too: this recovery faces
          // the same uncapped turn as the missing-stream path, and without an
          // anchor the reconcile can't bound a turn whose history outgrew a
          // page — it would poll to its limit over a persisted reply.
          this.onReconnectStreamGone?.(options.chatId, '', this.submittedTurnSeq.get(options.chatId));
        }
        throw err;
      },
    );
    if (!stream) {
      // The turn may have FINISHED before our SSE could attach (a sub-second
      // reply, an instant error bubble): resumable-stream has nothing to
      // replay and the reply lives only in Postgres. The ONLY proof is the
      // history read-back finding a finished reply to OUR submit. A 410 seen
      // during the retries is NOT proof: it can be the previous turn's DONE
      // stream (masking a real start failure), or even OUR run's id in its
      // startup window — the runner sets the active id before
      // createNewResumableStream is ready, and it inserts the empty assistant
      // shell before either, so "410 + shell row" can be a turn that is still
      // STARTING; closing it here would flip the chat to ready with no output
      // and invite a resend that cancel-and-replaces the live run (Codex P2 on
      // PR #1076). On a proven finish, missingStreamError arms the SENTINEL
      // cursor and enters the standard cursorless gone-recovery (immediate
      // history reconcile + bounded retry loop), surfacing only a soft
      // restoring note the completed reconcile clears — a hard "didn't reply"
      // banner over a reply that exists would be a lie.
      const lastUserId = [...options.messages].reverse().find((m) => m.role === 'user')?.id;
      const error = await this.missingStreamError(options.chatId, lastUserId, persistedUserSeq);
      // Unproven finish, but a 410 was seen (a stream ran to DONE — possibly
      // OURS inside the persist window, where the read-back caught only the
      // empty shell). The reply may land moments after that read: arm the
      // SENTINEL cursor + cursorless recovery BEFORE erroring, same as a
      // transient open failure, so the bounded loop reconciles it in (a
      // completed reload clears the error) or attaches the live stream of a
      // still-starting run. Skipped when missingStreamError already armed it
      // (proven finish — the sentinel cursor is set). The throw stays:
      // nothing visibly ran, so a silent success here would just invite a
      // blind resend.
      if (this.finished410Chats.has(options.chatId) && !this.resumeCursor.has(options.chatId)) {
        this.resumeCursor.set(options.chatId, { streamId: '', chars: 0 });
        this.onReconnectStreamGone?.(options.chatId, '', this.submittedTurnSeq.get(options.chatId));
      }
      // Accepted, but nothing is streaming YET — and the read-back proved
      // nothing either way (a persisted run_error or a proven finish is
      // evidence, and owns the banner). Either a deploy checkpointed this
      // submit (`rescued`: the sweep answers it under a fresh stream id) or the
      // sweep answers it under a fresh stream id. The message is stored and a
      // turn is owed, so the 404s we just burned are the expected shape — arm
      // the sentinel + gone-recovery and say so. "Didn't reply, try sending
      // again" would invite a resend that cancel-and-replaces the rescued run.
      // The fallback check is the whole gate: proven evidence owns the banner,
      // absence of it doesn't. Whether the cursor is already armed is
      // irrelevant to the COPY — a stale 410 from a previous DONE stream arms
      // it just above, and skipping on that would tell a rescued sender to
      // resend (replacing the very run they're waiting on). It only decides
      // whether we still need to arm.
      if (rescued && isMissingStreamFallback(error)) {
        if (!this.resumeCursor.has(options.chatId)) {
          this.resumeCursor.set(options.chatId, { streamId: '', chars: 0 });
          this.onReconnectStreamGone?.(options.chatId, '', this.submittedTurnSeq.get(options.chatId));
        }
        throw sendStartFailure(`${QUEUED_PHRASE}. The reply will appear here.`);
      }
      throw error;
    }
    return stream;
  }

  // A run that fails at startup (e.g. a harness misconfiguration) can register,
  // error, and clear its stream faster than our first GET arrives — every retry
  // 404s and the turn would surface as an opaque "no active stream after
  // submit". The runner persists the real failure onto the assistant row
  // (metadata.run_status/run_error) before the stream closes, so read it back
  // and surface that instead. Best-effort: any fetch/shape problem falls back
  // to the generic error.
  private async missingStreamError(
    chatId: string,
    lastUserMessageId: string | undefined,
    persistedUserSeq?: number,
  ): Promise<Error> {
    const fallback = missingStreamFallback();
    try {
      // Anchor the read on the submitted row's sequence when we have it: a
      // fast tool loop can persist more rows than a fixed newest-N page
      // before the first GET gives up, paging the user row (and with it the
      // reply) out entirely. afterSequence guarantees the user row + its
      // reply lead the page — and an UNCAPPED tool-first turn can outgrow a
      // single page before its assistant anchor, so page forward (bounded)
      // until the turn ends or rows run out. Sequence 1 needs no cursor (the
      // full-history read spans it); no known sequence keeps the legacy
      // newest-10 page.
      type Row = { id?: string; role?: string; sequence?: number; metadata?: unknown };
      const fetchRows = async (params: string): Promise<Row[] | null> => {
        const res = await this.fetchImpl(`/api/workspace/messages?chatId=${encodeURIComponent(chatId)}${params}`);
        if (!res.ok) return null;
        const body = (await res.json()) as { messages?: Row[] };
        return Array.isArray(body.messages) ? body.messages : [];
      };
      let rows: Row[];
      let userSeq: number | undefined;
      // Set while the turn is still running past the page budget below: runs
      // are uncapped, so no fixed scan is guaranteed to reach the assistant
      // anchor of a tool-first turn.
      let outgrewScan = false;
      if (typeof persistedUserSeq === 'number') {
        // The POST minted this sequence — the user row's existence is proven,
        // so page strictly AFTER it (afterSequence must be ≥ 1, which also
        // covers a chat whose first-ever row is ours).
        userSeq = persistedUserSeq;
        rows = [];
        let after = persistedUserSeq;
        outgrewScan = true;
        for (let page = 0; page < 10; page += 1) {
          const chunk = await fetchRows(`&afterSequence=${after}&limit=200`);
          if (chunk === null) return fallback;
          rows.push(...chunk);
          const last = chunk.at(-1)?.sequence;
          const done =
            chunk.length < 200 ||
            typeof last !== 'number' ||
            last <= after || // backend ignored the cursor (local shim) — no progress
            chunk.some((r) => r.role === 'user' && (r.sequence ?? 0) > persistedUserSeq); // next turn began
          if (done) {
            outgrewScan = false;
            break;
          }
          after = last;
        }
      } else {
        const single = await fetchRows('&limit=10');
        if (single === null) return fallback;
        rows = single;
        userSeq = rows.find((r) => r.id === lastUserMessageId)?.sequence;
      }
      // Only trust rows that are provably OUR turn: everything after our
      // persisted user row up to the NEXT user row (a stale error from an
      // older turn, or a later collaborator/replacement turn whose failure
      // isn't ours, falls outside the window → generic error). Scanned, not
      // first-row-only: the local runner persists tool rows BEFORE the
      // assistant anchor, so a tool-using turn's first post-user row is a
      // system row.
      const after =
        typeof userSeq === 'number'
          ? rows
              .filter((r) => typeof r.sequence === 'number' && r.sequence > userSeq)
              .sort((a, b) => (a.sequence as number) - (b.sequence as number))
          : [];
      const nextUser = after.findIndex((r) => r.role === 'user');
      const turnRows = nextUser === -1 ? after : after.slice(0, nextUser);
      const mdOf = (r: (typeof rows)[number] | undefined) =>
        (r?.metadata ?? null) as { run_status?: unknown; run_error?: unknown } | null;
      // 'incomplete' is terminal-failed too (unfinished tool calls, stalled
      // streams) — latestTurnOutcome already classifies it as failed, and the
      // soft "restoring" note would misread it as a successful reply.
      // `resume_pending` outranks the status: a deploy checkpointed this turn
      // (an interrupted tool loop persists as `incomplete`) and a healthy
      // machine is resuming it under a fresh stream. Reporting that as a
      // terminal failure would both lie and stop the recovery, exactly as it
      // would in latestTurnOutcome — which reads the same marker.
      const errored = turnRows.find(
        (r) =>
          r.role === 'assistant' &&
          (mdOf(r) as { resume_pending?: unknown } | null)?.resume_pending !== true &&
          ['error', 'incomplete'].includes(String(mdOf(r)?.run_status)),
      );
      if (errored) {
        // UNTAGGED on purpose: a persisted run_error is a TERMINAL run
        // failure (the run's row exists), and those end the turn silently —
        // only the no-row fallback below gets the visible send/start hint.
        const md = mdOf(errored);
        return new Error(
          typeof md?.run_error === 'string' && md.run_error
            ? md.run_error
            : 'Sundial Agent hit an error before it could reply.',
        );
      }
      // Success recovery only for a FRESH submit (we hold the sequence its
      // POST just minted, so every turn row postdates this attempt) whose
      // window shows TERMINAL proof: the last row is an assistant row without
      // the in-flight `streaming` marker. A regenerate reuses the old user
      // row (the previous reply would masquerade as this run's success), and
      // a mid-run window — an announcement row awaiting its tools, a cloud
      // anchor still streaming — must not stop recovery as "completed" while
      // the run is still producing.
      const lastRow = turnRows.at(-1);
      const lastTerminal =
        lastRow?.role === 'assistant' &&
        (mdOf(lastRow) as { streaming?: unknown } | null)?.streaming !== true;
      // `outgrewScan` joins it: the turn ran past the page budget, so the
      // anchor is out of reach — but 2000+ persisted rows PROVE the turn
      // produced output, which is exactly the case the reconcile handles. The
      // recovery loop re-reads rows and stands down once the turn is terminal;
      // claiming "didn't reply" about a turn we watched persist thousands of
      // rows would be the one clearly wrong answer.
      if (typeof persistedUserSeq === 'number' && (lastTerminal || outgrewScan)) {
        // The run SUCCEEDED before our first GET could attach (e.g. it
        // finished and its replay window was already evicted — the stream
        // 410s forever). That's a delivery problem, not a failed turn: arm
        // the sentinel + gone-recovery so the reply merges from history, and
        // surface a soft transport note the completed reconcile clears.
        this.resumeCursor.set(chatId, { streamId: '', chars: 0 });
        this.onReconnectStreamGone?.(chatId, '', this.submittedTurnSeq.get(chatId));
        return sendStartFailure('The reply finished before the stream connected, restoring it from history.');
      }
    } catch {
      // fall through
    }
    return fallback;
  }

  async reconnectToStream(
    options: { chatId: string } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // Single attempt — if there's no active stream we simply return null and
    // the chat stays at rest. Resume from the character offset we've already
    // consumed so the server replays only the un-seen tail.
    // Already tailing this chat: a second reader on the same stream makes the
    // SDK interleave two divergent snapshots of one message (see
    // `attachedChats`). Bail before anything else — no fetch, and no
    // gone-recovery either, since the attached reader owns the turn.
    if (this.attachedCount(options.chatId) > 0) return null;
    // Snapshot the cursor this resume is based on BEFORE the await: a new turn
    // for the same chat can replace the map entry (new stream id) while the
    // resume fetch is in flight, and we must not report that newer, live stream
    // as gone.
    const attempted = this.resumeCursor.get(options.chatId);
    this.finished410Chats.delete(options.chatId);
    // A transient open failure here must NOT propagate. For trigger
    // 'resume-stream' the SDK calls reconnectToStream OUTSIDE the try block
    // that wraps the rest of the turn: it catches the rejection into onError
    // and sets status 'error', but returns right there — `onFinish` never
    // runs, so the auto-resume loop dies permanently and the turn is lost from
    // the UI even though the run completes on the brain. Do what the SUBMIT
    // path does with the same failure (see submitAndAttach): arm the SENTINEL
    // cursor + gone-recovery and resolve null (idle), so the bounded recovery
    // loop reconciles the reply from history. Hard failures (401/403/500)
    // still throw — retrying can't help and the banner is honest.
    let transientOpenFailure = false;
    const stream = await this.openStream(options.chatId, undefined, { retries: 0, resume: true }).catch(
      (err: unknown) => {
        if (err instanceof Error && isTransportStreamFailure(err)) {
          transientOpenFailure = true;
          return null;
        }
        throw err;
      },
    );
    if (transientOpenFailure) {
      // The retries above can burn seconds, and a submit can land inside that
      // window. Stand down exactly like the two sibling paths do (the res.ok
      // branch on attachedCount, the no-stream branch on the cursor identity):
      // that newer turn owns the chat, so nothing is gone, and overwriting its
      // real cursor with the sentinel would make the NEXT drop resume with no
      // offset — a full replay from character 0, i.e. the duplicate-turn
      // cascade the cursor exists to prevent.
      if (this.attachedCount(options.chatId) > 0) return null;
      if (this.resumeCursor.get(options.chatId) !== attempted) return null;
      this.resumeCursor.set(options.chatId, { streamId: '', chars: 0 });
      this.onReconnectStreamGone?.(options.chatId, '', this.submittedTurnSeq.get(options.chatId));
      return null;
    }
    // A submit attached while this resume's GET was in flight and the resume
    // stood down (see attachStream). Nothing is gone — the submit's reader owns
    // the turn — so return quietly without arming recovery.
    if (this.supersededResumes.delete(options.chatId)) return null;
    if (!stream) {
      // No live stream. If we'd opened one for this chat (a cursor exists — even
      // at zero chars, recorded the moment the stream opened, so an SSE that
      // died before its first frame still counts), the turn finished while our
      // SSE was severed and its tail is gone from the stream store. Signal so
      // the client can reconcile the frozen, half-rendered bubble from persisted
      // history instead of leaving it stuck until a manual reload. We do NOT drop
      // the cursor here: if that reconcile fails (e.g. the same blip also failed
      // the history refetch), the cursor must survive so a later reconnect
      // retries. The client clears it via clearResumeCursor once recovery
      // actually lands (or on a clean finish).
      const cursor = this.resumeCursor.get(options.chatId);
      // Only recover the stream this resume actually tried. If the cursor changed
      // during the await, a newer turn took over — its stream is live, not gone.
      if (cursor && attempted && cursor.streamId === attempted.streamId) {
        this.onReconnectStreamGone?.(options.chatId, cursor.streamId, this.submittedTurnSeq.get(options.chatId));
      } else if (this.finished410Chats.has(options.chatId) && !cursor) {
        // 410 with no cursor: a fresh mount/reload landed inside the post-turn
        // persist window (active id → DONE stream). There's no offset to
        // replay, but a turn definitely just finished here — arm the SENTINEL
        // cursor and enter the standard cursorless recovery (immediate
        // reconcile + the hook's bounded retry loop), same as an initial
        // stream-open failure, so the reply isn't stranded behind the
        // eagerly-inserted empty row while its row is still persisting.
        this.resumeCursor.set(options.chatId, { streamId: '', chars: 0 });
        this.onReconnectStreamGone?.(options.chatId, '', this.submittedTurnSeq.get(options.chatId));
      }
    }
    return stream;
  }

  /** Attach with the chat marked as taken for the whole attempt — including the
   *  registration retries, since the assistant row (and its realtime tickle)
   *  lands BEFORE the stream registers. A handed-back reader owns the mark and
   *  releases it when it ends; every other exit releases here. */
  private async openStream(
    chatId: string,
    abortSignal: AbortSignal | undefined,
    opts: { retries: number; resume?: boolean },
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // Every reader gets its own controller (chained to the caller's signal
    // when there is one — the submit path's stop/interrupt keeps working) so
    // abortAttachedReaders can sever it. Registered for the whole attempt and
    // dropped when the reader ends, alongside the attach mark.
    const controller = new AbortController();
    if (abortSignal?.aborted) controller.abort();
    else abortSignal?.addEventListener('abort', () => controller.abort(), { once: true });
    const held = this.attachAborts.get(chatId) ?? new Set<AbortController>();
    this.attachAborts.set(chatId, held);
    held.add(controller);
    const releaseMark = this.markAttached(chatId);
    const release = () => {
      held.delete(controller);
      if (held.size === 0 && this.attachAborts.get(chatId) === held) this.attachAborts.delete(chatId);
      releaseMark();
    };
    let reader: ReadableStream<UIMessageChunk> | null = null;
    try {
      reader = await this.attachStream(chatId, controller.signal, opts, release);
      return reader;
    } finally {
      if (!reader) release();
    }
  }

  private async attachStream(
    chatId: string,
    abortSignal: AbortSignal | undefined,
    opts: { retries: number; resume?: boolean },
    /** Released by the reader this hands back, when that reader ends. */
    onReaderClosed: () => void,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // 404 = stream not registered yet (post-submit → Redis race); uses the
    // caller's budget. Transient gateway/proxy statuses on a *resumable* stream
    // — a Vercel/Fly blip (edge 504, cold start, machine drain) while the turn is
    // almost certainly still alive on the brain — get their own budget in BOTH
    // submit and reconnect paths: resumable-stream is built to ride these out, so
    // a momentary 504 must reconnect from the offset, not surface a hard "Sunny
    // couldn't reply (504)".
    const maxNotFoundAttempts = Math.max(1, opts.retries + 1);
    const MAX_TRANSIENT_ATTEMPTS = 4;
    let notFoundAttempts = 0;
    let transientAttempts = 0;
    let lastStatus = 0;
    let saw410 = false;
    for (;;) {
      // On resume, offer our cursor (offset + the stream it belongs to). The
      // server honours the offset only while that stream is still the chat's
      // active one; otherwise it serves the new turn from 0 and tells us the
      // new stream id via `X-Stream-Id` below.
      const cursor = opts.resume ? this.resumeCursor.get(chatId) : undefined;
      const res = await this.fetchImpl(
        `/api/workspace/agent-stream?chatId=${encodeURIComponent(chatId)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            // Only resume from an offset we can guard with its stream id. An
            // untagged cursor (opened pre-upgrade against an endpoint that sent
            // no X-Stream-Id) can't be validated server-side, so sending its
            // raw offset would risk skipping the start of whatever stream is now
            // active. We drop it instead and let the server replay from 0 — at
            // worst a display duplicate during the deploy window, never lost
            // reply content.
            ...(cursor && cursor.chars > 0 && cursor.streamId
              ? { 'Last-Event-ID': String(cursor.chars), 'X-Resume-Stream-Id': cursor.streamId }
              : {}),
          },
          signal: abortSignal,
        },
      );
      lastStatus = res.status;
      if (res.status === 410) saw410 = true;
      if (res.ok && res.body) {
        // A submit (or an earlier resume) attached while THIS resume's GET was
        // in flight — the count is >1 because our own attempt holds one mark.
        // Reading on would make us the second reader of the same stream, so
        // stand down and let the newer attach own the turn.
        if (opts.resume && this.attachedCount(chatId) > 1) {
          this.supersededResumes.add(chatId);
          void res.body.cancel().catch(() => {});
          return null;
        }
        const streamId = res.headers.get('x-stream-id') ?? cursor?.streamId ?? '';
        // The absolute offset of this response's first byte, when the server
        // reports it (the local sidecar does — its replay window can evict
        // the stream's prefix, so a cold attach starts mid-stream at an
        // offset the client can't infer). Without it, keep counting from our
        // offset only when we actually resumed it — i.e. the cursor was
        // tagged (so we sent the guarded offset above) and the server resumed
        // that very stream. Anything else was served from 0.
        const servedFrom = res.headers.get('x-stream-offset');
        const base =
          servedFrom !== null && Number.isFinite(Number(servedFrom))
            ? Number(servedFrom)
            : cursor && cursor.streamId !== '' && cursor.streamId === streamId
              ? cursor.chars
              : 0;
        // A COLD attach that landed mid-stream (base > 0 without a matching
        // resumed cursor — the server's replay window evicted the prefix):
        // this SSE will only ever carry the tail, so reconcile the missed
        // prefix from persisted rows explicitly. The merge keeps the live
        // tail, and the recovery loop stands down while the stream is live —
        // without this, a clean finish would leave a silently truncated
        // transcript.
        const coldMidStreamAttach = base > 0 && !(cursor && cursor.chars > 0 && cursor.streamId === streamId);
        if (coldMidStreamAttach) {
          this.onReconnectStreamGone?.(chatId, '', this.submittedTurnSeq.get(chatId));
        }
        // Record the cursor the moment the stream opens, before any frame. If
        // the SSE dies before sseBodyToChunks sees a complete frame, this
        // zero-length cursor is what lets the gone-recovery still fire on the
        // next reconnect (otherwise the chat would look idle and freeze).
        this.resumeCursor.set(chatId, { streamId, chars: base });
        const chunks = sseBodyToChunks(
          res.body,
          abortSignal,
          (streamChars) => this.resumeCursor.set(chatId, { streamId, chars: base + streamChars }),
          // Clean finish for THIS chat's stream → the cursor is spent; drop it
          // (guarded by streamId so we never wipe a newer turn's cursor) so a
          // later idle reconnect doesn't read the offset as a severed tail and
          // fire the gone-recovery on an already-complete chat.
          () => this.clearResumeCursor(chatId, streamId),
          onReaderClosed,
        );
        // Any stream that starts mid-way (base > 0) can begin partway through
        // a text/reasoning part whose `*-start` it never saw — a resume's
        // offset replay, but also a SUBMIT whose first GET landed on an
        // already-evicted tail (X-Stream-Offset > 0). Repair the boundary so
        // the SDK's stream processor doesn't throw "missing … part" and kill
        // the reply. Only a COLD mid-stream attach drops orphan tool outputs
        // — an honored resume's client already holds the tool part they
        // belong to.
        // The cold attach also re-opens the message under the run's PERSISTED
        // assistant id (the evicted prefix carried the `start` chunk that
        // normally sets it) — otherwise useChat mints its own, and the
        // reconcile armed above merges by id, so the canonical row could
        // never replace the live tail.
        return base > 0
          ? repairResumedPartBoundaries(chunks, {
              dropOrphanToolOutputs: coldMidStreamAttach,
              startMessageId: coldMidStreamAttach ? (res.headers.get('x-message-id') ?? undefined) : undefined,
            })
          : chunks;
      }
      // 404 = no active stream yet. Backoff and retry on submit; bail on
      // reconnect. A 410 on SUBMIT is the same shape — the previous turn's
      // DONE stream is still the active id while the new run registers — so
      // it shares the retry budget (on resume it falls through to the
      // gone-recovery below instead).
      if (res.status === 404 || (res.status === 410 && !opts.resume)) {
        notFoundAttempts++;
        if (notFoundAttempts < maxNotFoundAttempts) {
          await new Promise((r) => setTimeout(r, 150 * notFoundAttempts));
          continue;
        }
        break;
      }
      // Transient gateway blip on a resumable stream: back off and retry (the
      // run lives on independently of this SSE connection).
      if (TRANSIENT_STREAM_STATUSES.has(res.status) && transientAttempts < MAX_TRANSIENT_ATTEMPTS) {
        transientAttempts++;
        await new Promise((r) => setTimeout(r, Math.min(1000, 250 * transientAttempts)));
        continue;
      }
      // Other 4xx/5xx: bail. reconnectToStream returns null; sendMessages
      // throws upstream.
      break;
    }
    if (lastStatus === 404 || lastStatus === 410) {
      // A 410 on ANY attempt = the active_stream_id pointed at a stream that
      // is already DONE (resumable-stream can't replay it): the post-turn
      // persist window — the brain clears the id only once the row has landed,
      // so the id can flip 410 → 404 mid-loop. Mark the chat so the caller
      // (reconnectToStream, or a submit whose turn finished before its SSE
      // attach) fires the gone-recovery that reconciles the persisted reply
      // from history, rather than reading this as "never started" / idle.
      if (saw410) this.finished410Chats.add(chatId);
      return null;
    }
    throw new Error(`agent-stream failed (${lastStatus})`);
  }
}
