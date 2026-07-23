'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LINK_INVITE_EMAIL } from '@/lib/workspace/invites';
import { buildWorkspacePath } from '@/lib/workspace/paths';
import type { WorkspaceKind } from '@/lib/workspace/kinds';
import { track } from '@/lib/analytics/track';
import { isDesktopApp } from '@/lib/desktop';
import { SITE_URL } from '@/lib/seo';

/** Origin for links handed to collaborators. In the packaged desktop shell
 *  window.location.origin is the loopback proxy — useless off this machine —
 *  so shareable links must use the public site origin instead. */
export const shareOrigin = () => (isDesktopApp() ? SITE_URL : window.location.origin);

type WorkspaceRouteId = string | { id: string; public_id: string | null };
type RouterLike = {
  push(href: string): void;
};

type WorkspaceUser =
  | {
      id?: string | null;
    }
  | null
  | undefined;

export type ShareInvite = {
  id: string;
  token: string;
  role: 'editor' | 'commenter' | 'viewer';
  email: string | null;
  target_chat_id?: string | null;
  accepted_at: string | null;
  created_at: string;
  expires_at: string | null;
};

export type ShareOrganization = {
  id: string;
  name: string;
  role: string;
  canOpenPermissions: boolean;
  permissionsHref: string | null;
};

export type ShareMember = {
  user_id: string;
  role: 'owner' | 'editor' | 'commenter' | 'viewer';
  joined_at: string;
  email: string | null;
  name: string | null;
  username: string | null;
  imageUrl: string | null;
};

export type ShareInfo = {
  visibility: 'private' | 'public';
  publicAccess: 'view' | 'suggest' | 'edit' | 'none';
  isOwner: boolean;
  canInvite: boolean;
  organization: ShareOrganization | null;
  members: ShareMember[];
  invites: ShareInvite[];
};

export function useWorkspaceShare({
  projectId,
  projectKind,
  workspaceRouteId,
  currentChatId,
  user,
  router,
  openSignIn,
}: {
  projectId: string;
  projectKind: WorkspaceKind | null;
  workspaceRouteId: WorkspaceRouteId;
  currentChatId: string | null;
  user: WorkspaceUser;
  router: RouterLike;
  openSignIn: (options?: { redirectUrl?: string }) => void;
}) {
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);
  const [shareError, setShareError] = useState('');
  // Role granted by the "Copy link" join invite on a Restricted workspace.
  // The modal offers no role choice for this link, so it must not silently
  // mint editor membership; owners can upgrade members from the People list.
  const linkRole = 'viewer';
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'commenter' | 'viewer'>('editor');
  const [shareBusyAction, setShareBusyAction] = useState<string | null>(null);
  const [shareDropdown, setShareDropdown] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState('');

  const canManageShare = shareInfo?.isOwner ?? true;
  const canInviteShare = shareInfo?.canInvite ?? canManageShare;
  const canShowShareControls = projectKind !== null;

  const pendingEmailInvites = useMemo(
    () =>
      (shareInfo?.invites ?? []).filter(
        (invite): invite is ShareInvite & { email: string } =>
          Boolean(invite.email && invite.email !== LINK_INVITE_EMAIL && invite.accepted_at === null),
      ),
    [shareInfo?.invites],
  );

  const shareStatus = useMemo(() => {
    if (!shareInfo) return 'private';
    if (shareInfo.visibility === 'public' && shareInfo.publicAccess !== 'none') return 'public';
    if ((shareInfo.members?.length ?? 0) > 1 || (shareInfo.invites?.length ?? 0) > 0) return 'shared';
    return 'private';
  }, [shareInfo]);

  const loadShareInfo = useCallback(async () => {
    if (!projectId || projectKind === null) return;
    setShareError('');
    try {
      const res = await fetch(`/api/workspace/share?projectId=${projectId}`);
      if (!res.ok) {
        setShareError('Unable to load sharing settings.');
        return;
      }
      const payload = (await res.json()) as {
        project: { visibility: 'private' | 'public'; publicAccess?: 'view' | 'suggest' | 'edit' | 'none' };
        isOwner: boolean;
        canInvite?: boolean;
        organization?: ShareOrganization | null;
        members: ShareMember[];
        invites: ShareInvite[];
      };
      setShareInfo({
        visibility: payload.project.visibility,
        publicAccess: payload.project.publicAccess ?? 'edit',
        isOwner: payload.isOwner,
        canInvite: payload.canInvite ?? payload.isOwner,
        organization: payload.organization ?? null,
        members: payload.members ?? [],
        invites: payload.invites ?? [],
      });
    } finally {
      // no-op
    }
  }, [projectId, projectKind]);

  useEffect(() => {
    if (!showShareModal) return;
    void loadShareInfo();
  }, [showShareModal, loadShareInfo]);

  useEffect(() => {
    if (!projectId) return;
    void loadShareInfo();
  }, [projectId, loadShareInfo]);

  useEffect(() => {
    if (!shareDropdown) return;
    const handler = () => setShareDropdown(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [shareDropdown]);

  const handleOpenShare = useCallback(() => {
    if (!projectId) return;
    if (!canShowShareControls) return;
    if (!user) {
      openSignIn({ redirectUrl: buildWorkspacePath(workspaceRouteId) });
      return;
    }
    setShowShareModal(true);
  }, [canShowShareControls, openSignIn, projectId, user, workspaceRouteId]);

  const handleCopyInvite = useCallback(async (link: string) => {
    track('share_copy_link_clicked', { projectId, kind: 'invite' });
    try {
      await navigator.clipboard.writeText(link);
      setShareBusyAction('link-copied');
      window.setTimeout(() => setShareBusyAction((prev) => (prev === 'link-copied' ? null : prev)), 2000);
    } catch {
      setShareError('Copy failed');
    }
  }, [projectId]);

  const handleCreateLinkInvite = useCallback(async () => {
    if (!projectId) return;
    // When the workspace is link-shared, the doc URL itself is the share
    // link — no invite/login round-trip. lib/workspace/access.ts grants anon
    // access only when visibility='public' AND public_access != 'none'. The
    // /invite/<token> flow is only for restricted workspaces where the
    // visitor needs to be added to project_members on accept.
    const isEffectivelyPublic =
      shareInfo?.visibility === 'public' && shareInfo.publicAccess !== 'none';
    if (isEffectivelyPublic) {
      setShareBusyAction('link');
      setShareError('');
      setCopyNotice('');
      try {
        await handleCopyInvite(`${shareOrigin()}${buildWorkspacePath(workspaceRouteId)}`);
      } catch {
        setShareBusyAction(null);
      }
      return;
    }
    if (!canInviteShare) return;
    setShareBusyAction('link');
    setShareError('');
    setCopyNotice('');
    try {
      const existingInvite = shareInfo?.invites?.find(
        (invite) =>
          (invite.email === LINK_INVITE_EMAIL || invite.email === null) &&
          invite.role === linkRole &&
          (invite.target_chat_id ?? null) === (currentChatId ?? null) &&
          invite.accepted_at === null,
      );
      if (existingInvite) {
        await handleCopyInvite(`${shareOrigin()}/invite/${existingInvite.token}`);
        return;
      }
      const res = await fetch('/api/workspace/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          role: linkRole,
          ...(currentChatId ? { chatId: currentChatId } : {}),
        }),
      });
      if (!res.ok) {
        setShareBusyAction(null);
        setShareError('Unable to create join link.');
        return;
      }
      const payload = (await res.json()) as { inviteUrl: string };
      await handleCopyInvite(payload.inviteUrl);
      await loadShareInfo();
    } catch {
      setShareBusyAction(null);
    }
  }, [canInviteShare, currentChatId, handleCopyInvite, linkRole, loadShareInfo, projectId, shareInfo?.invites, shareInfo?.publicAccess, shareInfo?.visibility, workspaceRouteId]);

  const handleCreateEmailInvite = useCallback(async () => {
    if (!projectId || !canInviteShare) return;
    const normalizedEmail = inviteEmail.trim().toLowerCase();
    if (!normalizedEmail) {
      setShareError('Enter an email to invite.');
      return;
    }
    setShareBusyAction('email');
    setShareError('');
    setCopyNotice('');
    try {
      const res = await fetch('/api/workspace/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          role: inviteRole,
          email: normalizedEmail,
          ...(currentChatId ? { chatId: currentChatId } : {}),
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        setShareError(payload?.error ?? 'Unable to send invite.');
        return;
      }
      const payload = (await res.json()) as { inviteUrl: string; emailSent?: boolean };
      if (payload.emailSent) {
        track('share_email_invite_sent', {
          projectId,
          role: inviteRole,
          chatId: currentChatId ?? null,
        });
        setCopyNotice(`Invite sent to ${normalizedEmail}`);
        window.setTimeout(() => setCopyNotice(''), 3000);
        setInviteEmail('');
      } else {
        setShareError('Invite created, but the email could not be sent. You can still share a join link above.');
      }
      await loadShareInfo();
    } finally {
      setShareBusyAction(null);
    }
  }, [canInviteShare, currentChatId, inviteEmail, inviteRole, loadShareInfo, projectId]);

  const handleVisibilityChange = useCallback(
    async (visibility: 'private' | 'public') => {
      if (!projectId || !shareInfo?.isOwner) return;
      setShareBusyAction(visibility === 'private' ? 'visibility-private' : 'visibility-public');
      setShareError('');
      try {
        // Turning link sharing ON always starts at Viewer: a restricted
        // workspace may hold a latent public_access='edit' (the old DB
        // default) the owner never chose, and 'none' would leave the link
        // useless. Re-selecting "Anyone with the link" while already shared
        // keeps the chosen role.
        const wasLinkShared = shareInfo.visibility === 'public' && shareInfo.publicAccess !== 'none';
        const grantView = visibility === 'public' && !wasLinkShared;
        const res = await fetch('/api/workspace/share', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, visibility, ...(grantView ? { publicAccess: 'view' } : {}) }),
        });
        if (!res.ok) {
          setShareError('Unable to update visibility.');
          return;
        }
        const payload = (await res.json()) as {
          project: { visibility: 'private' | 'public'; publicAccess: 'view' | 'suggest' | 'edit' | 'none' };
        };
        setShareInfo((prev) =>
          prev
            ? {
                ...prev,
                visibility: payload.project.visibility,
                publicAccess: payload.project.publicAccess,
              }
            : prev,
        );
      } finally {
        setShareBusyAction(null);
      }
    },
    [projectId, shareInfo?.isOwner, shareInfo?.publicAccess, shareInfo?.visibility],
  );

  const handlePublicAccessChange = useCallback(
    async (publicAccess: 'view' | 'suggest' | 'edit' | 'none') => {
      if (!projectId || !shareInfo?.isOwner) return;
      setShareBusyAction(`public-access-${publicAccess}`);
      setShareError('');
      try {
        const res = await fetch('/api/workspace/share', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, publicAccess }),
        });
        if (!res.ok) {
          setShareError('Unable to update public access.');
          return;
        }
        const payload = (await res.json()) as { project: { publicAccess: 'view' | 'suggest' | 'edit' | 'none' } };
        setShareInfo((prev) => (prev ? { ...prev, publicAccess: payload.project.publicAccess } : prev));
      } finally {
        setShareBusyAction(null);
      }
    },
    [projectId, shareInfo?.isOwner],
  );

  const handleUpdateMemberRole = useCallback(
    async (memberId: string, role: 'editor' | 'commenter' | 'viewer') => {
      if (!projectId || !shareInfo?.isOwner) return;
      setShareBusyAction(`member-role-${memberId}`);
      setShareError('');
      try {
        const res = await fetch('/api/workspace/share', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, memberId, role }),
        });
        if (!res.ok) {
          setShareError('Unable to update permissions.');
          return;
        }
        await loadShareInfo();
      } finally {
        setShareBusyAction(null);
      }
    },
    [loadShareInfo, projectId, shareInfo?.isOwner],
  );

  const handleRemoveMember = useCallback(
    async (memberId: string) => {
      if (!projectId || !shareInfo?.isOwner) return;
      setShareBusyAction(`member-remove-${memberId}`);
      setShareError('');
      try {
        const res = await fetch('/api/workspace/share', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, memberId }),
        });
        if (!res.ok) {
          setShareError('Unable to revoke access.');
          return;
        }
        await loadShareInfo();
      } finally {
        setShareBusyAction(null);
      }
    },
    [loadShareInfo, projectId, shareInfo?.isOwner],
  );

  const handleResendShareInvite = useCallback(
    async (inviteId: string, email: string) => {
      if (!projectId || !canInviteShare) return;
      setShareBusyAction(`invite-resend-${inviteId}`);
      setShareError('');
      setCopyNotice('');
      try {
        const res = await fetch('/api/workspace/share', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, inviteId }),
        });
        const payload = (await res.json().catch(() => null)) as { error?: string; emailSent?: boolean } | null;
        if (!res.ok) {
          setShareError(payload?.error ?? 'Unable to resend invite.');
          return;
        }
        if (payload?.emailSent) {
          setCopyNotice(`Invite resent to ${email}`);
          window.setTimeout(() => setCopyNotice(''), 3000);
        } else {
          setShareError('Invite refreshed, but the email could not be sent.');
        }
        await loadShareInfo();
      } finally {
        setShareBusyAction(null);
      }
    },
    [canInviteShare, loadShareInfo, projectId],
  );

  const handleRevokeShareInvite = useCallback(
    async (inviteId: string, _email: string) => {
      if (!projectId || !canInviteShare) return;
      setShareBusyAction(`invite-revoke-${inviteId}`);
      setShareError('');
      setCopyNotice('');
      try {
        const res = await fetch('/api/workspace/share', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, inviteId }),
        });
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) {
          setShareError(payload?.error ?? 'Unable to revoke invite.');
          return;
        }
        await loadShareInfo();
      } finally {
        setShareBusyAction(null);
      }
    },
    [canInviteShare, loadShareInfo, projectId],
  );

  const handleOpenTeamPermissions = useCallback(() => {
    const href = shareInfo?.organization?.permissionsHref;
    if (!href) return;
    setShowShareModal(false);
    router.push(href);
  }, [router, shareInfo?.organization?.permissionsHref]);

  return {
    showShareModal,
    setShowShareModal,
    shareInfo,
    shareError,
    inviteEmail,
    setInviteEmail,
    inviteRole,
    setInviteRole,
    shareBusyAction,
    shareDropdown,
    setShareDropdown,
    copyNotice,
    canManageShare,
    canInviteShare,
    canShowShareControls,
    pendingEmailInvites,
    shareStatus,
    loadShareInfo,
    handleOpenShare,
    handleCopyInvite,
    handleCreateLinkInvite,
    handleCreateEmailInvite,
    handleVisibilityChange,
    handlePublicAccessChange,
    handleUpdateMemberRole,
    handleRemoveMember,
    handleResendShareInvite,
    handleRevokeShareInvite,
    handleOpenTeamPermissions,
  };
}
