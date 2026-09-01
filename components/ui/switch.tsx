'use client';

/** The one switch control for boolean settings and flags — don't hand-roll
 *  another pill toggle. Brand orange when on, neutral track when off, with a
 *  shadowed thumb and a visible keyboard focus ring. */
export function Switch({
  checked,
  onToggle,
  disabled = false,
  ariaLabel,
}: {
  checked: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange disabled:cursor-default disabled:opacity-40 ${
        checked ? 'bg-orange' : 'bg-stone-300 hover:bg-stone-400/70'
      }`}
    >
      <span
        aria-hidden
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-1 ring-stone-900/10 transition-transform duration-200 ease-in-out ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
