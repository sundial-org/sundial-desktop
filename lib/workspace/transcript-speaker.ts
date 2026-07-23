type TranscriptCollaborator = {
  name: string;
  username?: string | null;
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatUsername(username: string | null | undefined): string | null {
  const normalized = normalizeNonEmptyString(username);
  if (!normalized) return null;
  return normalized.startsWith('@') ? normalized : `@${normalized}`;
}

export function resolveTranscriptUserLabel(args: {
  authorUserId: string | null;
  currentUserId: string | null;
  collaborator: TranscriptCollaborator | null;
  transportAuthorDisplayName?: string | null;
  transportAuthorUsername?: string | null;
}): string {
  if (args.authorUserId) {
    if (args.authorUserId === args.currentUserId) {
      return 'You';
    }
    return formatUsername(args.collaborator?.username) ?? args.collaborator?.name ?? 'Teammate';
  }

  const displayName = normalizeNonEmptyString(args.transportAuthorDisplayName);
  if (displayName) return displayName;

  const username = formatUsername(args.transportAuthorUsername);
  if (username) return username;

  return 'Teammate';
}
