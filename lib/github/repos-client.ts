'use client';

// Client-side cache for the user's GitHub repo list. The modal used to refetch
// (`cache: 'no-store'`) on every open — a ~1.8s wait each time. We cache the
// response briefly and let the trigger button prefetch on hover, so opening the
// modal is instant. The server route also caches; this just avoids the round
// trip entirely within the TTL.

export type RepoOption = {
  id: string;
  fullName: string;
  htmlUrl: string | null;
  defaultBranch: string | null;
  updatedAt: string | null;
  private: boolean | null;
};

export type RepositoriesResponse =
  | { connected: false; repositories: [] }
  | { connected: true; githubLogin: string; repositories: RepoOption[]; error?: string };

const FRESH_MS = 60_000;

// The cache is scoped to the signed-in user. A module-level cache in a
// long-lived SPA session would otherwise let one Sundial user briefly see the
// previous user's `connected` state + private repo names after an account
// switch — so a different `userId` (or sign-out → null) is always a miss.
let cached: { body: RepositoriesResponse; at: number; owner: string | null | undefined } | null = null;
let inflight: Promise<RepositoriesResponse> | null = null;
let owner: string | null | undefined = undefined;
// Bumped whenever a force/invalidate/owner-change supersedes work in flight, so
// a slow prefetch that resolves afterwards can't write its stale body back.
let generation = 0;

async function doFetch(
  gen: number,
  forUser: string | null | undefined,
  force: boolean,
): Promise<RepositoriesResponse> {
  // force also busts the server-side cache — needed after the user edits the
  // installation's repo selection on GitHub, which bumps nothing in our DB.
  const res = await fetch(`/api/user/github/repositories${force ? '?force=1' : ''}`, {
    cache: 'no-store',
    credentials: 'include',
  });
  const body = (await res.json().catch(() => null)) as RepositoriesResponse | { error?: string } | null;
  if (!res.ok) {
    throw new Error((body as { error?: string } | null)?.error ?? `Failed (${res.status})`);
  }
  // A 200 with an unparseable body is a transport glitch, not "disconnected" —
  // throw so we don't cache null and silently render the Connect screen.
  if (!body || typeof (body as RepositoriesResponse).connected !== 'boolean') {
    throw new Error('GitHub repositories response was malformed');
  }
  // Only commit if a force/invalidate/owner-change hasn't superseded us.
  if (gen === generation) cached = { body: body as RepositoriesResponse, at: Date.now(), owner: forUser };
  return body as RepositoriesResponse;
}

function load(userId: string | null | undefined, force: boolean): Promise<RepositoriesResponse> {
  // An owner change (account switch / sign-out) or forced refresh discards both
  // the cached body and any in-flight request belonging to the prior state.
  if (owner !== userId || force) {
    cached = null;
    inflight = null;
    generation += 1;
    owner = userId;
  }
  if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.body);
  if (inflight) return inflight;
  const gen = generation;
  const p = doFetch(gen, userId, force);
  inflight = p;
  // Clear on both settle paths; handling the rejection here keeps this
  // bookkeeping branch from surfacing as an unhandled rejection (the caller
  // still gets `p` and handles the error itself).
  const clear = () => {
    if (inflight === p) inflight = null;
  };
  void p.then(clear, clear);
  return p;
}

/** Cached repo list for `userId`, or null if nothing fresh (render the spinner). */
export function getCachedRepositories(userId: string | null | undefined): RepositoriesResponse | null {
  return cached && cached.owner === userId && Date.now() - cached.at < FRESH_MS ? cached.body : null;
}

export function fetchRepositories(
  userId: string | null | undefined,
  opts?: { force?: boolean },
): Promise<RepositoriesResponse> {
  return load(userId, opts?.force ?? false);
}

/** Fire-and-forget warm-up — safe to call on hover/focus of the trigger. */
export function prefetchRepositories(userId: string | null | undefined): void {
  void load(userId, false).catch(() => {});
}

/**
 * Drop the cached list. Call when the GitHub connection changes outside the
 * modal (Settings → connect/re-authorize/disconnect) so the next open fetches
 * fresh instead of serving a stale connected/disconnected state for the TTL.
 */
export function invalidateRepositoriesCache(): void {
  cached = null;
  // Also drop the in-flight request: bumping `generation` stops it writing to
  // `cached`, but a follow-up fetch for the same (unchanged) user would still
  // `return inflight` and render that pre-invalidation response. Detach it so
  // the next fetch starts fresh.
  inflight = null;
  generation += 1;
}

/** Test hook. */
export function __resetRepositoriesCache(): void {
  cached = null;
  inflight = null;
  owner = undefined;
  generation += 1;
}
