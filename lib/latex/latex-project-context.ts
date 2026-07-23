import { buildBibIndex } from '@/lib/workspace/latex-bib-index';
import { extractLabels, extractUserCommands } from '@/lib/latex/latex-completions';
import { LATEX_IMAGE_EXT_RE } from '@/lib/workspace/latex-image';
import type { LatexProjectContext } from '@/lib/latex/monaco-latex-completion';

/**
 * Derive the project-wide LaTeX context the completion engine and citation
 * picker consume, from the set of project files (path + current text). Pure and
 * dependency-free: callers hand in already-loaded contents, so it never touches
 * the DB or filesystem and is unit-tested directly.
 *
 * - `labels`     — `\label{...}` keys across every `.tex` source (for `\ref`).
 * - `bibEntries` — parsed `.bib` index (for `\cite`), via the shared parser.
 * - `texFiles`   — `.tex` paths (for `\input`/`\include`/`\subfile`).
 * - `graphicsFiles` — image paths (for `\includegraphics`).
 */

export type LatexProjectFile = { path: string; text?: string | null };

export function buildLatexProjectContext(files: LatexProjectFile[]): LatexProjectContext {
  const texFiles: string[] = [];
  const graphicsFiles: string[] = [];
  const texSources: string[] = [];
  const bibInputs: { path: string; text: string | null | undefined }[] = [];

  for (const file of files) {
    const path = file.path;
    if (LATEX_IMAGE_EXT_RE.test(path)) graphicsFiles.push(path);
    if (/\.bib$/iu.test(path)) bibInputs.push({ path, text: file.text });
    if (/\.tex$/iu.test(path)) {
      texFiles.push(path);
      if (typeof file.text === 'string') texSources.push(file.text);
    }
  }

  return {
    labels: extractLabels(texSources),
    userCommands: extractUserCommands(texSources),
    bibEntries: buildBibIndex(bibInputs),
    texFiles: texFiles.sort(),
    graphicsFiles: graphicsFiles.sort(),
  };
}
