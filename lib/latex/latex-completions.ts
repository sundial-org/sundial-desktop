import { searchBibEntries, type BibEntry } from '@/lib/workspace/latex-bib-index';

/**
 * Pure LaTeX autocomplete engine (W3.acomplete, §5.1–5.5). Frameworks call
 * `getLatexCompletions` with the text before the cursor plus project-derived
 * context (labels, `.bib` entries, file paths); it detects which completion
 * context the cursor sits in and returns candidates plus the start column to
 * replace. No editor dependency, so it is unit-tested directly; the Monaco
 * provider is a thin adapter that maps `from`/`items` onto a completion range.
 *
 * The `\cite{` path shares the same `.bib` index as the citation picker
 * (§5.4/§6.3) so the inline completion and the menu never disagree.
 */

export type LatexCompletionKind = 'command' | 'environment' | 'ref' | 'cite' | 'file';

export type LatexCompletion = {
  /** Display label (the token, e.g. `\section`, `theorem`, `fig:flow`). */
  label: string;
  /** Text inserted in place of the active partial token. */
  insertText: string;
  kind: LatexCompletionKind;
  /** Right-aligned hint: env for refs, "Author · Title" for cites, etc. */
  detail?: string;
  /** Monaco-independent insertion behavior; plain text is the default. */
  insertMode?: 'snippet';
  /** Re-open the suggest widget after accepting this item (staged syntax). */
  retrigger?: boolean;
  /** Characters immediately after the cursor that this item replaces. */
  replaceSuffixChars?: number;
};

export type LatexCompletionContext = {
  /** Bounded text from the current line immediately before the cursor. */
  linePrefix: string;
  /** Bounded text after the cursor, used only to avoid duplicate closers. */
  suffix?: string;
  /** Whether the bounded suffix stops before the end of the document. */
  suffixTruncated?: boolean;
  /** `\label{...}` keys across the project (for `\ref` family). */
  labels?: string[];
  /** Parsed `.bib` entries (for the `\cite` family). */
  bibEntries?: BibEntry[];
  /** Workspace-relative `.tex` paths (for `\input`/`\include`/`\subfile`). */
  texFiles?: string[];
  /** Workspace-relative image paths (for `\includegraphics`). */
  graphicsFiles?: string[];
  /** User-defined macro names (no backslash) scanned from project `.tex`
   *  sources — `\newcommand`, `\def`, `\DeclareMathOperator`, … — so a project's
   *  own commands (e.g. from an `\input`-ed `decls.tex`) autocomplete after `\`. */
  userCommands?: string[];
};

export type LatexCompletionResult = {
  /** Offset (0-based, within `linePrefix`) where replacement starts. */
  from: number;
  items: LatexCompletion[];
};

/** High-frequency control sequences. Kept deliberately small — the long tail
 *  adds noise without helping; users reach for the symbol palette for those. */
const COMMANDS = [
  'section', 'subsection', 'subsubsection', 'paragraph', 'chapter',
  'textbf', 'textit', 'emph', 'texttt', 'underline', 'textsc',
  'begin', 'end', 'item', 'label', 'ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cref', 'Cref',
  'cite', 'citep', 'citet', 'footnote', 'caption', 'centering',
  'includegraphics', 'input', 'include', 'subfile', 'import', 'usepackage', 'documentclass',
  'frac', 'sqrt', 'sum', 'int', 'prod', 'lim', 'left', 'right',
  'href', 'url', 'newcommand', 'renewcommand', 'newenvironment', 'bibliography', 'bibliographystyle',
];

/** Commands whose next stage is a project-derived value or environment. */
const ARGUMENT_COMPLETION_COMMANDS = new Set([
  'begin', 'end', 'ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cref', 'Cref',
  'cite', 'citep', 'citet', 'includegraphics', 'input', 'include', 'subfile',
]);

/** One-required-argument commands that can finish as a native snippet. */
const UNARY_COMMANDS = new Set([
  'section', 'subsection', 'subsubsection', 'paragraph', 'chapter',
  'textbf', 'textit', 'emph', 'texttt', 'underline', 'textsc',
  'label', 'footnote', 'caption', 'sqrt', 'url', 'usepackage', 'documentclass',
  'bibliography', 'bibliographystyle',
]);

/** Environments offered after `\begin{`. `\end{` completes from the same set. */
const ENVIRONMENTS = [
  'document', 'itemize', 'enumerate', 'description', 'figure', 'table', 'tabular',
  'equation', 'align', 'gather', 'multline', 'cases', 'matrix', 'pmatrix', 'bmatrix',
  'theorem', 'lemma', 'proof', 'definition', 'corollary', 'remark', 'proposition',
  'abstract', 'quote', 'verbatim', 'center', 'minipage', 'array', 'subfigure',
];

/** The trailing partial of a `{a,b,partial` argument: text after the last comma. */
function lastArgToken(inner: string): string {
  const comma = inner.lastIndexOf(',');
  return comma === -1 ? inner : inner.slice(comma + 1);
}

function startsWithCaseInsensitive(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.trim().toLowerCase());
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function fileCompletions(
  paths: string[],
  partial: string,
  stripTexExt: boolean,
  ctx: LatexCompletionContext,
): LatexCompletion[] {
  const trimmed = partial.trim().toLowerCase();
  return paths
    .filter((p) => !trimmed || p.toLowerCase().includes(trimmed) || baseName(p).toLowerCase().includes(trimmed))
    .map((p) => {
      // \input/\include conventionally omit the .tex extension.
      const insert = stripTexExt ? p.replace(/\.tex$/i, '') : p;
      return { label: insert, ...argumentInsertion(insert, ctx), kind: 'file' as const };
    });
}

type CompletionInsertion = Pick<
  LatexCompletion,
  'insertText' | 'insertMode' | 'replaceSuffixChars'
>;

/** Finish a value argument when the cursor is at its end, replacing Monaco's
 * auto-closed `}` when present. Cite keeps the caret inside for another key. */
function argumentInsertion(
  value: string,
  ctx: LatexCompletionContext,
  keepCaretInside = false,
): CompletionInsertion {
  const lineSuffix = (ctx.suffix ?? '').split('\n', 1)[0] ?? '';
  const tokenTail = lineSuffix.match(/^[^,}\s]*/)?.[0] ?? '';
  const afterToken = lineSuffix.slice(tokenTail.length);
  const hasAdjacentBrace = afterToken.startsWith('}');
  const atArgumentEnd = hasAdjacentBrace || afterToken.trim() === '';
  const replaceSuffixChars = tokenTail.length + (hasAdjacentBrace ? 1 : 0);
  if (!atArgumentEnd) {
    return { insertText: value, replaceSuffixChars: tokenTail.length || undefined };
  }
  return {
    insertText: keepCaretInside ? `${value}$1}$0` : `${value}}`,
    insertMode: keepCaretInside ? 'snippet' : undefined,
    replaceSuffixChars: replaceSuffixChars || undefined,
  };
}

function commandInsertion(name: string): Pick<LatexCompletion, 'insertText' | 'insertMode' | 'retrigger'> {
  if (ARGUMENT_COMPLETION_COMMANDS.has(name)) {
    return { insertText: `\\${name}{`, retrigger: true };
  }
  if (UNARY_COMMANDS.has(name)) {
    return { insertText: `\\${name}{$1}$0`, insertMode: 'snippet' };
  }
  if (name === 'frac') return { insertText: '\\frac{$1}{$2}$0', insertMode: 'snippet' };
  if (name === 'href') return { insertText: '\\href{$1}{$2}$0', insertMode: 'snippet' };
  if (name === 'import') return { insertText: '\\import{$1}{$2}$0', insertMode: 'snippet' };
  return { insertText: `\\${name}` };
}

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function snippetLiteral(value: string): string {
  return value.replace(/[$}\\]/g, '\\$&');
}

function environmentBody(name: string): string {
  if (name === 'itemize' || name === 'enumerate') return '\\item $1';
  if (name === 'description') return '\\item[$1] $2';
  if (name === 'tabular' || name === 'array' || name === 'minipage' || name === 'subfigure') return '$2';
  return '$1';
}

function environmentExtraArgument(name: string): string {
  if (name === 'tabular' || name === 'array') return '{${1:cc}}';
  if (name === 'minipage') return '{${1:\\textwidth}}';
  if (name === 'subfigure') return '{${1:0.48\\textwidth}}';
  return '';
}

function environmentInsertion(
  name: string,
  mode: 'begin' | 'end',
  ctx: LatexCompletionContext,
): CompletionInsertion {
  const suffix = ctx.suffix ?? '';
  const lineSuffix = suffix.split('\n', 1)[0] ?? '';
  const nameTail = lineSuffix.match(/^[^}\s]*/)?.[0] ?? '';
  const afterName = lineSuffix.slice(nameTail.length);
  const hasAdjacentBrace = afterName.startsWith('}');
  const endsAtCursor = hasAdjacentBrace || afterName.trim() === '';
  if (!endsAtCursor) {
    return { insertText: name, replaceSuffixChars: nameTail.length || undefined };
  }

  const replaceCount = nameTail.length + (hasAdjacentBrace ? 1 : 0);
  const replaceSuffixChars = replaceCount || undefined;
  if (mode === 'end') return { insertText: `${name}}`, replaceSuffixChars };

  // Ignore commented-out closers: they do not balance the active opener.
  const activeSuffix = suffix
    .slice(replaceCount)
    .replace(/(^|[^\\])%.*$/gm, '$1');
  const hasMatchingCloser = new RegExp(`\\\\end\\{${regexLiteral(name)}\\}`).test(activeSuffix);
  if (hasMatchingCloser) return { insertText: `${name}}`, replaceSuffixChars };
  // A new block immediately before \end{document} is safe to pair even though
  // more document follows. A different adjacent closer may be the old half of
  // an environment rename, so leave it untouched instead of adding a mismatch.
  const beforeOuterCloser = /^\s*\\end\{document\}/.test(activeSuffix);
  if (!beforeOuterCloser && (ctx.suffixTruncated || activeSuffix.trim())) {
    return { insertText: `${name}}`, replaceSuffixChars };
  }

  const indent = ctx.linePrefix.match(/^\s*/)?.[0] ?? '';
  const safeName = snippetLiteral(name);
  return {
    insertText:
      `${safeName}}${environmentExtraArgument(name)}\n` +
      `${indent}  ${environmentBody(name)}\n` +
      `${indent}\\end{${safeName}}$0`,
    insertMode: 'snippet',
    replaceSuffixChars,
  };
}

function citeDetail(entry: BibEntry): string {
  const author = entry.authors[0] ? entry.authors[0].split(' ').pop() ?? entry.authors[0] : '';
  const bits = [author, entry.year, entry.title].filter(Boolean);
  return bits.join(' · ');
}

/**
 * Detect the completion context at the cursor and return candidates. Returns
 * null when nothing sensible applies (so the editor falls back to its default
 * word completion).
 */
export function getLatexCompletions(ctx: LatexCompletionContext): LatexCompletionResult | null {
  const line = ctx.linePrefix;

  // \cite{ … , partial  → bib keys
  const cite = line.match(/\\(?:no|text|paren|foot|auto|super)?cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)$/);
  if (cite) {
    const inner = cite[1] ?? '';
    const partial = lastArgToken(inner);
    const from = line.length - partial.length;
    // Reuse the picker's ranked, year-aware search so inline `\cite` completion
    // and the menu picker never disagree (§6.3).
    const items = searchBibEntries(ctx.bibEntries ?? [], partial)
      .map((e) => ({
        label: e.key,
        ...argumentInsertion(e.key, ctx, true),
        kind: 'cite' as const,
        detail: citeDetail(e),
      }));
    return { from, items };
  }

  // \ref{ partial  → labels
  const ref = line.match(/\\(?:eq|page|auto|name|c|C)?ref\*?\{([^}]*)$/);
  if (ref) {
    const partial = ref[1] ?? '';
    const from = line.length - partial.length;
    const labels = ctx.labels ?? [];
    const q = partial.trim().toLowerCase();
    const items = labels
      .filter((l) => !q || l.toLowerCase().includes(q))
      .map((l) => ({ label: l, ...argumentInsertion(l, ctx), kind: 'ref' as const }));
    return { from, items };
  }

  // \includegraphics[...]{ partial  → image paths
  const graphics = line.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/);
  if (graphics) {
    const partial = graphics[1] ?? '';
    return {
      from: line.length - partial.length,
      items: fileCompletions(ctx.graphicsFiles ?? [], partial, false, ctx),
    };
  }

  // \input{ / \include{ / \subfile{ partial  → .tex paths
  const include = line.match(/\\(?:input|include|subfile)\{([^}]*)$/);
  if (include) {
    const partial = include[1] ?? '';
    return {
      from: line.length - partial.length,
      items: fileCompletions(ctx.texFiles ?? [], partial, true, ctx),
    };
  }

  // \begin{ / \end{ partial → close the argument; begin also pairs the block.
  const env = line.match(/\\(begin|end)\{([^}]*)$/);
  if (env) {
    const mode = env[1] as 'begin' | 'end';
    const partial = env[2] ?? '';
    const from = line.length - partial.length;
    const items = ENVIRONMENTS
      .filter((e) => startsWithCaseInsensitive(e, partial))
      .map((e) => ({
        label: e,
        ...environmentInsertion(e, mode, ctx),
        kind: 'environment' as const,
      }));
    return { from, items };
  }

  // \command  → control sequences: project macros first (tagged), then the
  // built-ins a user `\renewcommand` hasn't already shadowed.
  const command = line.match(/\\([a-zA-Z]+)$/);
  if (command) {
    const partial = command[1] ?? '';
    const from = line.length - partial.length - 1; // include the backslash
    const userCommands = ctx.userCommands ?? [];
    const userSet = new Set(userCommands);
    const items = [
      ...userCommands.map((c) => [c, 'macro'] as const),
      ...COMMANDS.filter((c) => !userSet.has(c)).map((c) => [c, undefined] as const),
    ]
      .filter(([c]) => startsWithCaseInsensitive(c, partial))
      .map(([c, detail]) => ({
        label: `\\${c}`,
        ...(detail ? { insertText: `\\${c}` } : commandInsertion(c)),
        kind: 'command' as const,
        detail,
      }));
    return items.length ? { from, items } : null;
  }

  return null;
}

/**
 * Macro names (no backslash) defined across project `.tex` sources, so a
 * project's own commands autocomplete after `\`. Covers the `\newcommand`
 * family, `\DeclareMathOperator`/`\NewDocumentCommand`/`\DeclarePairedDelimiter`,
 * and `\def`/`\edef`/`\gdef`/`\let`. Commented-out lines are ignored.
 */
export function extractUserCommands(sources: string[]): string[] {
  const names = new Set<string>();
  // A `\<definer>` (braced/bare name, optional `*`) or a TeX primitive, then `\name`.
  const re =
    /\\(?:(?:newcommand|renewcommand|providecommand|DeclareMathOperator|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclarePairedDelimiter)\*?\s*\{?|def|edef|gdef|xdef|let)\s*\\([a-zA-Z]+)/g;
  for (const source of sources) {
    // Strip from an unescaped % to end of line (mirrors extractLabels).
    const cleaned = source.replace(/(^|[^\\])%.*$/gm, '$1');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) names.add(m[1]);
  }
  return [...names].sort();
}

/** Extract `\label{...}` keys from a set of project sources (for `\ref`). */
export function extractLabels(sources: string[]): string[] {
  const keys = new Set<string>();
  const re = /\\label\{([^}]+)\}/g;
  for (const source of sources) {
    // Skip commented-out labels: strip from an unescaped % to end of line.
    const cleaned = source.replace(/(^|[^\\])%.*$/gm, '$1');
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const key = m[1]?.trim();
      if (key) keys.add(key);
    }
  }
  return [...keys].sort();
}
