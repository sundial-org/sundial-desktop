/**
 * Shared invalidation fingerprint for inline editor diffs. The chat transcript
 * reads live `UIMessage.metadata` from useChat (SSE `message-metadata` chunks),
 * so the editor must use the same source — not the REST-seeded
 * `chatMessagesById` copy, which stays stale until a full history reload.
 */

export type TurnEditsFingerprintMessage = {
  id?: string;
  role?: string;
  metadata?: unknown;
};

export function readTurnEditsMetadata(message: TurnEditsFingerprintMessage) {
  return message.metadata && typeof message.metadata === 'object'
    ? (message.metadata as Record<string, unknown>)
    : null;
}

export function buildTurnEditsMessageFingerprint(
  messages: TurnEditsFingerprintMessage[],
): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message?.role !== 'assistant') continue;
    const meta = readTurnEditsMetadata(message);
    const hasTurnEdits = Boolean(meta?.has_turn_edits);
    const editedFileCount =
      typeof meta?.edited_file_count === 'number' ? meta.edited_file_count : 0;
    if (hasTurnEdits || editedFileCount > 0) {
      parts.push(`${message.id}:${hasTurnEdits ? 1 : 0}:${editedFileCount}`);
    }
  }
  return parts.join('|');
}

export function buildPendingEditsInvalidationToken(args: {
  docEditsRealtimeKey: number;
  messages: TurnEditsFingerprintMessage[];
}): string {
  const parts: string[] = [String(args.docEditsRealtimeKey)];
  const fingerprint = buildTurnEditsMessageFingerprint(args.messages);
  if (fingerprint) parts.push(fingerprint);
  return parts.join('|');
}
