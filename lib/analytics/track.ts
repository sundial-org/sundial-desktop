'use client';

import { loadPosthog, loadedPosthog } from '@/lib/analytics/posthog-client';

/**
 * Defensive wrapper around `posthog.capture` for client-side analytics.
 *
 * - No-ops on the server.
 * - No-ops when `NEXT_PUBLIC_POSTHOG_KEY` isn't set (e.g. local dev w/o PH).
 * - Swallows any error so analytics failures never affect the UX.
 * - When `window.__sundialTrackDebug` is an array, every capture is pushed to
 *   it. Useful for DevTools introspection and Playwright smoke tests; opt-in
 *   so it has zero cost in normal sessions.
 */
export function track(
  event: string,
  properties?: Record<string, unknown>,
  /** `{ transport: 'sendBeacon' }` for pagehide/unload-time events. */
  options?: { transport?: 'sendBeacon' },
) {
  if (typeof window === 'undefined') return;
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
  const debug = (window as unknown as { __sundialTrackDebug?: unknown }).__sundialTrackDebug;
  if (Array.isArray(debug)) debug.push({ event, properties: properties ?? {} });
  void loadPosthog()
    .then((posthog) => posthog?.capture(event, properties, options))
    .catch(() => {
      // Ignore.
    });
}

/** The browser's PostHog distinct id (anonymous or identified), or null.
 *  Lets server-side captures attribute events to the same person as the
 *  client-side ones (e.g. the compile route for signed-out visitors). Reads
 *  the SDK only if it already loaded — never waits on (or triggers) the lazy
 *  import, so a caller on a hot path stays synchronous; the server falls back
 *  to its own identity when this is null. */
export function posthogDistinctId(): string | null {
  if (typeof window === 'undefined' || !process.env.NEXT_PUBLIC_POSTHOG_KEY) return null;
  try {
    const id = loadedPosthog()?.get_distinct_id();
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}
