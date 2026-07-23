import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
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
  if (harness === 'claude' && model && !model.startsWith('anthropic/')) return 'anthropic/claude-sonnet-4.6';
  if (harness === 'openai' && model && !model.startsWith('openai/')) return 'openai/gpt-5.5';
  return model;
}

/** SQLite-backed store for everything the sidecar persists besides the user's
 *  own files: the project registry, per-file Y.Doc state (so suggestion marks
 *  and CRDT identity survive restarts), the local edit ledger (attribution /
 *  history), and share configs (which paths sync to which cloud workspace). */
export class LocalStore {
  constructor(home = defaultHome()) {
    mkdirSync(home, { recursive: true });
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
    ]) {
      try {
        this.db.exec(migration);
      } catch {
        /* column already present */
      }
    }
    this.adoptDefaultHarness();
  }

  /** Chats created before engine stamping carry harness NULL and would run
   *  as Sunny forever, ignoring the engine the user picked at onboarding.
   *  Point the empty ones at the install default; chats with messages keep
   *  their engine (a Sunny conversation must not switch mid-thread). Runs at
   *  boot and again when the default is first chosen, so an upgraded install
   *  doesn't need a restart for its legacy chats to follow the pick. */
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

  createChat(projectId, { title = null, model = null, harness = null, externalAgent = null, externalSessionId = null, externalCwd = null } = {}) {
    const chat = {
      id: randomUUID(),
      project_id: projectId,
      title,
      model,
      harness,
      external_agent: externalAgent,
      external_session_id: externalSessionId,
      external_cwd: externalCwd,
      created_at: new Date().toISOString(),
      last_message_at: null,
      archived_at: null,
      pinned: 0,
      message_count: 0,
    };
    this.db
      .prepare(
        'INSERT INTO local_chats (id, project_id, title, model, harness, external_agent, external_session_id, external_cwd, created_at, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
      )
      .run(chat.id, projectId, title, model, harness, externalAgent, externalSessionId, externalCwd, chat.created_at);
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

  /** `${agent}:${sessionId}` for every adopted external session — original id
   *  AND live resume target, so neither the imported transcript nor a resumed
   *  fork's continuation file ever lists as a second chat. */
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
    const allowed = ['title', 'model', 'harness', 'archived_at', 'pinned', 'external_resume_id'];
    for (const key of allowed) {
      if (key in patch) {
        this.db.prepare(`UPDATE local_chats SET ${key} = ? WHERE id = ?`).run(patch[key], chatId);
      }
    }
    return this.getChat(chatId);
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

  listChatMessages(projectId, chatId, { limit = 1000, afterSequence = 0 } = {}) {
    // Latest rows win when capped (DESC + reverse): a giant chat must never
    // serve its OLDEST 1000 rows while dropping the user's newest messages.
    return this.db
      .prepare(
        'SELECT * FROM local_messages WHERE project_id = ? AND chat_id = ? AND sequence > ? ORDER BY sequence DESC LIMIT ?',
      )
      .all(projectId, chatId, afterSequence, limit)
      .reverse()
      .map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
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

  recordEdit({ projectId, path: relPath, actor, authorId = null, editMode = 'edit', contentText = null, updateB64 = null, chatId = null, suggestionId = null }) {
    const result = this.db
      .prepare(
        `INSERT INTO local_edits (project_id, path, actor, author_id, edit_mode, content_text, update_b64, chat_id, suggestion_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, relPath, actor, authorId, editMode, contentText, updateB64, chatId, suggestionId, new Date().toISOString());
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

  /** Highest local_edits id safe to trim for this project: everything is
   *  trimmable when no enabled share exists; otherwise only rows every enabled
   *  share has already uploaded. */
  ledgerTrimFloor(projectId) {
    const shares = this.db
      .prepare('SELECT id FROM shares WHERE project_id = ? AND enabled = 1')
      .all(projectId);
    if (shares.length === 0) return Number.MAX_SAFE_INTEGER;
    return Math.min(...shares.map((share) => this.ledgerCursor(share.id, 'edit')));
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

  recordDeleteTombstone(projectId, relPath, actor = 'external', chatId = null, authorId = null) {
    const last = this.db
      .prepare('SELECT content_text, update_b64 FROM local_edits WHERE project_id = ? AND path = ? ORDER BY id DESC LIMIT 1')
      .get(projectId, relPath);
    if (!last || (last.content_text === null && last.update_b64 === null)) return;
    this.recordEdit({ projectId, path: relPath, actor, authorId, chatId, contentText: null });
  }

  /** Stable file identity: minted per (project, path) on first sight, retired
   *  on delete so a recreated path gets a NEW id (the editor uses that to know
   *  a cached Y.Doc must not be reused), and moved on rename. */
  ensureFileId(projectId, relPath) {
    const row = this.db.prepare('SELECT id FROM file_ids WHERE project_id = ? AND path = ?').get(projectId, relPath);
    if (row) return row.id;
    const id = randomUUID();
    this.db.prepare('INSERT INTO file_ids (project_id, path, id) VALUES (?, ?, ?)').run(projectId, relPath, id);
    return id;
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
        `SELECT id, path, actor, author_id, edit_mode, suggestion_id, chat_id, created_at FROM local_edits
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
        `SELECT id, path, actor, author_id, edit_mode, suggestion_id, chat_id, created_at FROM local_edits
         WHERE project_id = ? AND path = ? AND id <= ? ORDER BY id DESC LIMIT ?`,
      )
      .all(projectId, relPath, lastRowId, limit)
      .reverse();
  }

  getEditContent(rowId) {
    return this.db.prepare('SELECT id, content_text FROM local_edits WHERE id = ?').get(rowId) ?? null;
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

  createCommentThread(projectId, { path, quote, anchor, head, body, author }) {
    const now = new Date().toISOString();
    const threadId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO local_comment_threads (id, project_id, path, author, quote, anchor, head, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(threadId, projectId, path, JSON.stringify(author), quote, JSON.stringify(anchor), JSON.stringify(head), now, now);
    this.db
      .prepare('INSERT INTO local_comment_messages (id, thread_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), threadId, JSON.stringify(author), body, now, now);
    return threadId;
  }

  addCommentMessage(threadId, { body, author }) {
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO local_comment_messages (id, thread_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), threadId, JSON.stringify(author), body, now, now);
    this.#touchCommentThread(threadId, now);
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

  /** Comments follow file renames (file or folder subtree), like doc state. */
  renameCommentPaths(projectId, fromPath, toPath) {
    this.db
      .prepare('UPDATE local_comment_threads SET path = ? WHERE project_id = ? AND path = ?')
      .run(toPath, projectId, fromPath);
    this.db
      .prepare(
        "UPDATE local_comment_threads SET path = ? || substr(path, ?) WHERE project_id = ? AND substr(path, 1, length(?) + 1) = ? || '/'",
      )
      .run(toPath, fromPath.length + 1, projectId, fromPath, fromPath);
  }

  addShare({ projectId, workspaceId, scopePath = '', scopeKind = 'project', collabUrl = null, apiOrigin = null, token = null }) {
    const share = {
      id: randomUUID(),
      project_id: projectId,
      workspace_id: workspaceId,
      scope_path: scopePath,
      scope_kind: scopeKind,
      collab_url: collabUrl,
      api_origin: apiOrigin,
      token,
      enabled: 1,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO shares (id, project_id, workspace_id, scope_path, scope_kind, collab_url, api_origin, token, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(share.id, share.project_id, share.workspace_id, share.scope_path, share.scope_kind, share.collab_url, share.api_origin, share.token, share.enabled, share.created_at);
    return share;
  }

  updateShareToken(shareId, token) {
    this.db.prepare('UPDATE shares SET token = ? WHERE id = ?').run(token, shareId);
  }

  updateShareScope(shareId, scopePath) {
    this.db.prepare('UPDATE shares SET scope_path = ? WHERE id = ?').run(scopePath, shareId);
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


  removeShare(shareId) {
    this.db.prepare('DELETE FROM shares WHERE id = ?').run(shareId);
  }

  close() {
    this.db.close();
  }
}
