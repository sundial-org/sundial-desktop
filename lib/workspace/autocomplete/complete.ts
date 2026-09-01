import { generateText, type LanguageModel } from 'ai';
import { buildAutocompletePrompt, type AutocompleteRequest } from './prompt';

/**
 * One model call for one ghost-text completion. The `LanguageModel` is
 * INJECTED rather than constructed here: the Next route passes
 * `gateway('anthropic/claude-haiku-4.5')` from `lib/workspace/ai-gateway.ts`
 * (whose undici parallel-fetch dispatcher is Next-server-only), while the
 * prompt notebook passes a plain `createGateway()` model from
 * `npm:@ai-sdk/gateway`. Same prompt, same post-processing, one code path.
 *
 * Returns the RAW completion text — post-processing is `engine.ts`'s job, so
 * the notebook can render raw vs. processed side by side.
 */
export async function runAutocomplete(
  request: AutocompleteRequest,
  model: LanguageModel,
  options?: {
    abortSignal?: AbortSignal;
    /** Token counts for the metering path, reported the way the rewrite route
     *  reports its picker call: a callback, so the notebook keeps taking the
     *  same `Promise<string>` return. */
    onUsage?: (usage: { inputTokens?: number; outputTokens?: number } | null) => void;
  },
): Promise<string> {
  const { system, prompt, prefill, temperature, maxOutputTokens, stopSequences } =
    buildAutocompletePrompt(request);
  const result = await generateText({
    model,
    system,
    // A prefilled assistant turn, not a bare `prompt`: the completion has to
    // be able to START with a space (`than` + ` baseline`), and a reply never
    // does. The anchor takes that first position instead — see
    // `INSERTION_ANCHOR`. `result.text` is the continuation only, so the
    // anchor is not in the returned text (the engine strips it anyway, for
    // providers that treat the prefill as an ordinary previous turn).
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: prefill },
    ],
    temperature,
    maxOutputTokens,
    // Omitted when empty: providers reject an empty/whitespace-only list.
    ...(stopSequences.length ? { stopSequences } : {}),
    abortSignal: options?.abortSignal,
  });
  options?.onUsage?.(result.usage ?? null);
  return result.text ?? '';
}
