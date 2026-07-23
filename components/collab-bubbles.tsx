'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* ------------------------------------------------------------------ */
/*  Shared utilities                                                   */
/* ------------------------------------------------------------------ */

export const COLOR_POOL = ['#0f766e', '#ea580c', '#16a34a', '#0ea5e9', '#7c3aed', '#be123c'];

export function pickColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLOR_POOL[Math.abs(hash) % COLOR_POOL.length];
}

export function getInitials(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '??';
  return (
    trimmed
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '??'
  );
}

/* ------------------------------------------------------------------ */
/*  Tooltip (shared)                                                   */
/* ------------------------------------------------------------------ */

const tooltipClass =
  'absolute top-full left-1/2 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-stone-900 px-2 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100 pointer-events-none z-20 shadow-sm';

/**
 * Black hover-label matching the collaborator bubble tooltip. Render it
 * inside the trigger element; it tracks hover on that parent and portals
 * the label to <body> with fixed positioning, so no overflow-hidden
 * ancestor can clip it (tooltips used to lose half their text at panel
 * edges). `align` sets the preferred anchor edge; the final position is
 * clamped to the viewport either way.
 * Pass `open` truthy to suppress the tooltip while the associated menu
 * or popover is open (a hover-label should never overlap its own menu).
 */
export function IconTooltip({
  label,
  side = 'bottom',
  align = 'center',
  open = false,
}: {
  label: string;
  side?: 'top' | 'bottom';
  align?: 'center' | 'left' | 'right';
  open?: boolean;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const trigger = anchorRef.current?.parentElement;
    if (!trigger) return;
    const show = () => setHovered(true);
    const hide = () => setHovered(false);
    trigger.addEventListener('mouseenter', show);
    trigger.addEventListener('mouseleave', hide);
    // Boundary events are edge-triggered and edges get missed (late hydration,
    // a layout shift moving the trigger under a stationary pointer, the scroll
    // hide below) — once missed, the pointer rests on the trigger with no
    // tooltip and no way to re-fire mouseenter without leaving first. pointermove
    // is level-triggered: any move over the trigger proves hover and recovers.
    // Touch is excluded: a finger drag has no paired mouseleave, so a touch
    // move would strand the tooltip visible after pointerup.
    const showFromMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') show();
    };
    trigger.addEventListener('pointermove', showFromMove);
    // A pointer already resting on the trigger when hydration attaches these
    // listeners never re-fires mouseenter — catch up from the :hover state.
    if (trigger.matches(':hover')) show();
    return () => {
      trigger.removeEventListener('mouseenter', show);
      trigger.removeEventListener('mouseleave', hide);
      trigger.removeEventListener('pointermove', showFromMove);
    };
  }, []);

  // A fixed tooltip doesn't follow its trigger, so a scroll that can move the
  // trigger dismisses it. Scrolls in unrelated subtrees (e.g. another panel's
  // auto-scrolling transcript) don't — and couldn't bring it back, since the
  // pointer never re-enters the trigger to re-fire mouseenter.
  useEffect(() => {
    if (!hovered) return;
    const trigger = anchorRef.current?.parentElement;
    const hide = (e: Event) => {
      if (e.target instanceof Node && trigger && e.target.contains(trigger)) setHovered(false);
    };
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [hovered]);

  const visible = hovered && !open;

  // Position from the trigger rect once the tip has a measurable width;
  // re-run on label change (e.g. "Copy link" -> "Copied" resizes the tip).
  useLayoutEffect(() => {
    const tip = tipRef.current;
    const trigger = anchorRef.current?.parentElement;
    if (!tip || !trigger || !visible) return;
    const rect = trigger.getBoundingClientRect();
    const x =
      align === 'right'
        ? rect.right - tip.offsetWidth
        : align === 'left'
          ? rect.left
          : rect.left + (rect.width - tip.offsetWidth) / 2;
    tip.style.left = `${Math.min(Math.max(x, 4), window.innerWidth - tip.offsetWidth - 4)}px`;
    const above = rect.top - tip.offsetHeight - 4;
    const below = rect.bottom + 4;
    const fitsAbove = above >= 4;
    const fitsBelow = below + tip.offsetHeight <= window.innerHeight - 4;
    // Flip to the other side when the preferred one leaves the viewport,
    // then clamp for the (tiny-window) case where neither side fits.
    let y = side === 'top' ? (fitsAbove ? above : below) : fitsBelow ? below : above;
    y = Math.min(Math.max(y, 4), window.innerHeight - tip.offsetHeight - 4);
    tip.style.top = `${y}px`;
  }, [visible, side, align, label]);

  return (
    <span ref={anchorRef} hidden>
      {visible
        ? createPortal(
            <span
              ref={tipRef}
              data-testid="icon-tooltip"
              // z-[90]: above every overlay (modals z-[70]/z-[75], portalled
              // menus z-[80]) — a body-level tooltip behind a modal is invisible.
              className="fixed whitespace-nowrap rounded bg-stone-900 px-2 py-1 text-[11px] text-white pointer-events-none z-[90] shadow-sm"
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Sizes                                                              */
/* ------------------------------------------------------------------ */

const SIZE_MAP = {
  sm: { px: 24, cls: 'w-6 h-6', text: 'text-[10px]', emoji: 'text-xs', border: 'border', dot: 'w-1.5 h-1.5' },
  md: { px: 32, cls: 'w-8 h-8', text: 'text-xs', emoji: 'text-sm', border: 'border-2', dot: 'w-3 h-3' },
};

/* ------------------------------------------------------------------ */
/*  HumanBubble                                                        */
/* ------------------------------------------------------------------ */

interface HumanBubbleProps {
  id: string;
  name: string;
  imageUrl?: string | null;
  initials?: string;
  label?: string;
  size?: 'sm' | 'md';
  /** Explicit swatch color (e.g. from Yjs awareness) — defaults to
   *  `pickColor(id)` so cursor and chip stay the same hue. */
  color?: string | null;
  className?: string;
}

export function HumanBubble({ id, name, imageUrl, initials, label, size = 'sm', color, className }: HumanBubbleProps) {
  const s = SIZE_MAP[size];
  const displayInitials = initials ?? getInitials(name);
  const tooltipLabel = label ?? name;
  // A broken avatar URL (expired/blocked Clerk image, network failure) must
  // degrade to the initials swatch, never a broken-image icon. Reset the guard
  // whenever the src changes so a later-valid URL still gets a chance to load.
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [imageUrl]);

  return (
    <div className={`relative group ${className ?? ''}`}>
      {imageUrl && !imgFailed ? (
        <img
          src={imageUrl}
          alt={name}
          onError={() => setImgFailed(true)}
          className={`${s.cls} rounded-full ${s.border} border-white object-cover cursor-pointer transition-shadow hover:shadow-sm`}
        />
      ) : (
        <div
          className={`${s.cls} rounded-full ${s.border} border-white flex items-center justify-center ${s.text} font-medium text-[#fff] cursor-pointer transition-shadow hover:shadow-sm`}
          style={{ backgroundColor: color ?? pickColor(id) }}
        >
          {displayInitials}
        </div>
      )}
      <span className={tooltipClass}>{tooltipLabel}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentBubble                                                        */
/* ------------------------------------------------------------------ */

interface AgentBubbleProps {
  emoji: string;
  name: string;
  /** When set, render this image instead of the emoji (e.g. a Sunny PNG). */
  imageUrl?: string | null;
  /** When set (and no imageUrl), render this node instead of the emoji —
   *  used for inline brand SVGs (Claude/Codex/Gemini) that color via
   *  currentColor. */
  icon?: React.ReactNode;
  isActive?: boolean;
  size?: 'sm' | 'md';
  onClick?: () => void;
  statusDotClassName?: string;
  statusDotStyle?: React.CSSProperties;
  /** Inline background color override (used by branded agent chips). */
  bubbleBackgroundColor?: string;
  /** Inline text/glyph color override. Defaults to white when bubbleBackgroundColor is set. */
  bubbleTextColor?: string;
  /** Solid border color (in addition to the white frame); used by logo chips so the
   *  brand color still shows when the chip background is white. */
  bubbleBorderColor?: string;
  /** Inner padding around the image in pixels. Used for SVG brand logos so they
   *  don't crowd the edges of the bubble. */
  imagePadding?: number;
  className?: string;
}

export function AgentBubble({ emoji, name, imageUrl, icon, isActive, size = 'sm', onClick, statusDotClassName, statusDotStyle, bubbleBackgroundColor, bubbleTextColor, bubbleBorderColor, imagePadding, className }: AgentBubbleProps) {
  const s = SIZE_MAP[size];

  // Determine status dot
  let dotEl: React.ReactNode = null;
  if (statusDotClassName || statusDotStyle) {
    // Custom status dot (used by workspace for richer statuses)
    dotEl = (
      <span
        className={`absolute -bottom-0.5 -right-0.5 ${s.dot} rounded-full ${s.border} border-white ${statusDotClassName ?? ''}`}
        style={statusDotStyle}
      />
    );
  } else if (isActive !== undefined) {
    dotEl = isActive ? (
      <span className={`absolute -bottom-0.5 -right-0.5 ${s.dot} rounded-full ${s.border} border-white bg-beige-400 animate-pulse`} />
    ) : (
      <span className={`absolute -bottom-0.5 -right-0.5 ${s.dot} rounded-full ${s.border} border-white bg-stone-300`} />
    );
  }

  const bubbleStyle: React.CSSProperties = {};
  if (bubbleBackgroundColor) {
    bubbleStyle.backgroundColor = bubbleBackgroundColor;
    bubbleStyle.color = bubbleTextColor ?? '#ffffff';
  }
  if (bubbleBorderColor) {
    bubbleStyle.boxShadow = `inset 0 0 0 1.5px ${bubbleBorderColor}`;
  }
  const imgPadStyle: React.CSSProperties | undefined =
    imagePadding != null ? { padding: imagePadding } : undefined;
  return (
    <div className={`relative group ${className ?? ''}`}>
      <div
        className={`${s.cls} overflow-hidden rounded-full flex items-center justify-center ${s.emoji} ${s.border} border-white ${bubbleBackgroundColor ? 'font-semibold' : 'bg-stone-100 hover:bg-stone-200'} cursor-pointer transition-colors`}
        style={bubbleStyle}
        onClick={onClick}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            className={`h-full w-full ${imagePadding != null ? 'object-contain' : 'object-cover'}`}
            style={imgPadStyle}
            draggable={false}
          />
        ) : (
          icon ?? emoji
        )}
      </div>
      {dotEl}
      <span className={tooltipClass}>{name}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  OverflowCount                                                      */
/* ------------------------------------------------------------------ */

interface OverflowCountProps {
  count: number;
}

export function OverflowCount({ count }: OverflowCountProps) {
  if (count <= 0) return null;
  return <span className="text-[10px] text-stone-400 pl-1">+{count}</span>;
}
