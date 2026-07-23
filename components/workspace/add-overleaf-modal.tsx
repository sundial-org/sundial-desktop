'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowSquareOutIcon, CheckCircleIcon, CircleNotchIcon, FileTextIcon, XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { useRequireSignIn } from '@/lib/auth/use-require-signin';
import { IntegrationSignInGate } from '@/components/workspace/integration-signin-gate';
import { CloneProgress } from '@/components/workspace/clone-progress';
import { humanizeGitError } from '@/lib/git-remote/humanize-error';
import { Spinner } from '@/components/ui/spinner';

type OverleafStatus = { connected: boolean; overleafEmail: string | null };

export function AddOverleafModal({
  open,
  onClose,
  projectId,
  onLinked,
  linkedProjects = [],
  onOpenSync,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onLinked: (repositoryId: string) => void;
  /** Overleaf projects already linked to this workspace — shown with a
   *  shortcut to the Sync panel (where push/pull/commit live). */
  linkedProjects?: { id: string; label: string }[];
  /** Open the sidebar Sync section (host closes the modal first). */
  onOpenSync?: () => void;
}) {
  const { signedIn, isLoaded: authLoaded, requireSignIn } = useRequireSignIn();
  const [status, setStatus] = useState<OverleafStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [busy, setBusy] = useState<'linking' | 'cloning' | 'saving' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectUrl, setProjectUrl] = useState('');
  const [importedPath, setImportedPath] = useState('');
  const [token, setToken] = useState('');
  const [tokenEmail, setTokenEmail] = useState('');

  const refresh = useCallback(async () => {
    setStatusLoading(true);
    try {
      const response = await fetch('/api/user/overleaf/connection', {
        cache: 'no-store',
        credentials: 'include',
      });
      const body = (await response.json().catch(() => null)) as OverleafStatus | null;
      setStatus(body ?? { connected: false, overleafEmail: null });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !authLoaded) return;
    // Skip the account-scoped status fetch when logged out (would 401).
    if (!signedIn) return;
    void refresh();
  }, [open, authLoaded, signedIn, refresh]);

  const handleSaveToken = useCallback(async () => {
    if (!requireSignIn()) return;
    if (!token.trim()) return;
    setBusy('saving');
    setError(null);
    try {
      const res = await fetch('/api/user/overleaf/connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ accessToken: token.trim(), overleafEmail: tokenEmail.trim() || null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed to save token (${res.status})`);
      }
      setToken('');
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save Overleaf token');
    } finally {
      setBusy(null);
    }
  }, [token, tokenEmail, refresh, requireSignIn]);

  const handleLink = useCallback(async () => {
    if (!requireSignIn()) return;
    if (!projectUrl.trim()) return;
    setBusy('linking');
    setError(null);
    try {
      const link = await fetch('/api/workspace/linked-repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          projectId,
          provider: 'overleaf',
          projectUrl: projectUrl.trim(),
          importedPath: importedPath.trim() || undefined,
        }),
      });
      const linkBody = (await link.json().catch(() => null)) as
        | { repositoryId?: string; error?: string }
        | null;
      if (!link.ok || !linkBody?.repositoryId) {
        throw new Error(linkBody?.error ?? `Link failed (${link.status})`);
      }

      setBusy('cloning');
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
          `Project linked but initial clone failed: ${humanizeGitError('overleaf', raw)}`,
        );
      }

      onLinked(linkBody.repositoryId);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to link Overleaf project');
    } finally {
      setBusy(null);
    }
  }, [projectUrl, importedPath, projectId, onClose, onLinked, requireSignIn]);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="Add Overleaf project"
      panelClassName="relative flex w-full max-w-xl flex-col rounded-2xl border border-stone-200 bg-white shadow-xl"
      // Same guard as the GitHub modal: don't let a stray click/Escape
      // silently dismiss the modal while link/clone is in flight.
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
          <FileTextIcon className="h-5 w-5 text-emerald-700" weight="fill" aria-hidden />
          Add an Overleaf project
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          Requires{' '}
          <a
            className="text-stone-700 underline"
            href="https://www.overleaf.com/learn/how-to/Git_integration"
            target="_blank"
            rel="noreferrer"
          >
            Overleaf Premium git integration
            <ArrowSquareOutIcon className="ml-0.5 inline h-3 w-3" weight="bold" aria-hidden />
          </a>
          .
        </p>
      </header>

      {busy === 'linking' || busy === 'cloning' ? (
        <CloneProgress
          phase={busy}
          target={projectUrl.trim() || 'your Overleaf project'}
          icon={<FileTextIcon className="h-7 w-7 text-emerald-700" weight="fill" aria-hidden />}
        />
      ) : (
      <>
      <div className="space-y-4 px-6 py-5 text-sm">
        {linkedProjects.length > 0 && onOpenSync ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
            <p className="min-w-0 truncate text-xs text-stone-600">
              Linked: <span className="font-medium text-stone-800">{linkedProjects.map((p) => p.label).join(', ')}</span>
            </p>
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenSync();
              }}
              className="shrink-0 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100"
            >
              Open Sync panel
            </button>
          </div>
        ) : null}
        {!authLoaded ? (
          <Spinner label="Loading…" />
        ) : !signedIn ? (
          <IntegrationSignInGate provider="Overleaf" returnParam={{ modal: 'addOverleaf' }} />
        ) : statusLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-stone-400">
            <CircleNotchIcon className="h-4 w-4 animate-spin" weight="bold" aria-hidden />
            Checking Overleaf connection…
          </div>
        ) : !status?.connected ? (
          <div className="space-y-3">
            <p className="text-sm text-stone-700">
              Paste your Overleaf{' '}
              <a
                className="text-stone-700 underline"
                href="https://www.overleaf.com/user/settings"
                target="_blank"
                rel="noreferrer"
              >
                git-integration token
              </a>{' '}
              to clone, pull, and push. Stored once for your account.
            </p>
            <label className="block">
              <span className="text-xs font-medium text-stone-500">Token</span>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                type="password"
                placeholder="olp_…"
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-stone-500">Email (optional)</span>
              <input
                value={tokenEmail}
                onChange={(event) => setTokenEmail(event.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleSaveToken()}
              disabled={busy !== null || !token.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
            >
              {busy === 'saving' ? 'Saving…' : 'Save token'}
            </button>
          </div>
        ) : (
          <>
            <p className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              <CheckCircleIcon className="h-4 w-4 shrink-0" weight="fill" aria-hidden />
              <span>Connected as <span className="font-medium">{status.overleafEmail || 'your Overleaf account'}</span></span>
            </p>

            <label className="block">
              <span className="text-xs font-medium text-stone-500">Project URL or ID</span>
              <input
                value={projectUrl}
                onChange={(event) => setProjectUrl(event.target.value)}
                placeholder="https://www.overleaf.com/project/abc123… or git@git.overleaf.com:abc123…"
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-stone-500">Subfolder (optional)</span>
              <input
                value={importedPath}
                onChange={(event) => setImportedPath(event.target.value)}
                placeholder="e.g. paper-draft"
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500"
              />
            </label>
          </>
        )}

        {error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}
      </div>

      {status?.connected ? (
        <footer className="flex justify-end gap-2 border-t border-stone-200 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleLink()}
            disabled={busy !== null || !projectUrl.trim()}
            className="rounded-lg bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
          >
            Link &amp; clone
          </button>
        </footer>
      ) : null}
      </>
      )}
    </ModalShell>
  );
}
