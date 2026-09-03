import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { DOMParser as ProseMirrorDOMParser, Fragment, Slice } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

const LISTS = new Set(['bulletList', 'orderedList']);

/**
 * Pasting list lines at the END of a bullet used to produce two wrong shapes,
 * both from ProseMirror fitting a pasted list into a list caret on its own:
 *
 * 1. Handing the target's sub-list to the pasted content. ProseMirror splits
 *    the target item at the caret, and everything after the caret inside the
 *    item — the whole sub-list — belongs to the second half, which the last
 *    pasted item becomes. `- parent` with children `task`/`bullet` turned into
 *    `- parenttask`, then `- bullet` OWNING the two children: a subtree silently
 *    moved under content that was just pasted.
 * 2. Moving one bullet. Cutting a whole bullet line captures the line's item
 *    plus a trailing EMPTY item (`<ul><li><p>cut</p></li><li></li></ul>`), so a
 *    paste left a stray empty bullet, and the empty item's fitting could sink
 *    the pasted line (and the sibling below it) into a new nested list under
 *    that empty bullet — the "why did it nest?" report.
 *
 * So place it explicitly instead: the first pasted line merges into the caret's
 * line, and the rest become that line's following SIBLINGS at the SAME level.
 * Nothing already in the document moves, and a trailing empty item — the
 * drag-cut artifact — is dropped rather than pasted as an empty bullet.
 *
 * Deliberately narrow. It only fires for a collapsed caret at the end of a list
 * line when the clipboard's top node is a plain list of textblock lines.
 * Everything else — a range selection, a caret mid-line, a bare single-line
 * copy (top node is a paragraph, which ProseMirror already merges inline),
 * non-list content — returns false and takes ProseMirror's normal path.
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
  if (item.type.name !== 'listItem') return false;

  const list = soleListNode(slice.content);
  if (!list) return false;
  // Drop a trailing empty line: cutting a whole bullet captures the line's item
  // plus an empty one, and pasting that empty item is what left a stray bullet.
  const items = withoutTrailingEmpty(listItemsOf(list));
  if (items.length === 0) return false;
  const [first, ...rest] = items;
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

/** An item with no content: no text and no sub-list. A whole-line cut appends
 * one, and it can parse either as a bare item or as a single empty textblock. */
function isEmptyLine(item: ProseMirrorNode): boolean {
  if (item.childCount === 0) return true;
  return item.childCount === 1 && !!item.firstChild?.isTextblock && item.firstChild.content.size === 0;
}

/** Trim empty trailing lines — the artifact a whole-line drag-cut appends. */
function withoutTrailingEmpty(items: ProseMirrorNode[]): ProseMirrorNode[] {
  let end = items.length;
  while (end > 0 && isEmptyLine(items[end - 1])) end--;
  return items.slice(0, end);
}
