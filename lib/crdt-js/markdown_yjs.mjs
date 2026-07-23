/**
 * Markdown <-> Yjs XmlFragment round-tripping for the workspace-local
 * Hocuspocus server running inside Modal.
 *
 * Parsing is delegated to the shared markdown parser in `lib/markdown/` so
 * the editor (HTML render) and this server (Yjs build) always agree on what
 * markdown means. Keep feature additions in the shared parser — this file
 * only adapts the resulting Block[] AST into Yjs XML tree and serializes
 * the Yjs tree back to markdown.
 */

import * as Y from 'yjs';
import { humanizeCalloutType, parseMarkdown } from '../../lib/markdown/parser.mjs';
import { imageMarkdown } from '../../lib/markdown/image-attrs.mjs';

export { Y };

// Canonical markdown = the fixed point of `markdown → Y.Doc → markdown`. A
// single round-trip isn't always idempotent: a few constructs re-serialize
// differently when parsed a second time (emphasis vs. literal underscores in a
// table cell; padding a table whose rows and header disagree on column count).
// A non-fixed-point form desyncs Hocuspocus on load (phantom diff → welcome.md
// duplication) and makes freshly cloned files read as "modified", so iterate
// until the output stops changing. Capped — input that never converges keeps
// its last form rather than looping forever. Shared by the codec CLI (mirror)
// and the sandbox sync client so both sides agree on "canonical".
export function canonicalizeMarkdown(markdown, maxPasses = 5) {
  let text = markdown ?? '';
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const doc = new Y.Doc();
    let next;
    try {
      replaceFromMarkdown(doc, text);
      next = serializeDoc(doc);
    } finally {
      doc.destroy();
    }
    if (next === text) return next;
    text = next;
  }
  return text;
}

// Yjs >=13.6.18 logs `warnPrematureAccess` ("Add Yjs type to a document before
// reading data.") whenever a not-yet-integrated type is read. This codec builds
// every block as a detached node tree before attaching it (each `.push` reads
// the detached parent's `.length`), so the warning is a guaranteed false
// positive here — and at ~1 line per block it floods CI and the Hocuspocus
// logs. `blockToY` is the single point all detached nodes are built through, so
// dropping just that one message around it suppresses the noise at the source
// for every caller (editor, snapshot import, sandbox, CLI, agent-edit). The
// build is synchronous, so nothing else runs on the event loop mid-build and no
// unrelated warn is lost.
function quietDetachedAccess(fn) {
  const original = console.warn;
  console.warn = (...args) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('Add Yjs type to a document before reading data')
    ) {
      return;
    }
    original(...args);
  };
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

// --------------------------------------------------------------
// markdown → Y.XmlFragment
// --------------------------------------------------------------

export function replaceFromMarkdown(document, markdown) {
  const fragment = document.getXmlFragment('default');
  const blocks = parseMarkdown(markdown);
  const children = blocks.map((b) => blockToY(b, true)).filter(Boolean);
  // Wrap the delete+insert in a single Y.Doc transaction so clients receive
  // one combined update instead of one per deleted block. Without this an
  // N-block doc produces N+1 broadcasts, which thrashes the network layer
  // and can interleave weirdly with just-reconnected clients.
  document.transact(() => {
    while (fragment.length > 0) fragment.delete(0, 1);
    if (children.length > 0) fragment.push(children);
  });
}

export function populateFromMarkdown(document, markdown) {
  replaceFromMarkdown(document, markdown);
}

// Reconcile a live Y.Doc to `markdown` with the *minimal* set of block-level
// Yjs ops, instead of the delete-all + reinsert that `replaceFromMarkdown`
// does. Blocks whose serialized content is unchanged keep their existing
// (clientID, clock) identity, with spacing attrs updated in place — so:
//   - concurrent edits to *other* blocks survive (no whole-doc clobber),
//   - re-applying identical markdown is a no-op (idempotent), and
//   - attribution stays attached to the blocks an author actually touched.
//
// The final fragment is structurally identical to what `replaceFromMarkdown`
// would produce (same children, same order, same attrs), so `serializeDoc` is
// byte-for-byte unchanged — only op identity differs. Returns true if it
// mutated the doc.
export function applyMarkdownDiff(document, markdown) {
  const fragment = document.getXmlFragment('default');
  const blocks = parseMarkdown(markdown);

  // Build the target blocks once in a scratch doc to read canonical keys.
  // (Inserts below rebuild fresh detached nodes via blockToY — integrated
  // nodes can't move between docs.)
  const newSourceBlocks = [];
  const scratch = new Y.Doc();
  try {
    const scratchFragment = scratch.getXmlFragment('default');
    const scratchNodes = [];
    for (const block of blocks) {
      const node = blockToY(block, true);
      if (!node) continue;
      newSourceBlocks.push(block);
      scratchNodes.push(node);
    }
    if (scratchNodes.length > 0) scratch.transact(() => scratchFragment.push(scratchNodes));

    const newKeys = scratchNodes.map((_, i) => nodeKey(scratchFragment.get(i)));
    const oldKeys = [];
    for (let i = 0; i < fragment.length; i += 1) oldKeys.push(nodeKey(fragment.get(i)));

    const matches = lcsMatches(oldKeys, newKeys);
    // Sentinel match past both ends flushes the trailing deletes/inserts.
    matches.push([fragment.length, newKeys.length]);

    let mutated = false;
    document.transact(() => {
      let oi = 0;
      let ni = 0;
      let cursor = 0;
      for (const [mo, mn] of matches) {
        while (oi < mo) {
          fragment.delete(cursor, 1); // removed block — cursor stays
          oi += 1;
          mutated = true;
        }
        while (ni < mn) {
          fragment.insert(cursor, [blockToY(newSourceBlocks[ni], true)]);
          cursor += 1;
          ni += 1;
          mutated = true;
        }
        if (mo < oldKeys.length) {
          if (syncBlockSpacingAttrs(fragment.get(cursor), scratchFragment.get(mn))) {
            mutated = true;
          }
          cursor += 1; // matched block kept in place — preserve its identity
          oi += 1;
          ni += 1;
        }
      }
    });
    return mutated;
  } finally {
    scratch.destroy();
  }
}

// ============================================================
// Suggestions-as-marks for AGENT edits. Instead of replacing text, a suggest-
// mode agent edit is applied as insertion/deletion MARKS in the Y.Doc: the
// changed region (old→new) is diffed word-level within a single changed text
// block (formatting preserved), block-level otherwise, and the differences are
// marked. content_text projects deletions out (the accepted view), so agents
// read the doc as if accepted — same model as the human path. Accept/reject
// resolve the marks. v1 rebuilds the fragment (loses block identity); a
// minimal-range variant is a follow-up.
// ============================================================
function addSuggestionMark(marks, markObj) {
  const filtered = (marks || []).filter((m) => m.type !== markObj.type);
  return [...filtered, markObj];
}

function markBlockInlineDeep(block, markObj) {
  const tag = (inline) =>
    (inline || []).map((n) => (n.type === 'text' ? { ...n, marks: addSuggestionMark(n.marks, markObj) } : n));
  const b = { ...block };
  if (b.inline) b.inline = tag(b.inline);
  if (b.children) b.children = b.children.map((c) => markBlockInlineDeep(c, markObj));
  if (b.items) b.items = b.items.map((item) => item.map((c) => markBlockInlineDeep(c, markObj)));
  if (b.header) b.header = b.header.map(tag);
  if (b.rows) b.rows = b.rows.map((row) => row.map(tag));
  return b;
}

// Inline math ($…$, $$…$$) is ONE atomic diff token — never split on the spaces
// inside it. Otherwise a partial edit ($A^2 + 1$ → $B^2 + 1$) scatters the `$`
// delimiters across separate deletion/insertion/plain text nodes, so no
// renderer can match `$…$` to draw KaTeX. Kept whole, a changed formula is a
// clean whole-token delete + insert (each side contiguous → renders). Mirrors
// the editor's math regex (Mathematics.configure in collab-editor.tsx).
const INLINE_MATH_TOKEN = /\$\$[^$\n]+?\$\$|(?<!\\)\$(?!\s)[^$\n]+?(?<!\s)\$(?!\d)/g;

function inlineToWordTokens(inline) {
  const tokens = [];
  for (const node of inline || []) {
    if (node.type === 'text') {
      const marks = node.marks || [];
      const pushWords = (str) => {
        for (const piece of str.split(/(\s+)/)) {
          if (piece.length) tokens.push({ key: piece, text: piece, marks });
        }
      };
      const re = new RegExp(INLINE_MATH_TOKEN.source, 'g');
      let last = 0;
      let m;
      while ((m = re.exec(node.text)) !== null) {
        pushWords(node.text.slice(last, m.index));
        tokens.push({ key: m[0], text: m[0], marks });
        last = m.index + m[0].length;
      }
      pushWords(node.text.slice(last));
    } else {
      tokens.push({ key: `\0${node.type}:${node.src ?? node.marker ?? ''}`, node, marks: [] });
    }
  }
  return tokens;
}

const suggestionKind = (node) => {
  const marks = (node && node.type === 'text' && node.marks) || [];
  if (marks.some((m) => m.type === 'deletion')) return 'del';
  if (marks.some((m) => m.type === 'insertion')) return 'ins';
  return null;
};

// Coalesce adjacent changed words into ONE red span + ONE green span. A word-LCS
// keeps the SPACE between two changed words as common, which interleaves the
// output (del w1 / ins x1 / " " / del w2 / ins x2). Wherever a shared
// whitespace-only token sits BETWEEN two changes, fold it into both sides so the
// whole old run strikes then the whole new run inserts ("w1 w2" red, "x1 x2"
// green). Boundary spaces (next to an UNCHANGED word) stay black, so a lone
// single-word change is untouched. Atoms (images, etc.) break a run.
function coalesceChangeRuns(out, id) {
  const del = { type: 'deletion', id };
  const ins = { type: 'insertion', id };
  const isWsShared = (node) =>
    node && node.type === 'text' && !suggestionKind(node) && /^\s+$/.test(node.text);
  const result = [];
  for (let i = 0; i < out.length; ) {
    // Extent of a run made only of changes + internal shared-whitespace bridges.
    let j = i;
    let hasChange = false;
    while (j < out.length && (suggestionKind(out[j]) || isWsShared(out[j]))) {
      if (suggestionKind(out[j])) hasChange = true;
      j += 1;
    }
    if (!hasChange) { result.push(out[i]); i += 1; continue; }
    // Trim leading/trailing shared-whitespace — those are boundary spaces.
    let s = i;
    let e = j - 1;
    while (s <= e && isWsShared(out[s])) { result.push(out[s]); s += 1; }
    const trailing = [];
    while (e >= s && isWsShared(out[e])) { trailing.unshift(out[e]); e -= 1; }
    // Regroup: every removed node first (old run), then every inserted node (new
    // run). Bridge whitespace joins both sides. Nodes are kept (not flattened) so
    // a changed word's own formatting (bold, link, …) survives; mergeAdjacentText
    // fuses the same-mark neighbours into one span afterward.
    const oldNodes = [];
    const newNodes = [];
    for (let k = s; k <= e; k += 1) {
      const node = out[k];
      const kind = suggestionKind(node);
      if (kind === 'del') oldNodes.push(node);
      else if (kind === 'ins') newNodes.push(node);
      else {
        oldNodes.push({ type: 'text', text: node.text, marks: addSuggestionMark(node.marks, del) });
        newNodes.push({ type: 'text', text: node.text, marks: addSuggestionMark(node.marks, ins) });
      }
    }
    for (const n of oldNodes) result.push(n);
    for (const n of newNodes) result.push(n);
    for (const t of trailing) result.push(t);
    i = j;
  }
  return result;
}

function sameMarkSet(a, b) {
  if ((a || []).length !== (b || []).length) return false;
  const k = (m) => `${m.type}:${m.id ?? m.href ?? m.target ?? ''}`;
  return (a || []).map(k).sort().join('|') === (b || []).map(k).sort().join('|');
}

function mergeAdjacentText(inline) {
  const out = [];
  for (const node of inline) {
    const last = out[out.length - 1];
    if (node.type === 'text' && last && last.type === 'text' && sameMarkSet(last.marks, node.marks)) {
      last.text += node.text;
    } else {
      out.push(node.type === 'text' ? { ...node } : node);
    }
  }
  return out;
}

// Word-level LCS of two text blocks' inline → one merged inline AST where
// removed words carry `deletion` and added words carry `insertion`.
function wordDiffInline(oldInline, newInline, id) {
  const a = inlineToWordTokens(oldInline);
  const b = inlineToWordTokens(newInline);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i].key === b[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const del = { type: 'deletion', id };
  const ins = { type: 'insertion', id };
  const out = [];
  const emit = (tok, extra) => {
    if (tok.node) out.push(tok.node);
    else out.push({ type: 'text', text: tok.text, marks: extra ? addSuggestionMark(tok.marks, extra) : tok.marks });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].key === b[j].key) { emit(b[j]); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { emit(a[i], del); i += 1; }
    else { emit(b[j], ins); j += 1; }
  }
  while (i < n) emit(a[i++], del);
  while (j < m) emit(b[j++], ins);
  return mergeAdjacentText(coalesceChangeRuns(out, id));
}

// Near-total-rewrite suppression (the #581/#590 `md-full-rewrite` rule). A
// word-LCS counts matching WHITESPACE as common, so two unrelated lines still
// interleave (`Found`→`We` `3`→`completely` …) — noise that reads worse than a
// clean whole-line replace. When a block's word-diff keeps almost no shared
// NON-whitespace text, report it so the caller falls to whole-block strike+
// insert instead. Guarded to blocks with enough text to judge so tiny edits
// aren't over-suppressed.
function isNearTotalRewrite(mergedInline) {
  let common = 0;
  let del = 0;
  let ins = 0;
  for (const node of mergedInline) {
    if (node.type !== 'text') continue;
    const len = node.text.replace(/\s+/g, '').length;
    if (!len) continue;
    const marks = node.marks || [];
    if (marks.some((mk) => mk.type === 'deletion')) del += len;
    else if (marks.some((mk) => mk.type === 'insertion')) ins += len;
    else common += len;
  }
  // Use the SMALLER side: a true rewrite replaces most of BOTH versions. This
  // excludes a pure append/prepend to a short line (one side stays ~all shared)
  // and a pure deletion — those keep their word-diff, only a genuine two-sided
  // rewrite degrades to a whole-line replace.
  const minSide = Math.min(common + del, common + ins);
  return minSide >= 12 && common < 0.2 * minSide;
}

function isTextBlock(block) {
  return block && (block.type === 'paragraph' || block.type === 'heading') && !(block.inline || []).some((n) => n.type !== 'text');
}

// A block whose content can carry suggestion marks (inline text containers).
// Code fences (raw `block.text`), horizontal rules, and single-image paragraphs
// have no inline text to mark — wrapping them would leave an unreviewable
// duplicate (both copies serialize, neither resolvable), so such regions apply
// directly instead. (Codex P1)
// An inline image anywhere in a block — including nested list items, blockquote/
// callout children, or table cells — makes it unmarkable: inlineToY emits images
// as an unmarked literal, so marking only the surrounding text strands/dupes the
// image on accept/reject. (Codex)
function blockHasImage(block) {
  if (!block) return false;
  if ((block.inline || []).some((n) => n.type === 'image')) return true;
  if (Array.isArray(block.children) && block.children.some(blockHasImage)) return true;
  if (Array.isArray(block.items) && block.items.some((item) => item.some(blockHasImage))) return true;
  const cells = [...(block.header || []), ...((block.rows || []).flat())];
  if (cells.some((inline) => (inline || []).some((n) => n.type === 'image'))) return true;
  return false;
}

// A list containing an EMPTY item (a blank `- ` bullet — real items since the
// empty-bullet parser fix). Empty items hold no text, so suggestion marks can't
// represent adding/striking them: marking is a silent no-op and resolution
// can't tell a rejected insert from a pre-existing blank (prune-vs-keep is
// undecidable). Such lists apply DIRECTLY, like images/code fences — the
// turn-level text-revert path (turnIsMixed) handles reject.
function listHasEmptyItem(block) {
  return (block.items || []).some((item) => (item || []).some((b) =>
    (b?.type === 'paragraph' && !(b.inline || []).length)
    || ((b?.type === 'bulletList' || b?.type === 'orderedList') && listHasEmptyItem(b))));
}

function isMarkable(block) {
  if (!block) return false;
  // codeBlock = raw text; horizontalRule = no text; callout = title is stored
  // separately (block.title, emitted as its own paragraph) and isn't reached by
  // markBlockInlineDeep, so a whole-callout suggestion would strand the title.
  // All apply directly. (Codex)
  if (block.type === 'codeBlock' || block.type === 'horizontalRule' || block.type === 'callout') return false;
  if (blockHasImage(block)) return false;
  if ((block.type === 'bulletList' || block.type === 'orderedList') && listHasEmptyItem(block)) return false;
  return true;
}

// Pair two same-type blocks and WORD-diff their content (recursing into
// blockquote/callout/list bodies) so an edit that preserves most of a block
// shows inline word changes, not a whole-block replace. Returns the merged block,
// or null when they can't be paired (different type/level, atoms, child-count
// mismatch, or a changed callout title) — the caller then falls to block-level.
function pairBlockDiff(o, n, id, topLevel = false) {
  if (!o || !n || o.type !== n.type) return null;
  switch (o.type) {
    case 'paragraph':
    case 'heading': {
      if (o.type === 'heading' && o.level !== n.level) return null;
      if (inlineHasAtoms(o.inline) || inlineHasAtoms(n.inline)) return null;
      const merged = wordDiffInline(o.inline, n.inline, id);
      // Near-total-rewrite suppression applies ONLY at the top level. Inside a
      // list/blockquote/callout (via pairChildrenDiff, which is all-or-nothing),
      // a null return would strike+reinsert the WHOLE container including its
      // unchanged siblings — the very regression we avoid. A rewritten child
      // keeps its word-diff; only a top-level block becomes a whole-line replace.
      if (topLevel && isNearTotalRewrite(merged)) return null;
      return { ...n, inline: merged };
    }
    case 'blockquote': {
      const kids = pairChildrenDiff(o.children, n.children, id);
      return kids ? { ...n, children: kids } : null;
    }
    case 'callout': {
      if ((o.title ?? '') !== (n.title ?? '')) return null; // title change → block-level
      const kids = pairChildrenDiff(o.children, n.children, id);
      return kids ? { ...n, children: kids } : null;
    }
    case 'bulletList':
    case 'orderedList': {
      const oItems = o.items || [];
      const nItems = n.items || [];
      // A list item containing an unmarkable block (code fence / image) can't be
      // item-marked — defer to the whole-block path (matches prior behavior).
      // A list holding an EMPTY item is wholly unmarkable (see listHasEmptyItem):
      // bail so emitPair's isMarkable check routes it to a direct apply.
      if (listHasEmptyItem(o) || listHasEmptyItem(n)) return null;
      if ([...oItems, ...nItems].some((it) => (it || []).some((b) => !isMarkable(b)))) return null;
      // Align items by content via LCS so adding/removing (or reordering) ONE item
      // marks only THAT item — struck old / inserted new — instead of striking and
      // reinserting the whole list (the list-churn bug). Index-paired items inside
      // an unmatched span word-diff in place; an item that can't pair degrades to a
      // whole-item strike+insert on its OWN. Mirrors buildSuggestionRegion.
      const del = { type: 'deletion', id };
      const ins = { type: 'insertion', id };
      const markItem = (item, m) => item.map((b) => markBlockInlineDeep(b, m));
      const itemKey = (item) => blockKeys(item).join('');
      const matches = lcsMatches(oItems.map(itemKey), nItems.map(itemKey));
      matches.push([oItems.length, nItems.length]);
      const items = [];
      let oi = 0;
      let ni = 0;
      const emitPair = (oItem, nItem) => {
        const paired = pairChildrenDiff(oItem, nItem, id);
        if (paired) { items.push(paired); return; }
        items.push(markItem(oItem, del), markItem(nItem, ins));
      };
      for (const [mo, mn] of matches) {
        const oRun = oItems.slice(oi, mo);
        const nRun = nItems.slice(ni, mn);
        const k = Math.min(oRun.length, nRun.length);
        for (let i = 0; i < k; i += 1) emitPair(oRun[i], nRun[i]);
        for (let i = k; i < oRun.length; i += 1) items.push(markItem(oRun[i], del)); // removed item
        for (let i = k; i < nRun.length; i += 1) items.push(markItem(nRun[i], ins)); // added item
        if (mo < oItems.length) { items.push(nItems[mn]); oi = mo + 1; ni = mn + 1; } // unchanged anchor
      }
      return { ...n, items };
    }
    case 'table': {
      // Word-diff the table IN PLACE, cell by cell, when the grid lines up — so
      // an edit marks only the changed cells instead of striking the whole old
      // table and inserting a whole new one (the "duplicated table" bug). Any
      // structural change (column/row added or removed) or a cell that isn't
      // word-diffable (image/atom) returns null → caller strikes+inserts whole.
      const oHeader = o.header || [];
      const nHeader = n.header || [];
      const oRows = o.rows || [];
      const nRows = n.rows || [];
      if (oHeader.length !== nHeader.length || oRows.length !== nRows.length) return null;
      if (!oRows.every((row, i) => (row || []).length === (nRows[i] || []).length)) return null;
      const diffCell = (oc, nc) =>
        inlineHasAtoms(oc) || inlineHasAtoms(nc) ? null : wordDiffInline(oc || [], nc || [], id);
      const header = [];
      for (let i = 0; i < oHeader.length; i += 1) {
        const c = diffCell(oHeader[i], nHeader[i]);
        if (!c) return null;
        header.push(c);
      }
      const rows = [];
      for (let i = 0; i < oRows.length; i += 1) {
        const row = [];
        for (let j = 0; j < oRows[i].length; j += 1) {
          const c = diffCell(oRows[i][j], nRows[i][j]);
          if (!c) return null;
          row.push(c);
        }
        rows.push(row);
      }
      return { ...n, header, rows };
    }
    default:
      return null; // codeBlock / horizontalRule / image → not word-diffable
  }
}

function pairChildrenDiff(oc, nc, id) {
  if (!Array.isArray(oc) || !Array.isArray(nc) || oc.length !== nc.length) return null;
  const out = [];
  for (let i = 0; i < oc.length; i += 1) {
    const m = pairBlockDiff(oc[i], nc[i], id);
    if (!m) return null;
    out.push(m);
  }
  return out;
}

function inlineHasAtoms(inline) {
  return (inline || []).some((n) => n.type !== 'text');
}

function buildSuggestionRegion(oldBlocks, newBlocks, id) {
  // Balance: when the changed region's blocks line up 1:1, word-diff each in
  // place (inline marks, most of the block preserved). Only fall to whole-block
  // strike+insert for a genuine wholesale change (block added/removed, type or
  // heading-level change, atom content, changed callout title).
  // Counts line up → align by index and resolve each block INDEPENDENTLY: a
  // block that pairs gets an inline word-diff; one that can't (changed callout
  // title, atom, count-mismatched children) degrades on its OWN — block-level if
  // markable, direct otherwise. One stubborn block must never drag the whole
  // region to a whole-doc strike+insert (the "everything red then everything
  // green" bug).
  const del = { type: 'deletion', id };
  const ins = { type: 'insertion', id };
  const out = [];
  const emitPair = (o, n) => {
    const m = pairBlockDiff(o, n, id, true); // top-level region block
    if (m) { out.push(m); return; }
    if (!isMarkable(o) || !isMarkable(n)) { out.push(n); return; } // can't mark → direct
    out.push(markBlockInlineDeep(o, del), markBlockInlineDeep(n, ins)); // whole-block
  };
  // Align blocks by TYPE via LCS so same-type blocks pair up and word-diff —
  // even when the agent RESTRUCTURED (block count/type shift, the common case
  // for a reword). Ordered rewords keep their per-type order, so paragraphs pair
  // with paragraphs (shared words preserved as untouched) and headings with
  // headings; only genuinely added/removed blocks strike/insert. Never a whole-
  // region "everything red then everything green" diff.
  const matches = lcsMatches(oldBlocks.map((b) => b.type), newBlocks.map((b) => b.type));
  matches.push([oldBlocks.length, newBlocks.length]);
  let oi = 0;
  let ni = 0;
  for (const [mo, mn] of matches) {
    const oldRun = oldBlocks.slice(oi, mo);
    const newRun = newBlocks.slice(ni, mn);
    const k = Math.min(oldRun.length, newRun.length);
    for (let i = 0; i < k; i += 1) emitPair(oldRun[i], newRun[i]); // type-misaligned span, pair by index
    for (let i = k; i < oldRun.length; i += 1) out.push(isMarkable(oldRun[i]) ? markBlockInlineDeep(oldRun[i], del) : oldRun[i]); // removed
    for (let i = k; i < newRun.length; i += 1) out.push(isMarkable(newRun[i]) ? markBlockInlineDeep(newRun[i], ins) : newRun[i]); // added
    if (mo < oldBlocks.length) { emitPair(oldBlocks[mo], newBlocks[mn]); oi = mo + 1; ni = mn + 1; } // the type-matched anchor
  }
  return out;
}

// Block identity keys. Detached Yjs nodes can't be read (serializeNode throws),
// so integrate into a scratch doc first — same pattern as applyMarkdownDiff.
function blockKeys(blocks) {
  const scratch = new Y.Doc();
  try {
    const f = scratch.getXmlFragment('default');
    const nodes = blocks.map((bl) => blockToY(bl, true)).filter(Boolean);
    if (nodes.length > 0) scratch.transact(() => f.push(nodes));
    const keys = [];
    for (let i = 0; i < f.length; i += 1) keys.push(nodeKey(f.get(i)));
    return keys;
  } finally {
    scratch.destroy();
  }
}

// Apply old→new as a marked suggestion. Unchanged prefix/suffix blocks pass
// through; the changed region is diffed and marked. Returns true if it mutated.
export function applyMarkdownSuggestion(document, oldText, newText, suggestionId) {
  if (oldText === newText) return false;
  // Blank-line-only diffs can't be encoded as inline marks — marking the empty
  // content projects right back to oldText, so the suggestion would "apply" yet
  // change nothing visible. Normalize blank-line runs; if the markable content is
  // identical it's a spacing-only no-op — report it honestly. (Codex P2)
  const normalizeBlanks = (t) => t.replace(/\n{2,}/g, '\n\n');
  if (normalizeBlanks(oldText) === normalizeBlanks(newText)) return false;
  const fragment = document.getXmlFragment('default');
  const oldBlocks = parseMarkdown(oldText);
  const newBlocks = parseMarkdown(newText);
  const id = suggestionId || `a${Math.floor(Math.random() * 1e9)}`;
  const oldKeys = blockKeys(oldBlocks);
  const newKeys = blockKeys(newBlocks);
  let p = 0;
  while (p < oldKeys.length && p < newKeys.length && oldKeys[p] === newKeys[p]) p += 1;
  let s = 0;
  while (s < oldKeys.length - p && s < newKeys.length - p && oldKeys[oldKeys.length - 1 - s] === newKeys[newKeys.length - 1 - s]) s += 1;
  // No changed blocks (prefix/suffix consumed everything) but the text differs →
  // a spacing-only edit (blank lines): nodeKey ignores blankBefore/trailingNewlines.
  // Blank lines aren't markable; report an honest no-op rather than mutating
  // nothing while returning true (the "applied but disappeared" bug). (Codex P2)
  if (p >= oldBlocks.length - s && p >= newBlocks.length - s) {
    return false;
  }
  const region = buildSuggestionRegion(oldBlocks.slice(p, oldBlocks.length - s), newBlocks.slice(p, newBlocks.length - s), id);
  const regionNodes = region.map((bl) => blockToY(bl, true)).filter(Boolean);

  // Preserve OTHER pending suggestions: if the live fragment's blocks line up
  // with the parsed accepted view, replace ONLY the changed region in place and
  // leave the prefix/suffix nodes (and their existing insertion/deletion marks)
  // untouched. Otherwise (empty-paragraph nodes serializeDoc skips, or a whole
  // block already struck-out so the projection has fewer blocks) fall back to a
  // full rebuild. (Codex P1)
  const fragKeys = [];
  for (let i = 0; i < fragment.length; i += 1) fragKeys.push(nodeKey(fragment.get(i)));
  const aligned = fragKeys.length === oldKeys.length && fragKeys.every((k, i) => k === oldKeys[i]);

  document.transact(() => {
    if (aligned) {
      const end = fragment.length - s;
      for (let k = end - 1; k >= p; k -= 1) fragment.delete(k, 1);
      if (regionNodes.length) fragment.insert(p, regionNodes);
    } else {
      const nodes = [...oldBlocks.slice(0, p), ...region, ...oldBlocks.slice(oldBlocks.length - s)]
        .map((bl) => blockToY(bl, true))
        .filter(Boolean);
      fragment.delete(0, fragment.length);
      fragment.insert(0, nodes);
    }
    document.getMap(MARKDOWN_PROJECTION_ROOT).set(String(id), newlineBoundaries(newText));
  });
  return true;
}

// Shell types: containers that hold nothing once their text is gone. Anything
// NOT listed (image, hr, codeBlock, future node types) survives a resolution
// that empties the text around it, so its container must too.
const SHELL_NODES = new Set(['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList', 'blockquote', 'hardBreak', 'table', 'tableRow', 'tableCell', 'tableHeader']);
const NODE_INSERTION_ID = 'suggestionInsertionId';
const NODE_DELETION_ID = 'suggestionDeletionId';
const NODE_MODIFICATIONS = 'suggestionModifications';
const NODE_REQUIRED_SHELL = 'suggestionRequiredShell';
const STRUCTURAL_DROP_CONTAINERS = new Set(['listItem', 'bulletList', 'orderedList', 'blockquote']);
const MARKDOWN_PROJECTION_ROOT = 'markdownsuggestions_projection';

function newlineBoundaries(text) {
  return {
    leading: text.match(/^\n*/)?.[0].length ?? 0,
    trailing: text.match(/\n*$/)?.[0].length ?? 0,
  };
}

function structuralModifications(node, id) {
  if (!node || typeof node.getAttribute !== 'function') return [];
  const value = node.getAttribute(NODE_MODIFICATIONS);
  if (!Array.isArray(value)) return [];
  return value.filter((mod) => mod && typeof mod === 'object' && mod.id != null && (id === undefined || mod.id === id));
}

function structuralSuggestion(node, id) {
  if (!node || typeof node.getAttribute !== 'function') return null;
  const insertion = node.getAttribute(NODE_INSERTION_ID);
  if (insertion != null && (id === undefined || insertion === id)) return { kind: 'insertion', id: insertion };
  const deletion = node.getAttribute(NODE_DELETION_ID);
  if (deletion != null && (id === undefined || deletion === id)) return { kind: 'deletion', id: deletion };
  return null;
}

function hasLiveSuggestion(node) {
  if (structuralSuggestion(node) || structuralModifications(node).length) return true;
  if (node instanceof Y.XmlText) {
    return node.toDelta().some((op) => op.attributes?.insertion || op.attributes?.deletion || op.attributes?.modification);
  }
  if (node && typeof node.get === 'function' && node.length != null) {
    for (let i = 0; i < node.length; i += 1) if (hasLiveSuggestion(node.get(i))) return true;
  }
  return false;
}

function isStructurallyDeleted(node) {
  return structuralSuggestion(node)?.kind === 'deletion';
}

function deletionSuggestionIds(node, ids = new Set()) {
  const structural = structuralSuggestion(node);
  if (structural?.kind === 'deletion') ids.add(structural.id);
  if (node instanceof Y.XmlText) {
    for (const op of node.toDelta()) if (op.attributes?.deletion?.id != null) ids.add(op.attributes.deletion.id);
  } else if (node && typeof node.get === 'function' && node.length != null) {
    for (let i = 0; i < node.length; i += 1) deletionSuggestionIds(node.get(i), ids);
  }
  return ids;
}

function projectionBoundary(document, node, boundary) {
  const projections = document.getMap(MARKDOWN_PROJECTION_ROOT);
  for (const id of deletionSuggestionIds(node)) {
    const value = projections.get(String(id));
    if (value && typeof value === 'object' && Number.isFinite(value[boundary])) return Math.max(0, value[boundary]);
  }
  return null;
}

function projectsAsDeletedBlock(node) {
  if (isStructurallyDeleted(node) || blockIsFullyDeleted(node)) return true;
  return Boolean(node && STRUCTURAL_DROP_CONTAINERS.has(node.nodeName) && node.length > 0
    && Array.from({ length: node.length }, (_, index) => node.get(index)).every(projectsAsDeletedBlock));
}

function structuralDropTarget(node) {
  let current = node;
  let parent = current?.parent;
  // Table cells and list items require a leading block/paragraph. Preserve that
  // shell when sibling content survives and let the inline resolver empty it.
  if ((parent?.nodeName === 'tableCell' || parent?.nodeName === 'tableHeader') && parent.length === 1) return null;
  if (parent?.nodeName === 'listItem' && parent.length > 1 && parent.get(0) === node && node?.nodeName === 'paragraph') return null;
  while (parent && STRUCTURAL_DROP_CONTAINERS.has(parent.nodeName) && parent.length === 1) {
    current = parent;
    parent = current.parent;
  }
  return current;
}

function replaceXmlElementType(node, nodeName) {
  const parent = node?.parent;
  if (!parent || typeof parent.get !== 'function' || parent.length == null) return node;
  const replacement = new Y.XmlElement(nodeName);
  for (const [key, value] of Object.entries(node.getAttributes())) replacement.setAttribute(key, value);
  const children = Array.from({ length: node.length }, (_, index) => node.get(index).clone());
  if (children.length) replacement.insert(0, children);
  for (let i = 0; i < parent.length; i += 1) {
    if (parent.get(i) !== node) continue;
    parent.delete(i, 1);
    parent.insert(i, [replacement]);
    return replacement;
  }
  return node;
}

export const MARKDOWN_RESOLVED_ROOT = 'markdownsuggestions_resolved';

export function markdownSuggestionResolution(document, id) {
  const value = document.getMap(MARKDOWN_RESOLVED_ROOT).get(String(id));
  return value === 'accept' || value === 'reject' || value === 'mixed' ? value : null;
}

export function recordMarkdownSuggestionResolution(document, ids, action) {
  document.transact(() => {
    const resolved = document.getMap(MARKDOWN_RESOLVED_ROOT);
    for (const id of ids) {
      const key = String(id);
      const previous = resolved.get(key);
      resolved.set(key, previous === 'mixed' || (previous && previous !== action) ? 'mixed' : action);
    }
  });
}

// True when the node is an empty shell — no text anywhere under it and nothing
// non-shell that survives resolution — i.e. safe to delete.
function blockIsTextless(node) {
  if (node instanceof Y.XmlText) {
    for (const op of node.toDelta()) if (typeof op.insert === 'string' && op.insert.length) return false;
    return true;
  }
  if (node && typeof node.get === 'function' && node.length != null) {
    if (!SHELL_NODES.has(node.nodeName)) return false;
    for (let i = 0; i < node.length; i += 1) if (!blockIsTextless(node.get(i))) return false;
  }
  return true;
}

// Resolve a suggestion (accept/reject) by id, at the Yjs level, so any surface
// (editor, chat card, review panel) converges on ONE source of truth — the
// marks. Accept: deletion-marked text is removed, insertion/modification marks
// are cleared (text kept). Reject: insertion-marked text is removed, deletion
// marks are cleared (text restored). Mirrors the library's ProseMirror commands
// but operates on the Y.Doc directly (no editor view). Returns true if mutated.
export function resolveSuggestion(document, id, action) {
  const accept = action === 'accept';
  const acceptedProjection = accept ? serializeDoc(document) : null;
  const fragment = document.getXmlFragment('default');
  let changed = false;
  // Returns true if it removed any text from this Y.XmlText (so the owning block
  // may now be empty and removable).
  const visitText = (node) => {
    const ops = [];
    let offset = 0;
    for (const op of node.toDelta()) {
      if (typeof op.insert !== 'string') { offset += 1; continue; }
      const len = op.insert.length;
      const attrs = op.attributes || {};
      const isIns = attrs.insertion && attrs.insertion.id === id;
      const isDel = attrs.deletion && attrs.deletion.id === id;
      if (isIns || isDel) {
        const remove = (accept && isDel) || (!accept && isIns);
        ops.push({ offset, len, remove, mark: isIns ? 'insertion' : 'deletion' });
      } else if (attrs.modification && attrs.modification.id === id) {
        // A formatting/attribute suggestion: the text stays either way. Accept
        // keeps the suggested formatting; reject restores the previous value
        // the mark recorded (when it names one). Either way the mark must
        // clear, or the id stays "live" forever and Keep/Undo zombies on it.
        ops.push({ offset, len, remove: false, mark: 'modification', mod: attrs.modification });
      }
      offset += len;
    }
    let removedText = false;
    for (const o of ops.reverse()) {
      if (o.remove) { node.delete(o.offset, o.len); removedText = true; }
      else if (o.mark === 'modification') {
        const revert =
          !accept && typeof o.mod?.attrName === 'string' && o.mod.attrName
            ? { [o.mod.attrName]: o.mod.previousValue ?? null }
            : {};
        node.format(o.offset, o.len, { modification: null, ...revert });
      } else node.format(o.offset, o.len, { [o.mark]: null });
      changed = true;
    }
    return removedText;
  };
  // List items THIS resolution emptied. Pruned even when their list survives
  // (a rejected item added to an existing list must take its bullet with it) —
  // but only when nothing non-shell remains inside (an image or code fence
  // survives resolution, so its item must too), and only when the removal hit
  // the item's OWN content: an empty parent bullet whose suggested NESTED
  // child was rejected pre-existed the suggestion and must stay.
  const emptiedItems = [];
  const structuralDrops = [];
  const structuralModificationReplacements = [];
  const visit = (node) => {
    if (node instanceof Y.XmlText) return visitText(node);
    const structural = structuralSuggestion(node, id);
    if (structural) {
      const remove = (accept && structural.kind === 'deletion') || (!accept && structural.kind === 'insertion');
      if (remove) {
        const target = structuralDropTarget(node);
        if (target) {
          structuralDrops.push(target);
          return true;
        }
        // Required table-cell/list-item paragraph: keep the node shell but drop
        // all of the structurally suggested content it represents.
        node.removeAttribute(structural.kind === 'insertion' ? NODE_INSERTION_ID : NODE_DELETION_ID);
        if (node?.nodeName === 'paragraph') {
          if (node.length > 0) node.delete(0, node.length);
          if (node.parent?.nodeName === 'listItem') node.setAttribute(NODE_REQUIRED_SHELL, true);
        }
        changed = true;
        return true;
      } else {
        node.removeAttribute(structural.kind === 'insertion' ? NODE_INSERTION_ID : NODE_DELETION_ID);
        changed = true;
      }
    }
    const modifications = structuralModifications(node, id);
    if (modifications.length) {
      const all = structuralModifications(node);
      const selected = new Set(modifications.map((mod) => JSON.stringify(mod)));
      const remaining = all.filter((mod) => !selected.has(JSON.stringify(mod)));
      if (remaining.length) node.setAttribute(NODE_MODIFICATIONS, remaining);
      else node.removeAttribute(NODE_MODIFICATIONS);
      if (!accept) {
        for (const mod of modifications.filter((item) => item.type === 'attr').reverse()) {
          if (typeof mod.attrName === 'string') node.setAttribute(mod.attrName, mod.previousValue ?? null);
        }
        const typeChange = modifications.filter((item) => item.type === 'nodeType').at(-1);
        if (typeof typeChange?.previousValue === 'string') {
          structuralModificationReplacements.push({ node, nodeName: typeChange.previousValue });
        }
      }
      changed = true;
    }
    let removed = false;
    let removedOwn = false;
    if (node && typeof node.get === 'function' && node.length != null) {
      for (let i = 0; i < node.length; i += 1) {
        const child = node.get(i);
        const r = visit(child);
        removed = r || removed;
        if (r && child?.nodeName !== 'bulletList' && child?.nodeName !== 'orderedList') removedOwn = true;
      }
    }
    if (removedOwn && node?.nodeName === 'listItem' && blockIsTextless(node)) emptiedItems.push(node);
    return removed;
  };
  // Detach `node` from its parent; an emptied-out list follows its last item.
  const removeNode = (node) => {
    const parent = node?.parent;
    if (!parent || typeof parent.get !== 'function' || parent.length == null) return;
    for (let i = 0; i < parent.length; i += 1) {
      if (parent.get(i) === node) {
        parent.delete(i, 1);
        changed = true;
        if (parent === fragment && parent.length === 0) {
          const shell = new Y.XmlElement('paragraph');
          shell.setAttribute('trailingNewlines', '0');
          parent.insert(0, [shell]);
        }
        break;
      }
    }
    if ((parent.nodeName === 'bulletList' || parent.nodeName === 'orderedList') && parent.length === 0) {
      removeNode(parent);
    }
  };
  document.transact(() => {
    const emptied = [];
    for (let i = 0; i < fragment.length; i += 1) {
      if (visit(fragment.get(i))) emptied.push(fragment.get(i));
    }
    // Structural suggestions are the only representation available for atomic
    // and empty nodes. Resolve them before text-shell cleanup so headless
    // review (chat cards/API) matches the editor's node-attribute commands.
    for (const node of structuralDrops.reverse()) removeNode(node);
    for (const replacement of structuralModificationReplacements.reverse()) {
      replaceXmlElementType(replacement.node, replacement.nodeName);
    }
    for (const item of emptiedItems) removeNode(item);
    const requiredShellItems = [];
    const collectRequiredShellItems = (node) => {
      if (node?.nodeName === 'listItem' && node.get(0)?.getAttribute?.(NODE_REQUIRED_SHELL)) requiredShellItems.push(node);
      if (node && typeof node.get === 'function' && node.length != null) {
        for (let i = 0; i < node.length; i += 1) collectRequiredShellItems(node.get(i));
      }
    };
    collectRequiredShellItems(fragment);
    for (const item of requiredShellItems.reverse()) {
      const shell = item.get(0);
      if (!shell || !blockIsTextless(shell)) {
        shell?.removeAttribute?.(NODE_REQUIRED_SHELL);
        continue;
      }
      const siblings = Array.from({ length: Math.max(0, item.length - 1) }, (_, index) => item.get(index + 1));
      const surviving = siblings.some((child) => !projectsAsDeletedBlock(child));
      const pending = siblings.some(hasLiveSuggestion);
      if (siblings.length === 0 || (!surviving && !pending)) removeNode(item);
      else if (surviving && !pending) shell.removeAttribute(NODE_REQUIRED_SHELL);
    }
    // Drop blocks THIS resolution emptied (e.g. a rejected/accepted whole-block
    // add/delete). Covers headings/lists/blockquotes/tables too, not just
    // paragraphs — otherwise an empty `# `, `- `, or bare table is left behind.
    // (Codex P2) Void blocks (HR/image/codeBlock) never carry inline marks, so
    // they're not in `emptied`. Pre-existing blank paragraphs aren't either.
    // (`emptied` holds node references: the item pruning above may have shifted
    // fragment indexes, and removeNode no-ops on already-detached nodes.)
    // Lists are excluded here: a fully-rejected list already vanished via the
    // item pruning + removeNode recursion above, so a textless list that STILL
    // has items is holding pre-existing empty bullets (or void-bearing items)
    // — user content, keep it. blockIsTextless (not blockHasText) so a block
    // left holding an image / code fence survives too.
    const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'table']);
    for (const node of emptied) {
      if (node && TEXT_BLOCKS.has(node.nodeName) && blockIsTextless(node) && node.parent === fragment) {
        removeNode(node);
      }
    }
    if (acceptedProjection != null) {
      const boundaries = newlineBoundaries(acceptedProjection);
      for (let i = 0; i < fragment.length; i += 1) {
        const node = fragment.get(i);
        if (isEmptyParagraphNode(node)) continue;
        node?.setAttribute?.('blankBefore', String(boundaries.leading));
        break;
      }
      if (fragment.length > 0) {
        fragment.get(fragment.length - 1)?.setAttribute?.('trailingNewlines', String(boundaries.trailing));
      }
    }
    document.getMap(MARKDOWN_PROJECTION_ROOT).delete(String(id));
  });
  if (changed) recordMarkdownSuggestionResolution(document, [id], action);
  return changed;
}

// Stable identity key for a block's serialized content. Spacing attributes are
// synchronized onto matched nodes so blank-line-only changes don't churn block
// identity.
function nodeKey(node) {
  // Prefix with the node tag (NUL-separated `\0`, a byte that can't occur in a
  // tag name or serialized markdown) so two blocks that serialize to the same
  // markdown but have different shapes don't get LCS-matched. The case that
  // matters: a legacy `paragraph` holding literal `![alt](src)` text vs the new
  // atom `image` node both serialize to `![alt](src)` — without the tag the diff
  // would keep the old paragraph instead of upgrading it to the image node.
  // Keys serialize with spacing DEFAULTS (keySerialize) so nested blankBefore
  // attrs — like the top-level ones this comment's invariant always ignored —
  // never churn block identity on a blank-line-only change.
  keySerialize = true;
  try {
    return `${node?.nodeName ?? ''}\0${serializeNode(node, 0)}`;
  } finally {
    keySerialize = false;
  }
}

function syncBlockSpacingAttrs(target, source) {
  let changed = false;
  for (const attr of ['blankBefore', 'trailingNewlines']) {
    const current = target?.getAttribute?.(attr);
    const next = source?.getAttribute?.(attr);
    if (next == null) {
      if (current != null) {
        target.removeAttribute(attr);
        changed = true;
      }
    } else if (current !== next) {
      target.setAttribute(attr, next);
      changed = true;
    }
  }
  // Recurse into element children: nested blocks carry their own blankBefore
  // (a callout body's paragraph gap, a loose list item), and block identity
  // keys are spacing-blind — so a direct edit that ONLY changes nested spacing
  // matches the existing block and must have its nested attrs synced in place,
  // or the edit is silently dropped. Matched keys imply identical structure,
  // so a pairwise child walk is safe; min() guards a pathological mismatch.
  const walkable = (n) => n && typeof n.get === 'function' && n.length != null;
  if (walkable(target) && walkable(source)) {
    const len = Math.min(target.length, source.length);
    for (let i = 0; i < len; i += 1) {
      if (syncBlockSpacingAttrs(target.get(i), source.get(i))) changed = true;
    }
  }
  return changed;
}

// Longest common subsequence over two key arrays → matched [oldIdx, newIdx]
// pairs in increasing order. Block counts are small (tens–hundreds), so the
// O(n·m) table is fine.
function lcsMatches(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function blockToY(block, topLevel = false) {
  return quietDetachedAccess(() => buildBlock(block, topLevel));
}

function buildBlock(block, topLevel) {
  const el = blockToYInner(block, topLevel);
  if (!el) return el;
  // `blankBefore` = blank lines above this block in the source markdown.
  //   - On the first block: leading newlines before any content (value 1 means
  //     one leading `\n`, distinct from the no-leading default — so we must
  //     store the attribute for every non-undefined value, not just > 1).
  //   - On subsequent blocks: blank lines between previous block and this one.
  if (typeof block.blankBefore === 'number' && block.blankBefore >= 0) {
    el.setAttribute('blankBefore', String(block.blankBefore));
  }
  // `trailingNewlines` = newlines after this block's content. Only set on the
  // last block of the doc; serialized verbatim back to the file end.
  if (typeof block.trailingNewlines === 'number' && block.trailingNewlines > 0) {
    el.setAttribute('trailingNewlines', String(block.trailingNewlines));
  }
  return el;
}

function blockToYInner(block, topLevel = false) {
  switch (block.type) {
    case 'heading': {
      const el = new Y.XmlElement('heading');
      // Number, not String(...): y-prosemirror copies this attr verbatim into
      // the Tiptap heading node, whose `level` is numeric — a string "2" fails
      // the toolbar's strict isActive('heading', { level: 2 }) check.
      el.setAttribute('level', block.level);
      // inlineToY returns an ARRAY (text runs + hardBreak nodes); spread it.
      el.insert(0, inlineToY(block.inline));
      return el;
    }
    case 'paragraph': {
      // A *top-level* paragraph that is exactly one image → a block `image`
      // node, which the @tiptap Image extension renders natively (Google-Docs
      // style). It's a leaf; serializeNode turns it back into `![alt](src)`.
      // Mixed text+image paragraphs keep the image as literal markdown text
      // (see inlineToY). Nested paragraphs (list items, blockquotes) are NOT
      // converted: a `listItem` schema requires a leading `paragraph`, so a bare
      // image child would be invalid ProseMirror — they keep the literal form.
      if (topLevel && block.inline.length === 1 && block.inline[0].type === 'image') {
        const img = block.inline[0];
        const el = new Y.XmlElement('image');
        el.setAttribute('src', img.src);
        el.setAttribute('alt', img.alt || '');
        if (img.width) el.setAttribute('width', String(img.width));
        // Alignment rides on the same `textAlign` attr the TextAlign extension
        // uses, so the editor + schema pick it up with no extra wiring.
        if (img.align) el.setAttribute('textAlign', img.align);
        return el;
      }
      const el = new Y.XmlElement('paragraph');
      el.insert(0, inlineToY(block.inline));
      return el;
    }
    case 'codeBlock': {
      const el = new Y.XmlElement('codeBlock');
      if (block.language) el.setAttribute('language', block.language);
      if (block.text) el.insert(0, [new Y.XmlText(block.text)]);
      return el;
    }
    case 'horizontalRule':
      return new Y.XmlElement('horizontalRule');
    case 'blockquote': {
      const el = new Y.XmlElement('blockquote');
      const children = block.children.map(blockToY).filter(Boolean);
      if (children.length > 0) el.push(children);
      return el;
    }
    case 'callout': {
      const el = new Y.XmlElement('blockquote');
      // Use the ProseMirror attribute names (ObsidianBlockquote schema), not the
      // `data-*` HTML form — y-prosemirror reads Y.XmlElement attrs by PM name,
      // so the editor only sees the callout if it's stored as `calloutType`.
      el.setAttribute('calloutType', block.calloutType);
      if (block.foldable) el.setAttribute('calloutFoldable', 'true');
      if (block.collapsed) el.setAttribute('calloutCollapsed', 'true');
      if (block.titleExplicit) el.setAttribute('calloutTitleExplicit', 'true');
      const titlePara = new Y.XmlElement('paragraph');
      titlePara.insert(0, [new Y.XmlText(block.title)]);
      const body = block.children.map(blockToY).filter(Boolean);
      el.push([titlePara, ...body]);
      return el;
    }
    case 'bulletList':
    case 'orderedList': {
      const el = new Y.XmlElement(block.type);
      if (block.type === 'orderedList' && block.start !== 1) {
        el.setAttribute('start', String(block.start));
      }
      for (const itemChildren of block.items) {
        const li = new Y.XmlElement('listItem');
        const childNodes = itemChildren.map(blockToY).filter(Boolean);
        if (childNodes.length > 0) li.push(childNodes);
        el.push([li]);
      }
      return el;
    }
    case 'table': {
      const el = new Y.XmlElement('table');
      const headerRow = new Y.XmlElement('tableRow');
      for (const cellInline of block.header) {
        headerRow.push([cellToY('tableHeader', cellInline)]);
      }
      el.push([headerRow]);
      for (const row of block.rows) {
        const tr = new Y.XmlElement('tableRow');
        for (const cellInline of row) {
          tr.push([cellToY('tableCell', cellInline)]);
        }
        el.push([tr]);
      }
      return el;
    }
    default:
      return null;
  }
}

function cellToY(tag, inline) {
  const cell = new Y.XmlElement(tag);
  const p = new Y.XmlElement('paragraph');
  p.insert(0, inlineToY(inline));
  cell.push([p]);
  return cell;
}

// Returns an ARRAY of inline Y nodes: Y.XmlText runs interleaved with
// `hardBreak` Y.XmlElement nodes — the schema-conformant shape ProseMirror /
// y-prosemirror expect (a '\n'-in-text + custom mark is NOT in the schema and
// makes y-prosemirror throw). Callers spread this into the block element.
function inlineToY(inline) {
  const nodes = [];
  let run = new Y.XmlText();
  let offset = 0;
  const flushRun = () => {
    if (offset > 0) {
      nodes.push(run);
      run = new Y.XmlText();
      offset = 0;
    }
  };
  for (const node of inline) {
    if (node.type === 'text') {
      run.insert(offset, node.text, marksToAttrs(node.marks));
      offset += node.text.length;
    } else if (node.type === 'image') {
      // Literal markdown so the src survives — codec.ts leaves images as plain
      // text and the markdownImage extension overlays the preview at render
      // time. marksToAttrs([]) terminates any preceding mark run.
      const literal = imageMarkdown(node.alt, node.src, { width: node.width, align: node.align });
      run.insert(offset, literal, marksToAttrs([]));
      offset += literal.length;
    } else if (node.type === 'hardBreak') {
      // A real hardBreak node, with the original marker (`  ` / `\`, or absent
      // for a soft break) on an attribute so serializeDoc round-trips it byte
      // for byte.
      flushRun();
      const br = new Y.XmlElement('hardBreak');
      if (node.marker) br.setAttribute('marker', node.marker);
      nodes.push(br);
    }
  }
  flushRun();
  if (nodes.length === 0) nodes.push(new Y.XmlText());
  return nodes;
}

// Yjs merges adjacent inserts whose attrs don't explicitly differ. To end a
// mark the previous run carried, set it to null on the next run — without
// this, "bold" followed by plain text collapses into one bold span.
function marksToAttrs(marks) {
  const attrs = {
    bold: null,
    italic: null,
    code: null,
    strike: null,
    highlight: null,
    link: null,
    // Suggestion marks (agent suggest-mode edits). Stored as `{ id }` so
    // y-prosemirror maps them to the editor's insertion/deletion marks; reset
    // to null (like the others) so an unmarked run ends the suggestion span.
    insertion: null,
    deletion: null,
  };
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold': attrs.bold = true; break;
      case 'italic': attrs.italic = true; break;
      case 'code': attrs.code = true; break;
      case 'strike': attrs.strike = true; break;
      case 'highlight': attrs.highlight = true; break;
      case 'insertion': attrs.insertion = { id: mark.id }; break;
      case 'deletion': attrs.deletion = { id: mark.id }; break;
      case 'link':
        attrs.link = { href: mark.href };
        break;
      case 'wikilink':
        attrs.link = {
          href: '#',
          obsidianType: 'wiki',
          obsidianTarget: mark.target,
          obsidianAlias: mark.alias || null,
          obsidianEmbed: mark.embed,
        };
        break;
    }
  }
  return attrs;
}

// --------------------------------------------------------------
// Y.XmlFragment → markdown
// --------------------------------------------------------------

// True if a block has pending-deletion text but no surviving (non-deletion)
// text — the whole block is a pending deletion and projects to nothing.
function blockIsFullyDeleted(node) {
  if (isStructurallyDeleted(node)) return true;
  let hasDeletion = false;
  let hasSurviving = false;
  const visit = (n) => {
    if (n instanceof Y.XmlText) {
      for (const op of n.toDelta()) {
        if (typeof op.insert !== 'string' || !op.insert.length) continue;
        if (op.attributes && op.attributes.deletion) hasDeletion = true;
        else hasSurviving = true;
      }
      return;
    }
    if (n && typeof n.get === 'function' && n.length != null) {
      for (let k = 0; k < n.length; k += 1) visit(n.get(k));
    }
  };
  visit(node);
  return hasDeletion && !hasSurviving;
}

export function serializeDoc(document) {
  const fragment = document.getXmlFragment('default');
  let out = '';
  let first = true;
  let pendingEmpties = 0;
  let skippedLeadingSpacing = null;
  let lastProjectedBlockSkipped = false;
  let lastSkippedTrailingSpacing = null;
  for (let i = 0; i < fragment.length; i += 1) {
    const node = fragment.get(i);
    // A block whose entire content is a pending DELETION projects to nothing in
    // the optimistic (accepted) view — skip the whole block so we don't emit a
    // bare `# ` / `> ` / `## ` marker for it, NOR count it as a blank-line
    // spacer. This must run BEFORE the empty-paragraph check: a fully-struck
    // paragraph serializes to '' and would otherwise be treated as spacing,
    // leaking phantom newlines when a suggestion deletes the whole file or the
    // last paragraph.
    if (blockIsFullyDeleted(node)) {
      if (first && skippedLeadingSpacing == null) {
        const raw = node?.getAttribute?.('blankBefore');
        skippedLeadingSpacing = projectionBoundary(document, node, 'leading')
          ?? (raw == null ? 2 * pendingEmpties : Math.max(0, Number(raw) || 0));
      }
      lastProjectedBlockSkipped = true;
      lastSkippedTrailingSpacing = projectionBoundary(document, node, 'trailing');
      continue;
    }
    if (isEmptyParagraphNode(node)) {
      pendingEmpties += 1;
      lastProjectedBlockSkipped = false;
      lastSkippedTrailingSpacing = null;
      continue;
    }
    const serialized = serializeNode(node, 0);
    if (serialized === '') {
      if (first && skippedLeadingSpacing == null) {
        const raw = node?.getAttribute?.('blankBefore');
        skippedLeadingSpacing = projectionBoundary(document, node, 'leading')
          ?? (raw == null ? 2 * pendingEmpties : Math.max(0, Number(raw) || 0));
      }
      lastProjectedBlockSkipped = true;
      lastSkippedTrailingSpacing = projectionBoundary(document, node, 'trailing');
      continue;
    }
    lastProjectedBlockSkipped = false;
    lastSkippedTrailingSpacing = null;
    if (first) {
      // Leading newlines: blankBefore on first block = raw newline count
      // BEFORE any content. Falls back to legacy `2K` newlines from K
      // leading empty markers (which the old `parts.join('\n\n')` produced),
      // or 0 if neither is present.
      const leading = skippedLeadingSpacing ?? blankBeforeOf(node, 2 * pendingEmpties);
      out = '\n'.repeat(leading) + serialized;
      first = false;
    } else {
      // Inter-block separator. blankBefore = N means N blank lines (N+1
      // newlines). Default 1 = standard `\n\n`. Legacy inference from K
      // empty markers between blocks: K → 2K+1 blank lines (matches the
      // old `parts.join('\n\n')` behavior).
      out += '\n'.repeat(blankBeforeOf(node, 2 * pendingEmpties + 1) + 1) + serialized;
    }
    pendingEmpties = 0;
  }
  // Trailing newlines: explicit `trailingNewlines` attribute on the last
  // node wins; otherwise infer from leftover empty markers — K empties at
  // the end produced `2K` newlines under the old serializer.
  if (fragment.length > 0) {
    const last = fragment.get(fragment.length - 1);
    const trailingRaw = lastProjectedBlockSkipped
      ? lastSkippedTrailingSpacing ?? (first ? null : last?.getAttribute?.('trailingNewlines'))
      : last?.getAttribute?.('trailingNewlines');
    const trailing = trailingRaw != null
      ? Math.max(0, Number(trailingRaw) || 0)
      : 2 * pendingEmpties;
    if (trailing > 0) out += '\n'.repeat(trailing);
  }
  return out;
}

function isEmptyParagraphNode(node) {
  if (!node || node.nodeName !== 'paragraph') return false;
  if (node.length === 0) return true;
  return serializeNode(node, 0) === '';
}

function serializeNode(node, listIndent) {
  if (!node || !node.nodeName) return plainText(node);
  if (isStructurallyDeleted(node)) return '';

  switch (node.nodeName) {
    case 'heading': {
      const level = Number(node.getAttribute('level')) || 1;
      return `${'#'.repeat(level)} ${inlineFromY(node)}`;
    }
    case 'paragraph':
      return inlineFromY(node);
    case 'codeBlock': {
      const lang = node.getAttribute('language') || '';
      return `\`\`\`${lang}\n${codeText(node)}\n\`\`\``;
    }
    case 'bulletList': {
      const items = [];
      for (let i = 0; i < node.length; i += 1) {
        const item = serializeListItem(node.get(i), '- ', listIndent);
        if (item !== '') items.push(item);
      }
      return items.join('\n');
    }
    case 'orderedList': {
      const items = [];
      const start = Number(node.getAttribute('start')) || 1;
      for (let i = 0; i < node.length; i += 1) {
        const item = serializeListItem(node.get(i), `${start + items.length}. `, listIndent);
        if (item !== '') items.push(item);
      }
      return items.join('\n');
    }
    case 'blockquote': {
      if (node.getAttribute('calloutType') || node.getAttribute('data-callout')) return serializeCallout(node, listIndent);
      const children = [];
      for (let i = 0; i < node.length; i += 1) children.push(node.get(i));
      return quotePrefix(joinBlocksBySpacing(children, listIndent, 1));
    }
    case 'horizontalRule':
      return '---';
    case 'table':
      return serializeTable(node);
    case 'image': {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      return imageMarkdown(alt, src, {
        width: node.getAttribute('width'),
        align: node.getAttribute('textAlign'),
      });
    }
    default:
      return plainText(node);
  }
}

// Blank lines above a nested block, from its `blankBefore` attribute — the same
// spacing the top-level serializeDoc loop reproduces. Falls back to
// `defaultBlank` when the block records nothing (an in-editor block): quote
// bodies default to 1 (blocks are blank-separated), list items to 0 (tight).
// `keySerialize` (set by nodeKey/blockKeys) forces the defaults so nested
// spacing never leaks into block identity keys — preserving the invariant that
// a blank-line-only change is a diff no-op, never an unmarked direct mutation.
let keySerialize = false;
function blankBeforeOf(node, defaultBlank) {
  const raw = keySerialize ? null : node?.getAttribute?.('blankBefore');
  return raw != null ? Math.max(0, Number(raw) || 0) : defaultBlank;
}

// Prefix every line of a blockquote/callout body with `> ` (blank lines → `>`).
function quotePrefix(text) {
  return text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
}

// Join block-level children into markdown, reproducing each child's blankBefore
// so nested blocks keep their spacing instead of collapsing to a single newline
// (which would merge two paragraphs into one). Blocks serializing to '' (e.g. a
// fully-struck deletion) drop out without leaving a phantom separator.
function joinBlocksBySpacing(children, listIndent, defaultBlank) {
  let out = '';
  let first = true;
  for (const child of children) {
    const serialized = serializeNode(child, listIndent);
    if (serialized === '') continue;
    out = first ? serialized : out + '\n'.repeat(blankBeforeOf(child, defaultBlank) + 1) + serialized;
    first = false;
  }
  return out;
}

function serializeListItem(node, prefix, indent) {
  if (isStructurallyDeleted(node)) return '';
  if (node.length > 0 && Array.from({ length: node.length }, (_, index) => node.get(index)).every(projectsAsDeletedBlock)) return '';
  if (node.get(0)?.getAttribute?.(NODE_REQUIRED_SHELL) && blockIsTextless(node.get(0))
    && Array.from({ length: Math.max(0, node.length - 1) }, (_, index) => node.get(index + 1)).every(projectsAsDeletedBlock)) return '';
  const pad = '  '.repeat(indent);
  let out = '';
  let first = true;
  for (let i = 0; i < node.length; i += 1) {
    const child = node.get(i);
    // The leading paragraph is required by the list-item schema. When sibling
    // content survives, keep its empty marker; later deleted blocks can vanish.
    if (i > 0 && projectsAsDeletedBlock(child)) continue;
    const isNestedList = child?.nodeName === 'bulletList' || child?.nodeName === 'orderedList';
    // Nested lists carry their own indent; don't prepend the item's padding.
    const rendered = serializeNode(child, indent + 1);
    // An empty item's marker is emitted trimmed (`-`, not `- `): whitespace
    // strippers (git hooks, editors, external sync) would drop the trailing
    // space and the round trip must be byte-stable on the stripped form.
    const piece = first ? (rendered === '' ? `${pad}${prefix}`.trimEnd() : `${pad}${prefix}${rendered}`)
      : isNestedList ? rendered : `${pad}  ${rendered}`;
    // Default 0 (tight): a sub-list or continuation with no recorded blank stays
    // attached, so tight nested lists don't turn loose. A loose item (paragraph,
    // blank, paragraph) carries blankBefore and gets its blank line back.
    out = first ? piece : out + '\n'.repeat(blankBeforeOf(child, 0) + 1) + piece;
    first = false;
  }
  return first ? '' : out;
}

function serializeCallout(node, listIndent) {
  // Prefer the PM attr names; fall back to the legacy data-* names for docs
  // persisted before the codec unification.
  const calloutType = node.getAttribute('calloutType') ?? node.getAttribute('data-callout');
  const foldable = (node.getAttribute('calloutFoldable') ?? node.getAttribute('data-callout-foldable')) === 'true';
  const collapsed = (node.getAttribute('calloutCollapsed') ?? node.getAttribute('data-callout-collapsed')) === 'true';
  const titleExplicit = (node.getAttribute('calloutTitleExplicit') ?? node.getAttribute('data-callout-title-explicit')) === 'true';
  const defaultTitle = humanizeCalloutType(calloutType);
  const marker = foldable ? (collapsed ? '-' : '+') : '';

  const children = [];
  for (let i = 0; i < node.length; i += 1) children.push(node.get(i));
  const titleNode = children[0];
  const hasTitlePara = titleNode?.nodeName === 'paragraph';
  const visibleTitle = hasTitlePara ? inlineFromY(titleNode).trim() : '';
  const title = visibleTitle && (titleExplicit || visibleTitle !== defaultTitle)
    ? ` ${visibleTitle}` : '';

  // Seed with the header line, then append each body block honoring its
  // blankBefore. The header→first-body gap defaults to 0 (a single-line
  // `> [!note] Title\n> body` has no blank) — the blank form carries an explicit
  // blankBefore=1. Gaps between body blocks default to 1: two paragraphs always
  // need a blank line, so an in-editor block with none still separates cleanly.
  const bodyChildren = children.slice(hasTitlePara ? 1 : 0);
  let text = `[!${calloutType}${marker}]${title}`;
  let firstBody = true;
  for (const child of bodyChildren) {
    const part = serializeNode(child, listIndent);
    if (part === '') continue;
    text += '\n'.repeat(blankBeforeOf(child, firstBody ? 0 : 1) + 1) + part;
    firstBody = false;
  }
  return quotePrefix(text);
}

function serializeTable(node) {
  const rows = [];
  for (let i = 0; i < node.length; i += 1) {
    const row = node.get(i);
    if (!row || row.nodeName !== 'tableRow' || isStructurallyDeleted(row)) continue;
    const cells = [];
    for (let j = 0; j < row.length; j += 1) {
      const cell = row.get(j);
      if (!isStructurallyDeleted(cell)) cells.push(serializeTableCell(cell));
    }
    rows.push(cells);
  }
  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map((r) => r.length), 1);
  const pad = (cells) => cells.concat(
    Array.from({ length: Math.max(0, colCount - cells.length) }, () => ''),
  );
  const renderRow = (cells) => `| ${pad(cells).join(' | ')} |`;
  const separator = `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`;
  return [renderRow(rows[0]), separator, ...rows.slice(1).map(renderRow)].join('\n');
}

function serializeTableCell(node) {
  if (!node || isStructurallyDeleted(node)) return '';
  const parts = [];
  for (let i = 0; i < node.length; i += 1) {
    const child = node.get(i);
    const rendered = child?.nodeName === 'paragraph'
      ? inlineFromY(child)
      : serializeNode(child, 0);
    const compact = rendered.replace(/\n+/g, '<br>').trim();
    if (compact) parts.push(compact);
  }
  return parts.join('<br>').replace(/\|/g, '\\|');
}

// Marks wrap outer → inner in this order; for a contiguous run of text the
// shared marks are emitted ONCE around the range (a stack), so overlapping
// spans like `**a *b* c**` nest correctly instead of re-wrapping every run
// (which produced `**a *****b***** c**`).
const MARK_ORDER = ['link', 'highlight', 'strike', 'bold', 'italic', 'code'];
const MARK_TOKEN = { highlight: '==', strike: '~~', bold: '**', italic: '*', code: '`' };

// Ordered list of {name, key, href} for a delta op's attributes. Returns null
// to signal a wiki link, which is a self-contained token (handled inline).
function activeMarks(attrs) {
  if (attrs.link && attrs.link.obsidianType === 'wiki') return null;
  const marks = [];
  for (const name of MARK_ORDER) {
    if (name === 'link') {
      if (attrs.link) marks.push({ name, key: `link:${attrs.link.href || ''}`, href: attrs.link.href || '' });
    } else if (attrs[name]) {
      marks.push({ name, key: name });
    }
  }
  return marks;
}

function inlineFromY(node) {
  let out = '';
  let stack = [];
  const closeFrom = (idx) => {
    for (let k = stack.length - 1; k >= idx; k -= 1) {
      const m = stack[k];
      out += m.name === 'link' ? `](${m.href})` : MARK_TOKEN[m.name];
    }
    stack = stack.slice(0, idx);
  };
  for (let i = 0; i < node.length; i += 1) {
    const child = node.get(i);
    if (child && child.nodeName === 'hardBreak') {
      // A pending structural deletion projects as though the break were
      // accepted: join the surrounding inline runs without emitting a marker.
      if (isStructurallyDeleted(child)) continue;
      // Marks never span a hard break (the parser won't match across one), so
      // close everything before the marker + newline.
      closeFrom(0);
      out += `${child.getAttribute?.('marker') || ''}\n`;
      continue;
    }
    if (!(child instanceof Y.XmlText)) continue;
    for (const op of child.toDelta()) {
      if (typeof op.insert !== 'string') continue;
      const attrs = op.attributes || {};
      // Suggestions-as-marks: content_text is the OPTIMISTIC ("if accepted")
      // projection of the working Y.Doc — pending-deleted text is excluded,
      // pending insertions are emitted as plain text (the `insertion` /
      // `modification` marks aren't in MARK_ORDER, so activeMarks already drops
      // them). The marks themselves survive in ydoc_state; this only governs the
      // plaintext mirror that agents read / history diffs / export see.
      if (attrs.deletion) continue;
      const marks = activeMarks(attrs);
      if (marks === null) {
        closeFrom(0);
        const l = attrs.link;
        const target = (l.obsidianTarget ?? '').trim() || op.insert;
        const alias = (l.obsidianAlias ?? '').trim() || (op.insert !== target ? op.insert : '');
        out += `${l.obsidianEmbed ? '!' : ''}[[${target}${alias ? `|${alias}` : ''}]]`;
        continue;
      }
      let common = 0;
      while (common < stack.length && common < marks.length && stack[common].key === marks[common].key) common += 1;
      closeFrom(common);
      for (let k = common; k < marks.length; k += 1) {
        out += marks[k].name === 'link' ? '[' : MARK_TOKEN[marks[k].name];
        stack.push(marks[k]);
      }
      out += op.insert;
    }
  }
  closeFrom(0);
  return out;
}

function plainText(node) {
  if (!node) return '';
  return (node.toString?.() ?? '').replace(/<[^>]*>/g, '');
}

// Raw code text: concatenate the Y.XmlText inserts verbatim. plainText() runs a
// `<...>` strip that would eat literal tags inside a fenced code block (e.g.
// ```html\n<div>x</div>\n```); code must survive byte-for-byte.
function codeText(node) {
  if (!node) return '';
  let out = '';
  for (let i = 0; i < node.length; i += 1) {
    const child = node.get(i);
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta()) {
        if (typeof op.insert === 'string') out += op.insert;
      }
    }
  }
  return out;
}
