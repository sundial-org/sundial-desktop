'use client';

import { useEffect, useState } from 'react';
import { formatBytes } from '@/components/workspace/diff-review/turn-edit-helpers';
import type { TurnEditFile } from '@/lib/workspace/turn-edits';

// A binary (png, pdf…) the turn produced — there is no text diff to render.
// Shows an Added/Updated notice and, for images, an inline preview fetched via
// the signed preview URL. The preview is best-effort: it needs read access and
// a live `files` row; any failure quietly leaves the notice alone.
export function BlobFileNotice({
  file,
  projectId,
}: {
  file: TurnEditFile;
  projectId?: string | null;
}) {
  const verb = file.isNew ? 'Added' : 'Updated';
  const isImage = Boolean(file.mime?.startsWith('image/'));
  const kind = isImage ? 'image' : file.mime === 'application/pdf' ? 'PDF' : 'binary file';
  const size = typeof file.byteSize === 'number' ? ` (${formatBytes(file.byteSize)})` : '';
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    // Reset on every identity change so a reused instance can't show the
    // previous blob's image under the new file's notice.
    setPreviewUrl(null);
    if (!isImage || !projectId || !file.fileId) return;
    const controller = new AbortController();
    void fetch('/api/workspace/files/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, fileId: file.fileId }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const payload = (await res.json()) as { signedUrl?: string | null };
        if (payload.signedUrl) setPreviewUrl(payload.signedUrl);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [isImage, projectId, file.fileId]);

  return (
    <div className="space-y-1.5" data-testid="blob-file-notice">
      <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
        {verb} {kind}
        {size}.
      </div>
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt={file.filePath}
          className="max-h-56 max-w-full rounded-lg border border-stone-200 bg-white object-contain"
          onError={() => setPreviewUrl(null)}
        />
      ) : null}
    </div>
  );
}
