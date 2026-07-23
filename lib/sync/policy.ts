import rawPolicy from './policy.json';

export type SyncPolicy = {
  markdown_extensions: string[];
  crdt_extensions: string[];
  blob_extensions: string[];
  office_preview_extensions: string[];
  latex_document_extensions: string[];
  latex_source_extensions: string[];
  ignored_paths: string[];
};

export const syncPolicy = rawPolicy as SyncPolicy;

const markdownExtensions = new Set(syncPolicy.markdown_extensions);
const crdtExtensions = new Set(syncPolicy.crdt_extensions);
const blobExtensions = new Set(syncPolicy.blob_extensions);
const latexDocumentExtensions = new Set(syncPolicy.latex_document_extensions);
const latexSourceExtensions = new Set(syncPolicy.latex_source_extensions);

export function normalizeWorkspacePath(path: string | null | undefined): string {
  return (path ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export function getExtension(path: string | null | undefined) {
  const match = normalizeWorkspacePath(path).toLowerCase().match(/\.[^./]+$/u);
  return match ? match[0] : '';
}

export function isMarkdownFile(path: string | null | undefined, mimeType?: string | null) {
  if (typeof mimeType === 'string' && mimeType.toLowerCase().includes('markdown')) {
    return true;
  }
  return markdownExtensions.has(getExtension(path));
}

export function isCrdtFile(path: string | null | undefined, mimeType?: string | null) {
  if (crdtExtensions.has(getExtension(path))) return true;
  if (mimeType?.startsWith('text/')) return true;
  return mimeType === 'application/json';
}

export function isBlobFile(path: string | null | undefined, mimeType?: string | null) {
  const ext = getExtension(path);
  if (blobExtensions.has(ext)) return true;
  return Boolean(mimeType && !mimeType.startsWith('text/') && mimeType !== 'application/json');
}

export function isPdfFile(path: string | null | undefined, mimeType?: string | null) {
  return getExtension(path) === '.pdf' || mimeType === 'application/pdf';
}

// Office documents previewable via the pool's LibreOffice → PDF conversion
// (`/api/workspace/office-preview`). The extension list lives in policy.json
// (also read by sandbox/compile_pool.py); the MIME map covers extensionless
// uploads — the converter needs a supported extension, so only exact MIMEs we
// can map to one count as previewable.
const officePreviewExtensions = new Set(syncPolicy.office_preview_extensions);
const OFFICE_MIME_EXTENSIONS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.ms-excel': '.xls',
  'application/msword': '.doc',
  'application/vnd.oasis.opendocument.presentation': '.odp',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.text': '.odt',
};

/** The extension the office→PDF converter should treat the file as, or null if not previewable. */
export function officePreviewExtension(path: string | null | undefined, mimeType?: string | null) {
  const ext = getExtension(path);
  if (officePreviewExtensions.has(ext)) return ext;
  return OFFICE_MIME_EXTENSIONS[mimeType?.toLowerCase() ?? ''] ?? null;
}

export function isOfficePreviewFile(path: string | null | undefined, mimeType?: string | null) {
  return officePreviewExtension(path, mimeType) !== null;
}

export function isLatexDocumentFile(path: string | null | undefined, mimeType?: string | null) {
  const normalizedMime = mimeType?.toLowerCase() ?? '';
  return latexDocumentExtensions.has(getExtension(path)) || normalizedMime === 'text/x-tex';
}

export function isLatexSourceFile(path: string | null | undefined, mimeType?: string | null) {
  const normalizedMime = mimeType?.toLowerCase() ?? '';
  return latexSourceExtensions.has(getExtension(path)) || normalizedMime === 'text/x-tex' || normalizedMime === 'text/x-bibtex';
}

function ignoredPatternMatches(pattern: string, normalizedPath: string, parts: string[]) {
  if (!pattern) return false;
  if (pattern.endsWith('/')) {
    const root = pattern.slice(0, -1);
    return parts.includes(root);
  }
  if (pattern.startsWith('*.')) {
    return normalizedPath.toLowerCase().endsWith(pattern.slice(1).toLowerCase());
  }
  return parts.includes(pattern) || normalizedPath === pattern;
}

export function isIgnoredPath(path: string | null | undefined): boolean {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized || normalized === '.') return false;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return false;
  return syncPolicy.ignored_paths.some((pattern) => ignoredPatternMatches(pattern, normalized, parts));
}

export function ignoredFolderRoots() {
  return syncPolicy.ignored_paths
    .filter((path) => path.endsWith('/'))
    .map((path) => path.slice(0, -1));
}
