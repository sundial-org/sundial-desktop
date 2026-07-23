'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth/optional-auth';
import {
  ArrowSquareOutIcon,
  CircleNotchIcon,
  GithubLogoIcon,
  LinkIcon,
  XIcon,
} from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { useRequireSignIn } from '@/lib/auth/use-require-signin';
import { IntegrationSignInGate } from '@/components/workspace/integration-signin-gate';
import { CloneProgress } from '@/components/workspace/clone-progress';
import { humanizeGitError } from '@/lib/git-remote/humanize-error';
import {
  fetchRepositories,
  getCachedRepositories,
  invalidateRepositoriesCache,
  type RepositoriesResponse,
} from '@/lib/github/repos-client';

const OAUTH_MESSAGE_TYPE = 'sundial:github-oauth';

export function AddRepoModal({
  open,
  onClose,
  projectId,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onLinked: (repositoryId: string) => void;
}) {
  const { userId } = useAuth();
  const { signedIn, isLoaded: authLoaded, requireSignIn } = useRequireSignIn();
  // Seed from the client cache so a warm open paints repos with no spinner.
  const [data, setData] = useState<RepositoriesResponse | null>(() => getCachedRepositories(userId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [urlInput, setUrlInput] = useState('');
  // Tracks the in-flight link/clone per-target so only the clicked button
  // shows the spinner. `target` is the repo fullName or the URL string.
  const [busy, setBusy] = useState<{ target: string; phase: 'linking' | 'cloning' } | null>(null);

  const refresh = useCallback(async (force = false) => {
    setError(null);
    // Only show the spinner when there's nothing cached to paint immediately.
    if (force || !getCachedRepositories(userId)) setLoading(true);
    try {
      setData(await fetchRepositories(userId, { force }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load GitHub repos');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!open) return;
    if (!authLoaded) return;
    // Skip the account-scoped repo fetch when logged out — it 401s and surfaces
    // as a red "Unauthorized". The not-connected view + Connect prompt sign-in.
    if (!signedIn) return;
    void refresh();
  }, [open, authLoaded, signedIn, refresh]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== OAUTH_MESSAGE_TYPE) return;
      void refresh(true);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [open, refresh]);

  const handleConnect = useCallback((mode?: 'install') => {
    if (!requireSignIn()) return;
    const returnPath = `${window.location.pathname}?modal=addRepo`;
    const url = `/api/user/github/start?returnPath=${encodeURIComponent(returnPath)}${mode ? `&mode=${mode}` : ''}`;
    const popup = window.open(url, 'sundial-github-oauth', 'width=720,height=820');
    if (!popup) {
      window.location.href = url;
      return;
    }
    // Editing an existing installation's repo selection returns no OAuth
    // callback (no postMessage), so refresh when the popup closes.
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        invalidateRepositoriesCache();
        void refresh(true);
      }
    }, 750);
  }, [refresh, requireSignIn]);

  const linkRepo = useCallback(
    async (target: string, payload: Record<string, unknown>) => {
      setBusy({ target, phase: 'linking' });
      setError(null);
      try {
        const link = await fetch('/api/workspace/linked-repos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, provider: 'github', ...payload }),
        });
        const linkBody = (await link.json().catch(() => null)) as
          | { repositoryId?: string; error?: string; code?: string }
          | null;
        if (!link.ok || !linkBody?.repositoryId) {
          throw new Error(linkBody?.error ?? `Failed (${link.status})`);
        }

        setBusy({ target, phase: 'cloning' });
        const clone = await fetch(`/api/workspace/linked-repos/${linkBody.repositoryId}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, action: 'clone' }),
        });
        const cloneBody = (await clone.json().catch(() => null)) as
          | { ok?: boolean; error?: string; output?: string }
          | null;
        if (!clone.ok || !cloneBody?.ok) {
          const raw = cloneBody?.error || cloneBody?.output || `HTTP ${clone.status}`;
          throw new Error(
            `Repo linked but initial clone failed: ${humanizeGitError('github', raw)}`,
          );
        }

        onLinked(linkBody.repositoryId);
        onClose();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Failed to link repo');
      } finally {
        setBusy(null);
      }
    },
    [projectId, onClose, onLinked],
  );

  const filteredRepos = (data?.repositories ?? []).filter((r) =>
    r.fullName.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="Add GitHub repo"
      panelClassName="relative flex w-full max-w-xl flex-col rounded-2xl border border-stone-200 bg-white shadow-xl"
      // A stray click or Escape mid-clone silently dismissed the modal while
      // the link/clone kept running in the background — "modal disappeared,
      // nothing happened". Closing during work must be the explicit ✕.
      closeOnBackdrop={busy === null}
      closeOnEscape={busy === null}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-600"
      >
        <XIcon className="h-4 w-4" weight="bold" aria-hidden />
      </button>

      <header className="border-b border-stone-200 px-6 py-4">
        <h2 className="flex items-center gap-2 text-base font-semibold text-stone-900">
          <GithubLogoIcon className="h-5 w-5" weight="fill" aria-hidden />
          Add a GitHub repo
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          Cloned into a subfolder of this workspace. Push, pull, and commit from the Commits panel.
        </p>
      </header>

      {busy ? (
        <CloneProgress
          phase={busy.phase}
          target={busy.target}
          icon={<GithubLogoIcon className="h-7 w-7" weight="fill" aria-hidden />}
        />
      ) : (
      <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
        {!authLoaded ? (
          <p className="text-sm text-stone-500">Loading…</p>
        ) : !signedIn ? (
          <IntegrationSignInGate provider="GitHub" returnParam={{ modal: 'addRepo' }} />
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-stone-500">
            <CircleNotchIcon className="h-4 w-4 animate-spin" weight="bold" aria-hidden />
            Loading your repos…
          </div>
        ) : !data?.connected ? (
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-5 text-center">
            <GithubLogoIcon className="mx-auto h-8 w-8 text-stone-400" weight="fill" aria-hidden />
            <p className="mt-3 text-sm text-stone-700">Connect GitHub to browse your repos.</p>
            <button
              type="button"
              onClick={() => handleConnect()}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
            >
              Connect GitHub
            </button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between text-xs text-stone-500">
              <span>
                Connected as <span className="font-medium text-stone-700">@{data.githubLogin}</span>
              </span>
              <button
                type="button"
                onClick={() => handleConnect('install')}
                className="text-stone-500 hover:underline"
              >
                Manage repo access
              </button>
            </div>
            <div className="mb-4 flex gap-2">
              <div className="relative flex-1">
                <LinkIcon
                  className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
                  weight="bold"
                  aria-hidden
                />
                <input
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  placeholder="Paste owner/repo or https://github.com/…"
                  className="w-full rounded-lg border border-stone-300 bg-white py-2 pl-8 pr-3 text-sm outline-none focus:border-stone-500"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  const url = urlInput.trim();
                  if (url) void linkRepo(url, { repoUrl: url });
                }}
                disabled={!urlInput.trim()}
                className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
              >
                Link
              </button>
            </div>
            <div className="mb-2 text-[11px] uppercase tracking-wide text-stone-400">Or pick from your repos</div>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter repos…"
              className="mb-3 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500"
            />
            <div className="space-y-1">
              {(data?.repositories ?? []).length === 0 ? (
                <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-4 text-center">
                  <p className="text-xs text-stone-500">
                    You haven&apos;t granted Sundial access to any repositories yet.
                  </p>
                  <button
                    type="button"
                    onClick={() => handleConnect('install')}
                    className="mt-2 text-xs font-medium text-stone-700 underline hover:text-stone-900"
                  >
                    Choose repositories on GitHub
                  </button>
                </div>
              ) : filteredRepos.length === 0 ? (
                <p className="text-xs text-stone-400">No repos match.</p>
              ) : (
                filteredRepos.map((repo) => (
                  <div
                    key={repo.id}
                    className="group flex items-center justify-between gap-2 rounded-lg border border-transparent px-3 py-2 hover:border-stone-200 hover:bg-stone-50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium text-stone-800">
                        <span className="truncate">{repo.fullName}</span>
                        {repo.private ? (
                          <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[10px] text-stone-600">
                            private
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[11px] text-stone-400">
                        {repo.defaultBranch ?? 'main'}
                        {repo.updatedAt ? ` · updated ${new Date(repo.updatedAt).toLocaleDateString()}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {repo.htmlUrl ? (
                        <a
                          href={repo.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="Open on GitHub"
                          className="text-stone-300 hover:text-stone-500"
                        >
                          <ArrowSquareOutIcon className="h-4 w-4" weight="bold" aria-hidden />
                        </a>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void linkRepo(repo.fullName, { repoFullName: repo.fullName })}
                        className="rounded-md bg-stone-900 px-3 py-1 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50"
                      >
                        Link
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {error ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}
      </div>
      )}
    </ModalShell>
  );
}
