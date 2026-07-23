// Suggestions-as-marks: the durable, position-stable, CRDT-native suggestion
// engine that replaces the server text-match overlay + the instant-overlay
// band-aid with ONE path. A suggestion is a mark living in the Y.Doc
// (`insertion` / `deletion` / `modification`), so it syncs live, persists, and
// never needs re-locating by fuzzy text-matching.
//
// Built on @handlewithcare/prosemirror-suggest-changes. The library's marks,
// plugin, and accept/reject commands are wired into Tiptap here. Styling lives
// in app/globals.css (`ins[data-suggestion]` / `del[data-suggestion]`), so the
// look is fully ours.
import { Mark, Node, Extension, type AnyExtension, type CommandProps } from '@tiptap/core';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { canJoin } from '@tiptap/pm/transform';
import {
  suggestChanges,
  suggestChangesKey,
  isSuggestChangesEnabled,
  withSuggestChanges,
  enableSuggestChanges,
  disableSuggestChanges,
  applySuggestions,
  revertSuggestions,
  applySuggestion,
  revertSuggestion,
} from '@handlewithcare/prosemirror-suggest-changes';

// The library's SuggestionId type isn't re-exported from its index; it's just
// `string | number` (a suggestion's stable identity, shared by every mark that
// belongs to the same suggested edit).
export type SuggestionId = string | number;
type GenerateSuggestionId = NonNullable<Parameters<typeof withSuggestChanges>[1]>;

// The `id` attribute every suggestion mark carries. We serialize it the same
// way the library does (`data-id` = JSON.stringify(id)) so clipboard + codec
// round-trips agree with the library's own parse/serialize.
const idAttribute = {
  id: {
    default: null as SuggestionId | null,
    parseHTML: (el: HTMLElement) => {
      const raw = el.getAttribute('data-id');
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as SuggestionId;
      } catch {
        return raw;
      }
    },
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.id == null ? {} : { 'data-id': JSON.stringify(attrs.id) },
  },
};

export const InsertionMark = Mark.create({
  name: 'insertion',
  inclusive: false,
  excludes: 'deletion modification insertion',
  addAttributes: () => idAttribute,
  parseHTML: () => [{ tag: 'ins[data-id]' }],
  renderHTML: ({ HTMLAttributes }) => ['ins', { ...HTMLAttributes, 'data-suggestion': 'insertion' }, 0],
});

export const DeletionMark = Mark.create({
  name: 'deletion',
  inclusive: false,
  excludes: 'insertion modification deletion',
  addAttributes: () => idAttribute,
  parseHTML: () => [{ tag: 'del[data-id]' }],
  renderHTML: ({ HTMLAttributes }) => ['del', { ...HTMLAttributes, 'data-suggestion': 'deletion' }, 0],
});

// Present so the library's getSuggestionMarks() finds all three; attribute edits
// (marks/attrs changes) are a later increment, so keep it minimal but valid.
export const ModificationMark = Mark.create({
  name: 'modification',
  inclusive: false,
  excludes: 'deletion insertion',
  addAttributes: () => ({
    ...idAttribute,
    type: { default: null },
    attrName: { default: null },
    previousValue: { default: null },
    newValue: { default: null },
  }),
  parseHTML: () => [{ tag: "span[data-type='modification']" }],
  renderHTML: ({ HTMLAttributes }) => ['span', { ...HTMLAttributes, 'data-type': 'modification' }, 0],
});

// prosemirror-suggest-changes represents complete block insertions/deletions as
// node marks. The default ProseMirror `doc` forbids marked block children, so a
// multi-block paste throws before it can commit. This is the library-required
// document schema (see its README): same `block+` shape, with only our three
// suggestion marks admitted on top-level blocks.
export const SuggestionDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: 'block+',
  marks: 'insertion modification deletion',
});

const NODE_INSERTION_ID = 'suggestionInsertionId';
const NODE_DELETION_ID = 'suggestionDeletionId';
const NODE_MODIFICATIONS = 'suggestionModifications';
const NODE_REQUIRED_SHELL = 'suggestionRequiredShell';
const SUGGESTION_NODE_MARKS = 'insertion modification deletion';
const BLOCK_CONTAINERS = new Set([
  'doc', 'blockquote', 'bulletList', 'orderedList', 'listItem',
  'table', 'tableRow', 'tableCell', 'tableHeader',
]);
const REMOVABLE_REQUIRED_CONTAINERS = new Set(['listItem', 'bulletList', 'orderedList', 'blockquote']);

// The suggestion library can temporarily put marks on block children at every
// nesting depth, before our dispatch wrapper converts them to durable attrs +
// inline marks. Patch node kits recursively so those transactions are schema-
// valid inside lists, quotes, and tables as well as at the document root.
export function allowSuggestionBlockMarks<T extends AnyExtension>(extension: T): T {
  const fields: Record<string, unknown> = {};
  if (BLOCK_CONTAINERS.has(extension.name)) fields.marks = SUGGESTION_NODE_MARKS;
  if (extension.config.addExtensions) {
    fields.addExtensions = function (this: { parent?: () => AnyExtension[] }) {
      return (this.parent?.() ?? []).map(allowSuggestionBlockMarks);
    };
  }
  return Object.keys(fields).length ? extension.extend(fields) as T : extension;
}

// y-prosemirror does not persist marks attached to block nodes, but it does
// persist node attributes. Keep the structural identity there while inline
// marks continue to provide the visible diff for text-bearing blocks.
export const SuggestionNodeAttributes = Extension.create({
  name: 'suggestionNodeAttributes',
  addGlobalAttributes() {
    return [{
      types: 'nodes',
      attributes: {
        [NODE_INSERTION_ID]: { default: null, rendered: false },
        [NODE_DELETION_ID]: { default: null, rendered: false },
        [NODE_MODIFICATIONS]: { default: null, rendered: false },
        [NODE_REQUIRED_SHELL]: { default: null, rendered: false },
      },
    }];
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    suggestionChanges: {
      /** Turn suggestion (Google-Docs "suggesting") mode on/off. */
      setSuggesting: (on: boolean) => ReturnType;
      /** Accept every pending suggestion (insertions kept, deletions removed). */
      acceptAllSuggestions: () => ReturnType;
      /** Reject every pending suggestion (insertions removed, deletions restored). */
      rejectAllSuggestions: () => ReturnType;
      /** Accept one suggestion by id. */
      acceptSuggestion: (id: SuggestionId) => ReturnType;
      /** Reject one suggestion by id. */
      rejectSuggestion: (id: SuggestionId) => ReturnType;
    };
  }
}

export type SuggestionChangesOptions = {
  /** Mint the suggestion id for an edit — carry author/turn here in production. */
  generateId?: Parameters<typeof withSuggestChanges>[1];
  /** When false, the in-editor ✓/✕ review controls are not installed —
   *  commenters can compose suggestions but only editors resolve them. */
  canResolve?: boolean;
  /** Persist each range decision; the CRDT ledger folds conflicting decisions to mixed. */
  onResolved?: (ids: SuggestionId[], action: 'accept' | 'reject') => void;
};

const SUGGESTION_SPACER = '\u200B';

const nodeSuggestionAttr = (name: string) =>
  name === 'insertion' ? NODE_INSERTION_ID : name === 'deletion' ? NODE_DELETION_ID : null;
const nodeSuggestionId = (node: PMNode, name: 'insertion' | 'deletion'): SuggestionId | null =>
  (node.attrs[nodeSuggestionAttr(name)!] as SuggestionId | null | undefined) ?? null;
type StructuralModification = {
  id: SuggestionId;
  type: 'attr' | 'mark' | 'nodeType';
  attrName?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
};
const nodeModifications = (node: PMNode): StructuralModification[] => {
  const value = node.attrs[NODE_MODIFICATIONS];
  return Array.isArray(value) ? value.filter((item): item is StructuralModification =>
    item != null && typeof item === 'object' && 'id' in item && 'type' in item) : [];
};
const hasNodeSuggestion = (node: PMNode) =>
  nodeSuggestionId(node, 'insertion') != null || nodeSuggestionId(node, 'deletion') != null || nodeModifications(node).length > 0;

const SUGGESTION_MARK_NAMES = new Set(SUGGESTION_NODE_MARKS.split(' '));

/** True when a block (via durable node attrs, node marks, or any inline mark in
 *  its content) is part of a pending suggestion. View-layer extensions (shiki
 *  highlighting, mermaid previews) use this to render such blocks plain so the
 *  green/red review styling stays legible. */
export function nodeHasPendingSuggestion(node: PMNode): boolean {
  if (hasNodeSuggestion(node) || node.marks.some((m) => SUGGESTION_MARK_NAMES.has(m.type.name))) {
    return true;
  }
  let found = false;
  node.descendants((child) => {
    if (!found && child.marks.some((m) => SUGGESTION_MARK_NAMES.has(m.type.name))) found = true;
    return !found;
  });
  return found;
}

function removableStructuralRange(doc: PMNode, pos: number, node: PMNode): SuggestRange | null {
  const $pos = doc.resolve(pos);
  if ($pos.parent.canReplace($pos.index(), $pos.index() + 1)) return { from: pos, to: pos + node.nodeSize };
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    const ancestor = $pos.node(depth);
    if (!REMOVABLE_REQUIRED_CONTAINERS.has(ancestor.type.name) || ancestor.childCount !== 1) break;
    const parent = $pos.node(depth - 1);
    const index = $pos.index(depth - 1);
    const range = { from: $pos.before(depth), to: $pos.after(depth) };
    if (parent.canReplace(index, index + 1)) return range;
    // The doc itself requires one block. Surface its sole removable wrapper so
    // deleteOrKeepRequiredDocumentBlock can replace it with an empty paragraph.
    if (depth === 1 && parent === doc && parent.childCount === 1) return range;
  }
  return null;
}

const isSoleTopLevelNode = (doc: PMNode, pos: number) => doc.resolve(pos).depth === 0 && doc.childCount === 1;

function deleteOrKeepRequiredDocumentBlock(tr: Transaction, from: number, to: number): void {
  if (from >= to) return;
  if (isSoleTopLevelNode(tr.doc, from) && tr.doc.nodeAt(from)?.nodeSize === to - from) {
    tr.replaceWith(from, to, tr.doc.type.schema.nodes.paragraph.create());
  } else {
    tr.delete(from, to);
  }
}

// The library's numeric allocator scans suggestion marks only. Structural-only
// suggestions (blank/atomic nodes) persist their id in node attrs, so include
// those attrs or the next edit can reuse an id and resolve both suggestions.
const generateNextSuggestionId: GenerateSuggestionId = (_schema, doc) => {
  let highest = 0;
  doc?.descendants((node) => {
    const ids = [
      ...node.marks.filter((mark) => ['insertion', 'deletion', 'modification'].includes(mark.type.name)).map((mark) => mark.attrs.id),
      nodeSuggestionId(node, 'insertion'),
      nodeSuggestionId(node, 'deletion'),
      ...nodeModifications(node).map((mod) => mod.id),
    ];
    for (const id of ids) {
      if (typeof id === 'number' && Number.isFinite(id)) highest = Math.max(highest, id);
    }
    return true;
  });
  return highest + 1;
};

// y-prosemirror persists inline marks but drops marks attached to block nodes.
// The suggestion library uses node marks while constructing multi-block edits,
// so normalize those to equivalent inline marks before the transaction reaches
// Collaboration/Y.js. The library's own zero-width boundary markers stay in
// place, preserving structural joins on Reject; blank and atomic blocks rely
// on their durable node attribute because they have no text to mark.
function inlineBlockSuggestionMarks(tr: Transaction): void {
  const marked: Array<{ pos: number; marks: PMNode['marks'] }> = [];
  tr.doc.descendants((node, pos) => {
    const marks = node.marks.filter((mark) => ['insertion', 'deletion', 'modification'].includes(mark.type.name));
    if (!node.isText && marks.length) {
      marked.push({ pos, marks });
      return false;
    }
    return true;
  });

  for (const item of marked.sort((a, b) => b.pos - a.pos)) {
    let node = tr.doc.nodeAt(item.pos);
    if (!node) continue;

    const modifications = item.marks
      .filter((mark) => mark.type.name === 'modification')
      .map((mark) => mark.attrs as StructuralModification);
    if (modifications.length) {
      tr.setNodeAttribute(item.pos, NODE_MODIFICATIONS, [...nodeModifications(node), ...modifications]);
    }
    for (const mark of item.marks) {
      const attr = nodeSuggestionAttr(mark.type.name);
      if (attr) tr.setNodeAttribute(item.pos, attr, mark.attrs.id);
      tr.removeNodeMark(item.pos, mark.type);
    }
    if (node.isLeaf) continue;

    node = tr.doc.nodeAt(item.pos);
    if (!node) continue;
    const textRanges: SuggestRange[] = [];
    node.descendants((child, offset) => {
      if (child.isText) {
        const from = item.pos + 1 + offset;
        textRanges.push({ from, to: from + child.nodeSize });
      }
      return true;
    });
    if (textRanges.length === 0) continue;
    for (const mark of item.marks.filter((candidate) => candidate.type.name !== 'modification')) {
      for (const range of textRanges) tr.addMark(range.from, range.to, mark);
    }
  }
}

function resolveNodeModifications(
  tr: Transaction,
  originalPos: number,
  selected: StructuralModification[],
  accept: boolean,
): void {
  let pos = tr.mapping.map(originalPos, 1);
  const node = tr.doc.nodeAt(pos);
  if (!node) return;
  const selectedKeys = new Set(selected.map((mod) => JSON.stringify(mod)));
  const remaining = nodeModifications(node).filter((mod) => !selectedKeys.has(JSON.stringify(mod)));

  if (!accept) {
    // Restore the old node type first; attribute changes are relative to it.
    for (const mod of selected.filter((item) => item.type === 'nodeType').reverse()) {
      if (typeof mod.previousValue !== 'string') continue;
      const previousType = tr.doc.type.schema.nodes[mod.previousValue];
      if (previousType) tr.setNodeMarkup(pos, previousType, null);
    }
    pos = tr.mapping.map(originalPos, 1);
    for (const mod of selected.filter((item) => item.type === 'attr').reverse()) {
      if (typeof mod.attrName === 'string' && tr.doc.nodeAt(pos)) {
        tr.setNodeAttribute(pos, mod.attrName, mod.previousValue ?? null);
      }
    }
    for (const mod of selected.filter((item) => item.type === 'mark').reverse()) {
      if (mod.previousValue) tr.addNodeMark(pos, tr.doc.type.schema.markFromJSON(mod.previousValue as never));
      else if (mod.newValue) tr.removeNodeMark(pos, tr.doc.type.schema.markFromJSON(mod.newValue as never));
    }
  }
  pos = tr.mapping.map(originalPos, 1);
  if (tr.doc.nodeAt(pos)) tr.setNodeAttribute(pos, NODE_MODIFICATIONS, remaining.length ? remaining : null);
}

// ---------------------------------------------------------------------------
// Granular accept/reject review controls, in-editor DOM (no React):
//   • per change-GROUP — a ✓/✕ pair revealed on hover of a contiguous run of
//     suggestion marks (a replacement like del "Found" + ins "We" is ONE group)
//   • per BLOCK — a ✓/✕ pair pinned to a right-hand gutter, aligned across
//     every block that carries a suggestion
// Both act through the library's range commands, so they need no finer id
// grouping — a group/block accepts or reverts exactly the marks in its span.
// ---------------------------------------------------------------------------
// Cached in plugin state so the decoration set is rebuilt only when it can have
// changed (doc edit or hover move), never on selection / remote-cursor /
// awareness / IME ticks — see the cachedDecorations note in collab-editor.tsx.
type ReviewState = { hover: SuggestRange | null; decorations: DecorationSet; hasSuggestions: boolean };
const reviewKey = new PluginKey<ReviewState>('suggestionReview');

type SuggestRange = { from: number; to: number };

const isSuggestionMark = (m: { type: { name: string } }) =>
  m.type.name === 'insertion' || m.type.name === 'deletion';

// Maximal contiguous spans of inline text all carrying a suggestion mark, split
// at block boundaries (cross-block runs are the block gutter's job).
export function changeGroups(state: EditorState): SuggestRange[] {
  const groups: SuggestRange[] = [];
  let cur: SuggestRange | null = null;
  state.doc.descendants((node, pos) => {
    if (!node.isText && (node.marks.some(isSuggestionMark) || hasNodeSuggestion(node))) {
      if (cur) { groups.push(cur); cur = null; }
      groups.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
    if (node.isBlock) {
      if (cur) { groups.push(cur); cur = null; }
      return;
    }
    if (!node.isText) return;
    if (node.marks.some(isSuggestionMark)) {
      if (cur) cur.to = pos + node.nodeSize;
      else cur = { from: pos, to: pos + node.nodeSize };
    } else if (cur) { groups.push(cur); cur = null; }
  });
  if (cur) groups.push(cur);
  return groups;
}

// Top-level blocks that contain at least one suggestion, as content ranges.
export function suggestionBlocks(state: EditorState): SuggestRange[] {
  const raw: Array<SuggestRange & { delIds: Set<string>; insIds: Set<string>; modIds: Set<string> }> = [];
  // Walk to the innermost textblock (paragraph/heading/list-item paragraph, and
  // each table cell), not just top-level children — so a suggestion inside a
  // list item, blockquote, or a single table CELL gets its own gutter control
  // (cell-level accept/reject) instead of one for the whole container. The codec
  // word-diffs table cells in place, so only changed cells carry a control. We
  // track the suggestion ids per block (split by mark kind) so the #590 pair-merge
  // below can fuse a whole-line replace into one control — but ONLY when both
  // halves are the same suggestion.
  const idKey = (m: { attrs: Record<string, unknown> }) => JSON.stringify(m.attrs.id ?? null);
  const idsFor = (marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[], name: string) =>
    new Set(marks.filter((m) => m.type.name === name).map(idKey));
  state.doc.descendants((node, pos) => {
    const nodeDelIds = idsFor(node.marks, 'deletion');
    const nodeInsIds = idsFor(node.marks, 'insertion');
    const nodeModIds = idsFor(node.marks, 'modification');
    const nodeDelId = nodeSuggestionId(node, 'deletion');
    const nodeInsId = nodeSuggestionId(node, 'insertion');
    if (nodeDelId != null) nodeDelIds.add(JSON.stringify(nodeDelId));
    if (nodeInsId != null) nodeInsIds.add(JSON.stringify(nodeInsId));
    for (const mod of nodeModifications(node)) nodeModIds.add(JSON.stringify(mod.id));
    if (nodeDelIds.size || nodeInsIds.size || nodeModIds.size) {
      raw.push({ from: pos, to: pos + node.nodeSize, delIds: nodeDelIds, insIds: nodeInsIds, modIds: nodeModIds });
      return false;
    }
    if (!node.isTextblock) return true; // recurse into lists / quotes / tables
    const delIds = new Set<string>();
    const insIds = new Set<string>();
    const modIds = new Set<string>();
    node.forEach((child) => {
      for (const m of child.marks) {
        if (m.type.name === 'deletion') delIds.add(idKey(m));
        if (m.type.name === 'insertion') insIds.add(idKey(m));
        if (m.type.name === 'modification') modIds.add(idKey(m));
      }
      if (child.isText) return;
      const childDelId = nodeSuggestionId(child, 'deletion');
      const childInsId = nodeSuggestionId(child, 'insertion');
      if (childDelId != null) delIds.add(JSON.stringify(childDelId));
      if (childInsId != null) insIds.add(JSON.stringify(childInsId));
      for (const mod of nodeModifications(child)) modIds.add(JSON.stringify(mod.id));
    });
    if (delIds.size || insIds.size || modIds.size) raw.push({ from: pos, to: pos + node.nodeSize, delIds, insIds, modIds });
    return false; // textblocks don't nest
  });
  // A whole-block replacement (the #590 clean whole-line replace) is a
  // deletion-only block immediately followed by an insertion-only block, BOTH
  // carrying the same single suggestion id. Merge that pair into ONE control range
  // so it shows a single ✓/✕ — not one button on the struck line and another on
  // the new line. Two adjacent but *unrelated* suggestions (different ids — e.g.
  // one reviewer deletes a paragraph, another inserts one right below) must stay
  // separate so each is accepted/rejected on its own.
  const only = (s: Set<string>) => (s.size === 1 ? [...s][0] : null);
  const blocks: SuggestRange[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const b = raw[i];
    const next = raw[i + 1];
    const delOnly = b.delIds.size > 0 && b.insIds.size === 0 && b.modIds.size === 0 ? only(b.delIds) : null;
    const insOnly = next && next.insIds.size > 0 && next.delIds.size === 0 && next.modIds.size === 0 ? only(next.insIds) : null;
    if (next && delOnly != null && insOnly != null && delOnly === insOnly && b.to === next.from) {
      blocks.push({ from: b.from, to: next.to });
      i += 1; // consume the insertion half of the pair
    } else {
      blocks.push({ from: b.from, to: b.to });
    }
  }
  return blocks;
}

// Accept (or reject) every suggestion within [from, to] — the primitive behind
// the per-group and per-block controls. ACCEPT keeps insertions (strip the mark)
// and removes deleted text; REJECT removes inserted text and restores deletions
// (strip the mark). The library's range commands aren't in its public exports,
// so we apply the same semantics directly over the marks. Removed (drop) runs
// are coalesced so we can replay the library's whitespace rule — a run flanked
// by spaces also drops one space — keeping a granular accept byte-identical to
// Accept all / the old per-id widget. Edits apply right-to-left so a delete
// never invalidates an earlier position. Zero-width insertion spacers are
// dropped on accept, exactly as the library's own applySuggestions does. Returns
// false (a no-op) when the span holds no suggestion.
export function resolveSuggestionRange(from: number, to: number, accept: boolean) {
  return (state: EditorState, dispatch?: EditorView['dispatch']): boolean => {
    const insertion = state.schema.marks.insertion;
    const deletion = state.schema.marks.deletion;
    if (!insertion || !deletion) return false;
    const stripType = accept ? insertion : deletion; // keep text, drop the mark
    const dropType = accept ? deletion : insertion; // remove the text outright
    type Op = { from: number; to: number; kind: 'drop' | 'strip' | 'spacer' };
    type NodeOp = {
      from: number;
      to: number;
      kind: 'drop-node' | 'replace-node' | 'strip-node' | 'clear-node' | 'resolve-modification';
      attr?: string;
      mods?: StructuralModification[];
    };
    const ops: Op[] = [];
    const nodeOps: NodeOp[] = [];
    const boundaryJoins = new Map<string, number[]>();
    let run: { from: number; to: number } | null = null;
    const flush = () => { if (run) { ops.push({ ...run, kind: 'drop' }); run = null; } };
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) {
        flush();
        const wholeNodeIsInRange = pos >= from && pos + node.nodeSize <= to;
        const dropAttr = nodeSuggestionAttr(dropType.name)!;
        const stripAttr = nodeSuggestionAttr(stripType.name)!;
        if (wholeNodeIsInRange && (node.attrs[dropAttr] != null || dropType.isInSet(node.marks))) {
          const removable = removableStructuralRange(state.doc, pos, node);
          if (removable) {
            nodeOps.push({ ...removable, kind: 'drop-node' });
            return false;
          }
          if (isSoleTopLevelNode(state.doc, pos)) {
            nodeOps.push({ from: pos, to: pos + node.nodeSize, kind: 'replace-node' });
            return false;
          }
          // A table cell and similar schemas require this child. Keep its shell,
          // clear the structural id, and recurse so marked content is removed.
          nodeOps.push({ from: pos, to: pos + node.nodeSize, kind: 'clear-node', attr: dropAttr });
          return true;
        }
        if (wholeNodeIsInRange && (node.attrs[stripAttr] != null || stripType.isInSet(node.marks))) {
          nodeOps.push({ from: pos, to: pos + node.nodeSize, kind: 'strip-node' });
          return true;
        }
        const mods = nodeModifications(node);
        if (wholeNodeIsInRange && mods.length) {
          nodeOps.push({ from: pos, to: pos + node.nodeSize, kind: 'resolve-modification', mods });
        }
        return true;
      }
      const a = Math.max(from, pos);
      const b = Math.min(to, pos + node.nodeSize);
      const dropMark = dropType.isInSet(node.marks);
      if (dropMark) {
        if (node.text === SUGGESTION_SPACER) {
          const $pos = state.doc.resolve(pos);
          const key = JSON.stringify(dropMark.attrs.id ?? null);
          const joins = boundaryJoins.get(key) ?? [];
          joins.push($pos.after($pos.depth));
          boundaryJoins.set(key, joins);
        }
        if (run && run.to === a) run.to = b;
        else { flush(); run = { from: a, to: b }; }
        return;
      }
      flush();
      // Structural zero-width spacers disappear when their mark is resolved.
      if (stripType.isInSet(node.marks)) ops.push({ from: a, to: b, kind: node.text === SUGGESTION_SPACER ? 'spacer' : 'strip' });
    });
    flush();
    if (ops.length === 0 && nodeOps.length === 0) return false;
    if (!dispatch) return true;
    const size = state.doc.content.size;
    // A top-level block whose ENTIRE content is dropped (accepting a whole-line
    // strike, or rejecting a whole-line insert) must be removed outright — leaving
    // the emptied block behind renders as a stray blank line (the extra-newline
    // bug). Detect those and delete the whole node instead of just its text.
    // Only real text drops count — NOT spacers: accepting a suggested blank line
    // leaves a block whose sole child is the zero-width insertion placeholder, and
    // that block must be KEPT (blank), with just the placeholder removed.
    const dropRanges = ops.filter((o) => o.kind === 'drop');
    // Every text leaf under `node` (content starting at `start`) sits inside a
    // drop range, and there IS text. A non-text leaf (image/hr) survives
    // resolution, so its container must too — except hardBreak, which is
    // meaningless alone. An EMPTY textblock descendant (a pre-existing blank
    // bullet/line the suggestion never touched) is user content: it vetoes the
    // container delete so rejecting a sibling insert can't swallow it.
    const allTextDropped = (node: PMNode, start: number) => {
      let all = true;
      let any = false;
      node.descendants((child, off) => {
        if (child.isText) {
          any = true;
          const a = start + off;
          if (!dropRanges.some((r) => r.from <= a && r.to >= a + child.nodeSize)) all = false;
        } else if (child.isLeaf) {
          if (child.type.name !== 'hardBreak') all = false;
        } else if (child.isTextblock && child.content.size === 0) all = false;
        return all;
      });
      return any && all;
    };
    const blockDeletes: SuggestRange[] = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      const cStart = pos + 1;
      if (pos + node.nodeSize - 1 <= cStart) return false; // already empty — leave pre-existing blanks
      if (!allTextDropped(node, cStart)) return false;
      // A top-level emptied block is deleted outright. A NESTED one climbs to
      // the outermost fully-dropped list / blockquote container, so a rejected
      // list-item insert takes its bullet with it (and an emptied whole list,
      // the list). A nested textblock that can't climb keeps its container —
      // the paragraph a list_item / table cell REQUIRES — and falls through to
      // plain text deletion instead (a valid, possibly-empty block).
      const $pos = state.doc.resolve(pos);
      let del = $pos.depth === 0 ? { from: pos, to: pos + node.nodeSize } : null;
      for (let d = $pos.depth; d >= 1; d -= 1) {
        const anc = $pos.node(d);
        if (!REMOVABLE_REQUIRED_CONTAINERS.has(anc.type.name) || !allTextDropped(anc, $pos.start(d))) break;
        del = { from: $pos.before(d), to: $pos.after(d) };
      }
      // An earlier climb may already cover this range (later items of a fully
      // dropped list) — a duplicate delete would eat unrelated content.
      if (del && !blockDeletes.some((bd) => bd.from <= del!.from && bd.to >= del!.to)) blockDeletes.push(del);
      return false;
    });
    const inBlockDelete = (o: Op) => blockDeletes.some((bd) => bd.from <= o.from && bd.to >= o.to);

    const tr = state.tr;
    type Apply = {
      from: number;
      to: number;
      kind: 'drop' | 'replace-node' | 'strip-inline' | 'strip-node' | 'clear-node' | 'resolve-modification';
      attr?: string;
      mods?: StructuralModification[];
    };
    const applies: Apply[] = [
      ...blockDeletes.map((bd): Apply => ({ ...bd, kind: 'drop' })),
      ...nodeOps.map((op): Apply => ({
        ...op,
        kind: op.kind === 'drop-node'
          ? 'drop'
          : op.kind === 'replace-node'
            ? 'replace-node'
          : op.kind === 'strip-node'
            ? 'strip-node'
            : op.kind === 'clear-node' ? 'clear-node' : 'resolve-modification',
      })),
    ];
    for (const op of ops) {
      if (inBlockDelete(op)) continue; // subsumed by the whole-block delete
      if (op.kind === 'strip') { applies.push({ from: op.from, to: op.to, kind: 'strip-inline' }); continue; }
      let end = op.to;
      if (op.kind === 'drop') {
        const prev = op.from > 0 ? state.doc.textBetween(op.from - 1, op.from, 'x', 'x') : '';
        const next = op.to < size ? state.doc.textBetween(op.to, op.to + 1, 'x', 'x') : '';
        if (prev === ' ' && next === ' ') end = op.to + 1; // collapse the doubled space
      }
      applies.push({ from: op.from, to: end, kind: 'drop' });
    }
    // Right-to-left so deletes don't invalidate earlier positions.
    for (const a of applies.sort((x, y) => y.from - x.from)) {
      if (a.kind === 'strip-inline') tr.removeMark(a.from, a.to, stripType);
      else if (a.kind === 'replace-node') {
        const from = tr.mapping.map(a.from, 1);
        const to = tr.mapping.map(a.to, -1);
        tr.replaceWith(from, to, tr.doc.type.schema.nodes.paragraph.create());
      }
      else if (a.kind === 'strip-node') {
        const pos = tr.mapping.map(a.from, 1);
        if (tr.doc.nodeAt(pos)) {
          tr.setNodeAttribute(pos, nodeSuggestionAttr(stripType.name)!, null);
          tr.removeNodeMark(pos, stripType);
        }
      }
      else if (a.kind === 'clear-node') {
        const pos = tr.mapping.map(a.from, 1);
        if (tr.doc.nodeAt(pos) && a.attr) tr.setNodeAttribute(pos, a.attr, null);
      }
      else if (a.kind === 'resolve-modification') resolveNodeModifications(tr, a.from, a.mods ?? [], accept);
      else deleteOrKeepRequiredDocumentBlock(tr, a.from, a.to);
    }
    // A multi-block paste inside one textblock splits the original block and
    // brackets the inserted blocks with two zero-width markers of the same id.
    // Rejecting the insertion removes the middle blocks; join the original
    // halves back together instead of leaving two paragraphs/list-item blocks.
    const joins = [...boundaryJoins.values()].flatMap((positions) =>
      positions.length >= 2 ? positions.filter((_, index) => index % 2 === 0) : []);
    for (const original of joins.sort((a, b) => b - a)) {
      const mapped = tr.mapping.map(original, -1);
      if (canJoin(tr.doc, mapped)) tr.join(mapped);
    }
    tr.setMeta(suggestChangesKey, { skip: true });
    dispatch(tr);
    return true;
  };
}

function resolveSuggestionId(id: SuggestionId, accept: boolean) {
  return (state: EditorState, dispatch?: EditorView['dispatch']): boolean => {
    const structural: Array<{
      from: number;
      to: number;
      nodeFrom: number;
      kind: 'insertion' | 'deletion' | 'modification';
      remove?: boolean;
      replace?: boolean;
      mods?: StructuralModification[];
    }> = [];
    state.doc.descendants((node, pos) => {
      for (const kind of ['insertion', 'deletion'] as const) {
        if (nodeSuggestionId(node, kind) !== id) continue;
        const drop = accept ? kind === 'deletion' : kind === 'insertion';
        const removable = drop ? removableStructuralRange(state.doc, pos, node) : null;
        structural.push({
          from: removable?.from ?? pos,
          to: removable?.to ?? pos + node.nodeSize,
          nodeFrom: pos,
          kind,
          remove: Boolean(removable),
          replace: drop && !removable && isSoleTopLevelNode(state.doc, pos),
        });
      }
      const mods = nodeModifications(node).filter((mod) => mod.id === id);
      if (mods.length) structural.push({ from: pos, to: pos + node.nodeSize, nodeFrom: pos, kind: 'modification', mods });
      return true;
    });
    const resolveInline = accept ? applySuggestion(id) : revertSuggestion(id);
    if (structural.length === 0) return resolveInline(state, dispatch);
    if (!dispatch) return true;

    let tr: Transaction | null = null;
    resolveInline(state, (next) => { tr = next; });
    const out = tr ?? state.tr;
    for (const item of structural.sort((a, b) => b.from - a.from)) {
      if (item.kind === 'modification') {
        resolveNodeModifications(out, item.from, item.mods ?? [], accept);
        continue;
      }
      if (item.remove || item.replace) {
        const from = out.mapping.map(item.from, 1);
        const to = out.mapping.map(item.to, -1);
        if (item.replace) out.replaceWith(from, to, out.doc.type.schema.nodes.paragraph.create());
        else deleteOrKeepRequiredDocumentBlock(out, from, to);
      } else {
        const pos = out.mapping.map(item.nodeFrom, 1);
        if (out.doc.nodeAt(pos)) out.setNodeAttribute(pos, nodeSuggestionAttr(item.kind)!, null);
      }
    }
    out.setMeta(suggestChangesKey, { skip: true });
    dispatch(out);
    return true;
  };
}

function resolveAllSuggestions(accept: boolean) {
  return (state: EditorState, dispatch?: EditorView['dispatch']): boolean => {
    const structural: Array<{
      from: number;
      to: number;
      nodeFrom: number;
      kind: 'insertion' | 'deletion' | 'modification';
      remove?: boolean;
      replace?: boolean;
      mods?: StructuralModification[];
    }> = [];
    state.doc.descendants((node, pos) => {
      for (const kind of ['insertion', 'deletion'] as const) {
        if (nodeSuggestionId(node, kind) == null) continue;
        const drop = accept ? kind === 'deletion' : kind === 'insertion';
        const removable = drop ? removableStructuralRange(state.doc, pos, node) : null;
        structural.push({
          from: removable?.from ?? pos,
          to: removable?.to ?? pos + node.nodeSize,
          nodeFrom: pos,
          kind,
          remove: Boolean(removable),
          replace: drop && !removable && isSoleTopLevelNode(state.doc, pos),
        });
      }
      const mods = nodeModifications(node);
      if (mods.length) structural.push({ from: pos, to: pos + node.nodeSize, nodeFrom: pos, kind: 'modification', mods });
      return true;
    });
    const resolveInline = accept ? applySuggestions : revertSuggestions;
    if (!dispatch) return structural.length > 0 || resolveInline(state);

    let tr: Transaction | null = null;
    const inlineChanged = resolveInline(state, (next) => { tr = next; });
    if (structural.length === 0) {
      if (tr) dispatch(tr);
      return inlineChanged;
    }

    const out = tr ?? state.tr;
    for (const item of structural.sort((a, b) => b.from - a.from)) {
      if (item.kind === 'modification') {
        resolveNodeModifications(out, item.from, item.mods ?? [], accept);
        continue;
      }
      if (item.remove || item.replace) {
        const from = out.mapping.map(item.from, 1);
        const to = out.mapping.map(item.to, -1);
        if (item.replace) out.replaceWith(from, to, out.doc.type.schema.nodes.paragraph.create());
        else deleteOrKeepRequiredDocumentBlock(out, from, to);
      } else {
        const pos = out.mapping.map(item.nodeFrom, 1);
        if (out.doc.nodeAt(pos)) out.setNodeAttribute(pos, nodeSuggestionAttr(item.kind)!, null);
      }
    }
    out.setMeta(suggestChangesKey, { skip: true });
    dispatch(out);
    return true;
  };
}

function reviewButtons(
  view: EditorView,
  className: string,
  accept: () => void,
  reject: () => void,
) {
  const wrap = document.createElement('span');
  wrap.className = className;
  wrap.contentEditable = 'false';
  const mk = (label: string, kind: 'accept' | 'reject', run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = kind === 'accept' ? 'Accept' : 'Reject';
    b.className = `suggestion-review-${kind}`;
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
      view.focus();
    });
    return b;
  };
  wrap.append(mk('✕', 'reject', reject), mk('✓', 'accept', accept));
  return wrap;
}

// One doc walk → the gutter widgets, the hover widget, and whether any
// suggestion exists. Called only on init / doc-change / hover-change.
function buildReviewState(
  state: EditorState,
  hover: SuggestRange | null,
  onResolved?: SuggestionChangesOptions['onResolved'],
): { decorations: DecorationSet; hasSuggestions: boolean } {
  const blocks = suggestionBlocks(state);
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isLeaf && node.content.size > 0) return true;
    const kind = nodeSuggestionId(node, 'insertion') != null
      ? 'insertion'
      : nodeSuggestionId(node, 'deletion') != null
        ? 'deletion'
        : nodeModifications(node).length ? 'modification' : null;
    if (kind) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: `suggestion-node-${kind}` }));
    return true;
  });
  // Right-gutter ✓/✕ at the start of every suggestion-bearing block.
  for (const b of blocks) {
    decos.push(
      Decoration.widget(
        b.from + 1,
        (view, getPos) => {
          // Resolve the control's range at CLICK time, not build time. The widget
          // is keyed by block start, so its DOM (and this closure) is reused across
          // keystrokes that grow the block — a captured `to` would accept only the
          // earlier characters and miss whatever was typed since. Recompute the
          // live block (same semantics as build, #590 merge included) under the
          // widget's current position.
          const liveRange = (): SuggestRange | null => {
            const at = getPos();
            if (at == null) return null;
            return suggestionBlocks(view.state).find((bl) => at >= bl.from && at <= bl.to) ?? null;
          };
          return reviewButtons(
            view,
            'suggestion-gutter',
            () => { const r = liveRange(); if (r) resolveRangeAndRecord(view, r, true, onResolved); },
            () => { const r = liveRange(); if (r) resolveRangeAndRecord(view, r, false, onResolved); },
          );
        },
        { side: -1, key: `block-${b.from}` },
      ),
    );
  }
  // Inline ✓/✕ for the hovered change-group only (revealed on hover).
  if (hover) {
    decos.push(
      Decoration.widget(
        hover.to,
        (view) =>
          reviewButtons(
            view,
            'suggestion-inline-review',
            () => resolveRangeAndRecord(view, hover, true, onResolved),
            () => resolveRangeAndRecord(view, hover, false, onResolved),
          ),
        { side: 1, key: 'group-hover' },
      ),
    );
  }
  return { decorations: DecorationSet.create(state.doc, decos), hasSuggestions: blocks.length > 0 };
}

function suggestionIdsInRange(state: EditorState, from = 0, to = state.doc.content.size): SuggestionId[] {
  const ids = new Set<SuggestionId>();
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) {
      for (const kind of ['insertion', 'deletion'] as const) {
        const id = nodeSuggestionId(node, kind);
        if (id != null) ids.add(id);
      }
      for (const mod of nodeModifications(node)) ids.add(mod.id);
      return;
    }
    for (const mark of node.marks) {
      if ((mark.type.name === 'insertion' || mark.type.name === 'deletion' || mark.type.name === 'modification')
        && mark.attrs.id != null) ids.add(mark.attrs.id as SuggestionId);
    }
  });
  return [...ids];
}

export function resolveRangeAndRecord(
  view: EditorView,
  range: SuggestRange,
  accept: boolean,
  onResolved?: SuggestionChangesOptions['onResolved'],
) {
  const candidates = suggestionIdsInRange(view.state, range.from, range.to);
  const changed = resolveSuggestionRange(range.from, range.to, accept)(view.state, view.dispatch);
  if (!changed || !onResolved || candidates.length === 0) return;
  // Record EVERY range decision, not just the action that removes an id's final
  // live mark. One id can span several blocks; accepting one block and rejecting
  // another must become a durable `mixed` decision rather than last-write-wins.
  onResolved(candidates, accept ? 'accept' : 'reject');
}

function suggestionReviewPlugin(onResolved?: SuggestionChangesOptions['onResolved']) {
  return new Plugin<ReviewState>({
    key: reviewKey,
    state: {
      init: (_config, instance) => ({ hover: null, ...buildReviewState(instance, null, onResolved) }),
      apply: (tr, value, _oldState, newState) => {
        const meta = tr.getMeta(reviewKey) as { hover: SuggestRange | null } | undefined;
        if (meta) return { hover: meta.hover, ...buildReviewState(newState, meta.hover, onResolved) };
        // Keep the hovered range valid across doc changes (a collaborator's edit
        // before it shifts positions) — map it, dropping it if it collapses — then
        // rebuild (suggestion blocks may have appeared / vanished).
        if (tr.docChanged) {
          let hover = value.hover;
          if (hover) {
            const from = tr.mapping.map(hover.from);
            const to = tr.mapping.map(hover.to);
            hover = from < to ? { from, to } : null;
          }
          return { hover, ...buildReviewState(newState, hover, onResolved) };
        }
        // Selection / remote-cursor / awareness / IME tick: reuse the cached set
        // for free — this is what keeps a long single-file session from freezing.
        return value;
      },
    },
    view(editorView) {
      // Reveal the inline ✓/✕ for the change-group under the pointer. Owned as a
      // real DOM listener (not handleDOMEvents) so a HIDE can be DELAYED: the
      // control is an overlay dropped below the run, so moving the pointer onto
      // it crosses a gap that's over neither the run nor the button — without a
      // grace period the control would vanish before the click lands. Re-entering
      // a mark or the control cancels the pending hide. Doc only scanned when
      // actually over a mark, so the per-pixel cost stays near zero.
      let hideTimer: ReturnType<typeof setTimeout> | null = null;
      const clearHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
      const setHover = (group: SuggestRange | null) => {
        const cur = reviewKey.getState(editorView.state)?.hover ?? null;
        if (group?.from !== cur?.from || group?.to !== cur?.to) {
          editorView.dispatch(editorView.state.tr.setMeta(reviewKey, { hover: group }));
        }
      };
      const onMove = (event: MouseEvent) => {
        const el = event.target as HTMLElement | null;
        if (el?.closest?.('.suggestion-inline-review')) { clearHide(); return; } // on the control → hold
        const onMark = el?.closest?.('[data-suggestion]');
        if (onMark) {
          clearHide();
          const at = editorView.posAtCoords({ left: event.clientX, top: event.clientY });
          setHover(at ? changeGroups(editorView.state).find((g) => at.pos >= g.from && at.pos <= g.to) ?? null : null);
          return;
        }
        if (!hideTimer && reviewKey.getState(editorView.state)?.hover) {
          hideTimer = setTimeout(() => { hideTimer = null; setHover(null); }, 320);
        }
      };
      editorView.dom.addEventListener('mousemove', onMove);
      // Flag live suggestions so CSS can drop the content-visibility scroll
      // optimization while they're under review, and reserve the review gutter on
      // read-only editors. The live editor reserves that gutter permanently
      // regardless of this class (see globals.css), so toggling it never reflows
      // the doc mid-typing. Reads the cached flag (no doc walk) so it's free on
      // every view update.
      const sync = () =>
        editorView.dom.classList.toggle('has-suggestions', reviewKey.getState(editorView.state)?.hasSuggestions ?? false);
      sync();
      return {
        update: sync,
        destroy() { editorView.dom.removeEventListener('mousemove', onMove); clearHide(); },
      };
    },
    props: {
      decorations: (state) => reviewKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}

// ---------------------------------------------------------------------------
// Deletion handling. Struck text stays in the doc (that's what makes a deletion
// reversible + position-stable), but the EDITING MODEL treats it as already
// gone — the "accepted projection". So Backspace/Delete operate on that
// projection: they skip over any struck run in the press direction and act on
// the first REAL character beyond it (Cursor / Google-Docs behavior), instead of
// stalling against the strike-through. We own the keys for two more reasons: the
// library's ReplaceStep transform duplicates a deletion's tail as a spurious
// insertion when it abuts existing struck text, and grouping a progressive run
// under one id keeps accept/reject coherent.
// ---------------------------------------------------------------------------
let humanIdCounter = 0;
function freshDeletionId(): SuggestionId {
  humanIdCounter += 1;
  return `h${humanIdCounter}-${Math.floor(Math.random() * 1e6)}`;
}

const deletionIdAt = (state: EditorState, node: PMNode | null | undefined): SuggestionId | null => {
  const m = node?.marks.find((mk) => mk.type === state.schema.marks.deletion);
  return (m?.attrs.id as SuggestionId) ?? null;
};

// Walk past struck text in `dir`, staying inside the current block. Returns the
// position at the far edge of the struck region — where the caret rests in the
// accepted projection, reading the strike-through as absent.
function skipDeletions(state: EditorState, pos: number, dir: number): number {
  const deletion = state.schema.marks.deletion;
  let p = Math.max(0, Math.min(pos, state.doc.content.size));
  for (;;) {
    const $p = state.doc.resolve(p);
    const atBlockEdge = dir < 0 ? $p.parentOffset === 0 : $p.parentOffset >= $p.parent.content.size;
    if (atBlockEdge) return p;
    const node = dir < 0 ? $p.nodeBefore : $p.nodeAfter;
    if (!node?.isText || !deletion.isInSet(node.marks)) return p;
    p += dir < 0 ? -1 : 1;
  }
}

// Safe caret placement — Selection.near never throws the "must point at the
// current document" assertion that TextSelection.create can on a non-text pos.
function placeCaret(tr: Transaction, pos: number): void {
  const p = Math.max(0, Math.min(pos, tr.doc.content.size));
  tr.setSelection(Selection.near(tr.doc.resolve(p)));
}

function commit(view: EditorView, tr: Transaction): boolean {
  tr.setMeta(suggestChangesKey, { skip: true });
  view.dispatch(tr);
  return true;
}

function suggestDelete(view: EditorView, dir: number): boolean {
  const { state } = view;
  const deletion = state.schema.marks.deletion;
  const insertion = state.schema.marks.insertion;
  if (!deletion || !insertion) return false;
  const sel = state.selection;
  const tr = state.tr;

  // A non-empty selection: strike every real char it covers, drop the author's
  // own pending inserts, leave already-struck text alone, collapse the caret.
  if (!sel.empty) {
    const id = deletionIdAt(state, state.doc.resolve(skipDeletions(state, dir < 0 ? sel.to : sel.from, dir)).nodeAfter)
      ?? freshDeletionId();
    const segs: { from: number; to: number; ins: boolean; del: boolean }[] = [];
    state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
      if (!node.isText) return;
      segs.push({
        from: Math.max(sel.from, pos),
        to: Math.min(sel.to, pos + node.nodeSize),
        ins: insertion.isInSet(node.marks) != null,
        del: deletion.isInSet(node.marks) != null,
      });
    });
    for (const s of segs.slice().reverse()) {
      if (s.del) continue;
      if (s.ins) tr.delete(tr.mapping.map(s.from), tr.mapping.map(s.to));
      else tr.addMark(tr.mapping.map(s.from), tr.mapping.map(s.to), deletion.create({ id }));
    }
    // A selection that's already entirely struck holds no real (projection) text
    // to delete — collapse the caret and CONSUME the key. Returning false here
    // would let the default handler re-process the struck range and duplicate it
    // (`deleteme` → `deletemedeleteme`).
    placeCaret(tr, sel.from);
    return commit(view, tr);
  }

  // Empty caret: skip any struck run in the press direction, then act on the
  // first real character beyond it. At a block boundary, defer to the default
  // (paragraph join).
  const edge = skipDeletions(state, sel.from, dir);
  const $e = state.doc.resolve(edge);
  if (dir < 0 ? $e.parentOffset === 0 : $e.parentOffset >= $e.parent.content.size) return false;
  const from = dir < 0 ? edge - 1 : edge;
  const to = dir < 0 ? edge : edge + 1;
  const target = state.doc.resolve(from).nodeAfter;
  // Group the strike with the run we're extending (struck side of `edge`), so a
  // progressive deletion stays one suggestion.
  const struckNode = dir < 0 ? $e.nodeAfter : $e.nodeBefore;
  const id = deletionIdAt(state, struckNode) ?? freshDeletionId();
  if (target && insertion.isInSet(target.marks)) tr.delete(from, to); // own pending insert → remove
  else tr.addMark(from, to, deletion.create({ id }));
  placeCaret(tr, dir < 0 ? from : sel.from);
  return commit(view, tr);
}

// ---------------------------------------------------------------------------
// Deletions are real (struck) text in the doc — that's what makes them
// reversible and position-stable. But the cursor must treat a deletion run as
// atomic: you can read/select it, never type INTO it (which would leave new
// text stranded inside struck text). Typed input lands AFTER the run (Google
// Docs), and a filter backstops paste/programmatic inserts.
// ---------------------------------------------------------------------------
function deletionAt(state: EditorState, pos: number, side: -1 | 1): SuggestionId | null {
  const del = state.schema.marks.deletion;
  if (!del) return null;
  const $p = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
  const node = side < 0 ? $p.nodeBefore : $p.nodeAfter;
  const m = node?.marks.find((mk) => mk.type === del);
  return (m?.attrs.id as SuggestionId) ?? null;
}

// A position is STRICTLY inside a deletion run when the same deletion id hugs it
// on both sides (boundaries — run start/end — are not "inside", so appending
// right after a struck run is allowed).
function insideDeletion(state: EditorState, pos: number): SuggestionId | null {
  const before = deletionAt(state, pos, -1);
  const after = deletionAt(state, pos, 1);
  return before != null && before === after ? before : null;
}

// Walk forward to the first position no longer covered by deletion id `id`.
function deletionRunEnd(state: EditorState, pos: number, id: SuggestionId): number {
  const del = state.schema.marks.deletion;
  let p = pos;
  while (p < state.doc.content.size) {
    const node = state.doc.resolve(p).nodeAfter;
    const m = node?.marks.find((mk) => mk.type === del);
    if (!m || m.attrs.id !== id) break;
    p += 1;
  }
  return p;
}

// Walk backward to the first position before the run covered by deletion id `id`.
function deletionRunStart(state: EditorState, pos: number, id: SuggestionId): number {
  const del = state.schema.marks.deletion;
  let p = pos;
  while (p > 0) {
    const node = state.doc.resolve(p).nodeBefore;
    const m = node?.marks.find((mk) => mk.type === del);
    if (!m || m.attrs.id !== id) break;
    p -= 1;
  }
  return p;
}

// Move a position out of the interior of a struck run to its nearer boundary
// (a boundary is already "outside"). No-op when the position isn't inside one.
function snapOutOfDeletion(state: EditorState, pos: number): number {
  const id = insideDeletion(state, pos);
  if (id == null) return pos;
  const start = deletionRunStart(state, pos, id);
  const end = deletionRunEnd(state, pos, id);
  return pos - start <= end - pos ? start : end;
}

// Accepted projection of a fragment, recursing into blocks: always drop
// deletion-marked (struck) text, and when `stripMarks` also strip the
// insertion/modification marks (keeping their text). Returning a Fragment (not a
// string) lets the caller's serializer keep handling images, hard breaks, and
// block separators; this only touches what the suggestion overlay hides/adds.
function projectSuggestions(fragment: Fragment, stripMarks: boolean): Fragment {
  const projectNode = (node: PMNode): PMNode | null => {
    if (node.isText) {
      if (node.marks.some((m) => m.type.name === 'deletion')) return null; // struck → absent
      if (!stripMarks) return node;
      const marks = node.marks.filter((m) => m.type.name !== 'insertion' && m.type.name !== 'modification');
      return marks.length === node.marks.length ? node : node.mark(marks);
    }
    // Whole-block suggestions carry the mark on the BLOCK node itself (e.g. an
    // inserted blockquote, a struck paragraph). A struck block is dropped; an
    // inserted/modified block is kept with the suggestion mark stripped — so the
    // copied slice never carries a block-level `deletion`/`insertion` mark, which
    // the schema rejects on paste ("Invalid content for node doc").
    if (node.marks.some((m) => m.type.name === 'deletion') || nodeSuggestionId(node, 'deletion') != null) return null;
    const children: PMNode[] = [];
    node.content.forEach((child) => {
      const projected = projectNode(child);
      if (projected) children.push(projected);
    });
    const content = Fragment.fromArray(children);
    if (node.type.name === 'listItem' && node.firstChild?.attrs[NODE_REQUIRED_SHELL]
      && children.length === 1 && children[0].isTextblock && children[0].content.size === 0) return null;
    // A block emptied by accepted deletion disappears with its removable
    // wrappers. Required table-cell/list-item structure is rebuilt below.
    if (node.content.size > 0 && content.size === 0
      && (node.isTextblock || REMOVABLE_REQUIRED_CONTAINERS.has(node.type.name))) return null;
    const marks = stripMarks
      ? node.marks.filter((m) => m.type.name !== 'insertion' && m.type.name !== 'modification')
      : node.marks;
    const attrs = stripMarks ? {
      ...node.attrs,
      [NODE_INSERTION_ID]: null,
      [NODE_DELETION_ID]: null,
      [NODE_MODIFICATIONS]: null,
      [NODE_REQUIRED_SHELL]: null,
    } : node.attrs;
    // createAndFill supplies required shells (empty table-cell paragraph, or a
    // list-item paragraph before a surviving nested list) without inventing a
    // phantom wrapper for containers handled by the empty-prune branch above.
    return node.type.createAndFill(attrs, content, marks);
  };
  const kept: PMNode[] = [];
  fragment.forEach((node) => {
    const projected = projectNode(node);
    if (projected) kept.push(projected);
  });
  return Fragment.fromArray(kept);
}

// text/plain projection — struck text removed (marks are irrelevant to text).
export const stripDeletedText = (fragment: Fragment): Fragment => projectSuggestions(fragment, false);

// Clipboard slice projection — struck text removed AND insertion/modification
// marks stripped, so a Sundial→Sundial copy (which pastes the native lossless
// slice) carries the accepted text with NO suggestion identity: no strike-
// through, no stale accept/reject controls in the destination doc.
export const flattenSuggestions = (fragment: Fragment): Fragment => projectSuggestions(fragment, true);

const deletionGuardKey = new PluginKey('deletionGuard');

function deletionGuardPlugin() {
  return new Plugin({
    key: deletionGuardKey,
    props: {
      // Typed character inside a struck run → insert it just past the run end
      // instead. The dispatch is wrapped by withSuggestChanges, so in suggest
      // mode it still becomes a green insertion; in edit mode it's plain text.
      // The `allow` meta exempts this relocated insert from the filter below.
      handleTextInput(view, from, _to, text) {
        const id = insideDeletion(view.state, from);
        if (id == null) return false;
        const end = deletionRunEnd(view.state, from, id);
        const tr = view.state.tr.insertText(text, end);
        tr.setSelection(TextSelection.create(tr.doc, end + text.length));
        tr.setMeta(deletionGuardKey, { allow: true });
        view.dispatch(tr);
        return true;
      },
      // Selection endpoints never rest STRICTLY inside a struck run — each is
      // snapped to the nearer run boundary. For a click (empty selection) the
      // caret lands at a boundary (atomic, like Google Docs / Cursor); for a
      // drag the selection clamps to whole runs, so it can't cut a strike in
      // half — combined with the projection copy below, a selection reads as the
      // accepted + suggested text only.
      createSelectionBetween(view, $anchor, $head) {
        const a = snapOutOfDeletion(view.state, $anchor.pos);
        const h = snapOutOfDeletion(view.state, $head.pos);
        if (a === $anchor.pos && h === $head.pos) return null;
        return TextSelection.create(view.state.doc, a, h);
      },
      // ArrowLeft/Right step OVER a whole struck run rather than into it, so the
      // caret moves through the accepted projection (the library already does
      // this for its zero-width insertion spacers; this covers deletion runs).
      handleKeyDown(view, event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false;
        const { selection } = view.state;
        if (!(selection instanceof TextSelection)) return false;
        const dir = event.key === 'ArrowLeft' ? -1 : 1;
        const $h = view.state.doc.resolve(selection.head);
        const node = dir < 0 ? $h.nodeBefore : $h.nodeAfter;
        if (!node?.isText || !view.state.schema.marks.deletion?.isInSet(node.marks)) return false;
        const target = skipDeletions(view.state, selection.head, dir);
        if (target === selection.head) return false;
        const next = event.shiftKey
          ? TextSelection.create(view.state.doc, selection.anchor, target)
          : TextSelection.create(view.state.doc, target);
        view.dispatch(view.state.tr.setSelection(next).scrollIntoView());
        event.preventDefault();
        return true;
      },
      // NB: copy-yields-the-projection lives in the editor's single
      // clipboardTextSerializer (imageAwareClipboardText), which drops struck
      // text through stripDeletedText. A serializer here would be dead code —
      // someProp resolves the editor's direct prop before any plugin prop.
    },
    // Backstop for paste / programmatic inserts AT a cursor that sits strictly
    // inside a struck run: drop only that insertion so nothing is stranded
    // inside the strike-through. Scoped to a step that inserts at exactly the
    // cursor position, so an edit ELSEWHERE while the cursor happens to be
    // parked in a deletion (find-replace, a trailing-paragraph appendTransaction,
    // a snippet) is NOT blocked. The suggestion engine (skip meta), remote
    // y-sync, history, and the relocated typed-input above are exempt.
    filterTransaction(tr, state) {
      if (!tr.docChanged) return true;
      if ((tr.getMeta(deletionGuardKey) as { allow?: boolean } | undefined)?.allow) return true;
      const ys = (tr.getMeta('y-sync$') ?? {}) as Record<string, unknown>;
      if (ys.isChangeOrigin || ys.isUndoRedoOperation) return true;
      if (tr.getMeta('history$')) return true;
      if ('skip' in ((tr.getMeta(suggestChangesKey) as Record<string, unknown> | undefined) ?? {})) return true;
      // Only the FIRST content-adding step is checked: its `from` is still in
      // pre-transaction coords (later steps map through earlier ones). Block iff
      // that insert lands strictly inside a deletion run — so a paste at a
      // cursor-in-struck-text is dropped, but an edit elsewhere is not.
      for (const step of tr.steps) {
        const s = step as { from?: number; slice?: { content?: { size: number } } };
        if ((s.slice?.content?.size ?? 0) > 0) {
          return !(typeof s.from === 'number' && insideDeletion(state, s.from) != null);
        }
      }
      return true;
    },
  });
}

export const SuggestionChanges = Extension.create<SuggestionChangesOptions>({
  name: 'suggestionChanges',

  addProseMirrorPlugins() {
    return this.options.canResolve === false
      ? [suggestChanges(), deletionGuardPlugin()]
      : [suggestChanges(), suggestionReviewPlugin(this.options.onResolved), deletionGuardPlugin()];
  },

  addKeyboardShortcuts() {
    const run = (dir: number) => (): boolean => {
      const view = this.editor.view;
      if (!isSuggestChangesEnabled(view.state)) return false;
      return suggestDelete(view, dir);
    };
    return { Backspace: run(-1), Delete: run(1) };
  },

  // Tiptap owns the view's dispatchTransaction, so we wrap it after creation
  // (not via editorProps, which Tiptap overrides). withSuggestChanges rewrites
  // local edits into tracked (mark-based) edits ONLY when suggesting is enabled,
  // and already skips remote y-sync / history / collab transactions — so live
  // collaboration and undo keep working untouched.
  onCreate() {
    const editor = this.editor;
    const view = editor.view as typeof editor.view & { __suggestWrapped?: boolean };
    if (view.__suggestWrapped) return;
    // `dispatchTransaction` is a direct (non-plugin) prop, so someProp returns
    // Tiptap's own bound dispatcher at runtime. someProp must be called as a
    // METHOD (it reads this._props internally) — calling a detached reference
    // throws. We call the original through so Tiptap's bookkeeping (transaction
    // events, React updates) is preserved.
    const original =
      (view.someProp('dispatchTransaction' as never) as ((tr: Transaction) => void) | undefined) ??
      ((tr: Transaction) => view.updateState(view.state.apply(tr)));
    view.setProps({
      dispatchTransaction: withSuggestChanges(function (tr) {
        if (tr.docChanged) inlineBlockSuggestionMarks(tr);
        original.call(editor, tr);
      }, this.options.generateId ?? generateNextSuggestionId),
    });
    view.__suggestWrapped = true;
  },

  addCommands() {
    return {
      setSuggesting:
        (on: boolean) =>
        ({ state, dispatch }: CommandProps) =>
          (on ? enableSuggestChanges : disableSuggestChanges)(state, dispatch),
      acceptAllSuggestions:
        () =>
        ({ state, dispatch }: CommandProps) => {
          const ids = suggestionIdsInRange(state);
          const changed = resolveAllSuggestions(true)(state, dispatch);
          if (changed && dispatch && ids.length) this.options.onResolved?.(ids, 'accept');
          return changed;
        },
      rejectAllSuggestions:
        () =>
        ({ state, dispatch }: CommandProps) => {
          const ids = suggestionIdsInRange(state);
          const changed = resolveAllSuggestions(false)(state, dispatch);
          if (changed && dispatch && ids.length) this.options.onResolved?.(ids, 'reject');
          return changed;
        },
      acceptSuggestion:
        (id: SuggestionId) =>
        ({ state, dispatch }: CommandProps) => {
          const changed = resolveSuggestionId(id, true)(state, dispatch);
          if (changed && dispatch) this.options.onResolved?.([id], 'accept');
          return changed;
        },
      rejectSuggestion:
        (id: SuggestionId) =>
        ({ state, dispatch }: CommandProps) => {
          const changed = resolveSuggestionId(id, false)(state, dispatch);
          if (changed && dispatch) this.options.onResolved?.([id], 'reject');
          return changed;
        },
    };
  },
});

export const SuggestionMarks = [SuggestionDocument, SuggestionNodeAttributes, InsertionMark, DeletionMark, ModificationMark, SuggestionChanges];
