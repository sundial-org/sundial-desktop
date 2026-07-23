'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CalendarDotsIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { SidebarSectionHeader } from '@/components/workspace/sidebar-section-header';

// Left-panel Tasks view. A "task" is a chat with a schedule (see
// lib/scheduling/schedule.ts), so the list and management actions ride on the
// shared /api/workspace/schedules endpoints — this is the workspace-wide
// counterpart to the per-chat ScheduleChip. Creating a task spins up its own
// chat so scheduled runs accumulate in their own thread.

type ScheduleKind = 'at' | 'every' | 'cron';

type Task = {
  id: string;
  chatId: string | null;
  name: string | null;
  prompt: string | null;
  status: string | null;
  kind: ScheduleKind | null;
  timezone: string;
  scheduleText: string;
  nextRunAt: string | null;
  nextRunText: string | null;
};

type ScheduleFields = { kind: ScheduleKind; cron: string; everyMinutes: string; at: string };

const EMPTY_FIELDS: ScheduleFields = { kind: 'cron', cron: '', everyMinutes: '', at: '' };

const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

// Turn the form's schedule fields into the API's schedule params, or null when
// the chosen kind's input is missing/invalid.
function scheduleBody(f: ScheduleFields): Record<string, unknown> | null {
  if (f.kind === 'cron') return f.cron.trim() ? { kind: 'cron', cron: f.cron.trim() } : null;
  if (f.kind === 'every') {
    const n = Number(f.everyMinutes);
    return Number.isFinite(n) && n >= 1 ? { kind: 'every', intervalMinutes: Math.floor(n) } : null;
  }
  return f.at ? { kind: 'at', at: new Date(f.at).toISOString() } : null;
}

function ScheduleFieldInputs({
  value,
  onChange,
}: {
  value: ScheduleFields;
  onChange: (next: ScheduleFields) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={value.kind}
        onChange={(e) => onChange({ ...value, kind: e.target.value as ScheduleKind })}
        aria-label="Schedule type"
        className="rounded-md border border-stone-200 px-1.5 py-1 text-xs text-stone-600 outline-none"
      >
        <option value="cron">cron</option>
        <option value="every">every</option>
        <option value="at">at</option>
      </select>
      {value.kind === 'cron' ? (
        <input
          value={value.cron}
          onChange={(e) => onChange({ ...value, cron: e.target.value })}
          placeholder="0 8 * * 1-5"
          aria-label="Cron expression"
          className="min-w-0 flex-1 rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-indigo-300"
        />
      ) : value.kind === 'every' ? (
        <input
          type="number"
          min={1}
          value={value.everyMinutes}
          onChange={(e) => onChange({ ...value, everyMinutes: e.target.value })}
          placeholder="minutes"
          aria-label="Interval minutes"
          className="min-w-0 flex-1 rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-indigo-300"
        />
      ) : (
        <input
          type="datetime-local"
          value={value.at}
          onChange={(e) => onChange({ ...value, at: e.target.value })}
          aria-label="Run at"
          className="min-w-0 flex-1 rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-indigo-300"
        />
      )}
    </div>
  );
}

export function TasksRail({
  projectId,
  chatId,
  onOpenChat,
  collapsed,
  onToggleCollapsed,
}: {
  projectId: string;
  /** The chat a new task runs in (the active chat). Null disables creating. */
  chatId?: string | null;
  onOpenChat?: (chatId: string) => void;
  /** Accordion state: when collapsed, only the Tasks section header renders. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add-task form.
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newPrompt, setNewPrompt] = useState('');
  const [newName, setNewName] = useState('');
  const [newFields, setNewFields] = useState<ScheduleFields>(EMPTY_FIELDS);

  // Inline edit. The schedule field starts blank — leaving it blank patches
  // only the prompt; filling it reschedules.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [editFields, setEditFields] = useState<ScheduleFields>(EMPTY_FIELDS);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace/schedules?projectId=${encodeURIComponent(projectId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { schedules: Task[]; canManage: boolean };
      setTasks(data.schedules ?? []);
      setCanManage(Boolean(data.canManage));
    } catch {
      // Best-effort: leave the last-known list in place on a transient failure.
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setBusyId(id);
      setError(null);
      try {
        const res = await fetch(`/api/workspace/schedules/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(b?.error ?? 'Failed to update task');
        }
        await load();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to update task');
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        const res = await fetch(`/api/workspace/schedules/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const b = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(b?.error ?? 'Failed to delete task');
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete task');
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const resetAdd = useCallback(() => {
    setAdding(false);
    setNewPrompt('');
    setNewName('');
    setNewFields(EMPTY_FIELDS);
  }, []);

  const create = useCallback(async () => {
    const prompt = newPrompt.trim();
    const sched = scheduleBody(newFields);
    if (!prompt || !sched) {
      setError('Add a prompt and a valid schedule.');
      return;
    }
    if (!chatId) {
      setError('Open a chat first — a task runs in a chat.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/workspace/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          chatId,
          prompt,
          name: newName.trim() || prompt.slice(0, 60),
          timezone: LOCAL_TZ,
          ...sched,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? 'Could not create the task');
      }
      resetAdd();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the task');
    } finally {
      setCreating(false);
    }
  }, [newPrompt, newName, newFields, projectId, chatId, load, resetAdd]);

  const beginEdit = useCallback((t: Task) => {
    setEditingId(t.id);
    setEditPrompt(t.prompt ?? '');
    setEditFields({ kind: t.kind ?? 'cron', cron: '', everyMinutes: '', at: '' });
    setError(null);
  }, []);

  const saveEdit = useCallback(
    async (id: string) => {
      const body: Record<string, unknown> = {};
      const prompt = editPrompt.trim();
      if (prompt) body.prompt = prompt;
      const sched = scheduleBody(editFields);
      if (sched) Object.assign(body, sched, { timezone: LOCAL_TZ });
      if (Object.keys(body).length === 0) {
        setEditingId(null);
        return;
      }
      const ok = await patch(id, body);
      if (ok) setEditingId(null);
    },
    [editPrompt, editFields, patch]
  );

  return (
    <>
      <SidebarSectionHeader
        label="Tasks"
        actions={
          canManage ? (
            <button
              type="button"
              onClick={() => {
                setAdding((v) => !v);
                setEditingId(null);
                setError(null);
              }}
              aria-label="New task"
              aria-expanded={adding}
              data-testid="tasks-add-button"
              className="relative group/tip flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-200/50 hover:text-stone-600"
            >
              <PlusIcon className="h-4 w-4" weight="bold" aria-hidden />
              <IconTooltip label="New task" align="right" />
            </button>
          ) : null
        }
      />

      {collapsed ? null : (
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2" data-testid="tasks-rail">
        {adding ? (
          <div className="mb-2 space-y-2 rounded-lg border border-stone-200 bg-stone-50/70 p-2.5">
            <textarea
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              placeholder="What should Sunny do each time?"
              rows={2}
              aria-label="Task prompt"
              className="w-full resize-none rounded-md border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-700 outline-none focus:border-indigo-300"
            />
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (optional)"
              aria-label="Task name"
              className="w-full rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-700 outline-none focus:border-indigo-300"
            />
            <ScheduleFieldInputs value={newFields} onChange={setNewFields} />
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() => void create()}
                disabled={creating}
                data-testid="tasks-create-submit"
                className="font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create task'}
              </button>
              <button type="button" onClick={resetAdd} className="text-stone-400 hover:text-stone-600">
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="mb-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
            {error}
          </p>
        ) : null}

        {tasks.length === 0 ? (
          loaded ? (
            <div className="px-2 py-8 text-center">
              <CalendarDotsIcon className="mx-auto h-7 w-7 text-stone-300" weight="regular" aria-hidden />
              <p className="mt-3 text-xs text-stone-500">
                {canManage ? 'No tasks yet. Add one to run Sunny on a schedule.' : 'No scheduled tasks yet.'}
              </p>
            </div>
          ) : null
        ) : (
          <ul className="space-y-1">
            {tasks.map((t) => {
              const paused = t.status === 'paused';
              const isEditing = editingId === t.id;
              return (
                <li key={t.id} data-testid="task-row" className="rounded-lg px-1.5 py-1.5 hover:bg-stone-50">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => t.chatId && onOpenChat?.(t.chatId)}
                      disabled={!t.chatId}
                      className="min-w-0 flex-1 text-left disabled:cursor-default"
                    >
                      <p className="truncate text-sm text-stone-700">{t.prompt || t.name || 'Scheduled task'}</p>
                      <p className="truncate text-[11px] text-stone-500">
                        {t.scheduleText}
                        {paused ? ' · paused' : t.nextRunText ? ` · next ${t.nextRunText}` : ''}
                      </p>
                    </button>
                    {canManage ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busyId === t.id}
                          onClick={() => void patch(t.id, { action: paused ? 'resume' : 'pause' })}
                          title={paused ? 'Resume' : 'Pause'}
                          className="text-stone-400 transition-colors hover:text-stone-700 disabled:opacity-50"
                        >
                          {paused ? <PlayIcon className="h-4 w-4" aria-hidden /> : <PauseIcon className="h-4 w-4" aria-hidden />}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === t.id}
                          onClick={() => (isEditing ? setEditingId(null) : beginEdit(t))}
                          title="Edit"
                          className="text-stone-400 transition-colors hover:text-stone-700 disabled:opacity-50"
                        >
                          <PencilSimpleIcon className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          disabled={busyId === t.id}
                          onClick={() => void remove(t.id)}
                          title="Delete task"
                          className="text-stone-400 transition-colors hover:text-red-600 disabled:opacity-50"
                        >
                          <TrashIcon className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {isEditing ? (
                    <div className="mt-2 space-y-2 border-t border-stone-100 pt-2">
                      <input
                        value={editPrompt}
                        onChange={(e) => setEditPrompt(e.target.value)}
                        placeholder="What should run?"
                        aria-label="Edit task prompt"
                        className="w-full rounded-md border border-stone-200 px-2 py-1 text-sm text-stone-700 outline-none focus:border-indigo-300"
                      />
                      <ScheduleFieldInputs value={editFields} onChange={setEditFields} />
                      <p className="text-[10px] text-stone-400">Leave the schedule blank to keep the current one.</p>
                      <div className="flex items-center gap-3 text-xs">
                        <button
                          type="button"
                          disabled={busyId === t.id}
                          onClick={() => void saveEdit(t.id)}
                          className="font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
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
        )}
      </div>
      )}
    </>
  );
}
