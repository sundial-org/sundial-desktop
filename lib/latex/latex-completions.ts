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
};

export type LatexCompletionContext = {
  /** Text from the start of the current line up to the cursor. */
  linePrefix: string;
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
  /** Column (0-based, within the line) where the replaced token starts. */
  from: number;
  items: LatexCompletion[];
};

/** High-frequency control sequences. Kept deliberately small — the long tail
 *  adds noise without helping; users reach for the symbol palette for those. */
const COMMANDS = [
  'section', 'subsection', 'subsubsection', 'paragraph', 'chapter',
  'textbf', 'textit', 'emph', 'texttt', 'underline', 'textsc',
  'begin', 'end', 'item', 'label', 'ref', 'eqref', 'pageref', 'autoref', 'cref',
  'cite', 'citep', 'citet', 'footnote', 'caption', 'centering',
  'includegraphics', 'input', 'include', 'usepackage', 'documentclass',
  'frac', 'sqrt', 'sum', 'int', 'prod', 'lim', 'left', 'right',
  'newcommand', 'renewcommand', 'newenvironment', 'bibliography', 'bibliographystyle',
];

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
): LatexCompletion[] {
  const trimmed = partial.trim().toLowerCase();
  return paths
    .filter((p) => !trimmed || p.toLowerCase().includes(trimmed) || baseName(p).toLowerCase().includes(trimmed))
    .map((p) => {
      // \input/\include conventionally omit the .tex extension.
      const insert = stripTexExt ? p.replace(/\.tex$/i, '') : p;
      return { label: insert, insertText: insert, kind: 'file' as const };
    });
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
      .map((e) => ({ label: e.key, insertText: e.key, kind: 'cite' as const, detail: citeDetail(e) }));
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
      .map((l) => ({ label: l, insertText: l, kind: 'ref' as const }));
    return { from, items };
  }

  // \includegraphics[...]{ partial  → image paths
  const graphics = line.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/);
  if (graphics) {
    const partial = graphics[1] ?? '';
    return { from: line.length - partial.length, items: fileCompletions(ctx.graphicsFiles ?? [], partial, false) };
  }

  // \input{ / \include{ / \subfile{ / \import{ partial  → .tex paths
  const include = line.match(/\\(?:input|include|subfile|import)\{([^}]*)$/);
  if (include) {
    const partial = include[1] ?? '';
    return { from: line.length - partial.length, items: fileCompletions(ctx.texFiles ?? [], partial, true) };
  }

  // \begin{ / \end{ partial  → environments (auto-\end handled by the adapter)
  const env = line.match(/\\(?:begin|end)\{([^}]*)$/);
  if (env) {
    const partial = env[1] ?? '';
    const from = line.length - partial.length;
    const items = ENVIRONMENTS
      .filter((e) => startsWithCaseInsensitive(e, partial))
      .map((e) => ({ label: e, insertText: e, kind: 'environment' as const }));
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
      .map(([c, detail]) => ({ label: `\\${c}`, insertText: `\\${c}`, kind: 'command' as const, detail }));
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
