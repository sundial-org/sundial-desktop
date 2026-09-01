/** The model autocomplete uses when the user has no saved override. Shared by
 *  the route (fallback at mint time) and the preferences picker (labelling the
 *  "Default" row) — client-safe, so no 'server-only' here. */
export const DEFAULT_AUTOCOMPLETE_MODEL = 'anthropic/claude-haiku-4.5';

/** The featured row of the autocomplete model picker: the roster
 *  the out-of-tree latency notebook benchmarks, led by the production
 *  default and then ordered by measured TTFT (codestral 392ms → haiku 787ms).
 *  Ghost text is latency-bound, so the chat picker's flagship row (Opus,
 *  GPT 5.5, …) is the wrong short list here — those stay one "More models"
 *  click away. Anchors name a *line*, not a release: the picker hands a slot
 *  to a newer sibling of the same family when one lands, which is also why
 *  one Flash-Lite slot covers the three generations the notebook sweeps. */
export const AUTOCOMPLETE_FEATURED_MODEL_IDS: ReadonlyArray<string> = [
  'anthropic/claude-haiku-4.5',
  'mistral/codestral',
  'google/gemini-3.5-flash-lite',
  'inception/mercury-coder-small',
  // The one slot the notebook lists as a candidate rather than a result
  // ("other candidates worth a sweep") — cheap, fast, and the obvious OpenAI
  // entry for this tier.
  'openai/gpt-5.4-nano',
];
