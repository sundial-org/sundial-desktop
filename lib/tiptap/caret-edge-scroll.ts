import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Line-by-line caret scrolling at the pane edge (the Obsidian behavior).
 *
 * Vertical arrow motion inside a text block is native browser behavior —
 * ProseMirror never dispatches a scrollIntoView for it — and Blink reveals a
 * caret that lands FULLY outside its scroll container by CENTERING it
 * ("center if needed", ~430px jumps measured on an 824px pane). A caret still
 * partially visible gets a small nearest-edge reveal, which is the smooth
 * behavior we want everywhere. There is no CSS control over the reveal
 * alignment, so instead: on a plain vertical arrow, remember the container's
 * scrollTop, and in a pre-paint rAF check how far the native reveal moved it.
 * A jump well beyond one line means Blink centered — clamp it back so the
 * caret sits one line inside the edge it crossed. The correction runs before
 * the frame paints, so the user only ever sees the clamped, line-by-line
 * scroll. The key event is never consumed and the selection change itself
 * stays fully native (wrapped lines, goal column, Shift-selection).
 */

/** Pure decision: given the native reveal's scroll jump and the caret's
 *  post-reveal position, how much to adjust scrollTop (0 = leave it alone).
 *  Exported for unit tests. */
export function edgeClampDelta(args: {
  down: boolean;
  /** scrollTop change the native reveal caused (signed). */
  jumped: number;
  caretTop: number;
  caretBottom: number;
  viewTop: number;
  viewBottom: number;
}): number {
  // Guard degenerate rects (collapsed coords during layout) with a floor.
  const line = Math.max(args.caretBottom - args.caretTop, 16);
  // Nearest-edge reveals move by roughly a line (tall blocks a bit more);
  // centering moves by ~half the pane. 3 lines cleanly separates the two.
  if (args.down) {
    if (args.jumped <= line * 3) return 0;
    // Centered — park the caret one line above the bottom edge instead.
    return args.caretBottom - (args.viewBottom - line);
  }
  if (-args.jumped <= line * 3) return 0;
  return args.caretTop - (args.viewTop + line);
}

function scrollableAncestor(dom: HTMLElement): HTMLElement | null {
  for (let el = dom.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

export const CaretEdgeScroll = Extension.create({
  name: 'caretEdgeScroll',

  addProseMirrorPlugins() {
    // Per-editor clamp state. Key repeat can deliver several keydowns per
    // frame; the first one's scrollTop is the true baseline, so a pending
    // clamp keeps its baseline instead of re-reading a mid-jump value.
    let rafId = 0;
    let baseline = 0;
    let down = true;

    const clamp = (view: EditorView, scroller: HTMLElement) => {
      rafId = 0;
      if (view.isDestroyed) return;
      let caret: { top: number; bottom: number };
      try {
        caret = view.coordsAtPos(view.state.selection.head);
      } catch {
        return;
      }
      const rect = scroller.getBoundingClientRect();
      const delta = edgeClampDelta({
        down,
        jumped: scroller.scrollTop - baseline,
        caretTop: caret.top,
        caretBottom: caret.bottom,
        viewTop: rect.top,
        viewBottom: rect.bottom,
      });
      if (delta !== 0) scroller.scrollTop += delta;
    };

    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            // Runs only if no earlier handler (link menu, slash menu, …)
            // consumed the key; never consumes the event itself.
            if (event.metaKey || event.ctrlKey || event.altKey) return false;
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
            const scroller = scrollableAncestor(view.dom);
            if (!scroller) return false;
            down = event.key === 'ArrowDown';
            if (rafId === 0) {
              baseline = scroller.scrollTop;
              rafId = requestAnimationFrame(() => clamp(view, scroller));
            }
            return false;
          },
        },
        view() {
          return {
            destroy() {
              if (rafId !== 0) {
                cancelAnimationFrame(rafId);
                rafId = 0;
              }
            },
          };
        },
      }),
    ];
  },
});
