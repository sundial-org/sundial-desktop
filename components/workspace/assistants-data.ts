'use client';

import { useEffect, useState } from 'react';

/**
 * Shared client-side loaders for the assistants surfaces. The sidebar section
 * and the dock panel both need the catalog and this workspace's Haiku
 * suggestions; module-level promise caches make sure expanding the sidebar
 * and then opening the panel costs ONE catalog fetch and ONE model pass per
 * page load, whichever surface asks first.
 */

export type AssistantEntry = {
  slug: string;
  name: string;
  category: string;
  description: string;
  fields?: string[];
};

export type AssistantDetail = {
  slug: string;
  name: string;
  category: string;
  description: string;
  fields: string[];
  license: string | null;
  deadline: string | null;
  page_limit: string | null;
  open_path: string | null;
  sources: { name: string; url: string }[];
  selection_actions?: { id: string; label: string; title: string }[];
  files: { path: string; locked: boolean; binary: boolean }[];
};

let catalogPromise: Promise<AssistantEntry[]> | null = null;
const suggestPromises = new Map<string, Promise<string[]>>();
const detailPromises = new Map<string, Promise<AssistantDetail>>();

export function loadAssistantsCatalog(): Promise<AssistantEntry[]> {
  if (!catalogPromise) {
    catalogPromise = fetch('/api/assistants')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load assistants (${res.status})`);
        const data = (await res.json()) as { templates?: AssistantEntry[] };
        return data.templates ?? [];
      })
      .catch((error) => {
        // A failed load must not poison every later open with the cached
        // rejection — drop it so the next consumer retries.
        catalogPromise = null;
        throw error;
      });
  }
  return catalogPromise;
}

/** Best-effort by contract: resolves [] on any failure, never rejects. */
export function loadAssistantSuggestions(projectId: string): Promise<string[]> {
  let promise = suggestPromises.get(projectId);
  if (!promise) {
    promise = fetch('/api/workspace/assistants/suggest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    })
      .then(async (res) => {
        const data = res.ok ? ((await res.json()) as { slugs?: string[] }) : {};
        return Array.isArray(data.slugs) ? data.slugs : [];
      })
      .catch(() => []);
    suggestPromises.set(projectId, promise);
  }
  return promise;
}

export function loadAssistantDetail(slug: string): Promise<AssistantDetail> {
  let promise = detailPromises.get(slug);
  if (!promise) {
    promise = fetch(`/api/assistants/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load assistant (${res.status})`);
        return (await res.json()) as AssistantDetail;
      })
      .catch((error) => {
        detailPromises.delete(slug);
        throw error;
      });
    promise.catch(() => {});
    detailPromises.set(slug, promise);
  }
  return promise;
}

/** Catalog + this workspace's suggestions, fetched once and shared between
 *  the sidebar section and the dock panel. `suggested` is null while the
 *  Haiku pass runs. Nothing loads until `enabled`. */
export function useAssistantsData(projectId: string | null, enabled: boolean) {
  const [assistants, setAssistants] = useState<AssistantEntry[] | null>(null);
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled || !projectId) return;
    let cancelled = false;
    loadAssistantsCatalog()
      .then((entries) => {
        if (!cancelled) setAssistants(entries);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load assistants');
      });
    void loadAssistantSuggestions(projectId).then((slugs) => {
      if (!cancelled) setSuggested(slugs);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId]);

  return { assistants, suggested, error };
}

/** Test-only: drop every module cache between cases. */
export function __resetAssistantsDataForTest(): void {
  catalogPromise = null;
  suggestPromises.clear();
  detailPromises.clear();
}
