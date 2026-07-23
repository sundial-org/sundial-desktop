import { isIgnoredPath } from '@/lib/sync/policy';

export function isIgnoredWorkspacePath(path: string | null | undefined): boolean {
  return isIgnoredPath(path);
}
