export const LINK_INVITE_EMAIL = '__link__';

export type InviteRecord = {
  email: string | null;
  expires_at: string;
  accepted_at: string | null;
};

type ClerkEmail = { emailAddress?: string | null; verification?: { status?: string | null } | null };

/** Only VERIFIED addresses count as an invite identity: anyone can add
 *  `invited@example.com` to their Clerk account, so an unverified one would
 *  let a forwarded token be redeemed by someone who never owned the inbox. */
export function verifiedEmails(user: { emailAddresses?: ClerkEmail[] | null } | null | undefined) {
  return (user?.emailAddresses ?? [])
    .filter((entry) => entry?.verification?.status === 'verified')
    .map((entry) => entry?.emailAddress?.trim() ?? '')
    .filter(Boolean);
}

export type InviteProblem =
  | { reason: 'not_found' }
  | { reason: 'expired'; expiresAt: string }
  | { reason: 'already_used' }
  | { reason: 'email_mismatch'; invitedEmail: string; signedInAs: string | null }
  | { reason: 'revoked' };

/** Read-only verdict on an invite. Pure: the accept page renders it on GET
 *  without touching a single row, so a mail scanner or link prefetcher that
 *  opens the URL can never consume the invite. The claim RPC re-runs the same
 *  checks inside its row lock when the recipient actually submits. */
export function evaluateInvite(args: {
  invite: InviteRecord | null | undefined;
  userEmails: readonly string[];
  now?: number;
}): InviteProblem | null {
  const { invite } = args;
  if (!invite) return { reason: 'not_found' };

  const now = args.now ?? Date.now();
  const expiresAt = Date.parse(invite.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt < now) {
    return { reason: 'expired', expiresAt: invite.expires_at };
  }

  // Link invites carry no addressee and re-admit forever; email invites are
  // addressed and single-use.
  if (invite.email === LINK_INVITE_EMAIL) return null;
  if (!invite.email) return { reason: 'not_found' };

  const invitedEmail = invite.email.toLowerCase();
  const userEmails = args.userEmails.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!userEmails.includes(invitedEmail)) {
    return { reason: 'email_mismatch', invitedEmail: invite.email, signedInAs: args.userEmails[0] ?? null };
  }
  if (invite.accepted_at) return { reason: 'already_used' };
  return null;
}

/** Every dead end tells the recipient WHY and what to do next. The old page
 *  said "invalid or has already been used" for all of them, which left prod
 *  users (Aug 2026) clicking the same dead link over and over. */
export function inviteProblemCopy(problem: InviteProblem): {
  title: string;
  reason: string;
  recovery: string;
} {
  switch (problem.reason) {
    case 'expired': {
      const on = formatInviteDate(problem.expiresAt);
      return {
        title: 'This invite has expired',
        reason: on ? `Invite links last 7 days, and this one expired on ${on}.` : 'Invite links last 7 days, and this one has run out.',
        recovery: 'Ask the person who invited you to send a new invite.',
      };
    }
    case 'already_used':
      return {
        title: 'This invite has already been used',
        reason: 'Email invites work once, and this one was already accepted.',
        recovery: 'If you still need access, ask the person who invited you to send a new invite.',
      };
    case 'email_mismatch':
      return {
        title: 'This invite is for a different email',
        reason: problem.signedInAs
          ? `The invite was sent to ${problem.invitedEmail}, and you are signed in as ${problem.signedInAs}.`
          : `The invite was sent to ${problem.invitedEmail}.`,
        recovery: `Sign out and sign back in with ${problem.invitedEmail}, or ask the sender to invite the address you use.`,
      };
    case 'revoked':
      return {
        title: 'This invite is no longer valid',
        reason: 'It was revoked or replaced while you were opening it.',
        recovery: 'Ask the person who invited you to send a new invite.',
      };
    default:
      return {
        title: 'This invite link is not valid',
        reason: 'We could not find an invite for this link. Sending a new invite replaces the old link, so an older email stops working.',
        recovery: 'Open the most recent invite email, or ask the person who invited you to send a new one.',
      };
  }
}

function formatInviteDate(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
