import { readCodeText, replaceCodeText, seedClientId } from './code_text.mjs';
import { applyCodeSuggestion, hasCodeSuggestion, codeSuggestionResolution } from './code_suggestions.mjs';
import {
  Y,
  applyMarkdownDiff,
  applyMarkdownSuggestion,
  canonicalizeMarkdown,
  markdownSuggestionResolution,
  serializeDoc,
} from './markdown_yjs.mjs';
import { isMarkdownFile } from './sync_policy.mjs';

export const DOC_EDIT_DELETE_UPDATE = 'sundial-delete-v1';
export const DOC_EDIT_RENAME_UPDATE = 'sundial-rename-v1';

// The markdown codec self-suppresses the Yjs `warnPrematureAccess` false
// positive at its source (see `quietDetachedAccess` in markdown_yjs.mjs), so
// callers here don't need to wrap it.

export function isMarkdownDocument(documentName) {
  return isMarkdownFile(documentName);
}

// Raw serialization of the live Y.Doc, NUL included. Internal — every public
// reader strips NUL (see readDocumentText); only the NUL self-heal in
// applyContentTextIfChanged needs to see the byte to know the doc is dirty.
function serializeDocumentRaw(documentName, document) {
  return isMarkdownDocument(documentName)
    ? serializeDoc(document)
    : (readCodeText(document) ?? '');
}

const stripNul = (text) => (text.includes('\0') ? text.replace(/\0/g, '') : text);

export function readDocumentText(documentName, document) {
  // A NUL can live in the live Y.Doc (seeded from a raw import, pasted into a
  // code editor) but not in the `content_text` mirror this feeds — Postgres
  // `text` rejects it ("unsupported Unicode escape sequence"), which would fail
  // every Hocuspocus persist. Strip it here, the second content_text producer
  // alongside `canonicalizeContentText`. Cheap no-op when absent.
  return stripNul(serializeDocumentRaw(documentName, document));
}

// Set a live Y.Doc's text. For markdown this reconciles block-by-block
// (`applyMarkdownDiff`) so untouched blocks keep their CRDT identity and a
// concurrent editor's other-block edits survive; the serialized result is
// identical to a full reinsert. Code files replace the single Y.Text wholesale
// (a no-op when unchanged). Used by the Hocuspocus poll, the sandbox sync
// client, and cold-load seeding alike.
export function replaceDocumentText(documentName, document, text) {
  if (isMarkdownDocument(documentName)) {
    applyMarkdownDiff(document, text);
  } else {
    replaceCodeText(document, text);
  }
}

// seedClientId — content-derived clientID (FNV-1a, 32-bit) for cold-load text
// seeding. Moved to the leaf code_text.mjs (yjs-only, imported above) so the
// code-suggestion ledger can reuse it without pulling the markdown codec into the
// Monaco client bundle; re-exported here for this module's existing callers.
export { seedClientId };

// Seed an EMPTY live Y.Doc from canonical text (the Hocuspocus cold-load
// text-fallback). Building straight into the live doc mints ops under its
// random per-lifetime clientID; if two server lifetimes both hit this branch
// (e.g. the seed persist failed, so the next cold-load again finds no
// ydoc_state), each is a distinct "insert at position 0" branch and a
// reconnecting cached client merges them into a doubled doc (the welcome.md
// bug). Building in a scratch doc keyed to seedClientId(text) makes the seed
// deterministic, so Yjs dedupes a second identical seed as a no-op. The live
// doc keeps its own clientID, so genuine edits still merge (and never get
// dropped) the normal way.
export function seedDocumentFromText(documentName, document, text) {
  const scratch = new Y.Doc();
  scratch.clientID = seedClientId(text);
  try {
    replaceDocumentText(documentName, scratch, text);
    Y.applyUpdate(document, Y.encodeStateAsUpdate(scratch));
  } finally {
    scratch.destroy();
  }
}

// content_text rows must equal what `readDocumentText` produces for the
// post-parse Y.Doc. Without this, agent writes (raw `\n\n\n\n` blank lines)
// don't match the Y.Doc's serialized form (collapsed `\n\n`), Hocuspocus's
// onLoadDocument catch-up sees a phantom diff, runs replaceDocumentText
// under a fresh server clientID, and a reconnecting cached client merges
// the two parallel "insert at position 0" branches — content doubles.
export function canonicalizeContentText(documentName, text) {
  // Postgres `text` (content_text) and the JSON-RPC transport both reject NUL
  // (U+0000 → "unsupported Unicode escape sequence"), so strip it for every
  // file type before it can fail the persist. NUL carries no meaning in a text
  // document; a stray one (e.g. a binary-ish entry uploaded as text) shouldn't
  // sink the write. Stripping here keeps both sides of every later compare
  // (applyContentTextIfChanged, the onLoad catch-up) consistent.
  if (text.includes('\0')) text = text.replace(/\0/g, '');
  if (!isMarkdownDocument(documentName)) return text;
  // Iterate to the fixed point (shared with the codec CLI + sync client) — a
  // single parse→serialize isn't always idempotent, and every writer must agree
  // on the same canonical form or onLoad/diff sees a phantom re-canonicalization.
  return canonicalizeMarkdown(text);
}

// Apply a `content_text` row to a live Y.Doc (the doc_edits poll and the
// cold-load catch-up), but only when it differs from what the doc already
// holds. The no-op case is common — the poll routinely races a client's own
// just-persisted edit — so a raw-equality fast path skips all codec work, and
// the full compare canonicalizes BOTH sides: the live Y.Doc can serialize to a
// non-canonical string (e.g. a browser edit leaves a structure that re-parses
// differently), so comparing `incoming` against the raw live serialization
// would miss real no-ops and fire a needless destructive replace. Loop-safe
// because `canonicalizeContentText` is idempotent (see the document-text
// test). Returns true when mutated.
//
// A real apply re-derives ops from text against existing history — the
// welcome.md-doubling primitive. So both the ops and the clientID they're
// minted under are made a pure function of (base state vector, canonical
// content): the canonical form is what gets applied, under a deterministic
// id scoped to base + canonical content. Any two derivations of the same row
// from the same base — a cold-load catch-up re-run after a failed persist, a
// poll replay, a restart racing a reconnecting cached client — produce
// byte-identical ops that Yjs dedupes instead of concatenating. The id folds
// the base state vector, not just the content, so derivations from different
// bases can never share struct IDs (the Codex-P1 stranded-client trap).
export function applyContentTextIfChanged(documentName, document, contentText) {
  // Serialize once (raw), then derive the stripped form locally.
  const raw = serializeDocumentRaw(documentName, document);
  const liveHasNul = raw.includes('\0');
  const liveRaw = liveHasNul ? stripNul(raw) : raw;
  // The no-op fast paths skip codec work for the common case — but NEVER when
  // the live Y.Doc still carries a NUL. ydoc_state_text (preferred on cold load)
  // can hold a NUL that the stripped content_text mirror lost; if we no-op'd, the
  // doc would keep resurrecting the invalid byte. Fall through to rewrite it with
  // the clean content so the next ydoc_state refresh drops the NUL for good.
  if (!liveHasNul && contentText === liveRaw) return false;
  const incoming = canonicalizeContentText(documentName, contentText);
  if (!liveHasNul && incoming === canonicalizeContentText(documentName, liveRaw)) return false;
  const prev = document.clientID;
  document.clientID = seedClientId(incoming, Y.encodeStateVector(document));
  try {
    replaceDocumentText(documentName, document, incoming);
  } finally {
    document.clientID = prev;
  }
  return true;
}

// True if the live doc already carries inline or structural suggestion state
// for this id. The idempotency guard for the suggest-mode poll apply: a replayed
// row (cold-load catch-up, poll replay after a restart) must not re-mark content
// that's already pending. Scans the XmlFragment the same way resolveSuggestion
// does, but read-only.
export function hasSuggestionMark(document, id) {
  if (!id) return false;
  // All three inline mark types carry the suggestion id; atomic and empty
  // blocks carry the same identity in durable node attributes. Keep this probe
  // in exact correspondence with resolveSuggestion, which clears both forms.
  return scanSuggestionMarks(document, (a) =>
    Boolean(
      (a.insertion && a.insertion.id === id) ||
        (a.deletion && a.deletion.id === id) ||
        (a.modification && a.modification.id === id) ||
        a.suggestionInsertionId === id ||
        a.suggestionDeletionId === id ||
        (Array.isArray(a.suggestionModifications) && a.suggestionModifications.some((mod) => mod?.id === id)),
    ),
    { includeElementAttributes: true },
  );
}

// True if the live doc carries ANY suggestion mark, whatever its id. Editor-
// created human suggestions carry the suggestion library's own mark ids (not
// the doc_edits row id), so per-id checks can't see them — a whole-file "is
// anything still pending here" is the only mark truth available for human runs.
// Element attributes count here (a suggested empty block has no inline text to
// mark): this probe only PINS runs — resolved in the editor by the library that
// owns that representation — so unlike the per-id probe it cannot zombie.
export function hasAnySuggestionMark(document) {
  return scanSuggestionMarks(
    document,
    (a) => Boolean(
      a.insertion || a.deletion || a.modification ||
      a.suggestionInsertionId != null || a.suggestionDeletionId != null ||
      (Array.isArray(a.suggestionModifications) && a.suggestionModifications.length > 0),
    ),
    { includeElementAttributes: true },
  );
}

function scanSuggestionMarks(document, match, { includeElementAttributes = false } = {}) {
  const fragment = document.getXmlFragment('default');
  let found = false;
  const visit = (node) => {
    if (found || !node) return;
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta()) {
        if (match(op.attributes || {})) {
          found = true;
          return;
        }
      }
      return;
    }
    if (
      includeElementAttributes &&
      typeof node.getAttributes === 'function' &&
      match(node.getAttributes() || {})
    ) {
      found = true;
      return;
    }
    if (typeof node.get === 'function' && node.length != null) {
      for (let i = 0; i < node.length && !found; i += 1) visit(node.get(i));
    }
  };
  for (let i = 0; i < fragment.length && !found; i += 1) visit(fragment.get(i));
  return found;
}

// Apply a suggest-mode content_text row as suggestion MARKS rather than a direct
// block replace. `contentText` is the OPTIMISTIC (accepted) projection of the
// edit; `readDocumentText` projects the live doc to that same accepted view, so
// diffing one against the other (via applyMarkdownSuggestion) recovers exactly
// what changed and lands it as insertion/deletion marks. Returns true when it
// mutated the doc.
//
// Idempotent two ways: (1) if a mark with this id already exists, skip (a
// replayed row); (2) even without the id guard, once the marks are present the
// accepted view already equals contentText, so applyMarkdownSuggestion's
// oldText === newText early-return makes a re-apply a no-op.
//
// Code / LaTeX route through the CRDT-anchored code suggestion ledger
// (code_suggestions.mjs) — the Monaco analog of marks — instead of a silent
// direct apply, so an agent/sandbox/local-agent code suggestion renders as a
// pending, reviewable, instant overlay just like markdown. `meta` carries the
// unified attribution (authorId / agentTurnId / chatId) onto the ledger entry.
export function applySuggestionIfChanged(documentName, document, contentText, suggestionId, meta = {}) {
  if (!isMarkdownDocument(documentName)) {
    // Idempotent against the poll / cold-load re-seeing a suggest row: skip if the
    // suggestion is already staged (live entry) OR already resolved (tombstone) —
    // without the tombstone check, a re-applied row would re-stage a suggestion
    // the user already accepted/rejected.
    if (hasCodeSuggestion(document, suggestionId) || codeSuggestionResolution(document, suggestionId)) return false;
    const oldText = readDocumentText(documentName, document);
    return applyCodeSuggestion(document, oldText, contentText, suggestionId, meta);
  }
  if (hasSuggestionMark(document, suggestionId) || markdownSuggestionResolution(document, suggestionId)) {
    return false;
  }
  const oldText = readDocumentText(documentName, document);
  return applyMarkdownSuggestion(document, oldText, contentText, suggestionId);
}

// The ledger/marks id a suggest-mode `doc_edits` row stages under: an agent turn
// keys on its `tool_call_id`; a human suggest row (no tool_call_id) keys on
// `human-<rowId>` for CODE/LaTeX — so its ledger entry is resolvable by the
// chat-card / keep-undo APIs (PR #655) — and on `poll-<rowId>` for markdown
// (whose marks carry the library's own id). Single source for both the apply and
// the cold-load baseline guard.
export function suggestRowId(documentName, row) {
  return row.tool_call_id || (isMarkdownDocument(documentName) ? `poll-${row.id}` : `human-${row.id}`);
}

export function applyPolledDocEditRow(documentName, document, row) {
  // Rename signal rows are addressed to the sandbox sidecar (they carry the
  // file text at rename time so diff baselines stay correct). The live doc at
  // the new path already holds the flushed state — applying the row here
  // could only revert keystrokes typed since the rename.
  if (row?.update_bytes === DOC_EDIT_RENAME_UPDATE) {
    return { kind: 'skipped', applied: false };
  }
  if (typeof row?.content_text === 'string') {
    // A suggest-mode row from the sandbox / a local agent carries the optimistic
    // (accepted) projection in content_text. Materialize it as suggestion marks
    // so it shows up as a pending suggestion — identical to the live-Y.Doc path
    // human + Sunny-Tier-1 edits already use — instead of a silent direct
    // replace. edit-mode rows keep the byte-identical direct apply below.
    if (row?.edit_mode === 'suggest') {
      return {
        kind: 'suggestion',
        applied: applySuggestionIfChanged(
          documentName,
          document,
          row.content_text,
          suggestRowId(documentName, row),
          { authorId: row.author_id ?? null, agentTurnId: row.assistant_message_id ?? null, chatId: row.chat_id ?? null },
        ),
      };
    }
    return {
      kind: 'content_text',
      applied: applyContentTextIfChanged(documentName, document, row.content_text),
    };
  }
  if (row?.content_text === null && row?.update_bytes === DOC_EDIT_DELETE_UPDATE) {
    return {
      kind: 'delete',
      applied: applyContentTextIfChanged(documentName, document, ''),
    };
  }
  return { kind: 'skipped', applied: false };
}
