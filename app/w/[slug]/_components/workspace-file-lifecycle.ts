'use client';

import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { createBrowserClient } from '@/lib/supabase/browser';
import type { WorkspaceInitialFilesPayload } from '@/lib/workspace/route-context';
import { getAncestorFolders, isMetaPath } from './workspace-file-helpers';

export type WorkspaceStorageUsage = {
  usageBytes: number;
  limitBytes: number;
  usageRatio: number;
  warning: boolean;
  overLimit: boolean;
};

export function useWorkspaceFileLifecycle({
  projectId,
  initialFilesPayload,
  filesLoaded,
  workspaceFilesLength,
  projectTitle,
  lastFileStorageKey,
  selectedFilePath,
  showMetaFiles,
  supabaseClient,
  storageUsageEnabled = true,
  reloadFiles,
  didSetInitialFileRef,
  filesChannelRef,
  onProjectReset,
  setWorkspaceStorageUsage,
  setShowMetaFiles,
  setExpandedFolders,
}: {
  projectId: string;
  initialFilesPayload: WorkspaceInitialFilesPayload | null;
  filesLoaded: boolean;
  workspaceFilesLength: number;
  projectTitle: string;
  lastFileStorageKey: string;
  selectedFilePath: string;
  showMetaFiles: boolean;
  supabaseClient: ReturnType<typeof createBrowserClient>;
  /** False for local projects — storage quotas are a cloud concept. */
  storageUsageEnabled?: boolean;
  reloadFiles: (shouldSetInitial?: boolean, preloaded?: WorkspaceInitialFilesPayload) => Promise<number | undefined | void>;
  didSetInitialFileRef: MutableRefObject<boolean>;
  filesChannelRef: MutableRefObject<BroadcastChannel | null>;
  onProjectReset: () => void;
  setWorkspaceStorageUsage: Dispatch<SetStateAction<WorkspaceStorageUsage | null>>;
  setShowMetaFiles: Dispatch<SetStateAction<boolean>>;
  setExpandedFolders: Dispatch<SetStateAction<Set<string>>>;
}) {
  useEffect(() => {
    if (!projectId || !filesLoaded || !storageUsageEnabled) return;
    let cancelled = false;
    const controller = new AbortController();
    fetch(`/api/workspace/storage-usage?projectId=${encodeURIComponent(projectId)}`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('storage usage unavailable');
        return (await response.json()) as WorkspaceStorageUsage;
      })
      .then((usage) => {
        if (!cancelled) setWorkspaceStorageUsage(usage);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceStorageUsage(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [filesLoaded, projectId, setWorkspaceStorageUsage, storageUsageEnabled, workspaceFilesLength]);

  const bootstrappedProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    // Reset + first-load only when the project actually changes. Other deps of
    // this effect (reloadFiles/initialFilesPayload) can get a fresh identity on
    // an unrelated re-render — notably when browser back/forward makes Next
    // re-sync useSearchParams — and re-running onProjectReset then tears down
    // chats/files mid-session (spurious "New chat" flash on SPA back-nav).
    if (bootstrappedProjectRef.current !== projectId) {
      bootstrappedProjectRef.current = projectId;
      didSetInitialFileRef.current = false;
      onProjectReset();
      // First load uses the SSR-preloaded files (no fetch); the 15s interval and
      // the realtime channel below keep the list fresh from the network after.
      void reloadFiles(true, initialFilesPayload ?? undefined);
    }
    const interval = window.setInterval(() => {
      void reloadFiles(false);
    }, 15000);
    return () => {
      window.clearInterval(interval);
    };
  }, [didSetInitialFileRef, initialFilesPayload, onProjectReset, projectId, reloadFiles]);

  useEffect(() => {
    if (!filesLoaded) return;
    document.title = projectTitle.trim() || 'Untitled workspace';
  }, [filesLoaded, projectTitle]);

  useEffect(() => {
    if (!lastFileStorageKey || typeof window === 'undefined') return;
    try {
      if (selectedFilePath) {
        window.localStorage.setItem(lastFileStorageKey, selectedFilePath);
      } else if (didSetInitialFileRef.current) {
        window.localStorage.removeItem(lastFileStorageKey);
      }
    } catch {
      // ignore
    }
  }, [didSetInitialFileRef, lastFileStorageKey, selectedFilePath]);

  useEffect(() => {
    if (!selectedFilePath) return;
    if (isMetaPath(selectedFilePath) && !showMetaFiles) {
      setShowMetaFiles(true);
    }
    const ancestors = getAncestorFolders(selectedFilePath);
    if (ancestors.length === 0) return;
    setExpandedFolders((prev) => {
      let changed = false;
      const next = new Set(prev);
      ancestors.forEach((folder) => {
        if (!next.has(folder)) {
          next.add(folder);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [selectedFilePath, setExpandedFolders, setShowMetaFiles, showMetaFiles]);

  useEffect(() => {
    if (!projectId) return;
    const channel = new BroadcastChannel(`sundial-files-${projectId}`);
    filesChannelRef.current = channel;
    channel.onmessage = (event) => {
      if (event.data?.type === 'refresh') {
        void reloadFiles(false);
      }
    };
    return () => {
      channel.close();
      filesChannelRef.current = null;
    };
  }, [filesChannelRef, projectId, reloadFiles]);

  useEffect(() => {
    if (!supabaseClient || !projectId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase generated types don't include realtime overloads for files table
    const channel = supabaseClient.channel(`workspace-files-${projectId}`) as any;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (reloadTimer) return;
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void reloadFiles(false);
        // A clone burst inserts thousands of rows over minutes — 1s batching
        // keeps the tree live without refetching the full list continuously.
      }, 1000);
    };
    const realtimeBase = {
      schema: 'public',
      table: 'files',
      filter: `project_id=eq.${projectId}`,
    } as const;
    channel.on('postgres_changes', { event: 'INSERT', ...realtimeBase }, scheduleReload);
    channel.on('postgres_changes', { event: 'DELETE', ...realtimeBase }, scheduleReload);
    channel.on('postgres_changes', { event: 'UPDATE', ...realtimeBase }, scheduleReload);
    channel.subscribe();
    return () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      supabaseClient.removeChannel(channel);
    };
  }, [supabaseClient, projectId, reloadFiles]);

}
