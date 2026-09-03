import type { SupabaseClient } from '@supabase/supabase-js';
import { isPathShareRole, type PathShareRole } from '@/lib/workspace/path-grants';

/**
 * The workspace-root grant — "anyone with the link" — as the bare-URL
 * capability check. `getProjectAccess` resolves it into the workspace-wide
 * flags and `resolveAllGrants` merges it in as a grant carrying its own
 * lifetime.
 *
 * With `includeTokened`, a TOKENED root grant admits the bare URL too: the
 * share UI promises "anyone on the internet with the link", and the address
 * bar — not the ?pshare= capability URL — is the link people actually copy.
 * Callers that must keep the bare URL inert (local-backing workspaces, where
 * the token is deliberately the only credential to the owner's disk) leave it
 * off, matching the historical tokenless-only read.
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
  opts?: { includeTokened?: boolean },
): Promise<BareRootGrant | null> {
  let query = supabase
    .from('path_shares')
    .select('link_role, created_at')
    .eq('workspace_id', workspaceId)
    .eq('scope_kind', 'workspace');
  if (!opts?.includeTokened) query = query.is('link_token', null);
  const { data } = await query.maybeSingle();
  if (!isPathShareRole(data?.link_role)) return null;
  return { role: data.link_role, createdAt: typeof data.created_at === 'string' ? data.created_at : null };
}
