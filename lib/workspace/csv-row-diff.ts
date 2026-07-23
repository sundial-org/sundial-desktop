import type { PendingAddition } from '@/components/workspace/collab-editor';
import type { TurnEditLine } from '@/lib/workspace/turn-edits';

/**
 * Row-level diff for the CSV/TSV table viewer, derived from the same pending
 * additions the editors consume. Each chunk's ordered hunk ops (`lines`) are
 * spliced back onto the base rows by matching the chunk's "old side"
 * (context + deletions) so added / deleted / modified rows render in place —
 * the table equivalent of the markdown inline diff.
 */
/** The pending suggestion a changed row came from — drives its inline Keep/Discard. */
export type CsvRowSource = { key: string; groupKey?: string; authorLabel?: string; canMutate: boolean };

export type CsvDiffRow =
  | { kind: 'unchanged'; cells: string[] }
  | { kind: 'added' | 'deleted'; cells: string[]; source?: CsvRowSource }
  | { kind: 'modified'; oldCells: string[]; newCells: string[]; source?: CsvRowSource };

export type CsvDiff = {
  /** New-side column labels. */
  header: string[];
  /** Provenance of the header row itself (e.g. a column rename). */
  headerKind: 'unchanged' | 'added' | 'deleted' | 'modified';
  /** Old column labels, set only when the header row was modified. */
  headerOldCells?: string[];
  /** Source suggestion when the header row itself changed (e.g. a column rename). */
  headerSource?: CsvRowSource;
  rows: CsvDiffRow[];
  addedCount: number;
  deletedCount: number;
  modifiedCount: number;
};

type Entry =
  | { kind: 'unchanged'; raw: string }
  | { kind: 'added' | 'deleted'; raw: string; source?: CsvRowSource }
  | { kind: 'modified'; oldRaw: string; newRaw: string; source?: CsvRowSource };

function matchesAt(hay: string[], needle: string[], i: number): boolean {
  for (let j = 0; j < needle.length; j += 1) {
    if (hay[i + j] !== needle[j]) return false;
  }
  return true;
}

/**
 * First match of `needle` at or after `from`. When `prefer` is given (the
 * chunk's `newStart` line), return the match nearest to it instead — so a
 * suggestion targeting a later duplicate row anchors to that occurrence, not
 * the first identical block.
 */
function findSeq(hay: string[], needle: string[], from: number, prefer?: number): number {
  if (needle.length === 0) return -1;
  let best = -1;
  let bestDist = Infinity;
  for (let i = from; i + needle.length <= hay.length; i += 1) {
    if (!matchesAt(hay, needle, i)) continue;
    if (prefer == null) return i;
    const dist = Math.abs(i - prefer);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * Emit a hunk's rows, pairing consecutive deletion/addition runs into modified
 * rows. Emission is position-aware: `pos` tracks the base-row index of each
 * present-side row (context plus the matched side's changes — additions when
 * `presentIsNew`, deletions otherwise). Rows whose position is below `minPos`
 * were already emitted by an adjacent overlapping hunk and are skipped — so a
 * shared context window is dropped without ever discarding a change op (the
 * bug a naive `ops.slice` count had). `emitContext: false` suppresses context
 * rows for the addition-only fallback, where context isn't reliably positioned.
 */
/**
 * Pair deletions to additions within one run by row similarity, not position.
 * A 1-for-1 run is always a modify (a single-column value change has no shared
 * cell to match on). Otherwise an addition pairs with the deletion that shares
 * its key (first cell) or a majority of cells — so "delete row A, change row B"
 * renders as a clean delete + a modify, instead of pairing A's deletion with
 * B's addition positionally. Unpaired rows stay pure delete / add.
 */
function pairRuns(
  dels: string[],
  adds: string[],
  splitCells: (line: string) => string[],
): { pairs: [number, number][]; soloDels: number[]; soloAdds: number[] } {
  if (dels.length <= 1 && adds.length <= 1) {
    const pairs: [number, number][] = dels.length === 1 && adds.length === 1 ? [[0, 0]] : [];
    return {
      pairs,
      soloDels: dels.length === 1 && adds.length === 0 ? [0] : [],
      soloAdds: adds.length === 1 && dels.length === 0 ? [0] : [],
    };
  }
  const delCells = dels.map(splitCells);
  const usedDel = new Set<number>();
  const pairs: [number, number][] = [];
  const soloAdds: number[] = [];
  adds.forEach((add, a) => {
    const aCells = splitCells(add);
    let best = -1;
    let bestScore = 0;
    for (let d = 0; d < dels.length; d += 1) {
      if (usedDel.has(d)) continue;
      const dCells = delCells[d]!;
      const n = Math.max(aCells.length, dCells.length);
      let same = 0;
      for (let k = 0; k < n; k += 1) if ((aCells[k] ?? '') === (dCells[k] ?? '')) same += 1;
      const keyMatch = aCells.length > 0 && (aCells[0] ?? '') === (dCells[0] ?? '');
      if ((keyMatch || 2 * same >= n) && same > bestScore) {
        bestScore = same;
        best = d;
      }
    }
    if (best >= 0) {
      usedDel.add(best);
      pairs.push([best, a]);
    } else {
      soloAdds.push(a);
    }
  });
  const soloDels = dels.map((_, d) => d).filter((d) => !usedDel.has(d));
  return { pairs, soloDels, soloAdds };
}

function pushHunk(
  ops: TurnEditLine[],
  out: Entry[],
  startPos: number,
  minPos: number,
  presentIsNew: boolean,
  splitCells: (line: string) => string[],
  source: CsvRowSource | undefined,
  emitContext = true,
): void {
  let pos = startPos;
  let i = 0;
  const live = () => pos >= minPos;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.type === 'context') {
      if (emitContext && live()) out.push({ kind: 'unchanged', raw: op.content });
      pos += 1;
      i += 1;
      continue;
    }
    const dels: string[] = [];
    while (i < ops.length && ops[i]!.type === 'deletion') {
      dels.push(ops[i]!.content);
      i += 1;
    }
    const adds: string[] = [];
    while (i < ops.length && ops[i]!.type === 'addition') {
      adds.push(ops[i]!.content);
      i += 1;
    }
    const { pairs, soloAdds } = pairRuns(dels, adds, splitCells);
    const addForDel = new Map<number, number>();
    for (const [d, a] of pairs) addForDel.set(d, a);
    // Walk deletions in file order so a solo deletion before a modification
    // renders above it (a paired deletion → modified row, a solo one →
    // deleted row); pure insertions follow.
    for (let d = 0; d < dels.length; d += 1) {
      const a = addForDel.get(d);
      if (a !== undefined) {
        if (live()) out.push({ kind: 'modified', oldRaw: dels[d]!, newRaw: adds[a]!, source });
        pos += 1; // a modified pair occupies exactly one present-side base row
      } else {
        if (live()) out.push({ kind: 'deleted', raw: dels[d]!, source });
        if (!presentIsNew) pos += 1; // deletions are present only in a pre-edit doc
      }
    }
    for (const a of soloAdds) {
      if (live()) out.push({ kind: 'added', raw: adds[a]!, source });
      if (presentIsNew) pos += 1; // additions are present only in a post-edit doc
    }
  }
}

export function computeCsvDiffRows(
  baseContent: string,
  additions: (Pick<PendingAddition, 'lines'> &
    Partial<Pick<PendingAddition, 'newStart' | 'key' | 'groupKey' | 'authorLabel' | 'canMutate'>>)[],
  splitCells: (line: string) => string[],
): CsvDiff | null {
  // Drop empty lines so the header (first non-empty row) lands at out[0],
  // matching the table's `skipEmptyLines` parse — otherwise a leading blank
  // line would be treated as the header and shift the whole diff. Track blanks
  // removed before each original line so `newStart` (in original-line space)
  // can be mapped into the filtered array for duplicate-row disambiguation.
  const originalLines = baseContent.replace(/\r\n/g, '\n').split('\n');
  const baseLines: string[] = [];
  const blanksBefore: number[] = [0];
  for (let i = 0; i < originalLines.length; i += 1) {
    if (originalLines[i] === '') blanksBefore.push(blanksBefore[i]! + 1);
    else {
      baseLines.push(originalLines[i]!);
      blanksBefore.push(blanksBefore[i]!);
    }
  }
  if (baseLines.length === 0) return null;
  const toFilteredLine = (orig: number | undefined): number | undefined => {
    if (orig == null) return undefined;
    const clamped = Math.max(0, Math.min(orig, originalLines.length));
    return orig - blanksBefore[clamped]!;
  };

  const chunks = additions
    .filter((a): a is typeof a & { lines: TurnEditLine[] } => Array.isArray(a.lines) && a.lines.length > 0)
    .map((a) => {
      // Drop blank lines from the hunk ops too, so they match `baseLines` — a
      // blank context line would otherwise break the sequence match and
      // suppress the whole hunk.
      const ops = a.lines.filter((o) => o.content !== '');
      return {
        ops,
        newStart: toFilteredLine(typeof a.newStart === 'number' ? a.newStart : undefined),
        newSeq: ops.filter((o) => o.type !== 'deletion').map((o) => o.content),
        oldSeq: ops.filter((o) => o.type !== 'addition').map((o) => o.content),
        source: a.key
          ? { key: a.key, groupKey: a.groupKey, authorLabel: a.authorLabel, canMutate: a.canMutate ?? true }
          : undefined,
      };
    })
    .filter((c) => c.ops.length > 0);
  if (chunks.length === 0) return null;

  // Pending turns arrive newest-first, so chunks aren't in file order. The
  // splice below advances `baseIdx` monotonically, so probe each chunk's
  // position up front (using its `newStart` hint to disambiguate duplicate
  // rows) and process them top-to-bottom — otherwise an earlier-in-the-file
  // hunk supplied second can't anchor and is dropped. A hunk whose context
  // drifted (neither full side contiguous) is positioned by its addition rows
  // and marked `drifted`, so it sorts before a full-match hunk at the same
  // spot and can claim its changed row before that hunk consumes it as context.
  const probePosition = (c: (typeof chunks)[number]): { pos: number; drifted: boolean } => {
    const ns = findSeq(baseLines, c.newSeq, 0, c.newStart);
    if (ns >= 0) return { pos: ns, drifted: false };
    const os = findSeq(baseLines, c.oldSeq, 0, c.newStart);
    if (os >= 0) return { pos: os, drifted: false };
    const addSeq = c.ops.filter((o) => o.type === 'addition').map((o) => o.content);
    const at = findSeq(baseLines, addSeq, 0, c.newStart);
    if (at >= 0) return { pos: at, drifted: true };
    // Nothing to anchor on (a pure row deletion has no additions and its rows
    // are already gone). Fall back to the `newStart` hint so multiple pure
    // deletions still sort by file position instead of all colliding at the
    // end — otherwise an out-of-order pair renders ghosts in the wrong place.
    return { pos: c.newStart ?? Number.MAX_SAFE_INTEGER, drifted: true };
  };
  const orderedChunks = chunks
    .map((c) => ({ c, ...probePosition(c) }))
    .sort((a, b) => a.pos - b.pos || (a.drifted === b.drifted ? 0 : a.drifted ? -1 : 1))
    .map((x) => x.c);

  const out: Entry[] = [];
  let baseIdx = 0;
  for (const { ops, newSeq, oldSeq, newStart, source } of orderedChunks) {
    // `baseContent` is the LIVE doc. Anchor on whichever side is present in it:
    // the new side (context + additions) in a post-edit doc, the old side
    // (context + deletions) in a pre-edit doc. Both can match (a deletion hunk's
    // new side is context-only), so prefer the LONGER match — the shorter,
    // context-only one under-consumes and leaves a changed row to be re-emitted
    // as unchanged by the next hunk. `newStart` picks the right occurrence when
    // rows repeat.
    const pick = (from: number): { start: number; seq: string[] } => {
      const ns = findSeq(baseLines, newSeq, from, newStart);
      const os = findSeq(baseLines, oldSeq, from, newStart);
      if (ns >= 0 && os >= 0) {
        // With duplicate blocks the two sides can match different occurrences
        // (the new side at the edited spot, the old side at an untouched
        // duplicate). Prefer the match nearest `newStart`; only when they're
        // equidistant (e.g. both anchored on the same context) fall back to the
        // longer, more-complete side.
        if (newStart != null) {
          const dn = Math.abs(ns - newStart);
          const dosi = Math.abs(os - newStart);
          if (dn !== dosi) return dn < dosi ? { start: ns, seq: newSeq } : { start: os, seq: oldSeq };
        }
        return newSeq.length >= oldSeq.length ? { start: ns, seq: newSeq } : { start: os, seq: oldSeq };
      }
      if (ns >= 0) return { start: ns, seq: newSeq };
      if (os >= 0) return { start: os, seq: oldSeq };
      return { start: -1, seq: newSeq };
    };
    // Adjacent hunks (often from different turns) share context rows, so an
    // earlier hunk may have already consumed this one's leading context — retry
    // from the top and skip the overlap below.
    let { start, seq: matchedSeq } = pick(baseIdx);
    if (start < 0) ({ start, seq: matchedSeq } = pick(0));
    if (start < 0) {
      // Context drifted (e.g. a later turn inserted/removed a row inside this
      // hunk's context window), so neither full side is contiguous. Anchor on
      // the addition rows alone — they're present in the post-edit doc — and
      // render only the changes; surrounding rows come from `baseLines`. If
      // there are no additions either, the hunk is stale: suppress it like the
      // source editor drops stale decorations rather than show a phantom row.
      const addSeq = ops.filter((o) => o.type === 'addition').map((o) => o.content);
      const addStart = findSeq(baseLines, addSeq, baseIdx, newStart);
      if (addStart >= 0) {
        for (let k = baseIdx; k < addStart; k += 1) out.push({ kind: 'unchanged', raw: baseLines[k]! });
        pushHunk(ops, out, addStart, baseIdx, true, splitCells, source, false);
        baseIdx = Math.max(baseIdx, addStart + addSeq.length);
        continue;
      }
      // Pure row deletion: the removed rows are already gone from the post-edit
      // doc and there are no additions to anchor on, so neither match nor the
      // addition fallback fires. Drop a red deletion ghost at `newStart` so the
      // user still sees (and can Keep/Discard) their staged row removal, rather
      // than the row silently vanishing.
      const delLines = ops.filter((o) => o.type === 'deletion');
      if (delLines.length > 0) {
        const at =
          newStart != null ? Math.max(baseIdx, Math.min(newStart, baseLines.length)) : baseLines.length;
        for (let k = baseIdx; k < at; k += 1) out.push({ kind: 'unchanged', raw: baseLines[k]! });
        baseIdx = at;
        for (const d of delLines) out.push({ kind: 'deleted', raw: d.content, source });
        continue;
      }
      continue;
    }
    // Emit the gap before this hunk, then the hunk itself. `pushHunk` skips any
    // rows below `baseIdx` (a shared context window an adjacent hunk already
    // emitted) without dropping changes.
    for (let k = baseIdx; k < start; k += 1) out.push({ kind: 'unchanged', raw: baseLines[k]! });
    pushHunk(ops, out, start, baseIdx, matchedSeq === newSeq, splitCells, source, true);
    baseIdx = Math.max(baseIdx, start + matchedSeq.length);
  }
  for (let k = baseIdx; k < baseLines.length; k += 1) out.push({ kind: 'unchanged', raw: baseLines[k]! });

  if (out.length === 0) return null;

  let addedCount = 0;
  let deletedCount = 0;
  let modifiedCount = 0;
  const bump = (kind: Entry['kind']) => {
    if (kind === 'added') addedCount += 1;
    else if (kind === 'deleted') deletedCount += 1;
    else if (kind === 'modified') modifiedCount += 1;
  };

  // The first row is the table header. Surface its own change (e.g. a column
  // rename) instead of dropping it — otherwise a header-only edit shows no diff.
  const headerEntry = out[0]!;
  const headerKind = headerEntry.kind;
  const header = splitCells(headerEntry.kind === 'modified' ? headerEntry.newRaw : headerEntry.raw);
  const headerOldCells = headerEntry.kind === 'modified' ? splitCells(headerEntry.oldRaw) : undefined;
  const headerSource = headerEntry.kind !== 'unchanged' ? headerEntry.source : undefined;
  bump(headerKind);

  const rows: CsvDiffRow[] = out.slice(1).map((e) => {
    bump(e.kind);
    if (e.kind === 'modified') {
      return { kind: 'modified', oldCells: splitCells(e.oldRaw), newCells: splitCells(e.newRaw), source: e.source };
    }
    if (e.kind === 'unchanged') return { kind: 'unchanged', cells: splitCells(e.raw) };
    return { kind: e.kind, cells: splitCells(e.raw), source: e.source };
  });

  if (addedCount === 0 && deletedCount === 0 && modifiedCount === 0) return null;
  return { header, headerKind, headerOldCells, headerSource, rows, addedCount, deletedCount, modifiedCount };
}
