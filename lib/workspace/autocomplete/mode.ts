/**
 * The autocomplete behavior mode — 'ai' (model ghost text, uses credits) or
 * 'deterministic' (document-term + syntax completion, free and instant).
 *
 * Account-backed (`user_preferences.autocomplete_mode`) with the same
 * client-mirror pattern as the flag store: synchronous reads for the Monaco
 * provider, localStorage cache, hydrated from the preferences fetch. The
 * Settings → Advanced tabs are the only writer that persists.
 */

export const AUTOCOMPLETE_MODES = ['ai', 'deterministic'] as const;
export type AutocompleteMode = (typeof AUTOCOMPLETE_MODES)[number];
export const DEFAULT_AUTOCOMPLETE_MODE: AutocompleteMode = 'ai';

const STORAGE_KEY = 'sundial:autocomplete-mode';

let cache: AutocompleteMode | null = null;

export function isAutocompleteMode(value: unknown): value is AutocompleteMode {
  return typeof value === 'string' && (AUTOCOMPLETE_MODES as readonly string[]).includes(value);
}

export function getAutocompleteMode(): AutocompleteMode {
  if (cache !== null) return cache;
  let stored: string | null = null;
  if (typeof window !== 'undefined') {
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage disabled */
    }
  }
  cache = isAutocompleteMode(stored) ? stored : DEFAULT_AUTOCOMPLETE_MODE;
  return cache;
}

export function setAutocompleteMode(mode: AutocompleteMode): void {
  cache = mode;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* private mode — the in-memory value still holds. */
  }
}

/** Test-only: reset module state between cases. */
export function __resetAutocompleteModeForTest(): void {
  cache = null;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled */
  }
}
