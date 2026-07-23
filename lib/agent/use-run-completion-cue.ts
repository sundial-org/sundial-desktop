import { useEffect, useRef, useState } from 'react';

/** Session-local falling-edge detector for the live chat run: returns the id
 *  of the chat whose run just completed normally, so the transcript can stamp
 *  a quiet "Done" under its final turn ("not clear when the model has
 *  finished" — user-interview feedback). Guards against the ways the run
 *  state can fall without a real completion:
 *  - while any evidence says the reply is still in flight (a stall flap or a
 *    lagging store), the decision is deferred — never credited — until every
 *    signal is quiet;
 *  - a run that saw an interrupt request never qualifies, even when the
 *    falling edge beats the `interrupted` metadata.
 *  Resets on the next rising edge — and on navigating away from the chat —
 *  so the cue always refers to the run the user just watched finish, never a
 *  turn they come back to later. */
export function useRunCompletionCue({
  hasLiveChatRun,
  currentChatId,
  isInterrupting,
  latestAssistantInterrupted,
  latestReplyUnsettled,
}: {
  hasLiveChatRun: boolean;
  currentChatId: string | null;
  isInterrupting: boolean;
  latestAssistantInterrupted: boolean;
  /** Any evidence the latest reply is not a settled, normal finish: the
   *  cached row's `metadata.streaming === true`, a still-open useChat stream
   *  (the cached row can lag the live SSE — they're separate stores), or a
   *  client-side transport error. All signals must be quiet before a falling
   *  edge counts as a completion (Codex P2s #836). */
  latestReplyUnsettled: boolean;
}): string | null {
  const [completedRunChatId, setCompletedRunChatId] = useState<string | null>(null);
  const liveRunRef = useRef<{ chatId: string; interrupted: boolean } | null>(null);
  useEffect(() => {
    if (hasLiveChatRun && currentChatId) {
      if (liveRunRef.current?.chatId !== currentChatId) {
        liveRunRef.current = { chatId: currentChatId, interrupted: false };
      }
      if (isInterrupting) liveRunRef.current.interrupted = true;
      setCompletedRunChatId(null);
      return;
    }
    const run = liveRunRef.current;
    if (run && run.chatId === currentChatId && latestReplyUnsettled) {
      // The run-state stores can settle in different renders — the DB-derived
      // busy state may fall while the SSE is still open — and a transport
      // error may yet recover via auto-resume. Not decidable: keep the run
      // armed and decide only once every signal is quiet (Codex P2 #836). A
      // turn that dies without a finalize keeps its streaming metadata, and a
      // terminal error keeps its error status, so neither ever credits.
      return;
    }
    liveRunRef.current = null;
    if (run && run.chatId === currentChatId && !run.interrupted && !latestAssistantInterrupted) {
      setCompletedRunChatId(run.chatId);
      return;
    }
    // Navigating away retires the cue for good — it must not resurface on a
    // later visit to the chat (Codex P2).
    setCompletedRunChatId((prev) => (prev && prev !== currentChatId ? null : prev));
  }, [
    hasLiveChatRun,
    currentChatId,
    isInterrupting,
    latestAssistantInterrupted,
    latestReplyUnsettled,
  ]);
  return completedRunChatId;
}
