/* ── Comment-delivery events ──────────────────────────────────────────
 *  A doc comment that wakes an agent lands as a role:'user' message whose
 *  text is the machine shape built by formatCommentEventMessage (cloud) /
 *  commentMessage (sidecar). The transcript renders it as an event card, so
 *  it needs the pieces back: rows written after Aug 2026 carry them in
 *  `metadata.comment`; older rows are parsed out of the content string.
 *  The trailing "Address this comment…" instruction is model-only — never UI.
 * ─────────────────────────────────────────────────────────────────── */

export type CommentEvent = {
  filePath: string;
  quote: string;
  authorName: string;
  body: string;
  isNewThread: boolean;
  /** The run gate blocked after delivery and the retraction failed — no agent
   *  will answer this event; the card says so instead of looking dropped. */
  blocked?: boolean;
};

const HEADER =
  /^\[(Comment|Reply) on (.+?)\] (.+?) \(thread [^,]+, quoted: "([\s\S]*?)"\):\n/;
const INSTRUCTION = /\n\s*\nAddress this comment[\s\S]*$/;

/** Recover the event from the delivered text. Null when the content isn't the
 *  generated shape (then render the message verbatim). */
export function parseCommentEventContent(content: string): CommentEvent | null {
  const match = HEADER.exec(content ?? '');
  if (!match) return null;
  return {
    filePath: match[2],
    quote: match[4],
    authorName: match[3],
    body: content.slice(match[0].length).replace(INSTRUCTION, '').trim(),
    isNewThread: match[1] === 'Comment',
  };
}

/** Prefer the structured metadata written at delivery; fall back to parsing. */
export function resolveCommentEvent(
  meta: Record<string, unknown>,
  content: string,
): CommentEvent | null {
  const c = meta.comment as Record<string, unknown> | undefined;
  if (c && typeof c === 'object' && typeof c.file_path === 'string') {
    return {
      filePath: c.file_path,
      quote: typeof c.quote === 'string' ? c.quote : '',
      authorName: (typeof c.author_name === 'string' && c.author_name.trim()) || 'Someone',
      body: typeof c.body === 'string' ? c.body.trim() : '',
      isNewThread: c.is_new_thread !== false,
      blocked: c.blocked === true,
    };
  }
  return parseCommentEventContent(content);
}
