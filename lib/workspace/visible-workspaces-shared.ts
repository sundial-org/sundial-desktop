// Client-safe types for the visible-workspaces query — the query itself
// (visible-workspaces.ts) is server-only; UI imports the shapes from here.

export type VisibleWorkspaceRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export type VisibleWorkspaceSummary = {
  id: string;
  public_id: string | null;
  user_id: string;
  title: string | null;
  updated_at: string | null;
  status: string | null;
  visibility: string | null;
  role: VisibleWorkspaceRole;
  canWrite: boolean;
};
