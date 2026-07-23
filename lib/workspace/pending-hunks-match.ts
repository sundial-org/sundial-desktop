import type { TurnEditLine } from './turn-edits';

/**
 * Hunk-position matcher for code / plain-text / LaTeX pending edits.
 *
 * Unlike the markdown matcher (`pending-additions-match.ts`) which matches
 * per-block via text equality, this matcher locates each hunk by its
 * *surrounding context*. A hunk is `[…leading context, additions, …trailing
 * context]` (with deletions interleaved as ops that shouldn't appear in the
 * new file). We search the current buffer for the contiguous sequence of
 * "new-file lines" (contexts + additions, in order). When multiple positions
 * match, the one nearest the agent's `newStart` hint wins — that keeps
 * decorations stable when the same `}` / `return;` line appears many times.
 *
 * If the strict match fails (e.g. a human edited a context line), we fall
 * back to addition-only matching with the same proximity preference. If
 * that also fails, the hunk is treated as stale (no decoration) — silently
 * decorating the wrong line is worse than not decorating at all.
 */

export type PendingHunkInput = {
  /** Stable chunk key. */
  key: string;
  /** Full ordered op list for the chunk: contexts + additions + deletions. */
  lines: TurnEditLine[];
  /** 0-indexed expected starting line in the new file. Used as a proximity hint. */
  newStart?: number;
};

export type PendingHunkMatch = {
  key: string;
  /** 1-indexed inclusive first line of the addition run in the buffer. */
  addStartLine: number;
  /**
   * 1-indexed inclusive last line of the addition run. For pure-deletion
   * hunks (no additions), `addEndLine = addStartLine - 1` (empty range) and
   * the deletion ghost should render between buffer lines.
   */
  addEndLine: number;
  /** Deletion lines to render as red ghost rows above `addStartLine`. */
  deletedLines: string[];
};

type ExpectedEntry = { kind: 'context' | 'addition'; text: string };

function expectedSequence(lines: TurnEditLine[]): {
  entries: ExpectedEntry[];
  deletions: string[];
} {
  const entries: ExpectedEntry[] = [];
  const deletions: string[] = [];
  for (const line of lines) {
    if (line.type === 'deletion') {
      deletions.push(line.content);
    } else {
      entries.push({ kind: line.type, text: line.content });
    }
  }
  return { entries, deletions };
}

/** Index of buffer line text → ascending list of line numbers it appears at.
 * Built once per `matchPendingHunks` call so each `findExactRuns` probes only
 * the (usually few) positions where the target's first line occurs, instead of
 * every buffer position. Turns the per-keystroke cost from O(hunks·buffer·target)
 * toward O(buffer + hunks·matches·target) — the difference between a smooth and
 * a frozen editor on a large file with many pending hunks. */
type LineIndex = Map<string, number[]>;

function buildLineIndex(buffer: string[]): LineIndex {
  const index: LineIndex = new Map();
  for (let i = 0; i < buffer.length; i += 1) {
    const at = index.get(buffer[i]);
    if (at) at.push(i);
    else index.set(buffer[i], [i]);
  }
  return index;
}

function findExactRuns(buffer: string[], target: string[], index: LineIndex): number[] {
  if (target.length === 0 || buffer.length < target.length) return [];
  const starts = index.get(target[0]);
  if (!starts) return [];
  const maxStart = buffer.length - target.length;
  const out: number[] = [];
  // `starts` is ascending, so `out` stays ascending (matches the old full scan).
  outer: for (const start of starts) {
    if (start > maxStart) break;
    for (let i = 1; i < target.length; i += 1) {
      if (buffer[start + i] !== target[i]) continue outer;
    }
    out.push(start);
  }
  return out;
}

function pickNearest(starts: number[], hint: number): number | null {
  if (starts.length === 0) return null;
  let best = starts[0];
  let bestDist = Math.abs(best - hint);
  for (let i = 1; i < starts.length; i += 1) {
    const dist = Math.abs(starts[i] - hint);
    if (dist < bestDist) {
      best = starts[i];
      bestDist = dist;
    }
  }
  return best;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart <= bEnd && bStart <= aEnd;
}

function isClaimed(
  claimed: Array<{ start: number; end: number }>,
  start: number,
  end: number,
) {
  for (const c of claimed) {
    if (rangesOverlap(c.start, c.end, start, end)) return true;
  }
  return false;
}

function firstLastAdditionIndex(entries: ExpectedEntry[]) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].kind === 'addition') {
      if (first === -1) first = i;
      last = i;
    }
  }
  return { first, last };
}

function matchOne(
  buffer: string[],
  hunk: PendingHunkInput,
  claimed: Array<{ start: number; end: number }>,
  index: LineIndex,
): PendingHunkMatch | null {
  const { entries, deletions } = expectedSequence(hunk.lines);
  if (entries.length === 0) {
    // Pure deletion with no surrounding context — no place to anchor visually.
    return null;
  }
  const hint = hunk.newStart ?? 0;
  const { first: firstAddIdx, last: lastAddIdx } = firstLastAdditionIndex(entries);
  const pureDeletion = firstAddIdx === -1;

  // Tier 1: strict — full expected sequence (contexts + additions in order).
  // This is the path that picks the right `}` even when 50 `}` exist in the file.
  const strictTarget = entries.map((e) => e.text);
  const strictStarts = findExactRuns(buffer, strictTarget, index).filter(
    (s) => !isClaimed(claimed, s + 1, s + strictTarget.length),
  );
  const strictPick = pickNearest(strictStarts, hint);
  if (strictPick !== null) {
    if (pureDeletion) {
      const addStartLine = strictPick + strictTarget.length + 1; // after the run
      // Place the deletion ghost between the leading and trailing context: that's
      // where the lines used to live. Pin to the "first trailing context" line.
      // entries are all context here; we anchor before the first context that
      // came *after* the last deletion in the original chunk.
      const anchor = anchorPureDeletion(hunk.lines, strictPick);
      return {
        key: hunk.key,
        addStartLine: anchor,
        addEndLine: anchor - 1,
        deletedLines: deletions,
      };
    }
    return {
      key: hunk.key,
      addStartLine: strictPick + firstAddIdx + 1,
      addEndLine: strictPick + lastAddIdx + 1,
      deletedLines: deletions,
    };
  }

  if (pureDeletion) return null;

  // Tier 2: leading-context + additions. Drops trailing context, which is
  // common to lose when a human appended text after the hunk.
  const leadTarget = entries.slice(0, lastAddIdx + 1).map((e) => e.text);
  const leadStarts = findExactRuns(buffer, leadTarget, index).filter(
    (s) => !isClaimed(claimed, s + 1, s + leadTarget.length),
  );
  const leadPick = pickNearest(leadStarts, hint);
  if (leadPick !== null) {
    return {
      key: hunk.key,
      addStartLine: leadPick + firstAddIdx + 1,
      addEndLine: leadPick + lastAddIdx + 1,
      deletedLines: deletions,
    };
  }

  // Tier 3: trailing-context + additions. Mirror of tier 2 for the case
  // where leading context drifted.
  const tailEntries = entries.slice(firstAddIdx);
  const tailTarget = tailEntries.map((e) => e.text);
  const tailStarts = findExactRuns(buffer, tailTarget, index).filter(
    (s) => !isClaimed(claimed, s + 1, s + tailTarget.length),
  );
  const tailPick = pickNearest(tailStarts, hint);
  if (tailPick !== null) {
    return {
      key: hunk.key,
      addStartLine: tailPick + 1,
      addEndLine: tailPick + (lastAddIdx - firstAddIdx) + 1,
      deletedLines: deletions,
    };
  }

  // Tier 4: addition lines only. Last-resort; relies on proximity to disambiguate
  // when the addition matches multiple positions (the classic `}` problem).
  const addOnly = entries
    .slice(firstAddIdx, lastAddIdx + 1)
    .filter((e) => e.kind === 'addition')
    .map((e) => e.text);
  // Only safe when additions are contiguous in the chunk (no mid-chunk context).
  const additionsContiguous = entries
    .slice(firstAddIdx, lastAddIdx + 1)
    .every((e) => e.kind === 'addition');
  if (additionsContiguous && addOnly.length > 0) {
    const addStarts = findExactRuns(buffer, addOnly, index).filter(
      (s) => !isClaimed(claimed, s + 1, s + addOnly.length),
    );
    const addPick = pickNearest(addStarts, hint);
    if (addPick !== null) {
      return {
        key: hunk.key,
        addStartLine: addPick + 1,
        addEndLine: addPick + addOnly.length,
        deletedLines: deletions,
      };
    }
  }

  return null;
}

function anchorPureDeletion(lines: TurnEditLine[], strictStart: number): number {
  // Find the index (within the contexts-only sequence) of the first context
  // *after* the deletion run. That's where the deleted lines used to be.
  let contextIdx = 0;
  let seenDeletion = false;
  let firstTrailingContextIdx = -1;
  for (const line of lines) {
    if (line.type === 'deletion') {
      seenDeletion = true;
      continue;
    }
    // It's a context (additions are excluded by the pure-deletion guard).
    if (seenDeletion && firstTrailingContextIdx === -1) {
      firstTrailingContextIdx = contextIdx;
    }
    contextIdx += 1;
  }
  if (firstTrailingContextIdx === -1) {
    // Deletion was at the end of the chunk — anchor past the run.
    return strictStart + contextIdx + 1;
  }
  return strictStart + firstTrailingContextIdx + 1;
}

/**
 * Anchor every hunk to its location in the current buffer. Order matters:
 * hunks are processed in input order, and an earlier hunk's claim blocks
 * later hunks from matching the same lines.
 */
export function matchPendingHunks(
  bufferLines: string[],
  hunks: PendingHunkInput[],
): PendingHunkMatch[] {
  if (hunks.length === 0) return []; // ledger-only/legacy sessions: skip the O(buffer) index build
  const matches: PendingHunkMatch[] = [];
  const claimed: Array<{ start: number; end: number }> = [];
  const index = buildLineIndex(bufferLines);
  for (const hunk of hunks) {
    const m = matchOne(bufferLines, hunk, claimed, index);
    if (!m) continue;
    matches.push(m);
    claimed.push({
      start: m.addStartLine,
      end: Math.max(m.addStartLine, m.addEndLine),
    });
  }
  return matches;
}
