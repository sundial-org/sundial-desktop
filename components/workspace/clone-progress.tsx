'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { CheckIcon, CircleNotchIcon } from '@phosphor-icons/react';

export type ClonePhase = 'linking' | 'cloning';

const STEPS = ['Linking', 'Cloning files', 'Syncing into workspace'] as const;

/**
 * Full-panel loader shown while a repo/project links + clones. The clone is a
 * single opaque request, so once we reach the cloning phase we advance the last
 * cosmetic step on a timer to keep the animation alive during the long wait.
 */
export function CloneProgress({
  phase,
  target,
  icon,
}: {
  phase: ClonePhase;
  target: string;
  icon: ReactNode;
}) {
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (phase !== 'cloning') return;
    const timer = setTimeout(() => setSynced(true), 2500);
    return () => clearTimeout(timer);
  }, [phase]);

  const active = phase === 'linking' ? 0 : synced ? 2 : 1;

  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="relative flex h-16 w-16 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-stone-200/60" />
        <span className="relative flex h-16 w-16 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-stone-700">
          {icon}
        </span>
      </div>

      <p className="mt-5 text-sm font-medium text-stone-900">Cloning {target}</p>
      <p className="mt-1 text-xs text-stone-500">This can take a moment for large repos.</p>

      <ul className="mt-6 w-full max-w-xs space-y-2 text-left">
        {STEPS.map((label, index) => {
          const done = index < active;
          const running = index === active;
          return (
            <li
              key={label}
              className={`flex items-center gap-2.5 text-sm transition-colors ${
                done ? 'text-stone-500' : running ? 'text-stone-900' : 'text-stone-300'
              }`}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                {done ? (
                  <CheckIcon className="h-4 w-4 text-emerald-600" weight="bold" aria-hidden />
                ) : running ? (
                  <CircleNotchIcon className="h-4 w-4 animate-spin text-stone-500" weight="bold" aria-hidden />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-stone-300" aria-hidden />
                )}
              </span>
              {label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
