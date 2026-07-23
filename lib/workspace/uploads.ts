import { getExtension, isCrdtFile } from '@/lib/sync/policy';

export const MAX_TEXT_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

// Zip import caps. We extract zips in the browser and upload each entry
// individually, so the relevant limits are entry count + uncompressed size,
// not the compressed wire size. Anything bigger here is almost certainly a
// mistake (e.g. veribench-main.zip ships 42k .lean files).
export const MAX_ZIP_COMPRESSED_BYTES = 200 * 1024 * 1024;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
export const MAX_ZIP_ENTRY_COUNT = 1000;
export const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;

export { getExtension };

export function formatBytes(value?: number | null) {
  if (!value && value !== 0) return '';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function sanitizeFilename(value: string) {
  return value.replace(/[\\/]/g, '-');
}

export function isTextLikeUploadDescriptor(args: {
  name: string;
  mime?: string | null;
}) {
  return isCrdtFile(args.name, args.mime);
}

export function isTextLikeFile(file: File) {
  return isTextLikeUploadDescriptor({
    name: file.name,
    mime: file.type || null,
  });
}

export function ensureUniquePath(basePath: string, taken: Set<string>) {
  if (!taken.has(basePath)) return basePath;
  const extMatch = basePath.match(/(\.[^./]+)$/);
  const ext = extMatch ? extMatch[1] : '';
  const base = ext ? basePath.slice(0, -ext.length) : basePath;
  let index = 2;
  let candidate = `${base}-${index}${ext}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${base}-${index}${ext}`;
  }
  return candidate;
}

// Sibling path for a duplicated file/folder: "<name> copy<ext>", then a numeric
// suffix so repeats become "copy", "copy-2", … like Finder. `isTaken` decides a
// candidate ROOT — for a folder it must also reject roots whose descendant
// targets collide (folders are implicit, so a child path can be taken while the
// root is free), which is why this takes a predicate and not just a Set.
export function duplicatePath(sourcePath: string, isTaken: (candidate: string) => boolean) {
  const slash = sourcePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : sourcePath.slice(0, slash + 1);
  const name = slash === -1 ? sourcePath : sourcePath.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  // dot > 0 keeps dotfiles (".gitignore") whole instead of treating them as ext.
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = `${dir}${stem} copy${ext}`;
  if (!isTaken(base)) return base;
  let index = 2;
  while (isTaken(`${dir}${stem} copy-${index}${ext}`)) index += 1;
  return `${dir}${stem} copy-${index}${ext}`;
}
