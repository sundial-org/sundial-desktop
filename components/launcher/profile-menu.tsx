'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useClerk, useUser } from '@/lib/auth/optional-auth';
import { DESKTOP_CREDENTIALS_EVENT } from '@/lib/desktop';

type FetchedIdentity = { name: string | null; email: string | null; imageUrl: string | null };

/** The home-surface profile control: avatar button opening a small menu that
 *  carries the secondary navigation (Templates, Docs, Profile) and sign-out —
 *  the header itself stays wordmark + search + this. One component for every
 *  dashboard-like surface (web dashboard, /templates via Nav, desktop /local),
 *  so the dropdown is the same everywhere. Clerk-free by design (optional-auth
 *  seam): the packaged desktop shell renders it too, where sign-in lives as
 *  sd_ credentials in the sidecar — no Clerk user object, no sign-out. */
export function ProfileMenu() {
  const { user } = useUser();
  const clerk = useClerk();
  const [open, setOpen] = useState(false);

  // Sidecar-credential sign-ins have no Clerk user object, but the proxy
  // authenticates /api/* with the parked sd_ token — GET /api/user resolves
  // the same name/email/avatar, so the menu isn't a nameless "?" there.
  // Stale credentials just 401 and leave the generic fallback.
  const [fetched, setFetched] = useState<FetchedIdentity | null>(null);
  // A desktop re-sign-in lands new sd_ credentials without touching `user`
  // (still null) — the event is the only signal to drop the previous
  // account's identity and refetch.
  const [credentialsEpoch, setCredentialsEpoch] = useState(0);
  useEffect(() => {
    const bump = () => setCredentialsEpoch((n) => n + 1);
    window.addEventListener(DESKTOP_CREDENTIALS_EVENT, bump);
    return () => window.removeEventListener(DESKTOP_CREDENTIALS_EVENT, bump);
  }, []);
  useEffect(() => {
    if (user) return;
    setFetched(null);
    let cancelled = false;
    fetch('/api/user')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { user?: FetchedIdentity } | null) => {
        if (!cancelled && data?.user) setFetched(data.user);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, credentialsEpoch]);

  const name = user?.fullName || user?.username || fetched?.name || '';
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    fetched?.email ??
    null;
  const handleLine = user?.username ? `@${user.username}` : email;
  const imageUrl = user?.imageUrl || fetched?.imageUrl || null;

  const item = 'flex w-full items-center px-4 py-2 text-left text-sm text-stone-700 hover:bg-stone-50';

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="profile-menu"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center transition-opacity hover:opacity-80"
        aria-label="Account menu"
      >
        {imageUrl ? (
          <img src={imageUrl} alt="" className="h-8 w-8 rounded-full border border-stone-200" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#c9a57a] to-[#634a31] text-sm font-medium text-white">
            {name[0] || '?'}
          </span>
        )}
      </button>

      {open ? (
        <>
          {/* Click-away backdrop */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          {/* Renders below the header but stays its DOM descendant, so the
              shell's deep drag region would otherwise reach in: pressing the
              identity text or panel padding would drag the window. */}
          <div
            data-tauri-drag-region="false"
            className="absolute right-0 z-50 mt-2 w-48 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
          >
            {name || handleLine ? (
              <div className="border-b border-stone-100 px-4 py-2">
                <div className="truncate text-sm font-medium text-stone-800">{name}</div>
                {handleLine ? <div className="truncate text-xs text-stone-500">{handleLine}</div> : null}
              </div>
            ) : null}
            <Link href="/templates" onClick={() => setOpen(false)} className={item}>
              Templates
            </Link>
            <Link href="/docs" onClick={() => setOpen(false)} className={item}>
              Docs
            </Link>
            {/* /profile needs a Clerk session (it bounces signed-out Clerk to
                /) — sidecar-credential sign-ins have none, so no dead link. */}
            {user ? (
              <Link href="/profile" onClick={() => setOpen(false)} className={item}>
                Profile
              </Link>
            ) : null}
            {clerk.signOut ? (
              <div className="mt-1 border-t border-stone-100 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    void clerk.signOut?.({ redirectUrl: '/' });
                  }}
                  className={item}
                >
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
