import JSZip from 'jszip';

export interface ZipFileInput {
  path: string;
  content: string | Uint8Array | ArrayBuffer | null;
  isDirectory?: boolean;
}

// `storeBinary` is opt-in so the buffered (sidecar) path keeps its original
// DEFLATE-everything behavior untouched; only the streaming route skips a
// wasted second DEFLATE on already-compressed binaries.
function buildZip(files: ZipFileInput[], storeBinary = false): JSZip {
  const zip = new JSZip();

  for (const file of files) {
    const normalizedPath = file.path.trim().replace(/^\/+/u, '');
    if (!normalizedPath) continue;
    if (file.isDirectory) {
      const directoryPath = normalizedPath.replace(/\/+$/u, '');
      if (directoryPath) {
        zip.file(`${directoryPath}/`, '', { dir: true });
      }
      continue;
    }
    // Binary payloads (PDF/PNG/…) are already compressed — DEFLATE-ing them
    // again burns CPU/memory (pako allocates ~input-sized buffers) for ~no
    // size win; STORE them and keep DEFLATE for text, which still shrinks.
    const store = storeBinary && typeof file.content !== 'string';
    zip.file(normalizedPath, file.content ?? '', { compression: store ? 'STORE' : 'DEFLATE' });
  }

  return zip;
}

// Buffered variant — used by the local sidecar (a Node http server on the
// user's own machine, already size-bounded), where holding the archive in
// memory is fine. The hosted serverless route must stream (see below).
export async function createZipNodeBuffer(files: ZipFileInput[]): Promise<Buffer> {
  return buildZip(files).generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

// Stream the archive instead of buffering it whole. A serverless function
// can't hold (all file bytes + the full zip buffer + a Uint8Array copy) in
// memory for large workspaces — it gets OOM-killed and the download 500s with
// an empty body. Streaming keeps peak memory ~ the input size and dodges the
// buffered-response size cap.
export function createZipStream(files: ZipFileInput[]): ReadableStream<Uint8Array> {
  const internal = buildZip(files, true).generateInternalStream({
    type: 'uint8array',
    // streamFiles: emit each file's bytes as they're processed and write
    // size/CRC in a trailing data descriptor. Without it JSZip buffers each
    // fully-processed file in memory (to fill the local header) — a single
    // large file would reintroduce the same OOM class this streaming avoids.
    streamFiles: true,
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      internal
        .on('data', (chunk: Uint8Array) => {
          if (cancelled) return;
          controller.enqueue(chunk);
          // Honor backpressure: stop pulling from JSZip once the consumer's
          // queue is full, so a slow client can't make us buffer the archive.
          if ((controller.desiredSize ?? 1) <= 0) internal.pause();
        })
        .on('error', (err: Error) => controller.error(err))
        .on('end', () => controller.close());
      internal.resume();
    },
    pull() {
      if (!cancelled) internal.resume();
    },
    cancel() {
      cancelled = true;
      internal.pause();
    },
  });
}
