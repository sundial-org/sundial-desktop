'use client';

import { useEffect, useRef } from 'react';
import type { AnimationItem } from 'lottie-web';

// Player + rig load on demand: the full lottie build is ~360 KB minified and
// this mascot only shows inside the secrets manager, so it must not ride in
// the workspace's first-paint bundle.
const ANIMATIONS = {
  wave: () => import('./sunny/sunny-wave.json'),
  laptop: () => import('./sunny/sunny-laptop.json'),
} as const;

export type SunnyVariant = keyof typeof ANIMATIONS;

// Sunny, the brand mascot, as a self-contained Lottie player. Honors
// prefers-reduced-motion by holding a single static frame instead of looping.
export function SunnyMascot({
  variant = 'laptop',
  className,
}: {
  variant?: SunnyVariant;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let anim: AnimationItem | null = null;
    let cancelled = false;
    Promise.all([import('lottie-web/build/player/lottie_light'), ANIMATIONS[variant]()])
      .then(([mod, rig]) => {
        if (cancelled) return;
        anim = mod.default.loadAnimation({
          container: node,
          renderer: 'svg',
          loop: !reduceMotion,
          autoplay: !reduceMotion,
          animationData: rig.default,
        });
        if (reduceMotion) anim.goToAndStop(anim.totalFrames - 1, true);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [variant]);

  return <div ref={containerRef} className={className} aria-hidden />;
}
