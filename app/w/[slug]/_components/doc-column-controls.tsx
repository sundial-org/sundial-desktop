'use client';

import type { MouseEvent, ReactNode, RefObject } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';

/**
 * Workspace-v4 Phase 2 — the editor column's header strip. Editor and Review
 * are now independent center panels (top-bar 3-way control), so the old
 * Editor/Review toggle that lived here is gone; this strip carries the file
 * identity, per-file controls, and a close (X) that drops the editor panel
 * from the open set.
 */
export function DocColumnControls({
  onClose,
  leftSlot,
  rightSlot,
}: {
  /** Closes the editor panel (removes it from the center open-set). */
  onClose: () => void;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
}) {
  return (
    <div
      data-testid="doc-column-controls"
      className="flex h-9 items-center gap-2 bg-stone-50 px-3 shrink-0"
    >
      {leftSlot}
      <div className="ml-auto flex items-center gap-1">
        {rightSlot}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close editor"
          data-testid="doc-column-close"
          className="relative group/tip inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
        >
          <XIcon className="h-4 w-4" weight="bold" aria-hidden />
          <IconTooltip label="Close" />
        </button>
      </div>
    </div>
  );
}

export function DocFileNameControl({
  fileName,
  canRename,
  isRenaming,
  renameValue,
  inputRef,
  onBeginRename,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
  large = false,
}: {
  fileName: string;
  canRename: boolean;
  isRenaming: boolean;
  renameValue: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onBeginRename: (event: MouseEvent<HTMLButtonElement>) => void;
  onRenameValueChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  /** Google Docs-style header title: bigger, regular weight. The rename
   *  input mirrors the same metrics so nothing moves when editing starts. */
  large?: boolean;
}) {
  // Markdown is the product's native file type, so its extension is chrome,
  // not information — the header shows the bare name. Real extensions
  // (.tex, .csv, …) stay: they say what the file IS. Only the literal .md
  // hides — .mdx/.markdown keep theirs, because the rename flow only
  // auto-preserves .md and an extensionless display would invite renames
  // that silently convert the file (Codex P2 on #1027). A too-long name
  // clips cleanly (overflow-hidden, no ellipsis); title attr = full name.
  const label = fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
  const sizeClass = large
    ? 'text-[17px] font-normal text-stone-800'
    : 'text-[13px] font-medium text-stone-700';
  const labelClass = `min-w-0 overflow-hidden whitespace-nowrap ${sizeClass}`;

  if (isRenaming) {
    return (
      <input
        ref={inputRef}
        data-testid="doc-file-name-input"
        aria-label="Rename file"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={renameValue}
        onChange={(event) => onRenameValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommitRename();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancelRename();
          }
        }}
        onBlur={onCommitRename}
        onClick={(event) => event.stopPropagation()}
        size={Math.max(renameValue.length + 1, 2)}
        // Default: pinned to the control line (h-5/leading-5, header polish);
        // large (Docs title): free height, the input mirrors the label so
        // nothing moves when a rename starts. py-0: the title hugs the menu
        // bar below it (Belinda, round 3).
        className={`min-w-0 rounded px-1 text-left ${sizeClass} ${
          large ? 'py-0' : 'h-5 py-0 leading-5'
        } bg-transparent outline-none`}
      />
    );
  }

  if (!canRename) {
    return (
      <span data-testid="doc-file-name" className={labelClass} title={fileName}>
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid="doc-file-name"
      aria-label={`Rename ${fileName}`}
      title={fileName}
      onClick={onBeginRename}
      className={`${labelClass} rounded px-1 text-left ${
        large ? 'py-0' : 'h-5 py-0 leading-5'
      } hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300`}
    >
      {label}
    </button>
  );
}
