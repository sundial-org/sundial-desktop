'use client';

/**
 * `fetch` with a liveness bound, for short reads whose result gates UI state.
 *
 * Local (desktop) workspaces route every `/api/workspace/*` call to the
 * sidecar's single origin, where Chromium allows 6 HTTP/1.1 connections and
 * the workspace's `/events` SSE stream permanently holds one. A cold open
 * bursts far more than five requests at once, and once the pool is starved a
 * queued request gets no response, no error and no timeout — it simply never
 * settles. A hook that awaits one parks its UI forever (the "No TeX root" and
 * eternal "Loading…" LaTeX wedges).
 *
 * The deadline covers the response HEADERS only: the timer is cleared once the
 * Response resolves, so streaming a large body is never cut short. Not for
 * compiles — those are legitimately slow and must stay unbounded.
 */
/** Shared bound for short sidecar/API reads that gate UI state. */
export const READ_DEADLINE_MS = 12_000;

export async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error('request timed out'));
    }, ms);
  });
  const signal = init.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal;
  try {
    return await Promise.race([fetchImpl(input, { ...init, signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
