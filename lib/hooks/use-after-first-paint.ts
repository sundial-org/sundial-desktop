'use client';

import { useEffect, useState } from 'react';

/**
 * Opens non-critical data lanes only after the first browser paint, then waits
 * for idle time (bounded so background UI still converges promptly). Keeping
 * this shared prevents every workspace hook from inventing a different delay.
 */
export function useAfterFirstPaint(enabled: boolean, resetKey: string | null): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    if (!enabled) return;

    let idleId: number | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const frame = requestAnimationFrame(() => {
      if ('requestIdleCallback' in window) {
        idleId = window.requestIdleCallback(() => setReady(true), { timeout: 1_000 });
      } else {
        fallbackTimer = setTimeout(() => setReady(true), 0);
      }
    });

    return () => {
      cancelAnimationFrame(frame);
      if (idleId !== null) window.cancelIdleCallback(idleId);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [enabled, resetKey]);

  return ready;
}
