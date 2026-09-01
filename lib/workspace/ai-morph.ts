/* ── Live text morphing: axes + stream protocol ───────────────────────
 *  Shared by the morph API route and the Prism / length-resize popups. A
 *  "morph" is a fast rewrite of a captured passage along quantized semantic
 *  axes (Prism) or toward a target length (resize). Variants are keyed by
 *  their grid position so the client can cache and prefetch neighbors — the
 *  perceived speed comes from asking for a position BEFORE the knob lands on
 *  it. Client-safe: no server imports.
 * ─────────────────────────────────────────────────────────────────── */

export type MorphAxisId =
  | 'tone'
  | 'energy'
  | 'certainty'
  | 'complexity'
  | 'warmth'
  | 'abstraction';

export type MorphAxis = {
  id: MorphAxisId;
  /** Axis name in the picker. */
  label: string;
  /** Pole labels rendered at the dial's edges (negative / positive). */
  neg: string;
  pos: string;
  /** System-prompt clause for a step toward each pole; the route scales it
   *  with "slightly"/"strongly" for |value| 1/2. */
  negInstruction: string;
  posInstruction: string;
};

export const MORPH_AXES: readonly MorphAxis[] = [
  {
    id: 'tone',
    label: 'Tone',
    neg: 'casual',
    pos: 'formal',
    negInstruction: 'make the register more casual and conversational',
    posInstruction: 'make the register more formal and polished',
  },
  {
    id: 'energy',
    label: 'Energy',
    neg: 'measured',
    pos: 'punchy',
    negInstruction: 'make the delivery calmer and more measured',
    posInstruction: 'make the delivery punchier and more energetic, with shorter beats',
  },
  {
    id: 'certainty',
    label: 'Certainty',
    neg: 'hedged',
    pos: 'assertive',
    negInstruction: 'hedge the claims more; add qualifiers and soften assertions',
    posInstruction: 'commit to the claims; strip qualifiers and state things directly',
  },
  {
    id: 'complexity',
    label: 'Complexity',
    neg: 'plain',
    pos: 'technical',
    negInstruction: 'use plainer, simpler vocabulary anyone could read',
    posInstruction: 'use more precise, technical vocabulary for an expert reader',
  },
  {
    id: 'warmth',
    label: 'Warmth',
    neg: 'blunt',
    pos: 'warm',
    negInstruction: 'make it more blunt and matter-of-fact',
    posInstruction: 'make it warmer and more personable',
  },
  {
    id: 'abstraction',
    label: 'Abstraction',
    neg: 'concrete',
    pos: 'abstract',
    negInstruction: 'ground it in concrete specifics, examples, and imagery',
    posInstruction: 'lift it toward general principles and abstractions',
  },
];

export const MORPH_AXIS_BY_ID: ReadonlyMap<MorphAxisId, MorphAxis> = new Map(
  MORPH_AXES.map((axis) => [axis.id, axis]),
);

/** Axis steps are quantized to -2..2; 0 means "leave this axis alone". */
export const MORPH_AXIS_RANGE = 2;

/** Length-resize multiplier ladder (index into it = resize level). 1 is the
 *  original text — never requested. */
export const LENGTH_LEVELS: readonly number[] = [0.4, 0.6, 0.8, 1, 1.25, 1.6, 2];
export const LENGTH_ORIGINAL_INDEX = LENGTH_LEVELS.indexOf(1);

/** One requested variant: axis steps (Prism) or a length multiplier
 *  (resize) — exactly one of the two. */
export type MorphSpec = {
  axes?: { id: MorphAxisId; value: number }[];
  /** Target length as a multiplier of the original word count. */
  lengthFactor?: number;
};

export type MorphRequestVariant = { key: string; spec: MorphSpec };

/** Hard cap on the passage — live morphs must stay fast, so it's tighter
 *  than the rewrite popup's. Shared by popups (friendly message) and the
 *  route (400); the server never silently truncates (the client applies the
 *  variant over the FULL captured selection). */
export const MAX_MORPH_TEXT_CHARS = 4000;
/** Variants per request — one prefetch wave, not a whole grid. */
export const MAX_MORPH_VARIANTS = 8;

/** NDJSON events on the POST /api/workspace/morph response. Variants are
 *  keyed (not slotted): keys are client-chosen grid positions. */
export type MorphStreamEvent =
  | { type: 'start'; keys: string[] }
  | { type: 'delta'; key: string; text: string }
  | { type: 'variant-done'; key: string }
  | { type: 'variant-error'; key: string; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Incremental NDJSON reader (same shape as the rewrite popup's): feed
 *  decoded chunks, get one callback per complete line; `flush()` delivers a
 *  trailing partial line. */
export function createMorphStreamParser(onEvent: (event: MorphStreamEvent) => void) {
  let buffer = '';
  const emit = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as MorphStreamEvent);
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

const INTENSITY = ['', 'slightly', 'strongly'];

/** The system-prompt clauses for one spec, or null when the spec is a no-op
 *  (all axes 0 / length 1) or malformed. Exported for the route and tests. */
export function morphInstructions(spec: MorphSpec, originalWordCount: number): string[] | null {
  const clauses: string[] = [];
  for (const { id, value } of spec.axes ?? []) {
    const axis = MORPH_AXIS_BY_ID.get(id);
    const step = Math.round(value);
    if (!axis || step === 0) continue;
    if (Math.abs(step) > MORPH_AXIS_RANGE) return null;
    const strength = INTENSITY[Math.abs(step)];
    const base = step < 0 ? axis.negInstruction : axis.posInstruction;
    clauses.push(`${strength ? `${strength} ` : ''}${base}`);
  }
  if (spec.lengthFactor !== undefined) {
    const factor = Number(spec.lengthFactor);
    if (!Number.isFinite(factor) || factor < 0.2 || factor > 3) return null;
    if (factor !== 1) {
      const target = Math.max(3, Math.round(originalWordCount * factor));
      clauses.push(
        factor < 1
          ? `condense it to roughly ${target} words (it is ${originalWordCount}) without losing any essential meaning`
          : `expand it to roughly ${target} words (it is ${originalWordCount}), elaborating naturally without inventing new facts`,
      );
    }
  }
  return clauses.length > 0 ? clauses : null;
}

/** Count of words in a passage, the unit the length ladder is defined in. */
export function wordCount(text: string): number {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}
