'use client';

import { useEffect, useRef } from 'react';
import { clearAnonCookie, readAnonCookie } from './anon-identity-client';

/**
 * When a logged-in user is detected and an `sd_anon` cookie is still present,
 * POST `/api/auth/claim-anon` once to retro-attribute past edits to the user,
 * then drop the cookie. No-op when not signed in or when the cookie is absent.
 */
export function useClaimAnonOnLogin(isSignedIn: boolean | undefined): void {
  const claimedRef = useRef(false);

  useEffect(() => {
    if (!isSignedIn) return;
    if (claimedRef.current) return;
    const anon = readAnonCookie();
    if (!anon) return;
    claimedRef.current = true;
    void fetch('/api/auth/claim-anon', { method: 'POST' })
      .then((res) => {
        if (res.ok) clearAnonCookie();
        else claimedRef.current = false; // allow retry next mount
      })
      .catch(() => {
        claimedRef.current = false;
      });
  }, [isSignedIn]);
}
