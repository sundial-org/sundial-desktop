import path from 'node:path';
import fsp from 'node:fs/promises';

import { walkProject, ProjectWatcher } from './disk.mjs';
import { isIgnoredPath } from './paths.mjs';

/** Multi-root path model. A project always has a PRIMARY root (projects.root)
 *  whose entries keep the un-prefixed paths every existing project already
 *  persisted (ledger, doc states, file ids). EXTRA roots — folders mounted
 *  from anywhere on disk — each live under one top-level prefix segment, so a
 *  virtual project path maps to exactly one (root, inner-path) pair. This
 *  module is the single authority for that mapping: the walker, watcher,
 *  doc host, HTTP endpoints, and agent tools must all resolve through it. */

/** All roots for a project, primary first (prefix ''). */
export function projectRoots(store, project) {
  return [
    { prefix: '', root: project.root, name: path.basename(project.root) || project.root },
    ...store.listExtraRoots(project.id).map((row) => ({
      prefix: row.prefix,
      root: row.root,
      name: path.basename(row.root) || row.root,
    })),
  ];
}

/** Which root serves `virtualRel`, plus the path relative to it. Extra-root
 *  prefixes are single top-level segments, so the first segment decides;
 *  everything else belongs to the primary root. `rel` is '' when virtualRel
 *  IS an extra root's prefix (the mount itself, not a file under it). */
export function locateRel(roots, virtualRel) {
  const rel = String(virtualRel ?? '');
  const head = rel.split('/', 1)[0];
  for (const entry of roots) {
    if (!entry.prefix || entry.prefix !== head) continue;
    return { entry, root: entry.root, rel: rel === entry.prefix ? '' : rel.slice(entry.prefix.length + 1) };
  }
  return { entry: roots[0], root: roots[0].root, rel };
}

export function locateProjectPath(store, project, virtualRel) {
  return locateRel(projectRoots(store, project), virtualRel);
}

/** True when `virtualRel` lives under an extra root — such paths never reach
 *  the cloud share bridges (shares cover the primary root only). */
export function inExtraRoot(store, projectId, virtualRel) {
  const head = String(virtualRel ?? '').split('/', 1)[0];
  return head !== '' && store.listExtraRoots(projectId).some((row) => row.prefix === head);
}

/** Inner (per-root) path → virtual project path. */
export function virtualPath(prefix, rel) {
  return prefix ? (rel ? `${prefix}/${rel}` : prefix) : rel;
}

/** Deterministic prefix for a newly mounted root: its basename, then -2/-3/…
 *  past collisions with existing prefixes or names in `taken`, and past
 *  policy-ignored names (a root literally named node_modules must still get a
 *  servable prefix). */
export function pickRootPrefix(rootPath, taken) {
  // Slashes cannot survive in a single segment, and backslashes wouldn't
  // either (normalizeRelPath treats them as separators).
  const base = (path.basename(rootPath) || 'folder').replace(/[\\/]/g, '-') || 'folder';
  let candidate = base;
  for (let n = 2; taken.has(candidate) || isIgnoredPath(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

/** Combined walk across every root: primary entries keep their paths, each
 *  extra root contributes a folder row for its mount point plus its entries
 *  under the prefix. Sorted like walkProject's single-root output. Deduped by
 *  path with extra roots winning — a primary-root entry created UNDER a mount
 *  prefix after the fact (mkdir outside Sundial) is shadowed exactly like
 *  locateRel resolves it, and duplicate paths would blow up ensureFileIds. */
export async function walkAllRoots(roots) {
  if (roots.length === 1) return walkProject(roots[0].root);
  const lists = await Promise.all(
    roots.map(async (entry) => {
      const files = await walkProject(entry.root).catch(() => []);
      if (!entry.prefix) return files;
      const stat = await fsp.stat(entry.root).catch(() => null);
      return [
        { path: entry.prefix, type: 'folder', size: 0, updated_at: (stat?.mtime ?? new Date()).toISOString() },
        ...files.map((file) => ({ ...file, path: `${entry.prefix}/${file.path}` })),
      ];
    }),
  );
  const prefixes = new Set(roots.map((entry) => entry.prefix).filter(Boolean));
  const byPath = new Map();
  for (const [index, files] of lists.entries()) {
    for (const file of files) {
      // Primary-root entries at/under a mount prefix are unreachable
      // (resolution routes the first segment to the mount) — drop them.
      if (index === 0 && prefixes.has(file.path.split('/', 1)[0])) continue;
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** One watcher per root, addressed by VIRTUAL paths — the doc host and server
 *  keep calling the single-watcher API (suppress/seenBefore/…); this routes
 *  each call to the owning root's ProjectWatcher with the inner path. Each
 *  child is an unmodified ProjectWatcher, so the walk-seeded known-tree
 *  invariant holds per root. */
export class RootWatchers {
  constructor() {
    this.children = new Map(); // prefix ('' = primary) -> ProjectWatcher
  }

  /** Attach a watcher for one root. `onChange(virtualRel, suppressed)`. */
  attach(prefix, root, onChange, { debounceMs } = {}) {
    this.detach(prefix);
    this.children.set(
      prefix,
      new ProjectWatcher(root, (rel, suppressed) => onChange(virtualPath(prefix, rel), suppressed), { ...(debounceMs ? { debounceMs } : {}) }),
    );
  }

  detach(prefix) {
    this.children.get(prefix)?.close();
    this.children.delete(prefix);
  }

  #route(virtualRel) {
    const rel = String(virtualRel ?? '');
    const head = rel.split('/', 1)[0];
    const child = head && this.children.get(head);
    if (child) return [child, rel === head ? '' : rel.slice(head.length + 1)];
    return [this.children.get(''), rel];
  }

  seenBefore(virtualRel) {
    const [watcher, rel] = this.#route(virtualRel);
    return watcher && rel ? watcher.seenBefore(rel) : true;
  }

  takeFirstSight(virtualRel) {
    const [watcher, rel] = this.#route(virtualRel);
    return watcher && rel ? watcher.takeFirstSight(rel) : undefined;
  }

  markSeen(virtualRel) {
    const [watcher, rel] = this.#route(virtualRel);
    if (watcher && rel) watcher.markSeen(rel);
  }

  markGone(virtualRel) {
    const [watcher, rel] = this.#route(virtualRel);
    if (watcher && rel) watcher.markGone(rel);
  }

  suppress(virtualRel, ms) {
    const [watcher, rel] = this.#route(virtualRel);
    if (watcher && rel) watcher.suppress(rel, ...(ms === undefined ? [] : [ms]));
  }

  close() {
    for (const child of this.children.values()) child.close();
    this.children.clear();
  }
}
