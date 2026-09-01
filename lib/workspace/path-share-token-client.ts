import { PATH_SHARE_TOKEN_HEADER, PATH_SHARE_TOKEN_PARAM } from '@/lib/workspace/path-grants';

/**
 * Browser side of the `?pshare=` link token. An anonymous path-share guest's
 * ONLY credential is that query param, but in-app navigation rewrites the
 * query string — so the token is captured into sessionStorage the first time
 * a URL carries it and stays sticky for the tab. `withPathShareToken` wraps a
 * fetch so every workspace API call forwards it as the x-sundial-path-share
 * header (the server accepts either; see lib/workspace/path-grants.ts).
 */

const STORAGE_KEY = 'sundial:pshare-token';

/** Sticky per WORKSPACE, not per tab: share links land on `/w/<id>?pshare=`,
 *  and a second link opened in the same tab must not clobber the first
 *  workspace's only credential. Falls back to a global key off `/w/` routes. */
function storageKey(): string {
  const match = window.location.pathname.match(/^\/w\/([^/]+)/);
  return match ? `${STORAGE_KEY}:${match[1]}` : STORAGE_KEY;
}

export function currentPathShareToken(): string | null {
  if (typeof window === 'undefined') return null;
  let fromUrl: string | null = null;
  try {
    fromUrl = new URL(window.location.href).searchParams.get(PATH_SHARE_TOKEN_PARAM)?.trim() || null;
  } catch {
    /* opaque url */
  }
  try {
    if (fromUrl) window.sessionStorage.setItem(storageKey(), fromUrl);
    return fromUrl ?? window.sessionStorage.getItem(storageKey());
  } catch {
    // Storage blocked (private mode) — the token still works while the URL has it.
    return fromUrl;
  }
}

export function withPathShareToken(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const token = currentPathShareToken();
    if (!token) return fetchImpl(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(PATH_SHARE_TOKEN_HEADER, token);
    return fetchImpl(input, { ...init, headers });
  };
}

/**
 * Supabase JWT for the guest's realtime socket, minted by
 * GET /api/workspace/realtime-token from the sticky link token (see
 * lib/workspace/path-share-realtime-token.ts). Cached until shortly before
 * expiry; misses (revoked / path-scoped / feature off) are negative-cached so
 * the realtime heartbeat re-auth (~30s) doesn't hammer the route. Returns
 * null when the guest has no token or the mint is refused — callers fall
 * back to the bare anon socket.
 */
const REALTIME_JWT_REFRESH_MARGIN_MS = 2 * 60_000;
const REALTIME_JWT_MISS_TTL_MS = 5 * 60_000;
let realtimeJwtCache: {
  forToken: string;
  /** Clerk user id at mint time ('' = anonymous) — the mint embeds the sub,
   *  so a login/logout/account switch must invalidate the cache or the old
   *  identity would keep authorizing the socket until expiry. */
  forUser: string;
  jwt: string | null;
  staleAtMs: number;
  expiresAtMs: number;
} | null = null;

function currentClerkUserId(): string {
  if (typeof window === 'undefined') return '';
  const clerk = (window as unknown as { Clerk?: { user?: { id?: string | null } | null } }).Clerk;
  return clerk?.user?.id ?? '';
}

/** Stale-but-unexpired cached JWT, for transient mint failures. NEVER hand
 *  back an expired token — setAuth with it would wedge the socket in
 *  token-expired errors; null lets callers fall back to Clerk/anon. */
function cachedRealtimeJwt(linkToken: string, userId: string): string | null {
  if (realtimeJwtCache?.forToken !== linkToken || realtimeJwtCache.forUser !== userId) return null;
  return Date.now() < realtimeJwtCache.expiresAtMs ? realtimeJwtCache.jwt : null;
}

export type PathShareRealtimeMint =
  | { status: 'no-token' } // tab has no sticky ?pshare= token
  | { status: 'token'; jwt: string }
  | { status: 'refused' } // revoked / path-scoped / feature off — no point retrying
  | { status: 'transient' }; // 5xx/429/network — worth retrying

export async function pathShareRealtimeMint(): Promise<PathShareRealtimeMint> {
  const linkToken = currentPathShareToken();
  if (!linkToken) return { status: 'no-token' };
  const forUser = currentClerkUserId();
  const now = Date.now();
  if (
    realtimeJwtCache?.forToken === linkToken &&
    realtimeJwtCache.forUser === forUser &&
    now < realtimeJwtCache.staleAtMs
  ) {
    return realtimeJwtCache.jwt ? { status: 'token', jwt: realtimeJwtCache.jwt } : { status: 'refused' };
  }
  try {
    const response = await fetch('/api/workspace/realtime-token', {
      headers: { [PATH_SHARE_TOKEN_HEADER]: linkToken },
    });
    if (response.ok) {
      const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
      const jwt = typeof body.token === 'string' ? body.token : null;
      const expiresAtMs = jwt && typeof body.expiresAt === 'number' ? body.expiresAt * 1000 : 0;
      const staleAtMs = expiresAtMs
        ? Math.max(now + 60_000, expiresAtMs - REALTIME_JWT_REFRESH_MARGIN_MS)
        : now + REALTIME_JWT_MISS_TTL_MS;
      realtimeJwtCache = { forToken: linkToken, forUser, jwt, staleAtMs, expiresAtMs };
      return jwt ? { status: 'token', jwt } : { status: 'refused' };
    }
    // Only expected refusals (revoked / path-scoped / feature off) are
    // negative-cached; transient 5xx/429 retry on the next re-auth.
    if ([400, 403, 404].includes(response.status)) {
      realtimeJwtCache = {
        forToken: linkToken,
        forUser,
        jwt: null,
        staleAtMs: now + REALTIME_JWT_MISS_TTL_MS,
        expiresAtMs: 0,
      };
      return { status: 'refused' };
    }
  } catch {
    /* network blip — fall through to the stale-bridge/transient outcome */
  }
  // Don't cache: retry on the next re-auth. A stale-but-unexpired cached JWT
  // bridges the outage.
  const bridge = cachedRealtimeJwt(linkToken, forUser);
  return bridge ? { status: 'token', jwt: bridge } : { status: 'transient' };
}

export async function pathShareRealtimeToken(): Promise<string | null> {
  const mint = await pathShareRealtimeMint();
  return mint.status === 'token' ? mint.jwt : null;
}

/** Append `?pshare=` to an app-relative asset URL (img/preview srcs can't
 *  carry headers). No-op without a sticky token. */
export function appendPathShareTokenToUrl(url: string): string {
  const token = currentPathShareToken();
  if (!token || !url.startsWith('/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${PATH_SHARE_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}
