'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { HouseIcon, MagnifyingGlassIcon, SidebarSimpleIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';

/**
 * Home + sidebar toggle. Live in the rail's top row while it's open, and at
 * the left end of the single top bar while it's collapsed — one bar total.
 * Deliberately short: with the rail collapsed this cluster floats over the
 * document's own header, and every icon there reads as chrome bolted onto the
 * page (founder, twice) — the Docs/IDE switch and the schedules calendar both
 * left for menus (View / ⋮ / Appearance, Chats header). `minimal` cuts it to
 * the sidebar toggle alone — the Docs style's collapsed-rail float, where
 * even Home was one icon too many; Home rides the rail it reveals.
 * (Extracted from page.tsx so /test/sidepanel renders the real thing.)
 */
export function ShellNavControls({
  homeHref,
  onNavigateHome,
  sidebarOpen,
  onToggleSidebar,
  minimal = false,
  homeOnly = false,
}: {
  homeHref: string;
  onNavigateHome?: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  minimal?: boolean;
  /** Embedded panel: Home is the ONE piece of shell nav that survives (top
   *  corner, founder 2026-08-26); the sidebar toggle stays with the bottom
   *  switcher's Files surface. */
  homeOnly?: boolean;
}) {
  return (
    <>
      {minimal ? null : (
        <Link
          href={homeHref}
          onClick={onNavigateHome}
          aria-label="Home"
          data-testid="topbar-home"
          // ml-1.5: founder-requested ~6px nudge right, in both the rail top
          // row and the collapsed-rail bar (additive to the traffic-light pad).
          className="relative group/tip ml-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600"
        >
          <HouseIcon className="h-5 w-5" weight="regular" aria-hidden />
          <IconTooltip label="Home" />
        </Link>
      )}
      {homeOnly ? null : (
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-pressed={sidebarOpen}
        aria-label="Toggle sidebar"
        data-testid="topbar-sidebar-toggle"
        className={`relative group/tip inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-stone-100 ${
          minimal ? 'ml-1.5 ' : ''
        }${sidebarOpen ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'}`}
      >
        <SidebarSimpleIcon className="h-5 w-5" weight={sidebarOpen ? 'fill' : 'regular'} aria-hidden />
        <IconTooltip label="Sidebar" />
      </button>
      )}
    </>
  );
}

/**
 * The rail's top chrome: nav row (clears the macOS traffic lights in the
 * desktop shell) with the ⌘K search bar below.
 */
export function SidebarTopChrome({
  navControls,
  onOpenSearch,
  desktopPad = false,
}: {
  navControls: ReactNode;
  onOpenSearch: () => void;
  /** Desktop shell: traffic-light clearance + window-drag region. */
  desktopPad?: boolean;
}) {
  return (
    <div className="border-b border-stone-200">
      <div
        className={`flex h-11 min-w-0 items-center gap-1.5 px-3 ${desktopPad ? 'pl-[calc(72px/var(--sd-zoom,1))]' : ''}`}
        {...(desktopPad ? { 'data-tauri-drag-region': '' } : {})}
      >
        {navControls}
      </div>
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={onOpenSearch}
          data-testid="sidebar-search-bar"
          className="group flex w-full items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-left text-xs text-stone-400 shadow-[0_1px_2px_rgba(28,25,23,0.04)] transition-colors hover:border-stone-300 hover:text-stone-500"
        >
          <MagnifyingGlassIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Search</span>
          {/* The shortcut hint only surfaces on approach — quieter at rest. */}
          <kbd className="rounded border border-stone-200 bg-stone-50 px-1 py-px font-sans text-[10px] text-stone-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            ⌘K
          </kbd>
        </button>
      </div>
    </div>
  );
}
