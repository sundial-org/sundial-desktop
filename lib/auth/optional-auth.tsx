'use client';

// Optional-Clerk seam. The shared workspace/local surface imports its auth
// hooks and sign-in buttons from HERE instead of @clerk/nextjs, so a build
// with no ClerkProvider (the static desktop UI, which must not depend on
// cloud SDKs) gets signed-out defaults whose sign-in actions route through
// the desktop browser handoff (lib/desktop.ts). The cloud app mounts
// CloudAuthProvider (components/cloud-auth-provider.tsx) at the root to back
// these with real Clerk values. The API is a call-compatible subset of
// @clerk/nextjs — swapping the import path is the whole migration.

import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { beginDesktopAuth, clerkRedirectPath } from '@/lib/desktop';

export type OptionalUser = {
  id: string;
  username?: string | null;
  fullName?: string | null;
  imageUrl?: string;
  primaryEmailAddress?: { emailAddress: string } | null;
  emailAddresses?: Array<{ emailAddress: string }>;
};

export type SignInOptions = {
  redirectUrl?: string;
  forceRedirectUrl?: string;
  fallbackRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
};

export type SignInButtonProps = SignInOptions & {
  mode?: 'modal' | 'redirect';
  children?: ReactNode;
};

export type OptionalAuthState = { isLoaded: boolean; isSignedIn: boolean; userId: string | null };
export type OptionalClerkMethods = {
  openSignIn: (opts?: SignInOptions) => void;
  openSignUp: (opts?: SignInOptions) => void;
  openUserProfile: () => void;
};

export type CloudAuthValue = {
  auth: OptionalAuthState;
  user: OptionalUser | null;
  userLoaded: boolean;
  clerk: OptionalClerkMethods;
  SignInButton: ComponentType<SignInButtonProps>;
  SignUpButton: ComponentType<SignInButtonProps>;
};

export const CloudAuthContext = createContext<CloudAuthValue | null>(null);

const SIGNED_OUT: OptionalAuthState = { isLoaded: true, isSignedIn: false, userId: null };

// Without a provider there is no Clerk at all — sign-in can only mean the
// desktop handoff (system browser + sd_ credentials), same as what
// DesktopAuthInterceptor patches onto Clerk in the proxied app.
const desktopSignIn = (opts?: unknown) =>
  beginDesktopAuth(clerkRedirectPath(opts) ?? window.location.pathname + window.location.search);

const STUB_CLERK: OptionalClerkMethods = {
  openSignIn: desktopSignIn,
  openSignUp: desktopSignIn,
  openUserProfile: () => {},
};

export function useAuth(): OptionalAuthState {
  return useContext(CloudAuthContext)?.auth ?? SIGNED_OUT;
}

export function useUser(): { user: OptionalUser | null; isLoaded: boolean; isSignedIn: boolean } {
  const ctx = useContext(CloudAuthContext);
  if (!ctx) return { user: null, isLoaded: true, isSignedIn: false };
  return { user: ctx.user, isLoaded: ctx.userLoaded, isSignedIn: ctx.auth.isSignedIn };
}

export function useClerk(): OptionalClerkMethods {
  return useContext(CloudAuthContext)?.clerk ?? STUB_CLERK;
}

function StubAuthButton({ children, mode: _mode, ...opts }: SignInButtonProps) {
  return (
    <span style={{ display: 'contents' }} onClick={() => desktopSignIn(opts)}>
      {children}
    </span>
  );
}

export function SignInButton(props: SignInButtonProps) {
  const ctx = useContext(CloudAuthContext);
  if (ctx) return <ctx.SignInButton {...props} />;
  return <StubAuthButton {...props} />;
}

export function SignUpButton(props: SignInButtonProps) {
  const ctx = useContext(CloudAuthContext);
  if (ctx) return <ctx.SignUpButton {...props} />;
  return <StubAuthButton {...props} />;
}
