'use client';

/** Which local projects this machine actually opened, and when. The sidecar
 *  orders /projects by created_at and never touches the row on re-open, so
 *  without this "recent" would mean "recently ADDED folder" — the one thing a
 *  launcher must not mean. Per-machine by design: it lives in localStorage. */

const KEY = 'sundial:local-recents';
/** Bounded so a long-lived install can't grow the entry without limit. */
const LIMIT = 50;

function read(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function markProjectOpened(id: string): void {
  try {
    const kept = Object.entries(read())
      .filter(([key]) => key !== id)
      .sort((a, b) => (a[1] < b[1] ? 1 : -1))
      .slice(0, LIMIT - 1);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([[id, new Date().toISOString()], ...kept])));
  } catch {
    /* private mode / no storage — the list just stays in created_at order */
  }
}

/** When this machine last opened the project, falling back to when the
 *  folder was added — the launcher row's date column. */
export function lastOpenedAt(id: string, createdAt: string): string {
  return read()[id] ?? createdAt;
}

/** Most recently opened first, falling back to when the folder was added. */
export function sortByRecency<T extends { id: string; created_at: string }>(projects: T[]): T[] {
  const recents = read();
  const openedAt = (project: T) => Date.parse(recents[project.id] ?? project.created_at) || 0;
  return [...projects].sort((a, b) => openedAt(b) - openedAt(a));
}
