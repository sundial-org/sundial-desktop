'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, useClerk, useUser } from '@/lib/auth/optional-auth';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { isDesktopApp } from '@/lib/desktop';
import { useDesktopCredentials } from '@/lib/local/use-desktop-credentials';
import { sidecar, type LocalProject, type LocalShare, type SidecarConfig } from '@/lib/local/sidecar';
import { WorkspaceShareModal } from '@/app/w/[slug]/_components/workspace-share-modal';
import { shareOrigin, useWorkspaceShare, type ShareInfo } from '@/app/w/[slug]/_components/workspace-share';
import { STANDARD_WORKSPACE_KIND } from '@/lib/workspace/kinds';
import { formatRelativeTimeShort } from '@/lib/format';

/** Cloud-workspace links must not yank the user out of their local project.
 *  Browsers open a new tab; the desktop shell can't (the webview drops
 *  target="_blank"), so there the link goes through the /desktop/external
 *  marker, which the shell intercepts and opens in the SYSTEM BROWSER. */
const cloudHref = (target: string) => {
  if (!isDesktopApp()) return target;
  try {
    // open_url may be absolute; the marker only ejects same-origin PATHS.
    const url = new URL(target, window.location.origin);
    if (url.origin !== window.location.origin) return target;
    return `/desktop/external?to=${encodeURIComponent(url.pathname + url.search + url.hash)}`;
  } catch {
    return target;
  }
};
const blankTarget = () => (isDesktopApp() ? undefined : '_blank');

export type ShareScope = { kind: 'project' | 'folder' | 'file'; path: string };

const scopeName = (scope: { kind: string; path: string }, projectName: string) =>
  scope.kind === 'project' || !scope.path ? projectName : scope.path;

// Pre-share state for the GDocs-style modal: Restricted, nobody invited yet.
const UNSHARED_INFO: ShareInfo = {
  visibility: 'private',
  publicAccess: 'none',
  isOwner: true,
  canInvite: true,
  organization: null,
  members: [],
  invites: [],
};

/** Shares a local scope (whole project, a subfolder, or a single file) to the
 *  cloud. Presented as the standard GDocs-style share modal: flipping General
 *  access to "Anyone with the link" creates a cloud workspace, makes it
 *  link-viewable, mints a 7-day sync token, and hands both to the sidecar,
 *  which live-syncs the scope both ways from then on. Only files inside the
 *  scope ever leave the machine; WHO can see them is the cloud workspace's
 *  own member/invite ACL — once shared, the same modal manages that ACL
 *  directly (invites, roles, link access). Scopes can't overlap (the sidecar
 *  rejects it), so every subtree has exactly one audience. */
export function ShareLocalModal({
  config,
  project,
  scope,
  shares,
  onClose,
  onShared,
}: {
  config: SidecarConfig;
  project: LocalProject;
  scope: ShareScope;
  shares: LocalShare[];
  onClose: () => void;
  onShared: () => void;
}) {
  const router = useRouter();
  const { user } = useUser();
  const { isSignedIn: clerkSignedIn } = useAuth();
  const { openSignIn } = useClerk();
  // The packaged app has no webview Clerk session — sidecar sd_ credentials
  // are its sign-in state (the proxy attaches them to the cloud calls below).
  const desktopCredentials = useDesktopCredentials(config);
  const isSignedIn = clerkSignedIn || desktopCredentials;
  // Which pre-share action is in flight — mirrored into shareBusyAction so the
  // modal's own busy affordances (Send → "Sending...", disabled flip) apply.
  const [busyAction, setBusyAction] = useState<'visibility-public' | 'email' | 'stop' | null>(null);
  const busy = busyAction !== null;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(null);

  const enabled = shares.filter((share) => share.enabled);
  const scopePath = scope.kind === 'project' ? '' : scope.path;
  // Overlap mirror of the sidecar's rule (one audience per subtree), BOTH
  // directions — checked here so the create flow can't first mint a cloud
  // workspace that the sidecar then rejects (orphaning it):
  // - a scope COVERING this node → manage that share;
  // - shares INSIDE this node → block the create until they're stopped.
  const contains = (outer: string, inner: string) => !outer || inner === outer || inner.startsWith(`${outer}/`);
  const existing = enabled.find((share) => contains(share.scope_path, scopePath));
  const descendants = existing ? [] : enabled.filter((share) => contains(scopePath, share.scope_path));
  const scopeLabel = scopeName(scope, project.name);
  const scopeWord = scope.kind === 'project' ? 'project' : scope.kind;
  // `existing` may be an ANCESTOR share covering this node. Stopping it would
  // silently kill sync for the whole broader scope, so Stop syncing is only
  // offered when the share is exactly this scope; ancestors are labeled.
  const exactShare = existing && existing.scope_path === scopePath ? existing : null;
  const coveringLabel =
    existing && !exactShare
      ? scopeName({ kind: existing.scope_kind, path: existing.scope_path }, project.name)
      : null;

  // The share's audience IS the cloud workspace's ACL, so once a workspace
  // exists the standard workspace-share hook drives the whole modal against
  // it (invites, roles, link visibility). Empty id keeps the hook inert.
  const cloudWorkspaceId = existing?.workspace_id ?? createdWorkspaceId;
  const cloud = useWorkspaceShare({
    projectId: cloudWorkspaceId ?? '',
    projectKind: STANDARD_WORKSPACE_KIND,
    workspaceRouteId: cloudWorkspaceId ?? '',
    currentChatId: null,
    user,
    router,
    openSignIn,
  });

  const api = async <T,>(path: string, failure: string, body?: object, method?: string): Promise<T> => {
    const res = await fetch(path, {
      credentials: 'include',
      ...(body
        ? { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(parsed?.error || failure);
    return parsed;
  };

  /** Creates the backing cloud workspace and starts the sidecar sync. Returns
   *  the new workspace id (null on failure). `makePublic` reflects which
   *  gesture triggered the flip: the General-access "Anyone with the link"
   *  pick makes it link-viewable; an email invite keeps it Restricted. */
  const share = async (action: 'visibility-public' | 'email'): Promise<string | null> => {
    setBusyAction(action);
    setError(null);
    try {
      const title =
        scope.kind === 'project' ? project.name : `${project.name} / ${scope.path.split('/').pop()}`;
      const created = await api<{ project: { id: string; open_url: string } }>(
        '/api/workspace',
        'Failed to create workspace',
        { title, seedStarter: false },
      );
      // "Anyone with the link" is what the user just picked — make the cloud
      // workspace actually link-viewable, not merely existent.
      if (action === 'visibility-public') {
        await api(
          '/api/workspace/share',
          'Failed to enable link access',
          { projectId: created.project.id, visibility: 'public', publicAccess: 'view' },
          'PATCH',
        );
      }
      const host = await api<{ collabUrl?: string }>(
        `/api/workspace/host?workspaceId=${encodeURIComponent(created.project.id)}&ensure=1`,
        'Collab host unavailable',
      );
      if (!host.collabUrl) throw new Error('Collab host unavailable');
      const join = await api<{ token?: string }>(
        '/api/workspace/local-agent/join',
        'Failed to mint sync token',
        { projectId: created.project.id, bridge: true },
      );
      if (!join.token) throw new Error('Failed to mint sync token');

      await sidecar.createShare(config, project.id, {
        workspaceId: created.project.id,
        collabUrl: host.collabUrl,
        apiOrigin: window.location.origin,
        token: join.token,
        scopeKind: scope.kind,
        scopePath,
      });

      onShared();
      return created.project.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Share failed');
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const stopSharing = async (shareId: string) => {
    setBusyAction('stop');
    setError(null);
    try {
      await sidecar.removeShare(config, project.id, shareId);
      setCreatedWorkspaceId(null);
      onShared();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop sharing');
    } finally {
      setBusyAction(null);
    }
  };

  // Pre-share, sharing gestures ARE the share action. Signed out they become
  // the sign-in action — Clerk's imperative openSignIn, which
  // DesktopAuthInterceptor routes through the browser handoff in the shell.
  // Returns false when the flip can't proceed.
  const preShareGuard = () => {
    if (busy) return false;
    if (!isSignedIn) {
      openSignIn?.({ forceRedirectUrl: window.location.pathname });
      return false;
    }
    if (descendants.length > 0) {
      setError(`Parts of this ${scopeWord} are already shared separately — stop those shares first.`);
      return false;
    }
    return true;
  };

  // setCreatedWorkspaceId flips the modal to its cloud-backed state and kicks
  // the share hook's ACL load — the email path defers it until the invite has
  // landed so the first load already includes the pending invite row.
  const handlePreShareVisibility = (visibility: 'private' | 'public') => {
    if (visibility !== 'public' || !preShareGuard()) return;
    void share('visibility-public').then((id) => id && setCreatedWorkspaceId(id));
  };

  // Pre-share Copy link: a local scope has no shareable URL yet, so the
  // button performs the "Anyone with the link" flip and copies the new cloud
  // workspace link in one gesture.
  const handlePreShareCopyLink = async () => {
    if (!preShareGuard()) return;
    const id = await share('visibility-public');
    if (!id) return;
    setCreatedWorkspaceId(id);
    try {
      await navigator.clipboard.writeText(`${shareOrigin()}/w/${id}`);
      setNotice('Link copied');
      window.setTimeout(() => setNotice(''), 3000);
    } catch {
      setError('Copy failed');
    }
  };

  // Inviting someone to an unshared scope flips it to the cloud first (kept
  // Restricted), then sends a standard workspace invite on the new workspace.
  const handlePreShareInvite = async () => {
    const email = cloud.inviteEmail.trim().toLowerCase();
    // Validate BEFORE the cloud flip — a bad address must not leave the scope
    // uploaded and syncing with no invite to show for it.
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Enter a valid email address.');
      return;
    }
    if (!preShareGuard()) return;
    const workspaceId = await share('email');
    if (!workspaceId) return;
    setBusyAction('email');
    try {
      const sent = await api<{ emailSent?: boolean }>('/api/workspace/share', 'Unable to send invite.', {
        projectId: workspaceId,
        role: cloud.inviteRole,
        email,
      });
      if (sent.emailSent) {
        setNotice(`Invite sent to ${email}`);
        window.setTimeout(() => setNotice(''), 3000);
      } else {
        setError('Invite created, but the email could not be sent.');
      }
      cloud.setInviteEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send invite.');
    } finally {
      setCreatedWorkspaceId(workspaceId);
      setBusyAction(null);
    }
  };

  // GDocs anatomy even before anything is shared: the owner row keeps the
  // People section populated instead of an empty void.
  const unsharedInfo = useMemo<ShareInfo>(
    () => ({
      ...UNSHARED_INFO,
      members: user
        ? [{
            user_id: user.id,
            role: 'owner',
            joined_at: '',
            email: user.primaryEmailAddress?.emailAddress ?? null,
            name: user.fullName ?? null,
            username: user.username ?? null,
            imageUrl: user.imageUrl ?? null,
          }]
        : [],
    }),
    [user],
  );

  const conflictRows =
    descendants.length > 0 ? (
      <div className="mt-1">
        <div className="text-xs font-medium text-stone-500 mb-1">Already shared inside this {scopeWord}</div>
        <div className="space-y-1">
          {descendants.map((entry) => (
            <div key={entry.id} className="flex items-center gap-3 rounded-lg border border-stone-200 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[13px] text-stone-700">
                {scopeName({ kind: entry.scope_kind, path: entry.scope_path }, project.name)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void stopSharing(entry.id)}
                className="text-[12px] font-medium text-rose-600 hover:text-rose-700 disabled:opacity-50"
                data-testid={`share-stop-${entry.scope_path || 'project'}`}
              >
                Stop
              </button>
            </div>
          ))}
        </div>
      </div>
    ) : null;

  const openWorkspaceRow = cloudWorkspaceId ? (
    <div className="mt-1 flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] leading-snug text-stone-400">
        {coveringLabel ? `Shared as part of “${coveringLabel}” · ` : ''}
        {existing?.error ??
          (existing?.status === 'active'
            ? `${existing.bridgedFiles} file${existing.bridgedFiles === 1 ? '' : 's'} syncing`
            : existing?.status ?? 'Starting sync…')}
      </span>
      <a
        href={cloudHref(`/w/${cloudWorkspaceId}`)}
        target={blankTarget()}
        rel="noreferrer"
        className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-stone-600 hover:text-stone-900"
        data-testid="share-open-workspace"
      >
        Open cloud workspace <ArrowSquareOutIcon className="h-3.5 w-3.5" aria-hidden />
      </a>
    </div>
  ) : null;

  const isShared = Boolean(cloudWorkspaceId);
  return (
    <WorkspaceShareModal
      open
      subject={scope.kind === 'project' ? 'workspace' : scope.kind}
      projectTitle={scopeLabel}
      userId={user?.id}
      shareInfo={isShared ? cloud.shareInfo : unsharedInfo}
      shareError={error ?? (isShared ? cloud.shareError : '')}
      copyNotice={(isShared && cloud.copyNotice) || notice}
      // Until the cloud ACL actually loads (still fetching, or signed into an
      // account without access), the hook's optimistic defaults must not
      // surface live-looking invite / General-access controls — read-only +
      // the hook's load error instead. Pre-share the modal owns both flows:
      // invite → cloud flip (Restricted) + workspace invite.
      canManageShare={isShared ? Boolean(cloud.shareInfo) && cloud.canManageShare : true}
      canInviteShare={isShared ? Boolean(cloud.shareInfo) && cloud.canInviteShare : true}
      pendingEmailInvites={isShared ? cloud.pendingEmailInvites : []}
      inviteEmail={cloud.inviteEmail}
      setInviteEmail={cloud.setInviteEmail}
      inviteRole={cloud.inviteRole}
      setInviteRole={cloud.setInviteRole}
      shareDropdown={cloud.shareDropdown}
      setShareDropdown={cloud.setShareDropdown}
      shareBusyAction={busyAction ?? cloud.shareBusyAction}
      onClose={onClose}
      onCreateEmailInvite={isShared ? cloud.handleCreateEmailInvite : handlePreShareInvite}
      onCreateLinkInvite={isShared ? cloud.handleCreateLinkInvite : handlePreShareCopyLink}
      onUpdateMemberRole={cloud.handleUpdateMemberRole}
      onRemoveMember={cloud.handleRemoveMember}
      onResendInvite={cloud.handleResendShareInvite}
      onRevokeInvite={cloud.handleRevokeShareInvite}
      onVisibilityChange={isShared ? cloud.handleVisibilityChange : handlePreShareVisibility}
      onPublicAccessChange={cloud.handlePublicAccessChange}
      onOpenTeamPermissions={cloud.handleOpenTeamPermissions}
      formatRelativeTime={(value) => (value ? formatRelativeTimeShort(value) : '')}
      accessCaption={
        isShared
          ? `Synced with a cloud workspace; everything else stays on your machine.`
          : `Sharing syncs this ${scopeWord} to a cloud workspace; everything else stays on your machine.`
      }
      bodyExtra={isShared ? openWorkspaceRow : conflictRows}
      onStopSharing={exactShare ? () => void stopSharing(exactShare.id) : undefined}
    />
  );
}
