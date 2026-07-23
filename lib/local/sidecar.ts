'use client';

/** Client for the Sundial desktop sidecar (local-server/): a localhost daemon
 *  that serves local folders as projects — files over HTTP, docs over the
 *  Hocuspocus protocol. The Tauri shell spawns it and passes its port + token
 *  on the launch URL (`?sidecarPort=…&sidecarToken=…`); we latch that into
 *  localStorage so it survives SPA navigation. Browser dev can set the same
 *  key manually. */

import { DESKTOP_CREDENTIALS_EVENT } from '@/lib/desktop';

const STORAGE_KEY = 'sundial:sidecar';

export type SidecarConfig = { origin: string; token: string };

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

export type LocalProject = { id: string; root: string; name: string; created_at: string };
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
  workspace_id: string;
  scope_path: string;
  scope_kind: 'project' | 'folder' | 'file';
  status: string;
  error: string | null;
  bridgedFiles: number;
  enabled: number;
};

async function request<T>(config: SidecarConfig, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.origin}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    // Typed status: callers that emulate HTTP semantics (the workspace-api
    // shim) map this back to a response code instead of parsing messages.
    throw Object.assign(new Error(body?.error || `sidecar request failed (${response.status})`), {
      status: response.status,
    });
  }
  return body;
}

export const sidecar = {
  health: (c: SidecarConfig) => request<{ ok: boolean; projects: number }>(c, '/health'),
  listProjects: (c: SidecarConfig) =>
    request<{ projects: LocalProject[]; defaultProjectsDir?: string }>(c, '/projects'),
  openProject: (c: SidecarConfig, root: string) =>
    request<{ project: LocalProject }>(c, '/projects', { method: 'POST', body: JSON.stringify({ root }) }),
  createProject: (c: SidecarConfig, body: { name: string; location: string; pack?: string | null }) =>
    request<{ project: LocalProject }>(c, '/projects/create', { method: 'POST', body: JSON.stringify(body) }),
  cloneProject: (c: SidecarConfig, body: { url: string; location: string; name?: string | null }) =>
    request<{ project: LocalProject }>(c, '/projects/clone', { method: 'POST', body: JSON.stringify(body) }),
  getProject: (c: SidecarConfig, id: string) =>
    request<{ project: LocalProject; roots?: LocalRootEntry[]; shares: LocalShare[] }>(c, `/projects/${id}`),
  listFiles: (c: SidecarConfig, id: string) =>
    request<{ files: LocalFile[]; roots?: LocalRootEntry[] }>(c, `/projects/${id}/files`),
  /** Mount an outside folder into the project as an extra top-level root. */
  addRoot: (c: SidecarConfig, id: string, root: string) =>
    request<{ ok: boolean; root: LocalRootEntry }>(c, `/projects/${id}/roots`, {
      method: 'POST',
      body: JSON.stringify({ root }),
    }),
  /** Detach a mounted folder (never deletes anything from disk). */
  removeRoot: (c: SidecarConfig, id: string, prefix: string) =>
    request<{ ok: boolean }>(c, `/projects/${id}/roots?prefix=${encodeURIComponent(prefix)}`, { method: 'DELETE' }),
  writeFile: (c: SidecarConfig, id: string, path: string, content: string) =>
    request<{ ok: boolean; file: LocalFile | null }>(c, `/projects/${id}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  listChats: (c: SidecarConfig, id: string) => request<{ chats: LocalChat[] }>(c, `/projects/${id}/chats`),
  listExternalSessions: (c: SidecarConfig, id: string) =>
    request<{ sessions: LocalExternalSession[] }>(c, `/projects/${id}/external-sessions`),
  externalSessionMessages: (c: SidecarConfig, id: string, agent: string, sessionId: string) =>
    request<{ messages: LocalChatMessage[] }>(
      c, `/projects/${id}/external-sessions/messages?agent=${encodeURIComponent(agent)}&id=${encodeURIComponent(sessionId)}`),
  importExternalSession: (c: SidecarConfig, id: string, body: { agent: string; id: string }) =>
    request<{ chat: LocalChat }>(c, `/projects/${id}/external-sessions/import`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createChat: (c: SidecarConfig, id: string, body: { title?: string | null; model?: string | null; harness?: string | null }) =>
    request<{ chat: LocalChat }>(c, `/projects/${id}/chats`, { method: 'POST', body: JSON.stringify(body) }),
  patchChat: (c: SidecarConfig, id: string, chatId: string, body: Record<string, unknown>) =>
    request<{ chat: LocalChat }>(c, `/projects/${id}/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  chatMessages: (c: SidecarConfig, id: string, chatId: string, afterSequence = 0) =>
    request<{ messages: LocalChatMessage[] }>(
      c, `/projects/${id}/chat-messages?chatId=${encodeURIComponent(chatId)}&afterSequence=${afterSequence}`),
  sendChatMessage: (
    c: SidecarConfig,
    id: string,
    body: { chatId: string; content: string; clientId?: string | null; model?: string | null; editMode?: string | null },
  ) =>
    request<{ message: LocalChatMessage; agentStart: { status: string; reason?: string } }>(
      c, `/projects/${id}/chat-messages`, { method: 'POST', body: JSON.stringify(body) }),
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
    request<{ ok: boolean; file: LocalFile | null }>(c, `/projects/${id}/blob?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    }),
  createFolder: (c: SidecarConfig, id: string, path: string) =>
    request<{ ok: boolean; file: LocalFile | null }>(c, `/projects/${id}/folder`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  copyPath: (c: SidecarConfig, id: string, from: string, to: string) =>
    request<{ ok: boolean; file: LocalFile | null }>(c, `/projects/${id}/copy`, {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),
  textContents: (c: SidecarConfig, id: string, prefix?: string) =>
    request<{ files: Array<{ path: string; text: string }> }>(
      c, `/projects/${id}/text-contents${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`),
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
    request<{ ok: boolean }>(c, `/projects/${id}/rename`, { method: 'POST', body: JSON.stringify({ from, to }) }),
  deletePath: (c: SidecarConfig, id: string, path: string) =>
    request<{ ok: boolean; deletedAt?: string; untracked?: boolean }>(c, `/projects/${id}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  createShare: (
    c: SidecarConfig,
    id: string,
    body: {
      workspaceId: string;
      collabUrl: string;
      apiOrigin: string;
      token: string;
      scopeKind: 'project' | 'folder' | 'file';
      scopePath?: string;
    },
  ) => request<{ share: LocalShare }>(c, `/projects/${id}/shares`, { method: 'POST', body: JSON.stringify(body) }),
  removeShare: (c: SidecarConfig, id: string, shareId: string) =>
    request<{ ok: boolean }>(c, `/projects/${id}/shares/${shareId}`, { method: 'DELETE' }),
  listChanges: (c: SidecarConfig, id: string, params: { path?: string | null; folder?: string | null; beforeId?: string | null; limit?: string | null; actors?: string[] | null; chatId?: string | null }) => {
    const search = new URLSearchParams();
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
        createdAt: string | null;
        firstRowId: number;
        lastRowId: number;
        editCount: number;
        editMode: 'edit' | 'suggest';
        reviewState: 'pending' | 'applied';
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
  resolveReview: (c: SidecarConfig, id: string, body: { reviewId: string; action: 'accept' | 'reject' }) =>
    request<{ ok: boolean; changed: boolean; after: string | null }>(c, `/projects/${id}/resolve-review`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  historyCompare: (c: SidecarConfig, id: string, params: { from?: string | null; to: string }) =>
    request<{ from: number | null; to: number; files: unknown[] }>(
      c, `/projects/${id}/history-compare?to=${encodeURIComponent(params.to)}${params.from ? `&from=${encodeURIComponent(params.from)}` : ''}`),
  listLabels: (c: SidecarConfig, id: string) => request<{ labels: unknown[] }>(c, `/projects/${id}/labels`),
  upsertLabel: (c: SidecarConfig, id: string, body: { docEditId: number; name: string }) =>
    request<{ label: unknown }>(c, `/projects/${id}/labels`, { method: 'POST', body: JSON.stringify(body) }),
  deleteLabel: (c: SidecarConfig, id: string, labelId: string) =>
    request<{ ok: boolean; removed: boolean }>(c, `/projects/${id}/labels?id=${encodeURIComponent(labelId)}`, { method: 'DELETE' }),
  historyRestore: (c: SidecarConfig, id: string, body: { path: string; atId?: number | null; beforeCreatedAt?: string | null }) =>
    request<{ ok: boolean; file: LocalFile | null }>(c, `/projects/${id}/history-restore`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listComments: (c: SidecarConfig, id: string, path?: string | null) =>
    request<{ threads: unknown[] }>(
      c, `/projects/${id}/comments${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  createComment: (c: SidecarConfig, id: string, body: Record<string, unknown>) =>
    request<{ threads: unknown[] }>(c, `/projects/${id}/comments`, { method: 'POST', body: JSON.stringify(body) }),
  mutateComment: (c: SidecarConfig, id: string, method: 'PATCH' | 'DELETE', body: Record<string, unknown>) =>
    request<{ threads: unknown[] }>(c, `/projects/${id}/comments`, { method, body: JSON.stringify(body) }),
  /** Raw file URL (images, pdf) — token passed as a query param because <img>
   *  tags can't send headers. Loopback-only + per-install token. */
  fileUrl: (c: SidecarConfig, id: string, path: string) =>
    `${c.origin}/projects/${id}/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(c.token)}`,
  subscribe(config: SidecarConfig, id: string, onEvent: (event: { type: string; path?: string }) => void) {
    const source = new EventSource(
      `${config.origin}/projects/${id}/events?token=${encodeURIComponent(config.token)}`,
    );
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { type: string; path?: string };
        // Server-initiated credential changes (the proxy clearing an expired
        // sd_ token) refresh every mounted auth gate the same way the desktop
        // sign-in flow does. Dispatched here so each surface with a project
        // stream open reacts without its own wiring.
        if (event.type === 'credentials-changed') {
          window.dispatchEvent(new Event(DESKTOP_CREDENTIALS_EVENT));
        }
        onEvent(event);
      } catch {
        /* ignore malformed events */
      }
    };
    return () => source.close();
  },
};
