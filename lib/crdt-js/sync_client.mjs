// Agent-side sync daemon: a one-way mirror of the doc store onto the sandbox
// disk. Listens to Supabase Realtime doc_edits inserts for this workspace and
// materializes content_text to /workspace, plus a collab digest so the inotify
// watcher in file_server.py doesn't echo the write back. Deliberately holds NO
// local Y.Doc and no Hocuspocus connection: sandbox-originated writes flow
// through crdt_sync.py's bulk-write path so exactly one Y.Doc per file (the
// server's) ever exists — a second independently-built doc is the recipe for
// the welcome.md / 864-copies doubling bug.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { WebSocket } from 'ws';

import { RealtimeDocEditsApplier, safeBackstopCursor } from './realtime_doc_edits_applier.mjs';
import { canonicalizeMarkdown } from './markdown_yjs.mjs';

const port = Number(process.env.SYNC_CLIENT_PORT || 8091);
const workspaceDir = process.env.WORKSPACE_DIR || '/workspace';
const workspaceSystemDir =
  process.env.WORKSPACE_SYSTEM_DIR || path.join(workspaceDir, '.sundial');
const workspaceId = (process.env.WORKSPACE_ID || '').trim();
const supabaseUrl = (process.env.SUPABASE_URL_V2 || process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const supabaseKey = (
  process.env.SUPABASE_SERVICE_ROLE_KEY_V2 ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
).trim();
// Per-path coalesce window for incoming Realtime doc_edits events. A burst of
// rapid writes to the same path becomes one disk write — bounded by file
// count, not event count.
const realtimeCoalesceMs = Number(process.env.COLLAB_REALTIME_DEBOUNCE_MS || 50);
// Max rows fetched per catch-up cycle (after reconnect / on subscribe). Bounds
// the recovery query for workspaces that rack up a lot of writes during an
// outage.
const realtimeCatchUpLimit = Number(process.env.COLLAB_REALTIME_CATCHUP_LIMIT || 500);
// Fallback catch-up poll cadence. Realtime is at-most-once and a channel can
// fail to provision at all (CHANNEL_ERROR under load) — the cursor makes
// catch-up idempotent, so a slow poll guarantees the mirror converges no
// matter what the channel does.
const realtimePollMs = Number(process.env.COLLAB_REALTIME_POLL_MS || 15_000);
const resubscribeBaseMs = Number(process.env.COLLAB_REALTIME_RESUBSCRIBE_MS || 1_000);
// How long the catch-up cursor lags freshly-visible rows so a concurrently-
// committing lower id can't be skipped (see safeBackstopCursor / PR #698).
const realtimeCursorLagMs = Number(process.env.COLLAB_REALTIME_CURSOR_LAG_MS || 10_000);
const collabDeleteDigest = 'deleted';

// Fail fast: the Realtime mirror is this daemon's entire job now, so missing
// creds must crash the sidecar loudly at boot, not run a silently-stale
// sandbox for its whole lifetime.
if (!workspaceId) throw new Error('WORKSPACE_ID is required');
if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required');

const log = (m) => console.log(`[collab-client] ${m}`);
const logError = (m, e) => console.error(`[collab-client] ${m} error=${e?.message || e}`);

function normalizeDocumentPath(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw) return null;
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return null;
  return normalized;
}

const absPath = (relPath) => path.join(workspaceDir, relPath);
const digestPath = (relPath) => path.join(workspaceSystemDir, 'collab-digests', `${relPath}.sha1`);

const lastVolumeText = new Map();

// Markdown extensions come from the single source of truth — lib/sync/policy.json,
// bundled into the sandbox image. No second hard-coded list (per repo rule): if
// it's unreadable we disable the normalization-skip (write as before) rather than
// risk diverging from the rest of sync behaviour.
const markdownExtensions = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../sync/policy.json', import.meta.url), 'utf8'));
    const exts = parsed?.markdown_extensions;
    if (Array.isArray(exts) && exts.length) return exts.map((e) => String(e).toLowerCase());
    throw new Error('policy.json has no markdown_extensions');
  } catch (error) {
    logError('read markdown_extensions from policy.json (normalization-skip disabled)', error);
    return [];
  }
})();
const isMarkdownPath = (relPath) => {
  const lower = relPath.toLowerCase();
  return markdownExtensions.some((ext) => lower.endsWith(ext));
};

async function readVolumeText(relPath) {
  try {
    return await readFile(absPath(relPath), 'utf8');
  } catch {
    return null;
  }
}

// --- Disk sync -------------------------------------------------------------

async function tryVolumeWrite(relPath, text) {
  const abs = absPath(relPath);
  try {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text, 'utf8');
    return true;
  } catch (error) {
    logError(`volume write failed doc=${relPath}`, error);
    return false;
  }
}

async function writeCollabDigest(relPath, text) {
  const digestFile = digestPath(relPath);
  try {
    await mkdir(path.dirname(digestFile), { recursive: true });
    const digest = createHash('sha1').update(text, 'utf8').digest('hex');
    await writeFile(digestFile, digest, 'utf8');
  } catch (error) {
    logError(`digest write failed doc=${relPath}`, error);
  }
}

async function writeCollabDeleteDigest(relPath) {
  const digestFile = digestPath(relPath);
  try {
    await mkdir(path.dirname(digestFile), { recursive: true });
    await writeFile(digestFile, collabDeleteDigest, 'utf8');
  } catch (error) {
    logError(`delete digest write failed doc=${relPath}`, error);
  }
}

async function deleteVolumeFile(relPath) {
  try {
    await rm(absPath(relPath), { force: true });
    return true;
  } catch (error) {
    logError(`volume delete failed doc=${relPath}`, error);
    return false;
  }
}

// --- HTTP shim -------------------------------------------------------------
// /health only — for in-sandbox debugging. The listening socket also keeps the
// Node event loop alive independent of the Realtime channel's state.

const httpServer = http.createServer((req, res) => {
  const ok = req.method === 'GET' && req.url === '/health';
  res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ok ? { ok: true, docs: lastVolumeText.size } : { ok: false, error: 'not found' }));
});

// --- Realtime doc_edits listener -------------------------------------------
//
// One Supabase Realtime channel per sandbox, filtered to this workspace's
// doc_edits inserts. On each event we materialize the row's content_text to
// disk so bash / long-running tasks see the latest persisted state without
// hydrate. Coordinates with:
//
//   - the existing inotify watcher in file_server.py (collab-digest dedup
//     keeps write-loops from forming)
//   - workspace_hydrate at boot (full reconcile; this listener takes over
//     after boot)
//
// Realtime drops are recoverable: on every (re)subscribe we catch up by
// fetching doc_edits with id > lastSeenRealtimeDocEditId.

const realtimeClient = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  // In Node, supabase-js's realtime client needs an explicit WebSocket
  // implementation — there's no `globalThis.WebSocket` like in browsers.
  // Without this the subscribe ACK never arrives and the channel times out.
  realtime: { params: { eventsPerSecond: 50 }, transport: WebSocket },
});

async function fetchFileContentText(relPath) {
  try {
    const params = new URLSearchParams({
      select: 'content_text',
      project_id: `eq.${workspaceId}`,
      path: `eq.${relPath}`,
      limit: '1',
    });
    const res = await fetch(`${supabaseUrl}/rest/v1/files?${params}`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    if (!res.ok) return undefined;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const text = rows[0]?.content_text;
    return typeof text === 'string' ? text : null;
  } catch (error) {
    logError(`fetchFileContentText doc=${relPath}`, error);
    return undefined;
  }
}

const realtimeApplier = new RealtimeDocEditsApplier({
  lastVolumeText,
  writeFile: tryVolumeWrite,
  writeDigest: writeCollabDigest,
  deleteFile: deleteVolumeFile,
  writeDeleteDigest: writeCollabDeleteDigest,
  fetchFallbackContent: fetchFileContentText,
  normalizePath: normalizeDocumentPath,
  readExisting: readVolumeText,
  canonicalizeMarkdown,
  isMarkdownPath,
  coalesceMs: realtimeCoalesceMs,
  log,
  logError,
});

// Rows are APPLIED as soon as they're scanned, but the applier's cursor (a
// floor) only advances through the contiguous prefix of rows old enough that
// any concurrent lower-id insert has committed — a Realtime push never moves
// it, so a dropped or late-committing row stays inside the next scan's range.
// Per-path last-applied ids inside the applier make the re-scans idempotent.
let catchUpInFlight = false;
async function catchUpDocEdits() {
  if (catchUpInFlight) return;
  catchUpInFlight = true;
  try {
    const cutoffMs = Date.now() - realtimeCursorLagMs;
    let scanFrom = realtimeApplier.getCursor();
    let safeCursor = scanFrom;
    let safeFrozen = false;
    for (;;) {
      const params = new URLSearchParams({
        select: 'id,path,content_text,update_bytes,created_at',
        workspace_id: `eq.${workspaceId}`,
        order: 'id.asc',
        limit: String(realtimeCatchUpLimit),
      });
      params.append('id', `gt.${scanFrom}`);
      const res = await fetch(`${supabaseUrl}/rest/v1/doc_edits?${params}`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      });
      if (!res.ok) {
        logError(`catchUp fetch failed status=${res.status}`, '');
        return;
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop -- ordered apply
        await realtimeApplier.apply(row);
      }
      if (!safeFrozen) {
        const advanced = safeBackstopCursor(rows, safeCursor, cutoffMs);
        // Stopped before the page's last id ⇒ hit a too-new row ⇒ freeze: no
        // later (higher-id) row may advance the cursor past that gap.
        if (advanced < Number(rows[rows.length - 1]?.id ?? advanced)) safeFrozen = true;
        safeCursor = advanced;
      }
      const pageMaxId = Number(rows[rows.length - 1]?.id ?? scanFrom);
      log(`realtime catch-up applied=${rows.length} lastId=${pageMaxId}`);
      if (!(pageMaxId > scanFrom) || rows.length < realtimeCatchUpLimit) break;
      scanFrom = pageMaxId;
    }
    realtimeApplier.setCursor(safeCursor);
  } catch (error) {
    logError('catchUpDocEdits failed', error);
  } finally {
    catchUpInFlight = false;
  }
}

async function startRealtimeListener() {
  // Establish a baseline before subscribing — anything older than this id is
  // already represented by boot hydrate. The baseline is LAGGED: an edit
  // committing around boot (the hydrate→baseline window, or a lower id still
  // in flight while a higher id is visible) must not start below the floor,
  // where nothing would ever recover it. Rows younger than the lag stay above
  // the floor and the first catch-up re-applies them — idempotent, hydrate
  // wrote the same content.
  try {
    const params = new URLSearchParams({
      select: 'id',
      workspace_id: `eq.${workspaceId}`,
      created_at: `lt.${new Date(Date.now() - realtimeCursorLagMs).toISOString()}`,
      order: 'id.desc',
      limit: '1',
    });
    const res = await fetch(`${supabaseUrl}/rest/v1/doc_edits?${params}`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    const rows = res.ok ? await res.json() : [];
    const id = Array.isArray(rows) ? Number(rows[0]?.id ?? 0) : 0;
    if (Number.isFinite(id) && id > 0) realtimeApplier.setCursor(id);
  } catch (error) {
    logError('realtime baseline failed', error);
  }

  subscribeChannel();
}

// A channel that errors or times out never delivers SUBSCRIBED, so waiting on
// supabase-js alone leaves the mirror dead for the sandbox's lifetime. Tear
// the failed channel down and resubscribe fresh with capped backoff.
let activeChannel = null;
let resubscribeTimer = null;
let resubscribeDelayMs = resubscribeBaseMs;

function scheduleResubscribe(channel) {
  if (channel !== activeChannel || resubscribeTimer) return;
  const delay = resubscribeDelayMs;
  resubscribeDelayMs = Math.min(resubscribeDelayMs * 2, 30_000);
  log(`realtime resubscribe in ${delay}ms`);
  resubscribeTimer = setTimeout(async () => {
    resubscribeTimer = null;
    activeChannel = null; // ignore late status callbacks from the old channel
    try {
      await realtimeClient.removeChannel(channel);
    } catch {}
    subscribeChannel();
  }, delay);
}

function subscribeChannel() {
  const channel = realtimeClient.channel(`workspace-doc-edits-${workspaceId}`, {
    config: { broadcast: { self: false } },
  });
  activeChannel = channel;
  channel.on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'doc_edits',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      void realtimeApplier.apply(payload?.new);
    },
  );
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      resubscribeDelayMs = resubscribeBaseMs;
      if (channel === activeChannel && resubscribeTimer) {
        clearTimeout(resubscribeTimer);
        resubscribeTimer = null;
      }
      log(`realtime channel subscribed baseline=${realtimeApplier.getCursor()}`);
      // Drain anything that landed between the baseline read and now, plus
      // anything missed across a reconnect.
      void catchUpDocEdits();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      logError(`realtime channel ${status}`, '');
      scheduleResubscribe(channel);
    }
  });
}

void startRealtimeListener().then(() => {
  setInterval(() => void catchUpDocEdits(), realtimePollMs);
});

httpServer.listen(port, '0.0.0.0', () => {
  const actual = httpServer.address()?.port ?? port;
  log(`listening port=${actual} workspace=${workspaceId}`);
});
httpServer.on('error', (err) => {
  logError(`http server failed`, err);
  process.exit(1);
});
