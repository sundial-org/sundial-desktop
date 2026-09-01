import { Extension, getChangedRanges } from '@tiptap/core';
import type { Mark, Node } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { MATH_TEXT_REGEX } from './math-decorations';

/**
 * Obsidian-style inline tags (`#tag`, nested `#a/b`) and source comments
 * (`%% dimmed text %%`, incl. multi-line) as pure view-layer decorations —
 * the same pattern as math (see math-decorations.ts): the source text stays
 * verbatim in the Y.Doc, the codec and markdown round-trip never learn these
 * constructs exist, and this plugin only paints classes over the text.
 *
 * Tags render as pills over their own source text (nothing hidden). Source
 * comments render in one of three states:
 *   - EXPANDED (default): content visible as a dimmed chip; the `%%`
 *     delimiters are collapsed to zero width (math's hiding technique) with a
 *     small toggle icon marking the span. For block-form comments
 *     (`%%\n…\n%%`) the delimiter's own line break hides with it, so the chip
 *     has no empty first/last lines.
 *   - COLLAPSED: the whole comment folds into the icon. Doc-wide state — the
 *     icon toggles EVERY comment in the document at once, persisted per
 *     `storageKey` in localStorage. View preference only; never shared.
 *   - RAW: the caret is inside the comment (or the span carries suggestion
 *     marks under review) — full literal source shows, delimiters included,
 *     so editing and reviewing always see the real bytes. This also means a
 *     collapsed comment auto-expands while the caret is in it, and diffs are
 *     never hidden.
 *
 * "Source comment" (it lives in the markdown source) is deliberately distinct
 * from Sundial's selection-anchored doc-comment threads (doc-comments.ts).
 *
 * Matching is per-TEXTBLOCK over the block's flattened text, not per text
 * node: ProseMirror splits text nodes at mark boundaries, and a multi-line
 * comment spans hardBreak nodes — a per-node regex (the math approach) would
 * miss `%% see **this** %%` entirely. Flattening is offset-exact: every
 * inline node contributes exactly nodeSize characters (text verbatim,
 * hardBreak → '\n', other leaves → one placeholder char), so a match index
 * maps to a doc position by simple addition.
 *
 * ── Why the codec is untouched ─────────────────────────────────────────────
 * `%%` means NOTHING to lib/markdown/parser.mjs, and that is the design, not
 * an omission. An earlier revision of this feature taught the parser to keep a
 * comment's interior verbatim, which sounds harmless and isn't: "verbatim"
 * makes ordinary canonicalization (table normalization, whitespace trimming)
 * illegal inside a comment, so the normalizer needed a shield telling it where
 * comments are — a second implementation of the parser's own tokenizer. The
 * two drifted on every construct the copy hadn't ported (code, math, marks,
 * fences, rules, indentation, list markers), and each divergence rewrote the
 * file's bytes at LOAD time: the phantom-diff / Hocuspocus-desync class this
 * codec exists to prevent. Eleven consecutive review findings, all one bug.
 *
 * Keeping `%%` out of the codec removes that class outright. The cost is the
 * two limits below — both cosmetic, neither able to touch a byte.
 *
 * ── Deliberate scope limits ────────────────────────────────────────────────
 * 1. MARKDOWN RENDERS INSIDE A COMMENT. `%% note **bold** %%` shows *bold* in
 *    the dimmed chip rather than literal asterisks, because the codec parsed
 *    it as a real mark. Obsidian's preview mode does the same. Showing raw
 *    source instead would mean re-introducing the verbatim contract above.
 *
 * 2. A COMMENT BROKEN BY A BLOCK BOUNDARY ISN'T DECORATED. The scan is
 *    per-textblock, so a blank line, heading, list or table between the
 *    delimiters splits them across blocks and no single block holds a pair —
 *    the `%%` stay visible as ordinary text. Soft-wrapped multi-line comments
 *    (including the `%%\n…\n%%` block form) are unaffected: the parser keeps
 *    consecutive prose lines in ONE paragraph joined by hardBreaks, which this
 *    scan reads as '\n'. Fixing the rest is a VIEW-layer change — carry match
 *    state across adjacent blocks — and needs debouncing, since a freshly
 *    typed opening `%%` would otherwise dim the document down to the next
 *    stray `%%` on every keystroke. Still no codec involvement.
 *
 * 3. ESCAPES. `\#tag` / `\%% x %%` decorate anyway. The codec preserves
 *    escapes for NO inline construct (`a \* b` → `a * b`, locked by the
 *    `escaped chars` corpus row), so once canonicalized the stored bytes ARE a
 *    real tag/comment and decorating them agrees with what the next parse
 *    says. Durable escaping is a serializer-wide change, not a per-construct
 *    patch here.
 */

export type InlineToken =
  | { kind: 'comment'; from: number; to: number }
  | { kind: 'tag'; from: number; to: number; tag: string };

// A comment may span line breaks (hardBreaks flatten to '\n'); non-greedy so
// adjacent comments pair up (`%% a %% x %% b %%` → two comments). `%%%%` is a
// valid empty comment. An unclosed `%%` matches nothing — it stays ordinary
// visible text, never a comment-to-end-of-document. HTML comments
// (`<!-- … -->`) are the same construct with different delimiters — Obsidian
// hides both in reading view — and share every state and limit.
export const SOURCE_COMMENT_REGEX = /%%[\s\S]*?%%|<!--[\s\S]*?-->/g;

// Obsidian-compatible: `#` at start of text or after whitespace; Unicode
// letters/digits plus `_` and `-`; nested paths as `/`-separated non-empty
// segments (a trailing `/` stays outside the tag). Candidates whose body has
// no non-numeric character (`#5`, `#2024`) are rejected in findInlineTokens.
// No escape awareness by design — see scope limit 1 in the file header.
export const TAG_REGEX = /(?<=^|\s)#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;

type Range = readonly [number, number];

/**
 * Scan one textblock's flattened text for tags and comments. Comment and math
 * spans are resolved by a POSITIONAL scan — earliest-starting span wins, code-
 * marked ranges (`maskedRanges`) winning ties — mirroring the parser's left-
 * to-right tokenization: `$a %% b %%$` is one math span (its `%%` is math
 * content, so KaTeX still renders), while `%% a $x$ %%` is one comment (its
 * `$x$` stays dimmed literal source). Tags are then matched outside all
 * accepted spans — a `#` inside code, math, or a comment is content.
 */
export function findInlineTokens(
  text: string,
  maskedRanges: ReadonlyArray<Range> = [],
): InlineToken[] {
  const code: Range[] = [...maskedRanges].sort((a, b) => a[0] - b[0]);
  const masks: Range[] = [...code];
  const tokens: InlineToken[] = [];
  const commentRe = new RegExp(SOURCE_COMMENT_REGEX.source, 'g');
  const mathRe = new RegExp(MATH_TEXT_REGEX.source, 'g');

  let pos = 0;
  let ci = 0;
  while (pos < text.length) {
    while (ci < code.length && code[ci][1] <= pos) ci += 1;
    commentRe.lastIndex = pos;
    mathRe.lastIndex = pos;
    const cm = commentRe.exec(text);
    const mm = mathRe.exec(text);
    if (!cm && !mm) break;
    type Cand = { kind: 'code' | 'comment' | 'math'; from: number; to: number };
    const cands: Cand[] = [];
    if (ci < code.length) cands.push({ kind: 'code', from: code[ci][0], to: code[ci][1] });
    if (cm) cands.push({ kind: 'comment', from: cm.index, to: cm.index + cm[0].length });
    if (mm) cands.push({ kind: 'math', from: mm.index, to: mm.index + mm[0].length });
    // Earliest start wins; 'code' sorts first on a tie (a code-marked
    // delimiter can't open a comment or math span).
    cands.sort((a, b) => a.from - b.from || (a.kind === 'code' ? -1 : 1));
    const next = cands[0];
    if (next.kind === 'comment') {
      tokens.push({ kind: 'comment', from: next.from, to: next.to });
      masks.push([next.from, next.to]);
    } else if (next.kind === 'math') {
      masks.push([next.from, next.to]);
    }
    pos = next.to;
  }

  // Merge the masks into disjoint, ordered intervals so tag matching can walk
  // them with a single moving pointer. Testing every tag against every mask is
  // O(N²) per rescan, and rescans happen on each keystroke in the edited block
  // — a long agent-written paragraph full of tags would stall the editor.
  masks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of masks) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }

  const tagRe = new RegExp(TAG_REGEX.source, 'gu');
  let mi = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    // Obsidian rule: a tag must contain at least one non-numeric character —
    // `#5` / `#2024` are literal text (issue numbers, years), `#v2` is a tag.
    if (!/[\p{L}_-]/u.test(m[1])) continue;
    // Matches arrive left-to-right, so the pointer only ever moves forward.
    while (mi < merged.length && merged[mi][1] <= from) mi += 1;
    if (mi < merged.length && merged[mi][0] < to) continue;
    tokens.push({ kind: 'tag', from, to, tag: m[1] });
  }

  return tokens.sort((a, b) => a.from - b.from);
}

/**
 * Text whose characters are NOT literal markdown source, so a tag or comment
 * can never be matched inside it:
 *   - inline code — its bytes are content by the parser's own rule;
 *   - a WIKILINK's displayed text. The parser consumes `[[target|alias]]` in
 *     one step and stores only the alias (or target) as text, with `[[`, the
 *     target and the `|` living in mark attrs (parser.mjs → wikilink → a
 *     `link` mark with obsidianType 'wiki'). So `[[page|#tag]]` reaches this
 *     layer as the bare text `#tag` and `[[page|%% draft %%]]` as
 *     `%% draft %%` — decorating those invents a construct the source never
 *     had, and in the comment case would hide the link's own label (folding it
 *     away entirely). Masking mirrors the parser: the tokens don't exist
 *     outside the wikilink syntax, so they don't exist here either.
 */
function isMaskedMark(mark: Mark): boolean {
  return (
    mark.type.name === 'code' ||
    (mark.type.name === 'link' && mark.attrs.obsidianType === 'wiki')
  );
}

/**
 * Flattened block text plus the masked ranges (above) and the ranges carrying
 * suggestion marks — the latter force a comment to RAW so review diffs never
 * hide source bytes. Suggestion state is read from BOTH text/leaf marks and
 * node attrs, since a whole-node or hardBreak suggestion carries no mark.
 *
 * Formatting marks inside a matched comment are intentionally left alone here
 * (they normalize away on the next reparse — scope limit 2 in the header):
 * this function only reports, it must never mutate the doc.
 */
export function flattenTextblock(node: Node): {
  text: string;
  maskedRanges: Range[];
  reviewRanges: Range[];
} {
  let text = '';
  const maskedRanges: Range[] = [];
  const reviewRanges: Range[] = [];
  node.forEach((child) => {
    if (child.isText && child.text != null) {
      if (child.marks.some(isMaskedMark)) {
        maskedRanges.push([text.length, text.length + child.text.length]);
      }
      if (
        child.marks.some(
          (mark) =>
            mark.type.name === 'insertion' ||
            mark.type.name === 'deletion' ||
            mark.type.name === 'modification',
        )
      ) {
        reviewRanges.push([text.length, text.length + child.text.length]);
      }
      text += child.text;
    } else {
      // Leaf inline nodes occupy exactly one position; '\n' for hardBreak
      // keeps multi-line comments matchable AND counts as the whitespace a
      // tag boundary needs. '￼' for anything else pads the offset. A leaf
      // carrying a suggestion — structural attrs (a suggested hardBreak) or
      // marks — is review state too: collapsing must never hide its diff.
      const attrs = child.attrs as Record<string, unknown> | undefined;
      if (
        child.marks.some(
          (mark) =>
            mark.type.name === 'insertion' ||
            mark.type.name === 'deletion' ||
            mark.type.name === 'modification',
        ) ||
        (attrs &&
          (attrs.suggestionInsertionId != null ||
            attrs.suggestionDeletionId != null ||
            (Array.isArray(attrs.suggestionModifications) &&
              attrs.suggestionModifications.length > 0)))
      ) {
        reviewRanges.push([text.length, text.length + 1]);
      }
      text += child.type.name === 'hardBreak' ? '\n' : '￼';
    }
  });
  return { text, maskedRanges, reviewRanges };
}

/**
 * True when [from, to] does not overlap a `%%…%%` source comment — the
 * Mathematics extension's `shouldRenderMatch` veto, so `%% see $x$ %%` keeps
 * its `$x$` as dimmed literal source instead of a KaTeX widget.
 */
export function outsideSourceComment(state: EditorState, from: number, to: number): boolean {
  const $from = state.doc.resolve(from);
  const block = $from.parent;
  if (!block.isTextblock) return true;
  const blockStart = $from.start();
  const { text, maskedRanges } = flattenTextblock(block);
  for (const token of findInlineTokens(text, maskedRanges)) {
    if (token.kind !== 'comment') continue;
    if (from < blockStart + token.to && to > blockStart + token.from) return false;
  }
  return true;
}

/**
 * The `%%` delimiter ranges (block-relative) to hide in EXPANDED state. When a
 * delimiter sits ALONE on its line (the block form `%%\n…\n%%`), the adjacent
 * line break hides with it so the chip shows no empty first/last line; a
 * mid-line delimiter keeps its neighbouring breaks — hiding those would
 * visually re-flow the surrounding prose.
 */
export function commentHideRanges(token: { from: number; to: number }, text: string): Range[] {
  // Delimiter widths come from the matched form: `%%…%%` is 2/2, HTML
  // comments are `<!--` (4) / `-->` (3).
  const isHtml = text.startsWith('<!--', token.from);
  const openEnd = token.from + (isHtml ? 4 : 2);
  const closeStart = token.to - (isHtml ? 3 : 2);
  const openAlone = token.from === 0 || text[token.from - 1] === '\n';
  const closeAlone = token.to === text.length || text[token.to] === '\n';
  const open: Range = [
    token.from,
    openAlone && text[openEnd] === '\n' && openEnd < closeStart ? openEnd + 1 : openEnd,
  ];
  const close: Range = [
    closeAlone && text[closeStart - 1] === '\n' && closeStart - 1 >= open[1] ? closeStart - 1 : closeStart,
    token.to,
  ];
  return [open, close];
}

// Math's proven zero-footprint hiding: keeps the text in the DOM (caret can
// still enter, which flips the comment to RAW) without occupying layout.
const HIDDEN_STYLE =
  'display: inline-block; height: 0; opacity: 0; overflow: hidden; position: absolute; width: 0;';

// Hide [from, to] (block-relative) completely. The zero-size trick silences
// text but NOT hardBreaks — a styled <br> still breaks the line, so a folded
// multi-line comment would keep its full height in blank lines. Breaks need
// `display: none` instead, and the ranges must not overlap: prosemirror-view
// merges the style of stacked decorations in an order we don't control, so a
// zero-size range covering a display:none'd <br> can re-flip its display.
// Text segments and breaks therefore get disjoint decorations.
function hideDecos(pos: number, text: string, from: number, to: number, cls: string): Decoration[] {
  const out: Decoration[] = [];
  let segStart = from;
  for (let i = from; i < to; i += 1) {
    if (text[i] !== '\n') continue;
    if (i > segStart) {
      out.push(Decoration.inline(pos + 1 + segStart, pos + 1 + i, { class: cls, style: HIDDEN_STYLE }));
    }
    out.push(Decoration.inline(pos + 1 + i, pos + 2 + i, { class: cls, style: 'display: none;' }));
    segStart = i + 1;
  }
  if (to > segStart) {
    out.push(Decoration.inline(pos + 1 + segStart, pos + 1 + to, { class: cls, style: HIDDEN_STYLE }));
  }
  return out;
}

type SelectionLike = { from: number; to: number };

function makeToggleIcon(collapsed: boolean) {
  return () => {
    const el = document.createElement('span');
    el.className = `sd-source-comment-icon${collapsed ? ' sd-source-comment-icon--collapsed' : ''}`;
    el.title = collapsed ? 'Show comments' : 'Hide comments';
    return el;
  };
}

function blockDecorations(
  node: Node,
  pos: number,
  selection: SelectionLike | null,
  collapsed: boolean,
): Decoration[] {
  const { text, maskedRanges, reviewRanges } = flattenTextblock(node);
  // A STRUCTURAL suggestion (whole-node insert/delete/modify rides on node
  // attrs, not text marks) also puts the block under review: its comments
  // must show raw source like mark-level suggestions do.
  const attrs = node.attrs as Record<string, unknown> | undefined;
  if (
    attrs &&
    (attrs.suggestionInsertionId != null ||
      attrs.suggestionDeletionId != null ||
      (Array.isArray(attrs.suggestionModifications) && attrs.suggestionModifications.length > 0))
  ) {
    reviewRanges.push([0, text.length]);
  }
  const decos: Decoration[] = [];
  for (const token of findInlineTokens(text, maskedRanges)) {
    if (token.kind === 'tag') {
      decos.push(
        Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, {
          class: 'sd-tag',
          'data-tag': token.tag,
        }),
      );
      continue;
    }
    const absFrom = pos + 1 + token.from;
    const absTo = pos + 1 + token.to;
    // Suggestion-marked comments always show raw source: an inline review
    // diff must never hide the bytes being accepted or rejected.
    const review = reviewRanges.some(([a, b]) => token.from < b && token.to > a);
    const editing = !!selection && selection.from >= absFrom && selection.to <= absTo;
    if (review || editing) {
      decos.push(
        Decoration.inline(absFrom, absTo, { class: 'sd-source-comment sd-source-comment--raw' }),
      );
      for (const [hf, ht] of commentHideRanges(token, text)) {
        decos.push(Decoration.inline(pos + 1 + hf, pos + 1 + ht, { class: 'sd-source-comment-delim' }));
      }
    } else if (collapsed) {
      decos.push(
        ...hideDecos(pos, text, token.from, token.to, 'sd-source-comment sd-source-comment--collapsed'),
      );
      decos.push(
        Decoration.widget(absFrom, makeToggleIcon(true), { key: `sd-comment:${absFrom}:c` }),
      );
    } else {
      decos.push(Decoration.inline(absFrom, absTo, { class: 'sd-source-comment' }));
      for (const [hf, ht] of commentHideRanges(token, text)) {
        decos.push(...hideDecos(pos, text, hf, ht, 'sd-source-comment-delim'));
      }
      decos.push(
        Decoration.widget(absFrom, makeToggleIcon(false), { key: `sd-comment:${absFrom}:e` }),
      );
    }
  }
  return decos;
}

function scanBlocksBetween(
  doc: Node,
  from: number,
  to: number,
  selection: SelectionLike | null,
  collapsed: boolean,
) {
  const decorations: Decoration[] = [];
  let scanFrom = from;
  let scanTo = to;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    // Extend the removal window to whole blocks even for code blocks (a
    // paragraph turned codeBlock must drop its stale decorations).
    scanFrom = Math.min(scanFrom, pos);
    scanTo = Math.max(scanTo, pos + node.nodeSize);
    if (node.type.name !== 'codeBlock') {
      decorations.push(...blockDecorations(node, pos, selection, collapsed));
    }
    return false;
  });
  return { decorations, scanFrom, scanTo };
}

type TagCommentState = {
  decorations: DecorationSet;
  collapsed: boolean;
  editable: boolean;
  focused: boolean;
};
export type TagCommentPluginOptions = {
  // localStorage key persisting the doc-wide collapsed state (view preference
  // only — never written to the Y.Doc). null → in-memory for this editor.
  storageKey?: string | null;
  // Whether the editor accepts input. A read-only view still HAS a selection
  // (at doc start, or wherever a reader drags), and letting it drive the RAW
  // state would expose `%%` delimiters — and un-fold a collapsed comment —
  // with no editing possible. Defaults to editable when unset (bare plugin
  // use in tests). Mirrors the Mathematics extension's isEditable guard.
  isEditable?: () => boolean;
};

export const tagCommentPluginKey = new PluginKey<TagCommentState>('tagCommentDecorations');

function readCollapsed(storageKey: string | null): boolean {
  if (!storageKey) return false;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(storageKey) === 'collapsed';
  } catch {
    return false;
  }
}

function writeCollapsed(storageKey: string | null, collapsed: boolean) {
  if (!storageKey) return;
  try {
    if (typeof localStorage === 'undefined') return;
    if (collapsed) localStorage.setItem(storageKey, 'collapsed');
    else localStorage.removeItem(storageKey);
  } catch {
    // Storage unavailable (private mode, quota) — state stays in-memory.
  }
}

// Bounds of the textblocks containing [from, to] — the rescan window for a
// selection move (the comment the caret left AND the one it entered).
function blockBounds(doc: Node, from: number, to: number): Range {
  const clamp = (p: number) => Math.max(0, Math.min(p, doc.content.size));
  const $from = doc.resolve(clamp(from));
  const $to = doc.resolve(clamp(to));
  return [
    $from.depth === 0 ? 0 : $from.before(),
    $to.depth === 0 ? doc.content.size : $to.after(),
  ];
}

export const tagCommentPlugin = ({
  storageKey = null,
  isEditable,
}: TagCommentPluginOptions = {}) =>
  new Plugin<TagCommentState>({
    key: tagCommentPluginKey,
    state: {
      init: (_config, state) => {
        const collapsed = readCollapsed(storageKey);
        const editable = isEditable ? isEditable() : true;
        // Not focused until the view says so: an unfocused view still carries a
        // selection (position 1 on load), and letting that reveal raw source
        // would strip the `%%` off a leading comment before anyone clicks.
        return {
          collapsed,
          editable,
          focused: false,
          decorations: DecorationSet.create(
            state.doc,
            scanBlocksBetween(state.doc, 0, state.doc.content.size, null, collapsed).decorations,
          ),
        };
      },
      apply(tr, previous, oldState, newState) {
        const editable = isEditable ? isEditable() : true;
        const meta = tr.getMeta(tagCommentPluginKey) as
          | { collapsed?: boolean; focused?: boolean }
          | undefined;
        const focused = typeof meta?.focused === 'boolean' ? meta.focused : previous.focused;
        // The caret only reveals raw source in an editor that is BOTH editable
        // and focused. A blurred view keeps its selection, so without the focus
        // gate a comment stays open after the user clicks away into chat, and a
        // collapsed one silently unfolds against the persisted state.
        const revealing = editable && focused;
        const selection = revealing ? newState.selection : null;
        // The toggle: one icon click folds/unfolds EVERY comment in the doc.
        const requested = typeof meta?.collapsed === 'boolean' ? meta.collapsed : undefined;
        const collapsed = requested ?? previous.collapsed;
        const collapseChanged = requested !== undefined && requested !== previous.collapsed;
        // A full rebuild is also needed when editability or focus flips: both
        // change whether the selection may reveal raw source at all. Neither
        // dispatches on its own, so the plugin view below nudges a transaction.
        if (collapseChanged || editable !== previous.editable || focused !== previous.focused) {
          if (collapseChanged) writeCollapsed(storageKey, collapsed);
          return {
            collapsed,
            editable,
            focused,
            decorations: DecorationSet.create(
              tr.doc,
              scanBlocksBetween(tr.doc, 0, tr.doc.content.size, selection, collapsed).decorations,
            ),
          };
        }
        // Doc changes rescan the changed blocks; selection moves rescan the
        // blocks the caret left/entered (comments reveal raw under the caret) —
        // and are irrelevant when nothing can reveal.
        if (!tr.docChanged && (!tr.selectionSet || !revealing)) return previous;
        const mapped = previous.decorations.map(tr.mapping, tr.doc);
        const docSize = tr.doc.content.size;
        let minFrom = docSize;
        let maxTo = 0;
        if (tr.docChanged) {
          getChangedRanges(tr).forEach((range) => {
            minFrom = Math.min(minFrom, range.newRange.from - 1, range.oldRange.from - 1);
            maxTo = Math.max(maxTo, range.newRange.to + 1, range.oldRange.to + 1);
          });
        }
        if (tr.selectionSet) {
          const [oldFrom, oldTo] = blockBounds(
            tr.doc,
            tr.mapping.map(oldState.selection.from),
            tr.mapping.map(oldState.selection.to),
          );
          const [newFrom, newTo] = blockBounds(tr.doc, newState.selection.from, newState.selection.to);
          minFrom = Math.min(minFrom, oldFrom, newFrom);
          maxTo = Math.max(maxTo, oldTo, newTo);
        }
        // Pull in the full extent of any decoration straddling the window, so
        // breaking a `%%` at the END of a comment rescans the block holding
        // its start (same trick as math-decorations).
        mapped.find(Math.max(minFrom, 0), Math.min(maxTo, docSize)).forEach((deco) => {
          minFrom = Math.min(minFrom, deco.from);
          maxTo = Math.max(maxTo, deco.to);
        });
        minFrom = Math.max(minFrom, 0);
        maxTo = Math.min(maxTo, docSize);
        if (minFrom > maxTo) return { ...previous, decorations: mapped };
        const { decorations, scanFrom, scanTo } = scanBlocksBetween(
          tr.doc,
          minFrom,
          maxTo,
          selection,
          previous.collapsed,
        );
        return {
          collapsed: previous.collapsed,
          editable,
          focused,
          decorations: mapped.remove(mapped.find(scanFrom, scanTo)).add(tr.doc, decorations),
        };
      },
    },
    // setEditable() reconfigures the view without dispatching a transaction, so
    // apply() would never see the flip and a read-only view could keep showing
    // raw source under its selection. Nudge an empty transaction on the change;
    // apply() then rebuilds via the editable guard. (Same fix the Mathematics
    // extension needs, for the same reason.)
    view() {
      let lastEditable: boolean | undefined;
      return {
        update: (view) => {
          if (lastEditable === undefined) lastEditable = view.editable;
          if (view.editable !== lastEditable) {
            lastEditable = view.editable;
            view.dispatch(view.state.tr);
          }
          // Safety net for a view created already focused (autofocus), where no
          // focus EVENT ever fires after the plugin initialized.
          const state = tagCommentPluginKey.getState(view.state);
          if (state && view.hasFocus() !== state.focused) {
            view.dispatch(view.state.tr.setMeta(tagCommentPluginKey, { focused: view.hasFocus() }));
          }
        },
      };
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? DecorationSet.empty;
      },
      handleDOMEvents: {
        // Focus drives whether the caret may reveal raw source, so both edges
        // must recompute. Returning false leaves the event to everyone else.
        focus(view: EditorView) {
          view.dispatch(view.state.tr.setMeta(tagCommentPluginKey, { focused: true }));
          return false;
        },
        blur(view: EditorView) {
          view.dispatch(view.state.tr.setMeta(tagCommentPluginKey, { focused: false }));
          return false;
        },
        mousedown(view: EditorView, event: MouseEvent) {
          const target = event.target as HTMLElement | null;
          if (!target?.closest?.('.sd-source-comment-icon')) return false;
          event.preventDefault();
          const current = tagCommentPluginKey.getState(view.state);
          view.dispatch(
            view.state.tr.setMeta(tagCommentPluginKey, { collapsed: !current?.collapsed }),
          );
          return true;
        },
      },
    },
  });

export const TagCommentDecorations = Extension.create<TagCommentPluginOptions>({
  name: 'tagCommentDecorations',
  addOptions() {
    return { storageKey: null };
  },
  addProseMirrorPlugins() {
    return [tagCommentPlugin({ ...this.options, isEditable: () => this.editor.isEditable })];
  },
});

export default TagCommentDecorations;
