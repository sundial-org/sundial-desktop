'use client';

/** Client-side emulation of the `/api/workspace/*` REST surface, backed by the
 *  desktop sidecar — the seam that lets the real WorkspacePage render a local
 *  folder. Only the routes the page actually uses are implemented; anything
 *  outside `/api/workspace` falls through to the real fetch. Cloud-only routes
 *  return 501 and the page's existing fail-soft paths keep the UI coherent. */

import { isCrdtFile } from '@/lib/sync/policy';
import { decodeTextBlob } from '@/lib/sync/decode-text';
import { searchProject } from '@/lib/latex/project-search';
import { replaceProject } from '@/lib/latex/project-replace';
import { resolveLatexRoot } from '@/lib/workspace/latex-root';
import { isCompileTrigger, isSourceVersion } from '@/lib/latex/compile-contract';
import { duplicatePath } from '@/lib/workspace/uploads';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { sanitizeFileOrder, type FileOrderMap } from '@/lib/workspace/file-order';
import { authorDisplayName, classifyChangeAuthor, summarizeSessionPreview } from '@/lib/workspace/workspace-changes';
import { brandForAgentId } from '@/lib/workspace/agent-brand';
import {
  buildEmptyDeletedTurnEditFile,
  buildOversizedTurnEditFile,
  buildTurnEditFile,
  isOversizedTurnEditText,
} from '@/lib/workspace/turn-edits';
import { DEFAULT_SUNNY_AVATAR } from '@/lib/workspace/sunny-avatars';
import { deriveChatTitle } from '@/lib/workspace/derive-chat-title';
import { LOCAL_AI_PROJECT_ID } from '@/lib/workspace/local-ai';
import { sidecar, type LocalChat, type LocalExternalSession, type LocalFile, type SidecarConfig } from './sidecar';

/** `duplicateFile` seeds copies via GET /snapshots → POST create. Locally the
 *  snapshot is a path sentinel the create branch turns into a disk copy. */
const LOCAL_SNAPSHOT_PREFIX = 'sundial-local-path:';

/** Signed-out model picker for the local engines (subscription models — they
 *  run on the user's own Claude Code / Codex logins, no cloud catalog). */
const LOCAL_ENGINE_MODELS = [
  { id: 'anthropic/claude-sonnet-4.6', provider: 'anthropic', providerLabel: 'Anthropic', label: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-opus-5', provider: 'anthropic', providerLabel: 'Anthropic', label: 'Claude Opus 5' },
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
    folder_scope: chat.folder_scope ?? null,
    kind: chat.kind ?? null,
    comment_watch_path: chat.comment_watch_path ?? null,
    // Live runner state (sidecar v17+; undefined on older sidecars = unknown).
    running: chat.running,
    // Whether a started run still owes this chat's comment thread an answer
    // (v21+) — the window where the run is not live but the reply is still
    // coming. Undefined on older sidecars, which the panel reads as "can't
    // tell" and falls back to its pre-v21 behaviour.
    answering: chat.answering,
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
      ? await sidecar.writeFile(config, projectId, path, await decodeTextBlob(file))
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
  const named = await sidecar
    .patchChat(config, projectId, chatId, { autoTitle: title ?? deriveChatTitle(firstMessage) })
    .catch(() => null); // best-effort: an unnamed chat is not an error
  // Surface the settled title (post-CAS, so a mid-flight rename wins) to the
  // open page immediately — the 10s chat-list poll alone left the rail/header
  // on "New chat" for up to a full poll interval after naming completed.
  if (named?.chat?.title && typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('sundial:local-chat-titled', { detail: { chatId, title: named.chat.title } }),
    );
  }
}

/** `applied-<rowId>` → rowId; null for any other (cloud-shaped) review id. */
/** Folders that a delete left standing: the target and every directory down
 *  to a preserved ignored entry (a repo's `.git`, a `node_modules`). They are
 *  still on disk, so reporting them as deleted makes the tree drop rows that
 *  the next listing brings straight back. Exported for the delete mapping's
 *  regression test. */
export function survivingFolders(target: string, kept: string[]): Set<string> {
  const survived = new Set<string>();
  for (const keptPath of kept) {
    let dir = keptPath;
    for (let cut = dir.lastIndexOf('/'); cut > 0; cut = dir.lastIndexOf('/')) {
      dir = dir.slice(0, cut);
      if (dir !== target && !dir.startsWith(`${target}/`)) break;
      survived.add(dir);
    }
  }
  return survived;
}

function parseSessionReviewId(reviewId: string): number | null {
  const rowId = Number(reviewId.startsWith('applied-') ? reviewId.slice('applied-'.length) : 0);
  return Number.isInteger(rowId) && rowId > 0 ? rowId : null;
}

export function createLocalWorkspaceFetch(baseConfig: SidecarConfig, projectId: string): typeof fetch {
  // Helpers take the per-request config so a caller's AbortSignal reaches
  // every sidecar call the request makes (see the `config` shadow in handle).
  const listFiles = async (config: SidecarConfig) => (await sidecar.listFiles(config, projectId)).files;

  /** A suggest session's diff as a TurnEditsResponse. PENDING (the panel
   *  loads it before acting): the UNDECIDED delta — reject-projection →
   *  current accepted view — so a partially inline-decided session never
   *  shows already-accepted lines as actionable (the resolver would skip
   *  them). RESOLVED (the keep/undo POSTs answer with it): the SURVIVING
   *  delta — session-before → the file's post-resolution text, chunks kept.
   *  An empty surviving delta is `allUndone`. */
  const sessionTurnEdits = async (config: SidecarConfig, reviewId: string, resolved?: { after: string | null }) => {
    const data = await sidecar.appliedEdit(config, projectId, null, parseSessionReviewId(reviewId)!);
    const status = resolved ? ('kept' as const) : ('pending' as const);
    // Arms the card's ✓/✕: the chat's edit card only offers actions on a file
    // that carries an editMode, so the chat-edits tab showed pending LOCAL
    // suggestions with no way to keep or reject them (Codex, PR #1104 round
    // 15). A resolved session is settled — re-resolving no-ops — so it stays
    // modeless and renders informational, like the applied-edit payload.
    const editMode = resolved ? undefined : ('suggest' as const);
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
      const file = { ...buildOversizedTurnEditFile(params), editMode, oversized: !resolved, chunks: [sentinel] };
      return { assistantMessageId: reviewId, files: [file], allUndone: Boolean(resolved && afterText === beforeText) };
    }
    const file = buildTurnEditFile(params);
    const files = file
      ? [{ ...file, editMode, chunks: file.chunks.map((chunk) => ({ ...chunk, status })) }]
      : [];
    return { assistantMessageId: reviewId, files, allUndone: Boolean(resolved) && files.length === 0 };
  };

  /** One file a CHAT TURN edited → a read-only TurnEditFile. The turn's diff
   *  is history by the time the chip renders (local Keep/Undo is
   *  session-granular and lives in the Review panel), so every chunk is
   *  `kept`. Oversized bodies degrade to the size placeholder — the line diff
   *  is O(n²) and runs in the BROWSER here. */
  const turnEditFile = (row: {
    path: string;
    beforeText: string;
    afterText: string;
    deleted: boolean;
    existed?: boolean;
  }) => {
    const params = {
      fileId: null,
      filePath: row.path,
      beforeText: row.beforeText,
      afterText: row.deleted ? '' : row.afterText,
      // Ask the ledger whether the path was there, don't infer it from the
      // text: an existing EMPTY file has beforeText '' just like a brand new
      // one, and the length test labels editing it "Added". (Sidecars < 10
      // don't send the flag — fall back to the old inference.)
      isNew: (row.existed === undefined ? row.beforeText.length === 0 : !row.existed) && !row.deleted,
      isDeleted: row.deleted,
    };
    if (isOversizedTurnEditText(params.beforeText) || isOversizedTurnEditText(params.afterText)) {
      return [buildOversizedTurnEditFile(params)];
    }
    const file = buildTurnEditFile(params);
    if (!file) {
      // Two identical sides — a no-op edit, unless it's a DELETE of an already
      // empty file, which is a real change with no lines to show.
      return row.deleted ? [buildEmptyDeletedTurnEditFile({ fileId: null, filePath: row.path })] : [];
    }
    return [{ ...file, chunks: file.chunks.map((chunk) => ({ ...chunk, status: 'kept' as const })) }];
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
        const { configured } = await sidecar.agentCredentialsConfigured(baseConfig);
        if (configured) return true;
        const minted = await fetch('/api/auth/tokens', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Sundial Desktop · local Sunny', expires_in_days: 90 }),
        });
        const body = (await minted.json().catch(() => null)) as { token?: string } | null;
        if (!minted.ok || !body?.token) return false;
        await sidecar.setAgentCredentials(baseConfig, { apiOrigin: window.location.origin, token: body.token });
        return true;
      } finally {
        provisioning = null;
      }
    })();
    return provisioning;
  };

  /** Last known sidebar order from the backing workspace (a shared local
   *  project), refreshed in the BACKGROUND: the file list is the local lane's
   *  critical path and must never block on a cloud round trip. Until the first
   *  refresh answers — or when it can't (signed out, offline, pre-migration
   *  cloud) — the sidecar's own copy carries the tree. */
  let sharedOrder: FileOrderMap | null = null;
  let sharedOrderInFlight = false;
  const refreshSharedOrder = (workspaceId: string) => {
    if (sharedOrderInFlight) return;
    sharedOrderInFlight = true;
    void (async () => {
      try {
        const res = await fetch(`/api/workspace/file-order?projectId=${encodeURIComponent(workspaceId)}`, {
          credentials: 'include',
        });
        if (res.ok) {
          sharedOrder = sanitizeFileOrder(((await res.json()) as { fileOrder?: unknown }).fileOrder);
        }
      } catch {
        /* keep the last known order */
      } finally {
        sharedOrderInFlight = false;
      }
    })();
  };

  const handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (!url.pathname.startsWith('/api/workspace') && url.pathname !== '/api/agent/interrupt') {
      return fetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const route = `${method} ${url.pathname}`;
    // Thread the caller's abort into every sidecar call this request makes,
    // so an abandoned fetch actually frees its socket — the sidecar's single
    // origin has a 6-connection browser cap, and a parked request starves
    // everything behind it. Request inputs carry their own signal, like the
    // method and body above. (The liveness deadline itself lives in the
    // sidecar transport — see request() in lib/local/sidecar.ts.)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    const config = signal ? { ...baseConfig, signal } : baseConfig;

    try {
      switch (route) {
        case 'GET /api/workspace/files': {
          const [{ project, roots, backing_workspace_id: backing }, files, localOrder] = await Promise.all([
            sidecar.getProject(config, projectId),
            listFiles(config),
            // Older sidecars have no /file-order route — an unarranged tree
            // (alphabetical) is the right degradation, not a failed listing.
            // (An abort is the caller cancelling, not a degradation.)
            sidecar.getFileOrder(config, projectId).then((r) => r.fileOrder).catch((error) => {
              if (config.signal?.aborted) throw error;
              return {};
            }),
          ]);
          // Shared local project: the backing workspace holds the order every
          // collaborator sees, so it wins once known. Until it has one (a
          // folder arranged before it was shared), the sidecar's own stands
          // in and the next drag pushes it up.
          if (backing) refreshSharedOrder(backing);
          return json({
            fileOrder: sharedOrder && Object.keys(sharedOrder).length ? sharedOrder : localOrder,
            files: files.map((file) => toRow(projectId, file)),
            // Multi-root: the tree renders extra mounted folders as their own
            // top-level sections (see localRoots in the workspace page).
            localRoots: roots ?? [],
            canWrite: true,
            // A local folder is its user's own — owner-like arrival (chat
            // hero), never the non-owner document swap.
            isOwner: true,
            canAccessSecrets: false,
            projectTitle: project.name,
            projectStatus: 'active',
            projectKind: 'standard',
            hostUrl: null,
            cold: false,
          });
        }
        case 'PUT /api/workspace/file-order': {
          const body = await requestBody(input, init);
          const parent = typeof body.parent === 'string' ? body.parent : '';
          const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === 'string') : null;
          if (!parent || !names) return json({ error: 'parent and names are required' }, 400);
          const { fileOrder } = await sidecar.setFileOrder(config, projectId, { parent, names });
          // Shared local project: push the same parent up so collaborators on
          // the backing workspace get the arrangement. Best-effort — a signed
          // out or offline desktop keeps the local copy and re-pushes on the
          // next drag. The echoed map refreshes the read cache so the next
          // file-list poll can't serve a pre-drag order and snap the tree back.
          const { backing_workspace_id: backing } = await sidecar.getProject(config, projectId);
          if (backing) {
            const pushed = await fetch('/api/workspace/file-order', {
              method: 'PUT',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectId: backing, parent, names }),
            }).catch(() => null);
            if (pushed?.ok) {
              sharedOrder = sanitizeFileOrder(((await pushed.json()) as { fileOrder?: unknown }).fileOrder);
            }
          }
          return json({ fileOrder });
        }
        case 'POST /api/workspace/files': {
          const body = await requestBody(input, init);
          const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath : '';
          if (sourcePath) {
            const existing = new Set((await listFiles(config)).map((file) => file.path));
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
          const matching = (await listFiles(config)).filter(
            (file) => file.path === path || file.path.startsWith(`${path}/`),
          );
          const result = await sidecar.deletePath(config, projectId, path);
          // Ignored content (.git, node_modules, …) survives the delete, and so
          // does every folder on the way down to it — those rows are still on
          // disk and come back in the next listing, so they are NOT deleted.
          const kept = Array.isArray(result.kept) ? result.kept : [];
          const survived = survivingFolders(path, kept);
          const removed = matching.filter((file) => !survived.has(file.path));
          // Text deletes reconstruct from the local ledger (delete tombstone +
          // /history-restore); a blob in the batch makes it non-undoable, same
          // rule as the cloud route — as does UNTRACKED content the sidecar
          // reports (unknown-extension files/symlinks the listing never
          // showed; restore couldn't bring them back). `deletedAt` is the
          // SIDECAR's cutoff — guaranteed after its ledger writes, unlike a
          // browser timestamp.
          const restorable = !result.untracked && removed.every((file) => file.type !== 'blob')
            ? {
                folders: removed.filter((file) => file.type === 'folder').map((file) => file.path),
                texts: removed.filter((file) => file.type === 'text').map((file) => file.path),
              }
            : null;
          return json({
            ok: true,
            deleted: removed.map((file) => file.path),
            deletedAt: result.deletedAt ?? new Date().toISOString(),
            restorable,
            kept,
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
          const file = (await listFiles(config)).find((entry) => entry.id === body.fileId);
          if (!file) return json({ error: 'File not found' }, 404);
          return json({ signedUrl: sidecar.fileUrl(config, projectId, file.path) });
        }
        case 'GET /api/workspace/snapshots': {
          const fileId = url.searchParams.get('fileId');
          const file = (await listFiles(config)).find((entry) => entry.id === fileId);
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
        case 'GET /api/workspace/file-content': {
          // Per-file raw read (same seam as download) — the LaTeX completion
          // context loads `.tex`/`.bib` text through this route.
          const path = url.searchParams.get('path') ?? '';
          if (!path) return json({ error: 'projectId and path are required' }, 400);
          const res = await fetch(sidecar.fileUrl(config, projectId, path), { signal: signal ?? undefined });
          if (!res.ok) return json({ ok: true, exists: false, path });
          return json({ ok: true, exists: true, content: await res.text(), path });
        }
        case 'GET /api/workspace/files/download': {
          const byId = url.searchParams.get('fileId');
          const path = byId
            ? ((await listFiles(config)).find((entry) => entry.id === byId)?.path ?? '')
            : (url.searchParams.get('path') ?? '');
          if (!path) return json({ error: 'File not found' }, 404);
          // Passthrough keeps bytes + Content-Type; callers read arrayBuffer.
          // Forward the caller's abort signal — the SyncTeX loader cancels a
          // stale download on PDF switch, and a late completion would install
          // the old index on the new PDF.
          return fetch(sidecar.fileUrl(config, projectId, path), { signal: signal ?? undefined });
        }
        case 'GET /api/workspace/latex-root': {
          // Forward the abort: without it a timed-out resolve keeps holding a
          // connection in the 6-slot pool its deadline exists to protect.
          const { files } = await sidecar.textContents(config, projectId, undefined, init?.signal ?? undefined);
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
          // must never break because discovery does. An abort is the caller
          // cancelling, not a discovery failure — it must stay a rejection.
          const [{ chats }, external] = await Promise.all([
            sidecar.listChats(config, projectId),
            sidecar.listExternalSessions(config, projectId).catch((error) => {
              if (config.signal?.aborted) throw error;
              return { sessions: [] };
            }),
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
            folderScope: typeof body.folderScope === 'string' ? body.folderScope : null,
            kind: typeof body.kind === 'string' ? body.kind : null,
          });
          // The cloud route double-nests the created thread; match it.
          return json({ chat: { chat: toChatSummary(chat) } });
        }
        case 'DELETE /api/workspace/chats': {
          // Only the user's own confirmed "Delete chat" (mode=purge). The
          // cloud's OTHER caller — the lazy-lifecycle take-back of a
          // backspaced draft — has no local twin (armTypedEmpty is gated off
          // for local workspaces), so an unqualified DELETE stays 501 rather
          // than quietly destroying a chat the sidecar still considers live.
          if (url.searchParams.get('mode') !== 'purge') return notImplemented(url.pathname);
          const chatId = url.searchParams.get('chatId') ?? '';
          if (!chatId) return json({ error: 'chatId is required' }, 400);
          if (parseExternalChatId(chatId)) {
            return json({ error: 'External sessions live on disk. Delete them in the agent that wrote them.' }, 400);
          }
          await sidecar.deleteChat(config, projectId, chatId);
          return json({ deleted: true });
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
          const beforeRaw = url.searchParams.get('beforeSequence');
          const beforeSequence = beforeRaw ? Number(beforeRaw) : null;
          // FORWARD cursor, passed through like the backward one: the
          // long-turn recovery backfill pages with `afterSequence`, and
          // hardcoding 0 here made every page return the same newest window —
          // the middle of an uncapped local turn stayed missing after a replay
          // eviction. The sidecar has always honoured it.
          const afterRaw = url.searchParams.get('afterSequence');
          const afterSequence = afterRaw ? Number(afterRaw) : null;
          // An imported session is a file on disk, read whole — no cursor.
          const result = external
            ? await sidecar.externalSessionMessages(config, projectId, external.agent, external.sessionId)
            : await sidecar.chatMessages(config, projectId, chatId, afterSequence ?? 0, beforeSequence);
          const messages = result.messages;
          const page = (result as { page?: { firstSequence: number | null; hasMore: boolean } }).page ?? null;
          return json({
            messages,
            page: {
              limit: null,
              beforeSequence,
              afterSequence,
              // Real cursor + hasMore: the transcript export pages backwards
              // through these, and a flat `hasMore: false` stopped it at the
              // newest window — a long chat exported silently truncated.
              firstSequence: page?.firstSequence ?? null,
              lastSequence: null,
              hasMore: page?.hasMore ?? false,
            },
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
          if (parseExternalChatId(chatId)) return json({ error: 'External sessions are read-only. Import or resume first.' }, 400);
          const send = () =>
            sidecar.sendChatMessage(config, projectId, {
              chatId,
              content: typeof body.content === 'string' ? body.content : '',
              clientId: typeof body.clientId === 'string' ? body.clientId : null,
              attachments: Array.isArray(body.attachments) ? body.attachments : [],
              // View mode is a permission boundary — the runner drops write
              // tools for the turn.
              editMode: typeof body.editMode === 'string' ? body.editMode : null,
            }, init?.signal);
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
            { headers, signal: signal ?? undefined },
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
          const res = await fetch(input, init).catch((error) => {
            if (init?.signal?.aborted) throw error;
            return null;
          });
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
            // Polling the sidecar is a local SQLite read — cheap. Minting a
            // token opts the panel into its fast (2s) idle cadence; the shim
            // ignores `ifUnchanged` echoes (it never answers `unchanged`).
            pollToken: 'local',
          });
        }
        // The editor's inline review feed for one file — what the suggestion
        // gutter's author chip reads. Local review units are pending suggest
        // sessions on the path; `suggestionTurns` joins each session's staged
        // Y.Doc mark ids back to its reviewId (the cloud joins tool_call_id →
        // assistantMessageId the same way). Human-typed suggestions mint
        // doc-local ids with no ledger correlate, so they stay chip-less —
        // exactly like the cloud. Payloads arrive via the chat card's shared
        // turn-edits cache, so none are bundled here.
        case 'GET /api/workspace/file-pending-edits': {
          const filePath = url.searchParams.get('filePath') ?? '';
          if (!filePath) return json({ error: 'workspaceId and filePath are required' }, 400);
          // `pending` filters before the sidecar's page cap; the client-side
          // filter stays as the fallback for sidecars that ignore the param.
          const data = await sidecar.listChanges(config, projectId, { path: filePath, pending: true });
          const pending = data.entries.filter((entry) => entry.reviewState === 'pending');
          const suggestionTurns: Record<string, string> = {};
          for (const entry of pending) {
            for (const id of entry.suggestionIds ?? []) suggestionTurns[id] = entry.reviewId;
          }
          const turns = pending.map((entry) => ({
            // Keep/Undo and the turn-edits GET are keyed by the session id, so
            // this stays `applied-<rowId>` (`parseSessionReviewId` gates them).
            assistantMessageId: entry.reviewId,
            // …but the chip's jump needs the transcript's message id, which the
            // synthetic session id never matches. Null (human rows, older
            // sidecars) falls back to the session id — the chat still opens.
            jumpMessageId: entry.messageId ?? null,
            chatId: entry.chatId ?? null,
            createdAt: entry.createdAt,
            // The sidecar's own agent (actor 'agent') posts no user id — cloud
            // parity, and what makes the suggestion pill resolve the agent's
            // face. Its `authorId` is the ENGINE id (`ai:claude-code`…), corpus
            // metadata that would paint an external-agent brand mark on the
            // app's own agent (the review panel already reads these rows as
            // agent via localChangeAuthor). External agents keep their id.
            authorId:
              classifyChangeAuthor(entry.actor, entry.authorId) === 'sunny'
                ? null
                : entry.authorId ?? null,
            editedFileCount: 1,
            filePaths: [entry.path],
            messagePreview: summarizeSessionPreview([entry.path], entry.editCount),
          }));
          return json({ workspaceId: projectId, filePath, turns, payloads: {}, humanRuns: [], suggestionTurns });
        }
        // The chat-edits tab's summary list. Local review units are per-file
        // sessions (no assistant_message_id), so derive them from the same
        // sidecar listing the Review panel uses, scoped to this chat — their
        // `reviewId`s are exactly what the local turn-edits case above
        // resolves, so the cards load. (Codex, PR #1104 round 6.)
        case 'GET /api/workspace/chat-turn-edits': {
          const chatId = url.searchParams.get('chatId') ?? '';
          if (!chatId) return json({ error: 'chatId is required' }, 400);
          const data = await sidecar.listChanges(config, projectId, {
            chatId,
            limit: url.searchParams.get('limit'),
          });
          // PENDING sessions only. The local turn-edits shim renders any
          // `applied-<rowId>` GET as a session with pending chunks, so listing
          // already-applied history here would put live Keep/Undo controls on
          // settled edits and route clicks into `resolveReview` (Codex, PR
          // #1104 round 8). Applied local history stays in the Review dock,
          // which renders it read-only.
          const turns = data.entries
            .filter((entry) => entry.reviewState === 'pending')
            .map((entry) => ({
              assistantMessageId: entry.reviewId,
              chatId: entry.chatId ?? chatId,
              createdAt: entry.createdAt,
              authorId: entry.authorId ?? null,
              editedFileCount: 1,
              filePaths: [entry.path],
              messagePreview: summarizeSessionPreview([entry.path], entry.editCount),
            }));
          return json({ chatId, turns });
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
          if (parseSessionReviewId(reviewId)) return json(await sessionTurnEdits(config, reviewId));
          // Otherwise it's an assistant message id — the chat's diff chip.
          const { files } = await sidecar.turnEdits(config, projectId, reviewId);
          return json({ assistantMessageId: reviewId, files: files.flatMap(turnEditFile), allUndone: false });
        }
        case 'POST /api/workspace/turn-edits/keep-chunk':
        case 'POST /api/workspace/turn-edits/undo-chunk': {
          const body = await requestBody(input, init);
          const reviewId = typeof body.assistantMessageId === 'string' ? body.assistantMessageId : '';
          if (!parseSessionReviewId(reviewId)) return notImplemented(url.pathname);
          const keep = route.endsWith('/keep-chunk');
          const outcome = await sidecar.resolveReview(config, projectId, { reviewId, action: keep ? 'accept' : 'reject' });
          return json(await sessionTurnEdits(config, reviewId, { after: outcome.after }));
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
        // Cloud AI editor routes (rewrite, morph, factcheck, pangram,
        // humanize, image gen) have no local implementation — forward them to
        // the cloud through the sidecar proxy, which attaches the signed-in
        // user's parked sd_ token. The local project id is swapped for the
        // sentinel: no cloud project backs a local folder, and the routes
        // authorize on the signed-in caller instead.
        case 'POST /api/workspace/rewrite-variants':
        case 'POST /api/workspace/rewrite-variants/outcome':
        case 'POST /api/workspace/morph':
        case 'POST /api/workspace/factcheck':
        case 'POST /api/workspace/factcheck/feedback':
        case 'POST /api/workspace/pangram-check':
        case 'POST /api/workspace/humanize':
        case 'POST /api/workspace/generate-image':
        case 'POST /api/workspace/autocomplete': {
          const body = await requestBody(input, init);
          return fetch(url.pathname, {
            ...init,
            body: JSON.stringify({ ...body, projectId: LOCAL_AI_PROJECT_ID }),
          });
        }
        default:
          return notImplemented(url.pathname);
      }
    } catch (error) {
      // The caller cancelled — surface the platform rejection (like a real
      // aborted fetch), not a JSON error body.
      if (signal?.aborted) throw error;
      const status = (error as { status?: number })?.status;
      // A transport-level rejection means the sidecar itself is unreachable —
      // surface that instead of the browser's bare TypeError message
      // ("Load failed" on WebKit), which reads like a data error.
      const message = error instanceof Error ? error.message : 'Local request failed';
      const unreachable = /^(Failed to fetch|Load failed|NetworkError)/.test(message);
      // A bare `not found` is the sidecar's unknown-route 404 — i.e. an OLDER
      // sidecar process is holding the port and doesn't implement this route
      // (History, Comments, …). Panels render the raw string, so "not found"
      // is what the user sees; say what actually fixes it instead.
      const staleSidecar = status === 404 && /^not found$/i.test(message.trim());
      return json(
        {
          error: unreachable
            ? 'Sundial’s local service isn’t responding. Quit and reopen the app if this persists.'
            : staleSidecar
              ? 'This needs a newer version of Sundial’s local service. Quit and reopen the app (Check for Updates in the menu bar).'
              : message,
        },
        typeof status === 'number' ? status : 500,
      );
    }
  };

  return handle as typeof fetch;
}
