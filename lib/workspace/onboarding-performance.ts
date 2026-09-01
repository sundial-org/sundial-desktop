export const WORKSPACE_VISIBLE_BUDGET_MS = 5_000;
export const STARTER_DIAGNOSTIC_BUDGET_MS = 1_000;

const CREATION_STARTED_KEY = 'sundial:onboarding-creation-started';

export function markOnboardingCreationStarted(now = Date.now()) {
  try {
    sessionStorage.setItem(CREATION_STARTED_KEY, String(now));
  } catch {
    // Storage can be unavailable in private/embedded contexts; navigation
    // timing remains a useful fallback on the workspace page.
  }
}

export function onboardingElapsedMs(now = Date.now()): number {
  try {
    const started = Number(sessionStorage.getItem(CREATION_STARTED_KEY));
    if (Number.isFinite(started) && started > 0 && started <= now) return now - started;
  } catch {
    // fall through
  }
  return typeof performance !== 'undefined' ? Math.max(0, performance.now()) : 0;
}

export function clearOnboardingCreationTiming() {
  try {
    sessionStorage.removeItem(CREATION_STARTED_KEY);
  } catch {
    // no-op
  }
}
