'use client';

import type { Editor } from '@tiptap/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useDocStyle } from '@/lib/doc-style';
import { MarkdownToolbar } from './markdown-toolbar';

export type MarkdownPageMargin = 'narrow' | 'normal' | 'wide';

export type MarkdownPageChrome = {
  margin: MarkdownPageMargin;
  header: boolean;
  footer: boolean;
  /** Page size in inches (Google Docs style only) — defaults to US Letter. */
  pageWidthIn?: number;
  pageHeightIn?: number;
};

export const DEFAULT_PAGE_WIDTH_IN = 8.5;
export const DEFAULT_PAGE_HEIGHT_IN = 11;

interface MarkdownEditorFrameProps {
  editor: Editor | null;
  readOnly?: boolean;
  hidden?: boolean;
  showToolbar?: boolean;
  /** Split panes are print:hidden — no Print control and no global @page rule. */
  hidePrint?: boolean;
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
  showToolbar = true,
  hidePrint = false,
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
  // Document ⋯ menu → "Google Docs style". 'docs' restores the pre-redesign
  // Google Docs page: a bordered white card with symmetric page margins.
  const docsPage = useDocStyle() === 'docs';

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

  const margin = effectivePageChrome.margin;
  // Obsidian style is asymmetric on purpose: the first line should sit near
  // the top of the pane (Obsidian/VS Code) instead of below a full page-margin
  // of dead space. Only the SCREEN padding is trimmed — print still uses
  // --print-margin below, so the printed page keeps its even margins. Google
  // Docs style keeps the even page margins on screen too.
  const pagePaddingClass = docsPage
    ? margin === 'narrow'
      ? 'py-8'
      : margin === 'wide'
        ? 'py-12'
        : 'py-10 lg:py-12'
    : margin === 'narrow'
      ? 'pt-2 pb-8'
      : margin === 'wide'
        ? 'pt-8 pb-12'
        : 'pt-2 pb-10 lg:pt-3 lg:pb-12';
  // Horizontal margin scales with the PANE, not the viewport: a split pane /
  // chat-squeezed editor in a wide window used to keep the `lg:` margin and
  // leave a ~230px text column. Percentage padding resolves against the
  // containing block (this frame), so at a full-width pane (≳ 870px) these are
  // the old fixed values (56px normal, 80px wide, 32px narrow) and slope down
  // to their floor by ~400px, where the primary's total gutter meets the split
  // pane's 16px. Percentages, not a container query: `container-type` was a
  // containing block for the editor's non-portaled position:fixed popovers on
  // pre-Safari-18 WKWebView (desktop min macOS 13.5).
  const pagePaddingInline =
    margin === 'narrow'
      ? 'clamp(0.5rem, 8% - 2rem, 2rem)'
      : margin === 'wide'
        ? 'clamp(1rem, 16% - 4rem, 5rem)'
        : 'clamp(0.75rem, 12% - 3rem, 3.5rem)';
  // Printed page margin (the on-screen padding is in px; print wants inches).
  const printMargin = margin === 'narrow' ? '0.5in' : margin === 'wide' ? '1in' : '0.75in';
  // Docs-style page size: a real sheet, in CSS inches (US Letter default).
  const pageWidthIn = effectivePageChrome.pageWidthIn ?? DEFAULT_PAGE_WIDTH_IN;
  const pageHeightIn = effectivePageChrome.pageHeightIn ?? DEFAULT_PAGE_HEIGHT_IN;

  return (
    <div ref={frameRef} className="flex w-full flex-col">
      {docsPage && !hidePrint ? (
        // The picked page size must ALSO be the printed paper size — the
        // print stylesheet only handles zoom/margins, and without @page the
        // browser paginates 6×9 content onto default Letter (Codex r8).
        // @page can't read CSS vars in current engines, hence the literal rule.
        <style>{`@page { size: ${pageWidthIn}in ${pageHeightIn}in; }`}</style>
      ) : null}
      {showToolbar ? (
        <div className="sticky top-0 z-10 rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.05)]">
          {displayEditor ? (
            <MarkdownToolbar
              editor={displayEditor}
              readOnly={readOnly}
              containerWidth={width}
              hidePrint={hidePrint}
              zoom={zoom}
              onZoomChange={setInternalZoom}
              lineHeight={lineHeight}
              onLineHeightChange={setInternalLineHeight}
              pageChrome={effectivePageChrome}
              onPageChromeChange={setInternalPageChrome}
            />
          ) : (
            <div className="h-9 bg-stone-50/60" aria-hidden />
          )}
        </div>
      ) : null}
      <div
        data-testid="editor-zoom-container"
        data-print-root
        // Obsidian (flat) page: the document renders directly on the white
        // panel (no card border/shadow) — the padding keeps the reading
        // measure. Google Docs page: a white card on the shell's gray desk.
        // The sheet is the picked page size in inches, but never wider than
        // the pane: a fixed-inch sheet in a narrow pane slid under the chat
        // panel / comment lane and read as a clipped page (Belinda). maxWidth
        // caps the SCREEN sheet only — print resets it (max-width: none in
        // @media print) so sub-100% zoom can still widen the root back out.
        // Sharp-ish corners (rounded-sm): a real sheet, like Docs/Word.
        className={`${showToolbar ? 'mt-2' : ''} bg-white ${
          docsPage
            ? 'mx-auto max-w-full rounded-sm border border-stone-200 shadow-[0_1px_2px_rgba(28,25,23,0.05)] '
            : ''
        }${pagePaddingClass}`}
        style={{
          paddingInline: pagePaddingInline,
          // CSS zoom, NOT transform scale: zoom re-lays-out and re-rasterizes
          // text at the target size (like the print path), while a composited
          // scale() rasterizes at 100% and stretches the layer — which is what
          // made the doc (the big in-file title most visibly) blurry at any
          // non-100 zoom. Layout under zoom self-compensates, so the IDE
          // width-compensation trick is gone; the docs sheet keeps its
          // fixed-inch size in its own (zoomed) coordinates.
          zoom: zoom === 100 ? undefined : zoom / 100,
          width: docsPage ? `${pageWidthIn}in` : undefined,
          minHeight: docsPage ? `${pageHeightIn}in` : undefined,
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
