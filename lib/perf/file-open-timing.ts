'use client';

/** Monotonic, allocation-light timing for the document-open critical path. */
export interface FileOpenTiming {
  fileId: string;
  startedAtMs: number;
  navigationStartMs: number | null;
  navigationCandidate: boolean;
  markSuffix: number;
  visible: boolean;
  synced: boolean;
}

export interface FileOpenMeasurement {
  elapsedMs: number;
  openKind: 'navigation' | 'file_switch';
  navigationElapsedMs?: number;
}

type BrowserPerformance = Pick<Performance, 'now' | 'getEntriesByType'> &
  Partial<Pick<Performance, 'mark' | 'measure' | 'clearMarks' | 'clearMeasures'>>;

let navigationOpenClaimed = false;
let timingSequence = 0;

function browserPerformance(): BrowserPerformance | null {
  return typeof performance === 'undefined' ? null : performance;
}

function roundedMs(value: number) {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function navigationStart(perf: BrowserPerformance | null): number | null {
  const entry = perf?.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return entry && Number.isFinite(entry.startTime) ? entry.startTime : null;
}

function mark(perf: BrowserPerformance | null, name: string) {
  try {
    perf?.clearMarks?.(name);
    perf?.mark?.(name);
  } catch {
    // User Timing is diagnostic only and must never affect opening a file.
  }
}

export function startFileOpen(
  fileId: string,
  perf = browserPerformance(),
  eligibleForNavigation = true,
): FileOpenTiming {
  const startedAtMs = perf?.now() ?? Date.now();
  const markSuffix = ++timingSequence;
  const navigationCandidate = eligibleForNavigation && !navigationOpenClaimed;
  if (navigationCandidate) navigationOpenClaimed = true;
  mark(perf, `sundial:file-open:start:${markSuffix}`);
  return {
    fileId,
    startedAtMs,
    navigationStartMs: navigationStart(perf),
    navigationCandidate,
    markSuffix,
    visible: false,
    synced: false,
  };
}

function measurePhase(
  timing: FileOpenTiming,
  phase: 'visible' | 'sync',
  perf: BrowserPerformance | null,
): FileOpenMeasurement {
  const now = perf?.now() ?? Date.now();
  const markName = `sundial:file-open:${phase}:${timing.markSuffix}`;
  mark(perf, markName);
  try {
    const measureName = `sundial:file-open:start-to-${phase}`;
    perf?.clearMeasures?.(measureName);
    perf?.measure?.(measureName, `sundial:file-open:start:${timing.markSuffix}`, markName);
  } catch {
    // Older browsers can reject measures when a mark was evicted.
  }

  const isNavigation = timing.navigationCandidate;
  const result: FileOpenMeasurement = {
    elapsedMs: roundedMs(now - timing.startedAtMs),
    openKind: isNavigation ? 'navigation' : 'file_switch',
  };
  if (isNavigation && timing.navigationStartMs !== null) {
    result.navigationElapsedMs = roundedMs(now - timing.navigationStartMs);
  }
  return result;
}

/** Call after the editor DOM has painted, and only for a non-hidden pane. */
export function finishFileVisible(
  timing: FileOpenTiming,
  perf = browserPerformance(),
): FileOpenMeasurement | null {
  if (timing.visible) return null;
  timing.visible = true;
  const result = measurePhase(timing, 'visible', perf);
  return result;
}

/** Call on the first provider-confirmed sync for this file incarnation. */
export function finishFileSync(
  timing: FileOpenTiming,
  perf = browserPerformance(),
): FileOpenMeasurement | null {
  if (timing.synced) return null;
  timing.synced = true;
  return measurePhase(timing, 'sync', perf);
}

/** Two frames ensure React's committed editor DOM has reached a paint. */
export function afterNextPaint(callback: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(callback);
  });
  return () => {
    cancelAnimationFrame(first);
    if (second) cancelAnimationFrame(second);
  };
}

/** Test-only reset: each browser navigation naturally gets a fresh JS realm. */
export function resetFileOpenNavigationForTest() {
  navigationOpenClaimed = false;
  timingSequence = 0;
}
