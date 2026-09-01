'use client';

/* ── AI panel dock ────────────────────────────────────────────────────
 *  A single fixed right-side column (comments-style) that AI panels
 *  (factcheck, AI detection) portal into when the user docks them — out of
 *  the text's way, persistent across clicks into the doc, and stackable so
 *  several checks can be open at once. One container per window, created
 *  lazily; panels render into it with createPortal.
 * ─────────────────────────────────────────────────────────────────── */

const DOCK_ID = 'sd-ai-dock';

export function getAiDockContainer(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(DOCK_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = DOCK_ID;
    // pointer-events gymnastics: the empty column must never block clicks on
    // the doc beneath it; the panels themselves re-enable events.
    el.className =
      'fixed right-3 top-16 bottom-3 z-40 flex w-[400px] max-w-[calc(100vw-1.5rem)] flex-col gap-2 overflow-y-auto pointer-events-none';
    document.body.appendChild(el);
  }
  return el;
}

/** Per-tool docked preference. */
export function readDockPreference(tool: string): boolean {
  try {
    return window.localStorage.getItem(`sundial:ai-dock:${tool}`) === '1';
  } catch {
    return false;
  }
}

export function writeDockPreference(tool: string, docked: boolean): void {
  try {
    window.localStorage.setItem(`sundial:ai-dock:${tool}`, docked ? '1' : '0');
  } catch {
    // Best-effort persistence only.
  }
}
