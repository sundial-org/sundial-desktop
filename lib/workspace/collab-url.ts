export type ConnectionStatus = 'local' | 'connecting' | 'connected' | 'disconnected';

const LOCAL_COLLAB_URL = 'ws://localhost:8080';

export function resolveCollabUrl(): string | undefined {
  const configured = process.env.NEXT_PUBLIC_COLLAB_WS_URL?.trim();
  if (configured) {
    return configured;
  }
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    return LOCAL_COLLAB_URL;
  }
  return undefined;
}

export function httpToWs(httpUrl: string): string {
  return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

export type WorkspaceHost = {
  hostUrl: string;
  collabUrl: string;
  token: string;
  canWrite: boolean;
  status?: string | null;
  docNamePrefix?: string | null;
};

/** Fetch the per-workspace Sunny sandbox ingress URL + direct-file token.
 *  Polls via `ensure=1` until the container is ready. */
export async function fetchWorkspaceHost(
  workspaceId: string,
  options: { ensure?: boolean; signal?: AbortSignal; editMode?: 'edit' | 'suggest' } = {},
): Promise<WorkspaceHost | null> {
  if (!workspaceId) return null;
  const qs = new URLSearchParams({ workspaceId });
  if (options.ensure !== false) qs.set('ensure', '1');
  if (options.editMode === 'suggest') qs.set('editMode', 'suggest');
  const res = await fetch(`/api/workspace/host?${qs.toString()}`, {
    method: 'GET',
    credentials: 'include',
    signal: options.signal,
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    ok?: boolean;
    hostUrl?: string;
    collabUrl?: string;
    token?: string;
    canWrite?: boolean;
    status?: string | null;
    docNamePrefix?: string | null;
  };
  if (!body?.ok || !body.hostUrl || !body.collabUrl || !body.token) return null;
  return {
    hostUrl: body.hostUrl,
    collabUrl: body.collabUrl,
    token: body.token,
    canWrite: Boolean(body.canWrite),
    status: body.status ?? null,
    docNamePrefix: body.docNamePrefix ?? null,
  };
}
