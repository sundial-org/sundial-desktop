/**
 * Snap a SyncTeX inverse-search jump to the exact word the user double-clicked
 * in the PDF. The line map is approximate in ways the data cannot fix — most
 * visibly, everything \maketitle typesets is tagged with \maketitle's own line,
 * not the \title{...} that holds the words — but the double-click also selected
 * the word in the PDF's text layer, and that text is exact. Searching the
 * nearby source lines for it (nearest line first, case-sensitive) finds the
 * true target; the caller then selects that word so the editor highlight
 * matches what was clicked.
 */

export type WordHit = { line: number; column: number; length: number };

const SEARCH_RADIUS = 3;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find `word` on the source line nearest 1-based `line` (the line itself, then
 * ±1, ±2, ... up to ±3). Whole-word, case-sensitive. `lineAt` returns the text
 * of a 1-based line, or null past either end. Returns a 1-based line/column.
 */
export function findWordNearLine(
  lineAt: (line: number) => string | null,
  line: number,
  word: string,
): WordHit | null {
  const token = word.trim();
  // Multi-token or empty selections aren't a word; punctuation-only ones
  // (a double-clicked "—" or bullet) would match everywhere.
  if (!token || /\s/.test(token) || !/[A-Za-z0-9]/.test(token)) return null;
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(token)}(?![A-Za-z0-9])`);
  for (let dist = 0; dist <= SEARCH_RADIUS; dist++) {
    for (const candidate of dist === 0 ? [line] : [line + dist, line - dist]) {
      const text = lineAt(candidate);
      if (text === null) continue;
      const match = pattern.exec(text);
      if (match) return { line: candidate, column: match.index + 1, length: token.length };
    }
  }
  return null;
}
