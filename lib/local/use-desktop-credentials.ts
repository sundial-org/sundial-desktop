'use client';

import { useEffect, useState } from 'react';
import { DESKTOP_CREDENTIALS_EVENT } from '@/lib/desktop';
import { sidecar, type SidecarConfig } from './sidecar';

/** Whether the sidecar holds cloud (sd_) credentials — the packaged app's
 *  notion of "signed in", where no Clerk session exists in the webview.
 *  Re-checks when the desktop sign-in flow lands credentials mid-session.
 *
 *  Only counts when the page is served BY the sidecar (the proxy origin):
 *  that's the only case where page-relative /api/* fetches carry the sd_
 *  bearer. A dev-server page (localhost:3000) with a signed-out Clerk must
 *  read as signed OUT even if the sidecar holds credentials — its own API
 *  calls would 401.
 *
 *  Returns null while the first probe is in flight, so gates that must not
 *  flash a signed-out state on the packaged app (where Clerk never loads and
 *  this probe is the ONLY session signal) can wait for it to settle. Plain
 *  truthiness reads null as false, matching the old behavior. */
export function useDesktopCredentials(config: SidecarConfig | null): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    if (!config || window.location.origin !== config.origin) {
      setConfigured(false);
      return;
    }
    let cancelled = false;
    // A (re)gained config starts a fresh probe — unsettled until it answers.
    // Event-driven re-checks below don't pass here, so they never flap to null.
    setConfigured(null);
    const check = () =>
      void sidecar
        .agentCredentialsConfigured(config)
        .then(({ configured: value }) => {
          if (!cancelled) setConfigured(Boolean(value));
        })
        // Settle an unresolved probe as signed-out, but never downgrade a
        // value an earlier probe established (event re-checks can flake).
        .catch(() => {
          if (!cancelled) setConfigured((prev) => prev ?? false);
        });
    check();
    window.addEventListener(DESKTOP_CREDENTIALS_EVENT, check);
    return () => {
      cancelled = true;
      window.removeEventListener(DESKTOP_CREDENTIALS_EVENT, check);
    };
  }, [config]);
  return configured;
}
