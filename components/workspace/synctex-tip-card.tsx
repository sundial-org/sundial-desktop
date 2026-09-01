'use client';

/**
 * One-time teaching card for SyncTeX inverse search: the first double-click on
 * the PDF silently scrolls the source editor, which reads as "the app moved me
 * somewhere" to a user who has never met the gesture. Floats over the bottom
 * of the LaTeX column (the AutoFixSuggestionCard pattern; the host column is
 * position:relative), non-blocking, and never returns once dismissed (the
 * page persists the dismissal in localStorage).
 */
export function SyncTexTipCard({ onDismiss }: { onDismiss: () => void }) {
  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);
  return (
    <div
      data-testid="synctex-tip-card"
      role="status"
      className="latex-autofix-card-in absolute bottom-14 left-1/2 z-40 w-max max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-lg border border-stone-200 bg-white px-4 py-3 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.45)]"
    >
      <div className="text-[13px] font-medium text-stone-800">
        Jumped to the source: double-clicking the PDF opens the matching line.
      </div>
      <div className="mt-1 text-[12px] text-stone-500">
        To go the other way, use &ldquo;Show in PDF&rdquo; from the editor ({isMac ? '⌘⌥J' : 'Ctrl+Alt+J'}).
      </div>
      <div className="mt-2 flex items-center justify-end">
        <button
          type="button"
          data-testid="synctex-tip-dismiss"
          onClick={onDismiss}
          className="rounded border border-stone-200 bg-white px-2.5 py-1 text-[12px] font-medium text-stone-700 transition-colors hover:bg-stone-50"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
