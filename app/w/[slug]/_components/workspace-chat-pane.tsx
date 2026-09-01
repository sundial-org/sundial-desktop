'use client';

import type { ComponentProps, DragEvent, ReactNode } from 'react';
import { ChatComposer } from './chat-composer';
import { AIElementsTranscript } from './ai-elements-transcript';
import {
  isHardStreamOpenFailure,
  isSendStartFailure,
  isTransportStreamFailure,
} from '@/lib/agent/sundial-chat-transport';
import { SunnySpinner } from '@/components/ai-elements/sunny-spinner';
import { dropEntriesFrom, readDroppedEntries } from '@/lib/workspace/dropped-entries';
import type { UploadInput } from '@/components/workspace/use-workspace-uploads';

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
  onDropFiles?: (files: UploadInput[]) => void;

  /** Replaces the transcript while set (e.g. the chat-first arrival hero on
   *  an empty chat). */
  emptyState?: ReactNode;
  /** One-line note rendered just above the composer (first local-engine use). */
  notice?: ReactNode;
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
  /** The latest turn ended in a permanent model decline (content filter) —
   *  the run_error text. Unlike other terminal failures, re-sending
   *  reproduces it, so silence would just invite a second identical bill. */
  modelDeclined?: string | null;
  /** Debounced reconnect flag from useSundialChat (see ChatErrorBanners). */
  reconnecting?: boolean;
};

/** Stream status, quietly — never a red error banner (2026-08-01 feedback).
 *  A transport drop self-heals (resumable stream + history catch-up), so it
 *  reads as a reconnecting line. A terminal run failure renders NOTHING: the
 *  working line stopping IS the signal, and re-sending is the recovery path
 *  (silent turn end). Cases that stay visible, quiet grey: a send/start
 *  failure (sign-in gate, credit gate, brain down — the run never began, so
 *  its authored CTA copy is the only signal the user gets), a failed
 *  Stop (Sunny really is still running), and a permanent model decline
 *  (content filter — the one terminal failure re-sending cannot fix, so
 *  silence would just invite a second identical blank turn and bill). */
export function ChatErrorBanners({
  streamError,
  interruptError,
  reconnecting,
  modelDeclined,
}: {
  streamError?: Error;
  interruptError?: string;
  /** Debounced drop signal from useSundialChat: false while a fresh drop may
   *  still self-heal, so the line doesn't flash on every hiccup of a long turn.
   *  Omitted (test pages, galleries) falls back to the raw classification. */
  reconnecting?: boolean;
  modelDeclined?: string | null;
}) {
  const transportDrop = Boolean(streamError && isTransportStreamFailure(streamError));
  const showReconnecting = transportDrop && (reconnecting ?? true);
  const startFailure =
    streamError && !transportDrop && isSendStartFailure(streamError) ? streamError.message : null;
  // Hard stream-open failure (401/500 from the SSE route): the run may still
  // be finishing server-side, but this window can't watch it — say so quietly
  // instead of dead-ending (Codex round 7).
  const streamOpenFailure = Boolean(
    streamError && !transportDrop && !startFailure && isHardStreamOpenFailure(streamError),
  );
  if (!showReconnecting && !startFailure && !streamOpenFailure && !interruptError && !modelDeclined) {
    return null;
  }
  return (
    <div className="px-3 pb-2 lg:px-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-1">
        {modelDeclined ? (
          <div
            className="flex min-h-6 items-center text-[14px] text-stone-500"
            data-testid="chat-model-declined"
            title={modelDeclined}
          >
            The model declined this request. Try rephrasing, or switch models.
          </div>
        ) : null}
        {startFailure ? (
          <div
            className="flex min-h-6 items-center text-[14px] text-stone-500"
            data-testid="chat-start-failure"
          >
            {startFailure}
          </div>
        ) : null}
        {streamOpenFailure ? (
          <div
            className="flex h-6 items-center text-[14px] text-stone-500"
            data-testid="chat-stream-open-failure"
            title={streamError?.message}
          >
            Couldn’t open the reply stream - reload to catch up.
          </div>
        ) : null}
        {showReconnecting ? (
          <div
            className="flex h-6 items-center gap-2 text-[14px] text-stone-500"
            data-testid="chat-stream-reconnecting"
          >
            <SunnySpinner size={14} />
            <span className="chat-shimmer">Connection hiccup - reconnecting…</span>
          </div>
        ) : null}
        {interruptError ? (
          <div
            className="flex h-6 items-center text-[14px] text-stone-500"
            data-testid="chat-interrupt-error"
            title={interruptError}
          >
            Couldn’t stop - Sunny is still running.
          </div>
        ) : null}
      </div>
    </div>
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
  notice,
  beforeContent,
  footer,
  header,
  streamError,
  interruptError,
  modelDeclined,
  reconnecting,
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
      // Snapshot entries synchronously (they go stale on the first await), so a
      // dropped folder uploads its tree instead of throwing on a bogus File.
      const entries = dropEntriesFrom(event.dataTransfer);
      if (entries) {
        void readDroppedEntries(entries)
          .then(({ files }) => {
            if (files.length > 0) onDropFiles?.(files);
          })
          .catch(() => {});
        return;
      }
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
              {notice}
              <ChatErrorBanners streamError={streamError} interruptError={interruptError} reconnecting={reconnecting} modelDeclined={modelDeclined} />
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
          {notice}
          <ChatErrorBanners streamError={streamError} interruptError={interruptError} reconnecting={reconnecting} modelDeclined={modelDeclined} />
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
