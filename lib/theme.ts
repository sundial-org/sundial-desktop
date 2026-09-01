// App theme (light / dark / system). The preference is per-device, stored in
// localStorage like the other `sundial:*` UI prefs; the resolved mode is a
// `dark` class on <html> that app/globals.css keys its palette remap off.
//
// LIGHT is the default: an unset preference resolves light, not to the OS.
// "system" is therefore a value we STORE rather than the absence of one — the
// two used to be the same state, so following the OS was unavoidable.
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "sundial:theme";

// Fired on window by `apply` after every resolved-theme (re)application so
// JS consumers that can't key off CSS vars (e.g. Monaco) can follow flips.
export const THEME_CHANGE_EVENT = "sundial:theme-change";

// Runs inline in <body> before first paint (next to the engine script) so a
// dark-mode load never flashes light. Also owns the live listeners: OS theme
// changes while on "system", cross-tab preference changes via `storage`.
// `apply` re-adds the `js` class too: React's root hydration rewrites <html>'s
// className (wiping both classes), so ThemeApplier re-runs apply right after
// hydration. Do NOT re-assert from a MutationObserver instead — mutating the
// class mid-hydration livelocks React's hydration pass (hard page hang).
// The theme-color meta must follow the applied class too: the layout's static
// themeColor is light, and a hardcoded white paints the browser/PWA/titlebar
// strip ABOVE the viewport white in dark mode (the "white bar at top").
// #23201d mirrors .dark's --background in globals.css.
export const THEME_INLINE_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var c=document.documentElement.classList;var m=window.matchMedia('(prefers-color-scheme: dark)');var apply=function(){var t=localStorage.getItem(k);c.add('js');var d=t==='dark'||(t==='system'&&m.matches);c.toggle('dark',d);var mt=document.querySelector('meta[name="theme-color"]');if(!mt){mt=document.createElement('meta');mt.name='theme-color';document.head.appendChild(mt);}mt.setAttribute('content',d?'#23201d':'#ffffff');window.dispatchEvent(new Event('${THEME_CHANGE_EVENT}'));};apply();m.addEventListener('change',apply);window.addEventListener('storage',function(e){if(!e.key||e.key===k)apply();});window.__sundialApplyTheme=apply;}catch(e){}})();`;

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "light";
}

export function setThemePreference(pref: ThemePreference) {
  // "system" is stored explicitly — clearing the key means "default", which is
  // light. (Anyone who was implicitly on system before this change lands on
  // light and can pick system again.)
  window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  (window as { __sundialApplyTheme?: () => void }).__sundialApplyTheme?.();
}
