import {
  listBlockAnchors,
  listHeadingAnchors,
  resolveWorkspacePath,
} from '@/lib/markdown/anchors.mjs';
import { parseMarkdown } from '@/lib/markdown/parser.mjs';

/**
 * Pure logic behind the `[[note#` / `[[note#^` picker anchor mode — split out
 * of the editor so the state machine is unit-testable without a ProseMirror
 * view. The editor supplies note text (live doc for the open file, fetched
 * `file-content` for others) and renders the suggestions.
 */

export type WikiAnchorMode = {
  /** Text before `#` — empty means the current file. */
  filePart: string;
  kind: 'heading' | 'block';
  /** Text after `#` (after `#^` for blocks) used to filter suggestions. */
  anchorQuery: string;
};

/** Detect anchor mode in a `[[` picker query. Null = plain file search. */
export function splitAnchorQuery(query: string): WikiAnchorMode | null {
  const hash = query.indexOf('#');
  if (hash === -1) return null;
  const filePart = query.slice(0, hash).trim();
  const fragment = query.slice(hash + 1);
  if (fragment.startsWith('^')) return { filePart, kind: 'block', anchorQuery: fragment.slice(1) };
  return { filePart, kind: 'heading', anchorQuery: fragment };
}

/** The note the anchor mode targets, or null when nothing resolves. */
export function resolveAnchorNotePath(
  mode: WikiAnchorMode,
  paths: string[],
  currentFilePath: string | null | undefined,
): string | null {
  if (!mode.filePart) return currentFilePath ?? null;
  return resolveWorkspacePath(mode.filePart, paths);
}

export type WikiAnchorSuggestion =
  | { kind: 'heading'; path: string; heading: string; level: number; target: string; alias: string }
  | {
      kind: 'block';
      path: string;
      /** The block's existing `^id`. Only ID-carrying blocks are listed —
       *  authoring an ID is manual (type ` ^id` at the end of the line). */
      id: string;
      preview: string;
      index: number;
      alias: string;
    };

const MAX_ANCHOR_SUGGESTIONS = 50;

/** Display base for aliases: `notes/plan.md` → `plan`. */
export function wikiAliasBase(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

export function buildAnchorSuggestions(
  content: string,
  path: string,
  mode: WikiAnchorMode,
): WikiAnchorSuggestion[] {
  const blocks = parseMarkdown(content);
  const q = mode.anchorQuery.trim().toLowerCase();
  if (mode.kind === 'heading') {
    return listHeadingAnchors(blocks)
      .filter((h) => !q || h.text.toLowerCase().includes(q))
      .slice(0, MAX_ANCHOR_SUGGESTIONS)
      .map((h) => ({
        kind: 'heading' as const,
        path,
        heading: h.text,
        level: h.level,
        target: `${path}#${h.text}`,
        alias: h.text,
      }));
  }
  return listBlockAnchors(blocks)
    .filter((b) => !q || b.preview.toLowerCase().includes(q) || b.id.toLowerCase().includes(q))
    .slice(0, MAX_ANCHOR_SUGGESTIONS)
    .map((b) => ({
      kind: 'block' as const,
      path,
      id: b.id,
      preview: b.preview,
      index: b.index,
      alias: `${wikiAliasBase(path)} ^${b.id}`,
    }));
}
