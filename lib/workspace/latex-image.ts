/** Helpers for inserting dropped/pasted images into a LaTeX document. */

/** Image extensions `\includegraphics` can consume (raster + vector + pdf/eps). */
export const LATEX_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf|eps)$/iu;

/**
 * Path of `target` relative to the directory containing `texPath` (posix).
 * `\includegraphics` resolves paths relative to the .tex file, so an image at
 * `paper/images/fig.png` referenced from `paper/main.tex` becomes
 * `images/fig.png`; from `notes/main.tex` it becomes `../paper/images/fig.png`.
 */
export function relativeToTexDir(texPath: string, target: string): string {
  const texDir = texPath.includes('/') ? texPath.slice(0, texPath.lastIndexOf('/')) : '';
  if (!texDir) return target;
  const from = texDir.split('/');
  const to = target.split('/');
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i += 1;
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/') || target;
}

/** True when the LaTeX preamble already pulls in the graphicx package. */
export function texHasGraphicx(text: string): boolean {
  return /\\usepackage(?:\[[^\]]*\])?\s*\{[^}]*\bgraphicx\b[^}]*\}/u.test(text);
}
