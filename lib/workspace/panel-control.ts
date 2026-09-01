/**
 * Agent view-control for embedded panels (?view=panel): the panel is a
 * DISPLAY the agent steers over HTTP, never a browser it drives. GET /g/show
 * broadcasts a command on the workspace's panel-control channel; every open
 * panel for that workspace obeys live (no reload). Normal workspace views
 * ignore the channel entirely — a human's full editor is theirs to arrange.
 */

// No `split` here: the panel renders ONE surface at a time (the human is
// lending half a screen), so split is not a steerable panel surface.
export const PANEL_SURFACES = ['doc', 'files', 'chat', 'source', 'pdf'] as const;
export type PanelSurface = (typeof PANEL_SURFACES)[number];

export function isPanelSurface(value: unknown): value is PanelSurface {
  return typeof value === 'string' && (PANEL_SURFACES as readonly string[]).includes(value);
}

export type PanelControlCommand = {
  /** Workspace-relative file to display (optional — surface alone is valid). */
  path?: string;
  /** Which surface to show; `source`/`pdf` apply to the LaTeX view. */
  surface?: PanelSurface;
};

export const panelControlTopic = (workspaceId: string) => `panel-control-${workspaceId}`;
export const PANEL_CONTROL_EVENT = 'show';

/** Signed broadcast payload. The topic is public Realtime — anyone holding
 *  the workspace id + anon key can publish to it — so panels obey only
 *  commands carrying an HMAC minted by the write-gated server paths
 *  (/g/show, the MCP tool) and verified back through the server. */
export type SignedPanelControlCommand = PanelControlCommand & { ts: number; sig: string };

/** Signature freshness window; a replay inside it can only re-show something
 *  a key-holder legitimately showed seconds ago. */
export const PANEL_CONTROL_SIG_TTL_MS = 60_000;

const panelSecret = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

const commandMessage = (workspaceId: string, ts: number, { path, surface }: PanelControlCommand) =>
  [workspaceId, ts, path ?? '', surface ?? ''].join('\n');

/** Server-only: mint the payload panels will accept. Throws without the secret. */
export async function signPanelControl(
  workspaceId: string,
  command: PanelControlCommand,
  ts = Date.now(),
): Promise<SignedPanelControlCommand> {
  const secret = panelSecret();
  if (!secret) throw new Error('Supabase secret missing for panel command signing');
  return { ...command, ts, sig: await hmacHex(secret, commandMessage(workspaceId, ts, command)) };
}

/** Server-only: true iff the command was minted here and is still fresh. */
export async function verifyPanelControl(workspaceId: string, command: SignedPanelControlCommand): Promise<boolean> {
  const secret = panelSecret();
  if (!secret || typeof command.ts !== 'number' || typeof command.sig !== 'string') return false;
  const age = Date.now() - command.ts;
  if (age > PANEL_CONTROL_SIG_TTL_MS || age < -5_000) return false;
  const expected = await hmacHex(secret, commandMessage(workspaceId, command.ts, command));
  if (expected.length !== command.sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ command.sig.charCodeAt(i);
  return diff === 0;
}

/**
 * Server-side broadcast via Supabase Realtime's REST endpoint — no socket to
 * hold in a serverless handler. Throws on a non-2xx so the caller can report
 * an honest failure instead of a silent no-op.
 */
export async function broadcastPanelControl(workspaceId: string, command: PanelControlCommand): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase env missing for panel broadcast');
  const payload = await signPanelControl(workspaceId, command);
  const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      messages: [{ topic: panelControlTopic(workspaceId), event: PANEL_CONTROL_EVENT, payload, private: false }],
    }),
  });
  if (!res.ok) throw new Error(`panel broadcast failed: ${res.status}`);
}

/**
 * How many panels are LIVE on this workspace's control channel right now.
 * Open panels track presence on subscribe (use-panel-control), so an
 * ephemeral server-side join can read the roster: join, wait one presence
 * sync, count, leave. Returns null when UNKNOWN (env/transport failure or
 * timeout) — callers must fail open to ambiguous phrasing on null and never
 * claim zero, because "no panel is open" changes what an agent does next.
 *
 * This exists because the broadcast alone made /g/show lie: it reported
 * "Panel updated" into the void, the agent believed the human was looking at
 * the result, and the fallback (hand them the open-a-panel line) never fired
 * (seen live in a ChatGPT session, 2026-08-25).
 */
export async function countOpenPanels(workspaceId: string): Promise<number | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  try {
    // Node < 22 has no global WebSocket; `ws` is already a root dependency.
    const [{ createClient }, wsModule] = await Promise.all([
      import('@supabase/supabase-js'),
      (globalThis as { WebSocket?: unknown }).WebSocket
        ? Promise.resolve(null)
        : import('ws'),
    ]);
    const transport =
      (globalThis as { WebSocket?: unknown }).WebSocket ?? (wsModule as { WebSocket: unknown } | null)?.WebSocket;
    const client = createClient(url, key, {
      realtime: { transport: transport as never },
    });
    try {
      const channel = client.channel(panelControlTopic(workspaceId));
      return await new Promise<number | null>((resolve) => {
        let settled = false;
        const done = (value: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => done(null), 2500);
        channel
          .on('presence', { event: 'sync' }, () => {
            // Our own join never track()s, so the roster is exactly the panels.
            const state = channel.presenceState();
            done(
              Object.values(state).reduce(
                (total, metas) => total + (metas as unknown[]).length,
                0,
              ),
            );
          })
          .subscribe((status) => {
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              done(null);
            }
          });
      });
    } finally {
      await client.removeAllChannels().catch(() => {});
      client.realtime.disconnect();
    }
  } catch {
    return null;
  }
}
