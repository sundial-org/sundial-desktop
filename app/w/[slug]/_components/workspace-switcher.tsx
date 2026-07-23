'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArchiveIcon, CloudIcon, FolderOpenIcon, HouseIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { LocalRootGlyph } from './workspace-file-helpers';
import { useAuth } from '@/lib/auth/optional-auth';
import { createBrowserClient } from '@/lib/supabase/browser';
import { buildWorkspacePath } from '@/lib/workspace/paths';
import { isDesktopApp } from '@/lib/desktop';
import { resolveSidecarConfig, sidecar, type LocalProject } from '@/lib/local/sidecar';

export type WorkspaceSwitcherItem = {
  id: string;
  public_id: string | null;
  title: string | null;
  updated_at: string | null;
};

export function useWorkspaceSwitcher({
  projectId,
  userId,
  show,
  setShow,
}: {
  projectId: string;
  userId?: string | null;
  show: boolean;
  setShow: (value: boolean) => void;
}) {
  const workspaceSwitcherRef = useRef<HTMLDivElement>(null);
  const [workspaceSwitcherPos, setWorkspaceSwitcherPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [otherWorkspaces, setOtherWorkspaces] = useState<WorkspaceSwitcherItem[]>([]);

  const { isLoaded: isClerkLoaded } = useAuth();
  const loadOtherWorkspaces = useCallback(async () => {
    if (!userId) return;
    if (!isClerkLoaded) return; // wait so the Supabase REST call carries the Clerk JWT
    try {
      const sb = createBrowserClient();
      if (!sb) return;
      const { data } = await sb
        .from('projects')
        .select('id, public_id, title, updated_at')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(10);
      setOtherWorkspaces(
        (data ?? [])
          .filter((workspace) => workspace.id !== projectId)
          .sort((a, b) => {
            const aTime = a.updated_at ? Date.parse(a.updated_at) : 0;
            const bTime = b.updated_at ? Date.parse(b.updated_at) : 0;
            return bTime - aTime;
          }),
      );
    } catch {
      // ignore
    }
  }, [projectId, userId, isClerkLoaded]);

  useEffect(() => {
    void loadOtherWorkspaces();
  }, [loadOtherWorkspaces]);

  // Local (on-disk) projects from the desktop sidecar — listed alongside cloud
  // workspaces so switching works across both worlds. Resolves to nothing in a
  // plain browser without a sidecar.
  const [localProjects, setLocalProjects] = useState<LocalProject[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const config = await resolveSidecarConfig();
      if (!config || cancelled) return;
      try {
        const { projects } = await sidecar.listProjects(config);
        if (!cancelled) setLocalProjects(projects.filter((project) => project.id !== projectId));
      } catch {
        // sidecar not running
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!show) return;
    const handleClick = (event: MouseEvent) => {
      if (workspaceSwitcherRef.current && !workspaceSwitcherRef.current.contains(event.target as Node)) {
        setShow(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [setShow, show]);

  useLayoutEffect(() => {
    if (!show) {
      setWorkspaceSwitcherPos(null);
      return;
    }
    const update = () => {
      const wrapperEl = workspaceSwitcherRef.current;
      if (!wrapperEl) return;
      const triggerEl =
        wrapperEl.querySelector<HTMLElement>('[data-workspace-switcher-trigger]') ?? wrapperEl;
      const rect = triggerEl.getBoundingClientRect();
      const desiredWidth = 288;
      const margin = 8;
      const viewportW = window.innerWidth;
      const width = Math.min(desiredWidth, viewportW - margin * 2);
      const rightAlignedLeft = rect.right - width;
      let left: number;
      if (rightAlignedLeft >= margin) {
        left = rightAlignedLeft;
      } else {
        left = Math.min(rect.left, viewportW - width - margin);
        left = Math.max(margin, left);
      }
      setWorkspaceSwitcherPos({
        top: rect.bottom + 4,
        left,
        width,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [show]);

  return { workspaceSwitcherRef, workspaceSwitcherPos, otherWorkspaces, localProjects };
}

export function WorkspaceSwitcherMenu({
  position,
  otherWorkspaces,
  localProjects = [],
  canWrite,
  isArchived,
  isArchiving,
  archiveActionLabel,
  onSwitchWorkspace,
  onRename,
  onNewWorkspace,
  onDashboard,
  onToggleArchive,
  canArchive = true,
}: {
  position: { top: number; left: number; width: number } | null;
  otherWorkspaces: WorkspaceSwitcherItem[];
  /** Sidecar (on-disk) projects; empty outside the desktop app. */
  localProjects?: LocalProject[];
  canWrite: boolean;
  isArchived: boolean;
  isArchiving: boolean;
  archiveActionLabel: string;
  onSwitchWorkspace: (workspaceId: string) => void;
  onRename: () => void;
  onNewWorkspace: () => void;
  onDashboard: () => void;
  onToggleArchive: () => void;
  /** False for local projects — archive is a cloud-workspace concept. */
  canArchive?: boolean;
}) {
  return (
    <div
      className="fixed bg-white rounded-xl shadow-lg z-50 overflow-hidden border border-stone-200"
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        width: position?.width ?? 288,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {(otherWorkspaces.length > 0 || localProjects.length > 0) && (
        <>
          <div className="py-1">
            <div className="px-3 py-1.5 text-[10px] font-medium text-stone-400 uppercase tracking-wide">Switch to</div>
            {localProjects.map((project) => (
              <a
                key={project.id}
                href={`/local/${project.id}`}
                className="flex items-center gap-2 px-3 py-2 text-sm text-stone-600 hover:bg-stone-50"
                title={`${project.root} — on this device`}
              >
                {/* Wireframe origin icons: device = local, cloud = cloud. */}
                <LocalRootGlyph className="h-3.5 w-3.5 shrink-0 text-stone-400" />
                <span className="truncate">{project.name}</span>
              </a>
            ))}
            {otherWorkspaces.map((workspace) => (
              <a
                key={workspace.id}
                href={buildWorkspacePath(workspace)}
                onClick={() => onSwitchWorkspace(workspace.id)}
                title="Cloud workspace"
                className="flex items-center gap-2 px-3 py-2 text-sm text-stone-600 hover:bg-stone-50"
              >
                <CloudIcon className="h-3.5 w-3.5 shrink-0 text-stone-400" weight="regular" aria-hidden />
                <span className="truncate">{workspace.title || 'Untitled workspace'}</span>
              </a>
            ))}
          </div>
          <div className="border-t border-stone-100" />
        </>
      )}

      <div className="py-1">
        {canWrite && (
          <button
            type="button"
            onClick={onRename}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-stone-500 hover:text-stone-700 hover:bg-stone-50"
          >
            <PencilSimpleIcon className="w-3.5 h-3.5" weight="regular" aria-hidden />
            Rename workspace
          </button>
        )}
        <Link
          href="/new"
          onClick={onNewWorkspace}
          className="flex items-center gap-2 px-3 py-2 text-sm text-stone-500 hover:text-stone-700 hover:bg-stone-50"
        >
          <PlusIcon className="w-3.5 h-3.5" weight="bold" aria-hidden />
          New workspace
        </Link>
        {isDesktopApp() && (
          <button
            type="button"
            // Marker navigation: the Tauri shell cancels it and opens the
            // native folder picker (same flow as File ▸ Open Folder…, ⌘O).
            onClick={() => window.location.assign('/desktop/open-folder')}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-stone-500 hover:text-stone-700 hover:bg-stone-50"
          >
            <FolderOpenIcon className="w-3.5 h-3.5" weight="regular" aria-hidden />
            Open folder…
          </button>
        )}
        <Link
          href="/dashboard"
          onClick={onDashboard}
          className="flex items-center gap-2 px-3 py-2 text-sm text-stone-500 hover:text-stone-700 hover:bg-stone-50"
        >
          <HouseIcon className="w-3.5 h-3.5" weight="regular" aria-hidden />
          Dashboard
        </Link>
      </div>
      {canWrite && canArchive && (
        <div className="border-t border-stone-100 py-1">
          <button
            type="button"
            onClick={onToggleArchive}
            disabled={isArchiving}
            className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-stone-500 disabled:opacity-60 ${
              isArchived ? 'hover:text-stone-700 hover:bg-stone-50' : 'hover:text-stone-600 hover:bg-stone-50'
            }`}
          >
            <ArchiveIcon className="w-3.5 h-3.5" weight="regular" aria-hidden />
            {archiveActionLabel}
          </button>
        </div>
      )}
    </div>
  );
}
