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

// One agentic-loop cap across all three harnesses (steps for the Vercel loop,
// `maxTurns` for the Claude/OpenAI SDKs). A runaway-loop backstop, not a work
// budget — long autonomous runs must not be cut off mid-task.
export const MAX_AGENT_STEPS = 200;

// Token usage in the exact shape `runner.drainAgentInto` reads: it sums
// `inputTokens`/`outputTokens` for the messages row and prices the turn from
// `inputTokenDetails` (cache reads/writes are billed at different rates;
// `noCacheTokens` is the fresh-input count — Anthropic reports it exclusive of
// cache, so when a provider omits the breakdown we fall back to `inputTokens`).
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
