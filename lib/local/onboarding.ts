/**
 * First-run onboarding on the desktop home: the guided cards show on a machine
 * that has never opened anything, and never come back once the user dismisses
 * them or has a first project. The flag is sticky on purpose, so deleting every
 * project does not replay onboarding.
 */
export const ONBOARDING_DONE_KEY = 'sundial:onboarding-done';

export type OnboardingState = {
  /** Sidecar ready and, when signed in, the cloud list has answered. Until
   *  then the count is not trustworthy and the cards would flash. */
  resolved: boolean;
  /** The sticky "already onboarded" flag. */
  done: boolean;
  /** Local projects plus cloud workspaces: anything the user can open. */
  itemCount: number;
};

/** The guided cards belong to an empty, never-onboarded home. */
export function shouldShowOnboarding({ resolved, done, itemCount }: OnboardingState): boolean {
  return resolved && !done && itemCount === 0;
}

/** Having something to open counts as onboarded, so the cards never return. */
export function shouldMarkOnboarded({ resolved, done, itemCount }: OnboardingState): boolean {
  return resolved && !done && itemCount > 0;
}

export function readOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) === '1';
  } catch {
    return false; // private mode: onboarding is worth more than the memory
  }
}

export function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, '1');
  } catch {
    /* private mode */
  }
}

/** `?onboardingReset=1` on /local, for demos and screenshots. */
export function clearOnboardingDone(): void {
  try {
    localStorage.removeItem(ONBOARDING_DONE_KEY);
  } catch {
    /* private mode */
  }
}
