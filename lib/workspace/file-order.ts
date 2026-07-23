// Manual sidebar ordering (Obsidian-style drag-to-reorder), per workspace and
// per device like the other `sundial:*` layout prefs. Each parent folder
// (`__root__` for the top level) maps to its children's basenames in display
// order; names missing from the list (new files, renames) keep their
// alphabetical position after the ordered ones, and stale names are dropped
// whenever the parent's order is rewritten.
export type FileOrderMap = Record<string, string[]>;

export const ROOT_ORDER_KEY = '__root__';

const storageKey = (projectId: string) => `sundial:file-order:${projectId}`;

export function readFileOrder(projectId: string): FileOrderMap {
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, names]) => Array.isArray(names) && names.every((name) => typeof name === 'string'),
      ),
    ) as FileOrderMap;
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
