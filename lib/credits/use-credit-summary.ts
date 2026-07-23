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
};

export function useCreditSummary(): State & { refresh: () => void } {
  const [state, setState] = useState<State>({ summary: null, loading: true, ready: false });
  // Monotonic request id so the LATEST fetch always wins, even if an earlier
  // (slower) one resolves after it — e.g. a manual Refresh racing the mount
  // fetch, which would otherwise paint a stale balance.
  const reqId = useRef(0);

  const refresh = useCallback(() => {
    const id = ++reqId.current;
    setState((s) => ({ ...s, loading: true }));
    fetch('/api/stripe/customers', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? (res.json() as Promise<CreditSummary>) : null))
      .then((summary) => {
        if (id !== reqId.current) return; // superseded by a newer refresh
        setState({ summary, loading: false, ready: true });
      })
      .catch(() => {
        if (id !== reqId.current) return;
        setState({ summary: null, loading: false, ready: true });
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}
