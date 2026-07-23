import { isIgnoredWorkspacePath } from './ignored-paths';
import type { WorkspaceFileRow, WorkspaceSpace, WorkspaceSpaceKind } from './types';

export interface BuildWorkspaceSpacesOptions {
  labelOverrides?: Record<string, string>;
  kindOverrides?: Record<string, WorkspaceSpaceKind>;
  keyOverrides?: Record<string, string>;
  filter?: (path: string) => boolean;
}

// NOTE: never reserve a name a GitHub repo could plausibly have — a repo named
// `self` once cloned into an entirely invisible file tree (reserved roots are
// filtered from the Files panel). `self` was reserved speculatively, never used.
const RESERVED_WORKSPACE_SPACE_ROOTS = new Set([
  '.agents',
  '.claude',
  '.sundial',
  'meta',
]);

export function isWorkspaceMetaPath(path: string) {
  const rootPath = getWorkspaceRootPath(path);
  return rootPath ? RESERVED_WORKSPACE_SPACE_ROOTS.has(rootPath) : false;
}

export function deriveWorkspaceSpaces(
  workspaceFiles: WorkspaceFileRow[],
  options: BuildWorkspaceSpacesOptions = {}
): WorkspaceSpace[] {
  const roots = new Map<string, WorkspaceSpace>();
  for (const file of workspaceFiles) {
    const normalizedPath = (file.path ?? '').trim();
    if (!normalizedPath) continue;
    const rootPath = getSpaceRootPath(normalizedPath, file.type);
    if (!rootPath) continue;
    if (isIgnoredWorkspacePath(rootPath) || isWorkspaceMetaPath(rootPath)) continue;
    if (options.filter && !options.filter(rootPath)) continue;
    const label = options.labelOverrides?.[rootPath] ?? formatSpaceLabel(rootPath);
    if (!label) continue;
    roots.set(rootPath, {
      label,
      kind: options.kindOverrides?.[rootPath] ?? (rootPath.startsWith('.') ? 'vault' : 'folder'),
      path: rootPath,
      space_key: options.keyOverrides?.[rootPath] ?? rootPath,
    });
  }

  return Array.from(roots.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function getWorkspaceRootPath(path: string) {
  const normalized = path.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (!normalized) return null;
  const [rootPath] = normalized.split('/');
  return rootPath || null;
}

function getSpaceRootPath(path: string, type: WorkspaceFileRow['type']) {
  const normalized = path.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (!normalized) return null;
  const rootPath = getWorkspaceRootPath(normalized);
  if (!rootPath) return null;
  if (!normalized.includes('/')) {
    return type === 'folder' ? rootPath : null;
  }
  return rootPath;
}

function formatSpaceLabel(path: string) {
  const stripped = path.replace(/^[/.]+/, '');
  const segment = stripped.split('/').pop() ?? '';
  const words = segment
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) {
    return segment;
  }
  return words.map(capitalize).join(' ');
}

function capitalize(word: string) {
  return word.length === 0 ? '' : word[0].toUpperCase() + word.slice(1).toLowerCase();
}
