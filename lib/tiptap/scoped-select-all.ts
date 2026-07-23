import { Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

/**
 * Notion-style scoped select-all: the first Mod-A selects the current text
 * block's content; the second (or any state with no narrower target — a
 * multi-block selection, an already block-wide selection, which an empty
 * block always is) falls through to ProseMirror's whole-doc selectAll.
 */
export const ScopedSelectAll = Extension.create({
  name: 'scopedSelectAll',

  addKeyboardShortcuts() {
    return {
      'Mod-a': ({ editor }) => {
        const { state } = editor;
        const { $from, $to, from, to } = state.selection;
        if (!$from.sameParent($to) || !$from.parent.isTextblock) return false;
        const start = $from.start();
        const end = start + $from.parent.content.size;
        if (from === start && to === end) return false;
        editor.view.dispatch(
          state.tr.setSelection(TextSelection.create(state.doc, start, end)),
        );
        return true;
      },
    };
  },
});
