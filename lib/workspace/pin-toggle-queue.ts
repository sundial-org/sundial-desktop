/**
 * Serializes pin/unpin PATCHes per item and reconciles optimistic UI state on
 * failure. One queue instance per surface (e.g. the dashboard page).
 *
 * Guarantees, per key:
 * - `apply` is called synchronously with the optimistic value on toggle.
 * - `patch` calls run strictly in sequence, so the server can't persist a
 *   rapid pin→unpin out of order.
 * - On a failed PATCH, `apply` is called with the last server-acknowledged
 *   value — not the inverse of the failed request, which would diverge after
 *   two consecutive failures — and only when no newer toggle for the same key
 *   has been enqueued (the newer toggle then owns the final state).
 */
export type PinToggleQueue = ReturnType<typeof createPinToggleQueue>;

export function createPinToggleQueue() {
  const chains = new Map<string, Promise<unknown>>();
  const acked = new Map<string, boolean>();
  return {
    /** True while the key has unsettled PATCHes — its local state is optimistic. */
    pending(key: string): boolean {
      return chains.has(key);
    },
    toggle(key: string, pinned: boolean, patch: () => Promise<boolean>, apply: (pinned: boolean) => void): void {
      // Every toggle flips the current state, so before the first in-flight
      // toggle the server-acknowledged value is the pre-toggle one.
      if (!acked.has(key)) acked.set(key, !pinned);
      apply(pinned);
      const exec = async () => {
        const ok = await patch().then((r) => r, () => false);
        if (ok) acked.set(key, pinned);
        // The chain entry is replaced synchronously when a newer toggle is
        // enqueued, so identity tells us whether this toggle is still latest.
        else if (chains.get(key) === chain) apply(acked.get(key)!);
      };
      const chain: Promise<unknown> = (chains.get(key) ?? Promise.resolve()).then(exec, exec);
      chains.set(key, chain);
      void chain.finally(() => {
        if (chains.get(key) === chain) {
          chains.delete(key);
          acked.delete(key);
        }
      });
    },
  };
}
