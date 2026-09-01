'use client';

import { readJsonResponse } from '@/lib/http/read-json-response';
import { currentPathShareToken } from '@/lib/workspace/path-share-token-client';
import type { TurnEditsResponse } from '@/lib/workspace/turn-edits';

/**
 * Module-level cache for `/api/workspace/turn-edits` payloads, keyed by
 * `assistantMessageId`. Lets chat-side `TurnEditsCard` and file-side
 * `useFilePendingTurns` share the same Keep/Undo state — updating one place
 * propagates to the other via subscription.
 */

const cache = new Map<string, TurnEditsResponse>();
/** One request per id in flight; `inFlightSeq` orders forced refreshes. */
const inFlight = new Map<string, Promise<TurnEditsResponse | null>>();
const inFlightSeq = new Map<string, number>();
type Listener = (payload: TurnEditsResponse) => void;
const subscribers = new Map<string, Set<Listener>>();
type GlobalListener = (assistantMessageId: string, payload: TurnEditsResponse) => void;
const globalListeners = new Set<GlobalListener>();

export function getCachedTurnEdits(assistantMessageId: string): TurnEditsResponse | undefined {
  ensureScope();
  return cache.get(assistantMessageId);
}

export function setCachedTurnEdits(assistantMessageId: string, payload: TurnEditsResponse): void {
  // Establishes the scope on the first write (and drops stale payloads if the
  // link/workspace changed since the last touch) — then stores under it.
  ensureScope();
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

/**
 * Payloads are keyed by review id alone, and LOCAL (sidecar) ids are only
 * unique within their project — `applied-1` exists in every local workspace.
 * Binding the cache to the open workspace drops the payloads (never the live
 * subscriptions) when it changes, so a second local project can't be served
 * the first one's diff (Codex, PR #1104 round 20).
 */
let cacheWorkspaceId: string | null = null;
let cacheScope: string | null = null;

/** Workspace + the link token the payloads were fetched under. */
const currentScope = () => `${cacheWorkspaceId ?? ''}|${currentPathShareToken() ?? ''}`;

/**
 * Drop payloads whenever the scope changes. Checked on every READ, not just
 * when the host sets the workspace: opening a SECOND path-share link for the
 * same workspace in the same tab keeps the workspace id but swaps the sticky
 * `?pshare=` token, and the cached answers were fetched under the wider grant
 * — serving them would show diffs the new link doesn't cover (Codex, PR #1104
 * round 28).
 */
function ensureScope(): void {
  const scope = currentScope();
  if (scope === cacheScope) return;
  cacheScope = scope;
  cache.clear();
  inFlight.clear();
  inFlightSeq.clear();
}

export function setTurnEditsCacheWorkspace(workspaceId: string | null): void {
  cacheWorkspaceId = workspaceId;
  ensureScope();
}

/**
 * The scope a request is being made under — pass it back to
 * `setCachedTurnEditsForScope` so an answer authorized by an older share link
 * can't be cached under the current one.
 */
export function turnEditsCacheScope(): string {
  ensureScope();
  return cacheScope ?? '';
}

/** Cache a mutation's response ONLY if the scope it was authorized under is
 *  still current (Codex, PR #1104 round 30). */
export function setCachedTurnEditsForScope(
  scope: string,
  assistantMessageId: string,
  payload: TurnEditsResponse,
): void {
  if (currentScope() !== scope) return;
  setCachedTurnEdits(assistantMessageId, payload);
}

/**
 * Load a turn's diff, sharing one request per id.
 *
 * `force` follows a new-edits signal: a turn still streaming grows chunks, so
 * the cached copy — AND any request that started before the new rows landed —
 * would pin a surface to the diff as it stood. A forced load therefore starts
 * its own request, and a slower in-flight one can no longer write the cache
 * behind it (Codex, PR #1104 round 20).
 */
export function fetchTurnEdits(
  apiFetch: typeof fetch,
  assistantMessageId: string,
  opts?: { force?: boolean },
): Promise<TurnEditsResponse | null> {
  const force = opts?.force ?? false;
  ensureScope();
  const scope = cacheScope;
  if (!force) {
    const cached = cache.get(assistantMessageId);
    if (cached) return Promise.resolve(cached);
    const existing = inFlight.get(assistantMessageId);
    if (existing) return existing;
  }
  const seq = (inFlightSeq.get(assistantMessageId) ?? 0) + 1;
  inFlightSeq.set(assistantMessageId, seq);
  const request = (async () => {
    try {
      const res = await apiFetch(
        `/api/workspace/turn-edits?assistantMessageId=${encodeURIComponent(assistantMessageId)}`,
        { cache: 'no-store' },
      );
      const data = await readJsonResponse<TurnEditsResponse & { error?: string }>(res);
      if (!res.ok || !data) return null;
      // Authorized under a scope that has since changed: not cached AND not
      // delivered — the caller would render files the current link may not
      // cover (Codex, PR #1104 rounds 29 and 31). Compared against the LIVE
      // scope, since `cacheScope` lags until something calls ensureScope().
      if (currentScope() !== scope) return null;
      // Superseded by a newer request for the same turn: hand this answer back
      // to its own caller, but let the newer one own the cache.
      if (inFlightSeq.get(assistantMessageId) !== seq) return data;
      setCachedTurnEdits(assistantMessageId, data);
      return data;
    } catch {
      return null;
    } finally {
      if (inFlightSeq.get(assistantMessageId) === seq) inFlight.delete(assistantMessageId);
    }
  })();
  inFlight.set(assistantMessageId, request);
  return request;
}

export function clearTurnEditsCache(): void {
  cache.clear();
  inFlight.clear();
  inFlightSeq.clear();
  cacheWorkspaceId = null;
  cacheScope = null;
  subscribers.clear();
  globalListeners.clear();
}

