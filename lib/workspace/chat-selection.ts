export type WorkspaceChatSelectionCandidate = {
  id: string;
  archived_at?: string | null;
  last_message_at?: string | null;
  pinned_at?: string | null;
  pinned?: boolean | null;
  is_pinned?: boolean | null;
};

type IndexedChatCandidate = WorkspaceChatSelectionCandidate & { index: number };

function getChatRecencyTime(value: string | null | undefined) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : 0;
}

function pickFirstSidebarChat(candidates: IndexedChatCandidate[]) {
  let best: IndexedChatCandidate | null = null;
  for (const candidate of candidates) {
    if (!best) {
      best = candidate;
      continue;
    }

    const candidateTime = getChatRecencyTime(candidate.last_message_at);
    const bestTime = getChatRecencyTime(best.last_message_at);
    if (candidateTime > bestTime || (candidateTime === bestTime && candidate.index > best.index)) {
      best = candidate;
    }
  }
  return best;
}

function isPinnedChat(chat: WorkspaceChatSelectionCandidate) {
  if (typeof chat.is_pinned === 'boolean') return chat.is_pinned;
  if (typeof chat.pinned === 'boolean') return chat.pinned;
  return Boolean(chat.pinned_at);
}

export function findPreferredWorkspaceChatIndex(
  chats: WorkspaceChatSelectionCandidate[],
  storedChatId?: string | null
) {
  const activeChats = chats
    .map((chat, index) => ({ ...chat, index }))
    .filter((chat) => !chat.archived_at);

  if (activeChats.length === 0) return -1;

  if (storedChatId) {
    const storedChat = activeChats.find((chat) => chat.id === storedChatId);
    if (storedChat) {
      return storedChat.index;
    }
  }

  const pinnedChats = activeChats.filter(isPinnedChat);
  // Match the pinned section in the workspace sidebar: most recently active
  // pinned chats appear first, with later chat rows winning ties.
  const preferredPinnedChat = pickFirstSidebarChat(pinnedChats);
  if (preferredPinnedChat) {
    return preferredPinnedChat.index;
  }

  return pickFirstSidebarChat(activeChats)?.index ?? -1;
}
