import http from 'node:http';
import os from 'node:os';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { LocalStore, coerceModelForHarness, defaultHome } from './store.mjs';
import { DocHost } from './doc-host.mjs';
import {
  caseConflictMessage, caseVariantOnDisk, copyPath, deleteFile, hasUntrackedContent, makeFolder, readTextFile, renameFile,
  safeResolveInRoot, walkProject, writeBlobAtomic, writeBlobStreamAtomic, writeTextFileAtomic,
} from './disk.mjs';
import { RootWatchers, locateRel, pickRootPrefix, projectRoots, walkAllRoots } from './roots.mjs';
import { MIME, fileKind, fileKindForFile, isIgnoredPath, logPath, normalizeRelPath, resolveInRoot } from './paths.mjs';
import { buildLocalChangeEntries, collectLocalSessions } from './history.mjs';
import { SyncBridgeManager } from './bridge.mjs';
import { compileLatexLocally } from './compile.mjs';
import { createZipNodeBuffer } from '../lib/zip/create-zip-base64.ts';
import { resolveDefaultHarness } from '../lib/workspace/default-harness.ts';
import { isSingleEmoji } from '../lib/workspace/doc-comments.ts';
import { LocalAgentHost } from './agent/runner.mjs';
import { SUNNY_AUTHOR, createAgentWriter, engineAuthorId } from './agent/tools.mjs';
import { cloneGitHubRepo, createProjectDir } from './scaffold.mjs';
import { parseSidecarArgs, SIDECAR_USAGE, SidecarCliError } from './cli.mjs';
import { createDiagnosticsSink } from './diagnostics.mjs';

/** Bumped whenever the shell/web app depends on a sidecar endpoint that older
 *  sidecars lack. A leftover instance from before an update reports a lower
 *  number (absent = 1) and gets REPLACED at boot instead of deferred to —
 *  deferring to old code is how "unknown project" reached the create dialog. */
export const SIDECAR_API_VERSION = 27; // 27: GET/POST /diagnostics — the app's user-visible error-report toggle (an older sidecar 404s and the app hides the switch); 26: shares expose per-scope sync progress and the bridge reports cloud heartbeats; 25: hosted MCP folder attach + in-sidecar credential refresh; 24: `signedIn` on /health (agent-credentials present) — a headless `serve.sh --share` run reads it to decline injecting an anon share into a signed-in desktop instance (and points the user at the app's Share); an older instance omits it, so the headless defer requires apiVersion ≥ 24 and refuses rather than guessing; …9: grants-model shares (grants:true, scope:* ids) — an older sidecar would silently create a LEGACY share against the hidden backing workspace; 10: /turn-edits (chat diff chip), chat-message paging (beforeSequence), /local/<id> served off the shell; 11: extra_roots on GET /projects (launcher rows label multi-folder workspaces); 12: POST /shares/confirm (mint-confirm — the client treats a 404 as live for older sidecars); 13: scope generations (confirm returns `generation`, scopes carry it, stops revoke ≤ it); 14: afterSequence on GET /chat-messages selects the EARLIEST rows after the cursor (same response shape, different page) — an older sidecar returns the newest window instead, so the web app's long-turn backfill would silently re-read the tail and leave the middle of the turn missing; 15: /comments reads and writes the CLOUD backing store for share-covered paths — an older sidecar keeps every comment in its local twin, so link guests' comments stay invisible to the owner (and the owner's to them) until the service is restarted by hand; 16: comments trigger agent runs (thread.chatId on GET /comments, comment_watch_path on /chats) — an older sidecar just stores the comment and nothing reacts; 17: `running` on GET /chats rows (live runner state) — the comment panel's "Agent is working" clears from it; absent means unknown and the panel falls back to reply-derived state; 18: POST /chat-messages persists a UUID clientId as the row id (optimistic↔persisted identity) — an older sidecar mints a fresh id, so every history reconcile re-adds the user row beside the optimistic bubble (duplicate message at the transcript bottom); 19: /file, /folder and /rename answer 409 on a case-variant collision — an older sidecar silently truncates the differently-cased original (`recent.md` empties `Recent.md`); 20: /local-engines resolves `defaultHarness` from detection when nobody picked one (and new chats are stamped with it) — an older sidecar answers null, so every new chat silently runs as cloud Sunny while the composer chip says so, ignoring the Claude Code / Codex the machine already has; 21: `answering` on GET /chats rows (a started run still owes this chat's comment thread an answer, spanning the retry gaps where it is not live) — the comment panel holds its "Agent is working" badge on it, so the badge no longer clears seconds before the reply lands; an older sidecar omits it and the badge clears on the first settle, as before; 22: the shares surface is scoped to the deployment this sidecar proxies (one ledger per machine, one row set per cloud) — an older sidecar mixes another deployment's rows into this app's list, where they retry that cloud forever, veto new shares on the same path, hand back their unreachable workspace as this project's backing one, and answer every Stop with "Project not found"; 23: `eventsPort` on /health (a dedicated events-plane listener, so the long-lived /events stream never occupies a data-plane connection slot) — an older sidecar omits it and the app keeps the stream on the primary origin

/**
 * DNS-rebinding gate. Binding to 127.0.0.1 keeps other machines out, but it is
 * no defence against a page on any origin resolving its OWN name to 127.0.0.1
 * and then talking to us as same-origin. The `Host` header is the one part of
 * that request the page cannot forge, so a request naming anything but a
 * loopback host is refused outright — including `/health`, which answers ahead
 * of the bearer gate and would otherwise leak install presence, project count
 * and the proxied origin to any site.
 *
 * Accepts `127.0.0.1`, `localhost` and `[::1]`, each with an optional port. A
 * missing Host is refused too: HTTP/1.1 requires one, and every client here
 * (the webview, the CLI, the launcher) sends it.
 */
export const isLoopbackHost = (value) => {
  const host = String(value ?? '').trim().toLowerCase();
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  const port = host.slice(name.length);
  if (port && !/^:\d{1,5}$/.test(port)) return false;
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
};

/** True for an Origin header naming a loopback host (any scheme/port) — the
 *  only pages, beyond the deployment this instance proxies, with any business
 *  reading the sidecar API cross-origin. */
export const isLoopbackOrigin = (value) => {
  try {
    return isLoopbackHost(new URL(value).host);
  } catch {
    return false;
  }
};

/** @param {{ port?: number, home?: string, log?: (message: string) => void, exitOnShutdown?: boolean }} [options] */
export async function startLocalServer({
  port = Number(process.env.SUNDIAL_LOCAL_PORT || 4848),
  home = defaultHome(),
  log,
  exitOnShutdown = false,
} = {}) {
  const store = new LocalStore(home);
  if (!log) {
    // Default logger also appends to <home>/sidecar.log — the packaged app's
    // stdout goes nowhere, and sync incidents are undebuggable without it.
    // Rotate keep-one-previous instead of deleting: an incident spanning a
    // restart must not lose its earlier evidence at exactly that boot.
    const logFile = path.join(home, 'sidecar.log');
    try {
      if (fs.statSync(logFile).size > 5_000_000) {
        fs.rmSync(`${logFile}.prev`, { force: true });
        fs.renameSync(logFile, `${logFile}.prev`);
      }
    } catch { /* absent — start fresh */ }
    // The login unit's stdout file has no rotation of its own; launchd opens
    // it O_APPEND, so a boot-time copy+truncate caps it safely.
    const launchdLog = path.join(home, 'serve-launchd.log');
    try {
      if (fs.statSync(launchdLog).size > 10_000_000) {
        fs.rmSync(`${launchdLog}.prev`, { force: true });
        fs.copyFileSync(launchdLog, `${launchdLog}.prev`);
        fs.truncateSync(launchdLog, 0);
      }
    } catch { /* absent */ }
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    log = (message) => {
      const line = `${new Date().toISOString()} ${message}`;
      console.log(`[sundial-local] ${line}`);
      logStream.write(`${line}\n`);
    };
  }
  // Error-level diagnostics ship to the cloud this install is signed in to
  // (see diagnostics.mjs). Off switches: the app's own toggle (GET/POST
  // /diagnostics, live) and SUNDIAL_NO_DIAGNOSTICS=1 (disclosed in /start).
  // Wrapped around whatever logger is in effect so the desktop shell's own
  // logger feeds it too; the sink swallows every failure.
  const diagnosticsOrigin = (process.env.SUNDIAL_REMOTE_ORIGIN || '').trim().replace(/\/$/, '');
  let loadedBundleHash = null;
  const installId = (() => {
    try {
      const identity = fs.readFileSync(path.join(home, 'headless-identity'), 'utf8').trim();
      if (identity) return createHash('sha256').update(identity).digest('hex').slice(0, 16);
    } catch {
      /* not a headless install */
    }
    // Random per install, and the route's rate key when no workspace is named.
    try {
      return store.installId();
    } catch {
      return null;
    }
  })();
  const diagnostics = createDiagnosticsSink({
    // The user's OWN parked credentials — an install with nobody signed in
    // reports nothing rather than borrowing an unrelated share's token.
    resolveTarget: () => {
      const credentials = store.getAgentCredentials();
      if (!credentials?.token) return null;
      const origin = String(credentials.apiOrigin || diagnosticsOrigin || '').trim().replace(/\/$/, '');
      return origin ? { origin, token: credentials.token } : null;
    },
    isEnabled: () => store.diagnosticsEnabled(),
    redactionPaths: () => [
      os.homedir(),
      ...store.listProjects().flatMap((project) => [
        project.root,
        ...store.listExtraRoots(project.id).map((row) => row.root),
      ]),
    ],
    envelope: () => ({
      installId,
      bundleHash: loadedBundleHash,
      apiVersion: SIDECAR_API_VERSION,
      remoteOrigin: diagnosticsOrigin || null,
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      supervised: process.argv.includes('--supervised'),
    }),
  });
  {
    const baseLog = log;
    log = (message) => {
      baseLog(message);
      diagnostics.observe(message);
    };
  }
  const watchers = new Map(); // projectId -> ProjectWatcher
  const sseClients = new Map(); // projectId -> Set<res>

  // Which local engines this machine has, and what that means for new chats.
  // Memoized: the probe shells out to `which` when no binary sits at a known
  // path, and every new chat asks. A user-facing read (GET /local-engines)
  // refreshes it, so a fresh `claude login` shows up on the next workspace
  // load rather than after a TTL.
  let engineProbe = { at: 0, value: null };
  let detectedHarness = 'vercel';
  const detectLocalEngines = async ({ fresh = false } = {}) => {
    if (!fresh && engineProbe.value && Date.now() - engineProbe.at < 10_000) return engineProbe.value;
    const [{ detectClaudeEngine }, { detectCodexEngine }] = await Promise.all([
      import('./agent/claude-runner.mjs'),
      import('./agent/codex-runner.mjs'),
    ]);
    const pick = ({ available, loggedIn }) => ({ available, loggedIn });
    engineProbe = { at: Date.now(), value: { claude: pick(detectClaudeEngine()), codex: pick(detectCodexEngine()) } };
    detectedHarness = resolveDefaultHarness(engineProbe.value);
    return engineProbe.value;
  };
  /** The engine a new chat runs on: an explicit pick wins forever, otherwise
   *  whichever local engine is already set up here (there is no upfront
   *  chooser — the composer chip shows the answer and can change it). Sync:
   *  detection is primed below before anything serves, so the run path can
   *  just read it. */
  const installDefaultHarness = () => store.getSetting('default_harness') || detectedHarness;
  /** The engine a RUN uses, AND the model to run it with. A chat with no
   *  engine of its own resolves to the install default at run time and is
   *  stamped then: an unused chat keeps following detection (a CLI installed —
   *  or logged out of — after it was created), instead of freezing on whatever
   *  was around that day. The stamp coerces the model to one that engine can
   *  run, so it rides back here: the caller's `chat` row predates the write,
   *  and starting the turn on its stale model would run a Codex chat on an
   *  Anthropic model (or on none at all) while the row and the chip say
   *  otherwise. */
  const runHarness = (chat) => {
    if (chat.harness === 'vercel' || chat.harness === 'claude' || chat.harness === 'openai') {
      return { harness: chat.harness, model: chat.model };
    }
    // A conversation that predates stamping carries NULL with messages already
    // in it, and it ran on the cloud agent — adopting a detected local engine
    // now would switch engines mid-conversation on the next send (and the
    // client's own gate still reads such a chat as cloud). Same rule
    // store.adoptDefaultHarness() uses: only EMPTY chats follow the default.
    // The count is the caller's snapshot, taken before this turn's row was
    // appended, so a brand-new chat still reads as empty here.
    if (Number(chat.message_count ?? 0) > 0) {
      store.updateChat(chat.id, { harness: 'vercel' });
      return { harness: 'vercel', model: chat.model };
    }
    const harness = installDefaultHarness();
    const model = coerceModelForHarness(harness, chat.model);
    store.updateChat(chat.id, { harness, model });
    return { harness, model };
  };
  // Primed BEFORE anything can serve: the first run reads the default
  // synchronously, and a boot race would run cloud Sunny on a machine that has
  // Claude Code. Costs a few stat calls (and at worst one `which`).
  await detectLocalEngines().catch(() => {});

  // Per-install token, readable only by this user. Env override for tests/dev.
  const tokenPath = path.join(home, 'token');
  let token = (process.env.SUNDIAL_LOCAL_TOKEN || '').trim();
  if (!token) {
    try {
      token = fs.readFileSync(tokenPath, 'utf8').trim();
    } catch {
      token = randomBytes(24).toString('base64url');
      fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    }
  }

  const verifyToken = (candidate) => {
    if (typeof candidate !== 'string' || !candidate) return null;
    return candidate === token ? { actor: 'user', userId: 'local' } : null;
  };

  const emit = (projectId, event) => {
    const clients = sseClients.get(projectId);
    if (!clients) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(payload);
  };
  // Install-wide events (credential changes) reach every open project stream.
  const broadcast = (event) => {
    for (const projectId of sseClients.keys()) emit(projectId, event);
  };

  const docHost = new DocHost({ store, verifyToken, watchers, log });
  const agentHost = new LocalAgentHost({
    store,
    docHost,
    log,
    onCommentsChanged: (projectId, path) => emit(projectId, { type: 'comments-changed', path }),
  });
  // Agent-attributed ledger rows join the turn that made them — every rail
  // already carries the chat id, so this one hook keys them all by assistant
  // message id (what the chat's diff chip is fetched by).
  store.setTurnResolver((chatId) => agentHost.turnMessageId(chatId));
  const bridges = new SyncBridgeManager({
    store,
    docHost,
    log,
    // Which cloud this install talks to. Shares recorded against a DIFFERENT
    // origin are unreachable from here (see isForeignShare). Read lazily —
    // remoteOrigin is declared with the proxy, further down this function.
    remoteOrigin: () => remoteOrigin,
    emitFilesChanged: (projectId, path) => emit(projectId, { type: 'files-changed', path }),
    emitSharesChanged: (projectId) => emit(projectId, { type: 'shares-changed' }),
    emitCommentsChanged: (projectId) => emit(projectId, { type: 'comments-changed' }),
  });
  // Comment tools reach share-covered (cloud-mirrored) threads through the
  // bridges; set post-construction because the host is built first.
  agentHost.bridges = bridges;
  // A comment-triggered run that FAILS (model/credential error after
  // registration) would strand its delivery: the trigger reported handled,
  // the poll advanced, and delivery_started dedupes replays. One bounded
  // retry per chat re-starts it; success clears the counter; the failed turn
  // stays visible either way.
  // Mirrors rowsToModelMessages' cap in agent/runner.mjs — a delivery older
  // than this can never be read by a turn, so it can never be "served".
  const MODEL_HISTORY_WINDOW_ROWS = 300;
  const commentRunRetries = new Map();
  // Chats with a comment retry in flight: the LAST attempt speaks on the thread
  // (an early failure posted there would suppress the retry's real answer).
  const commentRetryPending = new Set();
  // What each in-flight turn will answer, captured at ITS start: a comment
  // that arrives mid-turn parks behind it and belongs to the NEXT run, so
  // completing this one must not mark it served.
  const runDeliverySnapshots = new Map();
  // The same capture keyed for answerSilentThreads: which THREAD each delivery
  // came from, and the comment it carries. `drop` removes the rows a turn held
  // OUT of its model context (deferred guest comments) — speaking for those
  // would publish a member turn's words onto a guest-readable thread.
  const runCommentThreads = new Map();
  const dropFromThreadAnswer = (chatId, ids) =>
    runCommentThreads.set(chatId, (runCommentThreads.get(chatId) ?? []).filter((row) => !ids?.includes(row.id)));
  agentHost.onRunStarted = (chatId) => {
    try {
      // Only what this turn can actually READ: rowsToModelMessages windows the
      // history, so an older delivery must not be marked served by it. Rows
      // past the window can never reach any model — stamp them terminal
      // (loudly) instead of leaving them to restart a doomed turn forever.
      const { visible, unreachable } = store.unservedCommentDeliveriesByVisibility(chatId, MODEL_HISTORY_WINDOW_ROWS);
      for (const row of unreachable) {
        log(`comment delivery is outside the model history window; marking served chat=${chatId} message=${row.id}`);
        store.mergeMessageMetadata(row.project_id, row.id, { delivery_served: true });
      }
      runDeliverySnapshots.set(chatId, visible.map((row) => row.id));
      // What this turn owes an ANSWER ON THE THREAD (see answerSilentThreads).
      // Its own map because onRunFailed drops the snapshot above, and a failed
      // turn is exactly the one whose thread must still hear something.
      runCommentThreads.set(chatId, visible.filter((row) => row.comment_thread_id));
    } catch {
      /* shutdown race */
    }
  };
  agentHost.onRunSucceeded = (chatId) => {
    commentRunRetries.delete(chatId);
    commentRetryPending.delete(chatId);
    // A run can hold guest deliveries OUT of its context (deferred behind a
    // member's own ask) — those were never answered, so they stay unserved
    // and a follow-up run takes them now that the member's ask sits answered
    // behind an assistant row (that turn reads as a sanitized guest turn).
    const deferred = agentHost.deliveryUnservedOverride.get(chatId) ?? [];
    agentHost.deliveryUnservedOverride.delete(chatId);
    dropFromThreadAnswer(chatId, deferred);
    const snapshot = runDeliverySnapshots.get(chatId) ?? [];
    runDeliverySnapshots.delete(chatId);
    const served = deferred.length ? snapshot.filter((id) => !deferred.includes(id)) : snapshot;
    if (served.length === 0 && deferred.length === 0) return;
    try {
      const chat = store.getChat(chatId);
      if (!chat) return;
      if (served.length) store.markCommentDeliveriesServed(chat.project_id, served);
      if (deferred.length && store.hasUnservedCommentDelivery(chatId)) {
        const project = store.getProject(chat.project_id);
        if (project) startCommentRun(project, chat);
      }
    } catch {
      /* shutdown race */
    }
  };
  agentHost.onRunFailed = (chatId) => {
    // Nothing was served — the snapshot is void; recovery re-reads the store.
    runDeliverySnapshots.delete(chatId);
    dropFromThreadAnswer(chatId, agentHost.deliveryUnservedOverride.get(chatId));
    agentHost.deliveryUnservedOverride.delete(chatId);
    let chat;
    try {
      chat = store.getChat(chatId);
    } catch {
      return; // shutdown race — nothing to retry into
    }
    if (!chat) return;
    // Any unserved delivery in this chat is this run's responsibility — a
    // comment run replaced by an ordinary send transfers the obligation, so
    // inspecting only the newest user row would drop it.
    if (!store.hasUnservedCommentDelivery(chatId)) return;
    const attempts = commentRunRetries.get(chatId) ?? 0;
    if (attempts >= 2) {
      log(`comment run retries exhausted chat=${chatId}`);
      return;
    }
    const attempt = attempts + 1;
    commentRunRetries.set(chatId, attempt);
    const project = store.getProject(chat.project_id);
    if (!project) return;
    commentRetryPending.add(chatId);
    setTimeout(() => {
      commentRetryPending.delete(chatId);
      try {
        // A successor already has the chat (the failed run's finally flushed
        // the parked comment, or a newer turn started): it reads our delivery
        // from history, so starting again would duplicate the turn.
        if (agentHost.isBusy?.(chatId)) return;
        // Stale timer: an intervening SUCCESS cleared the counter, or a newer
        // failure bumped it and scheduled its own retry.
        if (commentRunRetries.get(chatId) !== attempt) return;
        const liveChat = store.getChat(chatId);
        if (liveChat) startCommentRun(project, liveChat);
      } catch {
        /* shutdown race */
      }
    }, 3_000);
  };
  // Crash recovery: a delivery whose run died with the process (or never
  // started) is otherwise dedupe-suppressed forever — nothing re-observes it
  // (the bridge cursor already advanced). A served turn always leaves an
  // assistant row, so "last message is a comment delivery" IS the unserved
  // set. Bounded to the last 24h, to PRE-BOOT rows (a delivery arriving
  // after boot is owned by its live trigger — deliverComment, or the next
  // send it parks behind — and sweeping it starts a second run mid-flight),
  // and to one start per chat.
  const bootedAt = new Date().toISOString();
  const sweepUnservedComments = () => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      // ONE run per chat: the first turn reads the whole history and answers
      // every delivery pending in it, so a second start would just re-answer
      // them (it would park behind the first and then repeat it).
      const seenChats = new Set();
      for (const row of store.listUnservedCommentDeliveries(since)) {
        if (row.created_at >= bootedAt) continue;
        if (seenChats.has(row.chat_id)) continue;
        seenChats.add(row.chat_id);
        const chat = store.getChat(row.chat_id);
        const project = chat && store.getProject(chat.project_id);
        if (!project) continue;
        if (startCommentRun(project, chat)) {
          // Stamp EVERY delivery this run covers as started: a cloud-backed
          // one whose cursor never advanced will be replayed by the bridge,
          // and an unstamped row would pass deliverComment's guard and start
          // a second run for work this recovery already owns.
          for (const id of store.unservedCommentDeliveryIds(chat.id)) {
            store.mergeMessageMetadata(project.id, id, { delivery_started: true });
          }
          log(`comment delivery recovered chat=${chat.id} message=${row.id}`);
        }
      }
    } catch (error) {
      log(`comment sweep failed error=${error?.message}`);
    }
  };
  setTimeout(sweepUnservedComments, 2_000).unref?.();

  // A parked (queued) run starting is invisible otherwise — nudge the client
  // so the open transcript reattaches to the new stream.
  agentHost.onQueuedStart = (project, chatId) => emit(project.id, { type: 'chats-changed', chatId });

  /** Post an agent-authored reply on a comment thread, local or cloud-mirrored
   *  (the same two stores reply_comment writes to). Never throws. */
  const postAgentThreadReply = async (projectId, threadId, body) => {
    const local = store.getCommentThread(threadId);
    if (local && local.projectId === projectId) {
      if (local.status !== 'open') return false;
      store.addCommentMessage(threadId, { body, author: SUNNY_AUTHOR });
      emit(projectId, { type: 'comments-changed', path: local.filePath });
      return true;
    }
    const remote = await bridges.findCloudCommentThread(projectId, threadId).catch(() => null);
    if (!remote || remote.thread.status !== 'open') return false;
    await remote.engine.mutateCloudComment('PATCH', {
      threadId, filePath: remote.thread.filePath, action: 'reply', body, author: SUNNY_AUTHOR,
    });
    emit(projectId, { type: 'comments-changed', path: remote.thread.filePath });
    return true;
  };

  /** The turn's own last word: its terminal error, else its closing text. */
  const REPLY_CLIP = 700;
  const turnOutcomeText = (projectId, chatId) => {
    const rows = store.listChatMessages(projectId, chatId);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.role === 'user') break; // nothing after the delivery — silent turn
      if (row.role !== 'assistant') continue;
      const text = String(row.metadata?.run_error || row.content || '').trim();
      if (text) return text.length <= REPLY_CLIP ? text : `${text.slice(0, REPLY_CLIP - 1).trimEnd()}…`;
    }
    return null;
  };

  /** The comment thread is the ONLY surface the commenter is looking at — its
   *  chat is minted behind the card and never opened. A turn that ends without
   *  replying there (it failed on the engine, or the engine can only answer in
   *  chat, like Codex) reads as "the agent did nothing", which is exactly how
   *  the starter doc's first-run flow died. Speak the turn's outcome on the
   *  thread for every delivery that got no answer of its own. */
  const answerSilentThreads = async (chatId) => {
    const deliveries = runCommentThreads.get(chatId) ?? [];
    // Retire the obligation only once the replies below have actually landed:
    // /chats reports `answering` off this map, and a cloud-mirrored thread is
    // answered behind an await, so dropping it up front cleared the badge
    // while the thread was still silent — the very gap this covers. Identity-
    // checked so a NEXT run's freshly snapshotted obligation is never deleted
    // by this one unwinding late.
    const retire = () => {
      if (runCommentThreads.get(chatId) !== deliveries) return;
      runCommentThreads.delete(chatId);
      // Clearing `answering` is itself the thing clients are waiting to see,
      // and the paths that reach here WITHOUT posting a reply (thread gone or
      // closed, cloud write failed) emit nothing of their own — the run's own
      // chats-changed already fired, before this. Without a nudge here the
      // badge waits on a refresh that never comes.
      try {
        const row = store.getChat(chatId);
        if (row) emit(row.project_id, { type: 'chats-changed', chatId });
      } catch {
        /* shutdown race: the store can already be closed */
      }
    };
    if (!deliveries.length) return retire();
    const chat = store.getChat(chatId);
    if (!chat) return retire();
    // A turn that produced no row at all still owes the thread a word: silence
    // here is the whole bug, so there is no path out of this that says nothing.
    const text =
      turnOutcomeText(chat.project_id, chatId) ??
      'The agent finished this turn without an answer. Open the chat to see what happened.';
    // Answered means "an agent message sits after THIS comment" (the delivery's
    // clientId is `comment:<message id>`), not "the agent had the last word": a
    // human reply landing mid-turn would otherwise read as unanswered and get
    // this turn's outcome repeated under it.
    const answered = (thread, delivery) => {
      const at = thread.messages.findIndex((m) => `comment:${m.id}` === delivery.client_id);
      return thread.messages.slice(at + 1).some((m) => isAgentAuthor(m.author));
    };
    const spoken = new Set();
    try {
      for (const delivery of deliveries) {
        const threadId = delivery.comment_thread_id;
        if (spoken.has(threadId)) continue;
        try {
          const thread =
            store.getCommentThread(threadId) ??
            (await bridges.findCloudCommentThread(chat.project_id, threadId).catch(() => null))?.thread;
          if (!thread || answered(thread, delivery)) continue;
          if (!(await postAgentThreadReply(chat.project_id, threadId, text))) continue;
          spoken.add(threadId);
          // Answered, terminal error included — retire it, or the crash sweep
          // re-runs the same doomed turn on every restart for 24h.
          store.markCommentDeliveriesServed(chat.project_id, [delivery.id]);
        } catch (error) {
          log(`thread fallback reply failed thread=${threadId} error=${error?.message}`);
        }
      }
    } finally {
      retire();
    }
  };

  // Symmetric finish signal: the panel refetches and clears "Agent is working"
  // even when the engine answered only in the chat (no thread reply).
  agentHost.onRunFinished = (chatId, { superseded = false, aborted = false } = {}) => {
    try {
      const chat = store.getChat(chatId);
      if (chat) emit(chat.project_id, { type: 'chats-changed', chatId });
      // A superseded run's obligations moved to its replacement (which
      // re-snapshotted them at ITS start); a stopped one is the user's call.
      if (superseded) return;
      if (aborted || commentRetryPending.has(chatId)) runCommentThreads.delete(chatId);
      else void answerSilentThreads(chatId).catch(() => {});
    } catch {
      /* shutdown race: the store can already be closed when a run unwinds */
    }
  };
  // A link GUEST's comment reaches the cloud store directly — the bridge poll
  // observes it and routes it through the same trigger the owner's own posts
  // take (agent authors are gated out there; clientId dedup absorbs re-observes).
  bridges.onCloudCommentMessage = (projectId, { thread, message, isNewThread }) => {
    const project = store.getProject(projectId);
    if (!project) return true; // project removed — nothing to retry into
    return triggerCommentAgents({
      project,
      thread: {
        id: thread.id,
        chatId: thread.chatId ?? store.getCommentThreadChatLink(thread.id),
        filePath: thread.filePath,
        quote: thread.quote,
      },
      messageId: message.id,
      body: message.body,
      author: message.author,
      isNewThread,
      // Anyone can reach the cloud store via the share link; the poll cannot
      // tell members from guests, so nothing it observes may start a run
      // outside the owner's explicit watcher opt-in.
      untrusted: true,
    });
  };
  // ---- Comments → agent runs (the local twin of lib/workspace/comment-trigger)
  // Mode A: a thread gets its own chat once someone @sunny's it, and every
  // later reply on that thread lands there. Mode B: chats that called
  // listen_comments receive every human comment on the path they watch.

  /** `@sunny` as a whole word — never inside an email or a longer word. */
  const SUNNY_MENTION_RE = /(^|\W)@(sunny|agent|claude|codex)\b/i;
  /** Agent-written comments (Sunny's own reply_comment/add_comment) must never
   *  re-trigger a run. Locally they carry `agent:`/`ai:` ids; CLOUD Sunny rows
   *  (mirrored threads) carry the sunny UUID with username 'sunny', so gate on
   *  that too — the same own-filter the /events long-poll uses. */
  const isAgentAuthor = (author) => /^(agent|ai):/.test(author?.userId ?? '') || author?.username === 'sunny';
  const isHumanComment = (author) => typeof author?.userId === 'string' && !isAgentAuthor(author);
  /** Thread-chat title quote — clipCommentQuote(quote, 60) without the lib/ import. */
  const clipTitleQuote = (text) => {
    const quote = text.replace(/\s+/g, ' ').trim();
    return quote.length <= 60 ? quote : `${quote.slice(0, 59).trimEnd()}…`;
  };

  const commentMessage = ({ thread, body, authorName, isNewThread, isThreadChat, firstThreadDelivery, canComment }) => {
    const lines = [
      `[${isNewThread ? 'Comment' : 'Reply'} on ${thread.filePath}] ${authorName?.trim() || 'Someone'} ` +
        `(thread ${thread.id}, quoted: "${thread.quote}"):`,
      body,
    ];
    // A thread chat past its FIRST DELIVERY already carries the instruction —
    // keyed off the chat being minted by this comment, not off thread age, so
    // a first @sunny on a reply to an old thread still gets it.
    if (!isThreadChat || firstThreadDelivery) {
      lines.push(
        '',
        canComment
          ? 'Address this comment: make the requested changes (they land as suggestions for review), then post a brief reply on the thread with reply_comment (thread_id above) — a sentence or two, no recap. Do NOT resolve the thread; the commenter closes it after reviewing.'
          : 'Address this comment: make the requested changes (they land as suggestions for review), then close with your reply to the commenter — a sentence or two, no recap. Your closing message is posted verbatim on the thread, so write it for the commenter, not as a chat summary.',
      );
    }
    return lines.join('\n');
  };

  const deliverComment = ({ project, thread, chatId, messageId, body, author, isNewThread, isThreadChat, firstThreadDelivery, untrusted = false }) => {
    const chat = store.getChat(chatId);
    if (!chat) return;
    const { harness } = runHarness(chat);
    // The Codex engine runs its own native toolset — no Sundial comment tools,
    // so its closing message is what answerSilentThreads posts on the thread.
    // The instruction has to say so, or the model writes a chat-shaped recap
    // and the commenter reads that as the reply.
    const content = commentMessage({ thread, body, authorName: author?.name, isNewThread, isThreadChat, firstThreadDelivery, canComment: harness !== 'openai' });
    const clientId = `comment:${messageId}`;
    // Dedupe is per-chat (the same comment fans out to several chats), and it
    // also makes a retried POST idempotent — but only once a run was actually
    // STARTED for the row (delivery_started). A crash between the SQLite
    // insert and startOrQueue leaves the row unserved; the retry re-starts it.
    const existing = store.findChatMessageByClientId(chatId, clientId);
    if (existing?.metadata?.delivery_started) return;
    const row =
      existing ??
      store.appendChatMessage(project.id, chatId, {
        role: 'user',
        content,
        clientId,
        metadata: {
          source: 'comment',
          author_user_id: author?.userId ?? null,
          comment_thread_id: thread.id,
          // Structured copy for the transcript's event card (mirrors the cloud trigger).
          comment: {
            thread_id: thread.id,
            file_path: thread.filePath,
            quote: thread.quote,
            author_name: author?.name ?? null,
            body,
            is_new_thread: isNewThread,
            // Link-guest author: the runner shrinks this turn's toolset to
            // the comment-safe allow-list (mirrors the cloud trigger).
            ...(untrusted ? { untrusted_author: true } : {}),
          },
        },
      });
    if (!existing) emit(project.id, { type: 'chats-changed', chatId });
    // Not signed in: the comment still lands in the chat (visible, and it runs
    // on the next send) — starting would only fail the turn.
    if (!startCommentRun(project, chat)) return;
    // Stamped AFTER the run is registered/parked — a crash before this line
    // leaves the row unserved and the next retry re-starts it.
    store.mergeMessageMetadata(project.id, row.id, { delivery_started: true });
  };

  // startOrQueue, not start: a burst of comments must queue behind the
  // in-flight turn instead of cancel-and-replacing it. Always suggest: the
  // commenter wants granular review (mirrors the cloud trigger). Shared by
  // first delivery and the bounded failure retry below.
  const startCommentRun = (project, chat) => {
    const { harness, model } = runHarness(chat);
    const credentials = harness === 'vercel' ? store.getAgentCredentials() : null;
    if (harness === 'vercel' && !credentials) return false;
    agentHost.startOrQueue({
      project,
      chatId: chat.id,
      model,
      harness,
      credentials,
      editMode: 'suggest',
      writeText: createAgentWriter({
        project, docHost, watchers, bridges, emit, chatId: chat.id, editMode: 'suggest',
        authorId: engineAuthorId(harness),
      }),
    });
    return true;
  };

  /** Route a freshly-posted HUMAN comment to the agents that should react.
   *  Never throws — the comment itself is already saved. `untrusted` authors
   *  (bridge-observed link guests — anyone with the public share URL) can
   *  never START runs on the owner's machine: no mention-minting, no linked
   *  thread chat; only watcher chats, which the owner explicitly subscribed. */
  // Returns whether the comment was HANDLED — false means a transient failure
  // the caller should retry (clientId dedupe makes replays safe).
  const triggerCommentAgents = ({ project, thread, messageId, body, author, isNewThread, untrusted = false }) => {
    try {
      if (!isHumanComment(author)) return true;
      // Twin of the cloud guard (lib/workspace/comment-trigger.ts): a NEW
      // thread whose only message is one emoji is a REACTION, not an ask —
      // never hand it to an agent, or every 👍 on a watched doc queues a run.
      // Replies (isNewThread false) stay ordinary discussion and still deliver.
      if (isNewThread && isSingleEmoji(body)) return true;
      let threadChatId = untrusted ? null : thread.chatId;
      // A share-covered thread can carry a CLOUD chat id (minted by cloud
      // Sunny) — it can't host a local run, and treating it as claimed would
      // black-hole the delivery. Fall back to the local link (or mint/watchers).
      if (threadChatId && store.getChat(threadChatId)?.project_id !== project.id) {
        threadChatId = store.getCommentThreadChatLink(thread.id);
      }
      let mintedNow = false;
      if (!untrusted && !threadChatId && SUNNY_MENTION_RE.test(body)) {
        mintedNow = true;
        const harness = store.getSetting('default_harness');
        const chat = store.createChat(project.id, {
          title: `💬 ${clipTitleQuote(thread.quote)}`,
          model: coerceModelForHarness(harness, null),
          harness,
        });
        store.setCommentThreadChat(thread.id, chat.id);
        threadChatId = chat.id;
      }
      // A thread chat CLAIMS its comment — watchers only handle unclaimed ones,
      // else the same ask runs twice (duplicate suggestions + thread replies).
      const targets = threadChatId
        ? [{ chatId: threadChatId, isThreadChat: true, firstThreadDelivery: mintedNow }]
        : store
            .listCommentWatchChats(project.id)
            // The file id is AUTHORITATIVE when the watch carries one: it
            // follows renames and is retired on delete, so a new file at a
            // reused path can't inherit the subscription. Path-only watches
            // (legacy rows, deleted files) still match by path.
            .filter((chat) =>
              chat.comment_watch_path === '*'
                ? true
                : chat.comment_watch_file_id
                  ? chat.comment_watch_file_id === store.knownFileId(project.id, thread.filePath)
                  : chat.comment_watch_path === thread.filePath,
            )
            .map((chat) => ({ chatId: chat.id, isThreadChat: false, firstThreadDelivery: false }));
      for (const target of targets) {
        deliverComment({ project, thread, messageId, body, author, isNewThread, untrusted, ...target });
      }
      return true;
    } catch (error) {
      log(`comment trigger failed thread=${thread?.id} error=${error?.message}`);
      return false;
    }
  };

  docHost.onEditorConnected = (projectId, rel) => bridges.handleLocalDocOpened(projectId, rel);
  docHost.onRemotePersist = (projectId, rel, { remoteOnly } = {}) => {
    if (remoteOnly) bridges.handleRemotePersist(projectId, rel);
    emit(projectId, { type: 'files-changed', path: rel });
  };
  // Internal deletes (a rejected suggested creation) happen with the watcher
  // suppressed — propagate them like watcher deletes.
  docHost.onFileRemoved = (projectId, rel) => {
    void bridges
      .handleLocalFileEvent(projectId, rel)
      .catch((error) => log(`bridge delete failed path=${logPath(rel)} error=${error?.message}`));
    emit(projectId, { type: 'files-changed', path: rel });
  };

  // One change handler per project, shared by every root's watcher — `rel` is
  // the VIRTUAL project path (extra-root events arrive prefix-qualified).
  // Returns its work so ProjectWatcher.settle() can wait for the LEDGER ROW,
  // not just for the debounce to fire (the diff chip counts a turn's edits the
  // moment a natively-editing engine exits).
  const onWatcherChange = (project) => (rel, suppressed) => {
      return (async () => {
      // Text files sync through the doc host; kind===null covers FOLDER
      // events (deletes/renames arrive as one event for the folder path) —
      // the doc host stat-disambiguates. Blob changes skip the doc host but
      // still reach the bridges (sha-diffed blob sync).
      const kind = fileKind(rel);
      if (kind === null) {
        // Untracked kinds matter only as folder events: an existing directory
        // (create/rename destination, or a tree delete that preserved it), or
        // a vanished path with tracked rows beneath it (folder delete
        // cascade). Everything else is churn — cache files, build junk — and
        // on a huge project root (a whole home dir) forwarding it hammers the
        // doc host, the DB, and the UI's refetch loop. Skip it entirely.
        const loc = locateRel(projectRoots(store, project), rel);
        const stat = await fsp.stat(path.join(loc.root, loc.rel)).catch(() => null);
        if (stat && !stat.isDirectory()) return;
        if (!stat && !store.hasTraceUnder(project.id, rel)) return;
      }
      if (kind !== 'blob') {
        // Inside a Bash tool call's window, disk changes belong to the run
        // (Bash bypasses the agent writer) — otherwise 'external'.
        const attribution = agentHost.bashAttribution(project.id);
        // Awaited below: once this resolves the ledger row exists. The bridge
        // fan-out that follows stays fire-and-forget — a cloud round-trip must
        // not hold up the turn's own bookkeeping.
        const applied = docHost.handleDiskChange(project.id, rel, {
          record: !suppressed,
          fromWatcher: true,
          ...(attribution ?? {}),
        });
        void applied
          .then((outcome) => {
            // A swallowed stale delete echo must NOT reach the bridges (they
            // would read the still-absent path as a live local delete and
            // remove the collaborator's new cloud file); a suppressed event
            // that proved REAL still syncs + announces.
            if (outcome === 'stale-delete') return undefined;
            if (suppressed && outcome !== 'mutated') return undefined;
            if (suppressed) emit(project.id, { type: 'files-changed', path: rel });
            return bridges.handleLocalFileEvent(project.id, rel);
          })
          .catch((error) => log(`disk change failed path=${logPath(rel)} error=${error?.message}`));
        await applied.catch(() => {});
      } else if (!suppressed) {
        void bridges
          .handleLocalFileEvent(project.id, rel)
          .catch((error) => log(`blob change failed path=${logPath(rel)} error=${error?.message}`));
      }
      if (!suppressed) emit(project.id, { type: 'files-changed', path: rel });
      })().catch((error) => log(`disk change failed path=${logPath(rel)} error=${error?.message}`));
  };

  const ensureWatcher = (project) => {
    if (watchers.has(project.id)) return;
    const set = new RootWatchers();
    const onChange = onWatcherChange(project);
    for (const entry of projectRoots(store, project)) {
      try {
        set.attach(entry.prefix, entry.root, onChange);
      } catch (error) {
        // A vanished EXTRA root must not take the primary watcher down with it.
        if (!entry.prefix) throw error;
        log(`watcher failed root=${logPath(entry.root)} error=${error?.message}`);
      }
    }
    watchers.set(project.id, set);
  };

  // Live-edit horizon for resume's offline-delete reconciliation: anything
  // written from HERE on happens with watchers active — but engines register
  // only after listen(), so those events are dropped and the write's mtime is
  // its only trace. Stamping at bind time instead would misread such a write
  // as an offline edit and let reconciliation delete it.
  const watchersActiveAt = Date.now();
  for (const project of store.listProjects()) {
    try {
      ensureWatcher(project);
    } catch (error) {
      log(`watcher failed project root=${logPath(project.root)} error=${error?.message}`);
    }
  }
  // Bridge resumption re-auths every cloud-shared doc over the network —
  // seconds per install with real shares. It must NOT gate the port bind
  // (below): the desktop shell waits ~10s for the port before creating its
  // window, and a slow resume left the webview on a dead port (blank app).
  // Kicked off after listen() succeeds instead.

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req) => {
    // Accumulate BYTES and decode once: per-chunk decoding corrupts any UTF-8
    // code point that Node happens to split across chunk boundaries (U+FFFD
    // in saved file content).
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 20_000_000) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('invalid json'), { status: 400 });
    }
  };

  // Header-less browser contexts are the only places the token may ride the
  // URL: EventSource and media/file loads can't set Authorization. Everywhere
  // else it stays out of URLs, where it would land in logs, devtools traces
  // and copy-pasted links.
  const QUERY_TOKEN_PATHS = /^\/projects\/[^/]+\/(events|file)$/;
  const authed = (req) => {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const url = new URL(req.url || '/', 'http://localhost');
    const query =
      req.method === 'GET' && QUERY_TOKEN_PATHS.test(url.pathname) ? url.searchParams.get('token') : null;
    return verifyToken(match?.[1]?.trim() || query || '');
  };

  // ---- Remote UI proxy (packaged desktop app) -----------------------------
  // The shell loads the web app THROUGH the sidecar, so the webview origin is
  // plain-http loopback: WKWebView's mixed-content wall (an https page may
  // not fetch http://127.0.0.1) never applies, and the sidecar API + collab
  // socket are same-origin with the page. Enabled only when the shell sets
  // SUNDIAL_REMOTE_ORIGIN; the repo dev flow (localhost:3000) is unaffected.
  const remoteOrigin = (process.env.SUNDIAL_REMOTE_ORIGIN || '').trim().replace(/\/$/, '');
  let boundPort = port;
  const localOrigin = () => `http://127.0.0.1:${boundPort}`;

  /** Keep the webview on the proxy origin: remote-origin redirects become
   *  paths, and OAuth-style bounces (Clerk handshake) that would return to
   *  the remote origin are rewritten to return here instead. */
  const rewriteLocation = (value) => {
    if (value.startsWith(remoteOrigin)) return value.slice(remoteOrigin.length) || '/';
    try {
      const parsed = new URL(value);
      const back = parsed.searchParams.get('redirect_url');
      if (back?.startsWith(remoteOrigin)) {
        parsed.searchParams.set('redirect_url', localOrigin() + back.slice(remoteOrigin.length));
        return parsed.toString();
      }
    } catch { /* relative or opaque — leave as-is */ }
    return value;
  };

  /** Cookies arrive scoped for the remote host; re-scope them to the loopback
   *  origin the webview actually runs on (drop Domain, drop Secure — and
   *  SameSite=None requires Secure, so it becomes Lax; all traffic is
   *  same-origin through the proxy anyway). */
  const rewriteSetCookie = (value) =>
    value
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && !/^domain=/i.test(part) && !/^secure$/i.test(part) && !/^partitioned$/i.test(part))
      .map((part) => (/^samesite=none$/i.test(part) ? 'SameSite=Lax' : part))
      .join('; ');

  /** Offline fallback for document navigations the proxy can't reach: a raw
   *  JSON 502 rendered as the page reads as a crash. Local projects are fully
   *  offline-capable (static UI + this sidecar), so point the user there and
   *  auto-recover when the connection returns. */
  const offlinePage = (req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sundial</title><style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font: 15px/1.5 -apple-system, system-ui, sans-serif; background: #fff; color: #1a1a1a; }
  main { text-align: center; padding: 2rem; max-width: 24rem; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0 0 1.5rem; opacity: 0.6; }
  a, button { display: inline-block; font: inherit; text-decoration: none; cursor: pointer; border-radius: 8px; padding: 0.5rem 1rem; margin: 0 0.25rem; border: 1px solid rgba(128, 128, 128, 0.35); background: transparent; color: inherit; }
  a.primary { background: #1a1a1a; border-color: #1a1a1a; color: #fff; }
  @media (prefers-color-scheme: dark) { body { background: #23201d; color: #efece8; } a.primary { background: #efece8; border-color: #efece8; color: #23201d; } }
</style></head><body><main>
  <h1>No internet connection</h1>
  <p>This page needs the internet. Your local projects keep working offline.</p>
  ${uiDir ? '<a class="primary" href="/local">Open local projects</a>' : ''}
  <button onclick="location.reload()">Try again</button>
  <script>
    const probe = async () => {
      try {
        const r = await fetch(location.pathname + location.search, { cache: 'no-store' });
        if (r.status < 500) location.reload();
      } catch { /* still offline */ }
    };
    addEventListener('online', probe);
    setInterval(probe, 5000);
  </script>
</main></body></html>`);
  };

  const HOP_BY_HOP = new Set(['host', 'connection', 'upgrade', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'content-length', 'accept-encoding']);
  const proxyRemote = async (req, res, url) => {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key) && typeof value === 'string') headers[key] = value;
    }
    // The trust cookie is a LOCAL secret (it gates bearer injection below) —
    // it must never reach the remote origin or its access logs. Forward the
    // rest of the cookie jar untouched.
    const cookies = String(req.headers.cookie || '').split(/;\s*/).filter(Boolean);
    const forwarded = cookies.filter((pair) => !pair.startsWith('sundial_local='));
    if (forwarded.length !== cookies.length) {
      if (forwarded.length) headers.cookie = forwarded.join('; ');
      else delete headers.cookie;
    }
    // Signed-in cloud calls without Clerk in the webview: attach the parked
    // sd_ token to /api/* forwards. Gated on the per-install cookie (set by
    // /boot) so another local process can't ride the user's session by
    // hitting the proxy port.
    const trusted = cookies.includes(`sundial_local=${token}`);
    const credentials = store.getAgentCredentials();
    const injectedAuth = Boolean(
      trusted && credentials && url.pathname.startsWith('/api/') && !headers.authorization,
    );
    if (injectedAuth) headers.authorization = `Bearer ${credentials.token}`;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const response = await fetch(`${remoteOrigin}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      redirect: 'manual',
      ...(hasBody ? { body: req, duplex: 'half' } : {}),
    }).catch((error) => {
      // Document navigations get a human page (a JSON body rendered as the
      // whole window reads as a crash); programmatic fetches keep the shape.
      if (['GET', 'HEAD'].includes(req.method) && String(req.headers.accept || '').includes('text/html')) offlinePage(req, res);
      else json(res, 502, { ok: false, error: `remote unreachable: ${error?.message}` });
      return null;
    });
    if (!response) return;
    // The cloud rejecting OUR injected token means it expired or was revoked
    // — clear it so "credentials configured" stops reading as signed in and
    // the client's send gate reopens browser sign-in (mirrors the local-step
    // runner's 401 handling). Only when the body names the bearer: sd_-aware
    // routes answer 'Invalid token' / 'Token expired' (lib/auth/verify-token);
    // Clerk-only routes can 401 with a valid sd_ token they simply never read.
    if (injectedAuth && response.status === 401) {
      const text = await response.clone().text().catch(() => '');
      // Guarded on the token still being the one we injected: a slow 401 from
      // the old token must not clear credentials a re-auth just replaced.
      if (/Invalid token|Token expired/.test(text) && store.getAgentCredentials()?.token === credentials.token) {
        store.setAgentCredentials(null);
        // Mounted auth gates learn about this server-initiated sign-out the
        // same way they learn about sign-in (DESKTOP_CREDENTIALS_EVENT).
        broadcast({ type: 'credentials-changed' });
      }
    }
    const outHeaders = {};
    response.headers.forEach((value, key) => {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(key)) return;
      outHeaders[key] = key === 'location' ? rewriteLocation(value) : value;
    });
    const setCookies = (response.headers.getSetCookie?.() ?? []).map(rewriteSetCookie);
    if (setCookies.length) outHeaders['set-cookie'] = setCookies;
    res.writeHead(response.status, outHeaders);
    if (response.body) {
      try {
        for await (const chunk of response.body) res.write(chunk);
      } catch { /* client went away mid-stream */ }
    }
    res.end();
  };
  // ---- Static desktop UI (self-hosted /local surface) ---------------------
  // The exported desktop-ui build ships with the app, so the local surface is
  // served from disk — no cloud origin in the loop for local work. Resolution:
  // env override → bundled sibling (resources/sidecar/ui) → repo build (dev).
  const uiDir = (() => {
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.SUNDIAL_UI_DIR,
      path.join(selfDir, 'ui'),
      path.join(selfDir, '../desktop-ui/out'),
    ].filter(Boolean);
    for (const dir of candidates) {
      try {
        if (fs.existsSync(path.join(dir, 'local.html'))) return path.resolve(dir);
      } catch { /* unreadable candidate */ }
    }
    return null;
  })();

  const UI_MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm',
  };

  /** Absolute file to serve for a UI path, or null to fall through. /local
   *  and /local/<id> map to the exported shells; any other path serves only
   *  when the exported file exists on disk (hashed /_next chunks, fonts,
   *  icons) — proxied cloud pages reference their own /_next build, whose
   *  paths never collide with the export's content-hashed names.
   *
   *  Every /local/<id> payload — the HTML *and* the router's flight probes —
   *  maps onto the single exported `_` shell. Serving the probes is what
   *  makes opening a project a SOFT navigation: 404ing them forced the client
   *  router into a full document load, which paints an EMPTY window for the
   *  whole bundle boot (the flash between the launcher and the workspace) and
   *  made /local's route prefetch a guaranteed miss. `__next.*` directly
   *  under /local belongs to the LAUNCHER route, so it is left alone. */
  const uiFile = (pathname) => {
    if (!uiDir) return null;
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (rel === '/local' || rel === '/local/') rel = '/local.html';
    else if (rel.startsWith('/local/')) {
      const rest = rel.slice('/local/'.length);
      const slash = rest.indexOf('/');
      if (rest.startsWith('__next.')) {
        /* the launcher's own flight payloads — serve as-is */
      } else if (slash === -1) {
        rel = rest.endsWith('.txt') ? '/local/_.txt' : '/local/_.html';
      } else {
        rel = `/local/_/${rest.slice(slash + 1)}`;
      }
    }
    const resolved = path.resolve(uiDir, rel.replace(/^\/+/, ''));
    if (resolved !== uiDir && !resolved.startsWith(uiDir + path.sep)) return null;
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch { /* not exported — fall through to the proxy */ }
    return null;
  };

  const serveUiFile = (req, res, filePath) => {
    const type = UI_MIME[path.extname(filePath).toLowerCase()] || MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': filePath.includes(`${path.sep}_next${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath)
      .on('error', () => res.destroy())
      .pipe(res);
  };

  // The sidecar's own API namespace; everything else belongs to the web app.
  const isSidecarPath = (pathname) =>
    pathname === '/health' || pathname === '/boot' || pathname === '/session-config' || pathname === '/agent-credentials' ||
    pathname === '/diagnostics' ||
    // '/claude-engine' is a retired sidecar path: kept in the namespace so a
    // stale client's bearer-carrying probe 404s HERE instead of being
    // proxied (with the sidecar token) to the remote origin.
    pathname === '/local-engines' || pathname === '/claude-engine' || pathname === '/shutdown' ||
    pathname === '/self-update/check' ||
    pathname === '/projects' || pathname.startsWith('/projects/');

  const handleRequest = (req, res) => {
    // Before anything else, CORS headers included: a rebound page must learn
    // nothing at all, not even that a sidecar answered.
    if (!isLoopbackHost(req.headers.host)) {
      json(res, 403, { ok: false, error: 'forbidden host' });
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const sidecarPath = !remoteOrigin || isSidecarPath(url.pathname);
    const origin = req.headers.origin;
    // CORS applies to the sidecar's OWN API only — proxied web-app responses
    // keep the remote's headers, so the proxy can't be used to read the cloud
    // API cross-origin — and only for origins with business here: loopback
    // pages (repo dev servers, other sidecars) and the one deployment this
    // instance proxies. Any other origin gets no CORS headers, so its reads
    // fail in the browser and an arbitrary site can't probe /health for a
    // "Sundial is installed / signed in" fingerprint.
    const corsAllowed =
      Boolean(origin) && (isLoopbackOrigin(origin) || (Boolean(remoteOrigin) && origin === remoteOrigin));
    if (corsAllowed && sidecarPath) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      // Resume headers included: the agent-stream reconnect sends them, and a
      // rejected preflight would silently break local Sunny stream resume.
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID, X-Resume-Stream-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      // Chrome Private Network Access: a secure public origin fetching loopback.
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS' && sidecarPath) {
      res.writeHead(204);
      res.end();
      return;
    }

    (async () => {
      if (!isSidecarPath(url.pathname)) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const file = uiFile(url.pathname);
          if (file) {
            serveUiFile(req, res, file);
            return;
          }
          // A /local flight probe uiFile() couldn't map onto the export must
          // 404 here, never proxy: the cloud app also owns /local/[projectId],
          // so a remote 200 (HTML for a '<id>.txt' param) would feed the
          // client router a page that isn't the shell.
          if (uiDir && /^\/local\/.+\.txt$/.test(url.pathname)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
          }
        }
        if (remoteOrigin) {
          await proxyRemote(req, res, url);
          return;
        }
        // dev (no proxy): unknown paths fall through to the sidecar 404 below.
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, {
          ok: true,
          service: 'sundial-local',
          apiVersion: SIDECAR_API_VERSION,
          // The login service's own copy (--supervised): a re-run must defer
          // to it, never shut it down to "install" — launchd/systemd relaunch
          // it instantly and the takeover reports failure while everything is
          // healthy (live 2026-08-26).
          supervised: process.argv.includes('--supervised'),
          projects: store.listProjects().length,
          // Dedicated events-plane port (null until bound / when the bind
          // failed) — the app opens its /events stream there so the
          // long-lived connection never occupies a data-plane pool slot.
          eventsPort,
          // Which cloud this instance proxies ('' = direct/dev). The boot
          // deferral must match on it: adopting a same-version sidecar that
          // proxies a DIFFERENT deployment strands the app on the wrong env
          // (bit us: a leftover staging sidecar answered for a prod app).
          remoteOrigin,
          // Whether a signed-in user drives this instance (the desktop app
          // stores agent credentials; a headless serve.sh daemon never does).
          // A headless `--share` run declines to inject an anon share into a
          // signed-in instance and points the user at the app's own Share.
          signedIn: Boolean(store.getAgentCredentials()),
          // sha256 of the bundle this process LOADED (absent when not a
          // self-updating serve.mjs daemon). A deferring serve.sh run
          // compares it to its own freshly downloaded bundle and nudges
          // /self-update/check when they differ.
          ...(selfUpdateInfo?.bundleHash ? { bundleHash: selfUpdateInfo.bundleHash } : {}),
        });
        return;
      }
      // Shell bootstrap: prove possession of the per-install token once, get
      // the trust cookie (gates the proxy's sd_ injection) plus the fragment
      // config latch, and land on the app.
      if (req.method === 'GET' && url.pathname === '/boot') {
        const candidate = url.searchParams.get('token') || '';
        const to = url.searchParams.get('to') || '/local';
        if (!verifyToken(candidate) || !to.startsWith('/') || to.startsWith('//')) {
          json(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        res.writeHead(302, {
          'Set-Cookie': `sundial_local=${candidate}; HttpOnly; SameSite=Lax; Path=/`,
          Location: `${to}#sidecarPort=${boundPort}&sidecarToken=${candidate}`,
        });
        res.end();
        return;
      }
      // Config recovery for the packaged app: the page is SERVED by this
      // sidecar, so a same-origin fetch carrying the HttpOnly trust cookie
      // (set by /boot) can always re-learn the port + token — the app never
      // strands on lost browser storage.
      if (req.method === 'GET' && url.pathname === '/session-config') {
        const cookies = String(req.headers.cookie || '').split(/;\s*/);
        if (!cookies.includes(`sundial_local=${token}`)) {
          json(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        json(res, 200, { ok: true, port: boundPort, token });
        return;
      }
      const auth = authed(req);
      if (!auth) {
        json(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      // Update nudge: a deferring serve.sh run just downloaded the deployed
      // bundle and found this daemon executing older code (health.bundleHash
      // mismatch). Re-check NOW instead of waiting for the 6h tick; when the
      // check applies under supervision, the daemon exits after the response
      // flushes and the login unit relaunches it onto the new code.
      if (req.method === 'POST' && url.pathname === '/self-update/check') {
        if (!selfUpdateInfo?.check) {
          json(res, 200, { ok: true, status: 'unsupported', willRestart: false });
          return;
        }
        const status = await selfUpdateInfo.check();
        json(res, 200, { ok: true, status, willRestart: Boolean(selfUpdateInfo.willRestart) });
        return;
      }
      // Replaced-on-update path: a newer sidecar asks this one to step aside
      // (flushes and stops listening; exits only when running standalone).
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        json(res, 200, { ok: true });
        log('shutdown requested (newer instance taking over)');
        setTimeout(async () => {
          await close().catch(() => {});
          if (exitOnShutdown) process.exit(0);
        }, 50);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/projects') {
        // defaultProjectsDir seeds the create/clone dialogs' Location field —
        // only the sidecar knows the machine's home directory.
        json(res, 200, {
          ok: true,
          // extra_roots: mounted-folder paths, so launcher rows can label
          // multi-folder workspaces (absent on older sidecars).
          projects: store.listProjects().map((project) => ({
            ...project,
            extra_roots: store.listExtraRoots(project.id).map((row) => row.root),
          })),
          defaultProjectsDir: path.join(os.homedir(), 'Documents', 'Sundial'),
        });
        return;
      }
      // Scaffold a brand-new project folder (optionally from a starter pack),
      // then register it like POST /projects would.
      if (req.method === 'POST' && url.pathname === '/projects/create') {
        const body = await readBody(req);
        try {
          const root = await createProjectDir({ name: body.name, location: body.location, pack: body.pack });
          const project = store.openProject(root, typeof body.name === 'string' ? body.name.trim() : undefined);
          ensureWatcher(project);
          json(res, 200, { ok: true, project });
        } catch (error) {
          json(res, 400, { ok: false, error: error?.message || 'Failed to create project' });
        }
        return;
      }
      // Clone a GitHub repo and open it as a project. Responds when the clone
      // finishes — the client owns the progress UI.
      if (req.method === 'POST' && url.pathname === '/projects/clone') {
        const body = await readBody(req);
        try {
          const root = await cloneGitHubRepo({ input: body.url, location: body.location, name: body.name });
          const project = store.openProject(root, typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined);
          ensureWatcher(project);
          json(res, 200, { ok: true, project });
        } catch (error) {
          json(res, 400, { ok: false, error: error?.message || 'Failed to clone repository' });
        }
        return;
      }
      // Local chat engines: are the user's own Claude Code / Codex usable,
      // and which engine is the install's default for new chats?
      if (url.pathname === '/local-engines') {
        if (req.method === 'GET') {
          const engines = await detectLocalEngines({ fresh: true });
          json(res, 200, {
            ok: true,
            ...engines,
            // Never null: with no explicit pick, detection decides. The client
            // shows this on the composer chip before the first message.
            defaultHarness: installDefaultHarness(),
          });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const harness = ['vercel', 'claude', 'openai'].includes(body.defaultHarness) ? body.defaultHarness : null;
          if (!harness) {
            json(res, 400, { ok: false, error: 'defaultHarness must be vercel, claude, or openai' });
            return;
          }
          store.setSetting('default_harness', harness);
          store.adoptDefaultHarness();
          json(res, 200, { ok: true, defaultHarness: harness });
          return;
        }
      }
      // Error reports: the app's user-visible switch. Takes effect on the
      // next line observed — no restart. The env var can only force it off.
      if (url.pathname === '/diagnostics') {
        const envDisabled = !diagnostics.enabled;
        if (req.method === 'POST') {
          const body = await readBody(req);
          store.setDiagnosticsEnabled(body.enabled !== false);
        }
        if (req.method === 'GET' || req.method === 'POST') {
          json(res, 200, { ok: true, enabled: !envDisabled && store.diagnosticsEnabled(), envDisabled });
          return;
        }
      }
      // Cloud credentials for local Sunny (per install, single user). The
      // signed-in browser mints a user-scoped sd_ token and parks it here so
      // the sidecar can call the metered model-step endpoint.
      if (url.pathname === '/agent-credentials') {
        if (req.method === 'GET') {
          // The whole surface is local-token-gated (the same trust domain
          // that SET the credential), so return it: the headless driver
          // presents it for user-scoped attach even when the daemon owning
          // the store is a peer process.
          const credentials = store.getAgentCredentials();
          json(res, 200, {
            ok: true,
            configured: Boolean(credentials),
            ...(credentials ? { apiOrigin: credentials.apiOrigin, token: credentials.token } : {}),
          });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          let apiOrigin = typeof body.apiOrigin === 'string' ? body.apiOrigin.trim().replace(/\/$/, '') : '';
          const agentToken = typeof body.token === 'string' ? body.token.trim() : '';
          if (!apiOrigin || !agentToken) {
            json(res, 400, { ok: false, error: 'apiOrigin and token are required' });
            return;
          }
          // In the packaged app the webview's origin IS this sidecar — model
          // steps must go to the cloud it proxies, not back into the proxy.
          if (remoteOrigin && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiOrigin)) {
            apiOrigin = remoteOrigin;
          }
          store.setAgentCredentials({ apiOrigin, token: agentToken });
          json(res, 200, { ok: true });
          return;
        }
        if (req.method === 'DELETE') {
          store.setAgentCredentials(null);
          json(res, 200, { ok: true });
          return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/projects') {
        const body = await readBody(req);
        const root = typeof body.root === 'string' ? path.resolve(body.root) : '';
        const stat = root ? await fsp.stat(root).catch(() => null) : null;
        if (!stat?.isDirectory()) {
          json(res, 400, { ok: false, error: 'root must be an existing directory' });
          return;
        }
        const project = store.openProject(root, typeof body.name === 'string' ? body.name : undefined);
        ensureWatcher(project);
        json(res, 200, { ok: true, project });
        return;
      }

      const projectMatch = /^\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!projectMatch) {
        json(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const project = store.getProject(projectMatch[1]);
      if (!project) {
        json(res, 404, { ok: false, error: 'unknown project' });
        return;
      }
      const sub = projectMatch[2] || '';
      // Multi-root mapping for this request: virtual project path → the owning
      // root + inner path (see roots.mjs). Primary root paths stay unprefixed.
      const roots = projectRoots(store, project);
      const locate = (rel) => locateRel(roots, rel);

      if (req.method === 'GET' && sub === '') {
        json(res, 200, {
          ok: true,
          project,
          roots,
          shares: bridges.describeShares(project.id),
          backing_workspace_id: bridges.backingWorkspaceId(project.id),
        });
        return;
      }
      // ---- Extra roots: mount / unmount outside folders -------------------
      if (sub === '/roots') {
        if (req.method === 'POST') {
          const body = await readBody(req);
          const picked = typeof body.root === 'string' && body.root.trim() ? path.resolve(body.root.trim()) : '';
          const stat = picked ? await fsp.stat(picked).catch(() => null) : null;
          if (!stat?.isDirectory()) {
            json(res, 400, { ok: false, error: 'root must be an existing directory' });
            return;
          }
          // Canonicalize BEFORE comparing/storing: a symlink or alternate
          // spelling (/var vs /private/var) of an already-served tree must
          // read as the same root, not mount the same files twice under two
          // virtual paths (duplicate watchers, forked doc identity).
          const rootPath = await fsp.realpath(picked).catch(() => picked);
          const canonical = await Promise.all(
            roots.map(async (entry) => ({ entry, real: await fsp.realpath(entry.root).catch(() => entry.root) })),
          );
          const existing = canonical.find(({ real }) => real === rootPath);
          if (existing) {
            json(res, 200, { ok: true, root: existing.entry });
            return;
          }
          // Nested roots would double-serve (and double-watch) the overlap.
          // withSep: a filesystem root ('/', 'C:\') already ends with the
          // separator — naive `+ path.sep` would build '//' and let mounting
          // the whole filesystem slip past this guard.
          const withSep = (p) => (p.endsWith(path.sep) ? p : p + path.sep);
          const overlap = canonical.find(
            ({ real }) => rootPath.startsWith(withSep(real)) || real.startsWith(withSep(rootPath)),
          );
          if (overlap) {
            json(res, 400, { ok: false, error: 'folder overlaps a folder already in this project' });
            return;
          }
          // Prefix must not shadow an existing root prefix or a current
          // top-level entry of the primary root (deterministic -2/-3 suffix).
          const taken = new Set(roots.map((entry) => entry.prefix).filter(Boolean));
          for (const name of await fsp.readdir(project.root).catch(() => [])) taken.add(name);
          const prefix = pickRootPrefix(rootPath, taken);
          store.addExtraRoot(project.id, prefix, rootPath);
          try {
            watchers.get(project.id)?.attach(prefix, rootPath, onWatcherChange(project));
          } catch (error) {
            log(`watcher failed root=${logPath(rootPath)} error=${error?.message}`);
          }
          emit(project.id, { type: 'files-changed', path: prefix });
          json(res, 200, { ok: true, root: { prefix, root: rootPath, name: path.basename(rootPath) || rootPath } });
          return;
        }
        if (req.method === 'DELETE') {
          const prefix = url.searchParams.get('prefix') || '';
          if (!store.listExtraRoots(project.id).some((row) => row.prefix === prefix)) {
            json(res, 404, { ok: false, error: 'unknown folder' });
            return;
          }
          // Detach cleanly: flush unpersisted keystrokes to disk FIRST (the
          // folder survives on disk, so a pending debounce window must not be
          // dropped by the detach), then stop the watcher, close live docs
          // under the prefix, drop store traces. Disk is never touched.
          await docHost.flushProject(project.id);
          watchers.get(project.id)?.detach(prefix);
          await docHost.detachUnder(project.id, prefix);
          store.removeExtraRoot(project.id, prefix);
          emit(project.id, { type: 'files-changed', path: prefix });
          json(res, 200, { ok: true });
          return;
        }
      }
      if (req.method === 'PATCH' && sub === '') {
        const body = await readBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          json(res, 400, { ok: false, error: 'name is required' });
          return;
        }
        json(res, 200, { ok: true, project: store.renameProject(project.id, name) });
        return;
      }
      if (req.method === 'DELETE' && sub === '') {
        await bridges.stopProject(project.id);
        watchers.get(project.id)?.close();
        watchers.delete(project.id);
        store.removeProject(project.id);
        json(res, 200, { ok: true });
        return;
      }
      // Identity survives edits and renames but not delete+recreate — the
      // editor uses a changed id to drop its cached Y.Doc for the path.
      const describeEntry = (file, id = store.ensureFileId(project.id, file.path)) => ({
        id,
        mime: MIME[path.extname(file.path).toLowerCase()] ?? null,
        ...file,
      });
      const describePath = async (rel) => {
        const loc = locate(rel);
        // rel === an extra root's prefix resolves to the mounted folder itself.
        const abs = loc.rel ? await safeResolveInRoot(loc.root, loc.rel) : loc.root;
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat) return null;
        return describeEntry({
          path: rel,
          type: stat.isDirectory() ? 'folder' : fileKindForFile(rel) === 'text' ? 'text' : 'blob',
          size: stat.isDirectory() ? 0 : stat.size,
          updated_at: stat.mtime.toISOString(),
        });
      };

      // Creating at a path a case-insensitive disk already resolves to a
      // differently-cased entry would truncate that entry, and the typed name
      // would never appear in the tree. Answer 409 naming the real file — the
      // clobber used to be silent (`recent.md` emptied `Recent.md`).
      const caseConflict = async (loc) => {
        const onDisk = loc.rel ? await caseVariantOnDisk(loc.root, loc.rel) : null;
        if (!onDisk) return false;
        json(res, 409, { ok: false, error: caseConflictMessage(onDisk, loc.rel) });
        return true;
      };

      if (req.method === 'GET' && sub === '/files') {
        const files = await walkAllRoots(roots);
        const ids = store.ensureFileIds(project.id, files.map((file) => file.path));
        json(res, 200, { ok: true, files: files.map((file) => describeEntry(file, ids.get(file.path))), roots });
        return;
      }
      if (req.method === 'GET' && sub === '/file') {
        const rel = normalizeRelPath(url.searchParams.get('path') || '');
        if (!rel || isIgnoredPath(rel)) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        const loc = locate(rel);
        const abs = loc.rel ? await safeResolveInRoot(loc.root, loc.rel) : null;
        const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
        if (!stat?.isFile()) {
          json(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const ext = path.extname(rel).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || (fileKindForFile(rel) === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
          'Content-Length': stat.size,
        });
        // Headers are already sent — an async read error (file vanished mid-
        // stream) must sever the response, not crash the process.
        fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
        return;
      }
      if (req.method === 'PUT' && sub === '/blob') {
        // Raw-bytes upload, streamed to disk. Local projects are the user's
        // own file system — no size cap, no base64/JSON inflation (the JSON
        // rail below tops out at the 20 MB body cap).
        const rel = normalizeRelPath(url.searchParams.get('path') || '');
        if (!rel || isIgnoredPath(rel) || fileKindForFile(rel) !== 'blob') {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        const loc = locate(rel);
        if (await caseConflict(loc)) return;
        await writeBlobStreamAtomic(loc.root, loc.rel, req);
        // Suppress AFTER the write: the watcher only sees the final rename
        // (tmp paths are ignored), and a pre-write suppression window could
        // expire mid-stream on large files.
        watchers.get(project.id)?.suppress(rel);
        await bridges.handleLocalFileEvent(project.id, rel);
        emit(project.id, { type: 'files-changed', path: rel });
        json(res, 200, { ok: true, file: await describePath(rel) });
        return;
      }
      if (req.method === 'PUT' && sub === '/file') {
        const body = await readBody(req);
        const rel = normalizeRelPath(body.path || '');
        const kind = rel && !isIgnoredPath(rel) ? fileKindForFile(rel) : null;
        // Binary upload: base64 body, no doc host involvement; share bridges
        // pick it up for sha-diffed blob sync.
        if (kind === 'blob' && typeof body.contentBase64 === 'string') {
          const loc = locate(rel);
          if (await caseConflict(loc)) return;
          watchers.get(project.id)?.suppress(rel);
          await writeBlobAtomic(loc.root, loc.rel, Buffer.from(body.contentBase64, 'base64'));
          await bridges.handleLocalFileEvent(project.id, rel);
          emit(project.id, { type: 'files-changed', path: rel });
          json(res, 200, { ok: true, file: await describePath(rel) });
          return;
        }
        if (kind !== 'text') {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        // Editor image drops always send base64 — but some image types (SVG)
        // are TEXT-classified by the sync policy, so decode instead of
        // silently writing '' (which corrupted dropped SVGs).
        const content =
          typeof body.content === 'string'
            ? body.content
            : typeof body.contentBase64 === 'string'
              ? Buffer.from(body.contentBase64, 'base64').toString('utf8')
              : '';
        const loc = locate(rel);
        if (await caseConflict(loc)) return;
        watchers.get(project.id)?.suppress(rel);
        await writeTextFileAtomic(loc.root, loc.rel, content);
        // Attribution flows through handleDiskChange (one ledger row, the
        // caller's actor) — a separate recordEdit here would double-record.
        await docHost.handleDiskChange(project.id, rel, { actor: auth.actor });
        await bridges.handleLocalFileEvent(project.id, rel);
        emit(project.id, { type: 'files-changed', path: rel });
        json(res, 200, { ok: true, file: await describePath(rel) });
        return;
      }
      if (req.method === 'POST' && sub === '/folder') {
        const body = await readBody(req);
        const rel = normalizeRelPath(body.path || '');
        if (!rel || isIgnoredPath(rel)) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        const loc = locate(rel);
        if (!loc.rel) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        if (await caseConflict(loc)) return;
        await makeFolder(loc.root, loc.rel);
        emit(project.id, { type: 'files-changed', path: rel });
        json(res, 200, { ok: true, file: await describePath(rel) });
        return;
      }
      if (req.method === 'POST' && sub === '/copy') {
        const body = await readBody(req);
        const from = normalizeRelPath(body.from || '');
        const to = normalizeRelPath(body.to || '');
        if (!from || !to || isIgnoredPath(from) || isIgnoredPath(to)) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        const fromLoc = locate(from);
        const toLoc = locate(to);
        if (!fromLoc.rel || !toLoc.rel || fromLoc.root !== toLoc.root) {
          json(res, 400, { ok: false, error: 'cannot copy across added folders' });
          return;
        }
        // Copied text files flow through the watcher (doc host + bridges pick
        // them up as new files); emit immediately so the tree feels instant.
        await copyPath(fromLoc.root, fromLoc.rel, toLoc.rel);
        emit(project.id, { type: 'files-changed', path: to });
        json(res, 200, { ok: true, file: await describePath(to) });
        return;
      }
      if (req.method === 'GET' && sub === '/download') {
        const relFile = url.searchParams.get('path');
        const folder = url.searchParams.get('folderPath');
        const disposition = (name) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
        if (relFile && !folder) {
          const rel = normalizeRelPath(relFile);
          const loc = rel ? locate(rel) : null;
          const abs = rel && loc?.rel && !isIgnoredPath(rel) ? await safeResolveInRoot(loc.root, loc.rel) : null;
          const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
          if (!stat?.isFile()) {
            json(res, 404, { ok: false, error: 'not found' });
            return;
          }
          const ext = path.extname(rel).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Content-Disposition': disposition(path.basename(rel)),
          });
          fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
          return;
        }
        // Folder or whole-project zip (store-only). Bounded so a giant
        // project can't balloon the sidecar's memory.
        const folderRel = folder ? normalizeRelPath(folder) : '';
        const inScope = (rel) => !folderRel || rel === folderRel || rel.startsWith(`${folderRel}/`);
        const prefixLen = folderRel ? folderRel.length + 1 : 0;
        const baseName = folderRel ? path.basename(folderRel) : project.name || 'workspace';
        const entries = [];
        let total = 0;
        for (const file of await walkAllRoots(roots)) {
          if (file.type === 'folder' || !inScope(file.path)) continue;
          total += file.size;
          if (total > 200 * 1024 * 1024) {
            json(res, 413, { ok: false, error: 'folder too large to zip' });
            return;
          }
          const loc = locate(file.path);
          const abs = await safeResolveInRoot(loc.root, loc.rel).catch(() => null);
          const data = abs ? await fsp.readFile(abs).catch(() => null) : null;
          if (!data) continue;
          entries.push({ path: `${baseName}/${file.path.slice(prefixLen)}`, content: data });
        }
        const zip = await createZipNodeBuffer(entries);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zip.length,
          'Content-Disposition': disposition(`${baseName}.zip`),
        });
        res.end(zip);
        return;
      }
      if (req.method === 'POST' && sub === '/reveal') {
        const body = await readBody(req);
        const rel = normalizeRelPath(body.path || '');
        const loc = rel ? locate(rel) : null;
        const abs = loc ? (loc.rel ? await safeResolveInRoot(loc.root, loc.rel) : loc.root) : project.root;
        const { spawn } = await import('node:child_process');
        const cmd = process.platform === 'darwin'
          ? ['open', ['-R', abs]]
          : process.platform === 'win32'
            ? ['explorer', [`/select,${abs}`]]
            : ['xdg-open', [path.dirname(abs)]];
        spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && sub === '/rename') {
        const body = await readBody(req);
        const from = normalizeRelPath(body.from || '');
        const to = normalizeRelPath(body.to || '');
        if (!from || !to || isIgnoredPath(from) || isIgnoredPath(to)) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        const fromLoc = locate(from);
        const toLoc = locate(to);
        // Root prefixes themselves don't rename here (detach via /roots), and
        // entries can't move between roots — each root is its own disk tree.
        if (!fromLoc.rel || !toLoc.rel || fromLoc.root !== toLoc.root) {
          json(res, 400, { ok: false, error: 'cannot move across added folders' });
          return;
        }
        // A case-only rename (Notes.md -> notes.md) leaves the OLD spelling
        // still resolving to the file on a case-folding disk, so the watcher's
        // event for it would re-record the file under the name just moved away
        // from. Ordinary renames need no such window — the old path is gone.
        const { caseOnly } = await renameFile(fromLoc.root, fromLoc.rel, toLoc.rel);
        if (caseOnly) watchers.get(project.id)?.suppress(from);
        await docHost.handleDiskRename(project.id, from, to);
        await bridges.handleLocalRename(project.id, from, to);
        store.renameCommentPaths(project.id, from, to);
        emit(project.id, { type: 'files-changed', path: to });
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'DELETE' && sub === '/file') {
        const rel = normalizeRelPath(url.searchParams.get('path') || '');
        // The ignored-path guard matters most HERE: deleteFile is recursive,
        // and .git / node_modules are exactly what it must never touch.
        const loc = locate(rel);
        // A root prefix itself never deletes through here — detaching a
        // mounted folder is DELETE /roots (and never touches the disk).
        if (!rel || !loc.rel || isIgnoredPath(rel)) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        // Untracked content (unknown-extension files, symlinks) is invisible
        // to the listing but destroyed by this delete — probed BEFORE the rm
        // so the client can refuse to advertise an undo that couldn't bring
        // everything back.
        let untracked = await hasUntrackedContent(loc.root, loc.rel).catch(() => true);
        // Snapshot text bodies the ledger doesn't hold yet (files never edited
        // since the project opened) so undo-delete can always reconstruct. A
        // victim whose body can't be read (oversized text past MAX_TEXT_BYTES)
        // poisons restorability the same way untracked content does — undo
        // would restore stale content or nothing.
        const victims = (await walkProject(loc.root))
          .filter((file) => file.type === 'text' && (file.path === loc.rel || file.path.startsWith(`${loc.rel}/`)))
          .map((file) => ({ inner: file.path, virtual: loc.entry.prefix ? `${loc.entry.prefix}/${file.path}` : file.path }));
        for (const file of victims) {
          const text =
            docHost.getLiveText(project.id, file.virtual) ??
            (await readTextFile(loc.root, file.inner).catch(() => null))?.text;
          if (typeof text !== 'string') {
            untracked = true;
          } else if (store.latestContentBefore(project.id, file.virtual) !== text) {
            store.recordEdit({ projectId: project.id, path: file.virtual, actor: auth.actor, contentText: text });
          }
        }
        // Ignored content (.git, node_modules, …) is preserved by design, and
        // the folder holding it stays on disk — so it reappears in the very
        // next listing. Report it instead of claiming a clean delete.
        const { kept } = await deleteFile(loc.root, loc.rel);
        const keptVirtual = kept.map((inner) => (loc.entry.prefix ? `${loc.entry.prefix}/${inner}` : inner));
        await docHost.handleDiskChange(project.id, rel, { actor: auth.actor });
        await bridges.handleLocalFileEvent(project.id, rel);
        emit(project.id, { type: 'files-changed', path: rel });
        // The undo cutoff must be STRICTLY after every ledger row this delete
        // wrote (snapshots + tombstones) — a browser-minted timestamp can tie
        // the same millisecond and make `created_at < cutoff` miss them.
        json(res, 200, { ok: true, deletedAt: new Date(Date.now() + 1).toISOString(), untracked, kept: keptVirtual });
        return;
      }
      if (req.method === 'GET' && sub === '/text-contents') {
        // Bulk text bodies for project-wide search/replace, preferring live
        // doc text over disk so results reflect unflushed keystrokes.
        const prefix = normalizeRelPath(url.searchParams.get('prefix') || '');
        const files = [];
        let total = 0;
        for (const file of await walkAllRoots(roots)) {
          if (file.type !== 'text') continue;
          if (prefix && file.path !== prefix && !file.path.startsWith(`${prefix}/`)) continue;
          const fileLoc = locate(file.path);
          const live = docHost.getLiveText(project.id, file.path);
          const text = live ?? (await readTextFile(fileLoc.root, fileLoc.rel).catch(() => null))?.text;
          if (typeof text !== 'string') continue;
          total += text.length;
          if (total > 30_000_000) {
            json(res, 413, { ok: false, error: 'project too large for bulk text read' });
            return;
          }
          files.push({ path: file.path, text });
        }
        json(res, 200, { ok: true, files });
        return;
      }
      // ---- Edit history (Review panel backing) ---------------------------
      if (req.method === 'GET' && sub === '/changes') {
        const beforeId = Number(url.searchParams.get('beforeId') || 0) || null;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 200);
        const relPath = url.searchParams.get('path');
        const folder = url.searchParams.get('folder');
        const actors = url.searchParams.get('actors')?.split(',') ?? null;
        const chatId = url.searchParams.get('chatId') || null;
        // Pending-only (the editor's per-file review feed). Applied BEFORE the
        // cap, or a suggestion still open under a page of newer applied
        // history would vanish from the feed and lose its author chip.
        const pendingOnly = url.searchParams.get('pending') === '1';
        const scanOpts = {
          path: relPath ? normalizeRelPath(relPath) : null,
          folder: folder ? normalizeRelPath(folder) : null,
          beforeId,
        };
        // Actor/chat narrowing is two-phase: a FILTERED locator scan finds
        // where the selected author/chat was active (recent unrelated edits
        // can't bury it past the window), then grouping re-reads those
        // paths' FULL streams (≤500 rows each by retention) so interposed
        // other-author rows still split sessions — filtering rows before
        // grouping would merge adjacent sessions into a reviewId that
        // /applied-edit (which groups full history) cannot resolve.
        const locateRows = (filters) => {
          const located = store.listEditsWindow(project.id, { ...scanOpts, ...filters });
          const paths = [...new Set(located.rows.map((row) => row.path))];
          let full = paths
            .flatMap((p) => store.listPathEditsUpTo(project.id, p, (beforeId ?? Number.MAX_SAFE_INTEGER) - 1))
            .sort((a, b) => a.id - b.id);
          if (located.capped) full = full.filter((row) => row.id >= located.rows[0].id);
          return { rows: full, capped: located.capped };
        };
        let rows, capped;
        if (actors || chatId) ({ rows, capped } = locateRows({ actors, chatId }));
        else ({ rows, capped } = store.listEditsWindow(project.id, scanOpts));
        // A suggest session is 'pending' while any of its staged suggestion
        // ids is still unresolved in the doc — that's what arms the panel's
        // Keep/Undo; once resolved (panel or inline ✓/✕) it's plain history.
        const sessionPending = (entry) =>
          entry.editMode === 'suggest' &&
          docHost.hasPendingSuggestions(project.id, entry.path, entry.suggestionIds);
        let { entries, actorCounts, nextBeforeId } = buildLocalChangeEntries(rows, {
          limit,
          scanFloor: capped ? rows[0]?.id ?? null : null,
          actors,
          chatId,
          isPending: pendingOnly ? sessionPending : null,
        });
        if (actors) {
          // Author-chip counts stay pre-actor-filter — recomputed over the
          // same scope minus the actor filter (chat locator when chat-scoped,
          // else the plain window). One extra local SQLite scan is cheap.
          const countRows = chatId ? locateRows({ chatId }).rows : store.listEditsWindow(project.id, scanOpts).rows;
          actorCounts = buildLocalChangeEntries(countRows, { limit: 1, chatId }).actorCounts;
        }
        for (const entry of entries) {
          entry.reviewState = sessionPending(entry) ? 'pending' : 'applied';
        }
        json(res, 200, {
          ok: true,
          entries,
          actorCounts,
          latestDocEditId: store.latestEditId(project.id),
          nextBeforeId,
        });
        return;
      }
      // One agent turn's edits, per file — what the chat's diff chip renders.
      // Keyed by assistant message id like the cloud /api/workspace/turn-edits.
      if (req.method === 'GET' && sub === '/turn-edits') {
        json(res, 200, { ok: true, files: store.turnEditFiles(project.id, url.searchParams.get('messageId') || '') });
        return;
      }
      if (req.method === 'GET' && sub === '/applied-edit') {
        const lastRowId = Number(url.searchParams.get('lastRowId') || 0);
        // Path is derivable from the anchor row — the panel's turn-edits GET
        // only carries the `applied-<rowId>` review id.
        const rel =
          normalizeRelPath(url.searchParams.get('path') || '') || (lastRowId ? store.editPath(project.id, lastRowId) : null);
        if (!rel || !lastRowId) {
          json(res, 400, { ok: false, error: 'path and lastRowId are required' });
          return;
        }
        const rows = store.listPathEditsUpTo(project.id, rel, lastRowId);
        const session = collectLocalSessions(rows).find((s) => s.lastRowId === lastRowId);
        if (!session) {
          json(res, 404, { ok: false, error: 'unknown edit session' });
          return;
        }
        const firstIndex = rows.findIndex((row) => row.id === session.firstRowId);
        const before = firstIndex > 0 ? store.getEditContent(rows[firstIndex - 1].id) : null;
        const after = store.getEditContent(session.lastRowId);
        const deleted = after != null && after.content_text === null;
        // Reject-projection of the session's still-live marks — two jobs:
        // the diff baseline when NO earlier ledger row exists (first-ever
        // edit of a pre-existing file must not read as a whole-file "New
        // file" insertion), and the pending payload's `rejectedText` (with a
        // PARTIALLY inline-decided session, the undecided delta is
        // rejected→current, not the whole recorded diff). Null = nothing live.
        const rejected =
          !deleted && session.suggestionIds?.length
            ? await docHost.rejectedProjection(project.id, rel, session.suggestionIds)
            : null;
        json(res, 200, {
          ok: true,
          // Deletions diff against the newest recorded body — the pre-delete
          // snapshot can live INSIDE the same session (a never-edited file's
          // snapshot + tombstone land together), where the predecessor row
          // would wrongly read as "empty file deleted". Otherwise a
          // null-content predecessor is a delete marker/bridge row — the file
          // was absent (or unknowable) before this session → new file.
          beforeText: deleted
            ? store.latestContentBefore(project.id, rel, { atId: session.lastRowId }) ?? ''
            : before?.content_text ?? rejected ?? '',
          afterText: after?.content_text ?? '',
          deleted,
          session,
          rejectedText: rejected,
          currentText: deleted
            ? null
            : docHost.getLiveText(project.id, rel) ??
              (await readTextFile(locate(rel).root, locate(rel).rel).catch(() => null))?.text ??
              null,
        });
        return;
      }
      // Keep/Undo for a suggest session (`applied-<rowId>`): resolve its staged
      // suggestion ids through the doc host — live editors see the marks clear,
      // disk gets the accepted/reverted projection, a rejected creation deletes
      // its file. Idempotent: an already-resolved session is `changed: false`.
      if (req.method === 'POST' && sub === '/resolve-review') {
        const body = await readBody(req);
        const reviewId = typeof body.reviewId === 'string' ? body.reviewId : '';
        const action = body.action === 'reject' ? 'reject' : 'accept';
        const lastRowId = Number(reviewId.startsWith('applied-') ? reviewId.slice('applied-'.length) : 0);
        const rel = Number.isInteger(lastRowId) && lastRowId > 0 ? store.editPath(project.id, lastRowId) : null;
        if (!rel) {
          json(res, 404, { ok: false, error: 'unknown edit session' });
          return;
        }
        const session = collectLocalSessions(store.listPathEditsUpTo(project.id, rel, lastRowId)).find(
          (s) => s.lastRowId === lastRowId,
        );
        if (!session) {
          json(res, 404, { ok: false, error: 'unknown edit session' });
          return;
        }
        const result = await docHost.resolveSuggestions(project.id, rel, session.suggestionIds, action, {
          actor: 'user',
          chatId: session.chatId,
        });
        // changed:false is benign only when nothing is left pending (already
        // resolved elsewhere). Marks still live means the resolve DECLINED
        // (e.g. the file became unreadable) — report failure, or the panel
        // would record a decision and hide a still-pending suggestion.
        if (!result.changed && docHost.hasPendingSuggestions(project.id, rel, session.suggestionIds)) {
          json(res, 409, { ok: false, error: 'The suggestion could not be resolved: the file is unreadable.' });
          return;
        }
        if (result.changed) {
          // The resolution persisted with the watcher suppressed — nothing
          // else announces it. Sync + announce like other internal writes (a
          // rejected creation's DELETE arrives separately via onFileRemoved).
          void bridges
            .handleLocalFileEvent(project.id, rel)
            .catch((error) => log(`bridge resolve failed path=${logPath(rel)} error=${error?.message}`));
          emit(project.id, { type: 'files-changed', path: rel });
        }
        // `after` = the file's text once the dust settles — with PARTIALLY
        // pre-decided sessions (one id accepted inline, the other undone
        // here) the surviving delta is what the caller must report, not the
        // whole session diff. Null = the file is gone (rejected creation).
        const after = (await readTextFile(locate(rel).root, locate(rel).rel).catch(() => null))?.text ?? null;
        json(res, 200, { ok: true, changed: result.changed, after });
        return;
      }
      if (req.method === 'GET' && sub === '/history-compare') {
        const to = Number(url.searchParams.get('to') || 0);
        const from = Number(url.searchParams.get('from') || 0) || null;
        if (!to) {
          json(res, 400, { ok: false, error: 'to is required' });
          return;
        }
        // Per-path text at each point: newest ledger row ≤ the point (null
        // content = absent). Paths older than the 500-row retention window
        // under-resolve to "absent" — same trade the cap already makes.
        const files = [];
        for (const relPath of store.listEditPaths(project.id, to)) {
          const beforeText = from ? store.editTextAt(project.id, relPath, from) : undefined;
          const afterText = store.editTextAt(project.id, relPath, to);
          const beforeExists = typeof beforeText === 'string';
          const afterExists = typeof afterText === 'string';
          if (!beforeExists && !afterExists) continue;
          if (beforeExists && afterExists && beforeText === afterText) continue;
          files.push({
            path: relPath,
            status: !beforeExists ? 'added' : !afterExists ? 'removed' : 'modified',
            beforeText: beforeText ?? '',
            afterText: afterText ?? '',
          });
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        json(res, 200, { ok: true, from, to, files });
        return;
      }
      if (sub === '/file-order') {
        if (req.method === 'GET') {
          json(res, 200, { ok: true, fileOrder: store.getFileOrder(project.id) });
          return;
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const parent = typeof body.parent === 'string' ? body.parent : '';
          if (!parent || !Array.isArray(body.names)) {
            json(res, 400, { ok: false, error: 'parent and names are required' });
            return;
          }
          const names = body.names.filter((name) => typeof name === 'string' && name.length > 0);
          json(res, 200, { ok: true, fileOrder: store.setFileOrder(project.id, parent, names) });
          return;
        }
      }
      if (sub === '/labels') {
        if (req.method === 'GET') {
          json(res, 200, { ok: true, labels: store.listHistoryLabels(project.id) });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const docEditId = Number(body.docEditId || 0);
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!Number.isInteger(docEditId) || docEditId <= 0 || !name) {
            json(res, 400, { ok: false, error: 'docEditId and name are required' });
            return;
          }
          json(res, 200, { ok: true, label: store.upsertHistoryLabel(project.id, docEditId, name.slice(0, 120)) });
          return;
        }
        if (req.method === 'DELETE') {
          const labelId = url.searchParams.get('id') || '';
          json(res, 200, { ok: true, removed: store.deleteHistoryLabel(project.id, labelId) });
          return;
        }
      }
      if (req.method === 'POST' && sub === '/history-restore') {
        const body = await readBody(req);
        const rel = normalizeRelPath(String(body.path || ''));
        if (!rel || isIgnoredPath(rel) || fileKindForFile(rel) !== 'text') {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        // Restore is for GONE files (the undo-delete flow) — a path re-created
        // since the delete must not be clobbered by a stale undo (cloud parity).
        const restoreLoc = locate(rel);
        const existingAbs = await safeResolveInRoot(restoreLoc.root, restoreLoc.rel);
        if (await fsp.stat(existingAbs).catch(() => null)) {
          json(res, 409, { ok: false, error: 'path already exists' });
          return;
        }
        const atId = Number(body.atId || 0) || null;
        const text = store.latestContentBefore(project.id, rel, {
          atId,
          beforeCreatedAt: typeof body.beforeCreatedAt === 'string' ? body.beforeCreatedAt : null,
        });
        if (typeof text !== 'string') {
          json(res, 404, { ok: false, error: 'no recorded content for that path' });
          return;
        }
        // Same rail as a text PUT: write, fold into any live doc (attributed),
        // relay to shares, refresh the tree.
        watchers.get(project.id)?.suppress(rel);
        await writeTextFileAtomic(restoreLoc.root, restoreLoc.rel, text);
        await docHost.handleDiskChange(project.id, rel, { actor: auth.actor });
        await bridges.handleLocalFileEvent(project.id, rel);
        emit(project.id, { type: 'files-changed', path: rel });
        json(res, 200, { ok: true, file: await describePath(rel) });
        return;
      }
      if (req.method === 'GET' && sub === '/edits') {
        const rel = url.searchParams.get('path');
        json(res, 200, {
          ok: true,
          edits: store.listEdits(project.id, {
            path: rel ? normalizeRelPath(rel) : null,
            afterId: Number(url.searchParams.get('afterId') || 0),
          }),
        });
        return;
      }
      if (req.method === 'GET' && sub === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('data: {"type":"connected"}\n\n');
        let clients = sseClients.get(project.id);
        if (!clients) {
          clients = new Set();
          sseClients.set(project.id, clients);
        }
        clients.add(res);
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          clients.delete(res);
        });
        return;
      }
      // ---- Local Sunny: chats + agent runs ------------------------------
      if (req.method === 'GET' && sub === '/chats') {
        // `running` is live runner state (in-flight or parked) — the panel's
        // "Agent is working" clears from it even for engines that never post
        // a thread reply (Codex writes only in the chat).
        json(res, 200, {
          ok: true,
          chats: store.listChats(project.id).map((c) => ({
            ...c,
            running: agentHost.isBusy?.(c.id) === true,
            // Does a started run still owe this chat's thread an answer? True
            // from the run's start until that answer is posted, and across the
            // retry gaps in between — the exact window in which the run is not
            // live but the thread is still going to hear something. False when
            // no run ever started and when one was stopped (both drop the
            // obligation), which is what keeps the badge from spinning on a
            // thread nobody is answering.
            answering:
              (runCommentThreads.get(c.id)?.length ?? 0) > 0 || commentRetryPending.has(c.id),
          })),
        });
        return;
      }
      if (req.method === 'POST' && sub === '/chats') {
        const body = await readBody(req);
        // Only an EXPLICIT pick is stamped at creation — an unused chat keeps
        // following detection until its first run (runHarness). The model is
        // coerced either way: a client that created the chat before probing
        // would otherwise pair e.g. a Codex chat with an Anthropic model.
        const harness = typeof body.harness === 'string' ? body.harness : store.getSetting('default_harness');
        const model = coerceModelForHarness(harness, typeof body.model === 'string' ? body.model : null);
        const chat = store.createChat(project.id, {
          title: typeof body.title === 'string' ? body.title : null,
          model,
          harness,
          folderScope: typeof body.folderScope === 'string' && body.folderScope ? body.folderScope : null,
          kind: typeof body.kind === 'string' && body.kind ? body.kind : null,
        });
        json(res, 200, { ok: true, chat });
        return;
      }
      if (req.method === 'PATCH' && /^\/chats\/[^/]+$/.test(sub)) {
        const chatId = sub.split('/')[2];
        const body = await readBody(req);
        const patch = {};
        // Auto-generated first-message title: CAS write (only while unnamed),
        // so a user rename in flight is never clobbered.
        if (typeof body.autoTitle === 'string' && body.autoTitle.trim()) {
          store.setChatTitleIfUnset(chatId, body.autoTitle.trim());
        }
        if (typeof body.title === 'string') patch.title = body.title;
        if (typeof body.model === 'string') patch.model = body.model;
        if (typeof body.harness === 'string') patch.harness = body.harness;
        if (typeof body.archived === 'boolean') patch.archived_at = body.archived ? new Date().toISOString() : null;
        if (typeof body.pinned === 'boolean') patch.pinned = body.pinned ? 1 : 0;
        if ('commentWatchPath' in body) {
          patch.comment_watch_path =
            typeof body.commentWatchPath === 'string' && body.commentWatchPath.trim()
              ? body.commentWatchPath.trim()
              : null;
          // Bind a concrete path to the file's identity (see store migration).
          patch.comment_watch_file_id =
            patch.comment_watch_path && patch.comment_watch_path !== '*'
              ? store.knownFileId(project.id, patch.comment_watch_path)
              : null;
          // share → watch parity with the share route's 409: delivery skips
          // shared chats, so the watch would silently never fire.
          if (patch.comment_watch_path && store.chatHasActiveShare(chatId)) {
            json(res, 409, { ok: false, error: 'This chat is shared via a link. Stop the share before watching comments.' });
            return;
          }
          // Dekker verify (the cloud routes' pattern): we write the watch,
          // then re-check shares — the share path writes its scope and
          // re-checks the watch, so in any interleaving one side observes the
          // other. A raced share rolls the watch back rather than leaving a
          // chip over a chat deliveries skip (and whose history guests read).
          if (patch.comment_watch_path) {
            store.updateChat(chatId, patch);
            if (store.chatHasActiveShare(chatId)) {
              store.updateChat(chatId, { comment_watch_path: null });
              json(res, 409, { ok: false, error: 'This chat was shared while enabling the watch; the watch was rolled back.' });
              return;
            }
            json(res, 200, { ok: true, chat: store.getChat(chatId) });
            return;
          }
        }
        const chat = store.updateChat(chatId, patch);
        if (!chat) {
          json(res, 404, { ok: false, error: 'unknown chat' });
          return;
        }
        json(res, 200, { ok: true, chat });
        return;
      }
      if (req.method === 'DELETE' && /^\/chats\/[^/]+$/.test(sub)) {
        const chatId = sub.split('/')[2];
        // The URL scopes the delete: a chat id from ANOTHER project (a stale
        // tab, a client that kept an id after switching) must 404 here rather
        // than take a transcript out of a project the user isn't looking at.
        // deleteChat itself only matches on the id.
        const doomed = store.getChat(chatId);
        if (!doomed || doomed.project_id !== project.id) {
          json(res, 404, { ok: false, error: 'unknown chat' });
          return;
        }
        // A shared chat's scope is a LIVE bridge engine syncing into a cloud
        // workspace — unwinding it needs the share lock and a cloud revoke, so
        // refuse rather than leave a link pointing at nothing. Same 409 shape
        // the comment-watch route uses for the mirror-image conflict.
        if (store.chatHasActiveShare(chatId)) {
          json(res, 409, { ok: false, error: 'This chat is shared via a link. Stop the share before deleting it.' });
          return;
        }
        // Stop any in-flight run first: the runner writes assistant rows as it
        // streams, and one landing after the delete would resurrect the chat's
        // transcript with no chat to hold it.
        agentHost.interrupt(chatId);
        if (!store.deleteChat(chatId)) {
          json(res, 404, { ok: false, error: 'unknown chat' });
          return;
        }
        json(res, 200, { ok: true, deleted: true });
        return;
      }
      // ---- External agent sessions (Claude Code / Codex transcripts on
      // disk). Read-only over the agents' own dirs — never writes there.
      if (sub === '/external-sessions' && req.method === 'GET') {
        const { listExternalSessions } = await import('./external-sessions.mjs');
        const sessions = await listExternalSessions({
          roots,
          exclude: store.externalSessionLinks(project.id),
          onEngineSession: (agent, id) => store.recordEngineSession(agent, id),
        });
        // The transcript path stays server-side: clients re-address by id.
        json(res, 200, { ok: true, sessions: sessions.map(({ path: _path, ...session }) => session) });
        return;
      }
      if (sub === '/external-sessions/messages' && req.method === 'GET') {
        const { findExternalSession, readExternalSessionMessages } = await import('./external-sessions.mjs');
        const session = await findExternalSession({
          roots,
          agent: url.searchParams.get('agent') || 'claude',
          id: url.searchParams.get('id') || '',
          exclude: store.externalSessionLinks(project.id),
        });
        if (!session) {
          json(res, 404, { ok: false, error: 'unknown session' });
          return;
        }
        json(res, 200, { ok: true, messages: await readExternalSessionMessages(session) });
        return;
      }
      // Adopt a session as a real chat (the banner's Import AND Resume): the
      // transcript persists as attributed rows, and the external link makes
      // later sends continue the engine's own session natively.
      if (sub === '/external-sessions/import' && req.method === 'POST') {
        const body = await readBody(req);
        const { findExternalSession, readExternalSessionMessages } = await import('./external-sessions.mjs');
        const agent = body.agent === 'codex' ? 'codex' : 'claude';
        const id = typeof body.id === 'string' ? body.id : '';
        // Idempotent: a re-post (double-click, second window) answers the
        // already-adopted chat. Checked BEFORE the lookup — an adopted
        // session is excluded from the scan, so it would 404 otherwise.
        const adopted = store.findChatByExternalSession(project.id, agent, id);
        if (adopted) {
          json(res, 200, { ok: true, chat: adopted });
          return;
        }
        // The listing's exclusions apply here too: a stale row must not adopt
        // a session that is already a chat (our own engine's, notably).
        const session = await findExternalSession({
          roots,
          agent,
          id,
          exclude: store.externalSessionLinks(project.id),
        });
        if (!session) {
          json(res, 404, { ok: false, error: 'unknown session' });
          return;
        }
        // Read the transcript BEFORE creating anything: a vanished/unreadable
        // file must fail the request without leaving an empty linked chat
        // that would block retries (linked sessions leave the listing).
        const importedRows = await readExternalSessionMessages(session);
        // Re-check after the last await: from here to the end everything is
        // synchronous — one tick — so concurrent imports can't both create.
        const existing = store.findChatByExternalSession(project.id, agent, session.id);
        if (existing) {
          json(res, 200, { ok: true, chat: existing });
          return;
        }
        const chat = store.createChat(project.id, {
          title: session.title,
          harness: agent === 'codex' ? 'openai' : 'claude',
          externalAgent: agent,
          externalSessionId: session.id,
          externalCwd: session.cwd,
        });
        // `imported` marks the engine-already-knows boundary: resumed runs
        // send only rows after it (an interrupted transcript can end without
        // an assistant reply, so "after the last assistant" isn't enough).
        for (const row of importedRows) {
          store.appendChatMessage(project.id, chat.id, {
            role: row.role,
            content: row.content,
            metadata: { ...(row.metadata ?? {}), imported: true },
          });
        }
        json(res, 200, { ok: true, chat: store.getChat(chat.id) });
        return;
      }
      if (req.method === 'GET' && sub === '/chat-messages') {
        const chatId = url.searchParams.get('chatId') || '';
        const beforeRaw = url.searchParams.get('beforeSequence');
        // No `limit`: the window size is the store's own cap. Honouring the
        // caller's limit would shrink the chat UI's history (it asks for 200
        // and has no load-older path) to fix an export nobody has run yet.
        // A forward cursor means the caller is PAGING (the long-turn recovery
        // backfill): it needs the earliest rows after the cursor, not the
        // newest — otherwise every page returns the same tail and the middle
        // of a >1000-row local turn is never reachable. Cursorless reads keep
        // the newest window exactly as before.
        const afterSequence = Number(url.searchParams.get('afterSequence') || 0);
        const messages = store.listChatMessages(project.id, chatId, {
          afterSequence,
          beforeSequence: beforeRaw ? Number(beforeRaw) : null,
          fromOldest: afterSequence > 0,
        });
        const firstSequence = messages.length ? messages[0].sequence : null;
        json(res, 200, {
          ok: true,
          messages,
          page: { firstSequence, hasMore: store.hasEarlierChatMessage(project.id, chatId, firstSequence) },
        });
        return;
      }
      if (req.method === 'POST' && sub === '/chat-messages') {
        const body = await readBody(req);
        const chatId = typeof body.chatId === 'string' ? body.chatId : '';
        const content = typeof body.content === 'string' ? body.content : '';
        const chat = chatId ? store.getChat(chatId) : null;
        if (!chat || chat.project_id !== project.id) {
          json(res, 404, { ok: false, error: 'unknown chat' });
          return;
        }
        // clientId dedup mirrors the cloud route: the browser retries the POST
        // after auto-provisioning agent credentials, and the retry must reuse
        // the already-stored row instead of duplicating the message.
        const clientId = typeof body.clientId === 'string' ? body.clientId : null;
        // Cloud parity (app/api/workspace/messages/route.ts UUID_RE gate): a
        // UUID clientId is useChat's optimistic message id — persist it as the
        // row id so the live bubble and every history reload share ONE
        // identity. With a fresh row id, each reconcile-by-id merge re-added
        // the stored user row beside the optimistic copy: the same message
        // rendered twice, the id-orphaned bubble sunk to the transcript's
        // bottom. Non-UUID clientIds (comment:<id> deliveries) keep the
        // generated id, exactly like the cloud route.
        const rowIdFromClient =
          clientId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
            ? clientId
            : undefined;
        // Attachment metadata rides the message row (like the cloud route's
        // metadata.attachments) so chips survive reload/history reconcile.
        const attachments = Array.isArray(body.attachments) ? body.attachments : [];
        const message =
          store.findChatMessageByClientId(chatId, clientId) ??
          store.appendChatMessage(project.id, chatId, {
            id: rowIdFromClient,
            role: 'user',
            content,
            clientId,
            metadata: {
              author_user_id: 'local',
              ...(attachments.length > 0 ? { attachments } : {}),
            },
          });
        // The Claude/Codex engines run on the user's own local logins — cloud
        // credentials (sign-in + credits) gate only the cloud-step loop.
        const { harness, model: runModel } = runHarness(chat);
        const credentials = harness === 'vercel' ? store.getAgentCredentials() : null;
        if (harness === 'vercel' && !credentials) {
          json(res, 200, { ok: true, message, agentStart: { status: 'blocked', reason: 'credentials_missing' } });
          return;
        }
        // Absent/unrecognized falls back to 'suggest', matching the cloud
        // route — never fail open into silent direct writes.
        const requestedMode = ['view', 'suggest', 'edit'].includes(body.editMode) ? body.editMode : 'suggest';
        // A comment delivery is ALWAYS started in suggest — the commenter asked
        // for a reviewable change. This send REPLACES any parked comment run
        // and its turn answers that delivery too, so it inherits the stricter
        // boundary rather than applying the commenter's ask directly (Codex
        // P2). Only TRUSTED deliveries count: an untrusted (guest) one is
        // deferred out of this turn entirely, so it must not downgrade it.
        // …and only deliveries this turn can actually READ: one outside the
        // model window is trimmed away (and stamped unreachable by
        // onRunStarted), so it must not downgrade the send either.
        const answersPendingDelivery = () => {
          const visible = new Set(
            store
              .unservedCommentDeliveriesByVisibility(chatId, MODEL_HISTORY_WINDOW_ROWS)
              .visible.map((row) => row.id),
          );
          if (visible.size === 0) return false;
          return store
            .listChatMessages(project.id, chatId)
            .some((row) => visible.has(row.id) && row.metadata?.comment?.untrusted_author !== true);
        };
        // The cheap SQL probe first — the row scan only runs in the rare case.
        const editMode =
          requestedMode === 'edit' && store.hasUnservedCommentDelivery(chatId) && answersPendingDelivery()
            ? 'suggest'
            : requestedMode;
        agentHost.start({
          project,
          chatId,
          model: typeof body.model === 'string' && body.model ? body.model : runModel,
          harness,
          credentials,
          editMode,
          writeText: createAgentWriter({
            project, docHost, watchers, bridges, emit, chatId, editMode,
            authorId: engineAuthorId(harness),
          }),
        });
        json(res, 200, { ok: true, message, agentStart: { status: 'started' } });
        return;
      }
      if (req.method === 'GET' && sub === '/agent-stream') {
        const chatId = url.searchParams.get('chatId') || '';
        const run = agentHost.activeStream(chatId);
        if (!run) {
          json(res, 404, { ok: false, error: 'no active stream' });
          return;
        }
        const turnMessageId = agentHost.turnMessageId(chatId);
        const offset = Number(req.headers['last-event-id'] || 0);
        const resumeId = String(req.headers['x-resume-stream-id'] || '');
        // An offset below the eviction boundary can't be served completely.
        // Report the stream gone (410 → the transport reconciles from
        // persisted rows, which the loop fills as it streams) instead of
        // silently serving a hole:
        //  - a RESUME with an evicted cursor, run active or not — replaying
        //    the tail under the stale cursor would both skip the evicted
        //    middle for good and double-count the client's offset;
        //  - any offset on a FINISHED evicted stream — a cold reconnect
        //    would render tail+[DONE] as a seemingly complete reply.
        // A cold open (no cursor) on an ACTIVE run still gets the live tail:
        // it never saw the beginning, rows cover it, and attaching live is
        // the point of the request.
        const resuming = resumeId === run.id && offset > 0;
        const effectiveOffset = resuming ? offset : 0;
        if (effectiveOffset < run.evicted && (resuming || run.done)) {
          json(res, 410, { ok: false, error: 'replay window evicted' });
          return;
        }
        // The ABSOLUTE offset of this response's first byte. A cold attach on
        // an evicted active run starts at the eviction boundary, which the
        // client can't infer — without this its cursor counts from 0, later
        // resumes send relative offsets (fresh 410s though it was caught up)
        // and the mid-part boundary repair never arms.
        const servedFrom = Math.min(Math.max(effectiveOffset, run.evicted), run.length);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Stream-Id': run.id,
          'X-Stream-Offset': String(servedFrom),
          // The turn's persisted assistant id. A cold attach past the
          // eviction boundary never sees the stream's `start` chunk, so
          // without this the client mints its own id for the tail and the
          // history reconcile can't merge the canonical row onto it.
          ...(turnMessageId ? { 'X-Message-Id': turnMessageId } : {}),
          'Access-Control-Expose-Headers': 'X-Stream-Id, X-Stream-Offset, X-Message-Id',
        });
        // The offset only applies to the stream it was counted against.
        const unsubscribe = run.subscribe(res, effectiveOffset);
        req.on('close', unsubscribe);
        return;
      }
      if (req.method === 'POST' && sub === '/agent-interrupt') {
        const body = await readBody(req);
        {
          const stopChatId = String(body.chatId || '');
          const active = agentHost.interrupt(stopChatId);
          // Stop is TERMINAL for this chat's comment deliveries: without the
          // stamp the boot sweep would wake the agent for a turn the user
          // deliberately killed. (A cancel-and-REPLACE goes through start(),
          // not this route, so those stay unserved and transfer.)
          try {
            const stopped = store.getChat(stopChatId);
            if (stopped) {
              store.markCommentDeliveriesServed(stopped.project_id, store.unservedCommentDeliveryIds(stopChatId));
            }
          } catch {
            /* shutdown race */
          }
          json(res, 200, { ok: true, active });
        }
        return;
      }

      // ---- Doc comments (single local user; author snapshot comes from the
      // signed-in browser so echoes reconcile with optimistic renders).
      // Paths covered by an ACTIVE share read from and write to the CLOUD
      // backing workspace's threads (bridges.* helpers): link guests only
      // ever see that store, so a local-only row would be invisible to them
      // — and their comments invisible here. Everything else stays local. --
      if (sub === '/comments') {
        const localAuthor = (candidate) =>
          candidate && typeof candidate === 'object' && typeof candidate.userId === 'string'
            ? candidate
            : { userId: 'local', name: null, username: null, imageUrl: null };
        // Same order both stores use: open first, newest activity first —
        // keeps the POST contract that threads[0] is the just-created one.
        const mergeThreads = (path, cloudRaw) => {
          const local = store.listCommentThreads(project.id, { path: path || null });
          // Cloud rows carry no local chat link — overlay it so "Open chat"
          // works on share-covered threads too. A CLOUD chat id (minted by
          // cloud Sunny) means nothing to this sidecar's UI: replace it with
          // the local link (or null) so the client never no-ops on it.
          const cloud = cloudRaw.map((t) =>
            t.chatId && store.getChat(t.chatId)?.project_id === project.id
              ? t
              : { ...t, chatId: store.getCommentThreadChatLink(t.id) },
          );
          if (cloud.length === 0) return local;
          return [...local, ...cloud].sort(
            (a, b) =>
              (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) ||
              (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0),
          );
        };
        const threadsFor = async (path) =>
          mergeThreads(path, await bridges.listCloudCommentThreads(project.id, path || null));
        if (req.method === 'GET') {
          const rel = url.searchParams.get('path');
          json(res, 200, { ok: true, threads: await threadsFor(rel ? normalizeRelPath(rel) : null) });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const rel = normalizeRelPath(String(body.path || ''));
          const quote = typeof body.quote === 'string' ? body.quote.trim() : '';
          const text = typeof body.body === 'string' ? body.body.trim() : '';
          if (!rel || !quote || !text || !body.anchor || !body.head) {
            json(res, 400, { ok: false, error: 'path, quote, anchor, head, and body are required' });
            return;
          }
          const args = { quote, anchor: body.anchor, head: body.head, body: text, author: localAuthor(body.author) };
          const engine = bridges.commentEngineFor(project.id, rel);
          if (engine) {
            // Fail loudly on cloud failure — a local fallback row would be
            // invisible to every link guest, silently forking the thread.
            // On success, answer from the mirror's own echo: a second cloud
            // read could time out and drop the just-persisted comment.
            let echo;
            try {
              echo = await engine.mutateCloudComment('POST', { filePath: rel, ...args });
            } catch (error) {
              // Unless THIS request proved the cloud has no mirror at all
              // (older deployment): keep the comment locally rather than
              // losing it — exactly how this share behaved before the mirror.
              // Any other failure still fails loudly: the cloud may have
              // persisted it, and a local twin would fork the thread.
              if (!error?.commentsMirrorMissing) {
                json(res, 502, { ok: false, error: error?.message || 'Cloud comment create failed' });
                return;
              }
              echo = null;
            }
            if (echo === null) {
              store.createCommentThread(project.id, { path: rel, ...args });
              emit(project.id, { type: 'comments-changed', path: rel });
              json(res, 200, { ok: true, threads: await threadsFor(rel) });
              return;
            }
            emit(project.id, { type: 'comments-changed', path: rel });
            // threads[0] is the contract the browser binds its optimistic card
            // to, and the two stores keep INDEPENDENT clocks: a local row with
            // a skewed (or future) timestamp could sort above the fresh cloud
            // echo. Pin the created thread — echo[0], newest on the cloud's own
            // clock — and merge the rest behind it.
            // Bind to OUR insertion: the echo is the full list sorted by
            // updatedAt, so echo[0] can be a CONCURRENT request's thread. The
            // mirror names our rows (`echo.inserted`); content matching is the
            // fallback for pre-`inserted` mirrors. No match ⇒ no trigger
            // rather than waking the wrong thread.
            const inserted =
              (echo.inserted && echo.find((t) => t.id === echo.inserted.threadId)) ??
              echo.find((t) => t.messages?.[0]?.body === text && t.author?.userId === args.author.userId);
            // Delivered inline as the OWNER — the poll must not re-observe a
            // HANDLED delivery as guest activity and fan it to watchers. A
            // failed inline delivery stays unseen so the poll retries it
            // (watchers-only there — better than lost).
            if (inserted) {
              const handled = triggerCommentAgents({
                project,
                thread: {
                  id: inserted.id,
                  chatId: inserted.chatId ?? store.getCommentThreadChatLink(inserted.id),
                  filePath: rel,
                  quote: inserted.quote,
                },
                messageId: echo.inserted?.messageId ?? inserted.messages?.[0]?.id ?? inserted.id,
                body: text,
                author: args.author,
                isNewThread: true,
              });
              if (handled) engine.markCommentMessageSeen?.(echo.inserted?.messageId ?? inserted.messages?.[0]?.id);
            }
            // threads[0] is the contract the browser binds its optimistic card
            // to — pin OUR created thread when the mirror names it.
            const created = inserted ?? echo[0];
            const rest = echo.filter((t) => t !== created);
            json(res, 200, {
              ok: true,
              threads: created ? [created, ...mergeThreads(rel, rest)] : mergeThreads(rel, echo),
            });
            return;
          }
          const { threadId, messageId } = store.createCommentThread(project.id, { path: rel, ...args });
          emit(project.id, { type: 'comments-changed', path: rel });
          triggerCommentAgents({
            project, thread: store.getCommentThread(threadId), messageId, body: text, author: args.author, isNewThread: true,
          });
          json(res, 200, { ok: true, threads: await threadsFor(rel) });
          return;
        }
        // PATCH (reply/edit/resolve/reopen) and DELETE (message; index 0
        // deletes the thread) — mirrors the cloud route's action semantics.
        const body = await readBody(req);
        const threadId = String(body.threadId || '');
        const thread = threadId ? store.getCommentThread(threadId) : null;
        if (thread && thread.projectId !== project.id) {
          json(res, 404, { ok: false, error: 'Comment thread not found' });
          return;
        }
        if (!thread) {
          // Not a local row — a cloud thread on a shared path (guest- or
          // owner-authored), mutated in the backing store so both sides see it.
          const remote = await bridges.findCloudCommentThread(project.id, threadId);
          if (!remote) {
            json(res, 404, { ok: false, error: 'Comment thread not found' });
            return;
          }
          // Rename re-anchor: the UI sends the file's CURRENT path — forward
          // it (translated by mutateCloudComment) so the cloud row follows a
          // rename and stays inside guests' live-path filter, and reload
          // against it rather than the cached (possibly stale) thread path.
          const requestedPath =
            typeof body.filePath === 'string' && body.filePath.trim()
              ? normalizeRelPath(body.filePath)
              : null;
          const currentPath = requestedPath || remote.thread.filePath;
          const forward =
            req.method === 'PATCH'
              ? {
                  method: 'PATCH',
                  payload: {
                    threadId,
                    filePath: currentPath,
                    action: String(body.action || ''),
                    messageId: String(body.messageId || '') || undefined,
                    body: typeof body.body === 'string' ? body.body.trim() : undefined,
                    author: localAuthor(body.author),
                  },
                }
              : req.method === 'DELETE'
                ? {
                    method: 'DELETE',
                    payload: { threadId, filePath: currentPath, messageId: String(body.messageId || '') },
                  }
                : null;
          if (!forward) {
            json(res, 404, { ok: false, error: 'not found' });
            return;
          }
          let echo;
          try {
            echo = await remote.engine.mutateCloudComment(forward.method, forward.payload);
          } catch (error) {
            json(res, 502, { ok: false, error: error?.message || 'Cloud comment update failed' });
            return;
          }
          // The mirror decides the authoritative path (it ignores a re-anchor
          // onto a DIFFERENT file, e.g. All-comments mode sending the active
          // file) — answer where the echo says the thread lives.
          const echoPath = echo[0]?.filePath ?? remote.thread.filePath;
          emit(project.id, { type: 'comments-changed', path: echoPath });
          // A human reply on a share-covered thread wakes agents like a local
          // one would (linked thread chat, watchers). The echo is the full
          // sorted list — bind to the REQUESTED thread, never echo[0].
          const replied =
            forward.method === 'PATCH' && forward.payload.action === 'reply'
              ? echo.find((t) => t.id === forward.payload.threadId)
              : null;
          // Same inline-delivery marking as the create path: seen only once
          // handled, so a failed delivery falls back to the poll.
          if (replied) {
            const handled = triggerCommentAgents({
              project,
              thread: {
                id: replied.id,
                chatId: replied.chatId ?? store.getCommentThreadChatLink(replied.id),
                filePath: replied.filePath ?? echoPath,
                quote: replied.quote,
              },
              // The mirror names the inserted reply; last-message is only the
              // pre-`inserted` fallback (a concurrent reply could sort last).
              messageId: echo.inserted?.messageId ?? replied.messages?.at(-1)?.id ?? `${replied.id}:${replied.updatedAt}`,
              body: forward.payload.body ?? '',
              author: forward.payload.author,
              isNewThread: false,
            });
            if (handled) remote.engine.markCommentMessageSeen?.(echo.inserted?.messageId ?? replied.messages?.at(-1)?.id);
          }
          json(res, 200, { ok: true, threads: mergeThreads(echoPath, echo) });
          return;
        }
        if (req.method === 'PATCH') {
          const action = String(body.action || '');
          const text = typeof body.body === 'string' ? body.body.trim() : '';
          if (action === 'reply') {
            if (!text) {
              json(res, 400, { ok: false, error: 'body is required for replies' });
              return;
            }
            const author = localAuthor(body.author);
            const messageId = store.addCommentMessage(threadId, { body: text, author });
            triggerCommentAgents({ project, thread, messageId, body: text, author, isNewThread: false });
          } else if (action === 'edit') {
            const messageId = String(body.messageId || '');
            if (!messageId || !text) {
              json(res, 400, { ok: false, error: 'messageId and body are required for edits' });
              return;
            }
            if (!store.editCommentMessage(threadId, messageId, text)) {
              json(res, 404, { ok: false, error: 'Comment message not found' });
              return;
            }
          } else if (action === 'resolve' || action === 'reopen') {
            store.setCommentThreadStatus(
              threadId,
              action === 'resolve' ? 'resolved' : 'open',
              localAuthor(body.author).userId,
            );
          } else {
            json(res, 400, { ok: false, error: 'Unsupported action' });
            return;
          }
        } else if (req.method === 'DELETE') {
          if (!store.deleteCommentMessage(threadId, String(body.messageId || ''))) {
            json(res, 404, { ok: false, error: 'Comment message not found' });
            return;
          }
        } else {
          json(res, 404, { ok: false, error: 'not found' });
          return;
        }
        emit(project.id, { type: 'comments-changed', path: thread.filePath });
        json(res, 200, { ok: true, threads: await threadsFor(thread.filePath) });
        return;
      }

      if (req.method === 'POST' && sub === '/compile') {
        const body = await readBody(req);
        const rel = normalizeRelPath(body.path || '');
        if (!rel || isIgnoredPath(rel) || !rel.toLowerCase().endsWith('.tex')) {
          json(res, 400, { ok: false, error: 'path must be a .tex file' });
          return;
        }
        json(res, 200, await compileLatexLocally({
          project,
          relPath: rel,
          source: typeof body.source === 'string' ? body.source : undefined,
          docHost,
          watchers,
          emit,
        }));
        return;
      }
      if (req.method === 'POST' && sub === '/shares') {
        const body = await readBody(req);
        // Same rewrite as /agent-credentials: a loopback apiOrigin is the
        // page's own origin (a dev server, or this sidecar's proxy) — the
        // share must call the real cloud, or its REST half (poll, deletes,
        // creates) dies whenever that local server does.
        if (remoteOrigin && typeof body.apiOrigin === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(body.apiOrigin.trim().replace(/\/$/, ''))) {
          body.apiOrigin = remoteOrigin;
        }
        // grants: true = grants-model scope on the project's single hidden
        // backing workspace (audiences live in cloud path_shares grants). The
        // legacy one-workspace-per-scope share is READ/STOP only now: rows
        // that predate the grants model keep syncing, but nothing creates
        // new ones (SIDECAR_API_VERSION already forces a matching app).
        if (body.grants !== true) {
          json(res, 400, { ok: false, error: 'grants: true is required; legacy per-scope shares are retired' });
          return;
        }
        const share = await bridges.addShareScope(project.id, body);
        emit(project.id, { type: 'shares-changed' });
        json(res, 200, { ok: true, share });
        return;
      }
      if (req.method === 'POST' && sub === '/shares/confirm') {
        // Mint-confirm: "is this scope still recorded?", answered under the
        // per-project lock — the app calls it right after minting a grant and
        // revokes its own mint when the scope died mid-flight (see bridge).
        const body = await readBody(req);
        const { live, generation } = await bridges.confirmShareScope(project.id, {
          workspaceId: String(body.workspaceId || ''),
          scopeKind: String(body.scopeKind || ''),
          scopePath: String(body.scopePath || ''),
        });
        json(res, 200, { ok: true, live, generation });
        return;
      }
      if (req.method === 'DELETE' && /^\/shares\/[^/]+$/.test(sub)) {
        const shareId = sub.split('/')[2];
        // ?revoked=1 = the caller already revoked the scope's cloud audience
        // with user auth (the modal does, fail-closed, before calling this) —
        // skip the sidecar's own bridge-token revoke, which would brick the
        // stop on a stale token for an audience that is already gone.
        // body.token = a fresh user-minted bridge token for the last-scope
        // bulk revoke, so it never depends on the stored (stale) one.
        const body = await readBody(req).catch(() => ({}));
        if (shareId.startsWith('scope:')) {
          await bridges.removeShareScope(project.id, Number(shareId.slice(6)), {
            revoked: url.searchParams.get('revoked') === '1',
            freshToken: typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null,
          });
        } else await bridges.removeShare(project.id, shareId);
        emit(project.id, { type: 'shares-changed' });
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && /^\/shares\/[^/]+\/token$/.test(sub)) {
        // Cloud sync tokens expire after 7 days; the app re-mints one whenever
        // it opens a shared project and hands it here.
        const body = await readBody(req);
        const shareId = sub.split('/')[2];
        if (body.refresh === true) await bridges.refreshMcpShare(project.id, shareId);
        else bridges.refreshShareToken(project.id, shareId, String(body.token || ''));
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { ok: false, error: 'not found' });
    })().catch((error) => {
      json(res, error?.status || 500, { ok: false, error: error?.message || 'internal error' });
    });
  };

  const server = http.createServer(handleRequest);
  // Dedicated events-plane listener: the browser caps HTTP/1.1 at 6
  // connections PER ORIGIN, and the long-lived /events stream permanently
  // held one of the data plane's. A second loopback port is its own browser
  // pool — and unlike a `localhost` alias (whose ::1 may belong to a foreign
  // process), this bind proves the sidecar owns the address the per-install
  // token gets sent to. Same handler, same token gate; advertised on /health,
  // best-effort (no events plane = clients stay on the primary origin).
  const eventsServer = http.createServer(handleRequest);
  let eventsPort = null;
  // Self-update wiring for the serve.mjs daemon (main() installs it after
  // boot via handle.setSelfUpdate): the loaded-bundle hash for /health and
  // the on-demand re-check behind POST /self-update/check.
  let selfUpdateInfo = null;

  server.on('upgrade', (request, socket, head) => {
    // The same rebinding gate as the HTTP path. It matters MORE here: a
    // WebSocket handshake is not subject to CORS at all, so Host is the only
    // thing standing between a rebound page and the collab socket.
    if (!isLoopbackHost(request.headers.host)) {
      socket.destroy();
      return;
    }
    docHost.server.webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      docHost.hocuspocus.handleConnection(ws, request);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actualPort = server.address().port;
  boundPort = actualPort;
  await new Promise((resolve) => {
    eventsServer.once('error', () => resolve());
    eventsServer.listen(0, '127.0.0.1', () => {
      eventsPort = eventsServer.address().port;
      resolve();
    });
  });
  log(`listening on 127.0.0.1:${actualPort}${eventsPort ? ` (events on :${eventsPort})` : ''}${remoteOrigin ? ` (proxying ${remoteOrigin})` : ''}`);

  // Now that the port is up (the shell's readiness probe), resume cloud share
  // bridges in the background; requests never depended on it having finished.
  // The live-edit horizon is watcher activation, not bind (see above).
  const bridgesResumed = bridges
    .resumeAll({ interactiveSince: watchersActiveAt })
    .catch((error) => log(`bridge resume failed error=${error?.message}`));

  const close = async () => {
    diagnostics.stop();
    // Bash children run in their OWN process groups so Stop can kill the whole
    // tree — which also means they no longer die alongside the sidecar on
    // Ctrl-C. Signal them explicitly or they outlive the process.
    agentHost.abortAllTools();
    await docHost.flushAll();
    await bridges.stopAll();
    for (const watcher of watchers.values()) watcher.close();
    for (const clients of sseClients.values()) for (const res of clients) res.end();
    // Destroy Hocuspocus BEFORE closing the store: closing connections fires
    // async onStoreDocument hooks, which must not hit a closed database.
    await docHost.server.destroy().catch(() => {});
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => eventsServer.close(() => resolve()));
    // stopAll() above cancelled the background resume loop, so this joins at
    // most ONE in-flight engine.start() — after the port is already released
    // (shutdown stays fast) but before the store closes under it.
    await bridgesResumed;
    store.close();
  };

  const setSelfUpdate = (info) => {
    selfUpdateInfo = info;
    loadedBundleHash = info?.bundleHash ?? null;
  };

  return { server, store, docHost, agentHost, bridges, bridgesResumed, watchers, token, port: actualPort, eventsPort, home, close, setSelfUpdate };
}

// fileURLToPath, not URL.pathname: a packaged install can live under a path
// with spaces/non-ASCII, which pathname percent-encodes and never matches.
// realpathSync: Node resolves the entry module through symlinks (macOS /tmp,
// /var), so argv[1] must be resolved the same way or they never match.
const argvPath = (() => {
  if (!process.argv[1]) return null;
  const resolved = path.resolve(process.argv[1]);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
})();
const isMain = argvPath === fileURLToPath(import.meta.url);
if (isMain) {
  // Validate before installing handlers or touching the sidecar home. In
  // particular, help and malformed invocations must never boot/register/share.
  let cli;
  try {
    cli = parseSidecarArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof SidecarCliError ? error.message : String(error);
    console.error(`sundial serve.mjs: ${message}\n\n${SIDECAR_USAGE}`);
    process.exit(2);
  }
  if (cli.help) {
    console.log(SIDECAR_USAGE);
    process.exit(0);
  }
  // Node's default handling would crash with the stack on stderr only — a
  // Finder-launched app has no stderr, so mirror it into sidecar.log first.
  const fatal = (kind) => (error) => {
    // @hocuspocus/provider tears down a still-connecting bridge socket by
    // calling ws.close() before the handshake finished, which ws throws for —
    // asynchronously, so no callsite can catch it. It's a benign teardown
    // race, not a corrupted process; dying here killed every open chat.
    if (String(error?.message).includes('WebSocket was closed before the connection was established')) {
      try {
        fs.appendFileSync(
          path.join(defaultHome(), 'sidecar.log'),
          `${new Date().toISOString()} [warn] ignored benign ${kind}: ${error?.message}\n`,
        );
      } catch { /* home unwritable */ }
      return;
    }
    try {
      fs.appendFileSync(
        path.join(defaultHome(), 'sidecar.log'),
        `${new Date().toISOString()} [fatal] ${kind}: ${error?.stack || error}\n`,
      );
    } catch { /* home unwritable */ }
    console.error(`[sundial-local] ${kind}:`, error);
    process.exit(1);
  };
  process.on('uncaughtException', fatal('uncaughtException'));
  process.on('unhandledRejection', fatal('unhandledRejection'));
  // --share <folder>: headless mode (the curl-distributed serve.sh). After
  // boot, register the folder, wire it into an anon-owned cloud share, and
  // print the workspace link. The cloud origin rides SUNDIAL_REMOTE_ORIGIN —
  // the same env the proxy already uses, exported by serve.sh.
  const shareFolder = cli.share ? path.resolve(cli.share) : null;
  // --workspace <url|slug|uuid>: attach the folder to an EXISTING workspace
  // (a URL's anon= key authorizes it) instead of creating one. The bridge's
  // first sync produces the union of both sides; same-path conflicts keep
  // the local version.
  const attachWorkspace = cli.workspace;
  // --install: write a login unit (LaunchAgent / systemd user unit) that
  // keeps ONE daemon alive across restarts — boot resumes every shared
  // folder from the ledger, so the unit needs no per-folder arguments.
  // --uninstall removes it. Both handled before any daemon work.
  // Persistence is the DEFAULT for --share runs: syncing a folder means it
  // survives reboots and self-updates. --no-install keeps a one-off
  // foreground session; --install remains as a (redundant) alias. Never
  // under supervision (the login unit's own daemon must not re-install),
  // and only where a login unit exists to write.
  // Probed, not just platform-gated: Linux without a live systemd user
  // manager (WSL, servers) once STOPPED the running sync mid-install. When
  // the probe fails, sync stays a foreground session and says so loudly.
  const { persistenceAvailable } = await import('./persist.mjs');
  const persistProbe = persistenceAvailable();
  const persistSupported = persistProbe.ok;
  const wantsInstall =
    shareFolder !== null &&
    persistSupported &&
    !cli.noInstall &&
    !cli.supervised;
  if (cli.uninstall) {
    const { uninstallPersistence } = await import('./persist.mjs');
    console.log(`[sundial-local] ${uninstallPersistence({ log: console.error, home: defaultHome() })}`);
    process.exit(0);
  }
  // Run the headless share against a daemon (ours or a peer's) and print the
  // link. Never arms refresh itself — that is the SERVER daemon's job
  // (armSharesRefresh), so a deferring run can call this and then exit safely.
  const shareAndReport = async (localOrigin, localToken) => {
    const app = (process.env.SUNDIAL_REMOTE_ORIGIN || '').trim().replace(/\/$/, '');
    if (!app) {
      console.error('[sundial-local] --share needs SUNDIAL_REMOTE_ORIGIN (the cloud origin)');
      process.exit(1);
    }
    const { runHeadlessShare } = await import('./headless.mjs');
    try {
      const result = await runHeadlessShare({
        localOrigin,
        localToken,
        app,
        folder: shareFolder,
        home: defaultHome(),
        ...(attachWorkspace ? { workspace: attachWorkspace } : {}),
        ...(cli.mcpGrant ? { mcpGrant: cli.mcpGrant } : {}),
      });
      console.log(`[sundial-local] sharing ${shareFolder}`);
      console.log(`Workspace: ${result.url}`);
      console.log(
        result.anon
          ? 'Edits sync both ways. The link carries ownership: whoever opens it holds the workspace; signing in keeps it synced.'
          : 'Edits sync both ways, attributed to your signed-in Sundial account.',
      );
      const panelSep = result.url.includes('?') ? '&' : '?';
      console.log(
        `Side panel: ${result.url}${panelSep}view=panel renders one surface at a time for split views (add &filePath=<file> to pick; a .pdf path shows compiled output).`,
      );
      // Two credentials, two audiences: the link above is the HUMAN's
      // ownership handoff; this token is the AGENT's own rail credential
      // (edit-capable where the key is review-only, e.g. resolving
      // comments). Exposure adds nothing: the anon key in the link is
      // strictly stronger. Re-running this command reprints a fresh one.
      if (!result.mcp && result.token) {
        console.log(
          `Agent credential: authenticate /g ops with token=${result.token} (edit-capable, 7 days; re-run to reprint). The anon= link is the human's.`,
        );
      }
      return result;
    } catch (error) {
      console.error(`[sundial-local] share failed: ${error?.message}`);
      process.exit(1);
    }
  };
  // Install the login unit and confirm it took the port. The caller must
  // have released the port first (see persist.mjs). Exits the process on
  // success; returns false when the install itself failed, so the caller
  // can resume syncing in the foreground — an install failure must NEVER
  // leave sync dead (the exact WSL outcome that shipped a broken session).
  const installAndConfirm = async (port) => {
    const { installPersistence } = await import('./persist.mjs');
    let summary;
    try {
      summary = installPersistence({
        node: process.execPath,
        bundle: path.resolve(process.argv[1]),
        app: (process.env.SUNDIAL_REMOTE_ORIGIN || '').trim().replace(/\/$/, ''),
        home: defaultHome(),
        port,
        log: console.error,
      });
    } catch (error) {
      console.error(
        `[sundial-local] PERSISTENCE INSTALL FAILED: ${error?.message}. ` +
          `Sync will continue in THIS process; keep it running. ` +
          `Fix the login service (Linux needs a systemd user session; on WSL add "[boot]\\nsystemd=true" to /etc/wsl.conf and restart the distro), then re-run this command to install.`,
      );
      return false;
    }
    console.log(`[sundial-local] ${summary}`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json()).catch(() => null);
      if (health?.service === 'sundial-local') {
        console.log('[sundial-local] login service is up; sync now survives restarts and log-outs.');
        process.exit(0);
      }
    }
    console.log('[sundial-local] unit installed but not up yet — it starts at next login; re-run without --install to sync now.');
    process.exit(0);
  };
  const boot = () => startLocalServer({ exitOnShutdown: true });
  let handle = await boot().catch(async (error) => {
    if (error?.code !== 'EADDRINUSE') throw error;
    // An earlier instance (e.g. a previous shell launch) is already serving.
    // Same install → same token file, so that instance works for us too:
    // defer to it instead of crash-splatting into the shell's console. But
    // only if OUR token actually works there — deferring to a foreign
    // instance (stale checkout, other install) leaves the app permanently
    // unauthorized against a "healthy" sidecar.
    const port = Number(process.env.SUNDIAL_LOCAL_PORT || 4848);
    const fail = (message) => {
      console.error(`[sundial-local] ${message}`);
      // Packaged installs have no visible stdout — mirror into sidecar.log so
      // a port collision is diagnosable (/local otherwise just "isn't responding").
      try { fs.appendFileSync(path.join(defaultHome(), 'sidecar.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* home unwritable */ }
      process.exit(1);
    };
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json()).catch(() => null);
    const listenerOk = health?.service === 'sundial-local';
    // Derive our token exactly like startLocalServer: env override, else the
    // per-install token file. No readable token means the listener cannot be
    // this install — a same-install instance would have written the file.
    let ourToken = (process.env.SUNDIAL_LOCAL_TOKEN || '').trim();
    if (!ourToken) {
      try { ourToken = fs.readFileSync(path.join(defaultHome(), 'token'), 'utf8').trim(); } catch { /* no token file */ }
    }
    const authorized = listenerOk && ourToken
      ? await fetch(`http://127.0.0.1:${port}/projects`, { headers: { Authorization: `Bearer ${ourToken}` } })
          .then((res) => res.ok)
          .catch(() => false)
      : false;
    const ourRemoteOrigin = (process.env.SUNDIAL_REMOTE_ORIGIN || '').trim().replace(/\/$/, '');
    const sameDeployment = String(health?.remoteOrigin ?? '\0') === ourRemoteOrigin;
    const deferOk = authorized && (health?.apiVersion ?? 1) >= SIDECAR_API_VERSION && sameDeployment;
    // `--install` rerun while a same-install daemon owns the port: the defer
    // and share-handoff exits below would skip the fresh-start install block,
    // leaving the user with no unit (sync still dies with the terminal). Stop
    // the peer first (the unit's supervised copy must win the port, see
    // persist.mjs) and install; the unit resumes every share from the ledger,
    // so nothing the peer served is lost.
    const installOverPeer = async () => {
      // Already the login service's daemon (or its unit is on disk and a
      // healthy same-install peer holds the port): there is nothing to
      // install — say so and succeed. The old takeover shut the peer down,
      // the unit relaunched it inside the poll window, and a fully healthy
      // setup exited 1 with "could not stop the daemon" (live 2026-08-26).
      const { persistenceInstalled } = await import('./persist.mjs');
      if (health?.supervised === true || persistenceInstalled(defaultHome())) {
        console.log('[sundial-local] the login service already runs this daemon; nothing to install.');
        process.exit(0);
      }
      console.log(`[sundial-local] handing the daemon on port ${port} over to the login service`);
      await fetch(`http://127.0.0.1:${port}/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ourToken}` },
      }).catch(() => null);
      let alive = true;
      for (let attempt = 0; alive && attempt < 25; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        alive = await fetch(`http://127.0.0.1:${port}/health`).then(() => true).catch(() => false);
      }
      if (alive) {
        if (persistenceInstalled(defaultHome())) {
          console.log('[sundial-local] the login service relaunched the daemon; it already owns this sync.');
          process.exit(0);
        }
        fail(`could not stop the daemon on port ${port}; quit it and re-run with --install`);
      }
      // installAndConfirm exits the process on success — reaching past it
      // means the unit failed to install AND the peer is already stopped,
      // so become the daemon ourselves rather than leaving nothing running.
      if ((await installAndConfirm(port)) === false) {
        console.error('[sundial-local] becoming the daemon for this session instead; sync continues.');
        return await boot();
      }
      return null;
    };

    // Headless `--share`: a running instance is the user's, so NEVER evict it
    // for a share. Defer through it when safe; otherwise refuse with guidance.
    if (shareFolder) {
      if (!listenerOk) fail(`port ${port} is taken by something else — cannot share this folder`);
      if (!deferOk) {
        fail(
          `another Sundial is running on port ${port} but I can't safely sync through it ` +
            `(different version or deployment). Quit it and re-run, or share this folder from that app.`,
        );
      }
      if (health.signedIn && !cli.mcpGrant && !attachWorkspace) {
        // A signed-in instance owns the port and this run names no workspace,
        // so it would mint a fresh anon backing workspace and inject it — which
        // surfaces as a workspace the signed-in user can't own (owner actions
        // 403). Point them at the app's Share, which owns it properly. An
        // explicit --workspace attach is exempt: it targets an existing
        // workspace and wires through shareAndReport below, where the peer's
        // parked credentials (or the ref's key) attach it under the right
        // identity — never an un-ownable phantom.
        console.log(
          `[sundial-local] the Sundial app is already running here. Open ${shareFolder} in the app and ` +
            `click Share to sync it under your account.`,
        );
        process.exit(0);
      }
      // A headless peer serve.sh owns the port and runs the refresh loop —
      // but it may still EXECUTE an older bundle than the one this run just
      // downloaded (its own re-check ticks every 6h, and serve.sh already
      // overwrote the file). Nudge it: when its loaded hash differs from
      // ours, it re-checks now, and a supervised peer relaunches onto the
      // new code before we wire the share through it. Best effort — an old
      // peer without the endpoint still shares fine, one bundle behind.
      try {
        const { sha256Hex } = await import('./update.mjs');
        const ourHash = sha256Hex(await fsp.readFile(path.resolve(process.argv[1] ?? '')));
        if (health?.bundleHash !== ourHash) {
          const nudge = await fetch(`http://127.0.0.1:${port}/self-update/check`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${ourToken}` },
          }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
          if (nudge?.status === 'applied' && nudge.willRestart) {
            console.log('[sundial-local] the running Sundial is updating itself; waiting for it to come back');
            for (let attempt = 0; attempt < 60; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              const back = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json()).catch(() => null);
              if (back?.service === 'sundial-local' && back.bundleHash === ourHash) break;
            }
          }
        }
      } catch { /* nudge is never load-bearing */ }
      // Wire our folder through the peer and exit — it keeps the token fresh.
      await shareAndReport(`http://127.0.0.1:${port}`, ourToken);
      if (wantsInstall) {
        // A non-null return means the unit failed and we booted in the
        // peer's place (loudly reported inside): stay alive as the daemon.
        const recovered = await installOverPeer();
        if (recovered) return recovered;
      }
      console.log('[sundial-local] a Sundial is already running here and now syncs this folder too.');
      console.log('Persistence follows that running session. To pin sync to a login service, quit it and re-run this command.');
      process.exit(0);
    }

    if (listenerOk) {
      if (authorized) {
        // Deferring is only safe when the listener serves the SAME deployment:
        // a same-version sidecar proxying another cloud (a staging build's
        // leftover) would strand this app on the wrong env — the webview
        // proxies whatever the listener points at. Older instances don't
        // report remoteOrigin (undefined) — treat as mismatch and replace.
        if (deferOk) {
          if (wantsInstall) {
            const recovered = await installOverPeer();
            if (recovered) return recovered;
          }
          console.log(`[sundial-local] another instance already serves 127.0.0.1:${port}; deferring to it`);
          process.exit(0);
        }
        // Same install but OLDER code (it lacks endpoints the app depends on;
        // deferring is how "unknown project" reached the create dialog) or a
        // DIFFERENT deployment — replace it: ask politely (newer instances
        // expose /shutdown), then SIGTERM the listener — TERM runs its
        // flush-and-exit handler, so nothing is lost.
        console.log(
          sameDeployment
            ? `[sundial-local] outdated instance (apiVersion ${health.apiVersion ?? 1} < ${SIDECAR_API_VERSION}) on port ${port}; replacing it`
            : `[sundial-local] instance on port ${port} proxies "${health.remoteOrigin ?? 'unknown'}" but we need "${ourRemoteOrigin}"; replacing it`,
        );
        await fetch(`http://127.0.0.1:${port}/shutdown`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ourToken}` },
        }).catch(() => null);
        if (process.platform !== 'win32') {
          try {
            const { execFileSync } = await import('node:child_process');
            // -sTCP:LISTEN is load-bearing: without it lsof also lists CLIENTS
            // of the port (the shell, the webview, a test runner) and we'd
            // SIGTERM them along with the listener.
            const pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
              .split('\n')
              .map((pid) => Number(pid.trim()))
              .filter((pid) => pid && pid !== process.pid);
            for (const pid of pids) {
              try { process.kill(pid, 'SIGTERM'); } catch { /* raced its own exit */ }
            }
          } catch { /* already gone, or no lsof — the retry loop decides */ }
        }
        for (let attempt = 0; attempt < 25; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          try {
            return await boot();
          } catch (retryError) {
            if (retryError?.code !== 'EADDRINUSE') throw retryError;
          }
        }
        fail(`could not replace the outdated instance on port ${port} — quit the other Sundial and relaunch`);
      }
      fail(`an instance on 127.0.0.1:${port} rejects our token (foreign install?) — quit it or free the port`);
    }
    fail(`port ${port} is taken by something else — local projects unavailable`);
  });
  if (cli.printToken) console.log(`token: ${handle.token}`);
  // We are the server daemon. Wire the folder (if any), then arm the
  // daemon-side refresh whenever a headless identity exists — NOT only on
  // --share runs: a login-unit relaunch passes no folder, resumes every
  // share from the ledger, and still owes each one its daily re-mint.
  const remoteApp = (process.env.SUNDIAL_REMOTE_ORIGIN || '').trim().replace(/\/$/, '');
  let refreshTimer = null;
  if (shareFolder) {
    await shareAndReport(`http://127.0.0.1:${handle.port}`, handle.token);
    if (!wantsInstall) {
      const wantedButUnavailable =
        !persistProbe.ok && !cli.noInstall && !cli.supervised;
      console.log(
        wantedButUnavailable
          ? `PERSISTENCE UNAVAILABLE on this system: ${persistProbe.reason} ` +
            `Sync runs ONLY while this process stays alive; keep it running and re-run this command after fixing the login service.`
          : persistSupported && !cli.supervised
            ? 'One-off session (--no-install): sync stops when this process exits. Re-run without --no-install to make it survive reboots.'
            : 'Sync runs while this process runs.',
      );
    }
  }
  // Arm whenever a cloud origin exists: shares minted with the signed-in
  // account (mint_kind 'user') need the sweep even when no anon identity was
  // ever created; the sweep itself skips what it cannot mint.
  const { armSharesRefresh } = await import('./headless.mjs');
  if (remoteApp) {
    refreshTimer = armSharesRefresh({
      localOrigin: `http://127.0.0.1:${handle.port}`,
      localToken: handle.token,
      app: remoteApp,
      home: defaultHome(),
      log: console.error,
    });
  }
  if (wantsInstall) {
    // Hand the daemon over to the login unit: release the port FIRST (a
    // supervised copy that boots into the defer/exit path would be throttled
    // as a crash loop), then install + start the unit and confirm health.
    if (refreshTimer) clearInterval(refreshTimer);
    await handle.close().catch(() => {});
    if ((await installAndConfirm(Number(process.env.SUNDIAL_LOCAL_PORT || 4848))) === false) {
      // The unit failed to install (reported loudly inside). Resume as the
      // foreground daemon: the one unforgivable outcome is a dead sync.
      handle = await boot();
      if (remoteApp) {
        refreshTimer = armSharesRefresh({
          localOrigin: `http://127.0.0.1:${handle.port}`,
          localToken: handle.token,
          app: remoteApp,
          home: defaultHome(),
          log: console.error,
        });
      }
    }
  }
  const shutdown = async (signal) => {
    console.log(`[sundial-local] ${signal}; flushing`);
    if (refreshTimer) clearInterval(refreshTimer);
    await handle.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // Self-update — but ONLY when running the curl-distributed bundle (named
  // serve.mjs): a repo checkout or the desktop app's resources/server.mjs
  // must never overwrite itself with the web bundle (the desktop updater
  // owns that copy). Supervised daemons (--supervised, set by the login
  // unit) restart onto the new code via the supervisor; foreground runs
  // just announce it, since exiting would stop sync with nobody to relaunch.
  const runningBundle = path.resolve(process.argv[1] ?? '');
  if (remoteApp && path.basename(runningBundle) === 'serve.mjs') {
    const supervised = cli.supervised;
    const { armSelfUpdate, checkAndApplyUpdate, sha256Hex } = await import('./update.mjs');
    // The hash of the code THIS process runs, captured at boot. Without it,
    // an external serve.sh run that overwrites the file leaves disk == deploy
    // while the process executes old code, and the byte-compare would report
    // 'current' forever (the exact staleness that shipped a fixed bundle a
    // running daemon never picked up).
    const loadedHash = await fsp
      .readFile(runningBundle)
      .then((bytes) => sha256Hex(bytes))
      .catch(() => null);
    const onApplied = supervised
      ? () => shutdown('update (supervisor relaunches onto the new bundle)')
      : async () => {
          console.log('[sundial-local] a newer sidecar is downloaded; restart this command to run it (or use --install once so updates apply themselves).');
        };
    armSelfUpdate({ app: remoteApp, bundlePath: runningBundle, log: console.error, onApplied, loadedHash });
    handle.setSelfUpdate?.({
      bundleHash: loadedHash,
      willRestart: supervised,
      check: async () => {
        const status = await checkAndApplyUpdate({ app: remoteApp, bundlePath: runningBundle, log: console.error, loadedHash });
        // Delay the exit past the HTTP response flush — the nudging run
        // reads `applied` and polls /health for the relaunched daemon.
        if (status === 'applied') setTimeout(() => void onApplied(), 200);
        return status;
      },
    });
  }
}
