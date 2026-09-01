/**
 * Server-side guard for `?redirect_url=` values: only same-app relative paths
 * pass. Rejects absolute URLs and protocol-relative (`//host`) values so a
 * crafted link can never bounce a signed-in user off-site. Accepts `unknown`
 * because duplicated query params arrive as string[].
 */
export function internalRedirectPath(target: unknown): string | null {
  if (
    typeof target !== 'string' ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.startsWith('/\\')
  ) {
    return null;
  }
  return target;
}
