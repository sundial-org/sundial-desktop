// App theme (light / dark / system). The preference is per-device, stored in
// localStorage like the other `sundial:*` UI prefs; the resolved mode is a
// `dark` class on <html> that app/globals.css keys its palette remap off.
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "sundial:theme";

// Runs inline in <body> before first paint (next to the engine script) so a
// dark-mode load never flashes light. Also owns the live listeners: OS theme
// changes while on "system", cross-tab preference changes via `storage`.
// `apply` re-adds the `js` class too: React's root hydration rewrites <html>'s
// className (wiping both classes), so ThemeApplier re-runs apply right after
// hydration. Do NOT re-assert from a MutationObserver instead — mutating the
// class mid-hydration livelocks React's hydration pass (hard page hang).
export const THEME_INLINE_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var c=document.documentElement.classList;var m=window.matchMedia('(prefers-color-scheme: dark)');var apply=function(){var t=localStorage.getItem(k);c.add('js');c.toggle('dark',t==='dark'||(t!=='light'&&m.matches));};apply();m.addEventListener('change',apply);window.addEventListener('storage',function(e){if(!e.key||e.key===k)apply();});window.__sundialApplyTheme=apply;}catch(e){}})();`;

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function setThemePreference(pref: ThemePreference) {
  if (pref === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
  else window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  (window as { __sundialApplyTheme?: () => void }).__sundialApplyTheme?.();
}
