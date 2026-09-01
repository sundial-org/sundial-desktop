/* ── /image generation: stream protocol shared by route and popup ─────
 *  Client-safe: no server imports. */

export type GenerateImageStreamEvent =
  | { type: 'prompt'; text: string }
  | { type: 'image'; slot: number; dataUrl: string }
  | { type: 'image-error'; slot: number; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export const IMAGE_CANDIDATES = 4;

/** Incremental NDJSON reader for the generate-image stream. */
export function createImageStreamParser(onEvent: (event: GenerateImageStreamEvent) => void) {
  let buffer = '';
  const emit = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as GenerateImageStreamEvent);
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
