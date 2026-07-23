// Normalize an agent-supplied *scope* path for GET /grep and GET /files
// (`?path=`). Agents routinely send the sandbox mount (`/workspace/src`) or a
// `./`-prefixed / dot path; grep_workspace and the LIKE pushdown match exact
// workspace-relative prefixes, so those must be stripped first or the scope
// silently matches nothing. Mirrors Sunny's normalizeWorkspacePath
// (agent-ts/src/tools/paths.ts) for these cases, but is lenient: it returns ''
// for "whole workspace" (`.`, `/`, `/workspace`) instead of throwing, since the
// scope param is optional. Still rejects `..` escapes.
export function normalizeScopePath(input: string): string {
  const raw = input
    .trim()
    .replace(/^\/workspace(?:\/|$)/, '') // sandbox mount point
    .replace(/^\/+/, ''); // any other leading slash
  const out: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('path may not contain `..`');
    out.push(part);
  }
  return out.join('/');
}
