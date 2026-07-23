'use client';

import { useEffect, useRef, useState } from 'react';

type EditableChatTitleProps = {
  /** Resolved display text (custom title, else the `Sunny #N` fallback). */
  value: string;
  /** What to seed the input with when entering edit (the current title). */
  initialDraft: string;
  editing: boolean;
  onCommit: (next: string) => void;
  onCancel: () => void;
  className?: string;
};

// The chat-list title cell: shows the chat name, and an inline rename input when
// `editing`. Enter/blur commit, Escape cancels. Click/keydown stop propagation so
// editing never selects the chat row underneath (2026-06-05 feedback).
export function EditableChatTitle({
  value,
  initialDraft,
  editing,
  onCommit,
  onCancel,
  className,
}: EditableChatTitleProps) {
  const [draft, setDraft] = useState(initialDraft);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const skipBlurRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    setDraft(initialDraft);
    skipBlurRef.current = false;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
    // Re-seed each time we enter edit mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (!editing) {
    return <div className={className}>{value}</div>;
  }

  return (
    <input
      ref={inputRef}
      data-testid="chat-title-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          skipBlurRef.current = true;
          onCommit(draft);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          skipBlurRef.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (skipBlurRef.current) {
          skipBlurRef.current = false;
          return;
        }
        onCommit(draft);
      }}
      // Match the Files rename input: a borderless, transparent inline field
      // (no bordered "box"), so renaming a chat looks the same as renaming a file.
      className={`w-full min-w-0 bg-transparent text-left text-sm leading-4 text-stone-800 outline-none placeholder:text-stone-400 ${className ?? ''}`}
      placeholder="Chat name"
    />
  );
}
