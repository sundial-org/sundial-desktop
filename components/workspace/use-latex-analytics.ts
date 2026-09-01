'use client';

import { useCallback, useEffect, useRef } from 'react';
import { track } from '@/lib/analytics/track';
import { latexEmitter, latexErrorKind, type LatexErrorKind } from '@/lib/analytics/latex-events';
import type { CompileErrorState } from '@/components/workspace/use-latex-compile';

const emit = latexEmitter(track);
const emitBeacon = latexEmitter((event, props) => track(event, props, { transport: 'sendBeacon' }));

/**
 * Client-side LaTeX retention events (lib/analytics/latex-events.ts): workspace
 * opened, the Fix-with-Agent funnel, and compile-abandon on page leave.
 * Observes the compile controller's state transitions; the page only reports
 * fix clicks through the returned callback. Every emit is best-effort.
 */
export function useLatexAnalytics({
  projectId,
  texPath,
  texFileCount,
  workspaceCreatedAt,
  compileError,
  compiling,
  canFix,
  autoFix,
  autoFixSuggested = false,
}: {
  projectId: string;
  /** Compile target; a switch resets the per-document fix funnel. */
  texPath: string | null;
  texFileCount: number;
  workspaceCreatedAt: string | null;
  compileError: CompileErrorState | null;
  compiling: boolean;
  canFix: boolean;
  autoFix: boolean;
  /** The one-time "enable auto-fix?" offer is showing (use-latex-autofix.ts). */
  autoFixSuggested?: boolean;
}) {
  // Mutable session bookkeeping; only touched inside effects/callbacks.
  const state = useRef({
    projectId: '',
    texPath: null as string | null,
    failures: 0,
    attempts: 0,
    failing: false,
    errorKind: 'other' as LatexErrorKind,
    auto: false,
    prevCompiling: false,
    prevError: null as CompileErrorState | null,
    observedError: null as CompileErrorState | null,
  });
  const abandonProps = () => {
    const s = state.current;
    return s.failing && s.attempts === 0
      ? { projectId: s.projectId, error_kind: s.errorKind, failures_in_session: s.failures }
      : null;
  };

  // Workspace opened (>= 1 .tex): once per workspace per mount. Tags the person
  // so retention insights can filter on `latex_user`.
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || texFileCount === 0 || openedRef.current === projectId) return;
    openedRef.current = projectId;
    const created = workspaceCreatedAt ? Date.parse(workspaceCreatedAt) : NaN;
    emit('latex_workspace_opened', {
      projectId,
      tex_file_count: texFileCount,
      days_since_workspace_created: Number.isFinite(created)
        ? Math.max(0, Math.floor((Date.now() - created) / 86_400_000))
        : null,
      $set: { latex_user: true },
      $set_once: { first_latex_workspace_opened_at: new Date().toISOString() },
    });
  }, [projectId, texFileCount, workspaceCreatedAt]);

  // Compile-abandon: leaving the page with a red compile nobody asked to fix.
  useEffect(() => {
    const s = state.current;
    s.projectId = projectId;
    const onPageHide = () => {
      const props = abandonProps();
      if (props) emitBeacon('latex_session_ended_with_failing_compile', props);
      s.failing = false; // never double-count with the unmount path below
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      const props = abandonProps();
      if (props) emit('latex_session_ended_with_failing_compile', props);
      Object.assign(s, { failures: 0, attempts: 0, failing: false, texPath: null });
    };
  }, [projectId]);

  // Record one failed compile outcome (count + kind + `latex_fix_offered`),
  // once per CompileErrorState instance. Called from the transition effect
  // AND from onFixClicked: with auto-fix on, useLatexAutoFix's effect runs
  // before this hook's, so the click must be able to observe (and emit the
  // offer for) a failure the effect has not seen yet — offered stays ahead
  // of clicked in the funnel either way.
  const observeFailure = useCallback((err: CompileErrorState) => {
    const s = state.current;
    if (s.observedError === err) return;
    s.observedError = err;
    s.failures += 1;
    s.failing = true;
    s.errorKind = latexErrorKind({ log: err.details, error: err.message });
    if (canFix) {
      emit('latex_fix_offered', {
        projectId,
        error_kind: s.errorKind,
        failures_in_session: s.failures,
        auto: autoFix,
      });
    }
  }, [projectId, canFix, autoFix]);

  // Compile outcome transitions → fix funnel.
  useEffect(() => {
    const s = state.current;
    if (s.texPath !== texPath) {
      // New compile target: the fix funnel is per document; failures stay per session.
      Object.assign(s, { texPath, attempts: 0, failing: false, prevError: compileError, prevCompiling: compiling });
      return;
    }
    const finished = s.prevCompiling && !compiling;
    const cleared = s.prevError && !compileError;
    s.prevCompiling = compiling;
    s.prevError = compileError;
    if (finished && compileError) {
      observeFailure(compileError);
      return;
    }
    // Green again: either our own compile finished clean, or a background
    // (agent) compile cleared the error via the realtime PDF refresh.
    if ((finished && !compileError) || (cleared && !compiling)) {
      if (s.attempts > 0) emit('latex_fix_resolved', { projectId, attempts: s.attempts, auto: s.auto });
      s.attempts = 0;
      s.failing = false;
    }
  }, [projectId, texPath, compileError, compiling, observeFailure]);

  // Clicked = raw intent, emitted immediately (a click whose send later fails
  // is still a click). Started = the fix run was actually accepted; only THAT
  // commits a resolution-eligible attempt, so a manual edit going green after
  // a failed send cannot emit a false latex_fix_resolved.
  const onFixClicked = useCallback(
    (auto: boolean) => {
      const s = state.current;
      if (compileError) observeFailure(compileError); // offered precedes clicked
      emit('latex_fix_clicked', { projectId, error_kind: s.errorKind, attempts: s.attempts + 1, auto });
    },
    [projectId, compileError, observeFailure],
  );
  const onFixStarted = useCallback((auto: boolean) => {
    const s = state.current;
    s.attempts += 1;
    s.auto = auto;
  }, []);

  // The auto-fix offer funnel: suggested on the offer's rising edge (the
  // effect only re-runs when the flag changes), then the outcome callback
  // from the strip's buttons.
  useEffect(() => {
    if (autoFixSuggested) emit('latex_autofix_suggested', { projectId });
  }, [autoFixSuggested, projectId]);
  const onAutoFixSuggestionOutcome = useCallback(
    (accepted: boolean) => {
      emit(
        accepted ? 'latex_autofix_suggestion_accepted' : 'latex_autofix_suggestion_dismissed',
        { projectId },
      );
    },
    [projectId],
  );
  return { onFixClicked, onFixStarted, onAutoFixSuggestionOutcome };
}
