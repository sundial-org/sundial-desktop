'use client';

import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { XIcon } from '@phosphor-icons/react';
import {
  EDITOR_TAB_MIME,
  parseTabDragPayload,
  type TabDragPayload,
} from '@/lib/workspace/editor-panes';

interface EditorTabStripProps {
  paneId: string;
  tabs: string[];
  activePath: string;
  /** Rendered after the tabs — the ＋ new-tab launcher slot. */
  trailing?: ReactNode;
  /** Extra classes on the strip container (e.g. `min-w-0 flex-1` when the
   *  strip shares the single top-bar row with the shell controls). */
  className?: string;
  /** Desktop shell: empty strip area drags the window (data-tauri-drag-region). */
  dragRegion?: boolean;
  formatLabel: (path: string) => string;
  onActivate: (path: string) => void;
  onCloseTab: (path: string) => void;
  /** A tab (possibly from another pane) dropped at `index` in this strip. */
  onDropTab: (payload: TabDragPayload, index: number) => void;
  /** Mirrors native dragstart/dragend so the page can arm the split overlays. */
  onTabDragChange: (dragging: boolean) => void;
  /** Controlled inline rename (double-click): which tab is being renamed,
   *  the draft value, and the shared begin/change/commit/cancel handlers —
   *  the page owns the state so tab renames share the header/tree pipeline
   *  (sanitize, extension rules, unique paths). */
  renamingPath?: string | null;
  renameValue?: string;
  onBeginRename?: (path: string) => void;
  onRenameValueChange?: (value: string) => void;
  onCommitRename?: () => void;
  onCancelRename?: () => void;
}

const isTabDrag = (event: DragEvent) => event.dataTransfer.types.includes(EDITOR_TAB_MIME);

/**
 * One pane's tab row. Tabs drag with a custom mime type; the strip itself is a
 * drop target (reorder / adopt from another pane) and shows a slim indigo
 * insertion bar at the prospective index while a tab hovers.
 */
export function EditorTabStrip({
  paneId,
  tabs,
  activePath,
  trailing,
  className,
  dragRegion,
  formatLabel,
  onActivate,
  onCloseTab,
  onDropTab,
  onTabDragChange,
  renamingPath,
  renameValue,
  onBeginRename,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
}: EditorTabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  // Left offset (px, strip-content coords) of the insertion bar, or null.
  const [dropLeft, setDropLeft] = useState<number | null>(null);

  // Insertion index + indicator position from pointer x against the rendered
  // tab midpoints. Computed at event time (never during render).
  const dropTargetFromPointer = (event: DragEvent): { index: number; left: number } => {
    const strip = stripRef.current;
    if (!strip) return { index: tabs.length, left: 4 };
    const stripRect = strip.getBoundingClientRect();
    const items = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-index]'));
    const toLeft = (x: number) => x - stripRect.left + strip.scrollLeft - 1;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) {
        return { index: Number(item.dataset.tabIndex), left: toLeft(rect.left) };
      }
    }
    const last = items[items.length - 1];
    return { index: tabs.length, left: last ? toLeft(last.getBoundingClientRect().right) : 4 };
  };

  return (
    <div
      ref={stripRef}
      data-testid="editor-tab-strip"
      data-pane-id={paneId}
      // The bottom hairline is an INSET shadow, not a border: it paints under
      // the tabs, so the active tab's page-colored background breaks the line
      // and fuses with the editor surface below (VS Code/Obsidian style).
      className={`relative flex h-11 shrink-0 items-end gap-0.5 overflow-x-auto bg-stone-100/70 px-1.5 pt-1.5 shadow-[inset_0_-1px_0_0_rgba(231,229,228,0.6)] [scrollbar-width:none] print:hidden ${className ?? ''}`}
      {...(dragRegion ? { 'data-tauri-drag-region': '' } : {})}
      onDragOver={(event) => {
        if (!isTabDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setDropLeft(dropTargetFromPointer(event).left);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDropLeft(null);
      }}
      onDrop={(event) => {
        if (!isTabDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setDropLeft(null);
        const payload = parseTabDragPayload(event.dataTransfer.getData(EDITOR_TAB_MIME));
        if (payload) onDropTab(payload, dropTargetFromPointer(event).index);
      }}
    >
      {tabs.map((path, index) => {
        const active = path === activePath;
        return (
          <div
            key={path}
            data-tab-index={index}
            data-testid="editor-tab"
            data-active={active || undefined}
            draggable={renamingPath !== path}
            onDragStart={(event) => {
              // ONLY the namespaced mime — a text/plain path here would make
              // the file tree's drop fallback treat a tab drag as a file MOVE.
              event.dataTransfer.setData(
                EDITOR_TAB_MIME,
                JSON.stringify({ paneId, path } satisfies TabDragPayload),
              );
              event.dataTransfer.effectAllowed = 'move';
              onTabDragChange(true);
            }}
            onDragEnd={() => onTabDragChange(false)}
            onClick={() => onActivate(path)}
            onDoubleClick={() => onBeginRename?.(path)}
            onAuxClick={(event) => {
              if (event.button === 1) onCloseTab(path);
            }}
            title={path}
            className={`group/tab flex min-w-0 max-w-[200px] cursor-pointer select-none items-center gap-1 rounded-t-md border border-b-0 px-2.5 py-1.5 text-[13px] ${
              active
                ? 'border-stone-200 bg-white text-stone-800'
                : 'border-stone-200/50 text-stone-500 hover:bg-stone-200/60 hover:text-stone-700'
            }`}
          >
            {renamingPath === path ? (
              // Seamless inline rename: transparent, same type size, nothing
              // moves — matches the file-tree/chat rename fields.
              <input
                autoFocus
                value={renameValue ?? ''}
                aria-label="Rename file"
                onChange={(event) => onRenameValueChange?.(event.target.value)}
                onBlur={() => onCommitRename?.()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onCommitRename?.();
                  } else if (event.key === 'Escape') {
                    onCancelRename?.();
                  }
                }}
                onClick={(event) => event.stopPropagation()}
                className="min-w-0 bg-transparent text-[13px] text-stone-800 outline-none"
                style={{ width: `${Math.max((renameValue ?? '').length, 4)}ch` }}
              />
            ) : (
              <span className="truncate">{formatLabel(path)}</span>
            )}
            <button
              type="button"
              aria-label={`Close ${formatLabel(path)}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(path);
              }}
              // Wireframe: the close × is hover-revealed on every tab, the
              // active one included (keyboard focus reveals it too).
              className="-mr-1 shrink-0 rounded p-0.5 text-stone-400 opacity-0 hover:bg-stone-300/60 hover:text-stone-700 focus-visible:opacity-100 group-hover/tab:opacity-100"
            >
              <XIcon className="h-3 w-3" weight="bold" aria-hidden />
            </button>
          </div>
        );
      })}
      {trailing}
      {dropLeft !== null ? (
        <div
          data-testid="tab-insertion-bar"
          className="pointer-events-none absolute bottom-0 top-1.5 w-0.5 rounded-full bg-orange-500"
          style={{ left: dropLeft }}
        />
      ) : null}
    </div>
  );
}
