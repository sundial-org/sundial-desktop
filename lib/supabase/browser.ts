import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { pathShareRealtimeToken } from '@/lib/workspace/path-share-token-client';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

let _client: SupabaseClient | null = null;

/**
 * Returns a singleton Supabase browser client.
 *
 * The `accessToken` callback fetches a fresh Clerk session token from the global
 * `window.Clerk` instance (set up by `<ClerkProvider>` in `app/layout.tsx`).
 * Supabase verifies that token against the registered Clerk third-party-auth
 * issuer (`clerk.sundial.md` / `moral-oyster-95.clerk.accounts.dev`) and treats
 * the request as the `authenticated` Postgres role. RLS policies read
 * `auth.jwt() ->> 'sub'` (the Clerk user id) for owner/membership checks.
 *
 * Tabs holding a `?pshare=` link token prefer the path-share realtime JWT
 * (minted by /api/workspace/realtime-token; RLS honors its `pshare` claim,
 * and it embeds the Clerk sub for signed-in visitors so member access rides
 * along). Without one: the Clerk token, else null → bare `anon` role.
 */
export function createBrowserClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseKey) return null;
  if (!_client) {
    _client = createClient(supabaseUrl, supabaseKey, {
      accessToken: async () => {
        if (typeof window === 'undefined') return null;
        // pshare first: a signed-in NON-member's Clerk JWT holds no workspace
        // access, while the minted JWT carries both their sub and the claim.
        // No-op (null, no fetch) for tabs without a sticky link token.
        const pshareJwt = await pathShareRealtimeToken();
        if (pshareJwt) return pshareJwt;
        const clerk = (window as unknown as { Clerk?: { session?: { getToken: () => Promise<string | null> } } }).Clerk;
        try {
          return (await clerk?.session?.getToken()) ?? null;
        } catch {
          return null;
        }
      },
    });
  }
  return _client;
}
