'use client';

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * A dropdown panel that positions itself with `position: fixed` against a
 * trigger element, rendered through a portal on document.body. Fixed panels
 * laid out against the viewport already escape `overflow-auto` clipping in
 * spec terms, but the desktop shell's WKWebView clips fixed descendants of
 * composited overflow scrollers (the bounded sidebar sections) — the portal
 * takes the panel out of every such ancestor. Outside-click dismissal must
 * therefore not rely on DOM ancestry: handlers treat clicks inside
 * `[data-floating-action-menu]` as inside the menu.
 *
 * When opening downward would overflow the viewport bottom (e.g. the Chats
 * section sits at the bottom of the sidebar), the panel flips above the
 * trigger. Only one of a given menu family is open at a time, so callers share
 * a single `anchorRef` assigned to whichever trigger is currently open.
 */
/**
 * True when a document-level mouse/pointer event landed inside any portaled
 * floating menu — the containment check outside-click closers must use now
 * that panels are not DOM descendants of their triggers. WebKit can dispatch
 * mouse events with a Text-node target (no `closest`), so normalize to the
 * parent element first.
 */
export function isInFloatingActionMenu(target: EventTarget | null): boolean {
  const el =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  return Boolean(el?.closest('[data-floating-action-menu]'));
}

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

  return createPortal(
    <div
      ref={panelRef}
      data-floating-action-menu
      data-testid="anchored-dropdown"
      // z-[80]: the body-level tier for portalled menus — above modal
      // overlays (z-[70]/z-[75]; the share modal hosts the member-role menu),
      // below tooltips (z-[90]).
      className={`fixed z-[80] ${className}`}
      style={{ top, left, transform: align === 'right' ? 'translateX(-100%)' : undefined }}
    >
      {children}
    </div>,
    document.body,
  );
}
