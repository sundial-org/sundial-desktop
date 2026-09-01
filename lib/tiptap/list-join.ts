import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { ResolvedPos } from '@tiptap/pm/model';
import { checkboxMarkerLength } from '@/lib/markdown/checkbox';

const LIST_NODES = new Set(['listItem', 'bulletList', 'orderedList']);

/**
 * Backspace at the start of a list-item line, and Delete at its end, join it
 * with the neighbouring line — exactly like deleting the newline between them
 * in the markdown source.
 *
 * Tiptap's ListKeymap does something structural instead, and on any line pair
 * that does NOT sit at the same depth it corrupts the shape:
 *   - `handleBackspace` ends in `liftListItem`, which outdents the item AND
 *     re-parents its following siblings under it — a Backspace meant to pull a
 *     bullet into the one above shuffles a whole nested list sideways.
 *   - `handleDelete` strips the next line's bullet into a bare continuation
 *     paragraph, or drags a shallower line down into the nested list.
 * Tiptap's own `joinItemBackward` command doesn't cover this either: it is
 * `joinPoint` + `tr.join`, which only finds a point when the two lines are
 * adjacent siblings at the SAME depth, and hands every other case back to the
 * destructive default.
 *
 * Deleting the boundary is depth-agnostic: the text merges, the item's own
 * sub-list follows the text it belonged to, and nothing else moves. Both keys
 * run the same join on the same boundary — Delete just aims at the line below
 * — so the two can never disagree about what the result should be.
 *
 * The lift is kept where it is the point — Backspace with no list line above
 * (the first item of a top-level list, or a list that merely follows a
 * paragraph) still escapes the list, and an empty SOLE item still outdents so
 * a fresh Tab indent can be backed out.
 *
 * Priority > 100 so this runs before StarterKit's ListKeymap handlers.
 */
export const ListJoin = Extension.create({
  name: 'listJoin',
  priority: 110,

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { $from } = editor.state.selection;
        if (!atLineEdge(editor.state, -1)) return false;
        // Backspace on an empty SOLE item keeps the lift, so Enter→Tab→
        // Backspace still backs out of a fresh indent. An empty item with a
        // line above has nothing to drag, so it joins (i.e. just disappears).
        if ($from.parent.content.size === 0 && $from.node(-2).childCount === 1) return false;
        if (!lineAbove(editor.state, $from, -1)) return false;
        // A "- " typed just before must still revert to its literal text.
        if (editor.commands.undoInputRule()) return true;
        return joinLineInto(editor, $from);
      },
      Delete: ({ editor }) => {
        if (!atLineEdge(editor.state, 1)) return false;
        const $next = lineBelow(editor.state);
        if (!$next || !lineAbove(editor.state, $next, 1)) return false;
        return joinLineInto(editor, $next);
      },
    };
  },
});

/** Caret (not a range) at the very start / end of a paragraph in a listItem. */
function atLineEdge(state: EditorState, dir: 1 | -1): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 3) return false;
  if ($from.parent.type.name !== 'paragraph') return false;
  if ($from.node(-1).type.name !== 'listItem') return false;
  return dir < 0 ? $from.parentOffset === 0 : $from.parentOffset === $from.parent.content.size;
}

/** Start of the line below the caret's, when Delete should join it upward. */
function lineBelow(state: EditorState): ResolvedPos | null {
  const near = Selection.near(state.doc.resolve(state.selection.$from.after()), 1);
  if (!(near instanceof TextSelection)) return null;
  return near.$head.pos > state.selection.$from.pos ? near.$head : null;
}

/**
 * End of the line above `$at`, when the gap between them is a plain markdown
 * line break — a blockquote, table cell, or code block in between is a
 * container boundary, and merging across it would move text into a different
 * kind of block. A leading atom (image, rule) yields a node or gap selection
 * and is left to the default handling.
 *
 * `dir` is the key that was pressed, not the search direction. Going FORWARD
 * the two lines may share only the document: Delete at the end of a bullet is
 * expected to pull the following paragraph into it. Going BACKWARD they may
 * not, because that case is the escape-the-list lift.
 */
function lineAbove(state: EditorState, $at: ResolvedPos, dir: 1 | -1): ResolvedPos | null {
  const near = Selection.near(state.doc.resolve($at.before()), -1);
  if (!(near instanceof TextSelection)) return null;
  const $above = near.$head;
  if ($above.pos >= $at.pos || $above.parent.type.name !== 'paragraph') return null;
  const shared = $at.sharedDepth($above.pos);
  if (!LIST_NODES.has($at.node(shared).type.name) && !(dir > 0 && shared === 0)) return null;
  for (const $pos of [$at, $above]) {
    for (let d = shared + 1; d < $pos.depth; d += 1) {
      if (!LIST_NODES.has($pos.node(d).type.name)) return null;
    }
  }
  return $above;
}

/**
 * True when the line above `$at` is its own PARENT item's text (a depth gap of
 * exactly one list level) and `$at`'s item carries a sub-list of its own.
 * Deleting that boundary directly leaves the item shell behind to host the
 * sub-list, stranding an empty bullet; outdenting the item first turns this
 * into the plain sibling case, which merges cleanly.
 */
function needsLift(state: EditorState, $at: ResolvedPos): boolean {
  if ($at.depth < 3 || $at.node(-1).type.name !== 'listItem') return false;
  if ($at.node(-1).childCount < 2) return false;
  const $above = lineAbove(state, $at, -1);
  return $above != null && $at.depth - $above.depth === 2;
}

/** Merge the line starting at `$at` into the line above it. */
function joinLineInto(editor: Editor, $at: ResolvedPos): boolean {
  const chain = editor.chain().setTextSelection($at.pos);
  const lifted = needsLift(editor.state, $at) ? chain.liftListItem('listItem') : chain;
  return lifted
    .command(({ tr, dispatch }) => {
      // Recompute against `tr`: a lift moved the line, and the chain's later
      // commands see the transaction's document, not the original state.
      const $line = tr.selection.$from;
      const near = Selection.near(tr.doc.resolve($line.before()), -1);
      if (!(near instanceof TextSelection) || near.$head.pos >= $line.pos) return false;
      if (dispatch) {
        const from = near.$head.pos;
        // The merged-in line's own task marker sits right at `$line.pos` —
        // swallow it too, or its checkbox strands in the middle of the result.
        tr.delete(from, $line.pos + checkboxMarkerLength($line.parent.textContent));
        // Bias the caret BACKWARD — onto the line that absorbed the text.
        tr.setSelection(TextSelection.near(tr.doc.resolve(from), -1));
        tr.scrollIntoView();
      }
      return true;
    })
    .run();
}
