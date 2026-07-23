'use client';

import type { TurnEditsResponse } from '@/lib/workspace/turn-edits';

/**
 * Module-level cache for `/api/workspace/turn-edits` payloads, keyed by
 * `assistantMessageId`. Lets chat-side `TurnEditsCard` and file-side
 * `useFilePendingTurns` share the same Keep/Undo state — updating one place
 * propagates to the other via subscription.
 */

const cache = new Map<string, TurnEditsResponse>();
type Listener = (payload: TurnEditsResponse) => void;
const subscribers = new Map<string, Set<Listener>>();
type GlobalListener = (assistantMessageId: string, payload: TurnEditsResponse) => void;
const globalListeners = new Set<GlobalListener>();

export function getCachedTurnEdits(assistantMessageId: string): TurnEditsResponse | undefined {
  return cache.get(assistantMessageId);
}

export function setCachedTurnEdits(assistantMessageId: string, payload: TurnEditsResponse): void {
  cache.set(assistantMessageId, payload);
  const set = subscribers.get(assistantMessageId);
  if (set) {
    for (const cb of set) {
      try { cb(payload); } catch { /* swallow listener errors */ }
    }
  }
  for (const cb of globalListeners) {
    try { cb(assistantMessageId, payload); } catch { /* swallow listener errors */ }
  }
}

/** Fires on every cache write — used to hydrate file-side pending edits from chat. */
export function subscribeTurnEditsCache(listener: GlobalListener): () => void {
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
}

export function subscribeTurnEdits(
  assistantMessageId: string,
  listener: Listener,
): () => void {
  let set = subscribers.get(assistantMessageId);
  if (!set) {
    set = new Set();
    subscribers.set(assistantMessageId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) subscribers.delete(assistantMessageId);
  };
}

export function clearTurnEditsCache(): void {
  cache.clear();
  subscribers.clear();
  globalListeners.clear();
}

