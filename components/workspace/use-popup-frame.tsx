'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/* ── Popup drag + resize ──────────────────────────────────────────────
 *  Shared by the floating AI popups (rewrite, prism, factcheck, pangram,
 *  length-resize). The popup keeps its selection-anchored position until
 *  the user drags its header or pulls the corner handle; from then on the
 *  explicit frame wins. A new open resets back to the anchor.
 * ─────────────────────────────────────────────────────────────────── */

const MIN_WIDTH = 280;
const MIN_HEIGHT = 120;

type Frame = {
  left: number;
  top: number;
  width: number;
  /** Only a resize pins an explicit height — a move must keep the popup's
   *  natural height/maxHeight, or content still streaming at drag time gets
   *  squeezed into the loading-state height forever. */
  height: number | null;
};

export function usePopupFrame(boxRef: RefObject<HTMLDivElement | null>, resetKey: unknown) {
  const [frame, setFrame] = useState<Frame | null>(null);
  // Latest frame for gesture starts (a move after a resize keeps the pinned
  // height; a plain move never pins one).
  const frameRef = useRef<Frame | null>(null);
  frameRef.current = frame;

  useEffect(() => setFrame(null), [resetKey]);

  const startGesture = useCallback(
    (event: React.PointerEvent, gesture: 'move' | 'resize') => {
      const box = boxRef.current;
      if (!box || event.button !== 0) return;
      // Header buttons/inputs keep their own pointer behavior.
      if (gesture === 'move' && (event.target as HTMLElement).closest('button, input, textarea, select, a')) return;
      event.preventDefault();
      const rect = box.getBoundingClientRect();
      const origin = { x: event.clientX, y: event.clientY };
      const base: Frame = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: gesture === 'resize' ? rect.height : (frameRef.current?.height ?? null),
      };
      setFrame(base);
      const onMove = (move: PointerEvent) => {
        const dx = move.clientX - origin.x;
        const dy = move.clientY - origin.y;
        setFrame(
          gesture === 'move'
            ? { ...base, left: base.left + dx, top: base.top + dy }
            : {
                ...base,
                width: Math.max(MIN_WIDTH, base.width + dx),
                height: Math.max(MIN_HEIGHT, (base.height ?? 0) + dy),
              },
        );
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [boxRef],
  );

  const startMove = useCallback((event: React.PointerEvent) => startGesture(event, 'move'), [startGesture]);
  const startResize = useCallback((event: React.PointerEvent) => startGesture(event, 'resize'), [startGesture]);

  // Spread AFTER the anchored style: overrides left/width and neutralizes
  // whichever of top/bottom the anchor used. Height (and the maxHeight
  // release) applies only once the user has resized — otherwise the anchored
  // maxHeight keeps governing natural growth.
  const frameStyle: CSSProperties | null = frame
    ? {
        left: frame.left,
        top: frame.top,
        bottom: 'auto',
        width: frame.width,
        ...(frame.height !== null ? { height: frame.height, maxHeight: 'none' } : {}),
      }
    : null;

  return { frameStyle, startMove, startResize };
}

export function PopupResizeHandle({ onPointerDown }: { onPointerDown: (event: React.PointerEvent) => void }) {
  return (
    <div
      data-testid="popup-resize-handle"
      onPointerDown={onPointerDown}
      className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize touch-none"
    >
      <svg viewBox="0 0 16 16" className="h-full w-full text-stone-300">
        <path d="M14 8 8 14M14 12l-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </svg>
    </div>
  );
}
