// Pure-ish handler for incoming doc_edits Realtime events. Separated from
// sync_client.mjs's IO + channel setup so we can unit-test the
// dedup/coalesce/cursor logic with mocked fs + supabase.
//
// Contract:
//   * `apply(row)` processes one doc_edits row (shape: { id, path, content_text }).
//   * Rows with id <= cursor are dropped. The cursor is a FLOOR owned by the
//     caller (boot baseline + lagged catch-up advance via setCursor); apply()
//     never advances it, so a Realtime push of a higher id can't make the
//     catch-up poll skip a dropped/late-committing lower id.
//   * Per path, rows with id <= the last applied id for that path are dropped —
//     dedups catch-up/push overlap and keeps a late lower-id row from
//     clobbering newer content already on disk.
//   * Rows whose content_text is null and whose fallback fetch also returns
//     null are delete tombstones; they unlink the local file.
//   * Rename signals are a tombstone at the old path plus a
//     `sundial-rename-v1` row at the new path, so a warm sandbox sees the
//     renamed layout without a rehydrate. The rename row normally carries the
//     file text at rename time; one without content falls back to the files
//     row, and a fallback miss is a no-op (never a delete — the delete
//     already ran at the old path).
//   * Rows whose content_text matches `lastVolumeText.get(path)` are dropped —
//     a self-broadcast (we just wrote it) is a no-op.
//   * Otherwise the row is queued; per-path debounce coalesces rapid bursts
//     into a single write.
//
// Side-effects all flow through injected callbacks (writeFile, writeDigest,
// fetchFallbackContent, normalizePath, isIgnoredPath). That makes the class
// trivial to unit-test without touching disk or Supabase.

export const DOC_EDIT_DELETE_UPDATE = 'sundial-delete-v1';
export const DOC_EDIT_RENAME_UPDATE = 'sundial-rename-v1';

// How far a doc_edits catch-up cursor may advance over a scanned page.
// `doc_edits.id` is allocated at INSERT but a row is visible only at COMMIT, so
// a scan can see id N+1 while N is still in flight; advancing the cursor to the
// max visible id would skip N forever once it commits (PR #698 review). Given an
// id-ascending page carrying `created_at`, advance only through the contiguous
// PREFIX of rows older than `cutoffMs` (= now − safety lag) and stop at the
// first too-new row — no higher id may jump the gap. Safe as long as no
// doc_edits insert transaction stays open past the lag (they're sub-second RPCs).
export function safeBackstopCursor(rows, fromCursor, cutoffMs) {
  let safe = fromCursor;
  for (const row of Array.isArray(rows) ? rows : []) {
    const created = Date.parse(row?.created_at);
    if (!Number.isFinite(created) || created >= cutoffMs) break;
    const id = Number(row?.id ?? 0);
    if (Number.isFinite(id) && id > safe) safe = id;
  }
  return safe;
}

export class RealtimeDocEditsApplier {
  constructor({
    lastVolumeText,
    writeFile,
    writeDigest,
    deleteFile = async (_relPath) => true,
    writeDeleteDigest = async (_relPath) => {},
    fetchFallbackContent,
    normalizePath,
    isIgnoredPath = () => false,
    // Skip a write when the on-disk markdown file is byte-different but
    // canonically identical to the incoming content. Cloned markdown is stored
    // canonical in the doc store, and echoing that back over the original
    // working-tree bytes would dirty git with normalization no one made (the
    // "N files modified on a fresh clone" bug). Optional — when unset, the
    // applier writes unconditionally (prior behaviour).
    readExisting = null,
    canonicalizeMarkdown = null,
    isMarkdownPath = () => false,
    coalesceMs = 50,
    log = () => {},
    logError = () => {},
    now = () => Date.now(),
  }) {
    if (!lastVolumeText || typeof lastVolumeText.get !== 'function') {
      throw new Error('lastVolumeText must be a Map');
    }
    if (typeof writeFile !== 'function') throw new Error('writeFile must be a function');
    if (typeof writeDigest !== 'function') throw new Error('writeDigest must be a function');
    if (typeof normalizePath !== 'function') throw new Error('normalizePath must be a function');

    this._lastVolumeText = lastVolumeText;
    this._writeFile = writeFile;
    this._writeDigest = writeDigest;
    this._deleteFile = deleteFile;
    this._writeDeleteDigest = writeDeleteDigest;
    this._fetchFallbackContent = fetchFallbackContent ?? null;
    this._normalizePath = normalizePath;
    this._isIgnoredPath = isIgnoredPath;
    this._readExisting = readExisting;
    this._canonicalizeMarkdown = canonicalizeMarkdown;
    this._isMarkdownPath = isMarkdownPath;
    this._coalesceMs = coalesceMs;
    this._log = log;
    this._logError = logError;
    this._now = now;
    this._cursor = 0;
    this._pathLastId = new Map(); // relPath -> last applied doc_edits id
    this._pending = new Map(); // relPath -> { content, timer }
  }

  setCursor(id) {
    if (typeof id === 'number' && Number.isFinite(id) && id > this._cursor) {
      this._cursor = id;
    }
  }

  getCursor() {
    return this._cursor;
  }

  async apply(row) {
    if (!row || typeof row !== 'object') return { status: 'invalid' };
    const rowId = Number(row.id ?? 0);
    if (!Number.isFinite(rowId) || rowId <= 0) return { status: 'invalid' };
    if (rowId <= this._cursor) return { status: 'cursor_skip', rowId };

    const relPath = this._normalizePath(row.path);
    if (!relPath) return { status: 'invalid_path', rowId };
    if (this._isIgnoredPath(relPath)) return { status: 'ignored', rowId };
    if (rowId <= (this._pathLastId.get(relPath) ?? 0)) return { status: 'path_skip', rowId, path: relPath };

    if (row.update_bytes === DOC_EDIT_DELETE_UPDATE) {
      this._pathLastId.set(relPath, rowId);
      this._scheduleDelete(relPath);
      return { status: 'delete_scheduled', rowId, path: relPath };
    }

    let content = typeof row.content_text === 'string' ? row.content_text : null;
    if (content === null) {
      if (!this._fetchFallbackContent) return { status: 'no_content', rowId };
      try {
        content = await this._fetchFallbackContent(relPath);
      } catch (error) {
        // pathLastId deliberately NOT advanced: the next catch-up retries.
        this._logError(`fallback fetch failed doc=${relPath}`, error);
        return { status: 'fetch_failed', rowId };
      }
      if (content === null) {
        this._pathLastId.set(relPath, rowId);
        if (row.update_bytes === DOC_EDIT_RENAME_UPDATE) {
          return { status: 'no_content', rowId };
        }
        this._scheduleDelete(relPath);
        return { status: 'delete_scheduled', rowId, path: relPath };
      }
      if (typeof content !== 'string') return { status: 'no_content', rowId };
    }

    this._pathLastId.set(relPath, rowId);
    this._scheduleWrite(relPath, content);
    return { status: 'scheduled', rowId, path: relPath };
  }

  _scheduleWrite(relPath, content) {
    this._schedule(relPath, { kind: 'write', content });
  }

  _scheduleDelete(relPath) {
    this._schedule(relPath, { kind: 'delete' });
  }

  _schedule(relPath, next) {
    const existing = this._pending.get(relPath);
    if (existing) {
      // Cancel the prior timer; latest content wins.
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      const entry = this._pending.get(relPath);
      this._pending.delete(relPath);
      // Use the latest queued operation (in case more rows arrived during the
      // window) — the entry was overwritten by each apply call.
      this._materialize(relPath, entry?.op ?? next).catch((err) => {
        this._logError(`realtime materialize failed doc=${relPath}`, err);
      });
    }, this._coalesceMs);
    this._pending.set(relPath, { op: next, timer });
  }

  async _materialize(relPath, op) {
    if (op.kind === 'delete') {
      const deleted = await this._deleteFile(relPath);
      if (deleted === false) return;
      await this._writeDeleteDigest(relPath);
      this._lastVolumeText.delete(relPath);
      this._log(`realtime delete doc=${relPath}`);
      return;
    }
    const { content } = op;
    if (this._lastVolumeText.get(relPath) === content) return;
    if (await this._skipNormalizationOnlyWrite(relPath, content)) return;
    const wrote = await this._writeFile(relPath, content);
    if (wrote === false) return;
    await this._writeDigest(relPath, content);
    this._lastVolumeText.set(relPath, content);
    this._log(`realtime write doc=${relPath} len=${content.length}`);
  }

  // True when `content` is just the codec-normalized form of what's already on
  // disk: writing it would only reformat the file and dirty git. We leave the
  // original bytes in place but refresh the collab digest for the on-disk text,
  // so the file-server watcher still treats the path as synced (no echo).
  async _skipNormalizationOnlyWrite(relPath, content) {
    if (!this._canonicalizeMarkdown || !this._readExisting || !this._isMarkdownPath(relPath)) {
      return false;
    }
    let existing = null;
    try {
      existing = await this._readExisting(relPath);
    } catch {
      return false;
    }
    if (existing == null || existing === content) return false;
    // Canonicalize BOTH sides: `canonicalizeMarkdown` is a fixed-point normalizer
    // (it iterates to convergence), so this is safe even though `content` isn't
    // always already canonical — Hocuspocus persists `readDocumentText` output
    // (a single pass). Both converge to the same form, so a normalization-only
    // difference (cloned bytes vs. canonical) is detected and skipped.
    let same = false;
    try {
      same = this._canonicalizeMarkdown(existing) === this._canonicalizeMarkdown(content);
    } catch {
      return false;
    }
    if (!same) return false;
    await this._writeDigest(relPath, existing);
    this._lastVolumeText.set(relPath, content);
    this._log(`realtime skip normalization-only doc=${relPath}`);
    return true;
  }

  // Test helper: synchronously flush all pending writes. Real callers rely
  // on the coalesce timers firing on their own.
  async flushForTest() {
    const entries = Array.from(this._pending.entries());
    for (const [relPath, { timer, op }] of entries) {
      clearTimeout(timer);
      this._pending.delete(relPath);
      // eslint-disable-next-line no-await-in-loop -- test path, ordered intent
      await this._materialize(relPath, op);
    }
  }

  // Test helper: visibility into queued writes without flushing.
  pendingPaths() {
    return Array.from(this._pending.keys());
  }
}
