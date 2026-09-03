import { productFlavor } from '@/lib/flags/product-flavor';
import { WELCOME_PATH, WELCOME_TEX_PATH } from '@/lib/workspace/welcome-doc';
import { isIgnoredWorkspacePath } from '@/lib/workspace/ignored-paths';
import { isWorkspaceMetaPath } from '@/lib/workspace/spaces';
import { isMarkdownFile } from '@/lib/sync/policy';
import type { WorkspaceFileRow } from '@/lib/workspace/types';

/**
 * The default document a workspace arrival lands on (founder decision,
 * 2026-08-05): the most recently edited text document — the workspace's live
 * center of gravity — then a root README, then the first openable file in the
 * caller's order. Obvious non-content files (dotfiles, config/lockfiles,
 * binaries, runtime meta paths) never win a content pick; they remain only as
 * the very last resort so a workspace containing nothing else still opens
 * something.
 *
 * Order note: callers pass the path-sorted list from `loadWorkspaceFiles`, so
 * every fallback here resolves by PATH. A manual sidebar drag (`fileOrder`) is
 * display-only and ranks siblings within one parent, which cannot order this
 * cross-folder pick — so a reorder deliberately does not move the arrival doc.
 */
export type DefaultDocumentCandidate = Pick<WorkspaceFileRow, 'path' | 'type' | 'updated_at'>;

// Markdown per lib/sync/policy.json (the extension source of truth), plus the
// other prose formats the editor treats as documents.
const isTextDoc = (path: string) => isMarkdownFile(path) || /\.(tex|txt)$/i.test(path);
const CONFIG_RE = /\.(json|jsonc|ya?ml|toml|lock|cfg|ini)$/i;
const README_RE = /^readme(\.[a-z0-9]+)?$/i;

const hasDotSegment = (path: string) => path.split('/').some((segment) => segment.startsWith('.'));

export function pickDefaultDocument<T extends DefaultDocumentCandidate>(files: T[]): T | null {
  // The seeded onboarding doc never wins the landing while any other document
  // exists: eligible new users force it open themselves, and an
  // experienced user creating a template must land in the template, not the
  // tutorial. Only when it is the sole document (blank workspace) does it land.
  // welcome.tex lives at a nested path only we seed, so it is always the
  // tutorial. A root welcome.md is only ours on the general flavor (which
  // seeds it); on the scientific flavor it is a user's own document.
  const isOnboardingDoc = (path: string) =>
    path === WELCOME_TEX_PATH || (path === WELCOME_PATH && productFlavor() === 'general');
  const withoutOnboarding = files.filter((file) => !isOnboardingDoc(file.path));
  if (withoutOnboarding.length !== files.length) {
    const fallback = pickDefaultDocument(withoutOnboarding);
    if (fallback) return fallback;
  }
  const openable = files.filter(
    (file) =>
      file.type !== 'proposal' &&
      file.type !== 'folder' &&
      !isIgnoredWorkspacePath(file.path) &&
      !isWorkspaceMetaPath(file.path),
  );
  const content = openable.filter(
    (file) =>
      file.type === 'text' && !hasDotSegment(file.path) && !CONFIG_RE.test(file.path),
  );
  // 1. Most recently edited text document; timestamp ties keep path order.
  let latest: T | null = null;
  let latestAt = -1;
  for (const file of content) {
    if (!isTextDoc(file.path)) continue;
    const at = Date.parse(file.updated_at ?? '') || 0;
    if (at > latestAt) {
      latest = file;
      latestAt = at;
    }
  }
  if (latest) return latest;
  // 2. A root-level README-like file (readme, readme.rst, …).
  const rootReadme = content.find((file) => !file.path.includes('/') && README_RE.test(file.path));
  if (rootReadme) return rootReadme;
  // 3. First content file in path order, then anything openable — as a last
  //    resort any non-folder file (meta paths included), never a folder.
  return (
    content[0] ??
    openable[0] ??
    files.find((file) => file.type !== 'proposal' && file.type !== 'folder') ??
    null
  );
}
