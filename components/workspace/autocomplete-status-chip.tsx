'use client';

import { useSyncExternalStore } from 'react';
import {
  getAutocompleteActivity,
  subscribeAutocompleteActivity,
} from '@/lib/workspace/autocomplete/status';

/**
 * The peripheral autocomplete indicator — bottom corner of the code editor,
 * never anything at the cursor (an animation at the caret pulls the eye
 * exactly when the writer is mid-thought, and advertises requests that often
 * legitimately produce nothing).
 *
 * Renders only when the pilot flag is on, and says only what the user cannot
 * otherwise tell: this file type has no autocomplete, or a completion is
 * being fetched right now. Idle in a supported file shows nothing.
 */
export function AutocompleteStatusChip({ supported }: { supported: boolean }) {
  const activity = useSyncExternalStore(
    subscribeAutocompleteActivity,
    getAutocompleteActivity,
    () => 'idle' as const,
  );

  if (supported && activity !== 'pending') return null;
  return (
    <div
      data-testid="autocomplete-status-chip"
      className="pointer-events-none absolute bottom-1.5 left-2 z-20 flex items-center gap-1.5 rounded-full bg-white/85 px-2 py-0.5 text-[10px] text-stone-400"
    >
      {supported ? (
        <>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange" aria-hidden />
          autocomplete
        </>
      ) : (
        'no autocomplete for this file type'
      )}
    </div>
  );
}
