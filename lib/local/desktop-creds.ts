import { DESKTOP_CREDENTIALS_EVENT } from '@/lib/desktop';
import { sidecar, type SidecarConfig } from './sidecar';

// Parked sd_ credentials can be stale (expired/revoked) while /agent-credentials
// still reports configured — it only checks that a record exists. Before letting
// them stand in for a signed-in session, validate with a real authenticated
// cloud call (same signal /local uses), cached until the next desktop sign-in
// parks fresh credentials.
// Successes are re-checked after a short TTL — a token revoked mid-session
// must route back to sign-in, not bypass it for the rest of the SPA session.
// Rejections stick until a new sign-in parks fresh credentials (the event).
const VALIDATED_TTL_MS = 60_000;
let validated: { value: boolean; at: number } | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener(DESKTOP_CREDENTIALS_EVENT, () => {
    validated = null;
  });
}

/** Whether the sidecar's parked credentials can authenticate this page's cloud
 *  calls. Only true on the proxy origin — that's the only place page-relative
 *  /api/* fetches carry the sd_ bearer (see useDesktopCredentials). Fails open
 *  on network errors so transient offline doesn't loop sends into sign-in. */
export async function desktopCredentialsUsable(config: SidecarConfig): Promise<boolean> {
  if (typeof window === 'undefined' || window.location.origin !== config.origin) return false;
  const configured = await sidecar
    .agentCredentialsConfigured(config)
    .then(({ configured: value }) => Boolean(value))
    .catch(() => false);
  if (!configured) return false;
  if (!validated || (validated.value && Date.now() - validated.at > VALIDATED_TTL_MS)) {
    const value = await fetch('/api/workspaces')
      .then((res) => res.status !== 401 && res.status !== 403)
      .catch(() => true);
    validated = { value, at: Date.now() };
  }
  return validated.value;
}
