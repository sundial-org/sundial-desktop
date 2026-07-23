/** Browser ENGINE detection (not browser branding). Blink browsers (Chrome,
 *  Edge, Arc, …) carry the AppleWebKit token too, so real WebKit (Safari and
 *  every WKWebView, including the desktop shell) is "AppleWebKit minus Blink
 *  markers". Firefox has no AppleWebKit token.
 *
 *  Why it exists: WKWebView mishandles `content-visibility: auto` when the
 *  `:has(.sundial-cursor)` carve-out toggles a block in and out of the
 *  optimization during multiplayer typing — the block stops painting (text
 *  "disappears" until selected), and ProseMirror can then misread the skipped
 *  DOM and commit REAL deletions of the just-typed text. globals.css keeps the
 *  scroll optimization Blink-only via `:root:not([data-engine="webkit"])`. */
const WEBKIT_RE = /AppleWebKit/;
const BLINK_RE = /Chrom(e|ium)|Edg\//;

export const isWebKitEngineUA = (userAgent: string): boolean =>
  WEBKIT_RE.test(userAgent) && !BLINK_RE.test(userAgent);

/** Inline form for the root layout — must run before first paint, so it can't
 *  be a React effect. Kept in lockstep with isWebKitEngineUA by embedding the
 *  same regex literals. */
export const WEBKIT_ENGINE_INLINE_SCRIPT =
  `if (${WEBKIT_RE}.test(navigator.userAgent) && !${BLINK_RE}.test(navigator.userAgent)) ` +
  `document.documentElement.dataset.engine = 'webkit';`;
