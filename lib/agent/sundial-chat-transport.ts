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
   *  recovery can clear exactly that cursor (not a newer turn's). */
  onReconnectStreamGone?: (chatId: string, streamId: string) => void;
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
  // Chat whose last resume attempt hit a 410 (active id → DONE stream): the
  // post-turn persist window. Lets reconnectToStream fire gone-recovery even
  // with no cursor (fresh mount/reload), so the reply isn't stranded behind
  // the eagerly-inserted empty assistant row until a manual refresh.
  private reconnect410ChatId: string | null = null;

  private readonly onReconnectStreamGone?: (chatId: string, streamId: string) => void;
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
    // On a fresh user submit, persist the user message via Sundial's existing
    // POST endpoint. Regenerations skip the POST — there's no new user row.
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
          editMode: meta.editMode ?? 'edit',
        }),
        signal: options.abortSignal,
      }).catch((err: unknown) => {
        // An intentional Stop must stay an AbortError — the SDK's abort
        // handling (no error banner) keys on the name. Checked by name, not
        // instanceof: a DOMException from another realm fails instanceof.
        if ((err as { name?: unknown } | null)?.name === 'AbortError') throw err;
        throw new Error(`message send failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      if (!postRes.ok) {
        const text = await postRes.text().catch(() => '');
        throw new Error(`POST /api/workspace/messages failed (${postRes.status}): ${text}`);
      }
      // Credit gate: the message was stored but Sunny was not started (no
      // credits / not signed in). Surface a friendly reason now instead of
      // spinning on the never-arriving reply stream. The error renders in the
      // chat error banner; the user's message is preserved server-side.
      const postBody = (await postRes.json().catch(() => null)) as {
        agentStart?: { ok?: boolean; status?: string; reason?: string; error?: string };
      } | null;
      const gate = postBody?.agentStart;
      if (gate?.status === 'blocked') {
        throw new Error(
          gate.reason === 'signin_required'
            ? 'Sign in to chat with Sunny.'
            : "You're out of AI credits. Add credits or upgrade in Settings → Billing to keep going.",
        );
      }
      // Startup failure (brain unreachable / /agent/run rejected): the route
      // returns 200 with agentStart.ok=false and only logs. NO run or stream
      // exists — opening the SSE would 502 and masquerade as a recoverable
      // "Connection lost". Fail now with the real reason instead.
      if (gate && gate.ok === false && gate.status !== 'blocked') {
        throw new Error(`Sunny couldn't start${gate.error ? `: ${gate.error}` : '.'}`);
      }
    }

    // Now open the SSE stream for the assistant reply. A fresh submit starts a
    // new run/stream, so drop any prior cursor and count this one from 0. Brief
    // retry on 404 to cover the race between POST returning and the harness
    // writing the active_stream_id key into Redis. resumable-stream resolves to
    // a real body once registered.
    this.resumeCursor.delete(options.chatId);
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
          this.onReconnectStreamGone?.(options.chatId, '');
        }
        throw err;
      },
    );
    if (!stream) {
      const lastUserId = [...options.messages].reverse().find((m) => m.role === 'user')?.id;
      throw await this.missingStreamError(options.chatId, lastUserId);
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
  private async missingStreamError(chatId: string, lastUserMessageId: string | undefined): Promise<Error> {
    const fallback = new Error('SundialChatTransport: no active stream after submit');
    try {
      const res = await this.fetchImpl(
        `/api/workspace/messages?chatId=${encodeURIComponent(chatId)}&limit=10`,
      );
      if (!res.ok) return fallback;
      const body = (await res.json()) as {
        messages?: Array<{ id?: string; role?: string; sequence?: number; metadata?: unknown }>;
      };
      const rows = Array.isArray(body.messages) ? body.messages : [];
      const userSeq = rows.find((r) => r.id === lastUserMessageId)?.sequence;
      // Only trust an errored assistant row that is provably the reply to OUR
      // submit: the runner inserts the turn's assistant row up-front, so it is
      // the FIRST row after our persisted user row. Anything else (a stale
      // error from an older turn, or a later collaborator/replacement turn
      // whose failure isn't ours) falls back to the generic error.
      const reply =
        typeof userSeq === 'number'
          ? rows
              .filter((r) => typeof r.sequence === 'number' && r.sequence > userSeq)
              .sort((a, b) => (a.sequence as number) - (b.sequence as number))[0]
          : undefined;
      const md = (reply?.metadata ?? null) as { run_status?: unknown; run_error?: unknown } | null;
      if (reply?.role === 'assistant' && md?.run_status === 'error') {
        return new Error(
          typeof md.run_error === 'string' && md.run_error
            ? md.run_error
            : 'Sunny hit an error before it could reply.',
        );
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
    // Snapshot the cursor this resume is based on BEFORE the await: a new turn
    // for the same chat can replace the map entry (new stream id) while the
    // resume fetch is in flight, and we must not report that newer, live stream
    // as gone.
    const attempted = this.resumeCursor.get(options.chatId);
    this.reconnect410ChatId = null;
    const stream = await this.openStream(options.chatId, undefined, { retries: 0, resume: true });
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
        this.onReconnectStreamGone?.(options.chatId, cursor.streamId);
      } else if (this.reconnect410ChatId === options.chatId && !cursor) {
        // 410 with no cursor: a fresh mount/reload landed inside the post-turn
        // persist window (active id → DONE stream). There's no offset to
        // replay, but a turn definitely just finished here — arm the SENTINEL
        // cursor and enter the standard cursorless recovery (immediate
        // reconcile + the hook's bounded retry loop), same as an initial
        // stream-open failure, so the reply isn't stranded behind the
        // eagerly-inserted empty row while its row is still persisting.
        this.resumeCursor.set(options.chatId, { streamId: '', chars: 0 });
        this.onReconnectStreamGone?.(options.chatId, '');
      }
    }
    return stream;
  }

  private async openStream(
    chatId: string,
    abortSignal: AbortSignal | undefined,
    opts: { retries: number; resume?: boolean },
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
      if (res.ok && res.body) {
        const streamId = res.headers.get('x-stream-id') ?? cursor?.streamId ?? '';
        // Keep counting from our offset only when we actually resumed it — i.e.
        // the cursor was tagged (so we sent the guarded offset above) and the
        // server resumed that very stream. Anything else (untagged cursor, or a
        // switch to a different stream) was served from 0.
        const base =
          cursor && cursor.streamId !== '' && cursor.streamId === streamId ? cursor.chars : 0;
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
        );
        // A resume can begin partway through a text/reasoning part (the offset
        // replay skips the part's `*-start`). Repair the boundary so the SDK's
        // stream processor doesn't throw "missing … part" and kill the reply.
        return opts.resume && base > 0 ? repairResumedPartBoundaries(chunks) : chunks;
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
    if (lastStatus === 404 || (lastStatus === 410 && !opts.resume)) return null;
    // 410 = the active_stream_id still points at a stream that is already
    // DONE (resumable-stream can't replay it). On a resume this is the
    // post-turn persist window — the brain clears the id only once the row
    // has landed — so treat it like the stream being gone (null → the
    // gone-recovery reconciles from persisted history) rather than a hard
    // error that kills the chat.
    if (opts.resume && lastStatus === 410) {
      this.reconnect410ChatId = chatId;
      return null;
    }
    throw new Error(`agent-stream failed (${lastStatus})`);
  }
}
