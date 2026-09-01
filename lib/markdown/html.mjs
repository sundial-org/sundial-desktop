/**
 * AST → HTML renderer. Consumes Block[] from parser.mjs.
 *
 * @typedef {import('./parser.mjs').Block} Block
 * @typedef {import('./parser.mjs').Inline} Inline
 * @typedef {import('./parser.mjs').Mark} Mark
 *
 * @typedef {'chat' | 'document'} MarkdownVariant
 * @typedef {{ variant?: MarkdownVariant, renderMath?: boolean, renderImages?: boolean, resolveImageSrc?: (src: string) => string }} RenderOptions
 *
 * renderMath defaults to true. The codec (markdown → ProseMirror) passes false
 * so math stays as literal `$x^2$` text in the editor — the Tiptap Mathematics
 * extension renders it as a decoration. KaTeX HTML in the codec path would be
 * dropped by the ProseMirror DOMParser.
 *
 * renderImages defaults to true. The codec passes false so `![alt](src)` stays
 * as literal text in the editor — the markdownImage decoration extension
 * renders the preview, and the raw text reveals when the cursor enters it
 * (Obsidian-style live preview).
 */

import katex from 'katex';
import { resolveAnchor } from './anchors.mjs';
import { humanizeCalloutType, parseMarkdown } from './parser.mjs';
import { resolveCalloutType } from './callout-types.mjs';
import { imageMarkdown, parseAltSizeSpec } from './image-attrs.mjs';

function esc(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Match $$...$$ (block) then $...$ (inline). Single-line only; multi-line block
// math arrives as raw `$$\n...\n$$` and falls through (not yet supported).
const MATH_REGEX = /\$\$([^\$\n]+?)\$\$|(?<!\\)\$(?!\s)([^\$\n]+?)(?<!\s)\$(?!\d)/g;

/**
 * Render math markers ($…$, $$…$$) within plain text. Non-math content is
 * HTML-escaped. Use this for surfaces that should NOT process other markdown
 * syntax (user chat bubbles, where `**bold**` should stay literal).
 *
 * @param {string} text
 * @returns {string} HTML — safe to put in dangerouslySetInnerHTML.
 */
export function renderMathInPlainText(text) {
  return renderMathInText(collapseBlockMath(text));
}

function renderMathInText(text) {
  let out = '';
  let lastIndex = 0;
  const re = new RegExp(MATH_REGEX.source, MATH_REGEX.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(lastIndex, m.index));
    const isBlock = m[1] !== undefined;
    const content = m[1] ?? m[2];
    try {
      out += katex.renderToString(content, {
        displayMode: isBlock,
        throwOnError: false,
        strict: 'ignore',
        output: 'html',
      });
    } catch {
      out += esc(m[0]);
    }
    lastIndex = m.index + m[0].length;
  }
  out += esc(text.slice(lastIndex));
  return out;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

function sanitizeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^(?:javascript|vbscript|data):/i.test(trimmed)) return '#';
  return trimmed;
}

function isSameTabChatLink(href, variant) {
  if (variant !== 'chat') return false;
  try {
    const url = new URL(href, 'http://localhost');
    return url.hostname === 'connect.composio.dev';
  } catch { return false; }
}

function renderAttrs(attributes) {
  return Object.entries(attributes)
    .flatMap(([key, value]) => {
      if (value === null || value === undefined || value === false) return [];
      if (value === true) return [key];
      return [`${key}="${escAttr(String(value))}"`];
    })
    .join(' ');
}

/** @param {Inline[]} inline @param {RenderOptions} options */
function renderInline(inline, options) {
  let out = '';
  for (const node of inline) {
    if (node.type === 'hardBreak') { out += '<br>'; continue; }
    if (node.type === 'image') {
      if (options.renderImages === false) {
        out += esc(imageMarkdown(node.alt, node.src, { width: node.width, align: node.align }));
        continue;
      }
      const rawSrc = options.resolveImageSrc ? options.resolveImageSrc(node.src) : node.src;
      const safeSrc = sanitizeUrl(rawSrc);
      // Explicit width attr (`{width=N}` / manual resize) wins over the
      // Obsidian alt-text spec (`![alt|640x480](src)`), which renders but
      // never touches the stored bytes.
      const altSize = Number(node.width) > 0 ? null : parseAltSizeSpec(node.alt);
      const width = Number(node.width) > 0
        ? ` width="${Math.round(Number(node.width))}"`
        : altSize
          ? ` width="${altSize.width}"${altSize.height ? ` height="${altSize.height}"` : ''}`
          : '';
      // Center/right alignment needs a block element with auto margins — wrap.
      const align = node.align === 'center' || node.align === 'right' ? node.align : '';
      const img = safeSrc
        ? `<img src="${escAttr(safeSrc)}" alt="${escAttr(node.alt)}"${width}>`
        : esc(node.alt);
      out += align ? `<span class="md-image-align" data-align="${align}">${img}</span>` : img;
      continue;
    }

    const hasCodeMark = node.marks.some((m) => m.type === 'code');
    let html =
      hasCodeMark || options.renderMath === false
        ? esc(node.text)
        : renderMathInText(node.text);
    // Apply marks from innermost to outermost (reverse of source order)
    for (const mark of node.marks) {
      html = applyMark(html, mark, options);
    }
    out += html;
  }
  return out;
}

function applyMark(html, mark, options) {
  switch (mark.type) {
    case 'bold': return `<strong>${html}</strong>`;
    case 'italic': return `<em>${html}</em>`;
    case 'code': return `<code>${html}</code>`;
    case 'strike': return `<s>${html}</s>`;
    case 'highlight': return `<mark>${html}</mark>`;
    case 'underline': return `<u>${html}</u>`;
    case 'subscript': return `<sub>${html}</sub>`;
    case 'superscript': return `<sup>${html}</sup>`;
    case 'link': {
      const safe = sanitizeUrl(mark.href) || '#';
      const attrs = renderAttrs({
        href: safe,
        ...(isSameTabChatLink(safe, options.variant) ? {} : { target: '_blank', rel: 'noreferrer' }),
      });
      return `<a ${attrs}>${html}</a>`;
    }
    case 'wikilink': {
      const attrs = renderAttrs({
        href: '#',
        'data-obsidian-link-type': 'wiki',
        'data-obsidian-target': mark.target,
        'data-obsidian-alias': mark.alias || null,
        'data-obsidian-embed': mark.embed,
      });
      return `<a ${attrs}>${html}</a>`;
    }
    default: return html;
  }
}

/** @param {Block[]} blocks @param {RenderOptions} options */
function renderBlocks(blocks, options) {
  return blocks.map((block) => renderBlock(block, options)).join('');
}

/** @param {Block} block @param {RenderOptions} options */
function renderBlock(block, options) {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${renderInline(block.inline, options)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${renderInline(block.inline, options)}</p>`;
    case 'horizontalRule':
      // data-marker: the editor's markdown-paste path re-parses this HTML via
      // the ProseMirror DOMParser; MarkdownSourceFidelity reads it back so a
      // pasted `***` doesn't degrade to `---` on the next serialization.
      return block.marker ? `<hr data-marker="${escAttr(block.marker)}">` : '<hr>';
    case 'frontmatter':
      // Metadata, not prose — a dimmed raw block (styled via [data-frontmatter])
      // so chat/diff surfaces still show a frontmatter edit without rendering
      // its lines as paragraphs.
      return `<pre data-frontmatter="true"><code>${esc(block.text)}</code></pre>`;
    case 'codeBlock': {
      // data-indented: same paste-path bridge — a pasted 4-space code block
      // stays indented instead of re-serializing fenced.
      const indented = block.indented ? ' data-indented="true"' : '';
      return `<pre${indented}><code class="language-${escAttr(block.language)}">${esc(block.text)}</code></pre>`;
    }
    case 'blockquote':
      return `<blockquote>${renderBlocks(block.children, options)}</blockquote>`;
    case 'callout': {
      const title = block.title || humanizeCalloutType(block.calloutType);
      const titleHtml = `<p>${renderInline(parseInlineTitle(title), options)}</p>`;
      const body = renderBlocks(block.children, options);
      const attrs = renderAttrs({
        'data-callout': block.calloutType,
        // Styling/icon hook: aliases resolve to their canonical type here only —
        // `data-callout` keeps what the user typed so the markdown round-trips.
        'data-callout-resolved': resolveCalloutType(block.calloutType),
        'data-callout-foldable': block.foldable,
        'data-callout-collapsed': block.collapsed,
        'data-callout-title-explicit': block.titleExplicit,
      });
      return `<blockquote ${attrs}>${titleHtml}${body}</blockquote>`;
    }
    case 'bulletList':
    case 'orderedList':
      return renderList(block, options);
    case 'table':
      return renderTable(block, options);
    default:
      return '';
  }
}

// Callout titles are user-provided and may contain inline markdown.
function parseInlineTitle(text) {
  // Single-line input — reuse the block parser to get correct inline parsing.
  const parsed = parseMarkdown(text);
  if (parsed.length === 0) return [];
  const first = parsed[0];
  return first.type === 'paragraph' ? first.inline : [];
}

function renderList(block, options) {
  const tag = block.type === 'orderedList' ? 'ol' : 'ul';
  const start = block.type === 'orderedList' && block.start !== 1 ? ` start="${block.start}"` : '';
  const items = block.items.map((children) => {
    if (children.length === 0) return '<li><p></p></li>';
    // First block of an item is inlined into <li><p>...</p>; subsequent blocks
    // render normally. This matches the editor's existing HTML shape.
    const [first, ...rest] = children;
    const head = first.type === 'paragraph'
      ? `<p>${renderInline(first.inline, options)}</p>`
      : renderBlock(first, options);
    const tail = rest.map((child) => renderBlock(child, options)).join('');
    return `<li>${head}${tail}</li>`;
  }).join('');
  return `<${tag}${start}>${items}</${tag}>`;
}

function renderTable(block, options) {
  const columnCount = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
  const pad = (cells) => cells.concat(
    Array.from({ length: Math.max(0, columnCount - cells.length) }, () => []),
  );
  const aligns = block.align || [];
  // data-align doubles as the paste-path bridge (MarkdownSourceFidelity parses
  // it back into the cell's `align` attr); the style renders the alignment.
  const alignAttr = (col) => {
    const a = aligns[col];
    return a === 'left' || a === 'center' || a === 'right'
      ? ` data-align="${a}" style="text-align: ${a}"` : '';
  };
  const row = (tag, cells) => `<tr>${pad(cells)
    .map((cell, col) => `<${tag}${alignAttr(col)}><p>${renderInline(cell, options)}</p></${tag}>`)
    .join('')}</tr>`;
  const thead = row('th', block.header);
  const tbody = block.rows.map((r) => row('td', r)).join('');
  return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

/**
 * Render markdown to HTML. Primary entrypoint shared by the editor and any
 * frontend consumer that needs HTML output from markdown text.
 *
 * @param {string} text
 * @param {RenderOptions} [options]
 * @returns {string}
 */
export function markdownToHtml(text, options = {}) {
  return renderBlocks(parseMarkdown(collapseBlockMath(text)), options);
}

/**
 * Render only the section of `text` a wiki anchor addresses — the
 * transclusion body for `![[note#…]]` embeds. No anchor renders the whole
 * note; an anchor that doesn't resolve returns null (broken-embed state).
 * Nested `[[…]]` / `![[…]]` inside the section render as plain links (never
 * recursively fetched), so embed depth is 1 by construction.
 *
 * @param {string} text
 * @param {{ heading?: string | null, blockId?: string | null } | null} anchor
 * @param {RenderOptions} [options]
 * @returns {string | null}
 */
export function markdownAnchorHtml(text, anchor, options = {}) {
  const blocks = parseMarkdown(collapseBlockMath(text));
  if (!anchor || (!anchor.heading && !anchor.blockId)) return renderBlocks(blocks, options);
  const range = resolveAnchor(blocks, anchor);
  if (!range) return null;
  return renderBlocks(blocks.slice(range.start, range.end), options);
}

// `$$\n...\n$$` arrives as a multi-line paragraph; flatten it to a single line
// so the inline math regex matches. Inner newlines in math are whitespace to KaTeX.
// Code fences are passed through untouched so literal `$$` in code isn't molested.
function collapseBlockMath(text) {
  let out = '';
  let codeBuf = '';
  let nonCodeBuf = '';
  let inFence = false;
  const flush = () => {
    if (nonCodeBuf) {
      out += nonCodeBuf.replace(/\$\$([\s\S]+?)\$\$/g, (m, inner) =>
        inner.includes('\n') ? `$$${inner.replace(/\s+/g, ' ').trim()}$$` : m);
      nonCodeBuf = '';
    }
    if (codeBuf) { out += codeBuf; codeBuf = ''; }
  };
  for (const line of text.split('\n')) {
    const isFence = /^\s*(```+|~~~+)/.test(line);
    if (isFence) {
      flush();
      inFence = !inFence;
    }
    if (inFence || (isFence && !inFence)) codeBuf += line + '\n';
    else nonCodeBuf += line + '\n';
  }
  flush();
  return out.replace(/\n$/, text.endsWith('\n') ? '\n' : '');
}
