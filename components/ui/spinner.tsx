import { CircleNotchIcon } from '@phosphor-icons/react';

// Shared loading affordance — a spinning icon with an optional muted label.
// Replaces ad-hoc "Loading…" text across panels, modals, and dropdowns so the
// app reads as one product. For large surfaces (editors) prefer a skeleton.
// The icon uses currentColor and the label inherits the surrounding font size,
// so a Spinner drops into a chip, a dropdown row, or a full panel and fits in.
export function Spinner({
  label,
  size = 16,
  className,
  center = false,
}: {
  /** Optional muted text shown next to the spinner (e.g. "Loading commits…"). */
  label?: string;
  size?: number;
  className?: string;
  /** Fill and center within the parent box (handy for empty panels). */
  center?: boolean;
}) {
  return (
    <div
      role="status"
      aria-label={label ?? 'Loading'}
      className={`inline-flex items-center gap-2 text-stone-400 ${
        center ? 'h-full w-full justify-center py-8 text-sm' : ''
      } ${className ?? ''}`}
    >
      <CircleNotchIcon size={size} weight="bold" className="animate-spin" aria-hidden />
      {label ? <span>{label}</span> : null}
    </div>
  );
}
