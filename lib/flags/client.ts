/**
 * The one client-side flag store. Synchronous reads (per-keystroke consumers
 * like the Monaco completion provider cannot await a fetch), backed by an
 * in-memory cache with a localStorage mirror per flag, hydrated from the
 * account preference when /api/user/preferences resolves. The server value is
 * the truth for signed-in users; the mirror is a cache and the anonymous
 * fallback — never a second source of truth.
 */

import { FLAGS, getFlagDefinition } from './registry';

const cache = new Map<string, boolean>();

function storageKey(key: string): string {
  return getFlagDefinition(key)?.legacyStorageKey ?? `sundial:flag:${key}`;
}

function readStored(key: string): boolean {
  const fallback = getFlagDefinition(key)?.default ?? false;
  if (typeof window === 'undefined') return fallback;
  try {
    const value = window.localStorage.getItem(storageKey(key));
    // 'on'/'off' is the value format the pre-registry autocomplete flag
    // persisted; keeping it means opted-in browsers survive the migration.
    return value === null ? fallback : value === 'on';
  } catch {
    return fallback;
  }
}

export function getFlag(key: string): boolean {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = readStored(key);
  cache.set(key, value);
  return value;
}

export function setFlag(key: string, enabled: boolean): void {
  cache.set(key, enabled);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(key), enabled ? 'on' : 'off');
  } catch {
    /* private mode / storage disabled — the in-memory flip still holds. */
  }
}

/** Cache-only set: flips the flag for this page's lifetime without touching
 *  the localStorage mirror or the account. For escape hatches and test
 *  harnesses — a URL param or a visited page must NEVER durably opt a browser
 *  (let alone an account) into a feature. Only a deliberate settings action
 *  goes through setFlag. */
export function setFlagEphemeral(key: string, enabled: boolean): void {
  cache.set(key, enabled);
}

/** Mirror the server's resolved flags into the store. `skip` protects keys an
 *  explicit override (e.g. a URL param) already set this load — the caller
 *  persists those upstream instead of letting the fetch clobber them. */
export function hydrateFlags(flags: Record<string, boolean>, skip: string[] = []): void {
  for (const [key, value] of Object.entries(flags)) {
    if (typeof value !== 'boolean' || skip.includes(key)) continue;
    setFlag(key, value);
  }
}

/** Test-only: reset cache and mirrors between cases. */
export function __resetFlagsForTest(): void {
  const keys = new Set([...cache.keys(), ...FLAGS.map((flag) => flag.key)]);
  cache.clear();
  if (typeof window === 'undefined') return;
  try {
    for (const key of keys) window.localStorage.removeItem(storageKey(key));
  } catch {
    /* storage disabled — the cache reset above is what matters. */
  }
}
