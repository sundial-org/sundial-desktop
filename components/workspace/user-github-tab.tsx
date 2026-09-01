'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowSquareOutIcon, GithubLogoIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import { invalidateRepositoriesCache } from '@/lib/github/repos-client';
import { useRequireSignIn } from '@/lib/auth/use-require-signin';
import { IntegrationSignInGate } from '@/components/workspace/integration-signin-gate';
import { Spinner } from '@/components/ui/spinner';

type ConnectionStatus = {
  connected: boolean;
  githubLogin: string | null;
  githubUrl: string | null;
  scopes: string[];
  legacyAccess: boolean;
};

const OAUTH_MESSAGE_TYPE = 'sundial:github-oauth';

export function UserGitHubTab() {
  const { signedIn, isLoaded: authLoaded, requireSignIn } = useRequireSignIn();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/user/github/connection', { cache: 'no-store', credentials: 'include' });
      const body = (await response.json().catch(() => null)) as ConnectionStatus | { error?: string } | null;
      if (!response.ok) {
        throw new Error((body as { error?: string } | null)?.error ?? `Failed (${response.status})`);
      }
      setStatus(body as ConnectionStatus);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load GitHub status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoaded) return;
    // Skip the account-scoped status fetch when logged out — it would 401 and
    // surface as a red "Unauthorized". Connect prompts sign-in instead.
    if (!signedIn) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [authLoaded, signedIn, refresh]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== OAUTH_MESSAGE_TYPE) return;
      invalidateRepositoriesCache();
      void refresh();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [refresh]);

  // Always authorize-first: it persists a ghu_ token on this origin, and the
  // callback chains into the repo picker when there's no installation yet —
  // including legacy gho_ migrations, where install-first could complete
  // without ever swapping the token.
  const handleConnect = useCallback(() => {
    if (!requireSignIn()) return;
    setActionInFlight('connect');
    const returnPath = `${window.location.pathname}?panel=github`;
    const url = `/api/user/github/start?returnPath=${encodeURIComponent(returnPath)}`;
    const popup = window.open(url, 'sundial-github-oauth', 'width=720,height=820');
    if (!popup) {
      window.location.href = url;
      return;
    }
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        setActionInFlight(null);
        invalidateRepositoriesCache();
        void refresh();
      }
    }, 750);
  }, [refresh, requireSignIn]);

  const handleDisconnect = useCallback(async () => {
    setActionInFlight('disconnect');
    setError(null);
    try {
      const response = await fetch('/api/user/github/disconnect', { method: 'POST', credentials: 'include' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed (${response.status})`);
      }
      invalidateRepositoriesCache();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Disconnect failed');
    } finally {
      setActionInFlight(null);
    }
  }, [refresh]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="max-w-3xl px-6 py-8">
        <header className="mb-6 flex items-start gap-3">
          <GithubLogoIcon className="mt-1 h-7 w-7 text-stone-700" weight="fill" aria-hidden />
          <div>
            <h2 className="text-lg font-semibold text-stone-900">GitHub</h2>
            <p className="mt-1 text-sm text-stone-500">
              Connect your GitHub account once. Sundial can only access the repositories you
              choose, and uses them to push, pull, and commit from any workspace.
            </p>
          </div>
        </header>

        {!authLoaded ? (
          <Spinner label="Loading…" />
        ) : !signedIn ? (
          <IntegrationSignInGate provider="GitHub" returnParam={{ panel: 'github' }} />
        ) : loading ? (
          <Spinner label="Loading…" />
        ) : status?.connected ? (
          <section className="rounded-2xl border border-stone-200 bg-stone-50 p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-stone-800">
                  <PlugsConnectedIcon className="h-4 w-4 text-emerald-600" weight="bold" aria-hidden />
                  Connected as
                  {status.githubUrl ? (
                    <a
                      href={status.githubUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-stone-900 hover:underline"
                    >
                      @{status.githubLogin}
                      <ArrowSquareOutIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
                    </a>
                  ) : (
                    <span className="text-stone-900">@{status.githubLogin}</span>
                  )}
                </div>
                <p className="mt-2 text-xs text-stone-500">
                  {status.legacyAccess ? (
                    'Access: all repositories (legacy) · Re-authorize to pick specific repos'
                  ) : (
                    <>
                      Access: only the repositories you granted ·{' '}
                      <a
                        href="https://github.com/settings/installations"
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        manage on GitHub
                      </a>
                    </>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={actionInFlight !== null}
                  className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:opacity-50"
                >
                  Re-authorize
                </button>
                <button
                  type="button"
                  onClick={() => void handleDisconnect()}
                  disabled={actionInFlight !== null}
                  className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                >
                  Disconnect
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="rounded-2xl border border-stone-200 bg-white p-5">
            <p className="text-sm text-stone-600">
              You haven&apos;t connected GitHub yet. Connect to link repos and push commits from any
              Sundial workspace.
            </p>
            <button
              type="button"
              onClick={handleConnect}
              disabled={actionInFlight !== null}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-orange px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
            >
              <GithubLogoIcon className="h-4 w-4" weight="fill" aria-hidden />
              {actionInFlight === 'connect' ? 'Opening GitHub…' : 'Connect GitHub'}
            </button>
          </section>
        )}

        {error ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
