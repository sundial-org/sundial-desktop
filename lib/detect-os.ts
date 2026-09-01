/**
 * Client-side OS detection for surface gating (e.g. which "Open with" options
 * a visitor can actually use). Coarse on purpose: browsers can't reliably tell
 * Apple Silicon from Intel (navigator reports MacIntel on both), so callers
 * treat "macos" as the Apple Silicon build's audience, same as /download.
 */
export type DetectedOS = 'macos' | 'ios' | 'windows' | 'android' | 'linux' | 'unknown';

export function detectOS(
  // `null` is the explicit "no navigator" (SSR) value — `undefined` would fall
  // back to this default and grab the runtime's own navigator.
  nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> | null = typeof navigator ===
  'undefined'
    ? null
    : navigator,
): DetectedOS {
  if (!nav) return 'unknown';
  const ua = nav.userAgent ?? '';
  const platform = nav.platform ?? '';
  // iPadOS 13+ masquerades as Macintosh; touch points give it away.
  if (/iPhone|iPad|iPod/.test(ua) || /iPhone|iPad/.test(platform)) return 'ios';
  if (/Mac/.test(platform) || ua.includes('Macintosh')) {
    return (nav.maxTouchPoints ?? 0) > 1 ? 'ios' : 'macos';
  }
  if (/Android/.test(ua)) return 'android';
  if (/Win/.test(platform) || ua.includes('Windows')) return 'windows';
  if (/Linux/.test(platform) || ua.includes('Linux')) return 'linux';
  return 'unknown';
}
