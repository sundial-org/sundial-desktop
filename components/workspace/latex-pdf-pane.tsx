'use client';

import dynamic from 'next/dynamic';
import { Spinner } from '@/components/ui/spinner';
import type { SyncTexIndex } from '@/lib/latex/synctex';

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
  /** Plain blob URL from useLatexCompile, or null when there's no PDF yet. */
  pdfUrl: string | null;
  /** Parsed SyncTeX index for click-to-source (W4.synctex); optional. */
  synctex?: SyncTexIndex | null;
  onInverseSearch?: (file: string, line: number) => void;
}

function getFileName(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

// Presentational PDF preview. All compile state/triggering lives in
// useLatexCompile + the LaTeX toolbar; failures surface in CompileSummaryBar
// (which keeps the last-good PDF mounted, §1.4). This pane just renders the
// PDF.js viewer and the empty state.
export function LatexPdfPane({ texPath, pdfUrl, synctex, onInverseSearch }: LatexPdfPaneProps) {
  return (
    <div className="flex h-full min-h-[420px] flex-col bg-white">
      <div className="min-h-0 flex-1 bg-stone-100/30">
        {pdfUrl ? (
          <LatexPdfViewer
            fileUrl={pdfUrl}
            texPath={texPath}
            synctex={synctex}
            onInverseSearch={onInverseSearch}
          />
        ) : (
          <div className="flex h-full min-h-[420px] items-center justify-center p-6 text-center">
            <div className="max-w-xs space-y-2 text-sm text-stone-400">
              <p>
                Compile{' '}
                <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-xs text-stone-600">
                  {getFileName(texPath)}
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
