'use client';

import type { ReactNode } from 'react';
import { CircleNotchIcon, MagnifyingGlassIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { ConnectedAppAvatar } from '@/components/connected-app-avatar';
import { Spinner } from '@/components/ui/spinner';
import type { ConnectedAppSummary, ToolkitCatalogEntry } from '@/lib/composio/types';
import { catalogPlaceholder, useAppConnections } from './use-app-connections';

// Shared row shell for both the connected list and the catalog; the action
// button (Disconnect vs Connect) comes in as children.
function AppRow({
  testId,
  app,
  sublabel,
  avatarClassName,
  rowClassName,
  children,
}: {
  testId: string;
  app: Pick<ConnectedAppSummary, 'name' | 'logoUrl'>;
  sublabel: string;
  avatarClassName: string;
  rowClassName: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex items-center gap-3 rounded-xl border border-stone-200 bg-stone-50/80 px-3 ${rowClassName}`}
    >
      <ConnectedAppAvatar app={app} className={avatarClassName} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-stone-800">{app.name}</div>
        <div className="truncate font-mono text-xs text-stone-500">{sublabel}</div>
      </div>
      {children}
    </div>
  );
}

export type AppsPanelViewProps = {
  layout: 'desktop' | 'mobile';
  connectedApps: ConnectedAppSummary[];
  connectedAppsLoading: boolean;
  /** Catalog entries already filtered to not-yet-connected toolkits. */
  catalog: ToolkitCatalogEntry[];
  catalogLoading: boolean;
  catalogError: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  connectingSlug: string | null;
  disconnectingSlug: string | null;
  actionError: string | null;
  onConnect: (toolkitSlug: string) => void;
  onDisconnect: (app: ConnectedAppSummary) => void;
};

// Presentational Apps panel — all data via props so it can be rendered in the
// visual gallery (tests/smoke/apps-gallery.spec.ts) without any network.
export function AppsPanelView({
  layout,
  connectedApps,
  connectedAppsLoading,
  catalog,
  catalogLoading,
  catalogError,
  query,
  onQueryChange,
  connectingSlug,
  disconnectingSlug,
  actionError,
  onConnect,
  onDisconnect,
}: AppsPanelViewProps) {
  const busy = connectingSlug !== null || disconnectingSlug !== null;
  const placeholder = catalogPlaceholder({
    loading: catalogLoading,
    error: catalogError,
    isEmpty: catalog.length === 0,
    query,
  });
  const container =
    layout === 'mobile' ? 'px-4 py-3 space-y-4' : 'flex-1 overflow-auto px-4 py-4 space-y-4';

  return (
    <div className={container} data-testid="apps-panel">
      <section className="rounded-2xl border border-stone-200 bg-white p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
          Connected
        </div>
        <div className="mt-2 text-sm text-stone-500">Connected across all your workspaces.</div>
        {connectedAppsLoading ? (
          <Spinner label="Loading connected apps…" className="mt-4 text-sm" />
        ) : connectedApps.length === 0 ? (
          <div className="mt-4 text-sm text-stone-500">No apps connected yet.</div>
        ) : (
          <div className="mt-4 space-y-2" data-testid="connected-apps">
            {connectedApps.map((app) => {
              const isDisconnecting = disconnectingSlug === app.toolkitSlug;
              return (
                <AppRow
                  key={app.toolkitSlug}
                  testId={`connected-app-${app.toolkitSlug}`}
                  app={app}
                  sublabel={app.connectedCount > 1 ? `${app.connectedCount} accounts` : app.toolkitSlug}
                  avatarClassName="h-8 w-8"
                  rowClassName="py-3"
                >
                  <button
                    type="button"
                    onClick={() => onDisconnect(app)}
                    disabled={busy}
                    aria-label={`Disconnect ${app.name}`}
                    title={`Disconnect ${app.name}`}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isDisconnecting ? (
                      <CircleNotchIcon className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <TrashIcon className="h-3.5 w-3.5" aria-hidden />
                    )}
                  </button>
                </AppRow>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
          Add an app
        </div>
        <div className="relative mt-3">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
            aria-hidden
          />
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search apps (Gmail, Linear, Notion...)"
            aria-label="Search apps"
            className="w-full rounded-xl border border-stone-200 bg-stone-50/80 py-2 pl-9 pr-3 text-sm text-stone-800 outline-none placeholder:text-stone-400 focus:border-stone-300 focus:bg-white"
          />
        </div>

        {actionError ? (
          <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-700">
            {actionError}
          </div>
        ) : null}

        <div className="mt-3 space-y-2">
          {placeholder !== null ? (
            <div className="text-sm text-stone-500">{placeholder}</div>
          ) : (
            catalog.map((entry) => {
              const isConnecting = connectingSlug === entry.toolkitSlug;
              return (
                <AppRow
                  key={entry.toolkitSlug}
                  testId={`catalog-app-${entry.toolkitSlug}`}
                  app={entry}
                  sublabel={entry.toolkitSlug}
                  avatarClassName="h-7 w-7"
                  rowClassName="py-2.5"
                >
                  <button
                    type="button"
                    onClick={() => onConnect(entry.toolkitSlug)}
                    disabled={busy}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isConnecting ? (
                      <CircleNotchIcon className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <PlusIcon className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {isConnecting ? 'Connecting...' : 'Connect'}
                  </button>
                </AppRow>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

type AppsPanelProps = {
  layout: 'desktop' | 'mobile';
  connectedApps: ConnectedAppSummary[];
  connectedAppsLoading: boolean;
  currentChatId: string | null;
  reloadConnectedApps: () => Promise<void> | void;
};

// Container: wires the shared hook to the presentational view.
export function AppsPanel({
  layout,
  connectedApps,
  connectedAppsLoading,
  currentChatId,
  reloadConnectedApps,
}: AppsPanelProps) {
  const apps = useAppConnections({ connectedApps, currentChatId, reloadConnectedApps });
  return (
    <AppsPanelView
      layout={layout}
      connectedApps={connectedApps}
      connectedAppsLoading={connectedAppsLoading}
      catalog={apps.catalog}
      catalogLoading={apps.catalogLoading}
      catalogError={apps.catalogError}
      query={apps.query}
      onQueryChange={apps.setQuery}
      connectingSlug={apps.connectingSlug}
      disconnectingSlug={apps.disconnectingSlug}
      actionError={apps.actionError}
      onConnect={apps.connect}
      onDisconnect={apps.disconnect}
    />
  );
}
