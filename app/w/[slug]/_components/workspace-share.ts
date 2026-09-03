'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LINK_INVITE_EMAIL } from '@/lib/workspace/invites';
import { buildWorkspacePath } from '@/lib/workspace/paths';
import type { WorkspaceKind } from '@/lib/workspace/kinds';
import { track } from '@/lib/analytics/track';
import { isSidecarServedOrigin } from '@/lib/local/sidecar';
import { withPathShareToken } from '@/lib/workspace/path-share-token-client';
import { SITE_URL } from '@/lib/seo';

/** Origin for links handed to collaborators: the origin the page is ACTUALLY
 *  served from, so a link always points at the deployment (or dev port) the
 *  user is on. The one exception is the packaged desktop shell's loopback
 *  proxy — that origin means nothing off this machine, so it falls back to
 *  the public site. Keying on "is this page sidecar-served" rather than "is
 *  this the desktop app" is what keeps a desktop build pointed at a dev
 *  server from minting links for some other worktree's port. */
export const shareOrigin = () => (isSidecarServedOrigin() ? SITE_URL : window.location.origin);

/** Origin for a copied workspace/chat/file link with a known path. Cloud
 *  (`/w/`) paths follow shareOrigin — in the packaged shell they'd otherwise
 *  copy as `http://127.0.0.1:<port>/w/...`, meaningless off this machine.
 *  `/local/` paths exist ONLY on this machine's sidecar, so the loopback
 *  origin is the only one that resolves and is kept. */
export const linkOriginFor = (path: string) =>
  path.startsWith('/local/') ? window.location.origin : shareOrigin();

import type { WorkspaceRouteInput } from '@/lib/workspace/public-ids';

// The page's own route id, `local` flag included — these hooks forward it
// straight to buildWorkspacePath, which is what keeps a local project's
// links and redirects off the cloud `/w/` route.
type WorkspaceRouteId = WorkspaceRouteInput;
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

/** The workspace-root grant: "anyone with the link" as a `path_shares` row.
 *  On cloud workspaces the bare /w/<id> URL grants `role` (tokened or not);
 *  the ?pshare= URL is a superset that also survives local-backing shares,
 *  where the token is the only credential. `id`/`url` on tokened rows are
 *  owner-only in the payload. */
export type ShareLinkShare = { id?: string; role: 'view' | 'suggest' | 'edit'; url?: string };

export type ShareInfo = {
  /** Root grant, or null — the single link-sharing lane. */
  linkShare?: ShareLinkShare | null;
  isOwner: boolean;
  canInvite: boolean;
  organization: ShareOrganization | null;
  /** The workspace belongs to an org with someone else in it: every one of
   *  them already has access (editor for owners/admins, viewer for members)
   *  without appearing in `members`. */
  orgAudience?: boolean;
  /** A signed-in chat participant beyond the owner: getProjectAccess grants
   *  them workspace-wide read with no project_members row. */
  chatAudience?: boolean;
  members: ShareMember[];
  invites: ShareInvite[];
};

export const isLinkSharedInfo = (info: ShareInfo | null): boolean => Boolean(info?.linkShare);

/** Named people who can get in regardless of any link: members beyond the
 *  owner, invites someone can still redeem (/invite/<token> rejects expired
 *  ones, and an accepted EMAIL invite is already counted as a member —
 *  reusable copy-link invites keep granting after their first acceptance),
 *  an org audience, or a chat participant. */
export const workspacePeopleAudience = (info: ShareInfo | null): boolean => {
  if (!info) return false;
  const liveInvites = (info.invites ?? []).filter(
    (invite) =>
      Date.parse(invite.expires_at ?? '') >= Date.now() &&
      (invite.accepted_at === null || !invite.email || invite.email === LINK_INVITE_EMAIL),
  );
  return (
    (info.members?.length ?? 0) > 1 ||
    liveInvites.length > 0 ||
    Boolean(info.orgAudience) ||
    Boolean(info.chatAudience)
  );
};

/** ANY audience at all — a live link lane or named people. */
export const shareInfoHasAudience = (info: ShareInfo | null): boolean =>
  isLinkSharedInfo(info) || workspacePeopleAudience(info);

/** The raw /api/workspace/share payload, normalized. */
export function parseShareInfoPayload(payload: {
  linkShare?: ShareLinkShare | null;
  isOwner?: boolean;
  canInvite?: boolean;
  organization?: ShareOrganization | null;
  orgAudience?: boolean;
  chatAudience?: boolean;
  members?: ShareMember[];
  invites?: ShareInvite[];
}): ShareInfo {
  return {
    linkShare: payload.linkShare ?? null,
    isOwner: payload.isOwner ?? false,
    canInvite: payload.canInvite ?? payload.isOwner ?? false,
    organization: payload.organization ?? null,
    orgAudience: payload.orgAudience ?? false,
    chatAudience: payload.chatAudience ?? false,
    members: payload.members ?? [],
    invites: payload.invites ?? [],
  };
}

/** An invite expires on a wall clock, not on a render: without this a tab
 *  left open past `expires_at` keeps reporting an audience /invite/<token>
 *  now refuses. One timer armed at the NEAREST future expiry per snapshot —
 *  not a poll (setTimeout truncates past ~24.8 days, so far-off expiries
 *  re-arm daily). Returns a tick to depend on wherever the audience is
 *  derived. */
function useInviteExpiryTick(invites: readonly ShareInvite[] | undefined): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const next = Math.min(
      ...(invites ?? [])
        .map((invite) => Date.parse(invite.expires_at ?? ''))
        .filter((at) => Number.isFinite(at) && at > now),
    );
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.min(next - now + 1, 86_400_000));
    return () => clearTimeout(timer);
  }, [invites, tick]);
  return tick;
}

/** Whether `projectId`'s workspace grants ANYONE access (link lane or named
 *  people), read from /api/workspace/share. `audience` is null until an
 *  authoritative read lands — a 403/5xx/network failure must not flip badges
 *  built on it. `lane` says WHICH lane grants it ('link' wins when both are
 *  on, matching cloud icon semantics; null while unauthoritative or when
 *  there is no audience) so local scopes can show the globe, not always the
 *  people icon. Read-only companion to useWorkspaceShare for surfaces (the
 *  local header's backing workspace) that only need the predicate. */
export function useWorkspaceAudienceProbe(projectId: string | null) {
  // The parsed payload, not just the boolean: the predicate re-evaluates as
  // the last invite's expires_at passes, which needs the expiries in scope.
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const seqRef = useRef(0);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    const seq = ++seqRef.current;
    try {
      const res = await fetch(`/api/workspace/share?projectId=${encodeURIComponent(projectId)}`);
      if (seq !== seqRef.current) return;
      if (!res.ok) {
        setInfo(null);
        return;
      }
      const payload = (await res.json()) as Parameters<typeof parseShareInfoPayload>[0];
      if (seq !== seqRef.current) return;
      setInfo(parseShareInfoPayload(payload));
    } catch {
      if (seq === seqRef.current) setInfo(null);
    }
  }, [projectId]);
  useEffect(() => {
    // Workspace switch: the previous workspace's audience must not answer
    // for this one while the new read is in flight.
    seqRef.current += 1;
    setInfo(null);
    if (projectId) void refresh();
  }, [projectId, refresh]);
  const expiryTick = useInviteExpiryTick(info?.invites);
  const { audience, lane } = useMemo<{ audience: boolean | null; lane: 'link' | 'members' | null }>(() => {
    void expiryTick; // re-evaluated when an invite's expiry passes
    if (!info) return { audience: null, lane: null };
    return {
      audience: shareInfoHasAudience(info),
      lane: isLinkSharedInfo(info) ? 'link' : workspacePeopleAudience(info) ? 'members' : null,
    };
  }, [info, expiryTick]);
  return { audience, lane, refresh };
}

/** A URL this CALLER can hand out. A tokened root share read by a non-owner
 *  has none — the bare URL grants nothing, so copying it would silently hand
 *  out a dead link. */
export const hasCopyableShareLink = (info: ShareInfo | null): boolean =>
  Boolean(info?.linkShare?.url);

export function useWorkspaceShare({
  projectId,
  projectKind,
  workspaceRouteId,
  currentChatId,
  user,
  desktopSignedIn = false,
  router,
  openSignIn,
  mintScopeGeneration,
  eagerLoad = true,
}: {
  projectId: string;
  projectKind: WorkspaceKind | null;
  workspaceRouteId: WorkspaceRouteId;
  currentChatId: string | null;
  user: WorkspaceUser;
  /** Packaged-shell sign-in (sd_ credentials in the sidecar). Clerk never
   *  loads on the loopback origin, so gating share on `user` alone sent
   *  signed-in desktop users to the browser sign-in on every click — an
   *  endless loop, since the round-trip can never produce a Clerk user
   *  here. Requests authenticate via the sidecar proxy regardless. */
  desktopSignedIn?: boolean;
  router: RouterLike;
  openSignIn: (options?: { redirectUrl?: string }) => void;
  /** Local project shares (PR #1033): the sidecar scope generation to stamp
   *  on invite mints — the route gates them against the root revocation
   *  watermark so a stop's revoke wins even if this tab dies mid-flight. */
  mintScopeGeneration?: () => number | null;
  /** Defer the status/badge read until the document-first shell has painted.
   * Opening the modal still loads immediately regardless of this flag. */
  eagerLoad?: boolean;
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

  const expiryTick = useInviteExpiryTick(shareInfo?.invites);

  // Independent of `shareStatus`, which collapses to 'public' when a link is
  // ALSO on — this predicate must not vanish then.
  const workspaceAudience = useMemo<boolean>(() => {
    void expiryTick; // re-evaluated when an invite's expiry passes
    return workspacePeopleAudience(shareInfo);
  }, [shareInfo, expiryTick]);
  const shareStatus: 'private' | 'shared' | 'public' = isLinkSharedInfo(shareInfo)
    ? 'public'
    : workspaceAudience
      ? 'shared'
      : 'private';

  // Only the LATEST load may write state. A fetch started before a mutation
  // can land after the refetch that follows it and roll the modal back to the
  // pre-mutation state (this is how a fresh link share bounced to Restricted).
  const loadSeqRef = useRef(0);
  const loadShareInfo = useCallback(async () => {
    if (!projectId || projectKind === null) return;
    const seq = ++loadSeqRef.current;
    setShareError('');
    try {
      // Token-forwarding: a root ?pshare= guest's ONLY credential is the
      // link token — without it this read 403s and the share UI errors out.
      const res = await withPathShareToken(fetch)(`/api/workspace/share?projectId=${projectId}`);
      if (seq !== loadSeqRef.current) return;
      if (!res.ok) {
        setShareError('Unable to load sharing settings.');
        return;
      }
      const payload = (await res.json()) as Parameters<typeof parseShareInfoPayload>[0];
      if (seq !== loadSeqRef.current) return;
      setShareInfo(parseShareInfoPayload(payload));
    } finally {
      // no-op
    }
  }, [projectId, projectKind]);

  useEffect(() => {
    if (!showShareModal) return;
    void loadShareInfo();
  }, [showShareModal, loadShareInfo]);

  // A client-side workspace switch keeps this hook mounted: the previous
  // workspace's sharing must not read as this one's (and an in-flight load
  // for it must not land) while the new read is out.
  useEffect(() => {
    loadSeqRef.current += 1;
    setShareInfo(null);
    if (!projectId || !eagerLoad) return;
    void loadShareInfo();
  }, [eagerLoad, projectId, loadShareInfo]);

  useEffect(() => {
    if (!shareDropdown) return;
    const handler = () => setShareDropdown(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [shareDropdown]);

  const handleOpenShare = useCallback(() => {
    if (!projectId) return;
    if (!canShowShareControls) return;
    if (!user && !desktopSignedIn) {
      openSignIn({ redirectUrl: buildWorkspacePath(workspaceRouteId) });
      return;
    }
    setShowShareModal(true);
  }, [canShowShareControls, desktopSignedIn, openSignIn, projectId, user, workspaceRouteId]);

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
    // When the caller holds a copyable link — the root grant's ?pshare= URL
    // (owner-only) or a tokenless share's bare doc URL — copy it directly. A
    // non-owner on a TOKENED root share has no capability URL, so they fall
    // through to the /invite/<token> mint below like on a restricted
    // workspace (a bare URL would copy "successfully" and grant nothing).
    const copyableUrl = shareInfo?.linkShare?.url;
    if (copyableUrl) {
      setShareBusyAction('link');
      setShareError('');
      setCopyNotice('');
      try {
        await handleCopyInvite(copyableUrl);
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
      const generation = mintScopeGeneration?.() ?? null;
      const res = await fetch('/api/workspace/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          role: linkRole,
          ...(currentChatId ? { chatId: currentChatId } : {}),
          ...(generation != null ? { scopeGeneration: generation } : {}),
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
  }, [canInviteShare, currentChatId, handleCopyInvite, linkRole, loadShareInfo, mintScopeGeneration, projectId, shareInfo]);

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
      const generation = mintScopeGeneration?.() ?? null;
      const res = await fetch('/api/workspace/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          role: inviteRole,
          email: normalizedEmail,
          ...(currentChatId ? { chatId: currentChatId } : {}),
          ...(generation != null ? { scopeGeneration: generation } : {}),
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
  }, [canInviteShare, currentChatId, inviteEmail, inviteRole, loadShareInfo, mintScopeGeneration, projectId]);

  const handleVisibilityChange = useCallback(
    async (visibility: 'private' | 'public') => {
      if (!projectId || !shareInfo?.isOwner) return;
      if (visibility === 'public' && isLinkSharedInfo(shareInfo)) return; // already on
      setShareBusyAction(visibility === 'private' ? 'visibility-private' : 'visibility-public');
      setShareError('');
      try {
        if (visibility === 'public') {
          // Link sharing ON mints the workspace-ROOT grant: its own token +
          // role (Viewer to start). On cloud workspaces the bare /w/<id> URL
          // grants the same role (only local-backing shares stay token-only)
          // and per-path links stay independent. Local project shares stamp
          // the scope generation so the watermark gate can refuse a mint
          // that lost to a stop (PR #1033).
          const generation = mintScopeGeneration?.() ?? null;
          const res = await fetch('/api/workspace/path-shares', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId,
              scope: 'workspace',
              linkRole: 'view',
              ...(generation != null ? { scopeGeneration: generation } : {}),
            }),
          });
          const payload = (await res.json().catch(() => null)) as {
            share?: { id: string; linkRole: 'view' | 'suggest' | 'edit' | null; linkUrl: string | null };
          } | null;
          if (!res.ok || !payload?.share?.linkUrl) {
            setShareError('Unable to update visibility.');
            return;
          }
          const linkShare = {
            id: payload.share.id,
            role: payload.share.linkRole ?? ('view' as const),
            url: payload.share.linkUrl,
          };
          setShareInfo((prev) => (prev ? { ...prev, linkShare } : prev));
          return;
        }
        // Restricted = revoke the root grant (tokened or tokenless; revoking
        // a tokened one also rotates its secret).
        // Local shares ≤-scope the delete to this modal's generation (no
        // watermark raise — not a stop): a stale modal can never delete a
        // re-added scope's newer link, while re-enabling here keeps working.
        const generation = mintScopeGeneration?.() ?? null;
        const revoke = await fetch('/api/workspace/path-shares', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            scope: 'workspace',
            ...(generation != null ? { maxGeneration: generation } : {}),
          }),
        });
        if (!revoke.ok) {
          setShareError('Unable to update visibility.');
          return;
        }
        setShareInfo((prev) => (prev ? { ...prev, linkShare: null } : prev));
      } finally {
        setShareBusyAction(null);
      }
    },
    [mintScopeGeneration, projectId, shareInfo],
  );

  const handlePublicAccessChange = useCallback(
    async (publicAccess: 'view' | 'suggest' | 'edit' | 'none') => {
      if (!projectId || !shareInfo?.isOwner) return;
      setShareBusyAction(`public-access-${publicAccess}`);
      setShareError('');
      try {
        // The role lives on the grant row (token — or its absence — stable).
        // `id` is manager-only in the payload; owners always have it.
        const linkShare = shareInfo.linkShare;
        if (!linkShare?.id || publicAccess === 'none') return;
        // Local project shares stamp the scope generation here too: the row
        // id is REUSED across a stop + re-add, so without it a stale window
        // could widen the re-added link's role (Codex P1 round 27). The
        // route predicates the update on it and 409s the stale side.
        const generation = mintScopeGeneration?.() ?? null;
        const res = await fetch('/api/workspace/path-shares', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            shareId: linkShare.id,
            linkRole: publicAccess,
            ...(generation != null ? { scopeGeneration: generation } : {}),
          }),
        });
        if (!res.ok) {
          setShareError(
            res.status === 409
              ? 'Sharing changed in another window. Reload and try again.'
              : 'Unable to update public access.',
          );
          return;
        }
        setShareInfo((prev) => (prev ? { ...prev, linkShare: { ...linkShare, role: publicAccess } } : prev));
      } finally {
        setShareBusyAction(null);
      }
    },
    [mintScopeGeneration, projectId, shareInfo],
  );

  /** Local project shares: the workspace ACL IS the scope's audience, and its
   *  members/invites are addressed by id — ids a stop + re-add hands straight
   *  back to a stale window. Stamping this modal's generation lets the route
   *  refuse those mutations once a stop's watermark covers it, instead of
   *  letting them land on the re-added share's people (Codex P2 round 28). */
  const aclBody = useCallback(
    (fields: Record<string, unknown>) => {
      const generation = mintScopeGeneration?.() ?? null;
      return JSON.stringify(generation != null ? { ...fields, scopeGeneration: generation } : fields);
    },
    [mintScopeGeneration],
  );
  const staleAcl = 'Sharing changed in another window. Reload and try again.';

  const handleUpdateMemberRole = useCallback(
    async (memberId: string, role: 'editor' | 'commenter' | 'viewer') => {
      if (!projectId || !shareInfo?.isOwner) return;
      setShareBusyAction(`member-role-${memberId}`);
      setShareError('');
      try {
        const res = await fetch('/api/workspace/share', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: aclBody({ projectId, memberId, role }),
        });
        if (!res.ok) {
          setShareError(res.status === 409 ? staleAcl : 'Unable to update permissions.');
          return;
        }
        await loadShareInfo();
      } finally {
        setShareBusyAction(null);
      }
    },
    [aclBody, loadShareInfo, projectId, shareInfo?.isOwner],
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
          body: aclBody({ projectId, memberId }),
        });
        if (!res.ok) {
          setShareError(res.status === 409 ? staleAcl : 'Unable to revoke access.');
          return;
        }
        await loadShareInfo();
      } finally {
        setShareBusyAction(null);
      }
    },
    [aclBody, loadShareInfo, projectId, shareInfo?.isOwner],
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
          // A resend repeats the SAME link (the one already in the recipient's
          // inbox keeps working) and pushes the expiry back another 7 days.
          body: aclBody({ projectId, inviteId }),
        });
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
          emailSent?: boolean;
          inviteUrl?: string;
        } | null;
        if (!res.ok) {
          setShareError(payload?.error ?? 'Unable to resend invite.');
          return;
        }
        if (payload?.emailSent) {
          setCopyNotice(`Invite resent to ${email}`);
          window.setTimeout(() => setCopyNotice(''), 3000);
        } else if (payload?.inviteUrl) {
          // THIS invite's link, which the route rides back for exactly this
          // case. The generic Copy link control mints a different one (its own
          // role, no email restriction), so it is not a substitute.
          await handleCopyInvite(payload.inviteUrl);
          setShareError(
            `The invite for ${email} is still valid, but the email could not be sent. Its join link is on your clipboard.`,
          );
        } else {
          setShareError('The invite is still valid, but the email could not be sent.');
        }
        await loadShareInfo();
      } finally {
        setShareBusyAction(null);
      }
    },
    [aclBody, canInviteShare, handleCopyInvite, loadShareInfo, projectId],
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
          body: aclBody({ projectId, inviteId }),
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
    [aclBody, canInviteShare, loadShareInfo, projectId],
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
    workspaceAudience,
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
