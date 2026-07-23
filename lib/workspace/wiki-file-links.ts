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
  const t = target.trim();
  if (!t) return null;
  if (knownPaths.includes(t)) return t;

  const matches = knownPaths.filter((p) => {
    const base = p.split('/').pop() ?? p;
    const stem = base.replace(/\.[^.]+$/, '');
    return (
      base === t ||
      stem === t ||
      p === t ||
      p.endsWith(`/${t}`) ||
      p.endsWith(`/${t}.md`)
    );
  });

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  const exactBase = matches.find((p) => (p.split('/').pop() ?? p) === t);
  if (exactBase) return exactBase;
  const exactStem = matches.find((p) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '') === t);
  return exactStem ?? matches[0]!;
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
