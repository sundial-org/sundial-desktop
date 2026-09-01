import type { PendingAddition } from '@/components/workspace/collab-editor';
import type { FilePendingTurn } from '@/lib/workspace/use-file-pending-turns';
import { ANON_AUTHOR_PREFIX, anonDisplayName } from '@/lib/auth/anon-identity';
import { brandForAgentId } from '@/lib/workspace/agent-brand';
import { pickColor } from '@/components/collab-bubbles';
import { isAppliedReviewId, isHumanReviewId } from '@/lib/workspace/human-suggestions';
import type { TurnEditLine } from '@/lib/workspace/turn-edits';

type BuildActionableWorkspacePendingAdditionsArgs = {
  turns: FilePendingTurn[];
  filePath: string | null | undefined;
  /** Resolves a turn's display author name. Falls back to a generic label. */
  resolveAuthorLabel?: (turn: FilePendingTurn) => string;
  /** Host-supplied avatar imagery for the code editor's author chip. */
  resolveAuthorVisual?: (turn: FilePendingTurn) => SuggestionAuthorVisual | null;
};

/**
 * Default label: `Agent #N` for agents, `Anonymous <Animal>` for anon
 * visitors, the raw user id otherwise. `Sundial Agent` is the last-resort
 * fallback for legacy NULL author_id rows (pre-anon-identity).
 */
export function defaultAuthorLabel(turn: Pick<FilePendingTurn, 'authorId'>): string {
  if (turn.authorId?.startsWith('sunny:')) {
    return `Agent #${turn.authorId.slice('sunny:'.length)}`;
  }
  if (turn.authorId?.startsWith(ANON_AUTHOR_PREFIX)) {
    return anonDisplayName(turn.authorId);
  }
  // Local agents suggest under their ai:<name> id — show the brand name.
  if (turn.authorId?.startsWith('ai:')) {
    return brandForAgentId(turn.authorId).displayName;
  }
  if (turn.authorId) return turn.authorId;
  return 'Sundial Agent';
}

/** How an author renders in the tiny review controls — mirrors the chat list:
 *  Sunny is her round face image, a local agent is its brand mark, a human is
 *  an initials bubble in their stable color. */
export type SuggestionAuthorVisual = {
  /** Avatar image; absent → initials chip. */
  imageUrl?: string | null;
  /** True for face avatars (clip round, cover); false for brand marks (contain). */
  imageRound?: boolean;
  /** Chip text override (e.g. a brand's "Cx"); absent → initials of the label. */
  chipLabel?: string;
  /** Chip background override (e.g. a brand color); absent → pickColor(label). */
  chipColor?: string;
};

export type SuggestionAuthorInfo = SuggestionAuthorVisual & {
  label: string;
  color: string;
  /** The chip's JUMP target — the transcript message id, not the review id
   *  (they coincide in the cloud, but a local review unit is a synthetic
   *  `applied-<rowId>` session that no message div carries). */
  assistantMessageId: string;
  chatId: string | null;
};

/** Local-agent authors (`ai:*`) render their brand mark everywhere else in the
 *  workspace — the review controls match. Sunny/humans are resolved by the
 *  host (the Sunny avatar is per-chat state the page owns). */
export function brandAuthorVisual(authorId: string | null | undefined): SuggestionAuthorVisual | null {
  if (!authorId?.startsWith('ai:')) return null;
  const brand = brandForAgentId(authorId);
  return brand.logoPath
    ? { imageUrl: brand.logoPath, imageRound: false }
    : { chipLabel: brand.label, chipColor: brand.color };
}

/**
 * Suggestion mark id → who wrote it, for the markdown gutter's author icon.
 * The server joins mark id (the agent write's `tool_call_id`) to its turn;
 * this adds the display identity the editor can't derive. Marks whose turn is
 * no longer pending — and every human mark, which has no persisted id — are
 * absent, and render with no author icon.
 */
export function buildSuggestionAuthors({
  turns,
  suggestionTurns,
  resolveAuthorLabel = defaultAuthorLabel,
  resolveAuthorVisual,
}: {
  turns: FilePendingTurn[];
  suggestionTurns: Record<string, string>;
  resolveAuthorLabel?: (turn: FilePendingTurn) => string;
  /** Host-supplied avatar imagery (Sunny face per chat, profile photos). */
  resolveAuthorVisual?: (turn: FilePendingTurn) => SuggestionAuthorVisual | null;
}): Record<string, SuggestionAuthorInfo> {
  const byTurn = new Map(turns.map((turn) => [turn.assistantMessageId, turn]));
  const authors: Record<string, SuggestionAuthorInfo> = {};
  for (const [markId, assistantMessageId] of Object.entries(suggestionTurns)) {
    const turn = byTurn.get(assistantMessageId);
    if (!turn) continue;
    const label = resolveAuthorLabel(turn);
    const visual = resolveAuthorVisual?.(turn) ?? brandAuthorVisual(turn.authorId) ?? {};
    authors[markId] = {
      label,
      // Seeded by LABEL, not author id: the code editor's chip only has the
      // label, and one person must not be two hues across file types.
      color: pickColor(label),
      assistantMessageId: turn.jumpMessageId ?? assistantMessageId,
      chatId: turn.chatId,
      ...visual,
    };
  }
  return authors;
}

/**
 * The code/LaTeX editor paints the live CRDT suggestion ledger and MERGES in
 * server-derived additions for turns the ledger never staged (legacy rows,
 * backends without ledger code). This drops the prop copies that ARE
 * ledger-backed — showing both paints two green bands over one change, and a
 * stale prop re-shows a just-accepted suggestion whenever the ledger blinks
 * empty.
 *
 * Two review-unit id shapes are ledger-backed by construction, even though
 * their ledger chunks carry no `assistantMessageId` to match on:
 *   - `human-<rowId>` runs — client-staged here, server-staged via the poll.
 *   - `applied-<rowId>` local sessions — the sidecar stages every suggest
 *     write straight into this same ledger.
 */
export function ledgerUnbackedAdditions<T extends { groupKey?: string; assistantMessageId?: string }>(
  additions: T[],
  ledgerBackedTurnIds: ReadonlySet<string>,
): T[] {
  return additions.filter(
    (a) =>
      !(a.groupKey && (isHumanReviewId(a.groupKey) || isAppliedReviewId(a.groupKey))) &&
      // …plus any agent turn the ledger already staged (resolved included).
      (!a.assistantMessageId || !ledgerBackedTurnIds.has(a.assistantMessageId)),
  );
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
  resolveAuthorVisual,
}: BuildActionableWorkspacePendingAdditionsArgs): PendingAddition[] {
  if (!filePath) return [];

  const additions: PendingAddition[] = [];
  const seenChunkKeys = new Set<string>();

  for (const turn of turns) {
    if (!turn.payload) continue;
    const fileEntry = turn.payload.files.find((file) => file.filePath === filePath);
    if (!fileEntry || fileEntry.isDeleted) continue;
    const authorLabel = resolveAuthorLabel(turn);
    const authorVisual = resolveAuthorVisual?.(turn) ?? brandAuthorVisual(turn.authorId) ?? undefined;

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
      // Jump by TRANSCRIPT message id: local review units are synthetic
      // `applied-<rowId>` sessions no message div carries, so prefer the
      // ledger's real id when the feed supplies one.
      const jumpableAssistantMessageId = isHumanReviewId(turn.assistantMessageId)
        ? undefined
        : turn.jumpMessageId ?? turn.assistantMessageId;
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
        authorVisual,
        assistantMessageId: jumpableAssistantMessageId,
        chatId: jumpableAssistantMessageId ? (turn.chatId ?? undefined) : undefined,
      });
    }
  }

  return additions;
}
