// Browser-safe canonicalization: document_text.mjs (the usual owner of
// canonicalizeContentText) transitively reads policy.json via node:fs, which
// no client bundle can carry — and the local-workspace data plane builds these
// diffs in the browser. Same semantics: strip NUL, canonical markdown form.
import { canonicalizeMarkdown } from '@/lib/crdt-js/markdown_yjs.mjs';
import { isMarkdownFile } from '@/lib/sync/policy';

function canonicalizeContentText(filePath: string, text: string): string {
  const clean = text.includes('\0') ? text.replace(/\0/g, '') : text;
  return isMarkdownFile(filePath) ? canonicalizeMarkdown(clean) : clean;
}

export const TURN_EDIT_MAX_BYTES = 150 * 1024;
export const TURN_EDIT_MAX_LINES = 2000;
const CHUNK_CONTEXT_LINES = 2;

export type TurnEditLine = {
  type: 'addition' | 'deletion' | 'context';
  content: string;
  lineNumber?: number;
};

export type TurnEditChunk = {
  id: string;
  /**
   * The pre-content-hash positional id this chunk would have had
   * (`chunk-<n>-<oldStart>-<newStart>-…`). Decision replay matches it too, so
   * `diff.chunk_kept`/`undone` events recorded before the id format changed keep
   * resolving (for chunks whose positions haven't since shifted — the only ones
   * the old positional scheme matched anyway). Transitional; safe to drop once
   * no pre-migration decisions remain.
   */
  legacyId?: string;
  status: 'pending' | 'kept' | 'undone';
  lines: TurnEditLine[];
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
};

export type TurnEditFile = {
  id: string;
  fileId: string | null;
  filePath: string;
  isNew: boolean;
  isDeleted: boolean;
  addedLineCount: number;
  deletedLineCount: number;
  // Set when the file is too large to diff (over the byte/line budget). The
  // file still surfaces in chat — with `chunks: []` and a size-only notice —
  // instead of vanishing silently. See `buildOversizedTurnEditFile`.
  oversized?: boolean;
  // A binary (png, pdf…) the turn produced. Blobs aren't CRDT text and create
  // no doc_edits row — the entry is synthesized from the blob's attributed
  // lifecycle event: chunkless and not reviewable, rendered as an added/updated
  // notice (plus an image preview) instead of a text diff.
  blob?: boolean;
  mime?: string | null;
  lineCount?: number;
  byteSize?: number;
  chunks: TurnEditChunk[];
};

/** When an applied-edit session merely accepted a pending suggestion, who
 *  originally proposed it — lets the Review panel label the accepted diff
 *  ("Accepted Sunny's suggestion") instead of showing an empty edit. */
export type AcceptedSuggestion = { kind: 'sunny' | 'local_agent' | 'human'; name: string };

export type TurnEditsResponse = {
  assistantMessageId: string;
  files: TurnEditFile[];
  allUndone: boolean;
  /** Present only for an applied session that accepted a suggestion. */
  acceptedFrom?: AcceptedSuggestion | null;
  /** The workspace the turn belongs to — lets the card fetch blob previews. */
  projectId?: string;
};

type DiffOp = {
  type: 'addition' | 'deletion' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  oldStart: number;
  newStart: number;
};

export function normalizeTurnEditText(text: string | null | undefined) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
}

export function countTextLines(text: string) {
  if (!text) return 0;
  return normalizeTurnEditText(text).split('\n').length;
}

export function isOversizedTurnEditText(text: string, byteSize?: number | null) {
  const normalized = normalizeTurnEditText(text);
  const bytes = typeof byteSize === 'number' && Number.isFinite(byteSize)
    ? byteSize
    : new TextEncoder().encode(normalized).length;
  return bytes > TURN_EDIT_MAX_BYTES || countTextLines(normalized) > TURN_EDIT_MAX_LINES;
}

/**
 * Whether a text body can surface a Keep/Undo chunk, i.e. `buildTurnEditFile`
 * would emit at least one chunk for a delete/create/rename of it. Two bodies
 * can't: an EMPTY file (a delete/create diffs `'' ↔ ''` → no chunk) and an
 * OVERSIZED file (over the byte/line budget → chunkless "diff too large"
 * placeholder, and undo-chunk 422s). The suggest rails record such changes
 * direct instead of as a suggestion the reviewer could never act on (still
 * recoverable via History). Mirrored by `_text_is_inline_reviewable` in
 * `sandbox/shared/crdt_sync.py`.
 */
export function textContentIsInlineReviewable(content: string): boolean {
  return content !== '' && !isOversizedTurnEditText(content);
}

// A file still "counts" for a turn if it proposed a non-undone chunk, or it's
// a chunkless placeholder (oversized / blob — the turn did touch the file).
export function turnEditFileIsActive(file: TurnEditFile) {
  return Boolean(file.oversized || file.blob) || file.chunks.some((chunk) => chunk.status !== 'undone');
}

function splitLines(text: string) {
  if (!text) return [];
  return normalizeTurnEditText(text).split('\n');
}

/** Deterministic FNV-1a 32-bit hash → base36, for stable content-keyed ids. */
function hashChunkContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function buildDiffOps(oldLines: string[], newLines: string[]) {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const reversed: Array<Omit<DiffOp, 'oldStart' | 'newStart'>> = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversed.push({
        type: 'context',
        content: oldLines[i - 1] ?? '',
        oldLineNumber: i - 1,
        newLineNumber: j - 1,
      });
      i -= 1;
      j -= 1;
      continue;
    }
    if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversed.push({
        type: 'addition',
        content: newLines[j - 1] ?? '',
        newLineNumber: j - 1,
      });
      j -= 1;
      continue;
    }
    reversed.push({
      type: 'deletion',
      content: oldLines[i - 1] ?? '',
      oldLineNumber: i - 1,
    });
    i -= 1;
  }

  const ops = reversed.reverse();
  let oldCursor = 0;
  let newCursor = 0;
  return ops.map((op) => {
    const withOffsets: DiffOp = {
      ...op,
      oldStart: oldCursor,
      newStart: newCursor,
    };
    if (op.type !== 'addition') oldCursor += 1;
    if (op.type !== 'deletion') newCursor += 1;
    return withOffsets;
  });
}

function buildChunkRanges(ops: DiffOp[]) {
  const changedRanges: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]?.type === 'context') {
      index += 1;
      continue;
    }
    const start = index;
    while (index < ops.length && ops[index]?.type !== 'context') {
      index += 1;
    }
    changedRanges.push({ start, end: index });
  }

  // Merge change-ranges only when they belong to the same logical "edit
  // region". Two edits stay in the same chunk if (a) no blank-line context
  // sits between them (i.e. they're in the same paragraph / contiguous
  // block of non-blank lines) AND (b) they're close enough that the context
  // windows would otherwise duplicate. Crossing a blank line or a wide gap
  // always splits — the user reads two paragraph-level edits much better as
  // two distinct chunks than one fused super-chunk where the renderer has
  // to lump unrelated deletions/additions together.
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of changedRanges) {
    const previous = merged[merged.length - 1];
    if (previous) {
      let crossesBlankLine = false;
      for (let i = previous.end; i < range.start; i += 1) {
        if (ops[i]?.content === '') {
          crossesBlankLine = true;
          break;
        }
      }
      const tooFar = range.start - previous.end > 2 * CHUNK_CONTEXT_LINES;
      if (!crossesBlankLine && !tooFar) {
        previous.end = range.end;
        continue;
      }
    }
    merged.push({ start: range.start, end: range.end });
  }

  // Now expand each merged group with context lines on either side. Clip
  // each expansion against its neighbours so two chunks never claim the
  // same change-op as their own — both may render the shared blank-line
  // context between them, but the changed lines belong to exactly one chunk.
  return merged.map((range, idx) => {
    const prevEnd = idx > 0 ? merged[idx - 1]!.end : 0;
    const nextStart = idx < merged.length - 1 ? merged[idx + 1]!.start : ops.length;
    return {
      start: Math.max(range.start - CHUNK_CONTEXT_LINES, prevEnd, 0),
      end: Math.min(range.end + CHUNK_CONTEXT_LINES, nextStart, ops.length),
    };
  });
}

function opToLine(op: DiffOp): TurnEditLine {
  const lineNumber = op.type === 'addition'
    ? typeof op.newLineNumber === 'number'
      ? op.newLineNumber + 1
      : undefined
    : typeof op.oldLineNumber === 'number'
      ? op.oldLineNumber + 1
      : undefined;
  return {
    type: op.type,
    content: op.content,
    lineNumber,
  };
}

export function buildTurnEditFile(params: {
  fileId: string | null;
  filePath: string;
  beforeText: string;
  afterText: string;
  isNew?: boolean;
  isDeleted?: boolean;
}): TurnEditFile | null {
  // Diff the canonical form of both sides — the same text the Y.Doc actually
  // holds after the markdown round-trip. Diffing raw agent output instead
  // yields chunks whose line text never matches the live doc blocks, so the
  // inline-diff matcher drops every decoration and text-anchored undo can't
  // locate its addition. (No-op for non-markdown files.)
  const beforeLines = splitLines(canonicalizeContentText(params.filePath, params.beforeText));
  const afterLines = splitLines(canonicalizeContentText(params.filePath, params.afterText));
  const ops = buildDiffOps(beforeLines, afterLines);
  const chunkRanges = buildChunkRanges(ops);
  if (chunkRanges.length === 0) {
    return null;
  }

  // Chunk ids are CONTENT-derived, not position-derived. A position-encoded id
  // (`chunk-N-oldStart-newStart-…`) shifts whenever an unrelated line above is
  // added/removed, which orphans the chunk's `diff.chunk_kept`/`undone`
  // decision and makes an already-resolved chunk re-render as pending.
  //
  // The id is the hash of the CHANGED lines only — so it's stable against ANY
  // line shift, near or far (it ignores surrounding context entirely). The sole
  // ambiguity is identical changed content in the same file (e.g. the same word
  // fixed in two paragraphs); ONLY those colliding chunks get a discriminator,
  // and it's their surrounding context — order-independent, unlike a positional
  // occurrence index, which would renumber when an identical edit is inserted
  // above a kept one and land the kept decision on the wrong (unreviewed) chunk.
  // A unique chunk therefore keeps a pure content id that survives nearby edits;
  // only duplicates are context-sensitive. The trailing occurrence index is a
  // last resort for chunks that are byte-identical including context.
  //
  // Accepted residual: when a chunk that WAS unique gains an identical-content
  // twin later in the run, its id flips from `chunk-<changedHash>` to the
  // context-suffixed form, so a prior keep re-pends (it never auto-accepts the
  // twin). This is irreducible for a *derived* id — no content-based id can be
  // stable against BOTH nearby-context changes and identical-content insertions;
  // we pick this (rarer) corner. The complete fix is a persistent stored chunk
  // id, a larger change tracked separately. Either way no decision is lost.
  const changedKeyOf = (range: { start: number; end: number }) =>
    ops
      .slice(range.start, range.end)
      .filter((op) => op.type !== 'context')
      .map((op) => `${op.type}:${op.content}`)
      .join('\n');
  const changedHashes = chunkRanges.map((range) => hashChunkContent(changedKeyOf(range)));
  const changedHashCounts = new Map<string, number>();
  for (const hash of changedHashes) changedHashCounts.set(hash, (changedHashCounts.get(hash) ?? 0) + 1);
  const occurrenceById = new Map<string, number>();
  const chunks: TurnEditChunk[] = chunkRanges.map((range, index) => {
    const segment = ops.slice(range.start, range.end);
    const changed = segment.filter((op) => op.type !== 'context');
    const firstChanged = changed[0]!;
    const lastChanged = changed[changed.length - 1]!;
    const changedHash = changedHashes[index]!;
    let id = `chunk-${changedHash}`;
    if ((changedHashCounts.get(changedHash) ?? 0) > 1) {
      const contextHash = hashChunkContent(
        segment.filter((op) => op.type === 'context').map((op) => op.content).join('\n'),
      );
      id = `${id}-${contextHash}`;
    }
    const occurrence = occurrenceById.get(id) ?? 0;
    occurrenceById.set(id, occurrence + 1);
    if (occurrence > 0) id = `${id}-${occurrence}`;
    return {
      id,
      // The exact id this chunk had before the content-hash switch, so stored
      // keep/undo decisions still match after deploy (see TurnEditChunk.legacyId).
      legacyId: `chunk-${index + 1}-${firstChanged.oldStart}-${firstChanged.newStart}-${lastChanged.oldStart}-${lastChanged.newStart}`,
      status: 'pending',
      lines: segment.map(opToLine),
      oldStart: firstChanged.oldStart,
      oldEnd: lastChanged.oldStart + (lastChanged.type !== 'addition' ? 1 : 0),
      newStart: firstChanged.newStart,
      newEnd: lastChanged.newStart + (lastChanged.type !== 'deletion' ? 1 : 0),
    };
  });

  const addedLineCount = ops.filter((op) => op.type === 'addition').length;
  const deletedLineCount = ops.filter((op) => op.type === 'deletion').length;

  return {
    id: params.filePath,
    fileId: params.fileId,
    filePath: params.filePath,
    isNew: params.isNew ?? beforeLines.length === 0,
    isDeleted: params.isDeleted ?? afterLines.length === 0,
    addedLineCount,
    deletedLineCount,
    chunks,
  };
}

/**
 * A file that blew past the diff budget (`isOversizedTurnEditText`). We can't
 * render a line diff, but the turn still *did* something, so emit a chunkless
 * placeholder carrying its size — the chat renders a "diff too large" notice
 * rather than dropping the file and claiming the turn produced no edit.
 */
export function buildOversizedTurnEditFile(params: {
  fileId: string | null;
  filePath: string;
  beforeText: string;
  afterText: string;
  isNew: boolean;
  isDeleted: boolean;
}): TurnEditFile {
  const subject = params.isDeleted ? params.beforeText : params.afterText;
  return {
    id: params.filePath,
    fileId: params.fileId,
    filePath: params.filePath,
    isNew: params.isNew,
    isDeleted: params.isDeleted,
    addedLineCount: 0,
    deletedLineCount: 0,
    oversized: true,
    lineCount: countTextLines(subject),
    byteSize: new TextEncoder().encode(normalizeTurnEditText(subject)).length,
    chunks: [],
  };
}

/**
 * A binary (png, pdf…) the turn produced, synthesized from its attributed
 * lifecycle event — blobs create no doc_edits row, so there is no text to
 * diff. Chunkless and not reviewable; the card renders an added/updated
 * notice (and an image preview) instead of dropping the file from the turn.
 */
export function buildBlobTurnEditFile(params: {
  fileId: string | null;
  filePath: string;
  isNew: boolean;
  mime: string | null;
  byteSize: number | null;
}): TurnEditFile {
  return {
    id: params.filePath,
    fileId: params.fileId,
    filePath: params.filePath,
    isNew: params.isNew,
    isDeleted: false,
    addedLineCount: 0,
    deletedLineCount: 0,
    blob: true,
    mime: params.mime,
    byteSize: params.byteSize ?? undefined,
    chunks: [],
  };
}

/**
 * Reverse-apply this chunk's hunk to the file in line-space: find the chunk's
 * "after" form (context + additions) as a contiguous run of lines in the
 * current text, swap it for the "before" form (context + deletions), rejoin.
 *
 * No char-level newline handling — blank-line separators ride along as empty
 * strings in the line array and are preserved exactly by split('\n') /
 * join('\n'). One code path covers additions, deletions, replacements, new
 * files, and mid-file edits.
 *
 * Returns null when the hunk's after-form is no longer a contiguous slice of
 * the file (later turn edited inside this hunk's neighborhood, or the chunk
 * was already undone). The caller treats null as a no-op success.
 */
export function applyUndoChunkToText(
  currentText: string,
  chunk: Pick<TurnEditChunk, 'lines'>,
): string | null {
  const afterForm = chunk.lines
    .filter((line) => line.type !== 'deletion')
    .map((line) => line.content);
  const beforeForm = chunk.lines
    .filter((line) => line.type !== 'addition')
    .map((line) => line.content);
  if (afterForm.length === 0) return null;

  const lines = currentText.split('\n');
  const idx = findLineSubsequence(lines, afterForm);
  if (idx < 0) return null;

  return [
    ...lines.slice(0, idx),
    ...beforeForm,
    ...lines.slice(idx + afterForm.length),
  ].join('\n');
}

function findLineSubsequence(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
