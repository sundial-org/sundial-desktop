import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileKindForFile, isIgnoredPath, normalizeRelPath, resolveInRoot } from './paths.mjs';

export const MAX_TEXT_BYTES = 10 * 1024 * 1024;

const versionForStat = (stat) => `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
const identityForStat = (stat) => `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;

export function fileFingerprintSync(root, relPath) {
  const abs = resolveInRoot(root, relPath);
  if (!abs) return null;
  try {
    const stat = fs.statSync(abs, { bigint: true });
    return { version: versionForStat(stat), identity: identityForStat(stat) };
  } catch {
    return null;
  }
}

export function fileVersionSync(root, relPath) {
  return fileFingerprintSync(root, relPath)?.version ?? null;
}

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

/** `onDir(rel, ino)` streams each non-ignored directory as it is discovered —
 *  the Linux per-directory watcher attaches mid-walk from it, so the unwatched
 *  window for any directory ends at its discovery, not at walk completion. */
export async function walkProject(root, { onDir } = {}) {
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
        onDir?.(rel, dirStat?.ino);
        files.push({ path: rel, type: 'folder', size: 0, updated_at: (dirStat?.mtime ?? new Date()).toISOString() });
        subdirs.push([abs, rel]);
        return;
      }
      if (!entry.isFile()) return;
      const kind = fileKindForFile(rel);
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

/** Names the segment that actually clashes — the leaf, or the parent folder
 *  when that is where the spelling diverges. */
export const caseConflictMessage = (onDisk, rel) => {
  const want = rel.split('/');
  const differs = onDisk.split('/').find((segment, index) => segment !== want[index]);
  return `“${differs}” already exists here — names that differ only in capitalization are the same file on this disk`;
};

/** macOS and Windows disks are case-INSENSITIVE: `recent.md` resolves to an
 *  existing `Recent.md`, so a create there truncates that file and then never
 *  appears under the name that was typed. Returns the on-disk spelling when
 *  `rel` resolves to a differently-cased entry, else null — nothing there, an
 *  exact match, or a case-sensitive disk, where the two names coexist. */
export async function caseVariantOnDisk(root, rel) {
  // Validate BEFORE any stat/readdir: this runs ahead of the write helpers on
  // the create rails, so a path escaping the root through a symlink must be
  // rejected here (400) rather than probed and reported as a 409 naming a file
  // outside the project.
  await safeResolveInRoot(root, rel);
  const segments = rel.split('/');
  let dir = root;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const entries = await fsp.readdir(dir).catch(() => null);
    if (entries?.includes(segment)) {
      dir = path.join(dir, segment);
      continue;
    }
    const folded = entries?.find((entry) => entry.toLowerCase() === segment.toLowerCase());
    // A differently-cased sibling only COLLIDES when the disk folds case, i.e.
    // when the requested spelling resolves to it anyway. On a case-SENSITIVE
    // disk it does not, and this is a genuinely new path.
    if (!folded || !(await fsp.stat(path.join(dir, segment)).catch(() => null))) return null;
    // Whether the clash is at the leaf or at a parent folder, this is where
    // the write would silently land somewhere other than the path asked for.
    return [...segments.slice(0, i), folded, ...segments.slice(i + 1)].join('/');
  }
  return null; // every segment matched exactly
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

/** Materialize a cloud-side empty text file without replacing a local file
 *  created after the caller's existence check. */
export async function createEmptyTextFileExclusive(root, relPath) {
  const abs = await safeResolveInRoot(root, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const handle = await fsp.open(abs, 'wx');
  await handle.close();
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

/** Returns `{ caseOnly }` — true when this was a capitalization-only rename of
 *  the same entry. The OLD spelling still resolves to the file on a
 *  case-folding disk, so callers suppress the watcher for it. */
export async function renameFile(root, fromRel, toRel) {
  const fromAbs = await safeResolveInRoot(root, fromRel);
  const toAbs = await safeResolveInRoot(root, toRel);
  const existing = await fsp.stat(toAbs).catch(() => null);
  // On a case-folding disk the target stats the SOURCE itself when the rename
  // only changes capitalization (Notes.md -> notes.md): a real rename, not a
  // collision. Everything else that the disk resolves the target onto is —
  // including a differently-cased PARENT (`Docs/draft.md` where the folder is
  // `docs/`), which would land the file somewhere other than the path the
  // caller goes on to record, so it is probed even when the leaf is free.
  const variant = await caseVariantOnDisk(root, toRel);
  const caseOnly = variant === fromRel && path.dirname(toRel) === path.dirname(fromRel);
  if ((existing || variant) && !caseOnly) {
    throw Object.assign(
      new Error(variant && variant !== fromRel ? caseConflictMessage(variant, toRel) : 'target already exists'),
      { status: 409 },
    );
  }
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  if (caseOnly) {
    // Same `.sundial-tmp-` marker the atomic writes use — the watcher filters
    // it, so the intermediate never surfaces as a file in the tree.
    const via = `${fromAbs}.sundial-tmp-case-${process.pid}-${Date.now()}`;
    await fsp.rename(fromAbs, via);
    await fsp.rename(via, toAbs);
    return { caseOnly: true };
  }
  await fsp.rename(fromAbs, toAbs);
  return { caseOnly: false };
}

/** Delete a file, or a folder's NON-IGNORED contents: nested repos/caches
 *  (.git, node_modules, …) survive a tree delete — the ignore policy exists
 *  precisely to keep sync/API operations away from them. The folder itself is
 *  removed only when nothing protected remains inside.
 *
 *  Returns the ignored entries that survived, root-relative. A folder holding
 *  one is still on disk afterwards and comes straight back in the next
 *  listing, so the caller must say so rather than report a clean delete
 *  ("deleted a cloned repo, some files stayed" — Discord). */
export async function deleteFile(root, relPath) {
  const abs = await safeResolveInRoot(root, relPath);
  const stat = await fsp.lstat(abs).catch(() => null);
  if (!stat) return { kept: [] };
  if (!stat.isDirectory()) {
    await fsp.rm(abs, { force: true });
    return { kept: [] };
  }
  const kept = [];
  const prune = async (dirAbs, dirRel) => {
    for (const entry of await fsp.readdir(dirAbs, { withFileTypes: true })) {
      const rel = `${dirRel}/${entry.name}`;
      if (isIgnoredPath(rel)) {
        kept.push(rel);
        continue;
      }
      const entryAbs = path.join(dirAbs, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await prune(entryAbs, rel);
      else await fsp.rm(entryAbs, { force: true });
    }
    await fsp.rmdir(dirAbs).catch(() => {}); // stays if protected content remains
  };
  await prune(abs, relPath);
  return { kept };
}

/** True when deleting `relPath` would also remove content the file listing
 *  never showed — symlinks only, now that every regular file classifies.
 *  Undo-delete can only rebuild tracked files, so such deletes must not be
 *  advertised as undoable. Ignored paths don't count: deleteFile preserves
 *  them. Never follows symlinks. */
export async function hasUntrackedContent(root, relPath) {
  const abs = await safeResolveInRoot(root, relPath);
  const scan = async (entryAbs, rel) => {
    const stat = await fsp.lstat(entryAbs).catch(() => null);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
    if (!stat.isDirectory()) return false;
    for (const entry of await fsp.readdir(entryAbs, { withFileTypes: true }).catch(() => [])) {
      const childRel = `${rel}/${entry.name}`;
      if (isIgnoredPath(childRel)) continue;
      if (await scan(path.join(entryAbs, entry.name), childRel)) return true;
    }
    return false;
  };
  return scan(abs, relPath);
}

let watchLimitWarned = false;

/** Recursive tree watch. On Linux, Node's recursive fs.watch attaches inotify
 *  watches to files, so it goes permanently deaf to modify events for any file
 *  whose inode was swapped by an atomic tmp+rename write (our own
 *  writeTextFileAtomic, vim, VS Code saves). Directory-level watches deliver
 *  child events regardless of file inodes, so on Linux we keep one
 *  non-recursive watch per directory instead; darwin/win32 keep the native
 *  recursive watcher. `add(rel, ino)` attaches a watch for a pre-existing
 *  subdirectory — fed from ProjectWatcher's initial walk so huge roots
 *  aren't walked twice. */
export function watchTree(root, listener) {
  if (process.platform !== 'linux') {
    return fs.watch(root, { recursive: true }, listener);
  }
  const watchers = new Map(); // relDir ('' = root) -> { w: fs.FSWatcher, ino }
  const failed = new Set(); // dirs whose watch attach failed (EMFILE/ENOSPC)
  let closed = false;
  let lastAttachError = null;
  let retryTimer = null;
  // Watch-limit failures would otherwise leave a subtree silently unwatched
  // forever — retry on a slow timer and rescan the directory once it attaches.
  const scheduleRetry = () => {
    if (retryTimer || closed || failed.size === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      for (const rel of [...failed]) {
        if (!fs.existsSync(path.join(root, rel))) {
          failed.delete(rel);
          continue;
        }
        discover(rel);
        if (watchers.has(rel)) failed.delete(rel);
      }
      scheduleRetry();
    }, 30_000);
    retryTimer.unref?.();
  };
  const drop = (relDir) => {
    for (const [dir, entry] of watchers) {
      if (dir === relDir || dir.startsWith(`${relDir}/`)) {
        entry.w.close();
        watchers.delete(dir);
      }
    }
  };
  const attach = (relDir, ino = null) => {
    if (closed || watchers.has(relDir)) return false;
    try {
      const w = fs.watch(path.join(root, relDir), (event, name) => {
        if (!name) return;
        const rel = relDir ? `${relDir}/${String(name)}` : String(name);
        listener(event, rel);
        // A created subdirectory needs its own watch; a deleted one, cleanup.
        // The has() guard keeps plain file deletes (every atomic write's tmp
        // rename included) from scanning the whole watcher map; children are
        // always attached after their parent, so a non-watched path can't
        // have watched descendants.
        fsp.lstat(path.join(root, rel)).then(
          (stat) => {
            if (!stat.isDirectory() || isIgnoredPath(rel)) return;
            // A delete + recreate at the same path leaves the old watch on a
            // dead inode. Re-attach on inode mismatch — and when the old
            // entry's inode is still unknown, since a stale watch we can't
            // verify would stay deaf forever while a re-attach only costs a
            // redundant rescan.
            const existing = watchers.get(rel);
            if (existing && existing.ino !== stat.ino) drop(rel);
            discover(rel, stat.ino);
          },
          () => {
            if (watchers.has(rel)) drop(rel);
          },
        );
      });
      w.on('error', () => drop(relDir));
      const entry = { w, ino };
      watchers.set(relDir, entry);
      if (ino == null) {
        fsp.stat(path.join(root, relDir)).then(
          (stat) => {
            entry.ino = stat.ino;
          },
          () => {},
        );
      }
      return true;
    } catch (error) {
      // inotify watch exhaustion (ENOSPC/EMFILE): leave this directory to the
      // poll recovery path rather than crashing the sidecar.
      lastAttachError = error;
      if (relDir) {
        failed.add(relDir);
        scheduleRetry();
        if (!watchLimitWarned) {
          watchLimitWarned = true;
          console.warn(`[disk] fs.watch failed for ${relDir} (${error?.code ?? error}); will retry`);
        }
      }
      return false;
    }
  };
  /** Watch a directory first seen via an event. Children created before the
   *  watch attached never fire their own events — re-announce them (and
   *  recurse into subdirectories). */
  const discover = (relDir, ino = null) => {
    if (!attach(relDir, ino)) return;
    fsp.readdir(path.join(root, relDir), { withFileTypes: true }).then(
      (entries) => {
        for (const entry of entries) {
          const rel = `${relDir}/${entry.name}`;
          if (isIgnoredPath(rel)) continue;
          listener('rename', rel);
          if (entry.isDirectory()) discover(rel);
        }
      },
      () => {},
    );
  };
  // A watcher with no root watch is totally deaf — surface the failure like
  // the native fs.watch(root) path did instead of masking it.
  if (!attach('')) throw lastAttachError ?? new Error('failed to watch project root');
  return {
    add(rel, ino) {
      if (!isIgnoredPath(rel)) attach(rel, ino);
    },
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      for (const entry of watchers.values()) entry.w.close();
      watchers.clear();
    },
  };
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
    this.inflight = new Set(); // onChange promises still running (see settle)
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
    this.firstSight = new Map(); // relPath -> Promise<{ at, text: string|null }>
    // Paths that had raw events while the walk was still running: the walk
    // may have swept them into `known`, so `known` cannot prove they PREDATE
    // watcher startup — knownBefore() refuses to vouch for them.
    this.walkTainted = new Set();
    this.watcher = watchTree(root, (event, filename) => {
      if (!filename) return;
      const rel = normalizeRelPath(String(filename));
      if (!rel || isIgnoredPath(rel) || rel.includes('.sundial-tmp-')) return;
      if (!this.known) this.walkTainted.add(rel);
      if (this.known && !this.known.has(rel) && !this.timers.has(rel)) {
        // `at` lets the doc host place the capture BEFORE or AFTER an agent
        // run's attribution window opened — the only signal telling a prior
        // generation's bytes apart from the agent's own first write stroke.
        // Stamped when the read COMPLETES, not when it starts: a read racing
        // a later overwrite returns the overwriter's bytes, and those must
        // not carry a pre-overwrite timestamp.
        this.firstSight.set(
          rel,
          readTextFile(this.root, rel)
            .then((disk) => ({ at: Date.now(), text: disk?.text ?? null }))
            .catch(() => ({ at: Date.now(), text: null })),
        );
      }
      this.schedule(rel);
    });
    // Linux per-directory watches attach mid-walk via onDir — no second tree
    // walk, and no deaf window lasting the whole walk on huge roots.
    void walkProject(root, { onDir: (rel, ino) => this.watcher.add?.(rel, ino) })
      .then((files) => {
        this.known = new Set(files.filter((f) => f.type !== 'folder').map((f) => f.path));
        const ops = this.pendingOps;
        this.pendingOps = [];
        for (const [op, rel] of ops) (op === 'seen' ? this.known.add(rel) : this.markGone(rel));
      })
      .catch(() => {
        this.pendingOps = [];
      });
  }

  /** True when the path existed before the event being handled (best effort;
   *  conservative "true" while the initial walk is still running). */
  seenBefore(relPath) {
    return this.known ? this.known.has(relPath) : true;
  }

  /** seenBefore without the conservative fallback: null while the walk is
   *  still running, and never true for a path whose events raced the walk —
   *  for callers that persist the answer as PROOF and must not turn
   *  walk-window uncertainty into a definite fact. */
  knownBefore(relPath) {
    if (!this.known) return null;
    return this.walkTainted.has(relPath) ? false : this.known.has(relPath);
  }

  /** Consume the first-sight capture (Promise<{ at, text }>) taken when this
   *  path's raw event arrived (undefined when none was captured). */
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
    this.walkTainted.delete(relPath);
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
        // Track the handler's own async work (it writes the ledger row) so
        // settle() can wait for the ROW, not just for the debounce to fire.
        const done = this.onChange(rel, suppressed);
        if (done && typeof done.then === 'function') {
          this.inflight.add(done);
          done.then(
            () => this.inflight.delete(done),
            () => this.inflight.delete(done),
          );
        }
      }, this.debounceMs),
    );
  }

  /** Resolve once no debounced event is pending AND every handler it fired has
   *  finished (bounded). A native-editing agent (Codex, Bash) writes files
   *  straight to disk, so the ledger rows for its turn only exist after the
   *  debounce fires *and* the handler's async record completes — anything that
   *  reads "what did this turn edit" right after the process exits must settle
   *  first or it reads zero and reports a turn that changed nothing. */
  async settle(timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    const tick = () => new Promise((resolve) => setTimeout(resolve, this.debounceMs));
    // Leading wait, unconditionally: a write made microseconds ago has no
    // timer YET (the fs event hasn't been delivered), so an "is anything
    // pending?" check would answer no and settle instantly — the very race
    // this exists to close.
    await tick();
    await tick();
    while ((this.timers.size > 0 || this.inflight.size > 0) && Date.now() < deadline) {
      // Race the handlers against the tick: a slow handler shouldn't add a
      // whole debounce to every loop, and a pending timer needs the tick.
      await (this.inflight.size > 0
        ? Promise.race([Promise.allSettled([...this.inflight]), tick()])
        : tick());
    }
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.watcher.close();
  }
}
