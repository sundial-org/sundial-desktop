import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/* ── Locate plain-text needles inside a document range ────────────────
 *  Used by the factcheck and AI-detection popups to map a model/detector
 *  finding (an exact substring of the checked passage's plain text) back to
 *  ProseMirror positions for highlighting and in-place correction. Same
 *  convention as findQuoteRange in doc-comments-client: text nodes are
 *  concatenated with no separators.
 * ─────────────────────────────────────────────────────────────────── */

export type LocatedRange = { from: number; to: number };

/** All non-overlapping occurrences of `needle` in the concatenated text
 *  nodes of [from, to), as ProseMirror ranges. Empty needle → none. */
export function findTextOccurrencesInRange(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  needle: string,
): LocatedRange[] {
  if (!needle) return [];
  const segments: { start: number; text: string }[] = [];
  let combined = '';
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return true;
    // Clip to the range: nodesBetween yields text nodes that merely overlap.
    const start = Math.max(pos, from);
    const end = Math.min(pos + node.text.length, to);
    if (end <= start) return true;
    segments.push({ start, text: node.text.slice(start - pos, end - pos) });
    combined += node.text.slice(start - pos, end - pos);
    return true;
  });

  /** Char offset in `combined` → ProseMirror position. An offset that falls
   *  exactly between two segments is ambiguous: a range START must map to the
   *  following segment's first char (never past the previous block's text
   *  node, which would make the range straddle the block boundary), while an
   *  exclusive range END must map to the preceding segment's end. */
  const posAt = (offset: number, bias: 'start' | 'end'): number | null => {
    let seen = 0;
    for (const segment of segments) {
      const limit = seen + segment.text.length;
      if (offset < limit || (bias === 'end' && offset === limit)) {
        return segment.start + (offset - seen);
      }
      seen = limit;
    }
    return null;
  };

  const ranges: LocatedRange[] = [];
  for (
    let idx = combined.indexOf(needle);
    idx !== -1;
    idx = combined.indexOf(needle, idx + needle.length)
  ) {
    const start = posAt(idx, 'start');
    const end = posAt(idx + needle.length, 'end');
    if (start !== null && end !== null && end > start) ranges.push({ from: start, to: end });
  }
  return ranges;
}
