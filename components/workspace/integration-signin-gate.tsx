'use client';

import { SignInIcon } from '@phosphor-icons/react';
import { buildReturnPath, useRequireSignIn } from '@/lib/auth/use-require-signin';

/**
 * Shown in place of any integration's connect UI while the user is logged out.
 * Integrations are account-scoped, so we force Clerk sign-in FIRST — the user
 * signs into Sundial (Google, etc.), then links the provider afterwards.
 * `returnParam` (e.g. `{ panel: 'github' }`) re-deep-links the surface so it
 * reopens after sign-in even though the original param was already consumed.
 */
export function IntegrationSignInGate({
  provider,
  returnParam,
}: {
  provider: string;
  returnParam?: Record<string, string>;
}) {
  const { requireSignIn } = useRequireSignIn();
  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50 p-6 text-center">
      <SignInIcon className="mx-auto h-8 w-8 text-stone-400" weight="bold" aria-hidden />
      <p className="mt-3 text-sm font-medium text-stone-800">Sign in to connect {provider}</p>
      <p className="mt-1 text-xs text-stone-500">
        Sign in to Sundial first. You can link {provider} right after.
      </p>
      <button
        type="button"
        onClick={() => requireSignIn(returnParam ? buildReturnPath(returnParam) : undefined)}
        className="mt-4 inline-flex items-center justify-center rounded-lg bg-stone-900 px-5 py-2 text-sm font-medium text-white hover:bg-stone-800"
      >
        Sign in
      </button>
    </div>
  );
}
