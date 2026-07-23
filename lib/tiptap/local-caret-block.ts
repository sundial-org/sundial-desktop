import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Stamps the top-level block(s) containing the local selection with
 * `.sd-caret-block`, so the content-visibility scroll optimization
 * (globals.css) can exclude them the way it already excludes blocks holding a
 * REMOTE collaborator's caret (`.sundial-cursor`). The local caret is a native
 * caret with no DOM element, so CSS alone can't carve it out.
 *
 * Why it must be excluded: Blink can leave the DOM caret behind a character
 * typed into a freshly created `content-visibility: auto` block — the new
 * block starts in the not-yet-determined (skipped) state until the next
 * rendering pass, and caret canonicalization inside a skipped subtree is
 * unreliable. When no frame runs between Enter (split) and the next keystroke,
 * ProseMirror's mutation flush then reads the stale selection and re-anchors
 * the caret BEFORE the typed character, so all further typing lands in front
 * of it ("/ai foo" becomes "ai foo/" — the slash-menu rotation bug, July
 * 2026). Keeping the caret block out of the optimization means the block the
 * user is typing in — including one a Enter-split just created, since node
 * decorations render in the same transaction — is always a normally-rendered
 * subtree.
 */
export const LocalCaretBlock = Extension.create({
  name: 'localCaretBlock',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const { $from, $to } = state.selection;
            const decorations: Decoration[] = [];
            const seen = new Set<number>();
            // Depth 0 = a doc-level position (NodeSelection of a top block,
            // gap cursor): the endpoint's block is the node just inside the
            // selection — after `$from`, before `$to`.
            const positions = [
              $from.depth > 0 ? $from.before(1) : $from.pos,
              $to.depth > 0 ? $to.before(1) : $to.pos - ($to.nodeBefore?.nodeSize ?? 0),
            ];
            for (const pos of positions) {
              if (seen.has(pos)) continue;
              seen.add(pos);
              const node = state.doc.nodeAt(pos);
              if (!node?.isBlock) continue;
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, { class: 'sd-caret-block' }),
              );
            }
            return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
          },
        },
      }),
    ];
  },
});
