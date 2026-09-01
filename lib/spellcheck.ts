// Editor spellcheck preference, persisted in localStorage like the other
// `sundial:*` UI prefs. Browsers check against the user's enabled dictionaries
// and ignore `<html lang>`, so a browser with no English language would paint
// the (English by default) document red: default off unless some `en*` is set.
const SPELLCHECK_STORAGE_KEY = 'sundial:spellcheck';

export function getSpellcheckPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(SPELLCHECK_STORAGE_KEY);
    if (stored === '1' || stored === '0') return stored === '1';
  } catch {
    // Storage blocked: fall through to the language default.
  }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => /^en\b/i.test(l ?? ''));
}

export function setSpellcheckPreference(enabled: boolean) {
  try {
    window.localStorage.setItem(SPELLCHECK_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Storage blocked: the DOM attribute still carries the toggle for this session.
  }
}
