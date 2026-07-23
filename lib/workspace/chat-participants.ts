export type ChatParticipantKind = 'user';

export type ChatParticipantRow = {
  id?: string | null;
  identity_key?: string | null;
  participant_kind?: ChatParticipantKind | null;
  user_id?: string | null;
  metadata?: unknown;
  created_at?: string | null;
};

export type NormalizedChatParticipant = {
  id: string;
  identity_key: string;
  kind: ChatParticipantKind;
  user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string | null;
};

export const CHAT_PARTICIPANTS_SELECT =
  'chat_participants(id, identity_key, participant_kind, user_id, metadata, created_at)';

function normalizeId(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeUniqueIds(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const id = normalizeId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function normalizeChatParticipants(args: {
  chatId: string;
  rawParticipants: unknown;
  fallbackUserIds: Array<string | null | undefined>;
}): NormalizedChatParticipant[] {
  const rows = Array.isArray(args.rawParticipants)
    ? (args.rawParticipants as ChatParticipantRow[])
    : [];

  if (rows.length > 0) {
    return rows
      .map((row, index) => {
        const metadata = normalizeMetadata(row.metadata);
        const userId =
          normalizeId(row.user_id) ??
          (typeof metadata.user_id === 'string' ? normalizeId(metadata.user_id) : null);
        const rowIdentityKey = normalizeId(row.identity_key);
        const identityKey =
          rowIdentityKey ??
          (userId ? `user:${userId}` : `participant:${args.chatId}:${index}`);

        if (!userId && !rowIdentityKey) return null;

        return {
          id: normalizeId(row.id) ?? `${args.chatId}:participant:${index}`,
          identity_key: identityKey,
          kind: 'user' as const,
          user_id: userId,
          metadata: userId ? { ...metadata, user_id: userId } : metadata,
          created_at: typeof row.created_at === 'string' ? row.created_at : null,
        };
      })
      .filter((participant): participant is NormalizedChatParticipant => Boolean(participant));
  }

  return normalizeUniqueIds(args.fallbackUserIds).map((userId) => ({
    id: `legacy-user:${args.chatId}:${userId}`,
    identity_key: `user:${userId}`,
    kind: 'user' as const,
    user_id: userId,
    metadata: { user_id: userId },
    created_at: null,
  }));
}

export function chatIncludesUserParticipant(args: {
  rawParticipants: unknown;
  userId: string | null | undefined;
  fallbackUserIds?: Array<string | null | undefined>;
}): boolean {
  const viewerUserId = normalizeId(args.userId);
  if (!viewerUserId) return false;

  const rows = Array.isArray(args.rawParticipants)
    ? (args.rawParticipants as ChatParticipantRow[])
    : [];
  if (rows.length > 0) {
    return rows.some((row) => {
      const metadata = normalizeMetadata(row.metadata);
      const participantUserId =
        normalizeId(row.user_id) ??
        (typeof metadata.user_id === 'string' ? normalizeId(metadata.user_id) : null);
      return participantUserId === viewerUserId;
    });
  }

  return normalizeUniqueIds(args.fallbackUserIds ?? []).includes(viewerUserId);
}
