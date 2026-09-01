import { Extension } from '@tiptap/core';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
// Same key the editor uses to recognise remote (collaborator) transactions
// (see collab-editor.tsx) — so a peer's edit never pops open a local fold.
import { ySyncPluginKey } from '@tiptap/y-tiptap';

/* ── Obsidian-style fold (collapse) for headings and list items ─────────
 *  Hovering to the left of a heading / bullet that HAS children reveals a
 *  chevron in the gutter; clicking it hides the descendants until the next
 *  equal-or-higher heading (headings) or the nested child list (list items).
 *
 *  Fold is LOCAL VIEW STATE ONLY. It lives in this plugin's state — never a
 *  node attribute, never the Y.Doc. Toggling dispatches a *step-less*
 *  transaction (`setMeta` only, `docChanged === false`), so y-prosemirror
 *  emits zero Yjs updates: folding is never an attributed edit, never a diff,
 *  and never collapses the doc for other collaborators. Positions are mapped
 *  through `tr.mapping` so a fold stays anchored when text above it changes
 *  (incl. remote / multiplayer edits, which arrive as transactions too).
 * ───────────────────────────────────────────────────────────────────────── */

export type FoldRange = { from: number; to: number };
type FoldInfo = { hidden: FoldRange[] };
type FoldPluginState = { folded: number[]; decorations: DecorationSet };

export const foldPluginKey = new PluginKey<FoldPluginState>('foldGutter');

/** The blocks a folded heading/listItem should hide, or null if nothing to
 *  hide (i.e. the block isn't actually foldable). `pos` is the position just
 *  before the block node. */
function foldInfoAt(doc: ProseMirrorNode, pos: number): FoldInfo | null {
  const node = doc.nodeAt(pos);
  if (!node) return null;
  if (node.type.name === 'heading') return headingFold(doc, pos, node);
  if (node.type.name === 'listItem') return listItemFold(pos, node);
  return null;
}

/** A heading hides every following sibling until the next heading of
 *  equal-or-higher level (or the end of its parent). Each sibling is its own
 *  range: `Decoration.node` decorates a SINGLE node, so a range spanning
 *  multiple blocks would silently apply to nothing. */
function headingFold(doc: ProseMirrorNode, pos: number, node: ProseMirrorNode): FoldInfo | null {
  const level = node.attrs.level as number;
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  const index = $pos.index();
  const hidden: FoldRange[] = [];
  let from = pos + node.nodeSize; // end of the heading = start of the next block
  for (let i = index + 1; i < parent.childCount; i += 1) {
    const sib = parent.child(i);
    if (sib.type.name === 'heading' && (sib.attrs.level as number) <= level) break;
    hidden.push({ from, to: from + sib.nodeSize });
    from += sib.nodeSize;
  }
  return hidden.length ? { hidden } : null;
}

/** A list item hides everything below its own first line: nested child lists AND
 *  the continuation blocks a *loose* item carries (`- parent\n\n  continuation`),
 *  which are direct children of the same listItem. Hiding only sublists would
 *  leave those paragraphs on screen while the item is flagged collapsed. The
 *  leading paragraph is the item's own line (schema-required), so it always
 *  stays visible. */
function listItemFold(pos: number, node: ProseMirrorNode): FoldInfo | null {
  const hidden: FoldRange[] = [];
  node.forEach((child, offset, index) => {
    if (index === 0) return; // the item's own line
    const from = pos + 1 + offset; // pos+1 = inside the listItem
    hidden.push({ from, to: from + child.nodeSize });
  });
  return hidden.length ? { hidden } : null;
}

function chevron(pos: number, isFolded: boolean): HTMLElement {
  const el = document.createElement('span');
  el.className = 'sd-fold-toggle' + (isFolded ? ' sd-fold-toggle-collapsed' : '');
  el.setAttribute('data-fold-pos', String(pos));
  el.setAttribute('contenteditable', 'false');
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', isFolded ? 'Expand' : 'Collapse');
  return el;
}

/** Does selection [from, to] intersect a hidden range [r.from, r.to)? A caret
 *  (from === to) counts as inside when r.from <= from < r.to (so a caret at the
 *  range start is caught, one at the range end is not); a real range uses the
 *  standard half-open overlap so a selection whose HEAD (not just its anchor)
 *  reaches into hidden content is caught too. Shared by the pre-fold caret guard
 *  and the auto-expand so the two never disagree at a boundary. */
function selectionInHidden(from: number, to: number, hidden: FoldRange[]): boolean {
  return hidden.some((r) =>
    from === to ? from >= r.from && from < r.to : from < r.to && to > r.from,
  );
}

function build(doc: ProseMirrorNode, folded: number[]): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    const name = node.type.name;
    if (name !== 'heading' && name !== 'listItem') return true; // keep descending
    const info = foldInfoAt(doc, pos);
    if (!info) return true;
    const isFolded = folded.includes(pos);
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: isFolded ? 'sd-foldable sd-collapsed' : 'sd-foldable',
      }),
    );
    decos.push(
      Decoration.widget(pos + 1, () => chevron(pos, isFolded), {
        side: -1,
        // Key includes fold state so PM swaps the DOM (fresh aria/class) on toggle.
        key: `fold-${pos}-${isFolded ? 1 : 0}`,
        ignoreSelection: true,
      }),
    );
    if (isFolded) {
      for (const r of info.hidden) {
        decos.push(Decoration.node(r.from, r.to, { class: 'sd-fold-hidden' }));
      }
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

/** Re-anchor folded positions across a doc change and drop any that no longer
 *  sit at a foldable block start (e.g. the block was deleted or merged). The
 *  anchor is the position *before* the folded block, so it must bias to the
 *  right (assoc +1): content inserted exactly at the boundary (a block dropped
 *  in just above the fold, incl. at position 0) then stays before the block and
 *  the anchor rides along with it, instead of being stranded on the new node. */
function remap(tr: Transaction, folded: number[], doc: ProseMirrorNode): number[] {
  const next: number[] = [];
  for (const pos of folded) {
    const mapped = tr.mapping.mapResult(pos, 1);
    if (mapped.deleted) continue;
    const p = mapped.pos;
    // Deleting the folded block's own node maps its START (assoc +1) onto the
    // next block — which may itself be a foldable heading, so a plain
    // foldInfoAt(p) check would silently TRANSFER the fold onto it. Guard by
    // mapping the node's own end (assoc -1): if it collapses onto the start, the
    // node is gone and the fold must be released, not re-anchored on its
    // neighbour. Editing text *inside* the block leaves end > start, so folds
    // survive ordinary edits.
    const oldNode = tr.before.nodeAt(pos);
    if (oldNode && tr.mapping.mapResult(pos + oldNode.nodeSize, -1).pos <= p) continue;
    if (!next.includes(p) && foldInfoAt(doc, p)) next.push(p);
  }
  return next;
}

export const FoldGutter = Extension.create({
  name: 'foldGutter',

  addProseMirrorPlugins() {
    return [
      new Plugin<FoldPluginState>({
        key: foldPluginKey,
        state: {
          init: (_config, state: EditorState) => ({
            folded: [],
            decorations: build(state.doc, []),
          }),
          apply: (tr, value, _oldState, newState): FoldPluginState => {
            const toggle = tr.getMeta(foldPluginKey) as { toggle?: number } | undefined;
            if (toggle?.toggle != null) {
              const pos = toggle.toggle;
              const folded = value.folded.includes(pos)
                ? value.folded.filter((p) => p !== pos)
                : [...value.folded, pos];
              return { folded, decorations: build(newState.doc, folded) };
            }
            if (tr.docChanged) {
              const remapped = remap(tr, value.folded, newState.doc);
              // Remap for EVERY edit (local + remote) so anchors ride along, but
              // only auto-expand for LOCAL edits: the local caret is meaningless
              // for a collaborator's transaction, so acting on it there could pop
              // a peer's edit open on our screen. y-sync tags remote txns.
              if (tr.getMeta(ySyncPluginKey)) {
                return { folded: remapped, decorations: build(newState.doc, remapped) };
              }
              // An edit can grow a fold's hidden range around the selection
              // (e.g. Enter at the end of a collapsed heading spawns a paragraph
              // the fold now hides, or a range selection reaches into it).
              // Auto-expand any fold the selection now intersects so the user
              // never types into invisible content.
              const { from, to } = newState.selection;
              const folded = remapped.filter((pos) => {
                const info = foldInfoAt(newState.doc, pos);
                return !(info && selectionInHidden(from, to, info.hidden));
              });
              return { folded, decorations: build(newState.doc, folded) };
            }
            return value;
          },
        },
        props: {
          decorations: (state) => foldPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
          handleDOMEvents: {
            mousedown(view: EditorView, event: MouseEvent) {
              const { state } = view;
              const folded = foldPluginKey.getState(state)?.folded ?? [];
              // The chevron is out-of-flow (absolutely positioned in the
              // gutter), so a click always targets it directly.
              const toggleEl = (event.target as HTMLElement | null)?.closest?.('[data-fold-pos]');
              if (!toggleEl) return false;
              const pos = Number(toggleEl.getAttribute('data-fold-pos'));
              // Bail (leaving the browser default intact) BEFORE preventDefault,
              // so a malformed affordance doesn't swallow the click.
              if (Number.isNaN(pos)) return false;
              event.preventDefault();
              const willFold = !folded.includes(pos);
              let tr = state.tr.setMeta(foldPluginKey, { toggle: pos });
              // Don't strand the selection inside content we're about to hide —
              // move the caret to the header if the selection touches a hidden
              // range (shared predicate with auto-expand, so they agree at every
              // boundary and a just-folded block never pops back open).
              if (willFold) {
                const info = foldInfoAt(state.doc, pos);
                const { from, to } = state.selection;
                if (info && selectionInHidden(from, to, info.hidden)) {
                  tr = tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1)));
                }
              }
              view.dispatch(tr);
              return true;
            },
          },
        },
      }),
    ];
  },
});
