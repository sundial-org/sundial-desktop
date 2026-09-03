'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState, type ReactNode } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { LATEX_PANE_HEADER_CLASS } from '@/components/workspace/latex-workbench';
import type { SyncTexIndex } from '@/lib/latex/synctex';
import type {
  PdfCommentHighlight,
  PdfCommentMarker,
  PdfCommentSelection,
  SyncTexJump,
} from '@/components/workspace/latex-pdf-viewer';

// PDF.js is browser-only (worker + canvas + DOM), so load the viewer client-side
// only — it must never run during the server render.
const LatexPdfViewer = dynamic(
  () => import('@/components/workspace/latex-pdf-viewer').then((m) => m.LatexPdfViewer),
  {
    ssr: false,
    loading: () => <Spinner label="Loading PDF…" center className="min-h-[420px]" />,
  },
);

interface LatexPdfPaneProps {
  texPath: string;
  /** The .tex the Compile button actually builds — the root, which is NOT the
   *  open file while the user is inside an \input'd child. Naming the open
   *  child here read as "this fragment compiles standalone". */
  compileRootPath?: string | null;
  /** Plain blob URL from useLatexCompile, or null when there's no PDF yet. */
  pdfUrl: string | null;
  /** Per-file position memory key — must be globally unique (a file id). */
  stateKey?: string;
  /** Parsed SyncTeX index for click-to-source (W4.synctex); optional. */
  synctex?: SyncTexIndex | null;
  onInverseSearch?: (file: string, line: number, word?: string) => void;
  /** Forward search target (§4.2); the viewer scrolls + flashes when it changes. */
  jumpTarget?: SyncTexJump | null;
  /** Leading header cluster (Recompile + view switcher) — rendered by the
   *  viewer's header once it mounts, and by a matching fallback bar over the
   *  empty state AND while the pdf.js chunk loads, so the compile action
   *  never disappears with the PDF. The function form receives `dense` so a
   *  squeezed pane can shed the cluster's diagnostics. */
  headerLeft?: ReactNode | ((opts: { dense: boolean }) => ReactNode);
  /** Hairline on the header's divider-facing edge ('cut' chrome style). */
  headerCut?: boolean;
  /** Comment pins + selection commenting (pdf_comments_enabled); optional. */
  commentMarkers?: PdfCommentMarker[] | null;
  commentHighlights?: PdfCommentHighlight[] | null;
  onMarkerClick?: (threadId: string) => void;
  onCommentSelection?: (selection: PdfCommentSelection) => void;
  /** Continuous scroll sync (see the viewer's props). */
  onViewportScroll?: (pos: { page: number; yPt: number }) => void;
  followTarget?: SyncTexJump | null;
  scrollSyncEnabled?: boolean;
  onToggleScrollSync?: () => void;
}

function getFileName(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

// Presentational PDF preview. All compile state/triggering lives in
// useLatexCompile + the LaTeX toolbar; failures surface in CompileSummaryBar
// (which keeps the last-good PDF mounted, §1.4). This pane just renders the
// PDF.js viewer and the empty state.
export function LatexPdfPane({
  texPath,
  compileRootPath,
  pdfUrl,
  stateKey,
  synctex,
  onInverseSearch,
  jumpTarget,
  headerLeft,
  headerCut,
  commentMarkers,
  commentHighlights,
  onMarkerClick,
  onCommentSelection,
  onViewportScroll,
  followTarget,
  scrollSyncEnabled,
  onToggleScrollSync,
}: LatexPdfPaneProps) {
  // The viewer is a dynamically-imported chunk; until its header actually
  // mounts (and again whenever it unmounts) the pane keeps a fallback bar up,
  // so Recompile + the view switcher never blink out while pdf.js loads.
  const [viewerReady, setViewerReady] = useState(false);
  const handleViewerReady = useCallback((ready: boolean) => setViewerReady(ready), []);
  return (
    <div className="flex h-full min-h-[420px] flex-col bg-white">
      {!viewerReady && headerLeft ? (
        <div
          data-testid="latex-pdf-header"
          className={`${LATEX_PANE_HEADER_CLASS} ${headerCut ? 'border-l' : ''}`}
        >
          <div className="flex min-w-0 items-center">
            {typeof headerLeft === 'function' ? headerLeft({ dense: false }) : headerLeft}
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 bg-stone-100/30">
        {pdfUrl ? (
          <LatexPdfViewer
            fileUrl={pdfUrl}
            // The rendered PDF is the ROOT's build, so its label names the
            // root too — the visible empty state and the sr-only label must
            // not disagree about what compiled.
            texPath={compileRootPath || texPath}
            stateKey={stateKey}
            synctex={synctex}
            onInverseSearch={onInverseSearch}
            jumpTarget={jumpTarget}
            headerLeft={headerLeft}
            headerCut={headerCut}
            onViewerReady={handleViewerReady}
            commentMarkers={commentMarkers}
            commentHighlights={commentHighlights}
            onMarkerClick={onMarkerClick}
            onCommentSelection={onCommentSelection}
            onViewportScroll={onViewportScroll}
            followTarget={followTarget}
            scrollSyncEnabled={scrollSyncEnabled}
            onToggleScrollSync={onToggleScrollSync}
          />
        ) : (
          <div className="flex h-full min-h-[420px] items-center justify-center p-6 text-center">
            <div className="max-w-xs space-y-2 text-sm text-stone-400">
              <p>
                Compile{' '}
                <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-xs text-stone-600">
                  {getFileName(compileRootPath || texPath)}
                </code>{' '}
                to refresh the PDF preview.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
