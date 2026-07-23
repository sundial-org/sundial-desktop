'use client';

import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import ReactMarkdown from 'react-markdown';
import { isMarkdownFile } from '@/lib/sync/policy';
import {
  DiffChunkActions,
  DiffChunkStatusPill,
  DiffCodeChunk,
  DiffMarkdownChunk,
} from '@/components/workspace/diff-review/diff-markdown-chunk';
import { splitDiffLinesByContext } from '@/components/workspace/diff-review/turn-edit-helpers';
import type { DiffChunk } from './types';

interface InlineDocDiffProps {
  chunk: DiffChunk;
  filePath?: string;
  onKeep: () => void;
  onUndo: () => void;
  /** Hide the inline Keep/Undo buttons when the host renders its own. */
  hideButtons?: boolean;
  /** Render the changed region as the editor's inline suggestion marks (chat
   *  card coherence). Off by default — other hosts keep the legacy render. */
  renderAsMarks?: boolean;
}

function isMarkdownPath(path?: string) {
  if (!path) return true; // legacy default
  return isMarkdownFile(path);
}

const CONTEXT_PROSE =
  'prose prose-sm prose-stone max-w-none px-2.5 text-stone-400 [&_*]:!text-stone-400';

function ContextBlock({ text, isMarkdown }: { text: string; isMarkdown: boolean }) {
  if (!text) return null;
  if (isMarkdown) {
    return (
      <div className={CONTEXT_PROSE}>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
          {text}
        </ReactMarkdown>
      </div>
    );
  }
  return (
    <pre className="m-0 whitespace-pre-wrap break-words px-2.5 font-mono text-[12px] leading-5 text-stone-400">
      {text}
    </pre>
  );
}

export function InlineDocDiff({ chunk, filePath, onKeep, onUndo, hideButtons = false, renderAsMarks = false }: InlineDocDiffProps) {
  const { leading, middle, trailing } = splitDiffLinesByContext(chunk.lines);
  const leadingText = leading.map((l) => l.content).join('\n');
  const trailingText = trailing.map((l) => l.content).join('\n');
  const renderAsMarkdown = isMarkdownPath(filePath);

  const isKept = chunk.status === 'kept';
  const isUndone = chunk.status === 'undone';

  const actions =
    hideButtons ? null : isKept ? (
      <DiffChunkStatusPill label="Kept" tone="kept" />
    ) : isUndone ? (
      <DiffChunkStatusPill label="Undone" tone="undone" />
    ) : (
      <DiffChunkActions onUndo={onUndo} onKeep={onKeep} />
    );

  return (
    <div className="not-prose">
      <ContextBlock text={leadingText} isMarkdown={renderAsMarkdown} />
      {middle.length > 0 ? (
        renderAsMarkdown ? (
          <DiffMarkdownChunk
            lines={middle}
            renderMarks={renderAsMarks}
            faded={isUndone ? 'addition' : null}
            actions={actions}
          />
        ) : (
          <DiffCodeChunk
            lines={middle}
            faded={isUndone ? 'addition' : null}
            actions={actions}
          />
        )
      ) : null}
      <ContextBlock text={trailingText} isMarkdown={renderAsMarkdown} />
    </div>
  );
}
