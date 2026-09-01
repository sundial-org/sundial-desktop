// Pure structured parser for tectonic/LaTeX compile output (W1.parser).
//
// Kept deliberately free of Monaco/React/Node so it can be unit-tested as a
// plain function and shared by both the Next client (use-latex-compile.ts) and
// the agent brain (agent-ts self-heal loop). It turns raw tectonic stdout/.log
// text into a list of {severity, file, line, message, rawExcerpt} items.
//
// Contracts (docs/latex-parity-spec.md):
//  - IC6: preserve the raw excerpt for every item; a parse miss still surfaces
//         the error with `line: null` ("line unknown") rather than dropping it.
//  - IC7: map errors to a child file when the log's paren context names one;
//         otherwise fall back to the compiled root for `l.<n>`-only locations.
//  - IC8: callers collapse same-location items into one marker with a count
//         (see collapseLatexLogItems); warnings/bad boxes stay present but are
//         filtered out of the one-line surface by the W2 consumer.

export type LatexLogSeverity = 'error' | 'warning' | 'badbox';

export interface LatexLogItem {
  severity: LatexLogSeverity;
  /** Workspace-relative source file when known, else the root fallback, else null. */
  file: string | null;
  /** True when `file` came from the log's own context (paren stack or a
   *  `path:line:` prefix) rather than the root fallback — resolvers must only
   *  re-map log-sourced paths (a fallback is already a workspace path). */
  fileFromLog: boolean;
  /** 1-based source line, or null when the log gives none (IC6 "line unknown"). */
  line: number | null;
  /** Normalized one-line message. */
  message: string;
  /** Verbatim log lines this item was derived from (IC6 — never drop the raw). */
  rawExcerpt: string;
}

export interface ParseLatexLogOptions {
  /** Compiled root file; the IC7 fallback `file` when only `l.<n>` is known. */
  rootFile?: string | null;
}

export interface CollapsedLatexLogItem extends LatexLogItem {
  /** How many raw items collapsed into this one (IC8). */
  count: number;
}

// File extensions that make a `(token` look like an opened source file rather
// than ordinary parenthesised log prose. Kept conservative so unbalanced parens
// inside messages/math don't corrupt the file stack.
const PATH_EXTENSIONS = [
  'tex',
  'sty',
  'cls',
  'bib',
  'bst',
  'def',
  'cfg',
  'clo',
  'fd',
  'ldf',
  'aux',
  'toc',
  'out',
  'bbl',
];
const PATH_EXT_RE = new RegExp(`\\.(?:${PATH_EXTENSIONS.join('|')})$`, 'i');

const MAX_EXCERPT_LINES = 8;
// Deep macro-expansion errors can push the `l.<n>` location well past the
// excerpt window; search further for the line number than we keep for display.
const SOURCE_LINE_LOOKAHEAD = 40;

/** Strip a leading `./` and surrounding whitespace from a logged path. */
function normalizePath(raw: string): string {
  return raw.trim().replace(/^\.\//, '');
}

/** A `(token` opens a file only if it carries a path separator or known ext. */
function looksLikePath(token: string): boolean {
  if (!token) return false;
  return token.includes('/') || PATH_EXT_RE.test(token);
}

// Walk one log line char-by-char, mutating the paren file stack. Only `(`
// immediately followed by a path-like token pushes; every other `(` is ignored
// (so we never push garbage), and `)` pops when the stack is non-empty. This is
// best-effort — the canonical Overleaf-style heuristic — and good enough for
// IC7's "use the child path when the log proves one".
function advanceFileStack(line: string, stack: string[]): void {
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '(') {
      let j = i + 1;
      let token = '';
      while (j < line.length && !'(){} \t'.includes(line[j])) {
        token += line[j];
        j += 1;
      }
      if (looksLikePath(token)) {
        stack.push(normalizePath(token));
        i = j - 1;
      }
    } else if (ch === ')') {
      stack.pop();
    }
  }
}

function fileAt(stack: string[], rootFile: string | null | undefined): { file: string | null; fromLog: boolean } {
  if (stack.length > 0) return { file: stack[stack.length - 1], fromLog: true };
  return { file: rootFile ?? null, fromLog: false };
}

function clampExcerpt(lines: string[]): string {
  return lines.slice(0, MAX_EXCERPT_LINES).join('\n').trimEnd();
}

const ERROR_PREFIX_RE = /^! (.*)$/;
const SOURCE_LINE_RE = /^l\.(\d+)\b ?(.*)$/;
// Compiler-style `path:line: message` — mirrors the second regex in
// use-latex-compile.ts:extractLatexErrorLines.
const FILE_LINE_RE = /^(.+?):(\d+):\d*:?\s*(.+)$/;
const WARNING_RE = /(?:^|\s)((?:LaTeX|Package [\w@-]+|LaTeX Font|pdfTeX|Class [\w@-]+) Warning:.*)$/;
const INPUT_LINE_RE = /on input line (\d+)/;
const BADBOX_RE = /^(Overfull|Underfull) \\([hv]box)\b(.*)$/;
const BADBOX_LINES_RE = /at lines (\d+)--\d+/;
const BADBOX_LINE_RE = /(?:at|detected at) line (\d+)/;

/**
 * Parse raw tectonic/LaTeX log text into structured items. Pure: no I/O, no
 * throwing. Returns `[]` for empty/clean logs.
 */
export function parseLatexLog(log: string, options: ParseLatexLogOptions = {}): LatexLogItem[] {
  const rootFile = options.rootFile ?? null;
  if (!log || !log.trim()) return [];

  // Split on \r?\n so CRLF logs don't leave a trailing \r that breaks ^/$ anchors.
  const lines = log.split(/\r?\n/);
  const stack: string[] = [];
  const items: LatexLogItem[] = [];
  let sawHardFailure = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Detect items at the *current* file context, then advance the stack with
    // this line's parens so the next line sees the updated nesting.
    const errorMatch = line.match(ERROR_PREFIX_RE);
    if (errorMatch) {
      sawHardFailure = true;
      const excerpt: string[] = [line];
      let sourceLine: number | null = null;
      // Look ahead for the `l.<n>` line that carries the source location and the
      // offending token. Search further than we keep for the excerpt.
      for (let j = i + 1; j < lines.length && j < i + SOURCE_LINE_LOOKAHEAD; j += 1) {
        excerpt.push(lines[j]);
        const sourceMatch = lines[j].match(SOURCE_LINE_RE);
        if (sourceMatch) {
          sourceLine = Number(sourceMatch[1]);
          break;
        }
      }
      const loc = fileAt(stack, rootFile);
      items.push({
        severity: 'error',
        file: loc.file,
        fileFromLog: loc.fromLog,
        line: Number.isFinite(sourceLine) ? sourceLine : null,
        message: errorMatch[1].trim() || 'LaTeX error',
        rawExcerpt: clampExcerpt(excerpt),
      });
      advanceFileStack(line, stack);
      continue;
    }

    const badboxMatch = line.match(BADBOX_RE);
    if (badboxMatch) {
      const linesMatch = line.match(BADBOX_LINES_RE) || line.match(BADBOX_LINE_RE);
      const loc = fileAt(stack, rootFile);
      items.push({
        severity: 'badbox',
        file: loc.file,
        fileFromLog: loc.fromLog,
        line: linesMatch ? Number(linesMatch[1]) : null,
        message: line.trim(),
        rawExcerpt: line.trimEnd(),
      });
      advanceFileStack(line, stack);
      continue;
    }

    const warningMatch = line.match(WARNING_RE);
    if (warningMatch) {
      // The "on input line N." tail may sit on a continuation line; scan the
      // warning block until a blank line or the next recognizable item.
      const excerpt: string[] = [line];
      let inputLine: number | null = line.match(INPUT_LINE_RE)
        ? Number(line.match(INPUT_LINE_RE)![1])
        : null;
      for (
        let j = i + 1;
        inputLine === null && j < lines.length && j < i + MAX_EXCERPT_LINES;
        j += 1
      ) {
        if (!lines[j].trim() || ERROR_PREFIX_RE.test(lines[j])) break;
        excerpt.push(lines[j]);
        const inputMatch = lines[j].match(INPUT_LINE_RE);
        if (inputMatch) inputLine = Number(inputMatch[1]);
      }
      const loc = fileAt(stack, rootFile);
      items.push({
        severity: 'warning',
        file: loc.file,
        fileFromLog: loc.fromLog,
        line: inputLine,
        message: warningMatch[1].trim(),
        rawExcerpt: clampExcerpt(excerpt),
      });
      advanceFileStack(line, stack);
      continue;
    }

    // Compiler-style `path:line: message`. Only trust it when the path segment
    // is a whitespace-free, path-like token — otherwise ordinary log prose
    // (`Package x: see http://host:80: info`, timestamps) would forge errors and
    // turn a clean compile into a spurious failure.
    const fileLineMatch = line.match(FILE_LINE_RE);
    if (fileLineMatch) {
      const candidate = normalizePath(fileLineMatch[1]);
      if (!/\s/.test(candidate) && looksLikePath(candidate)) {
        sawHardFailure = true;
        items.push({
          severity: 'error',
          file: candidate,
          fileFromLog: true,
          line: Number(fileLineMatch[2]),
          message: fileLineMatch[3].trim(),
          rawExcerpt: line.trimEnd(),
        });
        advanceFileStack(line, stack);
        continue;
      }
    }

    if (/^error:/i.test(line.trim())) sawHardFailure = true;

    advanceFileStack(line, stack);
  }

  // IC6 never-drop safety net: a failed compile must never produce zero error
  // items. If something signalled a hard failure but nothing structured caught
  // an error, surface one fallback carrying the raw log tail.
  if (sawHardFailure && !items.some((item) => item.severity === 'error')) {
    items.push({
      severity: 'error',
      file: rootFile,
      fileFromLog: false,
      line: null,
      message: 'Compile failed (see log)',
      rawExcerpt: clampExcerpt(lines.slice(-MAX_EXCERPT_LINES)),
    });
  }

  return items;
}

/**
 * Collapse items sharing severity+file+line into one entry with an occurrence
 * count (IC8). Order is preserved by first appearance.
 */
export function collapseLatexLogItems(items: LatexLogItem[]): CollapsedLatexLogItem[] {
  const byKey = new Map<string, CollapsedLatexLogItem>();
  for (const item of items) {
    const key = `${item.severity}|${item.file ?? ''}|${item.line ?? ''}`;
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else byKey.set(key, { ...item, count: 1 });
  }
  return [...byKey.values()];
}
