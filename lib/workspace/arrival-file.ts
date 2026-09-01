import { findByIdRef, isUuid } from '@/lib/workspace/public-ids';
import type { WorkspaceFileRow } from '@/lib/workspace/types';

export const WORKSPACE_ARRIVAL_FILE_ID_HEADER = 'x-sundial-arrival-file-id';
export const WORKSPACE_ARRIVAL_FILE_PATH_HEADER = 'x-sundial-arrival-file-path';

const MAX_ARRIVAL_REF_LENGTH = 2_048;

export type WorkspaceArrivalRef = {
  fileId: string | null;
  filePath: string | null;
};

/**
 * Copy the file intent from the URL into internal request headers so the
 * workspace layout can preload the exact document. Next layouts deliberately
 * do not receive searchParams. Caller-supplied versions are always removed.
 */
export function forwardWorkspaceArrivalRef(request: {
  headers: Headers;
  nextUrl: { pathname: string; searchParams: URLSearchParams };
}) {
  request.headers.delete(WORKSPACE_ARRIVAL_FILE_ID_HEADER);
  request.headers.delete(WORKSPACE_ARRIVAL_FILE_PATH_HEADER);
  if (!request.nextUrl.pathname.startsWith('/w/')) return false;

  const fileId = request.nextUrl.searchParams.get('fileId')?.trim();
  const filePath = request.nextUrl.searchParams.get('filePath')?.trim();
  if (fileId && fileId.length <= MAX_ARRIVAL_REF_LENGTH) {
    request.headers.set(WORKSPACE_ARRIVAL_FILE_ID_HEADER, encodeURIComponent(fileId));
  }
  if (filePath && filePath.length <= MAX_ARRIVAL_REF_LENGTH) {
    request.headers.set(WORKSPACE_ARRIVAL_FILE_PATH_HEADER, encodeURIComponent(filePath));
  }
  return true;
}

function decodeHeader(value: string | null) {
  if (!value || value.length > MAX_ARRIVAL_REF_LENGTH * 3) return null;
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return null;
  }
}

export function readWorkspaceArrivalRef(headers: Pick<Headers, 'get'>): WorkspaceArrivalRef {
  return {
    fileId: decodeHeader(headers.get(WORKSPACE_ARRIVAL_FILE_ID_HEADER)),
    filePath: decodeHeader(headers.get(WORKSPACE_ARRIVAL_FILE_PATH_HEADER)),
  };
}

export function findWorkspaceArrivalFile(files: WorkspaceFileRow[], ref: WorkspaceArrivalRef) {
  const file = ref.fileId
    ? findByIdRef(files, ref.fileId, (entry) => entry.id)
    : ref.filePath
      ? files.find((entry) => entry.path === ref.filePath)
      : null;
  return file && file.type !== 'folder' && file.type !== 'proposal' ? file : null;
}

/** A full UUID or an exact path can be queried before the file list returns. */
export function prefetchableWorkspaceArrivalRef(ref: WorkspaceArrivalRef): WorkspaceArrivalRef | null {
  if (ref.fileId) return isUuid(ref.fileId) ? { fileId: ref.fileId, filePath: null } : null;
  return ref.filePath ? { fileId: null, filePath: ref.filePath } : null;
}
