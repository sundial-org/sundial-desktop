// Conversation history (AI SDK `ModelMessage[]`) → each SDK's input shape.
//
// `toModelMessages` rebuilds prior turns from stored UIMessage parts, so history
// now carries assistant tool-call messages and `tool` result messages (not just
// text). The Vercel harness consumes those natively; the Claude and OpenAI
// harnesses drive their own loop off a transcript, so `transcriptTextOf` folds
// tool calls + results in as annotated text below.

import type { ModelMessage } from "ai";
// Type-only: erased at compile time, so these never trigger a runtime SDK
// import (which matters — the OpenAI SDK touches zod internals at load).
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentInputItem } from "@openai/agents";

type Img = { url: string; mediaType?: string };

function splitUserContent(content: ModelMessage["content"]): { text: string; images: Img[] } {
  if (typeof content === "string") return { text: content, images: [] };
  let text = "";
  const images: Img[] = [];
  for (const part of content) {
    if (part.type === "text") {
      text += text ? `\n${part.text}` : part.text;
    } else if (part.type === "image") {
      const img = part.image;
      const url = img instanceof URL ? img.toString() : typeof img === "string" ? img : null;
      if (url) images.push({ url, ...(part.mediaType ? { mediaType: part.mediaType } : {}) });
    }
  }
  return { text, images };
}

function textOf(content: ModelMessage["content"]): string {
  return splitUserContent(content).text;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… (${value.length - max} more chars)` : value;
}

// A tool-result part's `output` is the AI SDK typed-output envelope
// ({ type: "text"|"error-text"|"json"|..., value }) — pull the human-readable
// value back out for the transcript.
function toolResultText(output: unknown): string {
  if (output && typeof output === "object" && "value" in output) {
    const value = (output as { value: unknown }).value;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return typeof output === "string" ? output : JSON.stringify(output);
}

// Flatten a message's content to transcript text, rendering tool calls and
// their results as annotated lines. The Claude Agent SDK and OpenAI Agents SDK
// both drive their own agentic loop off a prompt/transcript rather than native
// tool messages, so history's tool calls (rebuilt in session/history.ts) are
// folded in as text here — otherwise these harnesses would silently lose every
// prior tool result, the same re-Read-every-turn bug the Vercel path had.
function transcriptTextOf(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  const lines: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.trim()) lines.push(part.text);
    } else if (part.type === "tool-call") {
      lines.push(`[called ${part.toolName}(${truncate(JSON.stringify(part.input ?? {}), 300)})]`);
    } else if (part.type === "tool-result") {
      lines.push(`[${part.toolName} result]\n${truncate(toolResultText(part.output), 1500)}`);
    }
  }
  return lines.join("\n");
}

// ---- Claude Agent SDK ------------------------------------------------------

// One transcript line per prior turn, folded into the current prompt as context
// (the SDK manages its own assistant turns, so we can't replay them as input
// messages — but it sees the full history this way).
function priorTranscript(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role =
      m.role === "assistant"
        ? "Assistant"
        : m.role === "system"
          ? "System"
          : m.role === "tool"
            ? "Tool"
            : "User";
    const t = transcriptTextOf(m.content).trim();
    const imgs = m.role === "user" ? splitUserContent(m.content).images.length : 0;
    const suffix = imgs ? ` ${"[image]".repeat(imgs)}` : "";
    if (t || imgs) lines.push(`${role}: ${t}${suffix}`);
  }
  return lines.join("\n\n");
}

// Synthesized user input for a history that does NOT end in a user message —
// the stall-recovery shape, where the runner re-invokes the harness mid-turn
// and the tail is the captured assistant text / tool results. The Claude
// prompt must end in user input, so the real tail stays in the transcript
// (correctly labeled) and this becomes the turn. Histories ending in a user
// message — every non-recovery call — are byte-identical to before.
export const CLAUDE_CONTINUATION_PROMPT =
  "Continue exactly where you left off — the previous response was cut off mid-stream.";

/**
 * Build the Claude `query()` prompt. Single-turn text → a plain string (the
 * common path, incl. the repo-summary eval). When the current turn carries
 * images, or there's prior history, we yield one streaming-input user message
 * whose content is the transcript-prefixed text plus image blocks.
 */
export function modelMessagesToClaudePrompt(
  messages: ModelMessage[],
): string | AsyncIterable<SDKUserMessage> {
  const last = messages[messages.length - 1];
  const endsInUser = last?.role === "user";
  // Only a trailing USER message is the current input; a non-user tail (stall
  // recovery) must not be popped — a trailing tool result would render empty
  // and vanish, and trailing assistant text would be relabeled "User:".
  const prior = endsInUser ? messages.slice(0, -1) : messages;
  const lastText = !last
    ? ""
    : endsInUser
      ? splitUserContent(last.content).text
      : CLAUDE_CONTINUATION_PROMPT;

  const transcript = priorTranscript(prior);
  const promptText = transcript ? `${transcript}\n\nUser: ${lastText}` : lastText;

  // Carry images from EVERY user turn (not just the last) so a follow-up like
  // "what does that image show?" still has the earlier image — matching the
  // Vercel path, which keeps prior image parts in history.
  const allImages: Img[] = messages.flatMap((m) =>
    m.role === "user" ? splitUserContent(m.content).images : [],
  );

  if (allImages.length === 0) return promptText;

  const content = [
    { type: "text" as const, text: promptText },
    ...allImages.map((im) => ({
      type: "image" as const,
      source: { type: "url" as const, url: im.url },
    })),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = { role: "user", content } as any;
  async function* gen(): AsyncIterable<SDKUserMessage> {
    yield { type: "user", message, parent_tool_use_id: null } as SDKUserMessage;
  }
  return gen();
}

// ---- OpenAI Agents SDK -----------------------------------------------------

/** Faithful transcript: user (input_text/input_image) + assistant (output_text). */
export function modelMessagesToOpenAIInput(messages: ModelMessage[]): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  // The most recent assistant item's output_text block, so a following `tool`
  // message can fold its results into the assistant turn that produced them.
  let lastAssistantText: { text: string } | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      lastAssistantText = null;
      const { text, images } = splitUserContent(m.content);
      const content: Array<Record<string, unknown>> = [];
      if (text) content.push({ type: "input_text", text });
      // The @openai/agents `input_image` item carries the URL on `image` (string
      // URL / data-URI / `{id}`); the SDK maps it to the Responses API's
      // `image_url` internally. Using `image_url` here would NOT match the SDK's
      // schema. (Verified in @openai/agents-core protocol types.)
      for (const im of images) content.push({ type: "input_image", image: im.url });
      if (content.length === 0) content.push({ type: "input_text", text: "" });
      items.push({ role: "user", content } as unknown as AgentInputItem);
    } else if (m.role === "assistant") {
      // transcriptTextOf folds this turn's tool calls in as annotated text (the
      // OpenAI Agents SDK drives its own loop, so we can't replay native tool
      // items); the paired `tool` message below appends its results here.
      const text = transcriptTextOf(m.content);
      if (!text.trim()) {
        lastAssistantText = null;
        continue;
      }
      const block = { type: "output_text", text };
      items.push({
        role: "assistant",
        status: "completed",
        content: [block],
      } as unknown as AgentInputItem);
      lastAssistantText = block;
    } else if (m.role === "tool") {
      // Prior tool results MUST stay at assistant privilege, never `system`:
      // they carry untrusted workspace file/command output, so promoting them
      // to a system item would let last turn's `Read`/`Bash` output act as
      // system-priority instructions this turn. Fold them into the assistant
      // turn that produced them; if there's no such turn, keep them as user-role
      // evidence (still not system).
      const text = transcriptTextOf(m.content);
      if (!text.trim()) continue;
      if (lastAssistantText) {
        lastAssistantText.text += `\n${text}`;
      } else {
        items.push({
          role: "user",
          content: [{ type: "input_text", text }],
        } as unknown as AgentInputItem);
      }
    } else if (m.role === "system") {
      lastAssistantText = null;
      // The agent's own system prompt is `instructions`, but compaction injects
      // the summary of older turns as a system message — preserve it so it isn't
      // dropped (OpenAI system items take a plain string).
      const text = textOf(m.content);
      if (text.trim()) items.push({ role: "system", content: text } as unknown as AgentInputItem);
    }
  }
  return items;
}
