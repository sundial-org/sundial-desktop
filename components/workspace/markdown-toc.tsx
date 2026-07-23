'use client';

import { ListIcon } from '@phosphor-icons/react';
import { type TocHeading } from '@/lib/markdown/toc';

// The current markdown file's table of contents, shown in the Outline lane.
// Renders nothing when the file has no headings. Each
// item's index maps to the Nth heading in the rendered `.tiptap` doc so the
// caller can scroll to it. Headings come from the caller (derived from the live
// editor doc) so the list always matches what's rendered.
export function MarkdownTOC({
  headings,
  onSelect,
}: {
  headings: TocHeading[];
  onSelect: (heading: TocHeading) => void;
}) {
  if (headings.length === 0) return null;
  return (
    <div
      data-testid="markdown-toc"
      className="min-h-0 flex-1 overflow-auto px-2 pb-2"
    >
      <div className="flex items-center gap-1.5 px-1 py-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-400">
        <ListIcon className="h-3 w-3" weight="bold" aria-hidden />
        Outline
      </div>
      <nav aria-label="Table of contents">
        {headings.map((heading) => (
          <button
            key={heading.index}
            type="button"
            data-testid="toc-item"
            data-level={heading.level}
            onClick={() => onSelect(heading)}
            title={heading.text}
            className="block w-full truncate rounded px-2 py-1 text-left text-[12px] leading-4 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
            style={{ paddingLeft: `${0.5 + (heading.level - 1) * 0.7}rem` }}
          >
            {heading.text}
          </button>
        ))}
      </nav>
    </div>
  );
}
