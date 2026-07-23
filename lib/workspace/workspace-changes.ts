// Shared types + pure helpers for the workspace "Review" panel. No client- or
// server-only deps so both the panel (client) and the query (server) import it.
//
// The panel lets a reviewer scope tracked edits by file / folder / chat / chat
// turn (any combination) and filter by who made them — Sunny, a connected
// local agent (Claude Code, Codex, …), or a human. A single `doc_edits`
// metadata pass powers the list; per-entry diffs load lazily on selection.

import { ANON_AUTHOR_PREFIX } from '@/lib/auth/anon-identity';
import { brandForAgentId } from '@/lib/workspace/agent-brand';
import type { AcceptedSuggestion } from '@/lib/workspace/turn-edits';

export type { AcceptedSuggestion };

/** The three reviewer-visible author classes. `doc_edits.actor` maps to these:
 *  `agent`→sunny, `local_agent`→local_agent, `user`|`anon`→human. */
export type ChangeAuthorKind = 'sunny' | 'local_agent' | 'human';

export const CHANGE_AUTHOR_KINDS: readonly ChangeAuthorKind[] = [
  'sunny',
  'local_agent',
  'human',
] as const;

export function isChangeAuthorKind(value: unknown): value is ChangeAuthorKind {
  return value === 'sunny' || value === 'local_agent' || value === 'human';
}

/**
 * Classify a `doc_edits` row by its `(actor, author_id)`. `actor` is the
 * authoritative signal; `author_id` is a defensive fallback for legacy rows
 * written before `actor` was always populated (`sunny:` / `ai:` prefixes).
 */
export function classifyChangeAuthor(
  actor: string | null | undefined,
  authorId: string | null | undefined,
): ChangeAuthorKind {
  if (actor === 'agent') return 'sunny';
  if (actor === 'local_agent') return 'local_agent';
  if (actor === 'user' || actor === 'anon') return 'human';
  const id = authorId ?? '';
  if (id.startsWith('sunny:')) return 'sunny';
  if (id.startsWith('ai:')) return 'local_agent';
  return 'human';
}

/** `actor` values that map to each author kind — used to build the server-side
 *  `actor in (...)` filter. Legacy null-actor rows are reclassified in JS via
 *  {@link classifyChangeAuthor}, so the server filter stays a fast superset. */
export function actorsForAuthorKinds(kinds: readonly ChangeAuthorKind[]): string[] {
  const actors = new Set<string>();
  for (const kind of kinds) {
    if (kind === 'sunny') actors.add('agent');
    else if (kind === 'local_agent') actors.add('local_agent');
    else {
      actors.add('user');
      actors.add('anon');
    }
  }
  return [...actors];
}

/**
 * AND-combinable scope constraints. Any subset narrows the change set:
 * `{ folder: 'src', chatId: 'c1' }` = edits under `src/` made in chat `c1`.
 * An empty object scopes the whole workspace.
 */
export type ChangeScopeFilter = {
  /** Exact file path. */
  path?: string;
  /** Folder prefix (no trailing slash); matches the folder and everything under it. */
  folder?: string;
  /** Chat thread id (only Sunny turns carry one). */
  chatId?: string;
  /** Single assistant turn (only Sunny turns carry one). */
  assistantMessageId?: string;
};

export function scopeIsEmpty(scope: ChangeScopeFilter): boolean {
  return !scope.path && !scope.folder && !scope.chatId && !scope.assistantMessageId;
}

/** True when the scope can only contain Sunny turns (chat/turn carry no
 *  local-agent or human edits), so the UI can hide those author chips. */
export function scopeIsAgentOnly(scope: ChangeScopeFilter): boolean {
  return Boolean(scope.chatId || scope.assistantMessageId);
}

export type ChangeAuthor = {
  kind: ChangeAuthorKind;
  /** Raw `doc_edits.author_id` (`sunny:354`, `ai:claude-code`, a user id, …). */
  id: string | null;
  /** Display name resolved server-side (`Sunny`, `Claude`, a person's name). */
  name: string;
  /** Accurate avatar: the Sunny png for its number, the agent brand logo, or
   *  the human's profile photo. Null → render a fallback (initial / icon). */
  imageUrl: string | null;
};

/** Decision state of an entry's chunks, derived from `diff.chunk_*` events.
 *  `applied` = an `edit`-mode change that landed directly (no Keep/Undo gate). */
export type ChangeReviewState = 'pending' | 'partial' | 'reviewed' | 'applied';

export type ChangeEntry = {
  /** `assistant_message_id` for a Sunny turn, or `human-<rowId>` for a
   *  local-agent / human suggestion run. Drives the Keep/Undo routes. */
  reviewId: string;
  /** The entry's most-recent `doc_edits.id` — the document state after this
   *  change. A checkpoint label pins to this point. */
  docEditId: number;
  /** `turn` = a Sunny chat turn; `run` = a local-agent / human suggestion run
   *  (reviewable); `session` = a local-agent / human *applied* edit session
   *  (already-landed direct edits, grouped by author + time window; read-only). */
  kind: 'turn' | 'run' | 'session';
  author: ChangeAuthor;
  /** Chat the turn belongs to (null for runs — they have no thread). */
  chatId: string | null;
  createdAt: string | null;
  editMode: 'edit' | 'suggest';
  /** Distinct file paths the entry touched, intersected with the active scope. */
  filePaths: string[];
  editedFileCount: number;
  reviewState: ChangeReviewState;
  /** Suggest turns: the subset of `filePaths` whose live marks are fully
   *  resolved. Lets a CLIENT-side file filter recompute the state after
   *  narrowing — the server judged `reviewState` over the whole entry, and a
   *  resolved file must not render as a phantom pending suggestion when
   *  filtered to on its own. */
  resolvedFilePaths?: string[];
  /** One-line label: the turn's message preview, or a synthesized run summary. */
  messagePreview: string;
  /** Set on an applied `session` that accepted a pending suggestion — drives the
   *  "Accepted Sunny's suggestion" label so reviewers can see what was applied. */
  acceptedFrom?: AcceptedSuggestion | null;
  /** Sessions only: the session's oldest `doc_edits` row id. Sessions are keyed
   *  by their LAST row (`applied-<id>`), so one whose rows straddle an older-page
   *  cursor re-derives under a different id — this span lets the client drop
   *  that partial duplicate. */
  firstRowId?: number;
};

export type WorkspaceChangesResponse = {
  workspaceId: string;
  scope: ChangeScopeFilter;
  entries: ChangeEntry[];
  /** Newest reviewable/applied `doc_edits.id` the scan saw — the "now" anchor
   *  for compares. The capped `entries` alone can under-report it (pinned
   *  suggestions can consume the whole budget). Optional for older payloads. */
  latestDocEditId?: number | null;
  /** How many entries each author kind has in this scope BEFORE the author
   *  filter — lets the filter bar show counts and disable empty chips. */
  authorCounts: Record<ChangeAuthorKind, number>;
  /** Older-history cursor: non-null when more history exists past this page
   *  (the row scan hit its cap, or more entries were grouped than `limit`
   *  returned). Pass it back as `beforeId` to fetch the next-older page —
   *  only `doc_edits` rows with `id` strictly below it are scanned. */
  nextBeforeId?: number | null;
};

export function summarizeRunPreview(filePaths: string[]): string {
  if (filePaths.length === 0) return 'Suggested edit';
  const name = filePaths[0]!.split('/').pop() || filePaths[0]!;
  if (filePaths.length === 1) return `Suggested edit to ${name}`;
  return `Suggested edits to ${name} +${filePaths.length - 1}`;
}

export function summarizeSessionPreview(filePaths: string[], editCount: number): string {
  const name = filePaths[0]?.split('/').pop() || filePaths[0] || 'a file';
  const edits = editCount === 1 ? 'Edited' : `Edited (${editCount}×)`;
  return `${edits} ${name}`;
}

/** Label for an applied session that accepted a suggestion: who proposed it. */
export function summarizeAcceptedPreview(accepted: AcceptedSuggestion): string {
  return `Accepted ${accepted.name}'s suggestion`;
}

/**
 * Display name for a `doc_edits` author: 'Sunny' for the agent, the brand label
 * for a local agent, else the Clerk-resolved name (caller passes it in) or a
 * generic fallback. Single source for both the changes index and the
 * applied-edit detail so the two surfaces never show a different name.
 */
export function authorDisplayName(
  kind: ChangeAuthorKind,
  id: string | null,
  resolvedName?: string | null,
): string {
  if (kind === 'sunny') return 'Sunny';
  if (kind === 'local_agent') return brandForAgentId(id).displayName;
  return resolvedName || 'Someone';
}

/** Convenience for tests / callers: anon author display prefix passthrough. */
export const ANON_PREFIX = ANON_AUTHOR_PREFIX;
