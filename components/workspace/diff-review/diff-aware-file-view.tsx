'use client';

import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { Check, ArrowCounterClockwise } from '@phosphor-icons/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IconTooltip } from '@/components/collab-bubbles';
import { DiffCodeChunk, DiffMarkdownChunk } from '@/components/workspace/diff-review/diff-markdown-chunk';
import { splitDiffLinesByContext } from '@/components/workspace/diff-review/turn-edit-helpers';
import type { TurnEditChunk } from '@/lib/workspace/turn-edits';
import type { FilePendingTurn } from '@/lib/workspace/use-file-pending-turns';

export type DiffAwareFileViewHandle = {
  scrollToChunk: (assistantMessageId: string, chunkId: string) => void;
};

type ChunkRef = {
  assistantMessageId: string;
  createdAt: string | null;
  chunk: TurnEditChunk;
  isLatestTurn: boolean;
};

type Mode = 'prose' | 'mono';

interface Props {
  filePath: string;
  pendingTurns: FilePendingTurn[];
  latestAssistantMessageIdInChat: string | null;
  /** False hides Keep/Undo entirely (commenters / signed-out visitors — the
   *  keep/undo routes reject them, so don't render controls that 403). */
  canResolve?: boolean;
  activeUndoKey: string | null;
  onKeepChunk: (assistantMessageId: string, filePath: string, chunkId: string) => void;
  onUndoChunk: (assistantMessageId: string, filePath: string, chunkId: string) => void;
  /** Render mode — `prose` for markdown-style flowing text, `mono` for code/text files. */
  mode?: Mode;
  /** Show kept / undone chunks in addition to pending ones. */
  showResolvedChunks?: boolean;
}

function detectMode(filePath: string): Mode {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.txt')) return 'prose';
  return 'mono';
}

function ContextBlock({ text, mode }: { text: string; mode: Mode }) {
  if (!text) return null;
  if (mode === 'prose') {
    return (
      <div className="prose prose-sm prose-stone max-w-none px-4 py-1.5 text-stone-400 [&_*]:!text-stone-400 [&_p]:my-0 [&_p]:text-[13px] [&_p]:leading-6">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }
  return (
    <pre className="m-0 whitespace-pre-wrap break-words px-4 py-1 font-mono text-[12px] leading-5 text-stone-400">
      {text}
    </pre>
  );
}


export const DiffAwareFileView = forwardRef<DiffAwareFileViewHandle, Props>(
  function DiffAwareFileView(
    {
      filePath,
      pendingTurns,
      latestAssistantMessageIdInChat,
      canResolve = true,
      activeUndoKey,
      onKeepChunk,
      onUndoChunk,
      mode,
      showResolvedChunks = false,
    },
    ref,
  ) {
    const chunkRefs = useRef(new Map<string, HTMLDivElement | null>());
    const renderMode: Mode = mode ?? detectMode(filePath);

    useImperativeHandle(
      ref,
      () => ({
        scrollToChunk: (assistantMessageId: string, chunkId: string) => {
          const node = chunkRefs.current.get(`${assistantMessageId}:${chunkId}`);
          if (node instanceof HTMLDivElement) {
            node.scrollIntoView({ behavior: 'smooth', block: 'center' });
            node.classList.add('diff-deep-link-pulse');
            window.setTimeout(() => {
              node.classList.remove('diff-deep-link-pulse');
            }, 1400);
          }
        },
      }),
      [],
    );

    // Flatten chunks across all turns, optionally including already resolved ones.
    const chunkRefsList: ChunkRef[] = useMemo(() => {
      const result: ChunkRef[] = [];
      for (const turn of pendingTurns) {
        const file = turn.payload?.files.find((f) => f.filePath === filePath);
        if (!file) continue;
        const isLatestTurn = latestAssistantMessageIdInChat
          ? turn.assistantMessageId === latestAssistantMessageIdInChat
          : true;
        const sorted = [...file.chunks]
          .filter((c) => showResolvedChunks || c.status === 'pending')
          .sort((a, b) => a.newStart - b.newStart);
        for (const chunk of sorted) {
          result.push({
            assistantMessageId: turn.assistantMessageId,
            createdAt: turn.createdAt,
            chunk,
            isLatestTurn,
          });
        }
      }
      return result;
    }, [pendingTurns, filePath, latestAssistantMessageIdInChat, showResolvedChunks]);

    if (chunkRefsList.length === 0) return null;

    return (
      <div className="space-y-2">
        {chunkRefsList.map((cr) => {
          const undoKey = `${cr.assistantMessageId}:${filePath}:${cr.chunk.id}`;
          const undoActive = activeUndoKey === undoKey;
          const dimmed = activeUndoKey !== null && !undoActive;
          const showActions = canResolve && cr.chunk.status === 'pending';
          const { leading, middle, trailing } = splitDiffLinesByContext(cr.chunk.lines);
          const leadingText = leading.map((l) => l.content).join('\n');
          const trailingText = trailing.map((l) => l.content).join('\n');
          const statusLabel =
            cr.chunk.status === 'kept'
              ? 'Kept'
              : cr.chunk.status === 'undone'
                ? 'Undone'
                : !cr.isLatestTurn
                  ? 'Unreviewed'
                  : null;
          const statusToneClass =
            cr.chunk.status === 'kept'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : cr.chunk.status === 'undone'
                ? 'border-stone-200 bg-stone-100 text-stone-600'
                : 'border-orange-200 bg-orange-50 text-orange-700';
          const actions = showActions ? (
            <div className="flex items-center justify-end gap-1 border-t border-stone-100 bg-white px-2 py-1.5">
              <button
                type="button"
                aria-label="Keep this change"
                onClick={() => onKeepChunk(cr.assistantMessageId, filePath, cr.chunk.id)}
                disabled={activeUndoKey !== null}
                className="relative group/tip inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-stone-600 transition-colors hover:bg-emerald-50 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Check className="h-3.5 w-3.5" weight="bold" />
                Keep
                <IconTooltip label="Keep" />
              </button>
              <button
                type="button"
                aria-label="Undo this change"
                onClick={() => onUndoChunk(cr.assistantMessageId, filePath, cr.chunk.id)}
                disabled={activeUndoKey !== null}
                className="relative group/tip inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {undoActive ? (
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-stone-300 border-t-stone-500" />
                ) : (
                  <ArrowCounterClockwise className="h-3.5 w-3.5" weight="bold" />
                )}
                Undo
                <IconTooltip label="Undo" />
              </button>
            </div>
          ) : statusLabel ? (
            <div className="flex items-center justify-end border-t border-stone-100 bg-white px-2 py-1.5">
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusToneClass}`}
              >
                {statusLabel}
              </span>
            </div>
          ) : null;

          return (
            <div
              key={`${cr.assistantMessageId}-${cr.chunk.id}`}
              ref={(node) => {
                chunkRefs.current.set(`${cr.assistantMessageId}:${cr.chunk.id}`, node);
              }}
              className={`relative rounded-xl border border-stone-200 bg-white transition-opacity ${dimmed ? 'opacity-60' : ''} ${undoActive ? 'pointer-events-none opacity-60' : ''}`}
            >
              <ContextBlock text={leadingText} mode={renderMode} />
              {renderMode === 'prose' ? (
                <DiffMarkdownChunk
                  lines={middle}
                  actions={actions}
                />
              ) : (
                <DiffCodeChunk
                  lines={middle}
                  actions={actions}
                />
              )}
              <ContextBlock text={trailingText} mode={renderMode} />
            </div>
          );
        })}
      </div>
    );
  },
);
