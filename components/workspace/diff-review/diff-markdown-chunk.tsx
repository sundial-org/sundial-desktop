'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TurnEditLine } from '@/lib/workspace/turn-edits';
import {
  buildInlineMarkdownDiffHtmlFromLines,
  buildMarkedDiffHtmlFromLines,
  DIFF_MARKDOWN_SURFACE_CLASS,
} from '@/lib/workspace/diff-markdown-html';
import {
  buildLineChangeHighlights,
  buildRemovedLineHighlights,
  wrapAddedRangesHtml,
  wrapRemovedRangesHtml,
} from '@/lib/workspace/inline-word-diff';

type DiffMarkdownChunkProps = {
  /** Structured hunk lines drive block and word-level highlights. */
  lines: TurnEditLine[];
  faded?: 'addition' | null;
  actions?: ReactNode;
  className?: string;
  /** Render as the editor's inline suggestion marks (chat card) instead of the
   *  legacy block-decoration stack. Off by default so the review panel / file
   *  view (and their snapshots) are untouched. */
  renderMarks?: boolean;
};

export function DiffMarkdownChunk({
  lines,
  renderMarks = false,
  faded = null,
  actions = null,
  className = '',
}: DiffMarkdownChunkProps) {
  // `buildInlineMarkdownDiffHtmlFromLines` needs the DOM, so it returns '' during
  // SSR. Gate it on mount so the server + first client render emit identical
  // (empty) markup; the body then fills in after hydration instead of staying
  // blank (React won't re-run dangerouslySetInnerHTML on a hydration match).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const hasBody = lines.length > 0;
  // The chat card opts into the marks render so it matches the editor's inline
  // word-level green/red exactly (fallback to the legacy stack if the codec
  // can't produce marks); every other surface keeps the legacy render.
  const html = useMemo(() => {
    if (!mounted || !hasBody) return '';
    if (renderMarks) return buildMarkedDiffHtmlFromLines(lines) || buildInlineMarkdownDiffHtmlFromLines(lines);
    return buildInlineMarkdownDiffHtmlFromLines(lines);
  }, [mounted, hasBody, lines, renderMarks]);
  // React 19 resets `innerHTML` whenever the `dangerouslySetInnerHTML` object
  // identity changes, even if `__html` is value-equal — a fresh `{ __html }`
  // per render wipes and re-parses the whole diff DOM on every parent
  // re-render (visible flicker). Keyed on the string so the object only
  // changes when the markup actually does.
  const innerHtml = useMemo(() => ({ __html: html }), [html]);
  if (!hasBody && !actions) return null;

  const fadeClass = faded === 'addition' ? 'diff-inline-doc-chunk--fade-additions' : '';

  return (
    <div className={className}>
      <div className={`relative ${DIFF_MARKDOWN_SURFACE_CLASS} ${fadeClass}`.trim()}>
        {hasBody ? <div data-diff-body dangerouslySetInnerHTML={innerHtml} /> : null}
        {actions}
      </div>
    </div>
  );
}

/** Same React 19 caveat as above — keep the `__html` object stable per string. */
function StableHtmlPre({ html, className }: { html: string; className: string }) {
  const innerHtml = useMemo(() => ({ __html: html }), [html]);
  return <pre className={className} dangerouslySetInnerHTML={innerHtml} />;
}

type DiffCodeChunkProps = {
  lines: TurnEditLine[];
  faded?: 'addition' | null;
  actions?: ReactNode;
};

/** Code / plain-text hunks — Monaco visual language, not TipTap block decorations. */
export function DiffCodeChunk({
  lines,
  faded = null,
  actions = null,
}: DiffCodeChunkProps) {
  // Code/LaTeX surface — diff raw lines (no markdown stripping) so offsets
  // stay aligned to the indentation the highlight HTML renders.
  const highlights = buildLineChangeHighlights(lines, { markdown: false });
  const removed = buildRemovedLineHighlights(lines, { markdown: false });

  return (
    <div className="relative not-prose font-mono text-[12px] leading-5">
      {removed.map(({ delLine, removedRanges }, index) => (
        <div
          key={`del:${index}:${delLine}`}
          className={`monaco-diff-pending-deletion border-l-[3px] border-[var(--diff-del-border)] px-2 py-0.5 ${
            faded === 'addition' ? 'opacity-50' : ''
          }`}
        >
          <StableHtmlPre
            className="m-0 whitespace-pre-wrap break-words"
            html={delLine ? wrapRemovedRangesHtml(delLine, removedRanges) : '\u00a0'}
          />
        </div>
      ))}
      {highlights.map((line, index) => (
        <div
          key={`${index}:${line.newLine}`}
          className={`diff-code-addition border-l-[3px] border-[var(--diff-add-border)] bg-[var(--diff-add-bg)] px-2 py-0.5 ${
            faded === 'addition' ? 'opacity-50' : ''
          }`}
        >
          <StableHtmlPre
            className="m-0 whitespace-pre-wrap break-words text-stone-800"
            // Blank added lines keep a visible green row (mirrors the deletion
            // side) instead of collapsing to zero height.
            html={line.newLine ? wrapAddedRangesHtml(line.newLine, line.addedRanges) : '\u00a0'}
          />
        </div>
      ))}
      {actions}
    </div>
  );
}

export function DiffChunkActions({
  onUndo,
  onKeep,
  className = '',
}: {
  onUndo: () => void;
  onKeep: () => void;
  className?: string;
}) {
  return (
    <div className={`diff-pending-actions diff-pending-actions--float ${className}`.trim()}>
      <button
        type="button"
        className="diff-pending-undo"
        onClick={onUndo}
        aria-label="Undo suggestion"
        title="Undo suggestion"
      >
        ✕
      </button>
      <button
        type="button"
        className="diff-pending-keep"
        onClick={onKeep}
        aria-label="Keep suggestion"
        title="Keep suggestion"
      >
        ✓
      </button>
    </div>
  );
}

export function DiffChunkStatusPill({
  label,
  tone,
}: {
  label: string;
  tone: 'kept' | 'undone';
}) {
  const toneClass =
    tone === 'kept'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : 'border-stone-200 bg-stone-50 text-stone-600';
  return (
    <div className="diff-pending-actions diff-pending-actions--float">
      <span
        className={`inline-flex h-[22px] items-center rounded-md border px-2 text-[11px] font-medium leading-none ${toneClass}`}
      >
        {label}
      </span>
    </div>
  );
}
