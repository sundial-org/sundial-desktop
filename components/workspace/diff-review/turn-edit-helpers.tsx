import type { TurnEditChunk, TurnEditFile } from '@/lib/workspace/turn-edits';
import { isMarkdownFile } from '@/lib/sync/policy';
import {
  buildLineChangeHighlights,
  buildRemovedLineHighlights,
  type TextRange,
} from '@/lib/workspace/inline-word-diff';

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

function countWords(line: string): number {
  const t = line.trim();
  return t ? t.split(/\s+/).length : 0;
}

function countWordsInRanges(line: string, ranges: TextRange[]): number {
  let n = 0;
  for (const r of ranges) {
    const seg = line.slice(r.start, r.end).trim();
    if (seg) n += seg.split(/\s+/).length;
  }
  return n;
}

// Word-level added/removed counts, computed from the SAME highlight ranges the
// diff renders — so "+8 −5" means eight words added, five removed (granular),
// not the block/line counts that read as "4 things changed". Falls back to line
// counts only for oversized files (no chunk lines to word-diff).
export function countFileWords(file: TurnEditFile): { added: number; deleted: number } {
  if (file.oversized || file.chunks.length === 0) {
    return { added: file.addedLineCount, deleted: file.deletedLineCount };
  }
  const markdown = isMarkdownFile(file.filePath);
  let added = 0;
  let deleted = 0;
  for (const chunk of file.chunks) {
    for (const h of buildLineChangeHighlights(chunk.lines, { markdown })) {
      added += countWordsInRanges(h.newLine, h.addedRanges);
    }
    for (const r of buildRemovedLineHighlights(chunk.lines, { markdown })) {
      // A pure deletion (a removed paragraph / deleted file) has no paired
      // addition to word-diff against, so `removedRanges` is empty — the whole
      // line was dropped, count all its words rather than reporting −0.
      const ranged = countWordsInRanges(r.delLine, r.removedRanges);
      deleted += ranged > 0 ? ranged : countWords(r.delLine);
    }
  }
  return { added, deleted };
}

export function formatTurnFileSummary(file: TurnEditFile) {
  const { added, deleted } = countFileWords(file);
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (deleted > 0) parts.push(`-${deleted}`);
  return parts.join(' ');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
      {verb} — file too large to show a diff{parts.length ? ` (${parts.join(', ')})` : ''}.
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
