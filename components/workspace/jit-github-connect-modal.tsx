'use client';

import { useCallback, useEffect } from 'react';
import { GithubLogoIcon, XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { buildReturnPath, useRequireSignIn } from '@/lib/auth/use-require-signin';

const OAUTH_MESSAGE_TYPE = 'sundial:github-oauth';

// Just-in-time modal shown when the user tries to push/commit on a linked
// GitHub repo but their personal connection is missing. We block the action
// (no workspace fallback for writes) and prompt them to connect. After the
// popup closes we fire `onConnected` so the caller can retry the action.

export function JitGitHubConnectModal({
  open,
  onClose,
  onConnected,
  action,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
  /** The action that was being attempted, displayed in the modal copy. */
  action?: string | null;
}) {
  const { requireSignIn } = useRequireSignIn();
  const handleConnect = useCallback(() => {
    // If somehow reached logged out, send to Clerk first and land on the GitHub
    // settings tab to connect after sign-in.
    if (!requireSignIn(buildReturnPath({ panel: 'github' }))) return;
    const returnPath = `${window.location.pathname}?panel=github`;
    const url = `/api/user/github/start?returnPath=${encodeURIComponent(returnPath)}`;
    const popup = window.open(url, 'sundial-github-oauth', 'width=720,height=820');
    if (!popup) {
      window.location.href = url;
      return;
    }
    // The repo-picker leg can finish on another origin (no postMessage), so
    // also fire onConnected when the popup closes.
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        onConnected();
      }
    }, 750);
  }, [onConnected, requireSignIn]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== OAUTH_MESSAGE_TYPE) return;
      onConnected();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [open, onConnected]);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="Connect GitHub"
      panelClassName="relative flex w-full max-w-md flex-col rounded-2xl border border-stone-200 bg-white shadow-xl"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-600"
      >
        <XIcon className="h-4 w-4" weight="bold" aria-hidden />
      </button>

      <div className="px-6 py-7">
        <GithubLogoIcon className="h-9 w-9 text-stone-700" weight="fill" aria-hidden />
        <h2 className="mt-3 text-lg font-semibold text-stone-900">Connect GitHub to continue</h2>
        <p className="mt-2 text-sm text-stone-500">
          Sundial uses <span className="font-medium text-stone-700">your</span> GitHub token for
          writes so commits show your identity, never a teammate&apos;s. Connect once and we&apos;ll use it
          for every workspace.
        </p>
        {action ? (
          <p className="mt-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-500">
            Attempted action: <span className="font-medium text-stone-700">{action}</span>
          </p>
        ) : null}
        <button
          type="button"
          onClick={handleConnect}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
        >
          <GithubLogoIcon className="h-4 w-4" weight="fill" aria-hidden />
          Connect GitHub
        </button>
      </div>
    </ModalShell>
  );
}
