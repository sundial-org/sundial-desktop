'use client';

import { useState } from 'react';
import { FileTextIcon, XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { IconTooltip } from '@/components/collab-bubbles';
import type { LinkedRepoSummary } from '@/lib/workspace/use-linked-repos';

// Visual badge for files/folders that live inside a linked repo. Renders the
// provider icon plus a tiny status dot — green when clean, amber when dirty,
// purple when ahead, blue when behind. The Commits rail and the JIT modal
// reuse the same color taxonomy so users can carry meaning across the UI.
// Clicking opens the wireframe's git modal: repo link, branch/tracking info,
// last-synced + unpushed state (whatever the linked-repo API returned).

const PROVIDER_LABEL: Record<LinkedRepoSummary['provider'], string> = {
  github: 'GitHub',
  overleaf: 'Overleaf',
};

/** Wireframe repo glyph: a git commit graph ("Tracks a GitHub remote"). */
function RepoGraphGlyph({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden>
      <circle cx="5" cy="4" r="1.7" />
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="11.5" cy="6.5" r="1.7" />
      <path d="M5 5.7v4.6M11.5 8.2c0 2.2-2.5 2.3-4.4 2.6" />
    </svg>
  );
}

function formatSyncedAt(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function GitModal({ repo, onClose }: { repo: LinkedRepoSummary; onClose: () => void }) {
  const status = repo.syncStatus;
  const branch = status?.branch ?? repo.currentBranch ?? repo.defaultBranch;
  const branchLine = [
    branch ? `branch ${branch}` : null,
    repo.defaultBranch ? `tracking origin/${repo.defaultBranch}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const syncedAt = status ? formatSyncedAt(status.updatedAt) : null;
  const stateLine = [
    syncedAt ? `last synced ${syncedAt}` : null,
    status && status.ahead > 0
      ? `${status.ahead} local commit${status.ahead === 1 ? '' : 's'} not pushed`
      : null,
    status && status.behind > 0 ? `${status.behind} behind remote` : null,
    status && status.dirty > 0
      ? `${status.dirty} file${status.dirty === 1 ? '' : 's'} with local changes`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <ModalShell open onClose={onClose} ariaLabel={PROVIDER_LABEL[repo.provider]}>
      <div className="p-4" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-stone-800">{PROVIDER_LABEL[repo.provider]}</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="relative group/tip flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
          >
            <XIcon className="h-4 w-4" weight="bold" aria-hidden />
            <IconTooltip label="Close" />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2.5 rounded-lg px-1 py-1.5">
          <RepoGraphGlyph className="h-4 w-4 shrink-0 text-stone-500" />
          <div className="min-w-0">
            {repo.htmlUrl ? (
              <a
                href={repo.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-sm text-stone-800 hover:underline"
              >
                {repo.htmlUrl.replace(/^https?:\/\//, '')}
              </a>
            ) : (
              <div className="truncate text-sm text-stone-800">{repo.repoLabel}</div>
            )}
            {branchLine ? <div className="truncate text-xs text-stone-500">{branchLine}</div> : null}
          </div>
        </div>
        {stateLine ? <div className="px-1 pb-1 text-xs text-stone-500">{stateLine}</div> : null}
      </div>
    </ModalShell>
  );
}

export function LinkedRepoBadge({
  repo,
  variant = 'inline',
}: {
  repo: LinkedRepoSummary;
  variant?: 'inline' | 'header';
}) {
  const [showModal, setShowModal] = useState(false);
  const status = repo.syncStatus;
  const dot =
    status && status.dirty > 0
      ? { color: 'bg-amber-500', label: `${status.dirty} dirty` }
      : status && status.ahead > 0
        ? { color: 'bg-violet-500', label: `${status.ahead} ahead` }
        : status && status.behind > 0
          ? { color: 'bg-sky-500', label: `${status.behind} behind` }
          : { color: 'bg-emerald-500', label: 'clean' };

  // Wireframe icon language: repo-linked = git-graph glyph (Overleaf keeps
  // its document icon).
  const icon =
    repo.provider === 'github' ? (
      <RepoGraphGlyph className="h-3.5 w-3.5 text-stone-500" />
    ) : (
      <FileTextIcon className="h-3 w-3 text-emerald-700" weight="fill" aria-hidden />
    );
  const open = (event: React.MouseEvent) => {
    event.stopPropagation();
    setShowModal(true);
  };
  // The badge sits inside clickable rows (folder expand/collapse) — keep every
  // modal click, backdrop included, from bubbling into the row.
  const modal = showModal ? (
    <span onClick={(event) => event.stopPropagation()}>
      <GitModal repo={repo} onClose={() => setShowModal(false)} />
    </span>
  ) : null;

  if (variant === 'header') {
    return (
      <>
        <button
          type="button"
          onClick={open}
          className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] text-stone-600 hover:bg-stone-50"
          title={`${PROVIDER_LABEL[repo.provider]} · ${repo.repoLabel} · ${dot.label}`}
        >
          {icon}
          <span className="truncate max-w-[14ch]">{repo.repoLabel}</span>
          <span className={`h-1.5 w-1.5 rounded-full ${dot.color}`} aria-hidden />
        </button>
        {modal}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        data-testid="linked-repo-badge"
        aria-label={`${PROVIDER_LABEL[repo.provider]} — ${repo.repoLabel}`}
        className="relative group/tip ml-1 inline-flex items-center gap-1"
      >
        {icon}
        <span className={`h-1.5 w-1.5 rounded-full ${dot.color}`} aria-hidden />
        <IconTooltip label={`${PROVIDER_LABEL[repo.provider]} · ${dot.label}`} />
      </button>
      {modal}
    </>
  );
}
