'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CalendarBlankIcon,
  CaretDownIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { AnchoredDropdown } from '@/components/workspace/anchored-dropdown';

type ScheduleKind = 'at' | 'every' | 'cron';

type Schedule = {
  id: string;
  name: string | null;
  prompt: string | null;
  status: string | null;
  kind: ScheduleKind | null;
  timezone: string;
  scheduleText: string;
  nextRunAt: string | null;
  nextRunText: string | null;
};

type EditState = { prompt: string; kind: ScheduleKind; cron: string; everyMinutes: string; at: string };

function toEditState(s: Schedule): EditState {
  return {
    prompt: s.prompt ?? '',
    kind: s.kind ?? 'cron',
    cron: '',
    everyMinutes: '',
    at: '',
  };
}

export function ScheduleChip({ projectId, chatId }: { projectId: string | null; chatId: string | null }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!chatId || !projectId) {
      setSchedules([]);
      return;
    }
    try {
      const res = await fetch(`/api/workspace/schedules?projectId=${projectId}&chatId=${chatId}`);
      if (!res.ok) return;
      const data = (await res.json()) as { schedules: Schedule[]; canManage: boolean };
      setSchedules(data.schedules ?? []);
      setCanManage(Boolean(data.canManage));
    } catch {
      // Non-fatal: the chip just stays hidden if the fetch fails.
    }
  }, [chatId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Dismiss the popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setBusyId(id);
      try {
        await fetch(`/api/workspace/schedules/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const cancel = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await fetch(`/api/workspace/schedules/${id}`, { method: 'DELETE' });
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const saveEdit = useCallback(
    async (id: string) => {
      if (!edit) return;
      const body: Record<string, unknown> = { prompt: edit.prompt, kind: edit.kind };
      if (edit.kind === 'cron') body.cron = edit.cron;
      if (edit.kind === 'every') body.intervalMinutes = Number(edit.everyMinutes);
      if (edit.kind === 'at') body.at = edit.at ? new Date(edit.at).toISOString() : '';
      await patch(id, body);
      setEditingId(null);
      setEdit(null);
    },
    [edit, patch]
  );

  if (schedules.length === 0) return null;

  const label =
    schedules.length === 1 ? schedules[0].scheduleText : `${schedules.length} schedules`;

  return (
    <div className="relative" ref={wrapRef} data-testid="schedule-chip">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Scheduled chat"
        className="inline-flex max-w-[12rem] shrink-0 items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
      >
        <CalendarBlankIcon className="h-3 w-3 shrink-0" weight="fill" aria-hidden />
        <span className="truncate">{label}</span>
        <CaretDownIcon className="h-2.5 w-2.5 shrink-0 text-indigo-400" weight="bold" aria-hidden />
      </button>

      <AnchoredDropdown open={open} anchorRef={triggerRef} align="left" className="w-72">
        <div className="rounded-xl border border-stone-200 bg-white p-2 shadow-lg">
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">
            Schedules
          </p>
          <ul className="space-y-1">
            {schedules.map((s) => {
              const paused = s.status === 'paused';
              const isEditing = editingId === s.id;
              return (
                <li key={s.id} className="rounded-lg px-1.5 py-1.5 hover:bg-stone-50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-stone-700">{s.prompt || s.name}</p>
                      <p className="text-[11px] text-stone-500">
                        {s.scheduleText} · {s.timezone}
                        {paused ? ' · paused' : s.nextRunText ? ` · next ${s.nextRunText}` : ''}
                      </p>
                    </div>
                    {canManage ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busyId === s.id}
                          onClick={() => patch(s.id, { action: paused ? 'resume' : 'pause' })}
                          title={paused ? 'Resume' : 'Pause'}
                          className="text-stone-400 transition-colors hover:text-stone-700 disabled:opacity-50"
                        >
                          {paused ? <PlayIcon className="h-4 w-4" aria-hidden /> : <PauseIcon className="h-4 w-4" aria-hidden />}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === s.id}
                          onClick={() => {
                            setEditingId(isEditing ? null : s.id);
                            setEdit(isEditing ? null : toEditState(s));
                          }}
                          title="Edit"
                          className="text-stone-400 transition-colors hover:text-stone-700 disabled:opacity-50"
                        >
                          <PencilSimpleIcon className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          disabled={busyId === s.id}
                          onClick={() => cancel(s.id)}
                          title="Cancel schedule"
                          className="text-stone-400 transition-colors hover:text-red-600 disabled:opacity-50"
                        >
                          <TrashIcon className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {isEditing && edit ? (
                    <div className="mt-2 space-y-2 border-t border-stone-100 pt-2">
                      <input
                        value={edit.prompt}
                        onChange={(e) => setEdit({ ...edit, prompt: e.target.value })}
                        placeholder="What should run?"
                        className="w-full rounded-md border border-stone-200 px-2 py-1 text-sm text-stone-700 outline-none focus:border-indigo-300"
                      />
                      <div className="flex items-center gap-1.5">
                        <select
                          value={edit.kind}
                          onChange={(e) => setEdit({ ...edit, kind: e.target.value as ScheduleKind })}
                          className="rounded-md border border-stone-200 px-1.5 py-1 text-xs text-stone-600 outline-none"
                        >
                          <option value="cron">cron</option>
                          <option value="every">every</option>
                          <option value="at">at</option>
                        </select>
                        {edit.kind === 'cron' ? (
                          <input
                            value={edit.cron}
                            onChange={(e) => setEdit({ ...edit, cron: e.target.value })}
                            placeholder="0 8 * * 1-5"
                            className="min-w-0 flex-1 rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-indigo-300"
                          />
                        ) : null}
                        {edit.kind === 'every' ? (
                          <input
                            type="number"
                            min={1}
                            value={edit.everyMinutes}
                            onChange={(e) => setEdit({ ...edit, everyMinutes: e.target.value })}
                            placeholder="minutes"
                            className="min-w-0 flex-1 rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-indigo-300"
                          />
                        ) : null}
                        {edit.kind === 'at' ? (
                          <input
                            type="datetime-local"
                            value={edit.at}
                            onChange={(e) => setEdit({ ...edit, at: e.target.value })}
                            className="min-w-0 flex-1 rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-indigo-300"
                          />
                        ) : null}
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <button
                          type="button"
                          disabled={busyId === s.id}
                          onClick={() => saveEdit(s.id)}
                          className="font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null);
                            setEdit(null);
                          }}
                          className="text-stone-400 hover:text-stone-600"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </AnchoredDropdown>
    </div>
  );
}
