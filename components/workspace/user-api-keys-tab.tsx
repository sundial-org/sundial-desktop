'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowSquareOutIcon, CheckCircleIcon, KeyIcon } from '@phosphor-icons/react';
import { useRequireSignIn } from '@/lib/auth/use-require-signin';
import { IntegrationSignInGate } from '@/components/workspace/integration-signin-gate';
import { Spinner } from '@/components/ui/spinner';
import {
  BYOK_PROVIDERS,
  type ByokProvider,
  type ByokProviderId,
  normalizeProviderApiKey,
} from '@/lib/user/provider-keys-shared';

type SavedKey = { provider: ByokProviderId; keyHint: string; updatedAt: string };

export function UserApiKeysTab() {
  const { signedIn, isLoaded: authLoaded, requireSignIn } = useRequireSignIn();
  const [savedKeys, setSavedKeys] = useState<SavedKey[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/user/provider-keys', {
        cache: 'no-store',
        credentials: 'include',
      });
      const body = (await response.json().catch(() => null)) as
        | { keys?: SavedKey[]; error?: string }
        | null;
      if (!response.ok) throw new Error(body?.error ?? `Failed (${response.status})`);
      setSavedKeys(body?.keys ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoaded) return;
    // Skip the account-scoped fetch when logged out (would 401); the sign-in
    // gate renders instead.
    if (!signedIn) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [authLoaded, signedIn, refresh]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="max-w-3xl px-6 py-8">
        <header className="mb-6 flex items-start gap-3">
          <KeyIcon className="mt-1 h-7 w-7 text-amber-600" weight="fill" aria-hidden />
          <div>
            <h2 className="text-lg font-semibold text-stone-900">API keys</h2>
            <p className="mt-1 text-sm text-stone-500">
              Bring your own provider keys. Chats on these providers&apos; models run on your key
              and don&apos;t consume Sundial credits.
            </p>
          </div>
        </header>

        {!authLoaded ? (
          <Spinner label="Loading…" />
        ) : !signedIn ? (
          <IntegrationSignInGate provider="your API keys" returnParam={{ panel: 'apikeys' }} />
        ) : loading ? (
          <Spinner label="Loading…" />
        ) : (
          <div className="space-y-3">
            {BYOK_PROVIDERS.map((provider) => (
              <ProviderKeyCard
                key={provider.id}
                provider={provider}
                saved={savedKeys?.find((k) => k.provider === provider.id) ?? null}
                requireSignIn={requireSignIn}
                onChanged={refresh}
              />
            ))}
          </div>
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

function ProviderKeyCard({
  provider,
  saved,
  requireSignIn,
  onChanged,
}: {
  provider: ByokProvider;
  saved: SavedKey | null;
  requireSignIn: () => boolean;
  onChanged: () => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [actionInFlight, setActionInFlight] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showInput = !saved || editing;

  const handleSave = useCallback(async () => {
    if (!requireSignIn()) return;
    if (!normalizeProviderApiKey(value)) {
      setError('Paste the key as a single-line token.');
      return;
    }
    setActionInFlight('save');
    setError(null);
    try {
      const response = await fetch('/api/user/provider-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider: provider.id, apiKey: value.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed (${response.status})`);
      }
      setValue('');
      setEditing(false);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Save failed');
    } finally {
      setActionInFlight(null);
    }
  }, [onChanged, provider.id, requireSignIn, value]);

  const handleRemove = useCallback(async () => {
    setActionInFlight('remove');
    setError(null);
    try {
      const response = await fetch('/api/user/provider-keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider: provider.id }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed (${response.status})`);
      }
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Remove failed');
    } finally {
      setActionInFlight(null);
    }
  }, [onChanged, provider.id]);

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-stone-800">
            {provider.label}
            {saved ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                <CheckCircleIcon className="h-3 w-3" weight="fill" aria-hidden />
                ••••{saved.keyHint}
              </span>
            ) : null}
          </div>
          {saved ? (
            <p className="mt-1 text-[11px] text-stone-400">
              Updated {new Date(saved.updatedAt).toLocaleDateString()}
            </p>
          ) : (
            <a
              href={provider.keysUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-0.5 text-xs text-stone-500 underline hover:text-stone-700"
            >
              Get a key
              <ArrowSquareOutIcon className="h-3 w-3" weight="bold" aria-hidden />
            </a>
          )}
        </div>
        {saved ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing((prev) => !prev);
                setError(null);
              }}
              disabled={actionInFlight !== null}
              className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              {editing ? 'Cancel' : 'Replace'}
            </button>
            <button
              type="button"
              onClick={() => void handleRemove()}
              disabled={actionInFlight !== null}
              className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            >
              {actionInFlight === 'remove' ? 'Removing…' : 'Remove'}
            </button>
          </div>
        ) : null}
      </div>

      {showInput ? (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={provider.placeholder}
            aria-label={`${provider.label} API key`}
            className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 outline-none transition-colors focus:border-orange focus:ring-2 focus:ring-orange/20"
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={actionInFlight !== null || !value.trim()}
            className="shrink-0 rounded-lg bg-orange px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
          >
            {actionInFlight === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
