// Durable accept/reject decision events for suggestions, recorded at the ONE
// point every surface converges on: the live Y.Doc. Resolutions land in two
// resolved-maps (markdown marks: `markdownsuggestions_resolved`, code ledger:
// `codesuggestions_resolved`) whether they come from the editor's inline ✓/✕
// (a websocket update), the chat card / review panel (`/agent/resolve-suggestion`),
// or the desktop bridge. The maps alone say only WHAT was decided — this module
// diffs them per applied update and emits `activity_events` rows carrying WHO
// (the connection/token identity) and WHEN, keyed by suggestion id (= the
// suggest write's tool_call_id, so decisions join back to doc_edits/turns).

import { MARKDOWN_RESOLVED_ROOT } from './markdown_yjs.mjs';
import { CODE_RESOLVED_ROOT } from './code_suggestions.mjs';

const DECISION_TYPES = { accept: 'suggestion.accepted', reject: 'suggestion.rejected', mixed: 'suggestion.mixed' };

/** All resolved-map entries as `kind:id` → decision. */
export function snapshotResolutions(document) {
  const state = new Map();
  for (const [root, kind] of [[MARKDOWN_RESOLVED_ROOT, 'markdown'], [CODE_RESOLVED_ROOT, 'code']]) {
    // Only read roots the doc already has — getMap() would CREATE the root,
    // mutating the doc from a read path.
    if (!document.share.has(root)) continue;
    for (const [id, decision] of document.getMap(root).entries()) {
      if (decision in DECISION_TYPES) state.set(`${kind}:${id}`, decision);
    }
  }
  return state;
}

/** New/changed/undone decisions between two snapshots:
 *  [{ kind, id, decision, undone? }] — `decision` is the new value, or the
 *  removed value with `undone: true` (Cmd+Z rolled the resolution back). */
export function diffResolutions(prev, next) {
  const changes = [];
  const split = (key) => {
    const sep = key.indexOf(':');
    return { kind: key.slice(0, sep), id: key.slice(sep + 1) };
  };
  for (const [key, decision] of next) {
    if (prev.get(key) !== decision) changes.push({ ...split(key), decision });
  }
  for (const [key, decision] of prev) {
    if (!next.has(key)) changes.push({ ...split(key), decision, undone: true });
  }
  return changes;
}

/** `user:<clerkId>` / `anon:<id>` / null (no attributable identity). */
export function decisionActorId(context) {
  const userId = typeof context?.userId === 'string' ? context.userId.trim() : '';
  if (!userId) return null;
  // Local-agent collab sockets carry `ai:<name>` ids — keep them verbatim so
  // they match doc_edits attribution, instead of minting a fake `user:ai:…`.
  if (userId.startsWith('anon:') || userId.startsWith('ai:')) return userId;
  return `user:${userId}`;
}

export class SuggestionDecisionRecorder {
  #states = new Map(); // documentName -> Map<`kind:id`, decision>
  #insert;
  #logError;

  constructor({ insertActivityEvents, logError }) {
    this.#insert = insertActivityEvents;
    this.#logError = logError ?? (() => {});
  }

  seed(documentName, document) {
    this.#states.set(documentName, snapshotResolutions(document));
  }

  forget(documentName) {
    this.#states.delete(documentName);
  }

  /**
   * Diff the doc's resolved-maps against the last observed state and record any
   * new/changed decisions attributed to `context`. Called on every applied
   * update; unattributable applications (seed, ingestor echo, direct-connection
   * transacts — those record via their own endpoint) advance the state WITHOUT
   * emitting, so a decision made elsewhere is never re-recorded or misattributed.
   */
  observe(documentName, document, meta, context) {
    const prev = this.#states.get(documentName);
    const next = snapshotResolutions(document);
    this.#states.set(documentName, next);
    if (!prev || !meta) return;
    const actorId = decisionActorId(context);
    if (!actorId) return;
    // An undone decision (Cmd+Z rolls back an accept/reject — the UndoManager
    // removes the resolved-map entry) is itself a decision worth keeping.
    //
    // Desktop-bridge sockets RELAY resolutions decided on the sidecar (which
    // records them with the true local actor and uploads them via the ledger).
    // Record them anyway — suppression would let any writer mint a bridge
    // token and opt out of the audit trail — but tagged, so consumers prefer
    // the ledger row and the event reads as "relayed by", not "decided by".
    const via = context?.bridge === true ? { via: 'desktop_bridge' } : {};
    const rows = diffResolutions(prev, next).map((change) => ({
      workspace_id: meta.workspaceId,
      actor_id: actorId,
      type: change.undone ? 'suggestion.unresolved' : DECISION_TYPES[change.decision],
      data_json: {
        file_path: meta.path,
        suggestion_id: change.id,
        suggestion_kind: change.kind,
        ...via,
        ...(change.undone ? { undone_decision: change.decision } : {}),
      },
    }));
    if (rows.length === 0) return;
    Promise.resolve(this.#insert(rows)).catch((error) => {
      this.#logError(`suggestion decision insert failed doc=${documentName}`, error);
    });
  }
}
