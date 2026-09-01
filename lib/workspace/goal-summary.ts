import { generateText } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveChatTitle } from './derive-chat-title';

/** Strip a "Title:"/"Goal:" label, collapse whitespace, trim quotes/periods. */
function cleanLine(value: string | undefined): string {
  return (value ?? '')
    .replace(/^\s*(?:title|goal)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'`\s]+|["'`.\s]+$/g, '');
}

/** A short chat title: at most 6 words, no quotes/periods. Null when empty. */
export function normalizeChatTitle(value: string | undefined): string | null {
  const cleaned = cleanLine(value);
  return cleaned ? cleaned.split(' ').slice(0, 6).join(' ').slice(0, 60) : null;
}

export type ChatNaming = { title: string | null; goalSummary: string | null };

/**
 * One Haiku call (via the AI Gateway) names a chat from its first user
 * message: a short title plus a one-line goal phrase for the card subtitle.
 * Best-effort: returns null on any failure or when no gateway key is
 * configured, so callers can fall back and fire-and-forget.
 */
export async function generateChatNaming(firstMessage: string): Promise<ChatNaming | null> {
  const text = firstMessage.trim();
  if (!text || !process.env.AI_GATEWAY_API_KEY) return null;
  try {
    const result = await generateText({
      model: gateway('anthropic/claude-haiku-4.5'),
      system:
        'Name a new chat from its first user message. Output exactly two lines, nothing else:\n' +
        'Line 1 — a short chat title: at most 6 words, capitalized naturally, no quotes, no trailing punctuation.\n' +
        "Line 2 — the user's goal in one short lowercase-start phrase, max 8 words, no quotes, no trailing punctuation.",
      prompt: text.slice(0, 2000),
      maxOutputTokens: 60,
    });
    const [titleLine, goalLine] = result.text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const goal = cleanLine(goalLine);
    return { title: normalizeChatTitle(titleLine), goalSummary: goal ? goal.slice(0, 80) : null };
  } catch (error) {
    console.warn('[goal-summary] generation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * First-message auto-naming. Generates title + goal in one model call; when
 * generation fails (or no gateway key) the title falls back to the truncated
 * message text once — no retries, no revert loops. The title write is
 * conditional on `title` still being unset so a user rename in the interim is
 * never overwritten.
 */
export async function nameChatFromFirstMessage(
  supabase: SupabaseClient,
  chatId: string,
  firstMessage: string,
): Promise<void> {
  const naming = await generateChatNaming(firstMessage);
  const title = naming?.title ?? deriveChatTitle(firstMessage);
  const { data: won } = await supabase
    .from('chats')
    .update({ title })
    .eq('id', chatId)
    .is('title', null)
    .select('id');
  // The summary rides the SAME race outcome as the title: a naming call that
  // lost the CAS (user rename, or a duplicate call) must not overwrite the
  // winner's goal_summary with a later turn's.
  if (naming?.goalSummary && won?.length) {
    // Separate write: chats.goal_summary may not be migrated yet, and its
    // missing-column error must not take the title update down with it.
    await supabase.from('chats').update({ goal_summary: naming.goalSummary }).eq('id', chatId);
  }
}
