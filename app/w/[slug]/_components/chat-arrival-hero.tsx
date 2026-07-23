'use client';

// The chat-first landing surface: what an empty chat shows when it IS the
// workspace (chat-sole arrival). A greeting plus a few starter prompts that
// pre-fill the composer — the first act is telling the agent what you want,
// not staring at a blank page. Rendered as the chat pane's emptyState, so the
// real composer below stays the single input.

import { SunnyAnimation } from '@/components/sunny-animation';

const SUGGESTIONS = [
  'Turn my rough notes into a first draft',
  'Outline a piece, then draft the opening',
  'Give me a tour of this project',
];

function fillComposer(text: string) {
  window.dispatchEvent(
    new CustomEvent('sundial:fill-composer', { detail: { text, switchToChat: true } }),
  );
}

export function ChatArrivalHero({
  agentName = 'Sunny',
  hasChat = true,
}: {
  agentName?: string;
  /** The fill-composer seam drops events with no active chat — keep the
   *  chips off-screen until the arrival draft/selection has an id. */
  hasChat?: boolean;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-7"
      data-testid="chat-arrival-hero"
    >
      <SunnyAnimation name="laptop" className="w-24 opacity-95" />
      <h2 className="mt-3 text-center text-xl font-semibold tracking-tight text-stone-800">
        What are we working on?
      </h2>
      <p className="mt-1.5 max-w-sm text-center text-[13px] leading-snug text-stone-500">
        Describe it and {agentName} drafts it in your files. Every edit comes back to you, tracked
        and ready to review.
      </p>
      <div className="mt-5 flex min-h-[60px] max-w-md flex-wrap items-center justify-center gap-2">
        {hasChat && SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => fillComposer(suggestion)}
            className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-600 transition-colors hover:border-stone-300 hover:bg-stone-50 hover:text-stone-800"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
