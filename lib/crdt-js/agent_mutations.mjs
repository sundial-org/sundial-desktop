import {
  applyContentTextIfChanged,
  applySuggestionIfChanged,
  canonicalizeContentText,
  hasSuggestionForId,
  isMarkdownDocument,
  readDocumentText,
} from './document_text.mjs';
import { ensureCodeText, readCodeText, seedClientId } from './code_text.mjs';

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

// Every Unicode space separator (category Zs) EXCEPT the plain ASCII space,
// folded to one ASCII space. NARROW NO-BREAK SPACE (U+202F, which macOS bakes
// into screenshot filenames → image alts) and NO-BREAK SPACE (U+00A0, ubiquitous
// in French before `: ; ! ?`) are the common offenders: readers/greps render
// them as a normal space, so an anchor typed with a normal space silently misses.
// Zero-width chars are deliberately excluded — folding them would not be
// length-preserving (the anchor has no char there at all).
const UNICODE_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
// `.replace` with a /g regex is stateless (unlike `.test`/`.exec`), so this is
// safe to reuse; returns the same string when there's nothing to fold.
const foldSpaces = (text) => text.replace(UNICODE_SPACE, ' ');

// Replace by positions found in a length-preserving `folded` projection, splicing
// the ORIGINAL bytes (so surrounding text — and any bytes the fold touched but the
// edit didn't span — are preserved verbatim). `foldSpaces` maps char→char, so a
// folded index is identical to the original index. Mirrors split/join semantics:
// `$`-patterns in the replacement are inserted literally, never interpreted.
function replaceByFoldedPositions(original, folded, foldedNeedle, replacement, replaceAll) {
  const parts = [];
  let i = 0;
  for (;;) {
    const idx = folded.indexOf(foldedNeedle, i);
    if (idx === -1) { parts.push(original.slice(i)); break; }
    parts.push(original.slice(i, idx), replacement);
    i = idx + foldedNeedle.length;
    if (!replaceAll) { parts.push(original.slice(i)); break; }
  }
  return parts.join('');
}

// Validate the anchors and produce the post-edit text. Shared by the direct
// (edit) and suggestion paths so both honor the exact-occurrence contract.
function computeEditedText(current, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw Object.assign(new Error('edits must be a non-empty array'), { status: 400 });
  }
  let totalOccurrences = 0;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] ?? {};
    const oldString = typeof edit.old_string === 'string' ? edit.old_string : '';
    const newString = typeof edit.new_string === 'string' ? edit.new_string : '';
    if (!oldString) {
      throw Object.assign(new Error(`edits[${i}].old_string must be a non-empty string`), { status: 400 });
    }
    let occurrences = countOccurrences(current, oldString);
    if (occurrences > 0) {
      if (occurrences > 1 && edit.replace_all !== true) {
        throw Object.assign(
          new Error(`edits[${i}].old_string appears ${occurrences} times; set replace_all=true or add context`),
          { status: 409, code: 'AMBIGUOUS_ANCHOR', editIndex: i },
        );
      }
      totalOccurrences += occurrences;
      // split/join (never String.prototype.replace) so `$`-patterns in
      // new_string — `$$` for LaTeX display math, `$&`, `$1` — are inserted
      // literally instead of being interpreted as replacement specials.
      current = current.split(oldString).join(newString);
      continue;
    }
    // Fallback — ONLY when the exact anchor missed, so no currently-succeeding
    // edit changes behavior: retry against a Unicode-space-folded projection so a
    // normal-space anchor still matches text carrying U+202F / nbsp / thin spaces.
    const foldedCurrent = foldSpaces(current);
    const foldedNeedle = foldSpaces(oldString);
    // Only meaningful if folding actually changed something; otherwise it's a
    // genuine miss (avoids paying the scan when there are no exotic spaces).
    occurrences = foldedNeedle === oldString && foldedCurrent === current
      ? 0
      : countOccurrences(foldedCurrent, foldedNeedle);
    if (occurrences === 0) {
      throw Object.assign(new Error(`edits[${i}].old_string not found`), {
        status: 409, code: 'ANCHOR_NOT_FOUND', editIndex: i,
      });
    }
    if (occurrences > 1 && edit.replace_all !== true) {
      throw Object.assign(
        new Error(`edits[${i}].old_string appears ${occurrences} times; set replace_all=true or add context`),
        { status: 409, code: 'AMBIGUOUS_ANCHOR', editIndex: i },
      );
    }
    totalOccurrences += occurrences;
    current = replaceByFoldedPositions(current, foldedCurrent, foldedNeedle, newString, edit.replace_all === true);
  }
  return { text: current, occurrences: totalOccurrences };
}

export function replaceDocumentForAgent(path, document, contentText) {
  const changed = applyContentTextIfChanged(path, document, contentText);
  return {
    changed,
    contentText: readDocumentText(path, document),
  };
}

// applySuggestionIfChanged is idempotent BY ID — a replayed doc_edits row must
// never re-stage a suggestion that is already staged or already resolved. That
// makes it silently return false when the id is taken, which is right for a
// replay but catastrophic for a DIRECT agent mutation: the caller changed the
// text, got `changed:false`, and the HTTP layer answered 200 for an edit that
// never landed. Direct mutations therefore fail loudly instead of dropping the
// write; the server mints a unique id per request, so this only fires when a
// caller reuses a toolCallId for a genuinely different change.
//
// Gated on the id predicate, never on `changed` alone: applySuggestionIfChanged
// also declines changes the markdown codec cannot represent as marks (blank-line
// -only diffs, prefix/suffix-consumed blocks), and those are the caller's
// direct-rail fallback, not a collision. Only runs on the `changed:false` path,
// so the canonicalize compare stays off the hot path.
function assertSuggestionStaged(path, document, changed, newText, suggestionId) {
  if (changed || !hasSuggestionForId(path, document, suggestionId)) return;
  // The id is taken. Nothing was staged, so the doc still reads as it did
  // before — identical text under the same id is an idempotent retry of the
  // same tool call, not a dropped write.
  if (canonicalizeContentText(path, readDocumentText(path, document))
    === canonicalizeContentText(path, newText)) return;
  throw Object.assign(
    new Error(
      `suggestion id ${suggestionId} is already staged or resolved; retry with a fresh tool_call_id`,
    ),
    { status: 409, code: 'SUGGESTION_ID_IN_USE' },
  );
}

// Replace the whole document as a tracked suggestion (Write in suggest mode).
// Markdown → suggestion marks; code/LaTeX → the CRDT-anchored code suggestion
// ledger. `meta` carries unified attribution (authorId / agentTurnId / chatId).
export function replaceDocumentForAgentAsSuggestion(path, document, contentText, suggestionId, meta = {}) {
  const changed = applySuggestionIfChanged(path, document, contentText, suggestionId, meta);
  assertSuggestionStaged(path, document, changed, contentText, suggestionId);
  return { changed, contentText: readDocumentText(path, document) };
}

// Positional text operations applied straight to the code Y.Text: the op-level
// rail external bridges (Overleaf live sync) use for inbound edits. Op shape
// mirrors ShareJS / lib/bridges/overleaf/live-ops: {p, i} inserts string `i` at
// UTF-16 offset `p`; {p, d} deletes string `d` at `p` (`d` must equal the text
// there). Applying ops to the live Y.Text (instead of replacing whole text)
// avoids shipping whole documents and keeps CRDT-anchored suggestion positions.
//
// Code documents only: markdown docs are block-structured (ProseMirror), so a
// flat offset has no stable meaning there, and the bridges only sync code/LaTeX.
//
// Divergence guard: `base` carries the length + FNV-1a hash (seedClientId, no
// prefix) of the exact text the caller's ops index into. If this doc's current
// text differs AT ALL (a concurrent Sundial edit, any drift), the request 409s
// BEFORE any mutation and the caller falls back to a resync. This is what makes
// insert-only batches safe: a bare insert carries nothing to content-match, so
// without the base check it would land at a stale offset silently.
//
// The whole batch is also validated against a string projection before any
// Y.Text mutation (Yjs transactions don't roll back), via the NON-mutating
// readCodeText: ensureCodeText migrates legacy docs inside a transact, so it
// must not run until the request is known to be applied.
export function applyTextOpsToDocument(path, document, ops, base) {
  if (isMarkdownDocument(path)) {
    throw Object.assign(new Error('apply-text-ops supports code documents only'), { status: 400 });
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    throw Object.assign(new Error('ops must be a non-empty array'), { status: 400 });
  }
  let projected = readCodeText(document) ?? '';
  if (base != null) {
    const baseLength = Number(base.length);
    const baseHash = Number(base.hash);
    if (!Number.isInteger(baseLength) || !Number.isInteger(baseHash)) {
      throw Object.assign(new Error('base must carry integer length and hash'), { status: 400 });
    }
    if (projected.length !== baseLength || seedClientId(projected) !== baseHash) {
      throw Object.assign(new Error('document text has diverged from the ops base'), {
        status: 409, code: 'OP_BASE_MISMATCH',
      });
    }
  }
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] ?? {};
    const isInsert = typeof op.i === 'string' && op.i.length > 0 && op.d === undefined;
    const isDelete = typeof op.d === 'string' && op.d.length > 0 && op.i === undefined;
    if ((!isInsert && !isDelete) || !Number.isInteger(op.p) || op.p < 0) {
      throw Object.assign(new Error(`ops[${i}] must be {p, i} or {p, d} with a non-negative integer p`), {
        status: 400,
      });
    }
    if (isInsert) {
      if (op.p > projected.length) {
        throw Object.assign(new Error(`ops[${i}] insert position ${op.p} out of range (len ${projected.length})`), {
          status: 409, code: 'OP_RANGE', opIndex: i,
        });
      }
      projected = projected.slice(0, op.p) + op.i + projected.slice(op.p);
    } else {
      if (projected.slice(op.p, op.p + op.d.length) !== op.d) {
        throw Object.assign(new Error(`ops[${i}] delete text does not match the document at ${op.p}`), {
          status: 409, code: 'OP_MISMATCH', opIndex: i,
        });
      }
      projected = projected.slice(0, op.p) + projected.slice(op.p + op.d.length);
    }
  }
  const codeText = ensureCodeText(document);
  for (const op of ops) {
    if (typeof op.i === 'string') codeText.insert(op.p, op.i);
    else codeText.delete(op.p, op.d.length);
  }
  return { changed: true };
}

export function applyAgentTextEdits(path, document, edits) {
  const current = readDocumentText(path, document);
  const { text, occurrences } = computeEditedText(current, edits);
  const changed = applyContentTextIfChanged(path, document, text);
  return {
    changed,
    contentText: readDocumentText(path, document),
    occurrences,
  };
}

// Suggest-mode Edit/MultiEdit: apply the change as insertion/deletion marks
// instead of replacing text. content_text still reflects the post-edit
// (accepted) view, so the agent reads the doc as if its suggestion landed.
export function applyAgentTextEditsAsSuggestion(path, document, edits, suggestionId, meta = {}) {
  const oldText = readDocumentText(path, document);
  const { text, occurrences } = computeEditedText(oldText, edits);
  // applySuggestionIfChanged routes markdown → marks, code/LaTeX → code ledger.
  const changed = applySuggestionIfChanged(path, document, text, suggestionId, meta);
  assertSuggestionStaged(path, document, changed, text, suggestionId);
  return {
    changed,
    contentText: readDocumentText(path, document),
    occurrences,
  };
}
