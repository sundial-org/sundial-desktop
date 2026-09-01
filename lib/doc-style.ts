// Markdown document style: 'docs' draws the page as a white card floating on
// a gray desk with symmetric page margins (the pre-wireframe-redesign Google
// Docs look); 'obsidian' renders the document flat on the panel — the IDE
// surface, and the default every arrival gets (founder, 2026-08-12). Nothing
// infers it; the key is written only when someone switches, from the document
// ⋯ menu or Settings → Appearance, and that stored choice then always wins.
// Per-device, like the other `sundial:*` UI prefs (see lib/theme.ts).
import { useSyncExternalStore } from 'react';

export type DocStyle = 'docs' | 'obsidian';

export const DOC_STYLE_STORAGE_KEY = 'sundial:doc-style';

// Fired on window by `setDocStylePreference` so mounted editors restyle live
// the moment the menu item is clicked (the `storage` event only covers other
// tabs).
export const DOC_STYLE_CHANGE_EVENT = 'sundial:doc-style-change';

export function getDocStylePreference(): DocStyle {
  if (typeof window === 'undefined') return 'obsidian';
  try {
    return window.localStorage.getItem(DOC_STYLE_STORAGE_KEY) === 'docs' ? 'docs' : 'obsidian';
  } catch {
    return 'obsidian';
  }
}

export function setDocStylePreference(style: DocStyle) {
  try {
    window.localStorage.setItem(DOC_STYLE_STORAGE_KEY, style);
  } catch {}
  window.dispatchEvent(new Event(DOC_STYLE_CHANGE_EVENT));
}

function subscribeDocStyle(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === DOC_STYLE_STORAGE_KEY) callback();
  };
  window.addEventListener(DOC_STYLE_CHANGE_EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(DOC_STYLE_CHANGE_EVENT, callback);
    window.removeEventListener('storage', onStorage);
  };
}

/** Live doc-style preference. useSyncExternalStore so EVERY consumer reads the
 *  same snapshot in the same render pass — the previous per-component
 *  useState + mount-effect version let the shell, frame, and toolbar disagree
 *  for a frame (Docs header missing / IDE controls flashing). SSR/hydration
 *  stay deterministic via the 'obsidian' server snapshot. */
export function useDocStyle(): DocStyle {
  return useSyncExternalStore(subscribeDocStyle, getDocStylePreference, () => 'obsidian');
}
