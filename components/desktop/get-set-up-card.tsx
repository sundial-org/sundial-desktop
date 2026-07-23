'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircleIcon, CircleIcon } from '@phosphor-icons/react';
import { sidecar, type SidecarConfig } from '@/lib/local/sidecar';

/**
 * First-run "Get set up" checklist for the desktop app, pinned bottom-left in
 * a local project. Device-local (localStorage) and signal-driven: no plumbing
 * into the workspace monolith — it watches the sidecar for the things it
 * teaches. "Create your first file" completes when the project's file count
 * rises above the baseline captured on first sight (so a starter pack's
 * seeded files never auto-complete it); "Ask Sunny" when any local chat has a
 * message. Dismissed or completed, it never comes back on this device.
 */

const STORAGE_KEY = 'sundial:get-set-up:v1';
const POLL_MS = 8000;

type ChecklistState = {
  dismissed: boolean;
  file: boolean;
  askedAi: boolean;
  /** Per-project file-count baselines, captured on first sight. */
  baselines: Record<string, number>;
};

const EMPTY: ChecklistState = { dismissed: false, file: false, askedAi: false, baselines: {} };

function load(): ChecklistState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<ChecklistState>;
    return {
      dismissed: Boolean(parsed.dismissed),
      file: Boolean(parsed.file),
      askedAi: Boolean(parsed.askedAi),
      baselines: parsed.baselines && typeof parsed.baselines === 'object' ? parsed.baselines : {},
    };
  } catch {
    return EMPTY;
  }
}

function save(state: ChecklistState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode — the card degrades to per-session */
  }
}

function Step({ done, label, hint }: { done: boolean; label: string; hint?: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {done ? (
        <CheckCircleIcon className="h-4.5 w-4.5 shrink-0 text-emerald-600" weight="fill" aria-hidden />
      ) : (
        <CircleIcon className="h-4.5 w-4.5 shrink-0 text-stone-300" aria-hidden />
      )}
      <span className={done ? 'text-stone-400 line-through decoration-stone-300' : 'text-stone-700'}>{label}</span>
      {hint && !done && (
        <kbd className="ml-auto rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-sans text-[10px] text-stone-500">
          {hint}
        </kbd>
      )}
    </li>
  );
}

export function GetSetUpCard({ config, projectId }: { config: SidecarConfig; projectId: string }) {
  const [state, setState] = useState<ChecklistState | null>(null);
  useEffect(() => setState(load()), []);

  const active = state !== null && !state.dismissed && !(state.file && state.askedAi);

  // Watch the sidecar for completion signals while any step is open.
  useEffect(() => {
    if (!state || state.dismissed || (state.file && state.askedAi)) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = { ...state, baselines: { ...state.baselines } };
        let changed = false;
        if (!next.file) {
          const { files } = await sidecar.listFiles(config, projectId);
          const count = files.filter((file) => file.type !== 'folder').length;
          if (!(projectId in next.baselines)) {
            next.baselines[projectId] = count;
            changed = true;
          } else if (count > next.baselines[projectId]) {
            next.file = true;
            changed = true;
          }
        }
        if (!next.askedAi) {
          const { chats } = await sidecar.listChats(config, projectId);
          if (chats.some((chat) => chat.last_message_at !== null)) {
            next.askedAi = true;
            changed = true;
          }
        }
        if (changed && !cancelled) {
          save(next);
          setState(next);
        }
      } catch {
        /* sidecar hiccup — try again next tick */
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state, config, projectId]);

  const doneCount = useMemo(
    () => (state ? 1 + Number(state.file) + Number(state.askedAi) : 1),
    [state],
  );

  if (!active || !state) return null;

  return (
    <aside
      className="fixed bottom-4 left-4 z-40 w-64 rounded-xl border border-stone-200 bg-white p-4 shadow-lg"
      data-testid="get-set-up-card"
    >
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-stone-800">Get set up</span>
        <span className="font-mono text-xs text-stone-400">{doneCount}/3</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        <Step done label="Create your first project" />
        <Step done={state.file} label="Create your first file" hint="⌘N" />
        <Step done={state.askedAi} label="Ask Sunny" hint="⌘J" />
      </ul>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          className="text-xs text-stone-400 hover:text-stone-600"
          onClick={() => {
            const next = { ...state, dismissed: true };
            save(next);
            setState(next);
          }}
          data-testid="get-set-up-dismiss"
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
