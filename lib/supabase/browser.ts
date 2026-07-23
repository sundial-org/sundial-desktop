import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
 * Anonymous visitors have no Clerk session → callback returns null → Supabase
 * uses the bare `anon` role. RLS policies cover that branch via `auth.role()`.
 */
export function createBrowserClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseKey) return null;
  if (!_client) {
    _client = createClient(supabaseUrl, supabaseKey, {
      accessToken: async () => {
        if (typeof window === 'undefined') return null;
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
