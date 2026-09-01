// Chat → markdown transcript. Lives here rather than inline in the workspace
// page because the "what counts as the conversation" rule is the whole point:
// history rows are NOT 1:1 with UI messages (a tool call persists rows the UI
// coalesces away), so paging must compare — and the export must render — the
// same filtered view, or a tool-using chat exports raw tool/system text.
export type TranscriptMessage = { role: string; parts?: unknown[]; content?: unknown };

/** Live UI messages carry text in `parts`; rows from the history API carry it
 *  in `content`. Reading only `parts` produced a transcript with a title and
 *  nothing else the moment pagination actually worked. */
export function transcriptText(message: TranscriptMessage): string {
  const fromParts = (message.parts ?? [])
    .filter(
      (part): part is { type: 'text'; text: string } =>
        (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n\n')
    .trim();
  const raw = message.content;
  return fromParts || (typeof raw === 'string' ? raw.trim() : '');
}

/** Only what a reader would call the conversation: no system rows, nothing
 *  that renders as empty (tool/reasoning rows carry no text of their own). */
export function conversationMessages<T extends TranscriptMessage>(messages: T[]): T[] {
  return messages.filter((message) => message.role !== 'system' && transcriptText(message));
}

export function buildChatTranscript(
  title: string,
  messages: TranscriptMessage[],
  speaker: (role: string) => string,
): string {
  const body = conversationMessages(messages)
    .map((message) => `## ${speaker(message.role)}\n\n${transcriptText(message)}`)
    .join('\n\n');
  return `# ${title}\n\n${body}\n`;
}
