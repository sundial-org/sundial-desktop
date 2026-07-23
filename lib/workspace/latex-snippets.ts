// Pure LaTeX snippet model + formatter.
//
// Kept deliberately free of Monaco/React so the wrap-vs-insert and cursor
// placement rules can be unit-tested without a browser editor. The editor
// layer (collab-code-editor.tsx) translates the {text, selectionStart,
// selectionEnd} offsets returned here into a Monaco edit + selection.

/**
 * Marker inside a snippet template for where the user's selection (or the
 * placeholder, or the resting cursor) should land. Uses a private-use-area
 * codepoint that will never appear in a real LaTeX template.
 */
export const SNIPPET_SELECTION_MARKER = '\uE000';

export type LatexSnippet = {
  /** Stable id, also used as the toolbar button test id suffix. */
  id: string;
  /** Short human label for tooltip / menu. */
  label: string;
  /**
   * Template text containing exactly one {@link SNIPPET_SELECTION_MARKER}.
   * Text before the marker becomes the prefix, text after becomes the suffix.
   */
  template: string;
  /**
   * Default text dropped at the marker when the user has no selection. It is
   * left selected after insertion so the user can immediately type over it.
   * When omitted, an empty-selection insert just rests the cursor at the
   * marker.
   */
  placeholder?: string;
};

export type FormattedSnippet = {
  /** Full text to insert in place of the current selection. */
  text: string;
  /** Offset within {@link text} where the post-insert selection begins. */
  selectionStart: number;
  /** Offset within {@link text} where the post-insert selection ends. */
  selectionEnd: number;
};

/**
 * Resolve a snippet against the current selection.
 *
 * - With a selection: the selected text is wrapped and stays selected inside
 *   the snippet (e.g. `foo` + bold → `\textbf{foo}` with `foo` selected).
 * - Without a selection: the placeholder (if any) is inserted and selected,
 *   otherwise the cursor rests at the marker.
 */
export function formatLatexSnippet(selection: string, snippet: LatexSnippet): FormattedSnippet {
  const markerIndex = snippet.template.indexOf(SNIPPET_SELECTION_MARKER);
  if (markerIndex === -1) {
    // Defensive: a markerless template just inserts verbatim with the cursor
    // at the end. Snippet authors should always include the marker.
    return { text: snippet.template, selectionStart: snippet.template.length, selectionEnd: snippet.template.length };
  }
  const prefix = snippet.template.slice(0, markerIndex);
  const suffix = snippet.template.slice(markerIndex + SNIPPET_SELECTION_MARKER.length);
  const body = selection.length > 0 ? selection : snippet.placeholder ?? '';
  return {
    text: `${prefix}${body}${suffix}`,
    selectionStart: prefix.length,
    selectionEnd: prefix.length + body.length,
  };
}

const M = SNIPPET_SELECTION_MARKER;

// Section levels — the toolbar's "Format" (Tt) dropdown. First entry is the
// default action.
export const SECTION_SNIPPETS: LatexSnippet[] = [
  { id: 'section', label: 'Section', template: `\\section{${M}}`, placeholder: 'Title' },
  { id: 'subsection', label: 'Subsection', template: `\\subsection{${M}}`, placeholder: 'Title' },
  { id: 'subsubsection', label: 'Subsubsection', template: `\\subsubsection{${M}}`, placeholder: 'Title' },
  { id: 'paragraph', label: 'Paragraph', template: `\\paragraph{${M}}`, placeholder: 'Title' },
];

// Inline emphasis — standalone Bold / Italic buttons.
export const BOLD_SNIPPET: LatexSnippet = { id: 'bold', label: 'Bold', template: `\\textbf{${M}}` };
export const ITALIC_SNIPPET: LatexSnippet = { id: 'italic', label: 'Italic', template: `\\emph{${M}}` };

// "Insert math" dropdown — inline ($…$) and display (\[ … \]) plus the named
// AMS environments.
export const MATH_SNIPPETS: LatexSnippet[] = [
  { id: 'inline-math', label: 'Inline', template: `$${M}$` },
  { id: 'display-math', label: 'Display', template: `\\[\n  ${M}\n\\]` },
  { id: 'equation', label: 'Equation', template: `\\begin{equation}\n  ${M}\n\\end{equation}` },
  { id: 'align', label: 'Aligned equations', template: `\\begin{align}\n  ${M}\n\\end{align}` },
];

// "Insert list" dropdown.
export const LIST_SNIPPETS: LatexSnippet[] = [
  { id: 'itemize', label: 'Bulleted list', template: `\\begin{itemize}\n  \\item ${M}\n\\end{itemize}` },
  { id: 'enumerate', label: 'Numbered list', template: `\\begin{enumerate}\n  \\item ${M}\n\\end{enumerate}` },
];

// Standalone insert buttons (link, comment, cross-reference, citation,
// figure, table) in Overleaf toolbar order.
export const LINK_SNIPPET: LatexSnippet = {
  id: 'href',
  label: 'Insert link',
  template: `\\href{${M}}{text}`,
  placeholder: 'https://',
};
export const COMMENT_SNIPPET: LatexSnippet = {
  id: 'comment',
  label: 'Insert comment',
  template: `% ${M}`,
  placeholder: 'comment',
};
export const XREF_SNIPPET: LatexSnippet = {
  id: 'ref',
  label: 'Insert cross-reference',
  template: `\\ref{${M}}`,
  placeholder: 'sec:label',
};
export const CITATION_SNIPPET: LatexSnippet = {
  id: 'cite',
  label: 'Insert citation',
  template: `\\cite{${M}}`,
  placeholder: 'key',
};
export const FIGURE_SNIPPET: LatexSnippet = {
  id: 'figure',
  label: 'Insert figure',
  template: `\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{${M}}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}`,
  placeholder: 'path/to/image',
};
export const TABLE_SNIPPET: LatexSnippet = {
  id: 'table',
  label: 'Insert table',
  template: `\\begin{table}[ht]\n  \\centering\n  \\begin{tabular}{${M}}\n    a & b \\\\\n    c & d \\\\\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}`,
  placeholder: 'cc',
};

/** Every snippet, in toolbar order — the single source the toolbar + tests read. */
export const ALL_LATEX_SNIPPETS: LatexSnippet[] = [
  ...SECTION_SNIPPETS,
  BOLD_SNIPPET,
  ITALIC_SNIPPET,
  ...MATH_SNIPPETS,
  ...LIST_SNIPPETS,
  LINK_SNIPPET,
  COMMENT_SNIPPET,
  XREF_SNIPPET,
  CITATION_SNIPPET,
  FIGURE_SNIPPET,
  TABLE_SNIPPET,
];

/** Flat lookup of every snippet by id, for the editor handle + tests. */
export const LATEX_SNIPPETS_BY_ID: Record<string, LatexSnippet> = Object.fromEntries(
  ALL_LATEX_SNIPPETS.map((snippet) => [snippet.id, snippet]),
);
