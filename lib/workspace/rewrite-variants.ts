/* ── Paragraph review: axes + stream protocol ─────────────────────────
 *  Shared by the rewrite-variants API route and the editor popup. The four
 *  variants differ along NAMED axes (one generation per axis), never four
 *  samples at temp 1 — the axis is both the card label the user sees and
 *  the training label the preference log records. Client-safe: no server
 *  imports.
 * ─────────────────────────────────────────────────────────────────── */

export type RewriteAxisId = 'tighten' | 'sharpen' | 'restructure' | 'cut-hedging';

/** Axes are ADAPTIVE: a fast model pass picks the four most useful
 *  transformations for THIS passage (a wrong claim gets "Fix the claim", a
 *  hedge-free passage never gets "Cut hedging"); REWRITE_AXES below is the
 *  fallback when that pass fails or times out. Free-form ids — the log
 *  records id + label per variant. */
export type RewriteAxisSpec = {
  id: string;
  label: string;
  instruction: string;
};

/** Hard cap on the selected passage. Shared by the popup (friendly message,
 *  no request) and the route (400) — the server must never silently truncate:
 *  the client applies the variant over the FULL captured selection, so a
 *  truncated rewrite would delete the selection's tail. */
export const MAX_REWRITE_TEXT_CHARS = 8000;

export type RewriteAxis = {
  id: RewriteAxisId;
  /** Card label in the popup. */
  label: string;
  /** Axis-specific system-prompt clause. */
  instruction: string;
};

export const REWRITE_AXES: readonly RewriteAxis[] = [
  {
    id: 'tighten',
    label: 'Tighten',
    instruction:
      'Tighten the passage: cut filler words, redundancies, and throat-clearing. Keep every claim and fact; make it noticeably shorter without losing meaning.',
  },
  {
    id: 'sharpen',
    label: 'Sharpen the claim',
    instruction:
      'Sharpen the central claim: state the strongest version of the point directly and up front. Make the thesis unmistakable; length may stay the same.',
  },
  {
    id: 'restructure',
    label: 'Restructure',
    instruction:
      'Restructure the passage: reorder its ideas for better logical flow (e.g. conclusion first, or cause before effect). Keep the content; change the architecture of the sentences.',
  },
  {
    id: 'cut-hedging',
    label: 'Cut hedging',
    instruction:
      'Remove hedging: strip qualifiers like "perhaps", "somewhat", "it could be argued", "tends to", and vague intensifiers. Commit to the claims the passage is actually making.',
  },
];

/** NDJSON events on the POST /api/workspace/rewrite-variants response.
 *  `slots` in the start event is the PRESENTED order — the server shuffles
 *  axis→slot per invocation so position bias can't poison the choice labels. */
export type RewriteStreamEvent =
  | { type: 'start'; invocationId: string; slots: { slot: number; axis: string; label?: string }[] }
  | { type: 'delta'; slot: number; text: string }
  /** The slot's streamed text was discarded (it echoed the original) and a
   *  fresh attempt is streaming — the client clears the slot's buffer. */
  | { type: 'variant-reset'; slot: number }
  | { type: 'variant-done'; slot: number; firstTokenMs: number | null; totalMs: number }
  | { type: 'variant-error'; slot: number; message: string }
  /** Stream-level failure (e.g. the variants row could not be persisted) —
   *  the client must disable picking: a choice without a persisted variant
   *  set is an unusable preference record. */
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Incremental NDJSON reader: feed decoded chunks, get one callback per
 *  complete line. Handles lines split across chunks; a trailing partial line
 *  is delivered by `flush()` (defensive — the server always ends with \n). */
export function createRewriteStreamParser(onEvent: (event: RewriteStreamEvent) => void) {
  let buffer = '';
  const emit = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as RewriteStreamEvent);
    } catch {
      // Skip malformed lines rather than killing the whole stream.
    }
  };
  return {
    feed(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    },
    flush() {
      emit(buffer);
      buffer = '';
    },
  };
}
