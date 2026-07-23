import type { LatexErrorLine } from '@/components/workspace/use-latex-compile';

/**
 * Compose the message the "Fix with Sunny" action (§1.10 / §1.5 `Cmd+Enter`)
 * and the auto-fix toggle (§1.11) send into the chat. It's a normal user turn —
 * Sunny edits the `.tex` and self-heals as usual — so the fix flow needs no new
 * agent endpoint; it just hands Sunny the failing file + a trimmed error tail.
 *
 * Pure and unit-tested. The log tail is capped so a runaway tectonic dump can't
 * blow up the message body.
 */

const MAX_LOG_CHARS = 1500;
const MAX_ERROR_LINES = 12;

export function buildCompileFixPrompt(
  texPath: string,
  errorLines: LatexErrorLine[],
  logText: string,
): string {
  const header = `The LaTeX file \`${texPath}\` fails to compile. Fix the compile errors and keep my content intact.`;

  const lines = errorLines.slice(0, MAX_ERROR_LINES).map((e) => `- line ${e.line}: ${e.text}`);
  const errorBlock = lines.length > 0 ? `\nErrors:\n${lines.join('\n')}` : '';

  // Trim the raw log to its tail — the error and its context live at the end of
  // a tectonic run, and that's where the actionable `! ` lines are.
  const tail = logText.length > MAX_LOG_CHARS ? logText.slice(-MAX_LOG_CHARS) : logText;
  const logBlock = tail.trim() ? `\n\nCompile log (tail):\n\`\`\`\n${tail.trim()}\n\`\`\`` : '';

  return `${header}${errorBlock}${logBlock}`;
}
