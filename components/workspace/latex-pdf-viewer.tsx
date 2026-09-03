'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import {
  ArrowsDownUpIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ArrowSquareOutIcon,
  ChatCircleIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from '@phosphor-icons/react';
import { Spinner } from '@/components/ui/spinner';
import { LATEX_ICON_BTN, LATEX_PANE_HEADER_CLASS } from '@/components/workspace/latex-workbench';
import type { SyncTexForwardHit, SyncTexIndex, SyncTexSpan } from '@/lib/latex/synctex';

// PDF.js viewer that replaces the old browser <iframe> preview (spec W1.pdfjs).
// A real text layer (selectable text + SyncTeX anchors), continuous page
// scrolling, page navigation, and independent zoom. Double-click runs SyncTeX
// inverse search (W4.synctex), mapping a PDF point back to the source line;
// `jumpTarget` is the forward direction (§4.2): scroll to a page point, and
// flash it when the reader asked for it explicitly.

/**
 * A forward-search destination; `nonce` makes repeat jumps to one spot re-fire.
 * Every jump is explicit ("Show in PDF" / Ctrl+Alt+J), so it always scrolls and
 * always flashes.
 */
export type SyncTexJump = SyncTexForwardHit & { nonce: number };

/** A comment thread projected onto the PDF (source line → SyncTeX forward). */
export type PdfCommentMarker = {
  id: string;
  page: number;
  /** PDF points from the page top (the thread's source line's baseline). */
  yPt: number;
  active?: boolean;
};

/** A text selection on the PDF, in page + PDF-point coordinates, for the
 *  host to resolve back to source (SyncTeX inverse + quote matching). */
export type PdfCommentSelection = {
  text: string;
  page: number;
  xPt: number;
  yPt: number;
};
/** A thread's rendered material, highlighted over the page (SyncTeX spans). */
export type PdfCommentHighlight = {
  id: string;
  rects: SyncTexSpan[];
  active?: boolean;
};
// Marker pins stacked on one line would cover each other — spread them.
const MARKER_MIN_GAP_PX = 22;
// Highlight box around a span's baseline: ascent above, a little descent below.
const HIGHLIGHT_ASCENT_PT = 9;
const HIGHLIGHT_HEIGHT_PT = 12;
// Height (PDF pt) of the forward-search flash bar, roughly one text line.
const FLASH_HEIGHT_PT = 14;
const FLASH_MS = 1500;
// Budget for a smooth programmatic scroll to land, after which scroll capture
// re-arms (see cancelScrollRestore).
const SMOOTH_SCROLL_MS = 700;
// Keep first-page latency proportional to the bytes PDF.js needs. Supabase's
// signed object URL supports HTTP Range; a server that ignores Range and sends
// 200 still falls back to PDF.js's normal full-response path.
export const PDF_DOCUMENT_OPTIONS = {
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: 128 * 1024,
} as const;

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
// Only pages this close to the viewport rasterize a canvas — a long PDF would
// otherwise queue every canvas at once and wedge the tab. Farther pages mount
// just their text/annotation layers inside height-stable placeholder boxes.
const RENDER_WINDOW = 2;
// Whole-document text/annotation layers are what keep browser find (Ctrl+F),
// links and screen readers working beyond the canvas window — but past this
// page count even canvas-less mounts are too much work, so far pages fall
// back to bare boxes and find covers only the window.
const FULL_TEXT_MAX_PAGES = 150;
const HORIZONTAL_PADDING = 32; // matches the px-4 gutter around each page
const VERTICAL_PADDING = 16; // matches the py-2 gutter around each page
// Shared by the real page wrappers and the loading skeletons — equal heights
// between the two is the invariant that keeps scrollTop stable on recompile.
const PAGE_WRAPPER_CLASS = 'flex justify-center px-4 py-2';

// Shared with the LaTeX toolbar across the chrome seam — the two halves of the
// row must not diverge in rest/hover styling.
const ICON_BTN = LATEX_ICON_BTN;

interface LatexPdfViewerProps {
  /** Blob URL of the compiled PDF. */
  fileUrl: string;
  texPath: string;
  /** Restores scroll/zoom when the same key remounts (per-file memory). */
  stateKey?: string;
  /** Parsed SyncTeX index for click-to-source; null disables the gestures. */
  synctex?: SyncTexIndex | null;
  /** Inverse search: a PDF double-click resolved to a source file + line.
   *  `word` is the text the double-click selected in the PDF's text layer —
   *  the host uses it to snap the jump to the exact word in the source. */
  onInverseSearch?: (file: string, line: number, word?: string) => void;
  /** Forward search: scroll to + flash this page point whenever it changes. */
  jumpTarget?: SyncTexJump | null;
  /** Leading header cluster (Overleaf-style: Recompile + view switcher). The
   *  function form receives `dense` (narrow pane) so the cluster can shed its
   *  diagnostics; without headerLeft the header keeps the plain PDF-preview
   *  layout (nav left, labeled Open in new tab + zoom right, nothing gated). */
  headerLeft?: ReactNode | ((opts: { dense: boolean }) => ReactNode);
  /** Hairline on the header's divider-facing edge ('cut' chrome style). */
  headerCut?: boolean;
  /** Mount signal — the host pane keeps a fallback header up until the
   *  dynamically-imported viewer actually renders, so the compile controls
   *  never vanish while the pdf.js chunk loads. */
  onViewerReady?: (ready: boolean) => void;
  /** Comment pins to project onto the pages (pdf_comments_enabled). */
  commentMarkers?: PdfCommentMarker[] | null;
  /** Highlight rectangles over each thread's commented words. */
  commentHighlights?: PdfCommentHighlight[] | null;
  /** Continuous scroll sync: debounced report of the viewport-top position
   *  (page + PDF pt) as the reader scrolls; silent while a follow lands. */
  onViewportScroll?: (pos: { page: number; yPt: number }) => void;
  /** The editor scrolled — put this page point near the viewport top, with no
   *  flash and no smooth animation (it fires continuously). */
  followTarget?: SyncTexJump | null;
  /** Renders the scroll-sync toggle in the header when provided. */
  scrollSyncEnabled?: boolean;
  onToggleScrollSync?: () => void;
  /** A comment pin was clicked — the host selects that thread in the lane. */
  onMarkerClick?: (threadId: string) => void;
  /** Text was selected and "Comment" clicked — the host anchors it in source.
   *  Presence of this prop is what enables the selection bubble. */
  onCommentSelection?: (selection: PdfCommentSelection) => void;
}

type PageDims = { width: number; height: number };

// Last viewing position per stateKey. Remounts are how a file switch resets
// geometry, so position memory has to live outside the component.
const viewerStateCache = new Map<string, { scrollTop: number; scale: number }>();
// The forward-search target already acted on. Module-level on purpose: an
// explicit jump from Source mode MOUNTS the viewer with the target already
// set, so per-instance bookkeeping could not tell that first legitimate jump
// apart from a remount replaying a stale one. Only one viewer is mounted at a
// time (the workbench's panes are mutually exclusive).
let consumedJump: SyncTexJump | null = null;

// One page wrapper. Memoized so per-page events (a page reporting dimensions,
// a canvas finishing its raster, the render window sliding) re-render only the
// affected slots instead of every page in the document.
const PdfPageSlot = memo(function PdfPageSlot({
  page,
  index,
  pageWidth,
  heightPx,
  inWindow,
  mountText,
  painted,
  flashStyle,
  markers,
  highlightRects,
  onDoubleClick,
  onMarkerClick,
  onPageLoad,
  onPainted,
  registerRef,
}: {
  page: number;
  index: number;
  pageWidth: number | undefined;
  heightPx: number | undefined;
  inWindow: boolean;
  mountText: boolean;
  painted: boolean;
  flashStyle: CSSProperties | null;
  markers: Array<{ id: string; top: number; active: boolean }> | null;
  highlightRects: Array<{ key: string; active: boolean; left: number; top: number; width: number; height: number }> | null;
  onDoubleClick: ((page: number, event: React.MouseEvent<HTMLDivElement>) => void) | null;
  onMarkerClick: ((threadId: string) => void) | null;
  onPageLoad: (page: number, dims: { originalWidth: number; originalHeight: number }) => void;
  onPainted: (page: number) => void;
  registerRef: (index: number, node: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={(node) => registerRef(index, node)}
      onDoubleClick={onDoubleClick ? (event) => onDoubleClick(page, event) : undefined}
      className={`relative ${PAGE_WRAPPER_CLASS}`}
      style={heightPx !== undefined ? { minHeight: heightPx + VERTICAL_PADDING } : undefined}
    >
      {inWindow ? (
        // The backdrop box shows (identical to a skeleton) until the
        // canvas has painted once, then the page fades in — without it a
        // fresh canvas pops from blank white.
        <div className="relative">
          <div aria-hidden className="absolute inset-0 bg-white shadow-sm ring-1 ring-stone-200" />
          <div
            data-testid={`pdf-page-fade-${page}`}
            className={`relative transition-opacity duration-150 ${painted ? 'opacity-100' : 'opacity-0'}`}
          >
            <Page
              pageNumber={page}
              width={pageWidth}
              className="shadow-sm ring-1 ring-stone-200"
              onLoadSuccess={(dims) => onPageLoad(page, dims)}
              onRenderSuccess={() => onPainted(page)}
              renderAnnotationLayer
              renderTextLayer
            />
          </div>
        </div>
      ) : (
        // Out-of-window pages skip the canvas raster: text and
        // annotation layers still mount (up to FULL_TEXT_MAX_PAGES) so
        // browser find, screen readers and links cover the whole
        // document. The layers are absolutely positioned, so the sized
        // box stands in for the canvas.
        <div
          data-testid={`pdf-page-placeholder-${page}`}
          className="relative overflow-hidden bg-white shadow-sm ring-1 ring-stone-200"
          style={{ width: pageWidth, height: heightPx }}
        >
          {mountText ? (
            <Page
              pageNumber={page}
              width={pageWidth}
              renderMode="none"
              // Without a canvas the Page box collapses (its layers are
              // absolute) — pin it to the sized placeholder instead, so
              // the text layer spans land where the page renders.
              className="!absolute inset-0"
              onLoadSuccess={(dims) => onPageLoad(page, dims)}
              renderAnnotationLayer
              renderTextLayer
            />
          ) : null}
        </div>
      )}
      {flashStyle ? (
        // Forward-search flash: a fading bar across the page at the
        // target line. pt→px uses the page's own width, so it rides the
        // zoom preview transform with the canvas.
        <div
          data-testid="pdf-synctex-flash"
          aria-hidden
          className="stx-line-flash pointer-events-none absolute z-10 rounded-sm"
          style={flashStyle}
        />
      ) : null}
      {highlightRects?.map((rect) => (
        // Commented material, tinted like the editor's comment ranges. Never
        // intercepts the pointer: text selection under it keeps working.
        <div
          key={rect.key}
          data-testid={`pdf-comment-highlight-${rect.key}`}
          aria-hidden
          className={`pointer-events-none absolute z-[5] rounded-[2px] ${
            rect.active ? 'bg-amber-400/45' : 'bg-amber-300/30'
          }`}
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ))}
      {markers?.map((marker) => (
        // Comment pin at the page's right edge, level with its source line's
        // projected position (same pt→px basis as the flash bar).
        <button
          key={marker.id}
          type="button"
          data-testid={`pdf-comment-marker-${marker.id}`}
          onClick={onMarkerClick ? () => onMarkerClick(marker.id) : undefined}
          title="Open comment"
          aria-label="Open comment"
          className={`absolute z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border shadow-sm transition-colors ${
            marker.active
              ? 'border-amber-400 bg-amber-100 text-amber-700'
              : 'border-stone-200 bg-white text-stone-500 hover:border-amber-300 hover:text-amber-700'
          }`}
          style={{ top: marker.top, right: 2 }}
        >
          <ChatCircleIcon className="h-4 w-4" weight={marker.active ? 'fill' : 'regular'} aria-hidden />
        </button>
      ))}
    </div>
  );
});

export function LatexPdfViewer({
  fileUrl,
  texPath,
  stateKey,
  synctex,
  onInverseSearch,
  jumpTarget,
  headerLeft,
  headerCut = false,
  onViewerReady,
  commentMarkers,
  commentHighlights,
  onMarkerClick,
  onCommentSelection,
  onViewportScroll,
  followTarget,
  scrollSyncEnabled,
  onToggleScrollSync,
}: LatexPdfViewerProps) {
  const [savedState] = useState(() => (stateKey ? viewerStateCache.get(stateKey) : undefined));
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(savedState?.scale ?? 1);
  // renderScale lags scale: the canvas only re-rasterizes once a zoom gesture
  // settles, while scale drives an instant CSS transform (see below).
  const [renderScale, setRenderScale] = useState(savedState?.scale ?? 1);
  const [baseWidth, setBaseWidth] = useState(0);
  // renderWidth lags baseWidth the same way renderScale lags scale: a divider
  // drag fires a ResizeObserver tick per pixel, and feeding each one into the
  // <Page> width re-rasterizes every canvas — strobing them white. The CSS
  // preview stretches the current raster until the resize settles.
  const [renderWidth, setRenderWidth] = useState(0);
  // Pages whose canvas has painted at least once — fresh canvases fade in
  // instead of popping from a blank white box.
  const paintedPagesRef = useRef<Set<number>>(new Set());
  const [paintVersion, setPaintVersion] = useState(0);
  const [columnHeight, setColumnHeight] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped when a page reports different PDF-point dimensions, so min-heights
  // and skeletons (computed from pageDimsRef during render) re-derive.
  const [dimsVersion, setDimsVersion] = useState(0);
  // The floating "Comment" offer over a settled text selection (see the
  // comment-on-selection effect below). Declared here because handleScroll
  // dismisses it.
  const [selectionBubble, setSelectionBubble] = useState<
    (PdfCommentSelection & { top: number; left: number }) | null
  >(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollTop = useRef<number | null>(null);
  const restoreRaf = useRef<number | null>(null);
  const suppressScrollCapture = useRef(false);
  // Where to anchor the next zoom: the pointer offset within the pane for wheel
  // zooms, or null to use the viewport centre (button/fit zooms).
  const zoomAnchorY = useRef<number | null>(null);
  const prevScale = useRef(savedState?.scale ?? 1);
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
  // Re-armed once the programmatic scroll has landed: leaving capture
  // suppressed would disable position-holding across every later re-raster.
  const suppressReleaseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelScrollRestore = useCallback(() => {
    if (restoreRaf.current != null) cancelAnimationFrame(restoreRaf.current);
    restoreRaf.current = null;
    pendingScrollTop.current = null;
    suppressScrollCapture.current = true;
    if (suppressReleaseRef.current) clearTimeout(suppressReleaseRef.current);
    suppressReleaseRef.current = setTimeout(() => {
      suppressScrollCapture.current = false;
    }, SMOOTH_SCROLL_MS);
  }, []);
  useEffect(
    () => () => {
      if (suppressReleaseRef.current) clearTimeout(suppressReleaseRef.current);
    },
    [],
  );

  // Scroll preservation across a recompile: a fileUrl swap reloads <Document>,
  // and stable-height skeletons keep the browser from clamping scrollTop while
  // it loads. Latch the position anyway (synchronously, while the old pages are
  // still committed) and reapply it after load — the safety net for the rare
  // case where the new layout differs and the position drifted.
  const reloadScrollTopRef = useRef<number | null>(savedState?.scrollTop ?? null);
  // Set while the last load errored: the 200px error fallback collapses the
  // scroll height and the browser clamps scrollTop (firing a scroll event), so
  // scrolls in that window are clamps, not reader intent — don't let them
  // discard the latch holding the last good position.
  const loadFailedRef = useRef(false);
  const prevFileUrlRef = useRef(fileUrl);
  if (prevFileUrlRef.current !== fileUrl) {
    prevFileUrlRef.current = fileUrl;
    loadFailedRef.current = false;
    paintedPagesRef.current = new Set();
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

  // Remember the reading position for this file across remounts (file
  // switches, view-mode toggles). Layout effect: its cleanup still sees the
  // scroll node — passive cleanups run after React detaches refs.
  useLayoutEffect(() => {
    if (!stateKey) return;
    return () => {
      const el = scrollRef.current;
      if (!el) return;
      // In the error state the collapsed fallback clamped scrollTop; the
      // latch still holds the last good position — save that instead.
      const latched = reloadScrollTopRef.current;
      const scrollTop = loadFailedRef.current && latched !== null ? latched : el.scrollTop;
      viewerStateCache.set(stateKey, { scrollTop, scale: prevScale.current });
    };
  }, [stateKey]);

  // Re-rasterize for a new pane width only once the resize settles; the first
  // real measurement commits immediately (there is no raster to preserve yet)
  // and pre-paint, so initial load renders pages in the first painted frame.
  useLayoutEffect(() => {
    if (renderWidth === baseWidth) return;
    if (renderWidth <= 0 || baseWidth <= 0) {
      setRenderWidth(baseWidth);
      return;
    }
    const t = setTimeout(() => {
      // The previewed layout already matches the incoming width (reserve
      // height scales with the preview), so hold the exact scroll position
      // across the re-raster, like the zoom settle below.
      const el = scrollRef.current;
      if (el && !suppressScrollCapture.current) pendingScrollTop.current = el.scrollTop;
      setRenderWidth(baseWidth);
    }, 200);
    return () => clearTimeout(t);
  }, [baseWidth, renderWidth]);

  // Keep the viewport centre anchored while the pane width changes, so the
  // content under the cursor doesn't slide as the column scales.
  const prevBaseWidth = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevBaseWidth.current;
    prevBaseWidth.current = baseWidth;
    if (!el || prev <= 0 || baseWidth <= 0 || prev === baseWidth) return;
    const anchorY = el.clientHeight / 2;
    el.scrollTop = (el.scrollTop + anchorY) * (baseWidth / prev) - anchorY;
  }, [baseWidth]);

  // Continuous scroll sync plumbing: latest callback/geometry in refs so the
  // stable scroll handler can read them; a suppression window so an applied
  // follow (or one just sent) doesn't echo back and forth between panes.
  const onViewportScrollRef = useRef(onViewportScroll);
  onViewportScrollRef.current = onViewportScroll;
  const pageWidthRef = useRef(0);
  const followSuppressUntilRef = useRef(0);
  const viewportReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (viewportReportTimerRef.current) clearTimeout(viewportReportTimerRef.current);
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
    // A scroll moves the selection under the fixed-position bubble — drop it.
    setSelectionBubble(null);
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
    // Scroll-sync report (debounced): the page point sitting at the viewport
    // top, for the host to inverse-map into the editor. Quiet while a follow
    // from the editor side is landing, or the panes would chase each other.
    if (onViewportScrollRef.current && Date.now() >= followSuppressUntilRef.current) {
      if (viewportReportTimerRef.current) clearTimeout(viewportReportTimerRef.current);
      viewportReportTimerRef.current = setTimeout(() => {
        viewportReportTimerRef.current = null;
        const report = onViewportScrollRef.current;
        const el = scrollRef.current;
        const pw = pageWidthRef.current;
        if (!report || !el || pw <= 0) return;
        if (Date.now() < followSuppressUntilRef.current) return;
        const preview = zoomPreviewRef.current;
        const probe = el.scrollTop + 8;
        let found: { page: number; yPx: number } | null = null;
        for (let index = 0; index < pageRefs.current.length && !found; index++) {
          const node = pageRefs.current[index];
          if (!node) continue;
          const top = node.offsetTop * preview;
          const height = node.offsetHeight * preview;
          if (probe >= top && probe < top + height) {
            found = { page: index + 1, yPx: (probe - top) / preview - VERTICAL_PADDING / 2 };
          }
        }
        if (!found) return;
        const dims = pageDimsRef.current.get(found.page) ?? pageDimsRef.current.get(1);
        if (!dims || dims.width <= 0) return;
        report({ page: found.page, yPt: Math.max(0, (found.yPx * dims.width) / pw) });
      }, 120);
    }
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

  // Tell the host pane we're mounted (and gone again on unmount) — it keeps a
  // fallback header up while the pdf.js chunk is still loading.
  useLayoutEffect(() => {
    onViewerReady?.(true);
    return () => onViewerReady?.(false);
    // Mount/unmount only; a new callback identity must not re-signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable Document props: `onItemClick` feeds react-pdf's DocumentContext
  // memo — an inline arrow invalidates the context every render and forces
  // every mounted page (canvas/text/annotation layers) to re-render.
  const handleItemClick = useCallback(
    ({ pageNumber }: { pageNumber: number }) => goToPage(pageNumber),
    [goToPage],
  );
  const handleLoadError = useCallback((error: Error) => {
    loadFailedRef.current = true;
    setLoadError(error.message);
  }, []);
  const errorFallback = useMemo(
    () => (
      <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-center text-sm text-stone-400">
        {loadError ? `Could not display PDF: ${loadError}` : 'Could not display PDF.'}
      </div>
    ),
    [loadError],
  );

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
      if (!hit) return;
      // The double-click just word-selected in the text layer — that word is
      // ground truth the SyncTeX line map doesn't have (e.g. the title's
      // records all point at \maketitle, not \title{...}).
      const word = window.getSelection()?.toString().trim() || undefined;
      onInverseSearch(hit.file, hit.line, word);
    },
    [synctex, onInverseSearch],
  );

  // Comment-on-selection (pdf_comments_enabled): after a text-layer selection
  // settles, offer a floating "Comment" button; clicking hands the selected
  // text + its page-point coordinates to the host, which resolves them back to
  // a source range (SyncTeX inverse + quote match) and opens the normal draft.
  useEffect(() => {
    const container = scrollRef.current;
    if (!onCommentSelection || !container) return;
    const readSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const text = sel.toString();
      if (!text.trim()) return null;
      const range = sel.getRangeAt(0);
      const startNode = range.startContainer;
      const startEl = startNode instanceof Element ? startNode : startNode.parentElement;
      if (!startEl || !container.contains(startEl)) return null;
      const pageIndex = pageRefs.current.findIndex((node) => node?.contains(startEl));
      if (pageIndex === -1) return null;
      const page = pageIndex + 1;
      // First child of the wrapper is the page box (canvas tier or placeholder),
      // the same geometry basis the forward-search flash uses.
      const inner = pageRefs.current[pageIndex]?.firstElementChild;
      const dims = pageDimsRef.current.get(page);
      const pageRect = inner?.getBoundingClientRect();
      if (!dims || !pageRect || pageRect.width <= 0) return null;
      const rects = range.getClientRects();
      if (rects.length === 0) return null;
      const first = rects[0];
      const last = rects[rects.length - 1];
      const ptPerPx = dims.width / pageRect.width;
      return {
        text,
        page,
        xPt: (first.left - pageRect.left) * ptPerPx,
        yPt: (first.top + first.height / 2 - pageRect.top) * ptPerPx,
        top: last.bottom + 6,
        left: Math.max(pageRect.left, Math.min(last.right, pageRect.right - 96)),
      };
    };
    // The selection object settles after mouseup — read it on the next tick.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUp = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setSelectionBubble(readSelection()), 0);
    };
    // Collapsing the selection anywhere (click, Escape, typing) hides the offer.
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSelectionBubble(null);
    };
    container.addEventListener('mouseup', onUp);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      if (timer) clearTimeout(timer);
      container.removeEventListener('mouseup', onUp);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [onCommentSelection]);
  const confirmSelectionBubble = useCallback(() => {
    if (!selectionBubble || !onCommentSelection) return;
    const { text, page, xPt, yPt } = selectionBubble;
    onCommentSelection({ text, page, xPt, yPt });
    window.getSelection()?.removeAllRanges();
    setSelectionBubble(null);
  }, [selectionBubble, onCommentSelection]);

  // Forward (source→PDF): scroll the target point to the upper third of the
  // pane and flash a bar across it. The target page may not be mounted yet
  // (pane just un-collapsed, document still loading) — the jump stays pending
  // until its wrapper exists, so re-run whenever pages (re)mount.
  const [flash, setFlash] = useState<SyncTexJump | null>(null);
  const pendingJumpRef = useRef<SyncTexJump | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // A jump is a one-shot command: a remount (file switch and back, mobile
    // pane toggle) still receives the last target, but must not replay it.
    pendingJumpRef.current = jumpTarget && jumpTarget !== consumedJump ? jumpTarget : null;
  }, [jumpTarget]);
  useEffect(() => {
    const jump = pendingJumpRef.current;
    const container = scrollRef.current;
    const inner = pageRefs.current[jump ? jump.page - 1 : -1]?.firstElementChild;
    if (!jump || !container || !inner) return;
    const rect = inner.getBoundingClientRect();
    const dims = pageDimsRef.current.get(jump.page) ?? pageDimsRef.current.get(1);
    // Stay pending (don't consume) until the page reports real geometry: a
    // just-un-collapsed pane mounts its wrappers a commit before the PDF's own
    // dimensions land, and guessing there parks the jump at the page top.
    if (!dims || dims.width <= 0 || rect.width <= 0) return;
    pendingJumpRef.current = null;
    consumedJump = jump;
    const pxPerPt = rect.width / dims.width;
    const yPx = rect.top - container.getBoundingClientRect().top + jump.y * pxPerPt;
    cancelScrollRestore();
    container.scrollTo({ top: container.scrollTop + yPx - container.clientHeight / 3, behavior: 'smooth' });
    setFlash(jump);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), FLASH_MS);
    // paintVersion: a recompile can keep numPages/width/dims identical while
    // <Document> swaps its pages out for the loading fallback and back — the
    // post-swap first paint is then the only signal that the refs repopulated.
  }, [jumpTarget, numPages, renderWidth, dimsVersion, paintVersion, cancelScrollRestore]);
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  // Continuous follow (editor scrolled): place the target near the viewport
  // top instantly — no flash, no smooth animation (it fires per scroll pause),
  // and no viewport report for a beat so the panes don't ping-pong.
  const followConsumedRef = useRef<SyncTexJump | null>(null);
  useEffect(() => {
    const target = followTarget;
    if (!target || target === followConsumedRef.current) return;
    const container = scrollRef.current;
    const inner = pageRefs.current[target.page - 1];
    const dims = pageDimsRef.current.get(target.page) ?? pageDimsRef.current.get(1);
    const pw = pageWidthRef.current;
    if (!container || !inner || !dims || dims.width <= 0 || pw <= 0) return;
    followConsumedRef.current = target;
    const pxPerPt = pw / dims.width;
    const top =
      (inner.offsetTop + VERTICAL_PADDING / 2 + target.y * pxPerPt - 24) * zoomPreviewRef.current;
    followSuppressUntilRef.current = Date.now() + 400;
    cancelScrollRestore();
    container.scrollTop = Math.max(0, top);
  }, [followTarget, numPages, dimsVersion, cancelScrollRestore]);

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
  }, [renderScale, renderWidth]);

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
  }, [numPages, renderWidth]);

  const pageWidth = renderWidth > 0 ? renderWidth * renderScale : undefined;
  pageWidthRef.current = pageWidth ?? 0;
  // Combined CSS preview: zoom gestures scale by scale/renderScale, resizes by
  // baseWidth/renderWidth — both collapse to 1 once the settle commits.
  const zoomPreview = (scale / renderScale) * (renderWidth > 0 ? baseWidth / renderWidth : 1);
  zoomPreviewRef.current = zoomPreview;

  // Pixel height the page's canvas occupies at the current width, from the
  // last known PDF-point dimensions (the previous document's until the new one
  // reports — recompiles rarely change page geometry). Sizes both the loading
  // skeletons and the wrappers' min-height so layout never depends on the
  // canvas having painted.
  const pageHeightPx = useCallback(
    (page: number) => {
      if (!pageWidth) return undefined;
      const dims = pageDimsRef.current.get(page) ?? pageDimsRef.current.get(1);
      // A4 portrait guess until the first page reports real dimensions, so
      // out-of-window placeholders never collapse the scroll height.
      if (!dims || dims.width <= 0 || dims.height <= 0) return pageWidth * Math.SQRT2;
      return (pageWidth * dims.height) / dims.width;
    },
    [pageWidth],
  );

  // A page reporting dimensions used to bump dimsVersion synchronously, which
  // re-rendered EVERY page slot per report — on a 100+ page document that's a
  // quadratic commit storm during load that starves the source editor. One rAF
  // coalesces a burst of reports into a single re-derive.
  const dimsRafRef = useRef<number | null>(null);
  const reportPageDims = useCallback(
    (page: number, { originalWidth, originalHeight }: { originalWidth: number; originalHeight: number }) => {
      const prev = pageDimsRef.current.get(page);
      pageDimsRef.current.set(page, { width: originalWidth, height: originalHeight });
      if (prev && prev.width === originalWidth && prev.height === originalHeight) return;
      if (dimsRafRef.current !== null) return;
      dimsRafRef.current = requestAnimationFrame(() => {
        dimsRafRef.current = null;
        setDimsVersion((version) => version + 1);
      });
    },
    [],
  );
  useEffect(() => () => {
    if (dimsRafRef.current !== null) cancelAnimationFrame(dimsRafRef.current);
  }, []);
  const markPagePainted = useCallback((page: number) => {
    if (paintedPagesRef.current.has(page)) return;
    paintedPagesRef.current.add(page);
    setPaintVersion((version) => version + 1);
  }, []);
  const registerPageRef = useCallback((index: number, node: HTMLDivElement | null) => {
    pageRefs.current[index] = node;
  }, []);

  // Project comment markers into per-page pixel positions (same pt→px basis
  // as the flash bar), spreading pins that would overlap on one line.
  const markersByPage = useMemo(() => {
    if (!commentMarkers?.length || !pageWidth) return null;
    const byPage = new Map<number, Array<{ id: string; top: number; active: boolean }>>();
    const sorted = [...commentMarkers].sort((a, b) => a.page - b.page || a.yPt - b.yPt);
    for (const marker of sorted) {
      const dims = pageDimsRef.current.get(marker.page) ?? pageDimsRef.current.get(1);
      const pxPerPt = pageWidth / (dims?.width || 612);
      let top = VERTICAL_PADDING / 2 + (marker.yPt - 4) * pxPerPt;
      const list = byPage.get(marker.page) ?? [];
      const prev = list[list.length - 1];
      if (prev && top < prev.top + MARKER_MIN_GAP_PX) top = prev.top + MARKER_MIN_GAP_PX;
      list.push({ id: marker.id, top, active: Boolean(marker.active) });
      byPage.set(marker.page, list);
    }
    return byPage;
    // dimsVersion re-derives once pages report real PDF-point dimensions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentMarkers, pageWidth, dimsVersion]);

  // Same pt→px projection for the highlight rectangles over commented words.
  const highlightsByPage = useMemo(() => {
    if (!commentHighlights?.length || !pageWidth) return null;
    const byPage = new Map<
      number,
      Array<{ key: string; active: boolean; left: number; top: number; width: number; height: number }>
    >();
    for (const highlight of commentHighlights) {
      for (let i = 0; i < highlight.rects.length; i++) {
        const rect = highlight.rects[i];
        const dims = pageDimsRef.current.get(rect.page) ?? pageDimsRef.current.get(1);
        const pxPerPt = pageWidth / (dims?.width || 612);
        let list = byPage.get(rect.page);
        if (!list) {
          list = [];
          byPage.set(rect.page, list);
        }
        list.push({
          key: `${highlight.id}:${i}`,
          active: Boolean(highlight.active),
          left: HORIZONTAL_PADDING / 2 + rect.x * pxPerPt,
          top: VERTICAL_PADDING / 2 + (rect.y - HIGHLIGHT_ASCENT_PT) * pxPerPt,
          width: rect.w * pxPerPt,
          height: HIGHLIGHT_HEIGHT_PT * pxPerPt,
        });
      }
    }
    return byPage;
    // dimsVersion re-derives once pages report real PDF-point dimensions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentHighlights, pageWidth, dimsVersion]);

  const pages = useMemo(
    () =>
      Array.from({ length: numPages }, (_, index) => {
        const page = index + 1;
        const flashHere = flash?.page === page && pageWidth ? flash : null;
        return (
          <PdfPageSlot
            key={`${fileUrl}:page-${page}`}
            page={page}
            index={index}
            pageWidth={pageWidth}
            heightPx={pageHeightPx(page)}
            inWindow={Math.abs(page - currentPage) <= RENDER_WINDOW}
            mountText={numPages <= FULL_TEXT_MAX_PAGES}
            painted={paintedPagesRef.current.has(page)}
            flashStyle={
              flashHere && pageWidth
                ? (() => {
                    const dims = pageDimsRef.current.get(page) ?? pageDimsRef.current.get(1);
                    const pxPerPt = pageWidth / (dims?.width || 612);
                    return {
                      left: HORIZONTAL_PADDING / 2,
                      right: HORIZONTAL_PADDING / 2,
                      top: VERTICAL_PADDING / 2 + (flashHere.y - FLASH_HEIGHT_PT * 0.8) * pxPerPt,
                      height: FLASH_HEIGHT_PT * pxPerPt,
                    };
                  })()
                : null
            }
            markers={markersByPage?.get(page) ?? null}
            highlightRects={highlightsByPage?.get(page) ?? null}
            onDoubleClick={onInverseSearch ? handlePageDoubleClick : null}
            onMarkerClick={onMarkerClick ?? null}
            onPageLoad={reportPageDims}
            onPainted={markPagePainted}
            registerRef={registerPageRef}
          />
        );
      }),
    // dimsVersion re-derives the min-heights when a page reports new geometry;
    // currentPage slides the render window as the reader scrolls. Slots are
    // memoized, so only pages whose props actually changed re-render.
    [numPages, pageWidth, fileUrl, onInverseSearch, handlePageDoubleClick, pageHeightPx, dimsVersion, currentPage, paintVersion, flash, markersByPage, highlightsByPage, onMarkerClick, reportPageDims, markPagePainted, registerPageRef],
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
      {/* Pane header. With a compile cluster (headerLeft — the LaTeX
          workbench): cluster leads, nav/zoom close the row, and on narrow
          panes the zoom buttons yield first (the % label still fit-widths),
          then the open-in-new-tab link, then the page nav — the compile
          cluster is the part that must never fold. Without headerLeft (plain
          PDF file preview): the original layout — nav left, labeled Open in
          new tab + zoom right, nothing width-gated. */}
      {(() => {
        const wide = (min: number) => baseWidth === 0 || baseWidth >= min;
        // No pager for a document that cannot be paged (single page, or not
        // yet loaded) — "1 / 1" is pure chrome. The counter reserves width for
        // the document's largest value ("120 / 120") so a growing digit count
        // can't shift Prev/Next under the pointer mid-click.
        const pageNav = numPages <= 1 ? null : (
          <div className="flex shrink-0 items-center gap-0.5">
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
            <span
              style={{ minWidth: `${2 * String(numPages).length + 3}ch` }}
              className="text-center text-xs tabular-nums text-stone-500"
            >
              {`${currentPage} / ${numPages}`}
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
        );
        const zoomOut = (
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
        );
        const fitLabel = (
          <button
            type="button"
            className="rounded-md px-1 text-xs tabular-nums text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            onClick={() => zoomTo(1)}
            title="Fit width"
            aria-label="Fit width"
          >
            {Math.round(scale * 100)}%
          </button>
        );
        const zoomIn = (
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
        );
        const syncToggle = onToggleScrollSync ? (
          <button
            type="button"
            data-testid="pdf-scroll-sync-toggle"
            className={`${ICON_BTN} ${scrollSyncEnabled ? 'bg-stone-200/70 !text-stone-900' : ''}`}
            onClick={onToggleScrollSync}
            aria-pressed={scrollSyncEnabled}
            title={scrollSyncEnabled ? 'Scroll sync on: panes follow each other' : 'Scroll sync off'}
            aria-label="Toggle scroll sync with the source"
          >
            <ArrowsDownUpIcon className="h-4 w-4" weight="regular" aria-hidden />
          </button>
        ) : null;
        const openLink = (withLabel: boolean) => (
          <a
            href={`${fileUrl}#view=FitH&zoom=page-width`}
            target="_blank"
            rel="noreferrer"
            data-testid="pdf-open-new-tab"
            className={
              withLabel
                ? 'mr-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700'
                : ICON_BTN
            }
            title="Open the PDF in a new tab"
            aria-label="Open in new tab"
          >
            <ArrowSquareOutIcon className="h-4 w-4" weight="regular" aria-hidden />
            {withLabel ? 'Open in new tab' : null}
          </a>
        );
        const resolvedHeaderLeft =
          typeof headerLeft === 'function' ? headerLeft({ dense: !wide(560) }) : headerLeft;
        return (
          <div
            data-testid="latex-pdf-header"
            className={`${LATEX_PANE_HEADER_CLASS} ${headerCut ? 'border-l' : ''}`}
          >
            {resolvedHeaderLeft ? (
              <>
                <div className="flex min-w-0 items-center">{resolvedHeaderLeft}</div>
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  {wide(440) ? syncToggle : null}
                  {wide(400) ? pageNav : null}
                  {wide(520) ? zoomOut : null}
                  {wide(340) ? fitLabel : null}
                  {wide(520) ? zoomIn : null}
                  {wide(380) ? openLink(false) : null}
                </div>
              </>
            ) : (
              <>
                {pageNav}
                <div className="flex items-center gap-0.5">
                  {openLink(true)}
                  {zoomOut}
                  {fitLabel}
                  {zoomIn}
                </div>
              </>
            )}
          </div>
        );
      })()}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="latex-pdf-scroll"
        className="min-h-0 flex-1 overflow-auto py-2"
      >
        <Document
          file={fileUrl}
          options={PDF_DOCUMENT_OPTIONS}
          // External PDF links must open a new tab — with the default ('' =
          // same frame) they navigate the app itself away mid-session.
          externalLinkTarget="_blank"
          // Internal links (ToC/cross-refs) scroll via the always-mounted page
          // wrappers — their windowed <Page> target may not be registered.
          onItemClick={handleItemClick}
          onLoadSuccess={onDocumentLoad}
          onLoadError={handleLoadError}
          loading={loadingFallback}
          error={errorFallback}
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
              {renderWidth > 0 ? pages : null}
            </div>
          </div>
        </Document>
      </div>
      {selectionBubble ? (
        // Fixed-position (the root has no transform, so fixed is viewport-
        // relative); mousedown is swallowed so the click keeps the selection.
        <button
          type="button"
          data-testid="pdf-comment-bubble"
          onMouseDown={(event) => event.preventDefault()}
          onClick={confirmSelectionBubble}
          className="fixed z-[70] flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 shadow-md transition-colors hover:border-amber-300 hover:text-amber-700"
          style={{ top: selectionBubble.top, left: selectionBubble.left }}
        >
          <ChatCircleIcon className="h-4 w-4" weight="regular" aria-hidden />
          Comment
        </button>
      ) : null}
      <span className="sr-only">{`PDF preview for ${texPath}`}</span>
    </div>
  );
}

export default LatexPdfViewer;
