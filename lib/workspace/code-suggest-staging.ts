// Instant client-side staging of a user's suggest-mode edits in the Monaco /
// LaTeX editor — the code analog of the markdown marks model. The markdown
// editor wraps each keystroke into tracked insertion/deletion MARKS in the same
// synchronous transaction (see lib/workspace/suggestion-marks.ts); code/LaTeX get
// the same "instant" guarantee here by writing the change straight into the CRDT
// code-suggestion ledger (lib/crdt-js/code_suggestions.mjs) on the keystroke,
// with no await and no server round-trip. The green addition lines + red deletion
// ghosts then paint from the live ledger on the same tick (the renderer's
// suggestionsMap observer fires synchronously inside applyCodeSuggestion's
// transaction), instead of waiting on the doc_edits poll.
import type * as Y from 'yjs';
import {
  applyCodeSuggestion,
  rejectCodeSuggestion,
  codeSuggestionResolution,
} from '@/lib/crdt-js/code_suggestions.mjs';
import { readCodeText } from '@/lib/crdt-js/code_text.mjs';

export type CodeSuggestMeta = {
  authorId?: string | null;
  authorLabel?: string | null;
  chatId?: string | null;
};

// Mutable per-editor run state: the ledger id the user's current typing burst is
// being coalesced into. Held across keystrokes so a whole burst reviews as ONE
// Keep/Undo unit (mirrors the server's per-run grouping for human suggestions).
export type CodeSuggestRunState = { runId: string | null };

let runSeq = 0;
function freshHumanLocalId(): string {
  runSeq += 1;
  // A per-client random component: the id is written into the SHARED, synced
  // Y.Map (`${id}#${n}`) and resolved by id, so two sessions starting a burst in
  // the same millisecond must not mint the same id — otherwise one user's entry
  // overwrites the other's, or one accept/reject resolves both. `human-` prefix so
  // the editor overlay collapses the burst into one review pill (isHumanReviewId);
  // colon-free so it survives the `id:chunk` key split.
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `human-local-${rand}-${runSeq}`;
}

// Map a Keep/Undo pill's `data-key` to the ledger suggestion id it should
// accept/reject, or null when the pill is NOT a live ledger suggestion (so the
// caller falls back to the server-prop route). A grouped pill (human runs)
// carries the synthetic `${groupKey}:*` key — not a real per-hunk ledger key —
// so it's matched against the ledger GROUP set and resolved by its bare id
// (acceptCodeSuggestion/rejectCodeSuggestion match every `${id}#n` entry).
// Per-hunk pills resolve by their chunk's shared groupKey so a multi-hunk turn
// resolves as ONE unit.
export function ledgerResolveId(
  key: string,
  ledgerKeys: Set<string>,
  ledgerGroupKeys: Set<string>,
  groupKeyForKey?: (key: string) => string | undefined,
): string | null {
  if (key.endsWith(':*')) {
    const base = key.slice(0, -2);
    return ledgerGroupKeys.has(base) ? base : null;
  }
  if (ledgerKeys.has(key)) return groupKeyForKey?.(key) ?? key;
  return null;
}

// Stage the user's suggest-mode edit (the editor buffer currently equals
// `newText`) into the code-suggestion ledger SYNCHRONOUSLY. The whole burst
// coalesces into one suggestion: reject the run's prior entries (restoring the
// pre-suggestion baseline in the Y.Text), then re-stage baseline→newText under the
// same id — so fixing a typo inside your own pending insertion never spawns
// overlapping entries, and the run stays one reviewable unit. A resolved
// (kept/undone) run starts a fresh id. Returns the live run id, or null when the
// edit collapsed back to the baseline (nothing left pending).
export function stageHumanCodeEdit(
  ydoc: Y.Doc,
  newText: string,
  run: CodeSuggestRunState,
  meta: CodeSuggestMeta = {},
  mintId: () => string = freshHumanLocalId,
): string | null {
  if (!run.runId || codeSuggestionResolution(ydoc, run.runId)) run.runId = mintId();
  const runId = run.runId;
  // Restore-then-restage in ONE transaction so the ledger observer fires only
  // once, on the final state. Two transactions would render the intermediate
  // baseline-restored state (suggestion momentarily gone), blinking the red
  // deletion ghosts on every keystroke. The restore is non-tombstoning — we're
  // rewriting the suggestion, not rejecting it, so the run id stays stable across
  // the burst and never lands a spurious 'reject' on a still-live entry.
  let staged = false;
  ydoc.transact(() => {
    rejectCodeSuggestion(ydoc, runId, { tombstone: false }); // no-op for a fresh/empty run
    staged = applyCodeSuggestion(ydoc, readCodeText(ydoc) ?? '', newText, runId, meta);
  });
  if (!staged) {
    run.runId = null; // newText === baseline → user reverted; ledger is clean
    return null;
  }
  return run.runId;
}

// y-monaco's private seams we rely on (pinned ^0.1.6): the shared mutex that
// breaks the model↔Y.Text echo loop, and the model→Y.Text change subscription.
type YMonacoBinding = {
  mux?: (fn: () => void) => void;
  _monacoChangeHandler?: { dispose: () => void };
};

type MonacoModelLike = {
  getValue: () => string;
  onDidChangeContent: (cb: () => void) => { dispose: () => void };
};

// Switch a bound Monaco editor into suggest mode: suppress y-monaco's plain
// model→Y.Text mirror and route every local edit through {@link stageHumanCodeEdit}
// instead, so it lands as a tracked suggestion rather than raw text. Returns a
// disposable, or null when the y-monaco internals aren't shaped as expected (a
// version bump) — in which case the caller keeps the existing server-poll path
// rather than risk corrupting the buffer.
export function installCodeSuggestStaging(
  binding: YMonacoBinding,
  model: MonacoModelLike,
  ydoc: Y.Doc,
  getMeta: () => CodeSuggestMeta,
  // Transaction origin for the staged keystroke. Pass the editor's Y.UndoManager
  // tracked origin (the binding, mirroring y-monaco's own edit-mode mirror) so a
  // suggest-mode typing burst lands on the SAME undo stack as everything else and
  // Cmd+Z reverts it. Omitted → Yjs default (null), unchanged for non-editor uses.
  origin?: unknown,
): { dispose: () => void } | null {
  const mux = binding.mux;
  const baseHandler = binding._monacoChangeHandler;
  if (typeof mux !== 'function' || !baseHandler || typeof baseHandler.dispose !== 'function') {
    return null;
  }
  baseHandler.dispose();
  const run: CodeSuggestRunState = { runId: null };
  const sub = model.onDidChangeContent(() => {
    // Inside the binding mutex: the Y.Text writes applyCodeSuggestion makes don't
    // echo back through y-monaco's observer onto the model (which would
    // double-apply / jump the caret), and a REMOTE edit the observer is mirroring
    // to the model — already holding the mutex — is skipped here, not re-staged.
    // The outer transact carries `origin` to the whole staged change; the inner
    // transact stageHumanCodeEdit opens is nested, so it inherits this origin.
    mux(() => {
      ydoc.transact(() => {
        stageHumanCodeEdit(ydoc, model.getValue(), run, getMeta());
      }, origin);
    });
  });
  return { dispose: () => sub.dispose() };
}
