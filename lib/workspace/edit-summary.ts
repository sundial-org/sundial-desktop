import { isMarkdownFile } from '@/lib/sync/policy';
import type { TurnEditLine } from '@/lib/workspace/turn-edits';

/**
 * Per-file edit stats plus a compact human headline, for transport digests
 * (iMessage / Slack "Sunny edited 3 files (+12 −4)" summaries).
 */
export type FileEditStat = { path: string; added: number; deleted: number };

export type EditSummary = {
  /** Top files by churn, largest first. */
  files: FileEditStat[];
  totalAdded: number;
  totalDeleted: number;
  headline: string;
};

/** Count how many of the touched paths are markdown docs (per the sync policy). */
export function countMarkdownFiles(paths: string[]): number {
  return paths.filter((p) => isMarkdownFile(p)).length;
}

/** Tally hunk ops into added/deleted line counts for one file. */
export function tallyLines(lines: TurnEditLine[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of lines) {
    if (line.type === 'addition') added += 1;
    else if (line.type === 'deletion') deleted += 1;
  }
  return { added, deleted };
}

/** Cap a headline for transports with tight display limits. */
export function truncateHeadline(text: string, max = 80): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/** Slice out one page of file stats for paged digest UIs. */
export function pageOfFiles(files: FileEditStat[], page: number, size: number): FileEditStat[] {
  return files.slice(page * size, (page + 1) * size);
}

/**
 * Rank files by churn and produce the digest headline. `maxFiles` bounds how
 * many file names the headline spells out before collapsing to a count.
 */
export function summarizeEdits(stats: FileEditStat[], maxFiles = 3): EditSummary {
  const ranked = [...stats].sort((a, b) => b.added + b.deleted - (a.added + a.deleted));
  const totalAdded = ranked.reduce((n, s) => n + s.added, 0);
  const totalDeleted = ranked.reduce((n, s) => n + s.deleted, 0);
  const shown = ranked.slice(0, maxFiles);
  const names = shown.map((s) => s.path.split('/').pop() || s.path);
  const fileLabel =
    ranked.length <= maxFiles ? names.join(', ') : `${names.join(', ')} and ${ranked.length - maxFiles} more`;
  const headline = truncateHeadline(
    `Edited ${ranked.length} file${ranked.length > 1 ? 's' : ''} (+${totalAdded} −${totalDeleted}): ${fileLabel}`,
  );
  return { files: ranked, totalAdded, totalDeleted, headline };
}

/** Share of churn attributable to each file, as integer percentages. */
export function churnShare(stats: FileEditStat[]): Map<string, number> {
  const total = stats.reduce((n, s) => n + s.added + s.deleted, 0);
  const shares = new Map<string, number>();
  for (const s of stats) {
    shares.set(s.path, total === 0 ? 0 : Math.round(((s.added + s.deleted) / total) * 100));
  }
  return shares;
}
