"use client";

import { useCallback, useState } from 'react';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import {
  MAX_FILE_UPLOAD_BYTES,
  MAX_TEXT_UPLOAD_BYTES,
  MAX_ZIP_COMPRESSED_BYTES,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_ENTRY_COUNT,
  MAX_ZIP_UNCOMPRESSED_BYTES,
  ensureUniquePath,
  formatBytes,
  isTextLikeFile,
  sanitizeFilename,
} from '@/lib/workspace/uploads';
import { directUploadFile } from '@/lib/workspace/direct-upload';
import { convertHeicToJpeg, heicJpegName, isHeicUpload } from '@/lib/workspace/heic';
import { isCrdtFile, normalizeWorkspacePath } from '@/lib/sync/policy';
import { isIgnoredWorkspacePath } from '@/lib/workspace/ignored-paths';

export type UploadTarget = 'chat' | 'files';

export type PendingUpload = {
  id: string;
  file: File;
  name: string;
  path: string;
  target: UploadTarget;
  chatId?: string | null;
  progress: number;
  status: 'uploading' | 'processing' | 'error';
  error?: string;
};

type UploadCompleteHandler = (file: WorkspaceFileRow, upload: PendingUpload) => void;

type BinaryUpload = (
  path: string,
  file: File,
  onProgress?: (value: number) => void,
) => Promise<WorkspaceFileRow>;

type UseWorkspaceUploadsOptions = {
  projectId: string | null;
  canWrite: boolean;
  existingPaths: Set<string>;
  onUploadComplete: UploadCompleteHandler;
  onFilesChanged?: () => void;
  /** Local projects swap the data plane: text uploads go through the emulated
   *  workspace fetch, binaries through the sidecar. Defaults = cloud. */
  fetchImpl?: typeof fetch;
  uploadBinary?: BinaryUpload;
};

/**
 * Upload a binary file using the two-step direct flow: browser hashes the
 * file, asks the server for a signed Supabase Storage URL, PUTs the bytes
 * straight to storage, then asks the server to record the metadata. The
 * Next route never touches the bytes, so files can be arbitrarily large
 * (up to Supabase's per-bucket cap).
 */
const uploadBinaryDirect = (
  projectId: string,
  path: string,
  file: File,
  onProgress: (value: number) => void,
) => directUploadFile({ projectId, path, file, onProgress });

function cleanZipPath(value: string): string | null {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized || normalized.includes('\0')) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

async function uploadZipEntryAsText(args: {
  projectId: string;
  path: string;
  mime: string | null;
  text: string;
  fetchImpl: typeof fetch;
}): Promise<WorkspaceFileRow> {
  const res = await args.fetchImpl('/api/workspace/uploads', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: args.projectId,
      path: args.path,
      type: 'text',
      mime: args.mime,
      size: args.text.length,
      textContent: args.text,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Upload failed (${res.status}).`);
  }
  const payload = (await res.json()) as { file: WorkspaceFileRow };
  return payload.file;
}

const ZIP_UPLOAD_CONCURRENCY = 8;

type ZipPlanEntry = {
  entry: import('jszip').JSZipObject;
  finalPath: string;
  uncompressedSize: number;
};

function planZipImport(
  zip: import('jszip'),
  rootPath: string,
  existingPaths: Set<string>,
): ZipPlanEntry[] {
  const taken = new Set(existingPaths);
  const plan: ZipPlanEntry[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const entryPath = cleanZipPath(entry.name);
    const workspacePath = entryPath ? cleanZipPath(`${rootPath}/${entryPath}`) : null;
    if (!workspacePath || isIgnoredWorkspacePath(workspacePath)) continue;
    const finalPath = ensureUniquePath(workspacePath, taken);
    taken.add(finalPath);
    // JSZip exposes `_data.uncompressedSize` on the internal entry; safe-default
    // to 0 if absent (older zips that don't include the size in the central
    // directory — we'll still hit the per-entry cap on the streamed bytes).
    const internal = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
    plan.push({
      entry,
      finalPath,
      uncompressedSize: internal?.uncompressedSize ?? 0,
    });
  }
  return plan;
}

async function uploadZipEntry(
  projectId: string,
  plan: ZipPlanEntry,
  fetchImpl: typeof fetch,
  uploadBinary: BinaryUpload,
): Promise<WorkspaceFileRow> {
  const { entry, finalPath } = plan;
  const blob = await entry.async('blob');
  if (blob.size > MAX_ZIP_ENTRY_BYTES) {
    throw new Error(
      `${entry.name} is ${formatBytes(blob.size)}, exceeds the ${formatBytes(MAX_ZIP_ENTRY_BYTES)} per-file limit.`,
    );
  }
  if (isCrdtFile(finalPath, null) && blob.size <= MAX_TEXT_UPLOAD_BYTES) {
    return uploadZipEntryAsText({
      projectId,
      path: finalPath,
      mime: null,
      text: await blob.text(),
      fetchImpl,
    });
  }
  const filename = finalPath.split('/').pop() ?? 'file';
  const fileBlob = new File([blob], filename, {
    type: blob.type || 'application/octet-stream',
  });
  return uploadBinary(finalPath, fileBlob);
}

/**
 * Extract the zip in the browser and upload each entry through the regular
 * upload paths. Avoids the 100 MB multipart-through-Next bottleneck (which
 * Cloudflare HTTP/2 truncates and surfaces as busboy "Unexpected end of form")
 * and reuses TUS direct-to-Supabase for binary files like every other upload.
 */
async function importZipClientSide(args: {
  projectId: string;
  rootPath: string;
  file: File;
  existingPaths: Set<string>;
  onProgress: (fraction: number) => void;
  fetchImpl: typeof fetch;
  uploadBinary: BinaryUpload;
}): Promise<WorkspaceFileRow[]> {
  if (args.file.size > MAX_ZIP_COMPRESSED_BYTES) {
    throw new Error(
      `Zip is ${formatBytes(args.file.size)}, exceeds the ${formatBytes(MAX_ZIP_COMPRESSED_BYTES)} limit.`,
    );
  }

  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(args.file);
  const plan = planZipImport(zip, args.rootPath, args.existingPaths);

  if (plan.length === 0) {
    throw new Error('Zip did not contain importable files.');
  }
  if (plan.length > MAX_ZIP_ENTRY_COUNT) {
    throw new Error(
      `Zip contains ${plan.length.toLocaleString()} files, exceeds the ${MAX_ZIP_ENTRY_COUNT.toLocaleString()}-file limit. Trim the archive or upload as a binary blob.`,
    );
  }
  const totalUncompressed = plan.reduce((sum, item) => sum + item.uncompressedSize, 0);
  if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
    throw new Error(
      `Zip expands to ${formatBytes(totalUncompressed)}, exceeds the ${formatBytes(MAX_ZIP_UNCOMPRESSED_BYTES)} uncompressed limit.`,
    );
  }
  const oversized = plan.find((item) => item.uncompressedSize > MAX_ZIP_ENTRY_BYTES);
  if (oversized) {
    throw new Error(
      `${oversized.entry.name} is ${formatBytes(oversized.uncompressedSize)}, exceeds the ${formatBytes(MAX_ZIP_ENTRY_BYTES)} per-file limit.`,
    );
  }

  const created: WorkspaceFileRow[] = [];
  let done = 0;
  let cursor = 0;
  const total = plan.length;
  args.onProgress(0);

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= total) return;
      const row = await uploadZipEntry(args.projectId, plan[index], args.fetchImpl, args.uploadBinary);
      created.push(row);
      done += 1;
      args.onProgress(done / total);
    }
  }

  const workers = Array.from(
    { length: Math.min(ZIP_UPLOAD_CONCURRENCY, total) },
    () => worker(),
  );
  await Promise.all(workers);

  return created;
}

function isZipArchive(file: File) {
  return (
    file.name.toLowerCase().endsWith('.zip') ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
  );
}

function stripZipExtension(path: string) {
  return path.replace(/\.zip$/iu, '') || 'archive';
}

export function useWorkspaceUploads({
  projectId,
  canWrite,
  existingPaths,
  onUploadComplete,
  onFilesChanged,
  fetchImpl = fetch,
  uploadBinary,
}: UseWorkspaceUploadsOptions) {
  const [uploads, setUploads] = useState<PendingUpload[]>([]);

  const updateUpload = useCallback((id: string, patch: Partial<PendingUpload>) => {
    setUploads((prev) => prev.map((upload) => (upload.id === id ? { ...upload, ...patch } : upload)));
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((upload) => upload.id !== id));
  }, []);

  /** Surface an upload that failed outside the queue (e.g. an editor image
   *  drop) as a visible error entry, so the failure is never silent. */
  const reportUploadError = useCallback((name: string, message: string) => {
    setUploads((prev) => [
      ...prev,
      {
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file: new File([], name),
        name,
        path: name,
        target: 'files',
        progress: 0,
        status: 'error',
        error: message,
      },
    ]);
  }, []);

  const startUpload = useCallback(
    async (upload: PendingUpload) => {
      if (!projectId) return;
      const file = upload.file;
      if (file.size > MAX_FILE_UPLOAD_BYTES) {
        updateUpload(upload.id, { status: 'error', error: 'File exceeds size limit.' });
        return;
      }

      const isSmallText = isTextLikeFile(file) && file.size <= MAX_TEXT_UPLOAD_BYTES;
      const binaryUpload: BinaryUpload =
        uploadBinary ?? ((path, blob, onProgress) => uploadBinaryDirect(projectId, path, blob, onProgress ?? (() => {})));

      try {
        if (upload.target === 'files' && isZipArchive(file)) {
          updateUpload(upload.id, { status: 'processing', progress: 0 });
          const files = await importZipClientSide({
            projectId,
            rootPath: stripZipExtension(upload.path),
            file,
            existingPaths,
            onProgress: (progress) => updateUpload(upload.id, { progress }),
            fetchImpl,
            uploadBinary: binaryUpload,
          });
          files.forEach((fileRecord) => onUploadComplete(fileRecord, upload));
          onFilesChanged?.();
          removeUpload(upload.id);
          return;
        }

        if (isSmallText) {
          // Text files: read content and send as JSON (no storage needed)
          updateUpload(upload.id, { status: 'processing', progress: 1 });
          const text = await file.text();
          const res = await fetchImpl('/api/workspace/uploads', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId,
              path: upload.path,
              type: 'text',
              mime: file.type || null,
              size: file.size,
              textContent: text,
            }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? `Unable to finalize upload (${res.status}).`);
          }
          const payload = (await res.json()) as { file: WorkspaceFileRow };
          onUploadComplete(payload.file, upload);
          onFilesChanged?.();
          removeUpload(upload.id);
          return;
        }

        // Binary files: direct browser → Supabase Storage (or the sidecar's
        // disk write for local projects). The Next route never sees the bytes.
        updateUpload(upload.id, { status: 'uploading', progress: 0 });
        const fileRecord = await binaryUpload(upload.path, file, (progress) => {
          updateUpload(upload.id, { progress });
        });
        updateUpload(upload.id, { status: 'processing', progress: 1 });
        onUploadComplete(fileRecord, upload);
        onFilesChanged?.();
        removeUpload(upload.id);
      } catch (error) {
        updateUpload(upload.id, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Upload failed.',
        });
      }
    },
    [existingPaths, fetchImpl, onFilesChanged, onUploadComplete, projectId, removeUpload, updateUpload, uploadBinary]
  );

  const queueUploads = useCallback(
    (files: File[], target: UploadTarget, targetFolder: string | null, chatId?: string | null) => {
      if (!canWrite || !projectId) return;
      if (target === 'chat' && !chatId) return;
      const taken = new Set(existingPaths);
      const reserve = (name: string) => {
        const safeName = sanitizeFilename(name.trim()) || 'upload';
        const rawPath = targetFolder ? `${targetFolder}/${safeName}` : safeName;
        const path = ensureUniquePath(rawPath, taken);
        taken.add(path);
        return { safeName, path };
      };
      files.forEach((original) => {
        const isHeic = isHeicUpload(original.name, original.type);
        // Reserve the path from the PREDICTED post-conversion name (heicJpegName
        // is pure) and register the pending entry SYNCHRONOUSLY. A HEIC decode
        // takes seconds; chatUploadsInFlight must flip true immediately so a chat
        // send can't race ahead of its attachment. Then convert per-file (not a
        // batched Promise.all) so a slow decode never blocks its siblings.
        const { safeName, path } = reserve(isHeic ? heicJpegName(original.name) : original.name);
        const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setUploads((prev) => [
          ...prev,
          { id, file: original, name: safeName, path, target, chatId, progress: 0, status: isHeic ? 'processing' : 'uploading' },
        ]);
        void convertHeicToJpeg(original).then((file) => {
          // Conversion never throws; on failure it returns the original bytes, so
          // re-reserve under the real extension to keep the path/mime honest.
          const failed = isHeic && file.type !== 'image/jpeg';
          const final = failed ? reserve(original.name) : { safeName, path };
          const upload: PendingUpload = {
            id,
            file,
            name: final.safeName,
            path: final.path,
            target,
            chatId,
            progress: 0,
            status: 'uploading',
          };
          updateUpload(id, { file, name: final.safeName, path: final.path, status: 'uploading' });
          void startUpload(upload);
        });
      });
    },
    [canWrite, existingPaths, projectId, startUpload, updateUpload]
  );

  return {
    uploads,
    queueUploads,
    removeUpload,
    reportUploadError,
  };
}
