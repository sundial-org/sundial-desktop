'use client';

// One line, once ever: the first time a chat actually runs on the user's own
// Claude Code / Codex install, say where the agent is running and who pays for
// it. Replaces the upfront engine chooser — the composer chip carries the
// standing answer, this only explains it the first time. Fades on its own.

import { useEffect } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { CHAT_HARNESS_LABELS, type ChatHarness } from '@/lib/workspace/chat-runtime';

export function LocalEngineNotice({
  harness,
  onDismiss,
}: {
  harness: ChatHarness;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 12_000);
    return () => clearTimeout(timer);
  }, [onDismiss]);
  const device =
    typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) ? 'your Mac' : 'this computer';
  return (
    <div
      data-testid="local-engine-notice"
      className="flex shrink-0 items-center gap-2 px-4 py-1.5 text-[11px] text-stone-500 animate-[workspaceFileContentFadeIn_300ms_ease-out]"
    >
      <span className="min-w-0 flex-1 truncate">
        Using {CHAT_HARNESS_LABELS[harness]} from {device}. Runs on your existing subscription.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-stone-400 hover:bg-stone-200 hover:text-stone-600"
      >
        <XIcon className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
