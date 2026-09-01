'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { RadioactiveIcon, RobotIcon, SpinnerGapIcon, XIcon } from '@phosphor-icons/react';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import {
  MAX_PANGRAM_TEXT_CHARS,
  MIN_PANGRAM_TEXT_CHARS,
  createHumanizeStreamParser,
  isFlaggedLabel,
  type PangramCheckResponse,
} from '@/lib/workspace/pangram';
import { findTextOccurrencesInRange } from '@/lib/workspace/text-locate';
import type { RewriteSelectionCapture } from '@/lib/workspace/rewrite-anchor';
import { PopupResizeHandle, usePopupFrame } from '@/components/workspace/use-popup-frame';

/* ── Pangram popup ────────────────────────────────────────────────────
 *  AI-writing detection over the selection (Pangram), with an adversarial
 *  "humanize" loop: flagged segments get highlighted in the editor, and one
 *  click rewrites a segment repeatedly — each attempt re-scored by the
 *  detector — until it reads as human, then applies through the normal
 *  markdown-preserving anchor path.
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

const pangramHighlightKey = new PluginKey<DecorationSet>('pangramHighlights');

function makeHighlightPlugin() {
  return new Plugin<DecorationSet>({
    key: pangramHighlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta(pangramHighlightKey) as
          | { set?: { from: number; to: number; assisted: boolean }[]; clear?: boolean }
          | undefined;
        if (meta?.clear) return DecorationSet.empty;
        if (meta?.set) {
          return DecorationSet.create(
            tr.doc,
            meta.set.map((range) =>
              Decoration.inline(range.from, range.to, {
                class: range.assisted ? 'sd-pangram-assisted' : 'sd-pangram-ai',
              }),
            ),
          );
        }
        return set.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return pangramHighlightKey.getState(state);
      },
    },
  });
}

type OpenState = {
  capture: RewriteSelectionCapture;
  path: string | null;
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

type HumanizeState = {
  /** Segment index being humanized, or -1 for the whole selection. */
  target: number;
  attempt: number;
  streamingText: string;
  scores: number[];
  result: { text: string; aiLikelihood: number; passed: boolean } | null;
  error: string | null;
  applying: boolean;
  stale: boolean;
};

const POPUP_WIDTH = 440;
const POPUP_CLEARANCE = 300;

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function EditorPangramPopup({
  editor,
  projectId,
  filePath,
}: {
  editor: Editor;
  projectId: string | null;
  filePath: string | null;
}) {
  const apiFetch = useApiFetch();
  const [state, setState] = useState<OpenState | null>(null);
  const [phase, setPhase] = useState<'checking' | 'results' | 'error'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PangramCheckResponse | null>(null);
  const [humanize, setHumanize] = useState<HumanizeState | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { frameStyle, startMove, startResize } = usePopupFrame(boxRef, state);
  const abortRef = useRef<AbortController | null>(null);

  // File/workspace switches unmount the keyed editor without close() — kill
  // any in-flight check/humanize so the server stops paid work.
  useEffect(() => () => abortRef.current?.abort(), []);
  // Per-segment Yjs-anchored captures, built when results land (index -1 =
  // the whole selection) — highlighting and humanize-apply both use them.
  const segmentCapturesRef = useRef<Map<number, RewriteSelectionCapture>>(new Map());
  // The render reads the ref (Humanize buttons only show for located
  // segments), so locating must bump state or the buttons never appear.
  const [, setLocatedTick] = useState(0);

  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.registerPlugin(makeHighlightPlugin());
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(pangramHighlightKey);
    };
  }, [editor]);

  const clearHighlights = useCallback(() => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(pangramHighlightKey, { clear: true }));
  }, [editor]);

  const locateAndPaint = useCallback(
    async (capture: RewriteSelectionCapture, data: PangramCheckResponse, signal: AbortSignal) => {
      const { captureRange, resolveRewriteRange } = await loadAnchorDeps();
      // Superseded (new check) or closed while the import was pending — a
      // stale run must not reset captures or repaint highlights.
      if (editor.isDestroyed || signal.aborted) return;
      segmentCapturesRef.current = new Map();
      const range = resolveRewriteRange(editor, capture);
      const ranges: { from: number; to: number; assisted: boolean }[] = [];
      if (range) {
        segmentCapturesRef.current.set(-1, capture);
        // Windows arrive in document order — walk EVERY window (flagged or
        // not) with a forward-moving cursor, so repeated text maps each
        // window to its own occurrence instead of all landing on the first.
        let searchFrom = range.from;
        data.windows.forEach((window, index) => {
          // Pangram may normalize whitespace — try the raw text, then a
          // trimmed version; segments that still don't match just don't get
          // an editor highlight (they stay listed in the panel).
          const needle = window.text;
          const found =
            findTextOccurrencesInRange(editor.state.doc, searchFrom, range.to, needle)[0] ??
            findTextOccurrencesInRange(editor.state.doc, searchFrom, range.to, needle.trim())[0];
          if (!found) return;
          searchFrom = found.to;
          if (!isFlaggedLabel(window.label)) return;
          segmentCapturesRef.current.set(index, captureRange(editor, found.from, found.to));
          ranges.push({ ...found, assisted: /assisted/i.test(window.label) });
        });
      }
      // Paint + tick even when the selection no longer resolves: the empty
      // set clears the previous run's highlights, and the render must see
      // the emptied captures instead of the old run's Humanize anchors.
      editor.view.dispatch(editor.state.tr.setMeta(pangramHighlightKey, { set: ranges }));
      setLocatedTick((tick) => tick + 1);
    },
    [editor],
  );

  const runCheck = useCallback(
    (capture: RewriteSelectionCapture, path: string | null) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPhase('checking');
      setError(null);
      setResult(null);
      setHumanize(null);
      // Kill the previous run's anchors and highlights NOW — new results
      // render before the async locate pass finishes, a Humanize click in
      // that window must not act on the old selection's captures, and the
      // old purple washes must not linger if this run short-circuits.
      segmentCapturesRef.current = new Map();
      setLocatedTick((tick) => tick + 1);
      clearHighlights();
      if (capture.quote.length < MIN_PANGRAM_TEXT_CHARS) {
        setPhase('error');
        setError('Select a longer passage. The detector needs at least a paragraph.');
        return;
      }
      if (capture.quote.length > MAX_PANGRAM_TEXT_CHARS) {
        setPhase('error');
        setError('Selection is too long. Check a section at a time.');
        return;
      }
      void (async () => {
        const response = await apiFetch('/api/workspace/pangram-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ projectId, filePath: path, text: capture.quote }),
        });
        if (!response.ok) {
          const reason = await response
            .json()
            .then((data: { error?: string }) => data?.error)
            .catch(() => null);
          throw new Error(
            reason === 'pangram_unconfigured'
              ? 'Pangram is not configured on this server.'
              : reason === 'signin_required'
                ? 'Sign in to use AI detection.'
                : reason === 'out_of_credits'
                  ? 'Out of credits.'
                  : 'The detection check failed. Try again.',
          );
        }
        const data = (await response.json()) as PangramCheckResponse;
        if (controller.signal.aborted) return;
        setResult(data);
        setPhase('results');
        void locateAndPaint(capture, data, controller.signal);
      })().catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setPhase('error');
        setError(err instanceof Error ? err.message : 'The detection check failed. Try again.');
      });
    },
    [apiFetch, clearHighlights, locateAndPaint, projectId],
  );

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
      setState({
        capture: detail.capture,
        path: filePath,
        left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)),
        width,
        maxHeight,
        ...(flipUp ? { bottom: window.innerHeight - coords.top + 8 } : { top: coords.bottom + 8 }),
      });
      void loadAnchorDeps();
      runCheck(detail.capture, filePath);
    };
    window.addEventListener('sundial:open-pangram', onOpen);
    return () => window.removeEventListener('sundial:open-pangram', onOpen);
  }, [editor, filePath, runCheck]);

  const open = state !== null;

  const close = useCallback(() => {
    abortRef.current?.abort();
    clearHighlights();
    setState(null);
    setResult(null);
    setHumanize(null);
  }, [clearHighlights]);

  // Esc closes; outside click closes too — the same contract as every
  // other AI popup.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && boxRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () =>
      window.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
  }, [open, close]);

  const startHumanize = useCallback(
    (target: number) => {
      if (!state) return;
      const targetCapture = segmentCapturesRef.current.get(target);
      if (!targetCapture) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setHumanize({
        target,
        attempt: 0,
        streamingText: '',
        scores: [],
        result: null,
        error: null,
        applying: false,
        stale: false,
      });
      const parser = createHumanizeStreamParser((event) => {
        if (event.type === 'attempt-start') {
          setHumanize((prev) =>
            prev ? { ...prev, attempt: event.attempt, streamingText: '' } : prev,
          );
        } else if (event.type === 'delta') {
          setHumanize((prev) =>
            prev ? { ...prev, streamingText: prev.streamingText + event.text } : prev,
          );
        } else if (event.type === 'score') {
          setHumanize((prev) =>
            prev ? { ...prev, scores: [...prev.scores, event.aiLikelihood] } : prev,
          );
        } else if (event.type === 'result') {
          setHumanize((prev) =>
            prev
              ? {
                  ...prev,
                  result: {
                    text: event.text,
                    aiLikelihood: event.aiLikelihood,
                    passed: event.passed,
                  },
                }
              : prev,
          );
        } else if (event.type === 'error') {
          setHumanize((prev) => (prev ? { ...prev, error: 'Humanize failed. Try again.' } : prev));
        }
      });
      void (async () => {
        const response = await apiFetch('/api/workspace/humanize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            projectId,
            filePath: state.path,
            // Markdown so structure survives the rewrite round trip.
            text: targetCapture.text,
          }),
        });
        if (!response.ok || !response.body) {
          const reason = await response
            .json()
            .then((data: { error?: string }) => data?.error)
            .catch(() => null);
          throw new Error(
            reason === 'signin_required'
              ? 'Sign in to humanize.'
              : reason === 'out_of_credits'
                ? 'Out of credits.'
                : 'Humanize failed. Try again.',
          );
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.flush();
      })().catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setHumanize((prev) =>
          prev
            ? { ...prev, error: err instanceof Error ? err.message : 'Humanize failed. Try again.' }
            : prev,
        );
      });
    },
    [apiFetch, projectId, state],
  );

  const applyHumanized = useCallback(() => {
    if (!humanize?.result) return;
    const targetCapture = segmentCapturesRef.current.get(humanize.target);
    if (!targetCapture) return;
    setHumanize((prev) => (prev ? { ...prev, applying: true } : prev));
    void loadAnchorDeps().then(({ applyRewrite }) => {
      const applied = applyRewrite(editor, targetCapture, humanize.result!.text.trim());
      if (!applied) {
        setHumanize((prev) => (prev ? { ...prev, applying: false, stale: true } : prev));
        return;
      }
      // The doc changed — old highlights are stale; close the loop cleanly.
      close();
    });
  }, [close, editor, humanize]);

  if (!state) return null;

  const flaggedSegments = (result?.windows ?? [])
    .map((window, index) => ({ window, index }))
    .filter(({ window }) => isFlaggedLabel(window.label));
  const humanFraction = result ? Math.max(0, 1 - result.fractionAi - result.fractionAiAssisted) : 1;

  return (
    <div
      ref={boxRef}
      data-testid="pangram-popup"
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_4px_16px_rgba(28,25,23,0.16)]"
      style={{
        left: state.left,
        width: state.width,
        maxHeight: state.maxHeight,
        ...(state.top !== undefined ? { top: state.top } : {}),
        ...(state.bottom !== undefined ? { bottom: state.bottom } : {}),
        ...frameStyle,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        onPointerDown={startMove}
        className="flex cursor-grab select-none items-center gap-2 border-b border-stone-100 px-3 py-2 active:cursor-grabbing"
      >
        <RobotIcon className="h-4 w-4 text-purple-600" weight="regular" />
        <span className="text-[14px] font-semibold text-stone-800">AI detection</span>
        {phase === 'results' && result && (
          <span className="text-[12px] text-stone-400">{result.headline}</span>
        )}
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className="ml-auto rounded-md p-1 text-stone-400 hover:text-stone-600"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {phase === 'checking' && (
        <div className="flex items-center gap-2.5 px-3 py-5">
          <SpinnerGapIcon className="h-4 w-4 animate-spin text-purple-600" />
          <p className="text-[13px] text-stone-500">Running the passage through Pangram…</p>
        </div>
      )}

      {phase === 'error' && <p className="px-3 py-4 text-[13px] text-stone-500">{error}</p>}

      {phase === 'results' && result && !humanize && (
        <div className="min-h-0 overflow-y-auto p-3">
          {/* Composition meter: human / AI-assisted / AI. */}
          <div className="mb-1.5 flex h-2 overflow-hidden rounded-full bg-stone-100">
            {humanFraction > 0 && (
              <span className="h-full bg-emerald-400/70" style={{ width: pct(humanFraction) }} />
            )}
            {result.fractionAiAssisted > 0 && (
              <span
                className="h-full bg-purple-300/70"
                style={{ width: pct(result.fractionAiAssisted) }}
              />
            )}
            {result.fractionAi > 0 && (
              <span className="h-full bg-purple-500/80" style={{ width: pct(result.fractionAi) }} />
            )}
          </div>
          <div className="mb-2 flex items-center gap-3 text-[10px] text-stone-500">
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-400/70" />
              human {pct(humanFraction)}
            </span>
            {result.fractionAiAssisted > 0 && (
              <span>
                <span className="mr-1 inline-block h-2 w-2 rounded-full bg-purple-300/70" />
                assisted {pct(result.fractionAiAssisted)}
              </span>
            )}
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-purple-500/80" />
              AI {pct(result.fractionAi)}
            </span>
          </div>

          {flaggedSegments.length === 0 ? (
            <p className="rounded-lg bg-emerald-50/60 px-3 py-2.5 text-[14px] text-emerald-800">
              Reads as human-written throughout. Nothing to fix.
            </p>
          ) : (
            <>
              {flaggedSegments.map(({ window, index }) => (
                <div
                  key={index}
                  data-testid={`pangram-segment-${index}`}
                  className="mb-1.5 rounded-lg border border-purple-100 bg-purple-50/40 p-2 last:mb-0"
                >
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700">
                      {window.label}
                    </span>
                    <span className="text-[10px] text-stone-400">
                      {window.confidence.toLowerCase()} confidence
                      {window.isHumanized ? ' · humanizer detected' : ''}
                    </span>
                  </div>
                  <p className="text-[14px] leading-6 text-stone-600">
                    {window.text.length > 180 ? `${window.text.slice(0, 180)}…` : window.text}
                  </p>
                  {segmentCapturesRef.current.has(index) && (
                    <button
                      type="button"
                      data-testid={`pangram-humanize-${index}`}
                      onClick={() => startHumanize(index)}
                      className="mt-1.5 flex items-center gap-1 rounded-lg bg-purple-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-purple-700"
                    >
                      <RadioactiveIcon className="h-3 w-3" />
                      Humanize
                    </button>
                  )}
                </div>
              ))}
              {flaggedSegments.length > 1 && segmentCapturesRef.current.has(-1) && (
                <button
                  type="button"
                  onClick={() => startHumanize(-1)}
                  className="mt-1 w-full rounded-lg border border-purple-200 px-2.5 py-1.5 text-[11px] font-medium text-purple-700 hover:bg-purple-50"
                >
                  Humanize the whole selection
                </button>
              )}
            </>
          )}
        </div>
      )}

      {humanize && (
        <div className="min-h-0 overflow-y-auto p-3">
          <div className="mb-2 flex items-center gap-2">
            {!humanize.result && !humanize.error && (
              <SpinnerGapIcon className="h-3.5 w-3.5 animate-spin text-purple-600" />
            )}
            <span className="text-[13px] font-medium text-stone-700">
              {humanize.error
                ? humanize.error
                : humanize.result
                  ? humanize.result.passed
                    ? 'Passes as human'
                    : 'Best attempt (still flagged)'
                  : `Attempt ${humanize.attempt || 1}: rewriting, then re-scoring…`}
            </span>
          </div>
          {humanize.scores.length > 0 && (
            <div className="mb-2 flex items-center gap-1.5">
              {humanize.scores.map((score, i) => (
                <span
                  key={i}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    score < 0.25 ? 'bg-emerald-50 text-emerald-700' : 'bg-purple-50 text-purple-700'
                  }`}
                >
                  #{i + 1}: {pct(score)} AI
                </span>
              ))}
            </div>
          )}
          <div className="rounded-lg bg-stone-50/60 p-2">
            <p className="whitespace-pre-wrap text-[14.5px] leading-6 text-stone-800">
              {humanize.result?.text ?? humanize.streamingText ?? '…'}
            </p>
          </div>
          {humanize.stale && (
            <p className="mt-1.5 text-[11px] text-amber-600">
              The text changed underneath. Reselect and rerun.
            </p>
          )}
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                // A humanize attempt may still be streaming (3 rewrites +
                // Pangram scoring, all billed) — kill it, don't orphan it.
                abortRef.current?.abort();
                setHumanize(null);
              }}
              className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-stone-500 hover:bg-stone-100"
            >
              Back
            </button>
            <button
              type="button"
              data-testid="pangram-apply"
              onClick={applyHumanized}
              disabled={!humanize.result || humanize.applying}
              className="rounded-lg bg-purple-600 px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:bg-purple-700 disabled:opacity-40"
            >
              {humanize.result?.passed === false ? 'Apply best attempt' : 'Apply'}
            </button>
          </div>
        </div>
      )}
      <PopupResizeHandle onPointerDown={startResize} />
    </div>
  );
}
