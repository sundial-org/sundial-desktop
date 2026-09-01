'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowSquareOutIcon, FileTextIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import { useRequireSignIn } from '@/lib/auth/use-require-signin';
import { IntegrationSignInGate } from '@/components/workspace/integration-signin-gate';
import { Spinner } from '@/components/ui/spinner';

type ConnectionStatus = {
  connected: boolean;
  overleafEmail: string | null;
  lastValidatedAt: string | null;
};

export function UserOverleafTab() {
  const { signedIn, isLoaded: authLoaded, requireSignIn } = useRequireSignIn();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/user/overleaf/connection', {
        cache: 'no-store',
        credentials: 'include',
      });
      const body = (await response.json().catch(() => null)) as ConnectionStatus | { error?: string } | null;
      if (!response.ok) {
        throw new Error((body as { error?: string } | null)?.error ?? `Failed (${response.status})`);
      }
      setStatus(body as ConnectionStatus);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load Overleaf status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoaded) return;
    // Skip the account-scoped status fetch when logged out (would 401). Save
    // prompts sign-in instead.
    if (!signedIn) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [authLoaded, signedIn, refresh]);

  const handleSave = useCallback(async () => {
    if (!requireSignIn()) return;
    if (!token.trim()) return;
    setActionInFlight('save');
    setError(null);
    try {
      const response = await fetch('/api/user/overleaf/connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ accessToken: token.trim(), overleafEmail: email.trim() || null }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed (${response.status})`);
      }
      setToken('');
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Save failed');
    } finally {
      setActionInFlight(null);
    }
  }, [email, refresh, token, requireSignIn]);

  const handleDisconnect = useCallback(async () => {
    setActionInFlight('disconnect');
    setError(null);
    try {
      const response = await fetch('/api/user/overleaf/disconnect', {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed (${response.status})`);
      }
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
          <FileTextIcon className="mt-1 h-7 w-7 text-emerald-700" weight="fill" aria-hidden />
          <div>
            <h2 className="text-lg font-semibold text-stone-900">Overleaf</h2>
            <p className="mt-1 text-sm text-stone-500">
              Sync Overleaf projects into a Sundial subfolder. Requires an Overleaf Premium
              git-integration token:{' '}
              <a
                href="https://www.overleaf.com/user/settings#authentication"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-stone-700 underline hover:text-stone-900"
              >
                generate one here
                <ArrowSquareOutIcon className="h-3 w-3" weight="bold" aria-hidden />
              </a>
              .
            </p>
          </div>
        </header>

        {!authLoaded ? (
          <Spinner label="Loading…" />
        ) : !signedIn ? (
          <IntegrationSignInGate provider="Overleaf" returnParam={{ panel: 'overleaf' }} />
        ) : loading ? (
          <Spinner label="Loading…" />
        ) : status?.connected ? (
          <section className="rounded-2xl border border-stone-200 bg-stone-50 p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-stone-800">
                  <PlugsConnectedIcon className="h-4 w-4 text-emerald-600" weight="bold" aria-hidden />
                  Overleaf token saved
                </div>
                {status.overleafEmail ? (
                  <p className="mt-2 text-xs text-stone-500">Linked email: {status.overleafEmail}</p>
                ) : (
                  <p className="mt-2 text-xs text-stone-500">No email recorded.</p>
                )}
                {status.lastValidatedAt ? (
                  <p className="mt-1 text-[11px] text-stone-400">
                    Last validated: {new Date(status.lastValidatedAt).toLocaleString()}
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-stone-400">Not yet validated (will validate on first sync).</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
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
              Paste your Overleaf git-integration token. This is optional. Workspace members can
              share a token via the linker&apos;s account, but a personal token gives you authorship on
              commits you push.
            </p>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-xs font-medium text-stone-500">Token</span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="olp_…"
                  className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 outline-none transition-colors focus:border-orange focus:ring-2 focus:ring-orange/20"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-stone-500">Email (optional)</span>
                <input
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 outline-none transition-colors focus:border-orange focus:ring-2 focus:ring-orange/20"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={actionInFlight !== null || !token.trim()}
                className="mt-2 inline-flex items-center gap-2 rounded-lg bg-orange px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
              >
                {actionInFlight === 'save' ? 'Saving…' : 'Save token'}
              </button>
            </div>
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
