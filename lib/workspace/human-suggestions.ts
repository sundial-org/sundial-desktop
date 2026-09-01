/**
 * Human suggest-mode edits are persisted by Hocuspocus as debounced full-text
 * snapshots (`actor='user'|'anon'`, `assistant_message_id=NULL`,
 * `edit_mode='suggest'`) — there is no per-suggestion boundary. We model a
 * reviewable "human suggestion" as a maximal contiguous run of such rows, keyed
 * by the run's FIRST `doc_edits.id`. The first row is stable as the run grows
 * (each new debounced snapshot only advances the last row), so a Keep/Undo
 * decision recorded mid-run survives later keystrokes — keying by the last row
 * re-keyed the run on every snapshot and silently dropped the decision. The
 * review id is colon-free so it survives the `assistantMessageId:chunkId` key
 * splitting used by the inline overlay.
 */

const HUMAN_REVIEW_PREFIX = 'human-';
// Live editor-minted CRDT code-suggestion ids (see code-suggest-staging.ts). A
// review id with this prefix is a code/LaTeX LEDGER suggestion — resolved by id
// against the ledger — not a `human-<rowId>` doc_edits run.
const HUMAN_LEDGER_PREFIX = 'human-local-';

export type HumanSuggestRow = {
  id?: number | null;
  actor?: string | null;
  assistant_message_id?: string | null;
  edit_mode?: string | null;
  author_id?: string | null;
};

export function humanReviewId(firstRowId: number): string {
  return `${HUMAN_REVIEW_PREFIX}${firstRowId}`;
}

export function isHumanReviewId(id: string): boolean {
  return id.startsWith(HUMAN_REVIEW_PREFIX);
}

/** A code/LaTeX ledger suggestion id (resolve by id against the CRDT ledger),
 *  as opposed to a `human-<rowId>` doc_edits run. */
export function isHumanLedgerReviewId(id: string): boolean {
  return id.startsWith(HUMAN_LEDGER_PREFIX);
}

/** Parse `human-<rowId>` → rowId, or null if not a human review id. */
export function parseHumanReviewId(id: string): number | null {
  if (!isHumanReviewId(id)) return null;
  const raw = Number(id.slice(HUMAN_REVIEW_PREFIX.length));
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * A row is a pending direct suggestion when it was authored outside an agent
 * turn while in suggest mode: a human typing in Suggest mode, or a local agent
 * (Claude Code, Codex via the local-agent HTTP API) writing with
 * `editMode: 'suggest'`. Local agents have no assistant message, so they ride
 * the same run model as humans.
 */
export function isHumanSuggestRow(row: HumanSuggestRow): boolean {
  const actor = row.actor;
  if (actor !== 'user' && actor !== 'anon' && actor !== 'local_agent') return false;
  if (row.assistant_message_id) return false;
  return (row.edit_mode ?? 'edit') === 'suggest';
}

export type HumanSuggestionRun = {
  reviewId: string;
  /** First row id of the run — the stable identity the review id is keyed on. */
  firstRowId: number;
  /** Last row id — still tracked so callers can sort runs newest-first. */
  lastRowId: number;
  firstIndex: number;
  lastIndex: number;
  authorId: string | null;
};

/**
 * Group ordered (ascending `id`) doc_edit rows into maximal contiguous runs of
 * suggest rows by a single author. A run breaks on any non-suggest row AND on
 * an author change — otherwise interleaved suggestions from two collaborators
 * would collapse into one review unit attributed to the last writer.
 */
export function collectHumanSuggestionRuns(rows: HumanSuggestRow[]): HumanSuggestionRun[] {
  const runs: HumanSuggestionRun[] = [];
  let start: number | null = null;
  const authorKey = (row: HumanSuggestRow) => `${row.actor ?? ''}:${row.author_id ?? ''}`;
  const flush = (firstIndex: number, lastIndex: number) => {
    const first = rows[firstIndex]!;
    const last = rows[lastIndex]!;
    const firstRowId = typeof first.id === 'number' ? first.id : 0;
    const lastRowId = typeof last.id === 'number' ? last.id : 0;
    if (!firstRowId || !lastRowId) return;
    runs.push({
      reviewId: humanReviewId(firstRowId),
      firstRowId,
      lastRowId,
      firstIndex,
      lastIndex,
      authorId: typeof last.author_id === 'string' && last.author_id ? last.author_id : null,
    });
  };
  rows.forEach((row, index) => {
    if (isHumanSuggestRow(row)) {
      if (start !== null && authorKey(rows[index - 1]!) !== authorKey(row)) {
        flush(start, index - 1);
        start = index;
        return;
      }
      if (start === null) start = index;
      return;
    }
    if (start !== null) {
      flush(start, index - 1);
      start = null;
    }
  });
  if (start !== null) flush(start, rows.length - 1);
  return runs;
}

/**
 * Find a single run by ANY member row id (for keep/undo routes). The review id
 * normally embeds the run's first row, but a caller may hold a different member
 * id: a Review panel built from a truncated newest-N scan anchors on the first
 * FETCHED row (not the true first), and a stale client from before first-row
 * keying holds the run's old last-row id. Matching on membership resolves all
 * three to the same run; only a non-member id (e.g. a plain edit-mode row)
 * returns null.
 */
export function findHumanSuggestionRun(
  rows: HumanSuggestRow[],
  memberRowId: number,
): HumanSuggestionRun | null {
  return (
    collectHumanSuggestionRuns(rows).find((run) => {
      for (let i = run.firstIndex; i <= run.lastIndex; i += 1) {
        if (rows[i]?.id === memberRowId) return true;
      }
      return false;
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Applied edit sessions (read-only history of direct, edit-mode edits)
// ---------------------------------------------------------------------------

const APPLIED_REVIEW_PREFIX = 'applied-';
const SESSION_GAP_MS = 5 * 60 * 1000;

export function appliedReviewId(lastRowId: number): string {
  return `${APPLIED_REVIEW_PREFIX}${lastRowId}`;
}

export function isAppliedReviewId(id: string): boolean {
  return id.startsWith(APPLIED_REVIEW_PREFIX);
}

export function parseAppliedReviewId(id: string): number | null {
  if (!isAppliedReviewId(id)) return null;
  const raw = Number(id.slice(APPLIED_REVIEW_PREFIX.length));
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

export type AppliedEditRow = {
  id?: number | null;
  actor?: string | null;
  assistant_message_id?: string | null;
  edit_mode?: string | null;
  author_id?: string | null;
  created_at?: string | null;
  source?: string | null;
};

/** A direct (edit-mode, already-applied) edit by a human or local agent: no
 *  agent turn, not suggest mode. These are history, not a review unit.
 *  Exception: a `suggestion_reject:` revert row carries the rejected turn's
 *  `assistant_message_id` (legacy text-path convention) but IS the user's own
 *  applied action — history must show "Rejected <suggester>'s suggestion", not
 *  silently drop the record. */
export function isAppliedEditRow(row: AppliedEditRow): boolean {
  const actor = row.actor;
  if (actor !== 'user' && actor !== 'anon' && actor !== 'local_agent') return false;
  if (row.assistant_message_id && !row.source?.startsWith('suggestion_reject:')) return false;
  return (row.edit_mode ?? 'edit') !== 'suggest';
}

export type AppliedEditSession = {
  reviewId: string;
  lastRowId: number;
  firstIndex: number;
  lastIndex: number;
  authorId: string | null;
  editCount: number;
};

/**
 * Group ordered (ascending `id`) rows for ONE path into applied-edit sessions:
 * maximal runs of {@link isAppliedEditRow} rows by a single author within a
 * 5-minute gap. Mirrors the History feed's windowing so a flood of debounced
 * keystrokes collapses into a handful of reviewable sessions. Used by both the
 * Review index and the applied-edit detail route, so their `applied-<rowId>`
 * keys agree.
 */
export function collectAppliedEditSessions(rows: AppliedEditRow[]): AppliedEditSession[] {
  const sessions: AppliedEditSession[] = [];
  let start: number | null = null;
  const authorKey = (row: AppliedEditRow) => `${row.actor ?? ''}:${row.author_id ?? ''}`;
  const tsOf = (row: AppliedEditRow) => (row.created_at ? Date.parse(row.created_at) || 0 : 0);
  const flush = (firstIndex: number, lastIndex: number) => {
    const last = rows[lastIndex]!;
    const lastRowId = typeof last.id === 'number' ? last.id : 0;
    if (!lastRowId) return;
    sessions.push({
      reviewId: appliedReviewId(lastRowId),
      lastRowId,
      firstIndex,
      lastIndex,
      authorId: typeof last.author_id === 'string' && last.author_id ? last.author_id : null,
      editCount: lastIndex - firstIndex + 1,
    });
  };
  rows.forEach((row, index) => {
    if (isAppliedEditRow(row)) {
      if (start !== null) {
        const prev = rows[index - 1]!;
        const broke = authorKey(prev) !== authorKey(row) || tsOf(row) - tsOf(prev) > SESSION_GAP_MS;
        if (broke) {
          flush(start, index - 1);
          start = index;
          return;
        }
      }
      if (start === null) start = index;
      return;
    }
    if (start !== null) {
      flush(start, index - 1);
      start = null;
    }
  });
  if (start !== null) flush(start, rows.length - 1);
  return sessions;
}

export function findAppliedEditSession(
  rows: AppliedEditRow[],
  lastRowId: number,
): AppliedEditSession | null {
  return collectAppliedEditSessions(rows).find((s) => s.lastRowId === lastRowId) ?? null;
}
