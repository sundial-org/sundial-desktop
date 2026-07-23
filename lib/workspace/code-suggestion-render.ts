import type { TurnEditLine } from '@/lib/workspace/turn-edits';
import type { CodePendingAddition } from '@/components/workspace/collab-code-editor';
import { resolveCodeSuggestions } from '@/lib/crdt-js/code_suggestions.mjs';

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

// 1-indexed line of a character offset in `text`.
function lineOf(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i += 1) if (text[i] === '\n') line += 1;
  return line;
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
  for (const s of suggestions) {
    const insertedLen = s.anchor.end - s.anchor.start;
    const insertedText = s.insertedText ?? bufferText.slice(s.anchor.start, s.anchor.end);
    const addStartLine = lineOf(bufferText, s.anchor.start);
    // Last inserted char's line; an empty insertion (pure deletion) yields an
    // empty range (addEndLine < addStartLine) so only the ghost renders.
    const addEndLine = insertedLen > 0 ? lineOf(bufferText, s.anchor.start + insertedLen - 1) : addStartLine - 1;
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
      authorLabel: s.attribution.authorLabel ?? undefined,
      assistantMessageId: s.attribution.agentTurnId ?? undefined,
      chatId: s.attribution.chatId ?? undefined,
    });
  }
  return { matches, chunks };
}
