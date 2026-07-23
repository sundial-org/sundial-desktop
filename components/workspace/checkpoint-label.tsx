'use client';

import { useState } from 'react';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import { CheckIcon, TagIcon, XIcon } from '@phosphor-icons/react';
import type { HistoryLabel } from '@/lib/workspace/api-shared-types';

/**
 * Checkpoint a tracked change — a manual name pinned to a single `doc_edits.id`
 * (the document state after that edit). Stored as a history label (one per
 * point: unique `(workspace_id, doc_edit_id)`), surfaced in the Review panel so
 * a reviewer can mark and find notable points. Lifted out of the retired
 * version-history modal; the underlying API is unchanged.
 */
export function CheckpointLabel({
  projectId,
  docEditId,
  label,
  onLabelsChanged,
}: {
  projectId: string | null;
  docEditId: number | null;
  label?: HistoryLabel | null;
  onLabelsChanged?: () => void;
}) {
  const apiFetch = useApiFetch();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'done' | 'error'; message: string } | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');

  if (!projectId || !docEditId) return null;

  const saveLabel = async () => {
    const name = labelDraft.trim();
    if (!name) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await apiFetch('/api/workspace/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId, docEditId, name }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'Failed to save checkpoint');
      setLabelOpen(false);
      setLabelDraft('');
      onLabelsChanged?.();
    } catch (caught) {
      setStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : 'Failed to save checkpoint',
      });
    } finally {
      setBusy(false);
    }
  };

  const removeLabel = async () => {
    if (!label) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await apiFetch(
        `/api/workspace/labels?projectId=${encodeURIComponent(projectId)}&id=${encodeURIComponent(label.id)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'Failed to remove checkpoint');
      onLabelsChanged?.();
    } catch (caught) {
      setStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : 'Failed to remove checkpoint',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      {status ? (
        <span className={status.tone === 'error' ? 'text-rose-600' : 'text-emerald-600'}>
          {status.message}
        </span>
      ) : null}
      {labelOpen ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={labelDraft}
            onChange={(event) => setLabelDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveLabel();
              if (event.key === 'Escape') setLabelOpen(false);
            }}
            placeholder="Checkpoint name"
            disabled={busy}
            className="w-32 rounded-md border border-stone-300 px-2 py-1 text-xs focus:border-indigo-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void saveLabel()}
            disabled={busy || !labelDraft.trim()}
            aria-label="Save checkpoint"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-indigo-600 text-white transition-colors hover:bg-indigo-500 disabled:opacity-60"
          >
            <CheckIcon className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setLabelOpen(false)}
            disabled={busy}
            aria-label="Cancel checkpoint"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-stone-500 transition-colors hover:text-stone-800"
          >
            <XIcon className="h-3.5 w-3.5" aria-hidden />
          </button>
        </span>
      ) : label ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-0.5 pl-2 pr-1 text-indigo-700">
          <TagIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="max-w-[140px] truncate font-medium">{label.name}</span>
          <button
            type="button"
            onClick={() => void removeLabel()}
            disabled={busy}
            aria-label="Remove checkpoint"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-indigo-400 transition-colors hover:bg-indigo-100 hover:text-indigo-700"
          >
            <XIcon className="h-3 w-3" aria-hidden />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => {
            setStatus(null);
            setLabelDraft('');
            setLabelOpen(true);
          }}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
        >
          <TagIcon className="h-3.5 w-3.5" aria-hidden />
          Checkpoint
        </button>
      )}
    </div>
  );
}
