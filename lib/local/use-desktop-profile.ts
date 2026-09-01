'use client';

import { useEffect, useRef, useState } from 'react';
import { DESKTOP_CREDENTIALS_EVENT } from '@/lib/desktop';

/** `id` is the Clerk user id /api/user resolves from the sd_ token — the id the
 *  server stamps as the author of anything this identity writes. */
export type DesktopProfile = { id: string; name: string | null; email: string | null; imageUrl: string | null };

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
    // Per-load generation: a fetch that started before the latest rotation
    // must not write at all — a late resolve for the OLD account would
    // resurrect the profile the rotation just cleared (Codex).
    let gen = 0;
    const load = () => {
      const mine = ++gen;
      void fetch('/api/user')
        .then(async (res) => {
          if (cancelled || mine !== gen) return;
          if (!res.ok) {
            // A rejected sd_ token makes the proxy clear its parked
            // credentials, but cloud workspace pages have no project SSE to
            // hear that broadcast — poke the gates to re-check so the UI
            // drops to signed-out instead of a stale signed-in shell.
            if (res.status === 401 || res.status === 403) {
              // Rejected credentials: this profile no longer signs the
              // requests — drop it rather than keep authoring under it.
              setProfile(null);
              if (!reportedRef.current) {
                reportedRef.current = true;
                window.dispatchEvent(new Event(DESKTOP_CREDENTIALS_EVENT));
              }
            }
            return;
          }
          reportedRef.current = false;
          const data = (await res.json().catch(() => null)) as { user?: DesktopProfile } | null;
          if (!cancelled && mine === gen && data?.user) setProfile(data.user);
        })
        .catch(() => {});
    };
    load();
    // Credential rotation: the old profile must not survive into the refetch
    // window (or a failed refetch) — local-workspace writes persist whatever
    // author id the page holds, so a stale profile mis-attributes them.
    const rotated = () => {
      setProfile(null);
      load();
    };
    window.addEventListener(DESKTOP_CREDENTIALS_EVENT, rotated);
    return () => {
      cancelled = true;
      window.removeEventListener(DESKTOP_CREDENTIALS_EVENT, rotated);
    };
  }, [enabled]);
  return profile;
}
