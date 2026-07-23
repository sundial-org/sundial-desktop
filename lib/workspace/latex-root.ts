// Single source of truth for "which .tex compiles" — the LaTeX main document.
//
// Resolution order (spec §3 / IC2):
//   `% !TEX root` magic comment → active file if it has `\documentclass` →
//   nearest containing root → single `\documentclass` root → ambiguous.
//
// Pure and dependency-free on purpose: the Next app imports it directly, and
// the agent brain keeps a byte-identical mirror at agent-ts/src/latex/latex-root.ts
// (agent-ts can't import from lib/ — see that file's header). Touching this file
// means updating the mirror and re-running both parity test suites.

export type LatexRootReason = 'magic' | 'active' | 'nearest' | 'single' | 'ambiguous' | 'none';

export interface LatexRootResolution {
  /** The resolved main document path, or null when ambiguous / none. */
  root: string | null;
  reason: LatexRootReason;
  /** `.tex` files containing an uncommented `\documentclass` — the selectable roots. */
  candidates: string[];
}

export interface ResolveLatexRootInput {
  texFiles: Array<{ path: string; content: string }>;
  /** The file currently open in the editor; used for `% !TEX root` and active-root preference. */
  activeFile?: string | null;
}

/** Strip a LaTeX line comment (an unescaped `%` to end of line). */
function stripComment(line: string): string {
  return line.replace(/(?<!\\)%.*$/u, '');
}

/** True when the source has a `\documentclass` outside a comment. */
function hasDocumentClass(content: string): boolean {
  for (const line of content.split('\n')) {
    if (/\\documentclass\b/u.test(stripComment(line))) return true;
  }
  return false;
}

/**
 * Read a `% !TEX root = path` magic comment from the head of a file. Editors
 * (TeXShop/VS Code/Overleaf) only honor it near the top, so we scan the first
 * 20 lines. Returns the raw target path, or null.
 */
export function parseTexRootMagicComment(source: string): string | null {
  const lines = source.split('\n', 20);
  for (const line of lines) {
    const match = line.match(/^\s*%\s*!TEX\s+root\s*=\s*(.+?)\s*$/iu);
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * Normalize `target` against the directory of `fromFile`, collapsing `.`/`..`
 * and clamping at the workspace root (a `..` that would escape is dropped).
 * Paths are workspace-relative with forward slashes and no leading `./` or `/`.
 */
export function resolveWorkspacePath(fromFile: string | null | undefined, target: string): string {
  const clean = target.trim().replace(/\\/g, '/');
  // Absolute targets are taken relative to the workspace root.
  const baseSegments = clean.startsWith('/')
    ? []
    : (fromFile ?? '').split('/').slice(0, -1);
  const out: string[] = [...baseSegments];
  for (const segment of clean.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash) : '';
}

function containsPath(dir: string, path: string): boolean {
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

export function resolveLatexRoot(input: ResolveLatexRootInput): LatexRootResolution {
  const byPath = new Map<string, string>();
  for (const file of input.texFiles) {
    if (typeof file?.path === 'string' && typeof file?.content === 'string') {
      byPath.set(file.path, file.content);
    }
  }
  const candidates = Array.from(byPath.entries())
    .filter(([, content]) => hasDocumentClass(content))
    .map(([path]) => path)
    .sort();

  // 1. `% !TEX root` in the active file, resolved relative to it.
  const activeFile = input.activeFile ?? null;
  if (activeFile && byPath.has(activeFile)) {
    const activeContent = byPath.get(activeFile)!;
    const magic = parseTexRootMagicComment(activeContent);
    if (magic) {
      const resolved = resolveWorkspacePath(activeFile, magic);
      if (byPath.has(resolved)) {
        return { root: resolved, reason: 'magic', candidates };
      }
    }

    // 2. If the open file is independently compilable, compile it. This matches
    // Overleaf's least-surprising behavior and avoids "multiple roots" when the
    // user is literally looking at one of those roots.
    if (candidates.includes(activeFile) && hasDocumentClass(activeContent)) {
      return { root: activeFile, reason: 'active', candidates };
    }

    // 3. For an included fragment, prefer the deepest candidate in an ancestor
    // directory. This handles projects like `paper.tex` + `tutorial/paper.tex`
    // while editing `tutorial/section.tex` without a visible root chooser.
    if (candidates.length > 1) {
      const containingRoots = candidates
        .filter((candidate) => containsPath(dirname(candidate), activeFile))
        .sort((a, b) => dirname(b).length - dirname(a).length);
      if (
        containingRoots.length > 0 &&
        (containingRoots.length === 1 || dirname(containingRoots[0]!) !== dirname(containingRoots[1]!))
      ) {
        return { root: containingRoots[0]!, reason: 'nearest', candidates };
      }
    }
  }

  // 4. Auto-infer from `\documentclass`.
  if (candidates.length === 1) {
    return { root: candidates[0]!, reason: 'single', candidates };
  }
  if (candidates.length > 1) {
    return { root: null, reason: 'ambiguous', candidates };
  }
  return { root: null, reason: 'none', candidates: [] };
}
