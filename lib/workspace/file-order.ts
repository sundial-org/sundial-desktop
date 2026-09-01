// Manual sidebar ordering (Obsidian-style drag-to-reorder). Shared workspace
// state, not a per-device layout pref: it persists on the workspace (cloud
// `projects.file_order`, or the sidecar's settings row for a local project)
// so collaborators and your other devices see the tree you arranged.
// localStorage keeps a per-device cache so the tree paints in the arranged
// order before the server payload lands; the shared copy wins once it does.
// Writing it is a workspace-wide capability: a path-share guest can drag
// inside an edit-granted subtree (the rows are draggable per path), but the
// server refuses the write and their optimistic order reverts on the next
// load — a subtree view must not rearrange the tree for everyone else.
//
// Each parent folder (`__root__` for the top level) maps to its children's
// basenames in display order; names missing from the list (new files,
// renames) keep their alphabetical position after the ordered ones, and stale
// names are dropped whenever the parent's order is rewritten.
export type FileOrderMap = Record<string, string[]>;

export const ROOT_ORDER_KEY = '__root__';

// Bounds for the stored map. It round-trips through user-writable JSON on
// both lanes, so the parser — not just the writer — caps it.
const MAX_PARENTS = 2_000;
const MAX_NAMES_PER_PARENT = 10_000;
const MAX_NAME_LENGTH = 1_024;

/** Coerce untrusted JSON (localStorage, request body, jsonb column) into a
 *  FileOrderMap, dropping anything malformed rather than throwing. */
export function sanitizeFileOrder(value: unknown): FileOrderMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: [string, string[]][] = [];
  for (const [parent, names] of Object.entries(value as Record<string, unknown>)) {
    if (entries.length >= MAX_PARENTS) break;
    if (!Array.isArray(names)) continue;
    const clean = names.filter(
      (name): name is string => typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LENGTH,
    );
    if (clean.length) entries.push([parent, clean.slice(0, MAX_NAMES_PER_PARENT)]);
  }
  return Object.fromEntries(entries);
}

const storageKey = (projectId: string) => `sundial:file-order:${projectId}`;

export function readFileOrder(projectId: string): FileOrderMap {
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    return sanitizeFileOrder(raw ? (JSON.parse(raw) as unknown) : null);
  } catch {
    return {};
  }
}

export function writeFileOrder(projectId: string, map: FileOrderMap) {
  try {
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(map));
  } catch {
    /* private mode / storage full — order just won't persist */
  }
}

/** Sort `items` by their name's position in `order`; unordered items keep
 *  their incoming (alphabetical) relative order, after the ordered ones. */
export function sortByManualOrder<T>(
  items: T[],
  nameOf: (item: T) => string,
  order: string[] | undefined,
): T[] {
  if (!order?.length) return items;
  const position = new Map(order.map((name, index) => [name, index]));
  return items
    .map((item, index) => ({ item, index, pos: position.get(nameOf(item)) ?? Infinity }))
    .sort((a, b) => a.pos - b.pos || a.index - b.index)
    .map((entry) => entry.item);
}

/** Value equality — lets a poll skip `setState` when the server's order
 *  matches what's rendered, so the tree's memos don't churn every cycle. */
export function sameFileOrder(a: FileOrderMap, b: FileOrderMap): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => b[key]?.length === a[key].length && a[key].every((name, i) => name === b[key][i]))
  );
}

/** Apply one parent's new child order onto the stored map. Writes are scoped
 *  to a single parent so two people arranging different folders at the same
 *  time don't clobber each other; the loser of a same-folder race just drags
 *  again. An empty list clears the parent back to alphabetical. */
export function mergeParentOrder(map: FileOrderMap, parent: string, names: string[]): FileOrderMap {
  const next = { ...map };
  if (names.length) next[parent] = names;
  else delete next[parent];
  return sanitizeFileOrder(next);
}

/** New order for a parent after dragging `draggedNames` next to `targetName`.
 *  `displayedNames` is the parent's full child list in current display order. */
export function computeReorder(
  displayedNames: string[],
  draggedNames: string[],
  targetName: string,
  position: 'before' | 'after',
): string[] {
  const dragged = new Set(draggedNames);
  const rest = displayedNames.filter((name) => !dragged.has(name));
  const kept = displayedNames.filter((name) => dragged.has(name));
  const anchor = rest.indexOf(targetName);
  if (anchor === -1) return displayedNames;
  rest.splice(anchor + (position === 'after' ? 1 : 0), 0, ...kept);
  return rest;
}
