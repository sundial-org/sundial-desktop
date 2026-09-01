import { effectivePathRole, grantCoversPath, type PathGrant } from '@/lib/workspace/path-grants';
import type { FileShareStatus } from '@/components/workspace/file-share-button';
import type { LocalShare } from '@/lib/local/sidecar';
import type { PathShare } from './path-share-modal';

/** A shared local scope as the header icon reports it: the recorded kind plus
 *  WHICH icon lane its audience earns — 'public' (globe) when a link grant
 *  covers it, 'shared' (people) for named members only. Same icon semantics
 *  as cloud workspaces. */
export type LocalScopeAudience = { kind: 'file' | 'folder'; status: 'shared' | 'public' };

/** Sidecar scope entries the header icon and tree badges may report as
 *  SHARED. `enabled` means synced, not shared: the audience lives in the
 *  backing workspace's grants, and the share modal can empty it (link to
 *  Restricted, last member removed) without stopping the sync — the scope is
 *  then synced-but-private. `audiencePaths` is the backing workspace's
 *  grants-something set; `projectAudience` is its ACL-level answer (link lane
 *  or named people — a project scope's audience lives there, not in path
 *  grants). Either is null until its read is authoritative — the sync state
 *  stands until then, an empty or failed read must not flip badges (an
 *  unauthoritative lane likewise never flips an icon: it reads 'shared', the
 *  pre-lane answer, until proven 'public'). `lanes` carries the link-lane
 *  answers from the same reads: `linkPaths` — backing-workspace scope paths a
 *  LINK grant covers; `projectLane` — the ACL probe's lane for the project
 *  scope. Legacy shares (no share_id) always stand as 'shared': each has its
 *  own dedicated workspace whose ACL is the audience — the union backing
 *  reads say nothing about them. */
export function localSharedScopeMap(
  shares: readonly LocalShare[],
  audiencePaths: ReadonlyMap<string, 'file' | 'folder'> | null,
  projectAudience: boolean | null,
  lanes?: {
    linkPaths?: ReadonlyMap<string, 'file' | 'folder'> | null;
    projectLane?: 'link' | 'members' | null;
  },
): Map<string, LocalScopeAudience> {
  // COVERAGE semantics, not exact-path membership (Codex P2): a link grant on
  // an ancestor folder (or the workspace root) already opens this scope to
  // anyone with that link, so the scope must read 'public' even though its
  // own grant is member-only.
  const linkCovers = (path: string): boolean => {
    for (const [grantPath, kind] of lanes?.linkPaths ?? []) {
      if (grantCoversPath(grantPath, path, kind)) return true;
    }
    return false;
  };
  const status = (share: LocalShare): 'shared' | 'public' => {
    if (!share.share_id) return 'shared';
    if (share.scope_kind === 'project') return lanes?.projectLane === 'link' ? 'public' : 'shared';
    return linkCovers(share.scope_path) ? 'public' : 'shared';
  };
  return new Map(
    shares
      .filter(
        (share) =>
          share.enabled &&
          // A chat share's scope_path is a chat id — lighting every file for
          // it was exactly the founder bug.
          share.scope_kind !== 'chat' &&
          (!share.share_id ||
            (share.scope_kind === 'project'
              ? (projectAudience ?? true)
              : !audiencePaths || audiencePaths.has(share.scope_path))),
      )
      .map(
        (share) =>
          [share.scope_path, { kind: share.scope_kind === 'file' ? 'file' : 'folder', status: status(share) }] as const,
      ),
  );
}

/** Which surface the file header's Share button opens: the per-file path-share
 *  modal (cloud), the sidecar bridge share (local), or null — the caller then
 *  falls back to the workspace modal, whose bare /w/<id> link names no file. */
export function fileShareTarget({
  isLocalWorkspace,
  isExtraRootPath,
  canInviteShare,
  isScopedGuest,
  sharingLoaded,
  isSignedIn,
}: {
  isLocalWorkspace: boolean;
  /** Local extra-root mounts never sync, so they can't be shared. */
  isExtraRootPath: boolean;
  canInviteShare: boolean;
  isScopedGuest: boolean;
  /** Both sharing reads have answered. `canInviteShare` is optimistic-true
   *  until /api/workspace/share lands (routing a viewer to the path modal
   *  early would only 403 there), and an empty path-share list means "no
   *  grants" only once /api/workspace/path-shares has answered — before that
   *  a covered file would open a new exact-file scope, hiding the ancestor
   *  audience. Unconfirmed = the workspace flow, which signs the visitor in
   *  or shows read-only sharing. */
  sharingLoaded: boolean;
  isSignedIn: boolean;
}): 'local' | 'path' | null {
  if (isLocalWorkspace) return isExtraRootPath ? null : 'local';
  return sharingLoaded && isSignedIn && canInviteShare && !isScopedGuest ? 'path' : null;
}

/** Path shares that grant something on `path` today, NARROWEST scope first —
 *  several can overlap (a link on `docs`, members on `docs/private`), and
 *  "which one shares this file" has to be an ordering, not a coincidence of
 *  array order. Chat grants carry a chat id, not a path: they share a
 *  conversation, never this file. A FILE grant covers its exact path only. */
export function coveringPathShares(shares: readonly PathShare[], path: string): PathShare[] {
  return shares
    .filter(
      (share) =>
        !share.chatId &&
        (share.linkRole || share.members.length > 0) &&
        grantCoversPath(share.path ?? '', path, share.scopeKind === 'file' ? 'file' : 'folder'),
    )
    .sort((a, b) => (b.path ?? '').length - (a.path ?? '').length);
}

/** Grants that keep sharing something around `scopePath` after every grant AT
 *  that scope is revoked: an ancestor scope still covering it, or a narrower
 *  grant inside it whose audience the scope's own modal never lists. */
export function overlappingPathShares(shares: readonly PathShare[], scopePath: string): PathShare[] {
  const inside = (path: string) => (scopePath === '' ? path !== '' : path.startsWith(`${scopePath}/`));
  return shares.filter((share) => {
    const path = share.path ?? '';
    if (share.chatId || path === scopePath || !(share.linkRole || share.members.length > 0)) return false;
    return inside(path) || grantCoversPath(path, scopePath, share.scopeKind === 'file' ? 'file' : 'folder');
  });
}

/** Everyone who can already reach a scope but won't show up in ITS share
 *  modal — the workspace's own link and audience, and grants above or inside
 *  it. Without this the modal reads as "nothing else in the workspace", and
 *  revoking what it lists looks like it closes access when it doesn't. */
export function broaderAccessLabel({
  scopeKind,
  linkShared,
  workspaceAudience,
  overlaps,
}: {
  scopeKind: 'file' | 'folder';
  linkShared: boolean;
  /** Named people (or an org) can already open the whole workspace. */
  workspaceAudience: boolean;
  overlaps: readonly PathShare[];
}): string | null {
  const reasons = [
    linkShared ? 'anyone with the workspace link' : null,
    workspaceAudience ? 'everyone the workspace itself is shared with' : null,
    overlaps.length > 0
      ? `another share (${overlaps
          .map((share) => (share.path ? `“${share.path}”` : 'the whole workspace'))
          .join(', ')})`
      : null,
  ].filter((reason): reason is string => reason !== null);
  if (reasons.length === 0) return null;
  return `Already reachable by ${reasons.join(', and ')}, so revoking this ${scopeKind}'s share won't change that.`;
}

/** Access the open file already has, so the header's icon says whether the doc
 *  is out there. Cloud: covering path grants (the workspace-root grant covers
 *  every file) falling back to workspace-level sharing. Local: bridge shares.
 *  `scope` names the grant that OWNS the reported status, so a control can
 *  open the modal that can actually revoke or copy it — null when it's the
 *  workspace root grant or workspace-level sharing (the workspace modal). */
export function fileShareStatus({
  path,
  isLocalWorkspace,
  isExtraRootPath,
  localSharedScopePaths,
  cloudPathShares,
  cloudPathSharesLoaded,
  workspaceShareStatus,
  scopedGuestGrants,
}: {
  path: string | null | undefined;
  isLocalWorkspace: boolean;
  isExtraRootPath: boolean;
  localSharedScopePaths: ReadonlyMap<string, LocalScopeAudience>;
  cloudPathShares: readonly PathShare[];
  /** False while the grant list is unauthoritative (a 5xx/network failure, or
   *  the first load still in flight). An empty or stale list must not be read
   *  as per-file truth then — only the workspace-level status is known. */
  cloudPathSharesLoaded: boolean;
  workspaceShareStatus: FileShareStatus;
  /** A scoped guest reads neither sharing endpoint (both 403), but the grant
   *  they came in on is in the files payload — a covered file is shared, not
   *  private. Never "public": a grant says nothing about whether the guest
   *  got in by link or by email invite, and they can manage neither. */
  scopedGuestGrants?: readonly PathGrant[] | null;
}): { status: FileShareStatus; scope: { path: string; kind: 'file' | 'folder' } | null } {
  if (!path) return { status: 'private', scope: null };
  if (isLocalWorkspace) {
    if (isExtraRootPath) return { status: 'private', scope: null };
    // The NARROWEST covering scope owns the report, so the header opens the
    // modal that lists (and can revoke) the audience the icon claims — a
    // folder share covering this file must not open a fresh exact-file
    // modal that knows nothing about it. '' is the project scope; the
    // project-scope modal owns it (scope null).
    let covering: ({ path: string } & LocalScopeAudience) | null = null;
    let linkCovering: ({ path: string } & LocalScopeAudience) | null = null;
    for (const [scopePath, { kind, status }] of localSharedScopePaths) {
      if (!grantCoversPath(scopePath, path, kind)) continue;
      if (!covering || scopePath.length > covering.path.length) covering = { path: scopePath, kind, status };
      if (status === 'public' && (!linkCovering || scopePath.length > linkCovering.path.length))
        linkCovering = { path: scopePath, kind, status };
    }
    // Same ownership rule as the cloud branch below: the narrowest LINK-lane
    // scope wins (most permissive — a member-only file scope must not mask
    // the link-shared folder around it), else the narrowest covering scope.
    const owner = linkCovering ?? covering;
    return {
      status: owner ? owner.status : 'private',
      scope: owner && owner.path !== '' ? { path: owner.path, kind: owner.kind } : null,
    };
  }
  if (scopedGuestGrants) {
    return { status: effectivePathRole(scopedGuestGrants, path) ? 'shared' : 'private', scope: null };
  }
  if (!cloudPathSharesLoaded) return { status: workspaceShareStatus, scope: null };
  const covering = coveringPathShares(cloudPathShares, path);
  const owner = covering.find((share) => share.linkRole) ?? covering[0] ?? null;
  const fromGrants: FileShareStatus = owner ? (owner.linkRole ? 'public' : 'shared') : 'private';
  // Most permissive wins: a narrow member grant must never mask the fact that
  // the workspace around it is link-shared.
  const rank = { private: 0, shared: 1, public: 2 };
  const grantsWin = rank[fromGrants] >= rank[workspaceShareStatus];
  return {
    status: grantsWin ? fromGrants : workspaceShareStatus,
    // A root grant (path null) is workspace-wide — the workspace modal owns it.
    scope:
      grantsWin && owner?.path
        ? { path: owner.path, kind: owner.scopeKind === 'file' ? 'file' : 'folder' }
        : null,
  };
}

/** Which modal owns "share this file", for EVERY entry point that offers it
 *  (the doc header, the top bar's scope menu). One rule, one place: the two
 *  surfaces answer the same question and must never drift on it.
 *
 *  Always the scope that OWNS the reported audience — a covering folder or
 *  project grant's modal, never a fresh exact-file one that can't show or
 *  revoke what the icon is claiming. `null` = no file-level modal, and the
 *  caller falls back to the workspace modal, which owns the workspace lanes. */
export function fileShareModalScope(
  path: string,
  target: ReturnType<typeof fileShareTarget>,
  share: ReturnType<typeof fileShareStatus>,
):
  | { lane: 'local'; scope: { kind: 'project' | 'file' | 'folder'; path: string } }
  | { lane: 'path'; scope: { path: string; kind: 'file' | 'folder' } }
  | null {
  if (target === 'local') {
    // Anything that is not 'private' is covered by the project scope through
    // one lane or the other — 'public' (the link lane) included. Testing for
    // 'shared' alone sent link-shared files to an exact-file modal that
    // neither lists nor revokes the project share reaching them.
    return {
      lane: 'local',
      scope: share.scope ?? (share.status !== 'private' ? { kind: 'project', path: '' } : { kind: 'file', path }),
    };
  }
  // Cloud: a covered file opens its covering grant; an uncovered one opens a
  // fresh exact-file scope. Anything else inherits the workspace modal.
  if (target === 'path' && (share.scope || share.status === 'private')) {
    return { lane: 'path', scope: share.scope ?? { path, kind: 'file' } };
  }
  return null;
}
