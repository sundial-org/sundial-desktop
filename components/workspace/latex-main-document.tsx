'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LatexRootReason } from '@/lib/workspace/latex-root';

export interface LatexMainDocumentState {
  /** Resolved compile target, or null when ambiguous/none. */
  root: string | null;
  reason: LatexRootReason;
  /** `.tex` files containing `\documentclass` — useful for diagnostics. */
  candidates: string[];
  loading: boolean;
  /** True once the server resolver has answered at least once — the initial
   *  `none` state is "not resolved yet", not "the project has no root". */
  resolved: boolean;
}

/**
 * Compile target for the toolbar: the resolved root, else the open `.tex` when
 * the project has no `\documentclass` anywhere (`reason: 'none'`). The resolver
 * only sees persisted content, so a freshly created file being typed into has
 * no root yet — and with zero candidates there is nothing to disambiguate, so
 * compiling the open file (with its live editor source) is the only sensible
 * target. The fallback waits for a completed resolution (`resolved`) so a
 * fragment never transiently becomes the target while the fetch is in flight;
 * `ambiguous` stays blocked (spec §3.2).
 */
export function latexCompileTarget(
  state: Pick<LatexMainDocumentState, 'root' | 'reason' | 'resolved'>,
  activeTexPath: string | null,
): string | null {
  return state.root ?? (state.resolved && state.reason === 'none' ? activeTexPath : null);
}

/**
 * Owns main-document resolution for compile. Fetches the server-side resolver
 * (the only place file bodies live) when the project's `.tex` set or active
 * file changes. The result is intentionally not exposed as a selector in the
 * toolbar; most projects auto-resolve and ambiguous projects should explain
 * the compile block only when it matters.
 */
export function useLatexMainDocument(args: {
  projectId: string;
  activeFile: string | null;
  /** Signature of the project's `.tex` paths — refetch when files add/remove/rename. */
  texFileSignature: string;
  /** Whether this surface is a LaTeX document at all (keeps the hook inert otherwise). */
  enabled: boolean;
  /** The page's data plane — swapped for local (sidecar-backed) projects. */
  fetchImpl?: typeof fetch;
}): LatexMainDocumentState {
  const { projectId, activeFile, texFileSignature, enabled, fetchImpl = fetch } = args;
  const [state, setState] = useState<Omit<LatexMainDocumentState, 'loading'>>({
    root: null,
    reason: 'none',
    candidates: [],
    resolved: false,
  });
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!enabled || !projectId) return;
    setLoading(true);
    // A previous no-root answer is stale for the new file set / active file:
    // clear `resolved` so the compile-target fallback waits for this fetch
    // instead of pointing at whatever .tex just opened. The last-known `root`
    // stays in place, so rooted projects don't flicker while re-resolving.
    setState((s) => (s.resolved ? { ...s, resolved: false } : s));
    try {
      const params = new URLSearchParams({ projectId });
      if (activeFile) params.set('activeFile', activeFile);
      const res = await fetchImpl(`/api/workspace/latex-root?${params}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { root: string | null; reason: LatexRootReason; candidates: string[] };
      setState({ root: data.root ?? null, reason: data.reason, candidates: data.candidates ?? [], resolved: true });
    } catch {
      // Leave the last good resolution in place; compile can continue using it.
    } finally {
      setLoading(false);
    }
  }, [enabled, projectId, activeFile, fetchImpl]);

  // Refetch when the project's .tex set or the active file changes.
  useEffect(() => {
    void refetch();
    // texFileSignature/activeFile drive refetch; refetch closes over both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectId, activeFile, texFileSignature]);

  return { ...state, loading };
}
