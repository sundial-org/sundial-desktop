'use client';

/** Client for the Sundial desktop sidecar (local-server/): a localhost daemon
 *  that serves local folders as projects — files over HTTP, docs over the
 *  Hocuspocus protocol. The Tauri shell spawns it and passes its port + token
 *  on the launch URL (`?sidecarPort=…&sidecarToken=…`); we latch that into
 *  localStorage so it survives SPA navigation. Browser dev can set the same
 *  key manually. */

import { DESKTOP_CREDENTIALS_EVENT } from '@/lib/desktop';

const STORAGE_KEY = 'sundial:sidecar';

export type SidecarConfig = {
  origin: string;
  token: string;
  /** Optional per-request abort. The workspace-api shim threads each caller's
   *  `init.signal` here so an abandoned request actually frees its socket —
   *  on the sidecar's single HTTP/1.1 origin (6-connection browser cap) a
   *  parked request starves everything behind it. */
  signal?: AbortSignal;
};

/** Launch params arrive in the URL FRAGMENT (never sent to the remote origin
 *  or its logs — the token must not leave the machine); the query is still
 *  read as a fallback for localhost dev/tests. */
export function getLaunchParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return hash.get(name) ?? new URLSearchParams(window.location.search).get(name);
}

export function getSidecarConfig(): SidecarConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const port = getLaunchParam('sidecarPort');
    const token = getLaunchParam('sidecarToken');
    if (port && token) {
      const config = { origin: `http://127.0.0.1:${port}`, token };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      return config;
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<SidecarConfig>;
    if (typeof parsed.origin === 'string' && typeof parsed.token === 'string') {
      return { origin: parsed.origin, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

/** Async config recovery: launch params / storage first; in the packaged app
 *  (where this page is SERVED by the sidecar) fall back to asking the sidecar
 *  itself — a same-origin request carries the HttpOnly trust cookie, so the
 *  app can never strand on lost browser storage. */
export async function resolveSidecarConfig(): Promise<SidecarConfig | null> {
  const sync = getSidecarConfig();
  if (sync) return sync;
  if (typeof window === 'undefined') return null;
  const { protocol, hostname, origin } = window.location;
  if (protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(hostname)) return null;
  try {
    const res = await fetch('/session-config');
    const body = (await res.json().catch(() => null)) as { token?: string } | null;
    if (!res.ok || !body?.token) return null;
    const config = { origin, token: body.token };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    return config;
  } catch {
    return null;
  }
}

export function sidecarWsUrl(config: SidecarConfig): string {
  return config.origin.replace(/^http/, 'ws');
}

/** True when THIS page is being served by the sidecar's loopback proxy (the
 *  packaged app's https targets load through it). Links built from such an
 *  origin are meaningless off this machine; a desktop build pointed straight
 *  at a dev server is NOT proxied and keeps that server's origin — which is
 *  what makes share links land on the port you are actually running. */
export function isSidecarServedOrigin(): boolean {
  if (typeof window === 'undefined') return false;
  return getSidecarConfig()?.origin === window.location.origin;
}

export type LocalProject = {
  id: string;
  root: string;
  name: string;
  created_at: string;
  /** Mounted extra-folder paths (absent on older sidecars). */
  extra_roots?: string[];
};
/** One root of a (possibly multi-root) project. The primary root has prefix
 *  ''; extra mounted folders serve their files under `prefix/`. */
export type LocalRootEntry = { prefix: string; root: string; name: string };
export type LocalFile = {
  id: string;
  path: string;
  type: 'text' | 'blob' | 'folder';
  size: number;
  updated_at: string;
  mime?: string | null;
};
export type LocalChat = {
  id: string;
  project_id: string;
  title: string | null;
  model: string | null;
  harness: string | null;
  created_at: string;
  last_message_at: string | null;
  archived_at: string | null;
  pinned: number;
  folder_scope?: string | null;
  /** Purpose marker for special chats (e.g. 'latex_fix'); null = ordinary chat. */
  kind?: string | null;
  comment_watch_path?: string | null;
  /** Live runner state on list reads (v17+) — absent means unknown. */
  running?: boolean;
  /** A started run still owes this chat's comment thread an answer (v21+):
   *  not live, but the reply is still coming. Absent means unknown. */
  answering?: boolean;
  /** Present on list reads — powers the per-chat engine lock pre-transcript. */
  message_count?: number;
};

/** An external agent's (Claude Code / Codex) on-disk session whose cwd sits
 *  inside this project — listed read-only, adoptable via import. */
export type LocalExternalSession = {
  id: string;
  agent: 'claude' | 'codex';
  title: string | null;
  cwd: string;
  created_at: string | null;
  updated_at: string | null;
};

export type LocalChatMessage = {
  id: string;
  chat_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | null;
  metadata: Record<string, unknown> | null;
  client_id: string | null;
  sequence: number;
  created_at: string;
};

export type LocalShare = {
  id: string;
  /** Grants-model scope entries (id `scope:<n>`) name their union share row
   *  here — the id token refresh and connection updates target. */
  share_id?: string;
  workspace_id: string;
  /** File path for path scopes; the chat id for chat scopes. */
  scope_path: string;
  scope_kind: 'project' | 'folder' | 'file' | 'chat';
  /** Scope generation (PR #1033): mints record it on the cloud grant, stops
   *  revoke ≤ it. Absent on older sidecars / pre-generation scope rows. */
  generation?: number | null;
  status: string;
  error: string | null;
  bridgedFiles: number;
  /** Durable count of files ever synced (absent on older sidecars). */
  syncedFiles?: number;
  /** Current eligible-file progress (absent on sidecars before API v26). */
  progress?: {
    phase: 'scanning' | 'syncing' | 'up_to_date' | 'error';
    completedFiles: number;
    totalFiles: number | null;
    pendingFiles: number;
    skippedFiles: number;
    skippedByReason: Record<string, number>;
    updatedAt: string;
  } | null;
  enabled: number;
};

/** Liveness bound on sidecar calls, covering the response HEADERS only. All
 *  local traffic shares one HTTP/1.1 origin where the browser allows 6
 *  connections; once the pool wedges, a queued request gets no response, no
 *  error and no timeout — it simply never settles, and whatever UI awaits it
 *  parks forever. Any request that reaches the sidecar answers headers well
 *  within this bound; the timer is cleared the moment they arrive, so slow
 *  BODIES (big listings, transcripts) are never cut short. Heavy operations
 *  that legitimately work before answering (compile, clone, blob upload…)
 *  opt out via `deadlineMs: null`. */
export const SIDECAR_READ_DEADLINE_MS = 12_000;

/** Looser bound for bulk reads whose handlers do all their work BEFORE
 *  sending headers (project-wide text assembly, whole-transcript parses).
 *  Still bounded — they gate UI too — but sized for a large project, not a
 *  quick listing. */
export const SIDECAR_BULK_READ_DEADLINE_MS = 60_000;

type SidecarInit = RequestInit & { deadlineMs?: number | null };

async function transport<T>(config: SidecarConfig, path: string, init?: SidecarInit): Promise<T> {
  const deadlineMs = init?.deadlineMs === undefined ? SIDECAR_READ_DEADLINE_MS : init.deadlineMs;
  const external = init?.signal ?? config.signal ?? null;
  const controller = new AbortController();
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) onAbort();
  else external?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer =
    deadlineMs === null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, deadlineMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${config.origin}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init?.headers || {}),
        },
      });
    } finally {
      // Headers answered (or failed) — the deadline is a liveness bound, not
      // a body cap. The controller stays live so a caller abort mid-body
      // still frees the socket.
      clearTimeout(timer);
    }
    // Non-JSON answers degrade to {} — but an abort mid-body must stay an
    // abort, not a successful empty payload.
    const body = (await response.json().catch((error) => {
      if (controller.signal.aborted) throw error;
      return {};
    })) as T & { error?: string };
    if (!response.ok) {
      // Typed status: callers that emulate HTTP semantics (the workspace-api
      // shim) map this back to a response code instead of parsing messages.
      throw Object.assign(new Error(body?.error || `sidecar request failed (${response.status})`), {
        status: response.status,
      });
    }
    return body;
  } catch (error) {
    if (timedOut && !external?.aborted) {
      throw Object.assign(
        new Error('Sundial’s local service didn’t respond in time. Quit and reopen the app if this persists.'),
        { status: 504 },
      );
    }
    throw error;
  } finally {
    external?.removeEventListener('abort', onAbort);
  }
}

/** Identical same-tick GETs share one request. On a cold workspace open the
 *  page mounts several components that each ask for the same resource —
 *  /projects/:id, /files, /file-order, /chats, /external-sessions all fire
 *  2-3× within one tick — and every duplicate burns a slot in the same
 *  6-connection pool the wedge lives in. The share window is ONE macrotask
 *  (not the request's whole flight): a reload triggered later — say by a
 *  files-changed event that arrived while a slow read was still in flight —
 *  must get a fresh snapshot, never the pre-change one already underway.
 *  Abortable calls bypass sharing so one caller's cancel can't reject the
 *  others. */
const inflightGets = new Map<string, Promise<unknown>>();

function request<T>(config: SidecarConfig, path: string, init?: SidecarInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' || init?.signal || config.signal) return transport<T>(config, path, init);
  const key = `${config.origin}|${config.token}|${path}`;
  const pending = inflightGets.get(key);
  if (pending) return pending as Promise<T>;
  const run = transport<T>(config, path, init);
  inflightGets.set(key, run);
  const clear = () => {
    if (inflightGets.get(key) === run) inflightGets.delete(key);
  };
  setTimeout(clear, 0);
  run.then(clear, clear);
  return run;
}

export const sidecar = {
  health: (c: SidecarConfig) => request<{ ok: boolean; projects: number; eventsPort?: number | null }>(c, '/health'),
  listProjects: (c: SidecarConfig) =>
    request<{ projects: LocalProject[]; defaultProjectsDir?: string }>(c, '/projects'),
  // Project open/create/clone do real work before answering (folder scans,
  // pack seeding, a network git clone) — no liveness bound.
  openProject: (c: SidecarConfig, root: string) =>
    request<{ project: LocalProject }>(c, '/projects', { method: 'POST', body: JSON.stringify({ root }), deadlineMs: null }),
  createProject: (c: SidecarConfig, body: { name: string; location: string; pack?: string | null }) =>
    request<{ project: LocalProject }>(c, '/projects/create', { method: 'POST', body: JSON.stringify(body), deadlineMs: null }),
  cloneProject: (c: SidecarConfig, body: { url: string; location: string; name?: string | null }) =>
    request<{ project: LocalProject }>(c, '/projects/clone', { method: 'POST', body: JSON.stringify(body), deadlineMs: null }),
  getProject: (c: SidecarConfig, id: string) =>
    request<{ project: LocalProject; roots?: LocalRootEntry[]; shares: LocalShare[]; backing_workspace_id?: string | null }>(c, `/projects/${id}`),
  listFiles: (c: SidecarConfig, id: string) =>
    // Walks every root and seeds file ids before answering — on very large
    // trees that alone can run past the quick-read bound.
    request<{ files: LocalFile[]; roots?: LocalRootEntry[] }>(c, `/projects/${id}/files`, {
      deadlineMs: SIDECAR_BULK_READ_DEADLINE_MS,
    }),
  /** Mount an outside folder into the project as an extra top-level root. */
  addRoot: (c: SidecarConfig, id: string, root: string) =>
    request<{ ok: boolean; root: LocalRootEntry }>(c, `/projects/${id}/roots`, {
      method: 'POST',
      body: JSON.stringify({ root }),
    }),
  /** Detach a mounted folder (never deletes anything from disk). */
  removeRoot: (c: SidecarConfig, id: string, prefix: string) =>
    request<{ ok: boolean }>(c, `/projects/${id}/roots?prefix=${encodeURIComponent(prefix)}`, { method: 'DELETE' }),
  // Commit-before-response mutations (disk + doc host + bridge work runs
  // before headers): no liveness bound — a false 504 would report failure for
  // a change the sidecar goes on to commit.
  writeFile: (c: SidecarConfig, id: string, path: string, content: string) =>
    request<{ ok: boolean; file: LocalFile | null }>(c, `/projects/${id}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
      deadlineMs: null,
    }),
  listChats: (c: SidecarConfig, id: string) => request<{ chats: LocalChat[] }>(c, `/projects/${id}/chats`),
  listExternalSessions: (c: SidecarConfig, id: string) =>
    // Discovery enumerates candidates and reads hundreds of transcript heads
    // before answering — bulk bound.
    request<{ sessions: LocalExternalSession[] }>(c, `/projects/${id}/external-sessions`, {
      deadlineMs: SIDECAR_BULK_READ_DEADLINE_MS,
    }),
  externalSessionMessages: (c: SidecarConfig, id: string, agent: string, sessionId: string) =>
    // Parses the whole on-disk transcript before answering — bulk bound.
    request<{ messages: LocalChatMessage[] }>(
      c,
      `/projects/${id}/external-sessions/messages?agent=${encodeURIComponent(agent)}&id=${encodeURIComponent(sessionId)}`,
      { deadlineMs: SIDECAR_BULK_READ_DEADLINE_MS },
    ),
  // Parses the whole on-disk transcript before answering — no liveness bound.
  importExternalSession: (c: SidecarConfig, id: string, body: { agent: string; id: string }) =>
    request<{ chat: LocalChat }>(c, `/projects/${id}/external-sessions/import`, {
      method: 'POST',
      body: JSON.stringify(body),
      deadlineMs: null,
    }),
  createChat: (c: SidecarConfig, id: string, body: { title?: string | null; model?: string | null; harness?: string | null; folderScope?: string | null; kind?: string | null }) =>
    request<{ chat: LocalChat }>(c, `/projects/${id}/chats`, { method: 'POST', body: JSON.stringify(body) }),
  patchChat: (c: SidecarConfig, id: string, chatId: string, body: Record<string, unknown>) =>
    request<{ chat: LocalChat }>(c, `/projects/${id}/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteChat: (c: SidecarConfig, id: string, chatId: string) =>
    request<{ deleted: boolean }>(c, `/projects/${id}/chats/${chatId}`, { method: 'DELETE' }),
  chatMessages: (c: SidecarConfig, id: string, chatId: string, afterSequence = 0, beforeSequence: number | null = null) =>
    request<{ messages: LocalChatMessage[]; page?: { firstSequence: number | null; hasMore: boolean } }>(
      c,
      `/projects/${id}/chat-messages?chatId=${encodeURIComponent(chatId)}&afterSequence=${afterSequence}` +
        (beforeSequence === null ? '' : `&beforeSequence=${beforeSequence}`),
    ),
  sendChatMessage: (
    c: SidecarConfig,
    id: string,
    body: { chatId: string; content: string; clientId?: string | null; model?: string | null; editMode?: string | null; attachments?: unknown[] },
    signal?: AbortSignal | null,
  ) =>
    request<{ message: LocalChatMessage; agentStart: { status: string; reason?: string } }>(
      c, `/projects/${id}/chat-messages`, { method: 'POST', body: JSON.stringify(body), signal }),
  compile: (c: SidecarConfig, id: string, path: string, source?: string | null) =>
    request<{
      ok: boolean;
      pdfPath?: string;
      pdfBase64?: string;
      synctexPath?: string;
      synctexBase64?: string;
      size?: number;
      error?: string;
      failureKind?: 'latex' | 'infra';
      stdout?: string;
      stderr?: string;
      log?: string;
    }>(c, `/projects/${id}/compile`, {
      method: 'POST',
      body: JSON.stringify({ path, ...(typeof source === 'string' ? { source } : {}) }),
      // Compiles legitimately run for tens of seconds — no liveness bound.
      deadlineMs: null,
    }),
  interruptAgent: (c: SidecarConfig, id: string, chatId: string) =>
    request<{ ok: boolean; active: boolean }>(c, `/projects/${id}/agent-interrupt`, {
      method: 'POST',
      body: JSON.stringify({ chatId }),
    }),
  agentCredentialsConfigured: (c: SidecarConfig) =>
    request<{ configured: boolean }>(c, '/agent-credentials'),
  /** Local chat engines (the user's own Claude Code / Codex installs) plus
   *  the install's default engine for new chats. */
  localEngines: (c: SidecarConfig) =>
    request<{
      claude: { available: boolean; loggedIn: boolean };
      codex: { available: boolean; loggedIn: boolean };
      defaultHarness: string | null;
    }>(c, '/local-engines'),
  setDefaultHarness: (c: SidecarConfig, defaultHarness: string) =>
    request<{ ok: boolean }>(c, '/local-engines', { method: 'POST', body: JSON.stringify({ defaultHarness }) }),
  setAgentCredentials: (c: SidecarConfig, body: { apiOrigin: string; token: string }) =>
    request<{ ok: boolean }>(c, '/agent-credentials', { method: 'POST', body: JSON.stringify(body) }),
  writeBlob: (c: SidecarConfig, id: string, path: string, blob: Blob) =>
    // Raw bytes to the streaming endpoint — no base64/JSON inflation, no cap.
    // Upload time counts toward time-to-headers — no liveness bound.
    request<{ ok: boolean; file: LocalFile | null }>(c, `/projects/${id}/blob?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
      deadlineMs: null,
    }),
  createFolder: (c: SidecarConfig, id: string, path: string) =>
    request<{ ok: boolean; file: LocalFile | null }>(c, `/projects/${id}/folder`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  // Copy/delete recurse over whatever the path holds — no liveness bound.
  copyPath: (c: SidecarConfig, id: string, from: string, to: string) =>
    request<{ ok: boolean; file: LocalFile | null }>(c, `/projects/${id}/copy`, {
      method: 'POST',
      body: JSON.stringify({ from, to }),
      deadlineMs: null,
    }),
  textContents: (c: SidecarConfig, id: string, prefix?: string, signal?: AbortSignal) =>
    // Assembles every text file's content before answering — bulk bound.
    request<{ files: Array<{ path: string; text: string }> }>(
      c,
      `/projects/${id}/text-contents${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`,
      { signal, deadlineMs: SIDECAR_BULK_READ_DEADLINE_MS },
    ),
  revealPath: (c: SidecarConfig, id: string, path: string) =>
    request<{ ok: boolean }>(c, `/projects/${id}/reveal`, { method: 'POST', body: JSON.stringify({ path }) }),
  renameProject: (c: SidecarConfig, id: string, name: string) =>
    request<{ project: LocalProject }>(c, `/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  /** Browser-navigable download URL (token as query param, like fileUrl). */
  downloadUrl: (c: SidecarConfig, id: string, params: { path?: string; folderPath?: string }) => {
    const search = new URLSearchParams();
    if (params.path) search.set('path', params.path);
    if (params.folderPath) search.set('folderPath', params.folderPath);
    search.set('token', c.token);
    return `${c.origin}/projects/${id}/download?${search.toString()}`;
  },
  renamePath: (c: SidecarConfig, id: string, from: string, to: string) =>
    // Commit-before-response (see writeFile) — no liveness bound.
    request<{ ok: boolean }>(c, `/projects/${id}/rename`, { method: 'POST', body: JSON.stringify({ from, to }), deadlineMs: null }),
  deletePath: (c: SidecarConfig, id: string, path: string) =>
    request<{ ok: boolean; deletedAt?: string; untracked?: boolean; kept?: string[] }>(c, `/projects/${id}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE', deadlineMs: null }),
  createShare: (
    c: SidecarConfig,
    id: string,
    body: {
      workspaceId: string;
      collabUrl: string;
      apiOrigin: string;
      token: string;
      scopeKind: 'project' | 'folder' | 'file' | 'chat';
      scopePath?: string;
      /** Grants-model scope on the project's hidden backing workspace — the
       *  only shape the sidecar still accepts (legacy per-scope shares are
       *  read/stop only), so it is required, not optional. */
      grants: true;
    },
    // Share mutations revoke cloud grants / run initial bridge syncs before
    // answering — no liveness bound (a false 504 would diverge from the state
    // the sidecar goes on to commit).
  ) => request<{ share: LocalShare }>(c, `/projects/${id}/shares`, { method: 'POST', body: JSON.stringify(body), deadlineMs: null }),
  /** Mint-confirm: does the sidecar still record this scope? Answered under
   *  its per-project lock, so a `false` means an in-flight stop already
   *  finished — the caller must revoke the grant it just minted (fail-closed).
   *  A 404 = older sidecar without the endpoint: report live (pre-confirm
   *  behavior) rather than revoking every mint. */
  confirmScope: (c: SidecarConfig, id: string, body: { workspaceId: string; scopeKind: string; scopePath: string }) =>
    request<{ live: boolean; generation?: number | null }>(c, `/projects/${id}/shares/confirm`, {
      method: 'POST',
      body: JSON.stringify(body),
      // Answered under the per-project lock, which an in-flight stop's cloud
      // revokes can hold for a while — a false 504 here would fail-closed
      // revoke a grant that is actually live.
      deadlineMs: null,
    }).catch((error: { status?: number }) => {
      if (error?.status === 404) return { live: true, generation: null };
      throw error;
    }),
  /** `revoked` = the caller already revoked the scope's cloud audience with
   *  user auth, so the sidecar skips its own fail-closed bridge-token revoke.
   *  `token` = a FRESH user-minted bridge token riding the stop, so the
   *  sidecar's last-scope bulk revoke never aborts on its stored (possibly
   *  7-day-stale) token. */
  removeShare: (c: SidecarConfig, id: string, shareId: string, opts?: { revoked?: boolean; token?: string | null }) =>
    request<{ ok: boolean }>(c, `/projects/${id}/shares/${shareId}${opts?.revoked ? '?revoked=1' : ''}`, {
      method: 'DELETE',
      ...(opts?.token ? { body: JSON.stringify({ token: opts.token }) } : {}),
      deadlineMs: null,
    }).catch(
      (error: { status?: number }) => {
        // Already gone is the desired end state: a stop that ran slowly and
        // got clicked twice must not report failure for the winning call.
        if (error?.status === 404) return { ok: true };
        throw error;
      },
    ),
  listChanges: (c: SidecarConfig, id: string, params: { path?: string | null; folder?: string | null; beforeId?: string | null; limit?: string | null; actors?: string[] | null; chatId?: string | null; pending?: boolean }) => {
    const search = new URLSearchParams();
    // Filters BEFORE the page cap, so a long-open suggestion can't fall off
    // behind newer applied history. Ignored by older sidecars — the caller
    // still filters client-side.
    if (params.pending) search.set('pending', '1');
    if (params.path) search.set('path', params.path);
    if (params.folder) search.set('folder', params.folder);
    if (params.beforeId) search.set('beforeId', params.beforeId);
    if (params.limit) search.set('limit', params.limit);
    if (params.actors?.length) search.set('actors', params.actors.join(','));
    if (params.chatId) search.set('chatId', params.chatId);
    return request<{
      entries: Array<{
        reviewId: string;
        path: string;
        actor: string | null;
        authorId: string | null;
        chatId: string | null;
        /** Transcript assistant message id for the jump — NOT `reviewId`.
         *  Null for human rows; absent on older sidecars. */
        messageId?: string | null;
        createdAt: string | null;
        firstRowId: number;
        lastRowId: number;
        editCount: number;
        editMode: 'edit' | 'suggest';
        reviewState: 'pending' | 'applied';
        /** Staged suggestion mark ids (agent suggest sessions). Absent on older sidecars. */
        suggestionIds?: string[];
      }>;
      actorCounts: Record<string, number>;
      latestDocEditId: number | null;
      nextBeforeId: number | null;
    }>(c, `/projects/${id}/changes?${search.toString()}`);
  },
  appliedEdit: (c: SidecarConfig, id: string, path: string | null, lastRowId: number) =>
    request<{
      beforeText: string;
      afterText: string;
      deleted: boolean;
      session: { path: string };
      /** Reject-projection of the session's still-live suggestion ids; null when none live. */
      rejectedText?: string | null;
      /** The file's current accepted-view text; null when deleted. */
      currentText?: string | null;
    }>(c, `/projects/${id}/applied-edit?lastRowId=${lastRowId}${path ? `&path=${encodeURIComponent(path)}` : ''}`),
  /** One agent turn's edits, per file — the chat diff chip's payload. */
  turnEdits: (c: SidecarConfig, id: string, messageId: string) =>
    request<{
      files: Array<{
        path: string;
        beforeText: string;
        afterText: string;
        deleted: boolean;
        /** Did the path exist before the turn? Absent on sidecars < 10. */
        existed?: boolean;
      }>;
    }>(c, `/projects/${id}/turn-edits?messageId=${encodeURIComponent(messageId)}`),
  resolveReview: (c: SidecarConfig, id: string, body: { reviewId: string; action: 'accept' | 'reject' }) =>
    // Commit-before-response (see writeFile) — no liveness bound.
    request<{ ok: boolean; changed: boolean; after: string | null }>(c, `/projects/${id}/resolve-review`, {
      method: 'POST',
      body: JSON.stringify(body),
      deadlineMs: null,
    }),
  historyCompare: (c: SidecarConfig, id: string, params: { from?: string | null; to: string }) =>
    request<{ from: number | null; to: number; files: unknown[] }>(
      c, `/projects/${id}/history-compare?to=${encodeURIComponent(params.to)}${params.from ? `&from=${encodeURIComponent(params.from)}` : ''}`),
  /** Manual sidebar order, stored per project in the sidecar DB (not the
   *  browser) so it survives a cleared cache and follows the folder. */
  getFileOrder: (c: SidecarConfig, id: string) =>
    request<{ fileOrder: Record<string, string[]> }>(c, `/projects/${id}/file-order`),
  setFileOrder: (c: SidecarConfig, id: string, body: { parent: string; names: string[] }) =>
    request<{ fileOrder: Record<string, string[]> }>(c, `/projects/${id}/file-order`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  listLabels: (c: SidecarConfig, id: string) => request<{ labels: unknown[] }>(c, `/projects/${id}/labels`),
  upsertLabel: (c: SidecarConfig, id: string, body: { docEditId: number; name: string }) =>
    request<{ label: unknown }>(c, `/projects/${id}/labels`, { method: 'POST', body: JSON.stringify(body) }),
  deleteLabel: (c: SidecarConfig, id: string, labelId: string) =>
    request<{ ok: boolean; removed: boolean }>(c, `/projects/${id}/labels?id=${encodeURIComponent(labelId)}`, { method: 'DELETE' }),
  historyRestore: (c: SidecarConfig, id: string, body: { path: string; atId?: number | null; beforeCreatedAt?: string | null }) =>
    // Commit-before-response (see writeFile) — no liveness bound.
    request<{ ok: boolean; file: LocalFile | null }>(c, `/projects/${id}/history-restore`, {
      method: 'POST',
      body: JSON.stringify(body),
      deadlineMs: null,
    }),
  listComments: (c: SidecarConfig, id: string, path?: string | null) =>
    request<{ threads: unknown[] }>(
      c, `/projects/${id}/comments${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  // Comment mutations on shared projects wait on the cloud mirror before
  // answering — commit-before-response (see writeFile), no liveness bound.
  createComment: (c: SidecarConfig, id: string, body: Record<string, unknown>) =>
    request<{ threads: unknown[] }>(c, `/projects/${id}/comments`, { method: 'POST', body: JSON.stringify(body), deadlineMs: null }),
  mutateComment: (c: SidecarConfig, id: string, method: 'PATCH' | 'DELETE', body: Record<string, unknown>) =>
    request<{ threads: unknown[] }>(c, `/projects/${id}/comments`, { method, body: JSON.stringify(body), deadlineMs: null }),
  /** Raw file URL (images, pdf) — token passed as a query param because <img>
   *  tags can't send headers. Loopback-only + per-install token. */
  fileUrl: (c: SidecarConfig, id: string, path: string) =>
    `${c.origin}/projects/${id}/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(c.token)}`,
  subscribe(config: SidecarConfig, id: string, onEvent: (event: { type: string; path?: string }) => void) {
    // ONE EventSource per project, fanned out to every subscriber. The
    // workspace page mounts several subscribers (file tree, chats, comments,
    // shares…); each opening its own stream would eat the whole 6-connection
    // pool by itself.
    const key = `${config.origin}|${config.token}|${id}`;
    let entry = eventStreams.get(key);
    if (!entry) {
      entry = openEventStream(config, id, key);
      eventStreams.set(key, entry);
    }
    // Fresh identity per call: the same callback subscribed twice must count
    // twice, or the first unsubscribe would tear down the second's listener.
    const listener = (event: { type: string; path?: string }) => onEvent(event);
    entry.listeners.add(listener);
    let closed = false;
    return () => {
      if (closed) return; // idempotent — a double-call must not close a stream new subscribers reopened
      closed = true;
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && eventStreams.get(key) === entry) {
        eventStreams.delete(key);
        clearTimeout(entry.retryTimer);
        entry.source.close();
      }
    };
  },
};

/** The origin the long-lived `/events` stream connects on. The sidecar binds
 *  a second loopback port dedicated to the events plane (v23+) and advertises
 *  it on /health: browser connection pools are per-origin, so the stream
 *  rides its own pool and never occupies a data-plane slot. The port comes
 *  from the sidecar's own (trusted) origin and the sidecar provably owns it —
 *  unlike a `localhost` host alias, whose `::1` may belong to a foreign
 *  process the per-install token must never reach. Older sidecars (no
 *  eventsPort) and failed probes keep the primary origin. Resolved lazily
 *  and cached per sidecar; `null` = not known yet. */
const eventsOrigins = new Map<string, string>();
const eventsProbes = new Map<string, Promise<string>>();
function probeEventsOrigin(config: SidecarConfig): Promise<string> {
  const key = `${config.origin}|${config.token}`;
  let pending = eventsProbes.get(key);
  if (!pending) {
    pending = sidecar
      .health(config)
      .then((health) => {
        if (!health.eventsPort) return config.origin;
        const url = new URL(config.origin);
        url.port = String(health.eventsPort);
        return url.origin;
      })
      // A failed probe (starved pool, sidecar mid-restart) is not cached —
      // the next connect re-probes rather than pinning the data plane.
      .catch(() => config.origin)
      .then((origin) => {
        eventsProbes.delete(key);
        if (origin !== config.origin) eventsOrigins.set(key, origin);
        return origin;
      });
    eventsProbes.set(key, pending);
  }
  return pending;
}

/** Shared `/events` streams, keyed by origin+token+project — module-level so
 *  every subscriber on the page rides one connection. */
type EventStreamEntry = {
  source: EventSource;
  listeners: Set<(event: { type: string; path?: string }) => void>;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Latched when the events-plane origin failed before ever opening (stale
   *  advertised port after a sidecar restart) — stay on the data-plane origin
   *  instead of retrying an address that will never answer. */
  fellBack?: boolean;
};
const eventStreams = new Map<string, EventStreamEntry>();

function openEventStream(config: SidecarConfig, id: string, key: string): EventStreamEntry {
  const listeners: EventStreamEntry['listeners'] = new Set();
  const entry: EventStreamEntry = { source: null as unknown as EventSource, listeners };
  const probeKey = `${config.origin}|${config.token}`;
  const connect = () => {
    // Open SYNCHRONOUSLY on whatever origin is known — the primary until the
    // events port has been probed — so subscribers never wait on a round trip
    // (and a starved pool can't delay the stream that unblocks it). The first
    // successful probe migrates the stream onto the events plane once.
    const known = entry.fellBack ? null : eventsOrigins.get(probeKey);
    const origin = known ?? config.origin;
    if (!known && !entry.fellBack) {
      void probeEventsOrigin(config).then((eventsOrigin) => {
        if (eventsOrigin === config.origin || eventStreams.get(key) !== entry || entry.source !== source) return;
        source.close();
        connect();
      });
    }
    const source = new EventSource(`${origin}/projects/${id}/events?token=${encodeURIComponent(config.token)}`);
    entry.source = source;
    let opened = false;
    source.onopen = () => {
      opened = true;
    };
    source.onmessage = (message) => {
      let event: { type: string; path?: string };
      try {
        event = JSON.parse(message.data) as { type: string; path?: string };
      } catch {
        return; // ignore malformed events
      }
      // Server-initiated credential changes (the proxy clearing an expired
      // sd_ token) refresh every mounted auth gate the same way the desktop
      // sign-in flow does. Dispatched once per event, not per subscriber.
      if (event.type === 'credentials-changed') {
        window.dispatchEvent(new Event(DESKTOP_CREDENTIALS_EVENT));
      }
      // Snapshot: a listener unsubscribing mid-dispatch must not skip the
      // rest; a throwing listener must not starve the others.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          /* one bad subscriber must not break the shared stream */
        }
      }
    };
    source.onerror = () => {
      if (eventStreams.get(key) !== entry || entry.source !== source) return; // torn down / migrated
      if (origin !== config.origin) {
        // Events-plane failure: the advertised port is random and dies with
        // the process, so a replaced sidecar deafens a browser retry loop
        // against the old port forever. Forget the cached origin and
        // reconnect through a fresh probe — before the stream ever opened,
        // latch straight back to the data plane instead.
        eventsOrigins.delete(probeKey);
        source.close();
        if (listeners.size === 0) return;
        if (!opened) {
          entry.fellBack = true;
          connect();
        } else {
          entry.retryTimer = setTimeout(connect, 3000);
        }
        return;
      }
      // A non-2xx `/events` response closes an EventSource permanently (no
      // auto-reconnect). Long-lived subscribers hold the refcount above zero
      // and never remount, so a dead shared stream would deafen the whole
      // page for the session — reopen it ourselves, paced so a persistently
      // failing sidecar isn't hammered.
      if (source.readyState !== EventSource.CLOSED) return; // transient: EventSource retries itself
      if (listeners.size === 0) return;
      entry.retryTimer = setTimeout(connect, 3000);
    };
  };
  connect();
  return entry;
}
