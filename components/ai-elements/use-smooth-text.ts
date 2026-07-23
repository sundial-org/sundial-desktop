"use client";

import { useEffect, useRef, useState } from "react";

// Client-side display smoothing. Reveals streamed assistant text a little at a
// time at a steady cadence, so a burst of model tokens reads as a smooth
// typewriter (paired with Streamdown's per-word fade) instead of popping in big
// chunks — and the transcript grows in small even steps instead of jumping
// several lines at once (the awkward scrollbar twitch).
//
// Crucially this paces only the *display*: the raw stream still reaches the
// brain's stall-watchdog and partial-text persistence untouched. (Vercel's
// server-side `smoothStream` sat in front of those and corrupted stall detection
// + lost buffered partial text on a drop — see runner-integration tests.)
//
// The caller passes `streaming = true` only for the live reply; when it flips
// false the full text shows immediately, and history/each message is keyed by id
// so a new reply starts its reveal fresh.
export function useSmoothStreamedText(text: string, streaming: boolean): string {
  const [shownLen, setShownLen] = useState(() => (streaming ? 0 : text.length));
  const targetRef = useRef(text);
  targetRef.current = text;

  useEffect(() => {
    if (!streaming) {
      setShownLen(targetRef.current.length);
      return;
    }
    // ~30 reveals/sec (not per-frame) to keep markdown re-parsing cheap. Advance
    // more when further behind so a fast stream never lags noticeably, with a
    // floor so a slow trickle still moves.
    const id = setInterval(() => {
      setShownLen((len) => {
        const target = targetRef.current.length;
        if (len >= target) return len; // caught up (or text shrank) → no re-render
        const step = Math.max(4, Math.ceil((target - len) / 8));
        return Math.min(target, len + step);
      });
    }, 33);
    return () => clearInterval(id);
  }, [streaming]);

  if (!streaming) return text;
  let end = Math.min(shownLen, text.length);
  // Hold at the last word boundary so words appear whole (matching the fade),
  // never as a half-typed fragment.
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > 0) end = space;
  }
  return text.slice(0, end);
}
