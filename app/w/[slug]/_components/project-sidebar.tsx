'use client';

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { CalendarDotsIcon, PlusIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { SidebarSectionHeader } from '@/components/workspace/sidebar-section-header';
import type { SidebarSection, SidebarSectionState } from '@/lib/workspace/sidebar-sections';

export type { SidebarSection, SidebarSectionState };

const CHATS_MIN_PX = 112; // 7rem — matches min-h-[7rem]
const CHATS_MAX_RAIL_FRACTION = 0.75;
const CHATS_HEIGHT_KEY = 'sundial:chats-box-height';

/** Clamp a dragged chats-box max-height to [7rem, 75% of the rail]. */
export function clampChatsBoxHeight(px: number, railHeight: number): number {
  return Math.min(Math.max(px, CHATS_MIN_PX), Math.max(CHATS_MIN_PX, railHeight * CHATS_MAX_RAIL_FRACTION));
}

/**
 * The unified project sidebar (desktop wireframe): one scroll region holding
 * the Files/workspace section with the chat list DIRECTLY under it — separated
 * by an inset divider, not pinned to the window bottom. Chat rows are icon +
 * title only and the section has no header; creating a chat happens from the
 * "＋ New chat" row at the bottom of the list. Tasks/Sync (own headers) and
 * the profile footer stack below the scroll region.
 */
export function ProjectSidebar({
  header,
  filesPanel,
  chatRail,
  onNewChat,
  canStartChat,
  onOpenSchedules,
  onNewSchedule,
  chatsCollapsed,
  onToggleChats,
  assistants,
  syncPanel,
  support,
  openWith,
  footer,
}: {
  /** Rail-top chrome (nav controls + ⌘K search) — the rail owns it (PR #907). */
  header?: ReactNode;
  filesPanel: ReactNode;
  chatRail: ReactNode;
  /** Starts a fresh chat — fired by the Chats header ＋ and the list's
   *  "New chat" row. (External handoff lives in the unified Open with… flow.) */
  onNewChat?: () => void;
  canStartChat?: boolean;
  /** Opens the Schedules panel (list) — the calendar icon left of the Chats
   *  header ＋. It used to sit in the rail's top nav row, where it crowded
   *  the Docs-style header; schedules belong with chats. */
  onOpenSchedules?: () => void;
  /** Opens the Schedules panel with its create form — the "＋ New schedule"
   *  action row directly under "＋ New chat". Omitted → no row. */
  onNewSchedule?: () => void;
  /** Chats section collapse bit (sidebarSections) — collapsed leaves only the
   *  header row, so the list never disappears entirely. */
  chatsCollapsed?: boolean;
  onToggleChats?: () => void;
  /** Assistants entry (flag-gated), docked directly above the chats box. */
  assistants?: ReactNode;
  syncPanel?: ReactNode;
  /** Account-level support entry, docked immediately above Open with. */
  support?: ReactNode;
  /** The "Open with …" row — docked above the footer so it never overlays
   *  chats or any other component. */
  openWith?: ReactNode;
  footer?: ReactNode;
}) {
  // Dragged height for the chats box (px); null = hug the content up to the
  // default 45% cap. A dragged value is a REAL height, not a cap: capping
  // alone did nothing visible for the common case of a short chat list — the
  // box kept hugging its content and the divider ignored the pointer.
  // Loaded in an effect (not the initializer) so SSR/client markup match.
  const [chatsHeightPx, setChatsHeightPx] = useState<number | null>(null);
  const chatsRef = useRef<HTMLDivElement | null>(null);
  const chatsDragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    railHeight: number;
  } | null>(null);
  useEffect(() => {
    const stored = Number(window.localStorage.getItem(CHATS_HEIGHT_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      // Keep the RAW saved height — the rendered min(px, 75%) clamps live,
      // so mounting in a short window must not shrink the stored preference
      // (enlarging the window later restores it).
      setChatsHeightPx(Math.max(stored, CHATS_MIN_PX));
    }
    return () => {
      // Unmounted mid-drag: pointerup never reaches us; don't leak body styles.
      if (!chatsDragRef.current) return;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const startChatsDrag = (event: PointerEvent<HTMLDivElement>) => {
    const section = chatsRef.current;
    if (!section) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    chatsDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: section.getBoundingClientRect().height,
      railHeight: section.parentElement?.clientHeight ?? Number.POSITIVE_INFINITY,
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };
  const moveChatsDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = chatsDragRef.current;
    const section = chatsRef.current;
    if (!drag || !section) return;
    // Mutate the height directly so the divider tracks the pointer even when
    // the list is shorter than the box; React state stays untouched until
    // release. maxHeight goes with it — the default 45% cap must not clip a
    // box the user just dragged taller.
    const next = clampChatsBoxHeight(drag.startHeight + (drag.startY - event.clientY), drag.railHeight);
    section.style.height = `${next}px`;
    section.style.maxHeight = 'none';
  };
  const endChatsDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = chatsDragRef.current;
    if (!drag) return;
    chatsDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    } catch {}
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const px = parseFloat(chatsRef.current?.style.height ?? '');
    if (!Number.isFinite(px)) return; // pointer never moved and no prior drag
    // Restore the responsive min() form NOW: if px equals the current state,
    // React bails out of the set and the drag's raw-px style would otherwise
    // stick, breaking window-shrink re-clamping until the next real change.
    if (chatsRef.current) {
      chatsRef.current.style.height = `min(${px}px, ${CHATS_MAX_RAIL_FRACTION * 100}%)`;
      chatsRef.current.style.maxHeight = '';
    }
    setChatsHeightPx(px);
    try {
      window.localStorage.setItem(CHATS_HEIGHT_KEY, String(Math.round(px)));
    } catch {}
  };
  const resetChatsHeight = () => {
    // Drop the inline styles the drag wrote — React only owns them while
    // chatsHeightPx is set, so a bare state reset would leave them stuck.
    if (chatsRef.current) {
      chatsRef.current.style.height = '';
      chatsRef.current.style.maxHeight = '';
    }
    setChatsHeightPx(null);
    try {
      window.localStorage.removeItem(CHATS_HEIGHT_KEY);
    } catch {}
  };

  const newChatRow =
    onNewChat && canStartChat ? (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onNewChat();
        }}
        aria-label="New chat"
        data-testid="new-chat-button"
        className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
      >
        <PlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
        <span className="truncate">New chat</span>
      </button>
    ) : null;

  // NOT a chat row — a sibling action mirroring "＋ New chat" directly above.
  const newScheduleRow = onNewSchedule ? (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onNewSchedule();
      }}
      aria-label="New schedule"
      data-testid="new-schedule-button"
      className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
    >
      <PlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
      <span className="truncate">New schedule</span>
    </button>
  ) : null;

  return (
    // group/rail: rail-hover-only affordances (e.g. the metadata-files eye
    // toggle in the Files header) key off this.
    <div className="group/rail flex min-h-0 flex-1 flex-col">
      {header ? <div className="shrink-0">{header}</div> : null}
      {/* Files own the elastic scroll region… min-h-full stretches the panel's
          flex-1 tree over the whole visible region, so right-click (and drop)
          in the empty space below the rows still lands on the tree. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col">{filesPanel}</div>
      </div>

      {/* Assistants (flag-gated) sit directly above the chats box: the
          assistant serves the agent conversation, so its section lives with
          it. Full-bleed: the section brings its own header, like Chats. */}
      {assistants ? (
        <div data-testid="assistants-slot" className="max-h-[45%] shrink-0 overflow-y-auto border-t border-stone-200 empty:hidden">
          {assistants}
        </div>
      ) : null}

      {/* …and chats keep their OWN bounded box at the rail's bottom, scrolling
          internally. They used to share the files scroll region, which meant a
          project with more than a screenful of files pushed the chat list off
          the bottom entirely — the whole reason the rail exists. Collapsed it
          is just the header row, so chats are always at least one click away. */}
      <div
        ref={chatsRef}
        data-testid="sidebar-chats-section"
        className={`relative flex shrink-0 flex-col border-t border-stone-200 ${chatsCollapsed ? '' : chatsHeightPx === null ? 'max-h-[45%] min-h-[7rem]' : 'min-h-[7rem]'}`}
        // CSS min(): shrinking the window re-clamps a tall saved height to the
        // rail fraction WITHOUT touching the stored preference, so growing
        // the window back restores it. Keep the % in sync with the drag clamp.
        style={
          !chatsCollapsed && chatsHeightPx !== null
            ? { height: `min(${chatsHeightPx}px, ${CHATS_MAX_RAIL_FRACTION * 100}%)` }
            : undefined
        }
      >
        {/* Top border doubles as a drag handle (resize-handle.tsx pattern):
            drag adjusts the preferred cap, double-click resets to default. */}
        {chatsCollapsed ? null : (
          <div
            onPointerDown={startChatsDrag}
            onPointerMove={moveChatsDrag}
            onPointerUp={endChatsDrag}
            onPointerCancel={endChatsDrag}
            onLostPointerCapture={endChatsDrag}
            onDoubleClick={resetChatsHeight}
            role="separator"
            aria-orientation="horizontal"
            className="group absolute inset-x-0 top-[-4px] z-30 h-2 cursor-row-resize touch-none"
          >
            <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-transparent transition-colors duration-150 group-hover:bg-stone-300 group-active:bg-stone-400" />
          </div>
        )}
        <SidebarSectionHeader
          label="Chats"
          collapsed={chatsCollapsed}
          onToggleCollapsed={onToggleChats}
          actions={
            <>
              {onOpenSchedules ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSchedules();
                  }}
                  aria-label="Schedules"
                  data-testid="chats-header-schedules"
                  className="relative group/tip flex h-7 w-7 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-200/50 hover:text-stone-600"
                >
                  <CalendarDotsIcon className="h-4 w-4" weight="regular" aria-hidden />
                  <IconTooltip label="Schedules" />
                </button>
              ) : null}
              {/* No header ＋ here: the "＋ New chat" row at the bottom of the
                  list is the single new-chat affordance (it was duplicated). */}
            </>
          }
        />
        {chatsCollapsed ? null : (
          // No flex-1: the box hugs its content below the cap; min-h-0 lets
          // this region shrink and scroll once the cap bites.
          <div className="min-h-0 overflow-y-auto px-2 pb-2">
            {chatRail}
            {newChatRow}
            {newScheduleRow}
          </div>
        )}
      </div>

      {/* §9 — Sync (owns its header + body via the page); present only when a repo is linked. */}
      {syncPanel ? (
        <div className="flex max-h-[45%] min-h-9 shrink-0 flex-col border-t border-stone-200">{syncPanel}</div>
      ) : null}

      {support ? (
        <div data-testid="support-slot" className="shrink-0 border-t border-stone-200 px-2 py-2 empty:hidden">
          {support}
        </div>
      ) : null}

      {/* "Open with …" sits in-flow above the footer — pinned to the rail's
          bottom-left without covering chats or the footer (the slot the
          onboarding checklist held before it moved to Settings). */}
      {openWith ? (
        <div data-testid="open-with-slot" className="shrink-0 border-t border-stone-200 px-2 py-2 empty:hidden">
          {openWith}
        </div>
      ) : null}

      {/* §4.2 — pinned profile / settings footer */}
      {footer ? (
        <div className="mt-auto shrink-0 border-t border-stone-200 bg-stone-50 px-3 py-2">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
