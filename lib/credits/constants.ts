// Credit accounting constants. Ground truth is USD micro-dollars
// (1_000_000 = $1) in the credit_events ledger; "credits" are a fixed-rate
// display layer (1 credit = $0.10). Safe to import on client or server — pure
// values, no secrets.

export const USD_MICROS = 1_000_000;

// 1 credit = $0.10, so the $20 Plus plan = 200 credits and the $100 Max plan =
// 1000 credits (price × 10). Display unit only — grants/costs are stored in USD
// micros; this is what "one fewer zero on the credit count" means.
export const CREDIT_USD = 0.1;
export const MICROS_PER_CREDIT = CREDIT_USD * USD_MICROS; // 100_000

// Monthly allotments granted on subscription / renewal — the plan price in
// credits (Plus $20 → 200, Max $100 → 1000). Used by the Stripe webhook.
export const PLAN_PLUS_MICROS = 20 * USD_MICROS; // 200 credits
export const PLAN_PRO_MICROS = 100 * USD_MICROS; // 1000 credits

// Free-tier floor, refilled once per month (20 credits).
export const FREE_GRANT_MICROS = 2 * USD_MICROS; // 20 credits
// One-time welcome grant on a signed-in user's first send (200 credits, $20).
// Beta researchers get the larger bonus below instead; the monthly floor above
// tops everyone up afterward.
export const SIGNUP_FREE_GRANT_MICROS = 20 * USD_MICROS; // 200 credits
// Beta researchers get a one-time bonus of 10× a monthly Plus plan (2000
// credits) — the "researcher program" allotment shown in onboarding.
export const BETA_FREE_GRANT_MULTIPLIER = 10;
export const BETA_FREE_GRANT_MICROS = BETA_FREE_GRANT_MULTIPLIER * PLAN_PLUS_MICROS; // 2000 credits

export type PlanKey = "free" | "plus20" | "pro100";

export const PLAN_GRANT_MICROS: Record<Exclude<PlanKey, "free">, number> = {
  plus20: PLAN_PLUS_MICROS,
  pro100: PLAN_PRO_MICROS,
};

// Below this, the sidebar surfaces a "low credits" pill (hidden otherwise).
export const LOW_BALANCE_MICROS = 0.2 * USD_MICROS; // $0.20

export const microsToCredits = (micros: number): number =>
  Math.round(micros / MICROS_PER_CREDIT);

export const microsToUsd = (micros: number): number => micros / USD_MICROS;
