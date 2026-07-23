/**
 * Scroll-position preservation across view swaps whose content height differs
 * (e.g. rendered markdown ↔ raw source). Preserving raw `scrollTop` pixels would
 * drift because the two views have different total heights, so we preserve the
 * *fraction* of the scroll range instead — the reading position stays put.
 */

/** Current scroll position as a 0..1 fraction of the scrollable range. */
export function scrollFraction(el: HTMLElement): number {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return 0;
  return clamp01(el.scrollTop / max);
}

/** Apply a 0..1 fraction back onto an element's scrollable range. */
export function applyScrollFraction(el: HTMLElement, fraction: number): void {
  const max = el.scrollHeight - el.clientHeight;
  el.scrollTop = max <= 0 ? 0 : clamp01(fraction) * max;
}

/** Minimal element surface {@link restoreScrollFraction} needs — lets tests
 *  drive it with a plain object instead of a real DOM node. */
export interface ScrollTarget {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  addEventListener(type: string, listener: () => void, options?: unknown): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Restore a scroll fraction across a view swap whose destination both expands
 * *asynchronously* and *resets scrollTop to 0 at an unpredictable moment* — e.g.
 * toggling back to the rendered markdown view: the ProseMirror editor re-lays out
 * over several frames after being un-`display:none`d (scroll range starts at 0, so
 * a one-shot apply lands at the top), and when it regains visibility it scrolls its
 * focused selection into view, yanking the container back to the top tens to
 * hundreds of ms later. Settling once the height stops changing loses that race, so
 * we simply re-assert the fraction every animation frame for a short window
 * (`maxFrames` ≈ 0.8s), overriding both the empty-range apply and the late reset.
 * Any real user scroll input on the container cancels the loop immediately so we
 * never fight the reader. Returns a cleanup function (call on unmount / retoggle).
 */
export function restoreScrollFraction(
  el: ScrollTarget,
  fraction: number,
  raf: (cb: () => void) => number = requestAnimationFrame,
  cancelRaf: (id: number) => void = cancelAnimationFrame,
  maxFrames = 48,
): () => void {
  let id = 0;
  let frame = 0;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    cancelRaf(id);
    for (const type of USER_SCROLL_EVENTS) el.removeEventListener(type, stop);
  };
  const tick = () => {
    if (done) return;
    applyScrollFraction(el as unknown as HTMLElement, fraction);
    if (++frame >= maxFrames) return stop();
    id = raf(tick);
  };
  for (const type of USER_SCROLL_EVENTS) {
    el.addEventListener(type, stop, { passive: true });
  }
  tick();
  return stop;
}

const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
