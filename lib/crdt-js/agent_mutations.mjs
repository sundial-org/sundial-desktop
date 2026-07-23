import {
  applyContentTextIfChanged,
  applySuggestionIfChanged,
  readDocumentText,
} from './document_text.mjs';

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

// Replace the whole document as a tracked suggestion (Write in suggest mode).
// Markdown → suggestion marks; code/LaTeX → the CRDT-anchored code suggestion
// ledger. `meta` carries unified attribution (authorId / agentTurnId / chatId).
export function replaceDocumentForAgentAsSuggestion(path, document, contentText, suggestionId, meta = {}) {
  const changed = applySuggestionIfChanged(path, document, contentText, suggestionId, meta);
  return { changed, contentText: readDocumentText(path, document) };
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
  return {
    changed,
    contentText: readDocumentText(path, document),
    occurrences,
  };
}
