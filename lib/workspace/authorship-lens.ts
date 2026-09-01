import type { AttributionPaintRange } from '@/components/workspace/collab-editor';
import type { FileBlameResponse } from '@/lib/workspace/api-shared-types';
import { COLOR_POOL, pickColor } from '@/components/collab-bubbles';

// Author band colors, by index into the `.doc-attribution-paint-N` CSS set.
// Skips slot 2 — it's amber, and the workspace surfaces don't use yellows.
const AUTHOR_BAND_COLORS = [0, 1, 3, 4, 5];

/** Band per author: their avatar chip's stable hash where free, but never the
 *  same band as another author in view — telling people apart is the point. */
function assignAuthorBands(authorLabels: string[]): Map<string, number> {
  const taken = new Set<number>();
  const byAuthor = new Map<string, number>();
  for (const label of authorLabels) {
    if (byAuthor.has(label)) continue;
    const preferred = Math.max(0, COLOR_POOL.indexOf(pickColor(label)));
    let index = AUTHOR_BAND_COLORS.length;
    for (let step = 0; step < AUTHOR_BAND_COLORS.length; step += 1) {
      const candidate = AUTHOR_BAND_COLORS[(preferred + step) % AUTHOR_BAND_COLORS.length];
      if (!taken.has(candidate)) {
        index = candidate;
        break;
      }
    }
    if (index === AUTHOR_BAND_COLORS.length) {
      index = AUTHOR_BAND_COLORS[byAuthor.size % AUTHOR_BAND_COLORS.length];
    }
    taken.add(index);
    byAuthor.set(label, index);
  }
  return byAuthor;
}

/**
 * Blame lines → paint ranges for the authorship lens: EVERY line banded in its
 * author's color, with an "Author · when" margin annotation. The painter
 * matches block text, so consecutive same-author lines merge visually and the
 * side label renders once per run (the extension dedups).
 */
export function buildAuthorshipRanges(
  lines: FileBlameResponse['lines'],
  opts: {
    resolveLabel: (authorId: string | null) => string;
    formatWhen: (createdAt: string | null) => string | null;
    /** Same avatar imagery as the suggestion chips (Sunny face, brand marks). */
    resolveVisual?: (line: FileBlameResponse['lines'][number]) => { imageUrl?: string | null; imageRound?: boolean } | null;
  },
): AttributionPaintRange[] {
  const labels = lines.map((line) => opts.resolveLabel(line.authorId));
  const bands = assignAuthorBands(labels);
  const ranges: AttributionPaintRange[] = [];
  // Which copy of a repeated block THIS line is, among the same turn's copies
  // (document order) — lets the hover card pick the introducing chunk for the
  // right duplicate instead of always the first (Codex, PR #1104 round 32).
  const occurrenceByTurnText = new Map<string, number>();
  lines.forEach((line, index) => {
    // EVERY occurrence, in document order — collapsing duplicates by text threw
    // away the per-copy provenance the blame walk computed, so repeated list
    // items / boilerplate all inherited the first copy's author (Codex, PR
    // #1104 round 10). The painter consumes same-text ranges in order.
    if (!line.text) return;
    if (line.redacted) {
      // Share-redacted: hold the occurrence slot so later same-text copies
      // align, but paint nothing and name no one.
      ranges.push({ key: `blame-${index}`, text: line.text, authorLabel: '', colorIndex: 0, hidden: true });
      return;
    }
    const authorLabel = labels[index];
    const when = opts.formatWhen(line.createdAt);
    const visual = opts.resolveVisual?.(line);
    ranges.push({
      key: `blame-${index}`,
      text: line.text,
      authorLabel,
      colorIndex: bands.get(authorLabel) ?? AUTHOR_BAND_COLORS[0],
      sideLabel: when ? `${authorLabel} · ${when}` : authorLabel,
      avatarUrl: visual?.imageUrl ?? null,
      avatarRound: visual?.imageRound,
      assistantMessageId: line.assistantMessageId,
      chatId: line.chatId,
      filePath: line.filePath ?? null,
      occurrence: (() => {
        const key = `${line.assistantMessageId ?? ''}|${line.text}`;
        const seen = occurrenceByTurnText.get(key) ?? 0;
        occurrenceByTurnText.set(key, seen + 1);
        return seen;
      })(),
    });
  });
  return ranges;
}

/**
 * Which text a rendered block may claim a blame range with.
 *
 * Blame describes the RESOLVED document, so a block under review (its accepted
 * projection differs from the raw text it currently holds) may only match on
 * that projection — never on the raw old+new text, which still carries struck
 * copies. Two ways that went wrong: a reviewed block consumed another copy's
 * occurrence and painted the wrong author on both (round 13), and a block a
 * pending deletion emptied fell back to its struck text and stole a surviving
 * line's range, leaving the real line dark (round 18). An emptied block claims
 * nothing.
 */
export function attributionMatchKey(rendered: string, accepted: string): string | null {
  if (accepted === rendered) return rendered || null;
  return accepted || null;
}
