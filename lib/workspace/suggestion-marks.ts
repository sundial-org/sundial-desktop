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
import { InputRule, Mark, Node, Extension, type AnyExtension, type CommandProps } from '@tiptap/core';
import { EditorState, Plugin, PluginKey, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
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
import { rejectDependentGroups } from '@/lib/crdt-js/markdown_yjs.mjs';
import { changedBlockSpan } from '@/lib/tiptap/incremental-decorations';

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
// Table internals are climbed THROUGH when emptied (a fully-emptied table goes
// as a whole) but never deleted on their own — a lone emptied cell keeps the grid.
const TABLE_INTERNALS = new Set(['tableRow', 'tableCell', 'tableHeader']);

// The library anchors insertion runs with U+200B spacer characters, so in
// suggest mode a fresh line's text is "​# " — and every `^`-anchored
// input rule silently stops matching. Let block-TYPE rules (setBlockType:
// heading, code fence — tracked as a clean nodeType modification) skip leading
// spacers; the match then covers the spacer, so the rule's own delete-range
// removes it along with the markdown prefix. WRAPPING rules (lists, quotes)
// stay untouched: the library mistracks their ReplaceAroundStep into an empty
// wrapper, so for them not-firing is strictly better than firing.
const SPACER_TOLERANT_RULE_NODES = new Set(['heading', 'codeBlock']);
const spacerTolerantFind = (find: RegExp): RegExp =>
  find.source.startsWith('^') && !find.source.startsWith('^(?:\\u200B')
    ? new RegExp(`^(?:\\u200B)*${find.source.slice(1)}`, find.flags)
    : find;

// The suggestion library can temporarily put marks on block children at every
// nesting depth, before our dispatch wrapper converts them to durable attrs +
// inline marks. Patch node kits recursively so those transactions are schema-
// valid inside lists, quotes, and tables as well as at the document root —
// and make their `^`-anchored input rules tolerate the insertion spacers.
export function allowSuggestionBlockMarks<T extends AnyExtension>(extension: T): T {
  const fields: Record<string, unknown> = {};
  if (BLOCK_CONTAINERS.has(extension.name)) fields.marks = SUGGESTION_NODE_MARKS;
  // codeBlock ships `marks: ""`, which is right for formatting (no bold inside
  // fences) but also silently swallowed suggestion marks: in suggest mode a
  // delete or type inside a code block staged NOTHING (the addMark was a
  // schema no-op), so the edit appeared to do nothing and reviews had nothing
  // to show. Allow exactly the three suggestion marks there — formatting marks
  // stay banned.
  if (extension.name === 'codeBlock') fields.marks = SUGGESTION_NODE_MARKS;
  if (extension.config.addExtensions) {
    fields.addExtensions = function (this: { parent?: () => AnyExtension[] }) {
      return (this.parent?.() ?? []).map(allowSuggestionBlockMarks);
    };
  }
  if (SPACER_TOLERANT_RULE_NODES.has(extension.name) && extension.config.addInputRules) {
    fields.addInputRules = function (this: { parent?: () => InputRule[] }) {
      return (this.parent?.() ?? []).map((rule) =>
        rule.find instanceof RegExp
          ? new InputRule({ find: spacerTolerantFind(rule.find), handler: rule.handler, undoable: rule.undoable })
          : rule,
      );
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
  /** Who suggested this range — renders an avatar left of the ✓/✕ that opens the
   *  originating chat turn. Return null for ranges with no known author. */
  resolveAuthor?: (ids: SuggestionId[]) => SuggestionAuthor | null;
  /** Reject-cascade outcome for dependent stacked ids (see rejectDependentGroups
   *  in markdown_yjs.mjs): fully consumed dependents tombstone as 'mixed',
   *  partially consumed ones park until their remainder resolves — wire to
   *  recordRejectCascadeOutcome so the editor matches the headless resolver. */
  onCascade?: (outcome: CascadeOutcome) => void;
};

export type CascadeOutcome = { consumed: SuggestionId[]; partial: SuggestionId[] };

export type SuggestionAuthor = {
  label: string;
  /** Chip background — one stable color per author. */
  color?: string;
  /** Avatar image (Sunny's face, a brand mark); absent → initials chip. */
  imageUrl?: string | null;
  /** True for face avatars (clip round, cover); false for brand marks (contain). */
  imageRound?: boolean;
  /** Chip text/background overrides for logo-less brands (e.g. Codex "Cx"). */
  chipLabel?: string;
  chipColor?: string;
  /** Absent for suggestions with no chat turn to open (a human's own edits). */
  onJump?: () => void;
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
    // Structural suggestions on descendants carry ATTRS, not marks — a
    // suggested hardBreak has no mark at all. Both must reveal the source.
    if (
      !found &&
      (hasNodeSuggestion(child) || child.marks.some((m) => SUGGESTION_MARK_NAMES.has(m.type.name)))
    ) {
      found = true;
    }
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
//   • per BLOCK — author chip + ✓/✕ pinned to the right-hand gutter, revealed
//     for the hovered line
// The per-group overlay is the pre-#1104 control restored faithfully; it
// coexists with the gutter by explicit call (Florent, 2026-08-08) — both may
// show on the same hover. Both act through the same range primitive, so they
// need no finer id grouping — a group/block accepts or reverts exactly the
// marks in its span (a #590 merged replacement resolves whole, see
// inlineResolutionRange).
// ---------------------------------------------------------------------------
// Cached in plugin state so the decoration set is rebuilt only when it can have
// changed (doc edit or hover move), never on selection / remote-cursor /
// awareness / IME ticks — see the cachedDecorations note in collab-editor.tsx.
type ReviewState = {
  /** What props.decorations serves: `base` plus, while a run is hovered, the
   *  word-level floating ✓/✕ pair. A pointer move recomposes from `base`
   *  without re-walking the doc. */
  decorations: DecorationSet;
  /** The doc-derived set (gutter controls + node classes), rebuilt only on
   *  doc change / author refresh. */
  base: DecorationSet;
  hasSuggestions: boolean;
  /** Bumped when suggestion attribution changes. Folded into the gutter widget
   *  keys: ProseMirror reuses a keyed widget's DOM across rebuilds, so without
   *  a new key the control built before the author map arrived would keep its
   *  chipless DOM forever. */
  authorsVersion: number;
  /** Change runs / gutter blocks for the current doc — cached with the
   *  decorations so per-pixel hover hit-tests never walk the doc. */
  groups: SuggestRange[];
  blocks: SuggestionBlock[];
  /** The run whose word-level pair is showing, or null. */
  hover: SuggestRange | null;
};
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

// A gutter control's range: `merged` marks the #590 whole-block replacement
// pair (del-only block + ins-only block, same single suggestion id) fused into
// one control — one ATOMIC suggestion that must never be resolved by halves.
export type SuggestionBlock = SuggestRange & { merged?: true };

// Top-level blocks that contain at least one suggestion, as content ranges.
export function suggestionBlocks(state: EditorState): SuggestionBlock[] {
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
  const blocks: SuggestionBlock[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const b = raw[i];
    const next = raw[i + 1];
    const delOnly = b.delIds.size > 0 && b.insIds.size === 0 && b.modIds.size === 0 ? only(b.delIds) : null;
    const insOnly = next && next.insIds.size > 0 && next.delIds.size === 0 && next.modIds.size === 0 ? only(next.insIds) : null;
    if (next && delOnly != null && insOnly != null && delOnly === insOnly && b.to === next.from) {
      blocks.push({ from: b.from, to: next.to, merged: true });
      i += 1; // consume the insertion half of the pair
    } else {
      blocks.push({ from: b.from, to: b.to });
    }
  }
  return blocks;
}

// Blocks the by-id / whole-document resolutions empty. Those paths delegate the
// inline work to the suggest-changes library (which owns modification-mark
// semantics the range path does not model), so they can't reuse the range
// path's own drop set — recover it from the marks instead: accepting removes
// `deletion`-marked text, rejecting removes `insertion`-marked text. `id` null
// means every suggestion. `extra` carries the reject cascade's dependent drops.
function suggestionEmptiedBlocks(
  doc: PMNode,
  accept: boolean,
  id: SuggestionId | null,
  extra: SuggestRange[] = [],
): SuggestRange[] {
  const dropMark = accept ? 'deletion' : 'insertion';
  const dropRanges: SuggestRange[] = [...extra];
  doc.descendants((node, pos) => {
    if (node.isText && node.marks.some((m) => m.type.name === dropMark && (id == null || m.attrs.id === id))) {
      dropRanges.push({ from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  const structDropped = (node: PMNode) => {
    const nodeId = nodeSuggestionId(node, dropMark);
    return nodeId != null && (id == null || nodeId === id);
  };
  return emptiedBlockDeletes(doc, dropRanges, 0, doc.content.size, structDropped);
}

// Blocks whose ENTIRE text is removed by `dropRanges` (accepting a whole-line
// strike, or rejecting a whole-line insert) must be removed outright — leaving
// the emptied block behind renders as a stray blank line, a bare `# ` heading,
// or an orphan `- ` bullet (the #767 empty-shell class). Shared by every editor
// resolution path so they all converge with the headless resolver.
// Only real text drops count — NOT spacers: accepting a suggested blank line
// leaves a block whose sole child is the zero-width insertion placeholder, and
// that block must be KEPT (blank), with just the placeholder removed.
// `structDropped` names the nodes this resolution removes by node attr (a
// suggested blank bullet / code fence / rule / image has no text to mark) — they
// count as dropped content, so a list of only such nodes is deleted whole
// instead of item by item (ProseMirror refits a required listItem shell when
// the last one goes).
function emptiedBlockDeletes(
  doc: PMNode,
  dropRanges: SuggestRange[],
  from: number,
  to: number,
  structDropped: (node: PMNode, pos: number) => boolean = () => false,
): SuggestRange[] {
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
      if (structDropped(child, start + off)) { any = true; return false; }
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
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock && !structDropped(node, pos)) return true;
    const cStart = pos + 1;
    if (!structDropped(node, pos)) {
      if (pos + node.nodeSize - 1 <= cStart) return false; // already empty — leave pre-existing blanks
      if (!allTextDropped(node, cStart)) return false;
    }
    // A top-level emptied block is deleted outright. A NESTED one climbs to
    // the outermost fully-dropped list / blockquote container, so a rejected
    // list-item insert takes its bullet with it (and an emptied whole list,
    // the list). A nested textblock that can't climb keeps its container —
    // the paragraph a list_item / table cell REQUIRES — and falls through to
    // plain text deletion instead (a valid, possibly-empty block).
    const $pos = doc.resolve(pos);
    let del = $pos.depth === 0 ? { from: pos, to: pos + node.nodeSize } : null;
    for (let d = $pos.depth; d >= 1; d -= 1) {
      const anc = $pos.node(d);
      const name = anc.type.name;
      if (!(REMOVABLE_REQUIRED_CONTAINERS.has(name) || TABLE_INTERNALS.has(name) || name === 'table')) break;
      if (!allTextDropped(anc, $pos.start(d))) break;
      if (!TABLE_INTERNALS.has(name)) del = { from: $pos.before(d), to: $pos.after(d) };
    }
    // An earlier climb may already cover this range (later items of a fully
    // dropped list) — a duplicate delete would eat unrelated content.
    if (del && !blockDeletes.some((bd) => bd.from <= del!.from && bd.to >= del!.to)) blockDeletes.push(del);
    return false;
  });
  return blockDeletes;
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
    const dropAttr = nodeSuggestionAttr(dropType.name)!;
    // Only nodes THIS range resolves count as dropped — a sibling's pending
    // structural insertion outside [from, to] must not be swept along.
    const blockDeletes = emptiedBlockDeletes(state.doc, dropRanges, from, to,
      (n, pos) => n.attrs[dropAttr] != null && pos >= from && pos + n.nodeSize <= to);
    const inBlockDelete = (o: SuggestRange) => blockDeletes.some((bd) => bd.from <= o.from && bd.to >= o.to);

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
      // A structural drop inside a whole-container delete is subsumed by it
      // (positions are raw, so a nested second delete would eat what follows).
      ...nodeOps.filter((op) => op.kind !== 'drop-node' || !inBlockDelete(op)).map((op): Apply => ({
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

// Editor-path half of the stacked-suggestion reject cascade. The dependency
// rule itself is rejectDependentGroups in markdown_yjs.mjs — the codec's single
// source, shared with the headless resolver — so rejecting a stack's base from
// the editor produces the identical post-state the chat card / API produces
// (no dangling "beta OMEGA" hybrid). Run sequences mirror the codec's: one
// textblock's contiguous text children, split at non-text inline nodes (the
// codec walks each Y.XmlText alone).
function rejectCascadeOps(doc: PMNode, id: SuggestionId) {
  const drops: SuggestRange[] = [];
  const clears: SuggestRange[] = [];
  const depIds = new Set<SuggestionId>();
  const markId = (node: PMNode, name: string): SuggestionId | null =>
    (node.marks.find((m) => m.type.name === name)?.attrs.id as SuggestionId | null | undefined) ?? null;
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    let seq: Array<{ from: number; to: number; insertionId: SuggestionId | null; deletionId: SuggestionId | null }> = [];
    const flush = () => {
      if (!seq.length) return;
      const { cascaded, reverted, depIds: deps } = rejectDependentGroups(seq, id);
      for (const j of cascaded) drops.push({ from: seq[j].from, to: seq[j].to });
      for (const j of reverted) if (!cascaded.has(j)) clears.push({ from: seq[j].from, to: seq[j].to });
      for (const dep of deps) depIds.add(dep as SuggestionId);
      seq = [];
    };
    block.forEach((child, offset) => {
      if (!child.isText) { flush(); return; }
      const from = pos + 1 + offset;
      seq.push({ from, to: from + child.nodeSize, insertionId: markId(child, 'insertion'), deletionId: markId(child, 'deletion') });
    });
    flush();
    return false;
  });
  // Structural twin (mirror of the codec's cascadeStructural): a container's
  // child sequence, each child ONE run — its own attrs, else its subtree's ids
  // when uniform (a struck-and-replaced table / list / paragraph pair).
  const attrClears: number[] = []; // positions of nodes whose deletion attr clears
  const walkContainer = (container: PMNode, base: number) => {
    const kids: Array<{ node: PMNode; pos: number }> = [];
    container.forEach((child, offset) => kids.push({ node: child, pos: base + offset }));
    const { cascaded, reverted, depIds: deps } = rejectDependentGroups(kids.map((k) => nodeRunIds(k.node)), id);
    for (const j of cascaded) {
      const { node, pos } = kids[j];
      drops.push(removableStructuralRange(doc, pos, node) ?? { from: pos, to: pos + node.nodeSize });
    }
    for (const j of reverted) {
      if (cascaded.has(j)) continue;
      const { node, pos } = kids[j];
      const dep = nodeRunIds(node).deletionId;
      clears.push({ from: pos, to: pos + node.nodeSize });
      if (nodeSuggestionId(node, 'deletion') === dep) attrClears.push(pos);
      node.descendants((d, off) => { if (nodeSuggestionId(d, 'deletion') === dep) attrClears.push(pos + 1 + off); return true; });
    }
    for (const dep of deps) depIds.add(dep as SuggestionId);
    kids.forEach(({ node, pos }) => { if (!node.isLeaf && !node.isTextblock) walkContainer(node, pos + 1); });
  };
  walkContainer(doc, 0);
  return { drops, clears, attrClears, depIds };
}

function nodeRunIds(node: PMNode): { insertionId: SuggestionId | null; deletionId: SuggestionId | null } {
  if (nodeSuggestionId(node, 'insertion') != null || nodeSuggestionId(node, 'deletion') != null) {
    return { insertionId: nodeSuggestionId(node, 'insertion'), deletionId: nodeSuggestionId(node, 'deletion') };
  }
  const ins = new Set<SuggestionId | null>();
  const del = new Set<SuggestionId | null>();
  const markId = (n: PMNode, name: string) => (n.marks.find((m) => m.type.name === name)?.attrs.id as SuggestionId | undefined) ?? null;
  const visit = (n: PMNode): boolean => {
    if (n.isText) { ins.add(markId(n, 'insertion')); del.add(markId(n, 'deletion')); return true; }
    if (nodeSuggestionId(n, 'insertion') != null || nodeSuggestionId(n, 'deletion') != null) {
      ins.add(nodeSuggestionId(n, 'insertion')); del.add(nodeSuggestionId(n, 'deletion')); return false;
    }
    if ((n.isLeaf && n.type.name !== 'hardBreak') || (n.isTextblock && n.content.size === 0)) { ins.add(null); del.add(null); }
    return true;
  };
  if (visit(node)) node.descendants(visit);
  const one = (set: Set<SuggestionId | null>) => (set.size === 1 ? [...set][0] : null);
  return ins.size === 0 ? { insertionId: null, deletionId: null } : { insertionId: one(ins), deletionId: one(del) };
}

// Mirror of the codec's suggestionStillLive: inline marks + structural attrs.
function suggestionLiveInDoc(doc: PMNode, id: SuggestionId): boolean {
  let live = false;
  doc.descendants((node) => {
    if (!live) {
      live = node.isText
        ? node.marks.some((m) => SUGGESTION_MARK_NAMES.has(m.type.name) && m.attrs.id === id)
        : nodeSuggestionId(node, 'insertion') === id || nodeSuggestionId(node, 'deletion') === id
          || nodeModifications(node).some((mod) => mod.id === id);
    }
    return !live;
  });
  return live;
}

// U+200B spacers anchor pending insertion runs (the library inserts them at
// run boundaries). Once a resolution strips the marks, an orphaned spacer is
// plain invisible text that persists into the markdown forever — it survived
// accept, landed in `files.content_text`, and came back on every reload.
// Sweep every suggestion-unmarked spacer char in the SAME transaction; spacers
// still carrying a mark belong to a different pending suggestion and stay.
function sweepOrphanSpacers(tr: Transaction) {
  const positions: number[] = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isText || !node.text?.includes('\u200B')) return true;
    if (node.marks.some((m) => SUGGESTION_MARK_NAMES.has(m.type.name))) return true;
    for (let i = 0; i < node.text.length; i += 1) {
      if (node.text[i] === '\u200B') positions.push(pos + i);
    }
    return true;
  });
  for (let i = positions.length - 1; i >= 0; i -= 1) tr.delete(positions[i], positions[i] + 1);
}

/** The library's own resolve transaction, with the spacer sweep appended. */
const sweepingDispatch = (dispatch?: EditorView['dispatch']): EditorView['dispatch'] | undefined =>
  dispatch &&
  ((tr: Transaction) => {
    sweepOrphanSpacers(tr);
    dispatch(tr);
  });

function resolveSuggestionId(id: SuggestionId, accept: boolean, onCascade?: (outcome: CascadeOutcome) => void) {
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
    const cascade = accept ? null : rejectCascadeOps(state.doc, id);
    const resolveInline = accept ? applySuggestion(id) : revertSuggestion(id);
    // Blocks this id empties must go with it, exactly as on the range path —
    // otherwise accepting a suggestion that removed a heading leaves `# `.
    const blockDeletes = suggestionEmptiedBlocks(state.doc, accept, id, cascade?.drops ?? [])
      .filter((r) => !structural.some((s) => (s.remove || s.replace) && s.from <= r.from && s.to >= r.to));
    if (structural.length === 0 && !cascade?.depIds.size && blockDeletes.length === 0) {
      return resolveInline(state, sweepingDispatch(dispatch));
    }
    if (!dispatch) return true;

    // Block work first, library last — see resolveAllSuggestions.
    const out = state.tr;
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
    for (const r of [...blockDeletes].sort((a, b) => b.from - a.from)) {
      deleteOrKeepRequiredDocumentBlock(out, out.mapping.map(r.from, 1), out.mapping.map(r.to, -1));
    }
    resolveInline(EditorState.create({ doc: out.doc }), (inline) => { for (const step of inline.steps) out.step(step); });
    if (cascade) {
      // All positions pre-computed on `state.doc`; the mapping accounts for the
      // library's own deletions of `id`'s runs (dependent runs never overlap
      // them — an earlier id can't mark later-inserted text). One transaction,
      // so undo/observers see one step and the hybrid never renders.
      for (const r of [...cascade.drops].sort((a, b) => b.from - a.from)) {
        out.delete(out.mapping.map(r.from, 1), out.mapping.map(r.to, -1));
      }
      const deletionType = state.schema.marks.deletion;
      for (const r of cascade.clears) {
        out.removeMark(out.mapping.map(r.from, 1), out.mapping.map(r.to, -1), deletionType);
      }
      for (const p of cascade.attrClears) {
        const pos = out.mapping.map(p, 1);
        if (out.doc.nodeAt(pos)) out.setNodeAttribute(pos, NODE_DELETION_ID, null);
      }
    }
    sweepOrphanSpacers(out);
    out.setMeta(suggestChangesKey, { skip: true });
    dispatch(out);
    if (onCascade && cascade?.depIds.size) {
      const deps = [...cascade.depIds].filter((dep) => dep !== id);
      const consumed = deps.filter((dep) => !suggestionLiveInDoc(out.doc, dep));
      if (deps.length) onCascade({ consumed, partial: deps.filter((dep) => !consumed.includes(dep)) });
    }
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
    // Blocks emptied by this resolution must go with it — see the range path.
    const blockDeletes = suggestionEmptiedBlocks(state.doc, accept, null)
      .filter((r) => !structural.some((s) => (s.remove || s.replace) && s.from <= r.from && s.to >= r.to));
    const resolveInline = accept ? applySuggestions : revertSuggestions;
    if (!dispatch) return structural.length > 0 || blockDeletes.length > 0 || resolveInline(state);

    if (structural.length === 0 && blockDeletes.length === 0) return resolveInline(state, sweepingDispatch(dispatch));

    // Block work FIRST, on positions computed against `state.doc`. The library's
    // inline pass can merge an emptied block into its neighbour (deleteRange
    // over a mark run spanning blocks becomes one open-ended replace), after
    // which a pre-computed container range no longer maps to the container —
    // so it runs LAST, on the resulting doc, its steps folded into this one
    // transaction (single undo step, one Yjs update).
    const out = state.tr;
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
    for (const r of [...blockDeletes].sort((a, b) => b.from - a.from)) {
      deleteOrKeepRequiredDocumentBlock(out, out.mapping.map(r.from, 1), out.mapping.map(r.to, -1));
    }
    resolveInline(EditorState.create({ doc: out.doc }), (inline) => { for (const step of inline.steps) out.step(step); });
    sweepOrphanSpacers(out);
    out.setMeta(suggestChangesKey, { skip: true });
    dispatch(out);
    return true;
  };
}

/** Two letters from a display label ("Agent #7" → A7, "Ada Lovelace" → AL).
 *  Splits on `#` too, so agent numbers survive instead of collapsing to "A#". */
export function authorInitials(label: string): string {
  const letters = label.trim().split(/[\s#]+/).filter(Boolean).map((part) => part[0]).join('');
  return (letters.slice(0, 2) || '?').toUpperCase();
}

export function authorButton(author: SuggestionAuthor) {
  // No jump target → a plain chip, not a dead <button>: a disabled button
  // styled like the ✓/✕ controls beside it reads as a broken action
  // ("the icon isn't clickable" — user interviews), while a span with
  // `is-static` styling reads as the byline it is.
  const b = author.onJump ? document.createElement('button') : document.createElement('span');
  if (b instanceof HTMLButtonElement) b.type = 'button';
  b.className = author.onJump ? 'suggestion-author' : 'suggestion-author is-static';
  b.title = author.onJump ? `${author.label} · open the chat turn` : author.label;
  b.setAttribute('aria-label', b.title);
  if (author.imageUrl) {
    const img = document.createElement('img');
    img.src = author.imageUrl;
    img.alt = '';
    img.draggable = false;
    b.append(img);
    // Face avatars fill the round chip; brand marks sit on a transparent chip
    // uncropped — the same two treatments the chat list uses.
    if (author.imageRound === false) {
      b.classList.add('is-mark');
      img.classList.add('is-mark');
    }
  } else {
    b.textContent = author.chipLabel ?? authorInitials(author.label);
    const bg = author.chipColor ?? author.color;
    if (bg) b.style.background = bg;
  }
  if (author.onJump) {
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      author.onJump!();
    });
  }
  return b;
}

function reviewButtons(
  view: EditorView,
  className: string,
  accept: () => void,
  reject: () => void,
  author?: SuggestionAuthor | null,
) {
  const wrap = document.createElement('span');
  wrap.className = className;
  wrap.contentEditable = 'false';
  if (author) wrap.append(authorButton(author));
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

// One doc walk → the gutter widgets, the cached run/block ranges, and whether
// any suggestion exists. Called only on init / doc-change / author-refresh;
// the per-run hover pair rides on top via composeReview (a pointer move never
// re-walks the doc — the ranges are cached here).
type BuiltReview = {
  decorations: DecorationSet;
  hasSuggestions: boolean;
  groups: SuggestRange[];
  blocks: SuggestionBlock[];
};
function buildReviewState(
  state: EditorState,
  onResolved?: SuggestionChangesOptions['onResolved'],
  resolveAuthor?: SuggestionChangesOptions['resolveAuthor'],
  authorsVersion = 0,
): BuiltReview {
  const authorOf = (view: EditorView, range: SuggestRange) =>
    resolveAuthor?.(suggestionIdsInRange(view.state, range.from, range.to)) ?? null;
  const blocks = suggestionBlocks(state);
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    // Containers holding text are coloured by their inline marks; leaves,
    // blanks, textless containers and raw-text blocks only have the attr.
    if (!node.isLeaf && node.textContent && !node.type.spec.code) return true;
    const kind = nodeSuggestionId(node, 'insertion') != null
      ? 'insertion'
      : nodeSuggestionId(node, 'deletion') != null
        ? 'deletion'
        : nodeModifications(node).length ? 'modification' : null;
    // A struck EMPTY paragraph (the blank line a paste landed in) has nothing
    // to strike: it is invisible in the projection, so no red box. (Other
    // empty textblocks, e.g. a fence, still render chrome worth striking.)
    if (kind === 'deletion' && node.type.name === 'paragraph') return true;
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
            authorOf(view, b),
          );
        },
        { side: -1, key: `block-${b.from}-a${authorsVersion}` },
      ),
    );
  }
  return {
    decorations: DecorationSet.create(state.doc, decos),
    hasSuggestions: blocks.length > 0,
    groups: changeGroups(state),
    blocks,
  };
}

/** A per-run resolve must never split the #590 merged whole-block replacement
 *  — a del-only block + ins-only block sharing ONE suggestion id is one atomic
 *  suggestion, and resolving a half would strand the other while recording a
 *  partial decision for that id (Codex, PR #1180). Expand the run to its
 *  containing merged block so both halves resolve together, exactly like the
 *  block's own gutter control. */
export function inlineResolutionRange(blocks: SuggestionBlock[], run: SuggestRange): SuggestRange {
  return blocks.find((b) => b.merged && b.from <= run.from && run.to <= b.to) ?? run;
}

// Inline ✓/✕ for the hovered change-group only (revealed on hover) — the
// pre-#1104 per-run overlay, restored. An OVERLAY anchored at the run's end
// with NO inset offsets, so `position: absolute` keeps its static inline
// position: a positioned ancestor (`.sd-foldable`'s chevron anchor) cannot
// displace it the way it hijacks the gutter's lane (see globals.css).
function inlineReviewWidget(run: SuggestRange, onResolved?: SuggestionChangesOptions['onResolved']) {
  return Decoration.widget(
    run.to,
    (view, getPos) => {
      // Resolve at CLICK time under the widget's live position (the gutter's
      // liveRange rationale — the DOM and this closure outlive doc edits), and
      // widen to the whole #590 merged replacement so it resolves atomically.
      const liveRun = (): SuggestRange | null => {
        const at = getPos();
        if (at == null) return null;
        const cached = reviewKey.getState(view.state);
        const group = cached?.groups.find((g) => at >= g.from && at <= g.to) ?? null;
        return group ? inlineResolutionRange(cached?.blocks ?? [], group) : null;
      };
      return reviewButtons(
        view,
        'suggestion-inline-review',
        () => { const r = liveRun(); if (r) resolveRangeAndRecord(view, r, true, onResolved); },
        () => { const r = liveRun(); if (r) resolveRangeAndRecord(view, r, false, onResolved); },
      );
    },
    { side: 1, key: `run-${run.from}-${run.to}` },
  );
}

// Base decorations + (while a run is hovered) the per-run pair. The hover range
// arrives either fresh from the pointer or mapped through a doc change; snapping
// it back onto the group it overlaps drops it when its run was resolved away.
function composeReview(
  state: EditorState,
  built: BuiltReview,
  hover: SuggestRange | null,
  onResolved?: SuggestionChangesOptions['onResolved'],
): Omit<ReviewState, 'authorsVersion'> {
  const run = hover ? built.groups.find((g) => g.from <= hover.to && hover.from <= g.to) ?? null : null;
  return {
    decorations: run ? built.decorations.add(state.doc, [inlineReviewWidget(run, onResolved)]) : built.decorations,
    base: built.decorations,
    hasSuggestions: built.hasSuggestions,
    groups: built.groups,
    blocks: built.blocks,
    hover: run,
  };
}

/** Show (pos) or hide (null) the per-run pair for the change group at `pos` —
 *  ANY hovered run reveals its pair (pre-#1104 behavior; it may show beside
 *  the block's gutter control, which is intentional). The pointer plumbing
 *  lives in the plugin view; exported so tests can drive hover without
 *  coordinates (jsdom has no layout). Returns the run shown. */
export function setSuggestionRunHover(view: EditorView, pos: number | null): SuggestRange | null {
  const s = reviewKey.getState(view.state);
  if (!s) return null;
  const run = pos == null ? null : s.groups.find((g) => pos >= g.from && pos <= g.to) ?? null;
  if (run?.from !== s.hover?.from || run?.to !== s.hover?.to) {
    view.dispatch(view.state.tr.setMeta(reviewKey, { hover: run }));
  }
  return run;
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

/** Rebuild the review decorations in place. The controls are built once per
 *  block and reused across keystrokes, so attribution that arrives AFTER the
 *  marks were painted (the turn fetch resolves later) needs this nudge to
 *  appear — nothing else in the plugin reacts to a change outside the doc. */
export function refreshSuggestionReview(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(reviewKey, { bumpAuthors: true }));
}

function suggestionReviewPlugin(
  onResolved?: SuggestionChangesOptions['onResolved'],
  resolveAuthor?: SuggestionChangesOptions['resolveAuthor'],
) {
  return new Plugin<ReviewState>({
    key: reviewKey,
    state: {
      init: (_config, instance) => ({
        authorsVersion: 0,
        ...composeReview(instance, buildReviewState(instance, onResolved, resolveAuthor), null, onResolved),
      }),
      apply: (tr, value, _oldState, newState) => {
        const meta = tr.getMeta(reviewKey) as
          | { bumpAuthors?: boolean; hover?: SuggestRange | null }
          | undefined;
        if (meta?.bumpAuthors) {
          const authorsVersion = value.authorsVersion + 1;
          return {
            authorsVersion,
            ...composeReview(
              newState,
              buildReviewState(newState, onResolved, resolveAuthor, authorsVersion),
              value.hover,
              onResolved,
            ),
          };
        }
        if (meta && 'hover' in meta) {
          // Pointer move: recompose over the cached base — no doc walk.
          return {
            authorsVersion: value.authorsVersion,
            ...composeReview(newState, { ...value, decorations: value.base }, meta.hover ?? null, onResolved),
          };
        }
        if (tr.docChanged) {
          // Plain typing in a suggestion-free doc: the rebuild below walks the
          // WHOLE doc, O(doc) per keystroke. A suggestion can only APPEAR
          // inside the edit, so with a provably empty state (nothing that
          // could go position-stale), probe just the changed blocks
          // (O(change)) and keep that empty state as-is.
          if (
            !value.hasSuggestions
            && value.base === DecorationSet.empty
            && value.groups.length === 0
            && value.blocks.length === 0
          ) {
            const span = changedBlockSpan(tr);
            if (span && suggestionIdsInRange(newState, span.from, span.to).length === 0) {
              return value;
            }
          }
          // Keep the hovered run valid across doc changes (a collaborator's
          // edit before it shifts positions): map it, then let composeReview
          // snap it onto a surviving run or drop it.
          const mapped = value.hover
            ? { from: tr.mapping.map(value.hover.from), to: tr.mapping.map(value.hover.to) }
            : null;
          return {
            authorsVersion: value.authorsVersion,
            ...composeReview(
              newState,
              buildReviewState(newState, onResolved, resolveAuthor, value.authorsVersion),
              mapped && mapped.from < mapped.to ? mapped : null,
              onResolved,
            ),
          };
        }
        // Selection / remote-cursor / awareness / IME tick: reuse the cached set
        // for free — this is what keeps a long single-file session from freezing.
        return value;
      },
    },
    view(editorView) {
      // The gutter control belongs to the LINE under the pointer, not to every
      // suggestion-bearing line at once (a fully-suggested document was a wall
      // of ✓/✕). Toggled as a plain class on the widget's DOM instead of through
      // plugin state: a rebuild per pointer move would re-walk the doc on every
      // pixel, and the class survives until the next move anyway.
      //
      // Resolved from posAtCoords, not from event.target: the controls live in
      // the editor's right padding lane, which is outside every block's box —
      // a target-based hit test would drop the hover the moment the pointer
      // left the text and the control would vanish before it could be clicked.
      let hoveredGutter: HTMLElement | null = null;
      const setGutterHover = (next: HTMLElement | null) => {
        if (hoveredGutter === next) return;
        hoveredGutter?.classList.remove('is-hovered');
        next?.classList.add('is-hovered');
        hoveredGutter = next;
      };
      // Where the content column ends, i.e. where the reserved gutter lane
      // starts. Cached: measuring it needs getBoundingClientRect +
      // getComputedStyle, and doing that per pointer pixel forces a style/layout
      // recalc on exactly the documents this plugin is careful not to stall.
      // Refreshed on view updates (typing, resize, file switch) — far rarer than
      // mousemove, and the lane only moves when the layout does.
      let contentRight = 0;
      const measureContentRight = () => {
        const box = editorView.dom.getBoundingClientRect();
        const padRight = parseFloat(getComputedStyle(editorView.dom).paddingRight) || 0;
        contentRight = box.right - padRight - 1;
      };
      const gutterOfPos = (pos: number): HTMLElement | null => {
        const dom = editorView.domAtPos(pos).node;
        let el: HTMLElement | null = dom.nodeType === 1 ? (dom as HTMLElement) : dom.parentElement;
        // Climb to the nearest ancestor that OWNS a control (the widget is a
        // direct child of its textblock) — never a query from the top, which
        // would hand every list item the first item's control. A children scan,
        // not querySelector: this runs per pointer move.
        for (; el && el !== editorView.dom; el = el.parentElement) {
          for (const child of el.children) {
            if (child.classList.contains('suggestion-gutter')) return child as HTMLElement;
          }
        }
        return null;
      };
      // Word-level pair: HIDE is delayed. The pair is an overlay dropped below
      // the hovered run, so travelling to it crosses ground that is over
      // neither the run nor the pair — without a grace period the buttons
      // would vanish before the click lands. Re-entering a mark or the pair
      // cancels the pending hide.
      let hideTimer: ReturnType<typeof setTimeout> | null = null;
      const clearHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
      const onMove = (event: MouseEvent) => {
        // Cached flag, no doc walk: nothing to reveal on a clean document.
        if (!reviewKey.getState(editorView.state)?.hasSuggestions) {
          setGutterHover(null);
          return;
        }
        const el = event.target as HTMLElement | null;
        // Hit test clamped into the content column: the gutter sits in the
        // editor's reserved right padding, outside every block's box, so the
        // raw position there resolves to nothing and the control would vanish
        // exactly as the pointer travelled to it.
        // Self-heal a measure taken before layout (or missed between updates):
        // an unmeasured lane would clamp every probe to the left edge.
        if (contentRight <= 0) measureContentRight();
        const at = editorView.posAtCoords({
          left: Math.min(event.clientX, contentRight),
          top: event.clientY,
        });
        setGutterHover(
          (el?.closest?.('.suggestion-gutter') as HTMLElement | null) ?? (at ? gutterOfPos(at.pos) : null),
        );
        // Word-level pair: over the pair itself → hold; over a suggestion mark
        // (the changed text, not just its line) → reveal that run's pair;
        // anywhere else → delayed hide.
        if (el?.closest?.('.suggestion-inline-review')) { clearHide(); return; }
        if (el?.closest?.('[data-suggestion]') && at) {
          clearHide();
          setSuggestionRunHover(editorView, at.pos);
        } else if (!hideTimer && reviewKey.getState(editorView.state)?.hover) {
          hideTimer = setTimeout(() => { hideTimer = null; setSuggestionRunHover(editorView, null); }, 320);
        }
      };
      const onLeave = () => {
        setGutterHover(null);
        clearHide();
        setSuggestionRunHover(editorView, null);
      };
      editorView.dom.addEventListener('mousemove', onMove);
      editorView.dom.addEventListener('mouseleave', onLeave);
      // A resize moves the lane without producing a transaction, so `sync`
      // never runs — re-measure here or the clamp lands mid-text afterwards.
      window.addEventListener('resize', measureContentRight);
      // Flag live suggestions so CSS reserves the review gutter on read-only
      // editors. The live editor reserves that gutter permanently
      // regardless of this class (see globals.css), so toggling it never reflows
      // the doc mid-typing. Reads the cached flag (no doc walk) so it's free on
      // every view update.
      const sync = () => {
        editorView.dom.classList.toggle('has-suggestions', reviewKey.getState(editorView.state)?.hasSuggestions ?? false);
        measureContentRight();
      };
      sync();
      return {
        update: sync,
        destroy() {
          editorView.dom.removeEventListener('mousemove', onMove);
          editorView.dom.removeEventListener('mouseleave', onLeave);
          window.removeEventListener('resize', measureContentRight);
          clearHide();
        },
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
      handleTextInput(view, from, to, text) {
        const id = insideDeletion(view.state, from);
        if (id != null) {
          const end = deletionRunEnd(view.state, from, id);
          const tr = view.state.tr.insertText(text, end);
          tr.setSelection(TextSelection.create(tr.doc, end + text.length));
          tr.setMeta(deletionGuardKey, { allow: true });
          view.dispatch(tr);
          return true;
        }
        // Caret at a struck run's boundary — its START is right where delete
        // leaves the caret: claim the keystroke and insert at the caret
        // ourselves. Left to the browser, Chrome's native insertion at the
        // boundary can get re-read as a change spanning into the strike and
        // ProseMirror reverts it — typed text silently vanished ("can't type
        // right after deleting").
        if (from === to && (deletionAt(view.state, from, 1) != null || deletionAt(view.state, from, -1) != null)) {
          const tr = view.state.tr.insertText(text, from);
          tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          tr.setMeta(deletionGuardKey, { allow: true });
          view.dispatch(tr);
          return true;
        }
        return false;
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
      : [
          suggestChanges(),
          // Read through `this.options` at call time, not captured: the editor
          // updates the option when attribution arrives (see refreshSuggestionReview).
          suggestionReviewPlugin(
            (ids, action) => this.options.onResolved?.(ids, action),
            (ids) => this.options.resolveAuthor?.(ids) ?? null,
          ),
          deletionGuardPlugin(),
        ];
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
          const changed = resolveSuggestionId(id, false, (outcome) => this.options.onCascade?.(outcome))(state, dispatch);
          if (changed && dispatch) this.options.onResolved?.([id], 'reject');
          return changed;
        },
    };
  },
});

export const SuggestionMarks = [SuggestionDocument, SuggestionNodeAttributes, InsertionMark, DeletionMark, ModificationMark, SuggestionChanges];
