'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowSquareOutIcon, CheckIcon, CopyIcon, FileTextIcon, XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { IntegrationSignInGate } from '@/components/workspace/integration-signin-gate';
import { useRequireSignIn } from '@/lib/auth/use-require-signin';
import { overleafBotEmail } from '@/lib/overleaf/bot-email';

// Overleaf connection, EXPORT-first: from inside a workspace the natural
// intent is "push what I have here to Overleaf", so the primary action creates
// a new Overleaf project from this workspace's LaTeX-relevant files (bot-owned
// until the first person opens the join link, then ownership transfers to them
// and the bot stays on as the sync editor). Live two-way sync follows
// automatically. The reverse direction (bring an existing Overleaf project
// into Sundial by inviting the bot) lives on the get-started surface; a hint
// here covers it.

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
  projectId?: string;
  onLinked?: (repositoryId: string) => void;
  /** Overleaf projects already linked to this workspace. `joinLink` is set
   *  while the exported project still awaits its first joiner (ownership
   *  transfer pending), so the link survives a modal close or page reload. */
  linkedProjects?: { id: string; label: string; joinLink?: string | null }[];
  /** Open the sidebar Sync section (host closes the modal first). */
  onOpenSync?: () => void;
}) {
  const botEmail = overleafBotEmail();
  // Export is account-scoped (the route rejects anonymous callers), so the
  // export tab gates behind sign-in; the import (invite) flow is deliberately
  // pre-auth and stays open to signed-out users.
  const { signedIn, isLoaded: authLoaded } = useRequireSignIn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinLink, setJoinLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<'email' | 'link' | null>(null);
  const [tab, setTab] = useState<'export' | 'import'>('export');
  // Invite (import) tracker: 'idle' until the user starts, 'waiting' while we
  // poll for Sunny accepting their invite, 'accepted' once THEIR project's
  // live link lands. The poll is scoped by the Overleaf project id parsed from
  // the pasted project link, so concurrent onboarders never see each other's
  // acceptance. The modal then points at the Overleaf chat.
  const [invite, setInvite] = useState<'idle' | 'waiting' | 'accepted'>('idle');
  const [inviteLink, setInviteLink] = useState('');
  // 24-hex Overleaf project id from a pasted project URL (or a bare id).
  const inviteProjectId = inviteLink.match(/[0-9a-f]{24}/i)?.[0]?.toLowerCase() ?? null;
  const inviteProject = useRef<string>('');

  const copy = useCallback(async (kind: 'email' | 'link', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // clipboard unavailable; the value is visible to select
    }
  }, []);

  // Ref'd so acceptance can notify the workspace without the poll effect
  // restarting on every parent render (callback identity churn).
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  useEffect(() => {
    if (invite !== 'waiting') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/workspace/overleaf/onboard-status?project=${encodeURIComponent(inviteProject.current)}`,
          { cache: 'no-store' },
        );
        const body = (await res.json().catch(() => null)) as { accepted?: number } | null;
        if (!cancelled && (body?.accepted ?? 0) > 0) {
          setInvite('accepted');
          // The workspace must SAY it connected, not just this modal
          // ("overleaf should say it connected" — user interviews): refetch
          // linked repos so the badge appears, poll the incoming files, and
          // open the Sync section — the same feedback the export path gets.
          onLinkedRef.current?.(inviteProject.current);
        }
      } catch {
        // transient; keep polling
      }
    };
    const timer = setInterval(() => void tick(), 3000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [invite]);

  const startInviteWait = useCallback(() => {
    if (!inviteProjectId) return;
    inviteProject.current = inviteProjectId;
    setInvite('waiting');
  }, [inviteProjectId]);

  const handleExport = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/workspace/overleaf/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId }),
      });
      const body = (await res.json().catch(() => null)) as
        | { joinLink?: string; projectId?: string; error?: string }
        | null;
      if (!res.ok || !body?.joinLink) throw new Error(body?.error ?? `Export failed (${res.status})`);
      setJoinLink(body.joinLink);
      if (body.projectId) onLinked?.(body.projectId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }, [projectId, onLinked]);

  // A fresh export's link wins; otherwise recover the stored link of an
  // exported project still waiting for its first joiner, so the link is not
  // lost to the linked-repos refresh or a modal reopen.
  const pendingJoinLink = joinLink ?? linkedProjects.find((p) => p.joinLink)?.joinLink ?? null;

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="Sync with Overleaf"
      panelClassName="relative flex w-full max-w-xl flex-col rounded-2xl border border-stone-200 bg-white shadow-xl"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
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
          Sync with Overleaf
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          {tab === 'export'
            ? 'Create an Overleaf project from this workspace and keep them in sync.'
            : 'Create a Sundial workspace from an existing Overleaf project and keep them in sync.'}{' '}
          Works on free Overleaf accounts.
        </p>
        <div className="mt-3 flex gap-1 rounded-lg bg-stone-100 p-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'export'}
            data-testid="overleaf-tab-export"
            onClick={() => setTab('export')}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === 'export' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            New Overleaf project
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'import'}
            data-testid="overleaf-tab-import"
            onClick={() => setTab('import')}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === 'import' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            New Sundial workspace
          </button>
        </div>
      </header>

      <div className="space-y-4 px-6 py-5 text-sm">
        {tab === 'export' ? (
        <>
        {pendingJoinLink ? (
          <div className="space-y-3">
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Your Overleaf project is ready and syncing. Open it to claim ownership; the first
              person to open the link becomes the project owner.
            </p>
            <div className="flex items-center gap-2">
              <a
                href={pendingJoinLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
              >
                Open in Overleaf
                <ArrowSquareOutIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
              </a>
              <button
                type="button"
                onClick={() => void copy('link', pendingJoinLink)}
                aria-label="Copy join link"
                title={copied === 'link' ? 'Copied' : 'Copy join link'}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-stone-300 text-stone-600 hover:bg-stone-100"
              >
                {copied === 'link' ? (
                  <CheckIcon className="h-4 w-4" weight="bold" aria-hidden />
                ) : (
                  <CopyIcon className="h-4 w-4" weight="bold" aria-hidden />
                )}
              </button>
            </div>
            <p className="text-xs text-stone-500">
              Anyone with the link can join and edit, so share it like a document link.
            </p>
          </div>
        ) : linkedProjects.length > 0 ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
            <p className="min-w-0 truncate text-xs text-emerald-800">
              Already synced with{' '}
              <span className="font-medium">{linkedProjects.map((p) => p.label).join(', ')}</span>
            </p>
            {onOpenSync ? (
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
            ) : null}
          </div>
        ) : !authLoaded ? (
          <p className="text-sm text-stone-500">Loading…</p>
        ) : !signedIn ? (
          <IntegrationSignInGate provider="Overleaf" returnParam={{ modal: 'addOverleaf' }} />
        ) : (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={busy || !projectId}
              className="inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
              data-testid="overleaf-export-button"
            >
              {busy ? 'Creating and syncing…' : 'Create and sync'}
            </button>
            <p className="text-xs text-stone-500">
              You get a join link; opening it makes you the project's owner in Overleaf. LaTeX
              project files sync; agent files and build artifacts stay here. Large projects can
              take a few minutes.
            </p>
          </div>
        )}

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
          >
            <p className="font-medium">Couldn’t create and sync the Overleaf project.</p>
            <p className="mt-1">{error}</p>
          </div>
        ) : null}
        </>
        ) : (
        <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
          <p className="text-xs font-medium text-stone-700">
            Connect an existing Overleaf project in under a minute:
          </p>
          <ol className="space-y-2 text-xs text-stone-600">
            <li className="flex items-center gap-2">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-stone-900 text-[10px] font-semibold text-white">1</span>
              <span className="min-w-0">
                In your Overleaf project: <span className="font-medium">Share</span> {'>'} invite{' '}
                <span className="font-medium text-stone-800">{botEmail}</span>
                <button
                  type="button"
                  onClick={() => void copy('email', botEmail)}
                  aria-label="Copy address"
                  title={copied === 'email' ? 'Copied' : 'Copy address'}
                  className="mx-1 inline-flex h-4 w-4 items-center justify-center rounded align-text-bottom text-stone-500 hover:bg-stone-200 hover:text-stone-700"
                >
                  {copied === 'email' ? (
                    <CheckIcon className="h-3 w-3" weight="bold" aria-hidden />
                  ) : (
                    <CopyIcon className="h-3 w-3" weight="bold" aria-hidden />
                  )}
                </button>
                as <span className="font-medium">Editor</span>.
              </span>
            </li>
            <li className="flex items-center gap-2">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-stone-900 text-[10px] font-semibold text-white">2</span>
              {invite === 'accepted' ? (
                <span className="flex items-center gap-1.5 font-medium text-emerald-700" data-testid="invite-accepted">
                  <CheckIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
                  Sunny accepted your invite.
                </span>
              ) : invite === 'waiting' ? (
                <span className="flex items-center gap-1.5 text-stone-600" data-testid="invite-waiting">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" aria-hidden />
                  Waiting for Sunny to accept, usually about 10 seconds.
                </span>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="text"
                    value={inviteLink}
                    onChange={(e) => setInviteLink(e.target.value)}
                    placeholder="Paste your Overleaf project link"
                    data-testid="invite-project-input"
                    className="min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 placeholder:text-stone-400"
                  />
                  <button
                    type="button"
                    onClick={startInviteWait}
                    disabled={!inviteProjectId}
                    data-testid="invite-sent-button"
                    className="shrink-0 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
                  >
                    Connect Overleaf project
                  </button>
                </span>
              )}
            </li>
            <li className="flex items-center gap-2">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-stone-900 text-[10px] font-semibold text-white">3</span>
              <span className={invite === 'accepted' ? 'font-medium text-stone-800' : undefined}>
                Back in Overleaf, open the chat in the left sidebar: Sundial just posted your
                workspace link there. Open it to claim your workspace.
              </span>
            </li>
          </ol>
        </div>
        )}
      </div>
    </ModalShell>
  );
}
