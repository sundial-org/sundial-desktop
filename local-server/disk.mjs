import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileKind, isIgnoredPath, normalizeRelPath, resolveInRoot } from './paths.mjs';

const MAX_TEXT_BYTES = 10 * 1024 * 1024;

/** Symlink-safe resolution: `resolveInRoot` is lexical, so a symlink inside
 *  the project (`link -> ~/Documents`) would pass the prefix check while the
 *  underlying fs ops escape the folder. Resolve the nearest EXISTING ancestor
 *  to its realpath and require it to stay under the project's realpath, and
 *  reject a leaf that is itself a symlink. Returns the absolute (lexical)
 *  path, or throws 400. */
export async function safeResolveInRoot(root, rel) {
  const abs = resolveInRoot(root, rel);
  if (!abs) throw Object.assign(new Error('invalid path'), { status: 400 });
  const realRoot = await fsp.realpath(root);
  let ancestor = path.dirname(abs);
  for (;;) {
    try {
      const real = await fsp.realpath(ancestor);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw Object.assign(new Error('path escapes project root'), { status: 400 });
      }
      break;
    } catch (error) {
      if (error?.status) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw Object.assign(new Error('invalid path'), { status: 400 });
      ancestor = parent;
    }
  }
  const leaf = await fsp.lstat(abs).catch(() => null);
  if (leaf?.isSymbolicLink()) {
    throw Object.assign(new Error('symlinks are not served'), { status: 400 });
  }
  return abs;
}

export async function walkProject(root) {
  const files = [];
  // Serial await-per-stat made big trees crawl (~1M entries ≈ 36s); batching
  // each directory's stats and visiting directories concurrently halves it.
  // The semaphore bounds in-flight readdirs; a slot is held only while a
  // directory's own entries stat (released before recursing), so no deadlock.
  let active = 0;
  const waiters = [];
  const acquire = () =>
    active < 16 ? ((active += 1), Promise.resolve()) : new Promise((resolve) => waiters.push(resolve));
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };
  const visit = async (dirAbs, dirRel) => {
    await acquire();
    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      release();
      return;
    }
    const subdirs = [];
    // Chunked so a single flat directory can't queue an unbounded number of
    // in-flight stat promises.
    const describe = async (entry) => {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (isIgnoredPath(rel)) return;
      if (entry.isSymbolicLink()) return;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        // Folder rows let the file tree render empty directories; sync-side
        // consumers all filter on type === 'text' and skip these.
        const dirStat = await fsp.stat(abs).catch(() => null);
        files.push({ path: rel, type: 'folder', size: 0, updated_at: (dirStat?.mtime ?? new Date()).toISOString() });
        subdirs.push([abs, rel]);
        return;
      }
      if (!entry.isFile()) return;
      const kind = fileKind(rel);
      if (!kind) return;
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat) return;
      files.push({
        path: rel,
        type: kind,
        size: stat.size,
        updated_at: stat.mtime.toISOString(),
      });
    };
    for (let i = 0; i < entries.length; i += 256) {
      await Promise.all(entries.slice(i, i + 256).map(describe));
    }
    release();
    await Promise.all(subdirs.map(([abs, rel]) => visit(abs, rel)));
  };
  await visit(root, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export async function readTextFile(root, relPath) {
  const abs = await safeResolveInRoot(root, relPath);
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat?.isFile()) return null;
  if (stat.size > MAX_TEXT_BYTES) {
    throw Object.assign(new Error('file too large'), { status: 413 });
  }
  const text = await fsp.readFile(abs, 'utf8');
  return { text, stat };
}

/** Atomic write (tmp + rename) so watchers and other readers never observe a
 *  half-written file. Creates parent directories as needed. */
export async function writeTextFileAtomic(root, relPath, text) {
  // Same cap as readTextFile — accepting a larger write would create a file
  // the sidecar then refuses to reopen or sync.
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    throw Object.assign(new Error('file too large'), { status: 413 });
  }
  const abs = await safeResolveInRoot(root, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const previous = await fsp.stat(abs).catch(() => null);
  const tmp = `${abs}.sundial-tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, text, 'utf8');
  // The rename replaces the inode — carry the original mode (exec bit on
  // scripts, restrictive perms) onto the new one.
  if (previous) await fsp.chmod(tmp, previous.mode & 0o7777).catch(() => {});
  await fsp.rename(tmp, abs);
  return abs;
}

/** Streaming atomic blob write — local uploads are plain writes to the
 *  user's own disk, so unlike the sync rails there is NO size cap here. */
export async function writeBlobStreamAtomic(root, relPath, readable) {
  const abs = await safeResolveInRoot(root, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.sundial-tmp-${process.pid}-${Date.now()}`;
  try {
    await pipeline(readable, fs.createWriteStream(tmp));
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  await fsp.rename(tmp, abs);
  return abs;
}

/** Atomic binary write for blob uploads — same tmp+rename pattern as text.
 *  `maxBytes` caps uploads; compile artifacts (PDFs easily exceed 10 MB)
 *  pass Infinity. */
export async function writeBlobAtomic(root, relPath, buffer, { maxBytes = MAX_TEXT_BYTES } = {}) {
  if (buffer.length > maxBytes) {
    throw Object.assign(new Error('file too large'), { status: 413 });
  }
  const abs = await safeResolveInRoot(root, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.sundial-tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, abs);
  return abs;
}

export async function makeFolder(root, relPath) {
  const abs = await safeResolveInRoot(root, relPath);
  await fsp.mkdir(abs, { recursive: true });
}

/** Recursive copy that never overwrites and never enters ignored paths. */
export async function copyPath(root, fromRel, toRel) {
  const fromAbs = await safeResolveInRoot(root, fromRel);
  const toAbs = await safeResolveInRoot(root, toRel);
  if (toRel === fromRel || toRel.startsWith(`${fromRel}/`)) {
    throw Object.assign(new Error('cannot copy into itself'), { status: 400 });
  }
  if (await fsp.stat(toAbs).catch(() => null)) {
    throw Object.assign(new Error('target already exists'), { status: 409 });
  }
  const stat = await fsp.lstat(fromAbs).catch(() => null);
  if (!stat) throw Object.assign(new Error('not found'), { status: 404 });
  const copy = async (srcAbs, destAbs, rel) => {
    const entryStat = await fsp.lstat(srcAbs);
    if (entryStat.isSymbolicLink()) return;
    if (entryStat.isDirectory()) {
      await fsp.mkdir(destAbs, { recursive: true });
      for (const entry of await fsp.readdir(srcAbs)) {
        const childRel = `${rel}/${entry}`;
        if (isIgnoredPath(childRel)) continue;
        await copy(path.join(srcAbs, entry), path.join(destAbs, entry), childRel);
      }
      return;
    }
    if (entryStat.isFile()) {
      await fsp.mkdir(path.dirname(destAbs), { recursive: true });
      await fsp.copyFile(srcAbs, destAbs);
    }
  };
  await copy(fromAbs, toAbs, fromRel);
}

export async function renameFile(root, fromRel, toRel) {
  const fromAbs = await safeResolveInRoot(root, fromRel);
  const toAbs = await safeResolveInRoot(root, toRel);
  const existing = await fsp.stat(toAbs).catch(() => null);
  if (existing) throw Object.assign(new Error('target already exists'), { status: 409 });
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);
}

/** Delete a file, or a folder's NON-IGNORED contents: nested repos/caches
 *  (.git, node_modules, …) survive a tree delete — the ignore policy exists
 *  precisely to keep sync/API operations away from them. The folder itself is
 *  removed only when nothing protected remains inside. */
export async function deleteFile(root, relPath) {
  const abs = await safeResolveInRoot(root, relPath);
  const stat = await fsp.lstat(abs).catch(() => null);
  if (!stat) return;
  if (!stat.isDirectory()) {
    await fsp.rm(abs, { force: true });
    return;
  }
  const prune = async (dirAbs, dirRel) => {
    for (const entry of await fsp.readdir(dirAbs, { withFileTypes: true })) {
      const rel = `${dirRel}/${entry.name}`;
      if (isIgnoredPath(rel)) continue;
      const entryAbs = path.join(dirAbs, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await prune(entryAbs, rel);
      else await fsp.rm(entryAbs, { force: true });
    }
    await fsp.rmdir(dirAbs).catch(() => {}); // stays if protected content remains
  };
  await prune(abs, relPath);
}

/** True when deleting `relPath` would also remove content the file listing
 *  never showed — unknown-extension files (fileKind null) or symlinks.
 *  Undo-delete can only rebuild tracked files, so such deletes must not be
 *  advertised as undoable. Ignored paths don't count: deleteFile preserves
 *  them. Never follows symlinks. */
export async function hasUntrackedContent(root, relPath) {
  const abs = await safeResolveInRoot(root, relPath);
  const scan = async (entryAbs, rel) => {
    const stat = await fsp.lstat(entryAbs).catch(() => null);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
    if (!stat.isDirectory()) return fileKind(rel) === null;
    for (const entry of await fsp.readdir(entryAbs, { withFileTypes: true }).catch(() => [])) {
      const childRel = `${rel}/${entry.name}`;
      if (isIgnoredPath(childRel)) continue;
      if (await scan(path.join(entryAbs, entry.name), childRel)) return true;
    }
    return false;
  };
  return scan(abs, relPath);
}

/** Recursive fs.watch with per-path debounce. `onChange(relPath, suppressed)`
 *  fires after the debounce window for any non-ignored path; `suppressed` is
 *  true when the change is (probably) an echo of our own write — callers still
 *  reconcile content (the text compare is the real echo guard) but skip
 *  side-effects like ledger rows and SSE noise. */
export class ProjectWatcher {
  constructor(root, onChange, { debounceMs = 150 } = {}) {
    this.root = root;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    this.timers = new Map();
    this.suppressed = new Map(); // relPath -> expiry timestamp
    // Which paths PREDATE any given moment (suggest-mode creation detection):
    // seeded by one initial walk, then maintained from events via
    // markSeen/markGone. `null` while the walk runs (or if it failed) —
    // seenBefore() then reports everything as pre-existing, the safe default.
    this.known = null;
    this.pendingOps = []; // ['seen'|'gone', rel] observed while walking
    // First-sight content capture for UNSEEN paths, taken at RAW event time:
    // an external create + agent overwrite can coalesce into one debounced
    // callback, and only the bytes at first sight can tell them apart.
    this.firstSight = new Map(); // relPath -> Promise<string|null>
    void walkProject(root)
      .then((files) => {
        this.known = new Set(files.filter((f) => f.type !== 'folder').map((f) => f.path));
        const ops = this.pendingOps;
        this.pendingOps = [];
        for (const [op, rel] of ops) (op === 'seen' ? this.known.add(rel) : this.markGone(rel));
      })
      .catch(() => {
        this.pendingOps = [];
      });
    this.watcher = fs.watch(root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const rel = normalizeRelPath(String(filename));
      if (!rel || isIgnoredPath(rel) || rel.includes('.sundial-tmp-')) return;
      if (this.known && !this.known.has(rel) && !this.timers.has(rel)) {
        this.firstSight.set(
          rel,
          readTextFile(this.root, rel).then((disk) => disk?.text ?? null).catch(() => null),
        );
      }
      this.schedule(rel);
    });
  }

  /** True when the path existed before the event being handled (best effort;
   *  conservative "true" while the initial walk is still running). */
  seenBefore(relPath) {
    return this.known ? this.known.has(relPath) : true;
  }

  /** Consume the first-sight content promise captured when this path's raw
   *  event arrived (undefined when none was captured). */
  takeFirstSight(relPath) {
    const capture = this.firstSight.get(relPath);
    this.firstSight.delete(relPath);
    return capture;
  }

  markSeen(relPath) {
    if (this.known) this.known.add(relPath);
    else this.pendingOps.push(['seen', relPath]);
  }

  /** Forget the path AND everything under it — a folder delete's children
   *  never get their own events, and a stale entry would make a recreated
   *  child read as pre-existing. */
  markGone(relPath) {
    this.firstSight.delete(relPath);
    if (!this.known) {
      this.pendingOps.push(['gone', relPath]);
      return;
    }
    this.known.delete(relPath);
    const prefix = `${relPath}/`;
    for (const rel of [...this.known]) {
      if (rel.startsWith(prefix)) this.known.delete(rel);
    }
  }

  /** Ignore watcher events for this path for the next `ms` (our own write).
   *  An own write also proves the path exists NOW — mark it seen immediately,
   *  not when its (possibly coalesced) event lands. */
  suppress(relPath, ms = 2_000) {
    this.suppressed.set(relPath, Date.now() + ms);
    this.markSeen(relPath);
  }

  schedule(rel) {
    const existing = this.timers.get(rel);
    if (existing) clearTimeout(existing);
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel);
        const until = this.suppressed.get(rel);
        const suppressed = Boolean(until && until > Date.now());
        if (!suppressed) this.suppressed.delete(rel);
        this.onChange(rel, suppressed);
      }, this.debounceMs),
    );
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.watcher.close();
  }
}
