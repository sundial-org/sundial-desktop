'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CaretDownIcon,
  CheckIcon,
  EyeIcon,
  NotePencilIcon,
  PencilSimpleIcon,
} from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import {
  DOC_EDIT_MODES,
  EDIT_MODE_LABEL,
  EDIT_MODE_TOOLTIP,
  type WorkspaceEditMode,
} from '@/lib/workspace/edit-mode';

const MODE_ICON = {
  edit: PencilSimpleIcon,
  suggest: NotePencilIcon,
  view: EyeIcon,
} as const;

const MODE_DESCRIPTION: Record<WorkspaceEditMode, string> = {
  edit: 'Changes apply directly to the document.',
  suggest: 'Changes become reviewable suggestions.',
  view: 'View without making edits.',
};

const MENU_WIDTH = 240; // matches w-60

type EditModeControlProps = {
  mode: WorkspaceEditMode;
  onChange: (mode: WorkspaceEditMode) => void;
  /** Which direction the menu opens. Composer footer opens up; toolbar opens down. */
  menuPlacement?: 'up' | 'down';
  /** Hide the text label, showing icon + caret only. */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  /** Which modes to offer. Defaults to the document toolbar set (edit/suggest);
   *  the chat composer passes CHAT_EDIT_MODES to include read-only Viewing. */
  modes?: WorkspaceEditMode[];
};

export function EditModeControl({
  mode,
  onChange,
  menuPlacement = 'up',
  compact = false,
  disabled = false,
  className = '',
  modes = DOC_EDIT_MODES,
}: EditModeControlProps) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // The menu is portaled to <body> with fixed positioning so it floats above
  // sibling panels (the chat) and escapes the editor pane's `overflow-hidden`
  // clip — an in-flow `absolute` menu got cut off at the pane edge. Track the
  // trigger rect and follow it on scroll/resize.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setAnchorRect(rect);
    };
    update();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const TriggerIcon = MODE_ICON[mode];
  // Every mode shares the neutral "Editing" styling — no per-mode colored
  // trigger tint or filled icon (2026-06-09 feedback).
  const triggerTone = 'text-stone-600 hover:bg-stone-200/50 hover:text-stone-800';
  // `up` anchors the menu's bottom to the trigger top (translateY(-100%)), so
  // height never needs measuring; `down` drops it below. Left edge clamps to
  // the viewport so a right-aligned trigger can't push it off-screen.
  const menuStyle = anchorRect
    ? {
        left: Math.min(window.innerWidth - MENU_WIDTH - 12, Math.max(12, anchorRect.left)),
        top: menuPlacement === 'up' ? anchorRect.top - 4 : anchorRect.bottom + 4,
        width: MENU_WIDTH,
        transform: menuPlacement === 'up' ? 'translateY(-100%)' : undefined,
      }
    : undefined;

  return (
    <div className={`relative ${className}`} data-testid="edit-mode-control">
      <button
        type="button"
        ref={triggerRef}
        data-testid="edit-mode-trigger"
        data-mode={mode}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        aria-label={EDIT_MODE_TOOLTIP[mode]}
        className={`relative group/tip flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${triggerTone}`}
      >
        <TriggerIcon className="h-3.5 w-3.5" aria-hidden weight="regular" />
        {!compact ? <span>{EDIT_MODE_LABEL[mode]}</span> : null}
        <CaretDownIcon className="h-3 w-3 opacity-60" weight="bold" aria-hidden />
        <IconTooltip label={EDIT_MODE_TOOLTIP[mode]} side={menuPlacement === 'up' ? 'top' : 'bottom'} open={open} />
      </button>
      {open && menuStyle && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              data-testid="edit-mode-menu"
              style={menuStyle}
              className="fixed z-[80] rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
            >
              {modes.map((option) => {
                const OptionIcon = MODE_ICON[option];
                const selected = option === mode;
                return (
                  <button
                    key={option}
                    type="button"
                    data-testid="edit-mode-option"
                    data-mode={option}
                    data-selected={selected ? 'true' : 'false'}
                    onClick={() => {
                      setOpen(false);
                      if (option !== mode) onChange(option);
                    }}
                    className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-stone-50 ${
                      selected ? 'bg-stone-50' : ''
                    }`}
                  >
                    <OptionIcon className="mt-0.5 h-4 w-4 shrink-0 text-stone-500" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-stone-800">{EDIT_MODE_LABEL[option]}</span>
                      <span className="block text-[11px] text-stone-400">{MODE_DESCRIPTION[option]}</span>
                    </span>
                    {selected ? (
                      <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500" weight="bold" aria-hidden />
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
