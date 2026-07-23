import type { SupabaseClient } from '@supabase/supabase-js';
import { isIgnoredWorkspacePath } from '@/lib/workspace/ignored-paths';
import type { WorkspaceFileRow } from '@/lib/workspace/types';

const FILE_COLUMNS =
  'id, project_id, parent_file_id, path, type, mime, size, storage_key, blob_sha, is_locked, created_at, updated_at';

/**
 * Single owner of the workspace file-list query. Paginates past 1000 rows and
 * drops runtime-artifact paths. Used by the files API and by the workspace
 * layout's SSR file preload (so the client skips a `/api/workspace/files`
 * round-trip on first paint).
 *
 * `pathPrefix` (optional) pushes a subtree filter into Postgres as a LIKE so
 * scoped listings (GET /files?path=, ?glob=) don't pull the whole tree. Pass a
 * prefix that paths should start with (typically a dir ending in '/').
 *
 * Keyset (not offset) pagination on `path`: a large repo is written
 * concurrently (clone bursts, a folder rename that rewrites hundreds of paths),
 * and an `offset/range` window is not stable under those writes — a row
 * inserted before the window re-appears in the next page (the panel "shows it
 * twice") and a deletion shifts a row past the seam (it "never shows up"). The
 * `(project_id, path)` unique index makes `path` a stable cursor, so each row
 * is seen at most once; the id-keyed map is a final belt-and-suspenders dedupe.
 */
export async function loadWorkspaceFiles(
  supabase: SupabaseClient,
  projectId: string,
  options?: { pathPrefix?: string | null },
): Promise<WorkspaceFileRow[]> {
  const pageSize = 1000;
  const byId = new Map<string, WorkspaceFileRow>();
  let cursor: string | null = null;

  const prefix = options?.pathPrefix?.trim() || '';
  // `%` and `_` are SQL LIKE wildcards; escape them so a literal `_` in a
  // directory name (e.g. `src_v2/`) can't match `srcXv2/`.
  const likePattern = prefix ? `${prefix.replace(/[\\%_]/g, '\\$&')}%` : null;

  for (;;) {
    let query = supabase.from('files').select(FILE_COLUMNS).eq('project_id', projectId);
    if (likePattern) query = query.like('path', likePattern);
    if (cursor !== null) query = query.gt('path', cursor);
    const { data, error } = await query.order('path', { ascending: true }).limit(pageSize);

    if (error) {
      throw error;
    }

    const raw = (data ?? []) as WorkspaceFileRow[];
    for (const entry of raw) {
      if (!isIgnoredWorkspacePath(entry.path)) byId.set(entry.id, entry);
    }
    if (raw.length < pageSize) {
      break;
    }
    cursor = raw[raw.length - 1].path;
  }

  return Array.from(byId.values());
}
