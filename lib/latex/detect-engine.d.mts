// Types for the shared, dependency-free engine detector (detect-engine.mjs),
// hand-written because the module ships as plain JS into the agent brain image.

export type LatexEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export function detectLatexEngine(source: string): LatexEngine | undefined;
