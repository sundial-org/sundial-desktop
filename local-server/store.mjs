import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export function defaultHome() {
  return process.env.SUNDIAL_LOCAL_HOME || path.join(os.homedir(), '.sundial', 'desktop');
}

export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** A chat must carry a model its engine can run — a Codex chat must not pair
 *  with an Anthropic model (mirrors the client's coerceModelForHarness). */
export function coerceModelForHarness(harness, model) {
  // No model at all also has to resolve: a chat minted for a detected engine
  // (comment mention, client that sends none) would otherwise carry null and
  // give the picker nothing to show.
  if (harness === 'claude' && (!model || !model.startsWith('anthropic/'))) return 'anthropic/claude-sonnet-4.6';
  if (harness === 'openai' && (!model || !model.startsWith('openai/'))) return 'openai/gpt-5.5';
  return model;
}

/** SQLite-backed store for everything the sidecar persists besides the user's
 *  own files: the project registry, per-file Y.Doc state (so suggestion marks
 *  and CRDT identity survive restarts), the local edit ledger (attribution /
 *  history), and share configs (which paths sync to which cloud workspace). */
export class LocalStore {
  constructor(home = defaultHome()) {
    // This directory contains cloud sync credentials. `mkdir`'s mode only
    // applies on first creation, so also tighten an existing install that was
    // created under a permissive umask.
    mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      chmodSync(home, 0o700);
    } catch {
      /* a read-only/mis-owned home will fail when SQLite opens below */
    }
    this.home = home;
    this.db = new DatabaseSync(path.join(home, 'sundial-local.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- Extra roots mounted into a project (multi-root): each serves its files
      -- under the single top-level 'prefix' segment. The primary root stays in
      -- projects.root with un-prefixed paths — existing rows never migrate.
      CREATE TABLE IF NOT EXISTS project_roots (
        project_id TEXT NOT NULL,
        prefix TEXT NOT NULL,
        root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, prefix)
      );
      CREATE TABLE IF NOT EXISTS doc_states (
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        state BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, path)
      );
      CREATE TABLE IF NOT EXISTS local_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        actor TEXT NOT NULL,
        author_id TEXT,
        edit_mode TEXT NOT NULL DEFAULT 'edit',
        content_text TEXT,
        update_b64 TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_edits_project_path
        ON local_edits (project_id, path, id);
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        scope_path TEXT NOT NULL DEFAULT '',
        scope_kind TEXT NOT NULL DEFAULT 'project',
        collab_url TEXT,
        api_origin TEXT,
        token TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shares_project ON shares (project_id);
      -- Scopes of a grants-model share (scope_kind 'union'): ONE share row per
      -- (project, backing workspace) syncs the union of these scopes at their
      -- real relative paths; each scope maps to a cloud path_shares grant.
      -- scope_path holds '' for 'project', a path for folder/file, the chat id
      -- for 'chat'.
      CREATE TABLE IF NOT EXISTS share_scopes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_path TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE (share_id, scope_kind, scope_path)
      );
      CREATE TABLE IF NOT EXISTS bridge_files (
        share_id TEXT NOT NULL,
        path TEXT NOT NULL,
        first_synced_at TEXT NOT NULL,
        PRIMARY KEY (share_id, path)
      );
      -- Blob sync bookkeeping: the content sha both sides agreed on last, plus
      -- the disk stat it corresponded to (so unchanged files skip rehashing).
      CREATE TABLE IF NOT EXISTS blob_sync (
        share_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sha TEXT NOT NULL,
        local_mtime_ms INTEGER,
        local_size INTEGER,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (share_id, path)
      );
      CREATE TABLE IF NOT EXISTS file_ids (
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        id TEXT NOT NULL,
        PRIMARY KEY (project_id, path)
      );
      CREATE TABLE IF NOT EXISTS local_chats (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        last_message_at TEXT,
        archived_at TEXT,
        pinned INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS local_chats_project ON local_chats (project_id, last_message_at);
      CREATE TABLE IF NOT EXISTS local_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        metadata TEXT,
        client_id TEXT,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_messages_chat ON local_messages (chat_id, sequence);
      -- Engine session ids WE caused: the local Claude engine spawns the CLI
      -- per turn, and the CLI writes its own transcript into ~/.claude —
      -- which the external-session scanner would then offer to import as a
      -- second chat. These are that chat, so they never list as external.
      CREATE TABLE IF NOT EXISTS local_engine_sessions (
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        chat_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (agent, session_id)
      );
      -- Single-user install settings (agent credentials, etc.).
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      -- Doc comments (threads + messages), the local twin of the cloud
      -- doc_comment_threads/doc_comment_messages tables. Anchors are opaque
      -- JSON payloads resolved client-side; author is a JSON snapshot.
      CREATE TABLE IF NOT EXISTS local_comment_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        author TEXT NOT NULL,
        quote TEXT NOT NULL,
        anchor TEXT NOT NULL,
        head TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT
      );
      CREATE INDEX IF NOT EXISTS local_comment_threads_project
        ON local_comment_threads (project_id, path);
      CREATE TABLE IF NOT EXISTS local_comment_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_comment_messages_thread
        ON local_comment_messages (thread_id, created_at);
      -- Mode A links for threads that live in the CLOUD store (share-covered
      -- paths): no local thread row exists to carry chat_id, so the link gets
      -- its own row.
      CREATE TABLE IF NOT EXISTS local_comment_thread_links (
        thread_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL
      );
      -- Poll-owned comment-delivery cursor, PERSISTED: a restart must not
      -- re-baseline over guest comments that arrived while the sidecar was
      -- offline (they'd be silently skipped forever).
      CREATE TABLE IF NOT EXISTS bridge_comment_seen (
        share_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (share_id, message_id)
      );
      -- Suggestion accept/reject decisions observed on local docs (the local
      -- twin of the cloud suggestion.* activity_events). Shipped to the cloud
      -- ledger mirror for shared projects.
      CREATE TABLE IF NOT EXISTS local_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        suggestion_id TEXT NOT NULL,
        suggestion_kind TEXT NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT,
        author_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_decisions_project ON local_decisions (project_id, id);
      -- Manual checkpoint labels pinned to a local_edits row (the local twin
      -- of the cloud history_labels table).
      CREATE TABLE IF NOT EXISTS local_history_labels (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        doc_edit_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, doc_edit_id)
      );
    `);
    // Additive migrations for databases created before the column existed.
    for (const migration of [
      'ALTER TABLE local_edits ADD COLUMN chat_id TEXT',
      // Which pending suggestion a suggest-mode row staged — the Review
      // panel's Keep/Undo resolves a session by these ids.
      'ALTER TABLE local_edits ADD COLUMN suggestion_id TEXT',
      // The assistant message whose turn made this edit — the local twin of
      // cloud `doc_edits.assistant_message_id`, and the key the chat's diff
      // chip (TurnEditsCard) is fetched by.
      'ALTER TABLE local_edits ADD COLUMN message_id TEXT',
      'CREATE INDEX IF NOT EXISTS local_edits_message ON local_edits (project_id, message_id)',
      // The path provably existed before this row's event (watcher tree /
      // file id), even when its text is unrecoverable — turnEditFiles falls
      // back to it when the path has no earlier row to prove existence by.
      'ALTER TABLE local_edits ADD COLUMN pre_existed INTEGER',
      // Which agent runtime runs the chat ('claude' = the user's own Claude
      // Code subscription, run by the sidecar; null/'vercel' = cloud Sunny).
      'ALTER TABLE local_chats ADD COLUMN harness TEXT',
      // Adopted external session (Import/Resume of a Claude Code / Codex
      // transcript): the ORIGINAL session id, immutable — it keys the listing
      // exclusion. Resuming can fork the engine to a new id; that live resume
      // target lives in external_resume_id so the original stays excluded.
      'ALTER TABLE local_chats ADD COLUMN external_agent TEXT',
      'ALTER TABLE local_chats ADD COLUMN external_session_id TEXT',
      'ALTER TABLE local_chats ADD COLUMN external_resume_id TEXT',
      // The session's recorded working directory, captured at import — resume
      // must run there, and the capped scanner can age the original file out.
      'ALTER TABLE local_chats ADD COLUMN external_cwd TEXT',
      // Attach-to-existing-workspace (serve.sh --workspace): the identity
      // that owns the ATTACHED workspace differs from this install's own
      // headless identity, so the daily token re-mint must remember which
      // key to present. Null = the install identity (create-from-folder).
      'ALTER TABLE shares ADD COLUMN mint_key TEXT',
      // 'user' = the share re-mints with the install's signed-in credentials
      // (settings.agent_credentials) instead of an anon key — attaching a
      // workspace the signed-in account already has access to.
      'ALTER TABLE shares ADD COLUMN mint_kind TEXT',
      // Workspace-scoped credential minted through the hosted MCP OAuth
      // handoff. It never leaves the sidecar again; refresh is performed by
      // the token-gated local endpoint on the row's behalf.
      'ALTER TABLE shares ADD COLUMN refresh_credential TEXT',
      // Folder the chat was started in ("New chat in this folder") — the
      // rail's folder-focus filter reads it.
      'ALTER TABLE local_chats ADD COLUMN folder_scope TEXT',
      // Scope generation (PR #1033): per-project monotonic int stamped on
      // every freshly added scope. Cloud grants record it at mint; stops
      // revoke ≤ their scope's generation, so a re-added scope's newer grant
      // survives and a dead tab's stale mint is refused server-side.
      'ALTER TABLE share_scopes ADD COLUMN generation INTEGER',
      // Agents react to comments. Mode A: the chat a thread owns once someone
      // @sunny'd it. Mode B: null = not listening, '*' = the whole project,
      // else a project-relative path. The file id (file_ids: minted per path,
      // RETIRED on delete, moved on rename) is authoritative when present, so
      // a delete-then-recreate at the same path can't steal a subscription —
      // the cloud's comment_watch_file_id rule.
      'ALTER TABLE local_comment_threads ADD COLUMN chat_id TEXT',
      'ALTER TABLE local_chats ADD COLUMN comment_watch_path TEXT',
      'ALTER TABLE local_chats ADD COLUMN comment_watch_file_id TEXT',
      // Purpose marker for special chats (the cloud's chats.kind twin) —
      // 'latex_fix' = the project's one dedicated compile-fix chat.
      'ALTER TABLE local_chats ADD COLUMN kind TEXT',
    ]) {
      try {
        this.db.exec(migration);
      } catch {
        /* column already present */
      }
    }
    this.adoptDefaultHarness();
    this.backfillScopeGenerations();
  }

  /** Scopes added before generations existed carry NULL, and a stop without a
   *  generation raises NO revocation watermark — with the cloud twins now
   *  retained, a stale tab could mint a generation-less grant back onto a
   *  share the user already stopped. Stamp every legacy scope at boot (and
   *  lift its project's counter above them) so every stop watermarks. The
   *  cloud rows stay NULL until the next mint adopts them, which is why the
   *  mint route only resets the audience when it raises OVER a recorded
   *  generation (Codex P1 round 22). */
  backfillScopeGenerations() {
    const legacy = this.db
      .prepare(
        `SELECT sc.id AS id, s.project_id AS project_id FROM share_scopes sc
         JOIN shares s ON s.id = sc.share_id WHERE sc.generation IS NULL ORDER BY sc.id ASC`,
      )
      .all();
    for (const row of legacy) {
      this.db
        .prepare('UPDATE share_scopes SET generation = ? WHERE id = ?')
        .run(this.nextScopeGeneration(row.project_id), row.id);
    }
  }

  /** Chats created before engine stamping carry harness NULL. An EXPLICIT
   *  pick points the empty ones at it; chats with messages keep their engine
   *  (a Sunny conversation must not switch mid-thread). Runs at boot and again
   *  when the default is picked, so an upgraded install doesn't need a restart
   *  for its legacy chats to follow. Chats still carrying NULL resolve to the
   *  install default at run time instead (server's runHarness). */
  adoptDefaultHarness() {
    const harness = this.getSetting('default_harness');
    if (!harness) return;
    const rows = this.db
      .prepare(
        `SELECT id, model FROM local_chats WHERE harness IS NULL
           AND NOT EXISTS (SELECT 1 FROM local_messages m WHERE m.chat_id = local_chats.id)`,
      )
      .all();
    const stamp = this.db.prepare('UPDATE local_chats SET harness = ?, model = ? WHERE id = ?');
    for (const row of rows) stamp.run(harness, coerceModelForHarness(harness, row.model), row.id);
  }

  // ---- Local Sunny: chats, messages, cloud credentials -------------------

  listChats(projectId) {
    // message_count feeds the client's per-chat engine lock: it must know a
    // chat has messages BEFORE the transcript loads.
    return this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM local_messages m WHERE m.chat_id = c.id) AS message_count
         FROM local_chats c WHERE c.project_id = ? ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      )
      .all(projectId);
  }

  createChat(projectId, { title = null, model = null, harness = null, externalAgent = null, externalSessionId = null, externalCwd = null, folderScope = null, kind = null } = {}) {
    const chat = {
      id: randomUUID(),
      project_id: projectId,
      title,
      model,
      harness,
      external_agent: externalAgent,
      external_session_id: externalSessionId,
      external_cwd: externalCwd,
      folder_scope: folderScope,
      kind,
      created_at: new Date().toISOString(),
      last_message_at: null,
      archived_at: null,
      pinned: 0,
      message_count: 0,
    };
    this.db
      .prepare(
        'INSERT INTO local_chats (id, project_id, title, model, harness, external_agent, external_session_id, external_cwd, folder_scope, kind, created_at, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
      )
      .run(chat.id, projectId, title, model, harness, externalAgent, externalSessionId, externalCwd, folderScope, kind, chat.created_at);
    return chat;
  }

  /** The chat that already adopted this external session, if any — imports
   *  must be idempotent (a double-click or second window re-posting). */
  findChatByExternalSession(projectId, agent, sessionId) {
    const row = this.db
      .prepare('SELECT id FROM local_chats WHERE project_id = ? AND external_agent = ? AND external_session_id = ? LIMIT 1')
      .get(projectId, agent, sessionId);
    return row ? this.getChat(row.id) : null;
  }

  /** A session the local engine itself opened — the CLI writes a transcript
   *  per turn, and without this every Sundial turn would come back as an
   *  "external session" to import. `chatId` is null when the scanner claims
   *  one after the fact (a run predating this ledger). */
  recordEngineSession(agent, sessionId, chatId = null) {
    if (!agent || !sessionId) return;
    this.db
      .prepare('INSERT OR IGNORE INTO local_engine_sessions (agent, session_id, chat_id, created_at) VALUES (?, ?, ?, ?)')
      .run(agent, sessionId, chatId, new Date().toISOString());
  }

  /** `${agent}:${sessionId}` for every session that is already a chat here:
   *  adopted external sessions (original id AND live resume target, so
   *  neither the imported transcript nor a resumed fork's continuation file
   *  lists as a second chat) plus every session our own engines opened.
   *  Engine sessions match on id alone — a session we created is never
   *  somebody's external chat, in this project or any other. */
  externalSessionLinks(projectId) {
    const links = new Set();
    for (const row of this.db
      .prepare(
        'SELECT external_agent, external_session_id, external_resume_id FROM local_chats WHERE project_id = ? AND external_session_id IS NOT NULL',
      )
      .all(projectId)) {
      links.add(`${row.external_agent}:${row.external_session_id}`);
      if (row.external_resume_id) links.add(`${row.external_agent}:${row.external_resume_id}`);
    }
    for (const row of this.db.prepare('SELECT agent, session_id FROM local_engine_sessions').all()) {
      links.add(`${row.agent}:${row.session_id}`);
    }
    return links;
  }

  getChat(chatId) {
    // Same shape as listChats — PATCH/create responses merge into client
    // summaries, so message_count must never be missing (a 0 would unlock a
    // started chat's engine until its transcript loads).
    return (
      this.db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM local_messages m WHERE m.chat_id = c.id) AS message_count
           FROM local_chats c WHERE c.id = ?`,
        )
        .get(chatId) ?? null
    );
  }

  updateChat(chatId, patch) {
    const allowed = ['title', 'model', 'harness', 'archived_at', 'pinned', 'external_resume_id', 'comment_watch_path', 'comment_watch_file_id'];
    for (const key of allowed) {
      if (key in patch) {
        this.db.prepare(`UPDATE local_chats SET ${key} = ? WHERE id = ?`).run(patch[key], chatId);
      }
    }
    return this.getChat(chatId);
  }

  /** The user's confirmed "Delete chat": the row and its transcript go, in one
   *  transaction. Local twin of the cloud's delete_chat_forever, with the same
   *  survivor rule — the EDIT LEDGER outlives the chat (Review/history rows
   *  keep their diffs, just unattributed), and `local_engine_sessions` keeps
   *  its exclusion rows so a deleted chat's on-disk CLI transcript can't
   *  reappear in the importer. An IMPORTED external chat's own row does go,
   *  which correctly makes that session importable again. */
  deleteChat(chatId) {
    if (!this.db.prepare('SELECT 1 FROM local_chats WHERE id = ?').get(chatId)) return false;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE local_edits SET chat_id = NULL WHERE chat_id = ?').run(chatId);
      this.db.prepare('DELETE FROM local_comment_thread_links WHERE chat_id = ?').run(chatId);
      // A thread that MINTED this chat (an @agent mention) points at it from
      // its own row, not just the links table. Left set, the comment panel
      // keeps reading the thread as delegated and opens a chat that is gone.
      this.db.prepare('UPDATE local_comment_threads SET chat_id = NULL WHERE chat_id = ?').run(chatId);
      this.db.prepare('DELETE FROM local_messages WHERE chat_id = ?').run(chatId);
      this.db.prepare('DELETE FROM local_chats WHERE id = ?').run(chatId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  /** CAS for auto-generated titles: writes only while the chat is still
   *  unnamed (null/blank/the "New Chat" default), so a user rename — even one
   *  landing while the naming call is in flight — always wins. */
  setChatTitleIfUnset(chatId, title) {
    return (
      this.db
        .prepare(
          "UPDATE local_chats SET title = ? WHERE id = ? AND (title IS NULL OR TRIM(title) = '' OR title IN ('New Chat', 'New chat'))",
        )
        .run(title, chatId).changes > 0
    );
  }

  /** @param opts.fromOldest  Which END of the match the cap keeps. Default
   *    (false) keeps the NEWEST rows — a giant chat must never serve its
   *    oldest 1000 while dropping the user's newest messages. Pass true to
   *    take the EARLIEST rows after the cursor, which is what a forward pager
   *    needs: the newest-first selection returns the same tail on every page,
   *    so a walk from a cursor never advances into the middle of a long turn.
   *    Explicit rather than inferred from `afterSequence`, so no existing
   *    caller's window silently changes shape. */
  listChatMessages(
    projectId,
    chatId,
    { limit = 1000, afterSequence = 0, beforeSequence = null, fromOldest = false } = {},
  ) {
    // `beforeSequence` walks BACK a window at a time — the transcript export
    // uses it, and without it a chat longer than the cap exported silently
    // truncated.
    const rows = this.db
      .prepare(
        `SELECT * FROM local_messages WHERE project_id = ? AND chat_id = ? AND sequence > ?
           AND (? IS NULL OR sequence < ?) ORDER BY sequence ${fromOldest ? 'ASC' : 'DESC'} LIMIT ?`,
      )
      .all(projectId, chatId, afterSequence, beforeSequence, beforeSequence, limit);
    // Always returned oldest-first; only the SELECTION differs above.
    return (fromOldest ? rows : rows.reverse()).map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
  }

  /** Is there anything older than `sequence` in this chat? Drives `hasMore`,
   *  so a pager knows to keep going rather than stopping at the first window. */
  hasEarlierChatMessage(projectId, chatId, sequence) {
    if (typeof sequence !== 'number') return false;
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM local_messages WHERE project_id = ? AND chat_id = ? AND sequence < ? LIMIT 1')
        .get(projectId, chatId, sequence),
    );
  }

  /** Comment deliveries no completed turn ever answered. Completion is an
   *  explicit stamp (delivery_served), never inferred from position: a turn
   *  persists streaming assistant/tool rows BEFORE it finishes, so "is it the
   *  last row" would call a crashed mid-turn delivery served. Age-bounded so
   *  an old unanswered comment isn't resurrected on every boot. */
  listUnservedCommentDeliveries(sinceIso) {
    return this.db
      .prepare(
        `SELECT m.* FROM local_messages m
           JOIN local_chats c ON c.id = m.chat_id AND c.archived_at IS NULL
          WHERE m.role = 'user' AND json_extract(m.metadata, '$.source') = 'comment'
            AND json_extract(m.metadata, '$.delivery_served') IS NULL
            AND m.created_at >= ?
          ORDER BY m.created_at ASC`,
      )
      .all(sinceIso)
      .map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
  }

  hasUnservedCommentDelivery(chatId) {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM local_messages
            WHERE chat_id = ? AND role = 'user' AND json_extract(metadata, '$.source') = 'comment'
              AND json_extract(metadata, '$.delivery_served') IS NULL LIMIT 1`,
        )
        .get(chatId),
    );
  }

  /** Unserved delivery ids in a chat, snapshotted when a turn STARTS: only
   *  those are marked served when it completes. A comment that arrives (and
   *  parks) mid-turn is not in the snapshot, so its own queued run still owes
   *  it — stamping the whole chat would strand it. */
  unservedCommentDeliveryIds(chatId) {
    return this.db
      .prepare(
        `SELECT id FROM local_messages
          WHERE chat_id = ? AND role = 'user' AND json_extract(metadata, '$.source') = 'comment'
            AND json_extract(metadata, '$.delivery_served') IS NULL`,
      )
      .all(chatId)
      .map((row) => row.id);
  }

  /** Unserved deliveries split by whether a turn starting NOW would actually
   *  see them: rowsToModelMessages keeps the newest ~300 rows, so anything
   *  older can never reach the model and must not be marked served by a turn
   *  that never read it. */
  unservedCommentDeliveriesByVisibility(chatId, windowRows) {
    const newest =
      this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM local_messages WHERE chat_id = ?').get(chatId)?.seq ?? 0;
    const rows = this.db
      .prepare(
        `SELECT id, project_id, sequence, client_id,
                json_extract(metadata, '$.comment_thread_id') AS comment_thread_id
           FROM local_messages
          WHERE chat_id = ? AND role = 'user' AND json_extract(metadata, '$.source') = 'comment'
            AND json_extract(metadata, '$.delivery_served') IS NULL`,
      )
      .all(chatId);
    return {
      visible: rows.filter((row) => newest - row.sequence < windowRows),
      unreachable: rows.filter((row) => newest - row.sequence >= windowRows),
    };
  }

  markCommentDeliveriesServed(projectId, ids) {
    for (const id of ids ?? []) this.mergeMessageMetadata(projectId, id, { delivery_served: true });
    return (ids ?? []).length;
  }

  chatHasCommentDeliveries(chatId) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM local_messages WHERE chat_id = ? AND json_extract(metadata, '$.source') = 'comment' LIMIT 1")
        .get(chatId),
    );
  }

  findChatMessageByClientId(chatId, clientId) {
    if (!clientId) return null;
    const row = this.db
      .prepare('SELECT * FROM local_messages WHERE chat_id = ? AND client_id = ? LIMIT 1')
      .get(chatId, clientId);
    return row ? { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null } : null;
  }

  appendChatMessage(projectId, chatId, { id, role, content, metadata, clientId }) {
    const next = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM local_messages WHERE chat_id = ?')
      .get(chatId).seq;
    const row = {
      id: id ?? randomUUID(),
      project_id: projectId,
      chat_id: chatId,
      role,
      content: content ?? '',
      metadata: metadata ?? null,
      client_id: clientId ?? null,
      sequence: next,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO local_messages (id, project_id, chat_id, role, content, metadata, client_id, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, projectId, chatId, role, row.content, row.metadata ? JSON.stringify(row.metadata) : null, row.client_id, next, row.created_at);
    this.db.prepare('UPDATE local_chats SET last_message_at = ? WHERE id = ?').run(row.created_at, chatId);
    return row;
  }

  /** MERGE fields into a persisted message's metadata. appendChatMessage is
   *  INSERT-only (its id is the turn anchor), so the turn-edits top-up — whose
   *  ledger rows can land after the row was written — needs this to reach the
   *  row. Merging, not replacing: the row it re-stamps may already carry
   *  run_status/run_error from a turn that FAILED after editing files, and
   *  dropping those would make reload read the failed turn as clean. */
  getMessageMetadata(projectId, messageId) {
    const row = this.db
      .prepare('SELECT metadata FROM local_messages WHERE project_id = ? AND id = ?')
      .get(projectId, messageId);
    if (!row?.metadata) return null;
    try {
      return JSON.parse(row.metadata);
    } catch {
      return null;
    }
  }

  mergeMessageMetadata(projectId, messageId, fields) {
    const row = this.db
      .prepare('SELECT metadata FROM local_messages WHERE project_id = ? AND id = ?')
      .get(projectId, messageId);
    if (!row) return;
    let existing = {};
    try {
      existing = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      existing = {};
    }
    this.db
      .prepare('UPDATE local_messages SET metadata = ? WHERE project_id = ? AND id = ?')
      .run(JSON.stringify({ ...existing, ...fields }), projectId, messageId);
  }

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  /** Stable per-install id, minted once. Namespaces cloud ledger uploads:
   *  share ids are transient (a re-share regenerates one), and re-uploading
   *  retained rows under a fresh namespace would duplicate the trail. */
  installId() {
    let id = this.getSetting('install_id');
    if (!id) {
      id = randomUUID();
      this.setSetting('install_id', id);
    }
    return id;
  }

  /** A process/engine epoch for cloud sync-progress reports. The atomic
   *  upsert makes simultaneous old/new sidecars choose distinct generations;
   *  the cloud can therefore reject a late report from the replaced process. */
  nextSyncProgressGeneration(projectId) {
    const row = this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
         RETURNING value`,
      )
      .get(`sync_progress_generation:${projectId}`);
    return Number(row.value);
  }

  /** Manual sidebar order for a project: {parentFolder: childBasenames[]},
   *  '__root__' for the top level. Lives here rather than in the browser so
   *  the arrangement survives a cleared cache and follows the folder, and so
   *  a shared local project can mirror it to its backing workspace. */
  getFileOrder(projectId) {
    try {
      const parsed = JSON.parse(this.getSetting(`file_order:${projectId}`) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Write ONE parent's child list — same per-parent scoping as the cloud RPC,
   *  so two open windows arranging different folders don't clobber. */
  setFileOrder(projectId, parent, names) {
    const map = this.getFileOrder(projectId);
    if (names.length) map[parent] = names;
    else delete map[parent];
    this.setSetting(`file_order:${projectId}`, JSON.stringify(map));
    return map;
  }

  setSetting(key, value) {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Cloud credentials for local Sunny (one signed-in user per install). */
  setAgentCredentials(credentials) {
    if (!credentials) {
      this.db.prepare("DELETE FROM settings WHERE key = 'agent_credentials'").run();
      return;
    }
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('agent_credentials', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(credentials));
  }

  getAgentCredentials() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'agent_credentials'").get();
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  openProject(root, name) {
    const existing = this.db
      .prepare('SELECT id, root, name, created_at FROM projects WHERE root = ?')
      .get(root);
    if (existing) return existing;
    const project = {
      id: randomUUID(),
      root,
      name: name || path.basename(root),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO projects (id, root, name, created_at) VALUES (?, ?, ?, ?)')
      .run(project.id, project.root, project.name, project.created_at);
    return project;
  }

  getProject(id) {
    return this.db.prepare('SELECT id, root, name, created_at FROM projects WHERE id = ?').get(id) ?? null;
  }

  // ---- Extra roots (multi-root projects) ----------------------------------

  listExtraRoots(projectId) {
    return this.db
      .prepare('SELECT prefix, root, created_at FROM project_roots WHERE project_id = ? ORDER BY created_at ASC, prefix ASC')
      .all(projectId);
  }

  addExtraRoot(projectId, prefix, root) {
    const row = { project_id: projectId, prefix, root, created_at: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO project_roots (project_id, prefix, root, created_at) VALUES (?, ?, ?, ?)')
      .run(row.project_id, row.prefix, row.root, row.created_at);
    return row;
  }

  /** Detach an extra root: drop the mount row and every store trace under its
   *  prefix. The DISK is never touched. Doc state/file ids must go so a
   *  re-added folder (same or different) mints fresh CRDT identity, and the
   *  ledger/decisions/comments go with them — keeping rows for an unmounted
   *  path would contaminate a future mount at the same prefix (stale
   *  baselines, resurrected history). */
  removeExtraRoot(projectId, prefix) {
    this.db.prepare('DELETE FROM project_roots WHERE project_id = ? AND prefix = ?').run(projectId, prefix);
    this.deleteDocState(projectId, prefix);
    this.retireFileId(projectId, prefix);
    for (const table of ['local_edits', 'local_decisions']) {
      this.db
        .prepare(`DELETE FROM ${table} WHERE project_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')`)
        .run(projectId, prefix, prefix, prefix);
    }
    this.db
      .prepare(
        `DELETE FROM local_comment_messages WHERE thread_id IN (
           SELECT id FROM local_comment_threads WHERE project_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/'))`,
      )
      .run(projectId, prefix, prefix, prefix);
    this.db
      .prepare("DELETE FROM local_comment_threads WHERE project_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')")
      .run(projectId, prefix, prefix, prefix);
  }

  listProjects() {
    return this.db.prepare('SELECT id, root, name, created_at FROM projects ORDER BY created_at DESC').all();
  }

  renameProject(id, name) {
    this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
    return this.getProject(id);
  }

  removeProject(id) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM project_roots WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM doc_states WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM local_edits WHERE project_id = ?').run(id);
    this.db
      .prepare('DELETE FROM blob_sync WHERE share_id IN (SELECT id FROM shares WHERE project_id = ?)')
      .run(id);
    this.db.prepare('DELETE FROM shares WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM local_chats WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM local_messages WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM local_decisions WHERE project_id = ?').run(id);
    this.db
      .prepare('DELETE FROM local_comment_messages WHERE thread_id IN (SELECT id FROM local_comment_threads WHERE project_id = ?)')
      .run(id);
    this.db.prepare('DELETE FROM local_comment_threads WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM local_history_labels WHERE project_id = ?').run(id);
    // `settings` is a flat KV with no project FK — drop the namespaced key by
    // hand or it outlives the project. (`scope_generation:` deliberately
    // survives: revocation watermarks must not reset on re-open.)
    this.setSetting(`file_order:${id}`, null);
  }

  saveDocState(projectId, relPath, state, hash) {
    this.db
      .prepare(
        `INSERT INTO doc_states (project_id, path, state, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, path)
         DO UPDATE SET state = excluded.state, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
      )
      .run(projectId, relPath, state, hash, new Date().toISOString());
  }

  getDocState(projectId, relPath) {
    const row = this.db
      .prepare('SELECT state, content_hash, updated_at FROM doc_states WHERE project_id = ? AND path = ?')
      .get(projectId, relPath);
    if (!row) return null;
    return { state: new Uint8Array(row.state), contentHash: row.content_hash, updatedAt: row.updated_at };
  }

  /** Move stored doc state for a file OR a whole subtree (folder rename).
   *  Subtree matches use substr, not LIKE — a folder named a_b must not match
   *  acb/… (LIKE treats _ and % as wildcards). */
  renameDocState(projectId, fromPath, toPath) {
    this.db
      .prepare("DELETE FROM doc_states WHERE project_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')")
      .run(projectId, toPath, toPath, toPath);
    this.db
      .prepare('UPDATE doc_states SET path = ? WHERE project_id = ? AND path = ?')
      .run(toPath, projectId, fromPath);
    this.db
      .prepare(
        "UPDATE doc_states SET path = ? || substr(path, ?) WHERE project_id = ? AND substr(path, 1, length(?) + 1) = ? || '/'",
      )
      .run(toPath, fromPath.length + 1, projectId, fromPath, fromPath);
  }

  /** Drop stored doc state for a file OR a whole subtree (folder delete) —
   *  stale child state would otherwise resurrect old CRDT identity if the
   *  folder is recreated. */
  deleteDocState(projectId, relPath) {
    this.db
      .prepare("DELETE FROM doc_states WHERE project_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')")
      .run(projectId, relPath, relPath, relPath);
  }

  /** Which assistant turn a chat is running right now, injected by the sidecar
   *  (LocalAgentHost). Every AGENT-attributed rail — the writer, suggest
   *  staging, Bash/Codex disk writes via the watcher, delete tombstones —
   *  already carries the chat id, so resolving here stamps them all without
   *  threading a message id through each one. */
  setTurnResolver(resolve) {
    this.turnResolver = resolve;
  }

  recordEdit({ projectId, path: relPath, actor, authorId = null, editMode = 'edit', contentText = null, updateB64 = null, chatId = null, messageId: turnMessageId = null, turnResolved = false, suggestionId = null, preExisted = null }) {
    // Only the agent's own rows join a turn (cloud does the same: a human edit
    // never carries assistant_message_id) — a Keep click landing mid-run must
    // not join the running turn's diff.
    //
    // An explicit messageId WINS over the chat lookup: a watcher-attributed
    // write carries the id of the run whose window it landed in, and by the
    // time it is recorded that run may already have been replaced — resolving
    // by chat would stamp it with the REPLACEMENT's turn.
    //
    // `turnResolved` means the caller already DECIDED (the watcher's
    // attribution window): a null id there is "ambiguous, claim no turn", not
    // "unknown" — falling through to the chat would hand a superseded run's
    // late write to the replacement run that now owns the chat.
    const messageId =
      actor !== 'agent'
        ? null
        : turnMessageId || (!turnResolved && chatId ? this.turnResolver?.(chatId) : null) || null;
    const result = this.db
      .prepare(
        `INSERT INTO local_edits (project_id, path, actor, author_id, edit_mode, content_text, update_b64, chat_id, suggestion_id, message_id, pre_existed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, relPath, actor, authorId, editMode, contentText, updateB64, chatId, suggestionId, messageId, preExisted === null ? null : preExisted ? 1 : 0, new Date().toISOString());
    // Retention: rows carry full content_text per persist window, so a long
    // typing session on a big file would grow the ledger unbounded. Rows the
    // cloud ledger mirror hasn't uploaded yet are never trimmed — an offline
    // stretch must not lose granular attribution for shared projects.
    this.db
      .prepare(
        `DELETE FROM local_edits WHERE project_id = ? AND path = ? AND id <= (
           SELECT id FROM local_edits WHERE project_id = ? AND path = ?
           ORDER BY id DESC LIMIT 1 OFFSET 500
         ) AND id <= ?`,
      )
      .run(projectId, relPath, projectId, relPath, this.ledgerTrimFloor(projectId));
    return Number(result.lastInsertRowid);
  }

  // ---- Cloud ledger mirror (shared projects) ------------------------------

  ledgerCursor(shareId, kind) {
    return Number(this.getSetting(`ledger_cursor:${shareId}:${kind}`) ?? 0);
  }

  setLedgerCursor(shareId, kind, rowid) {
    this.setSetting(`ledger_cursor:${shareId}:${kind}`, String(rowid));
  }

  /** Freeze a new share unit's message cursor at the current ledger head and
   *  record the watermark: a project share mirrors a chat only once it becomes
   *  ACTIVE above it (see syncShareLedger). A unit with no record predates the
   *  rule and keeps mirroring every chat, so nothing in flight is stranded. */
  seedChatActivation(cursorKey, shareId) {
    const projectId = this.db.prepare('SELECT project_id FROM shares WHERE id = ?').get(shareId)?.project_id;
    if (!projectId) return;
    const head = Number(
      this.db.prepare('SELECT MAX(rowid) AS head FROM local_messages WHERE project_id = ?').get(projectId)?.head ?? 0,
    );
    this.setLedgerCursor(cursorKey, 'message', head);
    this.setChatActivation(cursorKey, { seed: head, replayed: [] });
  }

  chatActivation(cursorKey) {
    const raw = this.getSetting(`ledger_activation:${cursorKey}`);
    return raw ? JSON.parse(raw) : null;
  }

  setChatActivation(cursorKey, state) {
    this.setSetting(`ledger_activation:${cursorKey}`, JSON.stringify(state));
  }

  /** Chats carrying message rows above `sinceRowid`: a project share's
   *  activation signal (a message sent after the share, or a session import
   *  writing one). */
  chatsWithMessagesSince(projectId, sinceRowid) {
    return this.db
      .prepare('SELECT DISTINCT chat_id FROM local_messages WHERE rowid > ? AND project_id = ?')
      .all(sinceRowid, projectId)
      .map((row) => row.chat_id);
  }

  /** Forget the mirrored chat versions for a (project, workspace) pair. Only
   *  ever called once the cloud purge landed: while twins exist the counter
   *  must stay monotonic, or a re-minted v1 is dropped as a duplicate and the
   *  mirror sticks. */
  clearLedgerChatState(projectId, workspaceId) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(`ledger_chat_state:${projectId}:${workspaceId}`);
  }

  /** Highest local_edits id safe to trim for this project: everything is
   *  trimmable when no enabled share exists; otherwise only rows every enabled
   *  share has already uploaded. Chat shares never upload edits (their edit
   *  cursor stays 0 forever), so counting them would pin trimming and grow
   *  local_edits unbounded. */
  ledgerTrimFloor(projectId) {
    // Legacy shares carry one edit cursor each; union (grants-model) shares
    // carry one per PATH scope (chat scopes never upload edits).
    const cursors = [];
    for (const share of this.db
      .prepare("SELECT id, scope_kind FROM shares WHERE project_id = ? AND enabled = 1 AND scope_kind != 'chat'")
      .all(projectId)) {
      if (share.scope_kind !== 'union') {
        cursors.push(this.ledgerCursor(share.id, 'edit'));
        continue;
      }
      for (const scope of this.listShareScopes(share.id)) {
        if (scope.scope_kind !== 'chat') cursors.push(this.ledgerCursor(`scope:${scope.id}`, 'edit'));
      }
    }
    if (cursors.length === 0) return Number.MAX_SAFE_INTEGER;
    return Math.min(...cursors);
  }

  /** Ledger rows after `sinceRowid`, oldest first. rowid (not id) keys the
   *  upload cursor so every table pages the same way. */
  listLedgerRowsSince(table, projectId, sinceRowid, limit = 200) {
    return this.db
      .prepare(
        `SELECT rowid AS rid, * FROM ${table} WHERE project_id = ? AND rowid > ?
         ORDER BY rowid ASC LIMIT ?`,
      )
      .all(projectId, sinceRowid, limit);
  }

  recordDecision({ projectId, path: relPath, suggestionId, suggestionKind, decision, actor = null, authorId = null }) {
    this.db
      .prepare(
        `INSERT INTO local_decisions (project_id, path, suggestion_id, suggestion_kind, decision, actor, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, relPath, suggestionId, suggestionKind, decision, actor, authorId, new Date().toISOString());
  }

  /** Ledger delete marker (content_text NULL): recorded when a tracked file
   *  vanishes so history/compare can represent the deletion. Skipped when the
   *  path has no history or its last row is already a tombstone (e.g. the
   *  bridge recorded the cloud-delete first). */
  /** True when the path's newest ledger row is a delete tombstone — a prior
   *  file generation existed here and was deleted. */
  lastEditIsDelete(projectId, relPath) {
    const last = this.db
      .prepare('SELECT content_text, update_b64 FROM local_edits WHERE project_id = ? AND path = ? ORDER BY id DESC LIMIT 1')
      .get(projectId, relPath);
    return Boolean(last && last.content_text === null && last.update_b64 === null);
  }

  recordDeleteTombstone(projectId, relPath, actor = 'external', chatId = null, authorId = null, messageId = null, turnResolved = false, existed = false) {
    const last = this.db
      .prepare('SELECT content_text, update_b64 FROM local_edits WHERE project_id = ? AND path = ? ORDER BY id DESC LIMIT 1')
      .get(projectId, relPath);
    // Already a tombstone — never stack a second one.
    if (last && last.content_text === null && last.update_b64 === null) return;
    // No history at all: only record when the caller PROVED the file was there
    // (a file id had been minted for it). A never-opened, never-edited file
    // leaves no recoverable text, but the deletion itself must still reach the
    // turn diff — dropping it makes the file vanish from review silently.
    if (!last && !existed) return;
    this.recordEdit({ projectId, path: relPath, actor, authorId, chatId, messageId, turnResolved, contentText: null, preExisted: existed });
  }

  /** Stable file identity: minted per (project, path) on first sight, retired
   *  on delete so a recreated path gets a NEW id (the editor uses that to know
   *  a cached Y.Doc must not be reused), and moved on rename. */
  /** Read-only twin of ensureFileId: never mints (matching must not create
   *  identities for paths this sidecar has never seen). */
  knownFileId(projectId, relPath) {
    return this.db.prepare('SELECT id FROM file_ids WHERE project_id = ? AND path = ?').get(projectId, relPath)?.id ?? null;
  }

  ensureFileId(projectId, relPath) {
    const row = this.db.prepare('SELECT id FROM file_ids WHERE project_id = ? AND path = ?').get(projectId, relPath);
    if (row) return row.id;
    const id = randomUUID();
    this.db.prepare('INSERT INTO file_ids (project_id, path, id) VALUES (?, ?, ?)').run(projectId, relPath, id);
    return id;
  }

  /** Restore a specific id at a path (watcher-rename adoption: the delete
   *  half retired the row, the create half puts the SAME identity back). */
  setFileId(projectId, relPath, id) {
    this.db
      .prepare('INSERT OR REPLACE INTO file_ids (project_id, path, id) VALUES (?, ?, ?)')
      .run(projectId, relPath, id);
  }

  /** Bulk ensureFileId for a whole listing: one read + one insert transaction
   *  instead of per-file prepare/autocommit, which blocked the event loop for
   *  seconds on a big folder's first /files walk. */
  ensureFileIds(projectId, relPaths) {
    const ids = new Map(
      this.db.prepare('SELECT path, id FROM file_ids WHERE project_id = ?').all(projectId)
        .map((row) => [row.path, row.id]),
    );
    const missing = relPaths.filter((relPath) => !ids.has(relPath));
    if (missing.length) {
      const insert = this.db.prepare('INSERT INTO file_ids (project_id, path, id) VALUES (?, ?, ?)');
      this.db.exec('BEGIN');
      try {
        for (const relPath of missing) {
          const id = randomUUID();
          insert.run(projectId, relPath, id);
          ids.set(relPath, id);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    return ids;
  }

  /** Any tracked trace at rel or under rel/ — the watcher's cheap pre-filter
   *  so untracked churn (caches, build junk) never reaches the doc host.
   *  Checks ids, CRDT state AND history: state can exist for paths whose ids
   *  were never minted (agent edit to a never-listed file). The range compare
   *  is an index-friendly prefix match ('0' follows '/'). */
  hasTraceUnder(projectId, relPath) {
    const probe = (table) =>
      this.db
        .prepare(
          `SELECT 1 FROM ${table} WHERE project_id = ?
           AND (path = ? OR (path >= ? || '/' AND path < ? || '0')) LIMIT 1`,
        )
        .get(projectId, relPath, relPath, relPath);
    // Bridge bookkeeping is share-scoped: synced files (blobs especially) can
    // be tracked ONLY there, and their folder deletes must reach the bridges.
    const probeShared = (table) =>
      this.db
        .prepare(
          `SELECT 1 FROM ${table} t JOIN shares s ON s.id = t.share_id
           WHERE s.project_id = ?
           AND (t.path = ? OR (t.path >= ? || '/' AND t.path < ? || '0')) LIMIT 1`,
        )
        .get(projectId, relPath, relPath, relPath);
    return Boolean(
      probe('file_ids') || probe('doc_states') || probe('local_edits') ||
      probeShared('bridge_files') || probeShared('blob_sync'),
    );
  }

  /** Tracked paths whose stored doc state matches this content hash — used
   *  to spot a rename's source when its delete event hasn't landed yet. */
  pathsByContentHash(projectId, hash) {
    return this.db
      .prepare('SELECT path FROM doc_states WHERE project_id = ? AND content_hash = ?')
      .all(projectId, hash)
      .map((row) => row.path);
  }

  /** Content hash of the path's last recorded text, if any — the delete-time
   *  fallback for files with no live doc or stored state. */
  lastRecordedHash(projectId, relPath) {
    const row = this.db
      .prepare(
        `SELECT content_text FROM local_edits
         WHERE project_id = ? AND path = ? AND content_text IS NOT NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(projectId, relPath);
    return row ? contentHash(row.content_text) : null;
  }

  /** Paths with any persisted identity/state under `prefix/` — used to
   *  reconcile store rows for files deleted while their doc wasn't open. */
  listTrackedPaths(projectId, prefix) {
    const under = (table) =>
      this.db
        .prepare(`SELECT path FROM ${table} WHERE project_id = ? AND substr(path, 1, length(?) + 1) = ? || '/'`)
        .all(projectId, prefix, prefix)
        .map((row) => row.path);
    return [...new Set([...under('doc_states'), ...under('file_ids')])];
  }

  /** Has this path ever been listed? An id is minted on first sight, so this
   *  answers "the file was really there" for a path with no ledger history and
   *  no doc state — the only surviving proof once disk has moved on. Must be
   *  read BEFORE retireFileId. */
  hasFileId(projectId, relPath) {
    return (
      this.db.prepare('SELECT 1 FROM file_ids WHERE project_id = ? AND path = ? LIMIT 1').get(projectId, relPath) !==
      undefined
    );
  }

  retireFileId(projectId, relPath) {
    this.db
      .prepare("DELETE FROM file_ids WHERE project_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')")
      .run(projectId, relPath, relPath, relPath);
  }

  renameFileIds(projectId, fromPath, toPath) {
    this.retireFileId(projectId, toPath);
    this.db
      .prepare('UPDATE file_ids SET path = ? WHERE project_id = ? AND path = ?')
      .run(toPath, projectId, fromPath);
    this.db
      .prepare(
        "UPDATE file_ids SET path = ? || substr(path, ?) WHERE project_id = ? AND substr(path, 1, length(?) + 1) = ? || '/'",
      )
      .run(toPath, fromPath.length + 1, projectId, fromPath, fromPath);
  }

  /** Newest-first ledger window with full attribution columns (no bodies),
   *  optionally scoped and cursored for older pages; returned ascending, the
   *  order session grouping needs. `capped` = more history exists below. */
  listEditsWindow(projectId, { path = null, folder = null, beforeId = null, actors = null, chatId = null, limit = 2000 } = {}) {
    const where = ['project_id = ?'];
    const params = [projectId];
    if (path) {
      where.push('path = ?');
      params.push(path);
    }
    // Actor/chat narrowing here is a LOCATOR scan only (recent unrelated
    // edits must not bury the selected author/chat past the window) — its
    // rows are never grouped directly; the caller re-reads matched paths'
    // full streams so interposed rows still split sessions.
    if (chatId) {
      where.push('chat_id = ?');
      params.push(chatId);
    }
    if (actors?.length) {
      where.push(`actor IN (${actors.map(() => '?').join(', ')})`);
      params.push(...actors);
    }
    if (folder) {
      where.push("substr(path, 1, length(?) + 1) = ? || '/'");
      params.push(folder, folder);
    }
    if (beforeId) {
      where.push('id < ?');
      params.push(beforeId);
    }
    const rows = this.db
      .prepare(
        `SELECT id, path, actor, author_id, edit_mode, suggestion_id, chat_id, message_id, created_at FROM local_edits
         WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit);
    return { rows: rows.reverse(), capped: rows.length >= limit };
  }

  latestEditId(projectId) {
    const row = this.db
      .prepare('SELECT MAX(id) AS id FROM local_edits WHERE project_id = ?')
      .get(projectId);
    return row?.id ?? null;
  }

  /** Ledger rows for one path up to (and including) a row id, ascending —
   *  bounded like the cloud applied-edit window. */
  listPathEditsUpTo(projectId, relPath, lastRowId, limit = 800) {
    return this.db
      .prepare(
        `SELECT id, path, actor, author_id, edit_mode, suggestion_id, chat_id, message_id, created_at FROM local_edits
         WHERE project_id = ? AND path = ? AND id <= ? ORDER BY id DESC LIMIT ?`,
      )
      .all(projectId, relPath, lastRowId, limit)
      .reverse();
  }

  getEditContent(rowId) {
    return this.db.prepare('SELECT id, content_text FROM local_edits WHERE id = ?').get(rowId) ?? null;
  }

  /** Files one agent turn touched — the chat diff chip's gate + count (the
   *  local twin of the brain's countDistinctEditedPaths). */
  countTurnEditedPaths(projectId, messageId) {
    if (!messageId) return 0;
    return this.db
      .prepare('SELECT COUNT(DISTINCT path) AS n FROM local_edits WHERE project_id = ? AND message_id = ?')
      .get(projectId, messageId)?.n ?? 0;
  }

  /** Per-file before/after for one turn: the row before the turn's first touch
   *  of a path vs its last. A null-content last row is the delete tombstone. */
  turnEditFiles(projectId, messageId) {
    if (!messageId) return [];
    return this.db
      .prepare(
        `SELECT path, MIN(id) AS first_id, MAX(id) AS last_id FROM local_edits
         WHERE project_id = ? AND message_id = ? GROUP BY path ORDER BY MIN(id)`,
      )
      .all(projectId, messageId)
      .map(({ path: relPath, first_id: firstId, last_id: lastId }) => {
        const before = this.db
          .prepare(
            `SELECT content_text FROM local_edits
             WHERE project_id = ? AND path = ? AND id < ? ORDER BY id DESC LIMIT 1`,
          )
          .get(projectId, relPath, firstId);
        const after = this.getEditContent(lastId);
        return {
          path: relPath,
          beforeText: before?.content_text ?? '',
          afterText: after?.content_text ?? '',
          deleted: after?.content_text === null,
          // Existence can't be read off beforeText: an EMPTY file that already
          // existed has '' too, and deriving it from the length labels a real
          // edit "Added". A prior row with text means it was there. Otherwise
          // (no prior row, or only a tombstone) the turn's FIRST row carries
          // the watcher's existence proof — a file deleted in a past session
          // but recreated offline pre-exists this turn despite its tombstone.
          // First row, not any: a later same-turn row for a turn-created path
          // reads seen-before and must not relabel it.
          existed:
            (before ? before.content_text !== null : false) ||
            Boolean(this.db.prepare('SELECT pre_existed FROM local_edits WHERE id = ?').get(firstId)?.pre_existed),
        };
      });
  }

  /** The path a ledger row belongs to — resolves a `applied-<rowId>` review id
   *  when the caller has no path (the panel's turn-edits GET). */
  editPath(projectId, rowId) {
    return this.db.prepare('SELECT path FROM local_edits WHERE project_id = ? AND id = ?').get(projectId, rowId)?.path ?? null;
  }

  hasEdits(projectId, relPath) {
    return this.db.prepare('SELECT 1 FROM local_edits WHERE project_id = ? AND path = ? LIMIT 1').get(projectId, relPath) !== undefined;
  }

  /** The document text at a history point: the newest row ≤ `atId` for the
   *  path. `null` content = the row carries no body (a cloud-delete marker or
   *  a bridge write) — callers treat it as "absent at this point". Returns
   *  undefined when no row exists at or before the point (path unborn — or
   *  older than the per-path retention window). */
  editTextAt(projectId, relPath, atId) {
    const row = this.db
      .prepare(
        `SELECT content_text FROM local_edits
         WHERE project_id = ? AND path = ? AND id <= ? ORDER BY id DESC LIMIT 1`,
      )
      .get(projectId, relPath, atId);
    return row === undefined ? undefined : row.content_text;
  }

  /** Newest recorded body for a path, optionally bounded by a row id and/or a
   *  timestamp (the two restore addressing modes). Undefined = none recorded. */
  latestContentBefore(projectId, relPath, { atId = null, beforeCreatedAt = null } = {}) {
    const where = ['project_id = ?', 'path = ?', 'content_text IS NOT NULL'];
    const params = [projectId, relPath];
    if (atId) {
      where.push('id <= ?');
      params.push(atId);
    }
    if (beforeCreatedAt) {
      where.push('created_at < ?');
      params.push(beforeCreatedAt);
    }
    const row = this.db
      .prepare(`SELECT content_text FROM local_edits WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`)
      .get(...params);
    return row?.content_text;
  }

  /** Distinct ledger paths under `prefix/` — the folder-delete tombstone sweep. */
  listEditPathsUnder(projectId, prefix) {
    return this.db
      .prepare("SELECT DISTINCT path FROM local_edits WHERE project_id = ? AND substr(path, 1, length(?) + 1) = ? || '/'")
      .all(projectId, prefix, prefix)
      .map((row) => row.path);
  }

  listEditPaths(projectId, upToId = null) {
    const rows = upToId
      ? this.db
          .prepare('SELECT DISTINCT path FROM local_edits WHERE project_id = ? AND id <= ?')
          .all(projectId, upToId)
      : this.db.prepare('SELECT DISTINCT path FROM local_edits WHERE project_id = ?').all(projectId);
    return rows.map((row) => row.path);
  }

  // ---- History labels ------------------------------------------------------

  listHistoryLabels(projectId) {
    return this.db
      .prepare('SELECT id, doc_edit_id, name, created_at FROM local_history_labels WHERE project_id = ? ORDER BY doc_edit_id DESC')
      .all(projectId)
      .map((row) => ({ id: row.id, docEditId: row.doc_edit_id, name: row.name, createdBy: null, createdAt: row.created_at }));
  }

  upsertHistoryLabel(projectId, docEditId, name) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO local_history_labels (id, project_id, doc_edit_id, name, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, doc_edit_id) DO UPDATE SET name = excluded.name`,
      )
      .run(id, projectId, docEditId, name, now);
    const row = this.db
      .prepare('SELECT id, doc_edit_id, name, created_at FROM local_history_labels WHERE project_id = ? AND doc_edit_id = ?')
      .get(projectId, docEditId);
    return { id: row.id, docEditId: row.doc_edit_id, name: row.name, createdBy: null, createdAt: row.created_at };
  }

  deleteHistoryLabel(projectId, labelId) {
    const result = this.db
      .prepare('DELETE FROM local_history_labels WHERE project_id = ? AND id = ?')
      .run(projectId, labelId);
    return result.changes > 0;
  }

  listEdits(projectId, { path: relPath = null, afterId = 0, limit = 200 } = {}) {
    const rows = relPath
      ? this.db
          .prepare(
            `SELECT id, path, actor, author_id, edit_mode, suggestion_id, chat_id, created_at FROM local_edits
             WHERE project_id = ? AND path = ? AND id > ? ORDER BY id DESC LIMIT ?`,
          )
          .all(projectId, relPath, afterId, limit)
      : this.db
          .prepare(
            `SELECT id, path, actor, author_id, edit_mode, suggestion_id, chat_id, created_at FROM local_edits
             WHERE project_id = ? AND id > ? ORDER BY id DESC LIMIT ?`,
          )
          .all(projectId, afterId, limit);
    return rows;
  }


  // ---- Doc comments -------------------------------------------------------
  // Rows serialize to the cloud wire shape (DocCommentThread) so the sidecar
  // can hand them straight to the existing comments UI.

  #toCommentThread(row) {
    const messages = this.db
      .prepare('SELECT * FROM local_comment_messages WHERE thread_id = ? ORDER BY rowid ASC')
      .all(row.id)
      .map((message) => ({
        id: message.id,
        body: message.body,
        createdAt: message.created_at,
        updatedAt: message.updated_at,
        author: JSON.parse(message.author),
      }));
    // Read-only id lookup (fall back to the path, like the cloud shape) —
    // listing comments must not mint identity rows for deleted paths.
    const fileId = this.db
      .prepare('SELECT id FROM file_ids WHERE project_id = ? AND path = ?')
      .get(row.project_id, row.path)?.id;
    return {
      id: row.id,
      projectId: row.project_id,
      fileId: fileId ?? row.path,
      filePath: row.path,
      quote: row.quote,
      anchor: JSON.parse(row.anchor),
      head: JSON.parse(row.head),
      status: row.status,
      chatId: row.chat_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      resolvedByUserId: row.resolved_by,
      author: JSON.parse(row.author),
      messages,
    };
  }

  /** Threads for one file, or the whole project when `path` is null — open
   *  first, newest activity first (mirrors the cloud sort so `threads[0]` is
   *  the just-created thread after a POST). */
  listCommentThreads(projectId, { path = null } = {}) {
    const rows = path
      ? this.db
          .prepare(
            `SELECT * FROM local_comment_threads WHERE project_id = ? AND path = ?
             ORDER BY status = 'open' DESC, updated_at DESC, rowid DESC`,
          )
          .all(projectId, path)
      : this.db
          .prepare(
            `SELECT * FROM local_comment_threads WHERE project_id = ?
             ORDER BY status = 'open' DESC, updated_at DESC, rowid DESC`,
          )
          .all(projectId);
    return rows.map((row) => this.#toCommentThread(row));
  }

  getCommentThread(threadId) {
    const row = this.db.prepare('SELECT * FROM local_comment_threads WHERE id = ?').get(threadId);
    return row ? this.#toCommentThread(row) : null;
  }

  /** @returns {{ threadId: string, messageId: string }} — the message id keys
   *  the comment→agent delivery's dedupe (clientId `comment:<messageId>`). */
  createCommentThread(projectId, { path, quote, anchor, head, body, author }) {
    const now = new Date().toISOString();
    const threadId = randomUUID();
    const messageId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO local_comment_threads (id, project_id, path, author, quote, anchor, head, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(threadId, projectId, path, JSON.stringify(author), quote, JSON.stringify(anchor), JSON.stringify(head), now, now);
    this.db
      .prepare('INSERT INTO local_comment_messages (id, thread_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(messageId, threadId, JSON.stringify(author), body, now, now);
    return { threadId, messageId };
  }

  /** @returns the new message's id (the delivery dedupe key). */
  addCommentMessage(threadId, { body, author }) {
    const now = new Date().toISOString();
    const messageId = randomUUID();
    this.db
      .prepare('INSERT INTO local_comment_messages (id, thread_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(messageId, threadId, JSON.stringify(author), body, now, now);
    this.#touchCommentThread(threadId, now);
    return messageId;
  }

  /** Mode A link: the chat this thread owns (set on the first @sunny).
   *  Share-covered threads live in the cloud store — no local row to update —
   *  so their link lands in local_comment_thread_links instead. */
  setCommentThreadChat(threadId, chatId) {
    const updated = this.db
      .prepare('UPDATE local_comment_threads SET chat_id = ? WHERE id = ?')
      .run(chatId, threadId);
    if (updated.changes === 0) {
      this.db
        .prepare(
          'INSERT INTO local_comment_thread_links (thread_id, chat_id) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET chat_id = excluded.chat_id',
        )
        .run(threadId, chatId);
    }
  }

  loadCommentSeen(shareId) {
    return this.db
      .prepare('SELECT message_id FROM bridge_comment_seen WHERE share_id = ?')
      .all(shareId)
      .map((row) => row.message_id);
  }

  addCommentSeen(shareId, messageIds) {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO bridge_comment_seen (share_id, message_id) VALUES (?, ?)',
    );
    for (const id of messageIds) insert.run(shareId, id);
  }

  getCommentThreadChatLink(threadId) {
    return (
      this.db.prepare('SELECT chat_id FROM local_comment_thread_links WHERE thread_id = ?').get(threadId)
        ?.chat_id ?? null
    );
  }

  /** Mode B: live chats subscribed to comments via listen_comments.
   *  Chat-granted (shared) chats are excluded — a link guest reads every
   *  message in them, so a comment delivery would leak beyond their grant. */
  listCommentWatchChats(projectId) {
    return this.db
      .prepare(
        `SELECT * FROM local_chats WHERE project_id = ? AND comment_watch_path IS NOT NULL AND archived_at IS NULL
           AND id NOT IN (
             SELECT ss.scope_path FROM share_scopes ss
               JOIN shares s ON s.id = ss.share_id
              WHERE s.project_id = ? AND s.enabled = 1 AND ss.scope_kind = 'chat')`,
      )
      .all(projectId, projectId);
  }

  chatHasActiveShare(chatId) {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM share_scopes ss JOIN shares s ON s.id = ss.share_id
            WHERE s.enabled = 1 AND ss.scope_kind = 'chat' AND ss.scope_path = ? LIMIT 1`,
        )
        .get(chatId),
    );
  }

  /** null path stops watching. `fileId` qualifies a concrete path and is
   *  authoritative for matching (see the migration note). */
  setCommentWatch(chatId, path, fileId = null) {
    this.db
      .prepare('UPDATE local_chats SET comment_watch_path = ?, comment_watch_file_id = ? WHERE id = ?')
      .run(path, path && path !== '*' ? fileId : null, chatId);
  }

  editCommentMessage(threadId, messageId, body) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE local_comment_messages SET body = ?, updated_at = ? WHERE id = ? AND thread_id = ?')
      .run(body, now, messageId, threadId);
    if (result.changes === 0) return false;
    this.#touchCommentThread(threadId, now);
    return true;
  }

  /** Delete a message; deleting the thread's first message deletes the whole
   *  thread (same semantics as the cloud route — message 0 is the thread body).
   *  Returns 'thread' | 'message' | null. */
  deleteCommentMessage(threadId, messageId) {
    const messages = this.db
      .prepare('SELECT id FROM local_comment_messages WHERE thread_id = ? ORDER BY rowid ASC')
      .all(threadId);
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) return null;
    if (index === 0) {
      this.db.prepare('DELETE FROM local_comment_messages WHERE thread_id = ?').run(threadId);
      this.db.prepare('DELETE FROM local_comment_threads WHERE id = ?').run(threadId);
      return 'thread';
    }
    this.db.prepare('DELETE FROM local_comment_messages WHERE id = ?').run(messageId);
    this.#touchCommentThread(threadId, new Date().toISOString());
    return 'message';
  }

  setCommentThreadStatus(threadId, status, resolvedBy = null) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE local_comment_threads SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?')
      .run(status, status === 'resolved' ? now : null, status === 'resolved' ? resolvedBy : null, now, threadId);
    return result.changes > 0;
  }

  #touchCommentThread(threadId, now) {
    this.db.prepare('UPDATE local_comment_threads SET updated_at = ? WHERE id = ?').run(now, threadId);
  }

  /** Comments follow file renames (file or folder subtree), like doc state —
   *  and so do path-scoped comment watches, which is why the local schema
   *  needs no file-id twin of the cloud's comment_watch_file_id. */
  renameCommentPaths(projectId, fromPath, toPath) {
    this.db
      .prepare('UPDATE local_comment_threads SET path = ? WHERE project_id = ? AND path = ?')
      .run(toPath, projectId, fromPath);
    this.db
      .prepare(
        "UPDATE local_comment_threads SET path = ? || substr(path, ?) WHERE project_id = ? AND substr(path, 1, length(?) + 1) = ? || '/'",
      )
      .run(toPath, fromPath.length + 1, projectId, fromPath, fromPath);
    this.db
      .prepare('UPDATE local_chats SET comment_watch_path = ? WHERE project_id = ? AND comment_watch_path = ?')
      .run(toPath, projectId, fromPath);
    this.db
      .prepare(
        "UPDATE local_chats SET comment_watch_path = ? || substr(comment_watch_path, ?) WHERE project_id = ? AND substr(comment_watch_path, 1, length(?) + 1) = ? || '/'",
      )
      .run(toPath, fromPath.length + 1, projectId, fromPath, fromPath);
  }

  addShare({ projectId, workspaceId, scopePath = '', scopeKind = 'project', collabUrl = null, apiOrigin = null, token = null, mintKey = null, mintKind = null, refreshCredential = null }) {
    const share = {
      id: randomUUID(),
      project_id: projectId,
      workspace_id: workspaceId,
      scope_path: scopePath,
      scope_kind: scopeKind,
      collab_url: collabUrl,
      api_origin: apiOrigin,
      token,
      mint_key: mintKey,
      mint_kind: mintKind,
      refresh_credential: refreshCredential,
      enabled: 1,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO shares (id, project_id, workspace_id, scope_path, scope_kind, collab_url, api_origin, token, mint_key, mint_kind, refresh_credential, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(share.id, share.project_id, share.workspace_id, share.scope_path, share.scope_kind, share.collab_url, share.api_origin, share.token, share.mint_key, share.mint_kind, share.refresh_credential, share.enabled, share.created_at);
    return share;
  }

  updateShareToken(shareId, token) {
    this.db.prepare('UPDATE shares SET token = ? WHERE id = ?').run(token, shareId);
  }

  updateShareScope(shareId, scopePath) {
    this.db.prepare('UPDATE shares SET scope_path = ? WHERE id = ?').run(scopePath, shareId);
  }

  // ---- Grants-model shares (scope_kind 'union') ---------------------------

  getUnionShare(projectId) {
    return (
      this.db
        .prepare("SELECT * FROM shares WHERE project_id = ? AND scope_kind = 'union'")
        .get(projectId) ?? null
    );
  }

  updateShareConnection(shareId, { collabUrl, apiOrigin, token }) {
    this.db
      .prepare('UPDATE shares SET collab_url = ?, api_origin = ?, token = ?, enabled = 1 WHERE id = ?')
      .run(collabUrl, apiOrigin, token, shareId);
  }

  updateShareMint(shareId, { mintKey = null, mintKind = null, refreshCredential = null }) {
    this.db
      .prepare('UPDATE shares SET mint_key = ?, mint_kind = ?, refresh_credential = ? WHERE id = ?')
      .run(mintKey, mintKind, refreshCredential, shareId);
  }

  listShareScopes(shareId) {
    return this.db
      .prepare('SELECT * FROM share_scopes WHERE share_id = ? ORDER BY id ASC')
      .all(shareId);
  }

  /** Monotonic per-project scope generation — bumped for every FRESH scope
   *  add; never reused, so any stopped generation stays below all later ones
   *  (rename-safe: the counter is project-wide, not per-path). */
  nextScopeGeneration(projectId) {
    const key = `scope_generation:${projectId}`;
    const next = Number(this.getSetting(key) ?? 0) + 1;
    this.setSetting(key, String(next));
    return next;
  }

  /** The counter WITHOUT bumping it — the highest generation handed out so
   *  far. The last-scope stop sends it as the cloud's workspace-wide
   *  revocation epoch, so every mint in flight is below it and every later
   *  add is above it. Removing scopes never resets it (generations are never
   *  reused, or a stop's epoch would cover a later share). */
  currentScopeGeneration(projectId) {
    return Number(this.getSetting(`scope_generation:${projectId}`) ?? 0);
  }

  addShareScope(shareId, { scopeKind, scopePath, generation = null }) {
    const result = this.db
      .prepare(
        `INSERT INTO share_scopes (share_id, scope_kind, scope_path, generation, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (share_id, scope_kind, scope_path) DO NOTHING`,
      )
      .run(shareId, scopeKind, scopePath, generation, new Date().toISOString());
    const scope = this.db
      .prepare('SELECT * FROM share_scopes WHERE share_id = ? AND scope_kind = ? AND scope_path = ?')
      .get(shareId, scopeKind, scopePath);
    // A fresh PROJECT scope starts at the message ledger's head: chats the
    // user never touches again after the share never reach the cloud. A CHAT
    // scope is an explicit choice of one conversation (whole history by
    // design); folder/file scopes carry no chats at all.
    if (result.changes > 0 && scopeKind === 'project') this.seedChatActivation(`scope:${scope.id}`, shareId);
    return { scope, inserted: result.changes > 0 };
  }

  getShareScope(scopeId) {
    return this.db.prepare('SELECT * FROM share_scopes WHERE id = ?').get(scopeId) ?? null;
  }

  removeShareScope(scopeId) {
    this.db.prepare('DELETE FROM share_scopes WHERE id = ?').run(scopeId);
    this.db.prepare('DELETE FROM settings WHERE key LIKE ?').run(`ledger_cursor:scope:${scopeId}:%`);
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(`ledger_activation:scope:${scopeId}`);
  }

  updateShareScopePath(scopeId, scopePath) {
    this.db.prepare('UPDATE share_scopes SET scope_path = ? WHERE id = ?').run(scopePath, scopeId);
  }

  /** Stamp a rename-relocated scope's fresh generation once the cloud grant
   *  move landed it on the row (scopeMoveOp). Path-guarded and raise-only: a
   *  chained rename or a stop+re-add in the window means this move no longer
   *  speaks for the scope. */
  bumpShareScopeGeneration(scopeId, scopePath, generation) {
    this.db
      .prepare(
        'UPDATE share_scopes SET generation = ? WHERE id = ? AND scope_path = ? AND (generation IS NULL OR generation < ?)',
      )
      .run(generation, scopeId, scopePath, generation);
  }

  /** Durable queue of scope-root moves whose CLOUD half (subtree move +
   *  grant move) hasn't landed yet. Recorded BEFORE the local re-key so a
   *  sidecar restart re-queues the ops instead of misreading the re-keyed
   *  bridge rows as cloud deletes (which would reap the renamed files). */
  listPendingScopeMoves(shareId) {
    return JSON.parse(this.getSetting(`pending_scope_moves:${shareId}`) ?? '[]');
  }

  addPendingScopeMove(shareId, move) {
    const moves = this.listPendingScopeMoves(shareId);
    moves.push(move);
    this.setSetting(`pending_scope_moves:${shareId}`, JSON.stringify(moves));
  }

  removePendingScopeMove(shareId, move) {
    const moves = this.listPendingScopeMoves(shareId).filter(
      (entry) => !(entry.from === move.from && entry.to === move.to),
    );
    this.setSetting(`pending_scope_moves:${shareId}`, JSON.stringify(moves));
  }

  /** Every path an UNLANDED rename could still have this scope's grant parked
   *  at — the chain's origin plus each hop's target — and the highest
   *  generation any of them allocated. The cloud row only moves when its
   *  queued move lands, so a chain stalled midway (A→B→C with B→C still
   *  queued) leaves the grant reachable at whichever path it reached: a stop
   *  must revoke ALL of them, through a generation no pending stamp exceeds.
   *  Empty + 0 when nothing is pending. */
  pendingScopeRelocations(shareId, scopeId) {
    const paths = new Set();
    let generation = 0;
    for (const move of this.listPendingScopeMoves(shareId)) {
      for (const entry of move.relocations ?? []) {
        if (entry.scopeId !== scopeId) continue;
        paths.add(entry.path);
        paths.add(`${move.from}${entry.path.slice(move.to.length)}`);
        if (entry.generation > generation) generation = entry.generation;
      }
    }
    return { paths: [...paths], generation };
  }

  /** Move bridge/blob bookkeeping with a renamed subtree so the cloud twins'
   *  first-sync memory follows the files (identity path mapping). */
  renameBridgePaths(shareId, fromRel, toRel) {
    for (const table of ['bridge_files', 'blob_sync']) {
      // substr, not LIKE: `_`/`%` in a real path would act as wildcards and
      // re-key unrelated rows. Length in CODE POINTS — SQLite substr counts
      // characters, JS .length counts UTF-16 units (emoji paths differ).
      const prefix = `${fromRel}/`;
      for (const row of this.db
        .prepare(`SELECT path FROM ${table} WHERE share_id = ? AND (path = ? OR substr(path, 1, ?) = ?)`)
        .all(shareId, fromRel, [...prefix].length, prefix)) {
        const next = row.path === fromRel ? toRel : `${toRel}${row.path.slice(fromRel.length)}`;
        // OR REPLACE: a stale row at the target path loses to the moved one.
        this.db
          .prepare(`UPDATE OR REPLACE ${table} SET path = ? WHERE share_id = ? AND path = ?`)
          .run(next, shareId, row.path);
      }
    }
  }

  listBridgeFiles(shareId) {
    return this.db
      .prepare('SELECT path FROM bridge_files WHERE share_id = ?')
      .all(shareId)
      .map((row) => row.path);
  }

  hasBridgeFile(shareId, relPath) {
    return Boolean(
      this.db.prepare('SELECT 1 FROM bridge_files WHERE share_id = ? AND path = ?').get(shareId, relPath),
    );
  }

  markBridgeFile(shareId, relPath) {
    this.db
      .prepare(
        `INSERT INTO bridge_files (share_id, path, first_synced_at) VALUES (?, ?, ?)
         ON CONFLICT (share_id, path) DO NOTHING`,
      )
      .run(shareId, relPath, new Date().toISOString());
  }

  forgetBridgeFile(shareId, relPath) {
    this.db.prepare('DELETE FROM bridge_files WHERE share_id = ? AND path = ?').run(shareId, relPath);
    this.db.prepare('DELETE FROM blob_sync WHERE share_id = ? AND path = ?').run(shareId, relPath);
  }

  removeBridgeFiles(shareId) {
    this.db.prepare('DELETE FROM bridge_files WHERE share_id = ?').run(shareId);
    this.db.prepare('DELETE FROM blob_sync WHERE share_id = ?').run(shareId);
  }

  getBlobSync(shareId, relPath) {
    return this.db.prepare('SELECT * FROM blob_sync WHERE share_id = ? AND path = ?').get(shareId, relPath) ?? null;
  }

  recordBlobSync(shareId, relPath, { sha, mtimeMs = null, size = null }) {
    this.db
      .prepare(
        `INSERT INTO blob_sync (share_id, path, sha, local_mtime_ms, local_size, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (share_id, path)
         DO UPDATE SET sha = excluded.sha, local_mtime_ms = excluded.local_mtime_ms,
                       local_size = excluded.local_size, synced_at = excluded.synced_at`,
      )
      .run(shareId, relPath, sha, mtimeMs, size, new Date().toISOString());
  }

  listShares(projectId) {
    return this.db
      .prepare('SELECT * FROM shares WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId);
  }

  getShare(shareId) {
    return this.db.prepare('SELECT * FROM shares WHERE id = ?').get(shareId) ?? null;
  }

  /** Newest enabled share for one deployment — the diagnostics sink ships
   *  with its bridge token, the same credential the sync heartbeat uses. */
  latestShareForOrigin(apiOrigin) {
    return this.db
      .prepare(
        `SELECT id, workspace_id, api_origin, token FROM shares
         WHERE enabled = 1 AND api_origin = ? AND token IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(apiOrigin) ?? null;
  }


  removeShare(shareId) {
    this.db.prepare('DELETE FROM shares WHERE id = ?').run(shareId);
  }

  close() {
    this.db.close();
  }
}
