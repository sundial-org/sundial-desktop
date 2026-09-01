/**
 * The ghost-text pilot flag — the autocomplete-specific face over the shared
 * flag store (`lib/flags/client.ts`, registry key `autocomplete_enabled`).
 *
 * Its own module because its readers are not the feature: the workspace page
 * applies the URL escape hatch at load and the Monaco provider asks per
 * completion request. Neither should know a registry key by string.
 */

import { getFlag, setFlag, setFlagEphemeral, __resetFlagsForTest } from '@/lib/flags/client';

const FLAG_KEY = 'autocomplete_enabled';

/**
 * The pilot is off in prod builds, whatever any per-browser flag says.
 *
 * Exported because it has TWO readers, and a client-only guard is not a
 * guard: hiding the UI leaves `POST /api/workspace/autocomplete` callable by
 * anyone who can write to a workspace, which authorizes the request and bills
 * a Gateway model for a feature nobody can see. The route gates on this too.
 * Delete both when the pilot graduates.
 *
 * `NEXT_PUBLIC_IS_PROD` needs a manual dashboard setting per target and has
 * never been that on the Vercel Production target (see item 1 below) — so
 * the route's enforcement falls back to `VERCEL_ENV`, which Vercel sets to
 * `"production"` for the Production target with no configuration at all.
 * Server-only: it isn't inlined into the client bundle, so the browser-side
 * reader still depends on `NEXT_PUBLIC_IS_PROD` until that's set too.
 */
export function isAutocompleteProdDisabled(): boolean {
  if (process.env.NEXT_PUBLIC_IS_PROD === 'true') return true;
  return process.env.VERCEL_ENV === 'production';
}

/* ── Graduating the pilot ──────────────────────────────────────────────
 *  What has to be true before the guard above is deleted rather than merely
 *  ignored. Ordered by what blocks a prod flip, not by effort.
 *
 *  BLOCKING
 *  1. Decide what the guard means for the CLIENT reader. `NEXT_PUBLIC_IS_PROD`
 *     is not set on the Vercel Production target, so `isAutocompleteEnabled`
 *     (browser-only; `VERCEL_ENV` isn't inlined into the client bundle) still
 *     never treats prod as prod: `/demo/editor` renders on www.sundial.md
 *     while a bogus path 404s, and `app/demo/layout.tsx` on main carries the
 *     identical unset-var check. The server route no longer has this gap —
 *     it falls back to `VERCEL_ENV`. Either set `NEXT_PUBLIC_IS_PROD` too
 *     (NEXT_PUBLIC_* is inlined at build, so it takes a redeploy) or drop the
 *     client reader and let the route be the only enforcement.
 *  2. Gate or delete `/test/autocomplete-ghost-text`. It answers 200 in prod
 *     — `app/test/` has no layout guard the way `app/demo/` does — and calls
 *     `setAutocompleteEnabled(true)` on mount, so visiting it opts that
 *     browser into the pilot permanently, everywhere in the app.
 *  3. Settle the free tier. One completion is ~1_700 USD micros at the
 *     default model's prices, so the 20-credit monthly floor
 *     (`lib/credits/constants.ts`) is roughly four hours of writing. Cheaper
 *     default model, paid plans only, or accept it — but decide before the
 *     first free-tier user finds out by running dry.
 *  4. Confirm anonymous visitors are meant to lose ghost text. The payer gate
 *     refuses them (402 `signin_required`), which is the rule every other AI
 *     route applies, and is still a behaviour change for tokenless
 *     public-edit workspaces.
 *
 *  HARDENING — shippable without, revisit when the pilot runs wide
 *  5. A bounded credit hold, if spend must be exact across instances. The
 *     window is sized to the balance read at mint (`meter.ts`), which is a
 *     per-instance guarantee: two instances can each mint against the same
 *     balance. A real reservation needs a `hold` type on the `credit_events`
 *     CHECK, a release keyed to the grant so a retry cannot double-refund,
 *     and a sweeper for windows that never close. Hold ONE window's worth,
 *     never the whole balance — eight consumers read the same ledger sum
 *     (chat, the five direct-call routes, the sidebar pill), so a
 *     full-balance hold would show the payer 0 credits and refuse their chat
 *     while they type.
 *  6. Shared rate-limit state. `createRateLimiter` is per-instance by
 *     construction — a runaway guard, not a quota — so the real ceiling is
 *     40/minute times the instance count.
 *  7. Somewhere to watch it fail. The debit warning in `meter.ts` is a
 *     console.warn from a Vercel function, and the Axiom pipeline ships Fly
 *     apps only, so a failing ledger write is invisible today. Wanted: failed
 *     and unbanked windows, completion latency, acceptance rate.
 *
 *  ACCEPTED, NOT FORGOTTEN
 *  - Revocation lags one grant TTL: a collaborator removed mid-session keeps
 *    completions for up to a minute. Spend, never content — the prompt is
 *    built from the requester's own buffer.
 *  - The limiter's burst depth can carry a scripted client ~20 completions
 *    past a freshly emptied balance before the next mint refuses. A human
 *    typist cannot: the adapter debounces and keeps one request in flight.
 *  - An instance that dies mid-window drops what it had not banked, so the
 *    ledger under-bills — the right direction to fail.
 * ─────────────────────────────────────────────────────────────────────── */

/** Default OFF. Switched from Settings → Advanced (account-backed; the
 *  workspace page hydrates the shared flag store from the fetched preference
 *  so synchronous readers keep working) or via the `?autocomplete=on`
 *  escape hatch. */
export function isAutocompleteEnabled(): boolean {
  if (isAutocompleteProdDisabled()) return false;
  return getFlag(FLAG_KEY);
}

export function setAutocompleteEnabled(enabled: boolean): void {
  setFlag(FLAG_KEY, enabled);
}

/** The URL escape hatch: `?autocomplete=on|off` flips the flag for THIS page
 *  load only — in memory, never localStorage, never the account. A link must
 *  not be able to durably opt anyone in; only the Settings → Advanced switch
 *  persists. Returns what it applied (or null) so the workspace page can keep
 *  the account hydration from clobbering the override mid-session. */
export function applyAutocompleteFlagFromUrl(search?: string): boolean | null {
  if (search === undefined && typeof window === 'undefined') return null;
  const value = new URLSearchParams(search ?? window.location.search).get('autocomplete');
  if (value !== 'on' && value !== 'off') return null;
  setFlagEphemeral(FLAG_KEY, value === 'on');
  return value === 'on';
}

/** Session-only enable for the test harness page: on reload it is gone.
 *  Visiting a page must never durably opt the browser into the pilot. */
export function setAutocompleteEnabledEphemeral(enabled: boolean): void {
  setFlagEphemeral(FLAG_KEY, enabled);
}

/** Test-only: reset module state between cases. */
export function __resetAutocompleteFlagForTest(): void {
  __resetFlagsForTest();
}
