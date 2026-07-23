import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
// Tiptap v3's Collaboration binds via @tiptap/y-tiptap (its fork of
// y-prosemirror), so the live editor's sync plugin + relative-position mapping
// live under y-tiptap's keys/helpers. Importing these from y-prosemirror would
// read a non-matching PluginKey and silently return no binding — comments would
// stop anchoring. These MUST come from the same module the editor binds with.
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {
  clipCommentQuote,
  type CommentAnchorPayload,
  type DraftDocCommentSelection,
  type ResolvedDocCommentRange,
  type DocCommentThread,
} from '@/lib/workspace/doc-comments';

const WORD_CHAR = /[\p{L}\p{N}_]/u;

// A non-word stand-in for inline leaf nodes (hard breaks, inline images/math)
// so each one occupies exactly one index — keeps the scanned string's indices
// aligned 1:1 with ProseMirror positions inside the block.
const LEAF_PLACEHOLDER = '￼';

/**
 * Word boundaries around `offset` within `text`, using letters/numbers/`_` as
 * word chars. Returns null when `offset` doesn't sit inside a word (e.g. on a
 * space, punctuation, or inline-leaf placeholder), so callers can fall back to
 * default behaviour. `offset` is clamped to `[0, text.length]`.
 */
export function wordBoundsAt(text: string, offset: number): { start: number; end: number } | null {
  let start = Math.max(0, Math.min(offset, text.length));
  let end = start;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;
  if (start === end) return null;
  return { start, end };
}

/**
 * When nothing is selected, expand the selection to the word under the given
 * screen coordinates. Right-clicking collapses any prior selection to the click
 * point in most browsers, so a context menu that acts on a selection (comment /
 * add link) would otherwise have nothing to target and we'd fall through to the
 * browser's native menu. Returns true when the editor ends up with a non-empty
 * selection. No-ops (returns false) on empty space, atoms, or non-text blocks.
 */
export function selectWordAtCoords(view: EditorView, clientX: number, clientY: number): boolean {
  if (!view.state.selection.empty) return true;
  const found = view.posAtCoords({ left: clientX, top: clientY });
  if (!found) return false;
  const $pos = view.state.doc.resolve(found.pos);
  if (!$pos.parent.isTextblock) return false;
  // Scan in document-position space: build a string over the block whose
  // indices map 1:1 to positions (inline leaf nodes → one placeholder char),
  // so the resulting range is always valid — no textContent/offset mismatch.
  const blockStart = $pos.start();
  const blockText = view.state.doc.textBetween($pos.start(), $pos.end(), LEAF_PLACEHOLDER, LEAF_PLACEHOLDER);
  const bounds = wordBoundsAt(blockText, $pos.parentOffset);
  if (!bounds) return false;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, blockStart + bounds.start, blockStart + bounds.end),
    ),
  );
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getCommentBinding(editor: Editor | null) {
  if (!editor) return null;
  const syncState = ySyncPluginKey.getState(editor.state);
  const binding = syncState?.binding;
  if (!binding?.doc || !binding?.type || !binding?.mapping) return null;
  return binding;
}

export function buildDraftDocCommentSelection(
  editor: Editor,
): DraftDocCommentSelection | null {
  const binding = getCommentBinding(editor);
  if (!binding) return null;
  const { from, to, empty } = editor.state.selection;
  if (empty || from === to) return null;

  const quote = clipCommentQuote(editor.state.doc.textBetween(from, to, '\n', ' '));
  if (!quote) return null;

  const anchor = absolutePositionToRelativePosition(from, binding.type, binding.mapping);
  const head = absolutePositionToRelativePosition(to, binding.type, binding.mapping);
  if (!anchor || !head) return null;

  return {
    quote,
    anchor: Y.relativePositionToJSON(anchor) as Record<string, unknown>,
    head: Y.relativePositionToJSON(head) as Record<string, unknown>,
  };
}

function findQuoteRange(editor: Editor, quote: string): { from: number; to: number } | null {
  if (!quote) return null;
  const doc = editor.state.doc;
  type Segment = { charStart: number; pmStart: number; len: number };
  const segments: Segment[] = [];
  let combined = '';
  doc.descendants((node, pos) => {
    if (node.isText && typeof node.text === 'string' && node.text.length > 0) {
      segments.push({ charStart: combined.length, pmStart: pos, len: node.text.length });
      combined += node.text;
    }
    return true;
  });
  const idx = combined.indexOf(quote);
  if (idx === -1) return null;
  const endChar = idx + quote.length;
  let from: number | null = null;
  let to: number | null = null;
  for (const seg of segments) {
    const segEndChar = seg.charStart + seg.len;
    if (from === null && idx >= seg.charStart && idx <= segEndChar) {
      from = seg.pmStart + (idx - seg.charStart);
    }
    if (endChar >= seg.charStart && endChar <= segEndChar) {
      to = seg.pmStart + (endChar - seg.charStart);
      break;
    }
  }
  if (from === null || to === null || from === to) return null;
  return { from, to };
}

function readQuoteAnchor(payload: Record<string, unknown>): string | null {
  if (payload.kind === 'string-quote' && typeof payload.quote === 'string') return payload.quote;
  return null;
}

export function resolveDocCommentRanges(
  threads: DocCommentThread[],
  editor: Editor | null,
): ResolvedDocCommentRange[] {
  const binding = getCommentBinding(editor);
  const ranges: ResolvedDocCommentRange[] = [];

  for (const thread of threads) {
    if (!isRecord(thread.anchor) || !isRecord(thread.head)) continue;

    // Path 1: human comments — Yjs RelativePosition JSON, needs the y-sync
    // binding. Yields stable anchors that survive cross-block edits.
    if (binding) {
      try {
        const anchor = Y.createRelativePositionFromJSON(thread.anchor);
        const head = Y.createRelativePositionFromJSON(thread.head);
        const anchorPos = relativePositionToAbsolutePosition(binding.doc, binding.type, anchor, binding.mapping);
        const headPos = relativePositionToAbsolutePosition(binding.doc, binding.type, head, binding.mapping);
        if (anchorPos !== null && headPos !== null) {
          const from = Math.min(anchorPos, headPos);
          const to = Math.max(anchorPos, headPos);
          if (from !== to) {
            ranges.push({ id: thread.id, from, to, status: thread.status });
            continue;
          }
        }
      } catch {
        // fall through to the string-quote fallback below
      }
    }

    // Path 2: agent comments — `kind: 'string-quote'` anchor payload.
    // Substring-search the PM doc for the saved quote. Loses anchor stability
    // when the doc changes, but lets HTTP-only agents post comments without
    // a Yjs binding on the server side.
    if (!editor) continue;
    const quote = readQuoteAnchor(thread.anchor) ?? readQuoteAnchor(thread.head) ?? thread.quote;
    if (!quote) continue;
    const range = findQuoteRange(editor, quote);
    if (!range) continue;
    ranges.push({ id: thread.id, from: range.from, to: range.to, status: thread.status });
  }

  return ranges;
}

export function resolveDocCommentDraftRange(
  selection: DraftDocCommentSelection | null,
  editor: Editor | null,
): { from: number; to: number } | null {
  if (!selection) return null;
  return resolveDocCommentAnchorRange(selection.anchor, selection.head, editor);
}

/**
 * Re-run `onReflow` whenever the editor's rendered layout could have shifted so
 * the comment lane can re-measure each card to its anchor. Local edits
 * (`update`) and window resizes are the obvious triggers, but on reload the
 * editor reflows asynchronously *after* first paint — the CRDT content swaps in,
 * web fonts load, images decode — and none of those fire an editor `update`.
 * Without re-measuring on them the cards stay stacked at the top until an
 * unrelated event recomputes (the "comments pile up at the top on reload" bug).
 * A ResizeObserver on the editor DOM plus a `fonts.ready` tick catch those late
 * reflows. Returns a teardown.
 */
export function observeCommentAnchorReflow(editor: Editor, onReflow: () => void): () => void {
  editor.on('update', onReflow);
  window.addEventListener('resize', onReflow);
  const dom = editor.view?.dom as HTMLElement | undefined;
  const observer =
    dom && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => onReflow()) : null;
  if (dom) observer?.observe(dom);
  let active = true;
  void document.fonts?.ready?.then(() => {
    if (active) onReflow();
  });
  return () => {
    active = false;
    editor.off('update', onReflow);
    window.removeEventListener('resize', onReflow);
    observer?.disconnect();
  };
}

export function resolveDocCommentAnchorRange(
  anchorJson: CommentAnchorPayload,
  headJson: CommentAnchorPayload,
  editor: Editor | null,
): { from: number; to: number } | null {
  const binding = getCommentBinding(editor);
  if (!binding || !isRecord(anchorJson) || !isRecord(headJson)) return null;
  const anchor = Y.createRelativePositionFromJSON(anchorJson);
  const head = Y.createRelativePositionFromJSON(headJson);
  const anchorPos = relativePositionToAbsolutePosition(binding.doc, binding.type, anchor, binding.mapping);
  const headPos = relativePositionToAbsolutePosition(binding.doc, binding.type, head, binding.mapping);
  if (anchorPos === null || headPos === null) return null;
  const from = Math.min(anchorPos, headPos);
  const to = Math.max(anchorPos, headPos);
  if (from === to) return null;
  return { from, to };
}
