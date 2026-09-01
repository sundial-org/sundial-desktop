'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LatexRootReason } from '@/lib/workspace/latex-root';
import { fetchWithDeadline, READ_DEADLINE_MS } from '@/lib/workspace/fetch-deadline';

/** Retries for a resolver call that failed or never answered — a single bad
 *  answer must not leave `resolved` false forever. */
const RESOLVE_ATTEMPTS = 3;

export interface LatexMainDocumentState {
  /** Resolved compile target, or null when ambiguous/none. */
  root: string | null;
  reason: LatexRootReason;
  /** `.tex` files containing `\documentclass` — useful for diagnostics. */
  candidates: string[];
  /** True once the server resolver has answered at least once — the initial
   *  `none` state is "not resolved yet", not "the project has no root". */
  resolved: boolean;
  /** True when every resolve attempt failed — the toolbar must say so rather
   *  than sit silent with a dead Compile button. */
  unreachable: boolean;
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
  state: Pick<LatexMainDocumentState, 'root' | 'reason' | 'resolved'> & Partial<Pick<LatexMainDocumentState, 'candidates'>>,
  activeTexPath: string | null,
  /** A root the user is navigating diagnostics of — keeps winning while it is
   *  still a candidate (opening an included child must not re-target to an
   *  `ambiguous`/`nearest`-resolved other root mid-navigation). An explicit
   *  `% !TEX root` magic comment still outranks it. */
  pinnedRoot: string | null = null,
): string | null {
  // `none` names no candidates at all, and it is the very state whose
  // active-file fallback made `pinnedRoot` the compile root — without this the
  // click that opens a child would silently re-target the compile to that
  // child and compile the fragment standalone ("Missing \begin{document}").
  if (pinnedRoot && state.reason !== 'magic') {
    if (state.reason === 'none' || state.candidates?.includes(pinnedRoot)) return pinnedRoot;
  }
  if (state.root) return state.root;
  if (state.resolved && state.reason === 'none') return activeTexPath;
  return null;
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
  const [state, setState] = useState<LatexMainDocumentState>({
    root: null,
    reason: 'none',
    candidates: [],
    resolved: false,
    unreachable: false,
  });

  /** Resolves true when the state now holds a completed resolution — false
   *  means "ask again", never "this project has no root". `live` gates the
   *  post-await write: a slow answer for a previous activeFile must not
   *  clobber the current file's resolution. */
  const refetch = useCallback(async (live: () => boolean): Promise<boolean> => {
    if (!enabled || !projectId) return true;
    // A previous no-root answer is stale for the new file set / active file:
    // clear `resolved` so the compile-target fallback waits for this fetch
    // instead of pointing at whatever .tex just opened. The last-known `root`
    // stays in place, so rooted projects don't flicker while re-resolving.
    setState((s) => (s.resolved ? { ...s, resolved: false } : s));
    try {
      const params = new URLSearchParams({ projectId });
      if (activeFile) params.set('activeFile', activeFile);
      const res = await fetchWithDeadline(
        fetchImpl,
        `/api/workspace/latex-root?${params}`,
        { credentials: 'include' },
        READ_DEADLINE_MS,
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { root: string | null; reason: LatexRootReason; candidates: string[] };
      if (!live()) return true;
      setState({ root: data.root ?? null, reason: data.reason, candidates: data.candidates ?? [], resolved: true, unreachable: false });
      return true;
    } catch {
      // Leave the last good resolution in place; compile can continue using it.
      return false;
    }
  }, [enabled, projectId, activeFile, fetchImpl]);

  // Refetch when the project's .tex set or the active file changes, retrying a
  // failed/timed-out resolver call with backoff — a cold open is exactly when
  // the sidecar is slowest, and that must not be a permanent "no root".
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (n: number) => {
      const resolved = await refetch(() => !cancelled);
      if (resolved || cancelled) return;
      if (n + 1 >= RESOLVE_ATTEMPTS) {
        setState((s) => ({ ...s, unreachable: true }));
        return;
      }
      retry = setTimeout(() => void attempt(n + 1), 1_000 * 2 ** n);
    };
    void attempt(0);
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
    // texFileSignature drives refetch indirectly; the rest are refetch's deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectId, activeFile, texFileSignature, fetchImpl]);

  return state;
}
