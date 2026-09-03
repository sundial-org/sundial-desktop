/**
 * Maps a text selection made on the compiled PDF back to a character range in
 * the LaTeX source (the pdf_comments_enabled feature). SyncTeX inverse search
 * already resolved the selection to a source LINE; this narrows the line to the
 * selected span so the comment anchors to the exact words, Hypothesis-style.
 *
 * Rendered text differs from source text (macros, ligatures, hyphenation at
 * line breaks, justified spacing), so matching is best-effort with graceful
 * degradation: exact substring → whitespace/hyphenation-tolerant word match →
 * the whole SyncTeX line. The caller falls back to jump-to-source when even
 * the line is empty.
 */

export type PdfSelectionMatch = {
  from: number;
  to: number;
  /** How the range was found — 'line' means the span could not be narrowed. */
  method: 'exact' | 'words' | 'line';
};

// SyncTeX lines can be a couple of lines off (it records the line a box was
// CONTRIBUTED from, and paragraphs reflow); search a window around the hit.
const LINES_BEFORE = 3;
const LINES_AFTER = 12;
// A regex built from a huge selection would be pathological; word matching
// only needs enough of the head to pin the start.
const MAX_MATCH_WORDS = 24;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Start offset of each 1-based line, plus one past-the-end sentinel. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  starts.push(text.length + 1);
  return starts;
}

/** 1-based line containing `offset`, given lineStartOffsets output. */
function lineOfOffset(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Of several candidate ranges, the one on the line nearest the SyncTeX hit —
 *  repeated prose must not always anchor to the window's first occurrence. */
function nearestToLine(
  matches: Array<{ from: number; to: number }>,
  starts: number[],
  line: number,
): { from: number; to: number } | null {
  let best: { from: number; to: number } | null = null;
  let bestDist = Infinity;
  for (const match of matches) {
    const dist = Math.abs(lineOfOffset(starts, match.from) - line);
    if (dist < bestDist) {
      bestDist = dist;
      best = match;
    }
  }
  return best;
}

/**
 * 1-based [start, end] line span of a comment's quote inside `text`, or null
 * when the quote no longer appears. This is how comments on files OTHER than
 * the open one project onto the PDF: their Yjs anchors need the file's Y.Doc,
 * but every thread carries the quote, and the file text is one fetch away.
 */
export function quoteLineSpan(text: string, quote: string): [number, number] | null {
  if (!quote) return null;
  const idx = text.indexOf(quote);
  if (idx === -1) return null;
  const start = text.slice(0, idx).split('\n').length;
  const end = start + quote.split('\n').length - 1;
  return [start, end];
}

/**
 * Find the source range for `selectedText` (the rendered text the user selected
 * in the PDF) near 1-based `line` of `sourceText`. Never throws; returns null
 * only when `line` is outside the document.
 */
export function matchPdfSelectionToSource(
  sourceText: string,
  line: number,
  selectedText: string,
): PdfSelectionMatch | null {
  const starts = lineStartOffsets(sourceText);
  const lineCount = starts.length - 1;
  if (line < 1 || line > lineCount) return null;

  const windowStartLine = Math.max(1, line - LINES_BEFORE);
  const windowEndLine = Math.min(lineCount, line + LINES_AFTER);
  const windowFrom = starts[windowStartLine - 1];
  const windowTo = Math.min(sourceText.length, starts[windowEndLine] - 1);
  const window = sourceText.slice(windowFrom, windowTo);

  // PDF text layers hyphenate at line breaks ("exam- ple") and join lines with
  // single spaces; collapse both before matching.
  const dehyphenated = selectedText.replace(/-\s+/g, '');
  const candidates = [selectedText.trim(), dehyphenated.trim()];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const occurrences: Array<{ from: number; to: number }> = [];
    for (let idx = window.indexOf(candidate); idx !== -1; idx = window.indexOf(candidate, idx + 1)) {
      occurrences.push({ from: windowFrom + idx, to: windowFrom + idx + candidate.length });
    }
    const best = nearestToLine(occurrences, starts, line);
    if (best) return { ...best, method: 'exact' };
  }

  // Word-sequence match: the same words in order, tolerant of the whitespace,
  // line breaks, LaTeX ties (~), and residual hyphenation between them.
  const words = dehyphenated.split(/\s+/).filter(Boolean).slice(0, MAX_MATCH_WORDS);
  if (words.length > 0) {
    const pattern = words.map(escapeRegExp).join('[-\\s~]+');
    try {
      const re = new RegExp(pattern, 'g');
      const occurrences: Array<{ from: number; to: number }> = [];
      for (let match = re.exec(window); match; match = re.exec(window)) {
        occurrences.push({ from: windowFrom + match.index, to: windowFrom + match.index + match[0].length });
        if (match.index === re.lastIndex) re.lastIndex += 1;
      }
      const best = nearestToLine(occurrences, starts, line);
      if (best) return { ...best, method: 'words' };
    } catch {
      /* a pathological selection built an invalid pattern — fall through */
    }
  }

  // Could not narrow — anchor the whole SyncTeX line (Overleaf's granularity).
  const rawFrom = starts[line - 1];
  const rawTo = Math.min(sourceText.length, starts[line] - 1);
  const lineText = sourceText.slice(rawFrom, rawTo);
  const leading = lineText.length - lineText.trimStart().length;
  const trailing = lineText.length - lineText.trimEnd().length;
  return { from: rawFrom + leading, to: rawTo - trailing, method: 'line' };
}
