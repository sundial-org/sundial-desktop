/**
 * The single source of truth for the ghost-text autocomplete prompt.
 *
 * Pure and dependency-free on purpose: an out-of-tree prompt notebook
 * imports this file directly by relative path under a Deno kernel, so a
 * prompt iteration runs the exact production string rather than a copy of
 * it. Nothing here may import from `@/…`, from Next, or from
 * `lib/workspace/ai-gateway.ts` — pinned by `autocomplete-purity.test.ts`.
 *
 * Claude has no native fill-in-the-middle tokens, so FIM is expressed in the
 * prompt: the whole window is handed over with a `<CURSOR>` marker and the
 * model is asked for the insertion only.
 */

export type AutocompleteRequest = {
  /** Monaco language id (`markdown`, `latex`, …). */
  language: string;
  /** Workspace-relative path — weak but real signal about the document. */
  filePath: string;
  /** Text immediately before the cursor (already sliced by the engine). */
  prefix: string;
  /** Text immediately after the cursor (already sliced by the engine). */
  suffix: string;
};

export type AutocompletePrompt = {
  system: string;
  prompt: string;
  /** Assistant prefill the reply continues from — see `INSERTION_ANCHOR`. */
  prefill: string;
  temperature: number;
  maxOutputTokens: number;
  stopSequences: string[];
};

export const CURSOR_TOKEN = '<CURSOR>';

/**
 * Assistant prefill, and the reason ghost text no longer eats the space in
 * front of it. Claude will not begin a reply with a space: asked to insert at
 * a cursor sitting on `…in fewer iterations than`, it answers `baseline
 * approach…`, which splices in as `thanbaseline`. The space is lost before the
 * engine ever sees the text, so no amount of post-processing can restore it —
 * the two shapes are indistinguishable from `The autocomp` + `letion`, where
 * no space belongs. Prefilling one character moves the model's first emitted
 * character off the start of the reply, and the boundary whitespace survives.
 *
 * Zero-width by choice: a provider that ignores prefill (or echoes it back)
 * must not land a visible glyph mid-document, and a visible bracket invites
 * Haiku to close it. `postProcessCompletion` strips it regardless.
 */
export const INSERTION_ANCHOR = '\u2063'; // INVISIBLE SEPARATOR

/** Enough for a few lines of prose/markup; the cap is also the latency lever. */
export const AUTOCOMPLETE_MAX_OUTPUT_TOKENS = 100;

/**
 * Empty, deliberately. The natural boundary here is a blank-line triple
 * ("the model has moved on to new content"), but Anthropic rejects a
 * whitespace-only stop sequence outright — `stop_sequences: each stop
 * sequence must contain non-whitespace` — and there is no non-whitespace
 * boundary worth stopping on (a ``` fence arrives first, so stopping on it
 * would return nothing). `maxOutputTokens` plus the engine's line cap bound
 * the output instead. Caught by the prompt notebook on its first live run.
 */
export const AUTOCOMPLETE_STOP_SEQUENCES: string[] = [];

// Every line here is load-bearing and was arrived at in the notebook against
// `eval/autocomplete/post-processing.ts`. Notably, "no commentary" alone does NOT hold for prose: Haiku
// reliably answered a markdown continuation by reasoning out loud about what a
// good continuation would be. The reply-IS-the-insertion framing plus the hard
// length rule are what stop it.
const BASE_SYSTEM = [
  "You are a code completion engine. The user's cursor is at <CURSOR>.",
  'Output ONLY the characters to insert at the cursor — no repetition of',
  'surrounding text, no code fences, no commentary. Prefer short completions:',
  'finish the current expression, statement, or sentence. If no useful',
  'completion exists, output nothing.',
  'Your entire reply is spliced into the document verbatim at the cursor.',
  'Never explain your choice, never restate the task, never describe the',
  'document, never address the user. There is no reader — only the document.',
  'Stop at the end of the current sentence, statement, or block: at most one',
  'sentence of prose or five lines of markup, whichever comes first.',
].join('\n');

/** The one language-aware branch: same provider, same code path. */
const LATEX_SYSTEM_SUFFIX = [
  'This is a LaTeX document: complete prose and LaTeX markup; respect the',
  'document\'s voice. Citation rule: you may write \\cite{key} (or any \\cite',
  'variant) ONLY when that exact key already appears between the <file> tags.',
  'This project\'s bibliography is hidden from you, so no other key exists —',
  'a key you recognise from a well-known paper is still not in this project.',
  'When no key is visible, name the authors in prose and write no \\cite.',
].join('\n');

export function buildAutocompletePrompt({
  language,
  filePath,
  prefix,
  suffix,
}: AutocompleteRequest): AutocompletePrompt {
  const system =
    language === 'latex' ? `${BASE_SYSTEM}\n${LATEX_SYSTEM_SUFFIX}` : BASE_SYSTEM;
  return {
    system,
    prompt: `Language: ${language}\nFile: ${filePath}\n<file>${prefix}${CURSOR_TOKEN}${suffix}</file>`,
    prefill: INSERTION_ANCHOR,
    temperature: 0,
    maxOutputTokens: AUTOCOMPLETE_MAX_OUTPUT_TOKENS,
    stopSequences: [...AUTOCOMPLETE_STOP_SEQUENCES],
  };
}
