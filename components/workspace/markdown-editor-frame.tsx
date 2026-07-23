'use client';

import type { Editor } from '@tiptap/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MarkdownToolbar } from './markdown-toolbar';
import { MarkdownMenuBar } from './markdown-menu-bar';

export type MarkdownPageMargin = 'narrow' | 'normal' | 'wide';

export type MarkdownPageChrome = {
  margin: MarkdownPageMargin;
  header: boolean;
  footer: boolean;
};

interface MarkdownEditorFrameProps {
  editor: Editor | null;
  readOnly?: boolean;
  hidden?: boolean;
  showMenuBar?: boolean;
  showToolbar?: boolean;
  /** When provided, the content card's zoom is controlled by the caller. */
  zoom?: number;
  /** When provided, the content card's line-height is controlled by the caller. */
  lineHeight?: number;
  pageChrome?: MarkdownPageChrome;
  children: ReactNode;
}

export function MarkdownEditorFrame({
  editor,
  readOnly = false,
  hidden = false,
  showMenuBar = true,
  showToolbar = true,
  zoom: zoomProp,
  lineHeight: lineHeightProp,
  pageChrome,
  children,
}: MarkdownEditorFrameProps) {
  const [internalZoom, setInternalZoom] = useState(100);
  const [internalLineHeight, setInternalLineHeight] = useState(1.5);
  const [internalPageChrome, setInternalPageChrome] = useState<MarkdownPageChrome>({
    margin: 'normal',
    header: false,
    footer: false,
  });
  const zoom = zoomProp ?? internalZoom;
  const lineHeight = lineHeightProp ?? internalLineHeight;
  const effectivePageChrome = pageChrome ?? internalPageChrome;
  const [width, setWidth] = useState(0);

  // Retain the last valid editor so brief recreation cycles (Hocuspocus
  // reconnects, ydoc swaps) don't unmount the toolbar visually.
  const lastValidEditorRef = useRef<Editor | null>(null);
  if (editor && !editor.isDestroyed) {
    lastValidEditorRef.current = editor;
  } else if (lastValidEditorRef.current?.isDestroyed) {
    lastValidEditorRef.current = null;
  }
  const displayEditor = lastValidEditorRef.current;

  const frameRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    if (typeof ResizeObserver === 'undefined') {
      setWidth(node.getBoundingClientRect().width);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  if (hidden) {
    return <>{children}</>;
  }

  const showAnyChrome = showMenuBar || showToolbar;
  const placeholderHeight = showMenuBar && showToolbar ? 'h-[76px]' : 'h-[40px]';
  const margin = effectivePageChrome.margin;
  const pagePaddingClass =
    margin === 'narrow'
      ? 'px-6 py-8 lg:px-8'
      : margin === 'wide'
        ? 'px-14 py-12 lg:px-20'
        : 'px-10 py-10 lg:px-14 lg:py-12';
  // Printed page margin (the on-screen padding is in px; print wants inches).
  const printMargin = margin === 'narrow' ? '0.5in' : margin === 'wide' ? '1in' : '0.75in';

  return (
    <div ref={frameRef} className="flex w-full flex-col">
      {showAnyChrome ? (
        <div className="relative rounded-xl border border-stone-200 bg-stone-100 shadow-[0_1px_2px_rgba(28,25,23,0.05)]">
          {displayEditor ? (
            <>
              {showMenuBar ? (
                <MarkdownMenuBar editor={displayEditor} readOnly={readOnly} />
              ) : null}
              {showToolbar ? (
                <MarkdownToolbar
                  editor={displayEditor}
                  readOnly={readOnly}
                  containerWidth={width}
                  zoom={zoom}
                  onZoomChange={setInternalZoom}
                  lineHeight={lineHeight}
                  onLineHeightChange={setInternalLineHeight}
                  pageChrome={effectivePageChrome}
                  onPageChromeChange={setInternalPageChrome}
                />
              ) : null}
            </>
          ) : (
            <div
              className={`${placeholderHeight} bg-stone-50/60`}
              aria-hidden
            />
          )}
        </div>
      ) : null}
      <div
        data-testid="editor-zoom-container"
        data-print-root
        // Flat page: the document renders directly on the white panel (no
        // card border/shadow) — the padding keeps the reading measure.
        className={`${showAnyChrome ? 'mt-2' : ''} bg-white ${pagePaddingClass}`}
        style={{
          transform: zoom === 100 ? undefined : `scale(${zoom / 100})`,
          transformOrigin: 'top left',
          width: zoom === 100 ? undefined : `${(100 * 100) / zoom}%`,
          // Printing reads these (see @media print in globals.css): the zoom
          // becomes the printed text size and the margin becomes the page padding.
          ['--print-zoom' as string]: zoom / 100,
          ['--print-margin' as string]: printMargin,
          ['--line-height' as string]: lineHeight,
          lineHeight: 'var(--line-height)',
        }}
      >
        {effectivePageChrome.header ? (
          <div className="mb-8 h-8 border-b border-stone-200/80" aria-hidden />
        ) : null}
        {children}
        {effectivePageChrome.footer ? (
          <div className="mt-8 h-8 border-t border-stone-200/80" aria-hidden />
        ) : null}
      </div>
    </div>
  );
}
