'use client';

import { useEffect, useLayoutEffect } from 'react';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** Re-asserts the theme (and `js`) classes the inline boot script set on
 *  <html>: React's root hydration rewrites the element's className and wipes
 *  them. Layout effect so the heal lands pre-paint — no light flash. */
export function ThemeApplier() {
  useIsomorphicLayoutEffect(() => {
    (window as { __sundialApplyTheme?: () => void }).__sundialApplyTheme?.();
  }, []);
  return null;
}
