'use client';

import { CircleNotchIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { ConnectedAppAvatar } from '@/components/connected-app-avatar';
import { Spinner } from '@/components/ui/spinner';
import type { ConnectedAppSummary } from '@/lib/composio/types';
import { catalogPlaceholder, useAppConnections } from './use-app-connections';

type ChatAppsPickerProps = {
  open: boolean;
  connectedApps: ConnectedAppSummary[];
  connectedAppsLoading: boolean;
  currentChatId: string | null;
  reloadConnectedApps: () => Promise<void> | void;
};

// Compact apps menu for the chat composer: lists connected apps and lets the
// user connect a new one inline (same flow as Settings → Apps).
export function ChatAppsPicker({
  open,
  connectedApps,
  connectedAppsLoading,
  currentChatId,
  reloadConnectedApps,
}: ChatAppsPickerProps) {
  const apps = useAppConnections({
    connectedApps,
    currentChatId,
    reloadConnectedApps,
    enabled: open,
  });

  if (!open) return null;

  const placeholder = catalogPlaceholder({
    loading: apps.catalogLoading,
    error: apps.catalogError,
    isEmpty: apps.catalog.length === 0,
    query: apps.query,
  });

  return (
    <div
      data-testid="chat-apps-picker"
      className="absolute bottom-full left-0 z-50 mb-1 max-h-96 w-72 overflow-auto rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
    >
      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-stone-400">
        Connected
      </div>
      {connectedAppsLoading ? (
        <Spinner label="Loading connected apps…" size={13} className="px-3 py-2 text-xs" />
      ) : connectedApps.length === 0 ? (
        <div className="px-3 py-2 text-xs text-stone-500">No apps connected yet.</div>
      ) : (
        connectedApps.map((app) => (
          <div
            key={app.toolkitSlug}
            className="flex items-center gap-3 px-3 py-2 text-sm text-stone-700"
          >
            <ConnectedAppAvatar app={app} className="h-6 w-6" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-stone-700">{app.name}</div>
              <div className="text-[10px] text-stone-400">
                {app.connectedCount === 1 ? 'Connected' : `${app.connectedCount} accounts connected`}
              </div>
            </div>
            <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
          </div>
        ))
      )}

      <div className="mt-1 border-t border-stone-100 px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-stone-400">
        Add an app
      </div>
      <div className="px-2 pb-1">
        <div className="relative">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400"
            aria-hidden
          />
          <input
            type="text"
            value={apps.query}
            onChange={(event) => apps.setQuery(event.target.value)}
            placeholder="Search apps..."
            aria-label="Search apps"
            className="w-full rounded-lg border border-stone-200 bg-stone-50/80 py-1.5 pl-8 pr-2 text-xs text-stone-800 outline-none placeholder:text-stone-400 focus:border-stone-300 focus:bg-white"
          />
        </div>
      </div>

      {apps.actionError ? (
        <div className="mx-2 mb-1 rounded-md border border-orange-200 bg-orange-50 px-2 py-1 text-[11px] text-orange-700">
          {apps.actionError}
        </div>
      ) : null}

      {placeholder !== null ? (
        <div className="px-3 py-2 text-xs text-stone-500">{placeholder}</div>
      ) : (
        apps.catalog.slice(0, 6).map((entry) => {
          const isConnecting = apps.connectingSlug === entry.toolkitSlug;
          return (
            <div
              key={entry.toolkitSlug}
              data-testid={`chat-catalog-app-${entry.toolkitSlug}`}
              className="flex items-center gap-3 px-3 py-1.5 text-sm text-stone-700"
            >
              <ConnectedAppAvatar app={entry} className="h-6 w-6" />
              <div className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">
                {entry.name}
              </div>
              <button
                type="button"
                onClick={() => apps.connect(entry.toolkitSlug)}
                disabled={apps.connectingSlug !== null}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-stone-300 bg-white px-2 py-1 text-[11px] font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isConnecting ? (
                  <CircleNotchIcon className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <PlusIcon className="h-3 w-3" aria-hidden />
                )}
                {isConnecting ? 'Connecting' : 'Connect'}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
