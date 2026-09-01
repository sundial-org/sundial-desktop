import { Extension } from '@tiptap/core';
import { DOMSerializer, type Node } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { MATH_TEXT_REGEX } from './math-decorations';
import { SOURCE_COMMENT_REGEX, flattenTextblock } from './tag-comment-decorations';
import { changedBlockSpan } from './incremental-decorations';

/**
 * Obsidian/GitHub-style markdown footnotes as pure view-layer decorations —
 * the same pattern as math (math-decorations.ts) and tags/comments
 * (tag-comment-decorations.ts): `[^label]` references, `[^label]: …`
 * definitions and inline `^[text]` footnotes stay verbatim in the Y.Doc, the
 * codec and markdown round-trip never learn these constructs exist, and this
 * plugin only paints over the text. (The parser knows just enough to keep the
 * bracket LITERAL — see the footnote rules in lib/markdown/parser.mjs — which
 * is byte-neutral; it only decides the doc's mark structure.)
 *
 * Display model (all Obsidian live-preview parity):
 *   - A reference renders as a superscript number chip; the raw `[^label]`
 *     reveals while the caret is inside (math's cursor-reveal) or while the
 *     span carries suggestion marks — review diffs never hide source bytes.
 *   - Numbers are ORDER-OF-APPEARANCE, not the literal label: the first
 *     resolvable reference (or inline footnote) in doc order is 1, the next
 *     new one 2, … All references sharing a label share one number; the raw
 *     label stays visible at the caret and identifies the chip via data attrs.
 *   - A definition stays WHERE IT IS in the doc (markdown position = visual
 *     position), styled as a footnote block; its `[^label]:` marker renders as
 *     the assigned number with a ↩ back-reference widget at the end. A
 *     definition is only recognized as PLAIN SOURCE at the START of a
 *     TOP-LEVEL paragraph (GFM) — `**[^1]:** prose` is prose, even though the
 *     codec parsed the `**` away; an indented top-level paragraph following
 *     one is its continuation (multi-line definitions).
 *   - Inline `^[text]` footnotes fold into a numbered chip like references;
 *     their popover content is the text itself. Content may carry inline
 *     marks — matching is per-textblock over flattened text (the
 *     tag-comment technique), so `^[see **this**]` still folds even though
 *     the parser split it across text nodes.
 *   - Hovering a chip shows the (formatted) definition in a popover; clicking
 *     a reference chip jumps to its definition, clicking ↩ jumps back to the
 *     reference (cycling when a label has several).
 *
 * Degenerate cases: an ORPHAN reference (no definition) stays raw, muted — an
 * honest "unresolved" signal, and it consumes no number. DUPLICATE definitions
 * for one label: the first wins (GFM), later ones render raw with a warning
 * tint. An UNREFERENCED definition keeps its raw marker, muted, unnumbered.
 * Labels match case-INSENSITIVELY (GFM), so `[^Note]` resolves `[^note]: …`
 * and two case-variant definitions are duplicates — see labelKey.
 *
 * Interplay, mirroring the parser's left-to-right tokenization: a footnote
 * inside inline code, `$…$` math or a `%%…%%` comment is content, not a
 * footnote (positional scan, earliest span wins). Math inside a footnote's
 * OWN span (a `$` in a label, `^[$x$]`) must not paint a KaTeX widget over the
 * folded text — `outsideFootnote` is the Mathematics `shouldRenderMatch` veto
 * for that, composed with `outsideSourceComment` in collab-editor. An inline
 * footnote whose content would contain `%%` is NOT matched at all, so the
 * comment keeps rendering as a comment instead of two plugins fighting over
 * one span. Literal square brackets inside `^[…]` are unsupported (same
 * ambiguity Obsidian has); a link inside works — its brackets are consumed
 * into the mark during parsing.
 *
 * Numbering is GLOBAL (a new first reference renumbers every later chip), so
 * unlike math/tags this plugin re-indexes the whole doc on every docChanged
 * instead of windowing. That's one flatten+regex pass over the doc's text —
 * the same cost class as the checkbox decorations' full-doc walk — and
 * selection-only transactions reuse the cached index.
 */

type Range = readonly [number, number];

// Label: GFM footnote labels — no whitespace, no brackets, no `%` (a `%%`
// pair inside a label would fight the source-comment plugin over the same
// span; the parser's literal-bracket guard uses the same charset). '￼' is the
// flattened-leaf placeholder, never literal source.
export const FOOTNOTE_REF_REGEX = /\[\^([^\[\]\s%￼]+)\]/g;
// Inline footnote content: single line, no literal brackets, and no `%%` pair
// (which would collide with the source-comment plugin — see file header).
export const INLINE_FOOTNOTE_REGEX = /\^\[((?:(?!%%)[^\[\]\n￼])+)\]/g;
// Definition marker, only ever tested at offset 0 of a top-level paragraph.
const DEF_MARKER_REGEX = /^\[\^([^\[\]\s%￼]+)\]:/;
// A top-level paragraph starting indented continues the preceding definition
// (2+ spaces: GFM says 4, Obsidian accepts less; leading spaces survive the
// codec verbatim, so the indent is really there in the flattened text).
const CONTINUATION_REGEX = /^(?: {2,}|\t)/;

export type FootnoteToken =
  | { kind: 'def'; from: number; to: number; label: string }
  | { kind: 'ref'; from: number; to: number; label: string }
  | { kind: 'inline'; from: number; to: number; contentFrom: number; contentTo: number };

/**
 * Scan one textblock's flattened text for footnote tokens. Positional scan,
 * earliest-starting span wins (code-marked ranges winning ties), mirroring
 * findInlineTokens in tag-comment-decorations: `$a[^1]b$` is math (its ref is
 * math content), `%% [^1] %%` is a comment, `` `[^1]` `` is code. `^[^1]`
 * resolves as an INLINE footnote whose content is `^1` (it starts first).
 * `defAllowed` is true only for top-level paragraphs; the definition marker is
 * matched at offset 0 before anything else.
 */
export function findFootnoteTokens(
  text: string,
  maskedRanges: ReadonlyArray<Range> = [],
  defAllowed = false,
  formattedRanges: ReadonlyArray<Range> = [],
): FootnoteToken[] {
  const code: Range[] = [...maskedRanges].sort((a, b) => a[0] - b[0]);
  const tokens: FootnoteToken[] = [];
  let pos = 0;
  if (defAllowed) {
    const dm = text.match(DEF_MARKER_REGEX);
    // A definition marker must be PLAIN SOURCE at the very start of the line.
    // This scan runs on flattened text, where the codec has already consumed
    // emphasis delimiters — so `**[^1]:** prose` arrives as `[^1]: prose` and
    // would otherwise register as a definition that real refs resolve to (and
    // that the view would fold). Any formatting mark over the marker proves
    // the raw line began with a delimiter, not `[^`. Only the DEFINITION is
    // position-sensitive this way: a bolded `**[^1]**` reference or an
    // emphasized inline footnote is genuinely present in the raw source.
    const markerTo = dm ? dm[0].length : 0;
    const blocked =
      (code.length > 0 && code[0][0] < markerTo) ||
      formattedRanges.some(([a, b]) => a < markerTo && b > 0);
    if (dm && !blocked) {
      tokens.push({ kind: 'def', from: 0, to: markerTo, label: dm[1] });
      pos = markerTo;
    }
  }
  const commentRe = new RegExp(SOURCE_COMMENT_REGEX.source, 'g');
  const mathRe = new RegExp(MATH_TEXT_REGEX.source, 'g');
  const refRe = new RegExp(FOOTNOTE_REF_REGEX.source, 'g');
  const inlineRe = new RegExp(INLINE_FOOTNOTE_REGEX.source, 'g');
  let ci = 0;
  while (pos < text.length) {
    while (ci < code.length && code[ci][1] <= pos) ci += 1;
    commentRe.lastIndex = pos;
    mathRe.lastIndex = pos;
    refRe.lastIndex = pos;
    inlineRe.lastIndex = pos;
    const cm = commentRe.exec(text);
    const mm = mathRe.exec(text);
    const rm = refRe.exec(text);
    const im = inlineRe.exec(text);
    if (!cm && !mm && !rm && !im) break;
    type Cand = { kind: 'code' | 'mask' | 'ref' | 'inline'; from: number; to: number; m?: RegExpExecArray };
    const cands: Cand[] = [];
    if (ci < code.length) cands.push({ kind: 'code', from: code[ci][0], to: code[ci][1] });
    if (cm) cands.push({ kind: 'mask', from: cm.index, to: cm.index + cm[0].length });
    if (mm) cands.push({ kind: 'mask', from: mm.index, to: mm.index + mm[0].length });
    if (rm) cands.push({ kind: 'ref', from: rm.index, to: rm.index + rm[0].length, m: rm });
    if (im) cands.push({ kind: 'inline', from: im.index, to: im.index + im[0].length, m: im });
    // Earliest start wins; 'code' sorts first on a tie. A ref and an inline
    // can't share a start (different first character).
    cands.sort((a, b) => a.from - b.from || (a.kind === 'code' ? -1 : 1));
    const next = cands[0];
    if (next.kind === 'ref') {
      tokens.push({ kind: 'ref', from: next.from, to: next.to, label: next.m![1] });
    } else if (next.kind === 'inline') {
      tokens.push({
        kind: 'inline',
        from: next.from,
        to: next.to,
        contentFrom: next.from + 2,
        contentTo: next.to - 1,
      });
    }
    pos = next.to;
  }
  return tokens;
}

export type FootnoteRefEntry = {
  kind: 'ref';
  label: string;
  from: number;
  to: number;
  // Order-of-appearance display number; null = orphan (no definition).
  number: number | null;
};
export type InlineFootnoteEntry = {
  kind: 'inline';
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  number: number;
};
export type FootnoteDefEntry = {
  label: string;
  from: number; // marker `[^label]:` range (absolute)
  to: number;
  contentFrom: number; // after marker + one optional space
  // The definition paragraph plus its indented continuation paragraphs.
  blocks: Array<Range>; // node ranges, for block styling
  contentRanges: Array<Range>; // inline ranges, for the popover
  number: number | null; // null = unreferenced
  duplicate: boolean; // a later definition of an already-defined label
  refFroms: number[]; // every reference position, doc order (for ↩)
};
export type FootnoteIndex = {
  refs: FootnoteRefEntry[];
  inlines: InlineFootnoteEntry[];
  defs: FootnoteDefEntry[];
  // Keyed by labelKey(label), NOT the raw label — first definition wins.
  defByLabel: Map<string, FootnoteDefEntry>;
  reviewRanges: Range[]; // spans under suggestion review — always raw
};

/**
 * Identity key for a footnote label. GFM matches footnote identifiers
 * case-insensitively (they share the reference-map machinery CommonMark link
 * reference definitions use), so `[^Note]` resolves `[^note]: …` and two defs
 * differing only in case are duplicates. The ORIGINAL label is preserved on
 * every entry for display and for the raw source at the caret — only lookup
 * and duplicate detection normalize.
 */
export const labelKey = (label: string) => label.toLowerCase();

// Marks the diff engine applies, which carry NO source delimiters — a
// definition inside a pending insertion is still a real definition.
const SUGGESTION_MARK_NAMES = new Set(['insertion', 'deletion', 'modification']);

/**
 * Ranges of a textblock's flattened text carrying a FORMATTING mark, i.e. text
 * whose raw source had delimiters in front of it. Offsets match
 * `flattenTextblock` exactly (text verbatim, every other inline leaf one
 * char). Used only to veto a definition marker that isn't plain source — see
 * findFootnoteTokens.
 */
function formattedRanges(node: Node): Range[] {
  const out: Range[] = [];
  let offset = 0;
  node.forEach((child) => {
    const len = child.isText && child.text != null ? child.text.length : 1;
    if (child.marks.some((mark) => !SUGGESTION_MARK_NAMES.has(mark.type.name))) {
      out.push([offset, offset + len]);
    }
    offset += len;
  });
  return out;
}

function hasStructuralSuggestion(node: Node): boolean {
  const attrs = node.attrs as Record<string, unknown> | undefined;
  return Boolean(
    attrs &&
      (attrs.suggestionInsertionId != null ||
        attrs.suggestionDeletionId != null ||
        (Array.isArray(attrs.suggestionModifications) && attrs.suggestionModifications.length > 0)),
  );
}

/** Full-doc footnote index: every token, absolute positions, global numbering. */
export function buildFootnoteIndex(doc: Node): FootnoteIndex {
  const refs: FootnoteRefEntry[] = [];
  const inlines: InlineFootnoteEntry[] = [];
  const defs: FootnoteDefEntry[] = [];
  const reviewRanges: Range[] = [];
  // The definition a following indented top-level paragraph would continue.
  let openDef: FootnoteDefEntry | null = null;
  doc.descendants((node, pos, parent) => {
    const topLevel = parent === doc;
    if (!node.isTextblock) {
      // A top-level list/quote/table breaks a definition's continuation chain.
      if (topLevel) openDef = null;
      return true;
    }
    if (node.type.name === 'codeBlock') {
      if (topLevel) openDef = null;
      return false;
    }
    const { text, maskedRanges, reviewRanges: blockReview } = flattenTextblock(node);
    for (const [a, b] of blockReview) reviewRanges.push([pos + 1 + a, pos + 1 + b]);
    if (hasStructuralSuggestion(node)) reviewRanges.push([pos, pos + node.nodeSize]);
    const defAllowed = topLevel && node.type.name === 'paragraph';
    const tokens = findFootnoteTokens(
      text,
      maskedRanges,
      defAllowed,
      defAllowed ? formattedRanges(node) : [],
    );
    let blockDef: FootnoteDefEntry | null = null;
    for (const t of tokens) {
      if (t.kind === 'ref') {
        refs.push({ kind: 'ref', label: t.label, from: pos + 1 + t.from, to: pos + 1 + t.to, number: null });
      } else if (t.kind === 'inline') {
        inlines.push({
          kind: 'inline',
          from: pos + 1 + t.from,
          to: pos + 1 + t.to,
          contentFrom: pos + 1 + t.contentFrom,
          contentTo: pos + 1 + t.contentTo,
          number: 0,
        });
      } else {
        const contentFrom = pos + 1 + t.to + (text[t.to] === ' ' ? 1 : 0);
        blockDef = {
          label: t.label,
          from: pos + 1 + t.from,
          to: pos + 1 + t.to,
          contentFrom,
          blocks: [[pos, pos + node.nodeSize]],
          contentRanges: [[contentFrom, pos + 1 + text.length]],
          number: null,
          duplicate: false,
          refFroms: [],
        };
        defs.push(blockDef);
      }
    }
    if (topLevel) {
      if (blockDef) {
        openDef = blockDef;
      } else if (openDef && node.type.name === 'paragraph' && CONTINUATION_REGEX.test(text)) {
        const indent = text.match(CONTINUATION_REGEX)![0].length;
        openDef.blocks.push([pos, pos + node.nodeSize]);
        openDef.contentRanges.push([pos + 1 + indent, pos + 1 + text.length]);
      } else if (text.length > 0 || node.type.name !== 'paragraph') {
        // A non-empty, non-indented block ends the chain. Empty paragraphs
        // (legacy blank-line markers) sit between a definition and its
        // continuation, so they keep it open.
        openDef = null;
      }
    }
    return false;
  });
  const defByLabel = new Map<string, FootnoteDefEntry>();
  for (const d of defs) {
    if (defByLabel.has(labelKey(d.label))) d.duplicate = true;
    else defByLabel.set(labelKey(d.label), d);
  }
  // Order-of-appearance numbering over references and inline footnotes
  // together; orphans consume no number.
  const entries: Array<FootnoteRefEntry | InlineFootnoteEntry> = [...refs, ...inlines].sort(
    (a, b) => a.from - b.from,
  );
  const numberOf = new Map<string, number>();
  let n = 0;
  for (const e of entries) {
    if (e.kind === 'inline') {
      e.number = ++n;
      continue;
    }
    const def = defByLabel.get(labelKey(e.label));
    if (!def) continue; // orphan — number stays null
    if (!numberOf.has(labelKey(e.label))) numberOf.set(labelKey(e.label), ++n);
    e.number = numberOf.get(labelKey(e.label))!;
    def.refFroms.push(e.from);
  }
  for (const d of defs) {
    if (!d.duplicate) d.number = numberOf.get(labelKey(d.label)) ?? null;
  }
  return { refs, inlines, defs, defByLabel, reviewRanges };
}

/**
 * True when [from, to] does not overlap a footnote token's own span (a
 * reference, an inline footnote, or a definition MARKER — definition CONTENT
 * is ordinary visible text where math should render). The Mathematics
 * `shouldRenderMatch` veto: without it a `$…$` inside a folded span (`^[$x$]`,
 * a `$` in a label) would paint a KaTeX widget over hidden text.
 */
export function outsideFootnote(state: EditorState, from: number, to: number): boolean {
  const $from = state.doc.resolve(from);
  const block = $from.parent;
  if (!block.isTextblock) return true;
  const blockStart = $from.start();
  const defAllowed = block.type.name === 'paragraph' && $from.depth === 1;
  const { text, maskedRanges } = flattenTextblock(block);
  const tokens = findFootnoteTokens(
    text,
    maskedRanges,
    defAllowed,
    defAllowed ? formattedRanges(block) : [],
  );
  for (const token of tokens) {
    if (from < blockStart + token.to && to > blockStart + token.from) return false;
  }
  return true;
}

// Math's proven zero-footprint hiding (all footnote spans are single-line —
// no hardBreak can sit inside one — so the plain inline form suffices).
const HIDDEN_STYLE =
  'display: inline-block; height: 0; opacity: 0; overflow: hidden; position: absolute; width: 0;';

function chipDOM(kind: 'ref' | 'inline', number: number, label?: string, from?: number) {
  return () => {
    const el = document.createElement('sup');
    el.className = 'sd-fn-chip';
    el.textContent = String(number);
    el.dataset.fnKind = kind;
    if (label != null) el.dataset.fnLabel = label;
    if (from != null) el.dataset.fnFrom = String(from);
    return el;
  };
}

function defChipDOM(def: FootnoteDefEntry) {
  return () => {
    const el = document.createElement('span');
    el.className = 'sd-fn-chip sd-fn-chip--def';
    el.textContent = `${def.number}.`;
    el.dataset.fnKind = 'def';
    el.dataset.fnLabel = def.label;
    return el;
  };
}

function backrefDOM(label: string) {
  return () => {
    const el = document.createElement('span');
    el.className = 'sd-fn-backref';
    el.textContent = '↩';
    el.title = 'Back to reference';
    el.dataset.fnLabel = label;
    return el;
  };
}

function buildDecorations(doc: Node, index: FootnoteIndex, selection: { from: number; to: number } | null): DecorationSet {
  const decos: Decoration[] = [];
  const underReview = (from: number, to: number) =>
    index.reviewRanges.some(([a, b]) => from < b && to > a);
  const revealed = (from: number, to: number) =>
    (!!selection && selection.from >= from && selection.to <= to) || underReview(from, to);
  const fold = (from: number, to: number, widget: () => HTMLElement, key: string) => {
    decos.push(Decoration.inline(from, to, { class: 'sd-fn-src', style: HIDDEN_STYLE }));
    decos.push(Decoration.widget(from, widget, { key }));
  };
  for (const ref of index.refs) {
    if (ref.number == null) {
      decos.push(Decoration.inline(ref.from, ref.to, { class: 'sd-fn sd-fn--orphan' }));
    } else if (revealed(ref.from, ref.to)) {
      decos.push(Decoration.inline(ref.from, ref.to, { class: 'sd-fn sd-fn--raw' }));
    } else {
      fold(ref.from, ref.to, chipDOM('ref', ref.number, ref.label), `sd-fn-ref:${ref.label}:${ref.number}:${ref.from}`);
    }
  }
  for (const item of index.inlines) {
    if (revealed(item.from, item.to)) {
      decos.push(Decoration.inline(item.from, item.to, { class: 'sd-fn sd-fn--raw' }));
    } else {
      fold(item.from, item.to, chipDOM('inline', item.number, undefined, item.from), `sd-fn-inline:${item.number}:${item.from}`);
    }
  }
  for (const def of index.defs) {
    const blockClass = `sd-fn-def${def.duplicate ? ' sd-fn-def--dup' : ''}`;
    for (const [bf, bt] of def.blocks) decos.push(Decoration.node(bf, bt, { class: blockClass }));
    if (def.duplicate) {
      decos.push(Decoration.inline(def.from, def.to, { class: 'sd-fn sd-fn-marker--dup' }));
      continue;
    }
    if (def.number == null) {
      decos.push(Decoration.inline(def.from, def.to, { class: 'sd-fn sd-fn-marker--unref' }));
      continue;
    }
    if (revealed(def.from, def.to)) {
      decos.push(Decoration.inline(def.from, def.to, { class: 'sd-fn sd-fn--raw' }));
    } else {
      fold(def.from, def.to, defChipDOM(def), `sd-fn-def:${def.label}:${def.number}:${def.from}`);
    }
    if (def.refFroms.length > 0) {
      const [, lastBlockTo] = def.blocks[def.blocks.length - 1];
      decos.push(
        Decoration.widget(lastBlockTo - 1, backrefDOM(def.label), {
          key: `sd-fn-back:${def.label}:${lastBlockTo}`,
          side: 1,
        }),
      );
    }
  }
  return DecorationSet.create(doc, decos);
}

// ── Hover popover ──────────────────────────────────────────────────────────
// One floating element per window, plain DOM (widgets are plain DOM too),
// created lazily on hover and removed on leave / doc change / view destroy.
// Content is the definition's doc slice run through the schema's
// DOMSerializer, so inline formatting renders; `$…$` inside stays raw source.

let popoverEl: HTMLElement | null = null;
let popoverHideTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPopoverHide() {
  if (popoverHideTimer != null) {
    clearTimeout(popoverHideTimer);
    popoverHideTimer = null;
  }
}

export function hideFootnotePopover() {
  cancelPopoverHide();
  popoverEl?.remove();
  popoverEl = null;
}

function schedulePopoverHide() {
  cancelPopoverHide();
  popoverHideTimer = setTimeout(hideFootnotePopover, 250);
}

function showFootnotePopover(view: EditorView, anchor: HTMLElement, ranges: ReadonlyArray<Range>) {
  hideFootnotePopover();
  const serializer = DOMSerializer.fromSchema(view.state.schema);
  const el = document.createElement('div');
  el.className = 'sd-fn-popover';
  let hasContent = false;
  for (const [from, to] of ranges) {
    if (to <= from) continue;
    const part = document.createElement('div');
    part.appendChild(serializer.serializeFragment(view.state.doc.slice(from, to).content));
    if (part.textContent?.trim()) {
      el.appendChild(part);
      hasContent = true;
    }
  }
  if (!hasContent) return;
  el.addEventListener('mouseenter', cancelPopoverHide);
  el.addEventListener('mouseleave', schedulePopoverHide);
  document.body.appendChild(el);
  const rect = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  el.style.top = `${rect.bottom + 6}px`;
  popoverEl = el;
}

function popoverRangesFor(chip: HTMLElement, index: FootnoteIndex): ReadonlyArray<Range> | null {
  const kind = chip.dataset.fnKind;
  if (kind === 'ref') {
    const def = index.defByLabel.get(labelKey(chip.dataset.fnLabel ?? ''));
    return def ? def.contentRanges : null;
  }
  if (kind === 'inline') {
    const from = Number(chip.dataset.fnFrom);
    const item = index.inlines.find((x) => x.from === from);
    return item ? [[item.contentFrom, item.contentTo]] : null;
  }
  return null; // definition chip — its content is right next to it
}

function jumpTo(view: EditorView, pos: number) {
  hideFootnotePopover();
  const clamped = Math.max(0, Math.min(pos, view.state.doc.content.size));
  view.dispatch(
    view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(clamped))).scrollIntoView(),
  );
  if (view.editable) view.focus();
}

// ↩ cycles through a label's references on repeated clicks. Module-level and
// best-effort — a rebuilt widget or doc edit just restarts the cycle.
const backrefCycle = new Map<string, number>();

/** Could this edit have introduced a footnote token where none existed? Only
 *  the changed top-level blocks can carry one (tokens never span textblocks —
 *  a block MERGE lands the joined text inside the changed span too), so probe
 *  just their text for the two marker digraphs. O(change), not O(doc). */
function changedBlocksMayHaveFootnotes(tr: Transaction): boolean {
  const span = changedBlockSpan(tr);
  if (!span) return true; // attr-only step — can't localize, take the full path
  const text = tr.doc.textBetween(span.from, span.to, '\n', '￼');
  return text.includes('[^') || text.includes('^[');
}

type FootnoteState = {
  index: FootnoteIndex;
  decorations: DecorationSet;
  editable: boolean;
  focused: boolean;
};
export type FootnotePluginOptions = {
  // See tag-comment-decorations: a read-only view still has a selection, which
  // must not reveal raw source. Defaults to editable (bare plugin in tests).
  isEditable?: () => boolean;
};

export const footnotePluginKey = new PluginKey<FootnoteState>('footnoteDecorations');

export const footnotePlugin = ({ isEditable }: FootnotePluginOptions = {}) =>
  new Plugin<FootnoteState>({
    key: footnotePluginKey,
    state: {
      init: (_config, state) => {
        const index = buildFootnoteIndex(state.doc);
        return {
          index,
          decorations: buildDecorations(state.doc, index, null),
          editable: isEditable ? isEditable() : true,
          focused: false,
        };
      },
      apply(tr, previous, _oldState, newState) {
        const editable = isEditable ? isEditable() : true;
        const meta = tr.getMeta(footnotePluginKey) as { focused?: boolean } | undefined;
        const focused = typeof meta?.focused === 'boolean' ? meta.focused : previous.focused;
        // The caret only reveals raw source in an editable, focused editor
        // (same gate — and same reasons — as tag-comment-decorations).
        const revealing = editable && focused;
        const stateChanged = editable !== previous.editable || focused !== previous.focused;
        if (!tr.docChanged && !stateChanged && (!tr.selectionSet || !revealing)) {
          return previous;
        }
        // Global numbering → re-index the whole doc on a doc change — but only
        // when footnotes are in play at all. The common case (a footnote-free
        // document, plain typing) skips the O(doc) flatten+regex pass entirely:
        // with no tokens before the edit, a token can only appear if a changed
        // block's text now contains `[^` / `^[`, which the O(change) probe
        // below checks. (reviewRanges also live in the index, but they are
        // only ever read to reveal footnote SPANS — with zero tokens the
        // decoration set is empty regardless, so a stale empty index is fine.)
        const hadTokens =
          previous.index.refs.length > 0
          || previous.index.defs.length > 0
          || previous.index.inlines.length > 0;
        if (tr.docChanged && !hadTokens && !changedBlocksMayHaveFootnotes(tr)) {
          return { ...previous, editable, focused };
        }
        const index = tr.docChanged ? buildFootnoteIndex(tr.doc) : previous.index;
        const selection = revealing ? newState.selection : null;
        return {
          index,
          editable,
          focused,
          decorations: buildDecorations(tr.doc, index, selection),
        };
      },
    },
    // setEditable() reconfigures the view without a transaction; nudge one so
    // apply() sees the flip (same fix as Mathematics / tag-comment). Also the
    // autofocus safety net, popover cleanup on doc change and on destroy.
    view() {
      let lastEditable: boolean | undefined;
      let lastDoc: Node | undefined;
      return {
        update: (view) => {
          if (lastEditable === undefined) lastEditable = view.editable;
          if (view.editable !== lastEditable) {
            lastEditable = view.editable;
            view.dispatch(view.state.tr);
          }
          if (lastDoc !== undefined && lastDoc !== view.state.doc) hideFootnotePopover();
          lastDoc = view.state.doc;
          const state = footnotePluginKey.getState(view.state);
          if (state && view.hasFocus() !== state.focused) {
            view.dispatch(view.state.tr.setMeta(footnotePluginKey, { focused: view.hasFocus() }));
          }
        },
        destroy: hideFootnotePopover,
      };
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? DecorationSet.empty;
      },
      handleDOMEvents: {
        focus(view: EditorView) {
          view.dispatch(view.state.tr.setMeta(footnotePluginKey, { focused: true }));
          return false;
        },
        blur(view: EditorView) {
          view.dispatch(view.state.tr.setMeta(footnotePluginKey, { focused: false }));
          return false;
        },
        mousedown(view: EditorView, event: MouseEvent) {
          const target = event.target as HTMLElement | null;
          const el = target?.closest?.('.sd-fn-chip, .sd-fn-backref') as HTMLElement | null;
          if (!el) return false;
          event.preventDefault();
          const state = footnotePluginKey.getState(view.state);
          if (!state) return true;
          const label = labelKey(el.dataset.fnLabel ?? '');
          if (el.classList.contains('sd-fn-backref')) {
            const def = state.index.defByLabel.get(label);
            if (def && def.refFroms.length > 0) {
              const i = (backrefCycle.get(label) ?? 0) % def.refFroms.length;
              backrefCycle.set(label, i + 1);
              jumpTo(view, def.refFroms[i]);
            }
            return true;
          }
          const kind = el.dataset.fnKind;
          if (kind === 'ref') {
            const def = state.index.defByLabel.get(label);
            if (def) jumpTo(view, def.contentFrom);
          } else if (kind === 'inline') {
            // Reveal: place the caret inside so the raw source opens.
            const from = Number(el.dataset.fnFrom);
            const item = state.index.inlines.find((x) => x.from === from);
            if (item) jumpTo(view, item.contentFrom);
          } else if (kind === 'def') {
            const def = state.index.defByLabel.get(label);
            if (def) jumpTo(view, def.from + 1);
          }
          return true;
        },
        mouseover(view: EditorView, event: MouseEvent) {
          const target = event.target as HTMLElement | null;
          const chip = target?.closest?.('.sd-fn-chip') as HTMLElement | null;
          if (!chip) return false;
          const state = footnotePluginKey.getState(view.state);
          const ranges = state && popoverRangesFor(chip, state.index);
          // A chip with no popover content (a definition chip) must not pin a
          // previous chip's popover open — let any scheduled hide run.
          if (ranges) showFootnotePopover(view, chip, ranges);
          else schedulePopoverHide();
          return false;
        },
        mouseout(view: EditorView, event: MouseEvent) {
          const target = event.target as HTMLElement | null;
          if (target?.closest?.('.sd-fn-chip')) schedulePopoverHide();
          return false;
        },
      },
    },
  });

export const FootnoteDecorations = Extension.create<FootnotePluginOptions>({
  name: 'footnoteDecorations',
  addProseMirrorPlugins() {
    return [footnotePlugin({ isEditable: () => this.editor.isEditable })];
  },
});

export default FootnoteDecorations;
