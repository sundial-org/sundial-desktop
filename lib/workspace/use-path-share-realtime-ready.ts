'use client';

import { useEffect, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase/browser';
import { currentPathShareToken, pathShareRealtimeMint } from '@/lib/workspace/path-share-token-client';

// Transient mint failures retry on this cadence — releasing the gate without
// a token would attach dead channels instead (see below).
const TRANSIENT_RETRY_MS = 3_000;

/**
 * Gate for realtime subscriptions on a `?pshare=` page.
 *
 * A realtime channel subscribed before the socket's access token resolves
 * joins WITHOUT auth claims and never recovers: the join frame is serialized
 * eagerly, and a later `access_token` push does not re-create
 * `postgres_changes` subscriptions server-side (verified against dev
 * Supabase). Tabs without a sticky link token are ready immediately (the
 * client constructor primes the Clerk token before any effect subscribes);
 * tabs WITH one hold subscriptions until the mint lands — the minted JWT is
 * the socket's credential for signed-in visitors too (it embeds their sub).
 * An expected refusal (revoked link, path-scoped grant, feature off) flips
 * ready — those tabs fall back to Clerk-or-anon auth — while transient mint
 * failures keep the gate closed and retry: releasing it claims-less would
 * pin dead channels for the rest of the session.
 */
export function usePathShareRealtimeAuthReady(): boolean {
  const [needsPrime] = useState(
    () => typeof window !== 'undefined' && currentPathShareToken() !== null,
  );
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    if (!needsPrime || primed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = async () => {
      const mint = await pathShareRealtimeMint().catch(() => ({ status: 'transient' as const }));
      if (cancelled) return;
      if (mint.status === 'transient') {
        timer = setTimeout(() => void attempt(), TRANSIENT_RETRY_MS);
        return;
      }
      if (mint.status === 'token') {
        // The singleton may predate this page (created by the root-layout
        // auth sync on an earlier route) with the socket's auth already
        // resolved — push the JWT into it BEFORE channels mount, or their
        // joins would still go out claims-less.
        try {
          await createBrowserClient()?.realtime.setAuth(mint.jwt);
        } catch {
          /* socket not up yet — the join path reads the token via the callback */
        }
      }
      if (!cancelled) setPrimed(true);
    };
    void attempt();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [needsPrime, primed]);
  return !needsPrime || primed;
}
