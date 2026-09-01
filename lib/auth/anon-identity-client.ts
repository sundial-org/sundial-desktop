'use client';

import {
  ANON_COOKIE_NAME,
  collectAnonHandoffIds,
  generateAnonId,
  isValidAnonId,
} from './anon-identity';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Read the sd_anon cookie if present and well-formed. */
export function readAnonCookie(): string | null {
  if (typeof document === 'undefined') return null;
  // Allow hyphens: readable slug keys (harbor-swift-otter-marble-…) are valid
  // anon ids too, and a `[a-z0-9]+` capture would truncate one to its first
  // word, making the client treat the cookie as absent and mint a second id.
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${ANON_COOKIE_NAME}=([a-z0-9-]+)`),
  );
  const value = match?.[1] ?? null;
  return isValidAnonId(value) ? value : null;
}

export function setAnonCookie(id: string) {
  document.cookie = `${ANON_COOKIE_NAME}=${id}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}

/** Lazily mint a stable anonymous id cookie for this browser, return it. */
export function ensureAnonCookie(): string {
  if (typeof document === 'undefined') return '';
  const existing = readAnonCookie();
  if (existing) return existing;
  const id = generateAnonId();
  setAnonCookie(id);
  return id;
}

/** Handoff identities parked by the middleware, read from the cookie names. */
export function readAnonHandoffIds(): string[] {
  if (typeof document === 'undefined') return [];
  const names = document.cookie.split('; ').map((pair) => pair.split('=')[0]);
  return collectAnonHandoffIds(names);
}

// NOTE: there is deliberately no clearAnonCookie() here. /api/auth/claim-anon
// expires every identity it claimed via Set-Cookie on its own response, which
// is the only snapshot that cannot race a handoff parked mid-request.
