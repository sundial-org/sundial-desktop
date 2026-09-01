'use client';

import type { KeyboardEvent, ReactNode } from 'react';

/**
 * Shared header row for the stacked project-sidebar sections (Files / Chats /
 * Tasks / Sync) so they all look identical: the section label on the left,
 * the section's actions on the right. Pass `onToggleCollapsed` to make the
 * header a minimize/maximize toggle for the section body — the whole row
 * (background included) toggles; the actions cluster and any interactive
 * parts of a rich label opt out via stopPropagation. No caret glyph — flat.
 */
export function SidebarSectionHeader({
  label,
  actions,
  collapsed,
  onToggleCollapsed,
}: {
  /** Section label — a plain string, or a rich node (e.g. the Files section's
   *  workspace identity), which styles itself. */
  label: ReactNode;
  actions?: ReactNode;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const labelEl =
    typeof label === 'string' ? (
      <span className="min-w-0 truncate text-[12px] font-semibold text-stone-500">{label}</span>
    ) : (
      label
    );

  // Rich labels have no inner toggle button, so the ROW carries the button
  // semantics: focusable, aria-expanded, Enter/Space. The target guard keeps
  // keys inside inner controls (rename input, breadcrumb Back) from toggling.
  const richToggle = Boolean(onToggleCollapsed) && typeof label !== 'string';

  return (
    <div
      // Toggleable headers hover as ONE full-bleed row (founder: the same
      // very subtle wash for Files and Chats, no inset padding box).
      className={`flex h-9 shrink-0 items-center gap-1.5 px-3 ${
        onToggleCollapsed ? 'cursor-pointer transition-colors hover:bg-stone-100/60' : ''
      }`}
      onClick={onToggleCollapsed}
      {...(richToggle
        ? {
            role: 'button' as const,
            tabIndex: 0,
            // Explicit name: without it the row's accessible name is its
            // concatenated contents (identity text + every action's label),
            // which is soup for screen readers and collides with the inner
            // buttons' names in role queries.
            'aria-label': collapsed ? 'Expand section' : 'Collapse section',
            'aria-expanded': !collapsed,
            onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggleCollapsed?.();
              }
            },
          }
        : {})}
    >
      {onToggleCollapsed && typeof label === 'string' ? (
        // String labels keep a real button: keyboard toggle + aria-expanded.
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed();
          }}
          aria-expanded={!collapsed}
          data-testid={`sidebar-section-toggle-${label.toLowerCase()}`}
          // No hover box of its own — the row carries the highlight.
          className="flex min-w-0 flex-1 items-center gap-1 px-1 text-left"
        >
          {labelEl}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{labelEl}</div>
      )}
      {actions ? (
        <div
          className="flex shrink-0 items-center gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
