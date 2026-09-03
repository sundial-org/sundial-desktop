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
import { escapeSerializedText, humanizeCalloutType, parseMarkdown } from '../../lib/markdown/parser.mjs';
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

// Blocks with no inline text to carry a mark. They stage STRUCTURALLY — the
// same durable node attr (suggestionInsertionId / suggestionDeletionId) the
// editor uses for human-added blank/atomic blocks — so every block type is
// reviewable the same way; nothing ever applies directly.
const TEXTLESS_BLOCK_TYPES = new Set(['codeBlock', 'horizontalRule', 'frontmatter']);
const hasText = (inline) => (inline || []).some((n) => n.type === 'text');
const isTextlessBlock = (b) => TEXTLESS_BLOCK_TYPES.has(b?.type)
  || ((b?.type === 'paragraph' || b?.type === 'heading') && !hasText(b.inline));

function markBlockInlineDeep(block, markObj) {
  // Text AND inline images carry the mark (images serialize as a literal run).
  const tag = (inline) =>
    (inline || []).map((n) => (n.type === 'hardBreak' ? n : { ...n, marks: addSuggestionMark(n.marks, markObj) }));
  const b = { ...block };
  if (isTextlessBlock(b)) b.suggestion = markObj;
  if (b.type === 'callout') b.titleMarks = addSuggestionMark(b.titleMarks, markObj);
  if (b.type === 'table') b.cellSuggestion = markObj; // empty cells stage like blank bullets
  if (b.inline) b.inline = tag(b.inline);
  if (b.children) b.children = b.children.map((c) => markBlockInlineDeep(c, markObj));
  if (b.items) b.items = b.items.map((item) => item.map((c) => markBlockInlineDeep(c, markObj)));
  if (b.header) b.header = b.header.map(tag);
  if (b.rows) b.rows = b.rows.map((row) => row.map(tag));
  return b;
}

// Inline math ($…$, $$…$$), source comments (%%…%%, <!--…-->) and inline
// footnotes (^[…]) are each ONE atomic diff token — never split on the spaces
// inside them. Otherwise a partial edit ($A^2 + 1$ → $B^2 + 1$) scatters the
// delimiters across separate deletion/insertion/plain text nodes, so no
// renderer can match the span to draw KaTeX (or dim the comment, or fold the
// footnote). Kept whole, a changed span is a clean whole-token delete +
// insert (each side contiguous → renders). Mirrors the editor's decoration
// regexes (math-decorations / tag-comment-decorations / footnote-decorations).
// `[^label]` refs need no entry: labels contain no whitespace, so the
// whitespace split already keeps them whole.
const ATOMIC_INLINE_TOKEN = /%%.*?%%|<!--.*?-->|\^\[[^\[\]\n]*\]|\$\$[^$\n]+?\$\$|(?<!\\)\$(?!\s)[^$\n]+?(?<!\s)\$(?!\d)/g;

function inlineToWordTokens(inline) {
  const tokens = [];
  for (const node of inline || []) {
    if (node.type === 'text') {
      const marks = node.marks || [];
      // Formatting is part of a word's identity: `_w_` → `**w**` must diff as
      // strike + insert (reviewable), not as unchanged text with no marks.
      const sig = JSON.stringify(marks.filter((m) => m.type !== 'insertion' && m.type !== 'deletion' && m.type !== 'modification'));
      const pushWords = (str) => {
        for (const piece of str.split(/(\s+)/)) {
          if (piece.length) tokens.push({ key: `${piece}\0${sig}`, text: piece, marks });
        }
      };
      const re = new RegExp(ATOMIC_INLINE_TOKEN.source, 'g');
      let last = 0;
      let m;
      while ((m = re.exec(node.text)) !== null) {
        pushWords(node.text.slice(last, m.index));
        tokens.push({ key: `${m[0]}\0${sig}`, text: m[0], marks });
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
      // Text into/out of an EMPTY block (a blank `- ` bullet filled in, or
      // emptied) can't pair: word-marking the blank's own paragraph would make
      // its reject prune a bullet that pre-existed. Strike + insert instead, so
      // the blank is restored/removed structurally (see markBlockInlineDeep).
      if (!o.inline.length !== !n.inline.length) return null;
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
      // A title / type / fold change lives in attrs the inline diff can't mark:
      // strike + insert the whole callout so it stays reviewable.
      if ((o.title ?? '') !== (n.title ?? '') || o.calloutType !== n.calloutType || Boolean(o.foldable) !== Boolean(n.foldable)
        || Boolean(o.collapsed) !== Boolean(n.collapsed) || Boolean(o.titleExplicit) !== Boolean(n.titleExplicit)) return null;
      const kids = pairChildrenDiff(o.children, n.children, id);
      return kids ? { ...n, children: kids } : null;
    }
    case 'bulletList':
    case 'orderedList': {
      // Marker / start-number changes are container attrs, invisible to the
      // item diff — bail to a marked whole-list replace (like table alignment).
      if ((o.marker ?? null) !== (n.marker ?? null) || (o.start ?? 1) !== (n.start ?? 1)) return null;
      const oItems = o.items || [];
      const nItems = n.items || [];
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
      // An alignment change lives in cell ATTRS, invisible to the inline word-
      // diff — pairing would apply it directly with no marks to review/reject
      // (an unreviewable mutation). Treat it like any other structural change:
      // bail to the marked whole-table strike+insert. (Codex)
      const oAlign = o.align || [];
      const nAlign = n.align || [];
      for (let c = 0; c < Math.max(oAlign.length, nAlign.length); c += 1) {
        if ((oAlign[c] ?? null) !== (nAlign[c] ?? null)) return null;
      }
      if (!oRows.every((row, i) => (row || []).length === (nRows[i] || []).length)) return null;
      // Same rule as paragraphs: text into/out of an EMPTY cell can't pair.
      const diffCell = (oc, nc) =>
        inlineHasAtoms(oc) || inlineHasAtoms(nc) || hasText(oc) !== hasText(nc) ? null : wordDiffInline(oc || [], nc || [], id);
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
    if (m) out.push(m);
    else out.push(markBlockInlineDeep(o, del), markBlockInlineDeep(n, ins)); // whole-block
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
    for (let i = k; i < oldRun.length; i += 1) out.push(markBlockInlineDeep(oldRun[i], del)); // removed
    for (let i = k; i < newRun.length; i += 1) out.push(markBlockInlineDeep(newRun[i], ins)); // added
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
  // untouched. Blocks an earlier suggestion struck out ENTIRELY project to
  // nothing, so they're transparent to the alignment (skipped, preserved in
  // place / re-merged below). Otherwise (empty-paragraph nodes serializeDoc
  // skips) fall back to a full rebuild. (Codex P1)
  const liveIndex = [];
  const fragKeys = [];
  for (let i = 0; i < fragment.length; i += 1) {
    const node = fragment.get(i);
    if (blockIsFullyDeleted(node)) continue;
    liveIndex.push(i);
    fragKeys.push(nodeKey(node));
  }
  const aligned = fragKeys.length === oldKeys.length && fragKeys.every((k, i) => k === oldKeys[i]);
  const endAccepted = oldBlocks.length - s;
  const fpStart = aligned ? (p < liveIndex.length ? liveIndex[p] : fragment.length) : 0;
  const fpEnd = aligned ? (endAccepted < liveIndex.length ? liveIndex[endAccepted] : fragment.length) : 0;
  // A second staging whose region overlaps blocks that already carry pending
  // marks must not wipe them: the rebuilt region only knows the NEW id. Capture
  // the live region's suggestion runs first and re-merge them after the
  // rebuild (see mergeLiveSuggestionSegments).
  const capture = aligned ? captureLiveSuggestionSegments(fragment, fpStart, fpEnd) : null;

  document.transact(() => {
    if (aligned) {
      fragment.delete(fpStart, fpEnd - fpStart);
      if (regionNodes.length) fragment.insert(fpStart, regionNodes);
      if (capture) mergeLiveSuggestionSegments(fragment, fpStart, regionNodes.length, capture);
    } else {
      const nodes = [...oldBlocks.slice(0, p), ...region, ...oldBlocks.slice(oldBlocks.length - s)]
        .map((bl) => blockToY(bl, true))
        .filter(Boolean);
      fragment.delete(0, fragment.length);
      fragment.insert(0, nodes);
    }
    const projections = document.getMap(MARKDOWN_PROJECTION_ROOT);
    const bounds = newlineBoundaries(newText);
    projections.set(String(id), bounds);
    // Every pending suggestion now projects to `newText`: refresh the other
    // records' boundaries too, or a preserved struck block at a doc edge would
    // resurrect the stale leading/trailing spacing of the staging that struck
    // it (Codex P2 on the same-block restage fix).
    for (const key of [...projections.keys()]) {
      const value = projections.get(key);
      if (value && (value.leading !== bounds.leading || value.trailing !== bounds.trailing)) {
        projections.set(key, { ...bounds });
      }
    }
    syncProjectionSpacing(fragment, newBlocks);
  });
  return true;
}

// Textless nodes (code fences, frontmatter, rules, block images, blank
// paragraphs) carry no markable chars, so they ride the capture/merge char
// streams as ONE sentinel token each (a byte no markdown text can hold): the
// count/order aligns like chars do, and a structural insertion attr on one can
// re-anchor to its rebuilt counterpart. Never descended into: a fence's raw text
// can't carry marks.
const ATOM_TOKEN = '\0';
// A textblock with no mark-bearing chars at all: empty text runs and hard
// breaks only (a blank bullet, an empty heading).
const isBlankParagraph = (n) => (n?.nodeName === 'paragraph' || n?.nodeName === 'heading')
  && Array.from({ length: n.length }, (_, k) => n.get(k)).every((c) => (c instanceof Y.XmlText && c.length === 0) || c?.nodeName === 'hardBreak');
const isTextlessNode = (n) => ['codeBlock', 'frontmatter', 'horizontalRule', 'image'].includes(n?.nodeName) || isBlankParagraph(n);
const listDepth = (n) => { let d = 0; for (let c = n; c; c = c.parent) if (c.nodeName === 'listItem') d += 1; return d; };

// Snapshot the pending-suggestion state of the live region [start, end) before
// it is rebuilt: runs carrying earlier suggestions' insertion/modification
// marks (as lengths in ACCEPTED-view chars), deletion-marked (struck) text —
// which the accepted view excludes — and whole struck blocks (cloned).
// `boundary` records each Y.XmlText edge so a mark at the start of a text can
// re-anchor at the start of its rebuilt counterpart. Null when the region holds
// no suggestion state (nothing to preserve).
function captureLiveSuggestionSegments(fragment, start, end) {
  const segments = [];
  let accepted = '';
  let sawMark = false;
  const walk = (n) => {
    if (isTextlessNode(n)) {
      // A struck atom is projection-invisible, like struck text: when it is a
      // whole struck list item, clone the item and re-insert it (see merge).
      if (isStructurallyDeleted(n)) {
        // A struck atom inside a surviving list item / blockquote / callout is
        // cloned alone and re-anchored in its container (a wholly struck item
        // was cloned whole below, before descending).
        const parent = n.parent;
        if (parent?.nodeName === 'listItem' || parent?.nodeName === 'blockquote') {
          segments.push({ kind: 'strikeAtom', node: quietDetachedAccess(() => n.clone()), depth: listDepth(parent), parentName: parent.nodeName });
          sawMark = true;
        }
        return;
      }
      const insertion = n.getAttribute(NODE_INSERTION_ID) ?? null;
      segments.push({ kind: 'atom', insertion });
      accepted += ATOM_TOKEN;
      if (insertion != null) sawMark = true;
      return;
    }
    if (n instanceof Y.XmlText) {
      segments.push({ kind: 'boundary' });
      for (const op of n.toDelta()) {
        if (typeof op.insert !== 'string' || !op.insert.length) continue;
        const attrs = op.attributes || {};
        if (attrs.deletion) {
          segments.push({ kind: 'strike', text: op.insert, attrs });
          sawMark = true;
          continue;
        }
        accepted += op.insert;
        const marks = {};
        if (attrs.insertion) marks.insertion = attrs.insertion;
        if (attrs.modification) marks.modification = attrs.modification;
        if (attrs.insertion || attrs.modification) {
          segments.push({ kind: 'mark', len: op.insert.length, marks });
          sawMark = true;
        } else {
          segments.push({ kind: 'plain', len: op.insert.length });
        }
      }
      return;
    }
    if (n && typeof n.get === 'function' && n.length != null) {
      // A wholly struck nested block (list item, or a quote / list / table
      // inside one) is projection-invisible like a struck top-level block:
      // clone it whole and re-insert it where it was (see merge) instead of
      // parking its pieces in a neighbour.
      const parent = n.parent;
      if (projectsAsDeletedBlock(n) && (n.nodeName === 'listItem' || parent?.nodeName === 'listItem' || parent?.nodeName === 'blockquote')) {
        const kind = n.nodeName === 'listItem' ? 'strikeItem' : 'strikeAtom';
        segments.push({ kind, node: quietDetachedAccess(() => n.clone()), depth: listDepth(kind === 'strikeItem' ? n : parent), parentName: kind === 'strikeItem' ? 'listItem' : parent.nodeName });
        sawMark = true;
        return;
      }
      // An editor-inserted container (empty table / list / quote) carries the
      // id on the container node itself: re-stamp the rebuilt container that
      // holds the next token (see merge).
      const insertion = n.getAttribute?.(NODE_INSERTION_ID);
      if (insertion != null) { segments.push({ kind: 'containerAttr', insertion, nodeName: n.nodeName }); sawMark = true; }
      for (let k = 0; k < n.length; k += 1) walk(n.get(k));
    }
  };
  for (let i = start; i < end; i += 1) {
    const node = fragment.get(i);
    if (blockIsFullyDeleted(node)) {
      segments.push({ kind: 'block', node: quietDetachedAccess(() => node.clone()) });
      sawMark = true;
      continue;
    }
    walk(node);
  }
  return sawMark ? { segments, accepted } : null;
}

// Re-merge a captured region's earlier suggestion marks into the freshly built
// region nodes fragment[start, start+count). The rebuild's non-insertion runs
// spell out the same accepted-view chars the capture recorded (old side), so a
// cursor over that shared char stream recovers every mark's position: `mark`
// runs re-format their chars (an earlier insertion the new suggestion deletes
// ends up carrying BOTH marks — resolvable in either order), `strike` runs
// re-insert their projection-invisible text, and struck whole blocks re-insert
// at the nearest block boundary. No-op when the char streams disagree — a
// region the rebuild direct-applied (code fence, image) has no stable
// positions to merge into (such blocks can't carry marks anyway).
function mergeLiveSuggestionSegments(fragment, start, count, capture) {
  const streams = []; // one per Y.XmlText / old-side atom in the rebuilt region, in doc order
  const collect = (n, topIndex) => {
    if (isTextlessNode(n)) {
      // An atom the NEW suggestion inserted is not old-side content.
      if (n.getAttribute(NODE_INSERTION_ID) == null) streams.push({ atom: n, ops: [], topIndex });
      return;
    }
    if (n instanceof Y.XmlText) {
      const ops = [];
      for (const op of n.toDelta()) {
        if (typeof op.insert !== 'string' || !op.insert.length) continue;
        ops.push({ len: op.insert.length, text: op.insert, insertion: Boolean(op.attributes?.insertion) });
      }
      streams.push({ ytext: n, ops, topIndex });
      return;
    }
    if (n && typeof n.get === 'function' && n.length != null) {
      for (let k = 0; k < n.length; k += 1) collect(n.get(k), topIndex);
    }
  };
  for (let i = start; i < start + count; i += 1) collect(fragment.get(i), i);
  const oldSide = streams
    .map((st) => (st.atom ? ATOM_TOKEN : st.ops.filter((o) => !o.insertion).map((o) => o.text).join('')))
    .join('');
  if (oldSide !== capture.accepted) return;
  if (!streams.some((st) => st.ytext) && capture.segments.some((sg) => sg.kind === 'strike')) return;
  let ti = 0; // stream index
  let oi = 0; // op index within stream
  let off = 0; // chars consumed within op
  let pos = 0; // char offset in current ytext, adjusted for our own inserts
  let blockShift = 0; // fragment nodes we re-inserted so far
  let lastStrike = null; // the struck node just re-inserted (ordering of adjacent strikes)
  // Move the cursor to stream `k`; `pre` = struck text already parked at its head.
  const enter = (k) => { ti = k; oi = 0; off = 0; pos = streams[k]?.pre ?? 0; };
  const hasOldSideLeft = (st, from, fromOff) => {
    if (st.atom) return true; // its one token is consumed by an atom segment
    for (let k = from; k < st.ops.length; k += 1) {
      if (!st.ops[k].insertion && st.ops[k].len > (k === from ? fromOff : 0)) return true;
    }
    return false;
  };
  // `n`'s listItem ancestors, innermost first.
  const listChain = (n) => {
    const chain = [];
    for (let cur = n; cur; cur = cur.parent) if (cur.nodeName === 'listItem') chain.push(cur);
    return chain;
  };
  const consume = (n, marks) => {
    while (n > 0 && ti < streams.length) {
      const st = streams[ti];
      if (oi >= st.ops.length) { enter(ti + 1); continue; }
      const op = st.ops[oi];
      if (op.insertion) { pos += op.len; oi += 1; off = 0; continue; }
      const take = Math.min(n, op.len - off);
      if (marks) st.ytext.format(pos, take, marks);
      pos += take;
      off += take;
      n -= take;
      if (off >= op.len) { oi += 1; off = 0; }
    }
  };
  for (const sg of capture.segments) {
    if (sg.kind === 'plain') consume(sg.len, null);
    else if (sg.kind === 'mark') consume(sg.len, sg.marks);
    else if (sg.kind === 'boundary') {
      // A mark that opened a live text lands at the START of the next rebuilt
      // text, not the tail of the previous one: skip streams with no old-side
      // chars left.
      while (ti < streams.length && !hasOldSideLeft(streams[ti], oi, off)) enter(ti + 1);
    } else if (sg.kind === 'atom') {
      while (ti < streams.length && !streams[ti].atom && !hasOldSideLeft(streams[ti], oi, off)) enter(ti + 1);
      if (!streams[ti]?.atom) return; // streams disagree — nothing further can anchor
      if (sg.insertion != null) streams[ti].atom.setAttribute(NODE_INSERTION_ID, sg.insertion);
      enter(ti + 1);
    } else if (sg.kind === 'strike') {
      if (ti < streams.length && streams[ti].ytext) {
        streams[ti].ytext.insert(pos, sg.text, sg.attrs);
        pos += sg.text.length;
      } else {
        // The cursor sits on an atom (or past the end): park the struck text
        // at the tail of the previous text, else the head of the next one.
        let k = ti < streams.length ? ti - 1 : streams.length - 1;
        while (k >= 0 && !streams[k].ytext) k -= 1;
        if (k >= 0) {
          streams[k].ytext.insert(streams[k].ytext.length, sg.text, sg.attrs);
        } else {
          k = ti;
          while (k < streams.length && !streams[k].ytext) k += 1;
          if (k >= streams.length) continue;
          const st = streams[k];
          st.pre = (st.pre ?? 0) + sg.text.length;
          st.ytext.insert(st.pre - sg.text.length, sg.text, sg.attrs);
        }
      }
    } else if (sg.kind === 'containerAttr') {
      // The container's first token lies ahead: skip streams already spent.
      let k = ti;
      while (k < streams.length && !hasOldSideLeft(streams[k], k === ti ? oi : 0, k === ti ? off : 0)) k += 1;
      let node = streams[k]?.ytext ?? streams[k]?.atom ?? null;
      while (node && node.nodeName !== sg.nodeName) node = node.parent;
      node?.setAttribute?.(NODE_INSERTION_ID, sg.insertion);
    } else if (sg.kind === 'strikeItem' || sg.kind === 'strikeAtom') {
      // A struck item goes back at its own list depth: after the item the
      // cursor is in (or just finished), else before the next one. A struck
      // atom goes back INTO that item, after the child the cursor is in.
      // Dropped when no list is near.
      const consumedSome = oi > 0 || off > 0 || pos > 0; // pos: struck text already parked here
      const anchorNode = (k) => (k >= 0 && k < streams.length ? (streams[k].ytext ?? streams[k].atom) : null);
      let anchor = anchorNode(consumedSome ? ti : ti - 1);
      let chain = listChain(anchor);
      let after = true;
      if (sg.parentName === 'listItem' ? !chain.length : !anchor) { anchor = anchorNode(ti); chain = listChain(anchor); after = false; }
      const item = chain[chain.length - sg.depth] ?? chain[0];
      let container = sg.kind === 'strikeItem' ? item?.parent : item;
      if (sg.kind === 'strikeAtom' && sg.parentName !== 'listItem') {
        container = anchor;
        while (container && container.nodeName !== sg.parentName) container = container.parent;
      }
      if (!container) continue;
      let target = anchor;
      if (sg.kind === 'strikeItem') target = item;
      else while (target && target.parent !== container) target = target.parent;
      // Consecutive struck nodes anchored after the same neighbour keep their
      // order: each one goes after the clone just placed, not after the anchor.
      const chained = after && lastStrike?.container === container && lastStrike.anchor === target;
      const at = chained ? lastStrike.node : target;
      for (let k = 0; k < container.length; k += 1) {
        if (container.get(k) === at) { container.insert(k + (after ? 1 : 0), [sg.node]); break; }
      }
      lastStrike = after ? { container, anchor: target, node: sg.node } : null;
    } else if (sg.kind === 'block') {
      // A struck whole block re-inserts before the current block when nothing
      // of that block has been consumed yet, after it otherwise (region end
      // once the stream is exhausted).
      const atStart = ti < streams.length && oi === 0 && off === 0
        && (ti === 0 || streams[ti - 1].topIndex !== streams[ti].topIndex);
      const idx = ti < streams.length ? streams[ti].topIndex + (atStart ? 0 : 1) : start + count;
      fragment.insert(idx + blockShift, [sg.node]);
      blockShift += 1;
    }
  }
}

// The accepted projection (surviving = non-deletion nodes) must serialize to
// `newText` EXACTLY, spacing included. Prefix/suffix nodes are reused from the
// OLD parse and direct-applied blocks carry no marks, so a structural change
// (a frontmatter block added or removed) leaves a neighbour holding the old
// blank-line count — a phantom blank line in content_text. Re-apply the new
// parse's spacing to the surviving nodes, positionally. Guarded on an exact
// 1:1 count match so an unexpected shape is left untouched rather than
// mis-spaced. (Codex P1)
function syncProjectionSpacing(fragment, newBlocks) {
  const surviving = [];
  for (let i = 0; i < fragment.length; i += 1) {
    const node = fragment.get(i);
    if (isStructurallyDeleted(node) || blockIsFullyDeleted(node) || isEmptyParagraphNode(node)) continue;
    surviving.push(node);
  }
  if (surviving.length !== newBlocks.length) return;
  surviving.forEach((node, i) => {
    const block = newBlocks[i];
    const blank = typeof block.blankBefore === 'number' && block.blankBefore >= 0 ? String(block.blankBefore) : null;
    if (blank == null) node.removeAttribute?.('blankBefore');
    else node.setAttribute?.('blankBefore', blank);
    const trailing = typeof block.trailingNewlines === 'number' && block.trailingNewlines > 0
      ? String(block.trailingNewlines) : null;
    if (trailing == null) node.removeAttribute?.('trailingNewlines');
    else node.setAttribute?.('trailingNewlines', trailing);
  });
}

// Shell types: containers that hold nothing once their text is gone. Anything
// NOT listed (image, hr, codeBlock, future node types) survives a resolution
// that empties the text around it, so its container must too.
const SHELL_NODES = new Set(['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList', 'blockquote', 'hardBreak', 'table', 'tableRow', 'tableCell', 'tableHeader']);
const NODE_INSERTION_ID = 'suggestionInsertionId';
const NODE_DELETION_ID = 'suggestionDeletionId';
const NODE_MODIFICATIONS = 'suggestionModifications';
const NODE_REQUIRED_SHELL = 'suggestionRequiredShell';
const nodeSuggestionAttr = (kind) => (kind === 'insertion' ? NODE_INSERTION_ID : NODE_DELETION_ID);
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

// A node's suggestion identity as ONE run for the structural cascade: its own
// attrs, else — for a node whose whole subtree agrees on a single insertion id
// and a single deletion id (a struck-and-replaced table, list, paragraph) — the
// subtree's ids. Mixed subtrees are no run at all (null/null): the inline
// cascade owns intra-block stacks.
function nodeSuggestionIds(node) {
  const own = structuralSuggestion(node);
  if (own) return { insertionId: node.getAttribute(NODE_INSERTION_ID) ?? null, deletionId: node.getAttribute(NODE_DELETION_ID) ?? null };
  const ins = new Set();
  const del = new Set();
  const walk = (n) => {
    if (n instanceof Y.XmlText) {
      for (const op of n.toDelta()) {
        if (typeof op.insert !== 'string' || !op.insert.length) continue;
        ins.add(op.attributes?.insertion?.id ?? null);
        del.add(op.attributes?.deletion?.id ?? null);
      }
      return;
    }
    if (typeof n?.getAttribute === 'function') {
      if (structuralSuggestion(n)) { ins.add(n.getAttribute(NODE_INSERTION_ID) ?? null); del.add(n.getAttribute(NODE_DELETION_ID) ?? null); return; }
      if (isTextlessNode(n)) { ins.add(null); del.add(null); return; }
    }
    if (n && typeof n.get === 'function' && n.length != null) for (let i = 0; i < n.length; i += 1) walk(n.get(i));
  };
  walk(node);
  const one = (set) => (set.size === 1 ? [...set][0] : null);
  return ins.size === 0 ? { insertionId: null, deletionId: null } : { insertionId: one(ins), deletionId: one(del) };
}

// Clear deletion `depId` from a node's subtree (attrs + inline marks). True if anything changed.
function clearDeletion(node, depId) {
  if (depId == null) return false;
  let changed = false;
  const walk = (n) => {
    if (n instanceof Y.XmlText) {
      let offset = 0;
      for (const op of n.toDelta()) {
        if (typeof op.insert !== 'string') { offset += 1; continue; }
        if (op.attributes?.deletion?.id === depId) { n.format(offset, op.insert.length, { deletion: null }); changed = true; }
        offset += op.insert.length;
      }
      return;
    }
    if (typeof n?.getAttribute === 'function' && n.getAttribute(NODE_DELETION_ID) === depId) { n.removeAttribute(NODE_DELETION_ID); changed = true; }
    if (n && typeof n.get === 'function' && n.length != null) for (let i = 0; i < n.length; i += 1) walk(n.get(i));
  };
  walk(node);
  return changed;
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

// Read the deletion attr directly: a node can carry BOTH (an earlier id's blank
// insertion a later id struck), and structuralSuggestion reports insertion first.
function isStructurallyDeleted(node) {
  return typeof node?.getAttribute === 'function' && node.getAttribute(NODE_DELETION_ID) != null;
}

function deletionSuggestionIds(node, ids = new Set()) {
  if (isStructurallyDeleted(node)) ids.add(node.getAttribute(NODE_DELETION_ID));
  if (node instanceof Y.XmlText) {
    for (const op of node.toDelta()) if (op.attributes?.deletion?.id != null) ids.add(op.attributes.deletion.id);
  } else if (node && typeof node.get === 'function' && node.length != null) {
    for (let i = 0; i < node.length; i += 1) deletionSuggestionIds(node.get(i), ids);
  }
  return ids;
}

// Is `node` still a direct child of the fragment? A Yjs node removed from its
// parent keeps its `.parent` pointer, so identity-scan the children instead.
function fragmentHolds(fragment, node) {
  for (let i = 0; i < fragment.length; i += 1) if (fragment.get(i) === node) return true;
  return false;
}

// The leading-blank-line count `id` recorded for the file when it staged.
// `applyMarkdownSuggestion` keeps every live id's record refreshed to the
// current projection's boundaries, so this is the file's leading spacing as of
// the last staging — null when the id never staged through the codec.
function projectionLeadingFor(document, id) {
  if (!document.share.has(MARKDOWN_PROJECTION_ROOT)) return null;
  const value = document.getMap(MARKDOWN_PROJECTION_ROOT).get(String(id));
  if (!value || typeof value !== 'object' || !Number.isFinite(value.leading)) return null;
  return Math.max(0, value.leading);
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
// Partial decisions (a cascade rejected SOME of an id's hunks while others
// stay pending). Deliberately a separate root: the resolved map means "this id
// is decided" to every consumer and to the decision-event recorder, so a
// still-live id must never appear there. Entries fold into the final value
// (differing action => 'mixed') when the id is actually resolved.
const MARKDOWN_PARTIAL_ROOT = 'markdownsuggestions_partial';

export function markdownSuggestionResolution(document, id) {
  const value = document.getMap(MARKDOWN_RESOLVED_ROOT).get(String(id));
  return value === 'accept' || value === 'reject' || value === 'mixed' ? value : null;
}

export function recordMarkdownSuggestionResolution(document, ids, action) {
  document.transact(() => {
    const resolved = document.getMap(MARKDOWN_RESOLVED_ROOT);
    // share.has guard: only read the partial root if it exists — getMap would
    // CREATE it, mutating docs that never had a partial cascade.
    const partials = document.share.has(MARKDOWN_PARTIAL_ROOT) ? document.getMap(MARKDOWN_PARTIAL_ROOT) : null;
    for (const id of ids) {
      const key = String(id);
      const partial = partials?.get(key);
      if (partial != null) partials.delete(key);
      const effective = partial != null && partial !== action ? 'mixed' : action;
      const previous = resolved.get(key);
      resolved.set(key, previous === 'mixed' || (previous && previous !== effective) ? 'mixed' : effective);
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
//
// Stacked suggestions (same-block re-staging): a run a LATER suggestion built
// on top of an EARLIER one carries both marks — insertion(earlier) +
// deletion(later). Rejecting the EARLIER id removes that run, so the later
// suggestion's PAIRED replacement text — the insertion runs staged directly
// after it — would dangle next to the restored text (a corrupt hybrid like
// "beta OMEGA" for beta→BETA→OMEGA). Those adjacent dependent runs are removed
// with it; the dependent id's hunks elsewhere don't sit on the earlier text,
// so they stay pending. A dependent whose every mark was consumed this way is
// tombstoned `mixed` (replay-safety): only the hunks it staged ON the earlier
// text were rejected, so a flat `reject` would claim more than happened. The whole
// resolution commits as ONE outer Yjs transaction (nested transacts fold in),
// so observers/persistence never see the intermediate hybrid state.
export function resolveSuggestion(document, id, action) {
  // Capture the result in a local: Y.Doc.transact only passes the callback's
  // return value through on newer yjs versions — a consumer pinning an older
  // yjs would get undefined, and callers gate persistence + decision events
  // on this boolean (a falsy `changed` skips the forced ydoc_state persist,
  // so a mark-only resolve would resurrect on cold reload).
  let changed = false;
  document.transact(() => { changed = resolveSuggestionInTransaction(document, id, action); });
  return changed;
}

// The dependency rule for rejecting a stacked suggestion's base — the ONE
// implementation shared by the headless resolver below and the editor's inline
// path (lib/workspace/suggestion-marks.ts), so both surfaces converge on
// identical post-state. `runs` is one contiguous inline sequence in document
// order (one Y.XmlText's delta / one textblock's text children), each
// { insertionId, deletionId } (null when unmarked). Rejecting `id` removes its
// insertion runs; a removed run also carrying a LATER suggestion's deletion
// drags that dependent's paired replacement — the contiguous dependent
// insertion runs the diff staged right after it — along. A chained re-staging
// (s3 on s2) surfaces as a deletion id on a walked run and extends the walk.
// An earlier id can never mark later-inserted text, so walked runs never
// collide with the caller's own ops for `id`. Returns run indexes to remove
// (`cascaded`), indexes whose dependent deletion mark clears (`reverted` —
// ORIGINAL text the dependent replacement also consumed, e.g. adjacent
// whitespace: rejecting the dependent hunk restores it), and the dependent ids
// (`depIds`) to tombstone or park.
export function rejectDependentGroups(runs, id) {
  const cascaded = new Set();
  const reverted = new Set();
  const depIds = new Set();
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (run.insertionId !== id || run.deletionId == null || run.deletionId === id) continue;
    const deps = new Set([run.deletionId]);
    for (let j = i + 1; j < runs.length; j += 1) {
      const a = runs[j];
      if (a.insertionId != null && deps.has(a.insertionId)) {
        cascaded.add(j);
        if (a.deletionId != null) deps.add(a.deletionId);
      } else if (a.deletionId != null && deps.has(a.deletionId)) {
        reverted.add(j);
      } else break;
    }
    for (const dep of deps) depIds.add(dep);
  }
  return { cascaded, reverted, depIds };
}

function resolveSuggestionInTransaction(document, id, action) {
  const accept = action === 'accept';
  const acceptedProjection = accept ? serializeDoc(document) : null;
  // `blankBefore` means "blank lines ABOVE me", so a block is only allowed to
  // spell the FILE's leading spacing while it is the first projected block.
  // When a reject REMOVES every block ahead of it, the survivor is promoted to
  // first still carrying its stale INTER-BLOCK separator and serializes a
  // phantom leading newline ("\nGamma." instead of "Gamma.") — the visible
  // corruption when a stacked suggestion's base is rejected. Record the block
  // that currently leads the projection, plus the leading this id last staged,
  // so the promotion can be detected and corrected below.
  const firstProjectedBlock = () => {
    const f = document.getXmlFragment('default');
    for (let i = 0; i < f.length; i += 1) {
      const node = f.get(i);
      if (blockIsFullyDeleted(node) || isEmptyParagraphNode(node)) continue;
      return node;
    }
    return null;
  };
  const priorFirstBlock = accept ? null : firstProjectedBlock();
  const stagedLeading = accept ? null : projectionLeadingFor(document, id);
  const fragment = document.getXmlFragment('default');
  const cascadeIds = new Set();
  let changed = false;
  // Returns true if it removed any text from this Y.XmlText (so the owning block
  // may now be empty and removable).
  const visitText = (node) => {
    // Materialize the runs once: the dependency cascade needs lookahead.
    const runs = [];
    let offset = 0;
    for (const op of node.toDelta()) {
      if (typeof op.insert !== 'string') { offset += 1; continue; }
      runs.push({ offset, len: op.insert.length, attrs: op.attributes || {} });
      offset += op.insert.length;
    }
    // Rejecting an insertion a later suggestion replaced: the removed run
    // carries that dependent's deletion, so the dependent's paired replacement
    // text must go too (see docstring + rejectDependentGroups).
    const { cascaded, reverted, depIds } = accept
      ? { cascaded: new Set(), reverted: new Set(), depIds: [] }
      : rejectDependentGroups(
          runs.map(({ attrs }) => ({ insertionId: attrs.insertion?.id ?? null, deletionId: attrs.deletion?.id ?? null })),
          id,
        );
    for (const dep of depIds) cascadeIds.add(dep);
    const ops = [];
    for (let i = 0; i < runs.length; i += 1) {
      const { offset: runOffset, len, attrs } = runs[i];
      const isIns = attrs.insertion && attrs.insertion.id === id;
      const isDel = attrs.deletion && attrs.deletion.id === id;
      if (isIns || isDel) {
        const remove = (accept && isDel) || (!accept && isIns);
        ops.push({ offset: runOffset, len, remove, mark: isIns ? 'insertion' : 'deletion' });
      } else if (attrs.modification && attrs.modification.id === id) {
        // A formatting/attribute suggestion: the text stays either way. Accept
        // keeps the suggested formatting; reject restores the previous value
        // the mark recorded (when it names one). Either way the mark must
        // clear, or the id stays "live" forever and Keep/Undo zombies on it.
        ops.push({ offset: runOffset, len, remove: false, mark: 'modification', mod: attrs.modification });
      }
    }
    for (const j of cascaded) ops.push({ offset: runs[j].offset, len: runs[j].len, remove: true, mark: 'insertion' });
    for (const j of reverted) if (!cascaded.has(j)) ops.push({ offset: runs[j].offset, len: runs[j].len, remove: false, mark: 'deletion' });
    let removedText = false;
    for (const o of ops.sort((x, y) => y.offset - x.offset)) {
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
          node.setAttribute(NODE_REQUIRED_SHELL, true);
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
      cascadeStructural(node);
      for (let i = 0; i < node.length; i += 1) {
        const child = node.get(i);
        const r = visit(child);
        removed = r || removed;
        if (r && child?.nodeName !== 'bulletList' && child?.nodeName !== 'orderedList') removedOwn = true;
      }
    }
    if (removedOwn && node?.nodeName === 'listItem' && blockIsTextless(node)) emptiedItems.push(node);
    // A cell/bullet paragraph THIS resolution emptied of text (vs. a pre-existing
    // blank, which is user content) — the table prune below tells them apart.
    if (removed && node?.nodeName === 'paragraph' && isBlankParagraph(node)) node.setAttribute(NODE_REQUIRED_SHELL, true);
    return removed;
  };
  // Structural twin of the inline cascade: rejecting `id`'s inserted node that a
  // later id replaced (its deletion attr sits on the same node) drags that
  // dependent's paired replacement nodes along — the same rejectDependentGroups
  // rule, over a container's child sequence instead of a text's runs.
  const cascadeStructural = (container) => {
    if (accept) return;
    const kids = Array.from({ length: container.length }, (_, i) => container.get(i));
    const { cascaded, reverted, depIds } = rejectDependentGroups(kids.map(nodeSuggestionIds), id);
    for (const j of cascaded) { const target = structuralDropTarget(kids[j]); if (target) structuralDrops.push(target); }
    for (const j of reverted) if (!cascaded.has(j) && clearDeletion(kids[j], nodeSuggestionIds(kids[j]).deletionId)) changed = true;
    for (const dep of depIds) cascadeIds.add(dep);
  };
  // Detach `node` from its parent; an emptied-out list follows its last item.
  const removeNode = (node) => {
    const parent = node?.parent;
    if (!parent || typeof parent.get !== 'function' || parent.length == null) return;
    for (let i = 0; i < parent.length; i += 1) {
      if (parent.get(i) === node) {
        // The file's trailing newlines ride on its LAST block: when that block
        // goes, the new last block inherits them (else the reject eats the
        // file's final newline).
        const trailing = parent === fragment && i === parent.length - 1 ? node.getAttribute?.('trailingNewlines') : null;
        parent.delete(i, 1);
        changed = true;
        if (parent === fragment && parent.length === 0) {
          const shell = new Y.XmlElement('paragraph');
          shell.setAttribute('trailingNewlines', '0');
          parent.insert(0, [shell]);
        } else if (trailing != null && parent.length > 0 && parent.get(parent.length - 1).getAttribute?.('trailingNewlines') == null) {
          parent.get(parent.length - 1).setAttribute('trailingNewlines', trailing);
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
    cascadeStructural(fragment);
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
    // A table is pruned only when EVERY cell was emptied or shelled by this
    // resolution — a pre-existing blank cell is user content and keeps it (the
    // table twin of "a textless list that still has items is user content").
    const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'table']);
    const cellParagraphs = (table) => {
      const out = [];
      const walk = (n) => {
        if (n?.nodeName === 'tableCell' || n?.nodeName === 'tableHeader') { for (let i = 0; i < n.length; i += 1) if (n.get(i)?.nodeName === 'paragraph') out.push(n.get(i)); return; }
        if (n && typeof n.get === 'function' && n.length != null) for (let i = 0; i < n.length; i += 1) walk(n.get(i));
      };
      walk(table);
      return out;
    };
    for (const node of emptied) {
      if (!node || !TEXT_BLOCKS.has(node.nodeName) || !blockIsTextless(node) || node.parent !== fragment) continue;
      if (node.nodeName === 'table' && !cellParagraphs(node).every((p) => p.getAttribute(NODE_REQUIRED_SHELL))) continue;
      removeNode(node);
    }
    // The shell markers are transient bookkeeping for this resolution.
    const clearShells = (n) => {
      if (n?.nodeName === 'paragraph' && n.getAttribute(NODE_REQUIRED_SHELL) && n.parent?.nodeName !== 'listItem') n.removeAttribute(NODE_REQUIRED_SHELL);
      if (n && typeof n.get === 'function' && n.length != null) for (let i = 0; i < n.length; i += 1) clearShells(n.get(i));
    };
    clearShells(fragment);
    // Reject promoted a new block to the head of the projection (the one that
    // led it was removed): re-point its `blankBefore` at the file's leading
    // spacing — the value this suggestion recorded when it staged — instead of
    // leaving the inter-block separator it was carrying. Skipped when the id
    // never recorded a projection (a structural suggestion staged directly),
    // where the survivor's own attribute IS the original leading spacing.
    if (priorFirstBlock && stagedLeading != null && !fragmentHolds(fragment, priorFirstBlock)) {
      const promoted = firstProjectedBlock();
      // Only when it became the fragment's physically first node. A struck
      // block still sitting ahead of it keeps owning the file's leading spacing
      // (serializeDoc reads it as `skippedLeadingSpacing`, so no phantom
      // newline is possible) and can be restored by a later reject — rewriting
      // the survivor's separator would destroy that block's real gap.
      if (promoted && promoted !== priorFirstBlock && fragment.get(0) === promoted) {
        promoted.setAttribute?.('blankBefore', String(stagedLeading));
        changed = true;
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
  // A dependent whose remaining marks were ALL consumed by this reject is
  // resolved: tombstone it (replay-safety) and drop its projection. `mixed`,
  // not `reject` — it was rejected by cascade, not by its own decision.
  // A PARTIALLY consumed dependent stays pending (marks + projection kept,
  // NO resolved-map entry, NO decision event — a still-live id must never
  // read as decided). Its consumed hunks park in the partial root instead;
  // the final resolution of the remainder folds them in — a later accept
  // lands as `mixed`, never a flat `accept` that hides the cascaded reject.
  const cascaded = [...cascadeIds].filter((dep) => dep !== id);
  const consumed = cascaded.filter((dep) => !suggestionStillLive(fragment, dep));
  recordRejectCascadeOutcome(document, { consumed, partial: cascaded.filter((dep) => !consumed.includes(dep)) });
  return changed;
}

// Record a reject cascade's dependent outcome — shared by the headless resolver
// and the editor path (collab-editor wires it through SuggestionChanges's
// onCascade), so both surfaces write the identical decision state.
export function recordRejectCascadeOutcome(document, { consumed, partial }) {
  document.transact(() => {
    if (consumed.length) {
      for (const dep of consumed) document.getMap(MARKDOWN_PROJECTION_ROOT).delete(String(dep));
      recordMarkdownSuggestionResolution(document, consumed, 'mixed');
    }
    if (partial.length) {
      const partials = document.getMap(MARKDOWN_PARTIAL_ROOT);
      for (const dep of partial) partials.set(String(dep), 'reject');
    }
  });
}

// True while `id` still has any live representation under `node` — inline
// insertion/deletion/modification marks or the structural node attributes.
function suggestionStillLive(node, id) {
  if (structuralSuggestion(node, id) || structuralModifications(node, id).length) return true;
  if (node instanceof Y.XmlText) {
    return node.toDelta().some((op) => {
      const a = op.attributes;
      return Boolean(a && (a.insertion?.id === id || a.deletion?.id === id || a.modification?.id === id));
    });
  }
  if (node && typeof node.get === 'function' && node.length != null) {
    for (let i = 0; i < node.length; i += 1) if (suggestionStillLive(node.get(i), id)) return true;
  }
  return false;
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
  // Structural (textless-block) suggestion — see markBlockInlineDeep.
  if (block.suggestion) el.setAttribute(nodeSuggestionAttr(block.suggestion.type), block.suggestion.id);
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
      // 4-space/tab-indented source form — serialized back indented, not fenced.
      if (block.indented) el.setAttribute('indented', 'true');
      if (block.text) el.insert(0, [new Y.XmlText(block.text)]);
      return el;
    }
    case 'horizontalRule': {
      const el = new Y.XmlElement('horizontalRule');
      // Non-default thematic-break marker (`***` / `___` / longer runs).
      if (block.marker) el.setAttribute('marker', block.marker);
      return el;
    }
    case 'frontmatter': {
      // Raw YAML text, fences included — one plain-text node, no inline parse,
      // so the metadata round-trips byte-for-byte (like a code fence's body).
      const el = new Y.XmlElement('frontmatter');
      el.insert(0, [new Y.XmlText(block.text)]);
      return el;
    }
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
      titlePara.insert(0, inlineToY([{ type: 'text', text: block.title, marks: block.titleMarks }]));
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
      if (block.type === 'bulletList' && (block.marker === '*' || block.marker === '+')) {
        el.setAttribute('marker', block.marker);
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
      const align = block.align || [];
      const headerRow = new Y.XmlElement('tableRow');
      block.header.forEach((cellInline, col) => {
        headerRow.push([cellToY('tableHeader', cellInline, align[col], block.cellSuggestion)]);
      });
      el.push([headerRow]);
      for (const row of block.rows) {
        const tr = new Y.XmlElement('tableRow');
        row.forEach((cellInline, col) => {
          tr.push([cellToY('tableCell', cellInline, align[col], block.cellSuggestion)]);
        });
        el.push([tr]);
      }
      return el;
    }
    default:
      return null;
  }
}

function cellToY(tag, inline, align, suggestion) {
  const cell = new Y.XmlElement(tag);
  // Column alignment from the `:---:` separator — carried on every cell so the
  // editor and HTML renderer style each cell without re-deriving columns.
  if (align) cell.setAttribute('align', align);
  const p = new Y.XmlElement('paragraph');
  p.insert(0, inlineToY(inline));
  // An EMPTY cell of a whole-marked table carries the mark structurally.
  if (suggestion && !hasText(inline)) p.setAttribute(nodeSuggestionAttr(suggestion.type), suggestion.id);
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
      // time. The image's own (suggestion) marks ride on the literal.
      const literal = imageMarkdown(node.alt, node.src, { width: node.width, align: node.align });
      run.insert(offset, literal, marksToAttrs(node.marks));
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
    underline: null,
    subscript: null,
    superscript: null,
    link: null,
    // Suggestion marks (agent suggest-mode edits). Stored as `{ id }` so
    // y-prosemirror maps them to the editor's insertion/deletion marks; reset
    // to null (like the others) so an unmarked run ends the suggestion span.
    insertion: null,
    deletion: null,
  };
  for (const mark of marks || []) {
    switch (mark.type) {
      case 'bold': attrs.bold = true; break;
      case 'italic': attrs.italic = true; break;
      case 'code': attrs.code = true; break;
      case 'strike': attrs.strike = true; break;
      case 'highlight': attrs.highlight = true; break;
      case 'underline': attrs.underline = true; break;
      case 'subscript': attrs.subscript = true; break;
      case 'superscript': attrs.superscript = true; break;
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
    // An atom (fence, rule, image, blank bullet / cell) that is not struck IS
    // surviving content — the block projects even if every text run around it
    // is struck. (A struck table's empty cells carry the deletion attr.)
    if (isTextlessNode(n)) {
      if (isStructurallyDeleted(n)) hasDeletion = true;
      else hasSurviving = true;
      return;
    }
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
    // `first` still set = the doc emitted NO content, so the leftover empty
    // paragraphs are the document, not spacing after it. ProseMirror cannot
    // hold an empty doc, so resolving away every block leaves exactly one blank
    // paragraph; inferring `2K` trailing newlines from it made an empty file
    // project as "\n\n" and diverge from the headless resolver's "". An
    // explicit trailingNewlines attribute still wins (a suggestion that struck
    // the whole file records the projection's real trailing spacing).
    const trailing = trailingRaw != null
      ? Math.max(0, Number(trailingRaw) || 0)
      : (first ? 0 : 2 * pendingEmpties);
    if (trailing > 0) out += '\n'.repeat(trailing);
  }
  return out;
}

function isEmptyParagraphNode(node) {
  if (!node || node.nodeName !== 'paragraph') return false;
  if (node.length === 0) return true;
  return serializeNode(node, 0) === '';
}

function serializeNode(node, listIndent, context = 'block') {
  if (!node || !node.nodeName) return plainText(node);
  if (isStructurallyDeleted(node)) return '';

  switch (node.nodeName) {
    case 'heading': {
      const level = Number(node.getAttribute('level')) || 1;
      return `${'#'.repeat(level)} ${escapeSerializedText(inlineFromY(node), 'inline')}`;
    }
    case 'paragraph':
      // Literal text that would re-parse as structure gets its escape back
      // (see escapeSerializedText) — without it a `\* not a bullet` paragraph
      // silently becomes a list and `\_x\_` becomes italic on the next parse.
      return escapeSerializedText(inlineFromY(node), context);
    case 'codeBlock': {
      // Indented (4-space) source form round-trips indented; blank code lines
      // stay bare so whitespace strippers keep the round trip byte-stable.
      if (node.getAttribute('indented') === 'true') {
        return codeText(node).split('\n').map((l) => (l ? `    ${l}` : l)).join('\n');
      }
      const lang = node.getAttribute('language') || '';
      const text = codeText(node);
      // A content line that could itself read as a fence (3+ backticks at up
      // to 3 spaces of indent) would close this block early on the next parse
      // and spill the rest of the document into code (team bug thread,
      // Aug 24). CommonMark's remedy: fence with MORE backticks than any such
      // run. Plain blocks keep the familiar three-backtick form.
      const runs = text.match(/^ {0,3}(`{3,})/gm);
      const longest = runs ? Math.max(...runs.map((r) => r.trimStart().length)) : 0;
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case 'bulletList': {
      const items = [];
      // `marker` preserves the source bullet style (`*` / `+`); default `-`.
      const style = node.getAttribute('marker');
      const bullet = style === '*' || style === '+' ? style : '-';
      for (let i = 0; i < node.length; i += 1) {
        const item = serializeListItem(node.get(i), `${bullet} `, listIndent);
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
      return node.getAttribute('marker') || '---';
    case 'frontmatter':
      // Verbatim — codeText, not plainText, so nothing is `<...>`-stripped.
      return codeText(node);
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
    // List items use the item escape contexts: the leading paragraph's first
    // line is consumed as the item's inline text (never misread), while every
    // later line lands in parseListAt's nesting scan.
    const rendered = serializeNode(child, indent + 1, first ? 'itemFirst' : 'item');
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
  const visibleTitle = hasTitlePara ? escapeSerializedText(inlineFromY(titleNode), 'inline').trim() : '';
  const title = visibleTitle && (titleExplicit || visibleTitle !== defaultTitle)
    ? ` ${visibleTitle}` : '';

  // Seed with the header line, then append each body block honoring its
  // blankBefore. The header→first-body gap defaults to 0 (a single-line
  // `> [!note] Title\n> body` has no blank) — the blank form carries an explicit
  // blankBefore=1. Gaps between body blocks default to 1: two paragraphs always
  // need a blank line, so an in-editor block with none still separates cleanly.
  const bodyChildren = children.slice(hasTitlePara ? 1 : 0);
  let text = `[!${calloutType}]${marker}${title}`;
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
  const aligns = [];
  for (let i = 0; i < node.length; i += 1) {
    const row = node.get(i);
    if (!row || row.nodeName !== 'tableRow' || isStructurallyDeleted(row)) continue;
    const cells = [];
    for (let j = 0; j < row.length; j += 1) {
      const cell = row.get(j);
      if (isStructurallyDeleted(cell)) continue;
      // Column alignment is read off the first surviving row (the header).
      if (rows.length === 0) aligns.push(cell.getAttribute?.('align') ?? null);
      cells.push(serializeTableCell(cell));
    }
    rows.push(cells);
  }
  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map((r) => r.length), 1);
  const pad = (cells) => cells.concat(
    Array.from({ length: Math.max(0, colCount - cells.length) }, () => ''),
  );
  const renderRow = (cells) => `| ${pad(cells).join(' | ')} |`;
  const sepCell = (a) =>
    (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---');
  const separator = `| ${Array.from({ length: colCount }, (_, c) => sepCell(aligns[c])).join(' | ')} |`;
  return [renderRow(rows[0]), separator, ...rows.slice(1).map(renderRow)].join('\n');
}

function serializeTableCell(node) {
  if (!node || isStructurallyDeleted(node)) return '';
  const parts = [];
  for (let i = 0; i < node.length; i += 1) {
    const child = node.get(i);
    const rendered = child?.nodeName === 'paragraph'
      ? escapeSerializedText(inlineFromY(child), 'inline')
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
const MARK_ORDER = ['link', 'highlight', 'strike', 'underline', 'subscript', 'superscript', 'bold', 'italic', 'code'];
const MARK_TOKEN = { highlight: '==', strike: '~~', bold: '**', italic: '*', code: '`' };
// Marks with no markdown syntax serialize as their inline-HTML tag — the same
// Obsidian-compatible subset the parser recognizes, so they round-trip.
const MARK_TAG = { underline: 'u', subscript: 'sub', superscript: 'sup' };
const markOpen = (m) => (m.name === 'link' ? '[' : MARK_TAG[m.name] ? `<${MARK_TAG[m.name]}>` : MARK_TOKEN[m.name]);
const markClose = (m) => (m.name === 'link' ? `](${m.href})` : MARK_TAG[m.name] ? `</${MARK_TAG[m.name]}>` : MARK_TOKEN[m.name]);

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
    for (let k = stack.length - 1; k >= idx; k -= 1) out += markClose(stack[k]);
    stack = stack.slice(0, idx);
  };
  for (let i = 0; i < node.length; i += 1) {
    const child = node.get(i);
    if (child && child.nodeName === 'hardBreak') {
      // A pending structural deletion projects as though the break were
      // accepted: join the surrounding inline runs without emitting a marker.
      if (isStructurallyDeleted(child)) continue;
      // Marks never span a hard break in the serialized form, so close
      // everything before the marker. A `<br>`-form break is inline within its
      // source line — emit the tag with no newline; `  ` / `\` / soft markers
      // are line breaks.
      closeFrom(0);
      const marker = child.getAttribute?.('marker') || '';
      out += /^<br/i.test(marker) ? marker : `${marker}\n`;
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
        out += markOpen(marks[k]);
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
