'use client';

import type { PanelSurface } from '@/lib/workspace/panel-control';

/** What the switcher can target: the steerable surfaces, plus the local-only
 *  Review destination that replaced the right dock in the panel layout
 *  (agents cannot steer to it; /g/show validates against PANEL_SURFACES
 *  alone). Home is a top-corner button, not a surface. */
export type PanelNavTarget = PanelSurface | 'review';

/**
 * The embedded panel's surface switcher (?view=panel only): one floating
 * segmented pill that SWITCHES the single surface — files / doc / chat, plus
 * source / split / pdf when the open file is LaTeX. Nothing here adds a
 * pane: the panel's contract is one surface at a time, because the human is
 * lending the agent half a screen.
 */
export function PanelSurfaceSwitcher({
  surfaces,
  active,
  onSelect,
}: {
  surfaces: Array<{ id: PanelNavTarget; label: string }>;
  active: PanelNavTarget;
  onSelect: (surface: PanelNavTarget) => void;
}) {
  if (surfaces.length < 2) return null;
  return (
    <div
      data-testid="panel-surface-switcher"
      className="pointer-events-auto fixed bottom-3 left-1/2 z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-stone-200 bg-white p-1 shadow-lg"
    >
      {surfaces.map((surface) => (
        <button
          key={surface.id}
          type="button"
          data-testid={`panel-surface-${surface.id}`}
          aria-pressed={surface.id === active}
          onClick={() => onSelect(surface.id)}
          className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
            surface.id === active
              ? 'bg-stone-900 text-white'
              : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
          }`}
        >
          {surface.label}
        </button>
      ))}
    </div>
  );
}
