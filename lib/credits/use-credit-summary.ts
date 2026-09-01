'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

// Client view of GET /api/stripe/customers (billing summary). Used by the
// sidebar low-balance pill and the billing settings tab.
export type CreditSummary = {
  balanceMicros: number;
  credits: number;
  plan: 'free' | 'plus20' | 'pro100' | string;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  meteredOverflowEnabled: boolean;
  stripeConfigured: boolean;
};

type State = {
  summary: CreditSummary | null;
  loading: boolean;
  /** true once a fetch has completed (success or 401) — lets callers avoid a flash. */
  ready: boolean;
  /** true when the fetch came back 401 — the only case that means "not signed
   *  in". A 5xx/network failure leaves this false so callers don't tell a
   *  signed-in user to sign in. */
  signedOut: boolean;
};

export function useCreditSummary(enabled = true): State & { refresh: () => void } {
  const [state, setState] = useState<State>({
    summary: null,
    loading: true,
    ready: false,
    signedOut: false,
  });
  // Monotonic request id so the LATEST fetch always wins, even if an earlier
  // (slower) one resolves after it — e.g. a manual Refresh racing the mount
  // fetch, which would otherwise paint a stale balance.
  const reqId = useRef(0);

  const refresh = useCallback(() => {
    const id = ++reqId.current;
    setState((s) => ({ ...s, loading: true }));
    fetch('/api/stripe/customers', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (id !== reqId.current) return; // superseded by a newer refresh
        const summary = res.ok ? ((await res.json()) as CreditSummary) : null;
        setState({ summary, loading: false, ready: true, signedOut: res.status === 401 });
      })
      .catch(() => {
        if (id !== reqId.current) return;
        setState({ summary: null, loading: false, ready: true, signedOut: false });
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  return { ...state, refresh };
}
