'use client';

import { useCallback, useEffect, useRef, type PointerEvent } from 'react';

/** Min share of the pane row either side of a pane boundary may shrink to. */
const PANE_MIN_FRACTION = 0.2;

/**
 * Drag handle between two adjacent center editor panes. Mounted inside a
 * secondary pane, straddling its left border; it resizes that pane against its
 * previous sibling by mutating `flex-grow` directly during the drag (no React
 * re-renders — the panes are `flex-1` basis-0, so grow IS the width share),
 * then commits every pane's width fraction on release.
 */
export function PaneResizeHandle({ onCommit }: { onCommit: (fractions: number[]) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    panes: HTMLElement[];
    index: number;
    widths: number[];
  } | null>(null);

  const endDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      } catch {}
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const widths = drag.panes.map((p) => p.getBoundingClientRect().width);
      const total = widths.reduce((a, b) => a + b, 0);
      if (total > 0) onCommit(widths.map((w) => w / total));
    },
    [onCommit],
  );

  return (
    <div
      ref={ref}
      onPointerDown={(event) => {
        const right = ref.current?.parentElement;
        const row = right?.parentElement;
        if (!right || !row) return;
        const panes = Array.from(row.children).filter((el): el is HTMLElement => el instanceof HTMLElement);
        const index = panes.indexOf(right);
        if (index < 1) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const widths = panes.map((p) => p.getBoundingClientRect().width);
        // Freeze every pane at its current width so only this boundary moves.
        panes.forEach((p, i) => {
          p.style.flexGrow = String(widths[i]);
        });
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, panes, index, widths };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const { panes, index, widths } = drag;
        const pair = widths[index - 1] + widths[index];
        const min = PANE_MIN_FRACTION * widths.reduce((a, b) => a + b, 0);
        const left = Math.min(Math.max(widths[index - 1] + (event.clientX - drag.startX), min), pair - min);
        panes[index - 1].style.flexGrow = String(left);
        panes[index].style.flexGrow = String(pair - left);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      role="separator"
      aria-orientation="vertical"
      className="group absolute inset-y-0 left-[-4px] z-30 w-2 cursor-col-resize touch-none"
    >
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-stone-300 group-active:bg-stone-400" />
    </div>
  );
}

type ResizeHandleProps = {
  /** Which edge of the parent the handle is mounted on. left/right resize width;
   *  top/bottom resize height. Determines drag-to-grow direction + axis. */
  side: 'left' | 'right' | 'top' | 'bottom';
  /** Minimum allowed size (width or height, per axis) in px. */
  min: number;
  /** Maximum allowed size in px (number or callback). Omit for unbounded. */
  max?: number | (() => number);
  /** Fired once on pointer up with the final size — perfect for committing to state + storage. */
  onCommit: (size: number) => void;
  /** Fired when the pointer is released without meaningful movement (i.e. a click/tap). */
  onTap?: () => void;
  /**
   * When set, dragging the border well past `min` collapses the panel entirely
   * — same end state as the panel toggle. The panel hard-clamps at `min` while
   * dragging (never shrinks below it); once the pointer crosses
   * `collapseThreshold` (default `min / 2`) it previews the fully-shut state
   * but keeps the drag live, so dragging back out re-expands it. The collapse
   * only commits on release, leaving the stored size untouched so it reopens
   * at its prior size.
   */
  onCollapse?: () => void;
  collapseThreshold?: number;
  /**
   * When true, the handle fills its parent instead of straddling the edge.
   * Use this when the parent is itself a thin rail and you want the entire
   * rail to be the drag target (e.g. collapsed side panels).
   */
  fillParent?: boolean;
  /** Extra classes on the handle root — e.g. `max-lg:hidden` to drop the handle
   *  where the column can't be resized (below lg the center panels auto-share). */
  className?: string;
};

const TAP_THRESHOLD_PX = 4;

/**
 * Drag handle that resizes its closest positioned ancestor by mutating
 * `style.width`/`style.height` directly during the drag (rAF-batched), then
 * commits the final value via `onCommit`. Because React state isn't touched
 * while the pointer is moving, the rest of the tree doesn't re-render — drag is
 * basically free regardless of how heavy the page is.
 */
export function ResizeHandle({
  side,
  min,
  max,
  onCommit,
  onTap,
  onCollapse,
  collapseThreshold,
  fillParent,
  className,
}: ResizeHandleProps) {
  const vertical = side === 'top' || side === 'bottom';
  const dimension = vertical ? 'height' : 'width';
  const growsPositive = side === 'right' || side === 'bottom';
  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    target: HTMLElement;
    pointerId: number;
    start: number;
    startSize: number;
    latestSize: number;
    rafId: number;
    moved: boolean;
    collapsing: boolean;
  } | null>(null);

  const resolveMax = useCallback(() => {
    if (typeof max === 'function') return max();
    if (typeof max === 'number') return max;
    return Number.POSITIVE_INFINITY;
  }, [max]);

  const flush = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.rafId = 0;
    drag.target.style[dimension] = `${drag.latestSize}px`;
  }, [dimension]);

  // Tear down the active drag (flush any pending size, release capture, reset
  // body styles) and return the drag record.
  const finishDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return null;
      if (drag.rafId !== 0) {
        cancelAnimationFrame(drag.rafId);
        drag.target.style[dimension] = `${drag.latestSize}px`;
      }
      drag.target.style.willChange = '';
      drag.target.style.overflow = '';
      dragRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      } catch {}
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      return drag;
    },
    [dimension],
  );

  // If the handle unmounts mid-drag (e.g. an external state change closes the
  // panel while the pointer is still held), pointer-up never reaches us and the
  // global body styles + pending rAF would leak. Reset them on unmount.
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.rafId !== 0) cancelAnimationFrame(drag.rafId);
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
    [],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const target = handleRef.current?.parentElement;
      if (!target) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const rect = target.getBoundingClientRect();
      const size = vertical ? rect.height : rect.width;
      dragRef.current = {
        target,
        pointerId: event.pointerId,
        start: vertical ? event.clientY : event.clientX,
        startSize: size,
        latestSize: size,
        rafId: 0,
        moved: false,
        collapsing: false,
      };
      document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none';
      target.style.willChange = dimension;
      // Clip content so the collapse preview (size 0) reads as fully shut
      // rather than spilling the panel's contents over its neighbour.
      if (onCollapse) target.style.overflow = 'hidden';
    },
    [dimension, onCollapse, vertical],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = (vertical ? event.clientY : event.clientX) - drag.start;
      if (!drag.moved && Math.abs(delta) > TAP_THRESHOLD_PX) drag.moved = true;
      const signed = growsPositive ? delta : -delta;
      const intended = drag.startSize + signed;
      // Past the collapse line: preview the fully-shut state (size 0) but keep
      // the drag live, so dragging back out re-expands. The real collapse is
      // only committed on release. Otherwise hard-clamp at min — the panel
      // never shrinks below it.
      drag.collapsing = Boolean(onCollapse) && intended < (collapseThreshold ?? min / 2);
      const next = drag.collapsing ? 0 : Math.min(Math.max(intended, min), resolveMax());
      if (next === drag.latestSize) return;
      drag.latestSize = next;
      if (drag.rafId === 0) {
        drag.rafId = requestAnimationFrame(flush);
      }
    },
    [growsPositive, min, resolveMax, flush, onCollapse, collapseThreshold, vertical],
  );

  const endDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = finishDrag(event);
      if (!drag) return;
      if (!drag.moved && onTap) {
        onTap();
        return;
      }
      // Released inside the collapse zone → really collapse (same end state as
      // the toggle); committed size is left untouched so it reopens unchanged.
      if (drag.collapsing && onCollapse) {
        onCollapse();
        return;
      }
      onCommit(drag.latestSize);
    },
    [onCommit, onTap, onCollapse, finishDrag],
  );

  const positionClass = fillParent
    ? vertical
      ? 'inset-x-0 top-0 h-full'
      : 'inset-y-0 left-0 w-full'
    : vertical
      ? `left-0 w-full h-2 ${side === 'bottom' ? 'bottom-[-4px]' : 'top-[-4px]'}`
      : `top-0 h-full w-2 ${side === 'right' ? 'right-[-4px]' : 'left-[-4px]'}`;

  return (
    <div
      ref={handleRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // Capture can be lost without a pointerup reaching us (window blur/alt-tab,
      // a context menu mid-drag, an OS gesture, a second pointer). Without this,
      // the body cursor/userSelect leak and stay stuck until refresh. Idempotent:
      // finishDrag no-ops once the drag record is gone (normal pointerup path).
      onLostPointerCapture={endDrag}
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      className={`group absolute z-30 touch-none ${vertical ? 'cursor-row-resize' : 'cursor-col-resize'} ${positionClass}${className ? ` ${className}` : ''}`}
    >
      {fillParent ? null : vertical ? (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-transparent transition-colors duration-150 group-hover:bg-stone-300 group-active:bg-stone-400" />
      ) : (
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-stone-300 group-active:bg-stone-400" />
      )}
    </div>
  );
}
