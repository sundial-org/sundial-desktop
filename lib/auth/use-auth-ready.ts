'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth/optional-auth';
import { clerkNeverLoads } from '@/lib/desktop';
import {
  getSidecarConfig,
  resolveSidecarConfig,
  type SidecarConfig,
} from '@/lib/local/sidecar';
import { useDesktopCredentials } from '@/lib/local/use-desktop-credentials';

/**
 * Session state across ALL auth flavors — Clerk (web) and sd_ sidecar
 * credentials (packaged desktop app, where clerk-js never finishes loading
 * on the loopback origin). Any gate that waits only on Clerk's `isLoaded`
 * hangs forever on the packaged app; any gate that reads only `isSignedIn`
 * calls a signed-in desktop user signed out. Compose from here instead.
 */
export function useHybridAuth(): { signedIn: boolean; ready: boolean } {
  const { isLoaded, isSignedIn } = useAuth();
  // Sync read first; if storage lost the config, fall back to the async
  // recovery path (`/session-config` on the sidecar origin, authenticated by
  // the HttpOnly trust cookie) — otherwise a packaged app with cleared
  // localStorage would read as signed OUT while its /api/* calls still
  // authenticate fine (Codex P2).
  const [sidecarConfig, setSidecarConfig] = useState<SidecarConfig | null>(() =>
    getSidecarConfig(),
  );
  // True once the config question is answered — cached, recovered, or
  // definitively absent. Until then a packaged app can't know its session
  // state, so `ready` must hold (else cleared-storage desktop users flash
  // the signed-out state while /session-config is still in flight).
  const [configSettled, setConfigSettled] = useState(false);
  useEffect(() => {
    if (sidecarConfig) {
      setConfigSettled(true);
      return;
    }
    let cancelled = false;
    void resolveSidecarConfig().then((config) => {
      if (cancelled) return;
      // On success, only store the config: settling here would batch with it
      // into a render where useDesktopCredentials still holds its stale
      // settled false (its null-reset effect hasn't run), flashing ready.
      // The effect's re-run settles instead, in the same commit as that reset.
      if (config) setSidecarConfig(config);
      else setConfigSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [sidecarConfig]);
  const desktopSignedIn = useDesktopCredentials(sidecarConfig);
  return {
    signedIn: Boolean(isSignedIn) || desktopSignedIn === true,
    // In the packaged app (clerkNeverLoads) the sidecar probe is the only
    // session signal — hold "ready" until it settles (null = in flight), so
    // signed-in desktop users don't flash a signed-out state.
    ready:
      isLoaded ||
      desktopSignedIn === true ||
      (clerkNeverLoads() && configSettled && desktopSignedIn !== null),
  };
}

/** Just the "auth resolved enough to proceed" bit of useHybridAuth. */
export function useAuthReady(): boolean {
  return useHybridAuth().ready;
}
