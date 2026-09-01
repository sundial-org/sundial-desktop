import type { CompileErrorState, LatexErrorLine } from '@/components/workspace/use-latex-compile';

/**
 * Pure guards for auto-fix-on-failure (§1.11): which failures are worth an
 * automatic agent turn, and the signature that rate-limits repeat attempts
 * on the same error. Ported from #1299's review loop.
 */

// Missing inputs (an absent .sty/.bib/.cls/image) aren't content bugs the
// agent can repair from the log alone — an auto turn would just invent a file.
const MISSING_FILE_RE = /File `[^']+' not found|I couldn't open (?:file name|database file)|LaTeX Error: File .* not found/i;

export function isAutoFixableFailure(
  compileError: CompileErrorState | null,
  errorLines: LatexErrorLine[],
): boolean {
  if (!compileError) return false;
  // Timeouts, bundle_too_big, an unreachable pool, network drops: never a fix turn.
  if (compileError.failureKind === 'infra') return false;
  const first = errorLines[0]?.text ?? compileError.message;
  return !MISSING_FILE_RE.test(first) && !MISSING_FILE_RE.test(compileError.details.slice(-1500));
}

/** First error message + file (the child file when the parser knows it, else the root) + line — stable across tectonic's path/timestamp noise. */
export function compileErrorSignature(
  compileError: CompileErrorState,
  errorLines: LatexErrorLine[],
  texPath: string | null,
): string {
  const first = errorLines[0];
  if (first) return `${first.file ?? texPath ?? ''}:${first.line}:${first.text}`;
  // Line-unknown failures (missing .sty/.bib, bad preamble): the generic
  // `compile_failed` message alone would collapse every such error into one.
  const diagnostic = compileError.details.match(/^! .*$/m)?.[0] ?? compileError.message;
  return `${texPath ?? ''}::${diagnostic}`;
}
