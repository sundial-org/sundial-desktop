// W1.trigger — compile-request contract (docs/latex-parity-spec.md).
//
// Single source of truth for the compile `trigger` enum and failure
// classification shared by the API route, the compile-pool client, and the
// editor hook. agent-ts is a separate build and inlines the one literal it
// needs ("sunny") rather than importing across the package boundary — the
// same pattern it uses for LATEX_DOCUMENT_EXTENSIONS.

/** Who/what kicked the compile — decides which failure path a break enters. */
export const COMPILE_TRIGGERS = ['sunny', 'user', 'manual', 'auto'] as const;
export type CompileTrigger = (typeof COMPILE_TRIGGERS)[number];

export function isCompileTrigger(value: unknown): value is CompileTrigger {
  return typeof value === 'string' && (COMPILE_TRIGGERS as readonly string[]).includes(value);
}

// `latex` = a real tex/content error — may launch a Sunny fix loop.
// `infra`  = pool/sandbox/network failure (IC5) — never launches a fix loop;
//            surface infra copy + a retry affordance instead.
export type CompileFailureKind = 'latex' | 'infra';

/** A monotonic, non-negative integer marking the source revision compiled. */
export function isSourceVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
