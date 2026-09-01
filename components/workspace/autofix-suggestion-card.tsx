'use client';

/**
 * Floating "enable auto-fix?" card, shown once when a requested fix turn
 * resolves the compile (state machine in use-latex-autofix.ts). It floats
 * centered over the bottom of the LaTeX editor column because the moment
 * arrives tens of seconds after the Fix click, when the user's attention has
 * moved on: a slim inline strip proved invisible in practice. Non-blocking
 * (editing and the PDF stay interactive) and persistent until answered.
 * The host column must be position:relative.
 */
export function AutoFixSuggestionCard({ onAnswer }: { onAnswer: (accepted: boolean) => void }) {
  return (
    <div
      data-testid="compile-autofix-suggestion"
      role="status"
      className="latex-autofix-card-in absolute bottom-14 left-1/2 z-40 w-max max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-lg border border-stone-200 bg-white px-4 py-3 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.45)]"
    >
      <div className="text-[13px] font-medium text-stone-800">
        Fixed. Want the agent to auto-fix future compile errors?
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="compile-autofix-dismiss"
          onClick={() => onAnswer(false)}
          className="rounded px-2 py-1 text-[12px] text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
        >
          No thanks
        </button>
        <button
          type="button"
          data-testid="compile-autofix-accept"
          onClick={() => onAnswer(true)}
          className="rounded border border-indigo-300 bg-white px-2.5 py-1 text-[12px] font-medium text-indigo-700 transition-colors hover:bg-indigo-50"
        >
          Enable auto-fix
        </button>
      </div>
    </div>
  );
}
