import { LATEX_IMAGE_EXT_RE } from '@/lib/workspace/latex-image';

/**
 * Pure project-wide search over LaTeX project sources (§12.2). The editor's
 * Monaco widget already covers in-file find/replace (§12.1); this engine powers
 * the cross-file search panel: it scans the text of every `.tex|.bib|.sty|.cls`
 * source plus the *paths* of figure files, so "where is fig:flow used / where
 * does flow.png live" both resolve from one query.
 *
 * Dependency-free — callers hand in already-loaded `{ path, text }` files, so it
 * never touches the DB and is unit-tested directly.
 */

export type SearchableFile = { path: string; text: string };

export type ProjectSearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
};

export type ProjectSearchMatch = {
  path: string;
  /** 1-based line number; 0 for a figure path-name match (no content line). */
  line: number;
  /** 1-based column of the match start within the line. */
  column: number;
  /** Full text of the matched line (for content matches) or the path. */
  lineText: string;
  matchText: string;
  kind: 'content' | 'path';
};

const TEXT_SOURCE_RE = /\.(?:tex|bib|sty|cls)$/iu;

/** Default cap so a pathological query ("e") can't return a megabyte of hits. */
const MAX_MATCHES = 500;

export function isProjectSearchSource(path: string): boolean {
  return TEXT_SOURCE_RE.test(path);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Build the per-query matcher; returns null for an empty or invalid pattern. */
export function buildMatcher(query: string, opts: ProjectSearchOptions): RegExp | null {
  if (query === '') return null;
  let source = opts.regex ? query : escapeRegExp(query);
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  const flags = opts.caseSensitive ? 'gu' : 'giu';
  try {
    return new RegExp(source, flags);
  } catch {
    return null; // malformed user regex → no results rather than a throw
  }
}

/**
 * Search the project. Content matches come from `.tex|.bib|.sty|.cls` text;
 * figure files (png/pdf/…) contribute path-name matches only. Results are
 * grouped by file in input order, capped at `maxMatches`.
 */
export function searchProject(
  files: SearchableFile[],
  query: string,
  opts: ProjectSearchOptions = {},
  maxMatches: number = MAX_MATCHES,
  // Which paths get content search. Cloud stays LaTeX-shaped; local projects
  // pass a wider predicate (their text set is arbitrary).
  isSource: (path: string) => boolean = isProjectSearchSource,
): ProjectSearchMatch[] {
  const matcher = buildMatcher(query, opts);
  if (!matcher) return [];

  const results: ProjectSearchMatch[] = [];

  const pathMatcher = () => {
    matcher.lastIndex = 0;
    return matcher;
  };

  for (const file of files) {
    if (results.length >= maxMatches) break;

    if (isSource(file.path)) {
      const lines = file.text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (results.length >= maxMatches) break;
        const lineText = lines[i]!;
        matcher.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = matcher.exec(lineText)) !== null) {
          results.push({
            path: file.path,
            line: i + 1,
            column: m.index + 1,
            lineText,
            matchText: m[0],
            kind: 'content',
          });
          if (m[0].length === 0) matcher.lastIndex += 1; // avoid zero-width loop
          if (results.length >= maxMatches) break;
        }
      }
      continue;
    }

    // Figure / other binary files: match the path itself (§12.2 "figure paths").
    if (LATEX_IMAGE_EXT_RE.test(file.path)) {
      const re = pathMatcher();
      const m = re.exec(file.path);
      if (m) {
        results.push({
          path: file.path,
          line: 0,
          column: m.index + 1,
          lineText: file.path,
          matchText: m[0],
          kind: 'path',
        });
      }
    }
  }

  return results;
}
