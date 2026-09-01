import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ID_MASK, TRAILING_BLOCK_ID_RE } from '@/lib/markdown/anchors.mjs';
import { applyIncremental } from '@/lib/tiptap/incremental-decorations';

/**
 * Obsidian block IDs (`… ^my-id` at the end of a line) stay literal text in
 * the doc — the markdown round trip is untouched, exactly like math and
 * markdown images. This plugin only paints the trailing `^id` as a dim badge
 * (`.sd-block-id`) so it reads as an anchor, not prose noise. Always-on
 * styling: the text stays visible and editable in place, so there's no
 * caret-aware reveal (and no selection-driven recompute) to manage.
 */

const blockIdKey = new PluginKey<DecorationSet>('blockIdBadges');

/** All `^id` badge ranges in [from, to] (defaults to the whole doc) — exported for tests. */
export function findBlockIdRanges(
  doc: ProseMirrorNode,
  from = 0,
  to = doc.content.size,
): Array<{ from: number; to: number; id: string }> {
  const out: Array<{ from: number; to: number; id: string }> = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === 'codeBlock') return false;
    // Hard breaks split a textblock into lines; an ID can end any of them.
    // Non-text inline leaves contribute one placeholder char per position so
    // segment text stays position-aligned (and a regex can't match across one).
    let segStart = pos + 1;
    let segText = '';
    const flush = (segEnd: number) => {
      const trimmed = segText.replace(/[ \t]+$/, '');
      const m = TRAILING_BLOCK_ID_RE.exec(trimmed);
      if (m) {
        const to = segStart + trimmed.length;
        out.push({ from: to - m[1].length - 1, to, id: m[1] });
      }
      segStart = segEnd;
      segText = '';
    };
    node.forEach((child, offset) => {
      if (child.type.name === 'hardBreak') {
        flush(pos + 1 + offset + child.nodeSize);
      } else if (child.isText) {
        const text = child.text ?? '';
        // Inline code is literal: a line ending in `cmd ^tmp` must not paint a
        // badge. Mask with the SHARED ID_MASK, not a space — a space satisfies
        // the regex's `[ \t]` prefix, so `run `cmd`^tmp` would fake an id here
        // while the resolver (same mask) ignores it, and the editor would paint
        // and navigate to a badge that embeds can't see.
        // Code AND link text are references, not the block's own content — a
        // block link's alias ends in `^id`, so an unmasked one would paint a
        // badge on the paragraph that merely points at the block.
        const isRef = child.marks.some((m) => m.type.name === 'code' || m.type.name === 'link');
        segText += isRef ? ID_MASK.repeat(text.length) : text;
      } else {
        segText += ID_MASK.repeat(child.nodeSize);
      }
    });
    flush(pos + 1 + node.content.size);
    return false;
  });
  return out;
}

function scanDecorations(doc: ProseMirrorNode, from: number, to: number): Decoration[] {
  return findBlockIdRanges(doc, from, to).map(({ from: f, to: t }) =>
    Decoration.inline(f, t, { class: 'sd-block-id' }),
  );
}

export const BlockIdBadges = Extension.create({
  name: 'blockIdBadges',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: blockIdKey,
        state: {
          init: (_config, state) =>
            DecorationSet.create(state.doc, scanDecorations(state.doc, 0, state.doc.content.size)),
          apply: (tr, previous) =>
            tr.docChanged ? applyIncremental(tr, previous, scanDecorations) : previous,
        },
        props: {
          decorations(state) {
            return blockIdKey.getState(state);
          },
        },
      }),
    ];
  },
});

export default BlockIdBadges;
