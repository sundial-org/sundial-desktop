import { LOCAL_BACKING_WORKSPACE_KIND, type WorkspaceKind } from '@/lib/workspace/kinds';
import type { SupabaseClient } from '@supabase/supabase-js';

export const LOCAL_BACKING_GITHUB_SYNC_CODE = 'LOCAL_FOLDER_GIT_AUTHORITY';
export const LOCAL_BACKING_GITHUB_SYNC_ERROR =
  'This workspace mirrors a local folder. Keep GitHub managed by the local checkout; Sundial will continue syncing file contents live.';

export function blocksGithubContentSync(kind: WorkspaceKind | null | undefined): boolean {
  return kind === LOCAL_BACKING_WORKSPACE_KIND;
}

/** Resolve local-folder backing ids in one query. A failed lookup blocks every
 *  candidate: uncertainty must not resurrect a second Git writer. */
export async function blockedLocalBackingProjectIds(
  supabase: SupabaseClient,
  projectIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return new Set();
  let data: Array<{ id: string; kind: string }> | null = null;
  let error: unknown = null;
  try {
    ({ data, error } = await supabase.from('projects').select('id, kind').in('id', ids));
  } catch (e) {
    error = e;
  }
  if (error) return new Set(ids);
  const seen = new Set((data ?? []).map((project) => project.id as string));
  return new Set([
    ...ids.filter((id) => !seen.has(id)),
    ...(data ?? [])
      .filter((project) => project.kind === LOCAL_BACKING_WORKSPACE_KIND)
      .map((project) => project.id as string),
  ]);
}
