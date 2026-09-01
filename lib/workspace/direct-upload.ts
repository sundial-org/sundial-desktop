/**
 * Browser-side direct upload via TUS resumable protocol.
 *
 *   sha256(file) → tus-js-client streams the file to our /api/workspace/uploads/tus
 *                  proxy → finalize creates the file row
 *
 * The Next route proxies TUS chunks to Supabase Storage's TUS endpoint with
 * service role auth. Each chunk is ~6 MB, so the proxy body limit doesn't
 * bite. The full file never lands in Node memory; multi-GB uploads stream
 * straight through.
 *
 * Why TUS? Supabase's single-shot upload endpoint (`storage/v1/object`)
 * hard-caps around 50 MB regardless of bucket settings. TUS is the only
 * upload path that handles arbitrary sizes.
 */
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import * as tus from 'tus-js-client';
import {
  currentPathShareToken,
  withPathShareToken,
} from '@/lib/workspace/path-share-token-client';
import { PATH_SHARE_TOKEN_HEADER } from '@/lib/workspace/path-grants';

// Path-share editors' only credential is the sticky ?pshare= token — forward
// it on every upload-rail call (precheck / TUS bytes / finalize).
const pshareFetch = withPathShareToken((input, init) => fetch(input, init));

export type DirectUploadProgress = (fractionUploaded: number) => void;

const CHUNK_SIZE = 6 * 1024 * 1024; // Supabase TUS minimum chunk = 6 MiB

/**
 * Compute the file's SHA-256 as a 64-char lowercase hex string. WebCrypto's
 * subtle.digest has no streaming API, so we materialize the ArrayBuffer once.
 * Modern browsers handle multi-GB ArrayBuffers — if memory ever becomes the
 * limit, swap in `hash-wasm` for a streaming hash.
 */
export async function sha256OfFile(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

async function tusUpload(args: {
  file: Blob;
  projectId: string;
  sha: string;
  mime: string;
  onProgress?: DirectUploadProgress;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(args.file as File, {
      endpoint: '/api/workspace/uploads/tus',
      chunkSize: CHUNK_SIZE,
      uploadDataDuringCreation: true,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      removeFingerprintOnSuccess: true,
      headers: {
        ...(currentPathShareToken()
          ? { [PATH_SHARE_TOKEN_HEADER]: currentPathShareToken()! }
          : {}),
      },
      metadata: {
        projectId: args.projectId,
        sha: args.sha,
        contentType: args.mime,
      },
      onError: reject,
      onProgress: (uploaded, total) => {
        if (total > 0) args.onProgress?.(uploaded / total);
      },
      onSuccess: () => resolve(),
    });
    upload.start();
  });
}

export async function finalizeDirectUpload(args: {
  projectId: string;
  path: string;
  sha: string;
  mime?: string | null;
}): Promise<WorkspaceFileRow> {
  const res = await pshareFetch('/api/workspace/uploads/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `finalize failed (${res.status})`);
  }
  const payload = (await res.json()) as { file: WorkspaceFileRow };
  return payload.file;
}

async function precheckBlob(args: { projectId: string; sha: string }): Promise<boolean> {
  const res = await pshareFetch('/api/workspace/uploads/precheck', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { exists?: boolean };
  return Boolean(body.exists);
}

/**
 * Hash the file, stream it to Supabase via TUS, then create the file row.
 * Works for files of any size up to the project's Supabase upload limit
 * (set in dashboard → Storage settings).
 *
 * Content-addressed dedup: if the same bytes have been uploaded before, the
 * precheck short-circuits and we skip TUS entirely.
 */
export async function directUploadFile(args: {
  projectId: string;
  path: string;
  file: File;
  onProgress?: DirectUploadProgress;
}): Promise<WorkspaceFileRow> {
  const sha = await sha256OfFile(args.file);
  const mime = args.file.type || 'application/octet-stream';
  const alreadyUploaded = await precheckBlob({ projectId: args.projectId, sha });
  if (!alreadyUploaded) {
    await tusUpload({
      file: args.file,
      projectId: args.projectId,
      sha,
      mime,
      onProgress: args.onProgress,
    });
  } else {
    args.onProgress?.(1);
  }
  return finalizeDirectUpload({
    projectId: args.projectId,
    path: args.path,
    sha,
    mime,
  });
}
