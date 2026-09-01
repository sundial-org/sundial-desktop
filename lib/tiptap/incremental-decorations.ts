import { getChangedRanges } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Incremental maintenance for block-scoped decoration plugins. Rebuilding a
 * full-doc DecorationSet on every keystroke is O(doc) — one of the costs that
 * made typing lag on long documents. Instead: map the previous set through the
 * transaction, then rebuild only the top-level blocks the transaction touched.
 *
 * Correct only when a decoration depends on nothing outside its own top-level
 * block (true for autolink/block-id/checkbox/callout decorations — each block
 * is scanned independently). Plugins with cross-block state (footnote
 * numbering, HTML regions) need their own strategy.
 */

/** The [from, to] window of top-level blocks a transaction touched, in new-doc
 *  coordinates — over-scanned one position each side so decorations straddling
 *  the edit are caught. Null when no range changed (e.g. attr-only steps still
 *  report their node's range, so those rescan too). */
export function changedBlockSpan(tr: Transaction): { from: number; to: number } | null {
  const size = tr.doc.content.size;
  let from = size;
  let to = 0;
  for (const range of getChangedRanges(tr)) {
    from = Math.min(from, range.newRange.from - 1);
    to = Math.max(to, range.newRange.to + 1);
  }
  if (from > to) return null;
  const clamp = (pos: number) => Math.max(0, Math.min(pos, size));
  const $from = tr.doc.resolve(clamp(from));
  const $to = tr.doc.resolve(clamp(to));
  return {
    from: $from.depth === 0 ? clamp(from) : $from.before(1),
    to: $to.depth === 0 ? clamp(to) : $to.after(1),
  };
}

/** One `apply()` step: previous set mapped through the transaction, with the
 *  changed top-level blocks rescanned via `scan(doc, from, to)`. `scan` must
 *  return every decoration for the window and none outside it, and must not
 *  anchor a decoration exactly at the window boundary (between blocks) —
 *  `find` is inclusive on both ends, so removal trims one position off each
 *  side to spare the NEIGHBORING blocks' decorations that merely touch it. */
export function applyIncremental(
  tr: Transaction,
  previous: DecorationSet,
  scan: (doc: ProseMirrorNode, from: number, to: number) => Decoration[],
): DecorationSet {
  const mapped = previous.map(tr.mapping, tr.doc);
  const span = changedBlockSpan(tr);
  // No ranged step but the doc DID change: an attr-only step (callout
  // collapse, heading level…) has an empty StepMap, so it is invisible to
  // getChangedRanges. Rare — never the typing path — so rescan everything.
  if (!span) {
    return tr.docChanged
      ? mapped.remove(mapped.find()).add(tr.doc, scan(tr.doc, 0, tr.doc.content.size))
      : mapped;
  }
  return mapped
    .remove(mapped.find(span.from + 1, span.to - 1))
    .add(tr.doc, scan(tr.doc, span.from, span.to));
}
