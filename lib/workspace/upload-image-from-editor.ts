import { directUploadFile } from '@/lib/workspace/direct-upload';
import { convertHeicToJpeg } from '@/lib/workspace/heic';
import { ensureUniquePath } from '@/lib/workspace/uploads';

export type EditorImageUploadResult = {
  fileId: string;
  /** Workspace-relative path, e.g. `assets/diagram-xyz.png` — used as the `src`. */
  path: string;
  alt: string;
};

/**
 * Upload an image dropped/pasted into the editor and return its
 * workspace-relative path. The editor embeds `![alt](path)`; the markdownImage
 * decoration resolves the path to a signed URL at render time.
 */
export async function uploadImageFromEditor(args: {
  projectId: string;
  file: File;
  existingPaths: Set<string>;
  folder?: string;
  /** Override for local projects (sidecar disk write); default = cloud TUS. */
  uploadBinary?: (path: string, file: File) => Promise<{ id: string; path: string }>;
}): Promise<EditorImageUploadResult> {
  // HEIC/HEIF won't render in the editor preview — transcode to JPEG at ingest.
  const file = await convertHeicToJpeg(args.file);
  const ext = file.name.match(/(\.[^./]+)$/)?.[1]?.toLowerCase() ?? extensionForMime(file.type);
  const baseName = file.name.replace(/\.[^./]+$/, '').trim() || 'image';
  // Both halves of the emitted `![alt](src)` must stay parseable by the shared
  // markdown image rule, which terminates the alt at the first `]` and the src
  // at the first `)`. Keep the readable original name in `alt` minus brackets;
  // restrict the path slug to a markdown/URL/LaTeX-safe charset (this also drops
  // whitespace, which breaks LaTeX `\includegraphics{…}`).
  const alt = baseName.replace(/[[\]]/g, '').trim() || 'image';
  const safeBase = baseName.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '') || 'image';
  const folder = (args.folder ?? 'assets').replace(/^\/+|\/+$/g, '');
  const rawPath = `${folder}/${safeBase}-${shortStamp()}${ext}`;
  const path = ensureUniquePath(rawPath, args.existingPaths);

  const fileRow = args.uploadBinary
    ? await args.uploadBinary(path, file)
    : await directUploadFile({
        projectId: args.projectId,
        path,
        file,
      });

  return { fileId: fileRow.id, path: fileRow.path, alt };
}

function shortStamp() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function extensionForMime(mime: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/svg+xml') return '.svg';
  return '.bin';
}
