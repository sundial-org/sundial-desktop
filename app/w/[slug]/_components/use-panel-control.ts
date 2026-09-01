'use client';

import { useEffect, useRef } from 'react';
import type { createBrowserClient } from '@/lib/supabase/browser';
import {
  PANEL_CONTROL_EVENT,
  panelControlTopic,
  isPanelSurface,
  type PanelControlCommand,
  type PanelSurface,
} from '@/lib/workspace/panel-control';

/**
 * The panel-control topic is public Realtime: anyone with the workspace id
 * and anon key can forge a broadcast. Panels therefore obey only payloads
 * whose server-minted HMAC the verify route confirms — a forged event costs
 * at most one rejected fetch. Returns the sanitized command (with its signed
 * server-minted ts, the ordering key for the gate below), or null.
 */
export async function authenticatePanelCommand(
  projectId: string,
  payload: unknown,
  fetcher: typeof fetch = fetch,
): Promise<{ path?: string; surface?: PanelSurface; ts: number } | null> {
  const raw = (payload ?? {}) as PanelControlCommand & { ts?: unknown; sig?: unknown };
  const path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : undefined;
  const surface = isPanelSurface(raw.surface) ? raw.surface : undefined;
  if ((!path && !surface) || typeof raw.ts !== 'number' || typeof raw.sig !== 'string') return null;
  try {
    const res = await fetcher('/api/workspace/panel-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: projectId, path, surface, ts: raw.ts, sig: raw.sig }),
    });
    if (!res.ok) return null;
  } catch {
    return null;
  }
  return { path, surface, ts: raw.ts };
}

/**
 * Verification fetches run concurrently, so response latency can complete an
 * older command after a newer one already applied. The gate keeps the newest
 * applied signed ts and drops any completion older than it (equal ts applies,
 * so a lone command always lands); in-order completions still all apply.
 */
export function createPanelCommandGate(
  projectId: string,
  onCommand: (command: { path?: string; surface?: PanelSurface }) => void,
  fetcher: typeof fetch = fetch,
): (payload: unknown) => Promise<void> {
  let newestTs = -Infinity;
  return async (payload) => {
    const command = await authenticatePanelCommand(projectId, payload, fetcher);
    if (!command || command.ts < newestTs) return;
    newestTs = command.ts;
    onCommand(command);
  };
}

/**
 * Applies one /g/show command as one unit. A command carrying both path and
 * surface must hand the requested file to the surface transition explicitly:
 * openFile only SCHEDULES the selection, so a surface handler that re-reads
 * the render's current selection would reopen the previously selected file.
 */
export function applyPanelCommand<F extends { type: string }>(
  { path, surface }: { path?: string; surface?: PanelSurface },
  fileByPath: ReadonlyMap<string, F>,
  openFile: (file: F) => void,
  showSurface: (surface: PanelSurface, file?: F) => void,
) {
  const file = path ? fileByPath.get(path) : undefined;
  const target = file && file.type !== 'folder' ? file : undefined;
  if (target) openFile(target);
  if (surface) showSurface(surface, target);
}

/**
 * The obeying half of /g/show: an embedded panel (?view=panel) subscribes to
 * its workspace's panel-control broadcasts and switches what it displays —
 * open a file, flip to chat/files, drive the LaTeX source/split/pdf view.
 * Inert outside panel view: a human's full editor is theirs to arrange, so
 * `enabled` must be the panel latch, never a width heuristic.
 */
export function usePanelControl({
  enabled,
  projectId,
  supabaseClient,
  onCommand,
}: {
  enabled: boolean;
  projectId: string | null;
  supabaseClient: ReturnType<typeof createBrowserClient> | null;
  onCommand: (command: { path?: string; surface?: PanelSurface }) => void;
}) {
  // Handlers close over big page state; keep the subscription stable.
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  useEffect(() => {
    if (!enabled || !projectId || !supabaseClient) return;
    const gate = createPanelCommandGate(projectId, (command) => onCommandRef.current(command));
    const channel = supabaseClient
      .channel(panelControlTopic(projectId), {
        // Per-tab presence key: two open panels must count as two.
        config: { presence: { key: crypto.randomUUID() } },
      })
      .on('broadcast', { event: PANEL_CONTROL_EVENT }, ({ payload }: { payload?: unknown }) => {
        void gate(payload);
      })
      .subscribe((status: string) => {
        // Presence is how /g/show counts open panels before telling the agent
        // whether the human actually saw anything — an untracked panel reads
        // as "none open" and the agent stops steering it.
        if (status === 'SUBSCRIBED') void channel.track({ panel: true });
      });
    return () => {
      void supabaseClient.removeChannel(channel);
    };
  }, [enabled, projectId, supabaseClient]);
}
