'use client';

import type { PostHog } from 'posthog-js';

/**
 * Lazily loads + initializes posthog-js (~175 KB minified) off the critical
 * path: nothing here runs until the first capture/identify or the post-load
 * idle tick (instrumentation-client.ts), so the SDK never competes with the
 * app bundle for first paint. Resolves null when no key is configured.
 */
let loading: Promise<PostHog | null> | null = null;
let loaded: PostHog | null = null;

/** The already-initialized SDK, or null when it hasn't loaded yet. Sync, so a
 *  caller that must not wait on (or trigger) the import can still read state. */
export function loadedPosthog(): PostHog | null {
  return loaded;
}

export function loadPosthog(): Promise<PostHog | null> {
  if (typeof window === 'undefined' || !process.env.NEXT_PUBLIC_POSTHOG_KEY) return Promise.resolve(null);
  loading ??= import('posthog-js')
    .then(({ default: posthog }) => {
      if (!posthog.__loaded) {
        posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY as string, {
          api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
          defaults: '2026-01-30',
        });
      }
      loaded = posthog;
      return posthog;
    })
    .catch(() => null);
  return loading;
}
