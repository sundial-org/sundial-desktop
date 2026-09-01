export type CommentAnchorPayload = Record<string, unknown>;

export type DocCommentStatus = 'open' | 'resolved';

export type DocCommentAuthor = {
  userId: string;
  name: string | null;
  username: string | null;
  imageUrl: string | null;
};

export type DocCommentMessage = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: DocCommentAuthor;
};

export type DocCommentThread = {
  id: string;
  /**
   * Stable React key, client-only (never sent by the server). When an
   * optimistically-created comment reconciles to its persisted row, the server
   * thread is stamped with the optimistic id here so the lane card keeps the
   * same DOM node across the id swap — otherwise it remounts and replays its
   * entry animation ("the comment arrives, then arrives again").
   */
  clientKey?: string;
  projectId: string;
  /** The thread's dedicated agent chat, once someone @sunny'd it. Optional: not
   *  every producer of this shape (e.g. the local server) fills it in. */
  chatId?: string | null;
  fileId: string;
  filePath: string;
  quote: string;
  anchor: CommentAnchorPayload;
  head: CommentAnchorPayload;
  status: DocCommentStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  author: DocCommentAuthor;
  messages: DocCommentMessage[];
};

export type DraftDocCommentSelection = {
  quote: string;
  anchor: CommentAnchorPayload;
  head: CommentAnchorPayload;
};

export type ResolvedDocCommentRange = {
  id: string;
  from: number;
  to: number;
  status: DocCommentStatus;
  /** The emoji when this range is a reaction rather than a comment thread
   *  (see `threadReactionEmoji`), else null. */
  reaction?: string | null;
};

/* ── Emoji reactions ──────────────────────────────────────────────────
 *  A reaction IS a comment thread whose single message body is exactly one
 *  emoji — no schema change, no second table. Anchoring, realtime, permissions,
 *  deletion, the local sidecar mirror and version history all keep working
 *  unchanged; only the rendering differs (a compact chip instead of a card).
 *  Replying to a reaction gives it a second message, at which point it stops
 *  classifying as one and renders as an ordinary thread.
 * ─────────────────────────────────────────────────────────────────── */

/** The palette offered on the selection bubble. */
export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '😂', '😮', '🙏'] as const;

// One emoji and nothing else: a flag (two regional indicators), or a pictograph
// with its optional modifiers/variation selectors and ZWJ continuations.
const EMOJI_TAIL = '(?:\\p{Emoji_Modifier}|\\uFE0F|\\u20E3)*';
const SINGLE_EMOJI_RE = new RegExp(
  `^(?:\\p{RI}\\p{RI}|\\p{Extended_Pictographic}${EMOJI_TAIL}(?:\\u200D\\p{Extended_Pictographic}${EMOJI_TAIL})*)$`,
  'u',
);

/** True when `body` is exactly one emoji (skin tones, ZWJ sequences and flags
 *  included) — the whole reaction/comment classification. */
export function isSingleEmoji(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.length > 0 && SINGLE_EMOJI_RE.test(trimmed);
}

/** The reaction emoji for a thread, or null when it's an ordinary comment. */
export function threadReactionEmoji(thread: Pick<DocCommentThread, 'messages'>): string | null {
  if (thread.messages.length !== 1) return null;
  const body = thread.messages[0].body.trim();
  return isSingleEmoji(body) ? body : null;
}

/**
 * The caller's own reaction with `emoji` covering exactly `[from, to)`, or null.
 * Picking the same emoji again on the same words removes it, so reacting is a
 * toggle. Matched on RESOLVED positions, not on the stored anchor payloads —
 * two captures of the same selection need not produce byte-identical Yjs
 * relative positions, but they always resolve to the same range. Pure so it can
 * be unit-tested without a live editor.
 */
export function findOwnReaction(
  threads: readonly DocCommentThread[],
  ranges: readonly ResolvedDocCommentRange[],
  params: { emoji: string; from: number; to: number; userId: string | null },
): DocCommentThread | null {
  if (!params.userId) return null;
  const rangeById = new Map(ranges.map((range) => [range.id, range]));
  for (const thread of threads) {
    if (thread.author.userId !== params.userId) continue;
    if (threadReactionEmoji(thread) !== params.emoji) continue;
    const range = rangeById.get(thread.id);
    if (range && range.from === params.from && range.to === params.to) return thread;
  }
  return null;
}

/** Optimistic (not-yet-persisted) thread/message ids are prefixed so the UI can
 *  tell them apart from server ids — server actions can't be issued against them. */
export const OPTIMISTIC_ID_PREFIX = 'optimistic-';
export function isOptimisticCommentId(id: string) {
  return id.startsWith(OPTIMISTIC_ID_PREFIX);
}

/** Any agent handle as a whole word — people tag @agent/@claude/@codex as
 *  readily as @sunny — never inside an email or a longer word. Client-safe
 *  twin of the server's summon check (`hasSunnyMention`), so the UI can tell
 *  a thread was already handed to an agent before the chat link lands. */
const AGENT_MENTION_RE = /(^|\W)@(sunny|agent|claude|codex)\b/i;
export function hasAgentMention(body: string): boolean {
  return AGENT_MENTION_RE.test(body ?? '');
}

/** Agent-written comments (Sunny's own add_comment/reply_comment). Mirrors the
 *  server's own-filter: local rows carry `agent:`/`ai:` ids, cloud rows carry the
 *  sunny UUID with username 'sunny'. */
export function isAgentCommentAuthor(author: Pick<DocCommentAuthor, 'userId' | 'username'>): boolean {
  return /^(agent|ai|sunny):/.test(author.userId) || author.username === 'sunny';
}

/** The pending `@…` mention under the caret (word-start only), for the comment
 *  composer's agent autocomplete. `start` indexes the `@`. The accepted
 *  characters must cover everything commentMentionHandle can EMIT (usernames
 *  and id fallbacks carry digits, dots and hyphens) — a narrower set closed the
 *  menu the moment someone typed their own displayed handle. */
export function findCommentMentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const match = /(?:^|\s)@([\w.-]*)$/i.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

/** One row of the comment composer's `@` menu. The agent row is the whole
 *  discovery surface for "tag the agent and it answers", so it is pinned first
 *  and never filtered out by a prefix the collaborators match too. */
export type CommentMentionOption = {
  handle: string;
  label: string;
  imageUrl?: string | null;
  isAgent?: boolean;
};

/** The one advertised agent handle. The aliases (@sunny/@claude/@codex) stay
 *  accepted when typed in full; they're just not listed — a menu of names
 *  nobody recognizes reads as a quiz. */
export const AGENT_MENTION_OPTION: CommentMentionOption = {
  handle: '@Agent',
  label: 'replies here',
  isAgent: true,
};

/** A collaborator's `@` handle: their username when they have one, else a
 *  slug of their display name. Never empty (falls back to the id). */
export function commentMentionHandle(person: {
  id: string;
  name?: string | null;
  username?: string | null;
}): string {
  const slug =
    person.username?.trim() ||
    person.name?.trim().split(/\s+/)[0]?.replace(/[^\w.-]/g, '') ||
    person.id.slice(0, 8);
  return `@${slug}`;
}

/** Menu rows for a pending `@<query>`: the agent ALWAYS first, then matching
 *  human collaborators (deduped by handle, self excluded by the caller). */
export function buildCommentMentionOptions(
  people: readonly CommentMentionOption[],
  query: string,
): CommentMentionOption[] {
  const prefix = query.toLowerCase();
  const matches = (option: CommentMentionOption) =>
    option.handle.slice(1).toLowerCase().startsWith(prefix);
  const seen = new Set([AGENT_MENTION_OPTION.handle.toLowerCase()]);
  const humans: CommentMentionOption[] = [];
  for (const person of people) {
    const key = person.handle.toLowerCase();
    if (person.isAgent || seen.has(key) || !matches(person)) continue;
    seen.add(key);
    humans.push(person);
  }
  // `agent` also matches nothing else, so a query that excludes it leaves the
  // humans alone; a query it matches keeps it on top regardless of theirs.
  return matches(AGENT_MENTION_OPTION) ? [AGENT_MENTION_OPTION, ...humans] : humans;
}

const MAX_QUOTE_LENGTH = 180;

export function clipCommentQuote(text: string, maxLength = MAX_QUOTE_LENGTH) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function sortDocCommentThreads(threads: DocCommentThread[]) {
  return [...threads].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === 'open' ? -1 : 1;
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

/**
 * Pick which comment a click landed in (Google-Docs-style "select the thread on
 * the right when you click commented text"). Ranges are half-open `[from, to)`;
 * when comments overlap the innermost (shortest) one wins so clicking nested
 * text selects the most specific thread. Returns the thread id, or `null` when
 * the position isn't inside any comment. Pure so it can be unit-tested without a
 * live editor.
 */
export function pickCommentAtPos(
  ranges: Array<{ id: string; from: number; to: number }>,
  pos: number,
): string | null {
  let best: { id: string; from: number; to: number } | null = null;
  for (const range of ranges) {
    if (pos < range.from || pos >= range.to) continue;
    if (!best || range.to - range.from < best.to - best.from) best = range;
  }
  return best ? best.id : null;
}

/**
 * Decide where to scroll a comment's anchor so focusing it brings the
 * highlighted text into view (the "selecting a comment doesn't focus the editor
 * at the right place with lots of comments" bug). All coordinates are viewport
 * pixels; returns the scroller's new `scrollTop`, or `null` when the anchor is
 * already comfortably visible so we don't jolt the page on reselect. Pure so it
 * can be unit-tested without a live editor.
 */
export function commentScrollTarget(params: {
  anchorTop: number;
  anchorBottom: number;
  viewportTop: number;
  viewportHeight: number;
  scrollTop: number;
  margin?: number;
}): number | null {
  const { anchorTop, anchorBottom, viewportTop, viewportHeight, scrollTop } = params;
  const margin = Math.min(params.margin ?? 80, viewportHeight / 2);
  const relTop = anchorTop - viewportTop;
  const relBottom = anchorBottom - viewportTop;
  const anchorHeight = Math.max(0, relBottom - relTop);
  // Already comfortably visible → don't jolt the page. An anchor taller than the
  // comfortable band can't fit entirely, so it's enough for its start to show.
  const fitsInBand = anchorHeight <= viewportHeight - 2 * margin;
  const visible = fitsInBand
    ? relTop >= margin && relBottom <= viewportHeight - margin
    : relTop >= margin && relTop <= viewportHeight - margin;
  if (visible) return null;
  // Center the anchor, but never push it above the top margin.
  const desiredRelTop = Math.max(margin, viewportHeight / 2 - anchorHeight / 2);
  return Math.max(0, Math.round(scrollTop + (relTop - desiredRelTop)));
}

/**
 * Lay out the comment-lane cards Google-Docs style. Cards want to sit at their
 * anchor's vertical offset (`desiredTop`) but can't overlap, so they need
 * collision resolution. When a comment is focused (`focusKey`) it is pinned at
 * its anchor (yielding downward only when the cards above wouldn't otherwise
 * fit above it — cards never overlap) and the others flow *away* from it — cards above are
 * pushed up, cards below are pushed down — so the selected thread lands next to
 * its highlighted text instead of wherever a top-down cascade happened to drop
 * it (the "selected comment is 700px below its line" bug). With no focus it
 * falls back to a plain top-down cascade. `items` must be sorted ascending by
 * `desiredTop`. Pure so it can be unit-tested without a live editor.
 */
export function layoutCommentLane(params: {
  items: Array<{ key: string; desiredTop: number; height: number }>;
  focusKey: string | null;
  gap: number;
}): Record<string, number> {
  const { items, gap } = params;
  const tops: Record<string, number> = {};
  const focusIndex = params.focusKey ? items.findIndex((item) => item.key === params.focusKey) : -1;

  if (focusIndex === -1) {
    let cursor = 0;
    for (const item of items) {
      const top = Math.max(Math.round(item.desiredTop), cursor);
      tops[item.key] = top;
      cursor = top + item.height + gap;
    }
    return tops;
  }

  const focus = items[focusIndex];
  // Cards must NEVER overlap. When the cards above can't fit between the lane
  // origin and the focus's own anchor, the FOCUS yields downward — the lane
  // grows — instead of the above-cluster piling onto 0 and rendering underneath
  // it (the "new comment composer half-covered by a thread card" bug: a tall
  // composer anchored near the top of the doc left no room for the thread above
  // it). Pinning to the anchor is a preference; not overlapping is a rule.
  let minFocusTop = 0;
  for (let i = 0; i < focusIndex; i++) minFocusTop += items[i].height + gap;
  const focusTop = Math.max(minFocusTop, Math.round(focus.desiredTop));
  tops[focus.key] = focusTop;
  // Above the focus: cascade the earlier cards top-down from the lane origin so
  // well-separated comments keep their own anchors and never overlap when there's
  // room. If the stack runs into the focus, slide the whole group up just enough
  // to clear it — it always fits now, since `focusTop` reserved exactly the
  // stack's height above itself. Cascading top-down (rather than up from the
  // focus) is what keeps spaced-out earlier comments off the lane top.
  if (focusIndex > 0) {
    // Pass 1: cascade top-down honoring anchors — non-overlapping, each >= its
    // own anchor (but the tail may run past the focus).
    let prevBottom = 0;
    for (let i = 0; i < focusIndex; i++) {
      const item = items[i];
      const top = Math.max(Math.round(item.desiredTop), prevBottom);
      tops[item.key] = top;
      prevBottom = top + item.height + gap;
    }
    // Pass 2: walk back up from the focus, pushing each card up only as far as it
    // must to clear the one below it. This keeps the gaps intact (a uniform shift
    // + per-card clamp would cramp them); the 0 clamp is now a no-op safety net,
    // since `focusTop` already reserved room for the whole stack.
    let limit = focusTop;
    for (let i = focusIndex - 1; i >= 0; i--) {
      const item = items[i];
      const top = Math.max(0, Math.min(tops[item.key], limit - gap - item.height));
      tops[item.key] = top;
      limit = top;
    }
  }
  // Below the focus: walk downward with the usual push-down cascade.
  let cursor = focusTop + focus.height + gap;
  for (let i = focusIndex + 1; i < items.length; i++) {
    const item = items[i];
    const top = Math.max(Math.round(item.desiredTop), cursor);
    tops[item.key] = top;
    cursor = top + item.height + gap;
  }
  return tops;
}

/**
 * Re-run `attempt` on a scheduler (a rAF in the browser) until it reports done
 * (returns `true`), bounded by `maxAttempts`. Used to retry the comment scroll
 * while the editor is still settling — the effect's React deps don't change once
 * layout resolves, so without this a deep-linked thread selected mid-load would
 * never scroll. `schedule`/`cancel` are injected so the loop is unit-testable;
 * frame-count (not wall-clock) bounding keeps a backgrounded tab's attempts.
 * Returns a teardown that cancels any pending tick.
 */
export function retryUntilDone(
  attempt: () => boolean,
  schedule: (fn: () => void) => number,
  cancel: (handle: number) => void,
  maxAttempts = 180,
): () => void {
  let handle = 0;
  let attempts = 0;
  const run = () => {
    handle = 0;
    if (attempt()) return;
    if (++attempts < maxAttempts) handle = schedule(run);
  };
  handle = schedule(run);
  return () => {
    if (handle) cancel(handle);
  };
}

/**
 * Resolve the scroll outcome for a focused comment, and crucially whether the
 * attempt should count as `handled`. When the editor is still settling — no
 * scroll container yet, or the anchor can't be measured (`coordsAtPos` threw, so
 * `anchor` is `null`) — the attempt is NOT handled, so the caller must leave the
 * thread retryable; otherwise a deep-linked thread selected mid-load marks
 * itself done and never scrolls into view once layout resolves. Only a real
 * measurement marks it handled (even when already visible → `scrollTop: null`).
 */
export function computeCommentScroll(params: {
  hasScroller: boolean;
  anchor: { top: number; bottom: number } | null;
  viewportTop: number;
  viewportHeight: number;
  scrollTop: number;
}): { handled: boolean; scrollTop: number | null } {
  if (!params.hasScroller || !params.anchor) {
    return { handled: false, scrollTop: null };
  }
  return {
    handled: true,
    scrollTop: commentScrollTarget({
      anchorTop: params.anchor.top,
      anchorBottom: params.anchor.bottom,
      viewportTop: params.viewportTop,
      viewportHeight: params.viewportHeight,
      scrollTop: params.scrollTop,
    }),
  };
}
