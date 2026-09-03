'use client';

import { CheckCircleIcon, FileIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';

// One-time overlay shown the FIRST time a user clicks an assistant (opening
// its details, or adding straight from a list row): a ~5s staged animation
// telling the truth about what "Add to workspace" does. It is PROGRAMMATIC,
// not an agent run: (1) the files are copied into the tree under the
// assistant's folder, (2) its instructions join the workspace's agent
// context, (3) nothing runs until the next chat message. Dismissing marks it
// seen (localStorage) and it never shows again.

const SEEN_KEY = 'sundial:assistants-intro-seen';

export function hasSeenAssistantIntro(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true; // storage unavailable: never gate the feature on an intro
  }
}

export function markAssistantIntroSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* private mode: the session still saw it once */
  }
}

/** An arriving row of the mini file tree, revealed at `delay` seconds. */
function DemoFileRow({ name, delay }: { name: string; delay: number }) {
  return (
    <div
      className="sd-demo-in flex items-center gap-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-stone-700"
      style={{ animationDelay: `${delay}s` }}
    >
      <FileIcon className="h-3 w-3 shrink-0 text-amber-600" aria-hidden />
      <span className="truncate">{name}</span>
    </div>
  );
}

function StepLabel({ n, text }: { n: number; text: string }) {
  return (
    <div className="pb-1 text-[10px] font-medium uppercase tracking-wide text-stone-400">
      {n} · {text}
    </div>
  );
}

export function AssistantIntro({
  open,
  assistantName,
  assistantSlug,
  onDone,
}: {
  open: boolean;
  /** The assistant that triggered the intro; its name makes the demo concrete. */
  assistantName: string;
  assistantSlug: string;
  /** Dismissed ("Got it", Esc, backdrop) — the caller marks it seen and
   *  resumes whatever click triggered it. */
  onDone: () => void;
}) {
  return (
    <ModalShell
      open={open}
      onClose={onDone}
      ariaLabel="What adding an assistant does"
      panelClassName="w-full max-w-md rounded-2xl border border-stone-200 bg-white shadow-xl"
    >
      {/* Keyframes for the staged reveal: scoped names, plain CSS so the
          whole sequence is declarative animation-delays. */}
      <style>{`
        @keyframes sd-demo-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        .sd-demo-in { opacity: 0; animation: sd-demo-in 0.45s ease-out forwards; }
      `}</style>
      <div data-testid="assistant-intro" className="flex flex-col gap-3 p-5">
        <div>
          <h2 className="text-base font-semibold text-stone-800">
            What adding {assistantName} does
          </h2>
          <p className="mt-1 text-xs text-stone-500">
            One instant, programmatic step. No agent runs and no chat starts.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Beat 1: the files are copied into the tree, at the root. */}
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-2">
            <StepLabel n={1} text="Files are copied in" />
            <div className="flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] text-stone-600">
              <FileIcon className="h-3 w-3 shrink-0 text-stone-400" aria-hidden />
              <span>main.tex</span>
            </div>
            <DemoFileRow name={`main-${assistantSlug}.tex`} delay={0.4} />
            <DemoFileRow name="style files" delay={0.9} />
            <DemoFileRow name="references.bib" delay={1.3} />
            <p className="px-1.5 pt-1 text-[10px] text-stone-400">
              At the root, beside your files. A taken name gets a suffix; nothing is overwritten.
            </p>
          </div>

          {/* Beat 2: its instructions append to the workspace's agent context
              (the same text Settings shows), NOT a chat message. */}
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-2">
            <StepLabel n={2} text="Instructions join the workspace" />
            <div className="rounded-md border border-stone-200 bg-white px-2 py-1.5">
              <div className="text-[10px] font-medium text-stone-500">Workspace instructions</div>
              <div className="mt-1 h-1 w-3/4 rounded bg-stone-200" />
              <div
                className="sd-demo-in mt-1.5 rounded border border-amber-200 bg-amber-50 px-1.5 py-1"
                style={{ animationDelay: '2.1s' }}
              >
                <div className="text-[10px] font-medium text-amber-800">## {assistantName}</div>
                <div className="mt-1 h-1 w-full rounded bg-amber-200/70" />
                <div className="mt-0.5 h-1 w-2/3 rounded bg-amber-200/70" />
              </div>
            </div>
            <p className="px-0.5 pt-1 text-[10px] text-stone-400">
              Sunny follows these in every chat here. Editable in Settings.
            </p>
          </div>
        </div>

        {/* Beat 3: nothing runs until the next message. */}
        <div
          className="sd-demo-in flex items-center gap-1.5 text-[12px] text-stone-600"
          style={{ animationDelay: '3.6s' }}
        >
          <CheckCircleIcon className="h-4 w-4 shrink-0 text-amber-600" weight="fill" aria-hidden />
          <span>
            3 · Nothing runs until you chat. Undo anytime: delete the folder, edit the
            instructions.
          </span>
        </div>

        <div className="flex items-center justify-end pt-1">
          <button
            type="button"
            onClick={onDone}
            data-testid="assistant-intro-done"
            className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-stone-700"
          >
            Got it
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
