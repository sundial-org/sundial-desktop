// Cheap, I/O-free triage of a root .tex: which engine should latexmk drive?
// Source text only, and only a positive signal counts — `undefined` leaves the
// choice to the pool, which also gets to sniff the project's own class files.
//
// Plain JS (no deps) so the Next app and the agent brain (which compiles only
// its own src/ tree) share one detector — same pattern as error-kind.mjs. Both
// compile paths must agree: a doc the user compiles on xelatex has to reach the
// pool on xelatex when the agent compiles it too.

const stripComments = (text) => text.replace(/(^|[^\\])%.*$/gm, '$1');

// `% !TEX program = xelatex`, TeXstudio's `% !TeX TXS-program:compile = ...`.
const MAGIC_RE = /^%\s*!TEX\b.*?\b(pdflatex|xelatex|lualatex|xetex|luatex|luahbtex)\b/im;
const CTEX_CLASS_RE = /\\documentclass(?:\[[^\]]*\])?\{ctex(?:art|book|rep|beamer)\}/;
const LUA_MACRO_RE = /\\directlua\b|\\luaescapestring\b|\\RequireLuaTeX\b/;
// `markdown` shells out to its Lua helper under pdf/xetex ("I can not access
// the shell", prod workspace aa67e088) but runs via \directlua on luatex.
const LUA_PACKAGES = new Set(['luacode', 'luatextra', 'lualatex-math', 'luamplib', 'luaotfload', 'luatexja', 'luatexbase', 'markdown']);
const XE_PACKAGES = new Set(['fontspec', 'polyglossia', 'xecjk', 'xltxtra', 'xunicode', 'unicode-math', 'ctex']);

/**
 * @param {string} source root .tex source
 * @returns {'pdflatex' | 'xelatex' | 'lualatex' | undefined}
 */
export function detectLatexEngine(source) {
  const body = stripComments(source ?? '');

  // Comma lists (`\usepackage{amsmath,fontspec}`) count package by package.
  const packages = new Set();
  for (const m of body.matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().toLowerCase();
      if (name) packages.add(name);
    }
  }

  // Magic comments survive stripComments only if read from the raw source.
  const magic = (source ?? '').match(MAGIC_RE)?.[1]?.toLowerCase();
  if (/lua/.test(magic ?? '') || LUA_MACRO_RE.test(body) || [...packages].some((p) => LUA_PACKAGES.has(p))) {
    return 'lualatex';
  }
  if (magic) return magic === 'pdflatex' ? 'pdflatex' : 'xelatex';
  if ([...packages].some((p) => XE_PACKAGES.has(p)) || CTEX_CLASS_RE.test(body)) return 'xelatex';
  return undefined;
}
