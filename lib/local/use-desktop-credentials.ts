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
 *  calls would 401. */
export function useDesktopCredentials(config: SidecarConfig | null): boolean {
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    if (!config || window.location.origin !== config.origin) {
      setConfigured(false);
      return;
    }
    let cancelled = false;
    const check = () =>
      void sidecar
        .agentCredentialsConfigured(config)
        .then(({ configured: value }) => {
          if (!cancelled) setConfigured(Boolean(value));
        })
        .catch(() => {});
    check();
    window.addEventListener(DESKTOP_CREDENTIALS_EVENT, check);
    return () => {
      cancelled = true;
      window.removeEventListener(DESKTOP_CREDENTIALS_EVENT, check);
    };
  }, [config]);
  return configured;
}
