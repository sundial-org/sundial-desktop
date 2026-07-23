import * as Y from 'yjs';
import { CODE_TEXT_ROOT } from '@/lib/collab/code-text';
import {
  clipCommentQuote,
  type CommentAnchorPayload,
  type DocCommentThread,
  type DraftDocCommentSelection,
  type ResolvedDocCommentRange,
} from '@/lib/workspace/doc-comments';

// Comment anchoring for the Monaco (code/LaTeX) editor. The file's content is a
// flat Y.Text (`codetext` root), so — unlike the ProseMirror path — we anchor to
// Yjs RelativePositions on that text. They survive concurrent edits the same way
// the markdown anchors do, and resolve to plain character offsets that map 1:1
// to Monaco model offsets (the binding keeps both on LF).

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build a draft selection from a character range `[from, to)` into the code
 * text. Anchors are RelativePosition JSON so they ride along with edits.
 */
export function buildCodeCommentSelection(
  ydoc: Y.Doc,
  from: number,
  to: number,
  quoteText: string,
): DraftDocCommentSelection | null {
  if (from === to) return null;
  const yText = ydoc.getText(CODE_TEXT_ROOT);
  const quote = clipCommentQuote(quoteText);
  if (!quote) return null;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const anchor = Y.createRelativePositionFromTypeIndex(yText, lo);
  const head = Y.createRelativePositionFromTypeIndex(yText, hi);
  return {
    quote,
    anchor: Y.relativePositionToJSON(anchor) as Record<string, unknown>,
    head: Y.relativePositionToJSON(head) as Record<string, unknown>,
  };
}

function relToOffset(ydoc: Y.Doc, json: CommentAnchorPayload): number | null {
  if (!isRecord(json)) return null;
  try {
    const rel = Y.createRelativePositionFromJSON(json);
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, ydoc);
    return abs ? abs.index : null;
  } catch {
    return null;
  }
}

export function resolveCodeCommentAnchorRange(
  anchorJson: CommentAnchorPayload,
  headJson: CommentAnchorPayload,
  ydoc: Y.Doc | null,
): { from: number; to: number } | null {
  if (!ydoc) return null;
  const a = relToOffset(ydoc, anchorJson);
  const b = relToOffset(ydoc, headJson);
  if (a === null || b === null) return null;
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  if (from === to) return null;
  return { from, to };
}

function readQuoteAnchor(payload: CommentAnchorPayload): string | null {
  if (isRecord(payload) && payload.kind === 'string-quote' && typeof payload.quote === 'string') {
    return payload.quote;
  }
  return null;
}

/**
 * Resolve open threads to `[from, to)` character ranges. Primary path is the
 * RelativePosition anchor; falls back to substring-searching the saved quote so
 * HTTP-only agent comments (which can't mint a RelativePosition server-side)
 * still anchor — mirrors the markdown resolver's two-path design.
 */
export function resolveCodeCommentRanges(
  threads: DocCommentThread[],
  ydoc: Y.Doc | null,
  text: string,
): ResolvedDocCommentRange[] {
  const ranges: ResolvedDocCommentRange[] = [];
  for (const thread of threads) {
    const rel = resolveCodeCommentAnchorRange(thread.anchor, thread.head, ydoc);
    if (rel) {
      ranges.push({ id: thread.id, from: rel.from, to: rel.to, status: thread.status });
      continue;
    }
    const quote = readQuoteAnchor(thread.anchor) ?? readQuoteAnchor(thread.head) ?? thread.quote;
    if (!quote) continue;
    const idx = text.indexOf(quote);
    if (idx === -1) continue;
    ranges.push({ id: thread.id, from: idx, to: idx + quote.length, status: thread.status });
  }
  return ranges;
}
