import { Extension, getChangedRanges, type Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
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
  shouldRender: (state: EditorState, pos: number, node: Node) => boolean;
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
  const { regex, katexOptions, editor, shouldRender } = options;
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

        newState.doc.nodesBetween(minFrom, maxTo, (node, pos) => {
          if (!node.isText || !node.text || !shouldRender(newState, pos, node)) return;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(node.text))) {
            const from = pos + match.index;
            const to = from + match[0].length;
            const content = match.slice(1).find(Boolean);
            if (!content) continue;

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

const defaultShouldRender = (state: EditorState, pos: number) =>
  state.doc.resolve(pos).parent.type.name !== 'codeBlock';

export const Mathematics = Extension.create<MathematicsOptions>({
  name: 'Mathematics',
  addOptions() {
    return {
      regex: /\$([^$]*)\$/gi,
      katexOptions: undefined,
      shouldRender: defaultShouldRender,
    };
  },
  addProseMirrorPlugins() {
    return [MathematicsPlugin({ ...this.options, editor: this.editor })];
  },
});

export default Mathematics;
