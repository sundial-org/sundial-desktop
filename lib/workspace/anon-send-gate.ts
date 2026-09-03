/**
 * The client-side pre-gate that stops a cloud agent run and asks for sign-in
 * before anything is persisted. The server's run gate is the authority; this
 * only decides whether to explain the cloud-account requirement FIRST instead
 * of letting a doomed send fail in the transcript.
 *
 * The subtlety this exists for: `/api/workspace/files` reports
 * `anonRunsRemaining` only for anonymous callers, so BOTH a server-authed
 * caller (Clerk cookie, or an `sd_` bearer / loopback-sidecar session that is
 * not Clerk-signed-in in the browser) and a genuinely anonymous visitor with
 * no allowance read `null` there. Gating on that field alone therefore either
 * blocks bearer-authed sends (staging post-deploy runtime e2e, 76/76 -> 66/76)
 * or lets the sign-in wall vanish for real anonymous visitors. `serverAuthed`
 * is the field that tells them apart, so the gate keys off it.
 */
export function needsCloudSignIn(args: {
  /** Clerk finished loading (or is known never to load in this shell). */
  clerkResolved: boolean;
  clerkSignedIn: boolean;
  /** Did the SERVER recognize an identity on our last files read? `null` =
   *  never reported (no payload yet, local sidecar payload, older server). */
  serverAuthed: boolean | null;
  /** Free anonymous runs left; `null` = not an anon-owned workspace, or
   *  unknown. */
  anonRunsRemaining: number | null;
}): boolean {
  const { clerkResolved, clerkSignedIn, serverAuthed, anonRunsRemaining } = args;
  if (!clerkResolved || clerkSignedIn) return false;
  // Only an EXPLICIT false is certainty that the caller is anonymous; unknown
  // defers to the server, which answers signin_required honestly if it really
  // applies. Never nag on unknown — a false nag blocks a send the server
  // would have served, which is strictly worse than a late honest refusal.
  if (serverAuthed !== false) return false;
  // Anonymous with free runs left: the server serves the send on the pinned
  // cheap model, so step aside.
  return !((anonRunsRemaining ?? 0) > 0);
}
