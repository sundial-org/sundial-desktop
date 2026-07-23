'use client';

import { useEffect, useRef } from 'react';

/**
 * Renders a Sunny Lottie animation (the real designed asset, not a hand-drawn
 * copy). Uses the SVG-only `lottie_light` build, dynamically imported so it
 * never lands in the main bundle — it loads on demand when the host mounts.
 *
 * Respects `prefers-reduced-motion`: the animation still renders, but holds on
 * a frame instead of looping.
 */
export function SunnyLottie({
  src = '/anim/sunny-laptop.json',
  // Crops the 750×600 comp to Sunny while leaving headroom above the head
  // (top=95 → ~70px of space). Tune the box, not the art.
  viewBox = '150 95 450 400',
  className,
}: {
  /** Public path to a Lottie JSON. */
  src?: string;
  /** SVG viewBox into the comp — controls zoom/headspace. */
  viewBox?: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let anim: { destroy: () => void; goToAndStop: (f: number, isFrame: boolean) => void } | null = null;
    let cancelled = false;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    import('lottie-web/build/player/lottie_light')
      .then((mod) => {
        if (cancelled || !hostRef.current) return;
        const lottie = mod.default;
        anim = lottie.loadAnimation({
          container: hostRef.current,
          renderer: 'svg',
          loop: !reduce,
          autoplay: !reduce,
          path: src,
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet', viewBoxSize: viewBox },
        });
        if (reduce) anim.goToAndStop(120, true);
      })
      // The player can't load/render in some environments (e.g. jsdom has no
      // canvas) — skip the animation rather than throw an unhandled rejection.
      .catch(() => {});

    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [src, viewBox]);

  return <div ref={hostRef} className={className} aria-hidden role="img" aria-label="Sunny" />;
}
