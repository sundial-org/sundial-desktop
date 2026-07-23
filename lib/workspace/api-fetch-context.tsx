'use client';

/** Workspace data-plane fetch as React context: local (sidecar) workspaces
 *  provide their emulated `/api/workspace/*` fetch here so deep components
 *  (Review panel, compare, labels) hit the local ledger without threading a
 *  prop through every layer. Cloud workspaces provide nothing — the hook
 *  falls back to the real fetch. */

import { createContext, useContext } from 'react';

const ApiFetchContext = createContext<typeof fetch | null>(null);

// Module-level (stable identity): consumers put the returned function in
// effect/callback deps, so a per-render fallback would retrigger their
// fetches on every state update. Wrapped so the global fetch keeps its
// expected receiver.
const realFetch: typeof fetch = (input, init) => fetch(input, init);

export function ApiFetchProvider({ value, children }: { value: typeof fetch; children: React.ReactNode }) {
  return <ApiFetchContext.Provider value={value}>{children}</ApiFetchContext.Provider>;
}

export function useApiFetch(): typeof fetch {
  return useContext(ApiFetchContext) ?? realFetch;
}
