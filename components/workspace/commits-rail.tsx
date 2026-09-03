'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircleIcon,
  GitBranchIcon,
  GitCommitIcon,
  GithubLogoIcon,
  FileTextIcon,
  LinkBreakIcon,
  PaperPlaneTiltIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { JitGitHubConnectModal } from '@/components/workspace/jit-github-connect-modal';
import { SidebarSectionHeader } from '@/components/workspace/sidebar-section-header';
import { Spinner } from '@/components/ui/spinner';
import type { LinkedRepoSummary } from '@/lib/workspace/use-linked-repos';
import { humanizeGitError } from '@/lib/git-remote/humanize-error';

// Left-panel commits view. Picks one linked repo at a time (top selector),
// shows the recent commit log + sync controls + a "Showing via @<login>"
// transparency line when reads use someone else's token.

// `git status --porcelain=v1` codes. We only color the ones that show up in a
// pre-commit preview (no merge/conflict glyphs — those would block the commit
// anyway). Default to a neutral grey for unknown two-char combos.
function dirtyColor(code: string) {
  const c = code.trim();
  if (c === 'M' || c === 'MM') return 'text-amber-600';
  if (c === 'A' || c === '??') return 'text-emerald-600';
  if (c === 'D') return 'text-rose-600';
  if (c === 'R') return 'text-blue-600';
  return 'text-stone-500';
}
function dirtyLabel(code: string) {
  const c = code.trim();
  return c === 'M' ? 'modified'
    : c === 'A' ? 'added'
    : c === 'D' ? 'deleted'
    : c === 'R' ? 'renamed'
    : c === '??' ? 'untracked'
    : code;
}

// Cap how many dirty rows we mount at once. Selection still operates on the
// full list — this only bounds the DOM so a repo with thousands of changed
// files doesn't render thousands of checkboxes and jank the rail.
const DIRTY_RENDER_CAP = 100;

function relativeTime(iso: string | null): string {
  if (!iso) return 'not yet';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

type Commit = {
  sha: string;
  author_name: string;
  author_email: string;
  authored_at: string;
  subject: string;
};

type CommitsResponse = {
  repositoryId: string;
  branch: string | null;
  commits: Commit[];
  via?: string;
  viaLogin?: string | null;
  isRequesterToken?: boolean;
  error?: string;
  code?: string;
};

export function CommitsRail({
  projectId,
  repos,
  selectedCommitSha,
  onSelectCommit,
  onActionComplete,
  collapsed,
  onToggleCollapsed,
  localSync,
}: {
  projectId: string;
  repos: LinkedRepoSummary[];
  selectedCommitSha: string | null;
  onSelectCommit: (repoId: string, sha: string | null) => void;
  /** Bumped by the host so `useLinkedRepos` refetches sync_status after an action. */
  onActionComplete: () => void;
  /** Accordion state: when collapsed, only the Sync section header renders. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Sync section covers every connected sync method — a non-repo status card
      (e.g. local folder mirror) renders above the repo surface. */
  localSync?: ReactNode;
}) {
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(repos[0]?.id ?? null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [via, setVia] = useState<{ userId: string; login: string | null; isRequester: boolean } | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [showJitModal, setShowJitModal] = useState<{ action: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [dirty, setDirty] = useState<{ code: string; path: string }[]>([]);
  const [showDirty, setShowDirty] = useState(true);
  const [showAllDirty, setShowAllDirty] = useState(false);
  // Paths the user has chosen to include in the next commit. Defaults to "all".
  // Cleared whenever the dirty list changes so the default is always "stage
  // everything you see right now".
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const selectedRepo = useMemo(
    () => repos.find((r) => r.id === selectedRepoId) ?? null,
    [repos, selectedRepoId],
  );
  // Auto-sync: the bridge worker owns pull/commit/push; the rail shows sync
  // state instead of manual git controls.
  const isAuto = selectedRepo?.mode === 'auto';
  // Live socket-level Overleaf sync: no git rail at all — no commits, no
  // tokens, no manual sync. Fetching commits here would resolve legacy git
  // auth and error with "No Overleaf token available".
  const isLive = selectedRepo?.bridgeState?.transport === 'live';

  useEffect(() => {
    // Select the first repo when nothing is selected, and recover when the
    // current selection is gone (e.g. after removing the selected sync) — else
    // selectedRepoId stays a now-deleted id and selectedRepo resolves to null.
    if (repos.length && !repos.some((r) => r.id === selectedRepoId)) {
      setSelectedRepoId(repos[0].id);
    }
  }, [repos, selectedRepoId]);

  const fetchCommits = useCallback(async () => {
    if (!selectedRepo || selectedRepo.bridgeState?.transport === 'live') {
      setCommits([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/workspace/linked-repos/${selectedRepo.id}/commits?projectId=${encodeURIComponent(projectId)}&limit=50`,
        { cache: 'no-store', credentials: 'include' },
      );
      const body = (await response.json().catch(() => null)) as CommitsResponse | null;
      if (!response.ok) throw new Error(body?.error ?? `Failed (${response.status})`);
      setCommits(body?.commits ?? []);
      setVia(
        body?.via
          ? {
              userId: body.via,
              login: body.viaLogin ?? null,
              isRequester: Boolean(body.isRequesterToken),
            }
          : null,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load commits');
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedRepo]);

  const statusInFlight = useRef(false);
  const fetchStatus = useCallback(async () => {
    if (!selectedRepo || selectedRepo.mode === 'auto') {
      // Auto repos don't show the dirty/commit surface, and polling `status`
      // would boot the sandbox for a tree the bridge worker owns anyway.
      setDirty([]);
      return;
    }
    // Never stack polls: a hung sandbox would otherwise pile up requests that
    // each wait out the route's full timeout.
    if (statusInFlight.current) return;
    statusInFlight.current = true;
    try {
      const response = await fetch(`/api/workspace/linked-repos/${selectedRepo.id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId, action: 'status' }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; data?: { dirty?: { code: string; path: string }[] } }
        | null;
      if (response.ok && body?.ok) {
        const next = body.data?.dirty ?? [];
        setDirty(next);
        setExcluded((prev) => {
          // Drop excluded paths that no longer appear in the dirty list.
          const live = new Set(next.map((d) => d.path));
          const filtered = new Set<string>();
          prev.forEach((p) => live.has(p) && filtered.add(p));
          return filtered.size === prev.size ? prev : filtered;
        });
      }
    } catch {
      // Status is best-effort — preserve last-known dirty list on failure.
    } finally {
      statusInFlight.current = false;
    }
  }, [projectId, selectedRepo]);

  // The rail now mounts collapsed in the stacked sidebar — don't fetch or
  // poll until it's actually open (and refetch on every expand).
  useEffect(() => {
    if (collapsed) return;
    void fetchCommits();
    void fetchStatus();
  }, [fetchCommits, fetchStatus, collapsed]);

  // While the rail is expanded, keep the dirty list live — doc edits reach
  // the sandbox disk asynchronously, so a one-shot status goes stale the
  // moment the user types.
  useEffect(() => {
    if (collapsed) return;
    void fetchStatus();
    const timer = setInterval(() => {
      void fetchStatus();
    }, 30_000);
    return () => clearInterval(timer);
  }, [fetchStatus, collapsed]);

  // Auto repos: refresh commits + bridge state (via the host's refetch) on the
  // same cadence, so the chip and log track the background loop.
  useEffect(() => {
    if (collapsed || !isAuto) return;
    const timer = setInterval(() => {
      void fetchCommits();
      onActionComplete();
    }, 30_000);
    return () => clearInterval(timer);
  }, [collapsed, isAuto, fetchCommits, onActionComplete]);

  const setMode = useCallback(
    async (mode: 'manual' | 'auto') => {
      if (!selectedRepo) return;
      setActionInFlight('mode');
      setError(null);
      try {
        const response = await fetch(`/api/workspace/bridges/${selectedRepo.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, mode }),
        });
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) throw new Error(body?.error ?? `Failed (${response.status})`);
        onActionComplete();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Failed to change sync mode');
      } finally {
        setActionInFlight(null);
      }
    },
    [projectId, selectedRepo, onActionComplete],
  );

  const syncNow = useCallback(async () => {
    if (!selectedRepo) return;
    setActionInFlight('sync_now');
    setError(null);
    try {
      const response = await fetch(`/api/workspace/bridges/${selectedRepo.id}/poke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? `Failed (${response.status})`);
      await fetchCommits();
      onActionComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sync failed');
    } finally {
      setActionInFlight(null);
    }
  }, [projectId, selectedRepo, fetchCommits, onActionComplete]);

  const resolveConflict = useCallback(
    async (resolution: 'keep_local' | 'keep_remote') => {
      if (!selectedRepo) return;
      setActionInFlight(`resolve_${resolution}`);
      setError(null);
      try {
        const response = await fetch(`/api/workspace/bridges/${selectedRepo.id}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, resolution }),
        });
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) throw new Error(body?.error ?? `Failed (${response.status})`);
        await fetchCommits();
        onActionComplete();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Failed to resolve conflict');
      } finally {
        setActionInFlight(null);
      }
    },
    [projectId, selectedRepo, fetchCommits, onActionComplete],
  );

  const runAction = useCallback(
    async (action: string, extras?: { message?: string; paths?: string[] }) => {
      if (!selectedRepo) return;
      setActionInFlight(action);
      setError(null);
      try {
        const response = await fetch(`/api/workspace/linked-repos/${selectedRepo.id}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, action, message: extras?.message, paths: extras?.paths }),
        });
        const body = (await response.json().catch(() => null)) as
          | { ok?: boolean; error?: string; code?: string; status?: string }
          | null;
        if (response.status === 409 && body?.code === 'NEEDS_GITHUB_CONNECTION') {
          setShowJitModal({ action });
          return;
        }
        if (!response.ok || !body?.ok) {
          const raw = body?.error ?? `Failed (${response.status})`;
          throw new Error(humanizeGitError(selectedRepo.provider, raw));
        }
        if (action === 'commit_push') setCommitMessage('');
        await Promise.all([fetchCommits(), fetchStatus()]);
        onActionComplete();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Action failed');
      } finally {
        setActionInFlight(null);
      }
    },
    [projectId, selectedRepo, fetchCommits, fetchStatus, onActionComplete],
  );

  // Remove the sync link. The bridges route stops the worker loop + purges the
  // on-disk working copy before dropping the row; the doc-store files stay —
  // only the link goes.
  const removeRepo = useCallback(async () => {
    if (!selectedRepo) return;
    setActionInFlight('remove');
    setError(null);
    try {
      const response = await fetch(
        `/api/workspace/bridges/${selectedRepo.id}?projectId=${encodeURIComponent(projectId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? `Failed (${response.status})`);
      setConfirmRemove(false);
      // Close any open commit diff for this repo — otherwise CommitDiffViewer
      // keeps fetching the now-deleted repositoryId and shows a stale error.
      onSelectCommit(selectedRepo.id, null);
      // Don't null the selection here — that would re-select the still-present
      // (stale) deleted repo. The refetch drops the row and the selection effect
      // recovers to a surviving repo.
      onActionComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to remove sync');
    } finally {
      setActionInFlight(null);
    }
  }, [projectId, selectedRepo, onActionComplete, onSelectCommit]);

  // Reset the confirm prompt when the selected repo changes.
  useEffect(() => setConfirmRemove(false), [selectedRepoId]);

  if (!repos.length) {
    // A local-folder-only workspace still gets the Sync section: header + the
    // local sync card, no repo surface.
    if (localSync) {
      return (
        <>
          <SidebarSectionHeader label="Sync" collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} />
          {collapsed ? null : <div className="min-h-0 flex-1 overflow-y-auto">{localSync}</div>}
        </>
      );
    }
    return (
      <div className="px-4 py-6 text-center">
        <GitCommitIcon className="mx-auto h-7 w-7 text-stone-300" weight="regular" aria-hidden />
        <p className="mt-3 text-xs text-stone-500">
          No linked repos yet. Use Files → Add GitHub repo or Add Overleaf project to link one.
        </p>
      </div>
    );
  }

  return (
    <>
      <SidebarSectionHeader
        label="Sync"
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        actions={
          isLive ? null : (
          <button
            type="button"
            onClick={() => void runAction('fetch')}
            disabled={actionInFlight !== null}
            aria-label="Fetch"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-200/50 hover:text-stone-600 disabled:opacity-40"
          >
            <ArrowClockwiseIcon className="h-4 w-4" weight="regular" aria-hidden />
          </button>
          )
        }
      />

      {collapsed ? null : (
      <>
      {/* One scroll container for the whole body (repo picker + actions card +
          commits list). Without it the actions card sits outside any scroll
          area, so on short sidebars the Commit & push button clips under the
          profile footer and can't be clicked. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
      {localSync}
      {repos.length > 1 ? (
        <div className="px-3 pb-2">
          <select
            value={selectedRepoId ?? ''}
            onChange={(event) => {
              setSelectedRepoId(event.target.value);
              onSelectCommit(event.target.value, null);
            }}
            className="w-full rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-700"
          >
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.provider === 'github' ? '⌥' : '∮'} {repo.repoLabel}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {selectedRepo ? (
        <div className="space-y-3 border-y border-stone-200/70 bg-stone-50/60 px-3 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-stone-200 bg-white">
              {selectedRepo.provider === 'github' ? (
                <GithubLogoIcon className="h-4 w-4 text-stone-700" weight="fill" aria-hidden />
              ) : (
                <FileTextIcon className="h-4 w-4 text-emerald-700" weight="fill" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-stone-800">{selectedRepo.repoLabel}</div>
              {selectedRepo.currentBranch ? (
                <div className="mt-0.5 flex items-center gap-1 text-[10px] text-stone-400">
                  <GitBranchIcon className="h-3 w-3" weight="bold" aria-hidden />
                  <span className="truncate">{selectedRepo.currentBranch}</span>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              disabled={actionInFlight !== null}
              aria-label="Remove sync"
              title="Remove sync"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center self-start rounded text-stone-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
            >
              <LinkBreakIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
            </button>
          </div>
          {confirmRemove ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-2 text-[11px] text-rose-700">
              <p>Remove this sync? Your files stay; only the {selectedRepo.provider === 'github' ? 'GitHub' : 'Overleaf'} link is removed.</p>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void removeRepo()}
                  disabled={actionInFlight !== null}
                  className="rounded-md bg-rose-600 px-2 py-1 font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {actionInFlight === 'remove' ? 'Removing…' : 'Remove'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemove(false)}
                  className="rounded-md border border-stone-300 bg-white px-2 py-1 text-stone-600 hover:bg-stone-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {selectedRepo.provider === 'github' && selectedRepo.importedPath !== '' ? (
            <label className="flex items-center justify-between rounded-md border border-stone-200 bg-white px-2.5 py-2">
              <span className="text-[11px] font-medium text-stone-700">Auto-sync</span>
              <button
                type="button"
                role="switch"
                aria-checked={isAuto}
                aria-label="Auto-sync"
                disabled={actionInFlight !== null}
                onClick={() => void setMode(isAuto ? 'manual' : 'auto')}
                className={`relative h-4.5 w-8 rounded-full transition-colors disabled:opacity-40 ${
                  isAuto ? 'bg-stone-900' : 'bg-stone-300'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                    isAuto ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </label>
          ) : null}
          {isAuto ? (
            <>
              {selectedRepo.bridgeState?.conflict ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-2 text-[11px] text-amber-800">
                  <p className="font-medium">Auto-sync paused: changed in both places</p>
                  <ul className="mt-1 font-mono text-[10px]">
                    {selectedRepo.bridgeState.conflict.paths.slice(0, 3).map((p) => (
                      <li key={p} className="truncate">{p}</li>
                    ))}
                    {selectedRepo.bridgeState.conflict.paths.length > 3 ? (
                      <li>…and {selectedRepo.bridgeState.conflict.paths.length - 3} more</li>
                    ) : null}
                  </ul>
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => void resolveConflict('keep_local')}
                      disabled={actionInFlight !== null}
                      className="rounded-md bg-stone-900 px-2 py-1 font-medium text-white hover:bg-stone-800 disabled:opacity-50"
                    >
                      {actionInFlight === 'resolve_keep_local' ? 'Keeping…' : 'Keep Sundial version'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void resolveConflict('keep_remote')}
                      disabled={actionInFlight !== null}
                      className="rounded-md border border-stone-300 bg-white px-2 py-1 text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                    >
                      {actionInFlight === 'resolve_keep_remote' ? 'Keeping…' : 'Keep GitHub version'}
                    </button>
                  </div>
                </div>
              ) : selectedRepo.bridgeState?.lastError ? (
                <div className="flex items-start gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-2 text-[11px] text-stone-500">
                  <WarningCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" weight="bold" aria-hidden />
                  <span className="min-w-0">Sync failing: {selectedRepo.bridgeState.lastError}</span>
                </div>
              ) : isLive ? (
                <div
                  className="flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-2 text-[11px] text-stone-500"
                  data-testid="live-sync-status"
                >
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  Live two-way sync with Overleaf: edits flow both ways within seconds.
                </div>
              ) : (
                <div className="flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-2 text-[11px] text-stone-500">
                  <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" weight="fill" aria-hidden />
                  Synced with {selectedRepo.provider === 'github' ? 'GitHub' : 'remote'} · {relativeTime(selectedRepo.bridgeState?.updatedAt ?? null)}
                </div>
              )}
              {isLive ? null : (
              <button
                type="button"
                onClick={() => void syncNow()}
                disabled={actionInFlight !== null}
                className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1.5 text-[11px] text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                <ArrowClockwiseIcon className="h-3 w-3" weight="bold" aria-hidden />
                {actionInFlight === 'sync_now' ? 'Syncing…' : 'Sync now'}
              </button>
              )}
            </>
          ) : null}
          {!isAuto && selectedRepo.syncStatus ? (
            <div className="flex items-center gap-1.5 text-[10px]">
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                  selectedRepo.syncStatus.ahead ? 'border-stone-300 text-stone-600' : 'border-stone-200 text-stone-300'
                }`}
              >
                <ArrowUpIcon className="h-3 w-3" weight="bold" aria-hidden /> {selectedRepo.syncStatus.ahead} ahead
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                  selectedRepo.syncStatus.behind ? 'border-stone-300 text-stone-600' : 'border-stone-200 text-stone-300'
                }`}
              >
                <ArrowDownIcon className="h-3 w-3" weight="bold" aria-hidden /> {selectedRepo.syncStatus.behind} behind
              </span>
            </div>
          ) : null}
          {!isAuto && via && !via.isRequester ? (
            <p className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-[10px] text-stone-500">
              Showing via{' '}
              <span className="font-medium text-stone-700">
                {via.login ? `@${via.login}` : 'the linker'}
              </span>
              , the user who linked this repo.
            </p>
          ) : null}
          {!isAuto ? (
          <>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => void runAction('pull')}
              disabled={actionInFlight !== null}
              className="inline-flex items-center justify-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1.5 text-[11px] text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              <ArrowDownIcon className="h-3 w-3" weight="bold" aria-hidden />
              {actionInFlight === 'pull' ? 'Pulling…' : 'Pull'}
            </button>
            <button
              type="button"
              onClick={() => void runAction('push')}
              disabled={actionInFlight !== null}
              className="inline-flex items-center justify-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1.5 text-[11px] text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              <ArrowUpIcon className="h-3 w-3" weight="bold" aria-hidden />
              {actionInFlight === 'push' ? 'Pushing…' : 'Push'}
            </button>
          </div>
          {dirty.length > 0 ? (
            <div className="rounded-md border border-stone-200 bg-white">
              <div className="flex items-center justify-between px-2 py-1.5 text-[11px] font-medium text-stone-600">
                <button
                  type="button"
                  onClick={() => setShowDirty((v) => !v)}
                  className="flex-1 text-left hover:text-stone-800"
                >
                  {dirty.length - excluded.size} of {dirty.length} selected
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setExcluded((prev) => (prev.size === dirty.length ? new Set() : new Set(dirty.map((d) => d.path))))
                  }
                  className="text-[10px] uppercase tracking-wide text-stone-400 hover:text-stone-700"
                >
                  {excluded.size === dirty.length ? 'All' : 'None'}
                </button>
                <span className="ml-2 text-stone-400">{showDirty ? '−' : '+'}</span>
              </div>
              {showDirty ? (
                <ul className="max-h-40 overflow-auto border-t border-stone-100 px-2 py-1.5 font-mono text-[10px] text-stone-700">
                  {(showAllDirty ? dirty : dirty.slice(0, DIRTY_RENDER_CAP)).map((entry) => {
                    const checked = !excluded.has(entry.path);
                    return (
                      <li key={entry.path} className="flex items-start gap-1.5 py-0.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setExcluded((prev) => {
                              const next = new Set(prev);
                              if (checked) next.add(entry.path);
                              else next.delete(entry.path);
                              return next;
                            })
                          }
                          className="mt-0.5 h-3 w-3 shrink-0 accent-stone-800"
                          aria-label={`Include ${entry.path}`}
                        />
                        <span
                          className={`shrink-0 ${dirtyColor(entry.code)}`}
                          title={dirtyLabel(entry.code)}
                        >
                          {entry.code.trim() || '??'}
                        </span>
                        <span className={`truncate ${checked ? '' : 'text-stone-400 line-through'}`}>
                          {entry.path}
                        </span>
                      </li>
                    );
                  })}
                  {dirty.length > DIRTY_RENDER_CAP ? (
                    <li className="pt-1">
                      <button
                        type="button"
                        onClick={() => setShowAllDirty((v) => !v)}
                        className="text-[10px] font-sans text-stone-500 hover:text-stone-800"
                      >
                        {showAllDirty
                          ? 'Show fewer'
                          : `Show all ${dirty.length} changes`}
                      </button>
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-2 text-[11px] text-stone-500">
              <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" weight="fill" aria-hidden />
              No local changes. Up to date.
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="Commit message…"
              className="w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-[11px] text-stone-800 outline-none focus:border-stone-500"
            />
            <button
              type="button"
              onClick={() => {
                if (!commitMessage.trim()) return;
                const selected = dirty.filter((d) => !excluded.has(d.path)).map((d) => d.path);
                if (selected.length === 0) return;
                void runAction('commit_push', { message: commitMessage.trim(), paths: selected });
              }}
              disabled={
                !commitMessage.trim() ||
                actionInFlight !== null ||
                dirty.length === 0 ||
                excluded.size === dirty.length
              }
              className="inline-flex items-center justify-center gap-1 rounded-md bg-stone-900 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-stone-800 disabled:opacity-50"
            >
              <PaperPlaneTiltIcon className="h-3 w-3" weight="bold" aria-hidden />
              {actionInFlight === 'commit_push'
                ? 'Committing…'
                : `Commit & push (${dirty.length - excluded.size})`}
            </button>
          </div>
          </>
          ) : null}
        </div>
      ) : null}

      <div className="px-2 py-2">
        {isLive ? null : loading ? (
          <Spinner label="Loading commits…" size={13} className="px-2 text-xs" />
        ) : commits.length === 0 ? (
          <p className="px-2 text-xs text-stone-400">No commits yet.</p>
        ) : (
          <ol className="space-y-0.5">
            {commits.map((commit) => {
              const isSelected = selectedRepo?.id === selectedRepoId && commit.sha === selectedCommitSha;
              return (
                <li key={commit.sha}>
                  <button
                    type="button"
                    onClick={() => selectedRepo && onSelectCommit(selectedRepo.id, commit.sha)}
                    className={`group flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                      isSelected ? 'bg-stone-200/80 text-stone-800' : 'text-stone-600 hover:bg-stone-100'
                    }`}
                  >
                    <GitCommitIcon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-stone-400" weight="regular" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-stone-800 group-hover:text-stone-900">
                        {commit.subject}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-stone-400">
                        {commit.author_name} · {new Date(commit.authored_at).toLocaleString()}{' '}
                        · {commit.sha.slice(0, 7)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {error ? (
          <p className="mt-3 flex items-start gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-2 text-[11px] text-stone-500">
            <WarningCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" weight="bold" aria-hidden />
            <span className="min-w-0">{error}</span>
          </p>
        ) : null}
      </div>
      </div>
      </>
      )}

      <JitGitHubConnectModal
        open={showJitModal !== null}
        onClose={() => setShowJitModal(null)}
        action={showJitModal?.action ?? null}
        onConnected={() => {
          const retryAction = showJitModal?.action;
          setShowJitModal(null);
          if (retryAction) {
            void runAction(retryAction, { message: commitMessage.trim() || undefined });
          }
        }}
      />
    </>
  );
}
