"use client";

import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { escapeCurrencyMath } from "@/lib/markdown/escape-currency-math";
import { cn } from "@/lib/utils";
import type { FileUIPart, UIMessage } from "ai";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PaperclipIcon,
  XIcon,
} from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import { createContext, memo, useContext, useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { CODE_PLUGIN } from "@/lib/markdown/code-highlight";
import { MERMAID_CHAT_PLUGIN } from "@/lib/markdown/mermaid-render";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  // Sundial palette. User: dark stone bubble, white text — the legacy
  // chat used `bg-stone-800` rounded-2xl, brought back here for contrast.
  // Assistant: plain stone-800 text on the page background — no bubble
  // chrome, but a darker text color than AI Elements' default
  // `text-foreground` (which falls back washed-out without shadcn vars).
  <div
    className={cn(
      // overflow-x-CLIP, not hidden: horizontal blowouts (wide KaTeX etc.) stay
      // clipped, but vertical overflow stays visible — `hidden` on one axis
      // forces the other to auto, which clipped the table copy/download menus
      // when a short table ended the message (Codex on #1022).
      "flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-x-clip text-[15px] leading-relaxed",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-sm group-[.is-user]:bg-stone-800 group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-white",
      "group-[.is-assistant]:text-stone-800",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

type MessageBranchContextType = {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
};

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = (newBranch: number) => {
    setCurrentBranch(newBranch);
    onBranchChange?.(newBranch);
  };

  const goToPrevious = () => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  };

  const goToNext = () => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  };

  const contextValue: MessageBranchContextType = {
    currentBranch,
    totalBranches: branches.length,
    goToPrevious,
    goToNext,
    branches,
    setBranches,
  };

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = Array.isArray(children) ? children : [children];

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const MessageBranchSelector = ({
  className,
  from,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className="[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md"
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  className,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

// Streamdown's default chrome renders a `bg-sidebar` outer card + a
// `bg-background` inner card + a language-name header strip + a sticky
// copy/download pill. None of those tokens are wired in this app, so the
// double-box reads as a stack of empty rectangles. We let streamdown keep
// its shiki pipeline (via `@streamdown/code` + `vitesse-light`, a soft
// pastel palette that sits next to Monaco's `vs` theme in `code-viewer`
// without competing with it) and just flatten the chrome to a single
// stone-50 slab that mirrors the editor's surface.
const MARKDOWN_CHROME =
  // Outer code-block — repaint the `bg-sidebar` card as a stone-50 slab.
  "[&_[data-streamdown=code-block]]:!relative " +
  "[&_[data-streamdown=code-block]]:!my-3 " +
  "[&_[data-streamdown=code-block]]:!gap-0 " +
  "[&_[data-streamdown=code-block]]:!border-stone-200 " +
  "[&_[data-streamdown=code-block]]:!bg-stone-50 " +
  "[&_[data-streamdown=code-block]]:!p-0 " +
  // Hide the language-name header strip (no one needs `python` repeated).
  "[&_[data-streamdown=code-block-header]]:!hidden " +
  // Inner body — kill the second border + `bg-background` so the outer
  // slab shows through; shrink from 14px to 13px to match the editor.
  "[&_[data-streamdown=code-block-body]]:!border-0 " +
  "[&_[data-streamdown=code-block-body]]:!bg-transparent " +
  "[&_[data-streamdown=code-block-body]]:!text-[13px] " +
  "[&_[data-streamdown=code-block-body]]:!leading-relaxed " +
  "[&_[data-streamdown=code-block-body]]:!text-stone-800 " +
  // Streamdown wraps each line in an outer <span>; without the line-number
  // transformer those spans are inline so all lines collapse onto one row.
  "[&_[data-streamdown=code-block-body]_pre>code>span]:block " +
  // Action row: streamdown's sticky `h-8 -mt-10` wrapper reserves vertical
  // space above the body. Re-anchor it to the slab's top-right corner so
  // the code starts flush with the padding.
  "[&_[data-streamdown=code-block]>div:has(>[data-streamdown=code-block-actions])]:!absolute " +
  "[&_[data-streamdown=code-block]>div:has(>[data-streamdown=code-block-actions])]:!top-1 " +
  "[&_[data-streamdown=code-block]>div:has(>[data-streamdown=code-block-actions])]:!right-1 " +
  "[&_[data-streamdown=code-block]>div:has(>[data-streamdown=code-block-actions])]:!m-0 " +
  "[&_[data-streamdown=code-block]>div:has(>[data-streamdown=code-block-actions])]:!h-auto " +
  "[&_[data-streamdown=code-block]>div:has(>[data-streamdown=code-block-actions])]:!pointer-events-auto " +
  // Strip the action pill's border/padding so only the buttons remain;
  // fade them in on hover so idle blocks look uncluttered.
  "[&_[data-streamdown=code-block-actions]]:!gap-0 " +
  "[&_[data-streamdown=code-block-actions]]:!border-0 " +
  "[&_[data-streamdown=code-block-actions]]:!bg-transparent " +
  "[&_[data-streamdown=code-block-actions]]:!px-0 " +
  "[&_[data-streamdown=code-block-actions]]:!py-0 " +
  "[&_[data-streamdown=code-block-actions]]:!opacity-0 " +
  "[&_[data-streamdown=code-block]:hover_[data-streamdown=code-block-actions]]:!opacity-100 " +
  "[&_[data-streamdown=code-block-copy-button]]:!h-7 " +
  "[&_[data-streamdown=code-block-copy-button]]:!w-7 " +
  "[&_[data-streamdown=code-block-copy-button]]:!rounded-md " +
  "[&_[data-streamdown=code-block-copy-button]]:!bg-transparent " +
  "[&_[data-streamdown=code-block-copy-button]]:!text-stone-500 " +
  "[&_[data-streamdown=code-block-copy-button]]:hover:!bg-stone-200 " +
  "[&_[data-streamdown=code-block-copy-button]]:hover:!text-stone-800 " +
  // Inline code pill — neutral stone with a thin ring for definition. A
  // warm beige fill felt too loud when paragraphs have many identifiers in
  // a row; this reads as a quiet chip that the prose can swallow.
  "[&_[data-streamdown=inline-code]]:rounded " +
  "[&_[data-streamdown=inline-code]]:bg-stone-100 " +
  "[&_[data-streamdown=inline-code]]:px-1 " +
  "[&_[data-streamdown=inline-code]]:py-px " +
  "[&_[data-streamdown=inline-code]]:font-mono " +
  "[&_[data-streamdown=inline-code]]:text-[0.85em] " +
  "[&_[data-streamdown=inline-code]]:text-stone-700 " +
  "[&_[data-streamdown=inline-code]]:ring-1 " +
  "[&_[data-streamdown=inline-code]]:ring-inset " +
  "[&_[data-streamdown=inline-code]]:ring-stone-200 " +
  // Links — match the editor's `.tiptap a` (blue-600, no underline, underline
  // on hover) instead of Streamdown's default chrome. Streamdown renders links
  // as `<button data-streamdown=link class="text-primary underline">` (and as a
  // custom `<a>` when the transcript supplies file-link components), so style
  // both. `!` beats Streamdown's own classes. On the dark user bubble lighten
  // for contrast (mirrors `.group-[.is-user] .wiki-file-link`).
  "[&_a]:!text-[#2563eb] [&_a]:!no-underline [&_a]:underline-offset-2 [&_a:hover]:!underline " +
  "[&_[data-streamdown=link]]:!text-[#2563eb] [&_[data-streamdown=link]]:!no-underline " +
  "[&_[data-streamdown=link]]:underline-offset-2 [&_[data-streamdown=link]:hover]:!underline " +
  "group-[.is-user]:[&_a]:!text-[#93c5fd] group-[.is-user]:[&_[data-streamdown=link]]:!text-[#93c5fd] " +
  // Mermaid diagram block (@streamdown/mermaid) — same treatment as the code
  // block: its default chrome leans on unwired `bg-sidebar`/`border-border`
  // tokens, so flatten it to the stone-50 slab, drop the "mermaid" label strip,
  // and pin the hover-revealed actions to the top-right corner.
  "[&_[data-streamdown=mermaid-block]]:!relative " +
  "[&_[data-streamdown=mermaid-block]]:!my-3 " +
  "[&_[data-streamdown=mermaid-block]]:!gap-0 " +
  "[&_[data-streamdown=mermaid-block]]:!border-stone-200 " +
  "[&_[data-streamdown=mermaid-block]]:!bg-stone-50 " +
  "[&_[data-streamdown=mermaid-block]]:!p-3 " +
  "[&_[data-streamdown=mermaid-block]>div:first-child]:!hidden " +
  "[&_[data-streamdown=mermaid-block]>div:has(>[data-streamdown=mermaid-block-actions])]:!absolute " +
  "[&_[data-streamdown=mermaid-block]>div:has(>[data-streamdown=mermaid-block-actions])]:!top-1 " +
  "[&_[data-streamdown=mermaid-block]>div:has(>[data-streamdown=mermaid-block-actions])]:!right-1 " +
  "[&_[data-streamdown=mermaid-block]>div:has(>[data-streamdown=mermaid-block-actions])]:!m-0 " +
  "[&_[data-streamdown=mermaid-block]>div:has(>[data-streamdown=mermaid-block-actions])]:!h-auto " +
  "[&_[data-streamdown=mermaid-block]>div:has(>[data-streamdown=mermaid-block-actions])]:!pointer-events-auto " +
  "[&_[data-streamdown=mermaid-block-actions]]:!border-0 " +
  "[&_[data-streamdown=mermaid-block-actions]]:!bg-transparent " +
  "[&_[data-streamdown=mermaid-block-actions]]:!opacity-0 " +
  "[&_[data-streamdown=mermaid-block]:hover_[data-streamdown=mermaid-block-actions]]:!opacity-100 " +
  // Thematic break — Streamdown's default `border-border` token is unwired
  // and renders near-black; soften to the app's hairline stone.
  "[&_[data-streamdown=horizontal-rule]]:!border-stone-200 " +
  // Markdown tables — restyled to the rendered-CSV grid (rounded-xl white
  // card, stone-50 uppercase header band, hairline row dividers) so a table in
  // a Sunny reply reads like a .csv file in the editor. Streamdown's default
  // is a bg-sidebar card with an always-visible controls row above the table;
  // repaint the card and tuck the copy/download/fullscreen controls into the
  // header band itself, hover-revealed (2026-07-30 table feedback).
  // No overflow-hidden on the wrapper — the copy/download dropdown menus
  // render inside it and must extend past a short table's bottom edge; the
  // inner scroll container carries the matching radius and does the clipping.
  "[&_[data-streamdown=table-wrapper]]:!relative " +
  "[&_[data-streamdown=table-wrapper]]:!my-3 " +
  "[&_[data-streamdown=table-wrapper]]:!gap-0 " +
  "[&_[data-streamdown=table-wrapper]]:!rounded-xl " +
  "[&_[data-streamdown=table-wrapper]]:!border-stone-200 " +
  "[&_[data-streamdown=table-wrapper]]:!bg-white " +
  "[&_[data-streamdown=table-wrapper]]:!p-0 " +
  // Controls row (the wrapper child without the table) → overlay the right end
  // of the header band: same height, same background, no chrome of its own.
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!absolute " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!top-px " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!right-px " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!z-10 " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!h-8 " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!gap-0 " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!rounded-tr-[11px] " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!bg-stone-50 " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!pl-2 " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!pr-1.5 " +
  // Hidden only on hover-capable devices — touch users have no hover, so the
  // band stays visible for them (Codex round 4).
  "[@media(hover:hover)]:[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:!opacity-0 " +
  // Revealed by hovering the HEADER BAND (or the controls themselves), not the
  // whole table (2026-08-01 feedback) — plus keyboard focus below.
  "[&_[data-streamdown=table-wrapper]:has([data-streamdown=table-header]:hover)>div:not(:has(table))]:!opacity-100 " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table)):hover]:!opacity-100 " +
  // Keyboard focus must reveal the controls too — hover-only would leave a
  // tabbed-to button invisible.
  "[&_[data-streamdown=table-wrapper]:focus-within>div:not(:has(table))]:!opacity-100 " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))_button]:!text-stone-400 " +
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))_button:hover]:!text-stone-600 " +
  // De-position the per-button `.relative` containers so the copy/download
  // dropdowns anchor to the band itself (its right edge ≈ the table's right
  // edge) — anchored to a button near a narrow table's left edge, a
  // right-aligned 120px menu pokes past the message's left clip.
  "[&_[data-streamdown=table-wrapper]>div:not(:has(table))>div]:!static " +
  // Scroll container — the wrapper card carries the border; the scroll div
  // (overflow ≠ visible) clips the header band to the matching inner radius.
  "[&_[data-streamdown=table-wrapper]>div:has(table)]:!rounded-[11px] " +
  "[&_[data-streamdown=table-wrapper]>div:has(table)]:!border-0 " +
  "[&_[data-streamdown=table-wrapper]>div:has(table)]:!bg-transparent " +
  "[&_[data-streamdown=table]]:!text-[12px] " +
  "[&_[data-streamdown=table]]:!divide-stone-200 " +
  "[&_[data-streamdown=table-header]]:!bg-stone-50 " +
  "[&_[data-streamdown=table-header]_tr]:!border-b " +
  "[&_[data-streamdown=table-header]_tr]:!border-stone-200 " +
  "[&_[data-streamdown=table-header-cell]]:!px-3 " +
  "[&_[data-streamdown=table-header-cell]]:!py-2 " +
  "[&_[data-streamdown=table-header-cell]]:!text-[10px] " +
  "[&_[data-streamdown=table-header-cell]]:!leading-4 " +
  "[&_[data-streamdown=table-header-cell]]:!font-medium " +
  "[&_[data-streamdown=table-header-cell]]:!uppercase " +
  "[&_[data-streamdown=table-header-cell]]:!tracking-wider " +
  "[&_[data-streamdown=table-header-cell]]:!text-stone-400 " +
  "[&_[data-streamdown=table-body]]:!divide-stone-100 " +
  "[&_[data-streamdown=table-body]_tr:hover]:!bg-stone-50/40 " +
  "[&_[data-streamdown=table-cell]]:!whitespace-nowrap " +
  "[&_[data-streamdown=table-cell]]:!px-3 " +
  "[&_[data-streamdown=table-cell]]:!py-1.5 " +
  // td carries its own `text-sm`, so the size must land on the cell itself.
  "[&_[data-streamdown=table-cell]]:!text-[12px] " +
  "[&_[data-streamdown=table-cell]]:!text-stone-700";

// Hoisted so memoized `MessageResponse` keeps stable prop references.
const MARKDOWN_CONTROLS = { code: { copy: true, download: false } } as const;
// CODE_PLUGIN (lib/markdown/code-highlight) is the app-wide shiki instance —
// shared with the doc editor's CodeBlockShiki, so a fence looks identical in a
// Sunny reply and in the doc and only one highlighter ever loads.
// MERMAID_CHAT_PLUGIN routes chat diagram renders through the same lock as the
// editor's previews — mermaid is a global singleton, and unlocked renders from
// two surfaces would cross-contaminate theme/security config mid-render.
const MARKDOWN_PLUGINS = { code: CODE_PLUGIN, mermaid: MERMAID_CHAT_PLUGIN };
// Passing `remarkPlugins` REPLACES Streamdown's built-in defaults (which
// include remark-gfm), so we must re-list `remarkGfm` here or GFM tables,
// strikethrough, and autolinks render as raw text (e.g. a summary table shows
// literal `| … | … |` rows).
// `remark-breaks` turns single newlines into <br>, matching the document
// renderer (lib/markdown/html.mjs emits <br> for every soft break) and the
// chat conventions of Slack/Discord/ChatGPT. Without it, CommonMark collapses
// single newlines to spaces, so a 30-line poem renders as run-on stanzas.
// Em-dashes render as plain dashes in chat (2026-08-01 feedback) — applied to
// PARSED TEXT NODES, so code (fenced, indented, inline), math, and link
// destinations are protected structurally rather than by source regexes
// (which kept sprouting edge cases: Codex rounds 9/11/13/14/16 on #1022).
// Display-only: copy-message and persistence keep the model's original text.
type MdastNode = { type?: string; value?: string; url?: string; children?: MdastNode[] };
function remarkEmDashToDash() {
  const walk = (node: MdastNode) => {
    if (node.type === "text" && typeof node.value === "string" && node.value.includes("—")) {
      node.value = node.value.replace(/ ?— ?/g, " - ");
    }
    // A GFM autolink's label IS its address — rewriting it would display a
    // different URL than the one linked. Literal autolinks normalize the url
    // (`www.x` → `http://www.x`, emails → `mailto:`), so compare the label
    // against the prefixed forms too.
    if (node.type === "link" && node.children?.length === 1 && node.children[0]?.type === "text") {
      const label = node.children[0].value;
      if (node.url === label || node.url === `http://${label}` || node.url === `mailto:${label}`) {
        return;
      }
    }
    node.children?.forEach(walk);
  };
  return walk;
}
const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkBreaks, remarkEmDashToDash];
const REHYPE_PLUGINS = [rehypeKatex];
// The smooth typewriter is driven by useSmoothStreamedText (word-by-word display
// pacing). `isAnimating` (passed only for the live reply) tells Streamdown the
// content is still streaming so it renders trailing incomplete markdown cleanly.
// We do NOT enable Streamdown's `animated` fade: it ships no CSS and its keyframes
// (referenced only via a CSS var) get purged by the Tailwind/Lightning build.

export const MessageResponse = memo(
  ({ className, children, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        MARKDOWN_CHROME,
        className
      )}
      controls={MARKDOWN_CONTROLS}
      lineNumbers={false}
      // Streamdown ships a Vercel-default "Open external link?" confirmation modal
      // (link safety). It's out of style with the app, and the editor opens links
      // directly anyway — disable it so chat links just open (2026-06-05 feedback).
      linkSafety={{ enabled: false }}
      plugins={MARKDOWN_PLUGINS}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      {...props}
    >
      {typeof children === "string" ? escapeCurrencyMath(children) : children}
    </Streamdown>
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.className === nextProps.className &&
    prevProps.components === nextProps.components &&
    prevProps.isAnimating === nextProps.isAnimating
);

MessageResponse.displayName = "MessageResponse";

export type MessageAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart;
  className?: string;
  onRemove?: () => void;
};

export function MessageAttachment({
  data,
  className,
  onRemove,
  ...props
}: MessageAttachmentProps) {
  const filename = data.filename || "";
  const mediaType =
    data.mediaType?.startsWith("image/") && data.url ? "image" : "file";
  const isImage = mediaType === "image";
  const attachmentLabel = filename || (isImage ? "Image" : "Attachment");

  return (
    <div
      className={cn(
        "group relative size-24 overflow-hidden rounded-lg",
        className
      )}
      {...props}
    >
      {isImage ? (
        <>
          <img
            alt={filename || "attachment"}
            className="size-full object-cover"
            height={100}
            src={data.url}
            width={100}
          />
          {onRemove && (
            <Button
              aria-label="Remove attachment"
              className="absolute top-2 right-2 size-6 rounded-full bg-background/80 p-0 opacity-0 backdrop-blur-sm transition-opacity hover:bg-background group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </Button>
          )}
        </>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex size-full shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <PaperclipIcon className="size-4" />
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>{attachmentLabel}</p>
            </TooltipContent>
          </Tooltip>
          {onRemove && (
            <Button
              aria-label="Remove attachment"
              className="size-6 shrink-0 rounded-full p-0 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export type MessageAttachmentsProps = ComponentProps<"div">;

export function MessageAttachments({
  children,
  className,
  ...props
}: MessageAttachmentsProps) {
  if (!children) {
    return null;
  }

  return (
    <div
      className={cn(
        "ml-auto flex w-fit flex-wrap items-start gap-2",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
