// Pure blame walk — no server deps, so unit tests can drive it with fixtures.
import { normalizeForDiff } from '@/lib/workspace/pending-additions-match';
import { parseMarkdown } from '@/lib/markdown/parser.mjs';
import { imageMarkdown } from '@/lib/markdown/image-attrs.mjs';

export type BlameTurn = {
  /** Full file text AFTER this edit. */
  text: string;
  /** The path this edit was written at — a pre-move edit still lives at the
   *  source path, and its turn diff is filed there too. */
  path?: string | null;
  authorId: string | null;
  actor: string | null;
  assistantMessageId: string | null;
  createdAt: string | null;
};

export type BlameLine = {
  /** ONE rendered block's text (a paragraph joins its hard-wrapped source
   *  lines), which is exactly what the painter compares against a ProseMirror
   *  block's `textContent`. */
  text: string;
  authorId: string | null;
  createdAt: string | null;
  assistantMessageId: string | null;
  chatId: string | null;
  /** Path-share redaction: the line exists (occupies its occurrence slot so
   *  positional matching stays aligned) but its provenance stays buried. */
  redacted?: boolean;
  /** Path the attributing edit was written at (differs from the open file
   *  after a move — the turn's diff is filed under the old path). */
  filePath?: string | null;
};

/**
 * A raw markdown line → the text the editor actually RENDERS, which is what
 * the authorship painter matches against (`node.textContent`).
 *
 * Delegates to the repo's one markdown text normalizer: block markers AND
 * inline delimiters, so `**bold**`, `[docs](url)`, `[[wiki|alias]]`, code
 * spans and the rest resolve to their rendered text. Stripping only block
 * prefixes left every formatted line un-attributed in the lens (Codex, PR
 * #1104 round 9).
 */
export function stripBlockPrefix(line: string): string {
  return normalizeForDiff(line, { markdown: true });
}

/**
 * Raw markdown → the text of each RENDERED textblock, in document order —
 * exactly what the painter compares against a ProseMirror textblock's
 * `textContent`.
 *
 * Built on the repo's ONE markdown parser (lib/markdown/parser.mjs), never a
 * second hand-rolled interpretation: lists nest, tables split per cell,
 * callouts and blockquotes unwrap, and inline marks resolve to their text.
 * Two subtleties the earlier regex splitter got wrong (2026-08-06 self-review):
 * hard-wrapped source lines become `hardBreak` nodes whose `textContent`
 * contribution is EMPTY (not a space), and table rows are per-cell
 * textblocks, not one pipe-joined line.
 */
export function renderedBlocks(text: string): string[] {
  const out: string[] = [];
  const inlineText = (inline: unknown): string => {
    let joined = '';
    type InlineNode = {
      type?: string;
      text?: string;
      alt?: string;
      src?: string;
      width?: number;
      align?: string;
    };
    for (const node of (inline as InlineNode[]) ?? []) {
      if (node?.type === 'text' && typeof node.text === 'string') joined += node.text;
      // An inline image is LITERAL markdown inside the textblock (the codec
      // inserts `imageMarkdown(...)` as text and the editor overlays a preview),
      // so `textContent` carries it and blame must too — dropping it left every
      // paragraph containing an image un-attributed (Codex, PR #1104 round 23).
      else if (node?.type === 'image') {
        joined += imageMarkdown(node.alt ?? '', node.src ?? '', {
          width: node.width,
          align: node.align,
        });
      }
      // Other leaf nodes (hardBreak, math) contribute '' — same as textContent.
    }
    return joined;
  };
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
  };
  const walk = (blocks: unknown): void => {
    for (const block of (blocks as Array<Record<string, unknown>>) ?? []) {
      switch (block?.type) {
        case 'paragraph':
        case 'heading':
          push(inlineText(block.inline));
          break;
        case 'codeBlock':
        // Frontmatter is raw text too — the codec stores the whole YAML block
        // (fences included) as ONE visible textblock, so it needs its own
        // blame slot or a note's properties show up un-attributed and every
        // later block shifts by one (Codex, PR #1104 round 17).
        case 'frontmatter':
          push(typeof block.text === 'string' ? block.text : '');
          break;
        case 'bulletList':
        case 'orderedList':
          for (const item of (block.items as unknown[]) ?? []) walk(item);
          break;
        case 'table':
          for (const cell of (block.header as unknown[]) ?? []) push(inlineText(cell));
          for (const row of (block.rows as unknown[][]) ?? []) {
            for (const cell of row ?? []) push(inlineText(cell));
          }
          break;
        default:
          // Containers (blockquote, callout, future types): unwrap children.
          // A callout's title is stored beside its children and the Yjs codec
          // emits it as the callout's FIRST paragraph, so it needs its own
          // blame slot here or the rendered title goes un-attributed and every
          // later occurrence in the block shifts by one (Codex, PR #1104
          // round 13).
          if (typeof block?.title === 'string') push(block.title);
          if (Array.isArray(block?.children)) walk(block.children);
      }
    }
  };
  walk(parseMarkdown(text));
  return out;
}

/**
 * Attribute every line of the NEWEST text to the edit that introduced it.
 *
 * Multiset walk oldest → newest: a line is "introduced" by turn N when N's
 * text contains more copies of it than turn N-1's. Each occurrence in the
 * final text takes the newest introduction not yet consumed by a later
 * duplicate, which keeps repeated lines (list items, boilerplate) attributed
 * to whoever actually added each copy rather than all to the first author.
 * User-revert rows (actor user/anon re-writing an agent turn's text) still
 * count as introductions by their own author — reverting IS an edit.
 */
export function blameLines(
  turns: BlameTurn[],
  opts?: {
    /** True when `turns[0]` is a BASELINE past the fetch horizon: lines it
     *  introduces are older than the window can see, so they surface with
     *  `redacted: true` (unknown provenance) instead of being falsely
     *  attributed to the horizon row's author (Codex, PR #1104). */
    baselineUnknown?: boolean;
  },
): BlameLine[] {
  if (turns.length === 0) return [];

  // POSITIONAL alignment, not text multisets. A multiset walk can't tell WHICH
  // duplicate a deletion removed and always discarded the newest introduction
  // — Alice adds TODO, Bob adds another, the top one is deleted, and the
  // survivor was credited to Alice (Codex, PR #1104 round 12). LCS between
  // consecutive block lists carries each surviving position's attribution
  // forward; ties prefer treating the EARLIEST duplicate as the deleted one,
  // matching how positional diffs read such an edit.
  let blocks: string[] = [];
  let attribution: number[] = [];
  turns.forEach((turn, index) => {
    const next = renderedBlocks(turn.text);
    attribution = alignAttribution(blocks, attribution, next, index);
    blocks = next;
  });

  return blocks.map((text, position) => {
    const turnIndex = attribution[position] ?? 0;
    if (turnIndex === 0 && opts?.baselineUnknown) {
      // Introduced at (or before) the horizon baseline — unknown, not the
      // horizon author's work.
      return { text, authorId: null, createdAt: null, assistantMessageId: null, chatId: null, redacted: true };
    }
    const turn = turns[turnIndex] ?? turns[turns.length - 1];
    return {
      text,
      authorId: turn.authorId,
      createdAt: turn.createdAt,
      assistantMessageId: turn.assistantMessageId,
      chatId: null,
      filePath: turn.path ?? null,
    };
  });
}

// Guard for pathological documents: above this many DP cells, fall back to
// prefix/suffix matching (the degenerate-case strategy diff tools use).
const LCS_CELL_CAP = 1_500_000;

/** Carry per-position attribution across one edit via LCS alignment. */
function alignAttribution(
  prev: string[],
  prevAttribution: number[],
  next: string[],
  turnIndex: number,
): number[] {
  if (prev.length === 0) return next.map(() => turnIndex);
  if ((prev.length + 1) * (next.length + 1) > LCS_CELL_CAP) {
    // Degenerate fallback: keep the common prefix + suffix, stamp the middle.
    const out = next.map(() => turnIndex);
    let head = 0;
    while (head < prev.length && head < next.length && prev[head] === next[head]) {
      out[head] = prevAttribution[head];
      head += 1;
    }
    let tail = 0;
    while (
      tail < prev.length - head &&
      tail < next.length - head &&
      prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
    ) {
      out[next.length - 1 - tail] = prevAttribution[prev.length - 1 - tail];
      tail += 1;
    }
    return out;
  }

  // dp[i][j] = LCS length of prev[i..] vs next[j..].
  const cols = next.length + 1;
  const dp = new Uint32Array((prev.length + 1) * cols);
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    for (let j = next.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] =
        prev[i] === next[j]
          ? dp[(i + 1) * cols + j + 1] + 1
          : Math.max(dp[(i + 1) * cols + j], dp[i * cols + j + 1]);
    }
  }
  const out = new Array<number>(next.length);
  let i = 0;
  let j = 0;
  while (j < next.length) {
    if (i >= prev.length) {
      out[j] = turnIndex; // appended past the old text
      j += 1;
    } else if (prev[i] === next[j] && dp[i * cols + j] === dp[(i + 1) * cols + j]) {
      // Matching here OR skipping prev[i] both preserve the LCS: prefer the
      // skip, so a deletion among duplicates consumes the EARLIEST copy and
      // the survivor keeps the later author (the round-12 Alice/Bob case).
      i += 1;
    } else if (prev[i] === next[j] && dp[i * cols + j] === dp[(i + 1) * cols + j + 1] + 1) {
      // The surviving copy keeps its author and the EXTRA copy reads as the
      // new one. Inserting a duplicate above vs below an identical block is
      // indistinguishable from the texts alone, so this follows the same
      // convention `diff` itself uses (`- TODO` → `- TODO\n- TODO` reports
      // line 2 as the addition, and the reverse deletes line 1) — the mirror
      // of the deletion tie-break above (Codex, PR #1104 rounds 12 and 21).
      out[j] = prevAttribution[i];
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      i += 1; // prev[i] deleted
    } else {
      out[j] = turnIndex; // next[j] inserted
      j += 1;
    }
  }
  return out;
}

/**
 * Path-share bound: lines whose attributed edit predates the covering grant
 * are REDACTED IN PLACE — the guest can read the text, but pre-share
 * who/when/turn stays buried, mirroring the scoped turn/diff paths
 * (`earliestCoveringGrantCreatedAt`). Redacted, not removed: the painter
 * consumes same-text ranges positionally, so dropping a pre-share occurrence
 * would let it swallow a post-share range and leak attribution onto exactly
 * the text that must stay dark (Codex, PR #1104 round 11). A null attribution
 * time also redacts: with a bound in force, unknown age reads as pre-share.
 */
export function applyShareStartBound(lines: BlameLine[], shareStartAt: string | null | undefined): BlameLine[] {
  if (!shareStartAt) return lines;
  return lines.map((line) =>
    typeof line.createdAt === 'string' && line.createdAt >= shareStartAt
      ? line
      : { text: line.text, authorId: null, createdAt: null, assistantMessageId: null, chatId: null, redacted: true },
  );
}
