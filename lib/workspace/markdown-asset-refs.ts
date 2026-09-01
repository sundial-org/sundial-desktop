/**
 * Workspace-relative asset references in a markdown source — markdown image
 * embeds AND raw HTML `<img src>` — resolved the way the export pool will
 * materialize them (posix normpath with `..` resolved, against both the
 * workspace root and the markdown file's directory). The export route gates
 * scoped guests on every resolution being covered by their grants; a
 * reference with NO in-workspace resolution is UNRESOLVABLE and must block
 * the export — never allow what we can't check.
 *
 * The pre-resolution steps MIRROR THE POOL (`_markdown_asset_paths` in
 * sandbox/compile_pool.py) exactly — strip `#hash`/`?query`, URL-decode,
 * skip only `://`-scheme'd and `data:` refs. Root-absolute `/x` (and
 * protocol-relative `//x`) refs are NOT skipped: the pool lstrips the
 * slashes and materializes them from the workspace root, so the gate must
 * resolve them the same way. Same for `%2F`-encoded traversal — the pool
 * decodes before normpath, so the gate decodes too.
 */

/** Python `urllib.parse.unquote` shape: decode each run of %XX escapes,
 *  leaving a run untouched when it isn't valid UTF-8 (the pool would yield
 *  replacement chars there — paths that can never match a manifest entry, so
 *  materialization and gating both no-op). */
function unquoteLikePool(value: string): string {
  return value.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });
}

/** Posix-normalize, resolving `.`/`..`; null when the path escapes the
 *  workspace root or normalizes to nothing. */
function normalizeResolved(raw: string): string | null {
  const segments = raw.trim().replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null; // escapes the workspace root
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out.join('/') : null;
}

function extractImageSrcs(source: string): string[] {
  const srcs: string[] = [];
  // Markdown embeds: ![alt](src …attrs)
  for (const match of source.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) {
    if (match[1]) srcs.push(match[1]);
  }
  // Raw HTML: <img src="…"> / <img src='…'> / <img src=…>
  for (const match of source.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const src = match[1] ?? match[2] ?? match[3];
    if (src) srcs.push(src);
  }
  return srcs;
}

export type ReferencedAssets = {
  /** One entry per relative ref: its in-workspace resolutions in the POOL'S
   *  resolution order — markdown-dir-relative FIRST, workspace-root second.
   *  The pool materializes the first resolution that actually exists, so
   *  callers gate coverage on that one only. */
  refs: Array<{ src: string; resolutions: string[] }>;
  /** Relative refs with NO in-workspace resolution — the caller must block. */
  unresolvable: string[];
};

export function referencedAssets(source: string, mdPath: string): ReferencedAssets {
  const mdDir = mdPath.includes('/') ? mdPath.slice(0, mdPath.lastIndexOf('/')) : '';
  const refs: Array<{ src: string; resolutions: string[] }> = [];
  const unresolvable: string[] = [];
  for (const raw of extractImageSrcs(source)) {
    const src = unquoteLikePool(raw.trim().split('#')[0].split('?')[0]);
    if (!src || src.includes('://') || src.startsWith('data:')) continue;
    const resolutions = (src.startsWith('/')
      ? // Root/protocol-relative: the pool's md-dir candidate keeps the
        // leading slash (never a manifest key); its effective resolution is
        // lstrip('/') against the workspace root.
        [normalizeResolved(src.replace(/^\/+/, ''))]
      : [
          // Pool order: relative to the markdown file first, then workspace root.
          normalizeResolved(mdDir ? `${mdDir}/${src}` : src),
          normalizeResolved(src),
        ]
    ).filter((value): value is string => value !== null);
    const deduped = [...new Set(resolutions)];
    if (deduped.length === 0) {
      unresolvable.push(src);
      continue;
    }
    refs.push({ src, resolutions: deduped });
  }
  return { refs, unresolvable };
}
