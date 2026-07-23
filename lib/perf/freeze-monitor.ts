'use client';

// Client-side freeze detector.
//
// The "editor/chat freezes during a long single-file session" bug is a pure
// MAIN-THREAD STALL: work that scales with accumulated session state (doc size,
// pending suggestions, transcript length) runs synchronously on every keystroke
// or streaming token. It produces ZERO server-side signal — Fly/Axiom logs are
// the backend, so until now a freeze was invisible to us and only surfaced when
// a user complained.
//
// This installs a `longtask` PerformanceObserver (the standard >50ms main-thread
// block) and, when a stall crosses a user-perceptible threshold, emits a single
// throttled `client_main_thread_stall` PostHog event stamped with the context
// that tells the three hypotheses apart: how big is the doc, how many pending
// suggestions, how long is the transcript. Triage in PostHog by those fields.
//
// Telemetry only: no behavior change, all errors swallowed, no-op without a
// PostHog key or `longtask` support.

import { track } from '@/lib/analytics/track';

export type FreezeContext = {
  route?: string | null;
  fileId?: string | null;
  fileType?: string | null;
  docChars?: number | null;
  docLines?: number | null;
  pendingSuggestions?: number | null;
  chatMessages?: number | null;
};

// A user-perceptible freeze. A dropped frame is ~16ms; 200ms is a clear hitch
// and well above ambient long tasks (route transitions, GC) we don't care about.
export const STALL_THRESHOLD_MS = 200;
// At most one event per window so a sustained freeze (many back-to-back long
// tasks) reports once, not hundreds of times.
export const EMIT_THROTTLE_MS = 5000;

let context: FreezeContext = {};

/** Merge cheap, already-computed metrics from the active surface. Call from the
 *  editor / transcript hot path — it's a shallow merge, never a doc walk. */
export function setFreezeContext(partial: FreezeContext): void {
  context = { ...context, ...partial };
}

/** Map a path to a coarse file_type for triage (markdown vs latex vs code). */
export function fileTypeFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'tex' || ext === 'latex' || ext === 'bib') return 'latex';
  if (ext === 'ipynb') return 'notebook';
  return ext ? `code:${ext}` : 'code';
}

/** Pure payload builder — unit-tested without a real PerformanceObserver. */
export function buildStallProps(stallMs: number, ctx: FreezeContext = context): Record<string, unknown> {
  return {
    stall_ms: Math.round(stallMs),
    route: ctx.route ?? (typeof location !== 'undefined' ? location.pathname : null),
    file_id: ctx.fileId ?? null,
    file_type: ctx.fileType ?? null,
    doc_chars: ctx.docChars ?? null,
    doc_lines: ctx.docLines ?? null,
    pending_suggestions: ctx.pendingSuggestions ?? null,
    chat_messages: ctx.chatMessages ?? null,
  };
}

let lastEmitAt = -Infinity;
/** Pure threshold + throttle decision — unit-tested directly. Records the emit
 *  time as a side effect when it returns true. */
export function shouldEmitStall(stallMs: number, now: number): boolean {
  if (stallMs < STALL_THRESHOLD_MS) return false;
  if (now - lastEmitAt < EMIT_THROTTLE_MS) return false;
  lastEmitAt = now;
  return true;
}

let observer: PerformanceObserver | null = null;

/** Install the longtask observer once. Idempotent; safe to call on every mount. */
export function startFreezeMonitor(): void {
  if (observer || typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
  try {
    observer = new PerformanceObserver((list) => {
      let worst = 0;
      for (const entry of list.getEntries()) if (entry.duration > worst) worst = entry.duration;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!shouldEmitStall(worst, now)) return;
      track('client_main_thread_stall', buildStallProps(worst));
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    observer = null;
  }
}

export function stopFreezeMonitor(): void {
  observer?.disconnect();
  observer = null;
}

/** Test-only reset of the throttle clock. */
export function __resetFreezeMonitorForTest(): void {
  lastEmitAt = -Infinity;
  context = {};
}
