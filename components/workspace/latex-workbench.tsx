'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';

const STORAGE_KEY = 'sundial:latex-workbench-editor-fraction';
const DEFAULT_EDITOR_FRACTION = 0.42;
const KEYBOARD_STEP_PX = 24;
const DIVIDER_WIDTH = 18;
const COLLAPSE_THRESHOLD_PX = 56;
const TAP_THRESHOLD_PX = 4;

type DragState = {
  pointerId: number;
  /** Left edge of the editor pane, already offset past the comment lane. */
  originLeft: number;
  splitWidth: number;
  startX: number;
  moved: boolean;
};

function getPaneBounds(containerWidth: number) {
  const minLeft = Math.min(320, Math.max(240, containerWidth * 0.32));
  const minRight = Math.min(380, Math.max(280, containerWidth * 0.38));
  const maxLeft = Math.max(minLeft, containerWidth - minRight);
  return { minLeft, maxLeft };
}

/**
 * Clamp the editor pane width with magnetic snapping at the edges:
 *  - cursor near the left edge collapses the editor (width 0)
 *  - cursor near the right edge collapses the preview (width container-divider)
 *  - in between, the divider snaps to [minLeft, maxLeft]
 */
function clampLeftWidth(nextWidth: number, containerWidth: number) {
  if (nextWidth <= COLLAPSE_THRESHOLD_PX) return 0;
  const collapsedPreviewWidth = Math.max(0, containerWidth - DIVIDER_WIDTH);
  if (nextWidth >= containerWidth - COLLAPSE_THRESHOLD_PX) return collapsedPreviewWidth;
  const { minLeft, maxLeft } = getPaneBounds(containerWidth);
  return Math.min(maxLeft, Math.max(minLeft, nextWidth));
}

function readStoredEditorFraction() {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0.25 || value > 0.75) return null;
  return value;
}

export type LatexViewMode = 'source' | 'split' | 'pdf';

/** One fixed outer height for every piece of the split chrome row — the two
 *  pane toolbars and the divider shim. Content sizing (py-*) drifted by a
 *  pixel or two between the bars (the bordered view switcher is 30px tall),
 *  which reads as a broken seam where they meet. Border-box, border-b
 *  included. */
export const LATEX_BAR_CLASS = 'h-[37px]';
/** The PDF pane's header shell — one string, two render sites (the viewer's
 *  live header and the pane's fallback while the viewer chunk loads), so the
 *  seam can't drift between them. */
export const LATEX_PANE_HEADER_CLASS = `${LATEX_BAR_CLASS} flex shrink-0 items-center justify-between gap-2 border-b border-stone-200 bg-white px-2`;
/** Icon-button token shared by both halves of the chrome row (the toolbar and
 *  the PDF header) — they sit on one line, so diverging rest/hover styles read
 *  as a broken seam. */
export const LATEX_ICON_BTN =
  'relative inline-flex h-7 w-7 items-center justify-center rounded text-stone-600 transition-colors hover:bg-stone-200/60 hover:text-stone-900 disabled:pointer-events-none disabled:opacity-40';

/** Map the internal width-derived collapse state to the toolbar's view mode. */
export function collapseStateToViewMode(state: 'none' | 'editor' | 'preview'): LatexViewMode {
  if (state === 'editor') return 'pdf';
  if (state === 'preview') return 'source';
  return 'split';
}

/** Editor-pane width (px) that realises a given view mode at a container width. */
export function viewModeToEditorWidth(
  viewMode: LatexViewMode,
  containerWidth: number,
  storedFraction: number | null,
): number {
  if (containerWidth <= 0) return 0;
  if (viewMode === 'pdf') return 0;
  if (viewMode === 'source') return Math.max(0, containerWidth - DIVIDER_WIDTH);
  const target = containerWidth * (storedFraction ?? DEFAULT_EDITOR_FRACTION);
  const { minLeft, maxLeft } = getPaneBounds(containerWidth);
  return Math.min(maxLeft, Math.max(minLeft, target));
}

interface LatexWorkbenchProps {
  editor: ReactNode;
  preview: ReactNode;
  isMobile: boolean;
  /** Comment lane, rendered between the editor and the PDF (never beside the PDF). */
  commentLane?: ReactNode;
  /** Controlled Source/Split/PDF state from the toolbar. */
  viewMode?: LatexViewMode;
  /** Fired when a drag/tap collapses or restores a pane, to keep the toolbar truthful. */
  onViewModeChange?: (mode: LatexViewMode) => void;
  /** How the divider meets the pane toolbars: 'full' runs the grab strip the
   *  whole height; 'shim' starts it below a chrome-row-height white cell so
   *  the two toolbars read as one continuous bar (LATEX_BAR_CLASS height). */
  dividerChrome?: 'full' | 'shim';
}

export function LatexWorkbench({
  editor,
  preview,
  isMobile,
  commentLane,
  viewMode,
  onViewModeChange,
  dividerChrome = 'full',
}: LatexWorkbenchProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const previousSplitWidthRef = useRef(0);
  const dragStateRef = useRef<DragState | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [laneWidth, setLaneWidth] = useState(0);
  const [editorWidth, setEditorWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [storedFraction, setStoredFraction] = useState<number | null>(null);
  // The comment lane rides between the two panes, so every pane computation runs
  // on what's left after it. Using the raw container width instead would let an
  // open lane eat the PDF's minimum width and make the divider jump by 320px on
  // grab (the pointer maps to an editor width only after backing the lane out).
  const splitWidth = Math.max(0, containerWidth - laneWidth);
  const hasLane = Boolean(commentLane);

  useEffect(() => {
    setStoredFraction(readStoredEditorFraction());
  }, []);

  useEffect(() => {
    if (isMobile || typeof ResizeObserver === 'undefined') return;
    const element = containerRef.current;
    if (!element) return;

    // Widths and the re-clamp land in ONE commit: splitting them across effects
    // lets a render see the new split with the old editor width, which reads as
    // "uncollapsed" and fires a spurious Split view-mode change.
    const measure = () => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth <= 0) return;
      const nextLane = laneRef.current?.getBoundingClientRect().width ?? 0;
      const nextSplit = Math.max(0, nextWidth - nextLane);
      setContainerWidth(nextWidth);
      setLaneWidth(nextLane);
      if (nextSplit <= 0) return;
      const previous = previousSplitWidthRef.current;
      previousSplitWidthRef.current = nextSplit;
      setEditorWidth((current) => {
        if (current === 0) return 0;
        // "Preview collapsed" is a mode, not a width, so test the width against
        // the split it was measured in. Against the NEW one, growing the split
        // (closing the lane, widening the window) reads as a plain drag and
        // silently flips Source view back to Split.
        if (current !== null && previous > 0 && current >= previous - DIVIDER_WIDTH - 1) {
          return Math.max(0, nextSplit - DIVIDER_WIDTH);
        }
        const fallback = nextSplit * (storedFraction ?? DEFAULT_EDITOR_FRACTION);
        return clampLeftWidth(current ?? fallback, nextSplit);
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (laneRef.current) observer.observe(laneRef.current);
    return () => observer.disconnect();
  }, [isMobile, hasLane, storedFraction]);

  useEffect(() => {
    if (isMobile || typeof window === 'undefined' || splitWidth <= 0 || editorWidth === null) return;
    if (editorWidth <= 0 || editorWidth >= splitWidth - DIVIDER_WIDTH) return;
    window.localStorage.setItem(STORAGE_KEY, String(editorWidth / splitWidth));
  }, [splitWidth, editorWidth, isMobile]);

  useEffect(() => {
    if (!dragging || typeof document === 'undefined') return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragging]);

  const resolvedEditorWidth = useMemo(() => {
    if (splitWidth <= 0) return null;
    if (editorWidth === null) {
      return clampLeftWidth(splitWidth * (storedFraction ?? DEFAULT_EDITOR_FRACTION), splitWidth);
    }
    return editorWidth;
  }, [splitWidth, editorWidth, storedFraction]);

  const collapseState: 'none' | 'editor' | 'preview' = useMemo(() => {
    if (resolvedEditorWidth === null || splitWidth <= 0) return 'none';
    if (resolvedEditorWidth <= 0) return 'editor';
    if (resolvedEditorWidth >= splitWidth - DIVIDER_WIDTH) return 'preview';
    return 'none';
  }, [resolvedEditorWidth, splitWidth]);

  // Apply the controlled view mode to the pane width when it changes. Guarded
  // so a resize or a drag (same view mode) never snaps the divider back.
  const lastAppliedViewModeRef = useRef<LatexViewMode | null>(null);
  /** True only after the USER set a width (drag / divider tap / arrow keys).
   *  Widths that merely materialized (measure seeding the stored fraction,
   *  the apply effect, resizes) must never report a derived view mode: that
   *  stale-derived 'split' clobbered and pinned the page's controlled mode
   *  (panel Source default at mount, and the chat -> Source round trip). */
  const userWidthRef = useRef(false);
  useEffect(() => {
    if (viewMode === undefined || isMobile || splitWidth <= 0) return;
    if (lastAppliedViewModeRef.current === viewMode && editorWidth !== null) return;
    lastAppliedViewModeRef.current = viewMode;
    userWidthRef.current = false;
    setEditorWidth(viewModeToEditorWidth(viewMode, splitWidth, storedFraction));
  }, [viewMode, splitWidth, storedFraction, isMobile, editorWidth]);

  // When a drag/tap changes which pane is collapsed, report it up so the
  // toolbar's Source/Split/PDF highlight matches what the user sees.
  useEffect(() => {
    if (splitWidth <= 0) return;
    const derived = collapseStateToViewMode(collapseState);
    // Only USER-made widths report (see userWidthRef): everything else keeps
    // the controlled viewMode authoritative and merely syncs the guard ref.
    if (!userWidthRef.current) {
      if (derived === viewMode) lastAppliedViewModeRef.current = derived;
      return;
    }
    lastAppliedViewModeRef.current = derived;
    if (onViewModeChange && derived !== viewMode) onViewModeChange(derived);
    // Only react to measured collapse changes; viewMode would race the apply effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseState, splitWidth]);

  const resetDrag = useCallback(() => {
    dragStateRef.current = null;
    setDragging(false);
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const element = containerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    dragStateRef.current = {
      pointerId: event.pointerId,
      originLeft: rect.left + laneWidth,
      splitWidth: Math.max(0, rect.width - laneWidth),
      startX: event.clientX,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  }, [laneWidth]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    if (!dragState.moved && Math.abs(event.clientX - dragState.startX) > TAP_THRESHOLD_PX) {
      dragState.moved = true;
    }
    if (!dragState.moved) return;
    const nextWidth = clampLeftWidth(
      event.clientX - dragState.originLeft,
      dragState.splitWidth,
    );
    userWidthRef.current = true;
    setEditorWidth(nextWidth);
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignored
    }
    if (!dragState.moved) {
      const cw = dragState.splitWidth;
      if (collapseState === 'none') {
        const rect = event.currentTarget.getBoundingClientRect();
        const tappedBottom = event.clientY - rect.top > rect.height / 2;
        userWidthRef.current = true;
        setEditorWidth(tappedBottom ? 0 : Math.max(0, cw - DIVIDER_WIDTH));
      } else {
        const target = cw * (storedFraction ?? DEFAULT_EDITOR_FRACTION);
        const { minLeft, maxLeft } = getPaneBounds(cw);
        userWidthRef.current = true;
        setEditorWidth(Math.min(maxLeft, Math.max(minLeft, target)));
      }
    }
    resetDrag();
  }, [collapseState, resetDrag, storedFraction]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (splitWidth <= 0) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -KEYBOARD_STEP_PX : KEYBOARD_STEP_PX;
    userWidthRef.current = true;
    setEditorWidth((current) =>
      clampLeftWidth(
        (current ?? splitWidth * (storedFraction ?? DEFAULT_EDITOR_FRACTION)) + delta,
        splitWidth,
      ),
    );
  }, [splitWidth, storedFraction]);

  if (isMobile) {
    const showEditor = viewMode !== 'pdf';
    const showPreview = viewMode !== 'source';
    return (
      <div data-testid="latex-split" className="flex flex-col gap-3">
        {showEditor ? (
          <div data-testid="latex-editor-pane" className="min-w-0">
            {editor}
          </div>
        ) : null}
        {commentLane}
        {showPreview ? (
          <div
            data-testid="latex-preview-pane"
            className="overflow-hidden rounded-xl border border-stone-200 bg-white"
          >
            {preview}
          </div>
        ) : null}
      </div>
    );
  }

  const { minLeft, maxLeft } =
    splitWidth > 0 ? getPaneBounds(splitWidth) : { minLeft: 0, maxLeft: 100 };
  const separatorValue =
    splitWidth > 0 && resolvedEditorWidth !== null
      ? Math.round((resolvedEditorWidth / splitWidth) * 100)
      : Math.round(DEFAULT_EDITOR_FRACTION * 100);
  const dividerAriaLabel =
    collapseState === 'editor'
      ? 'LaTeX editor collapsed. Click or drag to expand'
      : collapseState === 'preview'
        ? 'PDF preview collapsed. Click or drag to expand'
        : 'Resize LaTeX editor and PDF preview';

  return (
    <div
      ref={containerRef}
      data-testid="latex-split"
      className="flex h-full min-h-0 overflow-hidden bg-white"
    >
      <div
        data-testid="latex-editor-pane"
        className="min-w-0 h-full shrink-0 overflow-hidden bg-white"
        style={
          resolvedEditorWidth !== null
            ? { width: `${resolvedEditorWidth}px` }
            : { flex: `${DEFAULT_EDITOR_FRACTION} 1 0%` }
        }
        aria-hidden={collapseState === 'editor' || undefined}
      >
        {editor}
      </div>
      {commentLane ? (
        // `flex` (not a plain block) so the lane column stretches to the
        // workbench height — the panel inside sizes itself with `h-full`.
        <div ref={laneRef} data-testid="latex-comment-lane" className="flex h-full min-h-0 shrink-0">
          {commentLane}
        </div>
      ) : null}
      <div className="flex h-full min-h-0 shrink-0 flex-col" style={{ width: DIVIDER_WIDTH }}>
        {dividerChrome !== 'full' ? (
          // Chrome-row-height cell so the grab strip starts below the pane
          // toolbars and they read as one continuous bar across the split.
          <div
            aria-hidden
            data-testid="latex-divider-shim"
            className={`${LATEX_BAR_CLASS} w-full shrink-0 border-b border-stone-200 bg-white`}
          />
        ) : null}
        <div
          data-testid="latex-split-divider"
          data-collapsed={collapseState === 'none' ? undefined : collapseState}
          role="separator"
          tabIndex={0}
          aria-label={dividerAriaLabel}
          aria-orientation="vertical"
          // Percentages of the SPLIT, matching aria-valuenow and the bounds
          // above — against the container they'd exclude the reachable range
          // whenever the comment lane is open.
          aria-valuemin={Math.round((minLeft / Math.max(splitWidth, 1)) * 100)}
          aria-valuemax={Math.round((maxLeft / Math.max(splitWidth, 1)) * 100)}
          aria-valuenow={separatorValue}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={resetDrag}
          onLostPointerCapture={resetDrag}
          onKeyDown={handleKeyDown}
          className={`group relative flex min-h-0 w-full flex-1 shrink-0 touch-none cursor-col-resize flex-col items-center justify-center gap-1 bg-stone-50 outline-none transition-colors ${
            dragging ? 'bg-stone-100' : 'hover:bg-stone-100 focus-visible:bg-stone-100'
          }`}
        >
          {collapseState === 'editor' ? (
            <CaretRightIcon
              className="h-4 w-4 cursor-pointer text-stone-400 transition-colors group-hover:text-stone-700"
              weight="bold"
              aria-hidden
            />
          ) : collapseState === 'preview' ? (
            <CaretLeftIcon
              className="h-4 w-4 cursor-pointer text-stone-400 transition-colors group-hover:text-stone-700"
              weight="bold"
              aria-hidden
            />
          ) : (
            <>
              <CaretRightIcon
                className="h-4 w-4 cursor-pointer text-stone-300 transition-colors group-hover:text-stone-500 hover:!text-stone-700"
                weight="bold"
                aria-hidden
              />
              <CaretLeftIcon
                className="h-4 w-4 cursor-pointer text-stone-300 transition-colors group-hover:text-stone-500 hover:!text-stone-700"
                weight="bold"
                aria-hidden
              />
            </>
          )}
        </div>
      </div>
      <div
        data-testid="latex-preview-pane"
        className="min-w-0 h-full flex-1 overflow-hidden bg-stone-50"
        aria-hidden={collapseState === 'preview' || undefined}
      >
        {preview}
      </div>
    </div>
  );
}
