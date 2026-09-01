'use client';

import { useEffect, useState } from 'react';
import type { WorkspaceCollabSocket } from '@/lib/workspace/collab-socket-context';

export type SocketStatus = 'connecting' | 'connected' | 'disconnected';

/** A re-auth or wake-from-sleep reconnect drops and reopens the socket in well
 *  under a second — only a drop that persists past this window surfaces. */
const DROP_DEBOUNCE_MS = 1200;

type StatusEmitter = {
  status?: string;
  on: (event: 'status', handler: (payload: { status: string }) => void) => unknown;
  off: (event: 'status', handler: (payload: { status: string }) => void) => unknown;
};

/** Live status of the shared collab socket (the desktop sidecar for local
 *  projects, cloud Hocuspocus otherwise). Unlike the per-editor status
 *  callbacks this needs no editor mounted — a chat-only pane layout still
 *  reads the real connection. Pass null to idle (returns 'connecting'). */
export function useCollabSocketStatus(collab: WorkspaceCollabSocket | null): SocketStatus {
  const [status, setStatus] = useState<SocketStatus>('connecting');
  useEffect(() => {
    if (!collab) {
      setStatus('connecting');
      return;
    }
    const socket = collab.socket as unknown as StatusEmitter;
    let dropTimer: ReturnType<typeof setTimeout> | null = null;
    let shown: SocketStatus = 'connecting';
    const show = (next: SocketStatus) => {
      shown = next;
      setStatus(next);
    };
    const handleStatus = ({ status: raw }: { status: string }) => {
      const next: SocketStatus =
        raw === 'connected' ? 'connected' : raw === 'disconnected' ? 'disconnected' : 'connecting';
      if (next === 'connected') {
        if (dropTimer) clearTimeout(dropTimer);
        dropTimer = null;
        show('connected');
        return;
      }
      // Initial connect / sustained outage shows immediately; only a
      // connected→drop blip is debounced (idle checkConnection recycles the
      // socket, and reconnects land in well under the window).
      if (shown !== 'connected') {
        show(next);
        return;
      }
      if (dropTimer) clearTimeout(dropTimer);
      dropTimer = setTimeout(() => {
        dropTimer = null;
        show(next);
      }, DROP_DEBOUNCE_MS);
    };
    show('connecting');
    // The socket connects on creation — seed from its current status, since
    // subscribing after the connect replays no event.
    if (socket.status) handleStatus({ status: socket.status });
    socket.on('status', handleStatus);
    return () => {
      if (dropTimer) clearTimeout(dropTimer);
      socket.off('status', handleStatus);
    };
  }, [collab]);
  return status;
}

/** The top-bar Offline chip condition. Local (sidecar) workspaces read the
 *  sidecar socket — the connection that actually carries files, docs and chats
 *  — so a chat-only pane layout can't fake "Offline" (the per-editor status
 *  never updates when no editor is mounted), while a genuinely dead sidecar
 *  still surfaces even with no file open. Cloud keeps the editor-reported
 *  status and its editable-file gate unchanged. */
export function deriveShowOffline(opts: {
  isLocalWorkspace: boolean;
  status: 'local' | SocketStatus;
  isEditableFileOpen: boolean;
  connectingGraceElapsed: boolean;
}): boolean {
  if (!opts.isLocalWorkspace && !opts.isEditableFileOpen) return false;
  return (
    opts.status === 'disconnected' ||
    (opts.status === 'connecting' && opts.connectingGraceElapsed)
  );
}
