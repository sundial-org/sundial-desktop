import { getWorkspaceRouteId, toShortIdRef, type WorkspaceRouteInput } from '@/lib/workspace/public-ids';

type WorkspacePathParams = Record<
  string,
  string | number | boolean | null | undefined
>;

function normalizeWorkspaceId(workspaceId: WorkspaceRouteInput) {
  return encodeURIComponent(getWorkspaceRouteId(workspaceId));
}

function buildSearchParams(params?: WorkspacePathParams) {
  const searchParams = new URLSearchParams();
  if (!params) {
    return searchParams;
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') {
      continue;
    }

    if (typeof value === 'boolean') {
      searchParams.set(key, value ? '1' : '0');
      continue;
    }

    searchParams.set(key, String(value));
  }

  return searchParams;
}

export function buildWorkspacePath(
  workspaceId: WorkspaceRouteInput,
  params?: WorkspacePathParams
) {
  const basePath = `/w/${normalizeWorkspaceId(workspaceId)}`;
  const searchParams = buildSearchParams(params);
  const query = searchParams.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/** Local desktop projects render the same workspace page under
 *  `/local/<projectId>` — same query params, different base. */
export function buildLocalProjectPath(projectId: string, params?: WorkspacePathParams) {
  const query = buildSearchParams(params).toString();
  return query ? `/local/${encodeURIComponent(projectId)}?${query}` : `/local/${encodeURIComponent(projectId)}`;
}

/**
 * True when `path` is a bare workspace route (`/w/<id>`, no query/extra
 * segments). Used to validate client-supplied return paths before embedding
 * them in external callbacks (no open redirects).
 */
export function isWorkspacePath(path: string): boolean {
  return /^\/w\/[A-Za-z0-9_-]+$/.test(path);
}

// Shareable deep links carry git-style short id refs (see toShortIdRef);
// the page resolves them by unambiguous prefix, and full-id links keep
// working. buildWorkspacePath itself stays value-preserving.
export function buildWorkspaceChatPath(
  workspaceId: WorkspaceRouteInput,
  chatId: string
) {
  return buildWorkspacePath(workspaceId, { chatId: toShortIdRef(chatId) });
}

export function buildWorkspaceFilePath(
  workspaceId: WorkspaceRouteInput,
  fileId: string
) {
  return buildWorkspacePath(workspaceId, { fileId: toShortIdRef(fileId) });
}

export function buildFreshOnboardingWorkspaceUrl(workspaceId: WorkspaceRouteInput) {
  return buildWorkspacePath(workspaceId, { fresh: true });
}
