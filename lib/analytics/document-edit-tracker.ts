'use client';

import type * as Y from 'yjs';
import { track } from './track';

/**
 * Mirror of `hocuspocus-server/server.mjs` — `debounce: 10_000, maxDebounce:
 * 30_000`. Server persists one `doc_edits` row per debounce window, so we
 * fire one `user_edited_document` event per window to match. These are NOT
 * analytics-tuned numbers; change them only if the server config changes.
 */
const SERVER_PERSIST_DEBOUNCE_MS = 10_000;
const SERVER_PERSIST_MAX_DEBOUNCE_MS = 30_000;

export interface DocumentEditTrackerOptions {
  workspaceId: string | undefined;
  fileId: string | undefined;
  filePath: string | undefined;
  /** Document family — `collab` for markdown CRDT, `code` for Monaco CRDT. */
  mode: 'collab' | 'code';
  readOnly?: boolean;
  /**
   * Hocuspocus / Y-WebSocket provider driving this Y.Doc. Updates whose
   * origin matches the provider are skipped (remote / agent edits). Pass
   * `null` for purely local docs (every update counts as a user edit).
   */
  provider: unknown | null;
}

/**
 * Subscribe to a Y.Doc's update stream and fire `user_edited_document` once
 * per *server persistence window* (matching Hocuspocus's `debounce` /
 * `maxDebounce`). One event ≈ one `doc_edits` row.
 *
 * Local vs remote is decided by the Yjs `origin` parameter:
 *   - Hocuspocus applies remote updates via `Y.applyUpdate(ydoc, update, provider)`,
 *     so remote/agent updates arrive with `origin === provider` and are skipped.
 *   - Editor bindings (y-prosemirror, y-monaco) wrap local edits in a
 *     `ydoc.transact(fn, binding)` call, so origin is the binding (≠ provider)
 *     and the update is counted.
 *
 * Returns an unsubscribe function.
 */
export function trackYDocUserEdits(
  ydoc: Y.Doc,
  { workspaceId, fileId, filePath, mode, readOnly, provider }: DocumentEditTrackerOptions,
): () => void {
  if (readOnly || !workspaceId || !fileId || !filePath) return () => {};
  let trailing: number | null = null;
  let maxWait: number | null = null;
  const flush = () => {
    track('user_edited_document', { projectId: workspaceId, fileId, path: filePath, mode });
    if (trailing !== null) window.clearTimeout(trailing);
    if (maxWait !== null) window.clearTimeout(maxWait);
    trailing = null;
    maxWait = null;
  };
  const handler = (_update: Uint8Array, origin: unknown) => {
    if (provider && origin === provider) return;
    if (trailing !== null) window.clearTimeout(trailing);
    trailing = window.setTimeout(flush, SERVER_PERSIST_DEBOUNCE_MS);
    if (maxWait === null) maxWait = window.setTimeout(flush, SERVER_PERSIST_MAX_DEBOUNCE_MS);
  };
  ydoc.on('update', handler);
  return () => {
    ydoc.off('update', handler);
    if (trailing !== null) window.clearTimeout(trailing);
    if (maxWait !== null) window.clearTimeout(maxWait);
  };
}
