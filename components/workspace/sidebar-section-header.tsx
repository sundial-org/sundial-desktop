'use client';

import type { ReactNode } from 'react';
import { CaretRightIcon } from '@phosphor-icons/react';

/**
 * Shared header row for the stacked project-sidebar sections (Files / Chats /
 * Tasks / Sync) so they all look identical: the section label on the left,
 * the section's actions on the right. Pass `onToggleCollapsed` to make the
 * label a minimize/maximize toggle for the section body.
 */
export function SidebarSectionHeader({
  label,
  actions,
  collapsed,
  onToggleCollapsed,
}: {
  /** Section label — a plain string, or a rich node (e.g. the Files section's
   *  workspace name + switcher), which styles itself. */
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

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 px-3">
      {onToggleCollapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          data-testid={
            typeof label === 'string' ? `sidebar-section-toggle-${label.toLowerCase()}` : undefined
          }
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-stone-100"
        >
          <CaretRightIcon
            className={`h-3 w-3 flex-shrink-0 text-stone-400 transition-transform ${collapsed ? '' : 'rotate-90'}`}
            weight="bold"
            aria-hidden
          />
          {labelEl}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{labelEl}</div>
      )}
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}
