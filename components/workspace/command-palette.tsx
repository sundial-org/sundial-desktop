'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatTeardropIcon, FileTextIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { rankActions, rankChats, rankFiles, type PaletteChatSpec } from '@/lib/workspace/command-palette';

export type CommandPaletteAction = {
  id: string;
  label: string;
  /** Extra match-only terms (e.g. "zip export"); never displayed. */
  keywords?: string;
  /** Pre-formatted keyboard hint (e.g. '⌘⇧J') shown right-aligned. */
  shortcut?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** All workspace file paths (non-folders), in tree order. */
  files: string[];
  /** Open / recently used paths shown first on an empty query. */
  priorityFiles?: string[];
  onOpenFile: (path: string) => void;
  /** Workspace chats in rail order (archived ones are filtered out here). */
  chats?: PaletteChatSpec[];
  onOpenChat?: (chatId: string) => void;
  actions: CommandPaletteAction[];
  /** ⌘T reuses the palette as its "what goes in this tab?" chooser. */
  placeholder?: string;
};

type Row =
  | { kind: 'file'; key: string; path: string }
  | { kind: 'chat'; key: string; chat: PaletteChatSpec }
  | { kind: 'action'; key: string; action: CommandPaletteAction };

const SECTION_LABELS: Record<Row['kind'], string> = { file: 'Files', chat: 'Chats', action: 'Actions' };

/**
 * The ⌘K command palette: one input, Files then Chats then Actions, ↑/↓ +
 * Enter to run, Esc to close. Ranking lives in lib/workspace/command-palette
 * (pure, tested); this component only renders and routes the choice.
 */
export function CommandPalette({
  open,
  onClose,
  files,
  priorityFiles,
  onOpenFile,
  chats,
  onOpenChat,
  actions,
  placeholder = 'Search files, chats, and actions…',
}: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Scrolling the list replays a mousemove at the *unchanged* cursor position,
  // so hover only claims the selection once the pointer has really moved.
  const pointer = useRef<{ x: number; y: number } | null>(null);

  const rows = useMemo<Row[]>(() => {
    const fileRows = rankFiles(query, files, priorityFiles).map<Row>((path) => ({
      kind: 'file',
      key: `file:${path}`,
      path,
    }));
    const chatRows = rankChats(query, chats ?? []).map<Row>((chat) => ({
      kind: 'chat',
      key: `chat:${chat.id}`,
      chat,
    }));
    const actionRows = rankActions(query, actions).map<Row>((action) => ({
      kind: 'action',
      key: `action:${action.id}`,
      action,
    }));
    return [...fileRows, ...chatRows, ...actionRows];
  }, [actions, chats, files, priorityFiles, query]);

  // Fresh session per open: empty query, first row, focused input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    pointer.current = null;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => setSelectedIndex(0), [query]);
  const selected = Math.min(selectedIndex, Math.max(rows.length - 1, 0));

  const runRow = (row: Row) => {
    onClose();
    if (row.kind === 'file') onOpenFile(row.path);
    else if (row.kind === 'chat') onOpenChat?.(row.chat.id);
    else row.action.run();
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="Command palette"
      lockBodyScroll={false}
      overlayClassName="fixed inset-0 z-[70] flex justify-center bg-black/20 p-4 pt-[14vh]"
      panelClassName="h-fit w-full max-w-xl overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_8px_30px_rgba(28,25,23,0.14)]"
    >
      <div data-testid="command-palette">
        <div className="flex items-center gap-2 border-b border-stone-100 px-3">
          <MagnifyingGlassIcon className="h-4 w-4 flex-shrink-0 text-stone-400" weight="regular" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (rows.length === 0) return;
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                setSelectedIndex((selected + delta + rows.length) % rows.length);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const row = rows[selected];
                if (row) runRow(row);
              }
            }}
            placeholder={placeholder}
            aria-label="Search files, chats, and actions"
            data-testid="command-palette-input"
            className="w-full bg-transparent py-3 text-sm text-stone-800 outline-none placeholder:text-stone-400"
          />
        </div>
        <div className="max-h-[min(20rem,50vh)] overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-stone-400">No matches</div>
          ) : (
            rows.map((row, index) => (
              <div key={row.key}>
                {index === 0 || rows[index - 1]!.kind !== row.kind ? (
                  <SectionLabel>{SECTION_LABELS[row.kind]}</SectionLabel>
                ) : null}
                <button
                  type="button"
                  data-testid={`palette-${row.kind}`}
                  ref={index === selected ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : undefined}
                  onMouseMove={(event) => {
                    const moved =
                      pointer.current &&
                      (pointer.current.x !== event.clientX || pointer.current.y !== event.clientY);
                    pointer.current = { x: event.clientX, y: event.clientY };
                    if (moved) setSelectedIndex(index);
                  }}
                  onClick={() => runRow(row)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-stone-700 ${
                    index === selected ? 'bg-stone-100' : ''
                  }`}
                >
                  {row.kind === 'file' ? (
                    <>
                      <FileTextIcon className="h-4 w-4 flex-shrink-0 text-stone-400" weight="regular" aria-hidden />
                      <span className="truncate">{basename(row.path)}</span>
                      {row.path.includes('/') ? (
                        <span className="min-w-0 truncate text-xs text-stone-400">{dirname(row.path)}</span>
                      ) : null}
                    </>
                  ) : row.kind === 'chat' ? (
                    <>
                      <ChatTeardropIcon className="h-4 w-4 flex-shrink-0 text-stone-400" weight="regular" aria-hidden />
                      <span className="truncate">{row.chat.title}</span>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate">{row.action.label}</span>
                      {row.action.shortcut ? (
                        <kbd className="rounded border border-stone-200 bg-stone-50 px-1 py-px font-sans text-[10px] text-stone-400">
                          {row.action.shortcut}
                        </kbd>
                      ) : null}
                    </>
                  )}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-stone-400">
      {children}
    </div>
  );
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirname = (path: string) => path.slice(0, path.lastIndexOf('/'));
