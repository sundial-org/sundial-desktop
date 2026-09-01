import { WELCOME_TEX_ERROR_TARGET, WELCOME_TEX_PATH } from '@/lib/workspace/welcome-doc';

/**
 * State for the first-run landing on the deliberately broken welcome.tex.
 * Keep the old storage key so people who completed or skipped the retired
 * comment tour are not onboarded again.
 */
export const ONBOARDING_LANDING_DONE_KEY = 'sundial:onboarding-tour:v1';

const ONBOARDING_PRIVACY_PENDING_KEY = 'sundial:onboarding-privacy-pending:v1';

export function readOnboardingLandingDone(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(ONBOARDING_LANDING_DONE_KEY) === '1';
  } catch {
    return true;
  }
}

export function markOnboardingLandingDone(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ONBOARDING_LANDING_DONE_KEY, '1');
  } catch {
    /* private mode etc. - the landing just re-offers next visit */
  }
}

/**
 * Clicking the guided Fix starts onboarding's value moment; the privacy
 * promise waits until that exact workspace has a green compiled PDF. Persist
 * the arm so a reload while Sunny is working cannot drop the handoff.
 */
export function armOnboardingPrivacy(projectId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ONBOARDING_PRIVACY_PENDING_KEY, projectId);
  } catch {
    /* in-memory page state still covers the normal uninterrupted path */
  }
}

export function onboardingPrivacyPending(projectId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ONBOARDING_PRIVACY_PENDING_KEY) === projectId;
  } catch {
    return false;
  }
}

export function clearOnboardingPrivacyPending(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ONBOARDING_PRIVACY_PENDING_KEY);
  } catch {
    /* nothing else to clear */
  }
}

export function onboardingPrivacyReady(opts: {
  onboardingTexIntent: boolean;
  latexRootPath: string | null;
  compiling: boolean;
  hasCompileError: boolean;
  hasPdf: boolean;
}): boolean {
  return (
    opts.onboardingTexIntent &&
    opts.latexRootPath === WELCOME_TEX_PATH &&
    !opts.compiling &&
    !opts.hasCompileError &&
    opts.hasPdf
  );
}

/**
 * Is this welcome.tex OUR seeded broken doc? A shared or pre-existing
 * workspace can carry its own file at the same path; never hijack that file.
 */
export function welcomeTexLooksSeeded(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.includes(WELCOME_TEX_ERROR_TARGET);
}

/**
 * Keep automated tests, embedded agent panels, returning users, and people
 * who cannot ask Sunny to edit away from the first-run landing.
 */
export function onboardingLandingEligible(opts: {
  canWrite: boolean;
  hasWelcomeTex: boolean;
  panelView?: boolean;
}): boolean {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return false;
  if (opts.panelView) return false;
  if (readOnboardingLandingDone()) return false;
  return opts.hasWelcomeTex && opts.canWrite;
}
