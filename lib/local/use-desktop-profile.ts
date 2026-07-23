'use client';

import { useEffect, useRef, useState } from 'react';
import { DESKTOP_CREDENTIALS_EVENT } from '@/lib/desktop';

export type DesktopProfile = { name: string | null; email: string | null; imageUrl: string | null };

/** Profile of the sd_-credential identity for packaged-app UI (no Clerk user
 *  object exists in the webview). Page-relative /api/user carries the sd_
 *  bearer via the sidecar proxy. Refetches when a desktop sign-in lands new
 *  credentials mid-session. */
export function useDesktopProfile(enabled: boolean): DesktopProfile | null {
  const [profile, setProfile] = useState<DesktopProfile | null>(null);
  // One credentials-event poke per failure streak — the event retriggers this
  // hook's own listener, so an unguarded dispatch would loop.
  const reportedRef = useRef(false);
  useEffect(() => {
    if (!enabled) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      void fetch('/api/user')
        .then(async (res) => {
          if (!res.ok) {
            // A rejected sd_ token makes the proxy clear its parked
            // credentials, but cloud workspace pages have no project SSE to
            // hear that broadcast — poke the gates to re-check so the UI
            // drops to signed-out instead of a stale signed-in shell.
            if ((res.status === 401 || res.status === 403) && !reportedRef.current) {
              reportedRef.current = true;
              window.dispatchEvent(new Event(DESKTOP_CREDENTIALS_EVENT));
            }
            return;
          }
          reportedRef.current = false;
          const data = (await res.json().catch(() => null)) as { user?: DesktopProfile } | null;
          if (!cancelled && data?.user) setProfile(data.user);
        })
        .catch(() => {});
    load();
    window.addEventListener(DESKTOP_CREDENTIALS_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(DESKTOP_CREDENTIALS_EVENT, load);
    };
  }, [enabled]);
  return profile;
}
