import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { applyIncremental } from '@/lib/tiptap/incremental-decorations';

/* ── Clickable folding for Obsidian callouts ───────────────────────────
 *  A callout declared foldable in the markdown (`> [!note]-` / `> [!note]+`)
 *  gets a chevron on its title row; clicking it (or the `•••` shown while
 *  collapsed) toggles `calloutCollapsed`.
 *
 *  Unlike the heading/list fold (lib/tiptap/fold.ts), this is DOCUMENT state:
 *  `calloutCollapsed` serializes back as the `-`/`+` marker, so a toggle is a
 *  real attributed edit — one AttrStep through the normal edit path, synced to
 *  collaborators and visible in review. That is also why nothing here
 *  auto-expands on edits the way the view-state fold does: an implicit expand
 *  would be a second, unasked-for doc edit. Instead we only make sure a collapse
 *  never strands the caret inside the content it hides.
 *
 *  A callout with no `-`/`+` marker isn't foldable and gets no affordance at
 *  all, matching Obsidian.
 * ───────────────────────────────────────────────────────────────────────── */

export const calloutFoldPluginKey = new PluginKey<DecorationSet>('calloutFold');

function isFoldableCallout(node: ProseMirrorNode | null | undefined): boolean {
  return Boolean(
    node && node.type.name === 'blockquote' && node.attrs.calloutType && node.attrs.calloutFoldable,
  );
}

/** The callout children a collapse hides: everything after the title paragraph.
 *  Each child is its own range — `Decoration.node` decorates a SINGLE node, so
 *  one range spanning them all would silently apply to nothing. */
function hiddenRanges(node: ProseMirrorNode, pos: number): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  node.forEach((child, offset, index) => {
    if (index === 0) return; // the title row stays visible
    const from = pos + 1 + offset;
    ranges.push({ from, to: from + child.nodeSize });
  });
  return ranges;
}

/** End of the callout's title text, where the `•••` affordance hangs. */
function titleEnd(node: ProseMirrorNode, pos: number): number | null {
  const first = node.firstChild;
  return first?.isTextblock ? pos + 2 + first.content.size : null;
}

function affordance(className: string, label: string, text = ''): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.setAttribute('data-callout-fold', '');
  el.setAttribute('contenteditable', 'false');
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', label);
  if (text) el.textContent = text;
  return el;
}

function scan(doc: ProseMirrorNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!isFoldableCallout(node)) return true; // keep descending: callouts nest
    // Everything hangs off the title row; a callout without one (not something
    // the codec can produce) simply gets no affordance.
    const end = titleEnd(node, pos);
    if (end == null) return true;
    const collapsed = Boolean(node.attrs.calloutCollapsed);
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: collapsed ? 'sd-callout-foldable sd-callout-collapsed' : 'sd-callout-foldable',
      }),
    );
    decos.push(
      // Inside the title paragraph (pos+2), not between the blockquote's block
      // children (pos+1) — a widget there would displace `p:first-child`, which
      // the callout title styling hangs off.
      Decoration.widget(
        pos + 2,
        () =>
          affordance(
            `sd-fold-toggle${collapsed ? ' sd-fold-toggle-collapsed' : ''}`,
            collapsed ? 'Expand callout' : 'Collapse callout',
          ),
        {
          side: -1,
          // Key includes the state so PM swaps the DOM (fresh aria/class) on toggle.
          key: `callout-fold-${pos}-${collapsed ? 1 : 0}`,
          ignoreSelection: true,
        },
      ),
    );
    const hidden = collapsed ? hiddenRanges(node, pos) : [];
    // Nothing to hide (a body-less callout) → no `•••`: it advertises content
    // that isn't there. The chevron stays, since the marker is still doc state.
    if (!hidden.length) return true;
    for (const r of hidden) {
      decos.push(Decoration.node(r.from, r.to, { class: 'sd-fold-hidden' }));
    }
    decos.push(
      Decoration.widget(end, () => affordance('sd-fold-ellipsis', 'Expand callout', '•••'), {
        side: 1,
        key: `callout-fold-dots-${pos}`,
        ignoreSelection: true,
      }),
    );
    return true;
  });
  return decos;
}

export const CalloutFold = Extension.create({
  name: 'calloutFold',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: calloutFoldPluginKey,
        state: {
          // Derived purely from the doc — `calloutCollapsed` IS the state, so a
          // toggle (local or remote) arrives as an ordinary doc change. The
          // toggle itself is an attr-only step, which applyIncremental handles
          // via its full-rescan fallback.
          init: (_config, state: EditorState) =>
            DecorationSet.create(state.doc, scan(state.doc, 0, state.doc.content.size)),
          apply: (tr, value) => (tr.docChanged ? applyIncremental(tr, value, scan) : value),
        },
        props: {
          decorations: (state) => calloutFoldPluginKey.getState(state) ?? DecorationSet.empty,
          handleDOMEvents: {
            mousedown(view: EditorView, event: MouseEvent) {
              // Collapsing is a doc edit, so a read-only viewer can't do it (the
              // CSS hides the chevron there; a collapsed callout still reads as
              // collapsed, since that's the document's own state).
              if (!view.editable) return false;
              const { state } = view;
              // The chevron and the `•••` both carry `data-callout-fold`, so
              // one hook serves both. The `•••` is a contenteditable=false island
              // whose mousedown the browser routes to the enclosing <p>; the
              // elementFromPoint fallback forces layout, so only reach for it when
              // the click landed inside a collapsed callout at all.
              const hit = (el: Element | null | undefined) =>
                el?.closest?.('[data-callout-fold]');
              const target = event.target as HTMLElement | null;
              const toggleEl =
                hit(target) ??
                (target?.closest?.('.sd-callout-collapsed')
                  ? hit(document.elementFromPoint(event.clientX, event.clientY))
                  : null);
              if (!toggleEl) return false;
              // Resolve the callout FROM the widget's live DOM position — the
              // decorations are position-mapped across edits, so a pos baked
              // into the element at build time would go stale. Bail (leaving
              // the browser default intact) BEFORE preventDefault, so a stale
              // affordance never swallows the click.
              let pos = -1;
              try {
                const $p = state.doc.resolve(view.posAtDOM(toggleEl, 0));
                for (let d = $p.depth; d > 0; d -= 1) {
                  if (isFoldableCallout($p.node(d))) {
                    pos = $p.before(d);
                    break;
                  }
                }
              } catch {
                return false;
              }
              if (pos < 0) return false;
              const node = state.doc.nodeAt(pos);
              if (!node || !isFoldableCallout(node)) return false;
              event.preventDefault();
              const collapsing = !node.attrs.calloutCollapsed;
              // One AttrStep — the whole edit, so review/attribution shows a
              // single attribute change rather than a re-created blockquote.
              // `'true'` / null, not true / false: y-prosemirror writes the raw
              // attr value into the Y.XmlElement and DELETES the attribute on
              // null, so this leaves exactly the doc the markdown codec builds
              // for the same source. A boolean would store `true` where every
              // reader (and the codec) expects the string `'true'`.
              const tr = state.tr.setNodeAttribute(
                pos,
                'calloutCollapsed',
                collapsing ? 'true' : null,
              );
              if (collapsing) {
                const { from, to } = state.selection;
                const touches = hiddenRanges(node, pos).some((r) =>
                  from === to ? from >= r.from && from < r.to : from < r.to && to > r.from,
                );
                // Don't strand the caret in content we're about to hide — park it
                // on the title row, which stays visible. Resolve against `tr.doc`:
                // the AttrStep already replaced the doc (positions are unchanged).
                if (touches) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
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
