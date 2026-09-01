import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { humanizeCalloutType } from '@/lib/markdown/parser.mjs';

/* ── Callout editing commands ──────────────────────────────────────────
 *  Everything the callout controls bar does, as plain functions over an
 *  editor — DOM-free so they can be exercised headlessly, same idiom as
 *  slash-items.ts.
 *
 *  All three are pure ATTRIBUTE edits on the existing blockquote: no node is
 *  re-created, so the callout's content, its marks and its collaborators'
 *  positions are untouched, and review sees one attribute change per step.
 *  Flags are written as `'true'` / null (never booleans) — see the note in
 *  callout-fold.ts: y-prosemirror stores the raw value in the Y.XmlElement and
 *  deletes the attribute on null, which is exactly the shape the markdown
 *  codec builds.
 * ───────────────────────────────────────────────────────────────────── */

const FLAGS = ['calloutFoldable', 'calloutCollapsed', 'calloutTitleExplicit'] as const;

export type ActiveCallout = { pos: number; node: ProseMirrorNode };

/** The INNERMOST callout the caret sits in, or null. Callouts nest, and the
 *  controls must act on the one the caret is actually in. */
export function activeCallout(state: EditorState): ActiveCallout | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'blockquote' && node.attrs.calloutType) {
      return { pos: $from.before(depth), node };
    }
  }
  return null;
}

/** Change a callout's type in place.
 *
 *  A callout with no title of its own still SHOWS one: the humanized type name
 *  ("Tip"), which the serializer recognises as the default and omits. Left
 *  behind after a type change it no longer matches the new default, so it would
 *  come back out as an explicit title (`> [!warning] Tip`) — hence the rewrite.
 *
 *  But only when the visible title really is that default label. The
 *  `calloutTitleExplicit` flag alone is NOT enough: it's set by the parser at
 *  load time, so a title the user typed into a callout that started without one
 *  still carries `false`, and keying on the flag erased what they wrote. Compare
 *  the actual text against the OLD type's label — the same test the serializer
 *  uses to decide whether a title is the default or content. */
export function setCalloutType(editor: Editor, type: string): boolean {
  const active = activeCallout(editor.state);
  if (!active) return false;
  const { pos, node } = active;
  if (node.attrs.calloutType === type) return false;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setNodeAttribute(pos, 'calloutType', type);
      const title = node.firstChild;
      const isDefaultLabel =
        !node.attrs.calloutTitleExplicit &&
        title?.isTextblock &&
        title.textContent.trim() === humanizeCalloutType(String(node.attrs.calloutType));
      // Positions are unaffected by the AttrStep above, so they still resolve.
      if (isDefaultLabel && title) {
        const from = pos + 2;
        const label = humanizeCalloutType(type);
        // `schema.text('')` throws — an unnameable type just empties the row.
        tr.replaceWith(from, from + title.content.size, label ? editor.schema.text(label) : []);
      }
      return true;
    })
    .run();
}

/** Toggle the `-`/`+` fold marker on the callout the caret is in. */
export function toggleCalloutFoldable(editor: Editor): boolean {
  const active = activeCallout(editor.state);
  if (!active) return false;
  const foldable = !active.node.attrs.calloutFoldable;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setNodeAttribute(active.pos, 'calloutFoldable', foldable ? 'true' : null);
      // A callout that isn't foldable can't stay collapsed: without a marker
      // there is nowhere for the collapsed state to live in the markdown, and
      // the body would be hidden with no way to bring it back.
      if (!foldable) tr.setNodeAttribute(active.pos, 'calloutCollapsed', null);
      return true;
    })
    .run();
}

/** Drop the callout, keep every line: it becomes a plain blockquote. The
 *  inverse of making a quote a callout, and non-destructive — one more toggle
 *  gets to plain paragraphs. */
export function removeCallout(editor: Editor): boolean {
  const active = activeCallout(editor.state);
  if (!active) return false;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setNodeAttribute(active.pos, 'calloutType', null);
      for (const flag of FLAGS) tr.setNodeAttribute(active.pos, flag, null);
      return true;
    })
    .run();
}
