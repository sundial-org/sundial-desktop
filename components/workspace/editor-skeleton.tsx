'use client';

// Placeholder shown while an editor mounts (Monaco, ProseMirror, or the
// Y.Doc/provider handshake). It holds a correctly-sized, transparent box and
// only fades skeleton bars in if the load is slow (> REVEAL_DELAY_MS) — so the
// common fast file-switch shows nothing and the editor frame never twitches.
// Crucially it imposes NO width/centering/background of its own: the page already
// wraps editors in a stable centered column (app/w/[slug]/page.tsx), so the bars
// fill that same column and the hand-off to the live editor doesn't jump. Bars
// are aria-hidden; the load is announced via the sr-only status line.

import { useEffect, useState, type CSSProperties } from 'react';

const REVEAL_DELAY_MS = 180;
const DOC_LINES = ['58%', '100%', '92%', '80%'];
const CODE_LINES = ['85%', '55%', '90%', '45%', '70%', '60%', '40%'];

export function EditorSkeleton({
  variant = 'doc',
  className,
  style,
}: {
  variant?: 'doc' | 'code';
  className?: string;
  style?: CSSProperties;
}) {
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReveal(true), REVEAL_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const code = variant === 'code';
  const lines = code ? CODE_LINES : DOC_LINES;
  return (
    <div
      role="status"
      aria-label="Loading editor"
      // Code editors (Monaco) paint on white, so the code skeleton matches that
      // surface — a fast switch then reads as white→white instead of flashing the
      // page's grey through a transparent box. The doc skeleton stays transparent
      // so it keeps matching the markdown editing surface (stone-50).
      className={`min-h-[300px] w-full ${code ? 'bg-white' : ''} ${className ?? ''}`}
      style={style}
    >
      <span className="sr-only">Loading editor…</span>
      <div
        aria-hidden
        className={`space-y-4 px-3 py-3 transition-opacity duration-300 lg:px-6 ${
          reveal ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {lines.map((w, i) => (
          <div key={i} className="h-4 rounded bg-stone-200/70 animate-pulse" style={{ width: w }} />
        ))}
      </div>
    </div>
  );
}
