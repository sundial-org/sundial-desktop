import * as Y from 'yjs';
import { CODE_TEXT_ROOT, ensureCodeText, readCodeText, seedClientId } from './code_text.mjs';

// CRDT-anchored suggestions for CODE / LaTeX (Y.Text) files — the Monaco analog
// of the markdown insertion/deletion marks, and the code half of the ONE unified
// change ledger (see lib/workspace/change-ledger.ts). The accepted (optimistic)
// text lives in the code Y.Text; each suggested change is an entry in a sibling
// Y.Map keyed by `${id}#${n}`, holding Yjs RELATIVE positions that bracket the
// inserted span plus the removed text. Relative positions survive concurrent
// edits, so a suggestion is NEVER re-located by text-matching — this is what
// replaces the brittle `pending-hunks-match` path that caused the #600-class
// bugs for code, and what makes the overlay render instantly (it's CRDT content,
// not a server poll).
//
// `resolveCodeSuggestions` returns entries shaped like `PendingChange` so the
// Monaco renderer + review panel consume the same model as markdown.
export const CODE_SUGGESTIONS_ROOT = 'codesuggestions';
// Resolution tombstones: suggestion id → 'accept' | 'reject'. Written when an
// entry is accepted/rejected (editor ✓/✕ OR the chat-card/review-panel route, via
// the same accept/rejectCodeSuggestion). The read path uses these to tell a
// RESOLVED suggestion (entry gone, tombstone present → read-only) from a LEGACY
// pre-flag row that was never staged (no entry, no tombstone → content_text
// fallback) — a per-id distinction the document-level ledger probe couldn't make.
export const CODE_RESOLVED_ROOT = 'codesuggestions_resolved';

function suggestionsMap(doc) {
  return doc.getMap(CODE_SUGGESTIONS_ROOT);
}

function resolvedMap(doc) {
  return doc.getMap(CODE_RESOLVED_ROOT);
}

// The recorded decision for a suggestion id, or null if it was never resolved
// through the ledger (live, or a legacy never-staged row).
export function codeSuggestionResolution(doc, id) {
  const v = resolvedMap(doc).get(id);
  return v === 'accept' || v === 'reject' ? v : null;
}

// Split into line tokens that KEEP their trailing newline ("a\n", "b\n", "c"),
// so a hunk's char range and text are exact concatenations — no trailing-newline
// guesswork (the classic line-diff bug).
function splitLinesKeepingEol(text) {
  return text.length ? text.match(/[^\n]*\n|[^\n]+$/g) ?? [] : [];
}

// Line-level diff of old→new into ascending, non-overlapping hunks in OLD-text
// character coordinates: { at, deleted, inserted }. Line granularity keeps each
// changed region its own reviewable hunk; a run of adjacent changed lines stays
// one hunk. Tokens carry their newline, so `deleted`/`inserted` are exact slices.
// Cap on the O(n·m) LCS table. A near-total rewrite of a few-thousand-line file
// would otherwise allocate hundreds of MB of Uint32 and can OOM the Hocuspocus
// process (the request is well under the body cap, so nothing else catches it).
// ~16M cells ≈ 64 MB — comfortably safe; past it we emit one coarse hunk. (Codex)
const LCS_CELL_CAP = 16_000_000;

export function lineDiffHunks(oldText, newText) {
  const a = splitLinesKeepingEol(oldText);
  const b = splitLinesKeepingEol(newText);
  // Trim the common leading/trailing lines (O(n)) so the quadratic LCS only runs
  // on the changed middle — a handful of edited lines in a huge file stays cheap,
  // and the result is identical (trimmed lines are never part of a hunk anyway).
  const aLen = a.length;
  const bLen = b.length;
  let lo = 0;
  while (lo < aLen && lo < bLen && a[lo] === b[lo]) lo += 1;
  let aHi = aLen;
  let bHi = bLen;
  while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) { aHi -= 1; bHi -= 1; }
  let prefixChars = 0;
  for (let k = 0; k < lo; k += 1) prefixChars += a[k].length;
  const n = aHi - lo;
  const m = bHi - lo;
  if (n === 0 && m === 0) return [];
  // Pure insertion / deletion, or a rewrite too large to align line-by-line:
  // one coarse hunk covering the whole changed middle. (Codex — OOM guard)
  if (n === 0 || m === 0 || n * m > LCS_CELL_CAP) {
    const deleted = a.slice(lo, aHi).join('');
    const inserted = b.slice(lo, bHi).join('');
    return deleted === inserted ? [] : [{ at: prefixChars, deleted, inserted }];
  }
  // Index into the trimmed middle so dp/aStart stay bounded; `at` offsets re-add
  // the prefix char length to keep OLD-text coordinates.
  const aOff = lo;
  const bOff = lo;
  const ai = (i) => a[aOff + i];
  const bj = (j) => b[bOff + j];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = ai(i) === bj(j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const aStart = new Array(n + 1);
  aStart[0] = prefixChars;
  for (let i = 0; i < n; i += 1) aStart[i + 1] = aStart[i] + ai(i).length;

  const hunks = [];
  let i = 0;
  let j = 0;
  let runStart = -1; // old-token index where the current change run began
  let removed = [];
  let added = [];
  const flush = () => {
    if (runStart < 0) return;
    hunks.push({ at: aStart[runStart], deleted: removed.join(''), inserted: added.join('') });
    runStart = -1;
    removed = [];
    added = [];
  };
  const open = () => { if (runStart < 0) runStart = i; };
  while (i < n && j < m) {
    if (ai(i) === bj(j)) {
      flush();
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      open();
      removed.push(ai(i));
      i += 1;
    } else {
      open();
      added.push(bj(j));
      j += 1;
    }
  }
  while (i < n) { open(); removed.push(ai(i)); i += 1; }
  while (j < m) { open(); added.push(bj(j)); j += 1; }
  flush();
  return hunks;
}

// Converge the code Y.Text to `newText` via MINIMAL line-diff edits (no ledger
// entry), preserving the relative-position anchors of any live suggestions in the
// same file — unlike replaceCodeText's wholesale delete+insert. Returns true when
// it mutated.
export function applyCodeTextDirect(doc, newText) {
  const ytext = ensureCodeText(doc);
  const oldText = readCodeText(doc) ?? '';
  if (oldText === newText) return false;
  const hunks = lineDiffHunks(oldText, newText);
  if (hunks.length === 0) return false;
  doc.transact(() => {
    for (const h of [...hunks].reverse()) {
      if (h.deleted.length) ytext.delete(h.at, h.deleted.length);
      if (h.inserted.length) ytext.insert(h.at, h.inserted);
    }
  });
  return true;
}

// Normalize the attribution we persist on each entry. Accepts the unified
// ChangeAttribution keys; tolerates the legacy {author,turnId} for callers not
// yet migrated.
function normalizeMeta(meta = {}) {
  return {
    authorId: meta.authorId ?? meta.author ?? null,
    agentTurnId: meta.agentTurnId ?? meta.turnId ?? null,
    chatId: meta.chatId ?? null,
    authorLabel: meta.authorLabel ?? null,
  };
}

// Apply a code suggest-edit (oldText→newText) as sidecar suggestions: the Y.Text
// is moved to the optimistic (accepted) text, and one entry per hunk records the
// inserted span (as relative positions) + the removed text + attribution.
// Assumes the live Y.Text currently equals `oldText`. Returns true when it
// recorded anything. `createdAt` is supplied by callers that need determinism;
// it defaults to 0 (the codec never relies on wall-clock).
export function applyCodeSuggestion(doc, oldText, newText, id, meta = {}, createdAt = 0) {
  if (oldText === newText) return false;
  const ytext = ensureCodeText(doc);
  const hunks = lineDiffHunks(oldText, newText);
  if (hunks.length === 0) return false;
  const map = suggestionsMap(doc);
  // Guard overlapping suggestions (Codex P2): if a new hunk touches the live
  // inserted span of an existing unresolved entry, mutating here would leave that
  // entry's anchors bracketing text we're about to delete — a later reject would
  // then restore/duplicate the wrong text. Supersede: reject the overlapping
  // entries first (restoring their baseline into the buffer), then re-diff from
  // the restored buffer so the new entry's deletedText captures the TRUE original
  // and sibling suggestions stay isolated. (oldText == the live buffer here, so
  // hunk offsets and entry anchors share one coordinate system.)
  // Collect overlapping ENTRY KEYS, not suggestion ids: a MultiEdit/whole-file
  // suggestion has several distant hunks under ONE id, and rejecting by id would
  // revert the unrelated sibling hunks too. Reject only the hit entries. (Codex P1)
  const overlappingKeys = new Set();
  for (const h of hunks) {
    const dStart = h.at;
    const dEnd = h.at + h.deleted.length;
    for (const s of resolveCodeSuggestions(doc)) {
      const hit = dEnd > dStart
        ? dStart < s.anchor.end && s.anchor.start < dEnd // deleted range intersects
        : dStart > s.anchor.start && dStart < s.anchor.end; // pure insertion strictly inside
      if (hit) overlappingKeys.add(s.key);
    }
  }
  if (overlappingKeys.size > 0) {
    for (const key of overlappingKeys) rejectCodeSuggestion(doc, key);
    return applyCodeSuggestion(doc, readCodeText(doc) ?? '', newText, id, meta, createdAt);
  }
  const attribution = normalizeMeta(meta);
  // Mint the Y.Text + Y.Map ops under a clientID deterministic in (base state,
  // suggestion id, target text), mirroring applyContentTextIfChanged. When the
  // poll / cold-load re-derives the same content_text suggest row (two Hocuspocus
  // instances, or a restart racing a reconnecting client before ydoc_state
  // persists), both derivations mint byte-identical ops that Yjs dedupes instead
  // of merging two copies of the same insertion. (Codex P2)
  const prevClient = doc.clientID;
  doc.clientID = seedClientId(`${id} ${newText}`, Y.encodeStateVector(doc));
  try {
    doc.transact(() => {
      // Edit right-to-left so each hunk's `at` (old-text coords) stays valid.
      let n = hunks.length;
      for (const h of [...hunks].reverse()) {
        n -= 1;
        if (h.deleted.length) ytext.delete(h.at, h.deleted.length);
        if (h.inserted.length) ytext.insert(h.at, h.inserted);
        const from = Y.createRelativePositionFromTypeIndex(ytext, h.at);
        const to = Y.createRelativePositionFromTypeIndex(ytext, h.at + h.inserted.length);
        const entry = new Y.Map();
        entry.set('id', id);
        entry.set('from', Y.encodeRelativePosition(from));
        entry.set('to', Y.encodeRelativePosition(to));
        entry.set('deletedText', h.deleted);
        entry.set('authorId', attribution.authorId);
        entry.set('agentTurnId', attribution.agentTurnId);
        entry.set('chatId', attribution.chatId);
        entry.set('authorLabel', attribution.authorLabel);
        entry.set('createdAt', createdAt);
        map.set(`${id}#${n}`, entry);
      }
    });
  } finally {
    doc.clientID = prevClient;
  }
  return true;
}

function kindOf(deletedText, insertedLen) {
  if (deletedText && insertedLen > 0) return 'modify';
  if (insertedLen > 0) return 'insert';
  return 'delete';
}

// Resolve every live suggestion to absolute offsets in the current Y.Text, shaped
// as PendingChange: { id, key, kind, anchor:{start,end}, insertedText, deletedText,
// attribution, createdAt }. `anchor` brackets the inserted (green) span;
// `deletedText` renders as a ghost at `anchor.start`. Entries whose anchors no
// longer resolve (their span was fully removed by a later edit) are skipped.
export function resolveCodeSuggestions(doc) {
  const map = suggestionsMap(doc);
  if (map.size === 0) return [];
  const buffer = readCodeText(doc) ?? '';
  const out = [];
  for (const [key, entry] of map.entries()) {
    const fromBytes = entry.get('from');
    const toBytes = entry.get('to');
    if (!fromBytes || !toBytes) continue;
    const from = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBytes), doc);
    const to = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(toBytes), doc);
    if (!from || !to) continue;
    const start = from.index;
    const end = to.index;
    const deletedText = entry.get('deletedText') ?? '';
    out.push({
      id: entry.get('id'),
      key,
      kind: kindOf(deletedText, end - start),
      anchor: { start, end },
      insertedText: buffer.slice(start, end),
      deletedText,
      attribution: {
        authorId: entry.get('authorId') ?? null,
        agentTurnId: entry.get('agentTurnId') ?? null,
        chatId: entry.get('chatId') ?? null,
        authorLabel: entry.get('authorLabel') ?? null,
      },
      createdAt: entry.get('createdAt') ?? 0,
    });
  }
  return out.sort((a, b) => a.anchor.start - b.anchor.start);
}

// Accept: the optimistic text is already in the buffer, so just drop the entry
// and tombstone the decision. Pass a bare suggestion id to accept every hunk that
// shares it. `origin` tags the transaction so an editor's Y.UndoManager can scope
// the decision into its undo stack (Cmd+Z returns the suggestion to pending);
// undefined → Yjs's default (null), unchanged for every non-editor caller.
export function acceptCodeSuggestion(doc, idOrKey, options = {}) {
  const { origin } = options;
  const map = suggestionsMap(doc);
  const resolved = resolvedMap(doc);
  doc.transact(() => {
    for (const key of matchingKeys(map, idOrKey)) {
      const sid = map.get(key)?.get('id');
      if (sid != null) resolved.set(sid, 'accept');
      map.delete(key);
    }
  }, origin);
}

// Reject: restore the removed text and delete the inserted span for each matching
// entry, then drop it — returning the buffer to its pre-suggestion state. Edits
// run right-to-left (highest offset first) so earlier offsets stay valid.
//
// `tombstone: false` does the same buffer restore + entry drop WITHOUT recording a
// 'reject' decision — used by the live suggest-mode staging path, which restores
// its own run's baseline before re-diffing every keystroke (it is rewriting the
// suggestion, NOT rejecting it; tombstoning here would mark the still-live run
// rejected and churn its id every keystroke).
export function rejectCodeSuggestion(doc, idOrKey, options = {}) {
  const { tombstone = true, origin } = options;
  const map = suggestionsMap(doc);
  const resolved = resolvedMap(doc);
  const ytext = doc.getText(CODE_TEXT_ROOT);
  doc.transact(() => {
    const keys = matchingKeys(map, idOrKey);
    const ops = [];
    for (const key of keys) {
      const entry = map.get(key);
      const sid = entry.get('id');
      if (tombstone && sid != null) resolved.set(sid, 'reject');
      const fromBytes = entry.get('from');
      const toBytes = entry.get('to');
      const from = fromBytes && Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBytes), doc);
      const to = toBytes && Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(toBytes), doc);
      if (from) ops.push({ start: from.index, end: to ? to.index : from.index, deletedText: entry.get('deletedText') ?? '' });
      map.delete(key);
    }
    ops.sort((a, b) => b.start - a.start);
    for (const op of ops) {
      if (op.end > op.start) ytext.delete(op.start, op.end - op.start);
      if (op.deletedText) ytext.insert(op.start, op.deletedText);
    }
  }, origin);
}

function matchingKeys(map, idOrKey) {
  if (map.has(idOrKey)) return [idOrKey]; // exact key
  const keys = [];
  for (const key of map.keys()) {
    if (map.get(key)?.get('id') === idOrKey) keys.push(key);
  }
  return keys;
}

// True when the doc carries any live code suggestion (the idempotency guard for
// the poll/cold-load apply, mirroring hasSuggestionMark for markdown).
export function hasCodeSuggestion(doc, id) {
  const map = suggestionsMap(doc);
  if (!id) return map.size > 0;
  for (const key of map.keys()) if (map.get(key)?.get('id') === id) return true;
  return false;
}

// The accepted projection's text — just the current Y.Text, since deletions
// already live out-of-buffer in the sidecar.
export function codeAcceptedText(doc) {
  return readCodeText(doc) ?? '';
}

// True when the file carries HUMAN code-suggestion ledger state — a live human
// entry (no `agentTurnId`) OR a human resolution tombstone (an id minted by the
// editor staging / poll fallback: `human-local-*` / `poll-*`). This is the signal
// that the ledger is the source of truth for this file's HUMAN suggestions, so a
// content_text human run is a stale duplicate (live) or an accepted one (tombstone)
// and must be suppressed. A file with ONLY agent ledger state — or none — returns
// false, so a human's legacy/fallback content_text suggestion still surfaces for
// review instead of being dropped. (Codex P2)
export function hasHumanCodeLedgerState(doc) {
  // Human ledger ids (`human-*`) — the exact set `humanCodeSuggestionRunsFromLedger`
  // emits and the keep/undo routes resolve: editor-minted `human-local-*` AND a
  // `human-<rowId>` materialized from a no-tool_call_id human suggest row on
  // poll/cold-load. NOT a markdown `poll-*` (never in the CODE ledger) and NOT a
  // local-agent `a<ts>` / tool_call_id entry (agentTurnId-null but not human; stays
  // on the content_text path). Keying off the `human-` prefix avoids both. (Codex P1/P2)
  const isHumanId = (id) => typeof id === 'string' && id.startsWith('human-');
  for (const [, entry] of suggestionsMap(doc).entries()) {
    if (isHumanId(entry.get('id'))) return true;
  }
  for (const id of resolvedMap(doc).keys()) {
    if (isHumanId(id)) return true;
  }
  return false;
}
