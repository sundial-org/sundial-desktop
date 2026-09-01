import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { markdownToHtml } from '@/lib/markdown/html.mjs';
import { proseMirrorToMarkdown } from '@/lib/markdown/serializer';
import { resolveWorkspaceImageSrc } from '@/lib/workspace/image-src';
import { nodeHasPendingSuggestion } from '@/lib/workspace/suggestion-marks';

/**
 * Obsidian-style live preview for raw HTML, following the editor's
 * math/image/mermaid convention: the HTML stays LITERAL TEXT in the document
 * — the codec, sync, diffs and suggestion flows never see anything but plain
 * paragraphs — and this extension overlays a rendered preview as a decoration.
 * Selection outside the paragraph → sandboxed preview; cursor inside (or the
 * edit chip) → the source, exactly like mermaid's click-to-edit.
 *
 * SECURITY — same boundary as components/workspace/viewers/html-viewer.tsx:
 * workspace HTML is untrusted (Sunny, local agents, and any collaborator can
 * write it), so the preview runs in an opaque-origin `srcDoc` iframe. Never
 * add `allow-same-origin` (with `allow-scripts` that grants the content full
 * XSS on the app origin) or `allow-popups-to-escape-sandbox`. The host page
 * only ever consumes a clamped height number from the frame.
 */

export const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-popups';
const MIN_HEIGHT = 24;
const MAX_HEIGHT = 1600;

// Tags whose paragraph-leading appearance reads as "this paragraph is HTML".
// Inline-formatting tags (u/sub/sup/mark/br/span…) are deliberately absent so
// prose that merely starts with one keeps rendering as text. Hyphenated tags
// are custom elements and always count.
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'audio', 'blockquote', 'canvas', 'center',
  'details', 'dialog', 'div', 'dl', 'embed', 'fieldset', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'iframe', 'img',
  'main', 'nav', 'object', 'ol', 'p', 'pre', 'script', 'section', 'style',
  'summary', 'svg', 'table', 'ul', 'video',
]);

// Void tags never close, so an unclosed opener must not trigger the
// forward scan for a balancing block.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** True when a paragraph's source text should preview as rendered HTML. */
export function isHtmlSource(source: string): boolean {
  let line = source.trimStart();
  // Leading closed comments decide nothing — classify what follows them, so
  // `<!-- note -->plain prose` stays prose. Comment-only content (closed or
  // unterminated) has nothing to render and keeps its source visible.
  while (line.startsWith('<!--')) {
    const end = line.indexOf('-->');
    if (end === -1) return false;
    line = line.slice(end + 3).trimStart();
  }
  const m = line.match(/^<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])/);
  if (!m) return false;
  const tag = m[1].toLowerCase();
  return tag.includes('-') || BLOCK_TAGS.has(tag);
}

// --------------------------------------------------------------------------
// JSX → HTML normalization. MDX posts carry attributes a browser can't parse
// (`className`, `style={{…}}`, `width={320}`). The doc keeps the JSX verbatim;
// only the preview's srcdoc is normalized. Applied to every raw-HTML block:
// each rewritten pattern is invalid HTML to begin with, so this can only
// improve what the frame shows.
// --------------------------------------------------------------------------

const CSS_UNITLESS = new Set([
  'flex', 'flex-grow', 'flex-shrink', 'font-weight', 'line-height', 'opacity',
  'order', 'scale', 'z-index', 'zoom',
]);

// `{ position: 'relative', width: 'max(100%, 60vw)' }` → CSS text. Splits on
// top-level commas only (function args stay intact); JSX bare numbers mean px
// except for unitless properties. Expression values (ternaries, vars) can't be
// evaluated statically and are dropped.
function styleObjectToCss(body: string): string {
  const entries: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      entries.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  entries.push(current);

  const decls: string[] = [];
  for (const entry of entries) {
    const m = entry.match(/^\s*(['"]?)([A-Za-z][\w-]*)\1\s*:\s*([\s\S]*?)\s*$/);
    if (!m) continue;
    const key = m[2].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const raw = m[3];
    const quoted = raw.match(/^(['"])([\s\S]*)\1$/);
    let value: string | null = null;
    if (quoted) value = quoted[2];
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = CSS_UNITLESS.has(key) ? raw : `${raw}px`;
    if (value) decls.push(`${key}:${value}`);
  }
  return decls.join(';');
}

// One `attr={expr}` → its HTML form, or null to drop the attribute (arbitrary
// expressions can't run in a static preview).
function jsxAttrToHtml(name: string, expr: string): string | null {
  const value = expr.trim();
  if (value.startsWith('{') && value.endsWith('}')) {
    if (name !== 'style') return null;
    const css = styleObjectToCss(value.slice(1, -1));
    return css ? `style="${css.replace(/"/g, '&quot;')}"` : null;
  }
  const quoted = value.match(/^(['"])([\s\S]*)\1$/);
  if (quoted) return `${name}="${quoted[2].replace(/"/g, '&quot;')}"`;
  if (/^-?\d+(\.\d+)?$/.test(value)) return `${name}="${value}"`;
  if (value === 'true') return name;
  return null;
}

// Positional stand-in for a tag with its quoted attribute values blanked, so a
// literal `data-x="foo={1}"` can't be read as a JSX expression. Quotes inside
// `{…}` are part of the expression and stay. Indices map 1:1 onto the original.
function maskAttrValues(tag: string): string {
  let out = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of tag) {
    if (quote) {
      out += depth > 0 ? ch : ' ';
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    out += ch;
  }
  return out;
}

/** One start tag → HTML: `attr={expr}` resolved or dropped, `className` → `class`. */
function normalizeTagAttrs(tag: string): string {
  const masked = maskAttrValues(tag);
  const attrOpen = /([A-Za-z_][\w-]*)\s*=\s*\{/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = attrOpen.exec(masked))) {
    // Balanced-brace scan from the `{`, skipping quoted strings.
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = attrOpen.lastIndex - 1; i < tag.length; i += 1) {
      const ch = tag[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break; // unbalanced — leave the tail untouched
    out += tag.slice(last, m.index);
    const attr = jsxAttrToHtml(m[1], tag.slice(attrOpen.lastIndex, end));
    if (attr) out += attr;
    else out = out.replace(/[ \t]+$/, ''); // dropped attr: its leading space too
    last = end + 1;
    attrOpen.lastIndex = end + 1;
  }
  out += tag.slice(last);
  return renameClassName(out);
}

// `className` → `class`, but only where it is a real attribute NAME: preceded
// by whitespace and outside any quoted value. A blanket replace would rewrite
// `data-className="x"` and a literal `className=` sitting inside an authored
// attribute value, and would miss the spaced `className = "x"` JSX form.
function renameClassName(tag: string): string {
  const masked = maskAttrValues(tag);
  const name = /(\s)className(?=\s*=)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = name.exec(masked))) {
    const at = m.index + m[1].length;
    out += tag.slice(last, at) + 'class';
    last = at + 'className'.length;
  }
  return out + tag.slice(last);
}

// Raw-text elements: their bodies are code or literal text, never markup —
// `const x = {foo: 1}` is not a JSX attribute, and an `<img src=…>` typed into
// a <textarea> is not an image. Both normalizers below step over them.
const RAW_TEXT = String.raw`<(script|style|textarea|title)\b[\s\S]*?<\/\1\s*>`;
// One tag — quoted values and `{…}` attribute expressions may both contain `>`.
const RAW_TEXT_OR_TAG = new RegExp(
  `${RAW_TEXT}|` + String.raw`<\/?[A-Za-z][\w.-]*(?:"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\}|[^>])*>`,
  'gi',
);

/** Normalize JSX-flavored source into previewable HTML. Only tags are touched. */
export function jsxToHtml(source: string): string {
  // JSX comments have no HTML meaning (in text — a `{/*…*/}` in JS is code).
  const stripComments = (text: string) => text.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
  let out = '';
  let last = 0;
  for (const m of source.matchAll(RAW_TEXT_OR_TAG)) {
    out += stripComments(source.slice(last, m.index)) + (m[1] ? m[0] : normalizeTagAttrs(m[0]));
    last = m.index + m[0].length;
  }
  return out + stripComments(source.slice(last));
}

// --------------------------------------------------------------------------
// Workspace media. The frame is opaque-origin, so the cookie-authed preview
// proxy is unreachable from INSIDE it — the host fetches workspace-relative
// srcs (same-origin, credentialed) and swaps them in as data: URLs. Site-root
// `/hero.jpg` paths (Next-style public/ assets) try `public/hero.jpg` first.
// --------------------------------------------------------------------------

// `filePath` may be a getter: a rename keeps the editor (and this extension)
// mounted, so a captured string would resolve `./hero.png` against the old
// directory until a full remount.
export type HtmlPreviewOptions = {
  workspaceId?: string;
  filePath?: string | (() => string | null | undefined);
};

const MAX_INLINE_MEDIA_BYTES = 25 * 1024 * 1024;
// src/poster on PASSIVE media tags only, in any HTML quoting form. Credentialed
// bytes must never reach an active element: `<iframe src="private.md">` would
// run them as a document, `<script src=…>` as code.
const RAW_TEXT_OR_MEDIA_TAG = new RegExp(
  `${RAW_TEXT}|` + String.raw`<(?:img|video|audio|source|track)\b(?:"[^"]*"|'[^']*'|[^>])*>`,
  'gi',
);
const MEDIA_ATTR = /(\s(?:src|poster)\s*=\s*)(?:(["'])([^"']*)\2|([^\s"'=<>`]+))/gi;
// Not a content cache — just a short window that coalesces the re-resolutions a
// decoration rebuild storm triggers (an edit above a region recreates its
// widget). The proxy redirects to the CURRENT blob and re-authorizes on every
// request, so entries must expire fast and key on the resolved URL, which
// carries the workspace, the path, and any share/sidecar token.
const MEDIA_TTL_MS = 5_000;
const mediaCache = new Map<string, { at: number; url: Promise<string | null> }>();

/** Walk every media src/poster; `map` returns a replacement URL, or null to
 *  leave the attribute exactly as authored. */
function rewriteMedia(html: string, map: (src: string) => string | null): string {
  return html.replace(RAW_TEXT_OR_MEDIA_TAG, (segment, raw: string) =>
    raw ? segment : segment.replace(
      MEDIA_ATTR,
      (full, pre: string, quote: string, quoted: string, bare: string) => {
        const url = map(((quote ? quoted : bare) ?? '').trim());
        return url == null ? full : `${pre}"${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
      },
    ),
  );
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Candidate workspace paths for a src, most specific first. A src is a URL:
 *  `./My%20Plot.png?v=2` names the stored path `My Plot.png`. */
export function mediaCandidates(src: string, fileDir: string): string[] {
  const bare = src.replace(/[?#].*$/, '');
  let path = bare;
  try {
    path = decodeURIComponent(bare);
  } catch {
    /* malformed escape — take the src literally */
  }
  const candidates = path.startsWith('/')
    ? [`public/${path.slice(1)}`, path.slice(1)]
    : [fileDir ? `${fileDir}/${path}` : path, path];
  return [...new Set(candidates.map(normalizePath).filter(Boolean))];
}

function isWorkspaceRelativeSrc(value: string): boolean {
  return !!value && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/api\/)/i.test(value);
}

function fetchAsDataUrl(url: string): Promise<string | null> {
  return fetch(url)
    .then((res) => {
      if (!res.ok) return null;
      // Don't materialize an oversized asset just to discard it below.
      if (Number(res.headers.get('content-length')) > MAX_INLINE_MEDIA_BYTES) {
        res.body?.cancel();
        return null;
      }
      return res.blob();
    })
    .then((blob) => {
      if (!blob || blob.size > MAX_INLINE_MEDIA_BYTES) return null;
      return new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    })
    .catch(() => null);
}

// Sidecar loopback URLs carry their token in the query, so the frame can use
// them directly — but probe first so a missing candidate falls through to the
// next, like the cloud path does.
function probeUrl(url: string): Promise<string | null> {
  return fetch(url)
    .then((res) => {
      res.body?.cancel();
      return res.ok ? url : null;
    })
    .catch(() => null);
}

/** Directory the open document lives in — what `./media` resolves against. */
function currentFileDir(opts: HtmlPreviewOptions): string {
  const path = (typeof opts.filePath === 'function' ? opts.filePath() : opts.filePath) ?? '';
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

async function resolveMediaUrl(src: string, opts: HtmlPreviewOptions): Promise<string | null> {
  for (const path of mediaCandidates(src, currentFileDir(opts))) {
    const resolved = resolveWorkspaceImageSrc(path, opts.workspaceId);
    const key = resolved;
    const hit = mediaCache.get(key);
    let pending = hit && Date.now() - hit.at < MEDIA_TTL_MS ? hit.url : null;
    if (!pending) {
      // Sweep before inserting: an expired entry still pins its whole data URL
      // (megabytes of base64) until something looks the SAME url up again, so a
      // doc full of distinct images would retain every one of them.
      const now = Date.now();
      for (const [k, v] of mediaCache) if (now - v.at >= MEDIA_TTL_MS) mediaCache.delete(k);
      if (mediaCache.size >= 64) mediaCache.delete(mediaCache.keys().next().value as string);
      pending = /^https?:/i.test(resolved)
        ? probeUrl(resolved)
        : resolved.startsWith('/') ? fetchAsDataUrl(resolved) : Promise.resolve(null);
      mediaCache.set(key, { at: Date.now(), url: pending });
    }
    const url = await pending;
    if (url) return url;
    mediaCache.delete(key); // don't pin failures — the file may appear later
  }
  return null;
}

/** Swap workspace-relative src/poster refs in the composed srcdoc for URLs the
 *  opaque-origin frame can actually load. Unresolvable refs stay untouched. */
async function resolveWorkspaceMedia(srcdoc: string, opts: HtmlPreviewOptions): Promise<string> {
  if (!opts.workspaceId) return srcdoc;
  const refs = new Set<string>();
  rewriteMedia(srcdoc, (src) => {
    if (isWorkspaceRelativeSrc(src)) refs.add(src);
    return null;
  });
  if (refs.size === 0) return srcdoc;
  const resolved = new Map<string, string>();
  await Promise.all(
    [...refs].map(async (src) => {
      const url = await resolveMediaUrl(src, opts);
      if (url) resolved.set(src, url);
    }),
  );
  if (resolved.size === 0) return srcdoc;
  return rewriteMedia(srcdoc, (src) => resolved.get(src) ?? null);
}

// Rebuild the paragraph's markdown-ish source from its inline content, so the
// preview shows what the file holds (`**bold**` stays literal asterisks inside
// raw HTML, per CommonMark). UI-only reconstruction — the document itself is
// never read back through this.
const MARK_WRAP: Record<string, [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  code: ['`', '`'],
  strike: ['~~', '~~'],
  highlight: ['==', '=='],
  underline: ['<u>', '</u>'],
  subscript: ['<sub>', '</sub>'],
  superscript: ['<sup>', '</sup>'],
};

// findHtmlRegions re-derives every top-level paragraph's source on every doc
// change; nodes are immutable, so unchanged paragraphs (the vast majority of a
// keystroke's doc) hit this cache instead of re-flattening — the scan's cost
// becomes O(changed blocks), not O(doc).
const paragraphSourceCache = new WeakMap<ProseMirrorNode, string>();

export function paragraphSource(node: ProseMirrorNode): string {
  const cached = paragraphSourceCache.get(node);
  if (cached !== undefined) return cached;
  const source = computeParagraphSource(node);
  paragraphSourceCache.set(node, source);
  return source;
}

function computeParagraphSource(node: ProseMirrorNode): string {
  let out = '';
  node.forEach((child) => {
    if (child.type.name === 'hardBreak') {
      const marker = (child.attrs?.marker as string | null) ?? '';
      out += /^<br/i.test(marker) ? marker : '\n';
      return;
    }
    let text = child.text ?? '';
    for (const mark of child.marks ?? []) {
      const wrap = MARK_WRAP[mark.type.name];
      if (wrap) text = `${wrap[0]}${text}${wrap[1]}`;
      else if (mark.type.name === 'link') {
        // Mirror the shared serializer's wiki handling so `[[Page|Alias]]`
        // reconstructs as itself, not as `[Alias](#)`.
        const a = (mark.attrs ?? {}) as {
          href?: string; obsidianType?: string | null;
          obsidianTarget?: string | null; obsidianAlias?: string | null; obsidianEmbed?: boolean;
        };
        if (a.obsidianType === 'wiki') {
          const target = (a.obsidianTarget ?? '').trim() || text;
          const alias = (a.obsidianAlias ?? '').trim() || (text !== target ? text : '');
          text = `${a.obsidianEmbed ? '!' : ''}[[${target}${alias ? `|${alias}` : ''}]]`;
        } else {
          text = `[${text}](${a.href ?? ''})`;
        }
      }
    }
    out += text;
  });
  return out;
}

// Wrap the source in a minimal document that reports its content height to
// the parent. The content is untrusted: it may swallow the reporter (an
// unclosed <script>) or lie about heights — both degrade to the clamped
// default, never to a capability.
//
// Theme bridge: the frame is an opaque origin, so the workspace theme can't
// reach in via CSS — instead the body gets a transparent background plus the
// theme's text color (snapshotted at build time; a theme flip rebuilds widgets
// on the next repaint), so agent-authored HTML that inherits color/background
// looks native in both light and dark. Exported for the `![[page.html]]`
// embed frame (embed-preview.ts), which must render identically.
//
// A `nonce` marks a frame carrying CREDENTIALED bytes (inlined workspace media,
// or a token-bearing sidecar URL) — a path-share guest can write a doc that
// references files they themselves can't read, so those bytes must not be
// readable BACK OUT of the frame. Nothing else there is trusted: the script-src
// nonce kills every authored script path (tags, `on*` handlers, `javascript:`
// URLs) while our reporter keeps running, and denying every other fetch stops
// authored CSS from probing `img[src^=…]` and phoning the answer home through a
// background image. Frames without media stay unrestricted.
const MEDIA_SOURCES = 'data: blob: http://127.0.0.1:* http://localhost:* http://[::1]:*';

export function wrapHtmlPreviewSrcDoc(source: string, token: string, dark: boolean, nonce = '') {
  const csp = nonce
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; `
      + `img-src ${MEDIA_SOURCES}; media-src ${MEDIA_SOURCES}; style-src 'unsafe-inline'; `
      + `font-src data:; script-src 'nonce-${nonce}'">`
    : '';
  const reporter = `<script${nonce ? ` nonce="${nonce}"` : ''}>(function(){var s=function(){parent.postMessage({sdHtmlPreview:'${token}',h:document.documentElement.scrollHeight},'*')};if(window.ResizeObserver)new ResizeObserver(s).observe(document.body);addEventListener('load',s);s()})()</script>`;
  // Light keeps a transparent canvas (embedded default scheme matches the
  // page, so the iframe stays see-through). Dark paints the workspace's dark
  // page color explicitly: browsers force an OPAQUE WHITE canvas whenever the
  // embedded document's used color-scheme mismatches the embedder's, and any
  // build/flip ordering hiccup would flash white-on-dark — an explicit
  // background can't. #1b1917 = the dark theme's --color-stone-50 page.
  const theme = dark
    ? 'color:#e7e5e4;background:#1b1917;color-scheme:dark'
    : 'color:#1c1917;background:transparent;color-scheme:light';
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>body{margin:8px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:15px;${theme}}</style></head><body>${source}${reporter}</body></html>`;
}

export const isDarkTheme = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

// --------------------------------------------------------------------------
// Region detection. A paragraph that OPENS a tag it doesn't close (the
// blank-line `<details>…</details>` pattern splits the HTML across several
// blocks — CommonMark parses the interior as markdown) extends its region
// forward to the block whose source balances the root tag. Interior blocks
// render as markdown inside the frame, matching Obsidian's reading view.
// --------------------------------------------------------------------------

const MAX_REGION_BLOCKS = 100;

// Review state that lives in OTHER plugins' decorations rather than in node
// marks/attrs — doc-comment ranges are painted this way, so
// nodeHasPendingSuggestion can't see them. Hiding a commented paragraph
// behind the iframe would hide its highlight until someone happened to click
// in. Matched on the decoration's class.
const REVIEW_DECORATION_CLASS = /doc-comment|suggestion|review|attribution/;

/** True when another plugin paints review/comment state anywhere in [from,to]. */
function hasReviewDecoration(state: EditorState, from: number, to: number): boolean {
  for (const plugin of state.plugins) {
    // Skip ourselves: our own decorations are the preview, not review state.
    if (plugin.spec?.key === htmlPreviewKey) continue;
    const set = plugin.props?.decorations?.call(plugin, state) as DecorationSet | undefined;
    if (!set || typeof set.find !== 'function') continue;
    for (const deco of set.find(from, to)) {
      const cls = (deco as unknown as { type?: { attrs?: { class?: string } } }).type?.attrs?.class;
      if (typeof cls === 'string' && REVIEW_DECORATION_CLASS.test(cls)) return true;
    }
  }
  return false;
}

// Cheap stable content hash (djb2) for widget identity keys.
function hashSource(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

// Net open-minus-close count for `tag` in a source string. Self-closing forms
// (`<tag …/>`) don't open anything. Comments and quoted attribute/string
// values are blanked first — `<!-- </div> -->` or title="</div>" contain
// tag-LIKE text, not tokens, and counting them truncates the region.
function tagDepthDelta(source: string, tag: string): number {
  const scrubbed = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/"[^"\n]*"/g, '""')
    .replace(/'[^'\n]*'/g, "''");
  const opens = (scrubbed.match(new RegExp(`<${tag}(?=[\\s/>])`, 'gi')) ?? []).length;
  const selfClosing = (scrubbed.match(new RegExp(`<${tag}[^<>]*/>`, 'gi')) ?? []).length;
  const closes = (scrubbed.match(new RegExp(`</${tag}\\s*>`, 'gi')) ?? []).length;
  return opens - selfClosing - closes;
}

function rootTag(source: string): string | null {
  const m = source.trimStart().match(/^(?:<!--[\s\S]*?-->\s*)*<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])/);
  return m ? m[1].toLowerCase() : null;
}

// Markdown source of a non-paragraph block, for rendering the interior. The
// serializer wants a doc root; wrap defensively and fall back to plain text.
function blockMarkdown(node: ProseMirrorNode): string {
  try {
    const doc = node.type.schema.topNodeType.create(null, [node]);
    return proseMirrorToMarkdown(doc);
  } catch {
    return node.textContent;
  }
}

type HtmlRegion = {
  from: number;
  to: number;
  blocks: Array<{ pos: number; end: number; node: ProseMirrorNode }>;
  /** Composed HTML for the iframe: raw HTML paragraphs verbatim, interior markdown rendered. */
  srcdoc: string;
  /** Verbatim single-paragraph source (used as part of the widget identity key). */
  key: string;
};

function findHtmlRegions(doc: ProseMirrorNode): HtmlRegion[] {
  const children: Array<{ pos: number; end: number; node: ProseMirrorNode }> = [];
  doc.forEach((node, offset) => {
    children.push({ pos: offset, end: offset + node.nodeSize, node });
  });

  const regions: HtmlRegion[] = [];
  let i = 0;
  while (i < children.length) {
    const child = children[i];
    if (child.node.type.name !== 'paragraph') { i += 1; continue; }
    const source = paragraphSource(child.node);
    if (!isHtmlSource(source)) { i += 1; continue; }

    const tag = rootTag(source);
    let endIndex = i;
    if (tag && !VOID_TAGS.has(tag) && tagDepthDelta(source, tag) > 0) {
      // Unclosed root tag — scan forward for the block that balances it.
      let depth = tagDepthDelta(source, tag);
      for (let j = i + 1; j < children.length && j - i < MAX_REGION_BLOCKS; j += 1) {
        const b = children[j];
        if (b.node.type.name === 'paragraph') depth += tagDepthDelta(paragraphSource(b.node), tag);
        if (depth <= 0) { endIndex = j; break; }
      }
      // No closer found → fall back to previewing the opener alone.
    }

    const blocks = children.slice(i, endIndex + 1);
    const parts = blocks.map(({ node }) => {
      if (node.type.name === 'paragraph') {
        const src = paragraphSource(node);
        // Raw HTML lines pass through (JSX-normalized); prose paragraphs inside
        // the region render as markdown (KaTeX needs its CSS, so math stays text).
        return src.trimStart().startsWith('<') ? jsxToHtml(src) : markdownToHtml(src, { renderMath: false });
      }
      return markdownToHtml(blockMarkdown(node), { renderMath: false });
    });

    const srcdoc = parts.join('\n');
    regions.push({
      from: blocks[0].pos,
      to: blocks[blocks.length - 1].end,
      blocks,
      srcdoc,
      // The key must cover the COMPOSED content: a collaborator editing an
      // interior block while the local selection is elsewhere must produce a
      // new key, or ProseMirror reuses the old iframe and its stale srcdoc.
      key: `${blocks[0].pos}:${blocks.length}:${hashSource(srcdoc)}`,
    });
    i = endIndex + 1;
  }
  return regions;
}

const selectionTouches = (selection: Selection, from: number, to: number) =>
  selection.from <= to && selection.to >= from;

type BlockSnapshot = { pos: number; end: number; editing: boolean; reviewed: boolean };
type PluginState = { decorations: DecorationSet; blocks: BlockSnapshot[] };

export const htmlPreviewKey = new PluginKey<PluginState>('htmlPreview');

let tokenSeq = 0;

const HtmlPreviewPlugin = (editor: Editor, options: HtmlPreviewOptions) => {
  let view: EditorView | null = null;

  const buildPreviewEl =
    (source: string) => (_view: EditorView, getPos: () => number | undefined) => {
      const el = document.createElement('div');
      el.className = 'sd-html-preview';
      el.contentEditable = 'false';

      const token = `sd-html-${++tokenSeq}`;
      const iframe = document.createElement('iframe');
      iframe.className = 'sd-html-preview-frame';
      iframe.setAttribute('sandbox', HTML_PREVIEW_SANDBOX);
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.title = 'HTML preview';
      // One theme snapshot for both paints: a flip rebuilds the widget (the
      // key carries the theme), so the async media swap must not re-read it
      // and repaint this frame in the other theme.
      const dark = isDarkTheme();
      iframe.srcdoc = wrapHtmlPreviewSrcDoc(source, token, dark);

      let disposed = false;
      resolveWorkspaceMedia(source, options).then((resolved) => {
        if (!disposed && resolved !== source) {
          iframe.srcdoc = wrapHtmlPreviewSrcDoc(resolved, token, dark, crypto.randomUUID());
        }
      });

      const onMessage = (event: MessageEvent) => {
        const data = event.data as { sdHtmlPreview?: string; h?: number } | null;
        if (!data || data.sdHtmlPreview !== token || typeof data.h !== 'number') return;
        iframe.style.height = `${Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(data.h)))}px`;
      };
      window.addEventListener('message', onMessage);
      (el as HTMLElement & { sdCleanup?: () => void }).sdCleanup = () => {
        disposed = true;
        window.removeEventListener('message', onMessage);
      };

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sd-html-preview-edit';
      chip.textContent = 'HTML';
      chip.title = 'Edit HTML source';
      chip.addEventListener('mousedown', (event) => {
        const pos = getPos();
        if (view == null || view.isDestroyed || !editor.isEditable || pos == null) return;
        event.preventDefault();
        const { doc } = view.state;
        const $inside = doc.resolve(Math.min(pos + 1, doc.content.size));
        view.dispatch(view.state.tr.setSelection(TextSelection.near($inside)));
        view.focus();
      });

      el.append(iframe, chip);
      return el;
    };

  const build = (state: EditorState): PluginState => {
    const regions = findHtmlRegions(state.doc);
    if (regions.length === 0) return { decorations: DecorationSet.empty, blocks: [] };

    const isEditable = editor.isEditable;
    const decos: Decoration[] = [];
    const snapshots: BlockSnapshot[] = [];
    for (const region of regions) {
      const isEditing = isEditable && selectionTouches(state.selection, region.from, region.to);
      const reviewed = hasReviewDecoration(state, region.from, region.to);
      snapshots.push({ pos: region.from, end: region.to, editing: isEditing, reviewed });
      // Editing anywhere in the region reveals ALL its source; pending
      // suggestions (marks/attrs) and decoration-borne review state
      // (doc-comment ranges) must be reviewable as source too.
      if (
        isEditing
        || reviewed
        || region.blocks.some(({ node }) => nodeHasPendingSuggestion(node))
      ) continue;
      for (const { pos, end } of region.blocks) {
        decos.push(Decoration.node(pos, end, { class: 'sd-html-source-hidden' }));
      }
      decos.push(
        // Theme in the key: a light/dark flip must mint a new widget (and thus
        // a new srcdoc with the flipped theme bridge), not reuse the old DOM.
        // The file's directory too — a move re-points every relative `./media`
        // ref, and the resolved bytes are baked into the frame.
        Decoration.widget(region.from, buildPreviewEl(region.srcdoc), {
          key: `sd-html:${isDarkTheme() ? 'd' : 'l'}:${currentFileDir(options)}:${region.key}`,
          side: -1,
          destroy: (node) => (node as HTMLElement & { sdCleanup?: () => void }).sdCleanup?.(),
        }),
      );
    }
    return { decorations: DecorationSet.create(state.doc, decos), blocks: snapshots };
  };

  return new Plugin<PluginState>({
    key: htmlPreviewKey,
    state: {
      init: (_config, state) => build(state),
      apply(tr, previous, _old, newState) {
        if (!tr.docChanged && !tr.getMeta(htmlPreviewKey)) {
          if (previous.blocks.length === 0) return previous;
          // Positions are unchanged, so only re-derive the two things that can
          // flip without a doc change: the editing reveal, and review state —
          // comment ranges arrive on METADATA-ONLY transactions of another
          // plugin, which would otherwise leave a stale preview hiding a fresh
          // highlight. Bounded by region count; the sources are cached.
          const isEditable = editor.isEditable;
          const unchanged = previous.blocks.every(
            (b) =>
              (isEditable && selectionTouches(newState.selection, b.pos, b.end)) === b.editing
              && hasReviewDecoration(newState, b.pos, b.end) === b.reviewed,
          );
          if (unchanged) return previous;
        }
        return build(newState);
      },
    },
    view(editorView: EditorView) {
      view = editorView;
      // setEditable() doesn't dispatch a transaction — nudge a repaint so the
      // editing-reveal recomputes. Same for a light/dark flip (a class toggle
      // on <html>): the srcdoc theme bridge is baked in, so previews rebuild.
      let lastEditable = editor.isEditable;
      let lastDir = currentFileDir(options);
      const repaint = () => {
        if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(htmlPreviewKey, true));
      };
      let lastTheme = isDarkTheme();
      const themeObserver =
        typeof MutationObserver === 'undefined'
          ? null
          : new MutationObserver(() => {
              if (isDarkTheme() !== lastTheme) {
                lastTheme = isDarkTheme();
                repaint();
              }
            });
      themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return {
        update: (v: EditorView) => {
          if (v.editable !== lastEditable) {
            lastEditable = v.editable;
            repaint();
            return;
          }
          // A rename/move changes what `./media` points at without touching the
          // doc; the resolved bytes are baked into each frame, so rebuild.
          const dir = currentFileDir(options);
          if (dir !== lastDir) {
            lastDir = dir;
            repaint();
            return;
          }
          // Plugins installed AFTER this one (comment ranges, attribution)
          // apply their state later in the same transaction, so the check in
          // `apply` can read their PREVIOUS decorations. This runs once the
          // state is fully applied — the authoritative read. Idempotent: after
          // the repaint the snapshot matches and no further dispatch happens.
          const snapshot = htmlPreviewKey.getState(v.state);
          if (
            snapshot?.blocks.some((b) => hasReviewDecoration(v.state, b.pos, b.end) !== b.reviewed)
          ) {
            repaint();
          }
        },
        destroy: () => {
          themeObserver?.disconnect();
          view = null;
        },
      };
    },
    props: {
      decorations(state: EditorState) {
        return htmlPreviewKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
};

export const HtmlPreview = Extension.create<HtmlPreviewOptions>({
  name: 'htmlPreview',

  addOptions() {
    return { workspaceId: undefined, filePath: undefined };
  },

  addProseMirrorPlugins() {
    return [HtmlPreviewPlugin(this.editor, this.options)];
  },
});

export default HtmlPreview;
