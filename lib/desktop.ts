const DESKTOP_FLAG = 'sundial:isDesktop';
/** Mirrored as a cookie so proxy.ts can keep "/" from trapping the shell. */
export const DESKTOP_COOKIE = 'sundial_desktop';

/**
 * True when running inside the Tauri desktop shell (tauri/). Tauri reaches the
 * remote prod origin through neither its globals (`__TAURI_INTERNALS__`) nor
 * init scripts nor a custom user agent — but the shell fully controls the
 * launch URL, so it appends `?sundialDesktop=1`. We latch that into
 * sessionStorage on first load so it survives SPA navigation and the sign-in
 * deep-link round-trip. Sign-in must then route through the system browser
 * (/desktop-login): OAuth inside the webview has no Google session and Google
 * may block embedded webviews outright.
 */
export function isDesktopApp(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const desktop =
      new URLSearchParams(window.location.search).get('sundialDesktop') === '1' ||
      sessionStorage.getItem(DESKTOP_FLAG) === '1';
    if (desktop) {
      sessionStorage.setItem(DESKTOP_FLAG, '1');
      // Session-scoped like the flag above: the shell re-sends the launch param
      // every start, and a browser that once saw a debug link forgets it on
      // close. Mirrored from the stored branch too — a webview that latched
      // the flag under pre-cookie code must still pick the cookie up.
      document.cookie = `${DESKTOP_COOKIE}=1; Path=/; SameSite=Lax`;
    }
    return desktop;
  } catch {
    return false;
  }
}

/**
 * Click handler for external `target="_blank"` links. The desktop shell's
 * webview drops `target="_blank"` (and released builds predate the opener
 * IPC permission), so those links silently no-op. But the shell intercepts
 * ANY off-site navigation and hands it to the system browser (see
 * tauri/src-tauri/src/lib.rs `leaves_app`), on every shell version — so in
 * the shell we navigate in place instead. Browsers keep the normal _blank.
 */
export function openExternalOnDesktop(event: {
  preventDefault: () => void;
  currentTarget: { href: string };
}): void {
  if (!isDesktopApp()) return;
  event.preventDefault();
  window.location.assign(event.currentTarget.href);
}

const HIDE_TOP_BAR_KEY = 'sundial:hide-top-bar';

/** Desktop-shell preference (the rail's ⋮ menu): hide the top bar + tab
 *  strips, making the shell run the web's bar-less layout. Read synchronously
 *  (like the shell flag) because the pane-snapshot restore needs it before
 *  React state settles. Meaningless in the browser build, which is always
 *  bar-less. */
export function hideTopBarPreferred(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(HIDE_TOP_BAR_KEY) === '1';
  } catch {
    return false;
  }
}

export function setHideTopBarPreferred(hidden: boolean): void {
  try {
    window.localStorage.setItem(HIDE_TOP_BAR_KEY, hidden ? '1' : '0');
  } catch {
    /* private mode — the toggle still applies for this session */
  }
}

/** True when clerk-js can never finish loading at this origin: production
 *  Clerk keys are domain-locked, and the packaged desktop app serves the UI
 *  through the loopback proxy (see tauri/src-tauri/src/lib.rs). Auth flows
 *  that wait on Clerk load state must proceed without it here — the sd_
 *  credentials parked in the sidecar are the session. */
export function clerkNeverLoads(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return (
    (host === '127.0.0.1' || host === 'localhost') &&
    (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '').startsWith('pk_live_')
  );
}

const DESKTOP_VERSION_KEY = 'sundial:desktopVersion';

/** Shell version (CARGO_PKG_VERSION), appended to the launch URL as
 *  `desktopVersion` and latched like the desktop flag. Null in the browser
 *  and under older shells that don't send it. */
export function getDesktopVersion(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const param = new URLSearchParams(window.location.search).get('desktopVersion');
    if (param && /^[\w.-]{1,32}$/.test(param)) {
      sessionStorage.setItem(DESKTOP_VERSION_KEY, param);
      return param;
    }
    return sessionStorage.getItem(DESKTOP_VERSION_KEY);
  } catch {
    return null;
  }
}

// Binds a desktop sign-in to the webview instance that started it. Without
// this, any sundial://auth?ticket=… deep link would be consumed, so an
// attacker could mint a ticket for their own account and trick a victim into
// opening a link that signs the victim's app into the attacker's account
// (session fixation). The nonce is generated here, kept only in this webview's
// sessionStorage, round-tripped through the browser, and checked on return.
const AUTH_STATE_KEY = 'sundial:desktop-auth-state';
const AUTH_NEXT_KEY = 'sundial:desktop-auth-next';
/** Fired by beginDesktopAuth so the ticket poller re-arms. Necessary because
 *  the shell CANCELS the /desktop-login navigation (it opens the system
 *  browser instead), so the SPA never remounts and no React state changes. */
export const DESKTOP_AUTH_STARTED_EVENT = 'sundial:desktop-auth-started';
/** Fired when the desktop sign-in lands sd_ credentials in the sidecar —
 *  local-surface auth gates listen and re-check "signed in". */
export const DESKTOP_CREDENTIALS_EVENT = 'sundial:desktop-credentials';

const AUTH_CLAIM_KEY = 'sundial:desktop-auth-claim-key';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Start desktop sign-in: mint a claim key, stash it locally, and open
 * /desktop-login in the system browser (the Tauri shell intercepts this
 * navigation). `next` is the in-app path to resume on after auth.
 *
 * The URL carries only `state` = SHA-256(claimKey): the browser parks the
 * one-time ticket UNDER the hash, but claiming it requires the preimage,
 * which never leaves this webview. Anyone who observes the URL (history
 * sync, screen share, logging proxy) learns nothing claim-usable.
 */
export function beginDesktopAuth(next?: string): void {
  void (async () => {
    const claimKey = crypto.randomUUID();
    const state = await sha256Hex(claimKey);
    try {
      // A fresh flow invalidates any prior completion — without this, a stale
      // marker would make a later re-auth (expired/revoked sd_ token) read any
      // deep link as success instead of processing its ticket.
      sessionStorage.removeItem(AUTH_DONE_KEY);
      sessionStorage.setItem(AUTH_STATE_KEY, state);
      sessionStorage.setItem(AUTH_CLAIM_KEY, claimKey);
      if (next) sessionStorage.setItem(AUTH_NEXT_KEY, next);
      else sessionStorage.removeItem(AUTH_NEXT_KEY);
    } catch {
      /* private mode / storage disabled — verification below will fail closed */
    }
    const params = new URLSearchParams({ state });
    if (next) params.set('next', next);
    window.dispatchEvent(new Event(DESKTOP_AUTH_STARTED_EVENT));
    window.location.assign(`/desktop-login?${params.toString()}`);
  })();
}

/**
 * Peek (without consuming) the pending sign-in started by beginDesktopAuth.
 * The webview's ticket poller keys on this: the browser parks the minted
 * ticket server-side under SHA-256(claimKey), and the poller redeems it by
 * presenting the preimage — the fallback path when the sundial:// deep link
 * never arrives (unbundled dev builds, browsers that block custom schemes).
 */
export function pendingDesktopAuth(): { claimKey: string; next: string | null } | null {
  try {
    const claimKey = sessionStorage.getItem(AUTH_CLAIM_KEY);
    if (!claimKey) return null;
    return { claimKey, next: sessionStorage.getItem(AUTH_NEXT_KEY) };
  } catch {
    return null;
  }
}

/**
 * Resolve a redirect target (relative or absolute) to a same-origin path we
 * can hand to beginDesktopAuth, or null when it's missing or points off-site.
 * Keeps the caller's intended return destination through the browser handoff.
 */
export function sameOriginPath(target: string | null | undefined): string | null {
  if (!target || typeof window === 'undefined') return null;
  try {
    const url = new URL(target, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : null;
  } catch {
    return null;
  }
}

// Clerk redirect options, most-specific first — so a button's explicit resume
// target (template autoCreate, workspace modal return path) survives the
// handoff instead of collapsing to the current page.
const REDIRECT_KEYS = [
  'forceRedirectUrl',
  'signInForceRedirectUrl',
  'signUpForceRedirectUrl',
  'redirectUrl',
  'fallbackRedirectUrl',
  'afterSignInUrl',
  'afterSignUpUrl',
] as const;

/** Extract the same-origin resume path from Clerk-style sign-in options. */
export function clerkRedirectPath(opts: unknown): string | null {
  if (!opts || typeof opts !== 'object') return null;
  const o = opts as Record<string, unknown>;
  for (const key of REDIRECT_KEYS) {
    if (typeof o[key] === 'string' && o[key]) return sameOriginPath(o[key] as string);
  }
  return null;
}

// Set when a desktop sign-in lands via sd_ credentials (no Clerk session). The
// deep-link and poller completions race: whichever wins consumes the one-shot
// nonce, so a LATE sundial://auth deep link reaches /desktop-auth with the
// nonce already gone and would otherwise show a false "expired" error over an
// already-successful sign-in. This marker lets the loser recognize success.
const AUTH_DONE_KEY = 'sundial:desktop-auth-complete';

/** Mark the desktop sign-in complete (sd_ credentials landed). */
export function markDesktopAuthComplete(): void {
  try {
    sessionStorage.setItem(AUTH_DONE_KEY, '1');
  } catch {
    /* private mode — the live isSignedIn / credentials checks still cover it */
  }
}

/** Whether a desktop sign-in already completed via sd_ credentials. */
export function desktopAuthCompleted(): boolean {
  try {
    return sessionStorage.getItem(AUTH_DONE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Read and clear the pending sign-in nonce (single use). */
export function takeDesktopAuthState(): string | null {
  try {
    const state = sessionStorage.getItem(AUTH_STATE_KEY);
    sessionStorage.removeItem(AUTH_STATE_KEY);
    sessionStorage.removeItem(AUTH_CLAIM_KEY);
    sessionStorage.removeItem(AUTH_NEXT_KEY);
    return state;
  } catch {
    return null;
  }
}
