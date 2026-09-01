/**
 * A tiny pub/sub for the autocomplete working state, so the editor can show a
 * peripheral status chip (never anything at the cursor — see the chip
 * component for the UX reasoning). The Monaco provider is the only writer.
 *
 * Keystroke-path discipline: `set` notifies ONLY on a value change, so plain
 * typing (which keeps the status at 'pending' or 'idle') causes zero React
 * work; subscribers re-render on transitions, a couple of times per request.
 */

export type AutocompleteActivity = 'idle' | 'pending';

let current: AutocompleteActivity = 'idle';
const listeners = new Set<() => void>();

export function getAutocompleteActivity(): AutocompleteActivity {
  return current;
}

export function setAutocompleteActivity(next: AutocompleteActivity): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeAutocompleteActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only. */
export function __resetAutocompleteActivityForTest(): void {
  current = 'idle';
  listeners.clear();
}
