import type { TurnEditLine } from '@/lib/workspace/turn-edits';
import type { CodePendingAddition } from '@/components/workspace/collab-code-editor';
import { brandAuthorVisual, defaultAuthorLabel } from '@/lib/workspace/pending-additions';
import { DEFAULT_SUNNY_AVATAR } from '@/lib/workspace/sunny-avatars';
import { resolveCodeSuggestions } from '@/lib/crdt-js/code_suggestions.mjs';

/** Avatar for a ledger author: agent turns show Sunny's face — the initials
 *  chip spelled "SA" out of "Sundial Agent", which reads as a word, not a
 *  person — and the chat list treatment carries over for the rest: brand marks
 *  for local agents, initials bubbles for humans via the chip fallback.
 *
 *  A missing id alone is NOT Sunny: a human's suggest-mode code edit stages
 *  with only an `authorLabel`, and painting Sunny on it would attribute the
 *  user's own suggestion to the agent (Codex, PR #1104 round 5). `agentTurnId`
 *  is the authorship signal there — only a turn write carries one — so the
 *  agent's own id-less writes (runs post no user id) still resolve to Sunny,
 *  and everything else falls through to the initials chip.
 *
 *  Legacy local-sidecar agent entries carry NO attribution at all (the sidecar
 *  stamped only `chatId` before it learned `agentTurnId`). Those are still
 *  agent writes — every human stage mints a `human-*` ledger id (editor
 *  `human-local-*`, cloud materialization `human-<rowId>`), so a fully
 *  unattributed entry under a non-human id resolves to Sunny too. */
function authorVisualForId(
  authorId: string | null,
  agentTurnId: string | null,
  authorLabel: string | null,
  suggestionId: string,
): CodePendingAddition['authorVisual'] {
  const legacyAgent =
    !authorId && !agentTurnId && !authorLabel && !suggestionId.startsWith('human-');
  if (authorId?.startsWith('sunny:') || (!authorId && agentTurnId) || legacyAgent) {
    // imageRound:false — Sunny's PNG is a transparent-background star, so the
    // `is-mark` treatment (uncropped, no chip disc) is the one that reads.
    return { imageUrl: DEFAULT_SUNNY_AVATAR, imageRound: false };
  }
  if (!authorId) return undefined;
  return brandAuthorVisual(authorId) ?? undefined;
}

// Convert the CRDT code-suggestion ledger into the shapes the Monaco renderer
// already consumes — but with EXACT line positions from the resolved relative
// positions, so `matchPendingHunks` (the brittle text re-location behind the
// #600-class code bugs) is skipped entirely. `matches` drives the green addition
// band; each `chunk` carries the deleted ghost + word-diff lines + attribution.

export type CodeHunkMatch = {
  key: string;
  /** 1-indexed inclusive line range of the inserted (green) text. */
  addStartLine: number;
  /** < addStartLine when the suggestion is a pure deletion (ghost only). */
  addEndLine: number;
  deletedLines: string[];
};

// 1-indexed lines for a batch of character offsets in one forward scan —
// per-offset scans from zero are O(suggestions × doc length) on every apply.
function linesAt(text: string, offsets: number[]): Map<number, number> {
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let line = 1;
  let i = 0;
  for (const offset of sorted) {
    const end = Math.min(offset, text.length);
    for (; i < end; i += 1) if (text[i] === '\n') line += 1;
    out.set(offset, line);
  }
  return out;
}

// Split retained text into lines, dropping the trailing empty that a final
// newline produces ("b\n" → ["b"], "b\nc" → ["b","c"]).
function toLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function codeSuggestionRender(
  doc: unknown,
  bufferText: string,
  opts: { canMutate?: boolean } = {},
): { matches: CodeHunkMatch[]; chunks: CodePendingAddition[] } {
  // Read-only mounts (diff-review preview) pass canMutate: false so no inline
  // Keep/Undo controls render and no local accept/reject is offered.
  const canMutate = opts.canMutate !== false;
  const suggestions = resolveCodeSuggestions(doc) as {
    key: string;
    id: string;
    anchor: { start: number; end: number };
    insertedText: string;
    deletedText: string;
    attribution: { authorId: string | null; agentTurnId: string | null; chatId: string | null; authorLabel: string | null };
  }[];
  const matches: CodeHunkMatch[] = [];
  const chunks: CodePendingAddition[] = [];
  const lineAt = linesAt(
    bufferText,
    suggestions.flatMap((s) => {
      const len = s.anchor.end - s.anchor.start;
      return len > 0 ? [s.anchor.start, s.anchor.start + len - 1] : [s.anchor.start];
    }),
  );
  for (const s of suggestions) {
    const insertedLen = s.anchor.end - s.anchor.start;
    const insertedText = s.insertedText ?? bufferText.slice(s.anchor.start, s.anchor.end);
    const addStartLine = lineAt.get(s.anchor.start)!;
    // Last inserted char's line; an empty insertion (pure deletion) yields an
    // empty range (addEndLine < addStartLine) so only the ghost renders.
    const addEndLine = insertedLen > 0 ? lineAt.get(s.anchor.start + insertedLen - 1)! : addStartLine - 1;
    const deletedLines = toLines(s.deletedText);
    const addedLines = toLines(insertedText);
    matches.push({ key: s.key, addStartLine, addEndLine, deletedLines });
    chunks.push({
      key: s.key,
      groupKey: s.id,
      text: insertedText,
      canMutate,
      lines: [
        ...deletedLines.map((content) => ({ type: 'deletion', content }) as TurnEditLine),
        ...addedLines.map((content) => ({ type: 'addition', content }) as TurnEditLine),
      ],
      newStart: addStartLine - 1,
      deletedText: s.deletedText,
      // Ledger writes from the agent rail persist authorId but rarely a display
      // label — derive one so the review pill can always say who suggested it.
      authorLabel:
        s.attribution.authorLabel ?? defaultAuthorLabel({ authorId: s.attribution.authorId }),
      authorVisual: authorVisualForId(
        s.attribution.authorId,
        s.attribution.agentTurnId,
        s.attribution.authorLabel,
        s.id,
      ),
      assistantMessageId: s.attribution.agentTurnId ?? undefined,
      chatId: s.attribution.chatId ?? undefined,
    });
  }
  return { matches, chunks };
}
