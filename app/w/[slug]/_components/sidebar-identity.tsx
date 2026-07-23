'use client';

import { SignInIcon } from '@phosphor-icons/react';
import { getInitials } from '@/components/collab-bubbles';

/**
 * The project sidebar footer's identity slot: a filled Log in button when
 * signed out, the avatar + display name when signed in — followed by a subtle
 * `beta` badge (always shown) and a flex spacer that pushes the trailing
 * pills/gear to the sidebar's right edge.
 *
 * Clerk auth resolves asynchronously and is unknown at SSR time, so until the
 * component has mounted AND Clerk has loaded we render a stable placeholder.
 * That keeps the server HTML and the first client render identical — otherwise
 * the avatar/name ↔ Log in flip is a React hydration mismatch (the bug this
 * component exists to prevent). `tests/ui/sidebar-identity.test.tsx` guards it.
 */
export function SidebarIdentity({
  hasMounted,
  authReady,
  signedIn,
  imageUrl,
  name,
  onSignIn,
  onOpenProfile,
}: {
  hasMounted: boolean;
  authReady: boolean;
  signedIn: boolean;
  imageUrl?: string | null;
  name: string;
  onSignIn: () => void;
  onOpenProfile: () => void;
}) {
  // Product-stage signal, not an auth signal — rendered in every state so its
  // position never shifts as auth resolves. Muted so it reads as a tag, not a CTA.
  // Lowest-priority footer item: collapses below a narrow footer width (named
  // `@container/footer`) so it yields to the credit/storage warning pills before
  // the row can overflow when the sidebar is dragged toward its minimum.
  const beta = (
    <span className="hidden shrink-0 rounded-full bg-stone-200/70 px-1.5 py-0.5 text-[10px] font-medium text-stone-500 @[12rem]/footer:inline-block">
      beta
    </span>
  );
  const spacer = <span className="min-w-0 flex-1" aria-hidden />;

  if (!hasMounted || !authReady) {
    return (
      <>
        <span className="h-6 w-6 shrink-0 rounded-full bg-stone-200" aria-hidden />
        {beta}
        {spacer}
      </>
    );
  }

  // Logged out / anon has no real profile (2026-06-05 feedback): skip the anon
  // avatar and show a filled Log in CTA where the name usually sits.
  if (!signedIn) {
    return (
      <>
        <button
          type="button"
          onClick={onSignIn}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-stone-900 px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-stone-800"
        >
          <SignInIcon className="h-3.5 w-3.5 shrink-0" weight="bold" aria-hidden />
          Log in
        </button>
        {beta}
        {spacer}
      </>
    );
  }

  // The avatar + name open the user's own profile page (/profile).
  return (
    <>
      <button
        type="button"
        onClick={onOpenProfile}
        aria-label={`Profile — ${name}`}
        className="-ml-1 flex min-w-0 shrink items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-stone-200/60"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-stone-200 text-[10px] font-semibold text-stone-600">
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt="" className="h-full w-full object-cover" draggable={false} />
          ) : (
            getInitials(name)
          )}
        </span>
        <span className="min-w-0 max-w-[120px] truncate text-[13px] font-medium text-stone-700">{name}</span>
      </button>
      {beta}
      {spacer}
    </>
  );
}
