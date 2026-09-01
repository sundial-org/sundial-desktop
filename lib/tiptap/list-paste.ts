import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { DOMParser as ProseMirrorDOMParser, Fragment, Slice } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

const LISTS = new Set(['bulletList', 'orderedList']);

/**
 * Pasting several list lines at the END of a bullet that HAS a sub-list used to
 * hand that sub-list to the pasted content.
 *
 * ProseMirror splits the target item at the caret, and everything after the
 * caret inside the item — which is the whole sub-list — belongs to the second
 * half. The last pasted item becomes that second half, so `- parent` with
 * children `task`/`bullet` turned into `- parenttask`, then `- bullet` OWNING
 * the two children. Read as flat text the result is defensible; read as the
 * outline the user is looking at, a subtree silently moved under content that
 * was just pasted.
 *
 * So place it explicitly instead: the first pasted line merges into the caret's
 * line, and the rest become that line's following SIBLINGS. Nothing that was
 * already in the document moves, and it matches what already happens when the
 * target has no children — the case ProseMirror gets right — so the rule is the
 * same either way.
 *
 * Deliberately narrow. It only fires for a collapsed caret at the end of a list
 * line whose item has a sub-list, when the clipboard is a plain list of lines.
 * Everything else — a range selection, a caret mid-line, a target with no
 * children, a nested-item paste, non-list content — returns false and takes
 * ProseMirror's normal path.
 */
export const ListPaste = Extension.create({
  name: 'listPaste',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const html = event.clipboardData?.getData('text/html');
            if (!html) return false;
            const wrapper = document.createElement('div');
            wrapper.innerHTML = html;
            const slice = ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(wrapper, {
              preserveWhitespace: false,
              context: view.state.selection.$from,
            });
            return pasteListBesideChildren(view, slice);
          },
        },
      }),
    ];
  },
});

/**
 * Insert `slice` as "merge the first line, append the rest as siblings" when
 * the caret sits at the end of a list line whose item owns a sub-list. Returns
 * false — having changed nothing — whenever that shape does not apply, so the
 * caller can fall through to ProseMirror.
 */
export function pasteListBesideChildren(view: EditorView, slice: Slice): boolean {
  const { $from, empty } = view.state.selection;
  if (!empty || $from.depth < 3) return false;
  if ($from.parent.type.name !== 'paragraph') return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const item = $from.node(-1);
  // Only an item that owns something after its paragraph can have it stolen.
  if (item.type.name !== 'listItem' || item.childCount < 2) return false;

  const list = soleListNode(slice.content);
  if (!list || list.childCount < 2) return false;
  const [first, ...rest] = listItemsOf(list);
  // A first line that carries its own sub-list is not "one line to merge".
  if (!first || first.childCount !== 1 || !first.firstChild?.isTextblock) return false;

  const tr = view.state.tr;
  // The ITEMS, not the list that held them: `after(-1)` is inside the target's
  // own list, which takes `listItem+`. Handing it a list node there would nest
  // a second list and split the first. Pasted items therefore adopt the target
  // list's type, the way an ordered line pasted into a bulleted list should.
  // Insert them FIRST, at the higher position, so the caret insert below does
  // not shift the position they were computed from.
  tr.insert($from.after(-1), Fragment.from(rest));
  tr.replaceWith($from.pos, $from.pos, first.firstChild.content);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** The single list node a pasted slice consists of, ignoring open wrappers. */
function soleListNode(content: Fragment): ProseMirrorNode | null {
  let node: ProseMirrorNode | null = content.childCount === 1 ? content.firstChild : null;
  // A slice copied from inside a list arrives wrapped in the item it came from.
  while (node && !LISTS.has(node.type.name)) {
    if (node.type.name !== 'listItem' || node.childCount !== 1) return null;
    node = node.firstChild;
  }
  return node && LISTS.has(node.type.name) ? node : null;
}

function listItemsOf(list: ProseMirrorNode): ProseMirrorNode[] {
  const items: ProseMirrorNode[] = [];
  list.forEach((child) => {
    if (child.type.name === 'listItem') items.push(child);
  });
  return items.length === list.childCount ? items : [];
}
