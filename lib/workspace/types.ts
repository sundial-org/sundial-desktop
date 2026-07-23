export type WorkspaceFileType = 'text' | 'binary' | 'blob_ref' | 'proposal' | 'folder';

export interface WorkspaceFileRow {
  id: string;
  project_id: string;
  parent_file_id: string | null;
  path: string;
  type: WorkspaceFileType;
  mime: string | null;
  size: number | null;
  storage_key: string | null;
  /** Content address of a binary row's stored bytes (`blobs/<sha>`). */
  blob_sha?: string | null;
  /** Agent-facing lock: agents can't modify/rename/delete; humans edit freely. */
  is_locked?: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export type WorkspaceSpaceKind = 'folder' | 'vault' | 'workspace';

export interface WorkspaceSpace {
  space_key: string;
  label: string;
  path: string;
  kind: WorkspaceSpaceKind;
}
