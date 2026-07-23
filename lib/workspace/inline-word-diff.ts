import type { Node as PMNode } from 'prosemirror-model';
import type { TurnEditLine } from '@/lib/workspace/turn-edits';
import {
  normalizeForDiff,
  stripBlockMarkers,
  stripInlineMarkdown,
} from '@/lib/workspace/pending-additions-match';

export type TextRange = { start: number; end: number };

export type LineChangePair = {
  oldLine: string | null;
  newLine: string;
  addedRanges: TextRange[];
};

type WordToken = { text: string; start: number; end: number };

const WORD_RE = /\S+/g;

/** Map a UTF-16 offset inside `blockNode.textContent` to a document position. */
function textOffsetToDocPos(blockNode: PMNode, blockPos: number, offset: number): number | null {
  // `descendants` reports content-relative positions (0 = the block's content
  // start). The block's content begins one position after `blockPos` — past
  // its own opening token — so every text position is `blockPos + 1 + relative`.
  // Omitting that `+ 1` shifts every highlight one character to the left.
  const contentStart = blockPos + 1;
  let cursor = 0;
  let found: number | null = null;
  blockNode.descendants((child, pos) => {
    if (found !== null) return false;
    if (!child.isText) return;
    const text = child.text ?? '';
    const len = text.length;
    if (offset >= cursor && offset <= cursor + len) {
      found = contentStart + pos + (offset - cursor);
      return false;
    }
    cursor += len;
    return undefined;
  });
  return found;
}

export function mapTextRangesToDocPositions(
  blockNode: PMNode,
  blockPos: number,
  ranges: TextRange[],
): Array<{ from: number; to: number }> {
  const positions: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const from = textOffsetToDocPos(blockNode, blockPos, range.start);
    const to = textOffsetToDocPos(blockNode, blockPos, range.end);
    if (from != null && to != null && from < to) positions.push({ from, to });
  }
  return positions;
}

function tokenizeWords(line: string): WordToken[] {
  const tokens: WordToken[] = [];
  let match: RegExpExecArray | null;
  WORD_RE.lastIndex = 0;
  while ((match = WORD_RE.exec(line))) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

export function normalizeMatchLine(line: string): string {
  return stripInlineMarkdown(stripBlockMarkers(line)).trim();
}

/** When counts differ, deletions/additions are separate structural blocks — don't cross-pair. */
export function pairChangeLines(lines: TurnEditLine[]): Array<{ oldLine: string | null; newLine: string }> {
  const pairs: Array<{ oldLine: string | null; newLine: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.type === 'context') {
      i += 1;
      continue;
    }
    const deletions: string[] = [];
    const additions: string[] = [];
    while (i < lines.length && lines[i]?.type === 'deletion') {
      deletions.push(lines[i]!.content);
      i += 1;
    }
    while (i < lines.length && lines[i]?.type === 'addition') {
      additions.push(lines[i]!.content);
      i += 1;
    }
    if (additions.length === 0) continue;
    if (deletions.length === 0) {
      for (const newLine of additions) pairs.push({ oldLine: null, newLine });
      continue;
    }
    if (deletions.length !== additions.length) {
      const min = Math.min(deletions.length, additions.length);
      for (let j = 0; j < min; j += 1) {
        const del = deletions[j]!;
        const add = additions[j]!;
        const related = shouldApplyInlineWordHighlights(
          normalizeMatchLine(del),
          normalizeMatchLine(add),
        );
        pairs.push({ oldLine: related ? del : null, newLine: add });
      }
      for (let j = min; j < additions.length; j += 1) {
        pairs.push({ oldLine: null, newLine: additions[j]! });
      }
      continue;
    }
    for (let j = 0; j < additions.length; j += 1) {
      pairs.push({ oldLine: deletions[j] ?? null, newLine: additions[j]! });
    }
  }
  return pairs;
}

/**
 * Indices of `newTokens` that are added/changed vs `oldTokens`. Sequential
 * with short lookahead — handles repeated tokens (e.g. two "or"s) and mid-line
 * substitutions better than a global LCS, and (unlike a naive cursor scan) a
 * single substitution doesn't strand the rest of the line as "unmatched".
 */
function addedTokenIndices(oldTokens: WordToken[], newTokens: WordToken[]): number[] {
  const added: number[] = [];
  let oi = 0;
  const LOOKAHEAD = 8;

  for (let ni = 0; ni < newTokens.length; ni += 1) {
    const nw = newTokens[ni]!;
    if (oi < oldTokens.length && oldTokens[oi]!.text === nw.text) {
      oi += 1;
      continue;
    }

    let resync = -1;
    for (let j = oi; j < Math.min(oldTokens.length, oi + LOOKAHEAD); j += 1) {
      if (oldTokens[j]!.text === nw.text) {
        resync = j;
        break;
      }
    }
    if (resync >= 0) {
      oi = resync + 1;
      continue;
    }

    added.push(ni);
  }
  return added;
}

function computeAddedWordRangesSequential(oldLine: string, newLine: string): TextRange[] {
  const oldTokens = tokenizeWords(oldLine);
  const newTokens = tokenizeWords(newLine);
  if (newTokens.length === 0) return [];
  const ranges = addedTokenIndices(oldTokens, newTokens).map((index) => ({
    start: newTokens[index]!.start,
    end: newTokens[index]!.end,
  }));
  return mergeAdjacentRanges(ranges);
}

/** Character ranges in `newLine` that were added or changed vs `oldLine`. */
export function computeAddedWordRanges(oldLine: string | null, newLine: string): TextRange[] {
  if (!newLine) return [];
  if (!oldLine) return [{ start: 0, end: newLine.length }];
  if (oldLine === newLine) return [];

  return computeAddedWordRangesSequential(oldLine, newLine);
}

function mergeAdjacentRanges(ranges: TextRange[]): TextRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: TextRange[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = merged[merged.length - 1]!;
    const cur = sorted[i]!;
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Skip noisy word highlights when old/new lines are unrelated (shown in ghost only). */
export function shouldApplyInlineWordHighlights(
  oldPlain: string | null,
  newPlain: string,
): boolean {
  if (!oldPlain) return false;
  if (!newPlain) return false;

  const oldTokens = tokenizeWords(oldPlain);
  const newTokens = tokenizeWords(newPlain);
  if (newTokens.length === 0) return false;
  if (oldTokens.length === 0) return true;

  // Short lines: highlight the change as long as the two sides are comparable
  // in length (an in-place edit). Wildly different lengths (`asd` vs
  // `What's next?`) are an unrelated pairing — skip.
  if (newTokens.length <= 3) return oldPlain.length >= newPlain.length * 0.55;

  // Longer lines: suppress per-word highlights once most of the line is new.
  // A near-total rewrite reads better as a whole-line replace than as a wall
  // of highlighted words. `addedTokenIndices` measures the real change (a lone
  // mid-line swap counts as 1, not "everything after it").
  const changedFraction = addedTokenIndices(oldTokens, newTokens).length / newTokens.length;
  return changedFraction <= 0.7;
}

/**
 * Word ranges for a block/line matched to a hunk line. The returned offsets
 * index `blockText` *exactly* — the same string the caller decorates (a
 * ProseMirror text node, a Monaco line, a rendered HTML block). We diff against
 * the raw text, not a trimmed copy: the tokenizer already ignores surrounding
 * whitespace, so trimming would only desync the offsets from the indentation
 * (Monaco lines) or leading text the caller is about to highlight.
 *
 * `markdown` controls how the old line is normalized for comparison — strip
 * markdown for prose surfaces, trim-only for code/LaTeX (where `#`, `-`, `*`,
 * `_` are syntax, not formatting).
 */
export function computeInlineAddedRangesForBlock(
  blockText: string,
  oldMarkdownLine: string | null,
  options?: { markdown?: boolean },
): TextRange[] {
  const newPlain = blockText.trim();
  if (!newPlain) return [];
  const oldPlain = oldMarkdownLine
    ? normalizeForDiff(oldMarkdownLine, { markdown: options?.markdown ?? true })
    : null;
  if (!shouldApplyInlineWordHighlights(oldPlain, newPlain)) return [];
  return computeAddedWordRanges(oldPlain, blockText);
}

export function buildLineChangeHighlights(
  lines: TurnEditLine[],
  options?: { markdown?: boolean },
): LineChangePair[] {
  return pairChangeLines(lines).map(({ oldLine, newLine }) => ({
    oldLine,
    newLine,
    // Offsets index the raw `newLine` (the string `wrapAddedRangesHtml` and
    // friends decorate), so normalize only the old side for comparison.
    addedRanges: computeAddedWordRanges(
      oldLine ? normalizeForDiff(oldLine, { markdown: options?.markdown ?? true }) : null,
      newLine,
    ),
  }));
}

export type RemovedLineHighlight = { delLine: string; removedRanges: TextRange[] };

/**
 * Per deletion line, the word ranges that were *removed* — offsets index the
 * raw `delLine` (the string the caller decorates). Mirror of the added ranges:
 * each deletion is diffed against the addition it was edited into, so shared
 * words stay un-highlighted and only the dropped words light up red.
 */
export function buildRemovedLineHighlights(
  lines: TurnEditLine[],
  options?: { markdown?: boolean },
): RemovedLineHighlight[] {
  const deletionLines = lines.filter((l) => l.type === 'deletion').map((l) => l.content);
  const additionLines = lines.filter((l) => l.type === 'addition').map((l) => l.content);
  // Diff each deletion against the addition at the SAME index — the same
  // per-run pairing additions use. (`pickPairedAdditionLine` is a block-level
  // alignment heuristic that returns the first list item for every deleted
  // list item, which would diff `- banana old` against `- apple new`.)
  return deletionLines.map((delLine, index) => ({
    delLine,
    removedRanges: computeInlineAddedRangesForBlock(delLine, additionLines[index] ?? null, options),
  }));
}

/**
 * When a deletion line lost its markdown block marker but pairs with an
 * addition that kept it (e.g. `Try this example` vs `## Try this example 🚀`),
 * restore the marker so both render at the same block level.
 */
export function isListItemMarkdownLine(line: string): boolean {
  return /^(\s*)([-*+]|\d+\.)\s/.test(line);
}

export function pickPairedAdditionLine(
  deletionLine: string,
  additionLines: string[],
  index: number,
): string | null {
  if (additionLines.length === 0) return null;
  if (isListItemMarkdownLine(deletionLine)) {
    const listAddition = additionLines.find((line) => isListItemMarkdownLine(line));
    if (listAddition) return listAddition;
  }
  if (/^#{1,6}\s/.test(deletionLine)) {
    const headingAddition = additionLines.find((line) => /^#{1,6}\s/.test(line));
    if (headingAddition) return headingAddition;
  }
  return additionLines[index] ?? additionLines[0] ?? null;
}

export function alignDeletionMarkdownToAddition(
  deletionLine: string,
  pairedAdditionLine: string | null | undefined,
): string {
  if (!pairedAdditionLine?.trim()) return deletionLine;

  const trimmedDeletion = deletionLine.trim();
  if (!trimmedDeletion) return deletionLine;

  const oldNorm = normalizeMatchLine(deletionLine);
  const newNorm = normalizeMatchLine(pairedAdditionLine);
  let aligned = deletionLine;

  const listPrefix = pairedAdditionLine.match(/^(\s*[-*+]\s+)/)?.[1];
  if (listPrefix) {
    // Marker-only list lines (e.g. "-") must become real list items for rendering.
    if (/^[-*+]$/.test(trimmedDeletion) || /^\s*[-*+]\s*$/.test(deletionLine)) {
      return `${listPrefix}\u200b`;
    }
    if (!/^(\s*)[-*+]\s/.test(deletionLine) && oldNorm && newNorm.startsWith(oldNorm)) {
      aligned = listPrefix + trimmedDeletion;
    }
  }

  const orderedPrefix = pairedAdditionLine.match(/^(\s*\d+\.\s+)/)?.[1];
  if (orderedPrefix) {
    if (/^\d+\.$/.test(trimmedDeletion) || /^\s*\d+\.\s*$/.test(deletionLine)) {
      return `${orderedPrefix}\u200b`;
    }
    if (!/^(\s*)\d+\.\s/.test(deletionLine) && oldNorm && newNorm.startsWith(oldNorm)) {
      aligned = orderedPrefix + trimmedDeletion;
    }
  }

  const headingPrefix = pairedAdditionLine.match(/^(#{1,6}\s+)/)?.[1];
  if (headingPrefix && oldNorm && newNorm.startsWith(oldNorm)) {
    aligned = headingPrefix + stripBlockMarkers(trimmedDeletion).trim();
  }

  return applySharedInlineMarkdownMarks(aligned, pairedAdditionLine);
}

function applySharedInlineMarkdownMarks(deletionLine: string, additionLine: string): string {
  let out = deletionLine;
  const spans: Array<{ pattern: RegExp; wrap: (text: string, match: RegExpExecArray) => string }> = [
    { pattern: /\*\*([^*\n]+)\*\*/g, wrap: (text) => `**${text}**` },
    { pattern: /__([^_\n]+)__/g, wrap: (text) => `__${text}__` },
    { pattern: /`([^`\n]+)`/g, wrap: (text) => `\`${text}\`` },
    { pattern: /~~([^~\n]+)~~/g, wrap: (text) => `~~${text}~~` },
    { pattern: /\[([^\]\n]+)\]\(([^)\n]+)\)/g, wrap: (text, match) => `[${text}](${match[2]})` },
  ];

  for (const { pattern, wrap } of spans) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(additionLine))) {
      const inner = match[1];
      if (!inner?.trim()) continue;
      const marked = wrap(inner, match);
      if (out.includes(marked)) continue;
      const index = out.indexOf(inner);
      if (index < 0) continue;
      out = out.slice(0, index) + marked + out.slice(index + inner.length);
    }
  }
  return out;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap word ranges in `<span class="${className}">` for HTML surfaces. */
export function wrapRangesHtml(
  line: string,
  ranges: TextRange[],
  className = 'diff-inline-added',
): string {
  if (ranges.length === 0) return escapeHtml(line);
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let html = '';
  let cursor = 0;
  for (const range of sorted) {
    if (range.start > cursor) {
      html += escapeHtml(line.slice(cursor, range.start));
    }
    html += `<span class="${className}">${escapeHtml(line.slice(range.start, range.end))}</span>`;
    cursor = range.end;
  }
  if (cursor < line.length) html += escapeHtml(line.slice(cursor));
  return html;
}

/** Wrap added word ranges (`diff-inline-added`). */
export function wrapAddedRangesHtml(line: string, ranges: TextRange[]): string {
  return wrapRangesHtml(line, ranges, 'diff-inline-added');
}

/** Wrap removed word ranges (`diff-inline-removed`) on a deletion line. */
export function wrapRemovedRangesHtml(line: string, ranges: TextRange[]): string {
  return wrapRangesHtml(line, ranges, 'diff-inline-removed');
}

/** Map a matched doc block to word-level added ranges from structured hunk lines. */
export function findAddedRangesForMatchedBlock(
  blockText: string,
  lines: TurnEditLine[] | undefined,
): TextRange[] {
  const trimmed = blockText.trim();
  if (!trimmed) return [];
  if (lines?.length) {
    const normBlock = normalizeMatchLine(blockText);
    for (const highlight of buildLineChangeHighlights(lines)) {
      if (normalizeMatchLine(highlight.newLine) === normBlock) {
        return computeInlineAddedRangesForBlock(blockText, highlight.oldLine);
      }
    }
  }
  return [];
}
