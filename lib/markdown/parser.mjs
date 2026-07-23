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
 *         | { type: 'link', href: string }
 *         | { type: 'wikilink', target: string, alias: string, embed: boolean }} Mark
 *
 * @typedef {{ type: 'heading', level: number, inline: Inline[] }
 *         | { type: 'paragraph', inline: Inline[] }
 *         | { type: 'codeBlock', language: string, text: string }
 *         | { type: 'bulletList', items: Block[][] }
 *         | { type: 'orderedList', start: number, items: Block[][] }
 *         | { type: 'blockquote', children: Block[] }
 *         | { type: 'callout', calloutType: string, foldable: boolean,
 *             collapsed: boolean, titleExplicit: boolean, title: string,
 *             children: Block[] }
 *         | { type: 'horizontalRule' }
 *         | { type: 'table', header: Inline[][], rows: Inline[][][] }} Block
 */

import {
  isMarkdownTableRow,
  isMarkdownTableSeparator,
  normalizeMarkdownForRendering,
  splitMarkdownTableRow,
} from './normalize.mjs';
import { parseImageAttrs } from './image-attrs.mjs';

const MD_TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)/;
// The content after the marker is OPTIONAL so an EMPTY bullet / list item
// (`- ` with nothing after, which `trimEnd` reduces to a bare `-`) still parses
// as a list item instead of literal paragraph text. Without this, empty bullets
// in an outline round-trip to `-` prose and split the surrounding list, leaving
// awkward blank gaps after an agent edit. `-text` (no space) still isn't a list.
const MD_BULLET = /^\s*[-*+](?:\s+(.*))?$/;
const MD_ORDERED = /^\s*(\d+)\.(?:\s+(.*))?$/;
const MD_HEADING = /^(#{1,6})\s+(.*)/;
const MD_CODE_FENCE = /^```(.*)/;
const MD_HR = /^---\s*$/;
const MD_BLOCKQUOTE = /^>\s?(.*)/;
const MD_CALLOUT = /^>\s*\[!([A-Za-z0-9_-]+)([+-])?\]\s*(.*)$/;

// Characters that can begin an inline token. Used to fast-skip plain-text runs
// in parseInline so a long unmarked line doesn't cost O(n^2).
const INLINE_SPECIAL = new Set(['$', '\\', '!', '[', '`', '=', '~', '*', '_']);

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

function getIndent(line) {
  let count = 0;
  for (const char of line) {
    if (char === ' ') { count += 1; continue; }
    if (char === '\t') { count += 4; continue; }
    break;
  }
  return count;
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
 * @returns {Inline[]}
 */
export function parseInline(text) {
  /** @type {Inline[]} */
  const out = [];
  let cursor = 0;

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

      // Link [text](href)
      const link = slice.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (link) {
        walk(link[1], [...marks, { type: 'link', href: link[2] }]);
        i += link[0].length;
        continue;
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

  walk(text, []);
  cursor; // keep linter happy for unused outer cursor
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
    paragraphLines.forEach((paragraphLine, index) => {
      // Detect a markdown hard-break marker on the raw (untrimmed) line.
      // `  ` (two+ trailing spaces) or `\` are the two canonical forms.
      const markerMatch = paragraphLine.match(/(?:\\| {2,})$/);
      const marker = markerMatch ? markerMatch[0] : null;
      const textLine = (marker
        ? paragraphLine.slice(0, paragraphLine.length - marker.length)
        : paragraphLine
      ).trimEnd();
      inline.push(...parseInline(textLine));
      if (index < paragraphLines.length - 1) {
        const node = { type: 'hardBreak' };
        if (marker) node.marker = marker;
        inline.push(node);
      }
    });
    return inline;
  };

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

    // Table: a row whose next line is a separator
    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(lines[i + 1] ?? '')) {
      const header = splitMarkdownTableRow(line).map(parseInline);
      i += 2;
      const rows = [];
      while (i < lines.length && isMarkdownTableRow(lines[i] ?? '')) {
        rows.push(splitMarkdownTableRow(lines[i]).map(parseInline));
        i += 1;
      }
      pushBlock({ type: 'table', header, rows });
      continue;
    }

    // Callout (before blockquote)
    const calloutMatch = line.match(MD_CALLOUT);
    if (calloutMatch) {
      const calloutType = calloutMatch[1].toLowerCase();
      const foldMarker = calloutMatch[2] ?? '';
      const title = calloutMatch[3]?.trim() ?? '';
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
    if (MD_HR.test(line)) {
      pushBlock({ type: 'horizontalRule' });
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
    // Collect raw (untrimmed) paragraph lines so `paragraphInline` can detect
    // the `  ` and `\` hard-break markers — those would otherwise be eaten by
    // the outer `trimEnd` at the top of this loop.
    const paragraphLines = [raw];
    i += 1;
    while (i < lines.length) {
      const nextRaw = lines[i] ?? '';
      if (isBlockStart(nextRaw.trimEnd(), i)) break;
      paragraphLines.push(nextRaw);
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

    // Same-indent list item.
    const task = raw.match(MD_TASK);
    // Content group is optional now (empty item) → default to '' so an empty
    // bullet becomes a list item holding an empty paragraph, not `undefined`.
    const text = task ? `[${task[1].toLowerCase() === 'x' ? 'x' : ' '}] ${task[2]}`
      : (isBullet ? isBullet[1] : isOrdered[2]) ?? '';
    items.push([{ type: 'paragraph', inline: parseInline(text) }]);
    pendingBlank = 0;
    i += 1;
    end = i;
  }

  return {
    block: type === 'bulletList'
      ? { type: 'bulletList', items }
      : { type: 'orderedList', start: startNum, items },
    nextIndex: end,
  };
}
