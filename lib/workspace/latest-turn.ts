import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Returns the id of the latest assistant message in `chatId`, or null when the
 * chat has no assistant turns.
 */
export async function getLatestAssistantTurnId(
  supabase: SupabaseClient,
  chatId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('chat_id', chatId)
    .eq('role', 'assistant')
    .order('sequence', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return typeof data.id === 'string' ? data.id : null;
}

/**
 * Returns true iff `assistantMessageId` is the latest assistant message in `chatId`.
 * Used by `/keep-chunk` and `/undo-chunk` to enforce the "only latest turn is mutable"
 * rule server-side (UI already enforces it client-side via `latestAssistantMessageIdInChat`).
 *
 * Returns false when the chat has no assistant turns.
 */
export async function isLatestAssistantTurn(
  supabase: SupabaseClient,
  chatId: string,
  assistantMessageId: string,
): Promise<boolean> {
  const latest = await getLatestAssistantTurnId(supabase, chatId);
  return latest === assistantMessageId;
}
