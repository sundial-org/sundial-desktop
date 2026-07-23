'use client';

import { useEffect, useState } from 'react';
import { readJsonResponse } from '@/lib/http/read-json-response';
import type { ChatTurnEditsResponse } from '@/lib/workspace/chat-turn-edits';

/**
 * Reads the authoritative set of files touched in `chatId` straight from the
 * `doc_edits` table via `/api/workspace/chat-turn-edits`. Refetches whenever
 * `invalidationToken` changes — pair it with `useDocEditsRealtimeKey` so a
 * Supabase Realtime INSERT (or visibility/focus) triggers a fresh pull.
 *
 * Returns the latest payload or `null` while no data has loaded yet.
 */
export function useChatTurnEdits(
  chatId: string | null,
  invalidationToken: number | string = '',
): ChatTurnEditsResponse | null {
  const [payload, setPayload] = useState<ChatTurnEditsResponse | null>(null);

  useEffect(() => {
    if (!chatId) {
      setPayload(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/workspace/chat-turn-edits?chatId=${encodeURIComponent(chatId)}`,
          { cache: 'no-store' },
        );
        if (!response.ok) return;
        const next = await readJsonResponse<ChatTurnEditsResponse>(response);
        if (cancelled || !next) return;
        // Preserve identity when nothing changed so downstream memos don't churn.
        setPayload((current) =>
          current && JSON.stringify(current) === JSON.stringify(next) ? current : next,
        );
      } catch {
        // best-effort lookup — fall through with the prior payload
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, invalidationToken]);

  return payload;
}
