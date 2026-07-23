'use client';

import { useEffect, useState } from 'react';
import type { ModelPickerOption } from '@/lib/workspace/chat-runtime';

type ModelsResponse = {
  models?: ModelPickerOption[];
  emptyReason?: string | null;
};

export function useChatModels(
  projectId: string | null | undefined,
  enabled = true,
  // Local workspaces pass the sidecar-shimmed fetch so the picker falls back
  // to the static local-engine catalog when the cloud one is unreachable.
  fetchImpl: typeof fetch = fetch,
) {
  const [models, setModels] = useState<ModelPickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !enabled) {
      setModels([]);
      setLoading(false);
      setEmptyReason(null);
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setModels([]);
      setLoading(true);
      setEmptyReason(null);
    });

    fetchImpl(`/api/workspace/models?projectId=${encodeURIComponent(projectId)}`, {
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        return (await response.json()) as ModelsResponse;
      })
      .then((payload) => {
        if (cancelled) return;
        setModels(payload.models ?? []);
        setEmptyReason(payload.emptyReason ?? null);
      })
      .catch((error) => {
        if (cancelled) return;
        setModels([]);
        setEmptyReason(error instanceof Error ? error.message : 'Failed to load models');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, projectId, fetchImpl]);

  return {
    models: projectId && enabled ? models : [],
    loading: projectId && enabled ? loading : false,
    emptyReason: projectId && enabled ? emptyReason : null,
  };
}
