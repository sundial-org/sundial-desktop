'use client';

import { createContext, useContext } from 'react';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import type { WorkspaceKind } from '@/lib/workspace/kinds';
import type { WorkspaceLocalSyncStatus } from '@/lib/workspace/local-sync-status';
import type { ServerTimingEntry } from '@/lib/perf/server-timing';

/** Files + access metadata preloaded during SSR so the client editor can
 *  paint without a blocking `/api/workspace/files` fetch on first load. */
import type { PathGrant } from '@/lib/workspace/path-grants';

export type WorkspaceInitialFilesPayload = {
  files: WorkspaceFileRow[];
  canWrite: boolean;
  /** Workspace owner (role, not capability) — drives the arrival surface. */
  isOwner: boolean;
  canSuggest: boolean;
  canComment: boolean;
  canAccessSecrets: boolean;
  // Owner or member row — the roles whose @Agent summons actually start runs.
  isMember?: boolean;
  /** True only for an owner/editor who may install and invoke assistants. */
  canManageAssistantActions?: boolean;
  // Free anonymous runs left for this caller (null: signed in, not
  // anon-owned, or not the owner) — mirrors the files GET field.
  anonRunsRemaining?: number | null;
  /** Whether the SERVER recognized an identity on this request (Clerk cookie
   *  or `sd_` bearer / loopback sidecar). The only signal that separates a
   *  server-authed caller from a genuinely anonymous one when
   *  `anonRunsRemaining` is null — both look identical on that field alone.
   *  Absent means "not reported": callers must treat it as unknown. */
  serverAuthed?: boolean;
  /** Path-share grants (always present so the client can trust the field —
   *  an absent array must never CLEAR grants a fetch delivered). */
  pathGrants?: PathGrant[];
  /** Chat ids granted view access (shared local chat mirrors). */
  chatGrants?: string[];
  scoped?: boolean;
  projectTitle: string | null;
  projectStatus: 'active' | 'archived' | null;
  projectKind: WorkspaceKind | null;
  /** Latest local-folder report for cloud mirrors; absent on older servers. */
  localSyncStatus?: WorkspaceLocalSyncStatus | null;
  projectCreatedAt?: string | null;
  templateSlug: string | null;
  templateName: string | null;
  templateDefaultAddendum: string | null;
  /** The assistant's CURRENT instructions (live from the store) — differs
   *  from the frozen default when the assistant was updated since this
   *  workspace snapshotted it; drives the settings card's upgrade banner. */
  templateLatestAddendum: string | null;
  templateAddendumOverride: string | null;
  spaceInstructions: string | null;
};

/** Hocuspocus socket credentials minted during SSR so the collab socket can
 *  open the moment the client hydrates, without a blocking
 *  `/api/workspace/host` round-trip. Same shape the route returns. */
export type WorkspaceInitialHost = {
  collabUrl: string;
  token: string;
  docNamePrefix: string;
  /** Clerk user id the token's uid was minted for (null for anonymous).
   *  Verified against the hydrated Clerk identity once it loads — a session
   *  signed out or switched in another tab must not keep the old account's
   *  socket capabilities for the token's lifetime. */
  clerkUserId: string | null;
  /** sd_anon id the token's uid derives from (null for signed-in callers).
   *  Always present for anonymous tokens — whether read from the request
   *  cookie or freshly minted — so the client can verify the live cookie
   *  still matches before adopting the token. */
  anonId?: string | null;
  /** True when SSR minted `anonId` (no cookie on the request): the client
   *  sets the cookie before any other request so attribution stays
   *  consistent with what `/api/workspace/host` will read. */
  anonMinted?: boolean;
};

/** Exact canonical Yjs snapshot for the document the arrival heuristic opens.
 * It is safe to paint immediately because the server only emits it when the
 * persisted Y.Doc revision includes the current text revision. The editor
 * remains read-only until Hocuspocus verifies/merges the live room. */
export type WorkspaceInitialSnapshot = {
  fileId: string;
  path: string;
  updateBase64: string;
};

export type WorkspaceRouteContextValue = {
  projectId: string | null;
  publicId: string | null;
  initialFiles: WorkspaceInitialFilesPayload | null;
  initialHost?: WorkspaceInitialHost | null;
  initialSnapshot?: WorkspaceInitialSnapshot | null;
  /** Server-render preload spans for cold-open diagnostics. */
  initialServerTiming?: ServerTimingEntry[];
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
