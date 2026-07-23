// Pure decision for what the chat composer's primary action should do.
//
// Classic stop/send UX on web: while a turn is streaming, the action button is
// a Stop button (interrupt regardless of any draft) and Enter is inert, so the
// user can compose a follow-up without aborting the reply — they stop first,
// then send. When nothing is streaming, the action sends.
//
// This governs the web composer ONLY. Concurrent sends from chat surfaces
// (Linq/iMessage/Slack/Discord) are still folded by the brain's
// replacement-cancel in agent-ts/src/session/lifecycle.ts.

export type ChatActionTrigger = 'enter' | 'button';
export type ChatActionDecision = 'interrupt' | 'send' | 'ignore';

export function decideChatAction(
  isChatInterruptible: boolean,
  trigger: ChatActionTrigger,
): ChatActionDecision {
  if (isChatInterruptible) {
    // The button is a Stop button while streaming; Enter does nothing so the
    // user can keep typing a follow-up without killing the in-flight reply.
    return trigger === 'button' ? 'interrupt' : 'ignore';
  }
  return 'send';
}
