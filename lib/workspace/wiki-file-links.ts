export type ContextFileEntry = { path: string; source: 'open' | 'mention' };
export type FileMentionTrigger = 'at' | 'wiki';

export type FileMentionMatch = {
  query: string;
  /** Index of `@` or the first `[` in `[[`. */
  start: number;
  trigger: FileMentionTrigger;
};

const WIKI_LINK_IN_TEXT_RE = /\[\[([^\]\n]+)\]\]/g;
const AT_MENTION_RE = /(?:^|[\s(,;:!?])@([^\s\[\]\n@]*)$/;

/** Active file-picker trigger before the caret: Obsidian-style `[[query` or `@query`. */
export function detectFileMention(value: string, caret: number): FileMentionMatch | null {
  const before = value.slice(0, caret);

  const wikiIdx = before.lastIndexOf('[[');
  if (wikiIdx !== -1) {
    const candidate = before.slice(wikiIdx + 2);
    if (!candidate.includes(']]') && !candidate.includes('\n')) {
      return { query: candidate, start: wikiIdx, trigger: 'wiki' };
    }
  }

  const atMatch = AT_MENTION_RE.exec(before);
  if (!atMatch) return null;
  const query = atMatch[1] ?? '';
  return { query, start: caret - query.length - 1, trigger: 'at' };
}

/** Raw inner text of each `[[...]]` in the message (before path resolution). */
export function extractWikiLinkTargets(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(WIKI_LINK_IN_TEXT_RE)) {
    let inner = (match[1] ?? '').trim();
    if (inner.includes('|')) inner = inner.split('|')[0]?.trim() ?? '';
    if (!inner || seen.has(inner)) continue;
    seen.add(inner);
    out.push(inner);
  }
  return out;
}

export function textHasWikiLinks(text: string): boolean {
  WIKI_LINK_IN_TEXT_RE.lastIndex = 0;
  const result = WIKI_LINK_IN_TEXT_RE.test(text);
  WIKI_LINK_IN_TEXT_RE.lastIndex = 0;
  return result;
}

export function formatWikiLink(path: string): string {
  return `[[${path}]]`;
}

/** Map a wiki target (path or basename) to a workspace file path. */
export function resolveWikiTargetToPath(target: string, knownPaths: string[]): string | null {
  // A literal path match — exact-case, then case-insensitive — wins before
  // any Obsidian interpretation, so a file whose name contains `#` stays
  // reachable and the fragment split can't eat part of its name.
  const raw = target.trim();
  if (knownPaths.includes(raw)) return raw;
  const rawLower = raw.toLowerCase();
  const ciLiteral = knownPaths.find((p) => p.toLowerCase() === rawLower);
  if (ciLiteral) return ciLiteral;
  // Obsidian allows heading/block refs after the note name — [[Note#Heading]],
  // [[Note#^block]]. Resolve to the note itself; the fragment is dropped.
  const t = (raw.split('#')[0] ?? '').trim();
  if (!t) return null;
  if (knownPaths.includes(t)) return t;
  // Obsidian resolves note names case-insensitively; exact case wins first.
  return (
    pickWikiMatch(t, knownPaths, (s) => s) ??
    pickWikiMatch(t, knownPaths, (s) => s.toLowerCase())
  );
}

function pickWikiMatch(
  target: string,
  knownPaths: string[],
  norm: (s: string) => string,
): string | null {
  const t = norm(target);
  const matches = knownPaths.filter((p0) => {
    const p = norm(p0);
    const base = p.split('/').pop() ?? p;
    const stem = base.replace(/\.[^.]+$/, '');
    return (
      base === t ||
      stem === t ||
      p === t ||
      p.replace(/\.[^./]+$/, '') === t ||
      p.endsWith(`/${t}`) ||
      p.endsWith(`/${t}.md`)
    );
  });

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  // An exact full-path match (with or without its extension) beats suffix
  // matches, so [[foo/bar]] picks foo/bar.md over archive/foo/bar.md. The
  // .md note still wins an extension tie (foo/bar.md over foo/bar.txt).
  const exactPaths = matches.filter(
    (p) => norm(p) === t || norm(p).replace(/\.[^./]+$/, '') === t,
  );
  if (exactPaths.length > 0) {
    return exactPaths.find((p) => norm(p).endsWith('.md')) ?? exactPaths[0]!;
  }
  const baseOf = (p: string) => norm(p).split('/').pop() ?? norm(p);
  const exactBase = matches.find((p) => baseOf(p) === t);
  if (exactBase) return exactBase;
  const exactStem = matches.find((p) => baseOf(p).replace(/\.[^.]+$/, '') === t);
  // Ties that fall through to list order prefer the markdown note —
  // Obsidian's default link target — over a sibling with another extension.
  return exactStem ?? matches.find((p) => norm(p).endsWith('.md')) ?? matches[0]!;
}

/** Join an href onto a directory, resolving `.`/`..`; null when it escapes the root. */
function joinRelativeHref(dir: string, href: string): string | null {
  const segs = dir ? dir.split('/') : [];
  for (const part of href.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segs.length === 0) return null;
      segs.pop();
    } else {
      segs.push(part);
    }
  }
  return segs.length > 0 ? segs.join('/') : null;
}

/** The href plus its fragment-stripped and URL-decoded variants, in match order. */
function hrefCandidates(target: string): string[] {
  const out = [target];
  const noFragment = target.split('#')[0] ?? '';
  if (noFragment && noFragment !== target) out.push(noFragment);
  for (const candidate of [...out]) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded !== candidate) out.push(decoded);
    } catch {
      /* malformed percent-escape — skip the decoded variant */
    }
  }
  return out;
}

/**
 * Editor navigation: map a link target — a wikilink target or a relative
 * markdown href — to an existing workspace path, Obsidian-style. Markdown
 * hrefs are document-relative: when `fromPath` (the linking document) is
 * given, candidates resolve against its directory first — `./`, `../`, and
 * bare `Plan.md` alike — before the vault-wide fallback chain (exact path,
 * basename/stem anywhere, URL-decoded). Wikilink targets are vault-wide by
 * definition, so their callers pass no `fromPath`. Falls back to the
 * normalized target when nothing matches, preserving navigate-verbatim
 * behavior for paths the caller's file list doesn't cover.
 */
export function resolveLinkTargetToPath(
  target: string,
  knownPaths: string[],
  fromPath?: string | null,
): string {
  if (fromPath && !target.startsWith('/')) {
    const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const joined = hrefCandidates(target)
      .map((href) => joinRelativeHref(dir, href))
      .filter((j): j is string => j !== null);
    // Exact case wins over case-insensitive; within each pass, a literal
    // match wins over extension inference (`./Plan` → notes/Plan.md).
    for (const norm of [(s: string) => s, (s: string) => s.toLowerCase()]) {
      for (const j of joined) {
        const cand = norm(j);
        const literal = knownPaths.find((p) => norm(p) === cand);
        if (literal) return literal;
      }
      for (const j of joined) {
        const cand = norm(j);
        const hits = knownPaths.filter((p) => norm(p).replace(/\.[^./]+$/, '') === cand);
        if (hits.length > 0) {
          return hits.find((p) => norm(p).endsWith('.md')) ?? hits[0]!;
        }
      }
    }
  }
  const t = target.replace(/^(\.\.?\/)+/, '').replace(/^\/+/, '');
  let resolved = resolveWikiTargetToPath(t, knownPaths);
  if (!resolved) {
    try {
      const decoded = decodeURIComponent(t);
      if (decoded !== t) resolved = resolveWikiTargetToPath(decoded, knownPaths);
    } catch {
      /* malformed percent-escape — keep the raw target */
    }
  }
  return resolved ?? t;
}

export function contextFilesFromWikiText(
  text: string,
  knownPaths: string[],
): ContextFileEntry[] {
  const out: ContextFileEntry[] = [];
  const seen = new Set<string>();
  for (const target of extractWikiLinkTargets(text)) {
    const path = resolveWikiTargetToPath(target, knownPaths);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, source: 'mention' });
  }
  return out;
}

export function mergeContextFileEntries(
  ...groups: ContextFileEntry[][]
): ContextFileEntry[] {
  const byPath = new Map<string, 'open' | 'mention'>();
  for (const group of groups) {
    for (const entry of group) {
      const existing = byPath.get(entry.path);
      if (!existing) {
        byPath.set(entry.path, entry.source);
      } else if (entry.source === 'open') {
        byPath.set(entry.path, 'open');
      }
    }
  }
  return Array.from(byPath.entries())
    .slice(0, 10)
    .map(([path, source]) => ({ path, source }));
}
