// The harness abstraction.
//
// Sundial can run a turn through three agent runtimes — the Vercel AI SDK
// (`vercel`, the long-standing default), Anthropic's Claude Agent SDK
// (`claude`), and the OpenAI Agents SDK (`openai`). The user's bet: the
// frontier models are trained inside their lab harnesses, so running them
// through those harnesses (system prompt, tool-use discipline, context
// management) beats a generic loop.
//
// The runner doesn't care which one it called. Every harness returns the same
// three things `drainAgentInto` consumes from a Vercel `streamText` result:
//   * toUIMessageStream(opts) → ReadableStream<UIMessageChunk>   (the wire)
//   * text                    → the combined assistant text       (persist)
//   * totalUsage              → token breakdown for the ledger     (billing)
// so the SSE/Redis layer, persistence, and every frontend component are reused
// unchanged. The only per-harness code is the model-stream → UIMessageChunk
// translation (see ui-stream.ts) plus history/tool/usage adapters.

import type { ModelMessage, UIMessageChunk } from "ai";
import type { EditMode } from "../session/edit-mode.js";

export const HARNESS_NAMES = ["vercel", "claude", "openai"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export function parseHarnessName(raw: unknown): HarnessName | null {
  return raw === "vercel" || raw === "claude" || raw === "openai" ? raw : null;
}

/** Default harness when a chat/workspace hasn't pinned one. */
export const DEFAULT_HARNESS: HarnessName = "vercel";

// Invariant: agent runs are uncapped — only a user interrupt, the model
// finishing, or the credit gate may end a run. Passed explicitly wherever the
// Vercel AI SDK takes `stopWhen`, because OMITTING it silently defaults to
// stepCountIs(20) (ToolLoopAgent) / stepCountIs(1) (bare streamText).
export const neverStop = () => false;

// Token usage in the exact shape `runner.drainAgentInto` reads: it sums
// `inputTokens`/`outputTokens` for the messages row and prices the turn from
// `inputTokenDetails` (cache reads/writes are billed at different rates;
// `noCacheTokens` is the fresh-input count). Only `inputTokenDetails` is
// normalized across harnesses — `inputTokens` is whatever its producer reports
// (fresh-only for the Claude harness, the cache-inclusive total for the Vercel
// path), so it feeds the messages row, never the price. A producer that omits
// the breakdown is read as an inclusive total (see `usageBreakdown`).
export type HarnessUsage = {
  inputTokens: number;
  outputTokens: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    noCacheTokens?: number;
  };
};

export const EMPTY_USAGE: HarnessUsage = { inputTokens: 0, outputTokens: 0 };

// The Prompt half of a turn, mirroring `sundialAgent.stream(...)` args so the
// runner call site is identical across harnesses.
export type HarnessStreamOptions = {
  chatId: string;
  workspaceId: string;
  appBaseUrl: string | null;
  modelIdOverride: string | null;
  editMode: EditMode;
};

export type HarnessStreamArgs = {
  options: HarnessStreamOptions;
  messages: ModelMessage[];
  abortSignal: AbortSignal;
};

// `sendStart`/`sendFinish` are honored by NOT emitting the `start`/`finish`
// chunks — the runner owns those (it emits a single `start` with the Supabase
// row id and a single terminal `finish`). `sendReasoning: false` drops
// thinking deltas.
export type HarnessUIStreamOptions = {
  sendReasoning: boolean;
  sendStart: boolean;
  sendFinish: boolean;
  /** Maps a raw stream error to the client-facing errorText — the SDK default
   *  masks everything as "An error occurred.", so the runner passes this to
   *  see the raw error (gateway timeout classification) while keeping the
   *  masked text on the wire. Custom harnesses may ignore it. */
  onError?: (error: unknown) => string;
};

export type HarnessStreamResult = {
  toUIMessageStream(opts: HarnessUIStreamOptions): ReadableStream<UIMessageChunk>;
  // Plain values or promises — the runner reads both via `Promise.resolve(...)`.
  readonly text: Promise<string> | string;
  readonly totalUsage: Promise<HarnessUsage> | HarnessUsage;
  // Per-step routing metadata for BYOK billing confirmation (see runner
  // drainAgentInto). The Vercel result carries the gateway's real steps;
  // harnesses that attach the user's key directly synthesize one.
  readonly steps?: Promise<unknown[]>;
};

export interface Harness {
  readonly name: HarnessName;
  stream(args: HarnessStreamArgs): Promise<HarnessStreamResult>;
}
