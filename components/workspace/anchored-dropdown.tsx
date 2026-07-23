'use client';

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/**
 * A dropdown panel that positions itself with `position: fixed` against a
 * trigger element. Fixed panels are laid out against the viewport, so they
 * escape the `overflow-auto` clipping of the bounded sidebar sections (which
 * would otherwise cut menus off at a section boundary). The panel is still
 * rendered inline (a DOM descendant of its trigger wrapper), so existing
 * ref-based outside-click dismissal keeps working without a portal.
 *
 * When opening downward would overflow the viewport bottom (e.g. the Chats
 * section sits at the bottom of the sidebar), the panel flips above the
 * trigger. Only one of a given menu family is open at a time, so callers share
 * a single `anchorRef` assigned to whichever trigger is currently open.
 */
export function AnchoredDropdown({
  open,
  anchorRef,
  align = 'right',
  className = '',
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** Which edge of the panel aligns to the trigger's matching edge. */
  align?: 'left' | 'right';
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [flip, setFlip] = useState(false);

  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      setFlip(false);
      return;
    }
    const update = () => {
      const el = anchorRef.current;
      if (el) setRect(el.getBoundingClientRect());
    };
    update();
    // Capture-phase scroll catches scrolling in any ancestor (the section
    // bodies scroll independently), so the panel tracks its trigger.
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, anchorRef]);

  // Once the panel has a measured height, flip it above the trigger if opening
  // downward would run past the viewport bottom.
  useLayoutEffect(() => {
    if (!open || !rect) return;
    const height = panelRef.current?.offsetHeight ?? 0;
    setFlip(height > 0 && rect.bottom + 4 + height > window.innerHeight - 8);
  }, [open, rect]);

  if (!open || !rect) return null;

  const height = panelRef.current?.offsetHeight ?? 0;
  const top = flip ? Math.max(8, rect.top - 4 - height) : rect.bottom + 4;
  const left = align === 'right' ? rect.right : rect.left;

  return (
    <div
      ref={panelRef}
      data-floating-action-menu
      data-testid="anchored-dropdown"
      className={`fixed z-50 ${className}`}
      style={{ top, left, transform: align === 'right' ? 'translateX(-100%)' : undefined }}
    >
      {children}
    </div>
  );
}
