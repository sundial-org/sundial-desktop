'use client';

// First-run engine picker for local (desktop) projects: choose which agent
// powers new chats — Sunny (Sundial's cloud agent) or the user's own Claude
// Code / Codex install (subscription auth, runs on this computer). Rendered
// in the empty chat transcript until a default engine is chosen; detected
// logged-in engines get a check so the working one is the obvious pick.

import { CheckCircleIcon } from '@phosphor-icons/react';
import type { ChatHarness } from '@/lib/workspace/chat-runtime';

type EngineState = { available: boolean; loggedIn: boolean };

export type LocalEnginesState = { claude: EngineState; codex: EngineState };

const detected = (engine: EngineState) => engine.available && engine.loggedIn;

export function LocalEngineOnboarding({
  engines,
  onChoose,
}: {
  engines: LocalEnginesState;
  onChoose: (harness: ChatHarness) => void;
}) {
  const options: Array<{
    harness: ChatHarness;
    title: string;
    body: string;
    state: EngineState | null;
    hint: string | null;
  }> = [
    {
      harness: 'claude',
      title: 'Claude Code',
      body: 'Your Claude subscription, running right on this computer.',
      state: engines.claude,
      hint: detected(engines.claude) ? null : 'Install Claude Code and run `claude login` to use it',
    },
    {
      harness: 'openai',
      title: 'Codex',
      body: 'Your ChatGPT subscription, running right on this computer.',
      state: engines.codex,
      hint: detected(engines.codex) ? null : 'Install Codex and run `codex login` to use it',
    },
    {
      harness: 'vercel',
      title: 'Sundial Agent',
      body: 'Sunny in the cloud — any model, needs a Sundial account.',
      state: null,
      hint: null,
    },
  ];

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-6" data-testid="engine-onboarding">
      <div className="w-full max-w-sm">
        <h2 className="text-center text-[15px] font-medium text-stone-800">Who should power this chat?</h2>
        <p className="mt-1 text-center text-xs text-stone-500">
          Pick your agent — it becomes the default for new chats. You can still switch per chat.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {options.map((option) => (
            <button
              key={option.harness}
              type="button"
              data-testid={`engine-choice-${option.harness}`}
              onClick={() => onChoose(option.harness)}
              className="group flex items-start gap-3 rounded-xl border border-stone-200 bg-white px-3.5 py-3 text-left transition-colors hover:border-stone-300 hover:bg-stone-50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-stone-800">
                  {option.title}
                  {option.state && detected(option.state) ? (
                    <span
                      className="flex items-center gap-1 rounded-full bg-green-50 px-1.5 py-0.5 text-[10px] font-normal text-green-700"
                      data-testid={`engine-detected-${option.harness}`}
                    >
                      <CheckCircleIcon weight="fill" className="h-3 w-3" />
                      Detected
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-xs leading-snug text-stone-500">{option.body}</div>
                {option.hint ? (
                  <div className="mt-0.5 text-[11px] leading-snug text-stone-400">{option.hint}</div>
                ) : null}
              </div>
              <span className="mt-0.5 hidden shrink-0 text-xs text-stone-400 group-hover:inline">Choose →</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
