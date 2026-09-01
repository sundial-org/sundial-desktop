import type { LatexErrorLine } from '@/components/workspace/use-latex-compile';

/**
 * Compose the message the "Fix with Agent" action (§1.10 / §1.5 `Cmd+Enter`)
 * and the auto-fix toggle (§1.11) send into the chat. It's a normal user turn —
 * Sunny edits the `.tex` and self-heals as usual — so the fix flow needs no new
 * agent endpoint; it just hands Sunny the failing file + a trimmed error tail.
 *
 * Pure and unit-tested. The log tail is capped so a runaway tectonic dump can't
 * blow up the message body.
 */

const MAX_LOG_CHARS = 1500;
const MAX_ERROR_LINES = 12;

// Source-excerpt caps: enough context to fix without a Read round trip, small
// enough that a book-length root doesn't blow up the message (or the bill).
const MAX_FULL_SOURCE_LINES = 120;
const EXCERPT_RADIUS_LINES = 25;
const MAX_SOURCE_CHARS = 4000;

/** The failing file's text around the first error, line-numbered, so the fix
 *  turn can go straight to Edit — the Read round trip was a visible chunk of
 *  the fix latency. Small files ride whole; large ones send a window around
 *  the first error line (or nothing when no line is known — the agent reads). */
function buildSourceBlock(texPath: string, sourceText: string, errorLines: LatexErrorLine[]): string {
  const lines = sourceText.split('\n');
  let start = 0;
  let end = lines.length;
  if (lines.length > MAX_FULL_SOURCE_LINES) {
    const firstInThisFile = errorLines.find((e) => !e.fileLabel)?.line ?? errorLines[0]?.line;
    if (typeof firstInThisFile !== 'number') return '';
    start = Math.max(0, firstInThisFile - 1 - EXCERPT_RADIUS_LINES);
    end = Math.min(lines.length, firstInThisFile + EXCERPT_RADIUS_LINES);
  }
  let excerpt = lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join('\n');
  if (excerpt.length > MAX_SOURCE_CHARS) excerpt = excerpt.slice(0, MAX_SOURCE_CHARS);
  if (!excerpt.trim()) return '';
  const label = start === 0 && end === lines.length ? 'full file' : `lines ${start + 1}-${end}`;
  return `\n\nCurrent content of \`${texPath}\` (${label}, line-numbered):\n\`\`\`\n${excerpt}\n\`\`\``;
}

export function buildCompileFixPrompt(
  texPath: string,
  errorLines: LatexErrorLine[],
  logText: string,
  /** Live text of the failing root, when the caller has it (root open in the
   *  editor). Included so the agent can edit without reading first. */
  sourceText?: string | null,
): string {
  // Speed contract: the fix turn must stay a cheap Tier-1 edit. Compiling
  // from the sandbox (a cold Bash boot) is what turned fix turns into
  // multi-minute waits — the brain recompiles the root automatically after
  // any .tex edit (agent-ts/src/latex/autocompile.ts), so the agent never
  // needs to verify by hand.
  const header =
    `The LaTeX file \`${texPath}\` fails to compile. Apply the smallest edit that fixes the compile errors and keep my content intact. ` +
    `Do not run shell commands and do not compile yourself — the document recompiles automatically after your edit. Reply in one short sentence.`;

  const lines = errorLines
    .slice(0, MAX_ERROR_LINES)
    .map((e) => `- ${e.fileLabel ? `${e.file ?? e.fileLabel} ` : ''}line ${e.line}: ${e.text}`);
  const errorBlock = lines.length > 0 ? `\nErrors:\n${lines.join('\n')}` : '';

  const sourceBlock =
    typeof sourceText === 'string' && sourceText.trim().length > 0
      ? buildSourceBlock(texPath, sourceText, errorLines)
      : '';

  // Trim the raw log to its tail — the error and its context live at the end of
  // a tectonic run, and that's where the actionable `! ` lines are.
  const tail = logText.length > MAX_LOG_CHARS ? logText.slice(-MAX_LOG_CHARS) : logText;
  const logBlock = tail.trim() ? `\n\nCompile log (tail):\n\`\`\`\n${tail.trim()}\n\`\`\`` : '';

  return `${header}${errorBlock}${sourceBlock}${logBlock}`;
}
