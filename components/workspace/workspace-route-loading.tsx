import { CircleNotchIcon } from '@phosphor-icons/react/dist/ssr';

export function WorkspaceCreationOverlay({ fixed = false }: { fixed?: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`${fixed ? 'fixed z-[60]' : 'absolute'} inset-0 flex items-center justify-center bg-black/15 px-5 backdrop-blur-[1px]`}
    >
      <div
        data-testid="create-workspace-overlay"
        className="w-full max-w-sm rounded-xl border border-stone-300 bg-white p-6 shadow-[0_24px_80px_rgba(0,0,0,0.18)]"
      >
        <div className="mb-5 flex items-center justify-between">
          <span className="rounded-full bg-stone-950 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white">
            Onboarding
          </span>
          <CircleNotchIcon
            className="h-5 w-5 animate-spin text-stone-900 motion-reduce:animate-none"
            weight="bold"
            aria-hidden
          />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-stone-950">Create a workspace</h1>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          Preparing a starter TeX document with one intentional error, ready for your first task with Sunny.
        </p>
        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-stone-200">
          <div className="h-full w-2/3 animate-pulse rounded-full bg-stone-950" />
        </div>
      </div>
    </div>
  );
}

export function WorkspaceRouteLoading({ creating = false }: { creating?: boolean }) {
  return (
    <div className="relative h-screen overflow-hidden bg-white">
      <span role="status" aria-live="polite" className="sr-only">
        {creating ? 'Creating your onboarding workspace…' : 'Loading workspace…'}
      </span>
      <div className="flex h-full" aria-hidden>
        <div className="flex w-12 shrink-0 flex-col items-center gap-4 py-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-6 w-6 rounded-md bg-stone-100" />
          ))}
        </div>
        <div className="hidden w-48 shrink-0 space-y-2 border-r border-stone-100 p-3 md:block">
          <div className="h-8 w-full rounded-md bg-stone-100" />
          <div className="h-5 w-2/3 rounded bg-stone-100" />
        </div>
        <div className="flex flex-1 justify-center bg-stone-50 pt-16">
          <div className="w-full max-w-2xl space-y-4 px-8">
            <div className="h-8 w-1/2 animate-pulse rounded bg-stone-200" />
            <div className="h-4 w-full animate-pulse rounded bg-stone-100" />
            <div className="h-4 w-11/12 animate-pulse rounded bg-stone-100" />
            <div className="h-4 w-4/5 animate-pulse rounded bg-stone-100" />
          </div>
        </div>
        <div className="hidden w-80 shrink-0 border-l border-stone-100 p-4 lg:block">
          <div className="h-6 w-24 rounded bg-stone-100" />
        </div>
      </div>

      {creating ? <WorkspaceCreationOverlay /> : null}
    </div>
  );
}
