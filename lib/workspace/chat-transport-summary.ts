export type ChatTransportSummary = {
  transport_types: string[];
};

export function createEmptyChatTransportSummary(): ChatTransportSummary {
  return {
    transport_types: [],
  };
}

export function getChatTransportTypes(
  chat: { transport_types?: string[] | null } | null | undefined
): string[] {
  return Array.isArray(chat?.transport_types)
    ? chat.transport_types.filter(
        (provider): provider is string =>
          typeof provider === 'string' && provider.trim().length > 0
      )
    : [];
}

export function hasTextTransport(
  chat: { transport_types?: string[] | null } | null | undefined
): boolean {
  return getChatTransportTypes(chat).includes('linq');
}

export function usesGroupChatPresentation(
  chatKind: string | null | undefined,
  _chat?: unknown
): boolean {
  return chatKind === 'group';
}
