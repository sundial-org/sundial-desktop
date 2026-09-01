'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

// Client-side hook that lists linked repos for a project + exposes a
// per-path lookup for the Files panel. Refetched whenever `refreshKey`
// changes (e.g. after a successful link, unlink, or git action).

export type LinkedRepoSummary = {
  id: string;
  provider: 'github' | 'overleaf';
  repoLabel: string;
  htmlUrl: string | null;
  importedPath: string;
  defaultBranch: string | null;
  currentBranch: string | null;
  syncStatus: {
    ahead: number;
    behind: number;
    dirty: number;
    branch: string | null;
    updatedAt: string;
  } | null;
  lastAction: string | null;
  lastActionStatus: string | null;
  connectedByUserId: string;
  mode: 'manual' | 'auto';
  bridgeState: {
    conflict: { paths: string[]; at: string } | null;
    lastError: string | null;
    updatedAt: string | null;
    joinLink?: string | null;
    transport?: string | null;
  } | null;
};

type Response = { repositories: LinkedRepoSummary[] };

export function useLinkedRepos(projectId: string, refreshKey: number = 0, enabled: boolean = true) {
  const [repos, setRepos] = useState<LinkedRepoSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspace/linked-repos?projectId=${encodeURIComponent(projectId)}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      const body = (await response.json().catch(() => null)) as Response | { error?: string } | null;
      if (!response.ok) throw new Error((body as { error?: string } | null)?.error ?? `Failed (${response.status})`);
      setRepos((body as Response | null)?.repositories ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load linked repos');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!enabled) return;
    void refetch();
  }, [enabled, refetch, refreshKey]);

  const repoByImportedPath = useMemo(() => {
    const map = new Map<string, LinkedRepoSummary>();
    for (const r of repos) map.set(r.importedPath.replace(/\/$/, ''), r);
    return map;
  }, [repos]);

  /** Walks parent folders to find the linked repo (if any) that owns `path`. */
  const findRepoForPath = useCallback(
    (filePath: string): LinkedRepoSummary | null => {
      const normalized = filePath.replace(/^\/+/, '').replace(/\/+$/, '');
      let cursor = normalized;
      while (cursor) {
        const hit = repoByImportedPath.get(cursor);
        if (hit) return hit;
        const idx = cursor.lastIndexOf('/');
        if (idx === -1) break;
        cursor = cursor.slice(0, idx);
      }
      // A root-level import (importedPath '', e.g. a flattened Overleaf live
      // workspace) owns every path the walk above didn't claim.
      return repoByImportedPath.get('') ?? null;
    },
    [repoByImportedPath],
  );

  return { repos, loading, error, refetch, findRepoForPath, repoByImportedPath };
}
