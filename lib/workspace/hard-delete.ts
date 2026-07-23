import type { SupabaseClient } from '@supabase/supabase-js';

// A workspace with a cloned repo can hold thousands of files rows and tens of
// thousands of doc_edits rows; deleting the projects row then exceeds
// Postgres's statement timeout because the FK cascade does all of that work
// in one statement (doc_edits.file_id is ON DELETE SET NULL from files, so
// the files cascade also rewrites doc_edits). Pre-deleting these tables in
// chunks keeps every statement small; the final projects delete only has the
// low-cardinality cascades left. doc_edits must go before files so the files
// delete has no doc_edits rows left to SET NULL.
const BULK_CHILD_TABLES = [
  { table: 'doc_edits', fk: 'workspace_id' },
  { table: 'files', fk: 'project_id' },
] as const;

// PostgREST encodes `.in('id', ids)` filters into the request URL, so the
// chunk size is bounded by URL-length limits, not by Postgres: 200 UUIDs is
// ~7.5KB of query string, comfortably under common proxy caps.
export const CHUNK_SIZE = 200;

export async function hardDeleteProjects(
  supabase: SupabaseClient,
  projectIds: string[],
): Promise<void> {
  if (projectIds.length === 0) return;

  for (const { table, fk } of BULK_CHILD_TABLES) {
    for (;;) {
      const { data, error } = await supabase
        .from(table)
        .select('id')
        .in(fk, projectIds)
        .limit(CHUNK_SIZE);
      if (error) throw new Error(error.message);
      const ids = (data ?? []).map(row => row.id);
      if (ids.length === 0) break;
      const { error: deleteError } = await supabase.from(table).delete().in('id', ids);
      if (deleteError) throw new Error(deleteError.message);
      if (ids.length < CHUNK_SIZE) break;
    }
  }

  const { error } = await supabase.from('projects').delete().in('id', projectIds);
  if (error) throw new Error(error.message);
}
