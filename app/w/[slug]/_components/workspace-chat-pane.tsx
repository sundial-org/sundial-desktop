'use client';

import { useState, type ComponentProps, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ChatComposer } from './chat-composer';
import { AIElementsTranscript } from './ai-elements-transcript';
import {
  isHardStreamOpenFailure,
  isOutOfCreditsFailure,
  isSendStartFailure,
  isTransportStreamFailure,
} from '@/lib/agent/sundial-chat-transport';
import { ModalShell } from '@/components/modal-shell';
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
  /** Unified Open with… flow, surfaced by the out-of-credits UI. */
  onOpenWith?: () => void;
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
  onOpenWith,
}: {
  streamError?: Error;
  interruptError?: string;
  /** Debounced drop signal from useSundialChat: false while a fresh drop may
   *  still self-heal, so the line doesn't flash on every hiccup of a long turn.
   *  Omitted (test pages, galleries) falls back to the raw classification. */
  reconnecting?: boolean;
  modelDeclined?: string | null;
  /** Opens the unified Open with… flow — the route to keep working in another
   *  tool once credits run out. Absent on local workspaces (already local). */
  onOpenWith?: () => void;
}) {
  const transportDrop = Boolean(streamError && isTransportStreamFailure(streamError));
  const showReconnecting = transportDrop && (reconnecting ?? true);
  const startFailure =
    streamError && !transportDrop && isSendStartFailure(streamError) ? streamError.message : null;
  // Hitting the credit wall is a dead end users silently churn at (every
  // non-refilled wall-hitter went quiet the same day), so it gets a MODAL
  // with a human way out, not just the banner: email us what you're working
  // on and we top you up. Dismissal is keyed on the error object, so the
  // next blocked send raises it again.
  const [creditsModalDismissedFor, setCreditsModalDismissedFor] = useState<Error | null>(null);
  const outOfCredits = Boolean(streamError && !transportDrop && isOutOfCreditsFailure(streamError));
  const creditsModalOpen = outOfCredits && creditsModalDismissedFor !== streamError;
  const dismissCreditsModal = () => setCreditsModalDismissedFor(streamError ?? null);
  const creditsModal = creditsModalOpen ? (
    <ModalShell
      open
      onClose={dismissCreditsModal}
      ariaLabel="Out of AI credits"
      overlayClassName="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      panelClassName="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-xl"
    >
      <div data-testid="out-of-credits-modal">
        <h2 className="text-lg font-semibold text-stone-800">You&apos;re out of AI credits</h2>
        <p className="mt-2 text-sm text-stone-600">
          We give more credits to people building real things, no payment needed. Send us a line
          about what you&apos;re working on and we&apos;ll top you up.
        </p>
        {onOpenWith ? (
          <p className="mt-2 text-sm text-stone-600">
            You can also open this workspace in Claude Code, Codex, or another tool and keep
            working there for free.
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <a
            href={`mailto:matthew@sundial.md?subject=${encodeURIComponent('More Sundial credits')}&body=${encodeURIComponent("Hi, I ran out of credits. Here's what I'm working on: ")}`}
            data-testid="out-of-credits-email"
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            Email matthew@sundial.md
          </a>
          {onOpenWith ? (
            <button
              type="button"
              data-testid="out-of-credits-open-with"
              onClick={() => {
                dismissCreditsModal();
                onOpenWith();
              }}
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-800 hover:bg-stone-100"
            >
              Open with…
            </button>
          ) : null}
          <button
            type="button"
            onClick={dismissCreditsModal}
            className="rounded-lg px-3 py-2 text-sm text-stone-600 hover:bg-stone-100"
          >
            Close
          </button>
        </div>
      </div>
    </ModalShell>
  ) : null;
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
      {creditsModal}
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
          outOfCredits ? (
            // The wall stays visible AND actionable after the modal closes:
            // the same two ways out, highlighted, until credits come back.
            <div
              className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[14px] text-stone-700"
              data-testid="chat-start-failure"
            >
              <span>{startFailure}</span>
              <a
                href={`mailto:matthew@sundial.md?subject=${encodeURIComponent('More Sundial credits')}&body=${encodeURIComponent("Hi, I ran out of credits. Here's what I'm working on: ")}`}
                data-testid="out-of-credits-banner-email"
                className="font-medium text-stone-900 underline underline-offset-2"
              >
                Email us for more
              </a>
              {onOpenWith ? (
                <button
                  type="button"
                  data-testid="out-of-credits-banner-open-with"
                  onClick={onOpenWith}
                  className="font-medium text-stone-900 underline underline-offset-2"
                >
                  Open with…
                </button>
              ) : null}
            </div>
          ) : (
            <div
              className="flex min-h-6 items-center text-[14px] text-stone-500"
              data-testid="chat-start-failure"
            >
              {startFailure}
            </div>
          )
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

// Clicking the pane's dead space returns the caret to the composer (the
// Slack/ChatGPT contract). Without this, canvas click → click back on the
// chat pane left focus on <body>, so typing went nowhere (bulldozer: "Cursor
// is not set into input field inside new chats after clicking in the canvas
// and returning to chat"). Interactive targets keep the click to themselves,
// and a real text selection in the transcript is never stolen.
export function focusComposerOnDeadClick(event: ReactMouseEvent<HTMLDivElement>) {
  if (event.defaultPrevented) return;
  const target = event.target as HTMLElement;
  if (
    target.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [role="menu"], [role="menuitem"], [role="dialog"]',
    )
  )
    return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  event.currentTarget
    .querySelector<HTMLElement>('[data-testid="chat-composer-input"]')
    ?.focus();
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
  onOpenWith,
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
        <div className="relative flex min-h-0 flex-1 flex-col" onClick={focusComposerOnDeadClick} {...dropZoneProps}>
          {header}
          {emptyState ?? <AIElementsTranscript {...transcriptProps} />}
          {footer ?? (
            <>
              {notice}
              <ChatErrorBanners streamError={streamError} interruptError={interruptError} reconnecting={reconnecting} modelDeclined={modelDeclined} onOpenWith={onOpenWith} />
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
      onClick={focusComposerOnDeadClick}
      {...dropZoneProps}
    >
      {header}
      {emptyState ?? <AIElementsTranscript {...transcriptProps} />}
      {footer ?? (
        <>
          {notice}
          <ChatErrorBanners streamError={streamError} interruptError={interruptError} reconnecting={reconnecting} modelDeclined={modelDeclined} onOpenWith={onOpenWith} />
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
