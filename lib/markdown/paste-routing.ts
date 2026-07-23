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
