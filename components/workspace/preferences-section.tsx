'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDownIcon, CpuIcon } from '@phosphor-icons/react';
import {
  buildChatRuntimePicker,
  DEFAULT_MODEL_REF,
  getChatModelLabel,
  type ChatRuntimePickerOption,
} from '@/lib/workspace/chat-runtime';
import { useChatModels } from '@/lib/workspace/use-models';
import { advancedFlags } from '@/lib/flags/registry';
import {
  AUTOCOMPLETE_MODES,
  type AutocompleteMode,
} from '@/lib/workspace/autocomplete/mode';
import {
  AUTOCOMPLETE_FEATURED_MODEL_IDS,
  DEFAULT_AUTOCOMPLETE_MODEL,
} from '@/lib/workspace/autocomplete/model';
import { getProviderIcon } from '@/components/workspace/provider-icons';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  formatShortcut,
  isMacPlatform,
  markdownSyntaxShortcuts,
  workspaceShortcuts,
} from '@/lib/workspace/shortcuts';

export function ShortcutsSection({ desktopShell }: { desktopShell: boolean }) {
  // ⌘ vs Ctrl is a client fact — read after mount to keep SSR markup stable.
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(isMacPlatform()), []);
  return (
    <section className="space-y-2" data-testid="shortcuts-section">
      <div>
        <h3 className="text-sm font-medium text-stone-800">Keyboard shortcuts</h3>
        <p className="mt-1 text-xs text-stone-500">
          Reference only. Shortcuts can&apos;t be customized yet.
        </p>
      </div>
      <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
        {workspaceShortcuts({ desktopShell }).map((spec) => (
          <li key={spec.id} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-stone-700">
            <span className="min-w-0 flex-1 truncate">{spec.label}</span>
            {spec.desktopApp && !desktopShell ? (
              <span className="mr-1 text-[10px] text-stone-400">desktop app</span>
            ) : null}
            {spec.keys.map((combo) => (
              <kbd
                key={combo}
                className="rounded border border-stone-200 bg-stone-50 px-1 py-px font-sans text-[10px] text-stone-400"
              >
                {formatShortcut(combo, mac)}
              </kbd>
            ))}
          </li>
        ))}
      </ul>
      <div className="pt-2">
        <h4 className="text-sm font-medium text-stone-800">Markdown syntax</h4>
        <p className="mt-1 text-xs text-stone-500">
          Type these in a Markdown document; they format as you type.
        </p>
      </div>
      <ul
        className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white"
        data-testid="markdown-syntax-list"
      >
        {markdownSyntaxShortcuts().map((spec) => (
          <li key={spec.id} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-stone-700">
            <span className="min-w-0 flex-1 truncate">{spec.label}</span>
            <kbd className="rounded border border-stone-200 bg-stone-50 px-1 py-px font-mono text-[10px] text-stone-400">
              {spec.syntax}
            </kbd>
          </li>
        ))}
      </ul>
    </section>
  );
}

type ModelPickerRuntime = ReturnType<typeof buildChatRuntimePicker> & {
  modelsLoading: boolean;
  emptyReason: string | null;
};

/** Picker state over an ALREADY-FETCHED catalog. It takes the `useChatModels`
 *  result rather than a projectId on purpose: that hook fetches per call with
 *  no dedupe, so resolving the catalog in here would put a second
 *  `/api/workspace/models` request on the wire for the second picker.
 *  `featuredIds` is the only axis the two differ on — chat flagships vs the
 *  latency roster ghost text is actually bound by. */
function useModelPickerRuntime(
  catalog: ReturnType<typeof useChatModels>,
  featuredIds?: ReadonlyArray<string>,
): ModelPickerRuntime {
  const { models, loading: modelsLoading, emptyReason } = catalog;
  return useMemo(
    () => ({ ...buildChatRuntimePicker(models, featuredIds), modelsLoading, emptyReason }),
    [models, featuredIds, modelsLoading, emptyReason]
  );
}

/** The default row and a nullable selection are ONE decision, so the props
 *  make them one: a picker without the row can never hand back `null`, which
 *  is what keeps its `onSelect` from needing a guard it can't reach. */
type ModelPickerControlProps = {
  loaded: boolean;
  /** Selected catalog id, or null when the default row (if any) is selected. */
  selectedId: string | null;
  runtime: ModelPickerRuntime;
  ariaLabel: string;
} & (
  | {
      /** A top row that selects `null` — "use the built-in default". */
      defaultRowLabel: string;
      onSelect: (modelId: string | null) => void;
    }
  | { defaultRowLabel?: undefined; onSelect: (modelId: string) => void }
);

function ModelPickerControl(props: ModelPickerControlProps) {
  // `onSelect` stays on `props` so its arm can be narrowed by the
  // `defaultRowLabel` discriminant below; destructuring it here would break
  // that correlation and force a cast at the one call that passes null.
  const { loaded, selectedId, runtime, ariaLabel, defaultRowLabel } = props;
  const { allOptions, featuredSections, moreSections, modelsLoading, emptyReason } = runtime;
  const [open, setOpen] = useState(false);
  // `null` = untouched, so the list can default itself open when the saved
  // default sits outside the featured row (a newer sibling took the slot) —
  // otherwise it renders with nothing selected. Same tri-state as the composer.
  const [showMore, setShowMore] = useState<boolean | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const featuredOptions = useMemo(
    () => featuredSections.flatMap((section) => section.options),
    [featuredSections]
  );
  const moreOptions = useMemo(
    () => moreSections.flatMap((section) => section.options),
    [moreSections]
  );
  const expanded = showMore ?? moreOptions.some((option) => option.id === selectedId);
  const [search, setSearch] = useState('');
  // A non-empty query replaces the browse view with a flat match list
  // (options are already featured-first / newest-first).
  const query = search.trim().toLowerCase();
  const searchResults = useMemo(
    () =>
      query
        ? allOptions.filter((option) =>
            `${option.label} ${option.id} ${option.providerLabel}`.toLowerCase().includes(query),
          )
        : null,
    [allOptions, query],
  );

  const selectedOption = selectedId
    ? allOptions.find((option) => option.id === selectedId) ?? null
    : null;
  const selectedLabel =
    selectedId === null && defaultRowLabel
      ? defaultRowLabel
      : selectedOption?.label ?? getChatModelLabel(selectedId ?? '', 'Model');
  const SelectedIcon = selectedOption ? getProviderIcon(selectedOption) ?? CpuIcon : null;

  // Drop the override on *every* close path — the trigger, an outside click,
  // picking a model — so the next open re-derives its default.
  useEffect(() => {
    if (!open) {
      setShowMore(null);
      setSearch('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const pick = (modelId: string | null) => {
    setOpen(false);
    if (modelId !== null) props.onSelect(modelId);
    // Only reachable from the default row, which only the nullable arm renders.
    else if (props.defaultRowLabel !== undefined) props.onSelect(null);
  };

  const renderOption = (option: ChatRuntimePickerOption) => {
    const isSelected = option.id === selectedId;
    // Providers without a brand icon get a neutral placeholder so rows align.
    const Icon = getProviderIcon(option) ?? CpuIcon;
    return (
      <button
        key={option.id}
        type="button"
        onClick={() => pick(option.id)}
        data-selected={isSelected ? 'true' : 'false'}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-stone-50 ${
          isSelected ? 'bg-stone-50 text-stone-800' : 'text-stone-700'
        }`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-stone-500" />
        <span className="truncate">{option.label}</span>
      </button>
    );
  };

  return (
    <div className="relative" ref={pickerRef}>
      <button
        type="button"
        onClick={() => loaded && setOpen((prev) => !prev)}
        aria-label={ariaLabel}
        disabled={!loaded}
        className="flex w-full items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 transition-colors hover:bg-stone-50 disabled:cursor-default disabled:hover:bg-white"
      >
        <span className="text-stone-400">Model:</span>
        {loaded ? (
          <>
            {SelectedIcon ? <SelectedIcon className="h-3.5 w-3.5 text-stone-500" /> : null}
            <span className="truncate">{selectedLabel}</span>
          </>
        ) : (
          <Spinner label="Loading…" size={13} className="text-[11px]" />
        )}
        <CaretDownIcon className="ml-auto h-3 w-3 text-stone-400" weight="bold" aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
          {expanded ? (
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search models"
              autoFocus
              className="w-full border-b border-stone-100 bg-transparent px-3 py-1.5 text-sm text-stone-700 placeholder:text-stone-400 focus:outline-none"
            />
          ) : null}
          <div className="max-h-[360px] overflow-y-auto">
            {searchResults ? (
              searchResults.length > 0 ? (
                searchResults.map(renderOption)
              ) : (
                <div className="px-3 py-1.5 text-[11px] text-stone-400">No models match</div>
              )
            ) : (
              <>
                {defaultRowLabel ? (
                  <button
                    type="button"
                    onClick={() => pick(null)}
                    data-selected={selectedId === null ? 'true' : 'false'}
                    className={`flex w-full items-center gap-2 border-b border-stone-100 px-3 py-1.5 text-left text-sm transition-colors hover:bg-stone-50 ${
                      selectedId === null ? 'bg-stone-50 text-stone-800' : 'text-stone-700'
                    }`}
                  >
                    <CpuIcon className="h-3.5 w-3.5 shrink-0 text-stone-500" />
                    <span className="truncate">{defaultRowLabel}</span>
                  </button>
                ) : null}
                {featuredOptions.map(renderOption)}
                {expanded
                  ? moreSections.map((section) => (
                      <div key={section.key}>
                        <div className="border-t border-stone-100 px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-stone-400">
                          {section.label}
                        </div>
                        {section.options.map(renderOption)}
                      </div>
                    ))
                  : null}
              </>
            )}
            {modelsLoading ? (
              <Spinner label="Loading…" size={13} className="px-3 py-1.5 text-[11px]" />
            ) : null}
            {!modelsLoading && allOptions.length === 0 && emptyReason ? (
              <div className="px-3 py-1.5 text-[11px] text-stone-400">{emptyReason}</div>
            ) : null}
            {moreOptions.length > 0 && !searchResults ? (
              <button
                type="button"
                onClick={() => setShowMore(!expanded)}
                className="mt-0.5 flex w-full items-center justify-between border-t border-stone-100 px-3 py-1.5 text-left text-[11px] text-stone-400 hover:bg-stone-50 hover:text-stone-600"
              >
                <span>{expanded ? 'Show less' : 'More models'}</span>
                <span aria-hidden>{expanded ? '▴' : '▾'}</span>
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}


/** Tab copy for the two behavior modes — ordered as AUTOCOMPLETE_MODES. */
const MODE_TABS: Record<AutocompleteMode, { label: string; blurb: string }> = {
  ai: { label: 'AI', blurb: 'Model-written continuations. Uses credits.' },
  deterministic: {
    label: 'Deterministic',
    blurb: 'Finishes words and syntax from this document. Free and instant.',
  },
};

type PreferencesSectionProps = {
  projectId: string | null | undefined;
  // The saved default model, owned by the parent (single source of truth).
  // null = not loaded yet → render a spinner instead of flashing a placeholder.
  value: string | null;
  onChange?: (values: { defaultModel: string }) => void;
  // The autocomplete override, from the SAME parent-owned preferences payload:
  // `undefined` while it loads, `null` for "no override". Owned there rather
  // than fetched here so one component doesn't hold two copies of one document
  // under two different loading conventions.
  autocompleteValue?: string | null | undefined;
  onAutocompleteChange?: (modelId: string | null) => void;
  /** The account-backed flags object from the same parent-owned preferences
   *  payload — every `lib/flags/registry` key resolved. `undefined` while it
   *  loads. The section renders one switch per `surface: 'advanced'` entry. */
  flags?: Record<string, boolean> | undefined;
  onFlagChange?: (key: string, enabled: boolean) => void;
  /** The autocomplete behavior mode, from the same parent-owned payload:
   *  `undefined` while it loads. */
  autocompleteMode?: AutocompleteMode | undefined;
  onAutocompleteModeChange?: (mode: AutocompleteMode) => void;
  /** Whether the viewer has an account to save an account-backed preference
   *  to. `/api/user/preferences` answers 401 to anonymous callers, so with
   *  this false the autocomplete picker is hidden rather than offered and
   *  then rolled back with "Failed to save preferences." on every pick. */
  canSavePreferences?: boolean;
};

export function PreferencesSection({
  projectId,
  value,
  onChange,
  autocompleteValue,
  onAutocompleteChange,
  flags,
  onFlagChange,
  autocompleteMode,
  onAutocompleteModeChange,
  canSavePreferences = true,
}: PreferencesSectionProps) {
  const loaded = value !== null;
  const defaultModel = value ?? DEFAULT_MODEL_REF;
  const [error, setError] = useState('');

  // ONE catalog fetch, two pickers drawn from it.
  const catalog = useChatModels(projectId ?? null);
  const runtime = useModelPickerRuntime(catalog);

  const save = async (modelId: string) => {
    setError('');
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_model: modelId }),
      });
      if (!res.ok) throw new Error('Failed to save preferences.');
      // Only update the parent (and thus new-chat default) after the save
      // persists — otherwise a failed PUT would feed an unsaved model into
      // chat creation, which rejects unsupported explicit models.
      onChange?.({ defaultModel: modelId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preferences.');
    }
  };

  // ── Autocomplete pilot ──────────────────────────────────────────
  // Same catalog, different short list: ghost text is latency-bound, so the
  // featured row is the benchmarked roster and the chat flagships sit under
  // "More models" with everything else.
  const autocompleteRuntime = useModelPickerRuntime(catalog, AUTOCOMPLETE_FEATURED_MODEL_IDS);

  const [autocompleteError, setAutocompleteError] = useState('');
  const [flagError, setFlagError] = useState<{ key: string; message: string } | null>(null);

  const saveFlag = async (key: string, enabled: boolean) => {
    setFlagError(null);
    const previous = flags?.[key] ?? false;
    // Optimistic like the model override below: the parent mirrors the flip
    // into the live flag store, so features follow the switch without a
    // reload. Rolled back if the PUT fails.
    onFlagChange?.(key, enabled);
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flags: { [key]: enabled } }),
      });
      if (!res.ok) throw new Error('Failed to save preferences.');
    } catch (err) {
      onFlagChange?.(key, previous);
      setFlagError({
        key,
        message: err instanceof Error ? err.message : 'Failed to save preferences.',
      });
    }
  };

  const saveAutocompleteMode = async (mode: AutocompleteMode) => {
    setAutocompleteError('');
    const previous = autocompleteMode;
    if (mode === previous) return;
    // Optimistic with rollback, like the switch: the parent mirrors the mode
    // into the client store so open editors change behavior without a reload.
    onAutocompleteModeChange?.(mode);
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autocomplete_mode: mode }),
      });
      if (!res.ok) throw new Error('Failed to save preferences.');
    } catch (err) {
      if (previous !== undefined) onAutocompleteModeChange?.(previous);
      setAutocompleteError(err instanceof Error ? err.message : 'Failed to save preferences.');
    }
  };

  const saveAutocompleteModel = async (modelId: string | null) => {
    setAutocompleteError('');
    const previous = autocompleteValue ?? null;
    // Optimistic, and rolled back below: unlike the default model — which
    // feeds chat creation and so must not move before the PUT lands — a wrong
    // autocomplete model costs one keystroke's ghost text.
    //
    // Either way an editor already open keeps completing on the previous model
    // until its grant expires, since the route signs the model in at mint time
    // (one minute, by AUTOCOMPLETE_GRANT_TTL_SECONDS).
    onAutocompleteChange?.(modelId);
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autocomplete_model: modelId }),
      });
      if (!res.ok) throw new Error('Failed to save preferences.');
    } catch (err) {
      onAutocompleteChange?.(previous);
      setAutocompleteError(err instanceof Error ? err.message : 'Failed to save preferences.');
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium text-stone-800">Model</h3>
          <p className="mt-1 text-xs text-stone-500">Default model for new chats.</p>
        </div>
        <ModelPickerControl
          loaded={loaded}
          selectedId={defaultModel}
          runtime={runtime}
          ariaLabel="Default model"
          onSelect={save}
        />
        {error ? <p className="text-[11px] text-rose-600">{error}</p> : null}
      </section>
      {canSavePreferences
        ? advancedFlags().map((flag) => {
            const enabled = flags?.[flag.key];
            return (
              <section className="space-y-2" key={flag.key} data-testid={`flag-section-${flag.key}`}>
                <label className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium text-stone-800">{flag.label}</h3>
                    <p className="mt-1 text-xs text-stone-500">{flag.description}</p>
                  </div>
                  <Switch
                    checked={enabled === true}
                    ariaLabel={flag.label}
                    disabled={enabled === undefined}
                    onToggle={(next) => void saveFlag(flag.key, next)}
                  />
                </label>
                {/* Per-flag extras render only while the switch is on. */}
                {flag.key === 'autocomplete_enabled' && enabled ? (
                  <div className="space-y-2">
                    <div
                      role="tablist"
                      aria-label="Autocomplete behavior"
                      className="flex w-fit gap-0.5 rounded-lg border border-stone-200 bg-stone-50 p-0.5"
                      data-testid="autocomplete-mode-tabs"
                    >
                      {AUTOCOMPLETE_MODES.map((mode) => {
                        const selected = autocompleteMode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            disabled={autocompleteMode === undefined}
                            onClick={() => void saveAutocompleteMode(mode)}
                            className={`rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                              selected
                                ? 'bg-white text-stone-800 shadow-sm'
                                : 'text-stone-500 hover:text-stone-700'
                            }`}
                          >
                            {MODE_TABS[mode].label}
                          </button>
                        );
                      })}
                    </div>
                    {autocompleteMode !== undefined ? (
                      <p className="text-xs text-stone-500">{MODE_TABS[autocompleteMode].blurb}</p>
                    ) : null}
                    {autocompleteMode !== 'deterministic' ? (
                      <div data-testid="autocomplete-model-section">
                        <ModelPickerControl
                          loaded={autocompleteValue !== undefined}
                          selectedId={autocompleteValue ?? null}
                          runtime={autocompleteRuntime}
                          ariaLabel="Autocomplete model"
                          defaultRowLabel={`Default (${getChatModelLabel(DEFAULT_AUTOCOMPLETE_MODEL, 'Model')})`}
                          onSelect={saveAutocompleteModel}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {flagError?.key === flag.key ? (
                  <p className="text-[11px] text-rose-600">{flagError.message}</p>
                ) : null}
                {flag.key === 'autocomplete_enabled' && autocompleteError ? (
                  <p className="text-[11px] text-rose-600">{autocompleteError}</p>
                ) : null}
              </section>
            );
          })
        : null}
    </div>
  );
}
