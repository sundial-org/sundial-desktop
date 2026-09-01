'use client';

/**
 * The whole-file "Reject all / Accept all" pair — ONE implementation for every
 * editor surface (markdown Tiptap bar, Monaco code/LaTeX overlay). Positioning
 * is the caller's via `className`; this component owns the look, the labels,
 * and the focus contract: `onMouseDown` preventDefault keeps the editor's
 * focus (typing/undo still land there right after) and no `.focus()` call, so
 * the reader's scroll position is never touched.
 */
export function SuggestionReviewBar({
  className,
  onAcceptAll,
  onRejectAll,
}: {
  className: string;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}) {
  return (
    <div className={`${className} flex justify-end gap-1.5`}>
      <button
        type="button"
        data-testid="suggestion-reject-all"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRejectAll}
        className="flex items-center gap-1 rounded-lg border border-[var(--diff-del-border)] bg-white/95 px-2.5 py-1.5 text-xs font-medium text-[var(--diff-del-text)] shadow-sm backdrop-blur transition-colors hover:bg-[var(--diff-del-bg)]"
      >
        <span className="text-sm leading-none">✕</span> Reject all
      </button>
      <button
        type="button"
        data-testid="suggestion-accept-all"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onAcceptAll}
        className="flex items-center gap-1 rounded-lg border border-[var(--diff-add-border)] bg-white/95 px-2.5 py-1.5 text-xs font-medium text-[var(--diff-add-text)] shadow-sm backdrop-blur transition-colors hover:bg-[var(--diff-add-bg)]"
      >
        <span className="text-sm leading-none">✓</span> Accept all
      </button>
    </div>
  );
}
