'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircleIcon, XIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';

type WorkspaceNotice = {
  type: 'success' | 'error';
  message: string;
};

export function useWorkspaceNotice() {
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const clearNotice = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setNotice(null);
  }, []);

  const showNotice = useCallback(
    (type: WorkspaceNotice['type'], message: string) => {
      clearNotice();
      setNotice({ type, message });
      timeoutRef.current = window.setTimeout(() => {
        setNotice(null);
        timeoutRef.current = null;
      }, 4000);
    },
    [clearNotice],
  );

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  return { notice, showNotice, clearNotice };
}

export function WorkspaceNoticeToast({
  notice,
  onClose,
}: {
  notice: WorkspaceNotice | null;
  onClose: () => void;
}) {
  if (!notice) return null;
  return (
    <div className="fixed bottom-20 left-4 right-4 z-[60] sm:left-auto sm:right-6 sm:max-w-sm">
      <div
        className={`flex items-start gap-3 rounded-xl px-4 py-3 shadow-2xl ${
          notice.type === 'success' ? 'bg-stone-800 text-white' : 'bg-red-600 text-white'
        }`}
      >
        {notice.type === 'success' ? (
          <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0" weight="fill" aria-hidden />
        ) : (
          <XIcon className="mt-0.5 h-4 w-4 shrink-0" weight="bold" aria-hidden />
        )}
        <div className="min-w-0 flex-1 text-sm">{notice.message}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="relative group/tip shrink-0 text-white/70 transition-colors hover:text-white"
        >
          <XIcon className="h-4 w-4" weight="bold" aria-hidden />
          <IconTooltip label="Dismiss" side="top" />
        </button>
      </div>
    </div>
  );
}
