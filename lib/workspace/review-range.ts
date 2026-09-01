// Pure helpers for the Review panel's range/compare model and chat handoff. No
// client- or server-only deps so both the panel and unit tests import it.
//
// The panel lists `ChangeEntry` rows (newest-first), each with `docEditId` = the
// doc state AFTER that change. "Compare a range" diffs the state before the older
// boundary against the state at the newer boundary, via /api/workspace/history/
// compare (which takes `doc_edits.id` from/to). Revise / Ask / Restore hand a
// preloaded prompt to the workspace chat (the `sundial:fill-composer` event).

import type { ChangeEntry } from './workspace-changes';
import type { InlineDiffLine } from './history-diff';

/** A doc_edits.id span for the compare endpoint. `from === null` ⇒ compare
 *  against the empty project (the older boundary is the start of history). */
export type DocEditRange = { from: number | null; to: number };

/**
 * Boundaries for the span between two entries (order-agnostic), derived from the
 * newest-first `entries` the panel already holds. `to` = the newer entry's
 * docEditId (state after it); `from` = the docEditId of the entry just OLDER than
 * the older boundary — i.e. the state immediately before it — or `null` when the
 * older boundary is the list's last entry.
 *
 * Caveat: the changes list is capped, so a range whose older edge is the last
 * listed entry compares against empty rather than the (unlisted) true
 * predecessor. Acceptable for v1; callers may show a "start of history" label.
 */
export function rangeDocEditIds(
  entries: readonly Pick<ChangeEntry, 'reviewId' | 'docEditId'>[],
  aReviewId: string,
  bReviewId: string,
): DocEditRange | null {
  const ia = entries.findIndex((e) => e.reviewId === aReviewId);
  const ib = entries.findIndex((e) => e.reviewId === bReviewId);
  if (ia < 0 || ib < 0) return null;
  // Newest-first ⇒ the larger index is the older entry. `|| null`: a comment
  // entry whose anchor probe found no doc edit carries docEditId 0 — as a
  // `from` boundary that means "start of history", not a real row id.
  const olderIdx = Math.max(ia, ib);
  const newerIdx = Math.min(ia, ib);
  return { to: entries[newerIdx]!.docEditId, from: entries[olderIdx + 1]?.docEditId || null };
}

const SESSION_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Collapse consecutive same-author entries (within a time window) into one
 * "session" run — a from→to span the panel shows as a single expandable row.
 * Input is newest-first; each returned run preserves that order. A lone entry is
 * a run of one (rendered as a normal row). Pure so it's unit-testable.
 *
 * `isBreak` marks entries that sever a run without joining one (the panel
 * passes its pending-suggestion predicate): a session click compares the span
 * across the FULL timeline, so two applied edits must never fuse across an
 * intervening suggestion the session heading wouldn't attribute.
 */
export function groupHistorySessions<
  T extends { author: { id: string | null; name: string }; createdAt: string | null },
>(entries: readonly T[], gapMs = SESSION_GAP_MS, isBreak?: (entry: T) => boolean): T[][] {
  const runs: T[][] = [];
  for (const entry of entries) {
    const current = runs[runs.length - 1];
    const prev = current?.[current.length - 1];
    const severed = (isBreak?.(entry) ?? false) || (!!prev && (isBreak?.(prev) ?? false));
    const sameAuthor = !!prev && prev.author.id === entry.author.id && prev.author.name === entry.author.name;
    const within = !!prev && Math.abs(Date.parse(prev.createdAt ?? '') - Date.parse(entry.createdAt ?? '')) <= gapMs;
    if (current && !severed && sameAuthor && within) current.push(entry);
    else runs.push([entry]);
  }
  return runs;
}

export type HandoffKind = 'revise' | 'ask' | 'restore';

/** Up to `max` of the most salient changed lines (removed then added), rendered
 *  as a `- `/`+ ` snippet for the composer. */
function diffSnippet(before: string, after: string, lines: InlineDiffLine[], max = 6): string {
  const changed = lines.filter((l) => l.type !== 'unchanged' && l.text.trim());
  const shown = (changed.length ? changed : lines).slice(0, max);
  return shown
    .map((l) => `${l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' '} ${l.text}`)
    .join('\n');
}

/**
 * The message the Review panel drops into the chat composer for a handoff. The
 * user completes it before sending — so it sets up context and stops short of an
 * instruction. `buildInlineDiff` is injected (the panel already imports it) to
 * keep this module free of the diff engine.
 */
export function buildHandoffPrompt(opts: {
  kind: HandoffKind;
  files: string[];
  /** `fromId`/`toId` are `doc_edits.id` anchors — quoted in the prompt so the
   *  agent can call `compare_document_versions` on the exact span instead of
   *  guessing from the human-readable labels. */
  range?: { fromLabel: string; toLabel: string; fromId?: number | null; toId?: number | null } | null;
  beforeAfter?: { before: string; after: string } | null;
  inlineDiff?: (before: string, after: string) => InlineDiffLine[];
}): string {
  const fileList = opts.files.length ? opts.files.join(', ') : 'the document';
  if (opts.kind === 'ask') {
    // A range → "what changed across this span"; a single change → "explain it".
    if (opts.range) {
      const { fromLabel, toLabel, fromId, toId } = opts.range;
      const anchor = toId != null ? ` (doc edits ${fromId ?? 'start'}\u2192${toId})` : '';
      return `What changed from ${fromLabel} to ${toLabel}?${anchor}`;
    }
    return `What does this change to ${fileList} do, and why?`;
  }
  const lead =
    opts.kind === 'restore'
      ? `Restore the change to ${fileList} onto the current version:`
      : `Revise the change to ${fileList}:`;
  const ba = opts.beforeAfter;
  if (ba && opts.inlineDiff) {
    const snippet = diffSnippet(ba.before, ba.after, opts.inlineDiff(ba.before, ba.after));
    if (snippet.trim()) return `${lead}\n\n\`\`\`diff\n${snippet}\n\`\`\`\n\n`;
  }
  return `${lead}\n\n`;
}

/** A run of consecutive diff lines, or a collapsed gap of unchanged lines — lets
 *  the range diff show each change with a little context and fold long untouched
 *  stretches into an expandable "… N unchanged lines" gutter. */
export type DiffSegment = { kind: 'lines'; lines: InlineDiffLine[] } | { kind: 'gap'; count: number };

export function collapseContext(lines: InlineDiffLine[], context = 2): DiffSegment[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (line.type === 'unchanged') return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) keep[j] = true;
  });
  const segments: DiffSegment[] = [];
  let run: InlineDiffLine[] = [];
  let gap = 0;
  const flushRun = () => { if (run.length) segments.push({ kind: 'lines', lines: run }); run = []; };
  const flushGap = () => { if (gap) segments.push({ kind: 'gap', count: gap }); gap = 0; };
  lines.forEach((line, i) => {
    if (keep[i]) { flushGap(); run.push(line); } else { flushRun(); gap += 1; }
  });
  flushRun();
  flushGap();
  return segments;
}
