'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DESKTOP_CREDENTIALS_EVENT } from '@/lib/desktop';
import { sidecar, type LocalShare, type SidecarConfig } from './sidecar';

/** Live view of a local project's cloud shares: loads them, follows the
 *  sidecar's shares-changed SSE, and quietly re-mints each share's 7-day sync
 *  token when a signed-in user opens the project (fire-and-forget — a failure
 *  just leaves the old token until the next visit). */
export function useLocalShares(config: SidecarConfig | null, projectId: string | null) {
  const [shares, setShares] = useState<LocalShare[]>([]);

  const refresh = useCallback(async () => {
    if (!config || !projectId) return;
    try {
      const { shares } = await sidecar.getProject(config, projectId);
      setShares(shares);
    } catch {
      /* sidecar hiccup — keep the last known list */
    }
  }, [config, projectId]);

  useEffect(() => {
    if (!config || !projectId) return;
    void refresh();
    return sidecar.subscribe(config, projectId, (event) => {
      if (event.type === 'shares-changed') void refresh();
    });
  }, [config, projectId, refresh]);

  // Keyed per share (not one-shot): switching local projects in the same SPA
  // session must still re-mint the other project's share tokens. No signed-in
  // gate — auth may be a Clerk cookie (web) or the proxy-injected sd_ bearer
  // (packaged app). Shares are marked done only on SUCCESS: a signed-out 401
  // must retry once credentials arrive (the desktop sign-in event re-runs
  // this effect), not burn the share's one attempt.
  const refreshedTokens = useRef(new Set<string>());
  const [authEpoch, setAuthEpoch] = useState(0);
  useEffect(() => {
    const bump = () => setAuthEpoch((n) => n + 1);
    window.addEventListener(DESKTOP_CREDENTIALS_EVENT, bump);
    return () => window.removeEventListener(DESKTOP_CREDENTIALS_EVENT, bump);
  }, []);
  useEffect(() => {
    void authEpoch; // re-attempt after desktop credentials land
    if (!config || !projectId || shares.length === 0) return;
    for (const share of shares) {
      // Grants-model scope entries share ONE union row — refresh it once.
      const tokenTarget = share.share_id ?? share.id;
      if (refreshedTokens.current.has(tokenTarget)) continue;
      void fetch('/api/workspace/local-agent/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId: share.workspace_id, bridge: true }),
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { token?: string };
          if (!res.ok || !body.token) return;
          await fetch(`${config.origin}/projects/${projectId}/shares/${tokenTarget}/token`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: body.token }),
          });
          refreshedTokens.current.add(tokenTarget);
        })
        .catch(() => {});
    }
  }, [authEpoch, config, projectId, shares]);

  return { shares, refreshShares: refresh };
}
