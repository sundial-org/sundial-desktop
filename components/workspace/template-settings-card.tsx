'use client';

import { useEffect, useState } from 'react';
import { CaretDownIcon, CaretRightIcon, SparkleIcon } from '@phosphor-icons/react';

type Props = {
  projectId: string;
  canWrite: boolean;
  templateSlug: string;
  templateName: string;
  // The current source-of-truth manifest text. If override is null the brain
  // uses this. Shown as the "default" the Reset button restores.
  defaultAddendum: string;
  // The user-edited text. Non-null means the brain uses this instead.
  initialOverride: string | null;
  // The assistant's CURRENT instructions from the store. When it differs from
  // defaultAddendum the assistant was edited after this workspace snapshotted
  // it; we offer an opt-in "Update" that re-snapshots (server-side).
  latestAddendum?: string | null;
};

/**
 * Template section in the workspace settings tab. Three modes:
 *   - default (no override): collapsed pill with View / Customize / Remove
 *   - editing (just clicked Customize, no override yet): editable textarea
 *     seeded with the manifest text; Save persists, Cancel reverts
 *   - customized (override set): editable textarea showing override; Reset
 *     to default clears the override
 *
 * View toggles a read-only expand of the effective text without entering
 * the edit flow. Remove clears template_slug + any override.
 */
export function TemplateSettingsCard({
  projectId,
  canWrite,
  templateSlug,
  templateName,
  defaultAddendum,
  initialOverride,
  latestAddendum = null,
}: Props) {
  const [override, setOverride] = useState<string | null>(initialOverride);
  const [draft, setDraft] = useState<string>(initialOverride ?? '');
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  // Set once Update succeeds so the banner clears without a reload. State (not
  // a prop resync) because the server-provided defaultAddendum is stale until
  // the next navigation.
  const [appliedDefault, setAppliedDefault] = useState<string | null>(null);
  const [previewingUpdate, setPreviewingUpdate] = useState(false);

  useEffect(() => {
    setOverride(initialOverride);
    setDraft(initialOverride ?? '');
  }, [initialOverride]);

  if (removed) return null;

  const isCustomized = override !== null;
  const currentDefault = appliedDefault ?? defaultAddendum;
  const effectiveText = isCustomized ? override ?? '' : currentDefault;
  const updateAvailable =
    typeof latestAddendum === 'string' &&
    latestAddendum.trim().length > 0 &&
    latestAddendum.trim() !== currentDefault.trim();

  async function patch(payload: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/workspace', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId, ...payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function startCustomize() {
    setDraft(override ?? currentDefault);
    setEditing(true);
    setViewing(false);
  }

  async function saveDraft() {
    const trimmed = draft.trim();
    // Treat editing back to the exact default as a Reset — cleaner state.
    const next = trimmed === currentDefault.trim() ? null : draft;
    const ok = await patch({ template_addendum_override: next });
    if (ok) {
      setOverride(next);
      setEditing(false);
    }
  }

  function cancelDraft() {
    setDraft(override ?? '');
    setEditing(false);
    setError(null);
  }

  async function resetToDefault() {
    const ok = await patch({ template_addendum_override: null });
    if (ok) {
      setOverride(null);
      setDraft('');
      setEditing(false);
    }
  }

  async function removeTemplate() {
    if (!window.confirm(`Remove the ${templateName} template from this workspace? Sundial Agent will stop following the venue's guidelines. Your files stay.`)) {
      return;
    }
    const ok = await patch({ template_slug: null });
    if (ok) setRemoved(true);
  }

  async function applyInstructionUpdate() {
    // Server re-reads the assistant and re-snapshots; the client never sends
    // the text itself.
    const ok = await patch({ refresh_template_default: true });
    if (ok) {
      setAppliedDefault(latestAddendum ?? defaultAddendum);
      setPreviewingUpdate(false);
    }
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-stone-50 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SparkleIcon className="h-4 w-4 text-orange" weight="fill" aria-hidden />
            <span className="text-sm font-medium text-stone-700">Template: {templateName}</span>
            {isCustomized ? (
              <span className="rounded-full bg-orange/15 px-1.5 py-0.5 text-[10px] font-medium text-orange-deep">
                edited
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-stone-600">
            Sunny fetches the live author guidelines before any edit and adheres to them.
            Applies to every chat in this workspace.
          </p>
        </div>
      </div>

      {updateAvailable ? (
        <div
          data-testid="template-update-banner"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
        >
          <p className="text-xs text-amber-900">
            {templateName} has newer instructions than this workspace uses.
            {isCustomized
              ? ' Updating changes the default your Reset button restores; your customized text stays in effect.'
              : ''}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPreviewingUpdate((v) => !v)}
              className="inline-flex items-center gap-1 text-xs text-amber-800 underline-offset-2 hover:underline"
            >
              {previewingUpdate ? 'Hide changes' : 'View changes'}
            </button>
            {canWrite ? (
              <button
                type="button"
                onClick={applyInstructionUpdate}
                disabled={busy}
                className="rounded-lg bg-orange px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
              >
                {busy ? 'Updating…' : 'Update'}
              </button>
            ) : null}
          </div>
          {previewingUpdate ? (
            <pre className="mt-2 max-h-[14rem] overflow-auto rounded-lg border border-amber-200 bg-white px-3 py-2 font-mono text-[11px] leading-relaxed text-stone-700 whitespace-pre-wrap">
              {latestAddendum}
            </pre>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <div className="mt-3">
          <textarea
            rows={12}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 font-mono text-xs text-stone-800 focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={saveDraft}
              disabled={busy || draft === (override ?? currentDefault)}
              className="rounded-lg bg-orange px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={cancelDraft}
              disabled={busy}
              className="rounded-lg border border-stone-200 px-3 py-1 text-xs text-stone-700 hover:bg-stone-50"
            >
              Cancel
            </button>
            {isCustomized ? (
              <button
                type="button"
                onClick={resetToDefault}
                disabled={busy}
                className="ml-auto rounded-md px-2 py-1 text-xs text-stone-500 hover:text-stone-700"
                title="Discard your edits and use the template's default text"
              >
                Reset to default
              </button>
            ) : null}
          </div>
        </div>
      ) : viewing ? (
        <div className="mt-3">
          <pre className="max-h-[18rem] overflow-auto rounded-lg border border-stone-200 bg-white px-3 py-2 font-mono text-[11px] leading-relaxed text-stone-700 whitespace-pre-wrap">
            {effectiveText}
          </pre>
          <button
            type="button"
            onClick={() => setViewing(false)}
            className="mt-2 inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700"
          >
            <CaretDownIcon className="h-3 w-3" weight="bold" aria-hidden /> Hide
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setViewing(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-xs text-stone-700 transition-colors hover:bg-stone-50"
          >
            <CaretRightIcon className="h-3 w-3" weight="bold" aria-hidden /> View instructions
          </button>
          {canWrite ? (
            <>
              <button
                type="button"
                onClick={startCustomize}
                className="inline-flex items-center rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-xs text-stone-700 transition-colors hover:bg-stone-50"
              >
                {isCustomized ? 'Edit' : 'Customize'}
              </button>
              {isCustomized ? (
                <button
                  type="button"
                  onClick={resetToDefault}
                  disabled={busy}
                  className="inline-flex items-center rounded-md px-2 py-1 text-xs text-stone-500 hover:text-stone-700"
                >
                  Reset to default
                </button>
              ) : null}
              <button
                type="button"
                onClick={removeTemplate}
                disabled={busy}
                className="ml-auto inline-flex items-center rounded-md px-2 py-1 text-xs text-stone-500 hover:text-red-600"
              >
                Remove
              </button>
            </>
          ) : null}
        </div>
      )}

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
