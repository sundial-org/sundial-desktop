'use client';

import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { createBrowserClient } from '@/lib/supabase/browser';
import { DEFAULT_MODEL_REF, normalizeChatModelRef } from '@/lib/workspace/chat-runtime';
import { findPreferredWorkspaceChatIndex } from '@/lib/workspace/chat-selection';
import { findIndexByIdRef } from '@/lib/workspace/public-ids';
import type { ChatMessage, ChatStatus } from './workspace-chat-model';

export function useWorkspaceChatListEffects<TChatThread>({
  projectId,
  isChatVisible,
  workspaceRealtimeChatIds,
  supabaseClient,
  currentChatRef,
  loadChatThreads,
  setChatsLoaded,
}: {
  projectId: string;
  /** Whether the chat transcript is on screen (any column), read via a ref so
   *  toggling panels doesn't re-subscribe the realtime channel. */
  isChatVisible: boolean;
  workspaceRealtimeChatIds: string[];
  supabaseClient: ReturnType<typeof createBrowserClient>;
  currentChatRef: MutableRefObject<{ id: string } | null>;
  loadChatThreads: () => Promise<TChatThread[]>;
  setChatsLoaded: Dispatch<SetStateAction<boolean>>;
}) {
  const isChatVisibleRef = useRef(isChatVisible);
  isChatVisibleRef.current = isChatVisible;
  useEffect(() => {
    if (!projectId) return;
    let isActive = true;
    const run = async () => {
      setChatsLoaded(false);
      await loadChatThreads();
    };
    if (isActive) {
      void run();
    }
    return () => {
      isActive = false;
    };
  }, [loadChatThreads, projectId, setChatsLoaded]);

  useEffect(() => {
    if (!projectId) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadChatThreads();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [loadChatThreads, projectId]);

  useEffect(() => {
    if (!projectId || !supabaseClient) return;
    const channel = supabaseClient.channel(`workspace-chats-${projectId}`);
    const refreshChats = () => {
      void loadChatThreads();
    };
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chats', filter: `project_id=eq.${projectId}` },
      refreshChats
    );
    channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'chats', filter: `project_id=eq.${projectId}` },
      refreshChats
    );
    workspaceRealtimeChatIds.forEach((chatId) => {
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
        () => {
          // Skip the redundant list refresh only when the user is already
          // looking at this chat's transcript (read via ref so panel toggles
          // don't tear down and re-subscribe the channel — dropping messages).
          if (
            isChatVisibleRef.current &&
            document.visibilityState === 'visible' &&
            currentChatRef.current?.id === chatId
          ) {
            return;
          }
          refreshChats();
        }
      );
    });
    channel.subscribe();
    return () => {
      supabaseClient.removeChannel(channel);
    };
  }, [currentChatRef, loadChatThreads, projectId, supabaseClient, workspaceRealtimeChatIds]);

}

export function useFillComposerEvent({
  currentChatRef,
  messageInputByChatIdRef,
  sectionAppendsByChatIdRef,
  setStoredMessageDraft,
  setShouldFocusChatInput,
  setMode,
}: {
  currentChatRef: MutableRefObject<{ id: string } | null>;
  messageInputByChatIdRef: MutableRefObject<Record<string, string>>;
  sectionAppendsByChatIdRef: MutableRefObject<Record<string, Record<string, string>>>;
  setStoredMessageDraft: (chatId: string, text: string, notify?: boolean) => void;
  setShouldFocusChatInput: Dispatch<SetStateAction<boolean>>;
  // Reveal the chat surface. Only ever called with 'chat'; a plain value setter
  // (not the full SetStateAction shape) so callers can pass a narrow shim.
  setMode: (mode: 'chat' | 'space') => void;
}) {
  useEffect(() => {
    const handleFillComposer = (event: Event) => {
      const customEvent = event as CustomEvent<{
        text?: string;
        switchToChat?: boolean;
        mode?: 'replace' | 'append';
        sectionKey?: string;
      }>;
      const text = customEvent.detail?.text;
      if (typeof text !== 'string' || !text) return;
      const chatId = currentChatRef.current?.id;
      if (!chatId) return;
      const fillMode = customEvent.detail?.mode ?? 'replace';
      const sectionKey = customEvent.detail?.sectionKey;
      if (fillMode === 'append') {
        const existing = messageInputByChatIdRef.current[chatId] ?? '';
        let base = existing;
        if (sectionKey) {
          const prev = sectionAppendsByChatIdRef.current[chatId]?.[sectionKey];
          if (prev && base.endsWith(prev)) {
            base = base.slice(0, base.length - prev.length).replace(/[ \t\n]+$/, '');
          }
        }
        let separator = '';
        if (base.trim()) {
          if (sectionKey) {
            separator = base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
          } else {
            separator = base.endsWith('\n') ? '' : ' ';
          }
        }
        setStoredMessageDraft(chatId, `${base}${separator}${text}`, true);
        if (sectionKey) {
          const map = sectionAppendsByChatIdRef.current[chatId] ?? {};
          map[sectionKey] = text;
          sectionAppendsByChatIdRef.current[chatId] = map;
        }
      } else {
        setStoredMessageDraft(chatId, text, true);
        delete sectionAppendsByChatIdRef.current[chatId];
      }
      setShouldFocusChatInput(true);
      if (customEvent.detail?.switchToChat) {
        setMode('chat');
      }
    };
    window.addEventListener('sundial:fill-composer', handleFillComposer);
    return () => {
      window.removeEventListener('sundial:fill-composer', handleFillComposer);
    };
  }, [
    currentChatRef,
    messageInputByChatIdRef,
    sectionAppendsByChatIdRef,
    setMode,
    setShouldFocusChatInput,
    setStoredMessageDraft,
  ]);
}

export function useInitialWorkspaceChatSelection<TThread extends { chat: { id: string } }>({
  projectId,
  chatThreadsForCurrentProject,
  selectedChatIndex,
  deepLinkedChatId,
  didSetInitialChatRef,
  setSelectedChatIndex,
  setSelectedChatSurface,
}: {
  projectId: string;
  chatThreadsForCurrentProject: TThread[];
  selectedChatIndex: number;
  deepLinkedChatId?: string | null;
  didSetInitialChatRef: MutableRefObject<boolean>;
  setSelectedChatIndex: Dispatch<SetStateAction<number>>;
  setSelectedChatSurface: Dispatch<SetStateAction<{ type: 'direct'; chatId: string | null }>>;
}) {
  useEffect(() => {
    if (!projectId || chatThreadsForCurrentProject.length === 0) return;
    if (didSetInitialChatRef.current) return;

    const storedId =
      typeof window !== 'undefined'
        ? window.localStorage.getItem(`sundial:last-chat:${projectId}`)
        : null;
    // A shared ?chatId= link outranks the locally-remembered chat. Links may
    // carry a short id-prefix ref instead of the full id (see findIndexByIdRef).
    const deepLinkedIndex = findIndexByIdRef(chatThreadsForCurrentProject, deepLinkedChatId, (thread) => thread.chat.id);
    const index = deepLinkedIndex >= 0
      ? deepLinkedIndex
      : findPreferredWorkspaceChatIndex(
          chatThreadsForCurrentProject.map((thread) => thread.chat),
          storedId
        );
    if (index < 0) {
      didSetInitialChatRef.current = true;
      return;
    }

    const initialChatId = chatThreadsForCurrentProject[index]?.chat.id ?? null;
    setSelectedChatIndex(index);
    if (initialChatId) {
      setSelectedChatSurface({ type: 'direct', chatId: initialChatId });
    }
    didSetInitialChatRef.current = true;
  }, [chatThreadsForCurrentProject, deepLinkedChatId, didSetInitialChatRef, projectId, setSelectedChatIndex, setSelectedChatSurface]);

  useEffect(() => {
    if (chatThreadsForCurrentProject.length === 0) return;
    if (selectedChatIndex >= chatThreadsForCurrentProject.length) {
      setSelectedChatIndex(0);
    }
  }, [chatThreadsForCurrentProject, selectedChatIndex, setSelectedChatIndex]);
}

export function useWorkspaceChatSidebarEffects<TThread extends { chat: { id: string; archived_at?: string | null } }>({
  projectId,
  chatsLoaded,
  chatsProjectId,
  selectedDirectChatId,
  currentThread,
  chatThreadsForCurrentProject,
  loadAgentStatuses,
  setSelectedChatIndex,
  setSelectedChatSurface,
}: {
  projectId: string;
  chatsLoaded: boolean;
  chatsProjectId: string | null;
  selectedDirectChatId: string | null;
  currentThread: unknown | null;
  chatThreadsForCurrentProject: TThread[];
  loadAgentStatuses: () => Promise<void>;
  setSelectedChatIndex: Dispatch<SetStateAction<number>>;
  setSelectedChatSurface: Dispatch<SetStateAction<{ type: 'direct'; chatId: string | null }>>;
}) {
  useEffect(() => {
    if (!chatsLoaded || chatsProjectId !== projectId) return;
    if (!selectedDirectChatId || currentThread) return;
    const nextIndex = findPreferredWorkspaceChatIndex(
      chatThreadsForCurrentProject.map((thread) => thread.chat),
      null
    );
    if (nextIndex < 0) {
      setSelectedChatSurface({ type: 'direct', chatId: null });
      return;
    }
    const nextChatId = chatThreadsForCurrentProject[nextIndex]?.chat.id ?? null;
    setSelectedChatIndex(nextIndex);
    setSelectedChatSurface({ type: 'direct', chatId: nextChatId });
  }, [
    chatThreadsForCurrentProject,
    chatsLoaded,
    chatsProjectId,
    currentThread,
    projectId,
    selectedDirectChatId,
    setSelectedChatIndex,
    setSelectedChatSurface,
  ]);

  useEffect(() => {
    if (!projectId) return;
    void loadAgentStatuses();
    const interval = window.setInterval(() => {
      void loadAgentStatuses();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [loadAgentStatuses, projectId]);
}

// `useCurrentChatRealtimeMessages` (Supabase Realtime subscription on the
// `messages` table for the active chat + 3s streaming watchdog) and
// `useCurrentChatAgentStream` (hand-rolled SSE consumer) both lived here
// before `useSundialChat` took over. They've been deleted as part of the
// move to `useChat` from `@ai-sdk/react`. The sidebar-wide
// `useWorkspaceChatStatusRealtime` below stays for cross-chat presence.

type RealtimeMessageRow = {
  id?: string | null;
  chat_id?: string | null;
  role?: string | null;
  sequence?: number | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Pure helper: given a realtime messages event, return the new chat status
 * — or null when the event doesn't carry one. Extracted from the hook so the
 * derivation can be unit-tested without spinning up a Supabase channel.
 */
export function deriveChatStatusFromMessageEvent(
  eventType: 'INSERT' | 'UPDATE' | 'DELETE' | string,
  row: RealtimeMessageRow | null | undefined,
): ChatStatus | null {
  if (!row?.chat_id || !row.role) return null;
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : null;
  const streaming = metadata?.streaming === true;
  if (row.role === 'assistant') {
    // A deploy-checkpointed row (`resume_pending`) has `streaming` cleared but
    // its run lives on under a fresh stream — still working, not settled.
    return streaming || metadata?.resume_pending === true ? 'working' : 'idle';
  }
  if (row.role === 'user' && eventType === 'INSERT') return 'starting';
  return null;
}

/**
 * Workspace-wide chat status realtime: subscribes to messages INSERT/UPDATE
 * across every chat in this project so the avatar row in the top-right lights
 * up when *anyone* — including other users — has Sunny working in any chat.
 *
 * Local optimistic updates from the send path still win — we only flip when
 * the incoming row genuinely advances the status.
 */
export function useWorkspaceChatStatusRealtime({
  supabaseClient,
  projectId,
  chatIds,
  setChatStatusById,
  onAssistantSettled,
}: {
  supabaseClient: ReturnType<typeof createBrowserClient>;
  projectId: string;
  chatIds: string[];
  setChatStatusById: Dispatch<SetStateAction<Record<string, ChatStatus>>>;
  /** An assistant row UPDATE landed with `streaming` cleared (and no
   *  `resume_pending`) — the run's persisted state is terminal. The active
   *  chat uses this to settle a live view whose SSE reader never delivered
   *  the finish (half-open socket): without it, the persisted terminal state
   *  has no path to useChat's `streaming` status until a manual reload. */
  onAssistantSettled?: (chatId: string, assistantRowId: string | null, rowSequence: number | null) => void;
}) {
  // Sort + join so re-renders with the same set don't churn the subscription.
  const filterKey = chatIds.slice().sort().join(',');
  // Read through a ref so the subscription doesn't churn on callback identity.
  const onSettledRef = useRef(onAssistantSettled);
  onSettledRef.current = onAssistantSettled;

  useEffect(() => {
    if (!supabaseClient || !projectId || !filterKey) return;
    const ids = filterKey.split(',').filter(Boolean);
    if (ids.length === 0) return;

    const channel = supabaseClient.channel(`workspace-chat-status-${projectId}`);
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: `chat_id=in.(${ids.join(',')})`,
      },
      (payload) => {
        const row = (payload.new ?? payload.old) as RealtimeMessageRow | null;
        const nextStatus = deriveChatStatusFromMessageEvent(payload.eventType, row);
        if (!nextStatus || !row?.chat_id) return;
        const chatId = row.chat_id;
        setChatStatusById((prev) => {
          if (prev[chatId] === nextStatus) return prev;
          return { ...prev, [chatId]: nextStatus };
        });
        if (payload.eventType === 'UPDATE' && row.role === 'assistant' && nextStatus === 'idle') {
          onSettledRef.current?.(
            chatId,
            typeof row.id === 'string' ? row.id : null,
            typeof row.sequence === 'number' ? row.sequence : null,
          );
        }
      },
    );
    channel.subscribe();
    return () => {
      supabaseClient.removeChannel(channel);
    };
  }, [filterKey, projectId, setChatStatusById, supabaseClient]);
}

type ForeignUserMessageRow = {
  id?: string | null;
  chat_id?: string | null;
  role?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  sequence?: number | null;
};

/**
 * Multi-user live updates for the active chat.
 *
 * The legacy per-chat Realtime subscription was dropped when useChat took
 * over the streaming hot path — that fixed the dropped-UPDATE / busy-WS
 * problems but lost the case where user X sees user Y's incoming message
 * live. This hook brings just that case back, with the smallest possible
 * surface:
 *
 *   - INSERT-only filter (UPDATEs were the source of the original pain;
 *     useChat's resumable stream handles streaming assistant content).
 *   - role='user' only — assistant rows come through SSE.
 *   - We skip rows authored by the current user — those are already in
 *     useChat from sendMessage.
 *   - Foreign INSERTs append to useChat's message list and tickle
 *     resumeStream, which reconnects to whatever active stream the
 *     harness just started for that user's message.
 */
export function useActiveChatForeignUserMessages({
  supabaseClient,
  currentChatId,
  isDraftChatId,
  currentUserId,
  appendForeignUserMessage,
  resumeStream,
}: {
  supabaseClient: ReturnType<typeof createBrowserClient>;
  currentChatId: string | null;
  isDraftChatId: (chatId: string | null | undefined) => boolean;
  currentUserId: string | null;
  appendForeignUserMessage: (row: ChatMessage, opts?: { replace?: boolean; remove?: boolean }) => void;
  resumeStream: () => void;
}) {
  // Stable callback refs so the effect doesn't tear down on every render
  // (parents may pass fresh function identities each pass).
  const appendRef = useRef(appendForeignUserMessage);
  const resumeRef = useRef(resumeStream);
  appendRef.current = appendForeignUserMessage;
  resumeRef.current = resumeStream;

  useEffect(() => {
    if (!supabaseClient || !currentChatId || isDraftChatId(currentChatId)) return;
    const chatId = currentChatId;
    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    const channel = supabaseClient.channel(`active-chat-foreign-${chatId}`);
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `chat_id=eq.${chatId}`,
      },
      (payload) => {
        const row = (payload.new ?? null) as ForeignUserMessageRow | null;
        if (!row || !row.id) return;
        if (row.role === 'assistant') {
          // A turn just started — possibly a QUEUED comment run whose stream
          // didn't exist yet when the delivery's retries fired. (Re)attach;
          // resuming an already-attached stream is a safe reconnect.
          resumeRef.current();
          retryTimers.push(setTimeout(() => resumeRef.current(), 1500));
          return;
        }
        if (row.role !== 'user') return;
        const authorId =
          typeof row.metadata?.author_user_id === 'string'
            ? (row.metadata.author_user_id as string)
            : null;
        // Own sends are already in useChat state — but an own-authored COMMENT
        // delivery isn't (it was ingested server-side, not sent from this
        // window), and skipping it would leave the open listening chat blind
        // until a chat switch.
        const isCommentDelivery = row.metadata?.source === 'comment';
        if (currentUserId && authorId && authorId === currentUserId && !isCommentDelivery) return;
        // Foreign user message. Append to useChat's state, then tickle the
        // resumable stream — the harness has already kicked /agent/run for
        // this row, the active_stream_id is in Redis, our useChat just
        // needs to reconnect to it.
        appendRef.current({
          id: row.id,
          role: 'user',
          content: typeof row.content === 'string' ? row.content : '',
          metadata: (row.metadata ?? null) as Record<string, unknown> | null,
          ...(row.created_at ? { created_at: row.created_at } : {}),
          sequence: typeof row.sequence === 'number' ? row.sequence : null,
        });
        resumeRef.current();
        // Comment deliveries invert the usual order: the row is INSERTed
        // BEFORE /agent/run registers the stream, so the first resume can hit
        // a cursorless 404 and give up. Re-tickle shortly after; resuming an
        // already-attached stream is a no-op-safe reconnect.
        if (isCommentDelivery) {
          for (const delay of [1500, 4000]) {
            retryTimers.push(setTimeout(() => resumeRef.current(), delay));
          }
        }
      },
    );
    // Comment deliveries can be ANNOTATED after insert (a blocked run stamps
    // metadata.comment.blocked so the card explains itself) — refresh the
    // rendered row in place. Scoped to comment-sourced user rows only;
    // assistant UPDATEs stay excluded (they were the original pain source).
    channel.on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `chat_id=eq.${chatId}`,
      },
      (payload) => {
        const row = (payload.new ?? null) as ForeignUserMessageRow | null;
        if (!row || !row.id || row.role !== 'user' || row.metadata?.source !== 'comment') return;
        appendRef.current(
          {
            id: row.id,
            role: 'user',
            content: typeof row.content === 'string' ? row.content : '',
            metadata: (row.metadata ?? null) as Record<string, unknown> | null,
            ...(row.created_at ? { created_at: row.created_at } : {}),
            sequence: typeof row.sequence === 'number' ? row.sequence : null,
          },
          { replace: true },
        );
      },
    );
    // A retracted delivery (blocked-gate compensation deletes the row after
    // insert) must leave the live transcript too. NO column filter here:
    // Postgres Changes can't filter DELETE events (the old record carries only
    // the replica-identity key, so a filtered listener never fires). Removal
    // by globally-unique id is a no-op for other chats' rows.
    channel.on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'messages',
      },
      (payload) => {
        const oldRow = (payload.old ?? null) as { id?: string } | null;
        if (!oldRow?.id) return;
        appendRef.current({ id: oldRow.id, role: 'user', content: '', metadata: null, sequence: null }, { remove: true });
      },
    );
    channel.subscribe();
    return () => {
      retryTimers.forEach(clearTimeout);
      supabaseClient.removeChannel(channel);
    };
  }, [supabaseClient, currentChatId, isDraftChatId, currentUserId]);
}

export function useChatStreamActivity({
  currentChatId,
  latestAssistantMessageId,
  latestAssistantMessageContent,
  latestAssistantStreaming,
  streamIdleTimeoutMs,
  streamTimeoutsRef,
  setStreamActivityByChatId,
}: {
  currentChatId: string | null;
  latestAssistantMessageId?: string | null;
  latestAssistantMessageContent?: string | null;
  latestAssistantStreaming: boolean;
  streamIdleTimeoutMs: number;
  streamTimeoutsRef: MutableRefObject<Record<string, number>>;
  setStreamActivityByChatId: Dispatch<SetStateAction<Record<string, number>>>;
}) {
  useEffect(() => {
    if (!currentChatId) return;
    if (!latestAssistantStreaming) {
      const timeoutId = streamTimeoutsRef.current[currentChatId];
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        delete streamTimeoutsRef.current[currentChatId];
      }
      setStreamActivityByChatId((prev) => {
        if (!prev[currentChatId]) return prev;
        const next = { ...prev };
        delete next[currentChatId];
        return next;
      });
      return;
    }

    setStreamActivityByChatId((prev) => ({ ...prev, [currentChatId]: Date.now() }));
    const timeoutId = streamTimeoutsRef.current[currentChatId];
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
    streamTimeoutsRef.current[currentChatId] = window.setTimeout(() => {
      setStreamActivityByChatId((prev) => {
        if (!prev[currentChatId]) return prev;
        const next = { ...prev };
        delete next[currentChatId];
        return next;
      });
    }, streamIdleTimeoutMs);
  }, [
    currentChatId,
    latestAssistantMessageContent,
    latestAssistantMessageId,
    latestAssistantStreaming,
    setStreamActivityByChatId,
    streamIdleTimeoutMs,
    streamTimeoutsRef,
  ]);

  useEffect(() => {
    return () => {
      Object.values(streamTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      streamTimeoutsRef.current = {};
    };
  }, [streamTimeoutsRef]);
}

export function useCurrentChatEffects<TMessage>({
  currentChatId,
  currentChatModel,
  mode,
  isChatTranscriptVisible,
  isDocumentVisible,
  userId,
  currentChatUnreadCount,
  currentChatLastSequence,
  clearUnreadForChat,
  markChatRead,
  ensureChatMessagesLoaded,
  setPreferredChatModel,
}: {
  currentChatId: string | null;
  currentChatModel?: string | null;
  mode: 'chat' | 'space';
  isChatTranscriptVisible: boolean;
  isDocumentVisible: boolean;
  userId?: string | null;
  currentChatUnreadCount: number;
  currentChatLastSequence: number | null;
  clearUnreadForChat: (chatId: string | null | undefined) => void;
  markChatRead: (chatId: string | null | undefined, lastReadSequence?: number | null) => Promise<void>;
  ensureChatMessagesLoaded: (chatId: string, options?: { force?: boolean }) => Promise<TMessage[]>;
  setPreferredChatModel: Dispatch<SetStateAction<string>>;
}) {
  useEffect(() => {
    if (!currentChatId) return;
    const nextModel = normalizeChatModelRef(currentChatModel ?? DEFAULT_MODEL_REF);
    setPreferredChatModel((prev: string) => (prev === nextModel ? prev : nextModel));
  }, [currentChatId, currentChatModel, setPreferredChatModel]);

  useEffect(() => {
    const shouldLoadActiveChatHistory = Boolean(currentChatId && isChatTranscriptVisible && isDocumentVisible);
    if (!currentChatId || !shouldLoadActiveChatHistory) return;
    if (currentChatUnreadCount > 0) {
      clearUnreadForChat(currentChatId);
    }
    if (currentChatUnreadCount > 0 || currentChatLastSequence === null) {
      void ensureChatMessagesLoaded(currentChatId, { force: currentChatUnreadCount > 0 }).then((messages) => {
        const lastMessage = messages[messages.length - 1] as { sequence?: unknown } | undefined;
        const lastSequence = lastMessage?.sequence;
        if (userId && typeof lastSequence === 'number') {
          void markChatRead(currentChatId, lastSequence);
        }
      });
      return;
    }
    if (userId && typeof currentChatLastSequence === 'number') {
      void markChatRead(currentChatId, currentChatLastSequence);
    }
  }, [
    clearUnreadForChat,
    currentChatId,
    currentChatLastSequence,
    currentChatUnreadCount,
    ensureChatMessagesLoaded,
    isChatTranscriptVisible,
    isDocumentVisible,
    markChatRead,
    mode,
    userId,
  ]);
}

export function usePersistLastChat({
  projectId,
  currentChatId,
  isDraftChatId,
}: {
  projectId: string;
  currentChatId: string | null;
  isDraftChatId: (chatId: string | null | undefined) => boolean;
}) {
  useEffect(() => {
    if (!projectId || !currentChatId || isDraftChatId(currentChatId)) return;
    try {
      window.localStorage.setItem(`sundial:last-chat:${projectId}`, currentChatId);
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  }, [currentChatId, isDraftChatId, projectId]);
}
