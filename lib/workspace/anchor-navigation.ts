import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import { normalizeAnchorInline, resolveHeadingEntries } from '@/lib/markdown/anchors.mjs';
import { findBlockIdRanges } from '@/lib/tiptap/block-id-decorations';

/**
 * Scroll-to-anchor for `[[note#heading]]` / `[[note#^block-id]]` navigation.
 * Matching mirrors lib/markdown/anchors.mjs (forgiving heading comparison,
 * case-insensitive IDs, standalone `^id` line anchors the block before it) but
 * runs against the live ProseMirror doc, so it always reflects unsynced edits.
 */

export type WikiAnchor = {
  heading?: string | null;
  /** Segments of a `#`-separated fragment, walked down the heading hierarchy
   *  when the literal name doesn't match — see parseWikiTarget. Must be carried
   *  alongside `heading` or the editor and the resolver disagree on
   *  `note#Top#Deep`. */
  headingPath?: string[] | null;
  blockId?: string | null;
};

/**
 * A live heading node's matching key. Projects the node into the parser's
 * inline shape (preserving the `code` mark) and defers to the shared rule in
 * anchors.mjs, so the editor and the AST resolver can't drift — `textContent`
 * alone would lose the code marks that decide whether a trailing `^x` is an id.
 */
function headingAnchorKey(node: ProseMirrorNode): string {
  const inline: Array<{ type: string; text?: string; marks?: Array<{ type: string }> }> = [];
  node.forEach((child) => {
    if (child.type.name === 'hardBreak') inline.push({ type: 'hardBreak' });
    else if (child.isText) {
      inline.push({
        type: 'text',
        text: child.text ?? '',
        marks: child.marks.map((m) => ({ type: m.type.name })),
      });
    }
  });
  return normalizeAnchorInline(inline);
}

/** Doc position of the top-level block an anchor points at — exported for tests. */
export function findAnchorTopLevelPos(doc: ProseMirrorNode, anchor: WikiAnchor): number | null {
  if (anchor.heading) {
    // Project the top level into the shape the shared resolver reads, so the
    // editor applies EXACTLY the rule embeds do — literal name first, then the
    // hierarchy walk — instead of re-implementing the search here.
    const entries: Array<{ isHeading: boolean; level?: number; key?: string }> = [];
    const offsets: number[] = [];
    doc.forEach((node, offset) => {
      const isHeading = node.type.name === 'heading';
      entries.push({
        isHeading,
        level: isHeading ? Number(node.attrs.level) || 1 : undefined,
        key: isHeading ? headingAnchorKey(node) : undefined,
      });
      offsets.push(offset);
    });
    const range = resolveHeadingEntries(entries, {
      heading: anchor.heading,
      headingPath: anchor.headingPath ?? undefined,
    }) as { start: number } | null;
    return range ? offsets[range.start] : null;
  }
  if (anchor.blockId) {
    const want = anchor.blockId.toLowerCase();
    const hit = findBlockIdRanges(doc).find((r) => r.id.toLowerCase() === want);
    if (!hit) return null;
    const $pos = doc.resolve(hit.from);
    const topNode = $pos.node(1);
    // A paragraph that is nothing but `^id` names the block BEFORE it
    // (Obsidian's form for tables/code fences, which can't carry a suffix).
    if (topNode.isTextblock && topNode.textContent.trim() === `^${hit.id}`) {
      const index = $pos.index(0);
      if (index === 0) return null;
      let prev: number | null = null;
      doc.forEach((_node, offset, i) => {
        if (i === index - 1) prev = offset;
      });
      return prev;
    }
    return $pos.before(1);
  }
  return null;
}

/**
 * Move the caret to the anchored block, scroll it into view, and flash it.
 * Returns false when the anchor doesn't resolve (caller shows the notice).
 */
export function scrollEditorToAnchor(editor: Editor | null | undefined, anchor: WikiAnchor): boolean {
  if (!editor || editor.isDestroyed) return false;
  const { view } = editor;
  const pos = findAnchorTopLevelPos(view.state.doc, anchor);
  if (pos == null) return false;
  const tr = view.state.tr
    .setSelection(Selection.near(view.state.tr.doc.resolve(pos + 1)))
    .scrollIntoView();
  view.dispatch(tr);
  const dom = view.nodeDOM(pos);
  if (dom instanceof HTMLElement) {
    // Remove + reflow so re-navigating to the same block restarts the flash.
    dom.classList.remove('sd-anchor-flash');
    void dom.offsetWidth;
    dom.classList.add('sd-anchor-flash');
    window.setTimeout(() => dom.classList.remove('sd-anchor-flash'), 1700);
  }
  return true;
}
