'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/lib/theme';
import { getDocStylePreference, setDocStylePreference, type DocStyle } from '@/lib/doc-style';

const THEME_OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

/* eslint-disable @next/next/no-img-element */
const image = (src: string) => (
  <img src={src} alt="" aria-hidden className="w-full rounded-lg border border-stone-200" />
);

/** Abstract mini-window: a tab strip (one active tab + two behind it) or a
 *  single plain title row — screenshots scaled this small were unreadable. */
function TabsGlyph({ tabs }: { tabs: boolean }) {
  return (
    <div aria-hidden className="w-full overflow-hidden rounded-lg border border-stone-200 bg-white">
      {tabs ? (
        <div className="flex items-end gap-1 border-b border-stone-200 bg-stone-100 px-2 pt-1.5">
          <div className="h-4 w-16 rounded-t-md border border-b-0 border-stone-200 bg-white" />
          <div className="mb-px h-3.5 w-14 rounded-t-md bg-stone-200/80" />
          <div className="mb-px h-3.5 w-14 rounded-t-md bg-stone-200/80" />
        </div>
      ) : (
        <div className="flex items-center justify-center border-b border-stone-200 bg-stone-50 py-2">
          <div className="h-1.5 w-20 rounded-full bg-stone-300" />
        </div>
      )}
      <div className="space-y-1.5 p-3">
        <div className="h-1.5 w-3/5 rounded-full bg-stone-200" />
        <div className="h-1.5 w-full rounded-full bg-stone-100" />
        <div className="h-1.5 w-4/5 rounded-full bg-stone-100" />
      </div>
    </div>
  );
}

// Where the document style is switched: every arrival lands on the IDE
// surface and this section (or the document ⋯ menu) is how anyone moves off it.
type PreviewOption<T extends string> = { id: T; label: string; caption: string; preview: ReactNode };

const DOC_STYLE_OPTIONS: PreviewOption<DocStyle>[] = [
  {
    id: 'docs',
    label: 'Docs',
    caption: 'A page with menus and a toolbar, like Google Docs.',
    preview: image('/onboarding/view-docs.png'),
  },
  {
    id: 'obsidian',
    label: 'IDE',
    caption: 'A minimal flat editor, like Obsidian or Apple Notes.',
    preview: image('/onboarding/view-ide.png'),
  },
];

const TAB_OPTIONS: PreviewOption<'tabs' | 'none'>[] = [
  {
    id: 'tabs',
    label: 'Tabs',
    caption: 'A tab strip across the top, with every open file in reach.',
    preview: <TabsGlyph tabs />,
  },
  {
    id: 'none',
    label: 'No tabs',
    caption: 'One surface at a time. More focused.',
    preview: <TabsGlyph tabs={false} />,
  },
];

/** Preview cards: the previews ARE the explanation of what each choice
 *  looks like. */
function PreviewPicker<T extends string>({
  options,
  value,
  onChange,
}: {
  options: PreviewOption<T>[];
  value: T | null;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex max-w-xl gap-3">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          // The label alone is the accessible name — captions would bloat it
          // (and break the by-name lookups tests and users rely on).
          aria-label={option.label}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`flex min-w-0 flex-1 flex-col gap-1.5 rounded-xl border p-2 text-left transition-colors ${
            value === option.id
              ? 'border-stone-400 bg-stone-50'
              : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50'
          }`}
        >
          {/* Decorative — the label right below names the choice. */}
          {option.preview}
          <span
            className={`text-sm ${value === option.id ? 'font-medium text-stone-800' : 'text-stone-600'}`}
          >
            {option.label}
          </span>
          <span className="text-xs text-stone-500">{option.caption}</span>
        </button>
      ))}
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T | null;
  onChange: (id: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-stone-200 bg-white p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`rounded-md px-3 py-1 text-sm transition-colors ${
            value === option.id
              ? 'bg-stone-100 text-stone-800'
              : 'text-stone-500 hover:text-stone-700'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function AppearanceSection({
  tabs,
  onSelectTabs,
}: {
  /** Desktop shell only: the current Tabs/No tabs layout plus its setter.
   *  The web build is always tab-less — leave onSelectTabs undefined and the
   *  section hides. */
  tabs?: boolean;
  onSelectTabs?: (tabs: boolean) => void;
} = {}) {
  // localStorage-backed, so read only after mount to keep SSR markup stable.
  const [theme, setTheme] = useState<ThemePreference | null>(null);
  const [docStyle, setDocStyle] = useState<DocStyle | null>(null);
  useEffect(() => {
    setTheme(getThemePreference());
    setDocStyle(getDocStylePreference());
  }, []);
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium text-stone-800">Theme</h3>
          <p className="mt-1 text-xs text-stone-500">Theme for this device.</p>
        </div>
        <SegmentedControl
          options={THEME_OPTIONS}
          value={theme}
          onChange={(id) => {
            setTheme(id);
            setThemePreference(id);
          }}
        />
      </section>
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium text-stone-800">Document style</h3>
          <p className="mt-1 text-xs text-stone-500">How markdown documents look in the editor.</p>
        </div>
        <PreviewPicker
          options={DOC_STYLE_OPTIONS}
          value={docStyle}
          onChange={(id) => {
            setDocStyle(id);
            setDocStylePreference(id);
          }}
        />
      </section>
      {onSelectTabs ? (
        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-medium text-stone-800">Tabs</h3>
            <p className="mt-1 text-xs text-stone-500">
              Show open files as tabs across the top, or one surface at a time.
            </p>
          </div>
          <PreviewPicker
            options={TAB_OPTIONS}
            value={tabs ? 'tabs' : 'none'}
            onChange={(id) => onSelectTabs(id === 'tabs')}
          />
        </section>
      ) : null}
    </div>
  );
}
