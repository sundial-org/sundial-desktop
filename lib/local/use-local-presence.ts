'use client';

import { useEffect, useState } from 'react';
import {
  collectAwarenessPeers,
  type AwarenessPeer,
  type WorkspaceCollabSocket,
} from '@/lib/workspace/collab-socket-context';

const POLL_MS = 2_000;

/** Drop peers that ARE this user (same awareness name+color — e.g. another
 *  window of the same signed-in account); cloud presence hides self the same
 *  way. Same name with a different color is a genuine other person. */
export function excludeSelfPeers(
  peers: AwarenessPeer[],
  self: { name: string; color: string },
): AwarenessPeer[] {
  return peers.filter((peer) => peer.name !== self.name || peer.color !== self.color);
}

/** Presence chips for local projects. Cloud presence rides a Supabase
 *  realtime channel local workspaces don't have; the equivalent signal is Yjs
 *  awareness on the sidecar's docs (cloud peers relayed by the share bridge).
 *  Polled: awareness churns on every cursor move, so a snapshot-diff beats
 *  subscribing to each provider. */
export function useLocalCollabPresence(
  collab: WorkspaceCollabSocket | null,
  enabled: boolean,
): AwarenessPeer[] {
  const [peers, setPeers] = useState<AwarenessPeer[]>([]);

  useEffect(() => {
    if (!enabled || !collab) {
      setPeers([]);
      return;
    }
    // null sentinel: the FIRST read must always publish — a socket swap to an
    // empty peer set would otherwise leave the previous socket's badges up.
    let last: string | null = null;
    const read = () => {
      const next = collectAwarenessPeers(collab.socket);
      const signature = next
        .map((peer) => peer.key)
        .sort()
        .join(',');
      if (signature === last) return;
      last = signature;
      setPeers(next);
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => clearInterval(timer);
  }, [collab, enabled]);

  return peers;
}
