import { appendPathShareTokenToUrl } from '@/lib/workspace/path-share-token-client';

/** True for `http(s):`, protocol-relative, or root-absolute `/…` URLs. */
export function isAbsoluteImageSrc(src: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(src);
}

/** Local (sidecar) projects resolve workspace-relative image paths against the
 *  loopback sidecar instead of the cloud preview proxy. The local layout
 *  registers its project here on mount; everything else stays cloud-shaped. */
type LocalImageSource = { projectId: string; toUrl: (path: string) => string };
let localImageSource: LocalImageSource | null = null;
export function setLocalImageSource(source: LocalImageSource | null) {
  localImageSource = source;
}

/** Any sidecar file URL, structurally — NOT tied to the registry. The inverse
 *  direction is a safety property (never bake a token-bearing loopback URL
 *  into a doc) and must hold on every paste path: local → cloud doc, local
 *  project A → project B, or after the local layout unmounted. */
const SIDECAR_FILE_URL_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/projects\/[^/?#]+\/file$/i;

/**
 * Workspace-relative `assets/foo.png` → signed-URL proxy; absolute used as-is.
 * Shared by the live editor (WorkspaceImage node) and any markdown surface that
 * renders embedded images outside the editor (history modal, etc.).
 */
export function resolveWorkspaceImageSrc(src: string, workspaceId?: string | null): string {
  const trimmed = src.trim();
  if (!trimmed || isAbsoluteImageSrc(trimmed) || !workspaceId) return trimmed;
  if (localImageSource && localImageSource.projectId === workspaceId) {
    return localImageSource.toUrl(trimmed);
  }
  // `appendPathShareTokenToUrl` is a no-op except for path-share guests, whose
  // only credential is the sticky ?pshare= token (img requests carry no
  // headers). `unresolveWorkspaceImageSrc` strips the whole query on paste, so
  // the token never bakes into a stored doc.
  return appendPathShareTokenToUrl(
    `/api/workspace/files/preview?projectId=${encodeURIComponent(
      workspaceId,
    )}&path=${encodeURIComponent(trimmed)}`,
  );
}

/**
 * Inverse of {@link resolveWorkspaceImageSrc}: a `…/files/preview?…&path=` proxy
 * URL → the raw workspace-relative path. The editor's `renderHTML` emits the
 * resolved proxy URL, so a copy→paste (or any HTML re-parse) would otherwise
 * bake that URL — projectId and all — back into the stored `src`, corrupting
 * the doc and breaking the image in any other workspace. Non-proxy srcs pass
 * through untouched.
 */
export function unresolveWorkspaceImageSrc(src: string): string {
  const trimmed = src.trim();
  const query = trimmed.indexOf('?');
  if (query === -1) return trimmed;
  const base = trimmed.slice(0, query);
  // Sidecar URLs carry the local token as a query param — a copy/paste that
  // baked one into the doc would leak the token into any later cloud sync.
  if (!SIDECAR_FILE_URL_RE.test(base) && !base.includes('/api/workspace/files/preview')) {
    return trimmed;
  }
  return new URLSearchParams(trimmed.slice(query + 1)).get('path') ?? trimmed;
}
