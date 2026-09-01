/**
 * Pure path-share grant math, shared by server authz (lib/workspace/
 * path-access.ts re-exports everything here) and the browser (per-file
 * capability derivation from the `pathGrants` field of GET /api/workspace/
 * files). No server imports — keep this module client-safe.
 *
 * URL shape: workspace links carry the link token as `?pshare=<token>`
 * (e.g. `/w/<id>?pshare=Ab3…`). API routes accept the same value via the
 * `pshare` query param or the `x-sundial-path-share` header.
 */

export type PathShareRole = 'view' | 'suggest' | 'edit';
export type PathGrant = {
  /** '' = the workspace-root grant (scope_kind='workspace'): covers every
   *  path — and every chat (see getScopedProjectAccess). */
  path: string;
  role: PathShareRole;
  /** What the shared path was when granted: a 'file' grant covers ONLY that
   *  exact path (never `plan.md/anything`); 'folder' covers the subtree.
   *  Absent = folder semantics (the root baseline grant ''). */
  kind?: 'file' | 'folder';
  /** share row's created_at — history exceptions (e.g. a pending suggested
   *  delete staying reviewable) are bounded to the SHARE LIFETIME so a new
   *  grant can't exhume pre-share tombstones. */
  createdAt?: string;
};

/** Earliest covering grant creation time for `path`, or null when no covering
 *  grant carries one (fail closed: an unbounded grant proves nothing). */
export function earliestCoveringGrantCreatedAt(
  grants: readonly PathGrant[],
  path: string,
): string | null {
  let earliest: string | null = null;
  for (const grant of grants) {
    if (!grantCoversPath(grant.path, path, grant.kind)) continue;
    if (typeof grant.createdAt !== 'string' || !grant.createdAt) continue;
    if (earliest === null || grant.createdAt < earliest) earliest = grant.createdAt;
  }
  return earliest;
}

const ROLE_ORDER: Record<PathShareRole, number> = { view: 0, suggest: 1, edit: 2 };

export function isPathShareRole(value: unknown): value is PathShareRole {
  return value === 'view' || value === 'suggest' || value === 'edit';
}

/** Highest-privilege role of the two (null = no access). */
export function maxPathShareRole(
  a: PathShareRole | null,
  b: PathShareRole | null,
): PathShareRole | null {
  if (!a) return b;
  if (!b) return a;
  return ROLE_ORDER[a] >= ROLE_ORDER[b] ? a : b;
}

export function roleAtLeast(role: PathShareRole | null, min: PathShareRole): boolean {
  return role !== null && ROLE_ORDER[role] >= ROLE_ORDER[min];
}

/**
 * Canonical share path: forward slashes, no leading/trailing/duplicate
 * slashes. Returns null for the workspace root ('' — root grants are minted
 * via scope:'workspace', never as a path) and for traversal segments.
 */
export function normalizeSharePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const segments = value.trim().replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) return null;
  return segments.join('/');
}

/** Watermark key in `path_share_revocations` for a grant target (PR #1033
 *  scope generations): one key per revocable target identity. */
export function pathShareScopeKey(target: { path?: string | null; chatId?: string | null; root?: boolean }): string {
  return target.root ? 'workspace' : target.chatId ? `chat:${target.chatId}` : `path:${target.path ?? ''}`;
}

/** Workspace-wide revocation EPOCH key. The last-scope bulk revoke
 *  (`all: true`) deletes every grant on the workspace regardless of target,
 *  so no per-target watermark can describe it — a mint for an untouched
 *  target would sail past its own key and land after the wipe. This one row
 *  covers them all: every audience mint gates on max(its target's
 *  watermark, this epoch). Reserved — `pathShareScopeKey` never produces it
 *  ('workspace' is the ROOT GRANT's key, `path:` / `chat:` are prefixed). */
export const WORKSPACE_REVOCATION_EPOCH_KEY = '*all*';

/**
 * Coverage rule: a FOLDER grant on `docs` covers `docs` itself and everything
 * under `docs/` (prefix match is segment-exact: `docs` never covers
 * `docs2/x`). A FILE grant covers ONLY its exact path — nothing may be
 * created or opened "under" a file (`plan.md/anything` must never inherit
 * the file's role).
 */
export function grantCoversPath(
  grantPath: string,
  path: string,
  kind?: 'file' | 'folder',
): boolean {
  if (path === grantPath) return true;
  return kind !== 'file' && (grantPath === '' || path.startsWith(`${grantPath}/`));
}

/** How `path` relates to enabled share scopes, each carrying its recorded
 *  kind ('' = the whole workspace) — a FILE scope covers its exact path only,
 *  never a same-named directory's children. 'scope' — this exact path is what
 *  someone chose to share. 'covered' — it only rides an ancestor scope.
 *  null — not shared. */
export function pathShareCoverage(
  scopePaths: ReadonlyMap<string, 'file' | 'folder'>,
  path: string,
): 'scope' | 'covered' | null {
  if (scopePaths.has(path)) return 'scope';
  for (const [scope, kind] of scopePaths) if (grantCoversPath(scope, path, kind)) return 'covered';
  return null;
}

/** Whether the tab's sticky `?pshare=` token may ride copied links: only when
 *  it PROVABLY resolves to the workspace-ROOT grant. Grants aren't attributed
 *  to credentials client-side, so that proof is "a root grant is held and no
 *  narrower grant is in play" — any non-root grant means another capability
 *  may own the sticky token (e.g. a tokenless public workspace opened via a
 *  narrower file-edit link), and appending it would leak that scope's
 *  stronger access to every recipient (Codex P1 on PR #1052). */
export function holdsRootGrantOnly(grants: readonly PathGrant[]): boolean {
  return grants.length > 0 && grants.every((grant) => grant.path === '');
}

/** Highest role any grant confers on `path`; null when no grant covers it. */
export function effectivePathRole(
  grants: readonly PathGrant[],
  path: string,
): PathShareRole | null {
  let role: PathShareRole | null = null;
  for (const grant of grants) {
    if (grantCoversPath(grant.path, path, grant.kind)) role = maxPathShareRole(role, grant.role);
  }
  return role;
}

/**
 * File-tree visibility for a scoped guest: everything a grant covers, plus the
 * ancestor folder rows of each granted path so the tree can render down to it.
 * Ancestors are structure-only — they confer no role (`effectivePathRole` on
 * them stays null, so reads/writes of an ancestor's other children still 403).
 */
export function pathVisibleToGrants(
  grants: readonly PathGrant[],
  path: string,
  options: { isFolder?: boolean } = {},
): boolean {
  if (effectivePathRole(grants, path) !== null) return true;
  // Ancestor rows are STRUCTURE only — a private non-folder row that merely
  // sits at an ancestor path of a grant (degenerate imported trees) must not
  // leak its metadata; when the caller knows the row type, only real folders
  // qualify.
  if (options.isFolder === false) return false;
  return grants.some((grant) => grant.path.startsWith(`${path}/`));
}

export function filterEntriesForGrants<T>(
  entries: readonly T[],
  grants: readonly PathGrant[],
  getPath: (entry: T) => string,
  isFolder?: (entry: T) => boolean,
): T[] {
  return entries.filter((entry) =>
    pathVisibleToGrants(grants, getPath(entry), isFolder ? { isFolder: isFolder(entry) } : {}),
  );
}

export const PATH_SHARE_TOKEN_PARAM = 'pshare';
export const PATH_SHARE_TOKEN_HEADER = 'x-sundial-path-share';

/** Link token as it flows on requests: `?pshare=` first, then the header. */
export function readPathShareToken(request: Request): string | null {
  try {
    const fromQuery = new URL(request.url).searchParams.get(PATH_SHARE_TOKEN_PARAM);
    if (fromQuery?.trim()) return fromQuery.trim();
  } catch {
    /* opaque url */
  }
  return request.headers.get(PATH_SHARE_TOKEN_HEADER)?.trim() || null;
}

export type PathCapability = { canWrite: boolean; canSuggest: boolean; canComment: boolean };

/**
 * Per-file capability for the CLIENT: max(workspace baseline, covering grant
 * role) — the UI mirror of the server's canWritePath/canSuggestPath helpers.
 * Non-canonical paths never match a grant (same guard as the server).
 * `identified` mirrors the PR #835 compose boundary: an anonymous suggest
 * grant gets a read-only socket, so its UI must stay comment-only
 * (`canComment` without `canSuggest`) — only identified users compose.
 */
export function pathCapability(
  baseline: PathCapability,
  grants: readonly PathGrant[] | null | undefined,
  path: string | null | undefined,
  identified = false,
): PathCapability {
  const role =
    grants?.length && path && normalizeSharePath(path) === path
      ? effectivePathRole(grants, path)
      : null;
  return {
    canWrite: baseline.canWrite || role === 'edit',
    canSuggest: baseline.canSuggest || role === 'edit' || (role === 'suggest' && identified),
    canComment: baseline.canComment || roleAtLeast(role, 'suggest'),
  };
}
