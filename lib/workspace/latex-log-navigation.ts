// Pure helpers that turn parsed compile-log items into editor navigation
// targets and gutter markers (spec §1.9). Framework-free so both sit under
// plain unit tests; the page wires them to workspaceFileByPath + Monaco.

import type { LatexLogItem, LatexLogSeverity } from '@/lib/workspace/latex-log-parser';
import { resolveWorkspacePath } from '@/lib/workspace/latex-root';

/**
 * Map a path as printed in the compile log to a workspace path, or null when
 * the file isn't in the project (a system `.sty`, a sandbox temp file).
 *
 * tectonic runs with cwd = the root's directory and the workspace tree
 * mirrored underneath, so log paths are root-dir-relative (`../shared.tex`,
 * tried root-dir-first then workspace-relative) or absolute sandbox paths
 * (`/tmp/compile-xyz/work/paper/a.tex`, `/workspace/paper/a.tex`), which are
 * taken relative to that mirror root only — never by loose suffix, so a system
 * `article.cls` can't hit a same-named workspace file. `\input{chapters/intro}`
 * is logged extension-less, so a bare name also tries `.tex`.
 */
export function resolveLatexLogPath(
  file: string | null | undefined,
  rootPath: string | null | undefined,
  hasPath: (path: string) => boolean,
): string | null {
  if (!file) return null;
  const clean = file.trim().replace(/\\/g, '/');
  const segments = clean.split('/').filter((s) => s && s !== '.');
  if (segments.length === 0) return null;
  let bases: string[];
  if (clean.startsWith('/')) {
    const mount = segments.findIndex((s) => s === 'work' || s === 'workspace');
    if (mount < 0) return null;
    bases = [segments.slice(mount + 1).join('/')];
  } else {
    // `..` segments (`\input{../shared}`) collapse against the root's directory.
    bases = [resolveWorkspacePath(rootPath, clean), resolveWorkspacePath(null, clean)];
  }
  const hasExt = /\.[^./]+$/.test(segments[segments.length - 1]!);
  for (const base of bases) {
    for (const candidate of hasExt ? [base] : [base, `${base}.tex`]) {
      if (candidate && hasPath(candidate)) return candidate;
    }
  }
  return null;
}

export interface LatexMarker {
  line: number;
  severity: Exclude<LatexLogSeverity, 'badbox'>;
  message: string;
}

/**
 * Gutter/squiggle markers for one open file: every error/warning whose
 * resolved path is `path` and whose line is known. Bad boxes are off by
 * default (noise), and same-line duplicates collapse into one marker whose
 * hover lists each message.
 */
export function buildLatexMarkers(
  items: Array<LatexLogItem & { path: string | null; count?: number }>,
  path: string | null,
): LatexMarker[] {
  if (!path) return [];
  const byLine = new Map<number, LatexMarker>();
  for (const item of items) {
    if (item.path !== path || item.line == null || item.severity === 'badbox') continue;
    // Items arrive pre-collapsed (IC8) — surface the occurrence count so a
    // line with several identical errors doesn't read as just one.
    const head = (item.count ?? 1) > 1 ? `${item.message} (×${item.count})` : item.message;
    const message = item.rawExcerpt && item.rawExcerpt !== item.message
      ? `${head}\n\n${item.rawExcerpt}`
      : head;
    const existing = byLine.get(item.line);
    if (!existing) {
      byLine.set(item.line, { line: item.line, severity: item.severity, message });
      continue;
    }
    if (item.severity === 'error') existing.severity = 'error';
    existing.message += `\n\n${message}`;
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}
