'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompileErrorState, LatexErrorLine, LocalEditTracker } from '@/components/workspace/use-latex-compile';
import { isAutoFixableFailure } from '@/lib/latex/autofix-guard';

/**
 * The per-user "auto-fix on failed compile" preference (§1.11): persisted in
 * localStorage and shared by the toolbar's overflow menu (the toggle) and the
 * page (the auto-launch). Lifted out of CompileSummaryBar so the bar can stay
 * absent on a clean compile without taking the auto-fire loop down with it.
 *
 * Also owns two follow-ons of that preference: a brief attention pulse on the
 * Fix button when a new failure lands, and the one-time offer to enable
 * auto-fix after a requested fix turn resolves the compile (red to green),
 * surfaced by CompileSummaryBar.
 */

const AUTOFIX_STORAGE_KEY = 'sundial:latex-autofix';
const AUTOFIX_SUGGESTED_KEY = 'sundial:latex-autofix-suggested';
const AUTOCOMPILE_STORAGE_KEY = 'sundial:latex-autocompile';

/** How long the Fix button's attention pulse runs (2 iterations of the 1.1s keyframe plus slack). */
export const FIX_ATTENTION_MS = 2400;

/** An auto-compile failure only auto-fixes once the user has stopped writing
 *  for this long — a fix turn landing mid-thought is exactly the invasiveness
 *  that kept auto-fix off during auto compiles. User-asked compiles skip it. */
export const AUTOFIX_AUTO_IDLE_MS = 5000;

function persistAutoFix(next: boolean) {
  try {
    localStorage.setItem(AUTOFIX_STORAGE_KEY, next ? '1' : '0');
  } catch {
    // localStorage unavailable (SSR/private mode): preference won't persist.
  }
}

/** Auto compile is ON unless the user turned it off ('0'). */
export function readAutoCompilePreference(): boolean {
  try {
    return localStorage.getItem(AUTOCOMPILE_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/** The per-user "auto compile on edit" preference (§1.2) — same persistence
 *  and cross-tab pattern as auto-fix. Seeded off for SSR hydration, then reads
 *  the stored value (default ON) on mount. */
export function useLatexAutoCompilePref() {
  const [autoCompile, setAutoCompile] = useState(false);
  useEffect(() => {
    setAutoCompile(readAutoCompilePreference());
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTOCOMPILE_STORAGE_KEY) setAutoCompile(event.newValue !== '0');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const toggleAutoCompile = useCallback(() => {
    setAutoCompile((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(AUTOCOMPILE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Preference won't persist; the in-memory flip still applies.
      }
      return next;
    });
  }, []);
  return { autoCompile, toggleAutoCompile };
}

export function useLatexAutoFix({
  compileError,
  errorLines,
  compiling,
  canFix,
  onFix,
  texPath = null,
  fixBusy = false,
  localEdits,
}: {
  compileError: CompileErrorState | null;
  errorLines: LatexErrorLine[];
  compiling: boolean;
  canFix: boolean;
  onFix?: () => void;
  /** Compile target; outcomes of a different document never resolve a requested fix. */
  texPath?: string | null;
  /** True while a fix run is live; failed compiles during the run don't disarm the offer. */
  fixBusy?: boolean;
  /** The tab's local-typing tracker (same object use-latex-compile reads).
   *  Gates auto-fix on 'auto' failures: fire only once the user has been idle
   *  and the failing text is still the current text. */
  localEdits?: LocalEditTracker;
}) {
  const [autoFix, setAutoFix] = useState(false);

  useEffect(() => {
    try {
      setAutoFix(localStorage.getItem(AUTOFIX_STORAGE_KEY) === '1');
    } catch {
      // localStorage unavailable (SSR/private mode): default off.
    }
    // Cross-tab sync: enabling auto-fix in one tab (the offer card, the ⋯
    // toggle) must reach tabs already mounted, or the tab the user actually
    // recompiles in silently ignores the just-enabled preference.
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTOFIX_STORAGE_KEY) setAutoFix(event.newValue === '1');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleAutoFix = useCallback(() => {
    setAutoFix((prev) => {
      const next = !prev;
      persistAutoFix(next);
      return next;
    });
  }, []);

  // One key per *parsed* failure (stable line:text), shared by the auto-fire
  // and the attention pulse so the two can never disagree about what counts
  // as "the same error". Not the raw log tail: tectonic dumps embed absolute
  // paths/timestamps that shift between otherwise identical failures and
  // would otherwise re-fire a turn on every recompile.
  const errorSignature = errorLines.map((e) => `${e.line}:${e.text}`).join('|');
  const failureKey = compileError ? errorSignature || compileError.message : null;

  // Auto-launch a Fix once per *new* failure when the toggle is on (§1.11).
  // A successful compile (no error) clears the key so the next failure can fire.
  // Auto-compile failures fire quietly: never on infra/missing-file errors,
  // never while the user is still writing (idle gate, re-checked when the
  // window elapses), and never once the failing text has been typed over —
  // the next auto compile owns that; the key stays unburned so the SAME error
  // surviving the recompile can still fire then. A tracker that never saw an
  // edit (lastEditAt 0, e.g. a mount-time compile of a broken document) is
  // maximally idle, so the fix the toggle promises still fires right away.
  const localEditsRef = useRef(localEdits);
  localEditsRef.current = localEdits;
  const firedForRef = useRef<string | null>(null);
  const [idleRetryTick, setIdleRetryTick] = useState(0);
  useEffect(() => {
    if (!failureKey) {
      firedForRef.current = null;
      return;
    }
    if (!autoFix || !canFix || compiling || !onFix) return;
    if (firedForRef.current === failureKey) return;
    if (!isAutoFixableFailure(compileError, errorLines)) return;
    const tracker = localEditsRef.current;
    if (compileError?.trigger === 'auto' && tracker) {
      if (
        compileError.localEditsAtStart !== undefined &&
        tracker.version !== compileError.localEditsAtStart
      ) {
        return;
      }
      const idle = Date.now() - tracker.lastEditAt;
      if (idle < AUTOFIX_AUTO_IDLE_MS) {
        const timer = setTimeout(() => setIdleRetryTick((t) => t + 1), AUTOFIX_AUTO_IDLE_MS - idle);
        return () => clearTimeout(timer);
      }
    }
    firedForRef.current = failureKey;
    onFix();
  }, [failureKey, autoFix, canFix, compiling, onFix, compileError, errorLines, idleRetryTick]);

  // Attention pulse: a NEW failure briefly animates the Fix button so the
  // affordance is noticed. Skipped when auto-fix is on (the busy spinner is
  // about to replace the button). Compiles pass through a transient errorless
  // state on start (use-latex-compile clears the error before fetching), so
  // the seen-key ref only resets on a settled green: a persistent failure
  // never re-pulses on every recompile. Every path either holds a live timer
  // or sets the state false, so the pulse can't strand on.
  const [fixAttention, setFixAttention] = useState(false);
  const attentionForRef = useRef<string | null>(null);
  const attentionUntilRef = useRef(0);
  useEffect(() => {
    if (!failureKey) {
      if (!compiling) attentionForRef.current = null;
      attentionUntilRef.current = 0;
      setFixAttention(false);
      return;
    }
    if (autoFix || !canFix) {
      // Mark the key as seen: flipping the toggle or a busy Fix run ending
      // later must not replay the pulse for an error the user is staring at.
      attentionForRef.current = failureKey;
      attentionUntilRef.current = 0;
      setFixAttention(false);
      return;
    }
    if (attentionForRef.current !== failureKey) {
      attentionForRef.current = failureKey;
      attentionUntilRef.current = Date.now() + FIX_ATTENTION_MS;
      setFixAttention(true);
    }
    const remaining = attentionUntilRef.current - Date.now();
    if (remaining <= 0) {
      setFixAttention(false);
      return;
    }
    const timer = setTimeout(() => setFixAttention(false), remaining);
    return () => clearTimeout(timer);
  }, [failureKey, autoFix, canFix, compiling]);

  // One-time upsell: the first time a *requested* fix turn resolves the
  // compile (red to green, same document), offer to flip auto-fix on.
  // Resolution mirrors use-latex-analytics: a compile finishing clean, or
  // the error clearing while idle (an agent compile landing via the realtime
  // PDF refresh). The transient errorless state at compile start resolves
  // nothing; a compile finishing red after the fix run ended, or the run
  // going idle with the error still standing, disarms the offer (later
  // greens belong to the user); a document switch disarms it entirely. The one-shot flag is only burned when the user answers the
  // strip, so an offer that never rendered can come back.
  const [suggestAutoFix, setSuggestAutoFix] = useState(false);
  const fixRequestedRef = useRef(false);
  const suggestedThisSessionRef = useRef(false);
  const noteFixRequested = useCallback(() => {
    fixRequestedRef.current = true;
  }, []);
  const prevCompileRef = useRef({ compiling, compileError, texPath, fixBusy });
  useEffect(() => {
    const prev = prevCompileRef.current;
    prevCompileRef.current = { compiling, compileError, texPath, fixBusy };
    if (prev.texPath !== texPath) {
      fixRequestedRef.current = false;
      return;
    }
    const finished = prev.compiling && !compiling;
    if (compileError) {
      // Disarm on a compile finishing red after the run, or on the run going
      // idle with the error still standing and no compile in flight: either
      // way the fix didn't land, so later greens belong to the user.
      if (!fixBusy && !compiling && (finished || prev.fixBusy)) fixRequestedRef.current = false;
      return;
    }
    const cleared = Boolean(prev.compileError);
    if (!(finished || (cleared && !compiling))) return;
    if (!fixRequestedRef.current) return;
    fixRequestedRef.current = false;
    if (autoFix || suggestedThisSessionRef.current) return;
    try {
      if (localStorage.getItem(AUTOFIX_SUGGESTED_KEY) === '1') return;
    } catch {
      // Unreadable flag: fall through and offer; the session ref caps repeats.
    }
    suggestedThisSessionRef.current = true;
    setSuggestAutoFix(true);
  }, [compiling, compileError, texPath, autoFix, fixBusy]);

  // Answer the offer (accept or decline). Either answer burns the one-shot:
  // the user saw it and spoke.
  const resolveAutoFixSuggestion = useCallback((accepted: boolean) => {
    setSuggestAutoFix(false);
    try {
      localStorage.setItem(AUTOFIX_SUGGESTED_KEY, '1');
    } catch {
      // The session ref above already keeps this browser session quiet.
    }
    if (accepted) {
      setAutoFix(true);
      persistAutoFix(true);
    }
  }, []);

  return {
    autoFix,
    toggleAutoFix,
    fixAttention,
    suggestAutoFix,
    resolveAutoFixSuggestion,
    noteFixRequested,
  };
}
