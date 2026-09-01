/** Edit-history grouping over the local_edits ledger — the sidecar's analog of
 *  the cloud Review panel's `doc_edits` session grouping. Local review units
 *  are all read-only "applied sessions": maximal contiguous runs of rows on one
 *  path by one author (actor:author_id) within a 5-minute gap, keyed
 *  `applied-<lastRowId>` like the cloud (`collectAppliedEditSessions`). Pure —
 *  callers pass ledger rows ascending by id. */

export const SESSION_GAP_MS = 5 * 60 * 1000;

// Chat id joins the session key: one author's edits from two chats are two
// review units (the panel's current-chat filter matches on entry.chatId).
// Edit mode joins it too: a suggest session must not absorb the same turn's
// direct-applied rows (an edit-mode write) — the panel's Undo resolves only
// suggestion ids, so a mixed unit would revert partially while displaying the
// whole span's diff.
// Message id joins it too, so a review unit never spans two assistant TURNS —
// the cloud's unit is the turn, and a merged unit would Keep/Undo both at once
// and point every author chip at whichever turn happened to be last. Human and
// external rows carry no message id, so their grouping is unchanged.
const authorKey = (row) =>
  `${row.actor ?? ''}:${row.author_id ?? ''}:${row.chat_id ?? ''}:${row.edit_mode ?? 'edit'}:${row.message_id ?? ''}`;
const tsOf = (row) => (row.created_at ? Date.parse(row.created_at) || 0 : 0);

/** Group one path's rows (ascending) into sessions. */
export function collectLocalSessions(rows) {
  const sessions = [];
  let start = null;
  const flush = (firstIndex, lastIndex) => {
    const first = rows[firstIndex];
    const last = rows[lastIndex];
    const span = rows.slice(firstIndex, lastIndex + 1);
    sessions.push({
      reviewId: `applied-${last.id}`,
      path: last.path,
      actor: last.actor ?? null,
      authorId: last.author_id ?? null,
      chatId: last.chat_id ?? null,
      // The transcript's assistant message id (the local analog of
      // `doc_edits.assistant_message_id`) — NOT the review id, which is the
      // synthetic `applied-<rowId>` session key. Only a jump target: it's what
      // the chat renders as `data-message-id`. Null for human/external rows.
      // Uniform across the span — it's part of `authorKey`.
      messageId: last.message_id ?? null,
      createdAt: last.created_at ?? null,
      firstRowId: first.id,
      lastRowId: last.id,
      editCount: lastIndex - firstIndex + 1,
      // A suggest session is reviewable: Keep/Undo resolves its staged
      // suggestion ids (the caller derives pending vs applied from whether
      // any id is still live in the doc). Mode is uniform within a session —
      // it's part of the session key.
      editMode: last.edit_mode === 'suggest' ? 'suggest' : 'edit',
      suggestionIds: [...new Set(span.map((row) => row.suggestion_id).filter(Boolean))],
    });
  };
  rows.forEach((row, index) => {
    if (start !== null) {
      const prev = rows[index - 1];
      if (authorKey(prev) !== authorKey(row) || tsOf(row) - tsOf(prev) > SESSION_GAP_MS) {
        flush(start, index - 1);
        start = index;
        return;
      }
      return;
    }
    start = index;
  });
  if (start !== null) flush(start, rows.length - 1);
  return sessions;
}

/** Sessions across all paths in a ledger window (rows ascending, mixed paths),
 *  newest first, capped at `limit` with an older-page cursor. `scanFloor` is
 *  the oldest scanned row id when the window was capped (more history exists
 *  below it), mirroring the cloud query's cursor semantics. `actors`/`chatId`
 *  filter SESSIONS before the cap (an author's older sessions must not vanish
 *  behind a page of someone else's) but never the row stream — grouping needs
 *  interposed other-author rows as session separators; per-actor counts are
 *  reported pre-actor-filter over the scanned window.
 *
 *  `isPending` narrows to still-unresolved suggest sessions, and for the same
 *  reason it runs BEFORE the cap: the editor's per-file review feed asks only
 *  for pending units, and one left open under a page of newer applied history
 *  would silently lose its author chip. Only suggest sessions can be pending,
 *  so the (doc-probing) predicate is never called for plain edit history.
 *
 *  @param {any[]} rows
 *  @param {{ limit?: number, scanFloor?: number | null, actors?: string[] | null,
 *            chatId?: string | null, isPending?: ((session: any) => boolean) | null }} [options]
 */
export function buildLocalChangeEntries(
  rows,
  { limit = 100, scanFloor = null, actors = null, chatId = null, isPending = null } = {},
) {
  const byPath = new Map();
  for (const row of rows) {
    const bucket = byPath.get(row.path);
    if (bucket) bucket.push(row);
    else byPath.set(row.path, [row]);
  }
  let sessions = [];
  for (const pathRows of byPath.values()) sessions.push(...collectLocalSessions(pathRows));
  // Baseline snapshots (recorded before a first-ever suggestion so its diff
  // has a "before") are not edits anyone made — never review units.
  sessions = sessions.filter((session) => session.actor !== 'baseline');
  sessions.sort((a, b) => b.lastRowId - a.lastRowId);
  // Chat is a SCOPE (like path): applied before counts, so author chips
  // reflect the scoped view. Actor is a display filter: counts stay pre-filter.
  if (chatId) sessions = sessions.filter((session) => session.chatId === chatId);
  const actorCounts = {};
  for (const session of sessions) {
    const key = session.actor ?? '';
    actorCounts[key] = (actorCounts[key] ?? 0) + 1;
  }
  if (actors) sessions = sessions.filter((session) => actors.includes(session.actor ?? ''));
  if (isPending) sessions = sessions.filter((s) => s.editMode === 'suggest' && isPending(s));
  const entries = sessions.slice(0, limit);
  const firstDropped = sessions[limit];
  const cursorCandidates = [];
  if (scanFloor != null) cursorCandidates.push(scanFloor);
  if (firstDropped) cursorCandidates.push(firstDropped.lastRowId + 1);
  return {
    entries,
    actorCounts,
    nextBeforeId: cursorCandidates.length > 0 ? Math.max(...cursorCandidates) : null,
  };
}
