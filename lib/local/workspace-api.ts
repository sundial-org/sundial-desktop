'use client';

/** Client-side emulation of the `/api/workspace/*` REST surface, backed by the
 *  desktop sidecar — the seam that lets the real WorkspacePage render a local
 *  folder. Only the routes the page actually uses are implemented; anything
 *  outside `/api/workspace` falls through to the real fetch. Cloud-only routes
 *  return 501 and the page's existing fail-soft paths keep the UI coherent. */

import { isCrdtFile } from '@/lib/sync/policy';
import { searchProject } from '@/lib/latex/project-search';
import { replaceProject } from '@/lib/latex/project-replace';
import { resolveLatexRoot } from '@/lib/workspace/latex-root';
import { isCompileTrigger, isSourceVersion } from '@/lib/latex/compile-contract';
import { duplicatePath } from '@/lib/workspace/uploads';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { authorDisplayName, classifyChangeAuthor, summarizeSessionPreview } from '@/lib/workspace/workspace-changes';
import { brandForAgentId } from '@/lib/workspace/agent-brand';
import { buildOversizedTurnEditFile, buildTurnEditFile, isOversizedTurnEditText } from '@/lib/workspace/turn-edits';
import { DEFAULT_SUNNY_AVATAR } from '@/lib/workspace/sunny-avatars';
import { deriveChatTitle } from '@/lib/workspace/derive-chat-title';
import { sidecar, type LocalChat, type LocalExternalSession, type LocalFile, type SidecarConfig } from './sidecar';

/** `duplicateFile` seeds copies via GET /snapshots → POST create. Locally the
 *  snapshot is a path sentinel the create branch turns into a disk copy. */
const LOCAL_SNAPSHOT_PREFIX = 'sundial-local-path:';

/** Signed-out model picker for the local engines (subscription models — they
 *  run on the user's own Claude Code / Codex logins, no cloud catalog). */
const LOCAL_ENGINE_MODELS = [
  { id: 'anthropic/claude-sonnet-4.6', provider: 'anthropic', providerLabel: 'Anthropic', label: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-opus-4.8', provider: 'anthropic', providerLabel: 'Anthropic', label: 'Claude Opus 4.8' },
  { id: 'anthropic/claude-haiku-4.5', provider: 'anthropic', providerLabel: 'Anthropic', label: 'Claude Haiku 4.5' },
  { id: 'openai/gpt-5.5', provider: 'openai', providerLabel: 'OpenAI', label: 'GPT 5.5' },
  { id: 'openai/gpt-5.5-codex', provider: 'openai', providerLabel: 'OpenAI', label: 'GPT 5.5 Codex' },
].map((model) => ({
  ...model,
  modelId: model.id.split('/')[1],
  reasoning: true,
  supportsImages: true,
  contextWindow: 200_000,
  maxTokens: null,
}));

function toRow(projectId: string, file: LocalFile): WorkspaceFileRow {
  return {
    id: file.id,
    project_id: projectId,
    parent_file_id: null,
    path: file.path,
    type: file.type === 'blob' ? 'binary' : file.type,
    mime: file.type === 'blob' ? (file.mime ?? null) : null,
    size: file.size,
    storage_key: null,
    created_at: file.updated_at,
    updated_at: file.updated_at,
  };
}

/** External agent sessions (Claude Code / Codex transcripts on disk) surface
 *  in the chat list under a synthetic id no real chat can collide with. */
const EXTERNAL_CHAT_PREFIX = 'external:';
export const externalChatId = (agent: string, sessionId: string) => `${EXTERNAL_CHAT_PREFIX}${agent}:${sessionId}`;
export function parseExternalChatId(chatId: string | null | undefined): { agent: string; sessionId: string } | null {
  if (!chatId?.startsWith(EXTERNAL_CHAT_PREFIX)) return null;
  const rest = chatId.slice(EXTERNAL_CHAT_PREFIX.length);
  const split = rest.indexOf(':');
  return split > 0 ? { agent: rest.slice(0, split), sessionId: rest.slice(split + 1) } : null;
}

/** Read-only chat-list row for an external session. `external_session` is the
 *  marker the workspace page keys the dashed icon / banner / no-composer on. */
function externalToChatSummary(session: LocalExternalSession) {
  return {
    id: externalChatId(session.agent, session.id),
    chat_kind: 'direct' as const,
    model: null,
    harness: session.agent === 'codex' ? 'openai' : 'claude',
    message_count: 1,
    last_message_at: session.updated_at,
    created_at: session.created_at,
    archived_at: null,
    preview_text: null,
    unread_count: 0,
    title: session.title,
    pinned: false,
    pinned_at: null,
    sunny_number: null,
    transport_types: [],
    participants: [],
    external_session: { agent: session.agent, session_id: session.id, cwd: session.cwd },
  };
}

/** Local chats rendered through the cloud chat UI — same summary shape. */
function toChatSummary(chat: LocalChat) {
  return {
    id: chat.id,
    chat_kind: 'direct' as const,
    model: chat.model,
    harness: chat.harness ?? null,
    message_count: chat.message_count ?? 0,
    last_message_at: chat.last_message_at,
    created_at: chat.created_at,
    archived_at: chat.archived_at,
    preview_text: null,
    unread_count: 0,
    title: chat.title,
    pinned: Boolean(chat.pinned),
    pinned_at: null,
    sunny_number: null,
    transport_types: [],
    participants: [],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notImplemented(pathname: string): Response {
  return json({ error: `Not available for local projects (${pathname})` }, 501);
}

function requestUrl(input: RequestInfo | URL): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
  try {
    if (init?.body) return JSON.parse(String(init.body)) as Record<string, unknown>;
    if (input instanceof Request) return (await input.clone().json()) as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return {};
}


/** Review-panel author chip for a local ledger row. The sidecar has no
 *  identity provider: names come from the actor class, not user records. */
function localChangeAuthor(actor: string | null, authorId: string | null) {
  const kind = classifyChangeAuthor(actor, authorId);
  const name =
    kind !== 'human'
      ? authorDisplayName(kind, authorId) // 'Sunny' / the local agent's brand
      : actor === 'user' || actor === 'anon'
        ? 'You'
        : actor === 'remote'
          ? 'Cloud collaborator'
          : actor === 'external'
            ? 'External app'
            : 'Someone';
  const imageUrl =
    kind === 'sunny' ? DEFAULT_SUNNY_AVATAR : kind === 'local_agent' ? brandForAgentId(authorId).logoPath : null;
  return { kind, id: authorId, name, imageUrl };
}

/** Binary uploads for local projects: raw bytes streamed to the sidecar's
 *  disk write. It's the user's own file system — no size cap. Some "image"
 *  drops (SVG) are TEXT-classified by the sync policy and must ride the text
 *  rail — the blob endpoint rejects them by design. */
export function createLocalBinaryUpload(config: SidecarConfig, projectId: string) {
  return async (path: string, file: File): Promise<WorkspaceFileRow> => {
    const text = isCrdtFile(path, null);
    // Sidecar text rail caps at 10 MB (MAX_TEXT_BYTES) — refuse before
    // materializing a potentially huge file in browser memory.
    if (text && file.size > 10 * 1024 * 1024) {
      throw new Error('Text files are limited to 10 MB.');
    }
    const { file: created } = text
      ? await sidecar.writeFile(config, projectId, path, await file.text())
      : await sidecar.writeBlob(config, projectId, path, file);
    if (!created) throw new Error('Upload failed');
    return toRow(projectId, created);
  };
}

/** Local mirror of the cloud first-message naming: one Haiku call via the
 *  Next server (which holds the gateway key), falling back to the truncated
 *  message text. The sidecar write is CAS-only (applies while the title is
 *  still unset), so a user rename — even mid-flight — always wins. */
export async function nameLocalChatFromFirstMessage(
  config: SidecarConfig,
  projectId: string,
  chatId: string,
  firstMessage: string,
): Promise<void> {
  let title: string | null = null;
  try {
    const res = await fetch('/api/local/chat-naming', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: firstMessage }),
    });
    const body = (await res.json().catch(() => null)) as { title?: unknown } | null;
    if (res.ok && typeof body?.title === 'string' && body.title.trim()) title = body.title;
  } catch {
    /* fall back to the derived title */
  }
  await sidecar
    .patchChat(config, projectId, chatId, { autoTitle: title ?? deriveChatTitle(firstMessage) })
    .catch(() => {}); // best-effort: an unnamed chat is not an error
}

/** `applied-<rowId>` → rowId; null for any other (cloud-shaped) review id. */
function parseSessionReviewId(reviewId: string): number | null {
  const rowId = Number(reviewId.startsWith('applied-') ? reviewId.slice('applied-'.length) : 0);
  return Number.isInteger(rowId) && rowId > 0 ? rowId : null;
}

export function createLocalWorkspaceFetch(config: SidecarConfig, projectId: string): typeof fetch {
  const listFiles = async () => (await sidecar.listFiles(config, projectId)).files;

  /** A suggest session's diff as a TurnEditsResponse. PENDING (the panel
   *  loads it before acting): the UNDECIDED delta — reject-projection →
   *  current accepted view — so a partially inline-decided session never
   *  shows already-accepted lines as actionable (the resolver would skip
   *  them). RESOLVED (the keep/undo POSTs answer with it): the SURVIVING
   *  delta — session-before → the file's post-resolution text, chunks kept.
   *  An empty surviving delta is `allUndone`. */
  const sessionTurnEdits = async (reviewId: string, resolved?: { after: string | null }) => {
    const data = await sidecar.appliedEdit(config, projectId, null, parseSessionReviewId(reviewId)!);
    const status = resolved ? ('kept' as const) : ('pending' as const);
    const pendingScoped = !resolved && data.rejectedText != null;
    const beforeText = pendingScoped ? data.rejectedText! : data.beforeText;
    const afterText = resolved
      ? (resolved.after ?? '')
      : pendingScoped
        ? (data.currentText ?? data.afterText)
        : data.deleted
          ? ''
          : data.afterText;
    const params = {
      fileId: null,
      filePath: data.session.path,
      beforeText,
      afterText,
      isNew: beforeText.length === 0,
      isDeleted: data.deleted || resolved?.after === null,
    };
    // Oversized bodies can't chunk in the browser. Cloud degrades to the
    // chunkless `oversized` placeholder, but every review action targets
    // pending CHUNK ids — chunkless would leave the suggestion stuck pending
    // with no button anywhere. Local resolution is session-granular (the ids
    // aren't consulted), so one lineless sentinel chunk arms the row quick
    // actions and the card's whole-file Keep/Reject; the size notice explains
    // the missing diff, and the empty chunk itself renders nothing.
    if (isOversizedTurnEditText(beforeText) || isOversizedTurnEditText(afterText)) {
      const sentinel = { id: 'session', status, lines: [], oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 0 };
      // `oversized` doubles as the panel's still-active signal (cloud oversized
      // payloads are chunkless) — a RESOLVED response must clear it or the row
      // survives its own Keep until the next poll.
      const file = { ...buildOversizedTurnEditFile(params), oversized: !resolved, chunks: [sentinel] };
      return { assistantMessageId: reviewId, files: [file], allUndone: Boolean(resolved && afterText === beforeText) };
    }
    const file = buildTurnEditFile(params);
    const files = file ? [{ ...file, chunks: file.chunks.map((chunk) => ({ ...chunk, status })) }] : [];
    return { assistantMessageId: reviewId, files, allUndone: Boolean(resolved) && files.length === 0 };
  };

  /** Local Sunny sends need the sidecar to hold a cloud token for the metered
   *  model-step endpoint. Auto-provision on demand from the signed-in browser
   *  (a user-scoped sd_ API token); a 401-invalidated token re-mints the same
   *  way on the next send. In-flight dedupe so concurrent sends can't each
   *  mint an orphan token. */
  let provisioning: Promise<boolean> | null = null;
  const ensureAgentCredentials = (): Promise<boolean> => {
    provisioning ??= (async () => {
      try {
        const { configured } = await sidecar.agentCredentialsConfigured(config);
        if (configured) return true;
        const minted = await fetch('/api/auth/tokens', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Sundial Desktop — local Sunny', expires_in_days: 90 }),
        });
        const body = (await minted.json().catch(() => null)) as { token?: string } | null;
        if (!minted.ok || !body?.token) return false;
        await sidecar.setAgentCredentials(config, { apiOrigin: window.location.origin, token: body.token });
        return true;
      } finally {
        provisioning = null;
      }
    })();
    return provisioning;
  };

  const handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (!url.pathname.startsWith('/api/workspace') && url.pathname !== '/api/agent/interrupt') {
      return fetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const route = `${method} ${url.pathname}`;

    try {
      switch (route) {
        case 'GET /api/workspace/files': {
          const [{ project, roots }, files] = await Promise.all([
            sidecar.getProject(config, projectId),
            listFiles(),
          ]);
          return json({
            files: files.map((file) => toRow(projectId, file)),
            // Multi-root: the tree renders extra mounted folders as their own
            // top-level sections (see localRoots in the workspace page).
            localRoots: roots ?? [],
            canWrite: true,
            canAccessSecrets: false,
            visibility: 'private',
            projectTitle: project.name,
            projectStatus: 'active',
            projectKind: 'standard',
            hostUrl: null,
            cold: false,
          });
        }
        case 'POST /api/workspace/files': {
          const body = await requestBody(input, init);
          const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath : '';
          if (sourcePath) {
            const existing = new Set((await listFiles()).map((file) => file.path));
            const target = duplicatePath(sourcePath, (candidate) => existing.has(candidate));
            const { file } = await sidecar.copyPath(config, projectId, sourcePath, target);
            if (!file) return json({ error: 'Copy failed' }, 500);
            return json({ file: toRow(projectId, file) });
          }
          const path = typeof body.path === 'string' ? body.path : '';
          if (!path) return json({ error: 'path is required' }, 400);
          const seed = typeof body.initialSnapshotBase64 === 'string' ? body.initialSnapshotBase64 : '';
          const { file } =
            body.type === 'folder'
              ? await sidecar.createFolder(config, projectId, path)
              : seed.startsWith(LOCAL_SNAPSHOT_PREFIX)
                ? await sidecar.copyPath(config, projectId, seed.slice(LOCAL_SNAPSHOT_PREFIX.length), path)
                : await sidecar.writeFile(config, projectId, path, typeof body.content === 'string' ? body.content : '');
          if (!file) return json({ error: 'Create failed' }, 500);
          return json({ file: toRow(projectId, file) });
        }
        case 'DELETE /api/workspace/files': {
          const body = await requestBody(input, init);
          const path = typeof body.path === 'string' ? body.path : '';
          if (!path) return json({ error: 'path is required' }, 400);
          const matching = (await listFiles()).filter(
            (file) => file.path === path || file.path.startsWith(`${path}/`),
          );
          const result = await sidecar.deletePath(config, projectId, path);
          // Text deletes reconstruct from the local ledger (delete tombstone +
          // /history-restore); a blob in the batch makes it non-undoable, same
          // rule as the cloud route — as does UNTRACKED content the sidecar
          // reports (unknown-extension files/symlinks the listing never
          // showed; restore couldn't bring them back). `deletedAt` is the
          // SIDECAR's cutoff — guaranteed after its ledger writes, unlike a
          // browser timestamp.
          const restorable = !result.untracked && matching.every((file) => file.type !== 'blob')
            ? {
                folders: matching.filter((file) => file.type === 'folder').map((file) => file.path),
                texts: matching.filter((file) => file.type === 'text').map((file) => file.path),
              }
            : null;
          return json({
            ok: true,
            deleted: matching.map((file) => file.path),
            deletedAt: result.deletedAt ?? new Date().toISOString(),
            restorable,
          });
        }
        case 'PATCH /api/workspace/files': {
          const body = await requestBody(input, init);
          const from = typeof body.sourcePath === 'string' ? body.sourcePath : '';
          const to = typeof body.targetPath === 'string' ? body.targetPath : '';
          if (!from || !to) return json({ error: 'sourcePath and targetPath are required' }, 400);
          await sidecar.renamePath(config, projectId, from, to);
          return json({ updates: [] });
        }
        case 'POST /api/workspace/files/preview': {
          const body = await requestBody(input, init);
          const file = (await listFiles()).find((entry) => entry.id === body.fileId);
          if (!file) return json({ error: 'File not found' }, 404);
          return json({ signedUrl: sidecar.fileUrl(config, projectId, file.path) });
        }
        case 'GET /api/workspace/snapshots': {
          const fileId = url.searchParams.get('fileId');
          const file = (await listFiles()).find((entry) => entry.id === fileId);
          return json({ snapshot: file ? `${LOCAL_SNAPSHOT_PREFIX}${file.path}` : null });
        }
        case 'GET /api/workspace': {
          const { project } = await sidecar.getProject(config, projectId);
          return json({
            project: { id: projectId, title: project.name, status: 'active', agent_default_model: null, space_instructions: null },
          });
        }
        case 'PATCH /api/workspace': {
          const body = await requestBody(input, init);
          if (typeof body.title === 'string' && body.title.trim()) {
            const { project } = await sidecar.renameProject(config, projectId, body.title.trim());
            return json({ project: { id: projectId, title: project.name } });
          }
          return json({ error: 'Only renames apply to local projects' }, 400);
        }
        case 'PATCH /api/workspace/uploads': {
          const body = await requestBody(input, init);
          const path = typeof body.path === 'string' ? body.path : '';
          if (!path) return json({ error: 'path is required' }, 400);
          const { file } = await sidecar.writeFile(
            config,
            projectId,
            path,
            typeof body.textContent === 'string' ? body.textContent : '',
          );
          if (!file) return json({ error: 'Upload failed' }, 500);
          return json({ file: toRow(projectId, file) });
        }
        case 'GET /api/workspace/search': {
          const query = url.searchParams.get('q') ?? '';
          if (!query) return json({ matches: [] });
          const { files } = await sidecar.textContents(config, projectId);
          return json({
            matches: searchProject(
              files,
              query,
              {
                caseSensitive: url.searchParams.get('case') === '1',
                wholeWord: url.searchParams.get('word') === '1',
                regex: url.searchParams.get('regex') === '1',
              },
              undefined,
              () => true, // every local text file is a content source
            ),
          });
        }
        case 'POST /api/workspace/replace': {
          const body = await requestBody(input, init);
          const query = typeof body.query === 'string' ? body.query : '';
          if (!query) return json({ error: 'query is required' }, 400);
          const { files } = await sidecar.textContents(config, projectId);
          const preview = replaceProject(
            files,
            query,
            typeof body.replacement === 'string' ? body.replacement : '',
            { caseSensitive: body.caseSensitive === true, wholeWord: body.wholeWord === true, regex: body.regex === true },
            () => true,
          );
          const summary = preview.files.map((file) => ({ path: file.path, count: file.count }));
          if (body.confirm !== true) {
            return json({ preview: true, files: summary, totalMatches: preview.totalMatches, totalFiles: preview.totalFiles });
          }
          for (const file of preview.files) {
            await sidecar.writeFile(config, projectId, file.path, file.after);
          }
          return json({ applied: summary, totalMatches: preview.totalMatches, totalFiles: preview.totalFiles });
        }
        case 'POST /api/workspace/compile': {
          const body = await requestBody(input, init);
          const filePath = typeof body.filePath === 'string' ? body.filePath : '';
          if (!filePath.toLowerCase().endsWith('.tex')) {
            return json({ error: 'filePath must end with .tex' }, 400);
          }
          // Contract echo, like the cloud route. `source` forwards as a
          // freshness hint — the sidecar waits for the live doc to converge
          // to it, then compiles from disk (never persisting the snapshot).
          const result = await sidecar.compile(
            config,
            projectId,
            filePath,
            typeof body.source === 'string' ? body.source : null,
          );
          return json({
            ...result,
            trigger: isCompileTrigger(body.trigger) ? body.trigger : 'manual',
            sourceVersion: isSourceVersion(body.sourceVersion) ? body.sourceVersion : null,
          });
        }
        case 'GET /api/workspace/files/download': {
          const byId = url.searchParams.get('fileId');
          const path = byId
            ? ((await listFiles()).find((entry) => entry.id === byId)?.path ?? '')
            : (url.searchParams.get('path') ?? '');
          if (!path) return json({ error: 'File not found' }, 404);
          // Passthrough keeps bytes + Content-Type; callers read arrayBuffer.
          // Forward the caller's abort signal — the SyncTeX loader cancels a
          // stale download on PDF switch, and a late completion would install
          // the old index on the new PDF.
          return fetch(sidecar.fileUrl(config, projectId, path), { signal: init?.signal });
        }
        case 'GET /api/workspace/latex-root': {
          const { files } = await sidecar.textContents(config, projectId);
          const resolution = resolveLatexRoot({
            texFiles: files
              .filter((file) => file.path.toLowerCase().endsWith('.tex'))
              .map((file) => ({ path: file.path, content: file.text })),
            activeFile: url.searchParams.get('activeFile'),
          });
          return json(resolution);
        }
        case 'GET /api/workspace/chats': {
          // External sessions fail soft (older sidecar → 404): the chat list
          // must never break because discovery does.
          const [{ chats }, external] = await Promise.all([
            sidecar.listChats(config, projectId),
            sidecar.listExternalSessions(config, projectId).catch(() => ({ sessions: [] })),
          ]);
          return json({
            chats: [
              ...chats.map((chat) => ({ chat: toChatSummary(chat) })),
              ...external.sessions.map((session) => ({ chat: externalToChatSummary(session) })),
            ],
          });
        }
        case 'POST /api/workspace/chats': {
          const body = await requestBody(input, init);
          const { chat } = await sidecar.createChat(config, projectId, {
            title: typeof body.title === 'string' ? body.title : null,
            model: typeof body.model === 'string' ? body.model : null,
            harness: typeof body.harness === 'string' ? body.harness : null,
          });
          // The cloud route double-nests the created thread; match it.
          return json({ chat: { chat: toChatSummary(chat) } });
        }
        case 'PATCH /api/workspace/chats': {
          const body = await requestBody(input, init);
          const chatId = typeof body.chatId === 'string' ? body.chatId : '';
          if (!chatId) return json({ error: 'chatId is required' }, 400);
          const { chat } = await sidecar.patchChat(config, projectId, chatId, body);
          return json({ chat: toChatSummary(chat) });
        }
        case 'GET /api/workspace/messages': {
          const chatId = url.searchParams.get('chatId') ?? '';
          const external = parseExternalChatId(chatId);
          const { messages } = external
            ? await sidecar.externalSessionMessages(config, projectId, external.agent, external.sessionId)
            : await sidecar.chatMessages(config, projectId, chatId);
          return json({
            messages,
            page: { limit: null, beforeSequence: null, afterSequence: null, firstSequence: null, lastSequence: null, hasMore: false },
          });
        }
        case 'PATCH /api/workspace/messages': {
          const body = await requestBody(input, init);
          return json({ ok: true, lastReadSequence: body.lastReadSequence ?? 0 });
        }
        case 'POST /api/workspace/external-sessions/import': {
          const body = await requestBody(input, init);
          const { chat } = await sidecar.importExternalSession(config, projectId, {
            agent: typeof body.agent === 'string' ? body.agent : 'claude',
            id: typeof body.sessionId === 'string' ? body.sessionId : '',
          });
          return json({ chat: { chat: toChatSummary(chat) } });
        }
        case 'POST /api/workspace/messages': {
          const body = await requestBody(input, init);
          const chatId = typeof body.chatId === 'string' ? body.chatId : '';
          if (parseExternalChatId(chatId)) return json({ error: 'External sessions are read-only — import or resume first.' }, 400);
          const send = () =>
            sidecar.sendChatMessage(config, projectId, {
              chatId,
              content: typeof body.content === 'string' ? body.content : '',
              clientId: typeof body.clientId === 'string' ? body.clientId : null,
              // View mode is a permission boundary — the runner drops write
              // tools for the turn.
              editMode: typeof body.editMode === 'string' ? body.editMode : null,
            });
          let result = await send();
          // FIRST user message (stored even when the agent start is blocked):
          // async Haiku naming, like the cloud route — no synchronous title
          // write (guarded, so a rename always sticks).
          const content = typeof body.content === 'string' ? body.content.trim() : '';
          if (result.message?.sequence === 1 && content) {
            void nameLocalChatFromFirstMessage(config, projectId, chatId, content);
          }
          if (result.agentStart?.reason === 'credentials_missing') {
            const provisioned = await ensureAgentCredentials().catch(() => false);
            if (!provisioned) {
              return json({ message: result.message, agentStart: { status: 'blocked', reason: 'signin_required' } });
            }
            result = await send();
          }
          return json(result);
        }
        case 'GET /api/workspace/agent-stream': {
          // Straight passthrough to the sidecar's live run stream — resume
          // headers forward, X-Stream-Id comes back on the Response itself.
          const chatId = url.searchParams.get('chatId') ?? '';
          const headers: Record<string, string> = {
            Authorization: `Bearer ${config.token}`,
            Accept: 'text/event-stream',
          };
          // Headers normalizes every HeadersInit shape + case-insensitivity.
          const requestHeaders = new Headers(init?.headers);
          for (const name of ['Last-Event-ID', 'X-Resume-Stream-Id']) {
            const value = requestHeaders.get(name);
            if (value) headers[name] = value;
          }
          return fetch(
            `${config.origin}/projects/${projectId}/agent-stream?chatId=${encodeURIComponent(chatId)}`,
            { headers, signal: init?.signal ?? undefined },
          );
        }
        case 'POST /api/agent/interrupt': {
          const body = await requestBody(input, init);
          const result = await sidecar.interruptAgent(config, projectId, String(body.chatId ?? ''));
          return json(result);
        }
        case 'GET /api/workspace/models': {
          // Model catalog is a cloud read for signed-in users. Signed out,
          // fall back to a static Anthropic set so the local Claude engine
          // (the user's own subscription — no sign-in) still has a picker.
          const res = await fetch(input, init).catch(() => null);
          if (res?.ok) {
            const body = (await res.json().catch(() => null)) as { models?: unknown[] } | null;
            if (body?.models?.length) return json(body);
          }
          return json({ models: LOCAL_ENGINE_MODELS, emptyReason: null });
        }
        // Review panel / edit history: the sidecar's local_edits ledger stands
        // in for cloud doc_edits. Suggest sessions with live marks are pending
        // (Keep/Undo-able); everything else is read-only applied history.
        case 'GET /api/workspace/changes': {
          // Author narrowing reaches the sidecar (pre-cap, like the cloud
          // route) — a page dominated by one author must not bury another's
          // older sessions past the limit.
          const authors = url.searchParams.get('authors');
          const kindActors: Record<string, string[]> = {
            sunny: ['agent'],
            local_agent: ['local_agent'],
            human: ['user', 'anon', 'external', 'remote'],
          };
          const data = await sidecar.listChanges(config, projectId, {
            path: url.searchParams.get('path'),
            folder: url.searchParams.get('folder'),
            beforeId: url.searchParams.get('beforeId'),
            limit: url.searchParams.get('limit'),
            actors: authors ? authors.split(',').flatMap((kind) => kindActors[kind] ?? []) : null,
            chatId: url.searchParams.get('chatId'),
          });
          // Pre-filter counts, folded actor→kind so the chips stay truthful.
          const authorCounts = { sunny: 0, local_agent: 0, human: 0 };
          for (const [actor, count] of Object.entries(data.actorCounts ?? {})) {
            authorCounts[localChangeAuthor(actor, null).kind] += count;
          }
          const entries = data.entries.map((entry) => {
            const author = localChangeAuthor(entry.actor, entry.authorId);
            const pending = entry.reviewState === 'pending';
            return {
              reviewId: entry.reviewId,
              docEditId: entry.lastRowId,
              // A pending suggestion renders as a turn (TurnEditsCard detail,
              // pending chunks via the turn GET); once resolved it's a plain
              // applied session (read-only AppliedEditDetail).
              kind: pending ? ('turn' as const) : ('session' as const),
              author,
              chatId: entry.chatId ?? null,
              createdAt: entry.createdAt,
              // A pending suggest session arms the panel's Keep/Undo, which
              // routes to the sidecar's resolve-review (see keep-chunk below).
              editMode: entry.editMode === 'suggest' ? ('suggest' as const) : ('edit' as const),
              filePaths: [entry.path],
              editedFileCount: 1,
              reviewState: pending ? ('pending' as const) : ('applied' as const),
              messagePreview: summarizeSessionPreview([entry.path], entry.editCount),
              firstRowId: entry.firstRowId,
            };
          });
          return json({
            workspaceId: projectId,
            scope: {},
            entries,
            latestDocEditId: data.latestDocEditId,
            authorCounts,
            nextBeforeId: data.nextBeforeId,
          });
        }
        case 'GET /api/workspace/applied-edit': {
          const reviewId = url.searchParams.get('reviewId') ?? '';
          const filePath = url.searchParams.get('filePath') ?? '';
          const lastRowId = Number(reviewId.startsWith('applied-') ? reviewId.slice('applied-'.length) : 0);
          if (!filePath || !Number.isInteger(lastRowId) || lastRowId <= 0) {
            return json({ error: 'filePath and a valid reviewId are required' }, 400);
          }
          const data = await sidecar.appliedEdit(config, projectId, filePath, lastRowId);
          // Same oversized guard as the cloud route — the line diff is O(n²)
          // and runs in the BROWSER here; a huge ledger body must degrade to
          // the safe empty state, not freeze the panel.
          if (isOversizedTurnEditText(data.beforeText) || isOversizedTurnEditText(data.afterText)) {
            return json({ assistantMessageId: reviewId, files: [], allUndone: false });
          }
          const file = buildTurnEditFile({
            fileId: null,
            filePath,
            beforeText: data.beforeText,
            afterText: data.deleted ? '' : data.afterText,
            isNew: data.beforeText.length === 0,
            isDeleted: data.deleted,
          });
          // Already applied — every chunk renders read-only, like the cloud route.
          const files = file ? [{ ...file, chunks: file.chunks.map((chunk) => ({ ...chunk, status: 'kept' })) }] : [];
          return json({ assistantMessageId: reviewId, files, allUndone: false });
        }
        // The panel's Keep/Undo loads the diff payload through the turn GET,
        // then posts keep/undo. Locally a review unit is one session on one
        // file, and resolution is session-granular: the sidecar resolves the
        // session's staged suggestion ids (per-chunk decisions live in the
        // editor's inline ✓/✕), so the chunk ids in the POST bodies are
        // acknowledged but not consulted, and repeat per-chunk posts no-op.
        // Both verbs answer with the session's TurnEditsResponse — the chat
        // card writes the POST body into the shared turn-edits cache.
        case 'GET /api/workspace/turn-edits': {
          const reviewId = url.searchParams.get('assistantMessageId') ?? '';
          if (!parseSessionReviewId(reviewId)) return notImplemented(url.pathname);
          return json(await sessionTurnEdits(reviewId));
        }
        case 'POST /api/workspace/turn-edits/keep-chunk':
        case 'POST /api/workspace/turn-edits/undo-chunk': {
          const body = await requestBody(input, init);
          const reviewId = typeof body.assistantMessageId === 'string' ? body.assistantMessageId : '';
          if (!parseSessionReviewId(reviewId)) return notImplemented(url.pathname);
          const keep = route.endsWith('/keep-chunk');
          const outcome = await sidecar.resolveReview(config, projectId, { reviewId, action: keep ? 'accept' : 'reject' });
          return json(await sessionTurnEdits(reviewId, { after: outcome.after }));
        }
        case 'GET /api/workspace/history/compare': {
          const to = url.searchParams.get('to');
          if (!to) return json({ error: 'to is required' }, 400);
          const data = await sidecar.historyCompare(config, projectId, { from: url.searchParams.get('from'), to });
          return json({ from: data.from, to: data.to, files: data.files });
        }
        case 'GET /api/workspace/labels':
          return json(await sidecar.listLabels(config, projectId));
        case 'POST /api/workspace/labels': {
          const body = await requestBody(input, init);
          return json(
            await sidecar.upsertLabel(config, projectId, {
              docEditId: Number(body.docEditId ?? 0),
              name: typeof body.name === 'string' ? body.name : '',
            }),
          );
        }
        case 'DELETE /api/workspace/labels':
          return json(await sidecar.deleteLabel(config, projectId, url.searchParams.get('id') ?? ''));
        case 'POST /api/workspace/history/restore': {
          const body = await requestBody(input, init);
          return json(
            await sidecar.historyRestore(config, projectId, {
              path: typeof body.path === 'string' ? body.path : '',
              atId: typeof body.atDocEditId === 'number' ? body.atDocEditId : null,
              beforeCreatedAt: typeof body.beforeCreatedAt === 'string' ? body.beforeCreatedAt : null,
            }),
          );
        }
        // Comments live in the sidecar's SQLite store; anchors/authors pass
        // through opaquely and the sidecar echoes cloud-shaped threads back.
        case 'GET /api/workspace/comments': {
          const filePath = url.searchParams.get('scope') === 'workspace' ? null : url.searchParams.get('filePath');
          return json(await sidecar.listComments(config, projectId, filePath));
        }
        case 'POST /api/workspace/comments': {
          const body = await requestBody(input, init);
          return json(await sidecar.createComment(config, projectId, { ...body, path: body.filePath }));
        }
        case 'PATCH /api/workspace/comments':
        case 'DELETE /api/workspace/comments': {
          const body = await requestBody(input, init);
          return json(await sidecar.mutateComment(config, projectId, method as 'PATCH' | 'DELETE', body));
        }
        default:
          return notImplemented(url.pathname);
      }
    } catch (error) {
      const status = (error as { status?: number })?.status;
      // A transport-level rejection means the sidecar itself is unreachable —
      // surface that instead of the browser's bare TypeError message
      // ("Load failed" on WebKit), which reads like a data error.
      const message = error instanceof Error ? error.message : 'Local request failed';
      const unreachable = /^(Failed to fetch|Load failed|NetworkError)/.test(message);
      return json(
        { error: unreachable ? 'Sundial’s local service isn’t responding — quit and reopen the app if this persists.' : message },
        typeof status === 'number' ? status : 500,
      );
    }
  };

  return handle as typeof fetch;
}
