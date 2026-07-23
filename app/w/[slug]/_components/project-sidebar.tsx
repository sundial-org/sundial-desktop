'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChatTeardropIcon, LightningIcon, PlusIcon } from '@phosphor-icons/react';
import { AnchoredDropdown } from '@/components/workspace/anchored-dropdown';
import type { SidebarSection, SidebarSectionState } from '@/lib/workspace/sidebar-sections';

export type { SidebarSection, SidebarSectionState };

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
  onConnectLocalAgent,
  canStartChat,
  tasksPanel,
  syncPanel,
  footer,
}: {
  /** Rail-top chrome (nav controls + ⌘K search) — the rail owns it (PR #907). */
  header?: ReactNode;
  filesPanel: ReactNode;
  chatRail: ReactNode;
  /** "New chat" row — starts a fresh chat. */
  onNewChat?: () => void;
  /** "Connect local agent" menu item; omitted = the item is hidden. */
  onConnectLocalAgent?: () => void;
  canStartChat?: boolean;
  tasksPanel?: ReactNode;
  syncPanel?: ReactNode;
  footer?: ReactNode;
}) {
  // "＋ New chat" opens a small dropdown when a second action (Connect local
  // agent) exists; with only "New chat" to offer it fires immediately. Caller
  // closes on outside-click / Escape since AnchoredDropdown doesn't.
  const [showNewChatMenu, setShowNewChatMenu] = useState(false);
  const newChatTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!showNewChatMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      // The target can be a Text node (not an Element) — narrow before closest.
      const target = event.target instanceof Node ? event.target : null;
      if (target && newChatTriggerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-floating-action-menu]')) return;
      setShowNewChatMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowNewChatMenu(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showNewChatMenu]);

  const newChatMenuHasChoices = Boolean(onConnectLocalAgent);
  const newChatRow =
    onNewChat && canStartChat ? (
      <>
        <button
          ref={newChatTriggerRef}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (!newChatMenuHasChoices) {
              onNewChat();
              return;
            }
            setShowNewChatMenu((open) => !open);
          }}
          aria-label="New chat"
          {...(newChatMenuHasChoices
            ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': showNewChatMenu }
            : {})}
          data-testid="new-chat-button"
          className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
        >
          <PlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
          <span className="truncate">New chat</span>
        </button>
        <AnchoredDropdown
          open={showNewChatMenu}
          anchorRef={newChatTriggerRef}
          align="left"
          className="w-44 rounded-lg border border-stone-200 bg-white py-1 text-xs shadow-lg"
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setShowNewChatMenu(false);
              onNewChat();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
          >
            <ChatTeardropIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
            New chat
          </button>
          {onConnectLocalAgent ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setShowNewChatMenu(false);
                onConnectLocalAgent();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
            >
              <LightningIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
              Connect local agent
            </button>
          ) : null}
        </AnchoredDropdown>
      </>
    ) : null;

  return (
    // group/rail: rail-hover-only affordances (e.g. the metadata-files eye
    // toggle in the Files header) key off this.
    <div className="group/rail flex min-h-0 flex-1 flex-col">
      {header ? <div className="shrink-0">{header}</div> : null}
      {/* One scroll region: the files tree with the chat list directly under
          it (wireframe: chats sit under the workspace section, not pinned to
          the window bottom). */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col">{filesPanel}</div>
        <div data-testid="sidebar-chats-section" className="pb-2">
          {/* Inset separator — doesn't span edge-to-edge (wireframe). */}
          <div className="mx-4 my-2 border-t border-stone-200" aria-hidden />
          <div className="px-2">
            {chatRail}
            {newChatRow}
          </div>
        </div>
      </div>

      {/* Tasks — scheduled chats (owns its header + body via the page). */}
      {tasksPanel ? (
        <div className="flex max-h-[40%] min-h-9 shrink-0 flex-col border-t border-stone-200">{tasksPanel}</div>
      ) : null}

      {/* §9 — Sync (owns its header + body via the page); present only when a repo is linked. */}
      {syncPanel ? (
        <div className="flex max-h-[45%] min-h-9 shrink-0 flex-col border-t border-stone-200">{syncPanel}</div>
      ) : null}

      {/* §4.2 — pinned profile / settings footer */}
      {footer ? (
        <div className="mt-auto shrink-0 border-t border-stone-200 bg-stone-50 px-3 py-2">{footer}</div>
      ) : null}
    </div>
  );
}
