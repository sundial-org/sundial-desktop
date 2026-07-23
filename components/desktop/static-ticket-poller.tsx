'use client';

// sd_-credentials-only sign-in completion for the static desktop UI, where
// Clerk does not exist at all: mirrors the clerkNeverLoads() path of
// DesktopTicketPoller (components/desktop-auth-interceptor.tsx). While a
// sign-in started by beginDesktopAuth is pending, poll the claim endpoint
// (proxied to the cloud) for the parked sd_ token and hand it to the sidecar.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DESKTOP_AUTH_STARTED_EVENT,
  DESKTOP_CREDENTIALS_EVENT,
  isDesktopApp,
  markDesktopAuthComplete,
  pendingDesktopAuth,
  takeDesktopAuthState,
} from '@/lib/desktop';
import { resolveSidecarConfig, sidecar } from '@/lib/local/sidecar';

const CLAIM_INTERVAL_MS = 2_000;
const CLAIM_WINDOW_MS = 5 * 60_000;

export function StaticTicketPoller() {
  const router = useRouter();
  const [armedAt, setArmedAt] = useState(0);
  useEffect(() => {
    const onStarted = () => setArmedAt((n) => n + 1);
    window.addEventListener(DESKTOP_AUTH_STARTED_EVENT, onStarted);
    return () => window.removeEventListener(DESKTOP_AUTH_STARTED_EVENT, onStarted);
  }, []);

  useEffect(() => {
    void armedAt; // each beginDesktopAuth restarts the poll window
    if (!isDesktopApp()) return;
    const pending = pendingDesktopAuth();
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const tick = async () => {
      if (stopped || Date.now() - startedAt > CLAIM_WINDOW_MS) return;
      try {
        const res = await fetch('/api/desktop/ticket/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claimKey: pending.claimKey }),
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { apiToken?: string | null } | null;
          const config = await resolveSidecarConfig();
          if (body?.apiToken && config) {
            const stored = await sidecar
              .setAgentCredentials(config, { apiOrigin: window.location.origin, token: body.apiToken })
              .then(() => true)
              .catch(() => false);
            if (stored) {
              window.dispatchEvent(new Event(DESKTOP_CREDENTIALS_EVENT));
              markDesktopAuthComplete(); // before clearing the nonce — a late deep link must read success
              takeDesktopAuthState();
              if (pending.next) router.replace(pending.next);
              return;
            }
          }
        }
      } catch (error) {
        console.warn('[desktop-auth] ticket claim attempt failed', error);
      }
      if (!stopped) timer = setTimeout(() => void tick(), CLAIM_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), CLAIM_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [armedAt, router]);
  return null;
}
