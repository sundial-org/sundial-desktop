// LaTeX retention events: the one place event names + props live. Transport
// agnostic — `latexEmitter(track)` on the client, `latexEmitter(serverCapture
// closure)` on the server (lib/analytics/latex-events-server.ts), so a PostHog
// insight can rely on one stable shape. `projectId` is the workspace id, like
// every other event in this app. No PII in props.

import { latexErrorKind, type LatexErrorKind } from '@/lib/latex/error-kind.mjs';
import type { CompileFailureKind, CompileTrigger } from '@/lib/latex/compile-contract';

export { latexErrorKind };
export type { LatexErrorKind };

/** How the workspace's first .tex got there (see `latex_compile_record`). */
export type LatexTexSource = 'template' | 'zip' | 'overleaf' | 'github' | 'upload' | 'agent' | 'blank';
export type LatexImportSource = 'zip' | 'overleaf' | 'github';
export type BibBackend = 'bibtex' | 'biber' | 'none';
export type EngineHint = 'pdflatex' | 'xelatex' | 'lualatex' | 'unknown';

export type LatexEventProps = {
  /** Server: every compile outcome (route + agent autocompile). */
  latex_compile_finished: {
    projectId: string;
    ok: boolean;
    trigger: CompileTrigger;
    duration_ms: number;
    failure_kind: CompileFailureKind | null;
    first_error_kind: LatexErrorKind | null;
    is_first_compile_in_workspace: boolean;
    attempt_index: number;
  };
  /** Server: once per workspace, the first `ok` compile. */
  latex_first_compile_success: {
    projectId: string;
    trigger: CompileTrigger;
    ms_since_first_tex: number | null;
    source: LatexTexSource;
  };
  /** Client: a workspace with >= 1 .tex was opened. Sets the `latex_user` person prop. */
  latex_workspace_opened: {
    projectId: string;
    tex_file_count: number;
    days_since_workspace_created: number | null;
    $set: { latex_user: true };
    $set_once: { first_latex_workspace_opened_at: string };
  };
  /** Client: a failed compile rendered the Fix with Agent affordance. */
  latex_fix_offered: { projectId: string; error_kind: LatexErrorKind; failures_in_session: number; auto: boolean };
  /** Client: Fix with Agent fired (button, Cmd+Enter, or the auto-fix toggle). */
  latex_fix_clicked: { projectId: string; error_kind: LatexErrorKind; attempts: number; auto: boolean };
  /** Client: the compile went green after >= 1 fix turn. */
  latex_fix_resolved: { projectId: string; attempts: number; auto: boolean };
  /** Client: the one-time "enable auto-fix?" offer armed after a requested fix resolved. */
  latex_autofix_suggested: { projectId: string };
  /** Client: the offer's outcome (the preference flipped on, or was declined). */
  latex_autofix_suggestion_accepted: { projectId: string };
  latex_autofix_suggestion_dismissed: { projectId: string };
  /** Client (zip) / server (overleaf, github): an import that brought .tex in. */
  latex_import_completed: {
    projectId: string;
    source: LatexImportSource;
    file_count: number;
    tex_count: number;
    bib_backend: BibBackend;
    engine_hint: EngineHint;
  };
  /** Client: the page was left while the last compile was red and Fix was never clicked. */
  latex_session_ended_with_failing_compile: {
    projectId: string;
    error_kind: LatexErrorKind;
    failures_in_session: number;
  };
};

export type LatexEventName = keyof LatexEventProps;
export type LatexCapture = (event: string, props: Record<string, unknown>) => void;

/** Typed, never-throwing emitter over any capture transport. */
export function latexEmitter(capture: LatexCapture) {
  return <E extends LatexEventName>(event: E, props: LatexEventProps[E]) => {
    try {
      capture(event, props);
    } catch {
      // Analytics must never affect the compile/fix flows.
    }
  };
}

/** bibtex vs biber from the sources that declare bibliography handling. */
export function detectBibBackend(sources: readonly string[]): BibBackend {
  let bibtex = false;
  for (const src of sources) {
    const biblatex = src.match(/\\usepackage\s*(\[[^\]]*\])?\s*\{biblatex\}/);
    if (biblatex) {
      // biblatex defaults to biber; only an explicit backend=bibtex opts out.
      if (!/backend\s*=\s*bibtex/.test(biblatex[1] ?? '')) return 'biber';
      bibtex = true;
    }
    if (/\\bibliography\s*\{|\\bibliographystyle\s*\{/.test(src)) bibtex = true;
  }
  return bibtex ? 'bibtex' : 'none';
}

/** `% !TEX program`, else fontspec/luacode/polyglossia presence, else unknown. */
export function detectEngineHint(sources: readonly string[]): EngineHint {
  for (const src of sources) {
    const magic = src.match(/^\s*%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im)?.[1]?.toLowerCase();
    if (magic) {
      if (magic.includes('lua')) return 'lualatex';
      if (magic.includes('xe')) return 'xelatex';
      if (magic.includes('pdf')) return 'pdflatex';
    }
  }
  const all = sources.join('\n');
  if (/\\usepackage\s*(\[[^\]]*\])?\s*\{(luacode|luatextra|luaotfload)\}|\\directlua\b/.test(all)) return 'lualatex';
  // Only Xe-SPECIFIC packages count: fontspec/polyglossia/unicode-math run on
  // both Xe and Lua, so they stay 'unknown' rather than corrupt the breakdown.
  if (/\\usepackage\s*(\[[^\]]*\])?\s*\{(xeCJK|xltxtra|xunicode|mathspec)\}/.test(all)) return 'xelatex';
  return 'unknown';
}

/** Import-outcome props from the imported paths + the .tex sources among them. */
export function latexImportProps(
  files: ReadonlyArray<{ path: string; text?: string | null }>,
): Pick<LatexEventProps['latex_import_completed'], 'file_count' | 'tex_count' | 'bib_backend' | 'engine_hint'> {
  const tex = files.filter((f) => /\.tex$/i.test(f.path));
  const sources = tex.map((f) => f.text ?? '').filter(Boolean);
  return {
    file_count: files.length,
    tex_count: tex.length,
    bib_backend: detectBibBackend(sources),
    engine_hint: detectEngineHint(sources),
  };
}
