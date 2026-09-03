import { MAX_TEXT_BYTES } from './disk.mjs';

export const SYNC_SKIP_REASONS = {
  textTooLarge: 'text_too_large',
  blobTooLarge: 'blob_too_large',
  unwritablePath: 'unwritable_path',
};

/** Size policy for one side of a path. `null` means it is eligible. */
export function syncSkipReason(file, { blobMaxBytes }) {
  if (!file) return null;
  const size = Number(file.size ?? 0);
  if (file.type === 'text' && size > MAX_TEXT_BYTES) return SYNC_SKIP_REASONS.textTooLarge;
  if (file.type === 'blob' && size > blobMaxBytes) return SYNC_SKIP_REASONS.blobTooLarge;
  return null;
}

/**
 * Build one deterministic file-count snapshot. Paths are the unit of work:
 * overlapping union scopes and a path present on both sides count once.
 * Skipped paths are reported separately; totalFiles means eligible paths, so
 * once discovery is complete: totalFiles = completedFiles + pendingFiles.
 */
export function buildSyncProgress({
  localFiles,
  cloudFiles,
  completedPaths,
  pendingPaths = new Set(),
  contains = /** @param {string} _path */ (_path) => true,
  blobMaxBytes,
  unwritable = () => false,
  busy = false,
  error = false,
  updatedAt,
}) {
  if (localFiles === null || cloudFiles === null) {
    return {
      phase: error ? 'error' : 'scanning',
      completedFiles: 0,
      totalFiles: null,
      pendingFiles: 0,
      skippedFiles: 0,
      skippedByReason: {},
      updatedAt,
    };
  }

  const paths = new Map();
  const add = (file, side) => {
    if (!file || file.type === 'folder' || !contains(file.path)) return;
    const entry = paths.get(file.path) ?? { local: null, cloud: null };
    entry[side] = file;
    paths.set(file.path, entry);
  };
  for (const file of localFiles.values()) add(file, 'local');
  for (const file of cloudFiles.values()) add(file, 'cloud');

  let completedFiles = 0;
  let eligibleFiles = 0;
  let skippedFiles = 0;
  const skippedByReason = {};
  for (const [path, sides] of paths) {
    const reason =
      syncSkipReason(sides.local, { blobMaxBytes }) ??
      syncSkipReason(sides.cloud, { blobMaxBytes }) ??
      (sides.cloud && unwritable(path) ? SYNC_SKIP_REASONS.unwritablePath : null);
    if (reason) {
      skippedFiles += 1;
      skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
    } else {
      eligibleFiles += 1;
      if (completedPaths.has(path) && !pendingPaths.has(path)) completedFiles += 1;
    }
  }
  const totalFiles = eligibleFiles;
  const pendingFiles = totalFiles - completedFiles;
  return {
    // Generic finalization work can be real without belonging to a file. Keep
    // counters literal (N/N, zero pending); the syncing phase lets UI cap the
    // visual bar below 100% until that unnamed work settles.
    phase: error ? 'error' : pendingFiles > 0 || busy ? 'syncing' : 'up_to_date',
    completedFiles,
    totalFiles,
    pendingFiles,
    skippedFiles,
    skippedByReason,
    updatedAt,
  };
}
