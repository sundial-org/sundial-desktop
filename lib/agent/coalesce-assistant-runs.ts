// Display transform shared by the transcript and its tests.
//
// Live streaming can split one assistant turn into several consecutive
// assistant UIMessages (one per tool/step boundary), which would render as a
// stack of separate "Ran N tools" badges. We merge consecutive assistant
// messages into one turn bubble so their contiguous tool parts collapse into a
// single group. Persisted history already arrives as one message per turn, so
// this is a no-op on reload.
//
// Pure (UIMessage[] → UIMessage[], no React) so it can be exercised directly by
// tests/ui/sundial-chat-live-transcript.test.tsx — the guard that the live
// transcript never duplicates or drops turns.

import type { UIMessage } from 'ai';

export function messageMeta(message: UIMessage): Record<string, unknown> {
  const m = message.metadata as Record<string, unknown> | null | undefined;
  return m && typeof m === 'object' ? m : {};
}

export function messageHasTurnEdits(message: UIMessage): boolean {
  return messageMeta(message).has_turn_edits === true;
}

// FNV-1a over the string — cheap, dependency-free, and (unlike a length tally)
// changes when content is replaced in place with same-length content.
function cheapHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * Cheap content fingerprint of a single message's *rendered* output, used to
 * memoize transcript rows. `coalesceAssistantRuns` returns fresh objects on
 * every streaming token (and re-merges runs), so row identity is unstable —
 * comparing this signature lets a row skip re-rendering when its visible
 * content is unchanged, turning the per-token cost from O(all messages) into
 * O(the one streaming message). It hashes the WHOLE of each part (not selected
 * fields) so any in-place change — a streaming input/output delta, a same-length
 * text/tool reconcile — invalidates the row; hashing the full part (vs picking
 * fields) also means a new rendered field can't silently slip past the memo.
 * Hashing the transcript per token is still ~100× cheaper than the markdown
 * re-render it avoids. Only ever compared against the SAME row's previous value,
 * so cross-message collisions are irrelevant.
 */
export function messageRenderSignature(message: UIMessage): string {
  const meta = messageMeta(message);
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const segs: string[] = [message.role, String(parts.length)];
  for (const p of parts) {
    const type = typeof (p as { type?: unknown })?.type === 'string' ? (p as { type: string }).type : '?';
    segs.push(`${type}:${cheapHash(safeStringify(p))}`);
  }
  segs.push(
    `e${typeof meta.edited_file_count === 'number' ? meta.edited_file_count : ''}`,
    `h${meta.has_turn_edits ? 1 : 0}`,
    `s${typeof meta.run_status === 'string' ? meta.run_status : ''}`,
    `r${typeof meta.run_error === 'string' ? meta.run_error : ''}`,
    `a${cheapHash(safeStringify(Array.isArray(meta.attachments) ? meta.attachments : []))}`,
    // Scheduled-run presentation (source tag / skipped note) renders from meta.
    `m${typeof meta.source === 'string' ? meta.source : ''}${meta.skipped === true ? '!' : ''}${typeof meta.skip_reason === 'string' ? cheapHash(meta.skip_reason) : ''}`,
  );
  return segs.join('|');
}

export function coalesceAssistantRuns(messages: UIMessage[]): UIMessage[] {
  const out: UIMessage[] = [];
  for (const message of messages) {
    const prev = out[out.length - 1];
    if (message.role === 'assistant' && prev && prev.role === 'assistant') {
      const prevParts = Array.isArray(prev.parts) ? prev.parts : [];
      const nextParts = Array.isArray(message.parts) ? message.parts : [];
      // Later metadata wins; keep the id of whichever message carries the
      // turn's edits (so the diff card / turn link resolve), else the latest.
      const id = messageHasTurnEdits(message)
        ? message.id
        : messageHasTurnEdits(prev)
          ? prev.id
          : message.id;
      out[out.length - 1] = {
        ...prev,
        id,
        parts: [...prevParts, ...nextParts] as UIMessage['parts'],
        metadata: { ...(prev.metadata ?? {}), ...(message.metadata ?? {}) },
      } as UIMessage;
    } else {
      out.push(message);
    }
  }
  return out;
}
