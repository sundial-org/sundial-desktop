/** A concise chat title derived from the first user message: first line,
 *  whitespace-collapsed, truncated on a word boundary to ~50 chars. Used to
 *  auto-title a chat from its first message (a custom rename then sticks). */
export function deriveChatTitle(text: string): string {
  const firstLine = text.replace(/\s+/g, ' ').trim();
  if (firstLine.length <= 50) return firstLine;
  const clipped = firstLine.slice(0, 50);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > 24 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
