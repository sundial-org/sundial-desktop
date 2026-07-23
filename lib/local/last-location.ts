'use client';

/** Where the create/clone dialogs' Location field starts: the folder the user
 *  last created into, else the parent of their most recent project, else the
 *  sidecar's suggested default — always pre-filled, never left to a
 *  placeholder the user has to retype. */

const KEY = 'sundial:last-project-location';

export function parentDirOf(root: string | null | undefined): string | null {
  if (!root) return null;
  const cut = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'));
  return cut > 0 ? root.slice(0, cut) : null;
}

export function readLastProjectLocation(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveLastProjectLocation(location: string): void {
  try {
    localStorage.setItem(KEY, location);
  } catch {
    /* private mode — next open falls back to recents/sidecar default */
  }
}
