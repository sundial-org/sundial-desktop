'use client';

import { XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { brandForAgentId } from '@/lib/workspace/agent-brand';
import type { CollaboratorBadge } from './workspace-chat-model';

/**
 * Opens when a connected local-agent chip in the topbar is clicked. Shows the
 * agent and the human-side "Suggest only" switch — when on, every edit the
 * agent makes lands as a reviewable diff (and delete/rename/exec/uploads are
 * blocked), regardless of the token it holds.
 */
export function LocalAgentModeModal({
  agent,
  suggestOnly,
  saving,
  error,
  onClose,
  onSuggestOnlyChange,
}: {
  agent: CollaboratorBadge | null;
  suggestOnly: boolean;
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSuggestOnlyChange: (next: boolean) => void;
}) {
  const brand = brandForAgentId(agent?.agentId);
  return (
    <ModalShell
      open={Boolean(agent)}
      onClose={onClose}
      ariaLabel="Local agent settings"
      overlayClassName="fixed inset-0 z-[75] flex items-center justify-center bg-stone-950/50 backdrop-blur-sm p-4"
      panelClassName="w-full max-w-sm rounded-3xl bg-white border border-stone-200 shadow-2xl"
    >
      <div className="relative px-6 pb-6 pt-6">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-stone-400 transition-colors hover:text-stone-600"
        >
          <XIcon className="h-5 w-5" weight="regular" aria-hidden />
        </button>

        <div className="flex items-center gap-3">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{ backgroundColor: `${brand.color}1a` }}
          >
            {brand.logoPath ? (
              <img src={brand.logoPath} alt="" className="h-7 w-7 object-contain" draggable={false} />
            ) : (
              <span className="text-lg font-semibold" style={{ color: brand.color }}>
                {brand.label}
              </span>
            )}
          </div>
          <div>
            <h2 className="text-base font-semibold text-stone-900">{brand.displayName}</h2>
            <p className="text-xs text-stone-500">{agent?.name ?? agent?.agentId ?? ''} · connected</p>
          </div>
        </div>

        <label className="mt-5 flex cursor-pointer items-start justify-between gap-3 rounded-2xl border border-stone-200 px-4 py-3">
          <span className="text-sm">
            <span className="font-medium text-stone-900">Suggest only</span>
            <span className="mt-0.5 block text-xs text-stone-500">
              Every edit shows up as a reviewable diff you accept or reject, never a direct change.
              Delete, rename, and shell commands are blocked.
            </span>
          </span>
          <input
            type="checkbox"
            checked={suggestOnly}
            disabled={saving}
            onChange={(event) => onSuggestOnlyChange(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 rounded border-stone-300 accent-stone-900"
          />
        </label>

        {error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}
      </div>
    </ModalShell>
  );
}
