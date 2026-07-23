/**
 * HEIC/HEIF ingest conversion.
 *
 * iPhones default to HEIC, which browsers cannot decode — a dropped `.heic`
 * uploads fine but never renders (broken preview). Workspace binary uploads go
 * straight from the browser to Supabase Storage (see `direct-upload.ts`), so the
 * only ingest point *before* the bytes are hashed and stored is the browser.
 * We transcode to JPEG here with `heic-to` (WASM libheif ≥1.19 — required for the
 * HDR gain-map `tmap` HEICs recent iPhones shoot by default; dynamically imported
 * so it costs nothing until a HEIC is actually dropped), so the stored blob, its
 * sha (dedup key), the `files` row mime, the path, and previews are all JPEG.
 *
 * Best-effort: any failure returns the original file so the upload still
 * succeeds — same behaviour as before this conversion existed, never a regression.
 */

const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

const HEIC_EXTENSION = /\.(heic|heif)$/i;

/** True when the name/mime looks like HEIC/HEIF and should be transcoded. */
export function isHeicUpload(name: string, mime?: string | null): boolean {
  const type = mime?.split(';', 1)[0].trim().toLowerCase();
  if (type && HEIC_MIME_TYPES.has(type)) return true;
  return HEIC_EXTENSION.test(name);
}

/**
 * Editor drop/paste/pick gate: a standard image MIME, or a HEIC the OS exposed
 * with an empty/generic MIME (extension-only) — those still transcode at ingest,
 * so filtering purely on `image/*` would drop them before conversion.
 */
export function isEditorImageFile(file: File): boolean {
  return file.type.startsWith('image/') || isHeicUpload(file.name, file.type);
}

/** Swap a `.heic`/`.heif` extension for `.jpg` (append if none present). */
export function heicJpegName(name: string): string {
  return HEIC_EXTENSION.test(name) ? name.replace(HEIC_EXTENSION, '.jpg') : `${name}.jpg`;
}

/**
 * Convert a HEIC/HEIF `File` to a JPEG `File`. Non-HEIC files pass through
 * untouched. On any conversion failure (corrupt bytes, unsupported variant) the
 * original file is returned so the upload still lands.
 */
export async function convertHeicToJpeg(file: File): Promise<File> {
  if (!isHeicUpload(file.name, file.type)) return file;
  try {
    const { heicTo } = await import('heic-to');
    // Decodes the primary image (multi-frame HEICs collapse to their key frame).
    const blob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.9 });
    if (!blob) return file;
    return new File([blob], heicJpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch (error) {
    console.warn('[uploads] HEIC→JPEG conversion failed; uploading original', error);
    return file;
  }
}
