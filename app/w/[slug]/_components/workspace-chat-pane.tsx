'use client';

import type { ComponentProps, DragEvent, ReactNode } from 'react';
import { ChatComposer } from './chat-composer';
import { AIElementsTranscript } from './ai-elements-transcript';
import { isTransportStreamFailure } from '@/lib/agent/sundial-chat-transport';

// The transcript prop bag is whatever AIElementsTranscript consumes —
// other call sites in page.tsx still build the broader legacy-ChatTranscript
// prop bag; we narrow at the boundary by accepting any superset.
type ChatTranscriptProps = ComponentProps<typeof AIElementsTranscript> &
  Record<string, unknown>;

// `key` is React-managed and not part of the component's prop bag; we set
// it explicitly on the composer below.
type ChatComposerProps = Omit<ComponentProps<typeof ChatComposer>, 'key'>;

type WorkspaceChatPaneProps = {
  /**
   * `primary` is the main chat surface (chat mode, left/center) — handles
   * drag-and-drop and grows to fill.
   * `space-side` is the right-hand chat panel in space mode — fixed width
   * supplied by the parent, renders a header (Sunny # + close) at the top.
   */
  variant: 'primary' | 'space-side';
  /** Stable key for the composer so React remounts on chat/mode transitions. */
  composerKey: string;
  transcriptProps: ChatTranscriptProps;
  composerProps: ChatComposerProps;

  // primary-only: drop-zone wiring
  canWrite?: boolean;
  currentChatId?: string | null;
  isChatDropActive?: boolean;
  setIsChatDropActive?: (value: boolean) => void;
  onDropFiles?: (files: File[]) => void;

  /** Replaces the transcript while set (e.g. the local engine onboarding
   *  picker on an empty first-run chat). */
  emptyState?: ReactNode;
  /** Extra content rendered before the header (e.g. ResizeHandle). */
  beforeContent?: ReactNode;
  /** Replaces the composer (and error banners) while set — e.g. the read-only
   *  external-session banner with its Import/Resume actions. */
  footer?: ReactNode;
  /** Optional header bar (chat picker, side-chat controls, etc.). */
  header?: ReactNode;
  /** Last error from the active SSE stream (useChat). Rendered as a small
   *  banner above the composer so Gateway / provider failures are visible
   *  to the user instead of silently dead-ending. */
  streamError?: Error | undefined;
  /** Message shown when a Stop/interrupt request fails. Surfacing it matters:
   *  a swallowed interrupt looks identical to "nothing happened". */
  interruptError?: string | undefined;
};

function ChatErrorBanner({ title, message, testId }: { title: string; message: string; testId: string }) {
  return (
    <div className="px-3 pb-2 lg:px-6" data-testid={testId}>
      <div className="mx-auto max-w-2xl rounded-xl border border-red-200 bg-red-50 px-3.5 py-2 text-xs leading-snug text-red-800">
        <span className="font-medium">{title}</span>{' '}
        <span className="[overflow-wrap:anywhere]">{message}</span>
      </div>
    </div>
  );
}

export function ChatErrorBanners({ streamError, interruptError }: { streamError?: Error; interruptError?: string }) {
  // A dead SSE pipe is not a failed run — the reply usually still completes
  // server-side and lands via history catch-up, which also clears the error.
  // Don't blame Sunny for a dropped connection.
  const stream = !streamError
    ? null
    : isTransportStreamFailure(streamError)
      ? { title: 'Connection lost:', message: 'Sunny may still be working — the reply will appear once it finishes.' }
      : { title: 'Sunny couldn’t reply:', message: streamError.message };
  return (
    <>
      {stream ? (
        <ChatErrorBanner title={stream.title} message={stream.message} testId="chat-stream-error" />
      ) : null}
      {interruptError ? (
        <ChatErrorBanner title="Couldn’t stop Sunny:" message={interruptError} testId="chat-interrupt-error" />
      ) : null}
    </>
  );
}

export function WorkspaceChatPane({
  variant,
  composerKey,
  transcriptProps,
  composerProps,
  canWrite,
  currentChatId,
  isChatDropActive,
  setIsChatDropActive,
  onDropFiles,
  emptyState,
  beforeContent,
  footer,
  header,
  streamError,
  interruptError,
}: WorkspaceChatPaneProps) {
  const dropZoneProps = {
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!canWrite || !currentChatId) return;
      const types = Array.from(event.dataTransfer.types ?? []);
      if (!types.includes('Files')) return;
      event.preventDefault();
      setIsChatDropActive?.(true);
    },
    onDragLeave: () => setIsChatDropActive?.(false),
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!canWrite || !currentChatId) return;
      event.preventDefault();
      event.stopPropagation();
      setIsChatDropActive?.(false);
      const droppedFiles = Array.from(event.dataTransfer.files ?? []);
      if (droppedFiles.length === 0) return;
      onDropFiles?.(droppedFiles);
    },
  };

  if (variant === 'space-side') {
    return (
      <>
        {beforeContent}
        <div className="relative flex min-h-0 flex-1 flex-col" {...dropZoneProps}>
          {header}
          {emptyState ?? <AIElementsTranscript {...transcriptProps} />}
          {footer ?? (
            <>
              <ChatErrorBanners streamError={streamError} interruptError={interruptError} />
              <ChatComposer key={composerKey} {...composerProps} />
            </>
          )}
          {isChatDropActive ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-stone-400 bg-stone-100/80 text-sm text-stone-600">
              Drop files to attach
            </div>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col"
      {...dropZoneProps}
    >
      {header}
      {emptyState ?? <AIElementsTranscript {...transcriptProps} />}
      {footer ?? (
        <>
          <ChatErrorBanners streamError={streamError} interruptError={interruptError} />
          <ChatComposer key={composerKey} {...composerProps} />
        </>
      )}
      {isChatDropActive ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-stone-400 bg-stone-100/80 text-sm text-stone-600">
          Drop files to attach
        </div>
      ) : null}
    </div>
  );
}
