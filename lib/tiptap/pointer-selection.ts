import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { ResolvedPos } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { LEAF_PLACEHOLDER, wordBoundsAt } from '@/lib/workspace/doc-comments-client';

/* ── Deterministic double / triple click selection ──────────────────────
 *  ProseMirror ships NO default double-click handler (prosemirror-view's
 *  `handleDoubleClick` only consults plugin props), so the word a double-click
 *  selects is 100% the ENGINE's native expansion, read back off the DOM. And
 *  its `defaultTripleClick` bails when the click resolves to a doc-level
 *  position — `posAtCoords().inside === -1`, which is every click that lands in
 *  a block MARGIN, the gap between two paragraphs, or the editor's padding — so
 *  that gesture falls through to the engine un-prevented too.
 *
 *  That hands two very common gestures to native behaviour we don't control,
 *  and WebKit (Safari, and every WKWebView — i.e. the desktop shell) expands a
 *  double-click that doesn't land squarely on a text run to the whole editable
 *  root: the reported "double-clicking a paragraph sometimes selects the entire
 *  page", where "sometimes" is which pixel the pointer happened to hit.
 *
 *  So: own both gestures inside text blocks. A double-click selects exactly the
 *  word under the pointer (`wordBoundsAt` — ICU segmentation, the same notion of
 *  word the engines use, shared with the right-click affordance); off a word it
 *  drops a caret at the click. A triple-click selects exactly the clicked text
 *  block. Returning true makes prosemirror-view preventDefault the mousedown, so
 *  the native expansion never runs and the result can't depend on the engine.
 *
 *  Scope is deliberately narrow — this only claims the gesture when it resolves
 *  into a TEXT BLOCK. Atoms (images, horizontal rules) keep ProseMirror's own
 *  node-selection behaviour, and `handleDoubleClickOn` props (which
 *  prosemirror-view runs FIRST) still win, so per-node affordances are
 *  untouched. Triple-click still defers to `defaultTripleClick` for the clicks
 *  that land INSIDE a text block, keeping its triple-click-and-drag extension.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * The text block the pointer resolved into, or null when the gesture isn't ours.
 *
 * A click on an ATOM (a block image, a horizontal rule) keeps ProseMirror's own
 * node-selection behaviour. Everything else snaps to the nearest text block —
 * including clicks that resolve to a doc-level position (`inside === -1`: block
 * margins, the gap between paragraphs, the editor's padding) and clicks inside a
 * container that isn't itself a text block (a list's own box, a blockquote's
 * padding). Those are exactly the points the engine mishandles, so they must not
 * be handed back.
 */
function textblockAt(state: EditorState, pos: number, inside: number): ResolvedPos | null {
  const $pos = state.doc.resolve(pos);
  if ($pos.parent.isTextblock) return $pos;
  if (inside !== -1 && state.doc.nodeAt(inside)?.isAtom) return null;
  const near = TextSelection.near($pos);
  return near instanceof TextSelection && near.$from.parent.isTextblock ? near.$from : null;
}

/** ProseMirror hands click props the position but not the `inside` it computed
 *  alongside it, so re-run the (cheap, cached-layout) hit test. */
function insideAt(view: EditorView, event: MouseEvent): number | null {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  return at ? at.inside : null;
}

function selectRange(view: EditorView, from: number, to: number) {
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, from, to))
      .setMeta('pointer', true),
  );
}

export const PointerSelection = Extension.create({
  name: 'pointerSelection',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('pointerSelection'),
        props: {
          handleDoubleClick(view, pos, event) {
            if ((event as MouseEvent).button !== 0) return false;
            // A failed re-hit-test falls back to the doc-level branch: shaky
            // hit-testing is precisely when the engine must not take over.
            const $pos = textblockAt(view.state, pos, insideAt(view, event as MouseEvent) ?? -1);
            if (!$pos) return false;
            const start = $pos.start();
            // Scan in document-position space: inline leaf nodes (hard breaks,
            // inline atoms) become one placeholder char each, so string indices
            // map 1:1 onto positions and the range is always valid.
            const text = view.state.doc.textBetween($pos.start(), $pos.end(), LEAF_PLACEHOLDER, LEAF_PLACEHOLDER);
            const bounds = wordBoundsAt(text, $pos.parentOffset);
            // Off a word (whitespace, punctuation, an atom, an empty block):
            // collapse to a caret at the click. Always DISPATCH, never just
            // return true on the existing selection — claiming the gesture
            // preventDefaults the mousedown, which leaves the DOM selection
            // where the engine last put it, and ProseMirror's async
            // selectionchange read would then clobber a following triple-click.
            selectRange(
              view,
              bounds ? start + bounds.start : $pos.pos,
              bounds ? start + bounds.end : $pos.pos,
            );
            return true;
          },

          handleTripleClick(view, pos, event) {
            if ((event as MouseEvent).button !== 0) return false;
            // `defaultTripleClick` walks OUTWARD from `inside` and takes the
            // first node it can select. Its FIRST step — the node AT `inside` —
            // is the clicked text block exactly when the click resolved into
            // one; that case is correct, and deferring keeps its
            // triple-click-and-drag paragraph extension. Every later step runs
            // PAST the text blocks and node-selects the CONTAINER instead: a
            // click on a list's own box (the ~1.6px seam between two items,
            // which the engine attributes to the <ul> itself) then selected the
            // WHOLE list, both items. Everything but that first step is ours.
            const inside = insideAt(view, event as MouseEvent) ?? -1;
            const at = inside === -1 ? null : view.state.doc.resolve(inside).nodeAfter;
            if (at?.inlineContent) return false;
            const $pos = textblockAt(view.state, pos, inside);
            if (!$pos) return false;
            selectRange(view, $pos.start(), $pos.end());
            return true;
          },
        },
      }),
    ];
  },
});
