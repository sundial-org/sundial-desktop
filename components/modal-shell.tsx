'use client';

import { ReactNode, useEffect, useRef } from 'react';

type ModalShellProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  overlayClassName?: string;
  panelClassName?: string;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  lockBodyScroll?: boolean;
  ariaLabel?: string;
};

export function ModalShell({
  open,
  onClose,
  children,
  overlayClassName,
  panelClassName,
  closeOnEscape = true,
  closeOnBackdrop = true,
  lockBodyScroll = true,
  ariaLabel,
}: ModalShellProps) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !closeOnEscape) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, closeOnEscape, onClose]);

  useEffect(() => {
    if (!open || !lockBodyScroll) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open, lockBodyScroll]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={(event) => {
        if (closeOnBackdrop && event.target === backdropRef.current) {
          onClose();
        }
      }}
      className={overlayClassName || 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4'}
    >
      <div className={panelClassName || 'w-full max-w-lg rounded-xl bg-white shadow-xl'}>
        {children}
      </div>
    </div>
  );
}
