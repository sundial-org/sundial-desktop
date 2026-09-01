export const STANDARD_WORKSPACE_KIND = 'standard' as const;
/** Hidden backing workspace for a shared LOCAL project: holds the synced
 *  union of shared scopes + mirrored chats. Never listed as a workspace of
 *  its own (dashboard, launcher, recents, switcher). */
export const LOCAL_BACKING_WORKSPACE_KIND = 'local-backing' as const;

export type WorkspaceKind = typeof STANDARD_WORKSPACE_KIND | typeof LOCAL_BACKING_WORKSPACE_KIND;

export function normalizeWorkspaceKind(kind: string | null | undefined): WorkspaceKind {
  return kind === LOCAL_BACKING_WORKSPACE_KIND ? LOCAL_BACKING_WORKSPACE_KIND : STANDARD_WORKSPACE_KIND;
}
