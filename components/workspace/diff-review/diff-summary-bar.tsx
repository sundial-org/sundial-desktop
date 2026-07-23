'use client';

import { useState, type ReactNode } from 'react';
import type { FileDiff } from './types';

interface DiffSummaryBarProps {
  files: FileDiff[];
  onKeepAll: () => void;
  onUndoAll: () => void;
  onSelectFile: (filePath: string) => void;
  selectedFilePath?: string;
  /** Extra action rendered on the right side of the summary row, after
   *  Keep all / Undo all (or alone when all changes are resolved). */
  extraAction?: ReactNode;
  /** Hide the in-bar Keep all / Undo all (the host renders them elsewhere,
   *  e.g. the Review panel's verb bar). */
  hideBulkActions?: boolean;
}

export function DiffSummaryBar({
  files,
  onKeepAll,
  onUndoAll,
  onSelectFile,
  selectedFilePath,
  extraAction,
  hideBulkActions,
}: DiffSummaryBarProps) {
  const [expanded, setExpanded] = useState(true);

  const totalPending = files.reduce(
    (sum, f) => sum + f.chunks.filter(c => c.status === 'pending').length,
    0,
  );
  // Chunkless placeholders (oversized / blob) are still real edits the turn
  // made — keep them listed and selectable, or a text+image turn would give
  // the image no UI path at all in the card/panel selector.
  const filesWithChanges = files.filter(f => f.chunks.length > 0 || f.oversized || f.blob);
  const allResolved = totalPending === 0;

  return (
    <div className="border-b border-stone-200 bg-stone-50/80">
      {/* Summary row */}
      <div className="flex items-center justify-between px-4 py-1.5">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-xs text-stone-600 hover:text-stone-800 transition-colors"
        >
          <svg
            className={`h-3 w-3 text-stone-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {allResolved ? (
            <span className="text-stone-400">All changes reviewed</span>
          ) : (
            <span>
              <span className="font-medium">{totalPending}</span>
              {' '}{totalPending === 1 ? 'change' : 'changes'}
              {' · '}
              <span className="font-medium">{filesWithChanges.length}</span>
              {' '}{filesWithChanges.length === 1 ? 'file' : 'files'}
            </span>
          )}
        </button>

        <div className="flex items-center gap-2">
          {!allResolved && !hideBulkActions && (
            <>
              <button
                onClick={onKeepAll}
                className="px-2.5 py-1 rounded border border-green-300 bg-green-50 text-[11px] font-medium text-green-700 hover:bg-green-100 transition-colors flex items-center gap-1.5"
              >
                Keep all
                <kbd className="px-1 py-0.5 rounded bg-white/80 text-[9px] text-green-600 font-mono border border-green-200">⇧D</kbd>
              </button>
              <button
                onClick={onUndoAll}
                className="px-2.5 py-1 rounded border border-stone-200 text-[11px] font-medium text-stone-500 hover:bg-stone-50 transition-colors flex items-center gap-1.5"
              >
                Undo all
                <kbd className="px-1 py-0.5 rounded bg-white/80 text-[9px] text-stone-400 font-mono border border-stone-200">⇧K</kbd>
              </button>
            </>
          )}
          {extraAction}
        </div>
      </div>

      {/* Expanded file list */}
      {expanded && (
        <div className="border-t border-stone-200 py-1 max-h-32 overflow-auto">
          {filesWithChanges.map((file) => {
            const pending = file.chunks.filter(c => c.status === 'pending').length;
            return (
              <button
                key={file.id}
                onClick={() => onSelectFile(file.filePath)}
                className={`w-full flex items-center justify-between px-4 py-1.5 text-left transition-colors ${
                  selectedFilePath === file.filePath ? 'bg-stone-100' : 'hover:bg-stone-100'
                }`}
              >
                <div className="flex items-center gap-2">
                  <svg
                    className="h-3.5 w-3.5 text-stone-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                  <span className="font-mono text-xs text-stone-600">{file.filePath}</span>
                </div>
                {pending > 0 ? (
                  <span className="text-[10px] text-stone-400">
                    {pending} unreviewed
                  </span>
                ) : file.chunks.length > 0 ? (
                  <span className="text-[10px] text-stone-400">reviewed</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
