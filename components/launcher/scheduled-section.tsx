'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ClockIcon } from '@phosphor-icons/react';
import { buildWorkspaceChatPath } from '@/lib/workspace/paths';

// Home "Scheduled" section — every schedule the signed-in user owns, across
// workspaces (GET /api/user/schedules). Flat rows; each links to the owning
// workspace (and its chat where applicable). Hidden entirely while empty.

export type UserSchedule = {
  id: string;
  chatId: string | null;
  name: string | null;
  prompt: string | null;
  status: string | null;
  /** 'new' = fresh chat per run — chatId is only the anchor, don't link it. */
  chatMode?: 'same' | 'new';
  scheduleText: string;
  nextRunAt: string | null;
  nextRunText: string | null;
  /** Failure detail — rendered in red once the backend starts sending it. */
  lastRunError?: string | null;
  projectId: string;
  projectTitle: string | null;
  projectRouteId: string;
};

export function ScheduledSection({ emptyMessage }: { emptyMessage?: string } = {}) {
  const [schedules, setSchedules] = useState<UserSchedule[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/user/schedules');
        if (!res.ok) return;
        const data = (await res.json()) as { schedules: UserSchedule[] };
        if (!cancelled) setSchedules(data.schedules ?? []);
      } catch {
        // Non-fatal: the section just stays hidden if the fetch fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Without `emptyMessage` the section hides while empty; the sidebar's
  // dedicated Scheduled view passes it to render a quiet empty state instead.
  if (schedules.length === 0) {
    return emptyMessage ? <p className="px-1 text-sm text-stone-400">{emptyMessage}</p> : null;
  }

  return (
    <section data-testid="scheduled" className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-400">
        <ClockIcon className="h-3.5 w-3.5" aria-hidden /> Scheduled
      </h2>
      <ul>
        {schedules.map((s) => {
          const paused = s.status === 'paused';
          const failure = s.lastRunError?.trim() || null;
          // 'new'-mode runs don't live in the anchor chat — link the
          // workspace itself, matching the panel's new-mode guard.
          const href = s.chatId && s.chatMode !== 'new'
            ? buildWorkspaceChatPath(s.projectRouteId, s.chatId)
            : `/w/${s.projectRouteId}`;
          return (
            <li key={s.id} data-testid="scheduled-row" className="border-b border-stone-200/60 last:border-b-0">
              <Link
                href={href}
                className="flex min-w-0 items-baseline gap-3 rounded-md px-1 py-2 hover:bg-stone-100"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-stone-900">
                    {s.name || s.prompt || 'Scheduled run'}
                  </span>
                  {failure ? (
                    <span data-testid="scheduled-failure" className="block truncate text-xs text-red-600">
                      {paused ? 'paused · ' : ''}
                      {failure}
                    </span>
                  ) : (
                    <span className="block truncate text-xs text-stone-500">
                      {s.scheduleText} · {s.projectTitle || 'Untitled workspace'}
                      {paused ? ' · paused' : s.nextRunText ? ` · next ${s.nextRunText}` : ''}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
