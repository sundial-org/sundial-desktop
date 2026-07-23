'use client';

import posthog from 'posthog-js';

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
export function track(event: string, properties?: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
  const debug = (window as unknown as { __sundialTrackDebug?: unknown }).__sundialTrackDebug;
  if (Array.isArray(debug)) debug.push({ event, properties: properties ?? {} });
  try {
    posthog.capture(event, properties);
  } catch {
    // Ignore.
  }
}
