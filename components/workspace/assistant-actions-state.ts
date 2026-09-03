'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceSelectionAction } from '@/lib/assistants/selection-actions';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';

const ACTIONS_CHANGED_EVENT = 'sundial:selection-actions-changed';
const ACTIONS_CHANNEL_PREFIX = 'sundial-selection-actions:';
const actionStateSource = `${Date.now()}:${Math.random()}`;
const pendingMutations = new Set<string>();

type ActionStateMessage = {
  projectId: string;
  source: string;
};

function openActionsChannel(projectId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(`${ACTIONS_CHANNEL_PREFIX}${projectId}`);
  } catch {
    return null;
  }
}

/** Tell every selected-text surface in this tab and the user's other tabs to
 * re-read the workspace-global assistant action snapshot. */
export function notifyWorkspaceSelectionActionsChanged(projectId: string) {
  window.dispatchEvent(new CustomEvent(ACTIONS_CHANGED_EVENT, { detail: { projectId } }));
  const channel = openActionsChannel(projectId);
  if (!channel) return;
  try {
    channel.postMessage({ projectId, source: actionStateSource } satisfies ActionStateMessage);
  } catch {
    // The server mutation already succeeded. Cross-tab broadcast is only a
    // refresh optimization and must not turn that success into an error.
  } finally {
    channel.close();
  }
}

/** One action can be configured from both the editor bubble and Assistants.
 * A module-level lock prevents two same-tab surfaces from racing one another. */
export function beginWorkspaceSelectionActionMutation(key: string): boolean {
  if (pendingMutations.has(key)) return false;
  pendingMutations.add(key);
  return true;
}

export function endWorkspaceSelectionActionMutation(key: string): void {
  pendingMutations.delete(key);
}

export function useWorkspaceSelectionActions(projectId: string | null) {
  const apiFetch = useApiFetch();
  const [snapshot, setSnapshot] = useState<{
    projectId: string | null;
    actions: WorkspaceSelectionAction[];
  }>({ projectId, actions: [] });
  const [refreshing, setRefreshing] = useState(Boolean(projectId));
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef(true);
  const requestRef = useRef(0);
  const actions = snapshot.projectId === projectId ? snapshot.actions : [];
  const loading = Boolean(projectId) && (refreshing || snapshot.projectId !== projectId);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!projectId) {
      if (liveRef.current && requestId === requestRef.current) {
        setSnapshot({ projectId: null, actions: [] });
        setRefreshing(false);
        setError(null);
      }
      return;
    }
    if (liveRef.current) setRefreshing(true);
    try {
      const response = await apiFetch(
        `/api/workspace/assistant-actions?projectId=${encodeURIComponent(projectId)}`,
      );
      const body = (await response.json().catch(() => ({}))) as {
        actions?: WorkspaceSelectionAction[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || 'Could not load actions');
      if (liveRef.current && requestId === requestRef.current) {
        setSnapshot({
          projectId,
          actions: Array.isArray(body.actions) ? body.actions : [],
        });
        setError(null);
      }
    } catch (cause) {
      if (liveRef.current && requestId === requestRef.current) {
        setSnapshot((current) =>
          current.projectId === projectId ? current : { projectId, actions: [] },
        );
        setError(cause instanceof Error ? cause.message : 'Could not load actions');
      }
    } finally {
      if (liveRef.current && requestId === requestRef.current) setRefreshing(false);
    }
  }, [apiFetch, projectId]);

  const applyActionState = useCallback(
    (
      assistantSlug: string,
      actionId: string,
      state: Partial<Pick<WorkspaceSelectionAction, 'connected' | 'enabled'>>,
    ) => {
      setSnapshot((current) => {
        if (current.projectId !== projectId) return current;
        return {
          ...current,
          actions: current.actions.map((action) =>
            action.assistant_slug === assistantSlug && action.id === actionId
              ? { ...action, ...state }
              : action,
          ),
        };
      });
    },
    [projectId],
  );

  const applyEnabled = useCallback(
    (assistantSlug: string, actionId: string, enabled: boolean) => {
      applyActionState(assistantSlug, actionId, { enabled });
    },
    [applyActionState],
  );

  useEffect(() => {
    liveRef.current = true;
    // The initial state already carries the loading affordance. Start I/O in
    // a microtask so the effect remains subscription setup, not a synchronous
    // state-update cascade.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    const onChanged = (event: Event) => {
      const changedProjectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (!changedProjectId || changedProjectId === projectId) void refresh();
    };
    window.addEventListener(ACTIONS_CHANGED_EVENT, onChanged);
    const onFocus = () => void refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const channel = projectId ? openActionsChannel(projectId) : null;
    if (channel) {
      channel.onmessage = (event: MessageEvent<ActionStateMessage>) => {
        if (event.data?.projectId === projectId && event.data.source !== actionStateSource) {
          void refresh();
        }
      };
    }
    return () => {
      cancelled = true;
      liveRef.current = false;
      requestRef.current += 1;
      window.removeEventListener(ACTIONS_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      channel?.close();
    };
  }, [projectId, refresh]);

  return { actions, loading, error, refresh, applyActionState, applyEnabled };
}
