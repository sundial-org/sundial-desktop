'use client';

import { useCallback, useEffect, useState, type ComponentType } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useClerk, useUser } from '@/lib/auth/optional-auth';
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  BooksIcon,
  CloudIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  GithubLogoIcon,
  GraduationCapIcon,
  NotebookIcon,
  PenNibIcon,
  PlusIcon,
  TreeStructureIcon,
  type IconProps,
} from '@phosphor-icons/react';
import { SunnyAnimation } from '@/components/sunny-animation';
import { isDesktopApp, getDesktopVersion, DESKTOP_CREDENTIALS_EVENT } from '@/lib/desktop';
import { getLaunchParam, resolveSidecarConfig, sidecar, type LocalProject, type SidecarConfig } from '@/lib/local/sidecar';
import { useDesktopCredentials } from '@/lib/local/use-desktop-credentials';
import { parentDirOf, readLastProjectLocation } from '@/lib/local/last-location';
import { STARTER_PACKS, type StarterPack } from '@/lib/local/starter-packs';
import { getWorkspaceRouteId } from '@/lib/workspace/public-ids';
import type { VisibleWorkspaceSummary } from '@/lib/workspace/visible-workspaces-shared';
import { ProjectDialog, type ProjectDialogIntent } from './_components/project-dialogs';

const PACK_ICONS: Record<string, ComponentType<IconProps>> = {
  'research-paper': GraduationCapIcon,
  'lit-review': BooksIcon,
  writing: PenNibIcon,
  notes: NotebookIcon,
  'knowledge-base': TreeStructureIcon,
  book: BookOpenIcon,
};

/** Desktop home: create or open a project on this machine — no sign-in needed
 *  until something is shared. The Tauri shell launches here; its File ▸ Open
 *  Folder… (and the "Open a folder" button below, via the /desktop/open-folder
 *  navigation the shell intercepts) land back with `openPath` in the fragment.
 *  In a plain browser without a sidecar this explains the desktop app instead. */
export default function LocalHomePage() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const { openSignIn } = useClerk();
  const [config, setConfig] = useState<SidecarConfig | null>(null);
  const [status, setStatus] = useState<'checking' | 'ready' | 'missing'>('checking');
  const [isDesktop, setIsDesktop] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [defaultLocation, setDefaultLocation] = useState('');
  const [folderInput, setFolderInput] = useState('');
  const [showPathInput, setShowPathInput] = useState(false);
  const [opening, setOpening] = useState(false);
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
  const [cloudWorkspaces, setCloudWorkspaces] = useState<VisibleWorkspaceSummary[] | null>(null);
  // Packaged-app sign-in can live only as sd_ credentials parked in the
  // sidecar (no Clerk session in the webview) — the proxy authenticates
  // /api/* with them, so that state counts as signed in here. But a parked
  // token can be stale (expired/revoked): /agent-credentials still says
  // configured while cloud calls 401 — so a rejected cloud call revokes the
  // signed-in reading and the sign-in affordances come back.
  const desktopCredentials = useDesktopCredentials(config);
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
    setIsDesktop(isDesktopApp());
    setVersion(getDesktopVersion());
    let cancelled = false;
    (async () => {
      const found = await resolveSidecarConfig();
      if (cancelled) return;
      setConfig(found);
      if (!found) {
        setStatus('missing');
        return;
      }
      // The desktop shell's folder picker lands here with the picked path —
      // but NOT when the pick was for a dialog's Location field (pickedPath),
      // which the open dialog consumes itself.
      const openPath = getLaunchParam('openPath');
      if (openPath) {
        setOpening(true);
        sidecar
          .openProject(found, openPath)
          // `cancelled` guards a same-document re-pick: a second folder chosen
          // before this resolves re-arms the effect, and the stale completion
          // must not navigate (or report) over the newer pick.
          .then(({ project }) => {
            if (!cancelled) router.replace(`/local/${project.id}`);
          })
          .catch((err) => {
            if (cancelled) return;
            setOpening(false);
            setStatus('ready');
            setError(err instanceof Error ? err.message : 'Failed to open folder');
          });
        return;
      }
      // The shell spawns the sidecar and loads this page in parallel — on slow
      // first launches the port isn't bound yet, so retry briefly before
      // declaring the sidecar missing (which disables the actions until reload).
      for (let attempt = 0; ; attempt += 1) {
        try {
          await sidecar.health(found);
          const { projects, defaultProjectsDir } = await sidecar.listProjects(found);
          if (cancelled) return;
          setProjects(projects);
          // Always pre-fill the create/clone Location: last folder created
          // into → parent of the most recent project → sidecar's default.
          setDefaultLocation(
            readLastProjectLocation() || parentDirOf(projects[0]?.root) || defaultProjectsDir || '',
          );
          setStatus('ready');
          return;
        } catch {
          if (cancelled) return;
          if (attempt >= 9) {
            setStatus('missing');
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootNonce, router]);

  const openFolder = useCallback(
    async (root: string) => {
      if (!config || !root.trim()) return;
      setError(null);
      setOpening(true);
      try {
        const { project } = await sidecar.openProject(config, root.trim());
        router.push(`/local/${project.id}`);
      } catch (err) {
        setOpening(false);
        setError(err instanceof Error ? err.message : 'Failed to open folder');
      }
    },
    [config, router],
  );

  const pickFolder = useCallback(() => {
    if (isDesktop) {
      // Marker navigation: the Tauri shell cancels it and opens the native
      // folder picker (same flow as File ▸ Open Folder…, ⌘O).
      window.location.assign('/desktop/open-folder');
      return;
    }
    setShowPathInput(true);
  }, [isDesktop]);

  const ready = status === 'ready';
  const openPack = useCallback(
    (pack: StarterPack | null) => {
      setError(null);
      setDialog({ kind: 'create', pack });
    },
    [],
  );

  return (
    <div className="flex min-h-screen flex-col bg-stone-50 text-stone-800">
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
      {/* Top bar; in the macOS shell it doubles as the window drag strip. */}
      <header
        data-tauri-drag-region
        className={`flex items-center justify-between px-6 py-3 ${isDesktop ? 'pl-24' : ''}`}
      >
        <span className="text-sm font-semibold tracking-tight text-stone-700">Sundial</span>
        <div className="flex items-center gap-3 text-sm">
          {/* No isLoaded gate: in the packaged app clerk-js never loads, so it
              would pin the header to "Sign in" even with sd_ credentials. */}
          {signedIn ? (
            // Desktop: cloud workspaces are inline below — a dashboard link
            // would just bounce back here (see app/dashboard's redirect).
            // The link also needs a real Clerk session, which sidecar-
            // credential sign-ins don't have.
            !isDesktop && user && (
              <Link href="/dashboard" className="flex items-center gap-1 text-stone-500 hover:text-stone-800">
                Cloud workspaces <ArrowUpRightIcon className="h-3.5 w-3.5" aria-hidden />
              </Link>
            )
          ) : (
            <button
              type="button"
              className="text-stone-500 hover:text-stone-800"
              onClick={() => openSignIn?.({ forceRedirectUrl: '/local' })}
              data-testid="local-sign-in"
            >
              Sign in
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-10 px-6 py-12">
        {status === 'missing' && !isDesktop ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <FolderSimpleIcon className="h-10 w-10 text-stone-400" weight="duotone" aria-hidden />
            <h1 className="text-xl font-semibold">Local projects live in the desktop app</h1>
            <p className="max-w-md text-sm text-stone-500">
              Sundial Desktop opens any folder on your computer as a project — files stay on your
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
          <>
            <div className="flex items-center gap-3">
              <Image src="/sundial-icon.png" alt="" width={44} height={44} className="rounded-xl" priority />
              <div className="flex flex-col">
                <span className="text-lg font-semibold tracking-tight">Sundial</span>
                {version && <span className="font-mono text-xs text-stone-400">v{version}</span>}
              </div>
            </div>

            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1.5">
                <h1 className="text-2xl font-semibold tracking-tight">What do you want to build?</h1>
                <p className="text-sm text-stone-500">
                  Pick a starter pack to scaffold your project with ready-made folders and starter
                  files. Everything stays on this machine until you share it.
                </p>
              </div>

              {status === 'missing' ? (
                <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900">
                  The local service isn&apos;t responding. Quit and reopen Sundial; if this keeps
                  happening, make sure nothing else is using its port.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {STARTER_PACKS.map((pack) => {
                      const Icon = PACK_ICONS[pack.id] ?? FolderSimpleIcon;
                      return (
                        <button
                          key={pack.id}
                          type="button"
                          disabled={!ready}
                          onClick={() => openPack(pack)}
                          className="group flex flex-col items-start gap-1.5 rounded-xl border border-stone-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-stone-300 hover:bg-stone-100/60 disabled:opacity-50"
                          data-testid={`starter-pack-${pack.id}`}
                        >
                          <span className="flex items-center gap-2">
                            <Icon className="h-4.5 w-4.5 text-stone-500" weight="duotone" aria-hidden />
                            <span className="text-sm font-medium text-stone-800">{pack.title}</span>
                          </span>
                          <span className="text-xs text-stone-500">{pack.tagline}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                    <span className="text-stone-500">Have something else in mind?</span>
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
                </>
              )}
            </div>

            {projects.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-400">
                  <FolderSimpleIcon className="h-3.5 w-3.5" aria-hidden /> On this computer
                </span>
                <div className="flex flex-col gap-1.5">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="group flex items-center justify-between rounded-xl border border-stone-200 bg-white px-4 py-3 text-left shadow-sm transition-colors hover:border-stone-300 hover:bg-stone-100/60"
                      onClick={() => router.push(`/local/${project.id}`)}
                      data-testid={`local-recent-${project.name}`}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <FolderSimpleIcon className="h-5 w-5 shrink-0 text-stone-400" weight="duotone" aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-stone-800">{project.name}</span>
                          <span className="block truncate text-xs text-stone-400">{project.root}</span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(cloudWorkspaces?.length ?? 0) > 0 && (
              <div className="flex flex-col gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-400">
                  <CloudIcon className="h-3.5 w-3.5" aria-hidden /> In the cloud
                </span>
                <div className="flex flex-col gap-1.5">
                  {cloudWorkspaces!.map((workspace) => (
                    <Link
                      key={workspace.id}
                      href={`/w/${getWorkspaceRouteId(workspace)}`}
                      className="group flex items-center justify-between rounded-xl border border-stone-200 bg-white px-4 py-3 text-left shadow-sm transition-colors hover:border-stone-300 hover:bg-stone-100/60"
                      data-testid={`local-cloud-${workspace.id}`}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <CloudIcon className="h-5 w-5 shrink-0 text-stone-400" weight="duotone" aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-stone-800">
                            {workspace.title || 'Untitled workspace'}
                          </span>
                          <span className="block truncate text-xs text-stone-400">
                            {workspace.role === 'owner' ? 'Your workspace' : 'Shared with you'}
                          </span>
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
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
        )}
      </main>

      <ProjectDialog
        intent={dialog}
        config={config}
        defaultLocation={defaultLocation}
        isDesktop={isDesktop}
        onClose={() => setDialog(null)}
        onCreated={(project) => router.push(`/local/${project.id}`)}
      />
    </div>
  );
}
