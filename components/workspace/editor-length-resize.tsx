'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { ArrowsOutLineVerticalIcon, SpinnerGapIcon, XIcon } from '@phosphor-icons/react';
import {
  LENGTH_LEVELS,
  LENGTH_ORIGINAL_INDEX,
  MAX_MORPH_TEXT_CHARS,
  wordCount,
  type MorphRequestVariant,
} from '@/lib/workspace/ai-morph';
import { useMorphCache } from '@/components/workspace/use-morph-cache';
import type { RewriteSelectionCapture } from '@/lib/workspace/rewrite-anchor';
import { PopupResizeHandle, usePopupFrame } from '@/components/workspace/use-popup-frame';

/* ── Length resize popup ──────────────────────────────────────────────
 *  Select text, then drag to resize it — like an image, but the dimension
 *  is WORDS: drag the handle down/right to expand the passage, up/left to
 *  condense it, meaning preserved. Length lives on a quantized multiplier
 *  ladder (LENGTH_LEVELS); dragging snaps to rungs and each rung is a keyed
 *  morph variant, prefetched one step ahead so the drag feels live.
 * ─────────────────────────────────────────────────────────────────── */

type ApplyDeps = {
  applyRewrite: typeof import('@/lib/workspace/rewrite-anchor').applyRewrite;
};
let applyDepsPromise: Promise<ApplyDeps> | null = null;
function loadApplyDeps(): Promise<ApplyDeps> {
  applyDepsPromise ??= import('@/lib/workspace/rewrite-anchor').then((anchor) => ({
    applyRewrite: anchor.applyRewrite,
  }));
  return applyDepsPromise;
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

const POPUP_WIDTH = 440;
const POPUP_CLEARANCE = 240;

export function lengthVariantKey(index: number): string {
  return `len:${LENGTH_LEVELS[index]}`;
}

/** The rung itself plus its immediate neighbors — one prefetch wave.
 *  Exported for tests. */
export function lengthPrefetchWave(index: number): MorphRequestVariant[] {
  return [index, index - 1, index + 1]
    .filter((i) => i >= 0 && i < LENGTH_LEVELS.length && i !== LENGTH_ORIGINAL_INDEX)
    .map((i) => ({ key: lengthVariantKey(i), spec: { lengthFactor: LENGTH_LEVELS[i] } }));
}

export function EditorLengthResize({
  editor,
  projectId,
  filePath,
}: {
  editor: Editor;
  projectId: string | null;
  filePath: string | null;
}) {
  const [state, setState] = useState<OpenState | null>(null);
  const [level, setLevel] = useState(LENGTH_ORIGINAL_INDEX);
  const [stale, setStale] = useState(false);
  const [applying, setApplying] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { frameStyle, startMove, startResize } = usePopupFrame(boxRef, state);

  const capture = state?.capture ?? null;
  const morph = useMorphCache({ projectId, filePath: state?.path ?? null, capture });
  const morphRef = useRef(morph);
  morphRef.current = morph;

  const prefetch = useCallback((index: number) => {
    morphRef.current.request(lengthPrefetchWave(index));
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      if (editor.isDestroyed || !editor.isEditable) return;
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
      morphRef.current.reset();
      setLevel(LENGTH_ORIGINAL_INDEX);
      setStale(false);
      setApplying(false);
      setState({
        capture: detail.capture,
        path: filePath,
        left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)),
        width,
        maxHeight,
        ...(flipUp ? { bottom: window.innerHeight - coords.top + 8 } : { top: coords.bottom + 8 }),
      });
      void loadApplyDeps();
    };
    window.addEventListener('sundial:open-length-resize', onOpen);
    return () => window.removeEventListener('sundial:open-length-resize', onOpen);
  }, [editor, filePath]);

  const open = state !== null;

  // Prefetch the two adjacent rungs the moment the popup opens.
  useEffect(() => {
    if (!open || !capture) return;
    if (capture.text.length > MAX_MORPH_TEXT_CHARS) return;
    prefetch(LENGTH_ORIGINAL_INDEX);
  }, [open, capture, prefetch]);

  const close = useCallback(() => {
    morphRef.current.reset();
    setState(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && boxRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
    };
  }, [open, close]);

  const moveToLevel = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(LENGTH_LEVELS.length - 1, next));
      setLevel((current) => {
        if (current === clamped) return current;
        prefetch(clamped);
        return clamped;
      });
    },
    [prefetch],
  );

  const atOriginal = level === LENGTH_ORIGINAL_INDEX;
  const currentEntry = atOriginal ? null : morph.get(lengthVariantKey(level));
  const previewText = atOriginal ? (capture?.text ?? '') : (currentEntry?.text ?? '');
  const previewStreaming = !atOriginal && currentEntry?.status === 'streaming';
  const previewError =
    !atOriginal && currentEntry?.status === 'error' ? (currentEntry.message ?? 'The preview failed.') : null;
  const applicable =
    !atOriginal && currentEntry?.status === 'done' && !!currentEntry.text.trim() && !applying;

  const apply = useCallback(() => {
    if (!state || !applicable || !currentEntry) return;
    setApplying(true);
    void loadApplyDeps().then(({ applyRewrite }) => {
      const applied = applyRewrite(editor, state.capture, currentEntry.text.trim());
      if (!applied) {
        setApplying(false);
        setStale(true);
        return;
      }
      close();
    });
  }, [applicable, close, currentEntry, editor, state]);

  if (!state || !capture) return null;

  const tooLong = capture.text.length > MAX_MORPH_TEXT_CHARS;
  const originalWords = wordCount(capture.text);
  const previewWords = previewText ? wordCount(previewText) : 0;
  const factor = LENGTH_LEVELS[level];

  return (
    <div
      ref={boxRef}
      data-testid="length-resize-popup"
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
        <ArrowsOutLineVerticalIcon className="h-3.5 w-3.5 text-beige-600" />
        <span className="text-[12px] text-stone-500" data-testid="length-indicator">
          {atOriginal
            ? `${originalWords} words`
            : `${factor < 1 ? '−' : '+'} ${Math.round(Math.abs(factor - 1) * 100)}% · ${
                previewWords > 0 ? `${previewWords} words` : '…'
              }`}
        </span>
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className="ml-auto rounded-md p-1 text-stone-400 hover:text-stone-600"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {tooLong ? (
        <p className="px-3 py-4 text-[12px] text-stone-500">
          Selection is too long for live resizing. Pick a shorter passage.
        </p>
      ) : morph.fatalError ? (
        <p className="px-3 py-4 text-[12px] text-stone-500">{morph.fatalError}</p>
      ) : (
        <>
          <div className="min-h-0 p-3">
            <div className="overflow-y-auto rounded-lg bg-stone-50/60 p-2" style={{ minHeight: 96, maxHeight: 260 }}>
              {previewError ? (
                <p className="text-[13px] text-red-500">{previewError} Move the slider to retry.</p>
              ) : (
                <p
                  key={level}
                  className={`whitespace-pre-wrap text-[15px] leading-6 text-stone-800 ${
                    previewStreaming ? 'opacity-80' : 'animate-[fadeIn_120ms_ease-out]'
                  }`}
                >
                  {previewText || '…'}
                  {previewStreaming && (
                    <SpinnerGapIcon className="ml-1 inline h-3 w-3 animate-spin text-stone-400" />
                  )}
                </p>
              )}
            </div>
            {/* One horizontal slider: left = shorter, right = longer, the
                middle detent is the original. */}
            <div className="mt-2 flex items-center gap-2 px-1">
              <span className="text-[11px] text-stone-400">shorter</span>
              <input
                type="range"
                data-testid="length-slider"
                aria-label="Resize the text"
                min={0}
                max={LENGTH_LEVELS.length - 1}
                step={1}
                value={level}
                onChange={(event) => moveToLevel(Number(event.target.value))}
                className="min-w-0 flex-1 accent-beige-600"
              />
              <span className="text-[11px] text-stone-400">longer</span>
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-stone-100 px-3 py-2">
            {stale && (
              <span className="text-[11px] text-amber-600">
                The text changed under this resize. Reselect and try again.
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                data-testid="length-apply"
                onClick={apply}
                disabled={!applicable}
                className="rounded-lg bg-beige-600 px-3 py-1 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}
      <PopupResizeHandle onPointerDown={startResize} />
    </div>
  );
}
