// Types for the shared, dependency-free LaTeX error bucketer (error-kind.mjs),
// hand-written because the module ships as plain JS into the agent brain image.

export type LatexErrorKind =
  | 'missing_package'
  | 'biber'
  | 'engine'
  | 'undefined_control_sequence'
  | 'missing_file'
  | 'timeout'
  | 'bundle_too_big'
  | 'other';

export const LATEX_ERROR_KINDS: readonly LatexErrorKind[];

export function latexErrorKind(input?: { log?: string | null; error?: string | null }): LatexErrorKind;
