'use client';

import { PushPinIcon } from '@phosphor-icons/react';

type PinButtonProps = {
  pinned: boolean;
  onToggle: () => void;
  label: string;
  testId?: string;
  size?: number;
};

// Pin/unpin toggle shared by the drive list, recent projects, and recent chats.
// Pinned rows show a filled amber pin; unpinned rows reveal a faint pin on hover
// (the parent row must be `group`).
export function PinButton({ pinned, onToggle, label, testId, size = 16 }: PinButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid={testId}
      onClick={onToggle}
      className={
        pinned
          ? 'text-amber-500 hover:text-amber-600'
          : 'text-stone-300 opacity-0 transition-opacity hover:text-stone-500 group-hover:opacity-100'
      }
    >
      <PushPinIcon size={size} weight={pinned ? 'fill' : 'regular'} />
    </button>
  );
}
