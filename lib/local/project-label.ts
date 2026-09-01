import type { LocalProject } from './sidecar';

/** Title for a local workspace. With ONE folder it is the project's own name;
 *  once extra roots are mounted, a title that still just names the primary
 *  folder no longer describes the whole — it becomes "Workspace". Shared by
 *  the workspace header and the launcher rows so every surface agrees. */
export function workspaceTitleLabel(title: string, primaryRootName: string | null, hasExtraRoots: boolean): string {
  return hasExtraRoots && (!title || title === primaryRootName) ? 'Workspace' : title;
}

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Launcher-row title + subtitle for a sidecar project (multi-root aware). */
export function localProjectRowLabels(project: LocalProject): { title: string; subtitle: string } {
  const extras = project.extra_roots?.length ?? 0;
  return {
    title: workspaceTitleLabel(project.name, basename(project.root), extras > 0),
    subtitle: extras ? `${project.root} · +${extras} folder${extras === 1 ? '' : 's'}` : project.root,
  };
}
