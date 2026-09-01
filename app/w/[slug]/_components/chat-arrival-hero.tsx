'use client';

// The chat-first landing surface: what an empty chat shows when it IS the
// workspace (chat-sole arrival). A greeting plus a few starter prompts that
// SEND on click when the host provides `onSendPrompt` ("send quick prompt on
// click" — user interviews; a chip that only pre-fills read as broken), and
// fall back to pre-filling the composer otherwise. Rendered as the chat
// pane's emptyState, so the real composer below stays the single input.

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
  agentName = 'Sundial Agent',
  hasChat = true,
  onSendPrompt,
}: {
  agentName?: string;
  /** The fill-composer seam drops events with no active chat — keep the
   *  chips off-screen until the arrival draft/selection has an id. */
  hasChat?: boolean;
  /** Send the prompt as a turn immediately; absent → pre-fill the composer. */
  onSendPrompt?: (text: string) => void;
}) {
  const firePrompt = onSendPrompt ?? fillComposer;
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
            onClick={() => firePrompt(suggestion)}
            className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 shadow-sm transition-colors hover:border-stone-400 hover:bg-stone-50"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The one-chip empty state for ORDINARY empty chats (the arrival hero above
 *  keeps the chat-sole landing). One suggestion only, deliberately: a quiet
 *  on-ramp, not a menu. */
export function EmptyChatPrompt({
  hasChat = true,
  onSendPrompt,
}: {
  hasChat?: boolean;
  onSendPrompt?: (text: string) => void;
}) {
  const firePrompt = onSendPrompt ?? fillComposer;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-7"
      data-testid="empty-chat-prompt"
    >
      {hasChat ? (
        <button
          type="button"
          onClick={() => firePrompt('Give me a tour of this project')}
          className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 shadow-sm transition-colors hover:border-stone-400 hover:bg-stone-50"
        >
          Give me a tour of this project
        </button>
      ) : null}
    </div>
  );
}
