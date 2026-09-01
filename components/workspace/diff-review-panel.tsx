'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowSquareOut, X } from '@phosphor-icons/react';
import { DiffReviewFlow } from '@/components/diff-review/diff-review-flow';
import { Spinner } from '@/components/ui/spinner';
import type { TurnEditsResponse } from '@/lib/workspace/turn-edits';

interface DiffReviewPanelProps {
  assistantMessageId: string;
  /** Optional href that opens the file directly in the workspace main editor (e.g. via existing handleFileClick). */
  workspaceHref?: string | null;
  /** Workspace title for the eyebrow. */
  workspaceTitle?: string | null;
  /** Omitted when the host owns the close affordance (as a pane tab, the tab's
   *  own × is the one way to shut it — a second X in the header is dead chrome). */
  onClose?: () => void;
}

export function DiffReviewPanel({
  assistantMessageId,
  workspaceHref,
  workspaceTitle,
  onClose,
}: DiffReviewPanelProps) {
  const [payload, setPayload] = useState<TurnEditsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspace/turn-edits?assistantMessageId=${encodeURIComponent(assistantMessageId)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Failed (${res.status}): ${t.slice(0, 160)}`);
      }
      setPayload((await res.json()) as TurnEditsResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load diff');
    } finally {
      setLoading(false);
    }
  }, [assistantMessageId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-stone-500">
            Reviewing diff
          </div>
          {payload ? (
            <div className="text-[12px] text-stone-700">
              {payload.files.length} {payload.files.length === 1 ? 'file' : 'files'} ·{' '}
              {payload.files.reduce(
                (sum, f) => sum + f.chunks.filter((c) => c.status === 'pending').length,
                0,
              )}{' '}
              pending
            </div>
          ) : null}
        </div>
        {workspaceHref ? (
          <a
            href={workspaceHref}
            className="inline-flex h-8 items-center gap-1 rounded text-[11px] text-stone-500 hover:text-stone-800"
            title="Open diff in standalone view"
          >
            <ArrowSquareOut className="h-3.5 w-3.5" weight="bold" />
          </a>
        ) : null}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close review"
            className="flex h-8 w-8 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-stone-800"
          >
            <X weight="bold" className="h-4 w-4" />
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <Spinner label="Loading diff…" center />
        ) : error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[13px] text-red-500">
            {error}
          </div>
        ) : payload && payload.files.length > 0 ? (
          <DiffReviewFlow
            assistantMessageId={assistantMessageId}
            initialPayload={payload}
            workspaceHref={null}
            readOnly={false}
            eyebrow={workspaceTitle ? `Diff · ${workspaceTitle}` : 'Diff review'}
            layout="mobile"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-[13px] text-stone-500">
            No pending edits to review.
          </div>
        )}
      </div>
    </div>
  );
}
