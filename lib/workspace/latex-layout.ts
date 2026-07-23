export type LatexChatCollapseState = {
  chatOpen: boolean;
  texFileKey: string | null;
};

export function shouldCollapseLatexPdfForChatOpen(
  previous: LatexChatCollapseState,
  next: LatexChatCollapseState,
  /** True once the user explicitly picked a view mode on this document —
   *  their choice must survive chat close/reopen cycles. */
  userPinnedViewMode = false,
): boolean {
  if (userPinnedViewMode) return false;
  if (!next.chatOpen || !next.texFileKey) return false;
  return !previous.chatOpen || previous.texFileKey !== next.texFileKey;
}

// Mirror of the chat status union in workspace-chat-model. Kept local so this
// pure layout helper stays dependency-free and unit-testable.
export type AgentTurnStatus =
  | 'idle'
  | 'working'
  | 'done'
  | 'error'
  | 'starting'
  | 'stopped';

const ACTIVE_TURN_STATUSES: AgentTurnStatus[] = ['working', 'starting'];
// Terminal states that count as a *clean* finish. `error` is excluded so a
// failed turn never auto-recompiles or yanks the user into Review.
const FINISHED_TURN_STATUSES: AgentTurnStatus[] = ['idle', 'done', 'stopped'];

export function isAgentTurnActive(status: AgentTurnStatus): boolean {
  return ACTIVE_TURN_STATUSES.includes(status);
}

/** Rising edge of a Sunny turn completing (§15.5). */
export function isAgentTurnJustFinished(
  previous: AgentTurnStatus,
  next: AgentTurnStatus,
): boolean {
  return isAgentTurnActive(previous) && FINISHED_TURN_STATUSES.includes(next);
}

/** Rising edge of a new Sunny turn starting — used to disarm a stale pending review. */
export function isAgentTurnJustStarted(
  previous: AgentTurnStatus,
  next: AgentTurnStatus,
): boolean {
  return !isAgentTurnActive(previous) && isAgentTurnActive(next);
}
