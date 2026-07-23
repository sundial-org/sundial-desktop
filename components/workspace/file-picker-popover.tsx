'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { FileTextIcon } from '@phosphor-icons/react';

export type FilePickerItem = {
  path: string;
  secondary?: string | null;
};

export function fileMatches(paths: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return paths.filter((path) => {
    if (!q) return true;
    const basename = path.split('/').pop()?.toLowerCase() ?? path.toLowerCase();
    return path.toLowerCase().includes(q) || basename.includes(q);
  });
}

export function rankFilePaths(
  paths: string[],
  query: string,
  updatedAtByPath: Map<string, string | null>,
): string[] {
  const q = query.trim().toLowerCase();
  const matched = fileMatches(paths, query);
  if (!q) {
    return [...matched].sort((a, b) => {
      const ta = updatedAtByPath.get(a) ?? '';
      const tb = updatedAtByPath.get(b) ?? '';
      return tb.localeCompare(ta);
    });
  }
  const score = (path: string): number => {
    const base = path.split('/').pop() ?? path;
    const lower = path.toLowerCase();
    const baseLower = base.toLowerCase();
    if (baseLower.startsWith(q)) return 0;
    if (baseLower.includes(q)) return 1;
    if (lower.includes(q)) return 2;
    return 3;
  };
  return [...matched].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sa - sb;
    const ta = updatedAtByPath.get(a) ?? '';
    const tb = updatedAtByPath.get(b) ?? '';
    return tb.localeCompare(ta);
  });
}

export function formatRelativeUpdatedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return null;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

type FilePickerPopoverProps = {
  items: FilePickerItem[];
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  onPick: (item: FilePickerItem) => void;
  position: { left: number; top: number };
  header?: ReactNode;
  emptyLabel?: string;
  className?: string;
  /** `fixed` uses viewport coords; `inline` fills an absolute parent. */
  positionMode?: 'fixed' | 'inline';
};

export function FilePickerPopover({
  items,
  highlightedIndex,
  onHighlight,
  onPick,
  position,
  header,
  emptyLabel = 'No matches',
  className = '',
  positionMode = 'fixed',
}: FilePickerPopoverProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) return;
    const itemTop = active.offsetTop;
    const itemBottom = itemTop + active.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (itemTop < viewTop) {
      container.scrollTop = itemTop;
    } else if (itemBottom > viewBottom) {
      container.scrollTop = itemBottom - container.clientHeight;
    }
  }, [highlightedIndex, items.length]);

  const positionClass = positionMode === 'fixed' ? 'fixed z-50' : 'absolute bottom-full left-0 z-50 mb-1 w-full';
  const positionStyle =
    positionMode === 'fixed'
      ? {
          left: Math.min(
            position.left,
            typeof window !== 'undefined' ? window.innerWidth - 336 : position.left,
          ),
          top: position.top,
        }
      : undefined;

  return (
    <div
      role="listbox"
      className={`${positionClass} max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-[#dadce0] bg-white p-1.5 shadow-[0_1px_2px_rgba(60,64,67,0.3),0_2px_6px_2px_rgba(60,64,67,0.15)] ${positionMode === 'inline' ? '' : 'w-80'} ${className}`}
      style={positionStyle}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('button')) return;
        event.preventDefault();
      }}
    >
      {header ? (
        <div className="px-3 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-[#5f6368]">
          {header}
        </div>
      ) : null}
      <div
        ref={listRef}
        className="max-h-[260px] overflow-y-auto overscroll-contain"
      >
        {items.length === 0 ? (
          <div className="px-3 py-2 text-[13px] text-[#5f6368]">{emptyLabel}</div>
        ) : (
          items.map((item, index) => {
            const active = index === highlightedIndex;
            const primary = item.path.split('/').pop() ?? item.path;
            return (
              <button
                key={item.path}
                type="button"
                role="option"
                aria-selected={active}
                className={[
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  active ? 'bg-[#f1f3f4] text-[#202124]' : 'text-[#202124] hover:bg-[#f1f3f4]',
                ].join(' ')}
                onMouseEnter={() => onHighlight(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onPick(item);
                }}
              >
                <FileTextIcon className="h-4 w-4 shrink-0 text-[#5f6368]" weight="regular" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{primary}</span>
                {item.secondary ? (
                  <span className="min-w-0 shrink truncate text-[11px] text-[#5f6368]">
                    {item.secondary}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
