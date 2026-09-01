'use client';

import { useCallback, useEffect, useState } from 'react';
import { parentDirOf, readLastProjectLocation } from './last-location';
import { sortByRecency } from './recents';
import { resolveSidecarConfig, sidecar, type LocalProject, type SidecarConfig } from './sidecar';

/** The sidecar's project list, most recently opened first — shared by every
 *  launcher surface (/local and the dashboard's "On this computer"). The
 *  desktop shell spawns the sidecar and loads the page in parallel, so on slow
 *  first launches the port isn't bound yet: retry briefly before declaring it
 *  missing (which disables the actions until reload). */
export function useLocalProjects() {
  const [config, setConfig] = useState<SidecarConfig | null>(null);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [defaultLocation, setDefaultLocation] = useState('');
  const [status, setStatus] = useState<'checking' | 'ready' | 'missing'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const reload = useCallback(() => setEpoch((n) => n + 1), []);

  useEffect(() => {
    void epoch;
    let cancelled = false;
    (async () => {
      const found = await resolveSidecarConfig();
      if (cancelled) return;
      setConfig(found);
      if (!found) {
        setStatus('missing');
        return;
      }
      for (let attempt = 0; ; attempt += 1) {
        try {
          await sidecar.health(found);
          const { projects, defaultProjectsDir } = await sidecar.listProjects(found);
          if (cancelled) return;
          const ordered = sortByRecency(projects);
          setProjects(ordered);
          // Always pre-fill the create/clone Location: last folder created
          // into → parent of the most recent project → sidecar's default.
          setDefaultLocation(
            readLastProjectLocation() || parentDirOf(ordered[0]?.root) || defaultProjectsDir || '',
          );
          setError(null);
          setStatus('ready');
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt >= 9) {
            setError(err instanceof Error ? err.message : 'Local service unreachable');
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
  }, [epoch]);

  // Renames and folder mounts happen inside a workspace page — refetch when
  // the user comes back so launcher rows don't keep the stale name/roots.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'hidden') reload();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload]);

  return { config, projects, defaultLocation, status, error, reload };
}
