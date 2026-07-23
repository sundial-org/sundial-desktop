'use client';

import { createContext, useContext } from 'react';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import type { WorkspaceKind } from '@/lib/workspace/kinds';

/** Files + access metadata preloaded during SSR so the client editor can
 *  paint without a blocking `/api/workspace/files` fetch on first load. */
export type WorkspaceInitialFilesPayload = {
  files: WorkspaceFileRow[];
  canWrite: boolean;
  canSuggest: boolean;
  canComment: boolean;
  canAccessSecrets: boolean;
  projectTitle: string | null;
  projectStatus: 'active' | 'archived' | null;
  projectKind: WorkspaceKind | null;
  templateSlug: string | null;
  templateName: string | null;
  templateDefaultAddendum: string | null;
  templateAddendumOverride: string | null;
  spaceInstructions: string | null;
};

export type WorkspaceRouteContextValue = {
  projectId: string | null;
  publicId: string | null;
  initialFiles: WorkspaceInitialFilesPayload | null;
  /** Present when this workspace is a local folder served by the desktop
   *  sidecar — the page swaps its data plane to `createLocalWorkspaceFetch`
   *  and skips cloud-only features. */
  local?: { config: { origin: string; token: string } } | null;
};

const WorkspaceRouteContext = createContext<WorkspaceRouteContextValue | null>(null);

export function WorkspaceRouteProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: WorkspaceRouteContextValue;
}) {
  return <WorkspaceRouteContext.Provider value={value}>{children}</WorkspaceRouteContext.Provider>;
}

export function useWorkspaceRoute() {
  return useContext(WorkspaceRouteContext);
}
