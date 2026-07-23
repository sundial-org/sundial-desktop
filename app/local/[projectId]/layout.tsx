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
import { GetSetUpCard } from '@/components/desktop/get-set-up-card';

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
  if (!config) return null;

  return (
    <WorkspaceRouteProvider value={routeValue}>
      <DocumentEditModeProvider workspaceId={projectId}>
        <LocalCollabSocketProvider projectId={projectId} wsUrl={sidecarWsUrl(config)} token={config.token}>
          {children}
          <GetSetUpCard config={config} projectId={projectId} />
        </LocalCollabSocketProvider>
      </DocumentEditModeProvider>
    </WorkspaceRouteProvider>
  );
}
