/**
 * Strip markdown syntax from a snippet of message text so rail titles and
 * previews read as prose: leading block markers (blockquote/heading/list) and
 * inline emphasis/code/link syntax drop, keeping the visible text. Underscore
 * emphasis only strips at word boundaries so snake_case identifiers survive.
 */
export function stripMarkdownSyntax(text: string): string {
  return (
    text
      // Fence delimiters (``` / ~~~ lines) carry no prose — drop the line.
      .replace(/^\s*(?:```|~~~).*$/gm, '')
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '') // thematic breaks
      .replace(/^\s*(?:>\s*)+/gm, '') // blockquote markers, nested included
      .replace(/^\s*#{1,6}\s+/gm, '') // ATX headings
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '') // list markers
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → link text
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // aliased wikilinks
      .replace(/\[\[([^\]]+)\]\]/g, '$1') // wikilinks
      .replace(/`([^`]+)`/g, '$1') // inline code
      .replace(/(\*\*|~~)(\S(?:[\s\S]*?\S)?)\1/g, '$2') // bold / strikethrough
      .replace(/\*(\S(?:[^*]*?\S)?)\*/g, '$1') // italics
      .replace(/(?<![\w\\])__(\S(?:[\s\S]*?\S)?)__(?!\w)/g, '$1')
      .replace(/(?<![\w\\])_(\S(?:[^_]*?\S)?)_(?!\w)/g, '$1')
  );
}

/** A concise chat title derived from the first user message: markdown syntax
 *  stripped, whitespace-collapsed, truncated on a word boundary to ~50 chars.
 *  Used to auto-title a chat from its first message (a custom rename then
 *  sticks). */
export function deriveChatTitle(text: string): string {
  const firstLine = stripMarkdownSyntax(text).replace(/\s+/g, ' ').trim();
  if (firstLine.length <= 50) return firstLine;
  const clipped = firstLine.slice(0, 50);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > 24 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
