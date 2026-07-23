export const STANDARD_WORKSPACE_KIND = 'standard' as const;

export type WorkspaceKind = typeof STANDARD_WORKSPACE_KIND;

export function normalizeWorkspaceKind(_kind: string | null | undefined): WorkspaceKind {
  return STANDARD_WORKSPACE_KIND;
}
