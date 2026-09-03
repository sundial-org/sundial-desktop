'use client';

import { useState, type ComponentType } from 'react';
import {
  BookOpenIcon,
  BooksIcon,
  CaretDownIcon,
  FolderSimpleIcon,
  GraduationCapIcon,
  MagnifyingGlassIcon,
  NotebookIcon,
  PenNibIcon,
  TreeStructureIcon,
  type IconProps,
} from '@phosphor-icons/react';

import { productFlavor } from '@/lib/flags/product-flavor';
import { starterPacksForFlavor, type StarterPack } from '@/lib/local/starter-packs';

/**
 * The starter-pack cards, shared by the desktop home (app/local) and the web
 * dashboard (app/dashboard). Both scaffold the same packs through different
 * transports — files on disk via the sidecar, rows via /api/workspace — but the
 * grid itself is presentation, and keeping two copies drifted three times: the
 * icon map, the arrival file, and the expanded-by-default state each landed on
 * one surface only. Callers supply just their own creation call.
 *
 * The listing is flavor-gated: a general build (desktop/OSS) drops the
 * scientific packs rather than opening on LaTeX and papers.
 */
const PACKS = starterPacksForFlavor(productFlavor());

const PACK_ICONS: Record<string, ComponentType<IconProps>> = {
  'research-paper': GraduationCapIcon,
  'lit-review': BooksIcon,
  writing: PenNibIcon,
  notes: NotebookIcon,
  'knowledge-base': TreeStructureIcon,
  book: BookOpenIcon,
};

/**
 * Expansion policy for the template grid, shared by both homes. The grid is open
 * by default — the packs are the fastest way into a real project — and a manual
 * collapse wins for the rest of the session. `open()` force-expands (desktop
 * onboarding steers the user here). Keeping the default in one place stops the
 * two homes drifting apart, which is exactly what happened before.
 */
export function useTemplatesExpanded() {
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? true;
  return {
    expanded,
    toggle: () => setOverride(!expanded),
    open: () => setOverride(true),
  } as const;
}

/**
 * The "Start from a template" toggle that opens the grid above. Shared for the
 * same reason as the grid: the button markup was copied onto both homes and had
 * already drifted (icon tint, self-start) before this was extracted. Each
 * surface owns only its expansion state and testId.
 */
export function TemplatesToggle({
  expanded,
  onToggle,
  disabled = false,
  testId,
}: {
  expanded: boolean;
  onToggle: () => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      disabled={disabled}
      className="flex items-center gap-1.5 self-start text-sm font-medium text-stone-700 hover:text-stone-900 disabled:opacity-50"
      data-testid={testId}
    >
      <NotebookIcon className="h-4 w-4" aria-hidden />
      Start from a template
      <CaretDownIcon
        className={`h-3 w-3 text-stone-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
        aria-hidden
      />
    </button>
  );
}

export function StarterPackGrid({
  disabled = false,
  onSelect,
}: {
  disabled?: boolean;
  onSelect: (pack: StarterPack) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {PACKS.map((pack) => {
        const Icon = PACK_ICONS[pack.id] ?? FolderSimpleIcon;
        return (
          <button
            key={pack.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(pack)}
            className="group flex flex-col items-start gap-1.5 rounded-xl border border-stone-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-stone-300 hover:bg-stone-100/60 disabled:opacity-50"
            data-testid={`starter-pack-${pack.id}`}
          >
            <span className="flex items-center gap-2">
              <Icon className="h-4.5 w-4.5 text-stone-500" weight="duotone" aria-hidden />
              <span className="text-sm font-medium text-stone-800">{pack.title}</span>
            </span>
            <span className="text-xs text-stone-500">{pack.tagline}</span>
          </button>
        );
      })}
    </div>
  );
}
