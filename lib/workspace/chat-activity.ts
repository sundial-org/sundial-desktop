// Sparse latest-message state per chat, as returned by the
// workspace_chat_list_rows RPC (see the chat_list_latest_message_state
// migration). Only role + metadata probes — never content or parts.
export type ChatLatestMessageState = {
  latest_message_role?: string | null;
  latest_message_has_parts?: boolean | null;
  latest_message_run_status?: string | null;
  latest_message_seeded?: boolean | null;
  latest_message_has_content?: boolean | null;
};

/**
 * A chat has an agent run in flight when its newest message is the assistant
 * row the brain inserts at run start and no terminal marker has landed yet:
 * completion backfills `metadata.parts`, failure stamps `metadata.run_status`
 * ('error' | 'aborted' | 'incomplete'). A crashed run that never persisted
 * either marker reads as active — it IS an uncompleted turn.
 *
 * Seeded assistant rows (a workspace's `metadata.seeded` intro greeting) are
 * NOT runs — they carry no parts/run_status but no turn ever owns them, so they
 * would otherwise read as "running" forever on every fresh chat.
 *
 * Content is the legacy guard: the in-flight row is inserted EMPTY (content
 * backfills only at finalize, alongside parts), so any content means the reply
 * finished — including pre-`metadata.parts` completed replies that carry no
 * modern markers at all and would otherwise read as active forever.
 */
export function isAgentRunActive(row: ChatLatestMessageState | null | undefined): boolean {
  if (!row) return false;
  return (
    row.latest_message_role === 'assistant' &&
    !row.latest_message_has_parts &&
    !row.latest_message_run_status &&
    !row.latest_message_seeded &&
    !row.latest_message_has_content
  );
}
