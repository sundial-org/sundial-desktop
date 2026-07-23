// Reverse adapter: Sundial's stored row shape → AI SDK UIMessage[].
//
// Why: AI Elements components (Message, Tool, Reasoning) render UIMessage
// parts directly. Sundial persists a turn as multiple rows in the order
// [user, tool_use_A, tool_result_A, tool_use_B, tool_result_B, assistant
// text] — the brain re-anchors the assistant row's sequence at onFinish so
// it lands AFTER the tool chain (see agent-ts/src/session/runner.ts).
//
// This module folds those rows into one UIMessage per turn with parts in
// source order: [tool-A, tool-B, text]. The previous chain-shaped
// ChatMessage[] intermediate goes away; AI Elements iterates parts
// directly.
//
// User rows stay as separate UIMessages (no tool calls on the user side).
// System rows that aren't tool_use/tool_result/thinking pass through as
// assistant-side text bubbles for backwards compatibility (loop events,
// task events) — those have their own existing rendering paths and
// will be handled by separate AI Elements wrappers in a follow-up.
//
// Important shape detail: AI SDK's tool part `type` is `tool-<name>` and
// the union member is keyed off that. We synthesise inputs/outputs into
// the right state ('input-streaming' / 'output-available' / 'output-error')
// so AI Elements' <Tool/ToolHeader> animates and styles correctly.

import type { UIMessage, ToolUIPart } from 'ai';

// The SDK's UIMessagePart<DATA_TYPES, TOOLS> generic is parameterised on
// the app's specific data/tool registry. We don't carry a typed registry,
// so we manipulate parts as opaque records and cast at the UIMessage
// boundary — runtime shape is what AI Elements checks.
type AnyPart = Record<string, unknown>;
import type { ChatMessage } from '@/app/w/[slug]/_components/workspace-chat-model';

type RowMeta = Record<string, unknown>;

function getMeta(row: ChatMessage): RowMeta {
  return row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? (row.metadata as RowMeta)
    : {};
}

function metaString(meta: RowMeta, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' ? v : null;
}

function metaBool(meta: RowMeta, key: string): boolean {
  return meta[key] === true;
}

function classifyRow(row: ChatMessage):
  | { kind: 'user' }
  | { kind: 'assistant_text' }
  | { kind: 'tool_use'; toolCallId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolCallId: string; content: string; isError: boolean }
  | { kind: 'thinking'; content: string }
  | {
      kind: 'compile_status';
      phase: 'compiling' | 'failed' | 'succeeded';
      texPath: string | null;
      attempt: number | null;
      errorTail: string | null;
    }
  | { kind: 'other_system' } {
  if (row.role === 'user') return { kind: 'user' };
  if (row.role === 'assistant') return { kind: 'assistant_text' };
  // system
  const meta = getMeta(row);
  const type = metaString(meta, 'type');
  if (type === 'tool_use') {
    const tool = (meta.tool ?? {}) as Record<string, unknown>;
    return {
      kind: 'tool_use',
      toolCallId: metaString(meta, 'tool_use_id') ?? row.id,
      toolName: typeof tool.name === 'string' ? tool.name : 'tool',
      input: tool.input ?? null,
    };
  }
  if (type === 'tool_result') {
    return {
      kind: 'tool_result',
      toolCallId: metaString(meta, 'tool_use_id') ?? row.id,
      content: row.content ?? '',
      isError: metaBool(meta, 'is_error'),
    };
  }
  if (type === 'thinking') {
    return { kind: 'thinking', content: row.content ?? '' };
  }
  // Legacy compile-status rows (option-2 era, before the brain inlined the
  // auto-fix loop). Convert to a data-compile-status part so the AI
  // Elements transcript renders them the same as freshly streamed ones.
  if (type === 'latex_compiling' || type === 'latex_failed' || type === 'latex_succeeded') {
    const phase: 'compiling' | 'failed' | 'succeeded' =
      type === 'latex_failed' ? 'failed' : type === 'latex_succeeded' ? 'succeeded' : 'compiling';
    const attemptRaw = meta.attempt;
    return {
      kind: 'compile_status',
      phase,
      texPath: metaString(meta, 'tex_path'),
      attempt: typeof attemptRaw === 'number' && Number.isFinite(attemptRaw) ? attemptRaw : null,
      errorTail: metaString(meta, 'error_tail'),
    };
  }
  return { kind: 'other_system' };
}

function toolPartFor(
  toolName: string,
  toolCallId: string,
  input: unknown,
  result: { content: string; isError: boolean } | null,
): ToolUIPart {
  // Construct the part directly — the SDK's exported types are unions
  // discriminated on `type: 'tool-<name>'` and `state`. AI Elements'
  // <Tool/> reads `type` to derive the displayed name when no `title` is
  // provided, and `state` for the status badge.
  if (!result) {
    return {
      type: `tool-${toolName}` as ToolUIPart['type'],
      toolCallId,
      state: 'input-available',
      input,
    } as ToolUIPart;
  }
  if (result.isError) {
    return {
      type: `tool-${toolName}` as ToolUIPart['type'],
      toolCallId,
      state: 'output-error',
      input,
      errorText: result.content,
    } as ToolUIPart;
  }
  return {
    type: `tool-${toolName}` as ToolUIPart['type'],
    toolCallId,
    state: 'output-available',
    input,
    output: result.content,
  } as ToolUIPart;
}

/**
 * Fold the stored row stream into UIMessages.
 *
 * Walking algorithm:
 *   - Each user row → its own UIMessage (no tool plumbing).
 *   - System tool_use/tool_result/thinking rows accumulate into a pending
 *     parts buffer.
 *   - When an assistant row arrives we flush the pending parts (preceding
 *     it) PLUS the assistant's text into one UIMessage. This matches the
 *     option-2 sequence ordering where the brain re-anchors the assistant
 *     row to land after its tool chain.
 *   - Trailing tool/thinking rows with no assistant row after them (in-
 *     flight turn that errored, or live mid-stream) get flushed as a
 *     synthetic assistant UIMessage so they still render.
 */
export function rowsToUIMessages(rows: ChatMessage[]): UIMessage[] {
  const out: UIMessage[] = [];

  type Pending = {
    parts: AnyPart[];
    // Track tool_use parts by call id so a later tool_result can upgrade
    // the matching entry in-place rather than appending an orphan result.
    toolByCallId: Map<string, number>; // callId → index in parts
    earliestSequence: number | null;
    earliestCreatedAt: string | undefined;
  };

  let pending: Pending = {
    parts: [],
    toolByCallId: new Map(),
    earliestSequence: null,
    earliestCreatedAt: undefined,
  };

  const recordPendingAnchor = (row: ChatMessage) => {
    if (pending.earliestSequence === null && typeof row.sequence === 'number') {
      pending.earliestSequence = row.sequence;
    }
    if (!pending.earliestCreatedAt && row.created_at) {
      pending.earliestCreatedAt = row.created_at;
    }
  };

  const flushPendingAsSynthetic = () => {
    if (pending.parts.length === 0) return;
    out.push({
      id: `synthetic-asst-${out.length}`,
      role: 'assistant',
      parts: pending.parts as UIMessage['parts'],
      metadata: {
        ...(pending.earliestSequence !== null ? { sequence: pending.earliestSequence } : {}),
        ...(pending.earliestCreatedAt ? { created_at: pending.earliestCreatedAt } : {}),
      },
    } as UIMessage);
    pending = {
      parts: [],
      toolByCallId: new Map(),
      earliestSequence: null,
      earliestCreatedAt: undefined,
    };
  };

  for (const row of rows) {
    // Option-3 fast path: assistant rows whose metadata carries the full
    // UIMessage.parts (written by the brain at onFinish post-cleanup). We
    // emit one UIMessage with those parts verbatim — no folding, no
    // synthetic anchor logic. Tools / reasoning / text all live there
    // already in source order.
    if (row.role === 'assistant') {
      const meta = getMeta(row);
      const persistedParts = meta.parts;
      if (Array.isArray(persistedParts) && persistedParts.length > 0) {
        flushPendingAsSynthetic(); // edge case: stray pending state
        out.push({
          id: row.id,
          role: 'assistant',
          parts: persistedParts as UIMessage['parts'],
          metadata: {
            ...(typeof row.sequence === 'number' ? { sequence: row.sequence } : {}),
            ...(row.created_at ? { created_at: row.created_at } : {}),
            ...meta,
          },
        } as UIMessage);
        continue;
      }
    }

    const cls = classifyRow(row);

    if (cls.kind === 'user') {
      flushPendingAsSynthetic(); // shouldn't normally happen, but safe
      out.push({
        id: row.id,
        role: 'user',
        parts: [
          { type: 'text', text: row.content ?? '' },
        ] as UIMessage['parts'],
        metadata: {
          ...(typeof row.sequence === 'number' ? { sequence: row.sequence } : {}),
          ...(row.created_at ? { created_at: row.created_at } : {}),
          ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
        },
      } as UIMessage);
      continue;
    }

    if (cls.kind === 'tool_use') {
      recordPendingAnchor(row);
      const idx = pending.parts.length;
      pending.parts.push(toolPartFor(cls.toolName, cls.toolCallId, cls.input, null));
      pending.toolByCallId.set(cls.toolCallId, idx);
      continue;
    }

    if (cls.kind === 'compile_status') {
      // Legacy persistence (separate system row per phase). Each row stands
      // on its own — the in-place merging the live stream does (via stable
      // chunk id) was never persisted, so the loaded history just shows the
      // attempts as a sequence of indicators.
      recordPendingAnchor(row);
      pending.parts.push({
        type: 'data-compile-status',
        id: `compile-${row.id}`,
        data: {
          phase: cls.phase,
          ...(cls.texPath ? { texPath: cls.texPath } : {}),
          ...(cls.attempt !== null ? { attempt: cls.attempt } : {}),
          ...(cls.errorTail ? { errorTail: cls.errorTail } : {}),
        },
      } as AnyPart);
      continue;
    }

    if (cls.kind === 'tool_result') {
      recordPendingAnchor(row);
      const matchIdx = pending.toolByCallId.get(cls.toolCallId);
      if (matchIdx !== undefined) {
        const existing = pending.parts[matchIdx] as ToolUIPart;
        pending.parts[matchIdx] = toolPartFor(
          existing.type.replace(/^tool-/, ''),
          cls.toolCallId,
          existing.input,
          { content: cls.content, isError: cls.isError },
        );
      } else {
        // Orphan result (no preceding tool_use in this turn — shouldn't
        // happen, but render it standalone so we don't drop information).
        pending.parts.push(
          toolPartFor('unknown', cls.toolCallId, null, {
            content: cls.content,
            isError: cls.isError,
          }),
        );
      }
      continue;
    }

    if (cls.kind === 'thinking') {
      recordPendingAnchor(row);
      pending.parts.push({ type: 'reasoning', text: cls.content } as AnyPart);
      continue;
    }

    if (cls.kind === 'assistant_text') {
      // Flush this turn: pending parts (tools/reasoning that preceded
      // this assistant row in sequence) + the assistant text part.
      const parts: AnyPart[] = [...pending.parts];
      if (row.content && row.content.length > 0) {
        parts.push({ type: 'text', text: row.content } as AnyPart);
      }
      out.push({
        id: row.id,
        role: 'assistant',
        parts: parts as UIMessage['parts'],
        metadata: {
          ...(typeof row.sequence === 'number' ? { sequence: row.sequence } : {}),
          ...(row.created_at ? { created_at: row.created_at } : {}),
          ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
        },
      } as UIMessage);
      pending = {
        parts: [],
        toolByCallId: new Map(),
        earliestSequence: null,
        earliestCreatedAt: undefined,
      };
      continue;
    }

    // other_system — pass-through as a synthetic system message. We'll
    // style these later if needed; for the demo they render as plain
    // text via AI Elements' MessageContent fallback.
    flushPendingAsSynthetic();
    out.push({
      id: row.id,
      role: 'system',
      parts: [{ type: 'text', text: row.content ?? '' }] as UIMessage['parts'],
      metadata: {
        ...(typeof row.sequence === 'number' ? { sequence: row.sequence } : {}),
        ...(row.created_at ? { created_at: row.created_at } : {}),
        ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
      },
    } as UIMessage);
  }

  // Live turn that's mid-stream and hasn't written its assistant text row
  // yet — render the chain so far as a synthetic assistant turn.
  flushPendingAsSynthetic();

  return out;
}
