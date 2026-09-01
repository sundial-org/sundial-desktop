/**
 * Folder-aware drag and drop.
 *
 * `dataTransfer.files` is flat: a dropped DIRECTORY arrives as a bogus `File`
 * (size 0, empty type) whose bytes can never be read — reading it throws
 * `NotFoundError: A requested file or directory could not be found…`. The only
 * way to see the tree is `DataTransferItem.webkitGetAsEntry()`, and the entries
 * go stale the moment the drop handler yields, so `dropEntriesFrom` MUST run
 * synchronously inside the drop event, before any await.
 */
import { MAX_ZIP_ENTRY_COUNT } from '@/lib/workspace/uploads';
import { isIgnoredWorkspacePath } from '@/lib/workspace/ignored-paths';

export type DroppedUpload = { file: File; relativePath: string };

/** Structural shape of the FileSystem Entry API bits we use (lib.dom's
 *  `FileSystemEntry` types are not available in every TS lib target). */
export type DropEntry = {
  isFile?: boolean;
  isDirectory?: boolean;
  name: string;
  file?: (ok: (file: File) => void, fail?: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (ok: (entries: DropEntry[]) => void, fail?: (error: unknown) => void) => void;
  };
};

type ItemsLike = { items?: ArrayLike<DataTransferItem> | null } | null | undefined;

/**
 * Snapshot the dropped items as filesystem entries. Returns null when the
 * entry API is unavailable (older Safari) or the drag carries no file items
 * (an internal file-tree move) — callers then fall back to `dataTransfer.files`.
 */
export function dropEntriesFrom(dataTransfer: ItemsLike): DropEntry[] | null {
  const items = dataTransfer?.items;
  if (!items || items.length === 0) return null;
  const entries: DropEntry[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const getAsEntry = (item as { webkitGetAsEntry?: () => DropEntry | null }).webkitGetAsEntry;
    if (typeof getAsEntry !== 'function') return null;
    const entry = getAsEntry.call(item);
    if (entry) entries.push(entry);
  }
  return entries.length > 0 ? entries : null;
}

/** Chrome returns at most 100 entries per call, so drain the reader until it
 *  hands back an empty batch. Same reader instance, or it restarts. */
function readAllChildren(dir: DropEntry): Promise<DropEntry[]> {
  const reader = dir.createReader?.();
  if (!reader) return Promise.resolve([]);
  return new Promise((resolve) => {
    const all: DropEntry[] = [];
    const step = () =>
      reader.readEntries((batch) => {
        if (!batch || batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        step();
      }, () => resolve(all));
    step();
  });
}

function entryFile(entry: DropEntry): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof entry.file !== 'function') {
      resolve(null);
      return;
    }
    entry.file((file) => resolve(file), () => resolve(null));
  });
}

/**
 * Walk dropped entries into uploads carrying their path relative to the drop
 * (`folder/sub/note.md`). Ignored paths (`.git`, `node_modules`, `.DS_Store`, …)
 * are pruned exactly like the zip import, and the walk stops at `maxFiles`.
 */
export async function readDroppedEntries(
  entries: DropEntry[],
  options?: { maxFiles?: number },
): Promise<{ files: DroppedUpload[]; truncated: boolean }> {
  const maxFiles = options?.maxFiles ?? MAX_ZIP_ENTRY_COUNT;
  const files: DroppedUpload[] = [];
  let truncated = false;

  const walk = async (entry: DropEntry, prefix: string) => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!entry.name || isIgnoredWorkspacePath(relativePath)) return;
    if (entry.isDirectory) {
      for (const child of await readAllChildren(entry)) await walk(child, relativePath);
      return;
    }
    const file = await entryFile(entry);
    if (file) files.push({ file, relativePath });
  };

  for (const entry of entries) await walk(entry, '');
  return { files, truncated };
}
