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
};

/** Optimistic (not-yet-persisted) thread/message ids are prefixed so the UI can
 *  tell them apart from server ids — server actions can't be issued against them. */
export const OPTIMISTIC_ID_PREFIX = 'optimistic-';
export function isOptimisticCommentId(id: string) {
  return id.startsWith(OPTIMISTIC_ID_PREFIX);
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
 * collision resolution. When a comment is focused (`focusKey`) it is pinned
 * exactly at its anchor and the others flow *away* from it — cards above are
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
  const focusTop = Math.max(0, Math.round(focus.desiredTop));
  tops[focus.key] = focusTop;
  // Above the focus: cascade the earlier cards top-down from the lane origin so
  // well-separated comments keep their own anchors and never overlap when there's
  // room. If the stack runs into the focus, slide the whole group up just enough
  // to clear it, clamping at 0 — which only forces overlap when the cluster
  // genuinely can't fit above the focus (where the wrapper's overflow-hidden would
  // otherwise clip cards pushed above the origin). Cascading top-down (rather than
  // up from the focus) is what keeps spaced-out earlier comments off the lane top.
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
    // + per-card clamp would cramp them) and clamps at 0 only when the cluster
    // genuinely can't fit above the focus, where some overlap is unavoidable.
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
