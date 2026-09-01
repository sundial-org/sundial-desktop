'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';

// Canonical brand asterisk from app/icon.svg.
const SUNNY_PATH =
  'm28.078 13.537-5.49-.762a.211.211 0 0 1-.103-.374l3.283-2.628-2.38-2.637-4.715 2.657a.21.21 0 0 1-.314-.166l-.39-4.59h-3.99l-.39 4.59a.21.21 0 0 1-.314.166L8.561 7.136 6.18 9.773 9.463 12.4a.211.211 0 0 1-.103.374l-5.49.762v3.204l5.195.343a.21.21 0 0 1 .12.373l-3.779 3.128 2.41 2.754 4.243-2.57a.211.211 0 0 1 .304.262l-2.265 5.493h4.107l1.572-4.015a.211.211 0 0 1 .394 0l1.572 4.015h4.107l-2.265-5.493a.211.211 0 0 1 .305-.261l4.241 2.57 2.41-2.754-3.778-3.129a.211.211 0 0 1 .12-.373l5.195-.343z';

/** Sunny's asterisk as a tiny continuously-rotating working spinner — the
 *  "Sunny is alive" signal shown for the entire duration of a live run.
 *  `spinning={false}` freezes the rotation (a hidden-but-mounted spinner must
 *  not keep an infinite animation alive). */
export function SunnySpinner({
  size = 14,
  className,
  spinning = true,
}: {
  size?: number;
  className?: string;
  spinning?: boolean;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="2 2 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      animate={reduce || !spinning ? undefined : { rotate: 360 }}
      transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
      aria-hidden
    >
      <path fill="#FF7800" d={SUNNY_PATH} />
    </motion.svg>
  );
}

/** Leading spinner slot that collapses smoothly (width + opacity over 300ms)
 *  when its line settles — the label slides left instead of jumping. The
 *  spinner UNMOUNTS after the collapse: a long chat renders many settled tool
 *  groups, and each hidden-but-mounted spinner would otherwise keep an
 *  infinite animation ticking. */
export function SpinnerSlot({ show }: { show: boolean }) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), 350);
    return () => clearTimeout(t);
  }, [show]);
  return (
    <span
      className={`flex shrink-0 items-center overflow-hidden transition-all duration-300 ${show ? 'mr-2 w-3.5 opacity-100' : 'mr-0 w-0 opacity-0'}`}
    >
      {mounted ? <SunnySpinner size={14} spinning={show} /> : null}
    </span>
  );
}
