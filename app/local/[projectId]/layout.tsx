'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { WorkspaceRouteProvider } from '@/lib/workspace/route-context';
import { DocumentEditModeProvider } from '@/lib/workspace/document-edit-mode-context';
import { LocalCollabSocketProvider } from '@/lib/workspace/collab-socket-context';
import { resolveSidecarConfig, sidecar, sidecarWsUrl, type SidecarConfig } from '@/lib/local/sidecar';
import { LOCAL_SHELL_PARAM, localProjectIdFromLocation } from '@/lib/local/static-shell';
import { setLocalImageSource } from '@/lib/workspace/image-src';

/** Local-project variant of the /w/[slug] layout: same providers, but the
 *  collab socket points at the desktop sidecar and the route context carries
 *  the sidecar config so WorkspacePage swaps its data plane. Client-only —
 *  the sidecar token lives in the browser and never reaches the server. */
export default function LocalWorkspaceLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ projectId: string }>();
  // The static desktop export serves one placeholder shell for every
  // /local/<id> — there the router's param is the shell marker and the DOM
  // URL carries the real id.
  const projectId =
    params.projectId === LOCAL_SHELL_PARAM
      ? (localProjectIdFromLocation() ?? params.projectId)
      : params.projectId;
  const [config, setConfig] = useState<SidecarConfig | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void resolveSidecarConfig().then((found) => {
      if (cancelled) return;
      if (found) setConfig(found);
      else setMissing(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Workspace-relative image paths resolve against the sidecar while this
  // project is open (the editor's image node + viewers share this registry).
  useEffect(() => {
    if (!config || !projectId) return;
    setLocalImageSource({
      projectId,
      toUrl: (path) => sidecar.fileUrl(config, projectId, path),
    });
    return () => setLocalImageSource(null);
  }, [config, projectId]);

  const routeValue = useMemo(
    () => ({ projectId, publicId: null, initialFiles: null, local: config ? { config } : null }),
    [projectId, config],
  );

  if (missing) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="text-sm font-medium">This project lives on your computer.</span>
        <span className="max-w-sm text-sm text-muted-foreground">
          Local projects open in the Sundial desktop app, which serves your folder to this page.
        </span>
        <Link href="/local" className="text-sm text-primary underline underline-offset-4">
          Back to local projects
        </Link>
      </div>
    );
  }
  return (
    <>
      {/* Static chrome behind the workspace. The sidecar now serves the `_`
          shell's flight payloads for every /local/<id>, so opening a project
          is a soft navigation and this rarely shows — but a cold window still
          boots the bundle against an EMPTY body (the white flash between the
          launcher and the workspace), and this is plain markup that ships
          inside /local/_.html and paints before any JS runs. It then sits
          behind the workspace, which covers it as it fades in. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-white" data-testid="local-workspace-shell">
        <div className="h-11 border-b border-stone-200" />
        {/* The pulse stops once the workspace can mount — past that the shell
            is only a backdrop for its fade-in, and an animation nothing can
            see would burn a compositor frame for the life of the window. */}
        <div className={`mx-auto mt-16 w-full max-w-2xl space-y-4 px-8 ${config ? '' : 'animate-pulse'}`}>
          <div className="h-8 w-1/2 rounded bg-stone-100" />
          <div className="h-4 w-full rounded bg-stone-100" />
          <div className="h-4 w-4/5 rounded bg-stone-100" />
        </div>
      </div>
      {config ? (
        // key on the project: /local/<a> → /local/<b> is a SOFT navigation in
        // the desktop shell (the sidecar serves the `_` shell's flight
        // payloads for every id), so the subtree would otherwise keep the
        // previous project's providers, sockets and editor state alive.
        <WorkspaceRouteProvider key={projectId} value={routeValue}>
          <DocumentEditModeProvider workspaceId={projectId}>
            {/* The "Get set up" checklist mounts inside WorkspacePage's
                sidebar (with this route context's sidecar config) — no
                overlay mount here. */}
            <LocalCollabSocketProvider projectId={projectId} wsUrl={sidecarWsUrl(config)} token={config.token}>
              {children}
            </LocalCollabSocketProvider>
          </DocumentEditModeProvider>
        </WorkspaceRouteProvider>
      ) : (
        <span role="status" className="sr-only">
          Opening project…
        </span>
      )}
    </>
  );
}
