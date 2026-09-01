"use client";

import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  // The library's mutable state record is a stable singleton (useMemo, []) —
  // safe to close over in the observer effect below.
  const { scrollRef, stopScroll, state: libState } = context;
  const followingRef = useRef(true);
  // Last scrollTop this guard saw (scroll events + our own pins). The upward-
  // release below compares against it, so every pin records the value it set —
  // otherwise a pin whose scroll event hasn't dispatched yet would make the
  // next user scroll look like a huge jump in the wrong direction.
  const lastScrollTopRef = useRef(0);

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
    // Re-engage following at the TRUE bottom; release synchronously on an
    // upward scroll that does NOT land there. The upward release covers
    // non-wheel escapes (scrollbar drag, keyboard, selection auto-scroll)
    // during the ~1ms window before the library's deferred escape fires —
    // without it the same-frame resize pin below could yank an escaping
    // reader back down. It can't misread stream lag (content growth never
    // moves scrollTop), and our own pins plus shrink-clamps always land
    // exactly at the bottom, so they hit the re-engage branch instead.
    lastScrollTopRef.current = el.scrollTop;
    const onScroll = () => {
      const prev = lastScrollTopRef.current;
      lastScrollTopRef.current = el.scrollTop;
      if (atTrueBottom()) {
        followingRef.current = true;
        return;
      }
      if (el.scrollTop < prev - FOLLOW_EPS_PX) followingRef.current = false;
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
    // Keyboard scrolling. The scroll element is a plain div, so make it
    // focusable (click or tab lands focus on it) and translate Arrow/Page keys
    // into scrolls ourselves — WebKit doesn't reliably keyboard-scroll overflow
    // divs. An upward key releases the follow synchronously (same contract as
    // the wheel path above) and stopScroll() aborts any in-flight follow, so a
    // streamed token can't yank the reader back down. No outline on mouse
    // focus, but keep a focus-visible ring so keyboard users can see where
    // focus landed before the arrows take over.
    el.tabIndex = 0;
    el.classList.add(
      "outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-inset",
      "focus-visible:ring-stone-300"
    );
    const keyScroll = (key: string): number => {
      const page = Math.max(48, el.clientHeight - 48);
      return { ArrowUp: -48, ArrowDown: 48, PageUp: -page, PageDown: page }[key] ?? 0;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Only when the SCROLLER ITSELF is focused. A native listener runs before
      // React's delegated handlers, so keys bubbling up from a focused
      // descendant (a copy button, a Radix menu trigger, an input) must pass
      // through untouched — preventDefault here would hand the widget a
      // cancelled ArrowDown.
      if (event.target !== el || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const delta = keyScroll(event.key);
      if (!delta || el.scrollHeight <= el.clientHeight) return;
      event.preventDefault();
      if (delta < 0) {
        followingRef.current = false;
        stopScroll();
      }
      el.scrollBy({ top: delta });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    // Streamed growth the React tree never re-renders for: only a ResizeObserver
    // on the content sees it. If the reader isn't following, cancel the library's
    // resize-follow so their place holds (stopScroll sets escaped → isAtBottom
    // false synchronously, so the library's follow animation aborts on its rAF).
    //
    // While FOLLOWING, pin synchronously right here instead: RO callbacks run
    // after layout but before paint, whereas the library's "instant" follow
    // lands on the NEXT rAF — so during a pane-resize drag every rewrap frame
    // painted un-pinned and then snapped back, bouncing the transcript up and
    // down for the whole drag (~490px/frame measured). Same-frame pinning means
    // the bounce never becomes visible; scroll-anchoring adjustments Blink makes
    // mid-layout are overwritten before they paint too. Gated on the library's
    // SYNC `isAtBottom` mirror like the commit-time pin below: a non-wheel
    // escape (scrollbar drag, keyboard, selection) clears that mirror in its
    // scroll event — before this observer fires — while `followingRef` only
    // learns on the next commit, so without the gate a resize landing in that
    // gap would yank the escaping reader back to the bottom.
    const ro =
      content &&
      new ResizeObserver(() => {
        if (followingRef.current && libState.isAtBottom) {
          if (!atTrueBottom()) {
            el.scrollTop = el.scrollHeight;
            lastScrollTopRef.current = el.scrollTop;
          }
        } else if (!followingRef.current && !atTrueBottom()) {
          stopScroll();
        }
      });
    if (ro && content) ro.observe(content);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKeyDown);
      if (ro) ro.disconnect();
    };
  }, [scrollRef, stopScroll, libState]);

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
    if (el && followingRef.current && isAtBottom) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
  });
  return null;
}

type LinkPreviewData = {
  url: string;
  host: string;
  title?: string;
  description?: string;
  siteName?: string;
};

// Client-side memo of /api/link-preview results (the server has its own LRU;
// this one just avoids refetching while the user sweeps across a message).
// null = fetched and unavailable → the card stays on the URL fallback. A
// failure only sticks for a minute — mirroring the server's failure TTL — so
// a timeout blip doesn't pin the fallback for the whole tab session.
const linkPreviewCache = new Map<string, { data: LinkPreviewData | null; expires: number }>();
const PREVIEW_TTL_OK_MS = 10 * 60_000;
const PREVIEW_TTL_FAIL_MS = 60_000;

function linkPreviewFallback(href: string): LinkPreviewData {
  try {
    return { url: href, host: new URL(href).hostname };
  } catch {
    return { url: href, host: "" };
  }
}

/** Whether a preview fetch makes sense: external http(s) links only — for
 *  same-origin links (workspace file links) the URL itself says everything. */
function isPreviewableLink(href: string): boolean {
  try {
    const url = new URL(href);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== window.location.origin
    );
  } catch {
    return false;
  }
}

const PREVIEW_CARD_WIDTH = 340;

/**
 * Hover preview for chat links: a compact card anchored next to the hovered
 * link showing the page's Open Graph title + description (via
 * /api/link-preview) over a domain + full-URL line, which is also the graceful
 * fallback while loading, on fetch failure, and for same-origin/mailto links.
 * Delegated mouseover on the scroll element (links stream in constantly, so
 * per-link handlers would churn); a 300ms arm delay stops sweep-flicker; the
 * card is pointer-events-none + absolutely positioned so it can neither steal
 * the hover it reports on nor shift layout.
 */
function LinkHoverPreview() {
  const { scrollRef } = useStickToBottomContext();
  const [anchor, setAnchor] = useState<{
    href: string;
    top: number;
    left: number;
    above: boolean;
  } | null>(null);
  // Keyed by href so a card for link B can never render link A's still-loaded
  // metadata during the effect gap between hover switch and state clear.
  const [preview, setPreview] = useState<{ href: string; data: LinkPreviewData | null } | null>(
    null,
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Track the hovered ELEMENT, not its href — the same URL can appear in
    // several places, and sweeping between two occurrences must re-anchor the
    // card to the new one.
    let current: HTMLAnchorElement | null = null;
    const clear = () => {
      clearTimeout(timer);
      current = null;
      setAnchor(null);
    };
    const onOver = (event: Event) => {
      const target = event.target;
      const link = target instanceof Element ? target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || !el.contains(link)) {
        clear();
        return;
      }
      if (link === current) return;
      clearTimeout(timer);
      current = link;
      setAnchor(null);
      timer = setTimeout(() => {
        // Anchor to the conversation root (the relative, non-scrolling parent).
        const root = el.parentElement;
        if (!root || !link.isConnected) return;
        const rootRect = root.getBoundingClientRect();
        const rect = link.getBoundingClientRect();
        const above = rect.bottom - rootRect.top > root.clientHeight - 120;
        setAnchor({
          href: link.href,
          top: above ? rect.top - rootRect.top - 6 : rect.bottom - rootRect.top + 6,
          left: Math.max(
            8,
            Math.min(rect.left - rootRect.left, root.clientWidth - PREVIEW_CARD_WIDTH - 8),
          ),
          above,
        });
      }, 300);
    };
    const onLeave = () => clear();
    el.addEventListener("mouseover", onOver);
    el.addEventListener("mouseleave", onLeave);
    // Scrolling moves the link out from under the card — drop it rather than
    // let it float detached (passive: never blocks the scroll itself).
    el.addEventListener("scroll", clear, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("mouseover", onOver);
      el.removeEventListener("mouseleave", onLeave);
      el.removeEventListener("scroll", clear);
    };
  }, [scrollRef]);

  const href = anchor?.href ?? null;
  useEffect(() => {
    setPreview(null);
    if (!href || !isPreviewableLink(href)) return;
    const cached = linkPreviewCache.get(href);
    if (cached && cached.expires > Date.now()) {
      setPreview({ href, data: cached.data });
      return;
    }
    const controller = new AbortController();
    fetch(`/api/link-preview?url=${encodeURIComponent(href)}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<LinkPreviewData>) : null))
      .then((data) => {
        linkPreviewCache.set(href, {
          data: data ?? null,
          expires: Date.now() + (data ? PREVIEW_TTL_OK_MS : PREVIEW_TTL_FAIL_MS),
        });
        if (!controller.signal.aborted) setPreview({ href, data: data ?? null });
      })
      .catch(() => {
        // Aborted or network failure — leave the URL fallback in place (and
        // let a later hover retry rather than negative-caching a blip).
      });
    return () => controller.abort();
  }, [href]);

  if (!anchor) return null;
  const data =
    preview && preview.href === anchor.href && preview.data
      ? preview.data
      : linkPreviewFallback(anchor.href);
  return (
    <div
      data-testid="chat-link-preview"
      style={{
        top: anchor.top,
        left: anchor.left,
        width: PREVIEW_CARD_WIDTH,
        transform: anchor.above ? "translateY(-100%)" : undefined,
      }}
      className="pointer-events-none absolute z-20 rounded-lg border border-stone-200 bg-white/95 px-3 py-2 shadow-md backdrop-blur-sm"
    >
      {data.title ? (
        <div className="line-clamp-2 text-[13px] font-medium leading-snug text-stone-800">
          {data.title}
        </div>
      ) : null}
      {data.description ? (
        <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-stone-500">
          {data.description}
        </div>
      ) : null}
      <div
        className={cn(
          "truncate font-mono text-[11px] leading-4 text-stone-400",
          (data.title || data.description) && "mt-1"
        )}
      >
        {data.title || data.description ? (data.siteName ? `${data.siteName} · ${data.host}` : data.host) : data.url}
      </div>
    </div>
  );
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
    <LinkHoverPreview />
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
