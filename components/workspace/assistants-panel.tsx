'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CheckCircleIcon,
  LockIcon,
  MagnifyingGlassIcon,
  SpinnerGapIcon,
  XIcon,
} from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { Spinner } from '@/components/ui/spinner';
import {
  beginWorkspaceSelectionActionMutation,
  endWorkspaceSelectionActionMutation,
  notifyWorkspaceSelectionActionsChanged,
  useWorkspaceSelectionActions,
} from '@/components/workspace/assistant-actions-state';
import {
  loadAssistantDetail,
  useAssistantsData,
  type AssistantDetail,
  type AssistantEntry,
} from '@/components/workspace/assistants-data';
import type { WorkspaceSelectionAction } from '@/lib/assistants/selection-actions';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';

// The Assistants browser (behind the `assistants_enabled` flag). Catalog rows
// are intentionally browse-only: setup begins after See details, where the
// user can inspect files/sources, watch a product demo, connect the assistant,
// or configure any selected-text controls it owns. The catalog and workspace
// suggestions share the cached assistants-data loaders with the sidebar.

export type { AssistantEntry };

type ConnectResult = {
  slug: string;
  name: string;
  added: string[];
  /** Original → suffixed path, for files renamed to dodge a name collision. */
  renamed: Record<string, string>;
  /** Paths that were already present with identical content. */
  identical: string[];
  agentsMerged: boolean;
  openPath: string | null;
};

export function AssistantsPanel({
  projectId,
  onClose,
  onConnected,
  /** Open directly on one assistant's details (a sidebar suggestion click). */
  initialSlug,
  /** Changes for every sidebar request, including repeat clicks on one slug. */
  focusRequestId = 0,
  renderDemo,
}: {
  projectId: string;
  onClose: () => void;
  /** Fired after a successful connect so the page can refresh the file tree. */
  onConnected?: (result: ConnectResult) => void;
  initialSlug?: string | null;
  focusRequestId?: number;
  /** Main-canvas demo supplied separately from assistant setup/data logic. */
  renderDemo?: (assistant: AssistantDetail) => ReactNode;
}) {
  const router = useRouter();
  const apiFetch = useApiFetch();
  const { assistants, suggested, error: loadError } = useAssistantsData(projectId, true);
  const {
    actions: selectionActions,
    loading: selectionActionsLoading,
    error: selectionActionsError,
    applyActionState,
  } = useWorkspaceSelectionActions(projectId);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  // null = the list; a slug = that assistant's details view.
  const [detailSlug, setDetailSlug] = useState<string | null>(initialSlug ?? null);
  const [detail, setDetail] = useState<AssistantDetail | null>(null);
  // slug → in-flight action; one action at a time keeps the result legible.
  const [pending, setPending] = useState<{
    slug: string;
    action: 'connect' | 'create' | 'toggle';
    actionId?: string;
  } | null>(null);
  const [connected, setConnected] = useState<Record<string, ConnectResult>>({});

  // Render-phase prop sync (not an effect): a new sidebar click retargets the
  // details view, and any slug change drops the stale detail immediately.
  const initialFocusKey = `${focusRequestId}:${initialSlug ?? ''}`;
  const [lastInitialFocusKey, setLastInitialFocusKey] = useState(initialFocusKey);
  if (initialFocusKey !== lastInitialFocusKey) {
    setLastInitialFocusKey(initialFocusKey);
    setDetailSlug(initialSlug ?? null);
  }
  const [lastDetailSlug, setLastDetailSlug] = useState(detailSlug);
  if (detailSlug !== lastDetailSlug) {
    setLastDetailSlug(detailSlug);
    setDetail(null);
  }

  useEffect(() => {
    if (!detailSlug) return;
    let cancelled = false;
    loadAssistantDetail(detailSlug)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
      })
      .catch(() => {
        // A vanished slug just falls back to the list.
        if (!cancelled) setDetailSlug(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detailSlug]);

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (a: AssistantEntry) =>
      !q ||
      `${a.name} ${a.slug} ${a.category} ${a.description} ${(a.fields ?? []).join(' ')}`
        .toLowerCase()
        .includes(q),
    [q],
  );

  // Suggested rows keep the model's order; the rest keep catalog order. The
  // search filter applies to both, so a query never hides a suggested match.
  const { suggestedRows, otherRows } = useMemo(() => {
    const all = assistants ?? [];
    const pinned = (suggested ?? [])
      .map((slug) => all.find((a) => a.slug === slug))
      .filter((a): a is AssistantEntry => Boolean(a))
      .filter(matches);
    const pinnedSlugs = new Set(pinned.map((a) => a.slug));
    return {
      suggestedRows: pinned,
      otherRows: all.filter((a) => !pinnedSlugs.has(a.slug)).filter(matches),
    };
  }, [assistants, suggested, matches]);

  const connect = useCallback(
    async (assistant: Pick<AssistantEntry, 'slug' | 'name'>) => {
      setPending({ slug: assistant.slug, action: 'connect' });
      setError('');
      try {
        const res = await apiFetch('/api/workspace/assistants/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, slug: assistant.slug }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          connected?: ConnectResult;
          error?: string;
        };
        if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
        if (!data.connected) throw new Error('Server did not return the connected assistant');
        const result = data.connected;
        setConnected((prev) => ({ ...prev, [assistant.slug]: result }));
        for (const action of selectionActions) {
          if (action.assistant_slug === assistant.slug) {
            applyActionState(assistant.slug, action.id, { connected: true });
          }
        }
        notifyWorkspaceSelectionActionsChanged(projectId);
        onConnected?.(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to connect assistant');
      } finally {
        setPending(null);
      }
    },
    [apiFetch, applyActionState, onConnected, projectId, selectionActions],
  );

  const toggleSelectionAction = useCallback(
    async (action: WorkspaceSelectionAction) => {
      const mutationKey = `${projectId}:${action.assistant_slug}:${action.id}`;
      if (pending || !beginWorkspaceSelectionActionMutation(mutationKey)) return;
      const enabled = !action.enabled;
      setPending({
        slug: action.assistant_slug,
        action: 'toggle',
        actionId: action.id,
      });
      setError('');
      try {
        const response = action.connected
          ? await apiFetch('/api/workspace/assistant-actions', {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                projectId,
                assistantSlug: action.assistant_slug,
                actionId: action.id,
                enabled,
              }),
            })
          : await apiFetch('/api/workspace/assistants/connect', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                projectId,
                slug: action.assistant_slug,
                enableActionIds: [action.id],
              }),
            });
        const body = (await response.json().catch(() => ({}))) as {
          connected?: ConnectResult;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error || 'Could not update this action');
        if (!action.connected) {
          if (!body.connected) throw new Error('Server did not return the connected assistant');
          setConnected((current) => ({
            ...current,
            [action.assistant_slug]: body.connected!,
          }));
          onConnected?.(body.connected);
        }
        applyActionState(action.assistant_slug, action.id, {
          connected: action.connected || enabled,
          enabled,
        });
        notifyWorkspaceSelectionActionsChanged(projectId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not update this action');
      } finally {
        endWorkspaceSelectionActionMutation(mutationKey);
        setPending(null);
      }
    },
    [apiFetch, applyActionState, onConnected, pending, projectId],
  );

  const createWorkspace = useCallback(
    async (assistant: Pick<AssistantEntry, 'slug'>) => {
      setPending({ slug: assistant.slug, action: 'create' });
      setError('');
      try {
        const res = await fetch('/api/assistants/new', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug: assistant.slug }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
        const openUrl: string | undefined = data?.project?.open_url;
        if (!openUrl) throw new Error('Server did not return open_url');
        router.push(openUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create workspace');
        setPending(null);
      }
    },
    [router],
  );

  const isAssistantAdded = (slug: string) =>
    Boolean(connected[slug]) ||
    selectionActions.some((action) => action.assistant_slug === slug && action.connected);

  const detailSetup = (assistant: AssistantEntry) => {
    const isPending = pending?.slug === assistant.slug;
    const added = isAssistantAdded(assistant.slug);
    return (
      <div className="space-y-2.5">
        {added ? (
          <div
            data-testid={`assistant-added-${assistant.slug}`}
            className="flex items-center gap-1.5 text-[12px] font-medium text-emerald-700"
          >
            <CheckCircleIcon className="h-4 w-4" weight="fill" aria-hidden />
            Added to this workspace
          </div>
        ) : null}
        <button
          type="button"
          disabled={pending !== null || added}
          onClick={() => void connect(assistant)}
          data-testid={`assistant-connect-${assistant.slug}`}
          className="flex h-10 w-full items-center justify-center rounded-xl bg-stone-900 px-4 text-[13px] font-medium text-white transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500"
        >
          {added
            ? 'Added'
            : isPending && pending?.action === 'connect'
              ? 'Adding…'
              : 'Add to workspace'}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void createWorkspace(assistant)}
          data-testid={`assistant-create-${assistant.slug}`}
          className="flex h-10 w-full items-center justify-center rounded-xl border border-stone-200 bg-white px-4 text-[13px] font-medium text-stone-600 transition-colors hover:border-stone-300 hover:bg-stone-50 hover:text-stone-800 disabled:opacity-50"
        >
          {isPending && pending?.action === 'create' ? 'Creating…' : 'New workspace'}
        </button>
      </div>
    );
  };

  const connectNote = (slug: string) => {
    const result = connected[slug];
    if (!result) return null;
    const renamedCount = Object.keys(result.renamed ?? {}).length;
    const parts = [
      `${result.added.length} file${result.added.length === 1 ? '' : 's'} added`,
      renamedCount ? `${renamedCount} renamed to avoid name collisions` : null,
      result.identical?.length ? `${result.identical.length} already present` : null,
      result.agentsMerged ? 'AGENTS.md merged' : null,
    ].filter(Boolean);
    return (
      <p className="mt-1 text-[11px] text-stone-400">
        {parts.join(', ')}. Its instructions now guide Sunny here.
      </p>
    );
  };

  const selectionActionSetup = (slug: string) => {
    const actions = selectionActions.filter((action) => action.assistant_slug === slug);
    const expectsActions =
      detail?.slug === slug && Boolean(detail.selection_actions?.length);
    if (!actions.length && !expectsActions) return null;
    return (
      <section
        data-testid="assistant-selection-actions"
        className="rounded-2xl border border-stone-200 bg-white p-4"
      >
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400">
          When text is selected
        </div>
        <div className="mt-3 space-y-3">
          {actions.map((action) => {
            const busy =
              pending?.action === 'toggle' &&
              pending.slug === action.assistant_slug &&
              pending.actionId === action.id;
            return (
              <div key={action.id} className="rounded-xl bg-stone-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-stone-800">{action.title}</div>
                    <p className="mt-0.5 text-[11px] leading-4 text-stone-500">
                      {!action.connected
                        ? `Turning this on installs ${action.assistant_name} and its skill.`
                        : action.enabled
                          ? 'Shown whenever text is selected.'
                          : 'Installed, but hidden from the selection menu.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={action.enabled}
                    aria-label={`Show ${action.label} when text is selected`}
                    disabled={pending !== null}
                    data-testid={`assistant-action-toggle-${action.id}`}
                    onClick={() => void toggleSelectionAction(action)}
                    className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
                      action.enabled ? 'bg-stone-800' : 'bg-stone-300'
                    }`}
                  >
                    {busy ? (
                      <SpinnerGapIcon
                        className="absolute left-2.5 top-1 h-3 w-3 animate-spin text-white"
                        aria-hidden
                      />
                    ) : (
                      <span
                        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                          action.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
                        }`}
                      />
                    )}
                  </button>
                </div>
                <div className="mt-3 border-t border-stone-200/80 pt-3">
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-stone-400">
                    Selection button
                  </div>
                  <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 text-xs font-medium text-stone-700 shadow-sm">
                    <MagnifyingGlassIcon className="h-3.5 w-3.5" aria-hidden />
                    {action.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {selectionActionsLoading ? (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-stone-400">
            <SpinnerGapIcon className="h-3 w-3 animate-spin" aria-hidden />
            Syncing settings…
          </div>
        ) : null}
        {selectionActionsError ? (
          <p role="alert" className="mt-2 text-[11px] text-rose-600">
            {selectionActionsError}
          </p>
        ) : null}
      </section>
    );
  };

  const renderRow = (assistant: AssistantEntry) => (
    <li
      key={assistant.slug}
      className="flex items-start justify-between gap-4 py-4"
      data-testid={`assistant-${assistant.slug}`}
    >
      <div className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-stone-800">{assistant.name}</span>
          <span className="text-[11px] uppercase tracking-wide text-stone-400">
            {assistant.category}
          </span>
        </span>
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-stone-500">
          {assistant.description}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setDetailSlug(assistant.slug)}
        aria-label={`See details for ${assistant.name}`}
        data-testid={`assistant-details-${assistant.slug}`}
        className="shrink-0 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-stone-300 hover:bg-stone-50 hover:text-stone-800"
      >
        See details
      </button>
    </li>
  );

  const detailEntry: AssistantEntry | null = detail
    ? {
        slug: detail.slug,
        name: detail.name,
        category: detail.category,
        description: detail.description,
        fields: detail.fields,
      }
    : null;
  const detailDemo = detail && renderDemo ? renderDemo(detail) : null;

  return (
    <div
      data-testid="assistants-panel"
      role="region"
      aria-label="Assistants"
      className="@container flex min-h-0 flex-1 flex-col bg-white"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-stone-200/70 bg-white px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {detailSlug ? (
            <button
              type="button"
              onClick={() => setDetailSlug(null)}
              aria-label="Back to all assistants"
              data-testid="assistant-detail-back"
              className="relative group/tip inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
            >
              <ArrowLeftIcon className="h-4 w-4" weight="bold" aria-hidden />
              <IconTooltip label="All assistants" />
            </button>
          ) : null}
          <span className="truncate text-[13px] font-medium text-stone-700">
            {detailSlug ? detail?.name ?? 'Assistant' : 'Assistants'}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close assistants"
          data-testid="assistants-panel-close"
          className="relative group/tip inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
        >
          <XIcon className="h-4 w-4" weight="bold" aria-hidden />
          <IconTooltip label="Close" />
        </button>
      </div>

      {detailSlug ? (
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="assistant-detail">
          <div className="mx-auto w-full max-w-6xl px-5 py-7 @3xl:px-8 @3xl:py-10">
            {error ? (
              <p role="alert" className="mb-4 rounded-xl bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
                {error}
              </p>
            ) : null}
            {!detail ? (
              <Spinner label="Loading…" size={14} className="py-2 text-[13px]" />
            ) : (
              <div className="grid gap-8 @5xl:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.55fr)] @5xl:gap-12">
                <main className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h2 className="text-2xl font-semibold tracking-[-0.02em] text-stone-900">
                      {detail.name}
                    </h2>
                    <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400">
                      {detail.category}
                    </span>
                  </div>
                  <p className="mt-2 max-w-3xl text-[14px] leading-6 text-stone-600">
                    {detail.description}
                  </p>

                  {detailDemo ? (
                    <section className="mt-6" data-testid="assistant-demo-slot">
                      {detailDemo}
                    </section>
                  ) : null}

                  <dl className="mt-6 flex flex-wrap gap-x-6 gap-y-2 border-y border-stone-100 py-3 text-[12px] text-stone-500">
                    {detail.fields.length ? (
                      <div>
                        <dt className="inline text-stone-400">Fields: </dt>
                        <dd className="inline">{detail.fields.join(', ')}</dd>
                      </div>
                    ) : null}
                    {detail.deadline ? (
                      <div>
                        <dt className="inline text-stone-400">Deadline: </dt>
                        <dd className="inline">{detail.deadline}</dd>
                      </div>
                    ) : null}
                    {detail.page_limit ? (
                      <div>
                        <dt className="inline text-stone-400">Page limit: </dt>
                        <dd className="inline">{detail.page_limit}</dd>
                      </div>
                    ) : null}
                    {detail.license ? (
                      <div>
                        <dt className="inline text-stone-400">License: </dt>
                        <dd className="inline">{detail.license}</dd>
                      </div>
                    ) : null}
                  </dl>

                  <div className="mt-7 grid gap-7 @3xl:grid-cols-2">
                    {detail.sources.length ? (
                      <section>
                        <h3 className="pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400">
                          Sources
                        </h3>
                        <ul className="space-y-1.5">
                          {detail.sources.map((source) => (
                            <li key={source.url}>
                              <a
                                href={source.url}
                                target="_blank"
                                rel="noreferrer"
                                data-testid="assistant-source-link"
                                className="inline-flex items-center gap-1 text-[13px] leading-5 text-stone-600 underline decoration-stone-300 underline-offset-2 hover:text-stone-900"
                              >
                                <span>{source.name}</span>
                                <ArrowSquareOutIcon className="h-3 w-3 shrink-0 text-stone-400" aria-hidden />
                              </a>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}

                    <section>
                      <h3 className="pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400">
                        Files it adds ({detail.files.length})
                      </h3>
                      <ul className="max-h-52 overflow-y-auto rounded-xl border border-stone-200 bg-stone-50 px-3 py-2">
                        {detail.files.map((file) => (
                          <li
                            key={file.path}
                            className="flex items-center gap-1.5 py-0.5 font-mono text-[11px] text-stone-600"
                          >
                            <span className="truncate">{file.path}</span>
                            {file.locked ? (
                              <LockIcon className="h-3 w-3 shrink-0 text-stone-400" aria-hidden />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1.5 text-[11px] leading-4 text-stone-400">
                        Added at the workspace root. A taken name gets a{' '}
                        <span className="font-mono">-{detail.slug}</span> suffix; nothing is overwritten.
                      </p>
                    </section>
                  </div>
                </main>

                <aside className="min-w-0 space-y-4 @5xl:sticky @5xl:top-6 @5xl:self-start">
                  {selectionActionSetup(detail.slug)}
                  <section className="rounded-2xl border border-stone-200 bg-stone-50/70 p-4">
                    <h3 className="text-[13px] font-semibold text-stone-800">Use this assistant</h3>
                    <p className="mb-4 mt-1 text-[11px] leading-4 text-stone-500">
                      Add it here, or start a separate workspace with its files and instructions.
                    </p>
                    {detailEntry ? detailSetup(detailEntry) : null}
                    {connectNote(detail.slug)}
                  </section>
                </aside>
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="shrink-0 px-4 pb-2 pt-4 @3xl:px-8">
            <div className="mx-auto w-full max-w-5xl">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search assistants"
                aria-label="Search assistants"
                data-testid="assistants-search"
                className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-700 transition-colors placeholder:text-stone-400 focus:border-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-400/20"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-7 @3xl:px-8">
            <div className="mx-auto w-full max-w-5xl">
              {error || loadError ? (
                <p className="pb-2 text-[13px] text-rose-600">{error || loadError}</p>
              ) : null}
              {!assistants && !loadError ? (
                <Spinner label="Loading…" size={14} className="py-2 text-[13px]" />
              ) : null}

              {suggested === null && assistants ? (
                <div data-testid="assistants-suggest-loading" className="flex items-center gap-2 py-2">
                  <Spinner
                    label="Picking suggestions for this workspace…"
                    size={13}
                    className="text-[12px] text-stone-400"
                  />
                </div>
              ) : null}
              {suggestedRows.length ? (
                <section
                  data-testid="assistants-suggested-section"
                  className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 pb-1 pt-3"
                >
                  <div className="pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                    Suggested for this workspace
                  </div>
                  <ul className="divide-y divide-amber-200">{suggestedRows.map(renderRow)}</ul>
                </section>
              ) : null}

              {assistants ? (
                <section data-testid="assistants-all-section">
                  {suggestedRows.length || suggested === null ? (
                    <div className="pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-stone-400">
                      All assistants
                    </div>
                  ) : null}
                  {otherRows.length ? (
                    <ul className="divide-y divide-stone-100">{otherRows.map(renderRow)}</ul>
                  ) : !suggestedRows.length ? (
                    <p className="py-2 text-sm text-stone-500">No assistants match.</p>
                  ) : null}
                </section>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
