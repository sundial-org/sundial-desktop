// Uploads the sidecar's granular ledger (edit attribution, local agent
// chats/messages, suggestion decisions) to the cloud mirror for a SHARED
// project. The CRDT bridge carries document state but collapses attribution
// to the share token — this carries what the bridge cannot: per-edit
// actor/author (human vs ai:claude-code vs external tools), tool calls, and
// decisions. Cursor-per-(share, kind) on SQLite rowids; the cloud upsert is
// idempotent, so a lost ack just re-sends.

import { contentHash } from './store.mjs';
import { inExtraRoot } from './roots.mjs';
import { scopeCoversPath } from './paths.mjs';

const BATCH_ROWS = 200;
const BATCH_BYTES = 800_000;
// Single-event ceiling: local text files can reach 10 MB, and one event the
// route/body limit rejects would jam the cursor behind it forever. Oversized
// edit bodies upload as metadata-only (attribution intact, content marked
// truncated — the doc content itself still reaches the cloud via the bridge).
const MAX_EVENT_BYTES = 2_000_000;

function parseMetadata(value) {
  if (typeof value !== 'string' || !value) return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value; // malformed rows upload verbatim rather than dropping
  }
}

/** Message bodies (tool results especially) can be huge but have no cloud
 *  twin to fall back on — keep the largest prefix that fits instead of
 *  dropping the content outright. */
function capMessagePayload(payload) {
  const size = (p) => Buffer.byteLength(JSON.stringify(p), 'utf8');
  if (size(payload) <= MAX_EVENT_BYTES) return payload;
  const originalBytes = typeof payload.content === 'string' ? Buffer.byteLength(payload.content, 'utf8') : 0;
  let content = typeof payload.content === 'string' ? payload.content : '';
  let capped = payload;
  do {
    content = content.slice(0, Math.floor(content.length / 2));
    capped = { ...payload, content, content_truncated: true, content_bytes: originalBytes };
  } while (content.length > 0 && size(capped) > MAX_EVENT_BYTES);
  // Content alone wasn't the problem (a giant metadata blob) — drop it too.
  if (size(capped) > MAX_EVENT_BYTES) capped = { ...capped, metadata: null, metadata_truncated: true };
  return capped;
}

function capEditPayload(payload) {
  // Cap the SERIALIZED event (bytes, not string length — non-ASCII text and
  // the base64 Yjs delta both inflate past code-unit counts). Degrade
  // progressively: the delta is redundant with content_text, drop it first;
  // only then fall back to metadata-only.
  const size = (p) => Buffer.byteLength(JSON.stringify(p), 'utf8');
  if (size(payload) <= MAX_EVENT_BYTES) return payload;
  const withoutDelta = { ...payload, update_b64: null };
  if (size(withoutDelta) <= MAX_EVENT_BYTES) return withoutDelta;
  return {
    ...withoutDelta,
    content_text: null,
    content_truncated: true,
    content_bytes: typeof payload.content_text === 'string' ? Buffer.byteLength(payload.content_text, 'utf8') : 0,
  };
}

// Append-only tables, paged by rowid cursor. Chats are handled separately —
// they MUTATE (title, harness, last_message_at, archive), so a one-shot
// cursor would freeze their first snapshot forever.
const KINDS = [
  {
    table: 'local_edits',
    kind: 'edit',
    payload: (row) => capEditPayload({
      path: row.path,
      actor: row.actor,
      author_id: row.author_id,
      edit_mode: row.edit_mode,
      chat_id: row.chat_id,
      // Turn linkage (PR #986): the sidecar assistant message this agent edit
      // belongs to. The cloud turn-edits route joins it back through the
      // mirrored message's client_id to serve the chat diff chip.
      message_id: row.message_id ?? null,
      // Joins a later decision event back to the exact staged edit it resolved.
      suggestion_id: row.suggestion_id ?? null,
      content_text: row.content_text,
      // Bridged CLOUD edits (actor 'remote') upload as content-only baselines:
      // the cloud turn diff reads its before-text from the ledger trail, so a
      // local turn that follows a cloud edit needs that row in place — but its
      // delta originated in the cloud and would be pure round-trip redundancy.
      update_b64: row.actor === 'remote' ? null : row.update_b64,
    }),
    pathOf: (row) => row.path,
  },
  {
    table: 'local_messages',
    kind: 'message',
    payload: (row) => capMessagePayload({
      chat_id: row.chat_id,
      role: row.role,
      content: row.content,
      // SQLite stores metadata as TEXT — parse so the JSONB ledger is
      // queryable (payload.metadata.tool_name etc.), not an escaped string.
      metadata: parseMetadata(row.metadata),
      client_id: row.client_id,
      sequence: row.sequence,
    }),
  },
  {
    table: 'local_decisions',
    kind: 'decision',
    payload: (row) => ({
      path: row.path,
      suggestion_id: row.suggestion_id,
      suggestion_kind: row.suggestion_kind,
      decision: row.decision,
      actor: row.actor,
      author_id: row.author_id,
    }),
    pathOf: (row) => row.path,
  },
];

/** Chats as hash-versioned snapshots: each metadata change mints a new
 *  (chatId, hash) event — append-only in the cloud — and the per-share state
 *  map keeps unchanged chats from re-POSTing every poll. `chatIds` limits the
 *  pass to specific conversations (chat scopes); null = every project chat. */
async function syncChatSnapshots(engine, namespace, chatIds) {
  const { share, store, project } = engine;
  // Keyed by (project, workspace) — NOT the transient share id: an unshare/
  // re-share to the same workspace must keep the version counter monotonic,
  // or a chat changed while unshared re-mints v1 and the cloud upsert drops
  // it as a duplicate, leaving the mirror stale.
  const stateKey = `ledger_chat_state:${project.id}:${share.workspace_id}`;
  const uploadedState = JSON.parse(store.getSetting(stateKey) ?? '{}');
  const changed = [];
  for (const row of store.listChats(project.id)) {
    if (chatIds && !chatIds.has(row.id)) continue;
    const payload = {
      title: row.title,
      model: row.model,
      harness: row.harness,
      last_message_at: row.last_message_at,
      archived_at: row.archived_at,
    };
    const hash = contentHash(JSON.stringify(payload)).slice(0, 12);
    const prev = uploadedState[row.id];
    if (prev?.hash === hash) continue;
    // Monotonic per-chat version, NOT the hash, keys the snapshot: a state
    // the chat RETURNS to (title A → B → A) must mint a fresh event, or the
    // duplicate-ignoring upsert leaves the mirror stuck at B.
    const version = (prev?.v ?? 0) + 1;
    changed.push({
      chatId: row.id,
      state: { hash, v: version },
      event: {
        kind: 'chat',
        localId: `${namespace}:${row.id}:v${version}`,
        createdAt: row.created_at ?? null,
        payload: { chat_id: row.id, ...payload },
      },
    });
  }
  if (changed.length === 0) return;
  // RESERVE the versions durably before any upload: if the POST lands but the
  // ack (or the process) is lost before the state save, a later change would
  // recompute the SAME v from stale state and its new payload would be
  // dropped as a duplicate localId. A reserved entry (hash null) never
  // matches, so the next pass always mints a fresh version.
  for (const c of changed) uploadedState[c.chatId] = { hash: null, v: c.state.v };
  store.setSetting(stateKey, JSON.stringify(uploadedState));
  // Chunked (route caps a batch at 500) with the hash state saved per acked
  // chunk — one oversized or half-failed upload must not re-send everything
  // forever, nor block the edit/message/decision cursors behind it.
  for (let start = 0; start < changed.length; start += BATCH_ROWS) {
    const chunk = changed.slice(start, start + BATCH_ROWS);
    await ledgerPost(engine, chunk.map((c) => c.event));
    for (const c of chunk) uploadedState[c.chatId] = c.state;
    store.setSetting(stateKey, JSON.stringify(uploadedState));
  }
}

/** One-time (per unit) deploy-transition backfill of retained rows below the
 *  current edit cursor, for the two contract upgrades the cursor already
 *  advanced past: bridged CLOUD rows (actor 'remote') were skipped entirely —
 *  a turn following an old cloud edit would diff against a stale baseline —
 *  and agent rows uploaded without their message_id turn linkage. The cloud
 *  upsert MERGES on (workspace, kind, local_id), so re-sent rows are enriched
 *  in place and never duplicated. The flag is set only after the pass
 *  survives, so a lost ack retries (idempotently) next sync. */
async function backfillLedgerContract(engine, namespace, unit, spec) {
  const { store, project } = engine;
  const flagKey = `ledger_backfill_v1:${unit.cursorKey}`;
  if (store.getSetting(flagKey)) return;
  const editCursor = store.ledgerCursor(unit.cursorKey, 'edit');
  let cursor = 0;
  while (cursor < editCursor) {
    const rows = store.listLedgerRowsSince(spec.table, project.id, cursor, BATCH_ROWS);
    if (rows.length === 0) break;
    const events = [];
    let bytes = 0;
    for (const row of rows) {
      cursor = row.rid;
      if (row.rid > editCursor) break;
      if (row.actor !== 'remote' && !(row.actor === 'agent' && row.message_id)) continue;
      const rel = spec.pathOf(row);
      if (inExtraRoot(store, project.id, rel) || !unit.contains(rel)) continue;
      const payload = spec.payload(row);
      payload.path = unit.toCloud(rel);
      bytes += Buffer.byteLength(JSON.stringify(payload), 'utf8');
      events.push({ kind: spec.kind, localId: `${namespace}:${row.id}`, createdAt: row.created_at ?? null, payload });
      if (bytes >= BATCH_BYTES) break;
    }
    if (events.length > 0) await ledgerPost(engine, events);
    if (rows.length < BATCH_ROWS && cursor >= rows[rows.length - 1].rid) break;
  }
  store.setSetting(flagKey, '1');
}

/** Plain authenticated POST — deliberately NOT engine.cloudFetch: that parks
 *  the whole share (status 'error' + authError) on a 401/403, and a rejected
 *  side-channel upload (e.g. a token that can't write) must never take down
 *  document sync that is otherwise working. */
async function ledgerPost(engine, events) {
  const doFetch = engine.ledgerFetch ?? fetch;
  const res = await doFetch(`${engine.share.api_origin}/api/workspace/local-ledger`, {
    method: 'POST',
    signal: engine.stopAbort?.signal,
    headers: {
      Authorization: `Bearer ${engine.share.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workspaceId: engine.share.workspace_id, events }),
  });
  if (!res.ok) throw new Error(`ledger upload failed status=${res.status}`);
}

/** The independent upload lanes of one share engine. Legacy shares are one
 *  unit keyed by the share id. A union (grants-model) share runs one unit PER
 *  SCOPE, each with its own cursors (`scope:<id>`), so a scope added later
 *  uploads its subtree's/chat's retained history from row zero — the cloud
 *  upsert dedupes rows an overlapping scope already sent. */
function ledgerUnits(engine) {
  const { share } = engine;
  const unitFor = (cursorKey, scopeKind, scopePath, contains, toCloud) =>
    scopeKind === 'chat'
      ? { cursorKey, kinds: ['message'], chatId: scopePath, chatIds: new Set([scopePath]) }
      : {
          cursorKey,
          // Chats/messages ride whole-project scopes only — a subfolder share
          // must not leak project-wide conversations.
          kinds: scopeKind === 'project' ? ['edit', 'message', 'decision'] : ['edit', 'decision'],
          chatId: null,
          chatIds: scopeKind === 'project' ? null : undefined,
          contains,
          toCloud,
        };
  if (!engine.isUnion) {
    return [
      unitFor(
        share.id,
        share.scope_kind,
        share.scope_path,
        (rel) => engine.scopeContains(rel),
        (rel) => engine.localToCloud(rel),
      ),
    ];
  }
  return engine.scopes.map((scope) =>
    unitFor(
      `scope:${scope.id}`,
      scope.scope_kind,
      scope.scope_path,
      (rel) => scopeCoversPath(scope, rel),
      (rel) => rel,
    ),
  );
}

/** One upload pass for one share engine. Path-scoped kinds respect each
 *  unit's scope; chats/messages upload only for whole-project units. A CHAT
 *  unit inverts that: only its one chat's snapshot + messages upload — no
 *  edits, no decisions, no files. Rows outside scope still advance the
 *  cursor — they are deliberately not shared, not pending. */
export async function syncShareLedger(engine) {
  const { store, project } = engine;
  const namespace = store.installId();
  for (const unit of ledgerUnits(engine)) {
    // chatIds: null = all project chats (project scope), a set = that chat
    // (chat scope), undefined = no chat snapshots (folder/file scope).
    if (unit.chatIds !== undefined) await syncChatSnapshots(engine, namespace, unit.chatIds);
    if (unit.kinds.includes('edit')) await backfillLedgerContract(engine, namespace, unit, KINDS[0]);
    for (const spec of KINDS) {
      if (!unit.kinds.includes(spec.kind)) continue;
      for (;;) {
        const cursor = store.ledgerCursor(unit.cursorKey, spec.kind);
        const rows = store.listLedgerRowsSince(spec.table, project.id, cursor, BATCH_ROWS);
        if (rows.length === 0) break;
        const events = [];
        let bytes = 0;
        let lastRid = cursor;
        for (const row of rows) {
          lastRid = row.rid;
          // Chat unit: other conversations advance the cursor, never upload.
          if (unit.chatId && row.chat_id !== unit.chatId) continue;
          // Extra-root (multi-root mount) rows are local-only context — a
          // project-scope share's contains() is true for EVERY path, so
          // without this their content would leak to the cloud ledger.
          if (spec.pathOf && inExtraRoot(store, project.id, spec.pathOf(row))) continue;
          if (spec.pathOf && !unit.contains(spec.pathOf(row))) continue;
          const payload = spec.payload(row);
          // Legacy scoped shares store files in the cloud under TRANSLATED
          // paths (docs/a.md → a.md) — ledger rows must use the same mapping
          // or they can't join back to the cloud files/doc_edits rows.
          // (Union scopes map identically.)
          if (spec.pathOf) payload.path = unit.toCloud(spec.pathOf(row));
          bytes += Buffer.byteLength(JSON.stringify(payload), 'utf8');
          events.push({
            kind: spec.kind,
            // Cloud idempotency key is (workspace, kind, local_id) and several
            // sidecars can feed one workspace — their SQLite ids all start at 1,
            // so a bare row id would make machine B's rows read as machine A's
            // duplicates and get silently dropped. The INSTALL id namespaces
            // them (share ids are transient: a re-share regenerates one and
            // would re-upload retained rows as duplicates).
            localId: `${namespace}:${row.id}`,
            createdAt: row.created_at ?? null,
            payload,
          });
          if (bytes >= BATCH_BYTES) break;
        }
        if (events.length > 0) {
          await ledgerPost(engine, events);
        }
        store.setLedgerCursor(unit.cursorKey, spec.kind, lastRid);
        if (lastRid === rows[rows.length - 1].rid && rows.length < BATCH_ROWS) break;
      }
    }
  }
}
