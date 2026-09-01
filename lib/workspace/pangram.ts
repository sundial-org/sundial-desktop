/* ── Pangram AI-detection: types shared by routes and popup ───────────
 *  Client-safe: no server imports. The check route proxies Pangram's async
 *  v4 API (segment-level verdicts); the humanize route runs the
 *  rewrite→score loop against the synchronous classifier.
 * ─────────────────────────────────────────────────────────────────── */

export type PangramWindow = {
  /** Segment text — a (possibly whitespace-normalized) substring of the
   *  submitted passage; located in the doc by search, never by index. */
  text: string;
  label: string;
  aiAssistanceScore: number;
  confidence: string;
  isHumanized: boolean;
};

export type PangramCheckResponse = {
  headline: string;
  prediction: string;
  fractionAi: number;
  fractionAiAssisted: number;
  windows: PangramWindow[];
};

export type HumanizeStreamEvent =
  | { type: 'attempt-start'; attempt: number }
  | { type: 'delta'; text: string }
  | { type: 'score'; attempt: number; aiLikelihood: number }
  | { type: 'result'; text: string; aiLikelihood: number; passed: boolean; attempts: number }
  | { type: 'error'; message: string };

export const MAX_PANGRAM_TEXT_CHARS = 40_000;
export const MAX_HUMANIZE_TEXT_CHARS = 8000;
/** Pangram wants real prose — tiny snippets classify as noise. */
export const MIN_PANGRAM_TEXT_CHARS = 80;

/** True when a segment label means "the detector flagged this". */
export function isFlaggedLabel(label: string): boolean {
  return /ai/i.test(label) && !/human/i.test(label);
}

/** Incremental NDJSON reader for the humanize stream. */
export function createHumanizeStreamParser(onEvent: (event: HumanizeStreamEvent) => void) {
  let buffer = '';
  const emit = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as HumanizeStreamEvent);
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
