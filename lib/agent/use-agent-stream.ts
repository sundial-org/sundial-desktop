// SSE helpers shared with `SundialChatTransport`.
//
// `useAgentMessageStream` and `uiMessageText` lived here in the era when
// Sundial had its own SSE consumer running alongside Supabase Realtime.
// Both are gone now that `useChat` from `@ai-sdk/react` owns the active
// chat — `sseBodyToChunks` is what survives because the transport still
// needs to convert SSE bytes into the SDK's `UIMessageChunk` stream.

import type { UIMessageChunk } from 'ai';

/**
 * Make a resumed chunk stream self-consistent. A resume replays from a consumed
 * character offset, so it can begin partway through a text or reasoning part —
 * the matching `text-start` / `reasoning-start` was before the offset and is
 * never re-sent. The AI SDK's stream processor rebuilds its part state fresh on
 * resume (it does NOT restore open parts from the continued message), so a
 * `*-delta` / `*-end` whose `*-start` it never saw throws
 * `Received <type>-delta for missing … part` and the whole reply errors out
 * ("Sunny couldn't reply"). We inject the missing `*-start` the first time we
 * see an orphan delta/end for an id, so the resumed tail renders (as its own
 * part) instead of killing the turn. A normally-ordered stream never triggers
 * an injection.
 *
 * Tool calls have the same hazard for `tool-input-delta` — but its
 * `tool-input-start` carries the `toolName`, which a delta lacks, so we can't
 * synthesize one. We DROP an orphan input-delta instead: that only loses the
 * live arg-typing animation; the complete input still arrives in the
 * self-contained `tool-input-available`. Tool *output* chunks resolve against
 * the continued message's parts, so they don't orphan.
 */
export function repairResumedPartBoundaries(
  source: ReadableStream<UIMessageChunk>,
): ReadableStream<UIMessageChunk> {
  const started = { text: new Set<string>(), reasoning: new Set<string>() };
  const startedTools = new Set<string>();
  const ensureStarted = (
    kind: 'text' | 'reasoning',
    id: string,
    controller: TransformStreamDefaultController<UIMessageChunk>,
  ) => {
    if (started[kind].has(id)) return;
    started[kind].add(id);
    controller.enqueue({ type: `${kind}-start`, id } as UIMessageChunk);
  };
  return source.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        const c = chunk as { type?: string; id?: unknown; toolCallId?: unknown };
        const id = typeof c.id === 'string' ? c.id : null;
        if (id) {
          if (c.type === 'text-start') started.text.add(id);
          else if (c.type === 'text-delta' || c.type === 'text-end') ensureStarted('text', id, controller);
          else if (c.type === 'reasoning-start') started.reasoning.add(id);
          else if (c.type === 'reasoning-delta' || c.type === 'reasoning-end') ensureStarted('reasoning', id, controller);
        }
        const toolCallId = typeof c.toolCallId === 'string' ? c.toolCallId : null;
        if (toolCallId) {
          if (c.type === 'tool-input-start' || c.type === 'tool-input-available') startedTools.add(toolCallId);
          else if (c.type === 'tool-input-delta' && !startedTools.has(toolCallId)) return; // drop orphan
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Pipe a `Response.body` (UTF-8 bytes of SSE frames) into a ReadableStream
 * of parsed `UIMessageChunk`s. SSE frame format is `data: <json>\n\n`;
 * comment frames (`event: ping\n…`) and any non-`data:` lines are ignored.
 */
export function sseBodyToChunks(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
  // Reports the running count of SSE *characters* consumed at each frame
  // boundary. The transport tracks this per chat and sends it back as
  // `Last-Event-ID` on reconnect so resumable-stream resumes from the offset
  // instead of replaying the whole turn (which duplicates it). The count must
  // span full frames incl. the `\n\n` separator to match the server's buffered
  // character offset.
  onChars?: (consumed: number) => void,
  // Fires once if the stream carried a terminal `finish` chunk — i.e. it ended
  // cleanly rather than being severed mid-flight. The transport uses this to
  // drop the resume cursor for THIS stream's chat (keyed correctly, unlike a
  // useChat onFinish closure whose chat id can drift after a switch), so a
  // completed chat doesn't keep an offset that a later idle reconnect would
  // read as a severed tail.
  onTerminalFinish?: () => void,
): ReadableStream<UIMessageChunk> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      // Drain the source greedily inside start() instead of using pull(): a
      // pull that consumes a frame without `data:` payload (ping, comment,
      // partial frame) would otherwise return without enqueueing, leaving
      // a waiting consumer with no signal that more data is coming.
      let buffer = '';
      let consumed = 0;
      (async () => {
        try {
          while (!abortSignal?.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              consumed += boundary + 2;
              onChars?.(consumed);
              const dataLine = frame
                .split('\n')
                .find((line) => line.startsWith('data:'));
              if (!dataLine) continue;
              const payload = dataLine.slice(5).trim();
              if (!payload) continue;
              try {
                const chunk = JSON.parse(payload) as UIMessageChunk;
                controller.enqueue(chunk);
                if ((chunk as { type?: unknown }).type === 'finish') onTerminalFinish?.();
              } catch {
                // malformed frame — skip and keep going
              }
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      })();
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}
