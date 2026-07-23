'use client';

import { useEffect } from 'react';

/** How long a freshly-attached provider may stay unsynced before we assume the
 *  shared socket is half-dead and force a reconnect. Normal first-sync over an
 *  already-open socket is sub-second; a real large-doc sync is a few seconds —
 *  8s clears both yet beats the 5-min messageReconnectTimeout by a wide margin. */
export const COLLAB_SYNC_WATCHDOG_MS = 8_000;

/**
 * Rescues the "Loading editor…" forever state. A shared Hocuspocus socket can
 * report `Connected` while actually dead (no message in < messageReconnectTimeout,
 * which we raised to 5 min to avoid idle churn). A provider attached to it during
 * that window — typically a file switch — sends SyncStep1 into the void and never
 * fires `synced`, so the editor hangs until the socket's own 5-min check finally
 * closes it. This watchdog forces that recovery after a few seconds instead.
 *
 * The gate is the provider's OWN `synced` (did the document actually handshake),
 * not the editor's render-ready flag: the code/LaTeX editor flips render-ready on
 * mere socket `status === 'connected'` before the doc syncs, which would otherwise
 * clear this watchdog on a dead-but-connected socket and skip recovery. `syncSignal`
 * (that render-ready flag) is passed only so the effect re-evaluates the gate when
 * sync state moves; the timeout also re-checks live `provider.synced`, so a sync
 * that lands late just no-ops. A reconnect hands off to the socket's retry loop +
 * the provider's `synced` listener (so it needn't re-arm), and `reconnect()`'s own
 * status guard keeps it from thrashing a socket that's already retrying.
 */
export function useCollabSyncWatchdog({
  enabled,
  provider,
  reconnect,
  syncSignal,
  timeoutMs = COLLAB_SYNC_WATCHDOG_MS,
}: {
  /** Only watch collaborative files (a local-only doc never needs the socket). */
  enabled: boolean;
  /** The provider whose `synced` is the authoritative gate (and re-checked on fire). */
  provider: { synced?: boolean } | null;
  /** Forces the shared socket to drop + re-establish. No-op guard when absent. */
  reconnect: (() => void) | undefined;
  /** The editor's render-ready flag — a reactive trigger to re-evaluate, NOT the gate. */
  syncSignal: boolean;
  timeoutMs?: number;
}) {
  useEffect(() => {
    if (!enabled || !reconnect || !provider || provider.synced) return;
    const timer = setTimeout(() => {
      if (!provider.synced) reconnect();
    }, timeoutMs);
    return () => clearTimeout(timer);
    // syncSignal is intentionally a dep: it moves on sync/status events, prompting
    // a re-evaluation of the authoritative `provider.synced` gate above.
  }, [enabled, provider, reconnect, syncSignal, timeoutMs]);
}
