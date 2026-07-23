'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase/browser';
import type { CompileFailureKind, CompileTrigger } from '@/lib/latex/compile-contract';
import { collapseLatexLogItems, parseLatexLog } from '@/lib/workspace/latex-log-parser';

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
  pdfPath?: string;
  // W1.trigger contract echo (consumed by later waves' failure routing).
  trigger?: CompileTrigger;
  sourceVersion?: number | null;
  failureKind?: CompileFailureKind;
};

export type CompileErrorState = {
  message: string;
  details: string;
};

export type LatexErrorLine = { line: number; text: string };

// Module-level cache so flipping back to a previously-rendered .tex restores
// the PDF on the very first render — the pane remounts and would otherwise
// blank to null while the download re-runs, producing a visible double-flash.
const PDF_CACHE = new Map<string, { blob: Blob; sha: string | null }>();
const cacheKey = (projectId: string, pdfPath: string) => `${projectId}:${pdfPath}`;

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

// Derive the gutter-jumpable error rows from raw tectonic output. Delegates to
// the shared structured parser (W1.parser) so the editor banner, the future
// one-line summary surface, and the agent self-heal loop all read errors the
// same way — no second log heuristic. We surface only `error` items that carry
// a known source line (the chips jump to a line), deduped and capped.
export function extractLatexErrorLines(details: string): LatexErrorLine[] {
  if (!details) return [];
  return collapseLatexLogItems(parseLatexLog(details))
    .filter((item) => item.severity === 'error' && typeof item.line === 'number' && item.line >= 1)
    .map((item) => ({ line: item.line as number, text: item.message.slice(0, 160) }))
    .slice(0, 12);
}

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
}

export interface LatexCompileController {
  /** Plain blob URL of the compiled PDF for the PDF.js viewer, or null. */
  pdfUrl: string | null;
  compiling: boolean;
  busy: boolean;
  hasPdf: boolean;
  compileError: CompileErrorState | null;
  /** Compile/Recompile/Compiling…/Loading… label for the trigger button. */
  compileLabel: string;
  errorLines: LatexErrorLine[];
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
}: UseLatexCompileArgs): LatexCompileController {
  const pdfPath = useMemo(() => (texPath ? texPath.replace(/\.tex$/i, '.pdf') : null), [texPath]);

  const [pdf, setPdf] = useState<{ blob: Blob; nonce: number } | null>(() => {
    if (!pdfPath) return null;
    const cached = PDF_CACHE.get(cacheKey(projectId, pdfPath));
    return cached ? { blob: cached.blob, nonce: Date.now() } : null;
  });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [compileError, setCompileError] = useState<CompileErrorState | null>(null);
  // Epoch ms of the last PDF we successfully mounted (compile, initial download,
  // or realtime refresh). Seeded null; drives the "Compiled HH:MM" pill (§1.4).
  const [lastCompiledAt, setLastCompiledAt] = useState<number | null>(null);

  useEffect(() => {
    if (!pdf) {
      setPreviewUrl(null);
      return;
    }
    const blobUrl = URL.createObjectURL(pdf.blob);
    setPreviewUrl(blobUrl);
    return () => {
      URL.revokeObjectURL(blobUrl);
    };
  }, [pdf]);

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

  useEffect(() => {
    needsAutoCompileWhenSourceArrivesRef.current = false;
    setCompileError(null);
    // Reset per-document timestamp so the "Compiled HH:MM" pill never leaks the
    // previous file's good build into the newly-opened one.
    setLastCompiledAt(null);
    if (!pdfPath) {
      loadedShaRef.current = null;
      setPdf(null);
      setInitialLoad(false);
      return;
    }

    const cached = PDF_CACHE.get(cacheKey(projectId, pdfPath));
    loadedShaRef.current = cached?.sha ?? null;
    setPdf(cached ? { blob: cached.blob, nonce: Date.now() } : null);
    setInitialLoad(true);
  }, [projectId, pdfPath]);

  // Monotonic source revision (W1.trigger), persisted per-document across
  // remounts (see SOURCE_VERSION). The compileInFlight guard serializes
  // compiles within a mount; the module-level counter keeps revisions ordered
  // across remounts so W2.autocompile's stale-response dropping has a stable
  // clock to compare against.
  const compileInFlight = useRef(false);
  const compile = useCallback(async (trigger: CompileTrigger = 'manual') => {
    if (!texPath || !pdfPath) return;
    // Guard against the auto-compile-on-mount path racing a manual click.
    if (compileInFlight.current) return;
    compileInFlight.current = true;
    setCompiling(true);
    setCompileError(null);
    try {
      const currentSource = getSource?.() ?? source;
      const sourceVersion = nextSourceVersion(projectId, texPath);
      const response = await fetchImpl('/api/workspace/compile', {
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
        }),
      });
      const result = (await response.json().catch(() => ({}))) as CompileResult;
      if (!response.ok || !result.ok || !result.pdfBase64) {
        setCompileError({
          message: result.error ?? `compile failed (${response.status})`,
          details: buildCompileDetails(result),
        });
        return;
      }
      const blob = base64ToPdfBlob(result.pdfBase64);
      setPdf({ blob, nonce: Date.now() });
      setLastCompiledAt(Date.now());
      // Seed the realtime-dedup tracker so the postgres_changes listener below
      // doesn't refetch and re-render the same content we just compiled.
      let sha: string | null = null;
      try {
        const buf = await blob.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buf);
        sha = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        loadedShaRef.current = sha;
      } catch {
        // Non-fatal: at worst we get the pre-fix double-flash for this turn.
      }
      PDF_CACHE.set(cacheKey(projectId, pdfPath), { blob, sha });
    } catch (error) {
      setCompileError({
        message: error instanceof Error ? error.message : 'compile failed',
        details: '',
      });
    } finally {
      setCompiling(false);
      compileInFlight.current = false;
    }
  }, [chatId, fetchImpl, getSource, pdfPath, projectId, source, texPath]);

  const compileRef = useRef(compile);
  compileRef.current = compile;

  useEffect(() => {
    if (!pdfPath) {
      setInitialLoad(false);
      return;
    }
    let cancelled = false;
    setCompileError(null);
    setInitialLoad(true);
    (async () => {
      try {
        const params = new URLSearchParams({ projectId, path: pdfPath });
        const response = await fetchImpl(`/api/workspace/files/download?${params}`, {
          credentials: 'include',
        });
        if (cancelled) return;
        if (response.ok) {
          const bytes = await response.arrayBuffer();
          if (cancelled) return;
          const blob = new Blob([bytes], { type: 'application/pdf' });
          const sha = response.headers.get('X-Blob-Sha');
          if (sha && sha === loadedShaRef.current && pdf) {
            // nothing to do — already showing these bytes
          } else {
            setPdf({ blob, nonce: Date.now() });
            setLastCompiledAt(Date.now());
            loadedShaRef.current = sha;
            PDF_CACHE.set(cacheKey(projectId, pdfPath), { blob, sha });
          }
          return;
        }
        if (response.status === 404) {
          if (canWriteRef.current && hasSourceRef.current) {
            await compileRef.current('auto');
          } else {
            needsAutoCompileWhenSourceArrivesRef.current = true;
          }
        }
      } catch {
        // ignore: leave the pane empty so the user can manually compile.
      } finally {
        if (!cancelled) setInitialLoad(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // pdf intentionally not in deps — read for the dedup short-circuit only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pdfPath]);

  // When source first becomes available after a 404 on initial load, kick the
  // auto-compile we couldn't fire at mount time.
  useEffect(() => {
    if (!needsAutoCompileWhenSourceArrivesRef.current) return;
    if (!hasSourceRef.current || !canWriteRef.current) return;
    needsAutoCompileWhenSourceArrivesRef.current = false;
    void compileRef.current('auto');
  }, [source]);

  // Live refresh: the brain compiles .tex edits in the background and upserts
  // the .pdf row. Dedup by blob_sha so identical content doesn't re-mount the
  // iframe for no visual change.
  useEffect(() => {
    if (!pdfPath || !liveRefresh) return;
    const supabase = createBrowserClient();
    if (!supabase) return;
    let cancelled = false;
    const channel = supabase
      .channel(`latex-pdf-${projectId}-${pdfPath}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'files', filter: `project_id=eq.${projectId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as { path?: string; blob_sha?: string } | null;
          if (row?.path !== pdfPath) return;
          const incomingSha = row?.blob_sha;
          if (incomingSha && incomingSha === loadedShaRef.current) {
            // The .pdf row was rewritten with byte-identical content — i.e. an
            // agent/background compile just *succeeded* (the compile route only
            // persists a PDF on success). The mounted bytes are already correct,
            // but a stale error from the user's last failed compile may still be
            // on screen; clearing it here is what makes "Sunny fixed it" reflect
            // in the chrome even when the PDF didn't visually change (item 3).
            setCompileError(null);
            setLastCompiledAt(Date.now());
            return;
          }
          void (async () => {
            try {
              const params = new URLSearchParams({ projectId, path: pdfPath });
              const response = await fetchImpl(`/api/workspace/files/download?${params}`, {
                credentials: 'include',
              });
              if (cancelled || !response.ok) return;
              const bytes = await response.arrayBuffer();
              if (cancelled) return;
              const blob = new Blob([bytes], { type: 'application/pdf' });
              setPdf({ blob, nonce: Date.now() });
              setLastCompiledAt(Date.now());
              loadedShaRef.current = incomingSha ?? null;
              PDF_CACHE.set(cacheKey(projectId, pdfPath), { blob, sha: incomingSha ?? null });
              setCompileError(null);
            } catch {
              // ignore — the manual Compile button is still available.
            }
          })();
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [projectId, pdfPath, liveRefresh, fetchImpl]);

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
  const logText = compileError?.details ?? '';
  const errorLines = useMemo(() => extractLatexErrorLines(logText), [logText]);
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
    logText,
    recompile,
    canRecompile: texPath !== null,
    lastCompiledAt,
    stale,
  };
}
