import type { Editor } from '@tiptap/react';
// MUST come from @tiptap/y-tiptap, not y-prosemirror — the editor binds via
// y-tiptap's plugin key; y-prosemirror's would silently return no binding
// (same trap documented in doc-comments-client.ts).
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { findQuoteRange, resolveDocCommentAnchorRange } from '@/lib/workspace/doc-comments-client';
import { markdownToProseMirror, proseMirrorToMarkdown } from '@/lib/markdown/codec';

/* ── Rewrite anchoring ────────────────────────────────────────────────
 *  Variants stream for seconds while collaborators (or the author) keep
 *  editing, so "apply variant 2" must survive the passage MOVING. Same
 *  two-path strategy as doc comments: Yjs relative positions (stable under
 *  any surrounding edit, including block moves) verified against the
 *  captured text, then a text search fallback (cut+paste elsewhere, or no
 *  y-sync binding). If neither finds the exact original text, the rewrite
 *  is stale — never apply onto changed text.
 * ─────────────────────────────────────────────────────────────────── */

export type RewriteSelectionCapture = {
  /** MARKDOWN of the range (inline marks preserved) — what the model sees,
   *  what the diff renders, and what an applied variant is parsed back from,
   *  so bold/links/code survive the round trip. */
  text: string;
  /** Concatenated text nodes, no separators — findQuoteRange's convention. */
  quote: string;
  anchor: Record<string, unknown> | null;
  head: Record<string, unknown> | null;
  /** Whether the quote was the doc's ONLY occurrence at capture time. A
   *  duplicate that existed then poisons the text-search fallback forever:
   *  if the selected copy is later edited away, the surviving copy would
   *  look unique and get rewritten instead. */
  quoteWasUnique: boolean;
  contextBefore: string;
  contextAfter: string;
};

const CONTEXT_CHARS = 2000;

function relativeJsonAt(editor: Editor, pos: number): Record<string, unknown> | null {
  const binding = ySyncPluginKey.getState(editor.state)?.binding;
  if (!binding?.doc || !binding?.type || !binding?.mapping) return null;
  const rel = absolutePositionToRelativePosition(pos, binding.type, binding.mapping);
  return rel ? (Y.relativePositionToJSON(rel) as Record<string, unknown>) : null;
}

/** Yjs-relative capture of a single doc position (e.g. an insertion point
 *  that must survive edits made while a popup is open). Null without a
 *  y-sync binding — callers fall back to the raw position. */
export function capturePosition(editor: Editor, pos: number): Record<string, unknown> | null {
  return relativeJsonAt(editor, pos);
}

/** Where a captured position lives NOW, or null when it can't resolve. */
export function resolvePosition(
  editor: Editor,
  json: Record<string, unknown> | null,
): number | null {
  if (!json) return null;
  const binding = ySyncPluginKey.getState(editor.state)?.binding;
  if (!binding?.doc || !binding?.type || !binding?.mapping) return null;
  return relativePositionToAbsolutePosition(
    binding.doc,
    binding.type,
    Y.createRelativePositionFromJSON(json),
    binding.mapping,
  );
}

/** Capture an arbitrary range (no document context) — used for the applied
 *  span so the chose-then-edited watcher can re-read it later. */
export function captureRange(editor: Editor, from: number, to: number): RewriteSelectionCapture {
  const doc = editor.state.doc;
  const quote = doc.textBetween(from, to, '', '');
  return {
    text: proseMirrorToMarkdown(doc.cut(from, to)),
    quote,
    anchor: relativeJsonAt(editor, from),
    head: relativeJsonAt(editor, to),
    quoteWasUnique: countQuoteOccurrences(editor, quote) === 1,
    contextBefore: '',
    contextAfter: '',
  };
}

/** Capture the current selection plus bounded document context around it. */
export function captureRewriteSelection(editor: Editor): RewriteSelectionCapture | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const doc = editor.state.doc;
  const capture = captureRange(editor, from, to);
  if (!capture.text.trim()) return null;
  // Positions over-count characters (node boundaries), so a position window
  // of N is always ≥ N chars — slice to the char budget after extraction.
  capture.contextBefore = doc
    .textBetween(Math.max(0, from - CONTEXT_CHARS * 2), from, '\n', ' ')
    .slice(-CONTEXT_CHARS);
  capture.contextAfter = doc
    .textBetween(to, Math.min(doc.content.size, to + CONTEXT_CHARS * 2), '\n', ' ')
    .slice(0, CONTEXT_CHARS);
  return capture;
}

/** Non-overlapping occurrences of `quote` across the doc's text nodes (the
 *  same string findQuoteRange searches). */
function countQuoteOccurrences(editor: Editor, quote: string): number {
  // `''.indexOf('')` is 0 and the scan below would never advance — an empty
  // quote is unresolvable, not a match.
  if (!quote) return 0;
  let combined = '';
  editor.state.doc.descendants((node) => {
    if (node.isText && node.text) combined += node.text;
    return true;
  });
  let count = 0;
  for (let idx = combined.indexOf(quote); idx !== -1; idx = combined.indexOf(quote, idx + quote.length)) {
    count += 1;
  }
  return count;
}

/** Where the captured passage lives NOW, or null when its exact text no
 *  longer exists anywhere (stale — the caller must not apply). */
export function resolveRewriteRange(
  editor: Editor,
  capture: RewriteSelectionCapture,
): { from: number; to: number } | null {
  // Verify MARKDOWN, not just text: a collaborator adding a link/bold/code
  // over the passage changes no text node, but applying the old captured
  // markdown over it would silently discard their formatting — stale.
  const verified = (range: { from: number; to: number } | null) =>
    range &&
    editor.state.doc.textBetween(range.from, range.to, '', '') === capture.quote &&
    proseMirrorToMarkdown(editor.state.doc.cut(range.from, range.to)) === capture.text
      ? range
      : null;
  if (capture.anchor && capture.head) {
    const range = verified(resolveDocCommentAnchorRange(capture.anchor, capture.head, editor));
    if (range) return range;
  }
  // Text-search fallback only when the quote is unique BOTH at capture time
  // and now: a duplicate that existed at capture could be the one surviving
  // an edit to the selected copy, and a duplicate that exists now is a
  // guess either way — stale is the safe answer.
  return capture.quoteWasUnique && countQuoteOccurrences(editor, capture.quote) === 1
    ? verified(findQuoteRange(editor, capture.quote))
    : null;
}

/** Current text at the captured range regardless of whether it still matches —
 *  the chose-then-edited signal. Null when the positions no longer resolve. */
export function readTextAtCapture(editor: Editor, capture: RewriteSelectionCapture): string | null {
  if (!capture.anchor || !capture.head) return null;
  const range = resolveDocCommentAnchorRange(capture.anchor, capture.head, editor);
  // Markdown, like capture.text/the chosen variant — so the chose-then-edited
  // comparison never flags formatting as a phantom edit.
  return range ? proseMirrorToMarkdown(editor.state.doc.cut(range.from, range.to)) : null;
}

type ParsedDoc = ReturnType<typeof markdownToProseMirror>;
type ParsedNode = Parameters<Parameters<ParsedDoc['descendants']>[0]>[0];

/** The sole leaf textblock of a parsed doc, or null when there are 0 or 2+. */
function singleLeaf(doc: ParsedDoc): ParsedNode | null {
  const leaves: ParsedNode[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) {
      leaves.push(node);
      return false;
    }
    return true;
  });
  return leaves.length === 1 ? leaves[0] : null;
}

/** Root→leaf node-type signature (e.g. "bulletList/listItem/paragraph") when
 *  the doc has exactly one leaf textblock; null otherwise. */
function leafPath(doc: ParsedDoc): string | null {
  if (!singleLeaf(doc)) return null;
  const path: string[] = [];
  let node: ParsedNode | null = doc.firstChild;
  while (node) {
    path.push(node.type.name);
    if (node.isTextblock) break;
    node = node.firstChild;
  }
  return path.join('/');
}

/**
 * Apply a chosen variant through the editor's NORMAL transaction path —
 * ySyncPlugin syncs it and Hocuspocus attributes + persists it to doc_edits
 * exactly like typing. Returns a capture of the applied span (for the
 * chose-then-edited watcher), or null when the passage is stale.
 */
export function applyRewrite(
  editor: Editor,
  capture: RewriteSelectionCapture,
  variantText: string,
): RewriteSelectionCapture | null {
  const trimmed = variantText.trim();
  if (!trimmed) return null;
  const resolved = resolveRewriteRange(editor, capture);
  if (!resolved) return null;
  // The variant is trimmed, so keep any whitespace the user swept into the
  // selection: replacing `" target "` wholesale with `"replacement"` would
  // weld the neighbors together. Boundary whitespace is always plain text
  // inside the first/last block, so chars map 1:1 to positions.
  const leading = capture.quote.length - capture.quote.trimStart().length;
  const trailing = capture.quote.length - capture.quote.trimEnd().length;
  const range = { from: resolved.from + leading, to: resolved.to - trailing };
  if (range.from >= range.to) return null;

  // Parse the variant as MARKDOWN through the one true codec (never as HTML),
  // so `**bold**`/links/code come back as marks instead of literal syntax.
  // A single-paragraph variant applied within one textblock inserts its
  // INLINE content, keeping the surrounding block (heading, list item);
  // anything else inserts the parsed blocks.
  const parsed = markdownToProseMirror(trimmed);
  const blocks = (parsed.toJSON().content ?? []) as { type: string; content?: unknown[] }[];
  if (blocks.length === 0) return null;
  const sameBlock =
    editor.state.doc.resolve(range.from).parent === editor.state.doc.resolve(range.to).parent;
  // For a same-block replacement, unwrap to the INLINE content when the
  // variant is plain paragraph text (it slots into the existing block —
  // heading stays heading, list item stays a single item) or when its block
  // structure ECHOES the selection's own (a list-item selection round-trips
  // its `- ` marker; inserting the parsed bulletList would nest a list
  // inside the existing item). Only structure the selection did NOT have —
  // e.g. "make this a bullet" on a paragraph — inserts as blocks.
  const variantPath = leafPath(parsed);
  const unwrap =
    sameBlock &&
    variantPath !== null &&
    (variantPath === 'paragraph' || variantPath === leafPath(markdownToProseMirror(capture.text)));
  const content = unwrap ? (singleLeaf(parsed)!.toJSON().content ?? []) : blocks;
  if (content.length === 0) return null;

  const applied = editor
    .chain()
    .focus(undefined, { scrollIntoView: false })
    .insertContentAt(range, content, { updateSelection: true })
    .run();
  if (!applied) return null;
  const { from, to } = editor.state.selection;
  // updateSelection leaves the selection spanning/after the inserted content;
  // re-capture from the transaction result so the watcher tracks reality.
  return captureRange(editor, Math.min(range.from, from), Math.max(range.from, to));
}
