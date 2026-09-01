import type { ChatTurnEditSummary } from '@/lib/workspace/chat-turn-edits';
import type { TurnEditFile, TurnEditsResponse } from '@/lib/workspace/turn-edits';

/**
 * "All edits" for a chat is a FILE list, not a turn list (2026-08-06 founder
 * feedback: a chat that edited two files across two turns read as "4 files
 * edited"). These helpers fold the per-turn payloads the API returns into one
 * card model per file, keeping every turn's chunks in chat order.
 */

export type ChatFileEditGroup = {
  filePath: string;
  /** Turns that touched this file, oldest first. */
  turnIds: string[];
};

/** filePath → the turns that touched it, both in chat order. */
export function groupTurnsByFile(turns: readonly ChatTurnEditSummary[]): ChatFileEditGroup[] {
  const byFile = new Map<string, string[]>();
  for (const turn of turns) {
    for (const filePath of turn.filePaths) {
      const list = byFile.get(filePath);
      // Same turn twice on one path (defensive — the query dedupes) stays one entry.
      if (list) {
        if (!list.includes(turn.assistantMessageId)) list.push(turn.assistantMessageId);
      } else {
        byFile.set(filePath, [turn.assistantMessageId]);
      }
    }
  }
  return [...byFile.entries()].map(([filePath, turnIds]) => ({ filePath, turnIds }));
}

/** Chunk ids are only unique within a turn — namespace them so a merged file's
 *  React keys (and any id-keyed lookup) can't collide across turns. */
export function mergedChunkId(turnId: string, chunkId: string): string {
  return `${turnId}::${chunkId}`;
}

/**
 * One file's diffs across every turn that touched it, as a single
 * `TurnEditFile` the chat's own card can render. Turn-level state (deleted,
 * oversized, editMode…) comes from the LATEST turn — that's the file's current
 * state — while counts and chunks accumulate. Returns null until at least one
 * of the file's turns has loaded.
 */
export function mergeFileAcrossTurns(
  filePath: string,
  turnIds: readonly string[],
  payloads: Readonly<Record<string, TurnEditsResponse | undefined>>,
): TurnEditFile | null {
  const perTurn = turnIds
    .map((turnId) => {
      const file = payloads[turnId]?.files.find((entry) => entry.filePath === filePath);
      return file ? { turnId, file } : null;
    })
    .filter((entry): entry is { turnId: string; file: TurnEditFile } => entry !== null);
  if (perTurn.length === 0) return null;

  const latest = perTurn[perTurn.length - 1]!.file;
  return {
    ...latest,
    id: filePath,
    fileId: perTurn.map((entry) => entry.file.fileId).filter(Boolean).pop() ?? latest.fileId,
    // Created by this chat if any of its turns created it; deleted only if the
    // last one did (a delete-then-recreate ends up live).
    isNew: perTurn.some((entry) => entry.file.isNew),
    isDeleted: latest.isDeleted,
    addedLineCount: perTurn.reduce((sum, entry) => sum + (entry.file.addedLineCount ?? 0), 0),
    deletedLineCount: perTurn.reduce((sum, entry) => sum + (entry.file.deletedLineCount ?? 0), 0),
    chunks: perTurn.flatMap((entry) =>
      entry.file.chunks.map((chunk) => ({ ...chunk, id: mergedChunkId(entry.turnId, chunk.id) })),
    ),
  };
}

/** The turns whose copy of this file still has chunks the given predicate wants. */
export function turnsWithFileChunks(
  filePath: string,
  turnIds: readonly string[],
  payloads: Readonly<Record<string, TurnEditsResponse | undefined>>,
  match: (status: 'pending' | 'kept' | 'undone') => boolean,
): string[] {
  return turnIds.filter((turnId) =>
    payloads[turnId]?.files
      .find((entry) => entry.filePath === filePath)
      ?.chunks.some((chunk) => match(chunk.status)),
  );
}
