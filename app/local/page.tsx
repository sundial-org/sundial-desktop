'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useClerk, useUser } from '@/lib/auth/optional-auth';
import {
  ArrowUpRightIcon,
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  CloudIcon,
  FileIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  GithubLogoIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PushPinIcon,
  UsersIcon,
  type IconProps,
} from '@phosphor-icons/react';
import { HomeHeader } from '@/components/launcher/home-header';
import { LauncherListHeader, LauncherRow } from '@/components/launcher/launcher-row';
import { StarterPackGrid, TemplatesToggle, useTemplatesExpanded } from '@/components/starter-pack-grid';
import { PinButton } from '@/components/launcher/pin-button';
import { ProfileMenu } from '@/components/launcher/profile-menu';
import { ScheduledSection } from '@/components/launcher/scheduled-section';
import { SunnyAnimation } from '@/components/sunny-animation';
import { isDesktopApp, getDesktopVersion, DESKTOP_CREDENTIALS_EVENT } from '@/lib/desktop';
import { getLaunchParam, sidecar } from '@/lib/local/sidecar';
import { useDesktopCredentials } from '@/lib/local/use-desktop-credentials';
import { formatDriveDate } from '@/lib/format';
import { lastOpenedAt, markProjectOpened } from '@/lib/local/recents';
import { localProjectRowLabels } from '@/lib/local/project-label';
import { useLocalProjects } from '@/lib/local/use-local-projects';
import type { StarterPack } from '@/lib/local/starter-packs';
import { getWorkspaceRouteId } from '@/lib/workspace/public-ids';
import { buildWorkspaceChatPath } from '@/lib/workspace/paths';
import { createPinToggleQueue } from '@/lib/workspace/pin-toggle-queue';
import type { VisibleWorkspaceSummary } from '@/lib/workspace/visible-workspaces-shared';
import { ProjectDialog, type ProjectDialogIntent } from './_components/project-dialogs';
import { GuidedOnboarding, useFirstRunOnboarding } from './_components/onboarding';

// /api/launcher payload rows (lib/workspace/launcher-data shapes, declared
// here because that module is server-side and this page ships in the static
// desktop export — the OSS boundary forbids the import, type-only included).
type LauncherProject = { id: string; routeId: string; title: string | null };
type LauncherChat = {
  id: string;
  projectRouteId: string;
  folderLabel: string;
  title: string | null;
  isGroup: boolean;
  pinned: boolean;
};
type LauncherSharedFile = {
  shareId: string;
  path: string;
  kind: 'file' | 'folder';
  workspaceRouteId: string;
  workspaceTitle: string | null;
};

// A first screen you never scroll: a handful of rows at rest, search for the
// rest. Capped hard rather than made scrollable — the hero must not drift.
const TOP_ROWS = 4;
const MAX_RESULTS = 8;

// The same view switcher the web dashboard shows — both homes are one design.
type HomeView = 'recent' | 'pinned' | 'chats' | 'shared' | 'files' | 'scheduled';
const VIEWS: Array<{ id: HomeView; label: string; icon: ComponentType<IconProps> }> = [
  { id: 'recent', label: 'Recent', icon: ClockCounterClockwiseIcon },
  { id: 'pinned', label: 'Pinned', icon: PushPinIcon },
  { id: 'chats', label: 'Chats', icon: ChatCircleIcon },
  { id: 'shared', label: 'Shared with you', icon: UsersIcon },
  // Hidden until any individual file or folder is shared with the user —
  // same rule as the web dashboard.
  { id: 'files', label: 'Shared', icon: FileIcon },
  { id: 'scheduled', label: 'Scheduled', icon: ClockIcon },
];

/** One openable thing on this screen: a local project or a cloud workspace.
 *  Both are searched and keyboard-navigated as one list. */
type LauncherItem = {
  key: string;
  testId: string;
  title: string;
  subtitle: string;
  kind: 'local' | 'cloud';
  href?: string;
  haystack: string;
  open: () => void;
  /** Drive-style row detail, same as the web dashboard: last-opened/updated
   *  date, Owner ("me" or a name) and Location ("Local" / "Cloud" / "Shared
   *  with you") columns. Cloud rows carry their workspace id so the pin
   *  toggle can address them. */
  meta?: string;
  owner?: string;
  location?: string;
  cloudId?: string;
};

function MoreHint({ count, testId, onShow }: { count: number; testId: string; onShow: () => void }) {
  return count > 0 ? (
    <button
      type="button"
      onClick={onShow}
      className="self-start px-1 text-left text-xs text-stone-400 hover:text-stone-600"
      data-testid={testId}
    >
      Show {count} more
    </button>
  ) : null;
}

/** Desktop home: create or open a project on this machine — no sign-in needed
 *  until something is shared. The Tauri shell launches here; its File ▸ Open
 *  Folder… (and the "Open a folder" button below, via the /desktop/open-folder
 *  navigation the shell intercepts) land back with `openPath` in the fragment.
 *  In a plain browser without a sidecar this explains the desktop app instead. */
export default function LocalHomePage() {
  const router = useRouter();
  const { user, isLoaded: authLoaded } = useUser();
  const { openSignIn } = useClerk();
  const { config, projects, defaultLocation, status, error: sidecarError } = useLocalProjects();
  const [isDesktop, setIsDesktop] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [folderInput, setFolderInput] = useState('');
  const [showPathInput, setShowPathInput] = useState(false);
  const [opening, setOpening] = useState(false);
  const [picking, setPicking] = useState(false);
  // The overlay appears only when an open actually takes a moment — a fast
  // open must not flash a one-frame animation.
  const [showOpeningOverlay, setShowOpeningOverlay] = useState(false);
  useEffect(() => {
    if (!opening) {
      setShowOpeningOverlay(false);
      return;
    }
    const timer = setTimeout(() => setShowOpeningOverlay(true), 300);
    return () => clearTimeout(timer);
  }, [opening]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ProjectDialogIntent | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [view, setView] = useState<HomeView>('recent');
  useEffect(() => {
    setIsDesktop(isDesktopApp());
    setVersion(getDesktopVersion());
  }, []);
  const templates = useTemplatesExpanded();
  const ready = status === 'ready';
  const [cloudWorkspaces, setCloudWorkspaces] = useState<VisibleWorkspaceSummary[] | null>(null);
  // Pins and recent chats, same payload the web dashboard shows — the two
  // homes stay one surface. Display-only here: pins are managed on the web.
  const [launcher, setLauncher] = useState<{
    pinnedProjects: LauncherProject[];
    recentChats: LauncherChat[];
    sharedFiles: LauncherSharedFile[];
  } | null>(null);
  // Packaged-app sign-in can live only as sd_ credentials parked in the
  // sidecar (no Clerk session in the webview) — the proxy authenticates
  // /api/* with them, so that state counts as signed in here. But a parked
  // token can be stale (expired/revoked): /agent-credentials still says
  // configured while cloud calls 401 — so a rejected cloud call revokes the
  // signed-in reading and the sign-in affordances come back.
  const desktopCredentials = useDesktopCredentials(config) === true;
  const [credentialsRejected, setCredentialsRejected] = useState(false);
  // Bumped when the desktop sign-in flow lands (possibly different)
  // credentials mid-session — the boolean above wouldn't change, but the
  // workspace list must refetch and a previous rejection no longer applies.
  const [credentialsEpoch, setCredentialsEpoch] = useState(0);
  useEffect(() => {
    const bump = () => {
      setCredentialsRejected(false);
      setCredentialsEpoch((n) => n + 1);
    };
    window.addEventListener(DESKTOP_CREDENTIALS_EVENT, bump);
    return () => window.removeEventListener(DESKTOP_CREDENTIALS_EVENT, bump);
  }, []);
  const signedIn = Boolean(user) || (desktopCredentials && !credentialsRejected);

  // Unified home: local projects AND cloud workspaces on one page — same
  // list the dashboard shows, so nothing is reachable only from there.
  // Keyed on the identity (user id / credential epoch), not just the
  // boolean: switching accounts must not keep the old account's list.
  const userId = user?.id ?? null;
  useEffect(() => {
    // Cleared on every identity change, not just sign-out: a slow or failed
    // refetch after an account switch must not keep rendering the previous
    // account's workspaces.
    setCloudWorkspaces(null);
    setLauncher(null);
    if (!signedIn) return;
    let cancelled = false;
    fetch('/api/workspaces')
      .then((res) => {
        if (res.status === 401 || res.status === 403) {
          // Stale parked credentials (no-op for Clerk sessions — `user`
          // keeps signedIn true regardless).
          if (!cancelled) setCredentialsRejected(true);
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data: { workspaces?: VisibleWorkspaceSummary[] } | null) => {
        if (!cancelled && data) setCloudWorkspaces(data.workspaces ?? []);
      })
      .catch(() => {});
    // Best-effort: an error just leaves the pinned/chats sections hidden (the
    // credential probe above owns the stale-credentials reading).
    fetch('/api/launcher')
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            pinnedProjects?: LauncherProject[];
            recentChats?: LauncherChat[];
            sharedFiles?: LauncherSharedFile[];
          } | null,
        ) => {
          if (!cancelled && data) {
            setLauncher({
              pinnedProjects: data.pinnedProjects ?? [],
              recentChats: data.recentChats ?? [],
              sharedFiles: data.sharedFiles ?? [],
            });
          }
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [signedIn, userId, credentialsEpoch]);

  // Warm the workspace route while the user is still picking: /local/<id> is
  // one shared client bundle, so prefetching any id makes the post-open jump
  // instant instead of a bundle download.
  useEffect(() => {
    router.prefetch(`/local/${projects[0]?.id ?? 'warmup'}`);
  }, [router, projects]);

  const openLocal = useCallback(
    (id: string, filePath?: string) => {
      markProjectOpened(id);
      // A freshly scaffolded pack names the document carrying its "Start here"
      // copy; without it the arrival heuristic opens whatever the pack wrote
      // last. Existing projects pass nothing and keep the heuristic.
      const query = filePath ? `?filePath=${encodeURIComponent(filePath)}` : '';
      router.push(`/local/${id}${query}`);
    },
    [router],
  );

  // Re-runs on hashchange: the shell's folder picker returns by navigating to
  // /local with `openPath` in the FRAGMENT — when we're already here, that's
  // a same-document change (no remount), and picking a folder must still work.
  const [bootNonce, setBootNonce] = useState(0);
  useEffect(() => {
    const rearm = () => setBootNonce((n) => n + 1);
    window.addEventListener('hashchange', rearm);
    return () => window.removeEventListener('hashchange', rearm);
  }, []);
  useEffect(() => {
    void bootNonce;
    // Not `pickedPath` — that pick was for a dialog's Location field, which
    // the dialog consumes itself.
    const openPath = getLaunchParam('openPath');
    if (!config || !openPath) return;
    let cancelled = false;
    setOpening(true);
    setPicking(false);
    sidecar
      .openProject(config, openPath)
      // `cancelled` guards a same-document re-pick: a second folder chosen
      // before this resolves re-arms the effect, and the stale completion
      // must not navigate (or report) over the newer pick.
      .then(({ project }) => {
        if (cancelled) return;
        markProjectOpened(project.id);
        router.replace(`/local/${project.id}`);
      })
      .catch((err) => {
        if (cancelled) return;
        setOpening(false);
        setError(err instanceof Error ? err.message : 'Failed to open folder');
      });
    return () => {
      cancelled = true;
    };
  }, [bootNonce, config, router]);

  const openFolder = useCallback(
    async (root: string) => {
      if (!config || !root.trim()) return;
      setError(null);
      setOpening(true);
      try {
        const { project } = await sidecar.openProject(config, root.trim());
        openLocal(project.id);
      } catch (err) {
        setOpening(false);
        setError(err instanceof Error ? err.message : 'Failed to open folder');
      }
    },
    [config, openLocal],
  );

  // The native picker lives outside the DOM; a launcher auto-update can't
  // see it (older shells announce updates mid-picker). Busy from the click
  // until the open takes over (the openPath effect clears it in the same
  // commit it raises `opening`) or, on cancel, a beat after the window
  // regains focus — the beat lets a chosen folder's fragment land first.
  useEffect(() => {
    if (!picking) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFocus = () => {
      timer = setTimeout(() => setPicking(false), 1000);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [picking]);
  const pickFolder = useCallback(() => {
    if (isDesktop) {
      // Marker navigation: the Tauri shell cancels it and opens the native
      // folder picker (same flow as File ▸ Open Folder…, ⌘O).
      setPicking(true);
      window.location.assign('/desktop/open-folder');
      return;
    }
    setShowPathInput(true);
  }, [isDesktop]);

  const openPack = useCallback((pack: StarterPack | null) => {
    setError(null);
    setDialog({ kind: 'create', pack });
  }, []);

  const onboardingActions = useMemo(
    () => ({
      // "Show me the templates" expands the grid the home already renders,
      // rather than a second copy of it inside the cards.
      onTemplate: () => templates.open(),
      onOpenFolder: pickFolder,
      onBlank: () => openPack(null),
      ready,
    }),
    [openPack, pickFolder, ready],
  );

  const items = useMemo<LauncherItem[]>(
    () => [
      ...projects.map((project) => {
        const labels = localProjectRowLabels(project);
        return {
          key: `local-${project.id}`,
          testId: `local-recent-${project.name}`,
          ...labels,
          kind: 'local' as const,
          // Search over what the row SHOWS (title covers the derived
          // "Workspace" label, subtitle covers root + mount count).
          haystack: `${labels.title} ${labels.subtitle}`.toLowerCase(),
          open: () => openLocal(project.id),
          meta: formatDriveDate(lastOpenedAt(project.id, project.created_at)),
          owner: 'me',
          location: 'Local',
        };
      }),
      ...(cloudWorkspaces ?? []).map((workspace) => {
        const href = `/w/${getWorkspaceRouteId(workspace)}`;
        const mine = workspace.role === 'owner';
        return {
          key: `cloud-${workspace.id}`,
          testId: `local-cloud-${workspace.id}`,
          title: workspace.title || 'Untitled workspace',
          subtitle: mine ? 'Your workspace' : 'Shared with you',
          kind: 'cloud' as const,
          href,
          haystack: (workspace.title || 'Untitled workspace').toLowerCase(),
          open: () => router.push(href),
          meta: workspace.updated_at ? formatDriveDate(workspace.updated_at) : undefined,
          owner: mine ? 'me' : workspace.ownerName ?? '',
          location: mine ? 'Cloud' : 'Shared with you',
          cloudId: workspace.id,
        };
      }),
    ],
    [projects, cloudWorkspaces, openLocal, router],
  );

  // First run: nothing to open and never onboarded. Signed-in homes wait for
  // the cloud list too, so a user with workspaces never sees a flash of cards.
  // `authLoaded` gates that: while Clerk is still loading, `user` is null and
  // `signedIn` reads false, which would resolve an empty count before the
  // cloud fetch even starts (Codex P2).
  const onboarding = useFirstRunOnboarding({
    resolved: ready && authLoaded && (!signedIn || cloudWorkspaces !== null),
    itemCount: items.length,
  });

  // Pins, same PATCH (and same serializing queue) the web dashboard uses —
  // the packaged app reaches the API through the sidecar's authenticated
  // proxy. The queue orders rapid toggles per project and rolls back to the
  // last server-acknowledged state on failure.
  const pinnedCloudIds = useMemo(
    () => new Set((launcher?.pinnedProjects ?? []).map((p) => p.id)),
    [launcher],
  );
  const [pinQueue] = useState(createPinToggleQueue);
  // Last-seen PINNED row per project: a pinned public non-member workspace
  // exists only in the launcher payload (never in /api/workspaces), and by
  // rollback time the optimistic update has already removed it from state.
  const pinnedRowCache = useRef(new Map<string, LauncherProject>());
  const toggleCloudPin = useCallback(
    (projectId: string, pinned: boolean) => {
      const known = launcher?.pinnedProjects.find((p) => p.id === projectId);
      if (known) pinnedRowCache.current.set(projectId, known);
      const apply = (nextPinned: boolean) =>
        setLauncher((prev) => {
          if (!prev) return prev;
          const rest = prev.pinnedProjects.filter((p) => p.id !== projectId);
          if (!nextPinned) return { ...prev, pinnedProjects: rest };
          const workspace = cloudWorkspaces?.find((w) => w.id === projectId);
          const row = workspace
            ? { id: workspace.id, routeId: getWorkspaceRouteId(workspace), title: workspace.title }
            : pinnedRowCache.current.get(projectId) ?? null;
          return row ? { ...prev, pinnedProjects: [row, ...rest] } : prev;
        });
      pinQueue.toggle(
        `project:${projectId}`,
        pinned,
        () =>
          fetch('/api/workspace/pins', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, pinned }),
          }).then((res) => res.ok),
        apply,
      );
    },
    [launcher, cloudWorkspaces, pinQueue],
  );

  // Search is purely client-side: the packaged app has no /api/search, and the
  // whole list is already in memory.
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(-1);
  // Truncated sections expand in place on "Show N more"; a new search
  // re-truncates its results.
  const [showAll, setShowAll] = useState<{
    local?: boolean;
    cloud?: boolean;
    search?: boolean;
    pinned?: boolean;
    chats?: boolean;
  }>({});
  useEffect(() => {
    setCursor(-1);
    setShowAll((prev) => (prev.search ? { ...prev, search: false } : prev));
  }, [query]);
  const needle = query.trim().toLowerCase();
  const matched = needle ? items.filter((item) => item.haystack.includes(needle)) : items;
  const localItems = matched.filter((item) => item.kind === 'local');
  const cloudItems = matched.filter((item) => item.kind === 'cloud');
  const visible = needle
    ? matched.slice(0, showAll.search ? matched.length : MAX_RESULTS)
    : [
        ...localItems.slice(0, showAll.local ? localItems.length : TOP_ROWS),
        ...cloudItems.slice(0, showAll.cloud ? cloudItems.length : TOP_ROWS),
      ];
  const visibleLocal = visible.filter((item) => item.kind === 'local');
  const visibleCloud = visible.filter((item) => item.kind === 'cloud');
  const activeKey = visible[cursor]?.key;

  const onSearchKey = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        setQuery('');
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setCursor((current) =>
          visible.length === 0 ? -1 : Math.min(Math.max(current + step, 0), visible.length - 1),
        );
        return;
      }
      // Enter with nothing highlighted opens the top match — but only when the
      // user actually searched; an empty box must not fire on a stray Enter.
      if (event.key === 'Enter' && (cursor >= 0 || needle)) visible[Math.max(cursor, 0)]?.open();
    },
    [cursor, needle, visible],
  );

  const renderRow = (item: LauncherItem) => (
    <LauncherRow
      key={item.key}
      kind={item.kind}
      title={item.title}
      subtitle={item.subtitle}
      href={item.href}
      onClick={item.href ? undefined : item.open}
      active={item.key === activeKey}
      testId={item.testId}
      meta={item.meta}
      owner={item.owner}
      location={item.location}
      accessory={
        // Pins need the launcher payload (signed-in, /api reachable) — until
        // it loads there is no pin state to toggle against.
        item.cloudId && launcher ? (
          <PinButton
            pinned={pinnedCloudIds.has(item.cloudId)}
            onToggle={() => toggleCloudPin(item.cloudId!, !pinnedCloudIds.has(item.cloudId!))}
            label={pinnedCloudIds.has(item.cloudId) ? 'Unpin folder' : 'Pin folder'}
            testId={`local-pin-${item.cloudId}`}
          />
        ) : undefined
      }
    />
  );

  // The header's centered search — same placement as the web dashboard. Kept
  // mounted (disabled) while the sidecar comes up, so the bar doesn't reflow
  // on every launch. Purely client-side: the packaged app has no /api/search
  // and the whole list is already in memory.
  const searchBox = (
    <div className="relative">
      <MagnifyingGlassIcon
        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
        aria-hidden
      />
      <input
        className="w-full rounded-full border border-stone-200 bg-white py-2 pl-10 pr-4 text-sm text-stone-800 shadow-sm outline-none placeholder:text-stone-400 focus:border-stone-400 disabled:opacity-50"
        placeholder="Search projects and workspaces"
        aria-label="Search projects and workspaces"
        value={query}
        // Only while the sidecar is still coming up: a dead sidecar must
        // still let a signed-in user find a cloud workspace.
        disabled={status === 'checking'}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onSearchKey}
        data-testid="local-search"
      />
    </div>
  );

  // No isLoaded gate: in the packaged app clerk-js never loads, so it would
  // pin the header to "Sign in" even with sd_ credentials.
  const headerRight = signedIn ? (
    <>
      {/* Desktop: cloud workspaces are inline below — a dashboard link would
          just bounce back here (see app/dashboard's redirect). The link also
          needs a real Clerk session, which sidecar-credential sign-ins don't
          have. */}
      {!isDesktop && user ? (
        <Link href="/dashboard" className="flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
          Cloud workspaces <ArrowUpRightIcon className="h-3.5 w-3.5" aria-hidden />
        </Link>
      ) : null}
      {/* Same avatar + dropdown as the web dashboard. On sidecar-credential
          sign-ins there is no Clerk user — the menu shows a generic avatar
          and hides sign-out (credentials live in the sidecar). */}
      <ProfileMenu />
    </>
  ) : (
    <button
      type="button"
      className="text-sm text-stone-500 hover:text-stone-800"
      onClick={() => openSignIn?.({ forceRedirectUrl: '/local' })}
      data-testid="local-sign-in"
    >
      Sign in
    </button>
  );

  const sharedWorkspaces = (cloudWorkspaces ?? []).filter((w) => w.role !== 'owner');

  return (
    <div className="flex min-h-screen flex-col bg-stone-50 text-stone-800" aria-busy={opening || picking || undefined}>
      {/* Opening a folder can take seconds (first scan of a big tree) — the
          inline button label alone reads as "nothing happened". */}
      {showOpeningOverlay ? (
        <div
          data-testid="local-opening-overlay"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-stone-50/90 backdrop-blur-sm"
        >
          <SunnyAnimation name="files" className="h-32 w-32 object-contain" />
          <p className="text-sm font-medium text-stone-700">Opening folder…</p>
        </div>
      ) : null}
      {/* In the macOS shell the header doubles as the window drag strip. */}
      <HomeHeader dragRegion={isDesktop} version={version} search={searchBox} right={headerRight} />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-8">
        {status === 'missing' && !isDesktop ? (
          <div className="my-auto flex flex-col items-center gap-3 text-center">
            <FolderSimpleIcon className="h-10 w-10 text-stone-400" weight="duotone" aria-hidden />
            <h1 className="text-xl font-semibold">Local projects live in the desktop app</h1>
            <p className="max-w-md text-sm text-stone-500">
              Sundial Desktop opens any folder on your computer as a project. Files stay on your
              machine and upload only when you explicitly share them. In the browser, use a cloud
              workspace instead.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <Link
                href="/download"
                className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
              >
                Get the desktop app
              </Link>
              <Link href="/dashboard" className="text-sm text-stone-600 underline underline-offset-4">
                Open cloud workspaces
              </Link>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-8 sm:flex-row">
            {/* View switcher — same rail as the web dashboard. */}
            <aside className="w-full shrink-0 sm:w-48">
              {/* Same dropdown contract as the web dashboard's New project:
                  the button offers every way in (folder, GitHub, blank)
                  instead of silently creating a blank project. */}
              <div className="relative mb-4">
                <button
                  type="button"
                  onClick={() => setShowNewMenu((v) => !v)}
                  disabled={!ready}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm font-medium text-stone-800 shadow-sm transition-colors hover:border-stone-300 hover:bg-stone-100/60 disabled:opacity-50 sm:justify-start"
                  data-testid="local-new-project"
                >
                  <PlusIcon className="h-4 w-4" aria-hidden />
                  New project
                </button>
                {showNewMenu ? (
                  <>
                    <button
                      type="button"
                      aria-label="Close menu"
                      onClick={() => setShowNewMenu(false)}
                      className="fixed inset-0 z-10 cursor-default"
                    />
                    <div className="absolute left-0 top-full z-20 mt-1 w-full min-w-48 overflow-hidden rounded-xl border border-stone-200 bg-white py-1 shadow-lg">
                      <button
                        type="button"
                        data-testid="local-new-open-folder"
                        onClick={() => {
                          setShowNewMenu(false);
                          pickFolder();
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                      >
                        <FolderOpenIcon className="h-4 w-4 text-stone-500" aria-hidden />
                        Open folder…
                      </button>
                      <button
                        type="button"
                        data-testid="local-new-from-repo"
                        onClick={() => {
                          setShowNewMenu(false);
                          setDialog({ kind: 'clone' });
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                      >
                        <GithubLogoIcon className="h-4 w-4 text-stone-700" weight="fill" aria-hidden />
                        Clone from GitHub…
                      </button>
                      <button
                        type="button"
                        data-testid="local-new-blank"
                        onClick={() => {
                          setShowNewMenu(false);
                          openPack(null);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                      >
                        <FileIcon className="h-4 w-4 text-stone-500" aria-hidden />
                        Blank project
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
              <nav className="flex flex-row flex-wrap gap-1 sm:flex-col">
                {VIEWS.filter(({ id }) => id !== 'files' || (launcher?.sharedFiles.length ?? 0) > 0).map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    data-testid={`view-${id}`}
                    onClick={() => setView(id)}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      view === id
                        ? 'bg-stone-200/70 font-medium text-stone-900'
                        : 'text-stone-600 hover:bg-stone-200/40'
                    }`}
                  >
                    <Icon
                      className="h-4 w-4 shrink-0 text-stone-500"
                      weight={view === id ? 'fill' : 'regular'}
                      aria-hidden
                    />
                    {label}
                  </button>
                ))}
              </nav>
            </aside>

            <section className="flex min-w-0 flex-1 flex-col gap-6">
              {status === 'missing' ? (
                <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900">
                  The local service isn&apos;t responding. Quit and reopen Sundial; if this keeps
                  happening, make sure nothing else is using its port.
                  {sidecarError && <span className="mt-1 block font-mono text-xs opacity-70">{sidecarError}</span>}
                </div>
              ) : needle ? (
                <div className="flex flex-col gap-1.5" data-testid="local-results">
                  {visible.map(renderRow)}
                  {visible.length === 0 && (
                    <p className="px-1 text-sm text-stone-400" data-testid="local-no-matches">
                      No matches.
                    </p>
                  )}
                  <MoreHint
                    count={matched.length - visible.length}
                    testId="local-more"
                    onShow={() => setShowAll((prev) => ({ ...prev, search: true }))}
                  />
                </div>
              ) : view === 'recent' ? (
                <>
                  {/* First run only: the guided cards sit ABOVE the action row,
                      they never replace it. */}
                  {onboarding.show ? (
                    <GuidedOnboarding actions={onboardingActions} onDismiss={onboarding.dismiss} />
                  ) : null}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                    <TemplatesToggle
                      expanded={templates.expanded}
                      onToggle={templates.toggle}
                      disabled={!ready}
                      testId="local-templates-toggle"
                    />
                    <button
                      type="button"
                      onClick={pickFolder}
                      disabled={!ready}
                      className="flex items-center gap-1.5 font-medium text-stone-700 hover:text-stone-900 disabled:opacity-50"
                      data-testid="local-pick-folder"
                    >
                      <FolderOpenIcon className="h-4 w-4" aria-hidden />
                      {opening ? 'Opening…' : status === 'checking' ? 'Connecting…' : 'Open folder'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDialog({ kind: 'clone' })}
                      disabled={!ready}
                      className="flex items-center gap-1.5 font-medium text-stone-700 hover:text-stone-900 disabled:opacity-50"
                      data-testid="local-clone-github"
                    >
                      <GithubLogoIcon className="h-4 w-4" aria-hidden />
                      Clone from GitHub
                    </button>
                    <button
                      type="button"
                      onClick={() => openPack(null)}
                      disabled={!ready}
                      className="flex items-center gap-1.5 font-medium text-stone-700 hover:text-stone-900 disabled:opacity-50"
                      data-testid="local-blank-project"
                    >
                      <PlusIcon className="h-4 w-4" aria-hidden />
                      Blank project
                    </button>
                  </div>

                  {templates.expanded && (
                    <StarterPackGrid disabled={!ready} onSelect={openPack} />
                  )}

                  {(showPathInput || !isDesktop) && ready && (
                    <form
                      className="flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void openFolder(folderInput);
                      }}
                    >
                      <input
                        className="flex-1 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm outline-none focus:border-stone-400"
                        placeholder="/Users/you/path/to/folder"
                        value={folderInput}
                        onChange={(event) => setFolderInput(event.target.value)}
                        data-testid="local-folder-input"
                      />
                      <button
                        type="submit"
                        className="rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
                        data-testid="local-open-folder"
                      >
                        Open
                      </button>
                    </form>
                  )}
                  {error && <p className="text-sm text-red-600">{error}</p>}

                  {localItems.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-400">
                        <FolderSimpleIcon className="h-3.5 w-3.5" aria-hidden /> On this computer
                      </span>
                      <div className="flex flex-col gap-1.5">
                        {visibleLocal.map(renderRow)}
                      </div>
                      <MoreHint
                        count={localItems.length - visibleLocal.length}
                        testId="local-more-recent"
                        onShow={() => setShowAll((prev) => ({ ...prev, local: true }))}
                      />
                    </div>
                  )}

                  {cloudItems.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-400">
                        <CloudIcon className="h-3.5 w-3.5" aria-hidden /> In the cloud
                      </span>
                      <div className="flex flex-col gap-1.5">
                        {visibleCloud.map(renderRow)}
                      </div>
                      <MoreHint
                        count={cloudItems.length - visibleCloud.length}
                        testId="local-more-cloud"
                        onShow={() => setShowAll((prev) => ({ ...prev, cloud: true }))}
                      />
                    </div>
                  )}

                  {isDesktop && !signedIn && projects.length > 0 && (
                    <button
                      type="button"
                      className="self-start text-sm text-stone-400 underline underline-offset-4 hover:text-stone-600"
                      onClick={() => openSignIn?.({ forceRedirectUrl: '/local' })}
                    >
                      Sign in to see your cloud workspaces
                    </button>
                  )}
                </>
              ) : view === 'pinned' ? (
                <div className="flex flex-col gap-1.5" data-testid="local-pinned-view">
                  {(launcher?.pinnedProjects.length ?? 0) === 0 ? (
                    <p className="px-1 text-sm text-stone-400">
                      {signedIn ? 'Nothing pinned yet.' : 'Sign in to see your pins.'}
                    </p>
                  ) : (
                    launcher!.pinnedProjects.map((project) => (
                      <LauncherRow
                        key={`pin-${project.id}`}
                        kind="cloud"
                        title={project.title || 'Untitled workspace'}
                        subtitle="Pinned workspace"
                        href={`/w/${project.routeId}`}
                        testId={`local-pinned-${project.id}`}
                        accessory={
                          <PinButton
                            pinned
                            onToggle={() => toggleCloudPin(project.id, false)}
                            label="Unpin folder"
                            size={14}
                          />
                        }
                      />
                    ))
                  )}
                </div>
              ) : view === 'chats' ? (
                <div className="flex flex-col gap-1.5" data-testid="local-chats-view">
                  {(launcher?.recentChats.length ?? 0) === 0 ? (
                    <p className="px-1 text-sm text-stone-400">
                      {signedIn ? 'No recent chats yet.' : 'Sign in to see your chats.'}
                    </p>
                  ) : (
                    launcher!.recentChats.map((chat) => (
                      <LauncherRow
                        key={`chat-${chat.id}`}
                        kind="chat"
                        title={`${chat.isGroup ? 'Group: ' : ''}${chat.title || 'Untitled chat'}`}
                        subtitle={chat.folderLabel}
                        href={buildWorkspaceChatPath(chat.projectRouteId, chat.id)}
                        testId={`local-chat-${chat.id}`}
                      />
                    ))
                  )}
                </div>
              ) : view === 'files' ? (
                <div className="flex flex-col gap-1.5" data-testid="local-files-view">
                  {(launcher?.sharedFiles.length ?? 0) === 0 ? (
                    <p className="px-1 text-sm text-stone-400">No files or folders shared with you yet.</p>
                  ) : (
                    <>
                      <LauncherListHeader />
                      {launcher!.sharedFiles.map((file) => (
                        <LauncherRow
                          key={file.shareId}
                          kind={file.kind === 'file' ? 'file' : 'local'}
                          title={file.path.split('/').pop() || file.path}
                          subtitle={file.workspaceTitle || 'Untitled workspace'}
                          location="Shared with you"
                          href={
                            file.kind === 'file'
                              ? `/w/${file.workspaceRouteId}?filePath=${encodeURIComponent(file.path)}`
                              : `/w/${file.workspaceRouteId}`
                          }
                          testId={`local-shared-file-${file.shareId}`}
                        />
                      ))}
                    </>
                  )}
                </div>
              ) : view === 'scheduled' ? (
                <div data-testid="local-scheduled-view">
                  <ScheduledSection
                    emptyMessage={signedIn ? 'Nothing scheduled yet.' : 'Sign in to see your scheduled tasks.'}
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-1.5" data-testid="local-shared-view">
                  {sharedWorkspaces.length === 0 ? (
                    <p className="px-1 text-sm text-stone-400">
                      {signedIn ? 'Nothing shared with you yet.' : 'Sign in to see workspaces shared with you.'}
                    </p>
                  ) : (
                    sharedWorkspaces.map((workspace) => (
                      <LauncherRow
                        key={`shared-${workspace.id}`}
                        kind="cloud"
                        title={workspace.title || 'Untitled workspace'}
                        subtitle="Shared with you"
                        href={`/w/${getWorkspaceRouteId(workspace)}`}
                        testId={`local-shared-${workspace.id}`}
                        meta={workspace.updated_at ? formatDriveDate(workspace.updated_at) : undefined}
                        owner={workspace.ownerName ?? ''}
                        location="Shared with you"
                      />
                    ))
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      <ProjectDialog
        intent={dialog}
        config={config}
        defaultLocation={defaultLocation}
        isDesktop={isDesktop}
        onClose={() => setDialog(null)}
        onCreated={(project) =>
          openLocal(project.id, dialog?.kind === 'create' ? dialog.pack?.openPath : undefined)
        }
      />
    </div>
  );
}
