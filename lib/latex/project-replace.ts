import {
  buildMatcher,
  isProjectSearchSource,
  type ProjectSearchOptions,
} from '@/lib/latex/project-search';

/**
 * Pure project-wide replace engine (§12.3). Companion to {@link searchProject}:
 * given already-loaded `.tex|.bib|.sty|.cls` sources plus a query/replacement,
 * it computes the new text and a match count per changed file — no DB, no I/O,
 * unit-tested directly. The CRDT-safe apply (live Y.Doc + tracked `doc_edits`)
 * lives in the route; this only decides *what* would change so the panel can
 * gate the write behind a preview/confirm step.
 *
 * Replacement uses native `String.replace` semantics: in regex mode `$1`/`$&`/
 * `$<name>` group refs resolve; in literal mode `$` is escaped to insert verbatim.
 */

export type ReplaceableFile = { path: string; text: string };

export type FileReplacement = {
  path: string;
  before: string;
  after: string;
  /** Number of matches replaced in this file. */
  count: number;
};

export type ProjectReplacePreview = {
  /** Only files whose text actually changed, in input order. */
  files: FileReplacement[];
  totalMatches: number;
  totalFiles: number;
};

/** Escape `$` so a literal replacement inserts verbatim (no `$1` expansion). */
function literalReplacement(replacement: string): string {
  return replacement.replace(/\$/gu, '$$$$');
}

/**
 * Replace within a single file's text and report the match count. Matching is
 * done **per line**, exactly mirroring {@link searchProject}, so the panel's
 * preview (which runs the search engine) and this apply never disagree on which
 * occurrences match (`^`/`$` anchors and newline-spanning patterns would
 * otherwise diverge between a per-line scan and a whole-file one).
 */
export function replaceInText(
  text: string,
  query: string,
  replacement: string,
  opts: ProjectSearchOptions = {},
): { after: string; count: number } {
  const matcher = buildMatcher(query, opts);
  if (!matcher) return { after: text, count: 0 };

  const repl = opts.regex ? replacement : literalReplacement(replacement);
  let count = 0;
  const after = text
    .split('\n')
    .map((line) => {
      matcher.lastIndex = 0;
      const hits = line.match(matcher);
      if (!hits || hits.length === 0) return line;
      count += hits.length;
      matcher.lastIndex = 0;
      return line.replace(matcher, repl);
    })
    .join('\n');

  return { after, count };
}

export function replaceProject(
  files: ReplaceableFile[],
  query: string,
  replacement: string,
  opts: ProjectSearchOptions = {},
  isSource: (path: string) => boolean = isProjectSearchSource,
): ProjectReplacePreview {
  if (buildMatcher(query, opts) === null) return { files: [], totalMatches: 0, totalFiles: 0 };

  const changed: FileReplacement[] = [];
  let totalMatches = 0;

  for (const file of files) {
    if (!isSource(file.path)) continue;
    const { after, count } = replaceInText(file.text, query, replacement, opts);
    if (count === 0 || after === file.text) continue; // no match, or replace-with-self
    changed.push({ path: file.path, before: file.text, after, count });
    totalMatches += count;
  }

  return { files: changed, totalMatches, totalFiles: changed.length };
}
