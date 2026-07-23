'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react';
import {
  buildChatRuntimePicker,
  DEFAULT_MODEL_REF,
  getChatModelLabel,
  type ChatRuntimePickerOption,
} from '@/lib/workspace/chat-runtime';
import { useChatModels } from '@/lib/workspace/use-models';
import { getProviderIcon } from '@/components/workspace/provider-icons';
import { Spinner } from '@/components/ui/spinner';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/lib/theme';

const THEME_OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

function AppearanceSection() {
  // localStorage-backed, so read only after mount to keep SSR markup stable.
  const [theme, setTheme] = useState<ThemePreference | null>(null);
  useEffect(() => setTheme(getThemePreference()), []);
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-stone-800">Appearance</h3>
        <p className="mt-1 text-xs text-stone-500">Theme for this device.</p>
      </div>
      <div className="inline-flex rounded-lg border border-stone-200 bg-white p-0.5">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={theme === option.id}
            onClick={() => {
              setTheme(option.id);
              setThemePreference(option.id);
            }}
            className={`rounded-md px-3 py-1 text-sm transition-colors ${
              theme === option.id
                ? 'bg-stone-100 text-stone-800'
                : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}

type PreferencesSectionProps = {
  projectId: string | null | undefined;
  // The saved default model, owned by the parent (single source of truth).
  // null = not loaded yet → render a spinner instead of flashing a placeholder.
  value: string | null;
  onChange?: (values: { defaultModel: string }) => void;
};

export function PreferencesSection({ projectId, value, onChange }: PreferencesSectionProps) {
  const loaded = value !== null;
  const defaultModel = value ?? DEFAULT_MODEL_REF;
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const {
    models: litellmModels,
    loading: modelsLoading,
    emptyReason,
  } = useChatModels(projectId ?? null);

  const { allOptions, featuredSections, moreSections } = useMemo(
    () => buildChatRuntimePicker(litellmModels),
    [litellmModels]
  );
  const featuredOptions = useMemo(
    () => featuredSections.flatMap((section) => section.options),
    [featuredSections]
  );
  const moreOptions = useMemo(
    () => moreSections.flatMap((section) => section.options),
    [moreSections]
  );
  const visibleOptions = showMore ? allOptions : featuredOptions;

  const selectedOption = allOptions.find((option) => option.id === defaultModel) ?? null;
  const selectedLabel = selectedOption?.label ?? getChatModelLabel(defaultModel, 'Model');
  const SelectedIcon = selectedOption ? getProviderIcon(selectedOption) : null;

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setShowMore(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const save = async (modelId: string) => {
    setError('');
    setOpen(false);
    setShowMore(false);
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

  const renderOption = (option: ChatRuntimePickerOption) => {
    const isSelected = option.id === defaultModel;
    const Icon = getProviderIcon(option);
    return (
      <button
        key={option.id}
        type="button"
        onClick={() => void save(option.id)}
        data-selected={isSelected ? 'true' : 'false'}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-stone-50 ${
          isSelected ? 'bg-stone-50 text-stone-800' : 'text-stone-700'
        }`}
      >
        {Icon ? (
          <Icon className="h-3.5 w-3.5 shrink-0 text-stone-500" />
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span className="truncate">{option.label}</span>
      </button>
    );
  };

  return (
    <div className="space-y-6">
    <AppearanceSection />
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-stone-800">Model</h3>
        <p className="mt-1 text-xs text-stone-500">Default model for new chats.</p>
      </div>
      <div className="relative" ref={pickerRef}>
        <button
          type="button"
          onClick={() => loaded && setOpen((prev) => !prev)}
          aria-label="Default model"
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
            <div className="max-h-[360px] overflow-y-auto">
              {visibleOptions.map(renderOption)}
              {modelsLoading ? (
                <Spinner label="Loading…" size={13} className="px-3 py-1.5 text-[11px]" />
              ) : null}
              {!modelsLoading && litellmModels.length === 0 && emptyReason ? (
                <div className="px-3 py-1.5 text-[11px] text-stone-400">{emptyReason}</div>
              ) : null}
              {moreOptions.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowMore((prev) => !prev)}
                  className="mt-0.5 flex w-full items-center justify-between border-t border-stone-100 px-3 py-1.5 text-left text-[11px] text-stone-400 hover:bg-stone-50 hover:text-stone-600"
                >
                  <span>{showMore ? 'Show less' : 'More models'}</span>
                  <span aria-hidden>{showMore ? '▴' : '▾'}</span>
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
      {error ? <p className="text-[11px] text-rose-600">{error}</p> : null}
    </section>
    </div>
  );
}
