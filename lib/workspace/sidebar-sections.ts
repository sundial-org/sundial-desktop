/**
 * Project-sidebar section model (workspace-v4 §4, stacked revision).
 *
 * The sidebar is one stacked column — Files, then Chats, then Tasks/Sync when
 * available — always rendered in `SIDEBAR_SECTION_ORDER` (PR #907 wireframe:
 * files and chats share the rail). There is no section picker and no presence
 * toggling; the only per-section state is **collapse** (minimized to its
 * header). `sidebarSections` stores the collapse bits; a section missing from
 * the array uses its default. Helpers never mutate their input.
 */

export type SidebarSection = 'files' | 'chats' | 'tasks' | 'sync';

/** A section's stored collapse state. */
export type SidebarSectionState = { id: SidebarSection; collapsed: boolean };

/** Canonical top-to-bottom order of the stacked sections. */
export const SIDEBAR_SECTION_ORDER: readonly SidebarSection[] = [
  'files',
  'chats',
  'tasks',
  'sync',
];

/** Sync starts minimized so the rail leads with files + chats. */
const DEFAULT_COLLAPSED: Record<SidebarSection, boolean> = {
  files: false,
  chats: false,
  tasks: false,
  sync: true,
};

export const DEFAULT_SIDEBAR_SECTIONS: readonly SidebarSectionState[] =
  SIDEBAR_SECTION_ORDER.map((id) => ({ id, collapsed: DEFAULT_COLLAPSED[id] }));

function isSidebarSection(value: unknown): value is SidebarSection {
  return typeof value === 'string' && SIDEBAR_SECTION_ORDER.includes(value as SidebarSection);
}

function sortCanonical(sections: SidebarSectionState[]): SidebarSectionState[] {
  return [...sections].sort(
    (a, b) => SIDEBAR_SECTION_ORDER.indexOf(a.id) - SIDEBAR_SECTION_ORDER.indexOf(b.id),
  );
}

export function isSectionCollapsed(
  sections: readonly SidebarSectionState[],
  id: SidebarSection,
): boolean {
  return sections.find((section) => section.id === id)?.collapsed ?? DEFAULT_COLLAPSED[id];
}

function setSectionCollapsed(
  sections: readonly SidebarSectionState[],
  id: SidebarSection,
  collapsed: boolean,
): SidebarSectionState[] {
  const rest = sections.filter((section) => section.id !== id);
  return sortCanonical([...rest, { id, collapsed }]);
}

/** Minimize/maximize a section (the header toggle). */
export function toggleSectionCollapsed(
  sections: readonly SidebarSectionState[],
  id: SidebarSection,
): SidebarSectionState[] {
  return setSectionCollapsed(sections, id, !isSectionCollapsed(sections, id));
}

/**
 * Ensure a section is expanded — used when a deep action targets it (open a
 * file → Files, select a commit → Sync). Other sections are untouched.
 */
export function expandSection(
  sections: readonly SidebarSectionState[],
  id: SidebarSection,
): SidebarSectionState[] {
  return setSectionCollapsed(sections, id, false);
}

/**
 * Validate restored state: keep only known ids, de-dupe, coerce `collapsed` to
 * a boolean, fill missing sections with their defaults, and canonicalize
 * order. Returns null when there's nothing usable, so the caller can fall
 * back to defaults. Legacy single-select layouts (e.g. `[{id:'chats'}]`)
 * restore as the full stack with only their stored collapse bits applied.
 */
export function normalizeSidebarSections(raw: unknown): SidebarSectionState[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Map<SidebarSection, boolean>();
  for (const entry of raw) {
    const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : entry;
    if (!isSidebarSection(id) || seen.has(id)) continue;
    const collapsed =
      entry && typeof entry === 'object'
        ? Boolean((entry as { collapsed?: unknown }).collapsed)
        : false;
    seen.set(id, collapsed);
  }
  if (seen.size === 0) return null;
  return SIDEBAR_SECTION_ORDER.map((id) => ({
    id,
    // Files always restores expanded: its header has no collapse toggle, so a
    // persisted collapsed:true would strand the tree with no way back.
    collapsed: id === 'files' ? false : (seen.get(id) ?? DEFAULT_COLLAPSED[id]),
  }));
}
