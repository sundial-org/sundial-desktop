import { Extension } from '@tiptap/core';
import { Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { markdownToProseMirror } from '@/lib/markdown/codec';

/**
 * Frontmatter only EXISTS at the start of a file — `parseBlockLines` refuses to
 * recognize it anywhere else. Pasting a note into the middle of a document (or
 * typing above an existing block) would otherwise leave a `frontmatter` node at
 * an interior position that serializes verbatim and reparses as `---` rules +
 * ordinary markdown on the next load: a phantom structural diff.
 *
 * This rewrites any interior node into exactly what that reparse produces, so
 * the document is already in its stable form. The replacement is built by the
 * SHARED codec (never a second parser), so YAML lines that happen to be valid
 * markdown — `tags:` + `- research`, a `# comment` — become the same list and
 * heading nodes a reload would produce. (Codex P2)
 *
 * Lives apart from the `Frontmatter` node because `lib/markdown/codec` imports
 * that node to build `markdownSchema`; importing the codec from there would be
 * a cycle.
 */

/** Sentinel block so the shared parser sees the text as INTERIOR, not as a
 *  file-leading fence. Dropped from the result. */
const INTERIOR_PREFIX = 'x\n\n';

/**
 * The nodes a mid-document `---\n…\n---` run parses into, built with the shared
 * codec and re-created in `schema` (the live editor's superset schema — the
 * codec builds against `markdownSchema`, and PM requires same-schema nodes).
 * Returns null when the parse can't be represented, leaving the node untouched.
 */
export function interiorFrontmatterNodes(text: string, schema: Schema): ProseMirrorNode[] | null {
  try {
    const parsed = markdownToProseMirror(`${INTERIOR_PREFIX}${text}`).toJSON() as {
      content?: unknown[];
    };
    const content = parsed.content ?? [];
    if (content.length < 2) return null; // sentinel + at least one block
    return content.slice(1).map((json) => ProseMirrorNode.fromJSON(schema, json));
  } catch {
    return null;
  }
}

export const FrontmatterNormalize = Extension.create({
  name: 'frontmatterNormalize',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(_transactions, _oldState, newState) {
          // EVERY depth, not just top level: pasting with the cursor inside a
          // list item / blockquote / table cell nests the node, and the
          // serializers then emit its multiline fences without the container's
          // line prefix — a list whose text lands outdented at column 0 and
          // reparses into a different structure entirely. Only the node at the
          // very start of the document is real frontmatter. (Codex P2)
          const stray: Array<{ pos: number; node: ProseMirrorNode }> = [];
          const root = newState.doc.firstChild;
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== 'frontmatter') return true;
            // A pending suggestion may hold a struck frontmatter at the head
            // and its replacement right behind it: both are real, resolution
            // leaves exactly one at position 0.
            const replacement = pos === root!.nodeSize
              && root!.type.name === 'frontmatter' && root!.attrs.suggestionDeletionId != null
              && node.attrs.suggestionInsertionId != null;
            if (!(pos === 0 && node === root) && !replacement) stray.push({ pos, node });
            return false;
          });
          if (stray.length === 0) return null;
          const tr = newState.tr;
          let changed = false;
          // Back to front so earlier positions stay valid.
          for (const { pos, node } of stray.reverse()) {
            const replacement = interiorFrontmatterNodes(node.textContent, newState.schema);
            if (!replacement || replacement.length === 0) continue;
            try {
              tr.replaceWith(pos, pos + node.nodeSize, replacement);
              changed = true;
            } catch {
              // The parsed blocks don't fit here (e.g. a leading rule inside a
              // list item, whose schema demands a paragraph first). Leaving the
              // node is no worse than before; never break the editor over it.
            }
          }
          return changed ? tr : null;
        },
      }),
    ];
  },
});

export default FrontmatterNormalize;
