/* ── Inline-ask context extraction ────────────────────────────────────
 *  Ask-Sunny / "/ai" turns (and composer snippet sends) prepend machine
 *  context to the message body: markdown blockquote anchor(s) built by
 *  formatSnippetBlock, optionally followed by a "My cursor is …" note.
 *  Sunny needs that text verbatim, but the transcript shouldn't show it
 *  raw — this parser splits it back out so the chat bubble can render a
 *  compact context chip instead. Recognizes ONLY the generated shape
 *  (path header / cursor note); a hand-typed "> quote" is left alone.
 * ─────────────────────────────────────────────────────────────────── */

export type InlineAskSnippet = { path: string | null; quote: string };

export type InlineAskContext = {
  snippets: InlineAskSnippet[];
  /** The caret-position sentence, when present. */
  note: string | null;
  /** The user's actual instruction. */
  body: string;
};

const PATH_HEADER = /^> _(?:from|in) `([^`]+)`:?_$/;
const CURSOR_NOTE = /^My cursor is .+/;

/** Split generated anchor context from a user message. Returns null when the
 *  message doesn't start with the generated shape (then render it verbatim). */
export function splitInlineAskContext(text: string): InlineAskContext | null {
  const lines = text.split('\n');
  const snippets: InlineAskSnippet[] = [];
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) {
    const header = lines[i].match(PATH_HEADER);
    const path = header ? header[1] : null;
    if (header) i++;
    const quote: string[] = [];
    while (i < lines.length && lines[i].startsWith('>')) {
      quote.push(lines[i].replace(/^> ?/, ''));
      i++;
    }
    snippets.push({ path, quote: quote.join('\n').trim() });
    // A blank line followed by another blockquote is the next snippet.
    if (lines[i] === '' && lines[i + 1]?.startsWith('>')) i++;
  }
  while (lines[i] === '') i++;
  let note: string | null = null;
  if (i < lines.length && CURSOR_NOTE.test(lines[i])) {
    note = lines[i];
    i++;
    while (lines[i] === '') i++;
  }
  const body = lines.slice(i).join('\n').trim();
  // Generated context always carries a path header or a cursor note; a bare
  // hand-typed quote has neither. And with no body left there's nothing to
  // collapse under a chip.
  if (!note && !snippets.some((s) => s.path)) return null;
  if (!body) return null;
  return { snippets, note, body };
}
