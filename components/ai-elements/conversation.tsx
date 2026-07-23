"use client";

import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

// A reader is "following" only when parked within a few px of the true bottom —
// NOT merely inside the library's 70px near-bottom zone. Small enough that a
// reader sitting ~20px above the bottom to read is left alone; large enough to
// absorb sub-pixel rounding of scrollTop/clientHeight/scrollHeight.
const FOLLOW_EPS_PX = 4;

/**
 * Keeps a chat pinned to the bottom while you're following the stream, but leaves
 * you alone the moment you scroll up to read — even as Sunny keeps streaming.
 *
 * The library treats its whole 70px near-bottom zone as "at the bottom" and a
 * downward scroll re-engages its auto-follow, so a reader ~20px above the bottom
 * got yanked down by the next token. We track our own `followingRef` instead:
 *
 *  - RELEASE (stop following): synchronously on a wheel-up in the event itself,
 *    plus the false→true edge of the library's sync `state.escapedFromLock`
 *    mirror for non-wheel escapes (scrollbar drag, selection). Waiting for the
 *    React-committed `escapedFromLock` lost a race to streamed-token renders —
 *    the pin yanked the reader down, the library read that as a user scroll-down
 *    and cancelled the escape, and the loop flickered (worst on WKWebView). Both
 *    signals are real user intent, unlike sniffing scroll deltas ourselves
 *    (which mis-read the few-px lag of a fast stream as "scrolled up").
 *  - RE-ENGAGE: only when the scroller actually reaches the TRUE bottom (within a
 *    few px), never merely the library's 70px zone. So nudging down to read at
 *    ~20px above the bottom stays put.
 *  - A ResizeObserver catches each streamed growth (React never re-renders for the
 *    async markdown growth) and, when not following, calls `stopScroll()` to cancel
 *    the library's resize-follow so the reading position holds.
 *  - `scrollToBottom` is wrapped so the scroll-to-latest button / programmatic
 *    jumps re-engage following. We deliberately do NOT override `targetScrollTop`:
 *    it also feeds `isNearBottom`/`isAtBottom`, so freezing it there would peg the
 *    chat to "at bottom" and hide the scroll-to-latest button.
 *  - A first-paint pin (while following) kills the open/switch flash.
 */
function BottomFollowGuard() {
  const context = useStickToBottomContext();
  const { scrollRef, stopScroll } = context;
  const followingRef = useRef(true);

  // Re-engage following on any explicit scroll-to-bottom. Capture the library's
  // own handle once (its identity is stable) so re-wrapping each render can't stack.
  const rawScrollToBottom = useRef<typeof context.scrollToBottom | null>(null);
  rawScrollToBottom.current ??= context.scrollToBottom;
  const followToBottom = rawScrollToBottom.current;
  context.scrollToBottom = (options) => {
    followingRef.current = true;
    return followToBottom(options);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const content = el.firstElementChild;
    const atTrueBottom = () =>
      el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_EPS_PX;
    // Re-engage following only at the TRUE bottom. We never flip following OFF
    // here — that's the wheel/escape release's job — so the few-px lag of a fast
    // stream can't be misread as a user scroll and drop the follow.
    const onScroll = () => {
      if (atTrueBottom()) followingRef.current = true;
    };
    // Release the follow the instant the user wheels up — synchronously, in the
    // event itself. The library's `escapedFromLock` flip only reaches us on a
    // React commit, and a streamed token can render in that gap: the pin below
    // would slam the reader back to the bottom, the library would read that raw
    // scrollTop jump as a user scroll-down and CANCEL the escape, and the cycle
    // repeated as a visible flicker while scrolling up mid-stream (worst on the
    // desktop WKWebView). deltaY-up is direct user intent (the library keys off
    // the same signal), unlike scroll-delta sniffing, which mis-reads stream lag.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0 || el.scrollHeight <= el.clientHeight) return;
      // A wheel inside a nested scroller is not an intent to leave the bottom
      // of the conversation — but only if that scroller can actually consume
      // THIS wheel: vertical overflow (chat code blocks are overflow-x-auto —
      // computed overflow auto with nothing to scroll vertically) and not
      // already at its top, where an upward wheel chains to the conversation.
      for (let target = event.target as Element | null; target && target !== el; target = target.parentElement) {
        if (
          ['scroll', 'auto'].includes(getComputedStyle(target).overflowY) &&
          target.scrollHeight > target.clientHeight &&
          target.scrollTop > 0
        )
          return;
      }
      followingRef.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    // Streamed growth the React tree never re-renders for: only a ResizeObserver
    // on the content sees it. If the reader isn't following, cancel the library's
    // resize-follow so their place holds (stopScroll sets escaped → isAtBottom
    // false synchronously, so the library's follow animation aborts on its rAF).
    const ro =
      content &&
      new ResizeObserver(() => {
        if (!followingRef.current && !atTrueBottom()) stopScroll();
      });
    if (ro && content) ro.observe(content);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      if (ro) ro.disconnect();
    };
  }, [scrollRef, stopScroll]);

  // Escapes that arrive without a wheel event (scrollbar drag, text selection)
  // land in the library's synchronous `state.escapedFromLock` mirror before any
  // commit — release on its false→true EDGE right here, pre-pin, so the pin in
  // this same effect can't fire on the render that carries the escape. Edge, not
  // level: after a scroll-to-latest the library can leave the flag stuck true
  // (its programmatic scrolls never clear it), and following must survive that.
  // The stuck-flag state also mutes the edge for later non-wheel escapes, so the
  // pin is additionally gated on the sync `isAtBottom` mirror — every user
  // escape path (wheel, scroll-up, selection, stopScroll) clears it, while
  // follow scrolls and scroll-to-latest keep it set.
  const prevEscapedRef = useRef(false);
  useLayoutEffect(() => {
    const { escapedFromLock, isAtBottom } = context.state;
    if (escapedFromLock && !prevEscapedRef.current) followingRef.current = false;
    prevEscapedRef.current = escapedFromLock;
    const el = scrollRef.current;
    if (el && followingRef.current && isAtBottom) el.scrollTop = el.scrollHeight;
  });
  return null;
}

export const Conversation = ({ className, children, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    // `initial`/`resize` = "instant" — a smooth spring follow looked nicer but its
    // in-flight animation fought a user scrolling up mid-stream (re-introducing the
    // yank), so we keep the snappy instant follow. Smoothness comes from the
    // typewriter reveal instead. BottomFollowGuard kills the pre-paint flash.
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  >
    {/* Conversation is always used with element children (the transcript), not
        StickToBottom's render-prop form. */}
    {children as ReactNode}
    <BottomFollowGuard />
  </StickToBottom>
);

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-3 p-4", className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<"button">;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  // Call through the context object live (not a destructured snapshot) so we hit
  // BottomFollowGuard's wrapped scrollToBottom, which re-engages following — a
  // destructured copy taken on first render could be the pre-wrap original.
  const context = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    context.scrollToBottom();
  }, [context]);

  if (context.isAtBottom) return null;

  return (
    <button
      type="button"
      onClick={handleScrollToBottom}
      aria-label="Scroll to latest"
      className={cn(
        "absolute bottom-3 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 shadow-[0_1px_2px_rgba(28,25,23,0.05)] transition hover:bg-stone-50 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-300",
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </button>
  );
};
