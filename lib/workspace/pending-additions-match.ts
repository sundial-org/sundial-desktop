import { parseImageAttrs } from '@/lib/markdown/image-attrs.mjs';

export function stripBlockMarkers(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^>\s+/, '');
}

/** Strip the inline-markdown delimiters that wrap text OUTSIDE of code spans. */
function stripInlineMarkdownDelimiters(text: string): string {
  return text
    // Styled images `![alt](src){…}` → `alt`, but only when the braces are a
    // VALID attribute block — reuse the parser's own `parseImageAttrs` so the
    // two never drift on whitespace/order. An invalid block stays literal and
    // is handled (sans braces) by the plain-image rule below.
    .replace(/!\[([^\]]+)\]\([^)]*\)(\{[^}]*\})/g, (full, alt, block) =>
      parseImageAttrs(block) ? alt : full,
    )
    // Links + plain images: `[text](url)` → `text`, `![alt](src)` → `alt`.
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Wiki / Obsidian links: `[[Page]]` → `Page`, `[[Page|alias]]` → `alias`.
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    // Bold (** or __).
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // Italic (* or _) — applied after bold so we don't eat its delimiters.
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2')
    // Strikethrough (GFM).
    .replace(/~~([^~]+)~~/g, '$1')
    // Highlight (Obsidian `==text==`) — renders as bare text in the block, so
    // the raw `==…==` line must strip to match its ProseMirror block.
    .replace(/==([^=]+)==/g, '$1');
}

/**
 * Strip inline markdown syntax so a raw markdown line matches the rendered
 * `textContent` of a ProseMirror block. Handles links, bold, italic, inline
 * code, strikethrough, and Obsidian highlights.
 *
 * Inline-code spans render their content LITERALLY (only the backticks drop),
 * so we must not strip markdown/`==`/`**` from inside them — otherwise a line
 * like `` use `x==1` here `` would mangle to `use x1 here` and stop matching
 * its block. We split on code spans, strip only the non-code segments, and keep
 * code content verbatim.
 *
 * Example: `Sundial works on [LaTeX](paper.tex) and **code**.` →
 *          `Sundial works on LaTeX and code.`
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .split(/(`[^`]+`)/g)
    .map((part, i) =>
      i % 2 === 1 ? part.slice(1, -1) : stripInlineMarkdownDelimiters(part),
    )
    .join('');
}

/**
 * Normalize a source line for inline word-diff matching. Markdown buffers strip
 * block + inline markdown so a raw line matches the rendered ProseMirror text;
 * code / LaTeX buffers compare raw (trim only) so backslash macros, `%` comments,
 * `*`-form environments, and `_` subscripts aren't mangled by markdown stripping.
 */
export function normalizeForDiff(line: string, options?: { markdown?: boolean }): string {
  const stripMarkdown = options?.markdown ?? true;
  return (stripMarkdown ? stripInlineMarkdown(stripBlockMarkers(line)) : line).trim();
}

// NOTE: the block/anchor text-matchers that used to live here
// (matchPendingAdditionBlocks / matchPendingDeletionAnchors) were removed once
// the markdown editor switched to inline suggestion MARKS — the overlay they
// fed no longer exists. Only the normalization helpers above survive; they are
// shared by the inline word-diff and the code editor.
