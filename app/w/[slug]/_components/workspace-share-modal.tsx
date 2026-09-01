'use client';

import { useRef, type ReactNode } from 'react';
import { CheckIcon, CaretDownIcon, GlobeSimpleIcon, LightningIcon, LinkIcon, LockSimpleIcon, XIcon } from '@phosphor-icons/react';
import { IconTooltip, getInitials, pickColor } from '@/components/collab-bubbles';
import { AnchoredDropdown } from '@/components/workspace/anchored-dropdown';
import { ModalShell } from '@/components/modal-shell';
import { hasCopyableShareLink, isLinkSharedInfo, type ShareInfo, type ShareInvite } from './workspace-share';

type InviteRole = 'editor' | 'commenter' | 'viewer';
type PublicAccess = 'view' | 'suggest' | 'edit' | 'none';

const MEMBER_ROLES = ['viewer', 'commenter', 'editor'] as const;

/** What is being shared. One GDocs-style modal covers every share surface —
 *  the full workspace, a single file/folder (local share-to-cloud today;
 *  per-path cloud shares slot in when path_shares lands), and chats. Every
 *  subject renders the complete anatomy (invite, people, general access,
 *  copy link); chats present the workspace ACL as inherited. */
export type ShareSubject = 'workspace' | 'file' | 'folder' | 'chat';

/** Caption under "People with access". Chats have no ACL of their own (yet) —
 *  the workspace's members are the audience, and inviting from here invites
 *  to the workspace. */
const peopleCaption = (subject: ShareSubject) =>
  subject === 'chat'
    ? 'Inherited from the workspace: everyone below can open this chat. Inviting someone adds them to the workspace.'
    : 'Members of this project can see project files, chats, comments, diffs, and scheduled-chat runs.';

function formatMemberRole(role: 'owner' | InviteRole) {
  return role[0].toUpperCase() + role.slice(1);
}

export function WorkspaceShareModal({
  open,
  subject = 'workspace',
  accessCaption,
  bodyExtra,
  onStopSharing,
  projectTitle,
  userId,
  shareInfo,
  shareError,
  copyNotice,
  canManageShare,
  canInviteShare,
  pendingEmailInvites,
  inviteEmail,
  setInviteEmail,
  inviteRole,
  setInviteRole,
  shareDropdown,
  setShareDropdown,
  shareBusyAction,
  onClose,
  onCreateEmailInvite,
  onCreateLinkInvite,
  onUpdateMemberRole,
  onRemoveMember,
  onResendInvite,
  onRevokeInvite,
  onVisibilityChange,
  onPublicAccessChange,
  onOpenTeamPermissions,
  onOpenLocalAgent,
  formatRelativeTime,
}: {
  open: boolean;
  subject?: ShareSubject;
  /** Quiet one-line caption under General access (e.g. the local sync note). */
  accessCaption?: string;
  /** Extra rows in the scrollable body (e.g. local share-conflict rows). */
  bodyExtra?: ReactNode;
  /** Footer "Stop sharing" action (local shares). */
  onStopSharing?: () => void | Promise<void>;
  projectTitle: string;
  userId?: string | null;
  shareInfo: ShareInfo | null;
  shareError: string;
  copyNotice: string;
  canManageShare: boolean;
  canInviteShare: boolean;
  pendingEmailInvites: Array<ShareInvite & { email: string }>;
  inviteEmail: string;
  setInviteEmail: (value: string) => void;
  inviteRole: InviteRole;
  setInviteRole: (value: InviteRole) => void;
  shareDropdown: string | null;
  setShareDropdown: (value: string | null) => void;
  shareBusyAction: string | null;
  onClose: () => void;
  onCreateEmailInvite: () => void | Promise<void>;
  onCreateLinkInvite: () => void | Promise<void>;
  onUpdateMemberRole: (memberId: string, role: InviteRole) => void | Promise<void>;
  onRemoveMember: (memberId: string) => void | Promise<void>;
  onResendInvite: (inviteId: string, email: string) => void | Promise<void>;
  onRevokeInvite: (inviteId: string, email: string) => void | Promise<void>;
  onVisibilityChange: (visibility: 'private' | 'public') => void | Promise<void>;
  onPublicAccessChange: (publicAccess: PublicAccess) => void | Promise<void>;
  onOpenTeamPermissions: () => void;
  onOpenLocalAgent?: () => void | Promise<void>;
  formatRelativeTime: (value?: string | null) => string;
}) {
  // Link-shared = the workspace-root grant exists (tokened or tokenless).
  const isLinkShared = isLinkSharedInfo(shareInfo);
  const linkRole = shareInfo?.linkShare?.role;
  // Never render a void: each section only mounts when it has content, so a
  // subject without people/invites collapses to title + general access.
  const hasPeople = Boolean(shareInfo && (shareInfo.members.length > 0 || pendingEmailInvites.length > 0));
  const hasBody = hasPeople || Boolean(shareInfo?.organization) || Boolean(bodyExtra);
  // Shared by all member-role menus — only one is open at a time.
  const dropdownAnchorRef = useRef<HTMLElement | null>(null);
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel={`Share ${subject}`}
      overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      panelClassName="w-full max-w-lg rounded-2xl bg-white border border-stone-200 shadow-xl"
    >
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-stone-800">Share &ldquo;{projectTitle || 'Untitled workspace'}&rdquo;</h2>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600 transition-colors" aria-label="Close">
            <XIcon className="h-5 w-5" weight="regular" aria-hidden />
          </button>
        </div>

        {canInviteShare && (
          <div className="flex items-center gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void onCreateEmailInvite();
                }
              }}
              placeholder="Add people by email"
              className="flex-1 rounded-lg border border-stone-200 px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-400/20 focus:border-stone-300 transition-colors"
            />
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setShareDropdown(shareDropdown === 'invite-role' ? null : 'invite-role');
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-2.5 text-sm bg-white hover:bg-stone-50 transition-colors"
              >
                {formatMemberRole(inviteRole)}
                <CaretDownIcon className="h-3.5 w-3.5 text-stone-400" weight="regular" aria-hidden />
              </button>
              {shareDropdown === 'invite-role' && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-stone-200 rounded-lg shadow-lg py-1 z-10 min-w-[110px]">
                  {MEMBER_ROLES.map((role) => (
                    <button
                      key={role}
                      type="button"
                      onClick={() => {
                        setInviteRole(role);
                        setShareDropdown(null);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-stone-50 transition-colors ${inviteRole === role ? 'text-stone-900 font-medium' : 'text-stone-600'}`}
                    >
                      {formatMemberRole(role)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onCreateEmailInvite}
              disabled={shareBusyAction === 'email' || !inviteEmail.trim()}
              className="shrink-0 rounded-lg bg-stone-900 text-white px-4 py-2.5 text-sm font-medium hover:bg-stone-800 disabled:opacity-40 transition-colors"
            >
              {shareBusyAction === 'email' ? 'Sending...' : 'Send'}
            </button>
          </div>
        )}

        {(shareError || copyNotice) && (
          <div className="mt-2">
            {shareError && <div className="text-xs text-rose-600">{shareError}</div>}
            {!shareError && copyNotice && <div className="text-xs text-emerald-600">{copyNotice}</div>}
          </div>
        )}
      </div>

      {hasBody && (
      <div className="px-5 pb-2 max-h-[340px] overflow-y-auto">
        {hasPeople && shareInfo && (
          <div>
            <div className="text-xs font-medium text-stone-500 mb-0.5">People with access</div>
            <p className="text-[11px] leading-snug text-stone-400 mb-2">{peopleCaption(subject)}</p>
            <div className="space-y-0.5">
              {shareInfo.members.map((member) => {
                const displayName = member.name ?? member.username ?? member.email ?? `User ${member.user_id.slice(0, 6)}`;
                const emailLine =
                  member.email && member.email !== member.name && member.email !== member.username
                    ? member.email
                    : null;
                const canEditMember = canManageShare && member.role !== 'owner';
                const busyRole = shareBusyAction === `member-role-${member.user_id}`;
                const busyRemove = shareBusyAction === `member-remove-${member.user_id}`;

                return (
                  <div key={member.user_id} className="flex items-center gap-3 py-2 group">
                    <div className="shrink-0">
                      {member.imageUrl ? (
                        <img src={member.imageUrl} alt="" className="h-8 w-8 rounded-full border border-stone-200 object-cover" />
                      ) : (
                        <div
                          className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold text-[#fff]"
                          style={{ backgroundColor: pickColor(member.user_id) }}
                        >
                          {getInitials(displayName)}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-stone-800 truncate">
                        {displayName}
                        {member.user_id === userId && <span className="text-stone-400 ml-1">(you)</span>}
                      </div>
                      {emailLine && <div className="text-xs text-stone-500 truncate">{emailLine}</div>}
                    </div>
                    <div className="shrink-0 flex items-center gap-1.5">
                      {canEditMember ? (
                        <>
                          <div className="relative">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                dropdownAnchorRef.current = event.currentTarget;
                                setShareDropdown(shareDropdown === `member-role-${member.user_id}` ? null : `member-role-${member.user_id}`);
                              }}
                              disabled={busyRole}
                              className="inline-flex items-center gap-1 text-xs text-stone-600 hover:text-stone-900 disabled:opacity-50 transition-colors"
                            >
                              {formatMemberRole(member.role)}
                              <CaretDownIcon className="h-3 w-3 text-stone-400" weight="regular" aria-hidden />
                            </button>
                            {/* Fixed-position panel: escapes the member list's
                                overflow-y-auto clipping and flips above the
                                trigger near the viewport bottom. */}
                            <AnchoredDropdown
                              open={shareDropdown === `member-role-${member.user_id}`}
                              anchorRef={dropdownAnchorRef}
                              className="bg-white border border-stone-200 rounded-lg shadow-lg py-1 min-w-[110px]"
                            >
                              {MEMBER_ROLES.map((role) => (
                                <button
                                  key={role}
                                  type="button"
                                  onClick={() => {
                                    void onUpdateMemberRole(member.user_id, role);
                                    setShareDropdown(null);
                                  }}
                                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-stone-50 transition-colors ${member.role === role ? 'text-stone-900 font-medium' : 'text-stone-600'}`}
                                >
                                  {formatMemberRole(role)}
                                </button>
                              ))}
                            </AnchoredDropdown>
                          </div>
                          <button
                            type="button"
                            onClick={() => void onRemoveMember(member.user_id)}
                            disabled={busyRemove}
                            aria-label="Remove"
                            className="relative group/tip opacity-0 group-hover:opacity-100 focus:opacity-100 rounded p-1 text-stone-400 hover:text-rose-500 hover:bg-rose-50 transition-all disabled:opacity-60"
                          >
                            <XIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                            <IconTooltip label="Remove" />
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-stone-400">{formatMemberRole(member.role)}</span>
                      )}
                    </div>
                  </div>
                );
              })}

              {pendingEmailInvites.map((invite) => {
                const busyResend = shareBusyAction === `invite-resend-${invite.id}`;
                const busyRevoke = shareBusyAction === `invite-revoke-${invite.id}`;
                return (
                  <div key={`invite-${invite.id}`} className="flex items-center gap-3 py-2 group">
                    <div className="shrink-0">
                      <div className="h-8 w-8 rounded-full bg-stone-100 flex items-center justify-center text-xs font-semibold text-stone-400 border border-dashed border-stone-300">
                        {invite.email[0]?.toUpperCase() ?? '?'}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-stone-600 truncate">{invite.email}</div>
                      <div className="text-xs text-stone-400">Invited {formatRelativeTime(invite.created_at)} &middot; {formatMemberRole(invite.role)}</div>
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void onResendInvite(invite.id, invite.email)}
                        disabled={busyResend}
                        className={`rounded px-2 py-1 text-[11px] text-stone-500 hover:bg-stone-50 hover:text-stone-600 disabled:opacity-50 transition-all ${busyResend ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
                      >
                        {busyResend ? 'Sending...' : 'Resend'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onRevokeInvite(invite.id, invite.email)}
                        disabled={busyRevoke}
                        aria-label="Revoke"
                        className="relative group/tip opacity-0 group-hover:opacity-100 focus:opacity-100 rounded p-1 text-stone-400 hover:text-rose-500 hover:bg-rose-50 transition-all disabled:opacity-60"
                      >
                        <XIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                        <IconTooltip label="Revoke" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {shareInfo?.organization && (
          <div className="mt-3 pt-3 border-t border-stone-100">
            <div className="text-xs font-medium text-stone-500 mb-2">Team</div>
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-stone-100 flex items-center justify-center text-sm shrink-0">
                {shareInfo.organization.name[0]?.toUpperCase() ?? 'T'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-stone-800 truncate">{shareInfo.organization.name}</div>
                <div className="text-xs text-stone-400">Team membership managed from dashboard</div>
              </div>
              {shareInfo.organization.canOpenPermissions && (
                <button
                  type="button"
                  onClick={onOpenTeamPermissions}
                  className="shrink-0 text-xs text-stone-500 hover:text-stone-600 hover:underline transition-colors"
                >
                  Manage
                </button>
              )}
            </div>
          </div>
        )}

        {bodyExtra}
      </div>
      )}

      <div className="px-5 pt-3 pb-4 border-t border-stone-100 mt-1">
        <div className="text-xs font-medium text-stone-500 mb-2">General access</div>
        {shareInfo === null ? (
          // Sharing state not loaded yet: a placeholder, never the default
          // "Restricted" flashing into "Anyone with the link" a beat later.
          <div className="flex items-center gap-3" data-testid="share-audience-loading">
            <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-stone-100" />
            <div className="min-w-0 flex-1">
              <div className="h-4 w-40 animate-pulse rounded bg-stone-100" />
              <div className="mt-1.5 h-3 w-56 animate-pulse rounded bg-stone-100" />
            </div>
          </div>
        ) : (
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-stone-100 flex items-center justify-center shrink-0">
            {isLinkShared ? <GlobeSimpleIcon className="h-4 w-4 text-stone-500" weight="regular" aria-hidden /> : <LockSimpleIcon className="h-4 w-4 text-stone-400" weight="regular" aria-hidden />}
          </div>
          <div className="flex-1 min-w-0">
            {canManageShare ? (
              <div className="relative inline-block">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setShareDropdown(shareDropdown === 'visibility' ? null : 'visibility');
                  }}
                  disabled={shareBusyAction === 'visibility-private' || shareBusyAction === 'visibility-public'}
                  className="inline-flex items-center gap-1 text-sm font-medium text-stone-800 hover:text-stone-900 disabled:opacity-50 transition-colors"
                >
                  {isLinkShared ? 'Anyone with the link' : 'Restricted'}
                  <CaretDownIcon className="h-3.5 w-3.5 text-stone-400" weight="regular" aria-hidden />
                </button>
                {shareDropdown === 'visibility' && (
                  <div className="absolute left-0 top-full mt-1 bg-white border border-stone-200 rounded-lg shadow-lg py-1 z-10 min-w-[220px]">
                    <button
                      type="button"
                      onClick={() => {
                        void onVisibilityChange('private');
                        setShareDropdown(null);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-stone-50 transition-colors ${!isLinkShared ? 'text-stone-900 font-medium' : 'text-stone-600'}`}
                    >
                      <div>Restricted</div>
                      <div className="text-xs text-stone-400 font-normal">Only people with access can open</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void onVisibilityChange('public');
                        setShareDropdown(null);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-stone-50 transition-colors ${isLinkShared ? 'text-stone-900 font-medium' : 'text-stone-600'}`}
                    >
                      <div>Anyone with the link</div>
                      <div className="text-xs text-stone-400 font-normal">Anyone on the internet can open</div>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm font-medium text-stone-800">
                {isLinkShared ? 'Anyone with the link' : 'Restricted'}
              </div>
            )}
            <div className="text-xs text-stone-400">
              {isLinkShared
                ? `Anyone on the internet with the link can ${linkRole === 'edit' ? 'edit' : linkRole === 'suggest' ? 'comment' : 'view'}`
                : 'Only people with access can open with the link'}
            </div>
          </div>
          {isLinkShared && (
            shareInfo?.isOwner ? (
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setShareDropdown(shareDropdown === 'public-access' ? null : 'public-access');
                  }}
                  disabled={shareBusyAction?.startsWith('public-access-')}
                  className="inline-flex items-center gap-1 text-xs text-stone-600 hover:text-stone-900 disabled:opacity-50 transition-colors"
                >
                  {formatLinkRole(linkRole)}
                  <CaretDownIcon className="h-3 w-3 text-stone-400" weight="regular" aria-hidden />
                </button>
                {shareDropdown === 'public-access' && (
                  <div className="absolute right-0 top-full mt-1 bg-white border border-stone-200 rounded-lg shadow-lg py-1 z-10 min-w-[110px]">
                    {(['view', 'suggest', 'edit'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          void onPublicAccessChange(value);
                          setShareDropdown(null);
                        }}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-stone-50 transition-colors ${linkRole === value ? 'text-stone-900 font-medium' : 'text-stone-600'}`}
                      >
                        {formatLinkRole(value)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <span className="shrink-0 text-xs text-stone-400">{formatLinkRole(linkRole)}</span>
            )
          )}
        </div>
        )}
        {accessCaption && <p className="mt-2 text-[11px] leading-snug text-stone-400">{accessCaption}</p>}
      </div>

      <div className="flex items-center justify-between px-5 py-3 border-t border-stone-100">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCreateLinkInvite}
            // A chat link is always copyable — restricted workspaces just copy
            // the plain chat URL for members who can't mint invites. Root-link
            // shares hide the tokened URL from non-owners, so a caller with
            // neither a copyable URL nor invite rights gets no dead button.
            disabled={(subject !== 'chat' && !hasCopyableShareLink(shareInfo) && !canInviteShare) || shareBusyAction === 'link'}
            className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm min-w-[120px] transition-colors ${shareBusyAction === 'link-copied' ? 'border-stone-300 bg-stone-100 text-stone-800' : 'border-stone-200 text-stone-700 hover:bg-stone-50'} disabled:opacity-50`}
          >
            {shareBusyAction === 'link-copied' ? (
              <CheckIcon className="h-4 w-4" weight="regular" aria-hidden />
            ) : (
              <LinkIcon className="h-4 w-4" weight="regular" aria-hidden />
            )}
            {shareBusyAction === 'link-copied' ? 'Copied' : 'Copy link'}
          </button>
          {onOpenLocalAgent ? (
            <button
              type="button"
              onClick={() => void onOpenLocalAgent()}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 transition-colors hover:bg-stone-50"
            >
              <LightningIcon className="h-4 w-4" weight="regular" aria-hidden />
              Connect agent
            </button>
          ) : null}
          {onStopSharing ? (
            <button
              type="button"
              onClick={() => void onStopSharing()}
              // Tearing down the cloud twins takes seconds: say so and lock the
              // button, or it reads as broken and gets clicked again. Quiet on
              // purpose (local-only): it stops the SYNC, which the audience
              // controls above can't — but it is not destructive, so no red.
              disabled={shareBusyAction === 'stop'}
              data-testid="share-stop-syncing"
              className="text-[12px] font-medium text-stone-500 transition-colors hover:text-stone-700 disabled:opacity-50"
            >
              {shareBusyAction === 'stop' ? 'Stopping…' : 'Stop syncing'}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-stone-900 text-white px-5 py-2 text-sm font-medium hover:bg-stone-800 transition-colors"
        >
          Done
        </button>
      </div>
    </ModalShell>
  );
}

function formatLinkRole(value?: PublicAccess | null) {
  if (value === 'edit') return 'Editor';
  if (value === 'suggest') return 'Commenter';
  return 'Viewer';
}
