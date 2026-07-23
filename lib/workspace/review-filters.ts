// Pure filter engine for the review panel. The UI keeps a single ReviewFilter;
// the panel fetches with `bestServerScope` (an efficiency hint the changes route
// already understands) and narrows the rest client-side via `filterEntries`, so
// multi-select scope, specific authors, time, and checkpoints all work without a
// backend change (server-side support for these is a follow-up for scale). No
// client/server-only deps so the panel and unit tests share it.

import type { ChangeAuthorKind, ChangeEntry, ChangeScopeFilter } from './workspace-changes';

export type WhenFilter =
  | { kind: 'any' }
  | { kind: 'preset'; value: 'today' | 'week' | 'month' }
  | { kind: 'range'; from?: string; to?: string };

export type ReviewFilter = {
  /** Specific files (exact paths). */
  paths: string[];
  /** Specific folders (prefix match, with or without trailing slash). */
  folders: string[];
  /** Specific chat ids. */
  chats: string[];
  /** Author classes — sunny / local_agent / human (multi-select). */
  authorKinds: ChangeAuthorKind[];
  /** Specific authors by `doc_edits.author_id` (e.g. one agent or one person). */
  authorIds: string[];
  when: WhenFilter;
  checkpointsOnly: boolean;
};

export const EMPTY_FILTER: ReviewFilter = {
  paths: [],
  folders: [],
  chats: [],
  authorKinds: [],
  authorIds: [],
  when: { kind: 'any' },
  checkpointsOnly: false,
};

const DAY_MS = 86_400_000;
const norm = (folder: string) => (folder.endsWith('/') ? folder : `${folder}/`);

export function isEmptyFilter(f: ReviewFilter): boolean {
  return (
    f.paths.length === 0 &&
    f.folders.length === 0 &&
    f.chats.length === 0 &&
    f.authorKinds.length === 0 &&
    f.authorIds.length === 0 &&
    f.when.kind === 'any' &&
    !f.checkpointsOnly
  );
}

/** Distinct active axes — drives the "Advanced · N" badge. */
export function activeFilterCount(f: ReviewFilter): number {
  return (
    f.paths.length +
    f.folders.length +
    f.chats.length +
    f.authorKinds.length +
    f.authorIds.length +
    (f.when.kind === 'any' ? 0 : 1) +
    (f.checkpointsOnly ? 1 : 0)
  );
}

/**
 * The single server scope to fetch with: when exactly one scope value is
 * selected we let the server narrow (cheap, exact). Any multi-select falls back
 * to the whole workspace and `filterEntries` does the narrowing client-side.
 */
export function bestServerScope(f: ReviewFilter): ChangeScopeFilter {
  const only = (a: string[], b: string[], c: string[]) => a.length === 1 && b.length === 0 && c.length === 0;
  if (only(f.paths, f.folders, f.chats)) return { path: f.paths[0] };
  if (only(f.folders, f.paths, f.chats)) return { folder: f.folders[0] };
  if (only(f.chats, f.paths, f.folders)) return { chatId: f.chats[0] };
  return {};
}

/** The subset of an entry's files the scope selects, or null when out of scope.
 *  A chat match selects the whole entry; a path/folder match NARROWS the entry
 *  to the matching files — the entry must only represent files the reviewer
 *  selected, or Keep/Undo would act on paths the filtered view never showed. */
function scopedFilePaths(entry: ChangeEntry, f: ReviewFilter): string[] | null {
  if (f.paths.length === 0 && f.folders.length === 0 && f.chats.length === 0) return entry.filePaths;
  if (f.chats.some((c) => entry.chatId === c)) return entry.filePaths;
  const matched = entry.filePaths.filter(
    (p) => f.paths.includes(p) || f.folders.some((fd) => p === fd || p.startsWith(norm(fd))),
  );
  return matched.length > 0 ? matched : null;
}

export function whenMatches(at: string | null, when: WhenFilter, now: number): boolean {
  if (when.kind === 'any') return true;
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return false;
  if (when.kind === 'preset') {
    const span = when.value === 'today' ? DAY_MS : when.value === 'week' ? 7 * DAY_MS : 30 * DAY_MS;
    return now - t <= span;
  }
  const from = when.from ? Date.parse(when.from) : -Infinity;
  // `to` is inclusive of the whole day.
  const to = when.to ? Date.parse(when.to) + DAY_MS : Infinity;
  return t >= from && t < to;
}

/** Apply every active axis to the fetched entries (server already pre-narrowed
 *  by `bestServerScope` when possible — the redundant checks are no-ops then).
 *  Entries kept under a path/folder filter are narrowed to their in-scope files. */
export function filterEntries(
  entries: readonly ChangeEntry[],
  f: ReviewFilter,
  opts: { now: number; isCheckpoint: (docEditId: number) => boolean },
): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  for (const entry of entries) {
    const paths = scopedFilePaths(entry, f);
    if (!paths) continue;
    // The author axis is ONE union (kinds + specific people): "Sunny" + "Me"
    // means either, not an impossible both — an entry has a single author. AND
    // still applies across the other axes (scope, when, checkpoints).
    const authorSelected = f.authorKinds.length > 0 || f.authorIds.length > 0;
    if (authorSelected && !f.authorKinds.includes(entry.author.kind) && !f.authorIds.includes(entry.author.id ?? '')) continue;
    if (!whenMatches(entry.createdAt, f.when, opts.now)) continue;
    if (f.checkpointsOnly && !opts.isCheckpoint(entry.docEditId)) continue;
    // Recompute the state over the KEPT files whenever they're all resolved —
    // a fully-resolved file on its own is reviewed history, not a phantom
    // pending suggestion (Keep/Undo would no-op on it). This must run even when
    // no narrowing happened HERE: an entry can arrive already narrowed (the
    // leftover a local Keep/Undo resolution leaves after acting on the live
    // sibling), and skipping it would resurface the leftover as pending once
    // the path filter clears.
    const resolved = entry.resolvedFilePaths;
    const lifted =
      entry.editMode === 'suggest' &&
      (entry.reviewState === 'pending' || entry.reviewState === 'partial') &&
      resolved != null &&
      paths.length > 0 &&
      paths.every((p) => resolved.includes(p));
    if (paths === entry.filePaths && !lifted) {
      out.push(entry);
      continue;
    }
    out.push({
      ...entry,
      filePaths: paths,
      editedFileCount: paths.length,
      ...(lifted ? { reviewState: 'reviewed' as const } : null),
      ...(resolved ? { resolvedFilePaths: resolved.filter((p) => paths.includes(p)) } : null),
    });
  }
  return out;
}

/** Every ancestor folder present in a file list, sorted — for the Folders picker. */
export function deriveFolders(paths: readonly string[]): string[] {
  const set = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) set.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...set].sort();
}

const WHEN_LABEL: Record<'today' | 'week' | 'month', string> = { today: 'today', week: 'this week', month: 'this month' };

function whenSummary(when: WhenFilter): string | null {
  if (when.kind === 'any') return null;
  if (when.kind === 'preset') return WHEN_LABEL[when.value];
  if (!when.from && !when.to) return null;
  return `${when.from ?? '…'} – ${when.to ?? 'now'}`;
}

/**
 * The filter as a plain-English clause for the panel header
 * ("Review <this> from … to …"). Names are resolved by the caller.
 */
export function summarizeFilter(
  f: ReviewFilter,
  opts: {
    chatName?: (id: string) => string;
    authorName?: (id: string) => string;
    authorKindLabel?: (kind: ChangeAuthorKind) => string;
  } = {},
): string {
  const scope = [
    ...f.paths,
    ...f.folders,
    ...f.chats.map((c) => opts.chatName?.(c) ?? c),
  ];
  // All three author kinds = everyone → no "by" clause; otherwise a clean list
  // ("a", "a and b", "a, b, and c") rather than stacked "&"s.
  const allKinds = f.authorKinds.length === 3 && f.authorIds.length === 0;
  const who = allKinds
    ? []
    : [
        ...f.authorKinds.map((k) => opts.authorKindLabel?.(k) ?? k),
        ...f.authorIds.map((id) => opts.authorName?.(id) ?? id),
      ];
  let out = scope.length ? scope.join(', ') : 'all changes';
  if (who.length) out += ` by ${who.join(', ')}`;
  const when = whenSummary(f.when);
  if (when) out += ` ${when}`;
  if (f.checkpointsOnly) out += ' · checkpoints';
  return out;
}
