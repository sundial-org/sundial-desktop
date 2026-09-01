import type { SupabaseClient } from '@supabase/supabase-js';
import { isPathShareRole, type PathShareRole } from '@/lib/workspace/path-grants';

/**
 * The TOKENLESS workspace-root grant — "anyone with the bare URL", the
 * unified replacement for legacy `visibility='public'`. It matches every
 * visitor, with no token and no identity, so both halves of the scoped-access
 * path need it: `getProjectAccess` to resolve the workspace-wide flags, and
 * `resolveAllGrants` to merge it in as a grant carrying its own lifetime.
 *
 * Its own module rather than a helper on either side: `path-access` already
 * imports `access` for `getProjectAccess`, and hanging a second export off
 * that edge means every test mocking `@/lib/workspace/access` silently loses
 * this query too.
 */
export type BareRootGrant = { role: PathShareRole; createdAt: string | null };

/** A lookup failure reads as "no grant" — fails closed, like the inline
 *  queries this replaced. */
export async function readBareRootGrant(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<BareRootGrant | null> {
  const { data } = await supabase
    .from('path_shares')
    .select('link_role, created_at')
    .eq('workspace_id', workspaceId)
    .eq('scope_kind', 'workspace')
    .is('link_token', null)
    .maybeSingle();
  if (!isPathShareRole(data?.link_role)) return null;
  return { role: data.link_role, createdAt: typeof data.created_at === 'string' ? data.created_at : null };
}
