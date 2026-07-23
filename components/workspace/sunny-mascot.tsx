'use client';

import { useEffect, useRef } from 'react';
import lottie, { type AnimationItem } from 'lottie-web';
import sunnyWave from './sunny/sunny-wave.json';
import sunnyLaptop from './sunny/sunny-laptop.json';

const ANIMATIONS = { wave: sunnyWave, laptop: sunnyLaptop } as const;

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

    const anim: AnimationItem = lottie.loadAnimation({
      container: node,
      renderer: 'svg',
      loop: !reduceMotion,
      autoplay: !reduceMotion,
      animationData: ANIMATIONS[variant],
    });
    if (reduceMotion) anim.goToAndStop(anim.totalFrames - 1, true);

    return () => anim.destroy();
  }, [variant]);

  return <div ref={containerRef} className={className} aria-hidden />;
}
