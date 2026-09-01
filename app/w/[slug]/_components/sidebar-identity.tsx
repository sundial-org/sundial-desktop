'use client';

import { useState } from 'react';
import { SignInIcon } from '@phosphor-icons/react';
import { getInitials } from '@/components/collab-bubbles';

/**
 * Loud claim nudge for an anon OWNER who is signed out: the workspace lives
 * on their cookie, so losing the link (or the browser profile) loses the
 * workspace. Anchored above the footer with an arrow pointing DOWN at the
 * Log in button it wants clicked; claim-on-login does the rest. Dismissible
 * per session ("Later"), and never rendered once signed in.
 *
 * `claimUrl` (embedded side-panel browsers, e.g. ChatGPT's) adds a second
 * option: copy the ownership link and claim in the browser that already
 * knows you. The panel browser has no Google session, so "Log in" there
 * means the email-code path — real, but not the one-click people expect —
 * and both doors stay visible per product direction.
 */
export function ClaimOwnershipNudge({
  show,
  onLogIn,
  onDismiss,
  claimUrl = null,
}: {
  show: boolean;
  onLogIn: () => void;
  onDismiss: () => void;
  claimUrl?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  if (!show) return null;
  const copyClaimUrl = () => {
    if (!claimUrl) return;
    void navigator.clipboard?.writeText(claimUrl).then(
      () => setCopied(true),
      () => setCopied(true), // the text also lives in the chat; keep flowing
    );
  };
  return (
    <div
      data-testid="claim-ownership-nudge"
      className="absolute bottom-full left-2 right-2 z-20 mb-3 rounded-2xl border border-stone-300 bg-white p-3 shadow-xl"
    >
      <p className="text-[12px] font-semibold text-stone-900">This workspace is yours, but only in this browser.</p>
      <p className="mt-1 text-[11px] leading-4 text-stone-500">
        Log in to claim it, so it is saved to your account and reachable from anywhere.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={onLogIn}
          data-testid="claim-ownership-login"
          className="rounded-md bg-stone-900 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-stone-800"
        >
          Log in to claim
        </button>
        {claimUrl ? (
          <button
            type="button"
            onClick={copyClaimUrl}
            data-testid="claim-ownership-copy-link"
            className="rounded-md border border-stone-300 px-2.5 py-1 text-[11px] font-medium text-stone-700 transition-colors hover:bg-stone-100"
          >
            {copied ? 'Copied. Open it in your usual browser' : 'Copy link for your browser'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          data-testid="claim-ownership-later"
          className="text-[11px] font-medium text-stone-500 hover:text-stone-700"
        >
          Later
        </button>
      </div>
      {/* The arrow: a rotated square whose visible corner points at Log in. */}
      <span
        className="absolute -bottom-1.5 left-7 h-3 w-3 rotate-45 border-b border-r border-stone-300 bg-white"
        aria-hidden
      />
    </div>
  );
}

/**
 * The project sidebar footer's identity slot: a filled Log in button when
 * signed out, the avatar + display name when signed in — followed by a flex
 * spacer that pushes the trailing pills/gear to the sidebar's right edge.
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
  const spacer = <span className="min-w-0 flex-1" aria-hidden />;

  if (!hasMounted || !authReady) {
    return (
      <>
        <span className="h-6 w-6 shrink-0 rounded-full bg-stone-200" aria-hidden />
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
        aria-label={`Profile · ${name}`}
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
      {spacer}
    </>
  );
}
