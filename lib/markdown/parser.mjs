/**
 * Shared markdown parser used by the editor (HTML render + paste) and the
 * workspace collab server (Yjs XmlFragment build). Emits a neutral block AST
 * so both sides render from the same structure — add a feature in one place
 * and both sides pick it up.
 *
 * @typedef {{ type: 'text', text: string, marks: Mark[] }
 *         | { type: 'hardBreak' }
 *         | { type: 'image', src: string, alt: string, width?: number, align?: 'center' | 'right' }} Inline
 *
 * @typedef {{ type: 'bold' }
 *         | { type: 'italic' }
 *         | { type: 'code' }
 *         | { type: 'strike' }
 *         | { type: 'highlight' }
 *         | { type: 'underline' }
 *         | { type: 'subscript' }
 *         | { type: 'superscript' }
 *         | { type: 'link', href: string }
 *         | { type: 'wikilink', target: string, alias: string, embed: boolean }} Mark
 *
 * @typedef {{ type: 'heading', level: number, inline: Inline[] }
 *         | { type: 'paragraph', inline: Inline[] }
 *         | { type: 'codeBlock', language: string, text: string, indented?: boolean }
 *         | { type: 'bulletList', items: Block[][] }
 *         | { type: 'orderedList', start: number, items: Block[][] }
 *         | { type: 'blockquote', children: Block[] }
 *         | { type: 'callout', calloutType: string, foldable: boolean,
 *             collapsed: boolean, titleExplicit: boolean, title: string,
 *             children: Block[] }
 *         | { type: 'horizontalRule', marker?: string }
 *         | { type: 'frontmatter', text: string }
 *         | { type: 'table', header: Inline[][], rows: Inline[][][],
 *             align?: ('left' | 'center' | 'right' | null)[] }} Block
 */

import {
  frontmatterCloseIndex,
  isMarkdownTableRow,
  isMarkdownTableSeparator,
  normalizeMarkdownForRendering,
  splitMarkdownTableRow,
} from './normalize.mjs';
import { parseImageAttrs } from './image-attrs.mjs';

// Any single state char (Obsidian custom checkboxes: `[?]`, `[-]`, `[/]`, …),
// not just ` `/`x`. The char round-trips verbatim. `[`/`]` excluded so a
// bullet starting with a wikilink or a literal `[]]` never half-matches.
const MD_TASK = /^\s*[-*+]\s+\[([^\[\]])\]\s+(.*)/;
// The content after the marker is OPTIONAL so an EMPTY bullet / list item
// (`- ` with nothing after, which `trimEnd` reduces to a bare `-`) still parses
// as a list item instead of literal paragraph text. Without this, empty bullets
// in an outline round-trip to `-` prose and split the surrounding list, leaving
// awkward blank gaps after an agent edit. `-text` (no space) still isn't a list.
const MD_BULLET = /^\s*[-*+](?:\s+(.*))?$/;
const MD_ORDERED = /^\s*(\d+)\.(?:\s+(.*))?$/;
const MD_HEADING = /^(#{1,6})\s+(.*)/;
const MD_CODE_FENCE = /^```(.*)/;
// CommonMark thematic-break variants: 3+ of `-`, `*`, or `_` alone on a line,
// optionally spaced (`***`, `- - -`, `_ _ _`), indented up to 3 spaces (4+ is
// an indented code block). The marker is captured (sans indent) so the source
// form round-trips verbatim. A bare or doubled `*` / `-` never matches (scene
// breaks / empty bullets stay protected).
const MD_HR = /^ {0,3}(-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/;
const MD_BLOCKQUOTE = /^>\s?(.*)/;
// Obsidian puts the fold marker AFTER the bracket (`> [!note]-`); the lazy type
// + optional inner marker also accepts the inside-the-bracket form (`[!note-]`)
// that Sundial used to emit, so docs written that way keep folding. Lazy is safe
// for hyphenated types: `[!my-type]` only matches with the whole word as group 1.
const MD_CALLOUT = /^>\s*\[!([A-Za-z0-9_-]+?)([+-])?\]([+-])?\s*(.*)$/;

// Characters that can begin an inline token. Used to fast-skip plain-text runs
// in parseInline so a long unmarked line doesn't cost O(n^2).
const INLINE_SPECIAL = new Set(['$', '\\', '!', '[', '`', '=', '~', '*', '_', '<']);

// Inline HTML subset (Obsidian parity): bare, attribute-less tags that map to
// real marks and round-trip back as the same tag. Anything tag-shaped outside
// this allowlist stays literal text (escaped at render). `<mark>` maps onto the
// existing highlight mark and serializes back as `==…==`.
const HTML_MARK_TYPES = { u: 'underline', sub: 'subscript', sup: 'superscript', mark: 'highlight' };

// Generic tag-shaped token (attribute values scanned as quoted runs). Consumed
// as literal text while tracking open/close depth, so subset tags INSIDE raw
// HTML stay literal — `<div><mark>x</mark></div>` must not become `==x==`.
// The attribute body is LAZY and the self-close slash is matched after
// optional whitespace, so `<my-widget />` reads as self-closing instead of
// the `/` being swallowed as attribute text (which left depth open and made
// a following toolbar `<u>` come back literal). Unquoted attribute values
// containing `/` (`href=/path`) still parse as attributes, not self-close.
const HTML_TAG_TOKEN =
  /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|[^<>"'\n])*?)?\s*(\/?)>/;

// HTML void elements can't contain children — they never open depth, or an
// `<img>` before a `<u>` would leave the parser "inside HTML" and the
// toolbar's underline would come back literal after a rebuild.
const HTML_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

// Only REAL HTML elements (or hyphenated custom elements) open raw-tag depth.
// Tag-shaped prose — generics like `Use <T>`, placeholders like `<name>` —
// must stay inert, or a toolbar underline serialized after it would come back
// literal on rebuild. Standard element names, voids excluded (they never
// nest) and the mark subset excluded (handled above at depth 0).
const HTML_CONTAINER_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo',
  'blockquote', 'body', 'button', 'canvas', 'caption', 'center', 'cite',
  'code', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn',
  'dialog', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'html', 'i', 'iframe', 'ins', 'kbd', 'label', 'legend', 'li', 'main',
  'map', 'mark', 'menu', 'meter', 'nav', 'noscript', 'object', 'ol',
  'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section', 'select', 'slot',
  'small', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'svg',
  'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead',
  'time', 'title', 'tr', 'u', 'ul', 'var', 'video',
]);
const opensRawDepth = (tag) => tag.includes('-') || HTML_CONTAINER_TAGS.has(tag);

// A start tag whose attributes run past the end of the line (prettified or
// pasted HTML: `<div\n  class="x">`). Only real containers qualify, so prose
// like `the <div element` in a sentence can't arm it for a whole line.
const HTML_TAG_OPENER_EOL = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^\n]*)?$/;

// Index of the `>` that ends a start tag, skipping quoted attribute values
// (`title="a>b"`). -1 when the tag still doesn't close on this line.
function findTagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

const isWordChar = (ch) => ch != null && /[\p{L}\p{N}]/u.test(ch);
// A `_` run can't open/close emphasis when flanked by a word char (intra-word)
// or by another `_` (part of a longer run that already failed, e.g. `a__b__c`).
const blocksUnderscore = (ch) => isWordChar(ch) || ch === '_';

// CommonMark forbids intra-word `_`/`__` emphasis. Without this, snake_case
// names and DOIs like `10.1162/tacl_a_00638` render (and round-trip) as italics.
// Asterisks are intentionally exempt — CommonMark *does* allow `a*b*c`.
function underscoreSpanOk(str, openIdx, matchLen) {
  const before = openIdx > 0 ? str[openIdx - 1] : '';
  const after = str[openIdx + matchLen] ?? '';
  return !blocksUnderscore(before) && !blocksUnderscore(after);
}

// ---------------------------------------------------------------------------
// Serialize-side escaping — the parser's inverse guard, kept HERE so escaping
// semantics can never fork from parsing semantics. parseInline strips the
// backslash off any `\x`, so literal text that LOOKS like structure must get
// its escape back on the way out; without it the round trip is not idempotent
// and quietly converts prose into structure (`\* not a bullet` came back as a
// real list; `\_x\_` re-parsed as italic and normalized to `*x*`).

// Inline tokens parseInline consumes VERBATIM (or whose payload bytes must
// survive untouched): math, wikilinks, images/links (hrefs), footnote refs,
// inline code, HTML comments and tags (quote-aware, so an attribute holding
// `<!--` or `>` is part of the tag, not a comment opener), plus an unclosed
// start tag running to end of line (parseInline's pendingTag). The
// underscore escaper skips these — an escape injected into an href, a
// comment, or a tag attribute would corrupt it. Mirrors the token order in
// parseInline. (`%%…%%` is absent on purpose: parseInline has no comment
// rule for it, so emphasis inside DOES parse and must escape.)
const HTML_TAG_OPENER_TAIL = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^\n]*)?$/;
const INLINE_VERBATIM_TOKEN = new RegExp(
  [
    /\$\$[^$\n]+?\$\$|(?<!\\)\$(?!\s)[^$\n]+?(?<!\s)\$(?!\d)/.source,
    /!?\[\[[^\[\]]+\]\]|!?\[[^\]]*\]\([^)]+\)(?:\{[^}]*\})?|\[\^[^\[\]\s%]+\]/.source,
    /`[^`]+?`|<!--.*?-->|<!--.*/.source,
    // HTML_TAG_TOKEN without its `^` anchor, then the unclosed-opener tail.
    `<\\/?[a-zA-Z][a-zA-Z0-9-]*(?:\\s+(?:"[^"\\n]*"|'[^'\\n]*'|[^<>"'\\n])*?)?\\s*\\/?>`,
    HTML_TAG_OPENER_TAIL.source,
  ].join('|'),
  'g',
);

// Literal `_`-emphasis spans in plain text keep an escape on the way out:
// parseInline would otherwise re-read them as italic/bold on the NEXT parse
// and the serializer normalizes underscore emphasis to `*` — the classic
// non-idempotent round trip. Every underscore of a recognizable span is
// escaped (opener-only would leave inner `_b_` spans live); text with no
// parseable span (snake_case, lone `_`) is returned byte-identical.
// Returns the escaped line plus the parse state it ends in: inside an
// UNCLOSED `<!--` comment, or inside an unclosed START TAG (parseInline's
// pendingTag) — the caller threads both across a paragraph's lines, because
// comment bodies and mid-tag bytes are consumed verbatim by parseInline (no
// unescaping), so escaping them would grow a new backslash on every pass.
function escapeInlineLine(line) {
  if (!line || (!line.includes('_') && !line.includes('<'))) {
    return { text: line, openComment: false, pendingTag: false };
  }
  const re = new RegExp(INLINE_VERBATIM_TOKEN.source, 'g');
  let out = '';
  let plainFrom = 0;
  let openComment = false;
  let cursor = 0;
  for (;;) {
    re.lastIndex = cursor;
    const m = re.exec(line);
    if (!m) break;
    let token = m[0];
    if (token[0] === '<' && token[1] !== '!' && !token.endsWith('>')) {
      // Unclosed start tag running to end of line. parseInline arms its
      // pendingTag path only for real containers/custom elements — prose
      // like `Use <T>` falls through to plain text, so keep scanning past
      // the `<` (a later token on the line may still act).
      const name = token.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/)?.[1]?.toLowerCase() ?? '';
      if (!opensRawDepth(name)) {
        cursor = m.index + 1;
        continue;
      }
      out += escapeUnderscoreSegment(line.slice(plainFrom, m.index)) + line.slice(m.index);
      return { text: out, openComment: false, pendingTag: true };
    }
    out += escapeUnderscoreSegment(line.slice(plainFrom, m.index));
    if (token[0] === '[' && token[1] !== '[' && token[1] !== '^') {
      // `[text](href)`: parseInline WALKS the text part (emphasis applies
      // there, and verbatim spans like `code` inside it stay verbatim), so
      // the label recurses through the full token-aware escaper — only the
      // href is verbatim. Images (`![…]`), wikilinks and footnote refs are
      // consumed atomically and stay untouched. (A label cannot contain `]`,
      // so the recursion can never see another link token.)
      const split = token.indexOf('](');
      token = `[${escapeInlineLine(token.slice(1, split)).text}${token.slice(split)}`;
    }
    out += token;
    if (token.startsWith('<!--') && !token.endsWith('-->')) openComment = true;
    cursor = m.index + m[0].length;
    plainFrom = cursor;
  }
  return {
    text: out + escapeUnderscoreSegment(line.slice(plainFrom)),
    openComment,
    pendingTag: false,
  };
}

// Only `_` spans are escaped here: underscore emphasis is the one construct
// the serializer NORMALIZES (`_x_` → `*x*`), so an unescaped literal span
// changes bytes on the next pass. Star/highlight/strike delimiters are the
// marks' own serialized form — at this (assembled-text) level a literal
// `*x*` is indistinguishable from a real italic mark's output, and escaping
// them here corrupts genuine formatting. An escaped `\*x\*` in source loses
// its backslashes but the resulting `*x*` is a byte-level fixed point
// (documented divergence: literal intent upgrades to formatting on a
// rebuild-from-text).
function escapeUnderscoreSegment(segment) {
  if (!segment.includes('_')) return segment;
  let out = '';
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === '_') {
      const slice = segment.slice(i);
      const span = slice.match(/^__(.+?)__/) || slice.match(/^_([^_]+?)_/);
      if (span && underscoreSpanOk(segment, i, span[0].length)) {
        out += span[0].replace(/_/g, '\\_');
        i += span[0].length;
        continue;
      }
    }
    out += segment[i];
    i += 1;
  }
  return out;
}

// Escape an assembled serialized text block so nothing in it re-parses as
// structure: block markers at line starts, literal underscore emphasis. The
// ONE serialize-side escaping entry point, comment-aware — lines inside a
// multi-line `<!-- … -->` span are consumed verbatim by parseInline (no
// unescaping), so they must be emitted verbatim too or every pass grows a new
// backslash. `context` names where the text sits, because the parser's block
// rules differ by position:
//   'block'     — its own block (parseBlockLines block start on line 0,
//                 paragraph-interrupt rules on later lines)
//   'itemFirst' — a list item's leading paragraph (line 0 is consumed as the
//                 item's inline text, so it can never be misread; later lines
//                 land in parseListAt's nesting scan)
//   'item'      — a list item continuation block (every line in the scan)
//   'inline'    — single-line inline contexts (heading text, table cells,
//                 callout titles): underscore escaping only, no block rules
export function escapeSerializedText(text, context = 'block') {
  if (!text) return text;
  const lines = text.split('\n');
  let inComment = false;
  let inTag = false;
  for (let k = 0; k < lines.length; k += 1) {
    if (inComment) {
      // Everything up to the closer is verbatim comment body; the remainder
      // resumes normal inline escaping. A line that BEGINS inside a comment
      // can never start a block on re-parse, so block rules don't apply.
      const close = lines[k].indexOf('-->');
      if (close === -1) continue;
      const rest = escapeInlineLine(lines[k].slice(close + 3));
      lines[k] = lines[k].slice(0, close + 3) + rest.text;
      inComment = rest.openComment;
      inTag = rest.pendingTag;
      continue;
    }
    if (inTag) {
      // Mid-tag bytes (a start tag spanning lines — parseInline's pendingTag
      // path) are consumed verbatim up to the quote-aware `>`.
      const end = findTagEnd(lines[k], 0);
      if (end === -1) continue;
      const rest = escapeInlineLine(lines[k].slice(end + 1));
      lines[k] = lines[k].slice(0, end + 1) + rest.text;
      inComment = rest.openComment;
      inTag = rest.pendingTag;
      continue;
    }
    const lineContext = context === 'inline'
      ? null
      : k === 0
        ? (context === 'itemFirst' ? null : context === 'item' ? 'item' : 'block')
        : (context === 'block' ? 'continuation' : 'item');
    if (lineContext && lineEscapes(lines[k], lineContext)) {
      // Ordered markers escape the DOT (`1\.`, the CommonMark form Obsidian
      // renders clean); everything else escapes its first non-blank char.
      const om = lines[k].match(/^(\s*)(\d+)\./);
      const indent = lines[k].match(/^\s*/)[0];
      lines[k] = om
        ? `${om[1]}${om[2]}\\${lines[k].slice(om[1].length + om[2].length)}`
        : `${indent}\\${lines[k].slice(indent.length)}`;
    }
    const inline = escapeInlineLine(lines[k]);
    lines[k] = inline.text;
    inComment = inline.openComment;
    inTag = inline.pendingTag;
  }
  return lines.join('\n');
}

// Would this line open a block (or interrupt its paragraph) if re-parsed?
// Mirrors parseBlockLines / isBlockStart / parseListAt exactly — escaping a
// line those rules would NOT reinterpret (a citation year `2020. DOI…` on a
// wrapped line, a scene-break `*`) would churn bytes for no reason.
function lineEscapes(line, context) {
  if (context !== 'item') {
    // MD_HR covers every thematic-break spelling (`---`, `***`, `___`, spaced
    // variants) — literal paragraph text in any of those shapes must escape or
    // the next parse turns it into an <hr>.
    if (/^#{1,6}\s/.test(line) || line[0] === '>' || line.startsWith('```') || MD_HR.test(line)) {
      return true;
    }
  }
  const m = line.match(/^(\s*)(\d+\.|[-*+])(\s|$)/);
  if (!m) return false;
  const marker = m[2];
  const hasContent = line.slice(m[1].length + marker.length).trim() !== '';
  const bullet = marker.length === 1;
  // Bare markers on later lines stay unescaped: whether they nest depends on
  // their siblings (parseListAt's empty-marker guards), and the common case —
  // a scene-break `*`, an empty outline `-` — must not churn bytes.
  if (context === 'item') return hasContent;
  if (context === 'continuation') {
    return bullet ? hasContent : hasContent && marker === '1.';
  }
  // 'block': list starts also include a bare `-` and a bare `1.`.
  return bullet ? hasContent || marker === '-' : hasContent || marker === '1.';
}

// Which verbatim inline construct (if any) is still OPEN after this line —
// the block parser's paragraph-accumulation twin of parseInline's `inComment`
// + `pendingTag` state. Verbatim spans parseInline consumes BEFORE those
// rules (escapes, inline code, math, wikilinks, links/images, complete
// quote-aware HTML tags) can't open either, so a literal `` `<!--` `` or a
// `title="<!--"` attribute never suppresses isBlockStart. Inside an open
// comment everything is literal until `-->`; inside an open start tag,
// until the quote-aware `>`.
const VERBATIM_SCAN_TOKEN = new RegExp(
  [
    /\\[\s\S]|`[^`]+?`|\$\$[^$\n]+?\$\$|\$(?!\s)[^$\n]+?(?<!\s)\$(?!\d)/.source,
    /!?\[\[[^\[\]]+\]\]|!?\[[^\]]*\]\([^)]+\)(?:\{[^}]*\})?/.source,
    '<!--',
    `<\\/?[a-zA-Z][a-zA-Z0-9-]*(?:\\s+(?:"[^"\\n]*"|'[^'\\n]*'|[^<>"'\\n])*?)?\\s*\\/?>`,
    HTML_TAG_OPENER_TAIL.source,
  ].join('|'),
  'g',
);
function verbatimStillOpen(line, state) {
  let { comment, tag } = state;
  let i = 0;
  const re = new RegExp(VERBATIM_SCAN_TOKEN.source, 'g');
  while (i < line.length) {
    if (comment) {
      const close = line.indexOf('-->', i);
      if (close === -1) return { comment: true, tag: false };
      comment = false;
      i = close + 3;
      continue;
    }
    if (tag) {
      const end = findTagEnd(line, i);
      if (end === -1) return { comment: false, tag: true };
      tag = false;
      i = end + 1;
      continue;
    }
    re.lastIndex = i;
    const m = re.exec(line);
    if (!m) return { comment: false, tag: false };
    if (m[0] === '<!--') {
      comment = true;
    } else if (m[0][0] === '<' && m[0][1] !== '!' && !m[0].endsWith('>')) {
      // Unclosed start tag to end of line — pendingTag arms only for real
      // containers/custom elements, like parseInline's opener branch.
      const name = m[0].match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/)?.[1]?.toLowerCase() ?? '';
      if (opensRawDepth(name)) return { comment: false, tag: true };
      i = m.index + 1;
      continue;
    }
    i = m.index + m[0].length;
  }
  return { comment, tag };
}

function getIndent(line) {
  let count = 0;
  for (const char of line) {
    if (char === ' ') { count += 1; continue; }
    if (char === '\t') { count += 4; continue; }
    break;
  }
  return count;
}

// True when the indented line at `index` continues a footnote definition:
// walking back over blanks and earlier indented continuation paragraphs, the
// nearest sub-indented non-blank line is a `[^id]:` definition.
function isFootnoteContinuation(lines, index) {
  for (let k = index - 1; k >= 0; k -= 1) {
    const line = lines[k] ?? '';
    if (!line.trim()) continue;
    if (getIndent(line) >= 4) continue; // an earlier continuation paragraph
    return /^\[\^[^\]\n]+\]:/.test(line.trim());
  }
  return false;
}

// Remove one level (4 columns, tab = 4) of code-block indentation.
function stripCodeIndent(line) {
  let cols = 0;
  let i = 0;
  while (i < line.length && cols < 4) {
    if (line[i] === ' ') cols += 1;
    else if (line[i] === '\t') cols += 4;
    else break;
    i += 1;
  }
  return line.slice(i);
}

export function humanizeCalloutType(type) {
  return type
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Parse inline markdown text into structured spans. Handles **bold**, *italic*,
 * `code`, ~~strike~~, ==highlight==, [text](url), [[wikilink|alias]], ![[embed]],
 * ![alt](src). Order of recognition matches the HTML renderer.
 *
 * @param {string} text
 * @param {{ rawDepth: number, inComment?: boolean }} [state] carries unclosed
 *   raw-tag depth AND open-comment state across the lines of one paragraph,
 *   so `<mark>` on the line after `<div>` stays literal, and tags inside a
 *   multi-line `<!-- … -->` never count as structure. Callers parsing
 *   independent single lines use the default.
 * @returns {Inline[]}
 */
export function parseInline(text, state = { rawDepth: 0, inComment: false }) {
  /** @type {Inline[]} */
  const out = [];
  let cursor = 0;
  let depth = state.rawDepth;
  let inComment = state.inComment === true;
  let pendingTag = state.pendingTag ?? null;
  // Sticky for the paragraph: `<mark>` is the only subset tag whose conversion
  // CHANGES bytes (it canonicalizes to `==`). Once real raw HTML has appeared,
  // a later sibling `<mark>` must stay literal — `<div></div><mark>x</mark>`
  // otherwise saves back as `<div></div>==x==`, rewriting the user's HTML.
  // u/sub/sup re-serialize as the identical tag, so they keep converting and
  // toolbar formatting after raw HTML still round-trips.
  let seenRawTag = state.seenRawTag === true;

  const pushText = (raw, marks) => {
    if (!raw) return;
    if (out.length > 0) {
      const last = out[out.length - 1];
      if (last.type === 'text' && marksEqual(last.marks, marks)) {
        last.text += raw;
        return;
      }
    }
    out.push({ type: 'text', text: raw, marks: marks.slice() });
  };

  // Recursive descent over the string, pulling off one token at a time.
  // parseInline itself is non-recursive; marks accumulate on a stack as we
  // descend into delimited spans.
  const walk = (str, marks) => {
    let i = 0;
    while (i < str.length) {
      const slice = str.slice(i);

      // Math $$…$$ or $…$ — preserved verbatim (delimiters + LaTeX content) so
      // the HTML renderer can KaTeX it. Crucially: skip the escape / italic /
      // bold rules below for the math span, or `\frac`, `x_i` etc. get mangled.
      if (slice[0] === '$') {
        const block = slice.match(/^\$\$([^\$\n]+?)\$\$/);
        if (block) {
          pushText(block[0], marks);
          i += block[0].length;
          continue;
        }
        const inline = slice.match(/^\$(?!\s)([^\$\n]+?)(?<!\s)\$(?!\d)/);
        if (inline) {
          pushText(inline[0], marks);
          i += inline[0].length;
          continue;
        }
      }

      // Escape: \x → literal x
      if (slice[0] === '\\' && slice.length > 1) {
        pushText(slice[1], marks);
        i += 2;
        continue;
      }

      // Image ![alt](src) with an optional `{width=N align=center}` attribute
      // suffix. The `{…}` is consumed only when it's a valid attribute block
      // (parseImageAttrs); anything else stays literal, never half-consumed.
      const img = slice.match(/^!\[([^\]]*)\]\(([^)]+)\)(\{[^}]*\})?/);
      if (img) {
        const node = { type: 'image', alt: img[1], src: img[2] };
        const attrs = img[3] ? parseImageAttrs(img[3]) : null;
        if (attrs) Object.assign(node, attrs);
        out.push(node);
        i += img[0].length - (img[3] && !attrs ? img[3].length : 0);
        continue;
      }

      // Wiki embed ![[target|alias]]
      const wikiEmbed = slice.match(/^!\[\[([^\[\]]+)\]\]/);
      if (wikiEmbed) {
        const { target, alias } = splitWikiInner(wikiEmbed[1]);
        pushText(alias || target, [
          ...marks,
          { type: 'wikilink', target, alias, embed: true },
        ]);
        i += wikiEmbed[0].length;
        continue;
      }

      // Wiki link [[target|alias]]
      const wiki = slice.match(/^\[\[([^\[\]]+)\]\]/);
      if (wiki) {
        const { target, alias } = splitWikiInner(wiki[1]);
        pushText(alias || target, [
          ...marks,
          { type: 'wikilink', target, alias, embed: false },
        ]);
        i += wiki[0].length;
        continue;
      }

      // Footnote reference [^label] — stays LITERAL text; the editor renders
      // it as a decoration (lib/tiptap/footnote-decorations.ts), the codec
      // never learns footnotes exist. The rule exists so `[^1](aside)` keeps
      // its ref atomic instead of becoming a link with text `^1` — byte-
      // neutral either way (the link form serializes back to the same
      // characters), but only the literal form is renderable as a footnote.
      const fnRef = slice.match(/^\[\^[^\[\]\s%]+\]/);
      if (fnRef) {
        pushText(fnRef[0], marks);
        i += fnRef[0].length;
        continue;
      }

      // Link [text](href) — unless the bracket opens an inline footnote
      // `^[…]` (Obsidian/Pandoc), whose brackets must stay literal for the
      // footnote decoration: `^[note](aside)` is a footnote followed by
      // literal parens, not a link titled `^note`. Byte-neutral, like above.
      const link = slice.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (link && str[i - 1] !== '^') {
        walk(link[1], [...marks, { type: 'link', href: link[2] }]);
        i += link[0].length;
        continue;
      }

      // Inline HTML subset. `<br>` variants become hard breaks (the same node
      // the two-space / backslash markers produce, with the original form kept
      // on `marker`); allowlisted bare tags become marks via recursion, so
      // `<u>**b**</u>` nests. Case-insensitive, and the `i` flag makes the
      // closing-tag backreference accept `<u>…</U>` too. Unclosed, attributed,
      // or unknown tags fail these matches and stay literal text. Inside raw
      // HTML (depth > 0) the subset stays literal too — a `<mark>` that is
      // part of `<div>…</div>` source must not become a highlight mark.
      if (slice[0] === '<') {
        if (depth === 0) {
          const br = slice.match(/^<br\s*\/?>/i);
          if (br) {
            out.push({ type: 'hardBreak', marker: br[0] });
            i += br[0].length;
            continue;
          }
          const tag = slice.match(/^<(u|sub|sup|mark)>(.+?)<\/\1>/i);
          if (tag && !(seenRawTag && tag[1].toLowerCase() === 'mark')) {
            walk(tag[2], [...marks, { type: HTML_MARK_TYPES[tag[1].toLowerCase()] }]);
            i += tag[0].length;
            continue;
          }
        }
        // A closed inline HTML comment is ONE literal token with no depth
        // effect — tags inside it (`<!-- <div> -->`) are commentary, not
        // structure. An opener with no closer on THIS line swallows the rest
        // of the line literally and carries the open state to the next line
        // of the paragraph (mirrors the multi-line form the tag-comment
        // decoration dims); the state resets at the paragraph boundary.
        const comment = slice.match(/^<!--.*?-->/);
        if (comment) {
          pushText(comment[0], marks);
          i += comment[0].length;
          continue;
        }
        if (slice.startsWith('<!--')) {
          pushText(slice, marks);
          inComment = true;
          i = str.length;
          continue;
        }
        const generic = slice.match(HTML_TAG_TOKEN);
        if (generic) {
          const tag = generic[2].toLowerCase();
          if (opensRawDepth(tag)) {
            const isClose = generic[1] === '/';
            const selfClose = generic[3] === '/' || HTML_VOID_TAGS.has(tag);
            if (isClose) depth = Math.max(0, depth - 1);
            else if (!selfClose) { depth += 1; seenRawTag = true; }
          }
          pushText(generic[0], marks);
          i += generic[0].length;
          continue;
        }
        // No complete tag on this line — a start tag left OPEN at end of line
        // carries to the next line of the paragraph, so its depth lands once
        // the tag actually closes. Checked last: a tag that closes here must
        // take the generic branch above.
        const opener = slice.match(HTML_TAG_OPENER_EOL);
        if (opener && opensRawDepth(opener[2].toLowerCase())) {
          pushText(slice, marks);
          pendingTag = { name: opener[2].toLowerCase(), isClose: opener[1] === '/' };
          i = str.length;
          continue;
        }
      }

      // Inline code `...`
      const code = slice.match(/^`([^`]+?)`/);
      if (code) {
        pushText(code[1], [...marks, { type: 'code' }]);
        i += code[0].length;
        continue;
      }

      // Highlight ==...==
      const hl = slice.match(/^==(.+?)==/);
      if (hl) {
        walk(hl[1], [...marks, { type: 'highlight' }]);
        i += hl[0].length;
        continue;
      }

      // Strike ~~...~~
      const strike = slice.match(/^~~(.+?)~~/);
      if (strike) {
        walk(strike[1], [...marks, { type: 'strike' }]);
        i += strike[0].length;
        continue;
      }

      // Bold **...** (asterisks may sit mid-word per CommonMark).
      const boldStar = slice.match(/^\*\*(.+?)\*\*/);
      if (boldStar) {
        walk(boldStar[1], [...marks, { type: 'bold' }]);
        i += boldStar[0].length;
        continue;
      }
      // Bold __...__ — only when not intra-word (see underscoreSpanOk).
      const boldUnder = slice.match(/^__(.+?)__/);
      if (boldUnder && underscoreSpanOk(str, i, boldUnder[0].length)) {
        walk(boldUnder[1], [...marks, { type: 'bold' }]);
        i += boldUnder[0].length;
        continue;
      }

      // Italic *...* or _..._  (avoid swallowing leftover * from bold token)
      const italicStar = slice.match(/^\*([^*]+?)\*/);
      if (italicStar) {
        walk(italicStar[1], [...marks, { type: 'italic' }]);
        i += italicStar[0].length;
        continue;
      }
      // Italic _..._ — only when not intra-word (see underscoreSpanOk).
      const italicUnder = slice.match(/^_([^_]+?)_/);
      if (italicUnder && underscoreSpanOk(str, i, italicUnder[0].length)) {
        walk(italicUnder[1], [...marks, { type: 'italic' }]);
        i += italicUnder[0].length;
        continue;
      }

      // Plain text — consume the whole run up to the next token-starting
      // char in one step, so a long unmarked line is O(n), not O(n^2).
      let j = i + 1;
      while (j < str.length && !INLINE_SPECIAL.has(str[j])) j += 1;
      pushText(str.slice(i, j), marks);
      i = j;
    }
  };

  // Inside an open multi-line comment: everything up to `-->` (or the whole
  // line) is literal commentary — no marks, no depth, no subset.
  let start = 0;
  if (inComment) {
    const close = text.indexOf('-->');
    if (close === -1) {
      pushText(text, []);
      start = text.length;
    } else {
      pushText(text.slice(0, close + 3), []);
      inComment = false;
      start = close + 3;
    }
  } else if (pendingTag) {
    // Finish a start tag that was left open on a previous line.
    const close = findTagEnd(text, 0);
    if (close === -1) {
      pushText(text, []);
      start = text.length;
    } else {
      pushText(text.slice(0, close + 1), []);
      const selfClose = text[close - 1] === '/' || HTML_VOID_TAGS.has(pendingTag.name);
      if (pendingTag.isClose) depth = Math.max(0, depth - 1);
      else if (!selfClose) { depth += 1; seenRawTag = true; }
      pendingTag = null;
      start = close + 1;
    }
  }
  if (start < text.length) walk(text.slice(start), []);
  cursor; // keep linter happy for unused outer cursor
  state.rawDepth = depth;
  state.inComment = inComment;
  state.pendingTag = pendingTag;
  state.seenRawTag = seenRawTag;
  return out;
}

function marksEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.type !== y.type) return false;
    if (x.type === 'link' && y.type === 'link' && x.href !== y.href) return false;
    if (x.type === 'wikilink' && y.type === 'wikilink') {
      if (x.target !== y.target || x.alias !== y.alias || x.embed !== y.embed) return false;
    }
  }
  return true;
}

function splitWikiInner(inner) {
  const [rawTarget, rawAlias] = inner.split('|', 2);
  return {
    target: (rawTarget ?? '').trim(),
    alias: rawAlias?.trim() ?? '',
  };
}

/**
 * Parse full markdown text into a block AST.
 *
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  const lines = normalizeMarkdownForRendering(text).split('\n');
  return parseBlockLines(lines, true);
}

/** @returns {Block[]} */
function parseBlockLines(lines, topLevel = false) {
  /** @type {Block[]} */
  const blocks = [];
  let i = 0;
  // Count of blank lines that appeared between the previous block and the next
  // one we push. Attached to the next block as `blankBefore` so the serializer
  // can emit the exact spacing back out (the standard `\n\n` block separator
  // already encodes 1 blank line, so blankBefore=1 is the no-op default).
  let pendingBlankBefore = null;
  let hasNonEmptyBlock = false;
  /** @param {Block} block */
  const pushBlock = (block) => {
    const isEmptyPara =
      block.type === 'paragraph' && (!block.inline || block.inline.length === 0);
    // Attach the blank-line count to the next NON-EMPTY block. For the first
    // block this records LEADING blanks; for subsequent blocks it records
    // inter-block spacing. Recorded at EVERY level (not just top-level) so the
    // serializer can reproduce blank lines inside callouts / blockquotes / list
    // items instead of collapsing them to a single newline (which merges two
    // paragraphs into one). Legacy empty-paragraph markers stay top-level only.
    if (pendingBlankBefore != null && !isEmptyPara) {
      block.blankBefore = pendingBlankBefore;
      pendingBlankBefore = null;
    } else if (!topLevel && hasNonEmptyBlock && !isEmptyPara) {
      // Nested parsed blocks with no intervening blank need an explicit zero;
      // serializers otherwise use their editor-created-node fallback spacing.
      block.blankBefore = 0;
    }
    if (!isEmptyPara) hasNonEmptyBlock = true;
    blocks.push(block);
  };

  const isBlockStart = (candidate, index) => {
    if (!candidate.trim()) return true;
    if (candidate.match(MD_CODE_FENCE)) return true;
    if (isMarkdownTableRow(candidate) && isMarkdownTableSeparator(lines[index + 1] ?? '')) return true;
    if (candidate.match(MD_CALLOUT)) return true;
    if (candidate.match(MD_BLOCKQUOTE)) return true;
    if (MD_HR.test(candidate)) return true;
    // CommonMark: an EMPTY list item can never interrupt a paragraph — a bare
    // `-` / `*` / `1.` line inside prose (scene break, minus sign, soft-wrapped
    // citation year) stays paragraph text. Only content-bearing markers split.
    const bullet = candidate.match(MD_BULLET);
    if (bullet && bullet[1]) return true;
    // CommonMark: an ordered list interrupts a paragraph only when it starts at
    // 1. So a soft-wrapped citation line like `…pp. 452–466,\n2020. DOI:…` stays
    // one paragraph instead of splitting off a bogus list that starts at 2020.
    const ordered = candidate.match(MD_ORDERED);
    if (ordered && ordered[2] && Number(ordered[1]) === 1) return true;
    if (candidate.match(MD_HEADING)) return true;
    return false;
  };

  const paragraphInline = (paragraphLines) => {
    const inline = [];
    // Raw-tag depth and open-comment state carry across the paragraph's
    // lines, so a `<mark>` on the line after an unclosed `<div>` stays
    // literal HTML source and tags inside `<!--\n…\n-->` never count.
    const state = { rawDepth: 0, inComment: false, pendingTag: null, seenRawTag: false };
    paragraphLines.forEach((paragraphLine, index) => {
      // Detect a markdown hard-break marker on the raw (untrimmed) line.
      // `  ` (two+ trailing spaces) or `\` are the two canonical forms.
      const markerMatch = paragraphLine.match(/(?:\\| {2,})$/);
      const marker = markerMatch ? markerMatch[0] : null;
      const textLine = (marker
        ? paragraphLine.slice(0, paragraphLine.length - marker.length)
        : paragraphLine
      ).trimEnd();
      inline.push(...parseInline(textLine, state));
      if (index < paragraphLines.length - 1) {
        const last = inline[inline.length - 1];
        // A line ending in an HTML <br> already breaks; the source newline
        // after it is whitespace, not a second visual break. Fold it into the
        // marker so the round trip stays byte-exact with ONE hardBreak node.
        if (!marker && last?.type === 'hardBreak' && /^<br/i.test(last.marker || '')) {
          last.marker += '\n';
          return;
        }
        const node = { type: 'hardBreak' };
        if (marker) node.marker = marker;
        inline.push(node);
      }
    });
    return inline;
  };

  // YAML frontmatter (Obsidian/Jekyll): only at the very start of the file —
  // `---` alone on line 1 with a later closing `---` fence. Captured verbatim
  // (fences included), never parsed, so the YAML round-trips byte-for-byte.
  // With no closing fence the leading `---` stays an ordinary HR, and a `---`
  // later in the document is unaffected. pendingBlankBefore=0 makes a block
  // that directly abuts the closing fence serialize with a single `\n`, not
  // the default blank line; a real blank run after the fence overwrites it.
  if (topLevel) {
    const close = frontmatterCloseIndex(lines);
    if (close !== -1) {
      pushBlock({ type: 'frontmatter', text: lines.slice(0, close + 1).join('\n') });
      pendingBlankBefore = 0;
      i = close + 1;
    }
  }

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Fenced code block
    const fence = line.match(MD_CODE_FENCE);
    if (fence) {
      const lang = fence[1].trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1;
      pushBlock({ type: 'codeBlock', language: lang, text: codeLines.join('\n') });
      continue;
    }

    // Multi-line display math: an opening `$$` with no closing `$$` on the same
    // line. Consume through the closing `$$` and emit it as ONE verbatim math
    // token. Parsing the inner lines as prose would unescape its LaTeX
    // (`\frac` → `frac`); the line breaks between `$$` delimiters are
    // insignificant whitespace, so collapsing them to spaces yields the
    // single-line `$$…$$` form, which round-trips backslashes intact.
    if (line.startsWith('$$') && line.indexOf('$$', 2) === -1) {
      const mathLines = [line];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const cur = (lines[j] ?? '').trimEnd();
        mathLines.push(cur);
        j += 1;
        if (cur.includes('$$')) { closed = true; break; }
      }
      if (closed) {
        const joined = mathLines.join('\n');
        const inner = joined
          .slice(joined.indexOf('$$') + 2, joined.lastIndexOf('$$'))
          .replace(/[ \t]*\r?\n[ \t]*/g, ' ')
          .trim();
        i = j;
        pushBlock({ type: 'paragraph', inline: [{ type: 'text', text: `$$${inner}$$`, marks: [] }] });
        continue;
      }
      // No closer found — fall through and treat the line as ordinary text.
    }

    // Table: a row whose next line is a separator. Per-column alignment comes
    // from the separator's colons (`:---` left, `:---:` center, `---:` right).
    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(lines[i + 1] ?? '')) {
      // NOT `.map(parseInline)`: map's index would land in the `state` param.
      const header = splitMarkdownTableRow(line).map((cell) => parseInline(cell));
      // Per-column alignment from the separator's colons (`:---` left,
      // `:---:` center, `---:` right).
      const align = splitMarkdownTableRow(lines[i + 1]).map((cell) => {
        const c = cell.replace(/\s+/g, '');
        const left = c.startsWith(':');
        const right = c.length > 1 && c.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
      });
      i += 2;
      const rows = [];
      while (i < lines.length && isMarkdownTableRow(lines[i] ?? '')) {
        rows.push(splitMarkdownTableRow(lines[i]).map((cell) => parseInline(cell)));
        i += 1;
      }
      pushBlock({ type: 'table', header, rows, align });
      continue;
    }

    // Callout (before blockquote)
    const calloutMatch = line.match(MD_CALLOUT);
    if (calloutMatch) {
      const calloutType = calloutMatch[1].toLowerCase();
      const foldMarker = calloutMatch[3] || calloutMatch[2] || '';
      const title = calloutMatch[4]?.trim() ?? '';
      const bodyLines = [];
      i += 1;
      while (i < lines.length) {
        const bq = (lines[i] ?? '').match(MD_BLOCKQUOTE);
        if (!bq) break;
        bodyLines.push(bq[1] ?? '');
        i += 1;
      }
      pushBlock({
        type: 'callout',
        calloutType,
        foldable: !!foldMarker,
        collapsed: foldMarker === '-',
        titleExplicit: !!title,
        title: title || humanizeCalloutType(calloutType),
        children: parseBlockLines(bodyLines),
      });
      continue;
    }

    // Blockquote
    const bq = line.match(MD_BLOCKQUOTE);
    if (bq) {
      const bqLines = [bq[1]];
      i += 1;
      while (i < lines.length) {
        const next = (lines[i] ?? '').match(MD_BLOCKQUOTE);
        if (!next) break;
        bqLines.push(next[1]);
        i += 1;
      }
      pushBlock({ type: 'blockquote', children: parseBlockLines(bqLines) });
      continue;
    }

    // Horizontal rule
    const hr = line.match(MD_HR);
    if (hr) {
      const block = { type: 'horizontalRule' };
      if (hr[1] !== '---') block.marker = hr[1];
      pushBlock(block);
      i += 1;
      continue;
    }

    // Lists (bullet/ordered/task, possibly nested by indent). An empty DASH
    // bullet (`- ` alone) starts a list — outlines full of blank bullets are
    // real documents. A bare `*` / `+` stays prose (a writer's scene-break
    // asterisk is not an outline). An empty ORDERED marker starts one only at
    // 1: a standalone year/version line like `2020.` must stay prose, not
    // become an <ol start=2020> (same hazard the isBlockStart guard covers).
    const bm = line.match(MD_BULLET);
    const om = bm ? null : line.match(MD_ORDERED);
    const listStart = (bm && (bm[1] || line.trim() === '-'))
      || (om && (om[2] || Number(om[1]) === 1));
    if (listStart) {
      const consumed = parseListAt(lines, i);
      pushBlock(consumed.block);
      i = consumed.nextIndex;
      continue;
    }

    // Heading
    const h = line.match(MD_HEADING);
    if (h) {
      pushBlock({ type: 'heading', level: h[1].length, inline: parseInline(h[2]) });
      i += 1;
      continue;
    }

    // Blank lines. Two complementary mechanisms preserve the count:
    //   (1) `blankBefore` attribute on the next NON-EMPTY block — read by the
    //       Y.Doc codec serializer for lossless round-trips of any count.
    //   (2) `floor(blankRun / 2)` empty-paragraph blocks — the legacy marker
    //       the ProseMirror codec (`markdownToHtml` → DOM → PM nodes) still
    //       depends on. Odd counts round-trip exactly through the legacy path;
    //       even counts shift to odd once and then stay fixed.
    if (!line.trim()) {
      let blankRun = 0;
      while (i < lines.length && !(lines[i] ?? '').trim()) { blankRun += 1; i += 1; }
      pendingBlankBefore = blankRun;
      if (topLevel) {
        for (let n = 0; n < Math.floor(blankRun / 2); n += 1) {
          pushBlock({ type: 'paragraph', inline: [] });
        }
      }
      continue;
    }
    // Indented code block (CommonMark: 4 spaces / 1 tab). Checked LAST among
    // block starts so every deliberate guard above keeps priority — an indented
    // list marker stays a nested list, an indented table row stays a table, and
    // indented lines inside list items never reach here (parseListAt consumes
    // them as item content). Interior blank runs stay in the block only when
    // more indented code follows; trailing blanks belong to the outer loop.
    // Footnote continuations are exempt: an indented paragraph following a
    // `[^id]:` definition is that definition's body (Obsidian), not code —
    // footnotes are literal text to this parser, so the continuation must stay
    // a paragraph for the footnote decorations to attach it.
    if (getIndent(raw) >= 4 && !isFootnoteContinuation(lines, i)) {
      const codeLines = [stripCodeIndent(raw)];
      i += 1;
      let scan = i;
      while (scan < lines.length) {
        const next = lines[scan] ?? '';
        if (!next.trim()) { scan += 1; continue; }
        if (getIndent(next) < 4) break;
        for (let k = i; k < scan; k += 1) codeLines.push('');
        codeLines.push(stripCodeIndent(next));
        scan += 1;
        i = scan;
      }
      pushBlock({ type: 'codeBlock', language: '', text: codeLines.join('\n'), indented: true });
      continue;
    }
    // Collect raw (untrimmed) paragraph lines so `paragraphInline` can detect
    // the `  ` and `\` hard-break markers — those would otherwise be eaten by
    // the outer `trimEnd` at the top of this loop. While an HTML comment or a
    // start tag is OPEN (`<!--` / `<div …` with no closer yet — the same
    // paragraph-scoped state parseInline carries as inComment/pendingTag),
    // block-shaped lines are commentary/tag bytes, not structure: without
    // this, `<!--\n- item\n-->` split into paragraph + list + escape hell
    // instead of staying one paragraph whose body is verbatim. Blank lines
    // still end the paragraph (and with it the open state).
    const paragraphLines = [raw];
    let open = verbatimStillOpen(raw, { comment: false, tag: false });
    i += 1;
    while (i < lines.length) {
      const nextRaw = lines[i] ?? '';
      if (!nextRaw.trim()) break;
      if (!open.comment && !open.tag && isBlockStart(nextRaw.trimEnd(), i)) break;
      paragraphLines.push(nextRaw);
      open = verbatimStillOpen(nextRaw, open);
      i += 1;
    }
    pushBlock({ type: 'paragraph', inline: paragraphInline(paragraphLines) });
  }

  // Trailing newlines: any blank run left dangling at end of input rolls onto
  // the last block as `trailingNewlines`. The codec serializer reads that
  // attribute to emit the exact trailing newline count back out. For a pure-
  // newline source (no non-empty blocks at all) the split('\n') over-counts
  // the trailing run by one — subtract that off so '\n' → '\n', not '\n\n'.
  if (topLevel && pendingBlankBefore != null && pendingBlankBefore > 0 && blocks.length > 0) {
    const allEmpty = blocks.every(
      (b) => b.type === 'paragraph' && (!b.inline || b.inline.length === 0),
    );
    const trailing = allEmpty ? pendingBlankBefore - 1 : pendingBlankBefore;
    if (trailing > 0) {
      blocks[blocks.length - 1].trailingNewlines = trailing;
    }
  }

  return blocks;
}

/**
 * Parse a list starting at `start`. Lists end when we hit a non-list line at
 * the same-or-shallower indent. Nested lists are parsed recursively.
 *
 * @returns {{ block: Block, nextIndex: number }}
 */
function parseListAt(lines, start) {
  const baseIndent = getIndent(lines[start]);
  const baseBullet = lines[start].match(MD_BULLET);
  const baseOrdered = lines[start].match(MD_ORDERED);
  const baseBulletMarker = baseBullet ? lines[start].trimStart()[0] : null;
  const type = baseBullet ? 'bulletList' : 'orderedList';
  const startNum = baseOrdered ? Number(baseOrdered[1]) || 1 : 1;

  /** @type {Block[][]} */
  const items = [];
  let i = start;
  // Index just past the last list line consumed. Blank lines BETWEEN items are
  // part of the list, but a trailing blank run belongs to the caller — ending
  // the list at `i` would swallow it and collapse the blank-line count after
  // every list on round-trip.
  let end = start;
  // Blank lines seen since the last consumed line — attached as `blankBefore` to
  // the next continuation block or nested list of the CURRENT item, so a loose
  // item (paragraph, blank, paragraph) round-trips its blank line instead of
  // collapsing to one paragraph. Reset at each same-indent sibling item (blanks
  // before a sibling are list-level looseness, not item-internal spacing).
  let pendingBlank = 0;

  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim()) { pendingBlank += 1; i += 1; continue; }

    // A spaced thematic break (`- - -`, `* * *`) matches the bullet regex, so
    // without this it would be swallowed as an item with text `- -`. Matched on
    // the raw line: MD_HR allows ≤3 leading spaces (same as CommonMark), so a
    // shallow-indented rule ends the list while a 4+-space `---`-ish line stays
    // item continuation text.
    if (MD_HR.test(raw)) break;

    const indent = getIndent(raw);
    if (indent < baseIndent) break;

    const isBullet = raw.match(MD_BULLET);
    const isOrdered = raw.match(MD_ORDERED);
    if (indent === baseIndent) {
      // Apply the same empty-marker protections used when starting a list.
      // Otherwise a prose `*` / `+` scene break after bullets is swallowed as
      // an empty item, and a citation year after an ordered list is too. Keep
      // a bare marker matching this list, repeated `1.`, and the next
      // sequential number as intentional empty items.
      if (type === 'bulletList'
        && (!isBullet || (!isBullet[1] && raw.trim() !== baseBulletMarker))) break;
      if (type === 'orderedList'
        && (!isOrdered || (!isOrdered[2]
          && Number(isOrdered[1]) !== 1
          && Number(isOrdered[1]) !== startNum + items.length))) break;
    }

    if (indent > baseIndent) {
      // An EMPTY marker can nest a list only when it isn't interrupting item
      // text (CommonMark: empty items don't interrupt paragraphs) — so a
      // soft-wrapped citation line ending in `2020.` or a bare `-` under a
      // text-bearing item stays a continuation paragraph. Empty ordered
      // markers additionally require start 1 (a stray deeper `2020.` line
      // must not become an <ol start=2020>).
      const emptyMarker = (isBullet && !isBullet[1]) || (isOrdered && !isOrdered[2]);
      const lastItem = items[items.length - 1];
      const lastBlock = lastItem ? lastItem[lastItem.length - 1] : null;
      const lastIsText = lastBlock?.type === 'paragraph' && (lastBlock.inline || []).length > 0;
      const nestsList = (isBullet || isOrdered)
        && !(isBullet && !isBullet[1]
          && baseBulletMarker !== null
          && raw.trim() !== '-'
          && raw.trim() !== baseBulletMarker)
        && !(emptyMarker && lastIsText)
        && !(isOrdered && !isOrdered[2] && Number(isOrdered[1]) !== 1);
      if (nestsList) {
        // Nested list — attach to the previous item. The `nextIndex > i`
        // guard prevents an infinite loop if the recursion can't advance.
        const nested = parseListAt(lines, i);
        if (pendingBlank > 0) nested.block.blankBefore = pendingBlank;
        if (items.length > 0) items[items.length - 1].push(nested.block);
        pendingBlank = 0;
        i = nested.nextIndex > i ? nested.nextIndex : i + 1;
        end = i;
      } else {
        // Deeper-indented non-list line — continuation of the previous item.
        // Recursing here would spin forever: the inner parseListAt finds no
        // list item, breaks immediately, and returns the same index.
        if (items.length > 0) {
          const para = { type: 'paragraph', inline: parseInline(raw.trim()) };
          if (pendingBlank > 0) para.blankBefore = pendingBlank;
          items[items.length - 1].push(para);
        }
        pendingBlank = 0;
        i += 1;
        end = i;
      }
      continue;
    }

    // Same-indent list item. A task state char is kept VERBATIM (`[X]`, `[?]`,
    // `[-]` — Obsidian custom states) so it round-trips unchanged.
    const task = raw.match(MD_TASK);
    // Content group is optional now (empty item) → default to '' so an empty
    // bullet becomes a list item holding an empty paragraph, not `undefined`.
    const text = task ? `[${task[1]}] ${task[2]}`
      : (isBullet ? isBullet[1] : isOrdered[2]) ?? '';
    items.push([{ type: 'paragraph', inline: parseInline(text) }]);
    pendingBlank = 0;
    i += 1;
    end = i;
  }

  // Preserve the source bullet marker (`*` / `+`): Obsidian notes are full of
  // starred lists, and normalizing every one to `-` rewrites the whole file.
  // `-` stays the unmarked default (editor-created lists have no marker).
  const bulletBlock = { type: 'bulletList', items };
  if (baseBulletMarker === '*' || baseBulletMarker === '+') bulletBlock.marker = baseBulletMarker;
  return {
    block: type === 'bulletList'
      ? bulletBlock
      : { type: 'orderedList', start: startNum, items },
    nextIndex: end,
  };
}
