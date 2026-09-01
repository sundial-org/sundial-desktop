'use client';

import { useEffect, useRef } from 'react';
import { readAnonCookie, readAnonHandoffIds } from './anon-identity-client';

/**
 * When a logged-in user is detected and this browser still carries ANY
 * anonymous identity, POST `/api/auth/claim-anon` once to retro-attribute past
 * edits to the user, then drop the cookies. No-op when not signed in or when
 * the browser holds no identity.
 *
 * A parked handoff counts on its own: sd_anon and each sd_anon_h_<id> expire
 * independently, so a browser can reach sign-in holding only a handoff, and
 * gating on sd_anon alone would leave that workspace anon-owned forever.
 */
export function useClaimAnonOnLogin(isSignedIn: boolean | undefined, onClaimed?: () => void): void {
  const claimedRef = useRef(false);
  // Ref so a fresh callback identity never re-fires the claim effect.
  const onClaimedRef = useRef(onClaimed);
  onClaimedRef.current = onClaimed;

  useEffect(() => {
    if (!isSignedIn) return;
    if (claimedRef.current) return;
    if (!readAnonCookie() && readAnonHandoffIds().length === 0) return;
    claimedRef.current = true;
    void fetch('/api/auth/claim-anon', { method: 'POST' })
      .then((res) => {
        // The response's Set-Cookie clears exactly the identities the server
        // claimed. Clearing here instead would re-read the CURRENT cookies and
        // delete a handoff parked while the request was in flight — one the
        // claim never saw, leaving that workspace anon-owned with its only
        // browser credential gone.
        if (res.ok) onClaimedRef.current?.();
        else claimedRef.current = false; // allow retry next mount
      })
      .catch(() => {
        claimedRef.current = false;
      });
  }, [isSignedIn]);
}
