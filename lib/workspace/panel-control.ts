/**
 * Agent view-control for embedded panels (?view=panel): the panel is a
 * DISPLAY the agent steers over HTTP, never a browser it drives. GET /g/show
 * broadcasts a command on the workspace's panel-control channel; every open
 * panel for that workspace obeys live (no reload). Normal workspace views
 * ignore the channel entirely — a human's full editor is theirs to arrange.
 *
 * Client-safe half only: the shapes and the channel name the panel needs.
 * Signing, verification and broadcasting live in panel-control-server.ts,
 * which is `server-only` and stays out of the open-source desktop export.
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
