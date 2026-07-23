import type { PendingAddition } from '@/components/workspace/collab-editor';
import type { FilePendingTurn } from '@/lib/workspace/use-file-pending-turns';
import { ANON_AUTHOR_PREFIX, anonDisplayName } from '@/lib/auth/anon-identity';
import { brandForAgentId } from '@/lib/workspace/agent-brand';
import { isHumanReviewId } from '@/lib/workspace/human-suggestions';
import type { TurnEditLine } from '@/lib/workspace/turn-edits';

type BuildActionableWorkspacePendingAdditionsArgs = {
  turns: FilePendingTurn[];
  filePath: string | null | undefined;
  /** Resolves a turn's display author name. Falls back to a generic label. */
  resolveAuthorLabel?: (turn: FilePendingTurn) => string;
};

/**
 * Default label: `Sunny #N` for agents, `Anonymous <Animal>` for anon
 * visitors, the raw user id otherwise. `Sunny` is the last-resort fallback
 * for legacy NULL author_id rows (pre-anon-identity).
 */
export function defaultAuthorLabel(turn: FilePendingTurn): string {
  if (turn.authorId?.startsWith('sunny:')) {
    return `Sunny #${turn.authorId.slice('sunny:'.length)}`;
  }
  if (turn.authorId?.startsWith(ANON_AUTHOR_PREFIX)) {
    return anonDisplayName(turn.authorId);
  }
  // Local agents suggest under their ai:<name> id — show the brand name.
  if (turn.authorId?.startsWith('ai:')) {
    return brandForAgentId(turn.authorId).displayName;
  }
  if (turn.authorId) return turn.authorId;
  return 'Sunny';
}

/**
 * Emits every unaccepted addition chunk across every turn for the file.
 * Chunks whose text no longer appears in the doc are filtered out
 * structurally by the editor's text-matching plugin (`matchPendingAdditionBlocks`).
 */
export function buildActionableWorkspacePendingAdditions({
  turns,
  filePath,
  resolveAuthorLabel = defaultAuthorLabel,
}: BuildActionableWorkspacePendingAdditionsArgs): PendingAddition[] {
  if (!filePath) return [];

  const additions: PendingAddition[] = [];
  const seenChunkKeys = new Set<string>();

  for (const turn of turns) {
    if (!turn.payload) continue;
    const fileEntry = turn.payload.files.find((file) => file.filePath === filePath);
    if (!fileEntry || fileEntry.isDeleted) continue;
    const authorLabel = resolveAuthorLabel(turn);

    for (const chunk of fileEntry.chunks) {
      if (chunk.status !== 'pending') continue;
      // Group consecutive `+` ops; insert a blank line between groups so the
      // matcher can see paragraph boundaries even when intervening context /
      // deletion ops separated them in the diff.
      const additionGroups: string[][] = [];
      let current: string[] | null = null;
      for (const line of chunk.lines) {
        if (line.type === 'addition') {
          if (!current) {
            current = [];
            additionGroups.push(current);
          }
          current.push(line.content);
        } else {
          current = null;
        }
      }
      const text = additionGroups.map((g) => g.join('\n')).join('\n\n');
      const deletedText = chunk.lines
        .filter((line) => line.type === 'deletion')
        .map((line) => line.content)
        .join('\n');
      // Pure-deletion chunks have no addition text — keep them so the editor
      // overlay can still anchor a red deletion ghost + Keep/Undo widget via
      // surrounding context lines (`matchPendingDeletionAnchors`).
      if (!text.trim() && !deletedText) continue;
      const key = `${turn.assistantMessageId}:${chunk.id}`;
      if (seenChunkKeys.has(key)) continue;
      seenChunkKeys.add(key);
      const jumpableAssistantMessageId = isHumanReviewId(turn.assistantMessageId)
        ? undefined
        : turn.assistantMessageId;
      additions.push({
        key,
        groupKey: turn.assistantMessageId,
        text,
        canMutate: true,
        deletedText: deletedText || undefined,
        // Pass through the full ordered hunk ops + newStart so the code/Tex
        // editor can run hunk-position matching (markdown ignores these).
        lines: chunk.lines as TurnEditLine[],
        newStart: chunk.newStart,
        authorLabel,
        assistantMessageId: jumpableAssistantMessageId,
        chatId: jumpableAssistantMessageId ? (turn.chatId ?? undefined) : undefined,
      });
    }
  }

  return additions;
}
