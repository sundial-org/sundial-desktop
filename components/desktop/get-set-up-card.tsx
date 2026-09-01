'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircleIcon, CircleIcon } from '@phosphor-icons/react';
import type { SidecarConfig } from '@/lib/local/sidecar';
import type { ChecklistSteps } from '@/lib/user/checklist-steps';

/**
 * The "Get set up" checklist — now a Settings tab (it used to dock in the
 * sidebar above the footer; founders deprecated that in favor of the
 * "Open with …" row, so the checklist survives as an on-demand surface).
 *
 * Completion is signal-driven, never self-reported: the steps poll
 * GET /api/user/checklist, which derives them from rows the product already
 * writes (see lib/user/checklist.ts). Signals merge into localStorage
 * monotonically (false→true only), so a done step stays done offline and
 * signed out. All-done renders as a completed list, not a blank tab.
 */

const STORAGE_KEY = 'sundial:get-set-up:v1';
// The endpoint fans out into several DB exists-checks — poll gently.
const POLL_MS = 60_000;

const STEP_KEYS = ['project', 'agentEdit', 'commented', 'commentReply', 'shared'] as const;

type StepKey = (typeof STEP_KEYS)[number];
type ChecklistState = Record<StepKey, boolean>;

const EMPTY: ChecklistState = {
  project: false,
  agentEdit: false,
  commented: false,
  commentReply: false,
  shared: false,
};

function load(): ChecklistState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<ChecklistState>;
    return {
      ...EMPTY,
      ...Object.fromEntries(STEP_KEYS.map((key) => [key, Boolean(parsed[key])])),
    };
  } catch {
    return EMPTY;
  }
}

function save(state: ChecklistState) {
  try {
    // Spread over the stored raw value so legacy keys (minimized/dismissed)
    // don't resurrect; only the step bits matter now.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode — the card degrades to per-session */
  }
}

function allDone(state: ChecklistState, inProject: boolean) {
  return STEP_KEYS.every((key) => state[key] || (key === 'project' && inProject));
}

function Step({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2.5">
      {done ? (
        <CheckCircleIcon className="mt-px h-4.5 w-4.5 shrink-0 text-emerald-600" weight="fill" aria-hidden />
      ) : (
        <CircleIcon className="mt-px h-4.5 w-4.5 shrink-0 text-stone-300" aria-hidden />
      )}
      <span className="min-w-0">
        <span
          className={`block text-sm ${done ? 'text-stone-400 line-through decoration-stone-300' : 'text-stone-700'}`}
        >
          {label}
        </span>
        {done ? null : <span className="block text-xs text-stone-400">{detail}</span>}
      </span>
    </li>
  );
}

export function GetSetUpCard({
  config,
  projectId,
}: {
  config?: SidecarConfig | null;
  projectId?: string | null;
}) {
  const [state, setState] = useState<ChecklistState | null>(null);
  useEffect(() => {
    setState(load());
  }, []);

  // Rendering inside a project IS the first step — don't wait for the cloud
  // round-trip to confirm what the surface already proves.
  const inProject = Boolean(config && projectId);
  const done = state !== null && allDone(state, inProject);

  // Poll the checklist while any step is open, merging monotonically — a
  // poll can only complete steps. Signed out (or with stale parked desktop
  // credentials) the fetch 401s and is ignored.
  useEffect(() => {
    if (!state || allDone(state, inProject)) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/user/checklist');
        if (!res.ok || cancelled) return;
        const { steps } = (await res.json()) as { steps: ChecklistSteps };
        setState((current) => {
          if (!current) return current;
          const next = { ...current };
          for (const key of STEP_KEYS) if (steps[key]) next[key] = true;
          if (STEP_KEYS.every((key) => next[key] === current[key])) return current;
          save(next);
          return next;
        });
      } catch {
        /* offline — try again next tick */
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state, inProject]);

  const doneCount = useMemo(
    () =>
      state ? STEP_KEYS.filter((key) => state[key] || (key === 'project' && inProject)).length : 0,
    [state, inProject],
  );

  if (!state) return null;

  return (
    <aside
      className="w-full rounded-xl border border-stone-200 bg-white p-3"
      data-testid="get-set-up-card"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold text-stone-800">Get set up</span>
        <span className="font-mono text-xs text-stone-400">
          {doneCount}/{STEP_KEYS.length}
        </span>
      </div>
      <div className="mb-3 mt-2 h-1 overflow-hidden rounded-full bg-stone-100" aria-hidden>
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width]"
          style={{ width: `${(doneCount / STEP_KEYS.length) * 100}%` }}
        />
      </div>
      <ul className="flex flex-col gap-2.5">
        <Step
          done={state.project || inProject}
          label="Create a project"
          detail="Start a workspace for your docs"
        />
        <Step done={state.agentEdit} label="Agent edits a file" detail="Ask Sunny to change something" />
        <Step done={state.commented} label="Make a comment" detail="Highlight text and comment" />
        <Step
          done={state.commentReply}
          label="Agent responds to a comment"
          detail="Sunny replies in the thread"
        />
        <Step done={state.shared} label="Share a workspace or file" detail="Invite someone or copy a link" />
      </ul>
      {done ? (
        <p className="mt-3 text-xs text-emerald-700" data-testid="get-set-up-done">
          All set: you&apos;ve tried everything.
        </p>
      ) : null}
    </aside>
  );
}
