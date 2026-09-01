'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  DetectiveIcon,
  SidebarSimpleIcon,
  SpinnerGapIcon,
  ThumbsDownIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import {
  MAX_FACTCHECK_TEXT_CHARS,
  type FactcheckClaim,
  type FactcheckResponse,
} from '@/lib/workspace/factcheck';
import { findTextOccurrencesInRange } from '@/lib/workspace/text-locate';
import {
  getAiDockContainer,
  readDockPreference,
  writeDockPreference,
} from '@/components/workspace/ai-dock';
import type { RewriteSelectionCapture } from '@/lib/workspace/rewrite-anchor';
import { PopupResizeHandle, usePopupFrame } from '@/components/workspace/use-popup-frame';

/* ── Factcheck panel ──────────────────────────────────────────────────
 *  A spellchecker for facts: check a selected passage against live web
 *  research, underline what's wrong in the editor (squiggles, like a
 *  spellchecker), and offer one-click corrections with sources. Every
 *  decision (apply / reject) is logged to factcheck_feedback and future
 *  runs inject the author's rejections — the checker learns what this
 *  author considers noise.
 *
 *  Two homes: FLOATING near the selection (one check at a time, click-away
 *  dismisses — same contract as every other AI popup) or DOCKED into the
 *  shared right rail (persistent, several checks stacked at once, each its
 *  own card). The dock toggle is remembered per tool.
 * ─────────────────────────────────────────────────────────────────── */

type AnchorDeps = {
  captureRange: typeof import('@/lib/workspace/rewrite-anchor').captureRange;
  applyRewrite: typeof import('@/lib/workspace/rewrite-anchor').applyRewrite;
  resolveRewriteRange: typeof import('@/lib/workspace/rewrite-anchor').resolveRewriteRange;
};
let anchorDepsPromise: Promise<AnchorDeps> | null = null;
function loadAnchorDeps(): Promise<AnchorDeps> {
  anchorDepsPromise ??= import('@/lib/workspace/rewrite-anchor').then((anchor) => ({
    captureRange: anchor.captureRange,
    applyRewrite: anchor.applyRewrite,
    resolveRewriteRange: anchor.resolveRewriteRange,
  }));
  return anchorDepsPromise;
}

/* Squiggly underlines over flagged quotes, mapped through edits like any
 * other decoration set. One plugin per editor, (re)filled via meta. */
const factcheckHighlightKey = new PluginKey<DecorationSet>('factcheckHighlights');

function makeHighlightPlugin() {
  return new Plugin<DecorationSet>({
    key: factcheckHighlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta(factcheckHighlightKey) as
          | { set?: { from: number; to: number; verdict: string }[]; clear?: boolean }
          | undefined;
        if (meta?.clear) return DecorationSet.empty;
        if (meta?.set) {
          return DecorationSet.create(
            tr.doc,
            meta.set.map((range) =>
              Decoration.inline(range.from, range.to, {
                class: `sd-factcheck-underline sd-factcheck-${range.verdict}`,
              }),
            ),
          );
        }
        return set.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return factcheckHighlightKey.getState(state);
      },
    },
  });
}

type FindingState = 'open' | 'applying' | 'applied' | 'rejected' | 'stale';

type FactcheckRun = {
  id: string;
  capture: RewriteSelectionCapture;
  path: string | null;
  phase: 'checking' | 'results' | 'error';
  error: string | null;
  result: FactcheckResponse | null;
  findingStates: Record<number, FindingState>;
  /** Per-claim Yjs-anchored captures — applying one fix must not strand the
   *  others (whole-passage anchors stop resolving after the first edit). */
  claimCaptures: Map<number, RewriteSelectionCapture>;
  startedAt: number;
};

type FloatingPos = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

const POPUP_WIDTH = 460;
const POPUP_CLEARANCE = 300;

const VERDICT_STYLE: Record<string, { label: string; chip: string }> = {
  inaccurate: { label: 'Inaccurate', chip: 'bg-red-50 text-red-600' },
  unsupported: { label: 'Unsupported', chip: 'bg-amber-50 text-amber-700' },
  accurate: { label: 'Verified', chip: 'bg-emerald-50 text-emerald-700' },
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function EditorFactcheckPopup({
  editor,
  projectId,
  filePath,
}: {
  editor: Editor;
  projectId: string | null;
  filePath: string | null;
}) {
  const apiFetch = useApiFetch();
  const [runs, setRuns] = useState<FactcheckRun[]>([]);
  const [docked, setDocked] = useState(false);
  const [floatingPos, setFloatingPos] = useState<FloatingPos | null>(null);
  // Clock for the elapsed indicator — state, not Date.now() in render
  // (render must stay pure); null until the first tick effect runs.
  const [now, setNow] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { frameStyle, startMove, startResize } = usePopupFrame(boxRef, floatingPos);
  const runsRef = useRef<FactcheckRun[]>([]);
  runsRef.current = runs;
  const abortersRef = useRef<Map<string, AbortController>>(new Map());

  // File/workspace switches unmount the keyed editor without closing runs —
  // kill every in-flight research call so the server stops paid work.
  useEffect(() => {
    const aborters = abortersRef.current;
    return () => aborters.forEach((controller) => controller.abort());
  }, []);

  useEffect(() => {
    setDocked(readDockPreference('factcheck'));
  }, []);

  // The squiggle plugin lives exactly as long as this panel component.
  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.registerPlugin(makeHighlightPlugin());
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(factcheckHighlightKey);
    };
  }, [editor]);

  /** Paint the union of every run's still-open findings. */
  const paintAll = useCallback(
    async (current: FactcheckRun[]) => {
      const { resolveRewriteRange } = await loadAnchorDeps();
      // A close/replace may have landed while the import was pending — a
      // stale snapshot must not repaint squiggles that were just cleared.
      if (editor.isDestroyed || runsRef.current !== current) return;
      const ranges: { from: number; to: number; verdict: string }[] = [];
      for (const run of current) {
        for (const [index, claimCapture] of run.claimCaptures) {
          const claim = run.result?.claims[index];
          const findingState = run.findingStates[index] ?? 'open';
          if (!claim || findingState === 'applied' || findingState === 'rejected') continue;
          const range = resolveRewriteRange(editor, claimCapture);
          if (range) ranges.push({ ...range, verdict: claim.verdict });
        }
      }
      editor.view.dispatch(editor.state.tr.setMeta(factcheckHighlightKey, { set: ranges }));
    },
    [editor],
  );

  const patchRun = useCallback(
    (id: string, patch: Partial<FactcheckRun>) => {
      setRuns((prev) => prev.map((run) => (run.id === id ? { ...run, ...patch } : run)));
    },
    [],
  );

  const runCheck = useCallback(
    (run: FactcheckRun) => {
      const controller = new AbortController();
      abortersRef.current.set(run.id, controller);
      void (async () => {
        const response = await apiFetch('/api/workspace/factcheck', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            projectId,
            filePath: run.path,
            // Plain text, not markdown: quotes come back as exact substrings
            // and get located against the doc's TEXT nodes.
            text: run.capture.quote,
            contextBefore: run.capture.contextBefore,
            contextAfter: run.capture.contextAfter,
          }),
        });
        if (!response.ok) {
          const reason = await response
            .json()
            .then((data: { error?: string }) => data?.error)
            .catch(() => null);
          throw new Error(
            reason === 'signin_required'
              ? 'Sign in to use the factchecker.'
              : reason === 'out_of_credits'
                ? 'Out of credits.'
                : 'The factcheck failed. Try again.',
          );
        }
        const data = (await response.json()) as FactcheckResponse;
        if (controller.signal.aborted) return;
        // Locate every flagged claim NOW (per-claim Yjs anchors).
        const { captureRange, resolveRewriteRange } = await loadAnchorDeps();
        const claimCaptures = new Map<number, RewriteSelectionCapture>();
        if (!editor.isDestroyed) {
          const range = resolveRewriteRange(editor, run.capture);
          if (range) {
            data.claims.forEach((claim, index) => {
              if (claim.verdict === 'accurate') return;
              const found = findTextOccurrencesInRange(
                editor.state.doc,
                range.from,
                range.to,
                claim.quote,
              );
              // Anchor only UNIQUE matches: with duplicates the model may
              // mean a later occurrence, and fixing found[0] would rewrite
              // the wrong claim. Ambiguous quotes stay listed without an
              // Apply button (same stale-over-wrong stance as rewrite).
              if (found.length === 1) {
                claimCaptures.set(index, captureRange(editor, found[0].from, found[0].to));
              }
            });
          }
        }
        setRuns((prev) => {
          const next = prev.map((candidate) =>
            candidate.id === run.id
              ? { ...candidate, phase: 'results' as const, result: data, claimCaptures }
              : candidate,
          );
          void paintAll(next);
          return next;
        });
      })().catch((err: unknown) => {
        if (controller.signal.aborted) return;
        patchRun(run.id, {
          phase: 'error',
          error: err instanceof Error ? err.message : 'The factcheck failed. Try again.',
        });
      });
    },
    [apiFetch, editor, paintAll, patchRun, projectId],
  );

  // Open on the bubble menu's event (scoped to this editor instance).
  useEffect(() => {
    const onOpen = (event: Event) => {
      if (editor.isDestroyed) return;
      const detail = (event as CustomEvent<{ capture?: RewriteSelectionCapture; source?: Element }>)
        .detail;
      if (!detail?.capture) return;
      if (detail.source && detail.source !== editor.view.dom) return;
      let coords = { left: 8, top: 0, bottom: 8 };
      try {
        coords = editor.view.coordsAtPos(editor.state.selection.from);
      } catch {
        // jsdom / detached view: keep the fallback corner position.
      }
      const roomBelow = window.innerHeight - coords.bottom - 24;
      const roomAbove = coords.top - 24;
      const flipUp = roomBelow < POPUP_CLEARANCE && roomAbove > roomBelow;
      const maxHeight = Math.round(
        Math.max(0, Math.min(flipUp ? roomAbove : roomBelow, window.innerHeight - 32)),
      );
      const width = Math.min(POPUP_WIDTH, window.innerWidth - 16);
      setFloatingPos({
        left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)),
        width,
        maxHeight,
        ...(flipUp ? { bottom: window.innerHeight - coords.top + 8 } : { top: coords.bottom + 8 }),
      });
      const run: FactcheckRun = {
        id: crypto.randomUUID(),
        capture: detail.capture,
        path: filePath,
        phase: 'checking',
        error: null,
        result: null,
        findingStates: {},
        claimCaptures: new Map(),
        startedAt: Date.now(),
      };
      if (detail.capture.quote.length > MAX_FACTCHECK_TEXT_CHARS) {
        run.phase = 'error';
        run.error = 'Selection is too long to factcheck. Pick a shorter passage.';
      }
      setRuns((prev) => {
        // Floating shows ONE check; the dock stacks them.
        const kept = readDockPreference('factcheck') ? prev : [];
        for (const old of prev) {
          if (!kept.includes(old)) abortersRef.current.get(old.id)?.abort();
        }
        const next = [...kept, run];
        // Repaint from the surviving runs NOW — a discarded run's squiggles
        // must not linger while the new check runs (or forever, if it errors).
        void paintAll(next);
        return next;
      });
      void loadAnchorDeps();
      if (run.phase === 'checking') runCheck(run);
    };
    window.addEventListener('sundial:open-factcheck', onOpen);
    return () => window.removeEventListener('sundial:open-factcheck', onOpen);
  }, [editor, filePath, paintAll, runCheck]);

  const open = runs.length > 0;

  // Elapsed ticker while any run is researching.
  useEffect(() => {
    if (!open || !runs.some((run) => run.phase === 'checking')) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, runs]);

  const closeRun = useCallback(
    (id: string) => {
      abortersRef.current.get(id)?.abort();
      abortersRef.current.delete(id);
      setRuns((prev) => {
        const next = prev.filter((run) => run.id !== id);
        void paintAll(next);
        return next;
      });
    },
    [paintAll],
  );

  const closeAll = useCallback(() => {
    for (const controller of abortersRef.current.values()) controller.abort();
    abortersRef.current.clear();
    setRuns([]);
    if (!editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(factcheckHighlightKey, { clear: true }));
    }
  }, [editor]);

  const toggleDock = useCallback(() => {
    setDocked((prev) => {
      const next = !prev;
      writeDockPreference('factcheck', next);
      // Undocking collapses to the most recent run — the floating popup is a
      // single-check surface.
      if (!next) {
        setRuns((current) => {
          const keep = current.slice(-1);
          for (const run of current.slice(0, -1)) abortersRef.current.get(run.id)?.abort();
          void paintAll(keep);
          return keep;
        });
      }
      return next;
    });
  }, [paintAll]);

  // Esc closes everything; floating mode also closes on outside click —
  // the SAME contract as every other AI popup (the dock is the way to keep
  // it around while working in the doc).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeAll();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [open, closeAll]);

  useEffect(() => {
    if (!open || docked) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && boxRef.current?.contains(target)) return;
      closeAll();
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () =>
      window.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
  }, [open, docked, closeAll]);

  const postFeedback = useCallback(
    (run: FactcheckRun, claim: FactcheckClaim, decision: 'applied' | 'rejected') => {
      if (!projectId) return;
      void apiFetch('/api/workspace/factcheck/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          projectId,
          filePath: run.path,
          quote: claim.quote,
          verdict: claim.verdict,
          correction: claim.correction,
          explanation: claim.explanation,
          decision,
        }),
      }).catch(() => {});
    },
    [apiFetch, projectId],
  );

  const setFindingState = useCallback(
    (runId: string, index: number, findingState: FindingState) => {
      setRuns((prev) => {
        const next = prev.map((run) =>
          run.id === runId
            ? { ...run, findingStates: { ...run.findingStates, [index]: findingState } }
            : run,
        );
        void paintAll(next);
        return next;
      });
    },
    [paintAll],
  );

  const applyFix = useCallback(
    async (run: FactcheckRun, index: number, claim: FactcheckClaim) => {
      if (!claim.correction) return;
      setFindingState(run.id, index, 'applying');
      const { applyRewrite } = await loadAnchorDeps();
      const claimCapture = run.claimCaptures.get(index);
      const applied = claimCapture ? applyRewrite(editor, claimCapture, claim.correction) : null;
      if (!applied) {
        setFindingState(run.id, index, 'stale');
        return;
      }
      postFeedback(run, claim, 'applied');
      setFindingState(run.id, index, 'applied');
    },
    [editor, postFeedback, setFindingState],
  );

  const rejectFinding = useCallback(
    (run: FactcheckRun, index: number, claim: FactcheckClaim) => {
      postFeedback(run, claim, 'rejected');
      setFindingState(run.id, index, 'rejected');
    },
    [postFeedback, setFindingState],
  );

  if (!open) return null;

  const dockButton = (
    <button
      type="button"
      aria-label={docked ? 'Float near the selection' : 'Dock to the side'}
      title={docked ? 'Float near the selection' : 'Dock to the side'}
      data-testid="factcheck-dock-toggle"
      onClick={toggleDock}
      className={`rounded-md p-1 ${docked ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'}`}
    >
      <SidebarSimpleIcon className="h-4 w-4" mirrored />
    </button>
  );

  const runCard = (run: FactcheckRun) => {
    const claims = run.result?.claims ?? [];
    const flagged = claims
      .map((claim, index) => ({ claim, index }))
      .filter(({ claim }) => claim.verdict !== 'accurate');
    const verified = claims.filter((claim) => claim.verdict === 'accurate');
    const snippet = run.capture.quote.trim().replace(/\s+/g, ' ');
    return (
      <div key={run.id} data-testid="factcheck-run" className="border-b border-stone-100 last:border-b-0">
        <div className="flex items-center gap-2 px-3 pt-2">
          <p className="min-w-0 flex-1 truncate text-[12px] italic text-stone-400">
            “{snippet.length > 64 ? `${snippet.slice(0, 64)}…` : snippet}”
          </p>
          {run.phase === 'results' && (
            <span className="shrink-0 text-[12px] text-stone-400">
              {flagged.length === 0
                ? 'clean'
                : `${flagged.length} finding${flagged.length === 1 ? '' : 's'}`}
            </span>
          )}
          <button
            type="button"
            aria-label="Close this check"
            onClick={() => closeRun(run.id)}
            className="shrink-0 rounded-md p-0.5 text-stone-300 hover:text-stone-500"
          >
            <XIcon className="h-3 w-3" />
          </button>
        </div>

        {run.phase === 'checking' && (
          <div className="flex items-center gap-2.5 px-3 py-4">
            <SpinnerGapIcon className="h-4 w-4 animate-spin text-beige-600" />
            <p className="text-[13px] text-stone-500">
              Researching the claims…
              <span className="ml-1 text-stone-400">
                {Math.max(0, Math.round(((now ?? run.startedAt) - run.startedAt) / 1000))}s
              </span>
            </p>
          </div>
        )}

        {run.phase === 'error' && <p className="px-3 py-3 text-[13px] text-stone-500">{run.error}</p>}

        {run.phase === 'results' && run.result && (
          <div className="p-2">
            {flagged.length === 0 && (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50/60 px-3 py-2.5">
                <CheckCircleIcon className="h-4 w-4 text-emerald-600" weight="fill" />
                <p className="text-[14px] text-emerald-800">
                  Nothing inaccurate found
                  {verified.length > 0 ? ': key claims verified against sources' : ''}.
                </p>
              </div>
            )}
            {flagged.map(({ claim, index }) => {
              const style = VERDICT_STYLE[claim.verdict];
              const findingState = run.findingStates[index] ?? 'open';
              const settled = findingState === 'applied' || findingState === 'rejected';
              return (
                <div
                  key={index}
                  data-testid={`factcheck-finding-${index}`}
                  className={`mb-1.5 rounded-lg border p-2 last:mb-0 ${
                    settled ? 'border-stone-100 opacity-60' : 'border-stone-200'
                  }`}
                >
                  <div className="mb-1 flex items-center gap-1.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${style.chip}`}
                    >
                      {style.label}
                    </span>
                    <span className="text-[11px] text-stone-400">{claim.confidence} confidence</span>
                    {findingState === 'applied' && (
                      <span className="text-[11px] font-medium text-emerald-600">fixed</span>
                    )}
                    {findingState === 'rejected' && (
                      <span className="text-[11px] font-medium text-stone-400">
                        dismissed · won’t flag again
                      </span>
                    )}
                    {findingState === 'stale' && (
                      <span className="text-[11px] font-medium text-amber-600">
                        text changed · couldn’t apply
                      </span>
                    )}
                  </div>
                  <p className="text-[14px] leading-6 text-stone-700">
                    <WarningCircleIcon className="mr-1 inline h-3.5 w-3.5 text-stone-400" />
                    <span className="rounded bg-stone-100 px-1 py-0.5 text-[13.5px]">
                      {claim.quote.length > 140 ? `${claim.quote.slice(0, 140)}…` : claim.quote}
                    </span>
                  </p>
                  <p className="mt-1 text-[14px] leading-6 text-stone-600">{claim.explanation}</p>
                  {claim.correction && findingState !== 'applied' && (
                    <p className="mt-1 text-[14px] leading-6">
                      <span className="font-medium text-stone-500">Fix: </span>
                      <span className="text-emerald-700">{claim.correction}</span>
                    </p>
                  )}
                  {claim.sources.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {claim.sources.map((n) => {
                        const source = run.result?.sources[n - 1];
                        if (!source) return null;
                        return (
                          <a
                            key={n}
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-0.5 rounded-full border border-stone-200 px-1.5 py-0.5 text-[11px] text-stone-500 hover:border-stone-300 hover:text-stone-700"
                          >
                            {hostOf(source.url)}
                            <ArrowSquareOutIcon className="h-2.5 w-2.5" />
                          </a>
                        );
                      })}
                    </div>
                  )}
                  {!settled && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      {claim.correction && run.claimCaptures.has(index) && (
                        <button
                          type="button"
                          data-testid={`factcheck-apply-${index}`}
                          disabled={findingState === 'applying'}
                          onClick={() => void applyFix(run, index, claim)}
                          className="rounded-lg bg-beige-600 px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40"
                        >
                          {findingState === 'applying' ? 'Applying…' : 'Apply fix'}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label="Reject this finding"
                        onClick={() => rejectFinding(run, index, claim)}
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                      >
                        <ThumbsDownIcon className="h-3 w-3" />
                        Not helpful
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {verified.length > 0 && flagged.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1 px-1">
                {verified.map((claim, i) => (
                  <span
                    key={i}
                    title={claim.explanation}
                    className="flex items-center gap-1 rounded-full bg-emerald-50/70 px-2 py-0.5 text-[11px] text-emerald-700"
                  >
                    <CheckCircleIcon className="h-3 w-3" weight="fill" />
                    {claim.quote.length > 48 ? `${claim.quote.slice(0, 48)}…` : claim.quote}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const panel = (
    <div
      ref={boxRef}
      data-testid="factcheck-popup"
      className={`pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_4px_16px_rgba(28,25,23,0.16)] ${
        docked ? 'max-h-full' : 'fixed z-50'
      }`}
      style={
        docked
          ? undefined
          : {
              left: floatingPos?.left,
              width: floatingPos?.width,
              maxHeight: floatingPos?.maxHeight,
              ...(floatingPos?.top !== undefined ? { top: floatingPos.top } : {}),
              ...(floatingPos?.bottom !== undefined ? { bottom: floatingPos.bottom } : {}),
              ...frameStyle,
            }
      }
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        onPointerDown={docked ? undefined : startMove}
        className={`flex items-center gap-2 border-b border-stone-100 px-3 py-2 ${
          docked ? '' : 'cursor-grab select-none active:cursor-grabbing'
        }`}
      >
        <DetectiveIcon className="h-4 w-4 text-beige-600" weight="regular" />
        <span className="text-[14px] font-semibold text-stone-800">Factcheck</span>
        <div className="ml-auto flex items-center gap-0.5">
          {dockButton}
          <button
            type="button"
            aria-label="Close"
            onClick={closeAll}
            className="rounded-md p-1 text-stone-400 hover:text-stone-600"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto">{[...runs].reverse().map(runCard)}</div>
      {!docked && <PopupResizeHandle onPointerDown={startResize} />}
    </div>
  );

  if (docked) {
    const container = getAiDockContainer();
    return container ? createPortal(panel, container) : panel;
  }
  return panel;
}
