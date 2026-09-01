'use client';

/** The one home-surface header, shared by the web dashboard and the desktop
 *  home so both stay one design: wordmark left, search center, profile (or
 *  sign-in) right. Replaces the marketing <Nav> on these surfaces. Clerk-free
 *  by design — each page supplies its own search box and right-side control,
 *  so the desktop static export can ship it. In the macOS shell the bar
 *  doubles as the window drag strip (`dragRegion`), padded left so the
 *  traffic lights don't overlap the wordmark. */
export function HomeHeader({
  search,
  right,
  version,
  dragRegion = false,
}: {
  search: React.ReactNode;
  right: React.ReactNode;
  version?: string | null;
  dragRegion?: boolean;
}) {
  // A bare/"true" attribute drags only when the mousedown TARGET carries it,
  // so any wrapper covering the strip swallowed the drag. "deep" (tauri ≥2.9)
  // makes the whole subtree draggable while the runtime still exempts
  // clickable tags — buttons, links and the search input keep working.
  const drag = dragRegion ? { 'data-tauri-drag-region': 'deep' } : {};
  return (
    <header
      {...drag}
      className="sticky top-0 z-30 border-b border-stone-200/60 bg-stone-50/90 backdrop-blur"
    >
      <div
        className={`mx-auto flex w-full max-w-6xl items-center gap-4 px-6 py-2.5 ${dragRegion ? 'pl-24' : ''}`}
      >
        {/* Fixed side widths keep the search centered on desktop; on mobile
            they'd crush it into a circle, so both sides shrink to fit. */}
        <span className="flex w-auto shrink-0 items-baseline gap-2 sm:w-44">
          <span className="text-sm font-semibold tracking-tight text-stone-800">☀️ Sundial</span>
          {version ? <span className="font-mono text-[10px] text-stone-400">v{version}</span> : null}
        </span>
        <div className="flex min-w-0 flex-1 justify-center">
          <div className="w-full max-w-xl">{search}</div>
        </div>
        <div className="flex w-auto shrink-0 items-center justify-end gap-3 whitespace-nowrap sm:w-44">{right}</div>
      </div>
    </header>
  );
}
