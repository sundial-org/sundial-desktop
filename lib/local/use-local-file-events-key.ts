'use client';

import { useEffect, useState } from 'react';
import { sidecar, type SidecarConfig } from './sidecar';

/** Trailing debounce, matching the local lane's other SSE consumers: a burst of
 *  persists during typing collapses into one bump. */
export const LOCAL_FILE_EVENTS_DEBOUNCE_MS = 500;

/**
 * A counter that bumps when the sidecar reports a file change — the local
 * stand-in for the cloud's `doc_edits` Realtime channel.
 *
 * Fold it into `buildPendingEditsInvalidationToken` so per-file review data
 * (the suggestion gutter's author chips) refetches when a suggestion lands
 * from ANOTHER chat or an outside process. Those writes render their Y.Doc
 * marks instantly over CRDT, but nothing else on the page changes, so without
 * this the chips stay missing until the user switches files or refocuses.
 *
 * Returns 0 (and subscribes to nothing) for cloud workspaces.
 */
export function useLocalFileEventsKey(
  config: SidecarConfig | null,
  projectId: string | null,
): number {
  const [key, setKey] = useState(0);

  useEffect(() => {
    if (!config || !projectId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = sidecar.subscribe(config, projectId, (event) => {
      if (event.type !== 'files-changed') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setKey((current) => current + 1);
      }, LOCAL_FILE_EVENTS_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [config, projectId]);

  return key;
}
