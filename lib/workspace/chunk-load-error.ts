/** A lazy chunk that 404s after a redeploy (the old hash is gone from the CDN)
 *  fails deterministically for the life of the page: retrying can't help,
 *  only a reload can. Webpack throws `ChunkLoadError`; Turbopack a plain Error
 *  ("Failed to load chunk …"). */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return (
    name === 'ChunkLoadError' ||
    (typeof message === 'string' && /Loading chunk|Failed to load chunk|ChunkLoadError/i.test(message))
  );
}

/** Indirection so tests can assert the reload without redefining `window.location`. */
export function reloadPage() {
  window.location.reload();
}
