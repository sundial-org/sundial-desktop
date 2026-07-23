'use client';

import { useAuth, useClerk } from '@/lib/auth/optional-auth';
import { useCallback } from 'react';

/**
 * Build a RELATIVE return path = the current URL with `params` set (e.g.
 * `{ modal: 'addRepo' }` → `/w/x?…&modal=addRepo`). Pass to `requireSignIn` so
 * OAuth sign-in reloads back onto the integration surface — the route-intent
 * effect strips `modal`/`panel` once consumed, so the current URL alone won't do.
 */
export function buildReturnPath(params: Record<string, string>): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const url = new URL(window.location.href);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.pathname + url.search + url.hash;
}

/**
 * Guard for account-scoped actions (connecting an integration, saving a token).
 * `requireSignIn(returnTo?)` returns true when the user is signed in so the
 * caller proceeds; otherwise it opens the Clerk sign-in modal — no API call, no
 * leaked "Unauthorized" — and returns false. No-ops while Clerk is loading.
 * Pass `returnTo` (a relative path, e.g. `/w/x?modal=addRepo`) so OAuth sign-in
 * reloads back onto the integration surface; defaults to the current URL.
 * `signedIn` lets callers skip account-scoped fetches that would 401.
 */
export function useRequireSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { openSignIn } = useClerk();

  const requireSignIn = useCallback(
    (returnTo?: string) => {
      if (!isLoaded) return false;
      if (isSignedIn) return true;
      // Use a RELATIVE path — an absolute URL on an origin outside
      // `allowedRedirectOrigins` (localhost, previews, per-worktree dev) is
      // rejected by Clerk as unsafe and falls back to "/", bouncing the user out.
      const here =
        typeof window !== 'undefined'
          ? window.location.pathname + window.location.search + window.location.hash
          : undefined;
      const redirectUrl = returnTo ?? here;
      openSignIn(redirectUrl ? { redirectUrl } : undefined);
      return false;
    },
    [isLoaded, isSignedIn, openSignIn],
  );

  return { signedIn: Boolean(isSignedIn), isLoaded, requireSignIn };
}
