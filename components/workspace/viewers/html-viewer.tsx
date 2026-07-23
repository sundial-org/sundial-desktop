'use client';

import { useEffect, useRef, useState } from 'react';

// Workspace HTML is untrusted: Sunny, local agents, and any collaborator can
// write these files. The preview therefore runs in an opaque origin —
// `sandbox` WITHOUT `allow-same-origin` — so scripts execute (slide decks
// need JS) but cannot reach our cookies, storage, DOM, or credentialed APIs.
// Never add `allow-same-origin` (with `allow-scripts` on a srcDoc iframe it
// grants the file full XSS on the app origin) or
// `allow-popups-to-escape-sandbox` (the file could open unsandboxed windows
// it controls — a phishing vector). Intended trade-off of the opaque origin:
// storage APIs throw and fetches go out uncredentialed inside the preview,
// so documents relying on them render degraded.
//
// Known limitation: srcDoc has no base URL, so only self-contained
// single-file HTML renders fully — relative references (./style.css,
// ./fig.png) won't resolve. Supporting multi-file documents means serving
// workspace files as inline `text/html` from a SEPARATE sandbox origin
// (a dedicated preview route/domain) and pointing the iframe `src` there.
// Don't reuse /api/workspace/files/download for that: it is same-origin and
// deliberately serves text as a `text/plain` attachment.

const RENDER_DEBOUNCE_MS = 500;
// Ceiling on preview staleness: a trailing-only debounce would starve while
// CRDT edits stream in faster than the window (e.g. Sunny rewriting the file).
const RENDER_MAX_WAIT_MS = 1500;

interface HTMLViewerProps {
  content: string;
  fileName: string;
}

export function HTMLViewer({ content, fileName }: HTMLViewerProps) {
  const [showSource, setShowSource] = useState(false);
  // Debounced (with a max-wait) so live CRDT keystrokes don't reload the
  // document on every edit; Reload applies the latest content at once.
  const [renderedContent, setRenderedContent] = useState(content);
  const [renderNonce, setRenderNonce] = useState(0);
  const lastAppliedAt = useRef<number | null>(null);
  if (lastAppliedAt.current === null) lastAppliedAt.current = Date.now();

  useEffect(() => {
    if (showSource) return; // never reload the document while it's hidden
    const sinceApplied = Date.now() - (lastAppliedAt.current ?? 0);
    const delay = Math.max(0, Math.min(RENDER_DEBOUNCE_MS, RENDER_MAX_WAIT_MS - sinceApplied));
    const timer = setTimeout(() => {
      lastAppliedAt.current = Date.now();
      setRenderedContent(content);
    }, delay);
    return () => clearTimeout(timer);
  }, [content, showSource]);

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-stone-100 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => setShowSource(false)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                !showSource
                  ? 'bg-white text-stone-700 shadow-sm'
                  : 'text-stone-500 hover:text-stone-700'
              }`}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setShowSource(true)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                showSource
                  ? 'bg-white text-stone-700 shadow-sm'
                  : 'text-stone-500 hover:text-stone-700'
              }`}
            >
              Source
            </button>
          </div>
          <button
            type="button"
            title="Reload preview"
            onClick={() => {
              lastAppliedAt.current = Date.now();
              setRenderedContent(content);
              setRenderNonce((n) => n + 1);
            }}
            className="px-2 py-1 text-xs rounded-md text-stone-500 hover:text-stone-700 hover:bg-stone-100 transition-colors"
          >
            ↻ Reload
          </button>
        </div>
        <span className="text-xs text-stone-400">{fileName}</span>
      </div>

      {/* Content — the iframe stays mounted while viewing source (updates
          paused) so the document's state, e.g. the current slide, survives
          the toggle when the content hasn't changed. */}
      {showSource && (
        <div className="border border-stone-200 rounded-xl overflow-hidden bg-stone-900">
          <div className="overflow-x-auto max-h-[65vh] p-4">
            <pre className="text-xs text-stone-300 font-mono whitespace-pre-wrap break-all leading-relaxed">
              {content}
            </pre>
          </div>
        </div>
      )}
      <div
        className={`border border-stone-200 rounded-xl overflow-hidden bg-white ${
          showSource ? 'hidden' : ''
        }`}
      >
        <iframe
          key={renderNonce}
          title={`Preview: ${fileName}`}
          srcDoc={renderedContent}
          sandbox="allow-scripts allow-popups"
          allow="fullscreen"
          referrerPolicy="no-referrer"
          className="w-full border-0"
          style={{ height: '65vh', minHeight: 400 }}
        />
      </div>
    </div>
  );
}
