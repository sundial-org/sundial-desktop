import type { Node } from '@tiptap/pm/model';

export type FindMatch = { from: number; to: number };

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find every occurrence of `term` in the document. Searches each textblock's
 *  concatenated inline text, so a match may span mark boundaries (e.g. a word
 *  half-bolded). Inline leaves (hard breaks, images, math) map to one NUL
 *  placeholder — nodeSize 1, so offsets stay position-exact — and never match,
 *  so a term can't falsely bridge them. Case-insensitive unless asked;
 *  the `u` flag gets Unicode simple case folding without shifting offsets. */
export function computeMatches(doc: Node, term: string, caseSensitive = false): FindMatch[] {
  const matches: FindMatch[] = [];
  if (!term) return matches;
  const re = new RegExp(escapeRegExp(term), caseSensitive ? 'gu' : 'giu');
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, '\u0000');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      matches.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
    }
    return false; // textblocks contain no nested textblocks
  });
  return matches;
}
