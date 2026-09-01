/**
 * Paste-routing helpers for the collaborative markdown editor.
 *
 * The editor's `handlePaste` prefers the clipboard's `text/plain` markdown so
 * that markdown source (Obsidian, code editors) and Sundial-only syntax
 * (`$math$`, `[[wiki-links]]`, callouts) render correctly. But rich editors
 * (Notion, web pages) put a *lossy* `text/plain` on the clipboard alongside
 * faithful `text/html`: the plain text keeps list/heading markers yet DROPS
 * hyperlink URLs. Routing those through the markdown path silently deletes the
 * links (UI/UX fix #7). This predicate decides when to defer to ProseMirror's
 * native HTML paste instead, so links + nesting survive.
 */

import { getExtension, isBlobFile, isCrdtFile } from '@/lib/sync/policy';

const HTML_ANCHOR_RE = /<a\s[^>]*\bhref\s*=/i;
// ProseMirror tags its own clipboard HTML with `data-pm-slice` on the wrapper.
const PM_SLICE_RE = /data-pm-slice\s*=/i;

/**
 * True when the clipboard HTML is ProseMirror's own serialized slice — i.e. a
 * copy *from* a Sundial editor. That HTML is lossless, so the caller should
 * return `false` from `handlePaste` and let ProseMirror parse it natively;
 * re-routing the lossy `text/plain` through markdown would drop callouts, math,
 * and exact marks (UI/UX fix: copy/paste between Sundial md files).
 */
export function isProseMirrorClipboardHtml(html: string | null | undefined): boolean {
  return Boolean(html && PM_SLICE_RE.test(html));
}
// A markdown inline link is `](` immediately followed by a non-space, non-`)`
// char (the start of a URL). Reference-style `[x]` without `(` is ignored.
const MARKDOWN_LINK_RE = /\]\([^)\s]/;

// Block-level markdown, anchored at line start: list items / checkboxes,
// headings, ordered lists, blockquotes / callouts, fences, wikilinks,
// highlights, tables.
const BLOCK_MD_RE =
  /^\s*(?:[-*+](\s+\[[ xX]\])?\s+|#{1,6}\s+|\d+\.\s+|>\s+|>\s*\[!|`{3,}|~{3,}|\[\[|!\[\[|==.+==|\|.*\||[^|\n]+\|[^|\n]+)/m;
// Inline links don't anchor at line start: mid-sentence [[wikilinks]] /
// ![[embeds]] (Obsidian) and [label](target) links. Without this, a pasted
// sentence with no other block markdown lands as inert plain text and the
// link never connects to its workspace file. Guarded against code-shaped
// text: `[` preceded by a word char, `]`, `.`, `)`, or `}` is (optionally
// chained) indexing or a call on a parenthesized/object receiver
// (`mylist[[x]]`, `handlers?.[op](ctx.value)`, `getHandlers()[op](x)`), and
// a quote glued to `[` is a string literal containing link syntax
// (`"[[My Note]]"`) — accepted false-negative: quoted prose like
// `il a dit "[[Note]] est bien"` degrades to plain text. Neither is a
// link; a `(target)` only counts as a
// link when it has no whitespace AND looks like a path/URL (contains one of
// `./:%#`), so `dispatch[op](l, r)` and log tokens like `[main](thread-1)`
// stay plain. Tradeoff: a link glued to a sentence period (`fin.[doc](x.md)`)
// no longer matches — space after punctuation is the norm. The wikilink
// target (group 1) and `[x](y)` target (group 2) are captured for the
// bare-word strength checks below.
const INLINE_LINK_RE =
  /(?<![\w\].)}"'`])\[\[([^\[\]\n]+)\]\]|(?<![\w\].)}"'`])\[[^\]\n]+\]\(([^()\s]+)\)/g;

/**
 * True when the `[` at `index` sits at the start of its line (only whitespace
 * before it) while the previous line ends like code (`\w`, `]`, `.`) — the
 * multiline computed-access shape `handlers\n  [op](ctx.value)`. A previous
 * line that is empty or ends with punctuation (`:`, `,`, …) reads as prose,
 * so those line-leading links still count.
 */
function continuesCodeLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  if (lineStart === 0) return false; // the paste starts with the link
  if (text.slice(lineStart, index).trim() !== '') return false; // not line-leading
  const prevStart = text.lastIndexOf('\n', lineStart - 2) + 1;
  const prevLine = text.slice(prevStart, lineStart - 1).trimEnd();
  return /[\w\].]$/.test(prevLine);
}

/**
 * True when the `[` at `index` follows same-line whitespace that itself
 * follows a word char, `]`, `.`, `)`, `}`, or a quote — the shape
 * `handlers [op](x)` / `getHandlers() [op](x)` / `"key" [i]` shares with a
 * mid-sentence link `see [docs](url)`, a post-parenthetical
 * `(aparté) [doc](url)`, or post-quotation `"fin" [[Meeting Notes]]`.
 * Position alone can't discriminate these, so matches in this shape must
 * carry strong target evidence.
 */
function followsBareWord(text: string, index: number): boolean {
  let i = index - 1;
  let sawSpace = false;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) {
    i -= 1;
    sawSpace = true;
  }
  return sawSpace && i >= 0 && /[\w\].)}"'`]/.test(text[i]!);
}

/** The extension is a known workspace file type (policy.json, the single source of truth). */
function hasKnownFileExtension(path: string): boolean {
  return getExtension(path) !== '' && (isCrdtFile(path) || isBlobFile(path));
}

/**
 * In the bare-word shape a `[x](y)` match only counts as a link when the
 * target is a URL. Extension evidence is inconclusive there: `config.json`
 * is also a member expression, and `a/b.md` even parses as a division
 * chain. Accepted false-negative: a mid-sentence markdown FILE link after a
 * bare word degrades to plain text (the pre-gate behavior) — safer than
 * corrupting pasted code. Wikilinks keep their tier rules (they're the
 * Obsidian-native syntax); extension evidence stays valid for [x](y) in
 * unambiguous positions.
 */
function strongLinkTarget(target: string): boolean {
  return target.includes('://');
}

// ISO-ish date — Obsidian daily-note names ([[2026-07-30]]) are note
// references even without letters.
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/;

/**
 * True when the `[` at `index` follows (through same-line whitespace) an
 * operator character — `matrix = [[1, 2]]`, `xs, [[i]]`. After an operator,
 * link syntax is code, unconditionally.
 */
const OPERATOR_CHARS = new Set('=+*-/<>&|,;');
function followsOperator(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i -= 1;
  return i >= 0 && OPERATOR_CHARS.has(text[i]!);
}

/**
 * Note-reference evidence for a wikilink in the ambiguous bare-word shape:
 * multi-word targets, paths, aliases, fragments, daily-note dates, or a
 * known file extension read as notes; a bare single-token identifier (`i`,
 * `op`, `name`) reads as spaced R/JS index access (`mylist [[i]]`). A note
 * name otherwise needs at least one letter (any script) — `[[1, 2]]` after
 * a bare word is a nested array literal, not a note.
 */
function noteishWikiTarget(target: string): boolean {
  if (ISO_DATE_RE.test(target)) return true;
  if (!/\p{L}/u.test(target)) return false;
  if (/[\s/|#]/.test(target)) return true;
  return hasKnownFileExtension(target);
}

type LiteralFrame =
  | { kind: 'template' }
  | { kind: 'triple'; quote: string }
  | { kind: 'interp'; depth: number }
  | { kind: 'blockComment' };

/**
 * Incremental forward scanner over the paste for string/comment context —
 * one scan front advanced monotonically across all matches, O(text length)
 * total. Tracks, without being a full lexer:
 * - backtick templates with `${…}` interpolation nesting (an interpolation
 *   is code, so it can open a nested template; a `}` at brace depth zero
 *   returns to the template);
 * - Python triple-quotes (''' / """; everything is inert inside them);
 * - C-style block comments, slash-star to star-slash (opened only at line
 *   start or after whitespace, so prose globs like `src/*` don't trigger);
 * - line-local `"` / `'` quote state, reset at `\n` (their multiline forms
 *   don't exist, and per-line keeps prose safe). A `'` flanked by word chars
 *   is an apostrophe (`don't`, `l'exemple`), not a delimiter;
 * - `//` line comments, reset at `\n`, counted only at line start or after
 *   whitespace and never right after `:` — so `https://x.y` in prose stays
 *   linkable. Accepted rare false-negative: a protocol-relative `//cdn.x`
 *   in prose opens a "comment". `#` is NOT a comment marker — Python
 *   comments are indistinguishable from markdown headings (out of scope).
 * Documented tradeoff throughout: an unpaired backtick or stray quote in
 * prose degrades later links on that state to plain text — the pre-gate
 * behavior — while a false-positive would corrupt pasted code.
 */
function createPasteContextScanner(text: string) {
  const stack: LiteralFrame[] = [];
  let lineQuote: string | null = null;
  let lineComment = false;
  let pos = 0;
  // `//` opens a line comment in ANY position except right after `:` (which
  // protects `https://` in prose) — how every C-family lexer treats it.
  // Documented residual false-negatives: protocol-relative `//cdn.x` in
  // prose, and a double slash inside a URL path (`https://x.y//path`) —
  // both degrade later links on the line to plain text, same asymmetry.
  const startsLineComment = (p: number) => text[p - 1] !== ':';
  // Memoized "does a `*/` exist at or after `from`" — `from` is monotonic
  // (the scan front only advances), so the search start never regresses and
  // the total cost stays O(text length) even for many unclosed `/*` globs.
  let closerIdx: number | null = null;
  const hasBlockCloser = (from: number): boolean => {
    if (closerIdx === null || (closerIdx !== -1 && closerIdx < from)) {
      closerIdx = text.indexOf('*/', from);
    }
    return closerIdx !== -1;
  };
  return {
    /** Whether `index` (must be ≥ any previous call) is inside a literal or comment. */
    insideAt(index: number): boolean {
      while (pos < index) {
        const ch = text[pos]!;
        if (ch === '\n') {
          lineQuote = null;
          lineComment = false;
          pos += 1;
          continue;
        }
        if (lineComment) {
          pos += 1;
          continue;
        }
        if (ch === '\\') {
          pos += 2;
          continue;
        }
        const top = stack[stack.length - 1];
        if (top?.kind === 'blockComment') {
          if (ch === '*' && text[pos + 1] === '/') {
            stack.pop();
            pos += 2;
          } else {
            pos += 1;
          }
          continue;
        }
        if (top?.kind === 'triple') {
          if (ch === top.quote[0] && text.slice(pos, pos + 3) === top.quote) {
            stack.pop();
            pos += 3;
          } else {
            pos += 1;
          }
          continue;
        }
        if (top?.kind === 'template') {
          if (ch === '`') {
            stack.pop();
          } else if (ch === '$' && text[pos + 1] === '{') {
            stack.push({ kind: 'interp', depth: 0 });
            pos += 1;
          }
          pos += 1;
          continue;
        }
        // Code — the base text or a template interpolation.
        if (lineQuote !== null) {
          if (ch === lineQuote) lineQuote = null;
          pos += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          if (text.slice(pos, pos + 3) === ch.repeat(3)) {
            stack.push({ kind: 'triple', quote: ch.repeat(3) });
            pos += 3;
            continue;
          }
          // Unicode letters, so accented contractions (`l'été`) count too.
          const wordInternal =
            ch === "'" &&
            pos > 0 &&
            /\p{L}/u.test(text[pos - 1]!) &&
            /\p{L}/u.test(text[pos + 1] ?? '');
          if (!wordInternal) lineQuote = ch;
          pos += 1;
          continue;
        }
        if (ch === '`') {
          stack.push({ kind: 'template' });
          pos += 1;
          continue;
        }
        if (ch === '/') {
          if (text[pos + 1] === '/' && startsLineComment(pos)) {
            lineComment = true;
            pos += 2;
            continue;
          }
          // `/*` is recognized by CLOSURE, not by the preceding char — a
          // glob (`src/*`) also follows a word char, but only a real block
          // comment has a matching `*/` later. Never right after `:`.
          if (text[pos + 1] === '*' && text[pos - 1] !== ':' && hasBlockCloser(pos + 2)) {
            stack.push({ kind: 'blockComment' });
            pos += 2;
            continue;
          }
        }
        if (top?.kind === 'interp') {
          if (ch === '{') {
            top.depth += 1;
          } else if (ch === '}') {
            if (top.depth === 0) stack.pop();
            else top.depth -= 1;
          }
        }
        pos += 1;
      }
      return stack.length > 0 || lineQuote !== null || lineComment;
    },
  };
}

/**
 * True when pasted `text/plain` looks like markdown and should be routed
 * through the markdown parser instead of inserted as plain text.
 */
export function pasteLooksLikeMarkdown(text: string): boolean {
  if (BLOCK_MD_RE.test(text)) return true;
  // One forward scanner for all matches — matchAll yields ascending indices.
  const context = createPasteContextScanner(text);
  for (const match of text.matchAll(INLINE_LINK_RE)) {
    if (context.insideAt(match.index)) continue;
    if (continuesCodeLine(text, match.index)) continue;
    // `word [x](y)` / `word [[x]]` are syntactically identical to computed
    // access (spaced call, R indexing), and `op = [[…]]` to an array literal
    // — in those shapes the target itself must prove it's a link. Accepted
    // false-negatives degrade to plain text, the pre-gate behavior; a
    // false-positive would corrupt pasted code. Unambiguous prose positions
    // (start of paste, after `:`/`(` or sentence punctuation, line-leading
    // after prose) accept any non-empty whitespace-free [x](y) target
    // (`[Plan](Plan)`) and any wikilink.
    const wikiTarget = match[1];
    const linkTarget = match[2];
    // Universal wikilink rule, position-independent: no real note name is
    // letterless-and-dateless, while nested numeric arrays
    // (`{ data: [[1, 2]] }`, `foo([[1, 2]])`) never are notes.
    if (
      wikiTarget !== undefined &&
      !/\p{L}/u.test(wikiTarget) &&
      !ISO_DATE_RE.test(wikiTarget)
    ) {
      continue;
    }
    // Operator context is code, full stop: no prose writes link syntax right
    // after `=+*-/<>&|,;`, and every evidence type is forgeable there
    // (`config.json` = member access, `a/b` = division, `2026-07-30` =
    // arithmetic, `[a](b)` = array-then-call). Reject both arms
    // unconditionally rather than shaving evidence types round after round.
    if (followsOperator(text, match.index)) continue;
    if (followsBareWord(text, match.index)) {
      if (wikiTarget !== undefined && !noteishWikiTarget(wikiTarget)) continue;
      if (linkTarget !== undefined && !strongLinkTarget(linkTarget)) continue;
    }
    return true;
  }
  return false;
}

/**
 * True when the clipboard HTML carries hyperlinks the plain text lacks, so the
 * markdown path would drop them. In that case the caller should return `false`
 * from `handlePaste` to let ProseMirror parse the richer `text/html`.
 */
export function shouldDeferToHtmlPaste(
  html: string | null | undefined,
  plainText: string,
): boolean {
  if (!html) return false;
  if (!HTML_ANCHOR_RE.test(html)) return false;
  // If the plain text already encodes links as markdown, it's a faithful
  // markdown copy (Obsidian/source) — keep it on the markdown path.
  return !MARKDOWN_LINK_RE.test(plainText);
}
