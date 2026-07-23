'use client';

import { ANON_COOKIE_NAME, generateAnonId, isValidAnonId } from './anon-identity';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Read the sd_anon cookie if present and well-formed. */
export function readAnonCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${ANON_COOKIE_NAME}=([a-z0-9]+)`),
  );
  const value = match?.[1] ?? null;
  return isValidAnonId(value) ? value : null;
}

/** Lazily mint a stable anonymous id cookie for this browser, return it. */
export function ensureAnonCookie(): string {
  if (typeof document === 'undefined') return '';
  const existing = readAnonCookie();
  if (existing) return existing;
  const id = generateAnonId();
  document.cookie = `${ANON_COOKIE_NAME}=${id}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
  return id;
}

export function clearAnonCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${ANON_COOKIE_NAME}=; path=/; max-age=0; samesite=lax`;
}
