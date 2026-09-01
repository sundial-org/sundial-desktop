// Buckets a failed LaTeX compile into a coarse, analytics-friendly error kind.
// Plain JS (no deps) so the Next app and the agent brain (which compiles only
// its own src/ tree) share one classifier — see lib/scheduling/schedule-core.mjs
// for the same pattern. Not a parser: lib/workspace/latex-log-parser.ts owns
// per-line diagnostics; this only answers "what broke, roughly".

export const LATEX_ERROR_KINDS = [
  'missing_package',
  'biber',
  'engine',
  'undefined_control_sequence',
  'missing_file',
  'timeout',
  'bundle_too_big',
  'other',
];

// latexmk runs with `-file-line-error`, which prints errors as
// `./main.tex:12: Undefined control sequence.` instead of `! Undefined control
// sequence.`. Without this every full-tier failure bucketed as `other` and the
// dashboards went blind. Extension list = PATH_EXTENSIONS in
// lib/workspace/latex-log-parser.ts, whose FILE_LINE_RE is the reference.
const FILE_LINE_ERROR_RE =
  /(?:^|\n)\S+\.(?:tex|sty|cls|bib|bst|def|cfg|clo|fd|ldf|aux|toc|out|bbl|ltx):\d+:\d*:?\s*(.*)/i;

/**
 * @param {{ log?: string | null; error?: string | null }} input
 *   `log` is the raw LaTeX/latexmk output; `error` is the route/pool error
 *   code or message (e.g. `bundle_too_big`, `compile request failed`).
 * @returns {string} one of LATEX_ERROR_KINDS
 */
export function latexErrorKind({ log, error } = {}) {
  const err = (error ?? '').toLowerCase();
  if (err === 'bundle_too_big') return 'bundle_too_big';
  if (/time(d )?out|deadline|abort/.test(err)) return 'timeout';
  const text = log ?? '';
  // First `! ...` line is LaTeX's canonical error marker; under
  // `-file-line-error` the same error arrives as `file:line: message` instead.
  // Fall back to the whole log for engine-level (`error:`) failures that never
  // reach TeX.
  const first = text.match(/(?:^|\n)!\s*(.*)/)?.[1] ?? text.match(FILE_LINE_ERROR_RE)?.[1] ?? '';
  const missing = first.match(/File [`'"]?([^'"\s]+)[`'"]? not found/i) ?? first.match(/I can't find file [`'"]?([^'"\s]+)/i);
  if (missing) return /\.(sty|cls|def|fd|cfg)$/i.test(missing[1]) ? 'missing_package' : 'missing_file';
  if (/undefined control sequence/i.test(first)) return 'undefined_control_sequence';
  if (/biber|bibtex|biblatex|\.bbl/i.test(first)) return 'biber';
  if (/emergency stop|fatal error|tex capacity exceeded|interwoven alignment|too many|\\end occurred/i.test(first)) return 'engine';
  if (!first && /(^|\n)error:/i.test(text)) {
    if (/biber|bibtex/i.test(text)) return 'biber';
    if (/bundle|fetch|download/i.test(text)) return 'missing_package';
    return 'engine';
  }
  if (/time(d )?out/i.test(text) && !first) return 'timeout';
  return 'other';
}
