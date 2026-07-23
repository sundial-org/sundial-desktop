'use client';

/**
 * The "pending desktop link" carries an in-app destination across the
 * download → install → first-launch boundary: /download parks it in a cookie,
 * and /continue (opened by the app's first-launch handshake) redeems it to
 * the app's loopback listener. A plain client-readable cookie — the value is
 * just a same-origin path, not a secret.
 */

const COOKIE = 'sundial_pending_link';
const MAX_AGE_S = 7 * 24 * 3600;

/** Same-origin app path only: no scheme, no host, no protocol-relative. */
export function isSafeAppPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 2048 &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001F\u007F]/.test(path)
  );
}

export function setPendingDesktopLink(path: string): void {
  if (!isSafeAppPath(path)) return;
  document.cookie = `${COOKIE}=${encodeURIComponent(path)}; Max-Age=${MAX_AGE_S}; Path=/; SameSite=Lax`;
}

export function readPendingDesktopLink(): string | null {
  const match = document.cookie.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  if (!match) return null;
  try {
    const value = decodeURIComponent(match.slice(COOKIE.length + 1));
    return isSafeAppPath(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearPendingDesktopLink(): void {
  document.cookie = `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}
