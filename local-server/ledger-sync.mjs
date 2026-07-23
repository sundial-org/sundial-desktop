// Uploads the sidecar's granular ledger (edit attribution, local agent
// chats/messages, suggestion decisions) to the cloud mirror for a SHARED
// project. The CRDT bridge carries document state but collapses attribution
// to the share token — this carries what the bridge cannot: per-edit
// actor/author (human vs ai:claude-code vs external tools), tool calls, and
// decisions. Cursor-per-(share, kind) on SQLite rowids; the cloud upsert is
// idempotent, so a lost ack just re-sends.

import { contentHash } from './store.mjs';
import { inExtraRoot } from './roots.mjs';

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
    // Bridged CLOUD edits echo into local_edits as actor 'remote' — they
    // already exist in cloud doc_edits; uploading them back would duplicate
    // the trail. (Cursor still advances past them: deliberately unshared.)
    skip: (row) => row.actor === 'remote',
    payload: (row) => capEditPayload({
      path: row.path,
      actor: row.actor,
      author_id: row.author_id,
      edit_mode: row.edit_mode,
      chat_id: row.chat_id,
      // Joins a later decision event back to the exact staged edit it resolved.
      suggestion_id: row.suggestion_id ?? null,
      content_text: row.content_text,
      update_b64: row.update_b64,
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
 *  map keeps unchanged chats from re-POSTing every poll. */
async function syncChatSnapshots(engine, namespace) {
  const { share, store, project } = engine;
  // Keyed by (project, workspace) — NOT the transient share id: an unshare/
  // re-share to the same workspace must keep the version counter monotonic,
  // or a chat changed while unshared re-mints v1 and the cloud upsert drops
  // it as a duplicate, leaving the mirror stale.
  const stateKey = `ledger_chat_state:${project.id}:${share.workspace_id}`;
  const uploadedState = JSON.parse(store.getSetting(stateKey) ?? '{}');
  const changed = [];
  for (const row of store.listChats(project.id)) {
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

/** One upload pass for one share engine. Path-scoped kinds respect the share
 *  scope; chats/messages upload only for whole-project shares (a subfolder
 *  share must not leak project-wide conversations). Rows outside scope still
 *  advance the cursor — they are deliberately not shared, not pending. */
export async function syncShareLedger(engine) {
  const { share, store, project } = engine;
  const namespace = store.installId();
  if (share.scope_kind === 'project') await syncChatSnapshots(engine, namespace);
  for (const spec of KINDS) {
    if (!spec.pathOf && share.scope_kind !== 'project') continue;
    for (;;) {
      const cursor = store.ledgerCursor(share.id, spec.kind);
      const rows = store.listLedgerRowsSince(spec.table, project.id, cursor, BATCH_ROWS);
      if (rows.length === 0) break;
      const events = [];
      let bytes = 0;
      let lastRid = cursor;
      for (const row of rows) {
        lastRid = row.rid;
        if (spec.skip?.(row)) continue;
        // Extra-root (multi-root mount) rows are local-only context — a
        // project-scope share's scopeContains() is true for EVERY path, so
        // without this their content would leak to the cloud ledger.
        if (spec.pathOf && inExtraRoot(store, project.id, spec.pathOf(row))) continue;
        if (spec.pathOf && !engine.scopeContains(spec.pathOf(row))) continue;
        const payload = spec.payload(row);
        // Scoped shares store files in the cloud under TRANSLATED paths
        // (docs/a.md → a.md) — ledger rows must use the same mapping or they
        // can't join back to the cloud files/doc_edits rows.
        if (spec.pathOf) payload.path = engine.localToCloud(spec.pathOf(row));
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
      store.setLedgerCursor(share.id, spec.kind, lastRid);
      if (lastRid === rows[rows.length - 1].rid && rows.length < BATCH_ROWS) break;
    }
  }
}
