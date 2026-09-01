'use client';

import { useCallback, useEffect, useState } from 'react';
import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';

// The workspace Schedules panel — the one entry point for scheduled runs
// (opened from the Chats header's calendar icon, the "＋ New schedule" row and
// the chat header's inline cadence text). Wears the workspace modal look
// (workspace-share-modal / path-share-modal): rounded-2xl panel, semibold
// title with no header rule, stone-900 primary action, stone focus rings.
// Rides on /api/workspace/schedules (see lib/scheduling/schedule.ts).

/** The one input style in the workspace modals — kept in one place here so
 *  the schedule fields can't drift apart from each other again. Carries no
 *  width: callers set it, and a `w-full` in here can't be overridden by a
 *  `w-auto` appended after it (same specificity — source order in the
 *  stylesheet decides, not the class attribute). */
const FIELD_CLASS =
  'rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 transition-colors focus:border-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-400/20';

type ScheduleKind = 'at' | 'every' | 'cron';

export type WorkspaceSchedule = {
  id: string;
  chatId: string | null;
  name: string | null;
  prompt: string | null;
  status: string | null;
  kind: ScheduleKind | null;
  /** Server truth: 'new' = a fresh chat per run; chatId is only the anchor. */
  chatMode?: 'same' | 'new';
  timezone: string;
  scheduleText: string;
  nextRunAt: string | null;
  nextRunText: string | null;
  /** Failure detail (e.g. "last run skipped, out of credits"). Not sent by the
   *  API yet — rendered in red as soon as the backend starts including it. */
  lastRunError?: string | null;
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

/** "in this chat" (runs accumulate in one thread) vs "new chat each run". */
function modeLabel(s: WorkspaceSchedule): string {
  return s.chatMode === 'new' ? 'new chat each run' : 'in this chat';
}

function ScheduleFieldInputs({
  value,
  onChange,
}: {
  value: ScheduleFields;
  onChange: (next: ScheduleFields) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        value={value.kind}
        onChange={(e) => onChange({ ...value, kind: e.target.value as ScheduleKind })}
        aria-label="Schedule type"
        className={`${FIELD_CLASS} shrink-0`}
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
          className={`${FIELD_CLASS} min-w-0 flex-1`}
        />
      ) : value.kind === 'every' ? (
        <input
          type="number"
          min={1}
          value={value.everyMinutes}
          onChange={(e) => onChange({ ...value, everyMinutes: e.target.value })}
          placeholder="minutes"
          aria-label="Interval minutes"
          className={`${FIELD_CLASS} min-w-0 flex-1`}
        />
      ) : (
        <input
          type="datetime-local"
          value={value.at}
          onChange={(e) => onChange({ ...value, at: e.target.value })}
          aria-label="Run at"
          className={`${FIELD_CLASS} min-w-0 flex-1`}
        />
      )}
    </div>
  );
}

export function SchedulesPanel({
  onRequireSignIn,
  open,
  onClose,
  projectId,
  /** The chat a new "in this chat" schedule runs in. Null disables creating. */
  currentChatId,
  onOpenChat,
  startInCreate,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  currentChatId?: string | null;
  onOpenChat?: (chatId: string) => void;
  startInCreate?: boolean;
  /** Route to sign-in when the server refuses anonymous schedule creation.
   *  Any create entry point can hit this (the panel has its own button), so
   *  the handling lives here, not just on the sidebar row. */
  onRequireSignIn?: () => void;
}) {
  const [schedules, setSchedules] = useState<WorkspaceSchedule[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-schedule form.
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newPrompt, setNewPrompt] = useState('');
  const [newName, setNewName] = useState('');
  const [newFields, setNewFields] = useState<ScheduleFields>(EMPTY_FIELDS);
  /** 'existing' runs in the current chat; 'new' spawns a chat per run (sent as
   *  chatMode: 'new' — the API ignores it until the backend lands). */
  const [newChatMode, setNewChatMode] = useState<'existing' | 'new'>('existing');

  // Inline edit. The schedule field starts blank — leaving it blank patches
  // only the prompt; filling it reschedules.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [editFields, setEditFields] = useState<ScheduleFields>(EMPTY_FIELDS);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace/schedules?projectId=${encodeURIComponent(projectId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { schedules: WorkspaceSchedule[]; canManage: boolean };
      setSchedules(data.schedules ?? []);
      setCanManage(Boolean(data.canManage));
    } catch {
      // Best-effort: leave the last-known list in place on a transient failure.
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEditingId(null);
    // Each open starts fresh: list view, or the create form when the caller
    // arrived via "＋ New schedule".
    setAdding(Boolean(startInCreate));
    void load();
  }, [open, startInCreate, load]);

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
          throw new Error(b?.error ?? 'Failed to update schedule');
        }
        await load();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to update schedule');
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
          throw new Error(b?.error ?? 'Failed to delete schedule');
        }
        setEditingId(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete schedule');
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
    setNewChatMode('existing');
  }, []);

  const create = useCallback(async () => {
    const prompt = newPrompt.trim();
    const sched = scheduleBody(newFields);
    if (!prompt || !sched) {
      setError('Add a prompt and a valid schedule.');
      return;
    }
    // Both modes need a chat today — the API requires chatId even for
    // chatMode: 'new' (which it ignores until the backend supports it).
    if (!currentChatId) {
      setError('Open a chat first. A schedule runs in a chat.');
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
          chatId: currentChatId,
          prompt,
          name: newName.trim() || prompt.slice(0, 60),
          timezone: LOCAL_TZ,
          ...sched,
          ...(newChatMode === 'new' ? { chatMode: 'new' } : {}),
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        if (b?.error === 'signin_required') {
          if (onRequireSignIn) {
            onRequireSignIn();
            return;
          }
          throw new Error('Sign in to create schedules.');
        }
        throw new Error(b?.error ?? 'Could not create the schedule');
      }
      resetAdd();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the schedule');
    } finally {
      setCreating(false);
    }
  }, [newPrompt, newName, newFields, newChatMode, projectId, currentChatId, load, resetAdd]);

  const beginEdit = useCallback((s: WorkspaceSchedule) => {
    setEditingId(s.id);
    setEditPrompt(s.prompt ?? '');
    setEditFields({ kind: s.kind ?? 'cron', cron: '', everyMinutes: '', at: '' });
    setAdding(false);
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
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="Schedules"
      panelClassName="w-full max-w-lg rounded-2xl border border-stone-200 bg-white shadow-xl"
    >
      <div data-testid="schedules-panel" className="flex max-h-[80vh] flex-col">
        <div className="flex shrink-0 items-center justify-between px-5 pt-5 pb-3">
          <h2 className="text-base font-semibold text-stone-800">Schedules</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-stone-400 transition-colors hover:text-stone-600"
          >
            <XIcon className="h-5 w-5" weight="regular" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5">
          {error ? <p className="pb-2 text-[13px] text-rose-600">{error}</p> : null}

          {schedules.length === 0 ? (
            loaded ? (
              <p className="pb-2 text-sm text-stone-500">
                No schedules yet. Sunny can run a prompt on a cadence, in this chat or a fresh one each run.
              </p>
            ) : null
          ) : (
            <ul className="divide-y divide-stone-200">
              {schedules.map((s) => {
                const paused = s.status === 'paused';
                const isEditing = editingId === s.id;
                const failure = s.lastRunError?.trim() || null;
                return (
                  <li key={s.id} data-testid="schedule-row" className="py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        // 'new'-mode runs don't land in the anchor chat, so
                        // the row doesn't link there — no single home thread.
                        onClick={() => s.chatMode !== 'new' && s.chatId && onOpenChat?.(s.chatId)}
                        disabled={s.chatMode === 'new' || !s.chatId}
                        className="min-w-0 flex-1 text-left disabled:cursor-default"
                      >
                        <p className="truncate text-sm text-stone-700">{s.name || s.prompt || 'Scheduled run'}</p>
                        {failure ? (
                          <p data-testid="schedule-failure" className="truncate text-[12px] text-rose-600">
                            {paused ? 'paused · ' : ''}
                            {failure}
                          </p>
                        ) : (
                          <p className="truncate text-[12px] text-stone-400">
                            {s.scheduleText} · {modeLabel(s)}
                            {paused ? ' · paused' : ''}
                          </p>
                        )}
                      </button>
                      {canManage ? (
                        <div className="flex shrink-0 items-center gap-1 pt-0.5 text-[12px] text-stone-400">
                          {paused ? (
                            <button
                              type="button"
                              disabled={busyId === s.id}
                              onClick={() => void patch(s.id, { action: 'resume' })}
                              className="hover:text-stone-700 disabled:opacity-50"
                            >
                              resume
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={busyId === s.id}
                                onClick={() => void patch(s.id, { action: 'pause' })}
                                className="hover:text-stone-700 disabled:opacity-50"
                              >
                                pause
                              </button>
                              <span aria-hidden>·</span>
                              <button
                                type="button"
                                disabled={busyId === s.id}
                                onClick={() => (isEditing ? setEditingId(null) : beginEdit(s))}
                                className="hover:text-stone-700 disabled:opacity-50"
                              >
                                edit
                              </button>
                            </>
                          )}
                        </div>
                      ) : null}
                    </div>

                    {isEditing ? (
                      <div className="mt-2 space-y-2">
                        <input
                          value={editPrompt}
                          onChange={(e) => setEditPrompt(e.target.value)}
                          placeholder="What should run?"
                          aria-label="Edit schedule prompt"
                          className={`${FIELD_CLASS} w-full`}
                        />
                        <ScheduleFieldInputs value={editFields} onChange={setEditFields} />
                        <p className="text-[12px] text-stone-400">Leave the schedule blank to keep the current one.</p>
                        <div className="flex items-center gap-2 pt-0.5">
                          <button
                            type="button"
                            disabled={busyId === s.id}
                            onClick={() => void saveEdit(s.id)}
                            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-40"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 transition-colors hover:bg-stone-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={busyId === s.id}
                            onClick={() => void remove(s.id)}
                            className="ml-auto rounded-lg border border-stone-200 px-3 py-2 text-sm text-rose-600 transition-colors hover:bg-rose-50 disabled:opacity-50"
                          >
                            Delete
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

        {canManage ? (
          <div className="shrink-0 px-5 pb-5 pt-3">
            {adding ? (
              <div className="space-y-2.5">
                <textarea
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  placeholder="What should Sunny do each time?"
                  rows={2}
                  aria-label="Schedule prompt"
                  className={`${FIELD_CLASS} w-full resize-none`}
                />
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Name (optional)"
                  aria-label="Schedule name"
                  className={`${FIELD_CLASS} w-full`}
                />
                <ScheduleFieldInputs value={newFields} onChange={setNewFields} />
                <div className="flex items-center gap-4 text-[13px] text-stone-600">
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="schedule-chat-mode"
                      checked={newChatMode === 'existing'}
                      onChange={() => setNewChatMode('existing')}
                      className="accent-stone-800"
                    />
                    in this chat
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="schedule-chat-mode"
                      checked={newChatMode === 'new'}
                      onChange={() => setNewChatMode('new')}
                      className="accent-stone-800"
                    />
                    new chat each run
                  </label>
                </div>
                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() => void create()}
                    disabled={creating}
                    data-testid="schedules-create-submit"
                    className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-40"
                  >
                    {creating ? 'Creating…' : 'Create schedule'}
                  </button>
                  <button
                    type="button"
                    onClick={resetAdd}
                    className="rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 transition-colors hover:bg-stone-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setAdding(true);
                  setEditingId(null);
                  setError(null);
                }}
                data-testid="schedules-new-button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 transition-colors hover:bg-stone-50"
              >
                <PlusIcon className="h-4 w-4" weight="regular" aria-hidden />
                New schedule
              </button>
            )}
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}

/**
 * The chat header's inline cadence — small muted text after the title when the
 * current chat has a schedule (e.g. "every weekday 8:00 am"). Clicking opens
 * the Schedules panel. Renders nothing otherwise; never a second line.
 */
export function ChatHeaderScheduleText({
  projectId,
  chatId,
  /** Any value — a change (e.g. the panel closing) triggers a refetch. */
  refresh,
  onOpen,
}: {
  projectId: string;
  chatId: string;
  refresh?: unknown;
  onOpen: () => void;
}) {
  const [schedules, setSchedules] = useState<WorkspaceSchedule[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/workspace/schedules?projectId=${encodeURIComponent(projectId)}&chatId=${encodeURIComponent(chatId)}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as { schedules: WorkspaceSchedule[] };
        if (!cancelled) setSchedules(data.schedules ?? []);
      } catch {
        // Non-fatal: the text just stays hidden if the fetch fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, chatId, refresh]);

  if (schedules.length === 0) return null;
  const label = schedules.length === 1 ? schedules[0].scheduleText : `${schedules.length} schedules`;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="chat-header-schedule"
      title="Open schedules"
      className="min-w-0 shrink truncate text-[12px] text-stone-400 transition-colors hover:text-stone-600"
    >
      {label}
    </button>
  );
}
