// Pure link-rewrite logic behind Obsidian-style rename link maintenance
// (lib/workspace/rename-links.ts). Plain .mjs, DOM- and server-free, so unit
// tests exercise the exact production rewrite.
//
// Given a file's markdown and the committed old→new path map, produce the
// minimal set of token replacements: `[[wiki]]` / `![[embed]]` targets are
// resolved with the SAME resolver navigation uses (lib/markdown/anchors.mjs),
// against the PRE-rename path list — that's the world the stored links were
// written in. Anchors (`#Heading`, `#^block`), aliases (`|alias`) and the
// embed `!` are preserved byte-for-byte; only the path segment is rewritten,
// keeping the author's style (bare basename stays a basename when it still
// resolves uniquely; an explicit `.md` stays explicit).

import { resolveWorkspacePath } from '../markdown/anchors.mjs';

const WIKI_TOKEN = /!?\[\[([^\[\]\n]+)\]\]/g;
// Inline markdown link/image whose href is a plain path. Spaces are allowed
// (the parser reads `](path with spaces.md)` verbatim, no title syntax);
// parens are not — matching the parser's own `[^)]+` href capture.
const MD_LINK = /(!?\[[^\]\n]*\]\()([^()\n]+)(\))/g;

const stripMd = (s) => s.replace(/\.md$/i, '');

/** Rewrite one wiki path segment, preserving the author's form. */
function rewriteWikiPath(trimmedPath, moved, prePaths, postPaths) {
  const resolved = resolveWorkspacePath(trimmedPath, prePaths);
  if (!resolved || !moved.has(resolved)) return null;
  const newFull = moved.get(resolved);
  const hadMd = trimmedPath.toLowerCase().endsWith('.md');
  const usedFolder = trimmedPath.includes('/');
  const form = (p) => (hadMd || !p.toLowerCase().endsWith('.md') ? p : stripMd(p));

  if (!usedFolder) {
    // Author linked by bare name — keep that if the new name still resolves
    // to the moved file (no ambiguity with another file of the same name).
    const base = form(newFull.split('/').pop() ?? newFull);
    if (resolveWorkspacePath(base, postPaths) === newFull) return base;
  }
  return form(newFull);
}

/** Blank out regions where link-like text is CODE, not a link — fenced blocks,
 *  `<script>`/`<style>` bodies, indented code lines, and inline code spans —
 *  so the scanners never see their tokens. Replacement is space-for-character,
 *  so every surviving token keeps its exact offset and text. The mask errs
 *  toward masking: a 4-space line that isn't a list item may be a nested list
 *  continuation, and skipping its link (stale but intact) beats a replace_all
 *  edit mutating a code block. */
const blank = (m) => m.replace(/[^\n]/g, ' ');
function maskCodeRegions(content) {
  return content
    .replace(/^(?:```|~~~)[^\n]*\n[\s\S]*?(?:^(?:`{3,}|~{3,})[^\n]*$|(?![\s\S]))/gm, blank)
    .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|(?![\s\S]))/gi, blank)
    .replace(/^(?: {4,}|\t)(?![-*+]\s|\d+[.)]\s)[^\n]*$/gm, blank)
    // Inline code spans: any delimiter length (CommonMark allows ``` `code` ```
    // to nest backticks); the per-char lookahead stops at the exact closer.
    .replace(/(`+)(?:(?!\1)[\s\S])+?\1(?!`)/g, blank);
}

/** Join a document-relative href onto the linking file's directory, resolving
 *  `./` and `../` segments — the same join navigation applies before its
 *  workspace-root fallback (lib/workspace/wiki-file-links.ts). Null when the
 *  href escapes the workspace root. */
function joinRelative(dir, href) {
  const parts = dir ? dir.split('/') : [];
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * @param {string} content
 * @param {{ moved: Map<string, string>, prePaths: string[], postPaths: string[], filePath?: string | null }} ctx
 *   `filePath` is the linking file's PRE-rename path — markdown hrefs resolve
 *   document-relative first (mirroring navigation), and the links were
 *   authored in the pre-move world.
 * @returns {{ edits: Array<{ old_string: string, new_string: string, replace_all: true }>, links: number }}
 */
export function rewriteLinksForRename(content, { moved, prePaths, postPaths, filePath = null }) {
  /** @type {Map<string, string>} old token → new token */
  const replacements = new Map();
  let links = 0;

  // Scan the code-masked text so tokens inside fences / inline code are never
  // candidates. The rewrite itself is a replace_all on the REAL doc, so a
  // token that appears in BOTH prose and code must be skipped outright — a
  // stale link beats silently mutating a code sample.
  const masked = maskCodeRegions(content);
  const countIn = (hay, needle) => hay.split(needle).length - 1;
  const alsoInCode = (token) => countIn(content, token) !== countIn(masked, token);

  for (const match of masked.matchAll(WIKI_TOKEN)) {
    const token = match[0];
    if (replacements.has(token)) {
      links += 1;
      continue;
    }
    const inner = match[1];
    const pipe = inner.indexOf('|');
    const targetRaw = pipe === -1 ? inner : inner.slice(0, pipe);
    const rest = pipe === -1 ? '' : inner.slice(pipe);
    // A `#` usually starts an anchor — but a NOTE NAME may contain one
    // (`[[docs/notes#1.md]]`). Literal path wins over the anchor split when it
    // resolves to a moved file, matching the resolver's literal-first order.
    const literal = targetRaw.includes('#') ? resolveWorkspacePath(targetRaw.trim(), prePaths) : null;
    const literalMoved = literal !== null && moved.has(literal);
    const hash = literalMoved ? -1 : targetRaw.indexOf('#');
    const pathRaw = hash === -1 ? targetRaw : targetRaw.slice(0, hash);
    const fragment = hash === -1 ? '' : targetRaw.slice(hash);
    const trimmed = pathRaw.trim();
    if (!trimmed) continue; // same-file anchor `[[#Heading]]`
    const newPath = rewriteWikiPath(trimmed, moved, prePaths, postPaths);
    if (newPath === null || newPath === trimmed || alsoInCode(token)) continue;
    const leading = pathRaw.match(/^\s*/)[0];
    const trailing = pathRaw.match(/\s*$/)[0];
    const bang = token.startsWith('!') ? '!' : '';
    replacements.set(token, `${bang}[[${leading}${newPath}${trailing}${fragment}${rest}]]`);
    links += 1;
  }

  const dir =
    filePath && filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  const preSet = new Set(prePaths);

  for (const match of masked.matchAll(MD_LINK)) {
    const token = match[0];
    if (replacements.has(token)) {
      links += 1;
      continue;
    }
    // Split off a `#fragment` before resolving — navigation strips it too —
    // and re-append it to the rewritten href so anchored links keep their
    // anchor. A fragment-only href (`#Heading`) is a same-file anchor: skip.
    // Literal-path-first, like the wiki branch: a FILE NAME may contain `#`
    // (`docs/notes#1.md`), and the whole href winning resolution to a moved
    // file suppresses the anchor split.
    const wholeHref = match[2];
    let literalHit = false;
    if (wholeHref.includes('#')) {
      const dirJoin = wholeHref.startsWith('/') ? null : joinRelative(dir, wholeHref);
      const rootRes = resolveWorkspacePath(
        wholeHref.replace(/^(\.\.?\/)+/, '').replace(/^\/+/, ''),
        prePaths,
      );
      literalHit =
        (dirJoin !== null && dirJoin !== '' && moved.has(dirJoin)) ||
        (rootRes !== null && moved.has(rootRes));
    }
    const fragAt = literalHit ? -1 : wholeHref.indexOf('#');
    const href = fragAt === -1 ? wholeHref : wholeHref.slice(0, fragAt);
    const fragment = fragAt === -1 ? '' : wholeHref.slice(fragAt);
    if (!href) continue;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      /* malformed escape — match the raw form only */
    }
    const candidates = decoded === href ? [href] : [href, decoded];

    // Resolution mirrors navigation (resolveLinkTargetToPath): the href joins
    // against the linking file's own directory FIRST — `[Plan](./Plan.md)`
    // inside `notes/index.md` means `notes/Plan.md` — then falls back to a
    // workspace-root exact path. A join that lands on an existing UNMOVED file
    // wins outright (navigation would open that file), so the root fallback
    // must not rewrite it.
    let oldFull = null;
    let viaDir = false;
    let inferredMd = false;
    let pointsAtUnmoved = false;
    for (const cand of candidates) {
      // A leading `/` is workspace-root absolute to navigation — it never
      // joins against the document's folder, so it must not shadow here.
      if (cand.startsWith('/')) continue;
      const joined = joinRelative(dir, cand);
      if (joined === null || joined === '') continue;
      if (moved.has(joined)) {
        oldFull = joined;
        viaDir = true;
        break;
      }
      if (preSet.has(joined)) {
        pointsAtUnmoved = true; // literal doc-relative hit on an unmoved file
        break;
      }
      // Extension inference (`./Plan` → notes/Plan.md), literal misses only.
      if (moved.has(`${joined}.md`)) {
        oldFull = `${joined}.md`;
        viaDir = true;
        inferredMd = true;
        break;
      }
      if (preSet.has(`${joined}.md`)) {
        pointsAtUnmoved = true; // inferred doc-relative hit on an unmoved file
        break;
      }
    }
    if (pointsAtUnmoved) continue;
    if (!oldFull) {
      // Root fallback through the same wiki resolver navigation uses, so a
      // bare `Plan.md` matches `notes/Plan.md` by suffix exactly when a click
      // would have. External URLs never resolve (scheme/host contain `/`).
      for (const cand of candidates) {
        const t = cand.replace(/^(\.\.?\/)+/, '').replace(/^\/+/, '');
        const resolved = t ? resolveWorkspacePath(t, prePaths) : null;
        if (resolved && moved.has(resolved)) {
          oldFull = resolved;
          break;
        }
      }
    }
    if (!oldFull || alsoInCode(token)) continue;
    const newFull = moved.get(oldFull);

    // Keep the author's document-relative spelling when the target is still
    // reachable that way — measured against the linking file's POST-rename
    // directory, since that's where the href will resolve from now on. A
    // folder move that carries both files leaves the relative href valid and
    // unchanged (`newHref === href` → no edit). Otherwise fall back to the
    // workspace path; navigation tries the file's own folder first, so when a
    // same-spelled path exists there the fallback is written root-absolute
    // (leading `/`), which the resolver treats as unambiguous.
    const postFile = moved.get(filePath) ?? filePath ?? '';
    const postDir = postFile.includes('/') ? postFile.slice(0, postFile.lastIndexOf('/')) : '';
    let newHref = newFull;
    if (viaDir && (postDir === '' || newFull.startsWith(`${postDir}/`))) {
      const rel = postDir === '' ? newFull : newFull.slice(postDir.length + 1);
      newHref = (href.startsWith('./') ? './' : '') + (inferredMd ? rel.replace(/\.md$/i, '') : rel);
    } else if (href.startsWith('/')) {
      newHref = `/${newFull}`; // keep the author's root-absolute spelling
    } else if (postDir) {
      const shadow = joinRelative(postDir, newFull);
      if (shadow && shadow !== newFull && postPaths.includes(shadow)) newHref = `/${newFull}`;
    }
    if (href.includes('%20')) newHref = newHref.split(' ').join('%20');
    if (newHref === href) continue;
    replacements.set(token, `${match[1]}${newHref}${fragment}${match[3]}`);
    links += 1;
  }

  return {
    // Longest token first: apply-edits runs sequentially, and `[[Old]]` is a
    // substring of `![[Old]]` (same for `[x](p)` inside `![x](p)`) — a shorter
    // replace_all applied first would mutate the longer token and strand its
    // own edit on ANCHOR_NOT_FOUND.
    edits: [...replacements.entries()]
      .sort(([a], [b]) => b.length - a.length)
      .map(([old_string, new_string]) => ({
        old_string,
        new_string,
        replace_all: /** @type {const} */ (true),
      })),
    links,
  };
}
