'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  CheckIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react';
import type { WorkspaceSelectionAction } from '@/lib/assistants/selection-actions';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import { BUBBLE_LABEL_BUTTON } from '@/components/workspace/selection-bubble-styles';
import {
  beginWorkspaceSelectionActionMutation,
  endWorkspaceSelectionActionMutation,
  notifyWorkspaceSelectionActionsChanged,
  useWorkspaceSelectionActions,
} from '@/components/workspace/assistant-actions-state';

export { useWorkspaceSelectionActions } from '@/components/workspace/assistant-actions-state';

export function SelectionActionControls({
  projectId,
  onInvoke,
}: {
  projectId: string | null;
  onInvoke: (action: WorkspaceSelectionAction) => void;
}) {
  const apiFetch = useApiFetch();
  const { actions, loading, error, applyEnabled } = useWorkspaceSelectionActions(projectId);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const customizeButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingRef = useRef(false);
  const actionsGroupId = useId();
  const actionsGroupLabelId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      customizeButtonRef.current?.focus();
    };
    window.addEventListener('pointerdown', close, { capture: true });
    // Document runs before the result card's window-level Escape handler, so
    // this foreground disclosure can claim Escape without dismissing both.
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close, { capture: true });
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const toggle = async (action: WorkspaceSelectionAction) => {
    const key = `${action.assistant_slug}:${action.id}`;
    const mutationKey = `${projectId}:${key}`;
    if (
      !projectId ||
      pendingRef.current ||
      !beginWorkspaceSelectionActionMutation(mutationKey)
    ) return;
    pendingRef.current = true;
    setPending(key);
    setMutationError(null);
    try {
      const response = action.connected
        ? await apiFetch('/api/workspace/assistant-actions', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              projectId,
              assistantSlug: action.assistant_slug,
              actionId: action.id,
              enabled: !action.enabled,
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
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not update this action');
      if (action.connected) {
        applyEnabled(action.assistant_slug, action.id, !action.enabled);
      }
      notifyWorkspaceSelectionActionsChanged(projectId);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : 'Could not update this action');
    } finally {
      pendingRef.current = false;
      endWorkspaceSelectionActionMutation(mutationKey);
      setPending(null);
    }
  };

  const enabledActions = actions.filter(
    (action) => action.enabled && action.connected && Boolean(action.prompt),
  );

  if (!projectId) return null;

  return (
    <>
      {enabledActions.map((action) => (
        <button
          key={`${action.assistant_slug}:${action.id}`}
          type="button"
          aria-label={action.title}
          data-testid={`selection-action-${action.id}`}
          className={BUBBLE_LABEL_BUTTON}
          onClick={() => onInvoke(action)}
        >
          <MagnifyingGlassIcon className="h-4 w-4" weight="regular" aria-hidden />
          {action.label}
        </button>
      ))}
      <div className="relative" ref={rootRef}>
        <button
          ref={customizeButtonRef}
          type="button"
          aria-label="Customize selection actions"
          aria-expanded={open}
          aria-controls={actionsGroupId}
          data-testid="selection-actions-customize"
          className={BUBBLE_LABEL_BUTTON}
          onClick={() => {
            setOpen((value) => {
              const next = !value;
              if (next) {
                queueMicrotask(() => customizeButtonRef.current?.focus({ preventScroll: true }));
              }
              return next;
            });
          }}
        >
          <GearSixIcon className="h-4 w-4" weight="regular" aria-hidden />
          Customize
        </button>
        {open && (
          <div
            id={actionsGroupId}
            role="group"
            aria-labelledby={actionsGroupLabelId}
            data-testid="selection-actions-menu"
            className="absolute right-0 top-full z-20 mt-1.5 w-64 rounded-xl border border-stone-200 bg-white p-1.5 shadow-[0_8px_24px_rgba(28,25,23,0.14)]"
          >
            <div
              id={actionsGroupLabelId}
              className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400"
            >
              Show when text is selected
            </div>
            {loading && actions.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-stone-500">
                <SpinnerGapIcon className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Loading actions…
              </div>
            ) : actions.length === 0 ? (
              <div className="px-2 py-2 text-[12px] text-stone-500">
                No assistant actions available.
              </div>
            ) : (
              actions.map((action) => {
                const key = `${action.assistant_slug}:${action.id}`;
                const busy = pending === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={action.enabled}
                    disabled={Boolean(pending)}
                    data-testid={`selection-action-toggle-${action.id}`}
                    onClick={() => void toggle(action)}
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-stone-100 disabled:opacity-60"
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        action.enabled
                          ? 'border-beige-500 bg-beige-500 text-white'
                          : 'border-stone-300 bg-white text-transparent'
                      }`}
                    >
                      {busy ? (
                        <SpinnerGapIcon className="h-3 w-3 animate-spin text-stone-500" aria-hidden />
                      ) : (
                        <CheckIcon className="h-3 w-3" weight="bold" aria-hidden />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium text-stone-800">{action.title}</span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-stone-500">
                        {action.connected
                          ? action.assistant_name
                          : `Install ${action.assistant_name} and its skill`}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
            {(mutationError || error) && (
              <div role="alert" className="mx-1 mt-1 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-700">
                {mutationError || error}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
