'use client';

import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** Live width of the element the returned callback ref is attached to. */
export function useElementWidth(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return setWidth(0);
    const measure = () => setWidth(el.offsetWidth);
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
    measure();
  }, []);
  return [ref, width];
}

/** Below this bar width the always-on controls fold into the ⋯ menu so the
 *  title keeps room. (Bar width = pane width, so collapsing the controls can't
 *  feed back into the measurement.) */
export const DOC_HEADER_COLLAPSE_WIDTH = 460;

interface DocPaneHeaderProps {
  path: string;
  /** The file-name control (rename-able), rendered right after the crumbs. */
  nameControl: ReactNode;
  /** Share status riding just right of the name. */
  shareIcon?: ReactNode;
  /** The row-end control cluster; `collapsed` = the bar is squished and the
   *  always-on controls should fold into the ⋯ menu. */
  controls: (collapsed: boolean) => ReactNode;
  /** Absolutely-positioned cluster at the row's left (no-tabs shell: × + ⋮). */
  leading?: ReactNode;
  leadingLeft?: CSSProperties['left'];
  /** Crumb click → focus that folder in the rail. */
  onFocusFolder: (path: string) => void;
  /** No bar above (web / hidden): the row is the top row — h-11 so its
   *  controls center on the rail's icons; the tabbed shell just adds air. */
  tall: boolean;
  /** Extra obstruction on each side mirrored into the title's width cap. */
  mirrorLeft?: number;
  mirrorRight?: number;
  paddingRight?: number;
  /** Hairline under the row — set when another chrome bar runs right below
   *  (the LaTeX split toolbars), so the two read as separate bars. */
  divider?: boolean;
  /** Override the measured collapse (the primary shares its value with the
   *  mobile bar and toolbar); the default measures this bar. */
  collapsed?: boolean;
  headerRef?: (el: HTMLDivElement | null) => void;
  testId?: string;
}

/**
 * The file's own header row: its identity (folder path + name + share status)
 * centered on the bar, and the controls closing the row. One component for
 * every editor pane — primary and splits read the same.
 */
export function DocPaneHeader({
  path,
  nameControl,
  shareIcon,
  controls,
  leading,
  leadingLeft,
  onFocusFolder,
  tall,
  mirrorLeft = 0,
  mirrorRight = 0,
  paddingRight,
  divider = false,
  collapsed,
  headerRef,
  testId = 'topbar-doc-controls',
}: DocPaneHeaderProps) {
  const [controlsRef, controlsWidth] = useElementWidth();
  const [measureHeader, headerWidth] = useElementWidth();
  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      headerRef?.(el);
      measureHeader(el);
    },
    [headerRef, measureHeader],
  );
  const isCollapsed = collapsed ?? (headerWidth > 0 && headerWidth < DOC_HEADER_COLLAPSE_WIDTH);
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const segs = folder ? folder.split('/') : [];
  const crumb = (seg: string, index: number) => (
    <button
      key={index}
      type="button"
      onClick={() => onFocusFolder(segs.slice(0, index + 1).join('/'))}
      className="shrink-0 rounded px-0.5 hover:bg-stone-100 hover:text-stone-600"
    >
      {seg}
    </button>
  );
  // Padded slashes, not spaces: flex-item boundaries trim plain whitespace,
  // eating the breadcrumb gaps.
  const sep = (key: string) => (
    <span key={key} className="shrink-0 px-0.5" aria-hidden>
      /
    </span>
  );
  return (
    <div
      ref={rowRef}
      data-testid={testId}
      className={`relative flex shrink-0 items-center justify-end gap-1 px-3 print:hidden ${
        tall ? 'h-11' : 'pt-1'
      } ${divider ? 'border-b border-stone-200' : ''}`}
      style={paddingRight ? { paddingRight } : undefined}
    >
      {leading ? (
        // No transform here: a ⋮ dropdown inside is position:fixed, and a
        // transformed ancestor would re-base it (panel drifting mid-window).
        <div className="absolute inset-y-0 flex items-center gap-0" style={{ left: leadingLeft ?? 8 }}>
          {leading}
        </div>
      ) : null}
      {/* Identity centered on the BAR (absolute), capped to the measured
          controls width mirrored on BOTH sides — so it stays truly centered
          yet can never run under the controls. Full folder path when roomy;
          as the bar tightens the ancestor chain collapses first, then the
          last folder, and only then the name — which clips with no ellipsis.
          Hover keeps the full path either way. inset-x-0 + mx-auto (not
          left-1/2 translate): the wrap trick needs a DEFINITE width. */}
      <div
        className={`absolute inset-y-0 inset-x-0 mx-auto flex min-w-0 items-center text-[13px] ${
          tall ? '' : 'pt-1'
        }`}
        title={path}
        style={{
          maxWidth: `calc(100% - ${2 * Math.max(controlsWidth + mirrorRight, mirrorLeft) + 32}px)`,
        }}
      >
        {/* row-reverse + wrap: the name is DOM-first (never wraps), the last
            folder then the ancestor chain wrap onto a second row that the h-5
            overflow-hidden wrapper clips away entirely — whole tiers drop,
            never mid-segment clipping. */}
        <div className="flex h-5 w-full min-w-0 flex-row-reverse flex-wrap content-start items-center justify-center overflow-hidden">
          {shareIcon}
          {nameControl}
          {segs.length ? (
            <>
              <span
                data-testid="doc-file-path"
                className="flex shrink-0 items-center whitespace-nowrap text-stone-400"
              >
                {crumb(segs[segs.length - 1], segs.length - 1)}
                {sep('sep-last')}
              </span>
              {segs.length > 1 ? (
                <span className="flex shrink-0 items-center whitespace-nowrap text-stone-400">
                  {segs.slice(0, -1).flatMap((seg, i) => [crumb(seg, i), sep(`sep-${i}`)])}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <div ref={controlsRef} className="flex items-center gap-1">
        {controls(isCollapsed)}
      </div>
    </div>
  );
}
