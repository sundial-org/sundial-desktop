/**
 * Command palette (⌘K) — pure matching/ranking, kept out of the component so
 * scoring is unit-testable. Hand-rolled fzf-lite: a case-insensitive greedy
 * subsequence match where word-boundary hits (start of text, or after
 * `/ - _ .` or a space) and consecutive runs score higher, and earlier /
 * shorter matches win ties.
 */

const BOUNDARY_CHARS = new Set(['/', '-', '_', '.', ' ']);

/** Null when `query` is not a subsequence of `text`; higher is better. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let prev = -2;
  let first = -1;
  let from = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, from);
    if (idx === -1) return null;
    if (idx === prev + 1) score += 3; // consecutive run
    else if (idx === 0 || BOUNDARY_CHARS.has(t[idx - 1])) score += 2; // word boundary
    else score += 1;
    if (first === -1) first = idx;
    prev = idx;
    from = idx + 1;
  }
  // Dense integer bonuses dominate; position/length only break near-ties.
  return score * 100 - first * 2 - t.length;
}

/** Basename hits outrank path-only hits (`spec` should find `docs/spec.md`
 *  before `specs/readme.md`); open/recent files get a small edge on ties. */
const BASENAME_BONUS = 1000;
const PRIORITY_BONUS = 50;

export function scoreFilePath(query: string, path: string): number | null {
  const full = fuzzyScore(query, path);
  if (full === null) return null;
  const base = fuzzyScore(query, path.slice(path.lastIndexOf('/') + 1));
  return base === null ? full : Math.max(full, base + BASENAME_BONUS);
}

/**
 * Rank workspace file paths for the palette. Empty query → `priority` (open /
 * recent, deduped, membership-checked) first, then the remaining `paths` in
 * their given (tree) order. With a query → fuzzy-ranked, priority as a
 * tie-breaking bonus.
 */
export function rankFiles(
  query: string,
  paths: string[],
  priority: string[] = [],
  limit = 12,
): string[] {
  const known = new Set(paths);
  const prioritySet = new Set(priority.filter((p) => known.has(p)));
  const trimmed = query.trim();
  if (!trimmed) {
    return [...prioritySet, ...paths.filter((p) => !prioritySet.has(p))].slice(0, limit);
  }
  return paths
    .map((path, index) => {
      const score = scoreFilePath(trimmed, path);
      return score === null
        ? null
        : { path, index, score: score + (prioritySet.has(path) ? PRIORITY_BONUS : 0) };
    })
    .filter((entry): entry is { path: string; index: number; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.path);
}

export type PaletteActionSpec = {
  id: string;
  label: string;
  /** Extra match-only terms (e.g. "zip export"); never displayed. */
  keywords?: string;
};

/** Empty query → declared order; otherwise fuzzy on label + keywords. */
export function rankActions<T extends PaletteActionSpec>(query: string, actions: T[]): T[] {
  const trimmed = query.trim();
  if (!trimmed) return actions;
  return actions
    .map((action, index) => {
      const label = fuzzyScore(trimmed, action.label);
      const keywords = action.keywords ? fuzzyScore(trimmed, action.keywords) : null;
      const score = label === null ? keywords : keywords === null ? label : Math.max(label, keywords);
      return score === null ? null : { action, index, score };
    })
    .filter((entry): entry is { action: T; index: number; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.action);
}
