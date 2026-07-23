'use client';

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { buildWorkspacePath } from '@/lib/workspace/paths';
import type { ConnectedAppSummary } from '@/lib/composio/types';
import type { ChatStatus } from './workspace-chat-model';

type WorkspaceRouteId = string | { id: string; public_id: string | null };
type SearchParamsLike = {
  get(name: string): string | null;
  toString(): string;
};
type RouterLike = {
  replace(href: string, options?: { scroll?: boolean }): void;
};

export function useWorkspaceAppConnectionCallback({
  projectId,
  callbackConnectedAccountId,
  callbackStatus,
  searchParams,
  router,
  workspaceRouteId,
  appConnectionHandledRef,
  optimisticStartingUntilByChatIdRef,
  startingStatusGraceMs,
  showWorkspaceAppNotice,
  loadConnectedApps,
  loadAgentStatuses,
  setShowAppsPicker,
  setChatStatusById,
}: {
  projectId: string;
  callbackConnectedAccountId: string | null;
  callbackStatus: string | null;
  searchParams: SearchParamsLike;
  router: RouterLike;
  workspaceRouteId: WorkspaceRouteId;
  appConnectionHandledRef: MutableRefObject<string | null>;
  optimisticStartingUntilByChatIdRef: MutableRefObject<Map<string, number>>;
  startingStatusGraceMs: number;
  showWorkspaceAppNotice: (variant: 'success' | 'error', message: string) => void;
  loadConnectedApps: () => Promise<void>;
  loadAgentStatuses: () => Promise<void>;
  setShowAppsPicker: Dispatch<SetStateAction<boolean>>;
  setChatStatusById: Dispatch<SetStateAction<Record<string, ChatStatus>>>;
}) {
  useEffect(() => {
    // A connected-account id is the only required signal. Composio's redirect
    // doesn't reliably append a `status` param across connection flows, so we
    // never gate on it — `connection-complete` server-verifies the account is
    // ACTIVE, and we only treat an *explicit* non-success status as a failure.
    if (!projectId || !callbackConnectedAccountId) return;
    const chatIdParam = searchParams.get('chatId')?.trim() || null;

    const handledKey = `${projectId}:${chatIdParam ?? 'no-chat'}:${callbackConnectedAccountId}:${callbackStatus}`;
    if (appConnectionHandledRef.current === handledKey) {
      return;
    }
    appConnectionHandledRef.current = handledKey;

    const clearCallbackParams = () => {
      const nextParams = new URLSearchParams(searchParams.toString());
      nextParams.delete('connected_account_id');
      nextParams.delete('connectedAccountId');
      nextParams.delete('id');
      nextParams.delete('status');
      const nextQuery = nextParams.toString();
      router.replace(`${buildWorkspacePath(workspaceRouteId)}${nextQuery ? `?${nextQuery}` : ''}`);
    };

    const processConnection = async () => {
      if (callbackStatus && callbackStatus !== 'success') {
        showWorkspaceAppNotice('error', 'App connection did not complete.');
        clearCallbackParams();
        return;
      }

      // Connected from the settings panel with no active chat: there's no turn
      // to resume, but still evict the brain's cached Composio session so the
      // next turn in any chat sees the new app (connection-complete does this
      // server-side for the chat path).
      if (!chatIdParam) {
        showWorkspaceAppNotice('success', 'App connected.');
        setShowAppsPicker(false);
        await fetch('/api/workspace/apps/connection-invalidate', { method: 'POST' }).catch(() => {});
        await loadConnectedApps();
        clearCallbackParams();
        return;
      }

      showWorkspaceAppNotice('success', 'App connected. Asking the agent to continue...');
      setShowAppsPicker(false);
      await loadConnectedApps();

      optimisticStartingUntilByChatIdRef.current.set(chatIdParam, Date.now() + startingStatusGraceMs);
      setChatStatusById((prev) => ({
        ...prev,
        [chatIdParam]: prev[chatIdParam] === 'working' ? prev[chatIdParam] : 'starting',
      }));

      try {
        const response = await fetch('/api/workspace/apps/connection-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: chatIdParam,
            connectedAccountId: callbackConnectedAccountId,
          }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { app?: ConnectedAppSummary; error?: string }
          | null;

        if (!response.ok) {
          throw new Error(payload?.error ?? 'Failed to continue after connecting the app.');
        }

        showWorkspaceAppNotice('success', `${payload?.app?.name ?? 'App'} connected.`);
        window.setTimeout(() => {
          void loadAgentStatuses();
        }, 300);
      } catch (error) {
        optimisticStartingUntilByChatIdRef.current.delete(chatIdParam);
        setChatStatusById((prev) => {
          const next = { ...prev };
          delete next[chatIdParam];
          return next;
        });
        showWorkspaceAppNotice(
          'error',
          error instanceof Error ? error.message : 'Connected, but the follow-up failed.'
        );
      } finally {
        await loadConnectedApps();
        clearCallbackParams();
      }
    };

    void processConnection();
  }, [
    appConnectionHandledRef,
    callbackConnectedAccountId,
    callbackStatus,
    loadAgentStatuses,
    loadConnectedApps,
    optimisticStartingUntilByChatIdRef,
    projectId,
    router,
    searchParams,
    setChatStatusById,
    setShowAppsPicker,
    showWorkspaceAppNotice,
    startingStatusGraceMs,
    workspaceRouteId,
  ]);
}
