'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import {
  CaretLeftIcon,
  CaretRightIcon,
  ArrowsHorizontalIcon,
  ArrowSquareOutIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from '@phosphor-icons/react';
import { Spinner } from '@/components/ui/spinner';
import type { SyncTexIndex } from '@/lib/latex/synctex';

// PDF.js viewer that replaces the old browser <iframe> preview (spec W1.pdfjs).
// A real text layer (selectable text + SyncTeX anchors), continuous page
// scrolling, page navigation, and independent zoom. "Show in PDF" opens the
// compiled PDF in a new tab; double-click runs SyncTeX inverse search
// (W4.synctex), mapping a PDF point back to the source line.

// pdfjs ships the worker as a separate module; resolve it through the bundler
// so the version always matches the API we import (a mismatch hard-errors).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const ZOOM_STEP = 0.2;
// Wheel zoom scales with deltaY so a trackpad pinch (many small events) stays
// smooth; each event is clamped to one ZOOM_STEP so a coarse mouse-wheel notch
// (deltaY ~100) advances a single step rather than leaping.
const ZOOM_WHEEL_FACTOR = 0.004;
// deltaMode line/page → pixel conversion so non-pixel wheels zoom comparably.
const PX_PER_LINE = 16;
const PX_PER_PAGE = 800;
const HORIZONTAL_PADDING = 32; // matches the px-4 gutter around each page
const VERTICAL_PADDING = 16; // matches the py-2 gutter around each page
// Shared by the real page wrappers and the loading skeletons — equal heights
// between the two is the invariant that keeps scrollTop stable on recompile.
const PAGE_WRAPPER_CLASS = 'flex justify-center px-4 py-2';

const ICON_BTN =
  'flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-40';

interface LatexPdfViewerProps {
  /** Blob URL of the compiled PDF. */
  fileUrl: string;
  texPath: string;
  /** Parsed SyncTeX index for click-to-source; null disables the gestures. */
  synctex?: SyncTexIndex | null;
  /** Inverse search: a PDF double-click resolved to a source file + line. */
  onInverseSearch?: (file: string, line: number) => void;
}

type PageDims = { width: number; height: number };

export function LatexPdfViewer({
  fileUrl,
  texPath,
  synctex,
  onInverseSearch,
}: LatexPdfViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1);
  // renderScale lags scale: the canvas only re-rasterizes once a zoom gesture
  // settles, while scale drives an instant CSS transform (see below).
  const [renderScale, setRenderScale] = useState(1);
  const [baseWidth, setBaseWidth] = useState(0);
  const [columnHeight, setColumnHeight] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped when a page reports different PDF-point dimensions, so min-heights
  // and skeletons (computed from pageDimsRef during render) re-derive.
  const [dimsVersion, setDimsVersion] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollTop = useRef<number | null>(null);
  const restoreRaf = useRef<number | null>(null);
  const suppressScrollCapture = useRef(false);
  // Where to anchor the next zoom: the pointer offset within the pane for wheel
  // zooms, or null to use the viewport centre (button/fit zooms).
  const zoomAnchorY = useRef<number | null>(null);
  const prevScale = useRef(1);
  // Live mirror of zoomPreview so the (memoised) scroll handler can read it.
  const zoomPreviewRef = useRef(1);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  // PDF-point dimensions per page (from Page onLoadSuccess) for px↔pt mapping.
  // Deliberately *not* cleared on a fileUrl swap: the previous document's
  // dimensions size the loading skeletons and page placeholders, which is what
  // keeps the scroll height (and therefore scrollTop) stable across recompiles.
  const pageDimsRef = useRef<Map<number, PageDims>>(new Map());

  // A programmatic scroll (page nav, SyncTeX) must win over a post-zoom restore,
  // or it would get yanked back to the pre-zoom position. Cancel any running
  // restore and suppress the still-pending debounce from capturing a new target
  // (it would otherwise snapshot the mid-navigation scrollTop and restore that).
  const cancelScrollRestore = useCallback(() => {
    if (restoreRaf.current != null) cancelAnimationFrame(restoreRaf.current);
    restoreRaf.current = null;
    pendingScrollTop.current = null;
    suppressScrollCapture.current = true;
  }, []);

  // Scroll preservation across a recompile: a fileUrl swap reloads <Document>,
  // and stable-height skeletons keep the browser from clamping scrollTop while
  // it loads. Latch the position anyway (synchronously, while the old pages are
  // still committed) and reapply it after load — the safety net for the rare
  // case where the new layout differs and the position drifted.
  const reloadScrollTopRef = useRef<number | null>(null);
  // Set while the last load errored: the 200px error fallback collapses the
  // scroll height and the browser clamps scrollTop (firing a scroll event), so
  // scrolls in that window are clamps, not reader intent — don't let them
  // discard the latch holding the last good position.
  const loadFailedRef = useRef(false);
  const prevFileUrlRef = useRef(fileUrl);
  if (prevFileUrlRef.current !== fileUrl) {
    prevFileUrlRef.current = fileUrl;
    loadFailedRef.current = false;
    // An unconsumed latch means the previous load failed before restoring —
    // it still holds the reader's last good position, so keep it for the retry
    // instead of re-latching the error state's clamped scrollTop.
    if (reloadScrollTopRef.current === null) {
      reloadScrollTopRef.current = scrollRef.current?.scrollTop ?? null;
    }
  }

  // Fit-to-width baseline: the page renders at container width × scale, so
  // scale = 1 always fills the pane and zoom multiplies from there.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const measure = () => setBaseWidth(Math.max(0, node.clientWidth - HORIZONTAL_PADDING));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Track which page is centered in the viewport so the page counter and
  // prev/next jumps stay in sync with free scrolling.
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    // Any scroll during the reload window is the reader navigating (skeletons
    // hold the heights, so nothing else moves the viewport) — their intent
    // wins over the latched restore. Scrolls in the error state are browser
    // clamps from the collapsed fallback, not intent (see loadFailedRef).
    if (!loadFailedRef.current) reloadScrollTopRef.current = null;
    const mid = container.scrollTop + container.clientHeight / 2;
    // Mid-zoom the column is CSS-scaled from its top while offsetTop stays
    // unscaled, so map each page's layout position into the scaled scroll space
    // before comparing — otherwise the counter mis-tracks during the preview.
    const previewScale = zoomPreviewRef.current;
    let nearest = 1;
    let nearestDistance = Infinity;
    pageRefs.current.forEach((node, index) => {
      if (!node) return;
      const center = (node.offsetTop + node.offsetHeight / 2) * previewScale;
      const distance = Math.abs(center - mid);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index + 1;
      }
    });
    // Only commit when a real page was measured — a scroll event that fires
    // before any page has mounted must not reset the counter to page 1.
    if (Number.isFinite(nearestDistance)) setCurrentPage(nearest);
  }, []);

  const onDocumentLoad = useCallback(({ numPages: count }: { numPages: number }) => {
    setNumPages(count);
    setCurrentPage((page) => Math.min(page, count) || 1);
    setLoadError(null);
    // Page refs repopulate from the ref callbacks below as the new pages mount
    // (their keys include fileUrl, so a document swap remounts them). Don't null
    // the array here — a second onLoadSuccess for the *same* file wouldn't
    // remount the pages, and would leave the refs permanently null.
    const pending = reloadScrollTopRef.current;
    reloadScrollTopRef.current = null;
    // After this load commits (rAF runs post-commit, pre-next-paint): put the
    // viewport back if anything moved it during the reload, then recompute the
    // page counter — a scroll over the skeletons couldn't (no pages mounted),
    // and no further scroll event is guaranteed.
    requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) return;
      if (pending !== null && Math.abs(container.scrollTop - pending) > 1) {
        container.scrollTop = pending;
      }
      handleScroll();
    });
  }, [handleScroll]);

  const goToPage = useCallback((page: number) => {
    const target = pageRefs.current[page - 1];
    if (!target) return;
    cancelScrollRestore();
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [cancelScrollRestore]);

  const zoomTo = useCallback((next: number) => {
    // Like a wheel zoom, a button/fit zoom intends to hold its own scroll
    // position — re-arm capture in case a prior navigation suppressed it.
    suppressScrollCapture.current = false;
    zoomAnchorY.current = null; // button/fit zoom anchors to the viewport centre
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(next.toFixed(2)))));
  }, []);

  // Inverse (PDF→source): a double-click on a page → nearest box → source line.
  const handlePageDoubleClick = useCallback(
    (page: number, event: React.MouseEvent<HTMLDivElement>) => {
      if (!synctex || !onInverseSearch) return;
      const canvas = pageRefs.current[page - 1]?.querySelector('canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dims = pageDimsRef.current.get(page);
      if (!dims || rect.width <= 0) return;
      const ptPerPx = dims.width / rect.width;
      const xPt = (event.clientX - rect.left) * ptPerPx;
      const yPt = (event.clientY - rect.top) * ptPerPx;
      const hit = synctex.inverse(page, xPt, yPt);
      if (hit) onInverseSearch(hit.file, hit.line);
    },
    [synctex, onInverseSearch],
  );

  // Ctrl/Cmd + wheel zooms (Overleaf gesture); plain wheel scrolls natively.
  // Attached as a non-passive native listener so preventDefault actually
  // suppresses the browser's page-zoom — React's onWheel is passive.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      // Normalize to pixels: some devices/browsers (e.g. Firefox mouse wheels)
      // report deltaY in lines or pages, where a notch is a small count rather
      // than the ~100px trackpads send — without this they'd barely zoom.
      const deltaPx = e.deltaY * (e.deltaMode === 1 ? PX_PER_LINE : e.deltaMode === 2 ? PX_PER_PAGE : 1);
      const step = Math.max(-ZOOM_STEP, Math.min(ZOOM_STEP, -deltaPx * ZOOM_WHEEL_FACTOR));
      // Anchor the zoom under the pointer so it doesn't drift toward the top.
      zoomAnchorY.current = e.clientY - node.getBoundingClientRect().top;
      // A fresh zoom intends to hold its own scroll position again; a new zoom
      // also supersedes any still-running post-commit scroll restore.
      suppressScrollCapture.current = false;
      if (restoreRaf.current != null) {
        cancelAnimationFrame(restoreRaf.current);
        restoreRaf.current = null;
      }
      // Keep the running scale unrounded — quantizing to 2 decimals here would
      // swallow sub-0.005 steps and stall a slow pinch; the label rounds for us.
      setScale((prev) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev + step)));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  // Re-rasterize at the new zoom only once the gesture settles; mid-gesture the
  // column transform below scales the rendered canvases on the GPU for instant
  // feedback — re-rendering on every wheel tick strobes the canvases white.
  useEffect(() => {
    if (renderScale === scale) return;
    const t = setTimeout(() => {
      // The previewed size already matches what we're about to re-raster, so
      // hold the exact scroll position across the commit — react-pdf briefly
      // collapses page heights while redrawing, which would clamp us to the top.
      const el = scrollRef.current;
      if (el && !suppressScrollCapture.current) pendingScrollTop.current = el.scrollTop;
      setRenderScale(scale);
    }, 150);
    return () => clearTimeout(t);
  }, [scale, renderScale]);

  // Restore the held scroll position once the re-rastered pages have grown back.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const target = pendingScrollTop.current;
    if (!el || target == null) return;
    pendingScrollTop.current = null;
    let tries = 0;
    const restore = () => {
      el.scrollTop = target;
      restoreRaf.current =
        ++tries < 20 && Math.abs(el.scrollTop - target) > 1 ? requestAnimationFrame(restore) : null;
    };
    restoreRaf.current = requestAnimationFrame(restore);
  }, [renderScale]);

  // Keep the anchor point (pointer for wheel zooms, viewport centre otherwise)
  // fixed as the page scales, so zooming feels centred instead of drifting up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevScale.current;
    prevScale.current = scale;
    if (!el || prev === scale || prev <= 0) return;
    const anchorY = zoomAnchorY.current ?? el.clientHeight / 2;
    el.scrollTop = (el.scrollTop + anchorY) * (scale / prev) - anchorY;
  }, [scale]);

  // Natural (untransformed) height of the page column at the current render
  // scale, so the scroll area can reserve the transformed height and the
  // scrollbar/anchor stay correct during the preview.
  useLayoutEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const measure = () => setColumnHeight(el.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [numPages, baseWidth]);

  const pageWidth = baseWidth > 0 ? baseWidth * renderScale : undefined;
  const zoomPreview = scale / renderScale;
  zoomPreviewRef.current = zoomPreview;

  // Pixel height the page's canvas occupies at the current width, from the
  // last known PDF-point dimensions (the previous document's until the new one
  // reports — recompiles rarely change page geometry). Sizes both the loading
  // skeletons and the wrappers' min-height so layout never depends on the
  // canvas having painted.
  const pageHeightPx = useCallback(
    (page: number) => {
      const dims = pageDimsRef.current.get(page) ?? pageDimsRef.current.get(1);
      if (!dims || dims.width <= 0 || dims.height <= 0 || !pageWidth) return undefined;
      return (pageWidth * dims.height) / dims.width;
    },
    [pageWidth],
  );

  const pages = useMemo(
    () =>
      Array.from({ length: numPages }, (_, index) => {
        const page = index + 1;
        const heightPx = pageHeightPx(page);
        return (
          <div
            key={`${fileUrl}:page-${page}`}
            ref={(node) => {
              pageRefs.current[index] = node;
            }}
            onDoubleClick={onInverseSearch ? (event) => handlePageDoubleClick(page, event) : undefined}
            className={`relative ${PAGE_WRAPPER_CLASS}`}
            style={heightPx !== undefined ? { minHeight: heightPx + VERTICAL_PADDING } : undefined}
          >
            <Page
              pageNumber={page}
              width={pageWidth}
              className="shadow-sm ring-1 ring-stone-200"
              onLoadSuccess={({ originalWidth, originalHeight }) => {
                const prev = pageDimsRef.current.get(page);
                pageDimsRef.current.set(page, { width: originalWidth, height: originalHeight });
                if (!prev || prev.width !== originalWidth || prev.height !== originalHeight) {
                  setDimsVersion((version) => version + 1);
                }
              }}
              renderAnnotationLayer
              renderTextLayer
            />
          </div>
        );
      }),
    // dimsVersion re-derives the min-heights when a page reports new geometry.
    [numPages, pageWidth, fileUrl, onInverseSearch, handlePageDoubleClick, pageHeightPx, dimsVersion],
  );

  // While <Document> reloads after a recompile it renders this fallback instead
  // of the pages. Same-height skeletons keep the scroll height identical, so
  // the browser never clamps scrollTop — that's what preserves the reader's
  // position. Centered "Loading PDF…" only before the first document.
  const loadingFallback =
    numPages > 0 && pageWidth && pageDimsRef.current.size > 0 ? (
      <div data-testid="latex-pdf-skeleton" aria-hidden>
        {Array.from({ length: numPages }, (_, index) => (
          <div key={index} className={PAGE_WRAPPER_CLASS}>
            <div
              className="bg-white shadow-sm ring-1 ring-stone-200"
              style={{ width: pageWidth, height: pageHeightPx(index + 1) }}
            />
          </div>
        ))}
      </div>
    ) : (
      <Spinner label="Loading PDF…" center className="min-h-[200px]" />
    );

  return (
    <div
      data-testid="latex-pdf-viewer"
      data-spec="W1.pdfjs"
      className="flex h-full min-h-[420px] flex-col bg-stone-100/40"
    >
      <div className="flex items-center justify-between gap-2 border-b border-stone-200 bg-white/80 px-2 py-1">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className={ICON_BTN}
            onClick={() => goToPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            title="Previous page"
            aria-label="Previous page"
          >
            <CaretLeftIcon className="h-4 w-4" weight="regular" aria-hidden />
          </button>
          <span className="min-w-[64px] text-center text-xs tabular-nums text-stone-500">
            {numPages ? `${currentPage} / ${numPages}` : '—'}
          </span>
          <button
            type="button"
            className={ICON_BTN}
            onClick={() => goToPage(Math.min(numPages, currentPage + 1))}
            disabled={currentPage >= numPages}
            title="Next page"
            aria-label="Next page"
          >
            <CaretRightIcon className="h-4 w-4" weight="regular" aria-hidden />
          </button>
        </div>
        <div className="flex items-center gap-0.5">
          <a
            href={`${fileUrl}#view=FitH&zoom=page-width`}
            target="_blank"
            rel="noreferrer"
            data-testid="pdf-open-new-tab"
            className="mr-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            title="Open the PDF in a new tab"
            aria-label="Show in PDF"
          >
            <ArrowSquareOutIcon className="h-4 w-4" weight="regular" aria-hidden />
            Show in PDF
          </a>
          <button
            type="button"
            className={ICON_BTN}
            onClick={() => zoomTo(scale - ZOOM_STEP)}
            disabled={scale <= MIN_SCALE}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <MagnifyingGlassMinusIcon className="h-4 w-4" weight="regular" aria-hidden />
          </button>
          <button
            type="button"
            className="rounded-md px-1.5 text-xs tabular-nums text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            onClick={() => zoomTo(1)}
            title="Fit width"
            aria-label="Fit width"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            className={ICON_BTN}
            onClick={() => zoomTo(scale + ZOOM_STEP)}
            disabled={scale >= MAX_SCALE}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <MagnifyingGlassPlusIcon className="h-4 w-4" weight="regular" aria-hidden />
          </button>
          <button
            type="button"
            className={ICON_BTN}
            onClick={() => zoomTo(1)}
            title="Fit width"
            aria-label="Fit width"
          >
            <ArrowsHorizontalIcon className="h-4 w-4" weight="regular" aria-hidden />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="latex-pdf-scroll"
        className="min-h-0 flex-1 overflow-auto py-2"
      >
        <Document
          file={fileUrl}
          onLoadSuccess={onDocumentLoad}
          onLoadError={(error) => {
            loadFailedRef.current = true;
            setLoadError(error.message);
          }}
          loading={loadingFallback}
          error={
            <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-center text-sm text-stone-400">
              {loadError ? `Could not display PDF: ${loadError}` : 'Could not display PDF.'}
            </div>
          }
          noData={null}
        >
          {/* Outer div reserves the transformed height so the scrollbar/anchor
              stay correct; inner column scales all pages uniformly on the GPU
              (no per-page re-raster → no white flicker, no overlap). On zoom-out
              the reserve is shorter than the column's untransformed height, so
              its leftover overflow would leak back into the scroll range (tall
              scrollbar + blank tail). Clip it only once the target scale fits the
              pane (scale ≤ 1) — `overflow: hidden` also clips X, so a zoom-out
              that stays wider than the pane must keep its horizontal scroll. */}
          <div
            style={
              zoomPreview !== 1 && columnHeight
                ? { height: columnHeight * zoomPreview, overflow: zoomPreview < 1 && scale <= 1 ? 'hidden' : undefined }
                : undefined
            }
          >
            <div
              ref={columnRef}
              style={zoomPreview !== 1 ? { transform: `scale(${zoomPreview})`, transformOrigin: 'center top' } : undefined}
            >
              {baseWidth > 0 ? pages : null}
            </div>
          </div>
        </Document>
      </div>
      <span className="sr-only">{`PDF preview for ${texPath}`}</span>
    </div>
  );
}

export default LatexPdfViewer;
