import { buildLatexProjectContext, type LatexProjectFile } from '@/lib/latex/latex-project-context';
import type { LatexProjectContext } from '@/lib/latex/monaco-latex-completion';

/**
 * Build the LaTeX completion context for a workspace from the HTTP APIs the
 * editor already has: `/api/workspace/files` for the path list, then
 * `/api/workspace/file-content` for the text of each `.tex`/`.bib` source
 * (needed for `\ref`/`\label` and `\cite` keys; paths alone power `\input` and
 * `\includegraphics`). Best-effort: any network failure degrades to an
 * empty/partial context rather than throwing, since autocomplete must never
 * block the editor.
 */

const TEXT_SOURCE_RE = /\.(?:tex|bib)$/iu;

export async function fetchLatexProjectContext(
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LatexProjectContext> {
  let paths: string[];
  try {
    const res = await fetchImpl(
      `/api/workspace/files?projectId=${encodeURIComponent(projectId)}`,
      { credentials: 'include' },
    );
    if (!res.ok) return {};
    const data = (await res.json()) as { files?: Array<{ path?: unknown }> };
    paths = (data.files ?? [])
      .map((f) => f.path)
      .filter((p): p is string => typeof p === 'string');
  } catch {
    return {};
  }

  const textByPath = new Map<string, string>();
  await Promise.all(
    paths
      .filter((path) => TEXT_SOURCE_RE.test(path))
      .map(async (path) => {
        try {
          const res = await fetchImpl(
            `/api/workspace/file-content?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
            { credentials: 'include' },
          );
          if (!res.ok) return;
          const data = (await res.json()) as { content?: unknown };
          if (typeof data.content === 'string') textByPath.set(path, data.content);
        } catch {
          // best-effort: leave this file's text undefined
        }
      }),
  );

  const files: LatexProjectFile[] = paths.map((path) => ({
    path,
    text: textByPath.get(path) ?? null,
  }));
  return buildLatexProjectContext(files);
}
