/**
 * Which audience a build/deployment serves. One codebase, two flavors:
 *
 * - 'scientific' — the LaTeX-first cloud beta (sundial.md today): welcome.tex
 *   onboarding with the compile-error tour, research featured skills.
 * - 'general'    — the markdown-first product (desktop/OSS, and any future
 *   general web deployment): welcome.md onboarding, general featured skills.
 *
 * Default is 'scientific' so existing deployments never change behavior by
 * omission. The desktop-ui build pins 'general' (desktop-ui/next.config.ts);
 * a web deployment opts in with NEXT_PUBLIC_SUNDIAL_FLAVOR=general (client +
 * server) or SUNDIAL_FLAVOR=general (server only).
 */
export type ProductFlavor = 'scientific' | 'general';

export function productFlavor(): ProductFlavor {
  const raw = process.env.NEXT_PUBLIC_SUNDIAL_FLAVOR ?? process.env.SUNDIAL_FLAVOR;
  return raw === 'general' ? 'general' : 'scientific';
}
