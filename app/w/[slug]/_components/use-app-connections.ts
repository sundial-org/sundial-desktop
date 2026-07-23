'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectedAppSummary, ToolkitCatalogEntry } from '@/lib/composio/types';
import { isDraftChatId } from './workspace-chat-model';

/**
 * The single message shown in place of the catalog list (loading / error /
 * empty), or null when there are entries to render. Shared by the settings
 * panel and the chat composer so the copy stays in one place.
 */
export function catalogPlaceholder(state: {
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  query: string;
}): string | null {
  if (state.loading) return 'Searching apps...';
  if (state.error) return state.error;
  if (state.isEmpty) {
    return state.query.trim() ? 'No matching apps found.' : 'No apps available to connect.';
  }
  return null;
}

/**
 * Shared Composio app state for the settings panel and the chat composer:
 * debounced catalog search, OAuth connect (full-page redirect), and disconnect.
 * `enabled` gates the catalog fetch so closed pickers don't hit the network.
 */
export function useAppConnections(args: {
  connectedApps: ConnectedAppSummary[];
  currentChatId: string | null;
  reloadConnectedApps: () => Promise<void> | void;
  enabled?: boolean;
}) {
  const { connectedApps, currentChatId, reloadConnectedApps, enabled = true } = args;

  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<ToolkitCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [disconnectingSlug, setDisconnectingSlug] = useState<string | null>(null);

  const connectedSlugs = useMemo(
    () => new Set(connectedApps.map((app) => app.toolkitSlug)),
    [connectedApps]
  );

  // Debounced catalog search with a request token to drop stale responses.
  const requestToken = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const token = ++requestToken.current;
    setCatalogLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : '';
        const response = await fetch(`/api/composio/toolkits${params}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Failed to load apps.');
        const payload = (await response.json()) as { toolkits?: ToolkitCatalogEntry[] };
        if (token !== requestToken.current) return;
        setCatalog(Array.isArray(payload.toolkits) ? payload.toolkits : []);
        setCatalogError(null);
      } catch {
        if (token !== requestToken.current) return;
        setCatalog([]);
        setCatalogError('Could not load the app catalog.');
      } finally {
        if (token === requestToken.current) setCatalogLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, enabled]);

  const connectable = useMemo(
    () => catalog.filter((entry) => !connectedSlugs.has(entry.toolkitSlug)),
    [catalog, connectedSlugs]
  );

  const connect = useCallback(
    async (toolkitSlug: string) => {
      setConnectingSlug(toolkitSlug);
      setActionError(null);
      try {
        // A not-yet-persisted draft chat has no DB row, so the connect route
        // would 404. Treat it as no chat — the connection still completes;
        // there's just no turn to resume.
        const chatId = currentChatId && !isDraftChatId(currentChatId) ? currentChatId : null;
        const response = await fetch('/api/workspace/apps/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolkitSlug,
            chatId,
            returnPath: window.location.pathname,
          }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { redirectUrl?: string; error?: string }
          | null;
        if (!response.ok || !payload?.redirectUrl) {
          throw new Error(payload?.error ?? 'Could not start the connection.');
        }
        window.location.href = payload.redirectUrl;
      } catch (error) {
        setConnectingSlug(null);
        setActionError(error instanceof Error ? error.message : 'Could not start the connection.');
      }
    },
    [currentChatId]
  );

  const disconnect = useCallback(
    async (app: ConnectedAppSummary) => {
      setDisconnectingSlug(app.toolkitSlug);
      setActionError(null);
      try {
        const response = await fetch('/api/workspace/apps/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectedAccountIds: app.connectedAccountIds }),
        });
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) throw new Error(payload?.error ?? 'Could not disconnect the app.');
        await reloadConnectedApps();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Could not disconnect the app.');
      } finally {
        setDisconnectingSlug(null);
      }
    },
    [reloadConnectedApps]
  );

  return {
    query,
    setQuery,
    catalog: connectable,
    catalogLoading,
    catalogError,
    connectingSlug,
    actionError,
    connect,
    disconnectingSlug,
    disconnect,
  };
}
