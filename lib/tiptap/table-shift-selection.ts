import { Extension } from '@tiptap/core';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { ResolvedPos } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Shift-Arrow selection steps OVER a neighbouring table in one press.
 *
 * A text selection with one end outside a table and the other inside it is not
 * representable, so prosemirror-tables rewrites it: `normalizeSelection` throws
 * the selection away and keeps only the block at its lower end. Extending
 * upward out of the block BELOW a table therefore lost the user's anchor on the
 * second press, turned into a cell selection on the third, then produced a dead
 * press and a mid-word selection on the way out. The keyboard could not carry
 * a selection past a table at all.
 *
 * Selecting the whole table instead (the Docs/Notion behaviour) keeps both ends
 * outside it, so normalization leaves the selection alone. Motion INSIDE a
 * table still belongs to prosemirror-tables, which turns it into a cell
 * selection; this only fires when the head is outside one.
 */

const inTable = ($pos: ResolvedPos): boolean => {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.spec.tableRole) return true;
  }
  return false;
};

/** Position on the far side of the table abutting the head's block, or null. */
const acrossTable = ($head: ResolvedPos, dir: 1 | -1): number | null => {
  if ($head.depth === 0) return null;
  const edge = dir > 0 ? $head.after($head.depth) : $head.before($head.depth);
  const $edge = $head.doc.resolve(edge);
  const table = dir > 0 ? $edge.nodeAfter : $edge.nodeBefore;
  if (table?.type.spec.tableRole !== 'table') return null;
  return dir > 0 ? edge + table.nodeSize : edge - table.nodeSize;
};

/** Exported for unit tests: the selection this key should produce, or null to
 *  leave the keystroke to the browser. `atBlockEdge` answers "is the caret on
 *  the block's last (down) / first (up) visual line": `view.endOfTextblock` in
 *  the editor, a stub in tests, since only real layout knows about wrapping. */
export function tableStepSelection(args: {
  selection: Selection;
  dir: 1 | -1;
  atBlockEdge: () => boolean;
}): Selection | null {
  const { selection: sel, dir } = args;
  if (!(sel instanceof TextSelection)) return null;
  const $head = sel.$head;
  // Inside a table, prosemirror-tables owns the keystroke (cell selection).
  if (!$head.parent.isTextblock || inTable($head)) return null;
  const target = acrossTable($head, dir);
  if (target === null) return null;
  // Mid-block motion stays native, so wrapped lines still move line by line.
  if (!args.atBlockEdge()) return null;
  // `TextSelection.between` would be the obvious call, but it recomputes its
  // bias from the anchor and so searches BACK into the table. Find the first
  // text position on the far side instead; null means the table is the doc's
  // first/last node and there is nothing out there to select to.
  const landing = Selection.findFrom($head.doc.resolve(target), dir, true);
  if (!landing || inTable(landing.$head)) return null;
  return TextSelection.create($head.doc, sel.anchor, landing.head);
}

export const TableShiftSelection = Extension.create({
  name: 'tableShiftSelection',

  addKeyboardShortcuts() {
    const step = (dir: 1 | -1) => () => {
      const view = this.editor.view as EditorView;
      const { state } = this.editor;
      const next = tableStepSelection({
        selection: state.selection,
        dir,
        atBlockEdge: () => view.endOfTextblock(dir > 0 ? 'down' : 'up'),
      });
      if (!next) return false;
      view.dispatch(state.tr.setSelection(next).scrollIntoView());
      return true;
    };
    return {
      'Shift-ArrowDown': step(1),
      'Shift-ArrowUp': step(-1),
    };
  },
});
