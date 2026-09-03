import type { TurnEditChunk, TurnEditFile } from '@/lib/workspace/turn-edits';
import { formatBytes } from '@/lib/workspace/uploads';

export function splitDiffLinesByContext<T extends { type: string }>(lines: T[]) {
  let firstIdx = -1;
  let lastIdx = -1;
  lines.forEach((line, index) => {
    if (line.type !== 'context') {
      if (firstIdx === -1) firstIdx = index;
      lastIdx = index;
    }
  });
  if (firstIdx === -1) return { leading: lines, middle: [], trailing: [] };
  return {
    leading: lines.slice(0, firstIdx),
    middle: lines.slice(firstIdx, lastIdx + 1),
    trailing: lines.slice(lastIdx + 1),
  };
}

// Line-level added/removed counts, git-numstat style: the unit every diff
// reader already speaks, and the one count that always matches the rendered
// body (a green line is +1, a red line is −1). Replaced the word/char counters
// whose highlight-range arithmetic drifted from the renderer (#1126).
// Oversized/chunkless files fall back to the server-computed line counts.
export function countFileLines(file: TurnEditFile): { added: number; deleted: number } {
  if (file.oversized || file.chunks.length === 0) {
    return { added: file.addedLineCount, deleted: file.deletedLineCount };
  }
  let added = 0;
  let deleted = 0;
  for (const chunk of file.chunks) {
    for (const line of chunk.lines) {
      if (line.type === 'addition') added += 1;
      else if (line.type === 'deletion') deleted += 1;
    }
  }
  return { added, deleted };
}

/** Compact counts for card headers: 89, 1.2k, 14k. */
export function formatCompactCount(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatTurnFileSummary(file: TurnEditFile) {
  const { added, deleted } = countFileLines(file);
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (deleted > 0) parts.push(`-${deleted}`);
  return parts.join(' ');
}


// Placeholder shown for files too large to diff (`file.oversized`). Conveys the
// turn touched the file and roughly how big it is, without rendering content.
export function OversizedFileNotice({ file }: { file: TurnEditFile }) {
  const verb = file.isDeleted ? 'Deleted' : file.isNew ? 'Added' : 'Changed';
  const parts: string[] = [];
  if (typeof file.lineCount === 'number') {
    parts.push(`${file.lineCount.toLocaleString()} ${file.lineCount === 1 ? 'line' : 'lines'}`);
  }
  if (typeof file.byteSize === 'number') parts.push(formatBytes(file.byteSize));
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
      {verb}: file too large to show a diff{parts.length ? ` (${parts.join(', ')})` : ''}.
    </div>
  );
}

export function StaticChunk({ chunk }: { chunk: TurnEditChunk }) {
  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-stone-50">
      {chunk.lines.map((line, index) => {
        const toneClass =
          line.type === 'addition'
            ? 'diff-block-add diff-tone-add'
            : line.type === 'deletion'
              ? 'diff-block-del diff-tone-del'
              : 'text-stone-600';
        return (
          <div
            key={`${chunk.id}-${index}`}
            className={`flex items-start gap-3 px-3 py-1.5 font-mono text-[12px] leading-5 ${toneClass}`}
          >
            <span className="w-10 shrink-0 text-right text-stone-400 select-none">
              {line.lineNumber ?? ''}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line.content || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}
