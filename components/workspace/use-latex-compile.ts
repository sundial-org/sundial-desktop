'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase/browser';
import { fetchWithDeadline, READ_DEADLINE_MS } from '@/lib/workspace/fetch-deadline';
import { usePathShareRealtimeAuthReady } from '@/lib/workspace/use-path-share-realtime-ready';
import type { CompileFailureKind, CompileTrigger } from '@/lib/latex/compile-contract';
import { latexSettleHold } from '@/lib/latex/autocompile-settle';
import { parseLatexLog, type CollapsedLatexLogItem } from '@/lib/workspace/latex-log-parser';
import { posthogDistinctId } from '@/lib/analytics/track';

// Compile lifecycle for a LaTeX document, lifted out of LatexPdfPane so the
// toolbar (which lives in the document chrome, a separate DOM subtree) and the
// preview pane can share one compile state + trigger. The logic here is moved
// near-verbatim from the old pane: auto-compile-on-404, source-arrival retry,
// realtime PDF refresh, cross-remount cache, and tectonic error parsing all
// behave as before — this change is placement, not compile semantics.

type CompileResult = {
  ok?: boolean;
  error?: string;
  log?: string;
  stdout?: string;
  stderr?: string;
  pdfBase64?: string;
  /** Immutable delivery URL for a pool-stored PDF. PDF.js reads this by range. */
  pdfUrl?: string;
  /** blob_sha of a pool-stored PDF. */
  pdfSha?: string;
  pdfPath?: string;
  // W1.trigger contract echo (consumed by later waves' failure routing).
  trigger?: CompileTrigger;
  sourceVersion?: number | null;
  failureKind?: CompileFailureKind;
};

export type CompileErrorState = {
  message: string;
  details: string;
  /** What kicked the failing compile — 'auto' failures get the quiet autofix
   *  gating (idle + unchanged source); user-asked ones may fix immediately. */
  trigger?: CompileTrigger;
  /** Route's failure classification; 'infra' never launches a fix turn (IC5).
   *  Null when the route predates the field or the failure was client-side. */
  failureKind?: CompileFailureKind | null;
  /** localEditVersion when the failing compile started. Auto-fix only fires
   *  while it still matches — typing since means a newer compile owns it. */
  localEditsAtStart?: number;
};

export type LatexErrorLine = {
  line: number;
  text: string;
  /** Resolved workspace path, or null when the log's file isn't in the project (row not navigable). */
  file: string | null;
  /** Short label shown beside the line when the error is outside the compiled root (`intro.tex`). */
  fileLabel: string | null;
};

/** A parsed log item plus the workspace path it resolves to (null = outside the project). */
export type LatexProblem = CollapsedLatexLogItem & { path: string | null };

// Module-level cache so flipping back to a previously-rendered .tex restores
// the PDF on the very first render — the pane remounts and would otherwise
// blank to null while the download re-runs, producing a visible double-flash.
type PdfSource =
  | { kind: 'blob'; blob: Blob; sha: string | null }
  | { kind: 'url'; url: string; sha: string | null; expiresAt: number };

const PDF_CACHE = new Map<string, PdfSource>();
const cacheKey = (projectId: string, pdfPath: string) => `${projectId}:${pdfPath}`;
const SIGNED_URL_CACHE_MS = 9 * 60 * 1000;

const usableCachedSource = (source: PdfSource | undefined): PdfSource | null => {
  if (!source) return null;
  return source.kind === 'url' && source.expiresAt <= Date.now() ? null : source;
};

type StoredPdfResult =
  | { kind: 'found'; source: PdfSource }
  | { kind: 'missing' }
  | { kind: 'mismatch' };

async function resolveStoredPdf(
  fetchImpl: typeof fetch,
  projectId: string,
  pdfPath: string,
  expectedSha?: string | null,
  preferSignedUrl = true,
): Promise<StoredPdfResult> {
  if (preferSignedUrl) {
    try {
      const preview = await fetchWithDeadline(
        fetchImpl,
        '/api/workspace/files/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, path: pdfPath, ...(expectedSha ? { expectedSha } : {}) }),
        },
        READ_DEADLINE_MS,
      );
      if (preview.ok) {
        const body = await preview.json() as { signedUrl?: string; blobSha?: string };
        if (body.signedUrl) {
          return {
            kind: 'found',
            source: {
              kind: 'url',
              url: body.signedUrl,
              sha: body.blobSha ?? expectedSha ?? null,
              expiresAt: Date.now() + SIGNED_URL_CACHE_MS,
            },
          };
        }
      }
      if (preview.status === 409) return { kind: 'mismatch' };
    } catch {
      // Signing is an optimization. The authenticated download below remains
      // the compatibility/recovery path when it is unavailable.
    }
  }

  // Local sidecars and older servers do not expose files/preview. Keep their
  // authenticated whole-file route as a compatibility fallback.
  const params = new URLSearchParams({ projectId, path: pdfPath });
  const download = await fetchWithDeadline(
    fetchImpl,
    `/api/workspace/files/download?${params}`,
    { credentials: 'include' },
    READ_DEADLINE_MS,
  );
  if (!download.ok) return { kind: 'missing' };
  const sha = download.headers.get('X-Blob-Sha') ?? expectedSha ?? null;
  if (expectedSha && sha && sha !== expectedSha) return { kind: 'mismatch' };
  return {
    kind: 'found',
    source: {
      kind: 'blob',
      blob: new Blob([await download.arrayBuffer()], { type: 'application/pdf' }),
      sha,
    },
  };
}


// Per-document monotonic compile counter (W1.trigger sourceVersion). Kept at
// module scope so it survives editor remounts (switching files and back, pane
// re-renders) instead of resetting to 0 — a reset could let a stale in-flight
// response look newer than a fresh compile. Keyed by project:texPath.
const SOURCE_VERSION = new Map<string, number>();
const nextSourceVersion = (projectId: string, texPath: string): number => {
  const key = `${projectId}:${texPath}`;
  const next = (SOURCE_VERSION.get(key) ?? 0) + 1;
  SOURCE_VERSION.set(key, next);
  return next;
};

function base64ToPdfBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: 'application/pdf' });
}

function buildCompileDetails(result: CompileResult): string {
  return [result.stdout, result.stderr, result.log]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n\n')
    .trim();
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// Structured problems from raw tectonic output, via the shared parser
// (W1.parser) so the editor markers, the error rows, and the agent self-heal
// loop all read errors the same way — no second log heuristic. `resolve` maps
// log paths to workspace paths; without it the log's own path stands in.
export function parseLatexProblems(
  details: string,
  rootFile: string | null = null,
  resolve?: (file: string | null) => string | null,
): LatexProblem[] {
  if (!details) return [];
  // Resolve BEFORE collapsing (IC8), keyed on the resolved path: a log-named
  // child whose string equals the root (`\input{paper/main}` under
  // paper/main.tex) must not collapse into the root-fallback item. Only paths
  // the log itself named get re-mapped — the parser's root fallback is already
  // a workspace path.
  const byKey = new Map<string, LatexProblem>();
  for (const item of parseLatexLog(details, { rootFile })) {
    const path = item.fileFromLog && resolve ? resolve(item.file) : item.file;
    const key = `${item.severity}|${path ?? `log:${item.file ?? ''}`}|${item.line ?? ''}`;
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else byKey.set(key, { ...item, path, count: 1 });
  }
  return [...byKey.values()];
}

// The jumpable error rows: `error` items with a known source line, capped.
export function errorLinesFromProblems(problems: LatexProblem[], rootFile: string | null = null): LatexErrorLine[] {
  return problems
    .filter((item) => item.severity === 'error' && typeof item.line === 'number' && item.line >= 1)
    .map((item) => ({
      line: item.line as number,
      text: item.message.slice(0, 160),
      file: item.path,
      fileLabel: item.path ? (item.path === rootFile ? null : basename(item.path)) : item.file ? basename(item.file) : null,
    }))
    .slice(0, 12);
}

export function extractLatexErrorLines(details: string, rootFile: string | null = null): LatexErrorLine[] {
  return errorLinesFromProblems(parseLatexProblems(details, rootFile), rootFile);
}

const hasLocatedError = (error: CompileErrorState | null, rootFile: string | null): boolean =>
  Boolean(error && extractLatexErrorLines(error.details, rootFile).length > 0);

interface UseLatexCompileArgs {
  projectId: string;
  chatId?: string | null;
  /** Null when the active file is not a LaTeX document — the hook stays inert. */
  texPath: string | null;
  canWrite: boolean;
  source?: string | null;
  getSource?: () => string | null;
  /**
   * Allow auto-compiling on a missing PDF even without live editor source —
   * set when the compile target (root) differs from the open file, so the
   * server pulls the root from the doc store (W1.root §3.3). Defaults to false.
   */
  compileWithoutSource?: boolean;
  /** Data plane for compile + PDF download — the page's `apiFetch`, so local
   *  (sidecar-backed) projects compile too. Defaults to the real fetch. */
  fetchImpl?: typeof fetch;
  /** Supabase realtime PDF refresh (background/agent compiles). Off for local
   *  projects, whose PDFs never land in the cloud `files` table. */
  liveRefresh?: boolean;
  /** Map a compile-log path to a workspace path (null = not in the project). */
  resolveLogPath?: (file: string | null) => string | null;
  /** Known failure for an immutable seeded document. Painted synchronously;
   * the real compile still verifies it after the first frame. */
  initialCompileError?: CompileErrorState | null;
  /** Debounced auto-compile on edit (Overleaf parity, §1.2). Flipping it on
   *  mid-edit compiles whatever changed while it was off. */
  autoCompile?: boolean;
  /** Pause auto compile while an agent turn streams: its edits compile
   *  brain-side and land via liveRefresh, which then counts as the compile
   *  for the current text. Released edits compile on release. */
  holdAutoCompile?: boolean;
  /** Mutable tracker bumped on every edit this tab authored (one stable
   *  object, mutated in place — never React state, so per-keystroke bumps
   *  cost no renders). When provided, auto compile fires only for THIS tab's
   *  edits — a collaborator's remote edit compiles in the collaborator's own
   *  tab and arrives here via liveRefresh, so N viewers never launch N
   *  identical pool compiles. */
  localEdits?: LocalEditTracker;
  /** Live text of the OPEN file (root or fragment): the change clock that
   *  arms the auto-compile debounce. Defaults to `source`. */
  editedSource?: string | null;
  /** Identity of the open file, so switching files re-seeds the clock instead
   *  of reading the next file's text as an edit. */
  editedPath?: string | null;
}

/** This tab's own typing, tracked off the render path: `version` bumps and
 *  `lastEditAt` restamps on every local Y.Doc transaction. One object per
 *  page, mutated in place. */
export type LocalEditTracker = { version: number; lastEditAt: number };

/** Overleaf-like quiet window after the last edit before an auto compile. */
export const AUTO_COMPILE_DEBOUNCE_MS = 2000;

/** An auto compile never starts on top of live typing: a keystroke this recent
 *  defers to the (still pending) debounce timer, which fires once typing stops. */
export const AUTO_COMPILE_TYPING_GUARD_MS = 1000;


export interface LatexCompileController {
  /** Immutable signed URL (cloud) or blob URL (local/legacy), or null. */
  pdfUrl: string | null;
  compiling: boolean;
  busy: boolean;
  hasPdf: boolean;
  compileError: CompileErrorState | null;
  /** Compile/Recompile/Compiling…/Loading… label for the trigger button. */
  compileLabel: string;
  errorLines: LatexErrorLine[];
  /** Every parsed error/warning/badbox with its resolved workspace path (editor markers). */
  problems: LatexProblem[];
  /** Raw tectonic output for the collapsible log (empty when clean). */
  logText: string;
  recompile: () => void;
  /** False when there is no compile target (no resolved root) — `recompile` no-ops. */
  canRecompile: boolean;
  /** Epoch ms of the last PDF we successfully mounted, for the "Compiled HH:MM"
   *  pill (§1.4). Null until the first PDF loads this session. */
  lastCompiledAt: number | null;
  /** True when the mounted PDF is the last *good* build but the current source
   *  failed to compile — drives the "stale" badge (§1.4). */
  stale: boolean;
}

export function useLatexCompile({
  projectId,
  chatId,
  texPath,
  canWrite,
  source,
  getSource,
  compileWithoutSource = false,
  fetchImpl = fetch,
  liveRefresh = true,
  resolveLogPath,
  initialCompileError = null,
  autoCompile = false,
  holdAutoCompile = false,
  localEdits,
  editedSource,
  editedPath = null,
}: UseLatexCompileArgs): LatexCompileController {
  const pshareRealtimeReady = usePathShareRealtimeAuthReady();
  const pdfPath = useMemo(() => (texPath ? texPath.replace(/\.tex$/i, '.pdf') : null), [texPath]);

  const [pdf, setPdf] = useState<{ source: PdfSource; nonce: number } | null>(() => {
    if (!pdfPath) return null;
    const cached = usableCachedSource(PDF_CACHE.get(cacheKey(projectId, pdfPath)));
    return cached ? { source: cached, nonce: Date.now() } : null;
  });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [compileError, setCompileError] = useState<CompileErrorState | null>(initialCompileError);
  // Log of the last *successful* compile — warnings still get markers (§1.9).
  const [successLog, setSuccessLog] = useState('');
  // blob_sha of the PDF that successLog describes: the compile route upserts
  // the PDF before responding, so our own compile's realtime echo must not
  // clear the warnings we just parsed (only a genuinely new build may).
  const successLogShaRef = useRef<string | null>(null);
  // True when that echo already arrived while the compile was still in flight —
  // then there is no later echo to absorb, so the keep-once guard stays unarmed.
  const echoSeenInFlightRef = useRef(false);
  // Echo skipped during our own flight (see the listener): almost always our
  // own build, but a CONCURRENT compile's row can hide behind it — replayed
  // after the flight when its sha differs from what we mounted, because no
  // later realtime event will come for it.
  const pendingEchoShaRef = useRef<string | null>(null);
  const refreshFromPathRef = useRef<((sha: string | null) => void) | null>(null);
  // Only arm the keep-once guard when the realtime channel is actually
  // subscribed — a compile finishing before the channel joins gets no echo, and
  // an armed guard would then absorb a real same-sha rebuild later.
  const echoChannelReadyRef = useRef(false);
  // Epoch ms of the last PDF we successfully mounted (compile, initial download,
  // or realtime refresh). Seeded null; drives the "Compiled HH:MM" pill (§1.4).
  const [lastCompiledAt, setLastCompiledAt] = useState<number | null>(null);

  useEffect(() => {
    if (!pdf) {
      setPreviewUrl(null);
      return;
    }
    if (pdf.source.kind === 'url') {
      setPreviewUrl(pdf.source.url);
      return;
    }
    const blobUrl = URL.createObjectURL(pdf.source.blob);
    setPreviewUrl(blobUrl);
    return () => {
      URL.revokeObjectURL(blobUrl);
    };
  }, [pdf]);

  // Range loading deliberately leaves unseen pages unfetched. Refresh the
  // signed URL one minute before its storage token expires so a long-lived
  // preview can still request a later page; the viewer preserves its scroll
  // state across this URL swap.
  useEffect(() => {
    if (!pdfPath || !liveRefresh || pdf?.source.kind !== 'url') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        let resolved = await resolveStoredPdf(fetchImpl, projectId, pdfPath, pdf.source.sha);
        if (resolved.kind === 'mismatch') {
          resolved = await resolveStoredPdf(fetchImpl, projectId, pdfPath);
        }
        if (cancelled || resolved.kind !== 'found') throw new Error('PDF URL refresh failed');
        setPdf({ source: resolved.source, nonce: Date.now() });
        loadedShaRef.current = resolved.source.sha;
        PDF_CACHE.set(cacheKey(projectId, pdfPath), resolved.source);
      } catch {
        if (!cancelled) timer = setTimeout(refresh, 30_000);
      }
    };
    timer = setTimeout(refresh, Math.max(0, pdf.source.expiresAt - Date.now()));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fetchImpl, liveRefresh, pdf, pdfPath, projectId]);

  // canWrite/hasSource ride in refs rather than effect deps — they change on
  // every keystroke and would otherwise re-run the mount effect mid-typing.
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const hasSourceRef = useRef(false);
  hasSourceRef.current =
    compileWithoutSource || (getSource?.() ?? source ?? '').trim().length > 0;
  const loadedShaRef = useRef<string | null>(
    pdfPath ? PDF_CACHE.get(cacheKey(projectId, pdfPath))?.sha ?? null : null,
  );
  const needsAutoCompileWhenSourceArrivesRef = useRef(false);
  const preserveNextAutoErrorRef = useRef(false);
  // A seeded, line-addressable diagnostic survives only its first verification
  // request. Key it to the text it describes so typing cannot resurrect stale
  // markers when that request settles.
  const preservedInitialErrorRef = useRef<{ source: string } | null>(null);
  const compileErrorRef = useRef(compileError);
  useEffect(() => {
    compileErrorRef.current = compileError;
  }, [compileError]);

  useEffect(() => {
    needsAutoCompileWhenSourceArrivesRef.current = false;
    preservedInitialErrorRef.current = null;
    // `initialCompileError` often appears after this hook's first render, once
    // the starter source hydrates. Keep the imperative compile path in sync
    // in this same effect; its verification is scheduled on the next frame
    // and can otherwise beat the passive state/ref update.
    compileErrorRef.current = initialCompileError;
    setCompileError(initialCompileError);
    setSuccessLog('');
    successLogShaRef.current = null;
    // Reset per-document timestamp so the "Compiled HH:MM" pill never leaks the
    // previous file's good build into the newly-opened one.
    setLastCompiledAt(null);
    if (!pdfPath) {
      loadedShaRef.current = null;
      setPdf(null);
      setInitialLoad(false);
      return;
    }

    const cached = usableCachedSource(PDF_CACHE.get(cacheKey(projectId, pdfPath)));
    loadedShaRef.current = cached?.sha ?? null;
    setPdf(cached ? { source: cached, nonce: Date.now() } : null);
    setInitialLoad(true);
  }, [projectId, pdfPath, initialCompileError]);

  // Monotonic source revision (W1.trigger), persisted per-document across
  // remounts (see SOURCE_VERSION). The compileInFlight guard serializes
  // compiles within a mount; the module-level counter keeps revisions ordered
  // across remounts so W2.autocompile's stale-response dropping has a stable
  // clock to compare against.
  const compileInFlight = useRef(false);
  // Queued/carried auto-compile state is keyed by project:texPath so a request
  // never survives into a different document.
  const targetKey = texPath ? cacheKey(projectId, texPath) : null;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
  // Text the last compile (ours, or a background one whose PDF landed) saw.
  // `null` = not seeded yet: the first text to arrive seeds it without
  // compiling, so opening a file never recompiles an existing PDF.
  const compiledClockRef = useRef<string | null>(null);
  // One coalesced follow-up for a request that arrived mid-compile, keyed to
  // the texPath it was queued for — never spent on a different document.
  // `force`: the caller asked for a build outright (a probe that found no
  // PDF), not a re-check of the auto-compile dirty predicate — draining it
  // through that predicate would drop it, since the text is unchanged.
  const trailingRef = useRef<{ trigger: CompileTrigger; targetKey: string; force?: boolean } | null>(null);
  const clockRef = useRef<() => string | null>(() => null);
  clockRef.current = () => editedSource ?? getSource?.() ?? source ?? null;
  // Local-edit count the last compile (or clock seed) covered. Background PDFs
  // are only trusted while this still matches — any uncovered LOCAL typing
  // keeps its owed compile; remote/agent edits don't bump the counter and are
  // exactly what a held (agent-run) PDF covers.
  const localEditsRef = useRef(localEdits);
  localEditsRef.current = localEdits;
  const localEditNow = () => localEditsRef.current?.version ?? 0;
  const localEditsAtCompileRef = useRef(localEdits?.version ?? 0);
  // Assigned below, once maybeAutoCompile exists; compile's finally drains
  // through the ref so the two can be defined in either order.
  const drainTrailingRef = useRef<() => void>(() => {});
  const compile = useCallback(async (
    trigger: CompileTrigger = 'manual',
    opts?: { deadlineMs?: number; preserveError?: boolean },
  ) => {
    if (!texPath || !pdfPath) return;
    // A call landing mid-compile coalesces into one follow-up at the latest
    // source instead of being dropped — a slow compile for document A must
    // not swallow B's first-open build, and edits made mid-compile keep
    // exactly one trailing run.
    if (compileInFlight.current) {
      if (targetKeyRef.current !== null) {
        trailingRef.current = trailingRef.current ?? { trigger, targetKey: targetKeyRef.current, force: true };
      }
      return;
    }
    compileInFlight.current = true;
    const requestTarget = targetKeyRef.current;
    const requestClock = clockRef.current();
    const preserveLocatedError = Boolean(
      opts?.preserveError &&
      preservedInitialErrorRef.current?.source === requestClock &&
      hasLocatedError(compileErrorRef.current, texPath)
    );
    const clearError = () => {
      preservedInitialErrorRef.current = null;
      setCompileError(null);
    };
    const publishFailure = (nextError: CompileErrorState) => {
      // A verification response for text that has since changed is stale.
      if (opts?.preserveError && requestClock !== clockRef.current()) {
        clearError();
        return;
      }
      // Otherwise a line-less response may keep the seeded marker; a real
      // location replaces it immediately.
      if (preserveLocatedError && !hasLocatedError(nextError, texPath)) return;
      preservedInitialErrorRef.current = null;
      setCompileError(nextError);
    };
    trailingRef.current = null; // this run reads the latest source, satisfying any queued request
    setCompiling(true);
    if (!preserveLocatedError) clearError();
    const localEditsAtStart = localEditNow();
    try {
      echoSeenInFlightRef.current = false;
      const currentSource = getSource?.() ?? source;
      // This compile covers the text as of now — the auto-compile debounce
      // compares against it to decide whether later text owes another run.
      compiledClockRef.current = clockRef.current();
      localEditsAtCompileRef.current = localEditsAtStart;
      const sourceVersion = nextSourceVersion(projectId, texPath);
      // Compiles are normally unbounded (legitimately slow), but a caller
      // reacting to a stalled transport can pass a ceiling so a hung request
      // fails closed instead of pinning `compiling` forever.
      const compileFetch: typeof fetch = opts?.deadlineMs
        ? (input, init) => fetchWithDeadline(fetchImpl, String(input), init ?? {}, opts.deadlineMs!)
        : fetchImpl;
      const response = await compileFetch('/api/workspace/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          projectId,
          ...(chatId ? { chatId } : {}),
          filePath: texPath,
          ...(typeof currentSource === 'string' ? { source: currentSource } : {}),
          trigger,
          sourceVersion,
          // Ties the server-side compile events to the same PostHog person as
          // the client-side funnel events for signed-out visitors.
          ...(posthogDistinctId() ? { phDistinctId: posthogDistinctId() } : {}),
        }),
      });
      const result = (await response.json().catch(() => ({}))) as CompileResult;
      // The user may have switched documents while this ran: cache the result
      // for ITS document, but never repaint the now-current one with it.
      const live = targetKeyRef.current === requestTarget;
      if (!response.ok || !result.ok || !(result.pdfBase64 || result.pdfSha)) {
        if (live) {
          publishFailure({
            message: result.error ?? `compile failed (${response.status})`,
            details: buildCompileDetails(result),
            trigger,
            failureKind: result.failureKind ?? null,
            localEditsAtStart,
          });
        }
        return;
      }
      let pdfSource: PdfSource;
      let blobToHash: Blob | null = null;
      let sha: string | null = null;
      let foreignBytes = false;
      if (result.pdfBase64) {
        const blob = base64ToPdfBlob(result.pdfBase64);
        pdfSource = { kind: 'blob', blob, sha: null };
        blobToHash = blob;
      } else if (result.pdfUrl) {
        sha = result.pdfSha ?? null;
        pdfSource = {
          kind: 'url',
          url: result.pdfUrl,
          sha,
          expiresAt: Date.now() + SIGNED_URL_CACHE_MS,
        };
      } else {
        const resolved = await resolveStoredPdf(fetchImpl, projectId, pdfPath, result.pdfSha, liveRefresh);
        if (resolved.kind === 'mismatch') {
          const latest = await resolveStoredPdf(fetchImpl, projectId, pdfPath, null, liveRefresh);
          if (latest.kind !== 'found') throw new Error('compiled, but the PDF delivery failed');
          pdfSource = latest.source;
          foreignBytes = true;
        } else if (resolved.kind === 'found') {
          pdfSource = resolved.source;
        } else {
          throw new Error('compiled, but the PDF download failed (404)');
        }
        sha = pdfSource.sha;
      }
      if (live) {
        clearError();
        setSuccessLog(foreignBytes ? '' : buildCompileDetails(result));
        setPdf({ source: pdfSource, nonce: Date.now() });
        setLastCompiledAt(Date.now());
      }
      if (blobToHash) {
        // Seed the realtime-dedup tracker so the postgres_changes listener
        // below doesn't refetch and re-render the same content we just
        // compiled. Published-first so hashing can't delay the preview, but
        // still AWAITED: compileInFlight is the own-echo guard, and clearing
        // it before the sha lands would let our own echo wipe the success log.
        try {
          const digest = await crypto.subtle.digest('SHA-256', await blobToHash.arrayBuffer());
          sha = Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        } catch {
          // Non-fatal: at worst we get the pre-fix double-flash for this turn.
        }
      }
      if (sha) {
        pdfSource.sha = sha;
        if (live) {
          loadedShaRef.current = sha;
          successLogShaRef.current =
            foreignBytes || echoSeenInFlightRef.current || !echoChannelReadyRef.current ? null : sha;
        }
      }
      PDF_CACHE.set(cacheKey(projectId, pdfPath), pdfSource);
    } catch (error) {
      if (targetKeyRef.current === requestTarget) {
        publishFailure({
          message: error instanceof Error ? error.message : 'compile failed',
          details: '',
          trigger,
          // Thrown here means transport or PDF delivery, never a tex error.
          failureKind: 'infra',
          localEditsAtStart,
        });
      }
    } finally {
      setCompiling(false);
      compileInFlight.current = false;
      // An echo skipped during our flight that is NOT what we mounted came
      // from a concurrent compile — no later realtime event will re-announce
      // it, so fetch it now (last build wins the pane).
      const pending = pendingEchoShaRef.current;
      pendingEchoShaRef.current = null;
      if (pending && pending !== loadedShaRef.current) refreshFromPathRef.current?.(pending);
      drainTrailingRef.current();
    }
  }, [chatId, fetchImpl, getSource, liveRefresh, pdfPath, projectId, source, texPath]);

  const compileRef = useRef(compile);
  compileRef.current = compile;

  // ---- Auto compile (§1.2): debounced compile-on-edit, ported from #1307. ----
  const initialLoadRef = useRef(true);
  initialLoadRef.current = initialLoad;
  // Requests that arrive mid-compile or mid-probe run once afterwards at the
  // latest source (the probe's own stale bytes must not overwrite a newer build).
  const mustQueue = () => compileInFlight.current || initialLoadRef.current;
  const autoCompileLive = autoCompile && !holdAutoCompile;
  const autoCompileRef = useRef(autoCompileLive);
  autoCompileRef.current = autoCompileLive;
  const holdRef = useRef(holdAutoCompile);
  holdRef.current = holdAutoCompile;
  const hasLocalDelta = () =>
    localEditsRef.current === undefined || localEditNow() !== localEditsAtCompileRef.current;
  // Edits left uncompiled when the user switched files mid-debounce: each
  // ROOT still owes one compile (the root covers every fragment). Keyed by
  // texPath so one root's debt is never spent on (or clobbered by) another's.
  const carryRef = useRef(new Set<string>());
  // Epoch ms of the last text change, so a compile draining mid-burst (its
  // predecessor just finished) doesn't start on top of live typing.
  const lastEditAtRef = useRef(0);
  // One retry timer for holds the debounce timer can't see out of: the
  // settle gate (text still mid-expression) and the typing guard on drain
  // paths. Re-armed for the remainder of the idle window; any new keystroke
  // replaces it with a fresh debounce cycle.
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSettleTimer = () => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  };
  const maybeAutoCompileRef = useRef<() => void>(() => {});
  const armSettleRetry = (delayMs: number) => {
    clearSettleTimer();
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      maybeAutoCompileRef.current();
    }, Math.max(1, delayMs));
  };
  const maybeAutoCompile = useCallback(() => {
    if (!autoCompileRef.current || !canWriteRef.current) return;
    const carried = targetKeyRef.current !== null && carryRef.current.has(targetKeyRef.current);
    const clock = clockRef.current();
    if (clock === null || (!carried && (clock === compiledClockRef.current || !hasLocalDelta()))) return;
    const idle = Date.now() - lastEditAtRef.current;
    // Still typing: wait out the burst (a drain can land right after a keystroke).
    if (idle < AUTO_COMPILE_TYPING_GUARD_MS) {
      armSettleRetry(AUTO_COMPILE_TYPING_GUARD_MS - idle);
      return;
    }
    // Mid-expression (§ settle): an open `$`, `{`, or environment can only
    // compile red, so don't compile AT ALL — the keystroke that closes the
    // construct starts a fresh debounce and compiles then. The dirty text
    // stays owed (nothing consumes the clock), so nothing is lost; manual
    // compile remains available for a deliberately unfinished document.
    if (latexSettleHold(clock) !== null) return;
    if (targetKeyRef.current !== null) carryRef.current.delete(targetKeyRef.current);
    if (mustQueue()) {
      // Anything already queued for THIS target covers us; a stale target's
      // entry (or nothing) is replaced so this edit isn't dropped.
      const queued = trailingRef.current;
      if (!queued || queued.targetKey !== targetKeyRef.current) {
        trailingRef.current = { trigger: 'auto', targetKey: targetKeyRef.current! };
      }
    } else void compileRef.current('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  maybeAutoCompileRef.current = maybeAutoCompile;
  const drainTrailing = () => {
    const trailing = trailingRef.current;
    // Still probing this target: the probe owns the PDF until it settles, so
    // its own drain runs the queued request rather than racing it.
    if (trailing && trailing.targetKey === targetKeyRef.current && mustQueue()) return;
    trailingRef.current = null;
    if (!trailing || trailing.targetKey !== targetKeyRef.current) return;
    if (trailing.force || trailing.trigger === 'manual') void compileRef.current(trailing.trigger);
    else maybeAutoCompileRef.current();
  };
  drainTrailingRef.current = drainTrailing;
  // A background PDF landing carries no source identity. Only while held (an
  // agent turn, whose compile is what lands here) and with no local typing
  // since the hold began does it count as covering the current text;
  // otherwise a redundant compile beats a skipped one.
  const markBackgroundCompiled = useCallback(() => {
    if (holdRef.current && localEditNow() === localEditsAtCompileRef.current) {
      compiledClockRef.current = clockRef.current();
    }
  }, []);
  const changeClock = editedSource ?? source ?? null;
  const lastClockRef = useRef<string | null>(null);
  const editedPathRef = useRef(editedPath);
  editedPathRef.current = editedPath;
  // Debt that belongs to whatever target seeds NEXT: set when the ROOT swaps
  // under an unchanged open file (late resolution) — the dirty text will be
  // compiled by the incoming root, not the one we are leaving.
  const carryOnSeedRef = useRef(false);
  useEffect(() => {
    const preserved = preservedInitialErrorRef.current;
    if (preserved && preserved.source !== changeClock) {
      preservedInitialErrorRef.current = null;
      setCompileError(null);
    }
  }, [changeClock]);
  useEffect(
    () => () => {
      // Leaving a seeded file (or root) re-seeds the clock; a still-dirty text
      // is carried (against the root that will compile it) so the switch
      // cannot drop a pending compile. An unseeded doc has nothing pending.
      const compiled = compiledClockRef.current;
      if (compiled !== null && lastClockRef.current !== null && lastClockRef.current !== compiled && hasLocalDelta()) {
        if (editedPath !== null && editedPathRef.current === editedPath) carryOnSeedRef.current = true;
        else if (targetKey !== null) carryRef.current.add(targetKey);
      }
      compiledClockRef.current = null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [targetKey, editedPath],
  );
  useEffect(() => {
    // Only a real text change is typing — this effect also re-runs on a target
    // or open-file switch, which must not hold off the compile that follows it.
    if (changeClock !== lastClockRef.current) {
      lastEditAtRef.current = Date.now();
      // A pending settle retry describes text that no longer exists.
      clearSettleTimer();
    }
    lastClockRef.current = changeClock;
    if (!texPath || changeClock === null) {
      compiledClockRef.current = null;
      return;
    }
    if (compiledClockRef.current === null) {
      compiledClockRef.current = changeClock; // first arrival seeds, never compiles
      localEditsAtCompileRef.current = localEditNow();
      if (carryOnSeedRef.current && targetKey !== null) {
        carryOnSeedRef.current = false;
        carryRef.current.add(targetKey);
      }
    }
    if (changeClock === compiledClockRef.current && (targetKey === null || !carryRef.current.has(targetKey))) return;
    const timer = setTimeout(maybeAutoCompile, AUTO_COMPILE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texPath, targetKey, editedPath, changeClock, maybeAutoCompile]);
  // Flipping the pref on (or an agent-run hold releasing) catches up on edits
  // made while auto compile was off.
  useEffect(() => {
    if (autoCompileLive) maybeAutoCompile();
  }, [autoCompileLive, maybeAutoCompile]);
  // The mount probe settling releases any request queued behind it.
  useEffect(() => {
    if (!initialLoad) drainTrailingRef.current();
  }, [initialLoad]);
  useEffect(() => clearSettleTimer, []);
  // ---- end auto compile ----

  useEffect(() => {
    if (!pdfPath) {
      setInitialLoad(false);
      return;
    }
    let cancelled = false;
    if (initialCompileError) {
      compileErrorRef.current = initialCompileError;
      setCompileError(initialCompileError);
      setInitialLoad(false);
      preserveNextAutoErrorRef.current = true;
      const clock = clockRef.current();
      preservedInitialErrorRef.current =
        clock !== null && hasLocatedError(initialCompileError, texPath)
          ? { source: clock }
          : null;
      // Let the known diagnostic paint first. Verification then runs without
      // the two serialized preview/download probes used for ordinary files.
      const frame = requestAnimationFrame(() => {
        setTimeout(() => {
          if (cancelled) return;
          if (canWriteRef.current && hasSourceRef.current) {
            preserveNextAutoErrorRef.current = false;
            void compileRef.current('auto', { preserveError: true });
          } else {
            needsAutoCompileWhenSourceArrivesRef.current = true;
          }
        }, 0);
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    setCompileError(null);
    setInitialLoad(true);
    (async () => {
      try {
        const resolved = await resolveStoredPdf(fetchImpl, projectId, pdfPath, null, liveRefresh);
        if (cancelled) return;
        if (resolved.kind === 'found') {
          const { source } = resolved;
          const sha = source.sha;
          if (sha && sha === loadedShaRef.current && pdf) {
            // nothing to do — already showing these bytes
          } else {
            setPdf({ source, nonce: Date.now() });
            setLastCompiledAt(Date.now());
            loadedShaRef.current = sha;
            PDF_CACHE.set(cacheKey(projectId, pdfPath), source);
          }
          return;
        }
        if (resolved.kind === 'missing') {
          if (canWriteRef.current && hasSourceRef.current) {
            await compileRef.current('auto');
          } else {
            needsAutoCompileWhenSourceArrivesRef.current = true;
          }
        }
      } catch {
        // Probe timed out or failed: mirror the 404 branch — compile now if
        // source is already here (the source-arrival effect has already run
        // and will not fire again), else arm the fallback for when it lands.
        // Not after cleanup — a stale timeout must not act for a document
        // this probe never belonged to.
        if (!cancelled) {
          if (canWriteRef.current && hasSourceRef.current) {
            // The transport just proved it can stall — bound this compile so
            // a hung request cannot pin the Compile button on busy.
            void compileRef.current('auto', { deadlineMs: 120_000 });
          } else {
            needsAutoCompileWhenSourceArrivesRef.current = true;
          }
        }
      } finally {
        if (!cancelled) setInitialLoad(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // pdf intentionally not in deps — read for the dedup short-circuit only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pdfPath, liveRefresh, initialCompileError]);

  // When source first becomes available after a 404 on initial load, kick the
  // auto-compile we couldn't fire at mount time.
  useEffect(() => {
    if (!needsAutoCompileWhenSourceArrivesRef.current) return;
    if (!hasSourceRef.current || !canWriteRef.current) return;
    needsAutoCompileWhenSourceArrivesRef.current = false;
    const preserveError = preserveNextAutoErrorRef.current;
    preserveNextAutoErrorRef.current = false;
    if (preserveError && hasLocatedError(compileErrorRef.current, null)) {
      const clock = clockRef.current();
      preservedInitialErrorRef.current = clock === null ? null : { source: clock };
    }
    void compileRef.current('auto', { preserveError });
  }, [source]);

  // Live refresh: the brain compiles .tex edits in the background and upserts
  // the .pdf row. Dedup by blob_sha so identical content doesn't re-mount the
  // iframe for no visual change.
  useEffect(() => {
    if (!pdfPath || !liveRefresh) return;
    if (!pshareRealtimeReady) return; // anonymous ?pshare= guests: wait for the realtime JWT
    const supabase = createBrowserClient();
    if (!supabase) return;
    let cancelled = false;
    // Shared by the realtime listener and the post-flight replay in compile():
    // Resolve the path to an immutable URL and mount it as an external build.
    refreshFromPathRef.current = (incomingSha) => {
      void (async () => {
        try {
          let resolved = await resolveStoredPdf(fetchImpl, projectId, pdfPath, incomingSha);
          if (resolved.kind === 'mismatch') {
            // Another compile won after the realtime row we observed; mount
            // the newest immutable object instead of stale/mislabeled bytes.
            resolved = await resolveStoredPdf(fetchImpl, projectId, pdfPath);
          }
          if (cancelled || resolved.kind !== 'found') return;
          const { source } = resolved;
          setPdf({ source, nonce: Date.now() });
          setLastCompiledAt(Date.now());
          loadedShaRef.current = source.sha;
          PDF_CACHE.set(cacheKey(projectId, pdfPath), source);
          setCompileError(null);
          if (source.sha !== successLogShaRef.current) setSuccessLog('');
          // A held agent run's compile landing counts as the compile for the
          // current text (unless the user typed during the turn).
          markBackgroundCompiled();
        } catch {
          // ignore — the manual Compile button is still available.
        }
      })();
    };
    const channel = supabase
      .channel(`latex-pdf-${projectId}-${pdfPath}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'files', filter: `project_id=eq.${projectId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as { path?: string; blob_sha?: string } | null;
          if (row?.path !== pdfPath) return;
          const incomingSha = row?.blob_sha;
          // The compile route upserts the PDF before responding, so this event
          // can be our own in-flight compile's echo — its sha refs aren't set
          // yet, and clearing successLog here would drop the warnings the
          // response is about to carry.
          const ownCompileInFlight = compileInFlight.current;
          if (ownCompileInFlight) echoSeenInFlightRef.current = true;
          if (incomingSha && incomingSha === loadedShaRef.current) {
            // The .pdf row was rewritten with byte-identical content — i.e. an
            // agent/background compile just *succeeded* (the compile route only
            // persists a PDF on success). The mounted bytes are already correct,
            // but a stale error from the user's last failed compile may still be
            // on screen; clearing it here is what makes "Sunny fixed it" reflect
            // in the chrome even when the PDF didn't visually change (item 3).
            setCompileError(null);
            if (!ownCompileInFlight) {
              if (incomingSha === successLogShaRef.current) {
                // Our own compile's one echo — keep the warnings it produced,
                // but consume the guard: a LATER byte-identical rewrite is a
                // genuine new build (e.g. an agent fixed a warning without
                // changing the rendered bytes) and must clear them.
                successLogShaRef.current = null;
              } else {
                setSuccessLog('');
              }
            }
            setLastCompiledAt(Date.now());
            markBackgroundCompiled();
            return;
          }
          // Our own compile's row upsert lands BEFORE the response (the route
          // persists first), so during our own flight this event is almost
          // always our own build — the response path mounts those bytes and
          // seeds the sha itself. Downloading here too would double-transfer
          // and double-mount every manual compile. A concurrent compile's row
          // can hide behind our flight though, so remember the sha — the
          // compile's finally replays it if it isn't what we end up mounting.
          if (ownCompileInFlight) {
            pendingEchoShaRef.current = incomingSha ?? null;
            return;
          }
          refreshFromPathRef.current?.(incomingSha ?? null);
        },
      )
      .subscribe((status) => {
        echoChannelReadyRef.current = status === 'SUBSCRIBED';
      });
    return () => {
      cancelled = true;
      refreshFromPathRef.current = null;
      echoChannelReadyRef.current = false;
      supabase.removeChannel(channel);
    };
  }, [projectId, pdfPath, liveRefresh, pshareRealtimeReady, fetchImpl, markBackgroundCompiled]);

  const busy = compiling || initialLoad;
  const recompile = useCallback(() => {
    if (compiling || initialLoad) return;
    void compile();
  }, [compile, compiling, initialLoad]);

  // The PDF.js viewer owns zoom/page-nav, so we hand it the bare blob URL — no
  // `#view=…` viewer params (those were for the old browser iframe).
  const pdfUrl = pdfPath ? previewUrl : null;
  // Distinguish "loading the existing PDF" (fast) from "running tectonic" (slow)
  // so a preloaded preview doesn't look like a slow compile on every open.
  const hasPdf = pdfPath !== null && pdf !== null;
  const compileLabel = compiling
    ? 'Compiling…'
    : initialLoad
      ? 'Loading…'
      : hasPdf || compileError
        ? 'Recompile'
        : 'Compile';
  const logText = compileError?.details ?? successLog;
  const problems = useMemo(
    () => parseLatexProblems(logText, texPath, resolveLogPath),
    [logText, texPath, resolveLogPath],
  );
  const errorLines = useMemo(() => errorLinesFromProblems(problems, texPath), [problems, texPath]);
  // The mounted PDF is the last good build but the current source failed: keep
  // it on screen and flag it stale (§1.4) rather than blanking to an error.
  const stale = Boolean(compileError) && hasPdf;

  return {
    pdfUrl,
    compiling,
    busy,
    hasPdf,
    compileError,
    compileLabel,
    errorLines,
    problems,
    logText,
    recompile,
    canRecompile: texPath !== null,
    lastCompiledAt,
    stale,
  };
}
