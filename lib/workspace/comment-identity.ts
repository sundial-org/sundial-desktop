import { anonDisplayName, toAnonAuthorId } from '@/lib/auth/anon-identity';
import type { DesktopProfile } from '@/lib/local/use-desktop-profile';

/** Who the workspace UI is commenting as. This must resolve to the SAME person
 *  the comments route stamps on the persisted row (`getAuthorSnapshot`), or the
 *  draft composer shows one identity and the sent comment another. Three ways a
 *  page holds that identity:
 *   - a Clerk session in the page (cloud web),
 *   - the sd_-credential profile behind /api/user when clerk-js never loaded
 *     (packaged desktop app) — the server still attributes to that Clerk user,
 *   - the anon visitor cookie, whose author id and cute display name the route
 *     derives the very same way.
 */
export type CommentIdentity = {
  userId: string | null;
  name: string | null;
  username: string | null;
  imageUrl: string | null;
};

function firstText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function resolveCommentIdentity(args: {
  /** Clerk user fields, flat so callers can memoize on them individually. */
  userId?: string | null;
  fullName?: string | null;
  username?: string | null;
  imageUrl?: string | null;
  /** sd_-credential profile; only present when the page has no Clerk user. */
  desktopProfile?: Pick<DesktopProfile, 'id' | 'name' | 'imageUrl'> | null;
  anonId?: string | null;
}): CommentIdentity {
  const { userId, fullName, username, imageUrl, desktopProfile, anonId } = args;
  // A signed-in identity outranks the anon cookie: the desktop webview keeps
  // one even while its sd_ credentials sign the requests, and the server
  // attributes those writes to the Clerk user, not to `anon:<id>`.
  const clerkId = userId ?? desktopProfile?.id ?? null;
  if (clerkId) {
    return {
      // Only labels `getAuthorSnapshot` also stamps (Clerk full name, then
      // username). An email or the anon animal would read fine in the draft and
      // then flip on the server echo — the very bug this prevents. Nameless
      // stays nameless, and the panel says "You" on both sides of the send.
      userId: clerkId,
      name: firstText(fullName, username, desktopProfile?.name),
      username: firstText(username),
      imageUrl: firstText(imageUrl, desktopProfile?.imageUrl),
    };
  }
  return {
    userId: anonId ? toAnonAuthorId(anonId) : null,
    name: anonId ? anonDisplayName(anonId) : null,
    username: null,
    imageUrl: null,
  };
}
