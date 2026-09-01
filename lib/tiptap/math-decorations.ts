import { Extension, getChangedRanges, InputRule, type Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import katex, { type KatexOptions } from 'katex';

/**
 * Decoration-based KaTeX rendering, vendored from `@tiptap/extension-mathematics`
 * v2 (MIT) and ported to Tiptap v3 core. Tiptap v3's own mathematics extension
 * rewrote math into `inlineMath`/`blockMath` *nodes*; Sundial keeps math as plain
 * `$…$` / `$$…$$` *text* in the Y.Doc (see lib/markdown/parser.mjs) so the
 * markdown round-trip is trivial and lossless. This extension only paints KaTeX
 * decorations over that text — it never mutates the document — so the codec and
 * serialization are untouched by the v3 upgrade. Class names are unchanged so the
 * existing `.Tiptap-mathematics-*` CSS still applies.
 */

export type MathematicsOptions = {
  regex: RegExp;
  katexOptions?: KatexOptions;
  /** Per text node. `parent` is the containing block (nodesBetween provides
   *  it) — use it instead of `state.doc.resolve(pos)`: a resolve is O(doc)
   *  and this runs for EVERY text node in the scanned range, which turned
   *  initial load of long documents O(n²) (multi-second freeze). */
  shouldRender: (state: EditorState, pos: number, node: Node, parent: Node | null) => boolean;
  // Optional per-MATCH veto (shouldRender is per text node, too coarse when a
  // node mixes render-worthy and veto-worthy spans). Used to keep KaTeX out of
  // `%%…%%` source comments, whose content must stay dimmed literal source.
  shouldRenderMatch?: (state: EditorState, from: number, to: number) => boolean;
};

/**
 * The canonical single-line math matcher: `$$inline$$` first (alternation
 * tries left), then `$…$`. Multi-line block math isn't matched (text nodes
 * don't span paragraphs). Shared by the editor's Mathematics config and the
 * slash menu's "don't open inside an equation" check — one source of truth
 * for "what counts as math text".
 */
export const MATH_TEXT_REGEX = /\$\$([^\$\n]+?)\$\$|(?<!\\)\$(?!\s)([^\$\n]+?)(?<!\s)\$(?!\d)/g;

type PluginState = { decorations: DecorationSet | undefined; isEditable: boolean | undefined };

// The range of positions a transaction may have changed — over-scanned by one
// position on each side so decorations straddling the edit are caught.
function getAffectedRange(
  newState: EditorState,
  previous: PluginState,
  isEditable: boolean,
  tr: Transaction,
  state: EditorState,
) {
  const docSize = newState.doc.nodeSize - 2;
  let minFrom = 0;
  let maxTo = docSize;
  if (previous.isEditable !== isEditable) {
    minFrom = 0;
    maxTo = docSize;
  } else if (tr.docChanged) {
    minFrom = docSize;
    maxTo = 0;
    getChangedRanges(tr).forEach((range) => {
      minFrom = Math.min(minFrom, range.newRange.from - 1, range.oldRange.from - 1);
      maxTo = Math.max(maxTo, range.newRange.to + 1, range.oldRange.to + 1);
    });
    // Widen to the containing textblocks. A match's render decision can depend
    // on text OUTSIDE its own node — `shouldRenderMatch` vetoes math inside a
    // `%%…%%` source comment — so completing or deleting a delimiter in
    // another text node (or across a hard break) has to re-evaluate this
    // block's math, or a stale KaTeX widget survives inside the new comment.
    // Rescanning a whole block can only recompute the same decorations.
    const clamp = (pos: number) => Math.max(0, Math.min(pos, docSize));
    const $min = newState.doc.resolve(clamp(minFrom));
    const $max = newState.doc.resolve(clamp(maxTo));
    minFrom = Math.min(minFrom, $min.depth === 0 ? 0 : $min.before());
    maxTo = Math.max(maxTo, $max.depth === 0 ? docSize : $max.after());
  } else if (tr.selectionSet) {
    const { $from, $to } = state.selection;
    const { $from: $newFrom, $to: $newTo } = newState.selection;
    minFrom = Math.min(
      $from.depth === 0 ? 0 : $from.before(),
      $newFrom.depth === 0 ? 0 : $newFrom.before(),
    );
    maxTo = Math.max(
      $to.depth === 0 ? maxTo : $to.after(),
      $newTo.depth === 0 ? maxTo : $newTo.after(),
    );
  }
  return { minFrom: Math.max(minFrom, 0), maxTo: Math.min(maxTo, docSize) };
}

const MathematicsPlugin = (options: MathematicsOptions & { editor: Editor }) => {
  const { regex, katexOptions, editor, shouldRender, shouldRenderMatch } = options;
  return new Plugin<PluginState>({
    key: new PluginKey('mathematics'),
    state: {
      init() {
        return { decorations: undefined, isEditable: undefined };
      },
      apply(tr, previous, state, newState) {
        const isEditable = editor.isEditable;
        // Recompute on doc/selection change OR when editability flips (the latter
        // changes whether the source is hidden behind the KaTeX preview). The
        // editability flip is driven into a transaction by the plugin view below,
        // since setEditable() alone doesn't dispatch one.
        if (
          !tr.docChanged &&
          !tr.selectionSet &&
          previous.decorations &&
          previous.isEditable === isEditable
        ) {
          return previous;
        }

        const mapped = (previous.decorations || DecorationSet.empty).map(tr.mapping, tr.doc);
        const { selection } = newState;
        const toAdd: Decoration[] = [];
        let { minFrom, maxTo } = getAffectedRange(newState, previous, isEditable, tr, state);
        // Expand the window to the full extent of any decoration overlapping it, so
        // breaking a delimiter at the END of `$a^2$` also re-evaluates the KaTeX
        // widget anchored at its START (outside the raw changed range). The inline
        // decoration spans the whole match, so intersecting it pulls the widget in.
        mapped.find(minFrom, maxTo).forEach((deco) => {
          minFrom = Math.min(minFrom, deco.from);
          maxTo = Math.max(maxTo, deco.to);
        });

        newState.doc.nodesBetween(minFrom, maxTo, (node, pos, parent) => {
          if (!node.isText || !node.text || !shouldRender(newState, pos, node, parent)) return;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(node.text))) {
            const from = pos + match.index;
            const to = from + match[0].length;
            const content = match.slice(1).find(Boolean);
            if (!content) continue;
            if (shouldRenderMatch && !shouldRenderMatch(newState, from, to)) continue;

            // "Editing" — the caret sits inside this span (or a range selects
            // within it), so show the raw `$…$` source instead of the preview.
            // Scoped to THIS match's [from, to], so clicking one math never
            // un-renders the others in the same paragraph.
            const selectionSize = selection.from - selection.to;
            const anchorIsInside = selection.anchor >= from && selection.anchor <= to;
            const rangeIsInside = selection.from >= from && selection.to <= to;
            const isEditing = (selectionSize === 0 && anchorIsInside) || rangeIsInside;

            toAdd.push(
              Decoration.inline(from, to, {
                class:
                  isEditing && isEditable
                    ? 'Tiptap-mathematics-editor'
                    : 'Tiptap-mathematics-editor Tiptap-mathematics-editor--hidden',
                style:
                  !isEditing || !isEditable
                    ? 'display: inline-block; height: 0; opacity: 0; overflow: hidden; position: absolute; width: 0;'
                    : undefined,
              }),
            );

            if (!isEditable || !isEditing) {
              toAdd.push(
                Decoration.widget(
                  from,
                  () => {
                    const element = document.createElement('span');
                    element.classList.add('Tiptap-mathematics-render');
                    if (isEditable) element.classList.add('Tiptap-mathematics-render--editable');
                    try {
                      katex.render(content, element, katexOptions);
                    } catch {
                      element.innerHTML = content;
                    }
                    return element;
                  },
                  // Stable key so ProseMirror reuses the KaTeX DOM across recomputes
                  // for unchanged math (same position + content) — without it, a
                  // cursor move near a span would destroy and recreate every widget
                  // in the range, which reads as flicker.
                  { key: `math:${from}:${content}` },
                ),
              );
            }
          }
        });

        // Rebuild the (expanded) affected range: drop every existing decoration in
        // it, then add the freshly scanned matches. `remove` matches structurally
        // (by position), so a stale decoration left by a broken delimiter is
        // dropped; unchanged widgets keep their DOM via the stable key above.
        const decorations = mapped.remove(mapped.find(minFrom, maxTo)).add(tr.doc, toAdd);
        return {
          decorations,
          isEditable,
        };
      },
    },
    // setEditable() reconfigures the view without dispatching a transaction, so
    // the apply() above never runs and math would keep its stale edit/view
    // styling (e.g. raw `$…$` source left showing in view mode). Nudge an empty
    // transaction on the flip; apply() then recomputes via the isEditable guard.
    // Idempotent — only fires when editability actually changed.
    view() {
      let lastEditable = editor.isEditable;
      return {
        update: (view) => {
          if (view.editable !== lastEditable) {
            lastEditable = view.editable;
            view.dispatch(view.state.tr);
          }
        },
      };
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
};

const defaultShouldRender = (state: EditorState, pos: number, node: Node, parent: Node | null) =>
  parent?.type.name !== 'codeBlock';

/** How far back the close-of-block rule searches for its opener — keeps the
 *  rule O(1) per keystroke (typed display math is short). */
const BLOCK_MATH_OPENER_SCAN = 40;

/**
 * Typing the closing `$$` of a multi-line display block collapses the block to
 * its single-line `$$…$$` form — the same normalization the markdown importer
 * applies (lib/markdown/parser.mjs: the newlines between `$$` delimiters are
 * insignificant, so they join as spaces). Text nodes can't span paragraphs, so
 * without this a block typed as `$$` ⏎ latex ⏎ `$$` never matches the
 * decoration regex and stays raw source — the importer-collapsed form renders.
 */
const blockMathCollapseRule = () =>
  new InputRule({
    find: /^\$\$$/,
    handler: ({ state, range }) => {
      const $close = state.doc.resolve(range.from);
      if ($close.depth === 0 || $close.parent.type.name !== 'paragraph') return null;
      const container = $close.node(-1);
      const closeIndex = $close.index(-1);
      // Walk up the siblings for the opener: a paragraph starting with `$$`
      // and not closed on its own line (the importer's opening condition).
      // Anything that isn't plain math-body text — a non-paragraph block, or a
      // line with its own `$$` — ends the search: there is no open block here.
      let openerIndex = -1;
      const innerLines: string[] = [];
      for (let i = closeIndex - 1; i >= 0 && closeIndex - i <= BLOCK_MATH_OPENER_SCAN; i -= 1) {
        const sibling = container.child(i);
        if (sibling.type.name !== 'paragraph') break;
        const text = sibling.textContent;
        if (text.startsWith('$$') && text.indexOf('$$', 2) === -1) {
          openerIndex = i;
          innerLines.unshift(text.slice(2));
          break;
        }
        if (text.includes('$$')) break;
        innerLines.unshift(text);
      }
      if (openerIndex === -1) return null; // no open block — leave the `$$` as typed
      const inner = innerLines.map((line) => line.trim()).filter(Boolean).join(' ');
      if (!inner) return null; // an empty block has nothing to render
      const openerFrom = $close.posAtIndex(openerIndex, -1);
      const closeEnd = $close.after();
      const collapsed = `$$${inner}$$`;
      const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(collapsed));
      state.tr
        .replaceWith(openerFrom, closeEnd, paragraph)
        .setSelection(TextSelection.create(state.tr.doc, openerFrom + 1 + collapsed.length));
    },
  });

export const Mathematics = Extension.create<MathematicsOptions>({
  name: 'Mathematics',
  addOptions() {
    return {
      regex: /\$([^$]*)\$/gi,
      katexOptions: undefined,
      shouldRender: defaultShouldRender,
      shouldRenderMatch: undefined,
    };
  },
  addInputRules() {
    return [blockMathCollapseRule()];
  },
  addProseMirrorPlugins() {
    return [MathematicsPlugin({ ...this.options, editor: this.editor })];
  },
});

export default Mathematics;
