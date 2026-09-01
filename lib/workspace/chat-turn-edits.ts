export type ChatTurnEditSummary = {
  assistantMessageId: string;
  /** Chat that owns the assistant message — used to jump to the right thread. */
  chatId: string | null;
  /** Transcript message id to scroll to, when it differs from the review id.
   *  Cloud turns ARE their message id and omit it; local review units are
   *  synthetic `applied-<rowId>` sessions and carry the real one here. */
  jumpMessageId?: string | null;
  createdAt: string | null;
  /** Raw `doc_edits.author_id` (e.g. `sunny:354` or a user id). */
  authorId: string | null;
  editedFileCount: number;
  filePaths: string[];
  messagePreview: string;
};

export type ChatTurnEditsResponse = {
  chatId: string;
  turns: ChatTurnEditSummary[];
};

export function pickSelectedChatTurnId(
  turns: ChatTurnEditSummary[],
  currentAssistantMessageId: string | null,
) {
  if (currentAssistantMessageId) {
    const currentTurn = turns.find(
      (turn) => turn.assistantMessageId === currentAssistantMessageId,
    );
    if (currentTurn) {
      return currentTurn.assistantMessageId;
    }
  }
  return turns[0]?.assistantMessageId ?? null;
}

export function summarizeChatTurnMessage(
  content: string | null | undefined,
  editedFileCount: number,
  maxLength = 160,
) {
  const collapsed = (content ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed || /^done[.!]?$/i.test(collapsed)) {
    return editedFileCount === 1 ? 'Edited 1 file' : `Edited ${editedFileCount} files`;
  }
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
