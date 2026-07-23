'use client';

// AI Elements transcript — full replacement for the legacy
// workspace-chat-model.tsx ChatTranscript renderer.
//
// Reads `currentChatMessages: ChatMessage[]` (the existing DB-row shape)
// through `rowsToUIMessages` and renders each UIMessage's parts in source
// order using AI Elements primitives (Message, Tool, Reasoning, Streamdown).
// Sundial-specific affordances — diff card on `has_turn_edits`, inline
// attachments, working indicator — are wrapped in here so we don't lose
// the polish the legacy renderer had.

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import { useSmoothStreamedText } from '@/components/ai-elements/use-smooth-text';
import { ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning';
import { TurnEditsCard } from '@/components/workspace/turn-edits-card';
import { CopyLinkButton } from '@/components/workspace/copy-link-button';
import { WikiLinkInline } from '@/components/workspace/wiki-link-inline';
import { textHasWikiLinks } from '@/lib/workspace/wiki-file-links';
import { isShortIdRef, isUuid } from '@/lib/workspace/public-ids';
import { setFreezeContext } from '@/lib/perf/freeze-monitor';
import {
  coalesceAssistantRuns,
  messageHasTurnEdits,
  messageMeta,
  messageRenderSignature,
} from '@/lib/agent/coalesce-assistant-runs';
import {
  ArrowUpRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  GlobeIcon,
  SparklesIcon,
  XCircleIcon,
} from 'lucide-react';
import { splitInlineAskContext } from '@/lib/workspace/inline-ask-context';
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type { StickToBottomContext } from 'use-stick-to-bottom';
import type { UIMessage, ToolUIPart } from 'ai';
import {
  clipText,
  summarizeToolInput,
  type MessageAttachment,
} from './workspace-chat-model';

type AIElementsTranscriptProps = {
  /** Live UIMessage[] from useSundialChat / useChat. The transcript reads
   *  this directly — no ChatMessage[] intermediate. */
  messages: UIMessage[];
  hasAssistant: boolean;
  showGreeting: boolean;
  assistantGreeting: string;
  showWorkingIndicator?: boolean;
  /** Used to build the per-turn copy-link target. */
  turnLinkBase?: string;
  /** Set while NOTHING is shared (no members, no invites, no link access, or a
   *  purely local workspace) — a turn link would be dead, so the button opens
   *  the share modal instead of copying. Cleared once sharing is set up. */
  onTurnLinkShareGate?: () => void;
  /** The ?diff= deep-linked turn — its diff card opens expanded. */
  highlightedDiffId?: string | null;
  /** Receives a force-scroll-to-bottom handle so the parent can pin the
   *  transcript when the user sends a message (even if scrolled up). */
  scrollToBottomRef?: MutableRefObject<(() => void) | null>;
  /** True while the active reply is still streaming in (useChat status). Drives
   *  live reasoning shimmer + keeps tool runs expanded while they execute. */
  isStreaming?: boolean;
  onOpenDiffFile?: (assistantMessageId: string) => void;
  /** True when a live run in THIS chat just finished (session-local falling
   *  edge derived in page.tsx). Stamps a quiet "Done" line under the final
   *  assistant turn — the positive counterpart of the abnormal run_status
   *  markers, so a finished reply is distinguishable from a stalled one
   *  (user-interview feedback). */
  latestTurnJustCompleted?: boolean;
  /** Workspace file paths for resolving `[[wiki]]` labels in user messages. */
  knownFilePaths?: string[];
  workspaceId?: string | null;
  onOpenWikiFile?: (path: string) => void;
};

type MessageResponseComponents = NonNullable<
  ComponentProps<typeof MessageResponse>['components']
>;

/* ─── Part predicates ────────────────────────────────────────── */

function isToolPart(part: unknown): part is ToolUIPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    typeof (part as { type?: unknown }).type === 'string' &&
    ((part as { type: string }).type.startsWith('tool-') ||
      (part as { type: string }).type === 'dynamic-tool')
  );
}

/** AI SDK step boundaries (`step-start`) are invisible markers the live stream
 *  inserts between tool steps. They render to nothing, but left in place they
 *  split a run of consecutive tool calls into separate "Ran 1 tool" badges — so
 *  we treat them as transparent when grouping. (Persisted history has none.) */
function isStepBoundaryPart(part: unknown): boolean {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'step-start'
  );
}

function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
  );
}

function isReasoningPart(
  part: unknown,
): part is { type: 'reasoning'; text?: string; reasoning?: string } {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'reasoning'
  );
}

const sundialFileLinkOrigins = new Set([
  'https://dev.sundial.md',
  'https://sundial.md',
  'https://www.sundial.md',
]);

function workspaceFilePathFromHref(
  href: string | undefined,
  workspaceId?: string | null,
): string | null {
  if (!href || typeof window === 'undefined') return null;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (
    (url.origin !== window.location.origin && !sundialFileLinkOrigins.has(url.origin)) ||
    !url.pathname.startsWith('/w/')
  ) {
    return null;
  }
  const currentWorkspacePath = window.location.pathname.match(/^\/w\/[^/?#]+/)?.[0];
  let linkedWorkspaceSlug: string;
  try {
    linkedWorkspaceSlug = decodeURIComponent(url.pathname.slice('/w/'.length));
  } catch {
    return null;
  }
  if (
    (!currentWorkspacePath || url.pathname !== currentWorkspacePath) &&
    (!workspaceId || linkedWorkspaceSlug !== workspaceId)
  ) {
    return null;
  }
  const filePathParam = url.searchParams.get('filePath');
  const legacyFileIdParam = url.searchParams.get('fileId');
  const filePath = (filePathParam ?? legacyWorkspaceFilePathFromFileId(legacyFileIdParam))?.replace(/^\/+/, '');
  if (!filePath || filePath.split('/').includes('..')) return null;
  return filePath;
}

function legacyWorkspaceFilePathFromFileId(fileId: string | null): string | null {
  // UUIDs and git-style short id refs are file ids, not legacy paths.
  if (!fileId || isUuid(fileId) || isShortIdRef(fileId)) {
    return null;
  }
  return fileId;
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

function workspaceFileLinkComponents(
  onOpenFile?: (path: string) => void,
  workspaceId?: string | null,
): MessageResponseComponents | undefined {
  if (!onOpenFile) return undefined;
  return {
    a: ({ href, node: _node, onClick, target, rel, ...props }) => {
      const filePath = workspaceFilePathFromHref(href, workspaceId);
      return (
        <a
          {...props}
          href={href}
          onClick={(event) => {
            onClick?.(event);
            if (!filePath || event.defaultPrevented || !isPlainLeftClick(event)) {
              return;
            }
            event.preventDefault();
            onOpenFile(filePath);
          }}
          rel={filePath ? rel : (rel ?? 'noreferrer')}
          target={filePath ? undefined : (target ?? '_blank')}
        >
          {filePath ?? props.children}
        </a>
      );
    },
  };
}

type CompileStatusData = {
  phase?: 'compiling' | 'failed' | 'succeeded' | 'no-tex';
  texPath?: string;
  attempt?: number;
  errorTail?: string;
};

function isCompileStatusPart(
  part: unknown,
): part is { type: 'data-compile-status'; id?: string; data?: CompileStatusData } {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'data-compile-status'
  );
}

function isVisibleTextPart(part: unknown): boolean {
  return isTextPart(part) && part.text.trim().length > 0;
}

/** The assistant's visible prose for the turn — what the "copy message" icon copies. */
function messagePlainText(parts: unknown[]): string {
  return parts
    .filter(isTextPart)
    .map((p) => p.text)
    .join('\n\n')
    .trim();
}

function isVisibleReasoningPart(part: unknown): boolean {
  return isReasoningPart(part) && (part.text ?? part.reasoning ?? '').trim().length > 0;
}

function CompileStatus({ data }: { data: CompileStatusData }) {
  const phase = data.phase ?? 'compiling';
  const texPath = data.texPath ?? null;
  const attempt = typeof data.attempt === 'number' ? data.attempt : null;
  if (phase === 'compiling') {
    return (
      <div className="flex justify-start py-0.5">
        <span className="latex-compile-shimmer text-[13px] font-medium">
          Compiling{texPath ? ` ${texPath}` : ' LaTeX'}…
        </span>
      </div>
    );
  }
  if (phase === 'failed') {
    const errorTail = data.errorTail ?? null;
    // First `! …` line is the most useful preview — tectonic puts the actual
    // `! LaTeX Error: …` near the top of the tail.
    const firstErrorLine = errorTail
      ? errorTail
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('!')) ?? null
      : null;
    return (
      <div className="flex justify-start py-0.5" title={errorTail ?? undefined}>
        <span className="text-[12px] font-medium text-red-600">
          Compile failed
          {texPath ? ` for ${texPath}` : ''}
          {attempt && attempt > 1 ? ` (attempt ${attempt})` : ''}
          {firstErrorLine ? ` — ${firstErrorLine.replace(/^!\s*/, '')}` : ''}
        </span>
      </div>
    );
  }
  if (phase === 'succeeded') {
    return (
      <div className="flex justify-start py-0.5">
        <span className="text-[12px] font-medium text-emerald-600">
          Compiled{texPath ? ` ${texPath}` : ' LaTeX'}
          {attempt && attempt > 1 ? ` (attempt ${attempt})` : ''}
        </span>
      </div>
    );
  }
  // 'no-tex' → render nothing
  return null;
}

/* ─── Message-level helpers (ported from the legacy renderer) ── */

function messageAttachments(message: UIMessage): MessageAttachment[] {
  const raw = messageMeta(message).attachments;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): MessageAttachment | null => {
      if (!item || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      const id = typeof r.id === 'string' ? r.id : '';
      const path = typeof r.path === 'string' ? r.path : '';
      if (!id || !path) return null;
      return {
        id,
        path,
        name: typeof r.name === 'string' ? r.name : null,
        mime: typeof r.mime === 'string' ? r.mime : null,
        size: typeof r.size === 'number' ? r.size : null,
        type:
          r.type === 'text'
            ? 'text'
            : r.type === 'binary' || r.type === 'blob_ref'
              ? 'binary'
              : undefined,
        signedUrl: typeof r.signed_url === 'string' ? r.signed_url : null,
        storagePath: typeof r.storage_path === 'string' ? r.storage_path : null,
      };
    })
    .filter((x): x is MessageAttachment => Boolean(x));
}

function messageEditedFileCount(message: UIMessage): number | null {
  const v = messageMeta(message).edited_file_count;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Terminal status the brain stamps on a turn that didn't complete normally
 *  (`metadata.run_status` from agent-ts finalize). Surfaced as a marker line so
 *  a dead turn never renders as a silent empty bubble (issue #432). */
function messageRunStatusLabel(message: UIMessage): string | null {
  const meta = messageMeta(message);
  const status = meta.run_status;
  const error = typeof meta.run_error === 'string' ? meta.run_error : null;
  if (status === 'aborted') {
    return error === 'replaced' ? 'Interrupted by a newer message' : 'Interrupted';
  }
  if (status === 'error') {
    return error ? `Turn failed: ${error}` : 'Turn failed';
  }
  if (status === 'incomplete') {
    return 'Turn ended before all tools finished';
  }
  return null;
}

function partKey(message: UIMessage, partIndex: number): string {
  return `${message.id}-${partIndex}`;
}

function assistantHasTurnLinkTarget(message: UIMessage, parts: unknown[]): boolean {
  return (
    messageHasTurnEdits(message) ||
    parts.some((part) => isVisibleTextPart(part) || isVisibleReasoningPart(part))
  );
}

/* ─── Renderers ──────────────────────────────────────────────── */

function toolDisplayName(part: ToolUIPart): string {
  const type = part.type as string;
  if (type === 'dynamic-tool') {
    const name = (part as { toolName?: unknown }).toolName;
    return typeof name === 'string' && name ? name : 'tool';
  }
  return type.replace(/^tool-/, '');
}

function toolStatusIcon(state: ToolUIPart['state']): ReactNode {
  switch (state) {
    case 'output-available':
    case 'approval-responded':
      return <CheckCircleIcon className="size-3 shrink-0 text-emerald-600" />;
    case 'output-error':
    case 'output-denied':
      return <XCircleIcon className="size-3 shrink-0 text-red-500" />;
    case 'input-streaming':
      return <CircleIcon className="size-3 shrink-0 text-stone-300" />;
    default:
      return <ClockIcon className="size-3 shrink-0 animate-pulse text-stone-500" />;
  }
}

function toolIsActive(state: ToolUIPart['state']): boolean {
  return (
    state === 'input-streaming' ||
    state === 'input-available' ||
    state === 'approval-requested'
  );
}

type WebSource = { url?: string; title?: string; pageAge?: string };

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Web-search results as clickable source cards — the provenance payload behind
 *  an agent edit: where each fact actually came from. */
function WebSearchSources({ sources }: { sources: WebSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1 px-1.5 pb-1.5">
      {sources.map((s, i) => (
        <a
          key={`${s.url ?? i}`}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group/src flex items-start gap-2 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 transition-colors hover:border-stone-300 hover:bg-stone-50"
        >
          <GlobeIcon className="mt-0.5 size-3.5 shrink-0 text-stone-400" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-stone-800">
              {s.title || s.url}
            </span>
            <span className="block truncate text-[11px] text-stone-400">
              {hostOf(s.url)}
              {s.pageAge ? ` · ${s.pageAge}` : ''}
            </span>
          </span>
          <ArrowUpRightIcon className="mt-0.5 size-3 shrink-0 text-stone-300 transition-colors group-hover/src:text-stone-500" />
        </a>
      ))}
    </div>
  );
}

function webSearchSources(part: ToolUIPart): WebSource[] | null {
  if (toolDisplayName(part) !== 'web_search') return null;
  if (part.state !== 'output-available') return null;
  const out = part.output;
  if (!Array.isArray(out)) return null;
  return out
    .filter((r): r is WebSource => !!r && typeof r === 'object')
    .map((r) => ({ url: (r as WebSource).url, title: (r as WebSource).title, pageAge: (r as WebSource).pageAge }));
}

/** One row inside a ToolGroup: status glyph + name + clipped input summary,
 *  expandable to the full input/output payload. */
function ToolRow({ part }: { part: ToolUIPart }) {
  const name = toolDisplayName(part);
  const input = (part.input ?? null) as Record<string, unknown> | null;
  const sources = webSearchSources(part);
  const summary = sources
    ? `${sources.length} source${sources.length === 1 ? '' : 's'}`
    : clipText(summarizeToolInput(name, input), 72);
  const hasDetail =
    part.input != null ||
    part.state === 'output-available' ||
    part.state === 'output-error';

  const rowBody = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {toolStatusIcon(part.state)}
      <span className="shrink-0 font-medium text-stone-700">
        {sources ? 'Searched the web' : name}
      </span>
      {summary ? (
        <span className="min-w-0 truncate font-mono text-[12px] text-stone-400">
          {summary}
        </span>
      ) : null}
    </div>
  );

  if (!hasDetail) {
    return <div className="flex items-center px-1.5 py-1 text-[13px]">{rowBody}</div>;
  }

  return (
    <Collapsible className="group/row">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-stone-100/70">
        {rowBody}
        <ChevronDownIcon className="size-3 shrink-0 text-stone-300 transition-transform group-data-[state=open]/row:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden text-popover-foreground">
        {sources ? (
          <WebSearchSources sources={sources} />
        ) : (
          <>
            {part.input != null ? <ToolInput input={part.input} /> : null}
            {part.state === 'output-available' || part.state === 'output-error' ? (
              <ToolOutput
                output={part.state === 'output-available' ? part.output : undefined}
                errorText={part.state === 'output-error' ? part.errorText : undefined}
              />
            ) : null}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Compact run of contiguous tool calls: a single "Ran N tools" summary that
 *  stays expanded while the tools execute, then collapses when finished. */
export function ToolGroup({ parts }: { parts: ToolUIPart[] }) {
  const total = parts.length;
  const active = parts.some((p) => toolIsActive(p.state));
  const errorCount = parts.filter(
    (p) => p.state === 'output-error' || p.state === 'output-denied',
  ).length;

  const [open, setOpen] = useState(active);
  const prevActive = useRef(active);
  useEffect(() => {
    if (active && !prevActive.current) setOpen(true);
    else if (!active && prevActive.current) setOpen(false);
    prevActive.current = active;
  }, [active]);

  const noun = total === 1 ? 'tool' : 'tools';
  const label = active ? `Running ${total} ${noun}…` : `Ran ${total} ${noun}`;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="not-prose group my-1 w-fit max-w-full rounded-lg border border-stone-200 bg-stone-50/60 text-[13px]"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-stone-600 transition-colors hover:bg-stone-100/60">
        {active ? (
          <ClockIcon className="size-3 shrink-0 animate-pulse text-stone-500" />
        ) : errorCount > 0 ? (
          <XCircleIcon className="size-3 shrink-0 text-red-500" />
        ) : (
          <CheckCircleIcon className="size-3 shrink-0 text-emerald-600" />
        )}
        <span className={active ? 'latex-compile-shimmer font-medium' : 'font-medium'}>
          {label}
          {errorCount > 0 ? ` · ${errorCount} failed` : ''}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-stone-400 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="flex flex-col gap-0.5 border-t border-stone-200/70 px-1.5 py-1">
          {parts.map((part, i) => (
            <ToolRow key={part.toolCallId ?? i} part={part} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Assistant markdown text. While the reply is live, the display is paced
 *  word-by-word (useSmoothStreamedText) and Streamdown fades each word in, so a
 *  burst of model tokens reads as a smooth typewriter; once finished it renders
 *  the full text instantly. Display-only — the raw stream still reaches the
 *  brain's watchdog/persistence untouched. */
function AssistantTextPart({
  text,
  streaming,
  components,
}: {
  text: string;
  streaming: boolean;
  components?: MessageResponseComponents;
}): ReactNode {
  const shown = useSmoothStreamedText(text, streaming);
  return (
    <MessageResponse components={components} isAnimating={streaming}>
      {shown}
    </MessageResponse>
  );
}

/* Plain, always-visible label. The default uses a `text-transparent`
   bg-clip shimmer that can render invisibly (empty-looking title) in
   this nested context. Module-scope so its identity never churns a
   memoized trigger. */
const transcriptThinkingMessage = (streaming: boolean, dur?: number) =>
  streaming ? (
    <span className="animate-pulse">Thinking…</span>
  ) : (
    <span>{dur ? `Thought for ${dur} second${dur === 1 ? '' : 's'}` : 'Reasoning'}</span>
  );

/** Memoized — primitive props, so settled thoughts skip re-rendering on every
 *  throttled stream flush of their (coalesced) message. */
const TranscriptReasoning = memo(function TranscriptReasoning({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  return (
    // Collapsed by default — the user opens it to read the chain of thought.
    <Reasoning defaultOpen={false} isStreaming={isStreaming}>
      <ReasoningTrigger getThinkingMessage={transcriptThinkingMessage} />
      <ReasoningContent>{text}</ReasoningContent>
    </Reasoning>
  );
});

function renderPart(
  message: UIMessage,
  part: unknown,
  partIndex: number,
  options: {
    knownFilePaths: string[];
    workspaceFileLinkComponents?: MessageResponseComponents;
    onOpenWikiFile?: (path: string) => void;
    reasoningIsStreaming?: boolean;
    /** True when this text part is the live reply's still-streaming tail — drives
     *  Streamdown's per-word fade-in so tokens read as a smooth typewriter. */
    textIsStreaming?: boolean;
  },
): ReactNode {
  const key = partKey(message, partIndex);

  if (isTextPart(part)) {
    if (!part.text) return null; // empty text run — skip to keep layout tight
    if (message.role === 'user') {
      // Ask-Sunny / "/ai" turns prepend quoted anchor context + a cursor
      // note for the model; show the user a compact chip, not the raw
      // scaffolding (full text on hover).
      const ask = splitInlineAskContext(part.text);
      if (ask) {
        return (
          <div key={key}>
            <div className="mb-1 flex flex-wrap gap-1.5">
              {(ask.snippets.length ? ask.snippets : [{ path: null, quote: '' }]).map(
                (s, idx) => (
                  <span
                    key={idx}
                    data-testid="ask-context-chip"
                    title={[s.quote, ask.note].filter(Boolean).join('\n\n')}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-stone-700 px-2 py-1 text-[12px] text-stone-100"
                  >
                    <SparklesIcon className="size-3 shrink-0" />
                    <span className="truncate">
                      {s.path?.split('/').pop() ?? 'selection'}
                      {s.quote ? (
                        <span className="text-stone-300"> · “{s.quote.slice(0, 40)}{s.quote.length > 40 ? '…' : ''}”</span>
                      ) : null}
                    </span>
                  </span>
                ),
              )}
            </div>
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{ask.body}</p>
          </div>
        );
      }
      if (textHasWikiLinks(part.text)) {
        return (
          <p
            key={key}
            className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
          >
            <WikiLinkInline
              text={part.text}
              knownPaths={options.knownFilePaths}
              onOpenFile={options.onOpenWikiFile}
              openOnClick
            />
          </p>
        );
      }
      return (
        <p
          key={key}
          className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
        >
          {part.text}
        </p>
      );
    }
    return (
      <AssistantTextPart
        key={key}
        text={part.text}
        streaming={Boolean(options.textIsStreaming)}
        components={options.workspaceFileLinkComponents}
      />
    );
  }

  if (isReasoningPart(part)) {
    const text = part.text ?? part.reasoning ?? '';
    // Hide an empty reasoning part EXCEPT while it's actively streaming — some
    // models (e.g. OpenAI gpt-5) reason silently for a while and only emit the
    // summary text near the end, so without this the box vanishes and the user
    // sees an empty bubble, then a "Thought for Ns" box pops in. Keeping it
    // mounted lets the "Thinking…" shimmer show continuously. Persisted/reloaded
    // empty reasoning (not streaming) still collapses away.
    if (!text && !options.reasoningIsStreaming) return null;
    return (
      <TranscriptReasoning
        key={key}
        text={text}
        isStreaming={Boolean(options.reasoningIsStreaming)}
      />
    );
  }

  if (isCompileStatusPart(part)) {
    return <CompileStatus key={key} data={part.data ?? {}} />;
  }

  return null;
}

/** Walk a message's parts in order, batching contiguous tool parts into a
 *  single compact ToolGroup and leaving text/reasoning/compile parts inline. */
function renderMessageParts(
  message: UIMessage,
  parts: unknown[],
  options: {
    knownFilePaths: string[];
    workspaceFileLinkComponents?: MessageResponseComponents;
    onOpenWikiFile?: (path: string) => void;
    /** True when this message is the actively-streaming assistant reply. */
    isStreamingMessage: boolean;
  },
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    // Invisible step boundaries never render and never break a tool run.
    if (isStepBoundaryPart(part)) {
      i += 1;
      continue;
    }
    if (isToolPart(part)) {
      const group: ToolUIPart[] = [];
      let j = i;
      while (j < parts.length && (isToolPart(parts[j]) || isStepBoundaryPart(parts[j]))) {
        if (isToolPart(parts[j])) group.push(parts[j] as ToolUIPart);
        j += 1;
      }
      nodes.push(<ToolGroup key={partKey(message, i)} parts={group} />);
      i = j;
      continue;
    }
    // A reasoning part streams only while it's the last part of the actively
    // streaming reply — once a tool/text part follows, thinking is finished.
    // The SDK also stamps live reasoning parts with state 'streaming'|'done'
    // at reasoning-start/-end; honoring 'done' settles the thought exactly
    // once, permanently — it can't flip back to "Thinking…" when a reconcile
    // or reseed momentarily makes the part last again. (Persisted fold-path
    // parts carry no state and fall back to the last-part heuristic.)
    const isLastPart = i === parts.length - 1;
    const reasoningIsStreaming =
      options.isStreamingMessage &&
      isLastPart &&
      (part as { state?: string }).state !== 'done';
    nodes.push(
      renderPart(message, part, i, {
        knownFilePaths: options.knownFilePaths,
        workspaceFileLinkComponents: options.workspaceFileLinkComponents,
        onOpenWikiFile: options.onOpenWikiFile,
        reasoningIsStreaming,
        // The streaming reply's final text part is the one growing token-by-token.
        textIsStreaming: options.isStreamingMessage && isLastPart,
      }),
    );
    i += 1;
  }
  return nodes;
}

/** Any renderable assistant content — used to retire the generic typing dots
 *  the moment live reasoning/tool/compile/text parts start streaming in. */
function hasRenderableAssistantParts(message: UIMessage): boolean {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.some(
    (p) =>
      (isTextPart(p) && p.text.trim().length > 0) ||
      (isReasoningPart(p) && (p.text ?? p.reasoning ?? '').trim().length > 0) ||
      isToolPart(p) ||
      isCompileStatusPart(p),
  );
}

/* ─── Attachments (user-side) ────────────────────────────────── */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentChip({ attachment }: { attachment: MessageAttachment }) {
  const name = attachment.name ?? attachment.path.split('/').pop() ?? 'attachment';
  const body = (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-stone-700 px-2 py-1 text-[12px] text-stone-100">
      <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.586-6.586a4 4 0 10-5.656-5.656L5.636 10.93a6 6 0 108.485 8.485l6.586-6.586"
        />
      </svg>
      <span className="truncate">{name}</span>
      {attachment.size ? <span className="text-stone-300">{formatBytes(attachment.size)}</span> : null}
    </span>
  );
  if (attachment.signedUrl) {
    return (
      <a href={attachment.signedUrl} target="_blank" rel="noreferrer">
        {body}
      </a>
    );
  }
  return body;
}

/* ─── Top-level transcript ───────────────────────────────────── */

// Stable per-render context shared by every row. Bundled into one memoized
// object so a row's props stay referentially stable across streaming tokens —
// the precondition for the row memo below to actually skip work.
type RowCtx = {
  knownFilePaths: string[];
  linkComponents: ReturnType<typeof workspaceFileLinkComponents>;
  onOpenWikiFile?: (path: string) => void;
  onOpenDiffFile?: (assistantMessageId: string) => void;
  turnLinkBase?: string;
  onTurnLinkShareGate?: () => void;
};

type MessageRowProps = {
  message: UIMessage;
  ctx: RowCtx;
  // Compared by the memo; identifies a content change for THIS row.
  signature: string;
  isStreamingMessage: boolean;
  isLatestTurnWithEdits: boolean;
  isHighlighted: boolean;
  isJustCompletedTurn: boolean;
};

function MessageRowImpl({
  message,
  ctx,
  isStreamingMessage,
  isLatestTurnWithEdits,
  isHighlighted,
  isJustCompletedTurn,
}: MessageRowProps) {
  const attachments = message.role === 'user' ? messageAttachments(message) : [];
  const hasEdits = message.role === 'assistant' && messageHasTurnEdits(message);
  const editCount = hasEdits ? messageEditedFileCount(message) : null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const showTurnLink =
    message.role === 'assistant' &&
    Boolean(ctx.turnLinkBase) &&
    assistantHasTurnLinkTarget(message, parts);
  const turnMessageText = showTurnLink ? messagePlainText(parts) : '';
  const runStatusLabel =
    message.role === 'assistant' && !isStreamingMessage
      ? messageRunStatusLabel(message)
      : null;

  return (
    <Message from={message.role} key={message.id} data-message-id={message.id}>
      <MessageContent>
        {renderMessageParts(message, parts, {
          knownFilePaths: ctx.knownFilePaths,
          workspaceFileLinkComponents: ctx.linkComponents,
          onOpenWikiFile: ctx.onOpenWikiFile,
          isStreamingMessage,
        })}
        {runStatusLabel ? (
          <div
            className="mt-1 flex items-center gap-1.5 text-[12px] text-stone-400"
            data-testid="turn-status"
          >
            <XCircleIcon className="size-3 shrink-0" />
            <span>{runStatusLabel}</span>
          </div>
        ) : isJustCompletedTurn && !isStreamingMessage && hasRenderableAssistantParts(message) ? (
          <div
            className="animate-fade-in mt-1 flex items-center gap-1.5 text-[12px] text-stone-400"
            data-testid="turn-done"
          >
            <CheckCircleIcon className="size-3 shrink-0 text-emerald-600" />
            <span>Done</span>
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} />
            ))}
          </div>
        ) : null}
        {showTurnLink && ctx.turnLinkBase ? (
          // End-of-turn affordances: a link icon (copies the turn link) and
          // a copy icon (copies the message). Icon-only — the label shows as
          // the app's black tooltip on hover, with a checkmark on copy
          // (2026-06-05 feedback: no permanent "Copy link to this turn" text).
          <div
            className="mt-1 flex items-center gap-0.5 opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100"
            data-testid="turn-link"
          >
            <CopyLinkButton
              url={`${ctx.turnLinkBase}${ctx.turnLinkBase.includes('?') ? '&' : '?'}turnId=${message.id}`}
              label="Copy link to this turn"
              tooltip={ctx.onTurnLinkShareGate ? 'Share to copy link' : 'Copy link to this turn'}
              iconClassName="h-3.5 w-3.5"
              onClickOverride={ctx.onTurnLinkShareGate}
            />
            {turnMessageText ? (
              <CopyLinkButton
                url={turnMessageText}
                icon="copy"
                label="Copy message"
                tooltip="Copy message"
                iconClassName="h-3.5 w-3.5"
              />
            ) : null}
          </div>
        ) : null}
        {hasEdits ? (
          <div
            data-diff-id={message.id}
            className={
              ctx.onOpenDiffFile
                ? 'mt-2 cursor-pointer rounded-2xl transition-shadow hover:shadow-[0_1px_4px_rgba(28,25,23,0.08)]'
                : 'mt-2'
            }
            onClick={
              ctx.onOpenDiffFile
                ? (event) => {
                    const target = event.target as HTMLElement | null;
                    const interactive = target?.closest('button, a, kbd, [role="button"]');
                    if (interactive && interactive !== event.currentTarget) return;
                    ctx.onOpenDiffFile?.(message.id);
                  }
                : undefined
            }
            role={ctx.onOpenDiffFile ? 'button' : undefined}
            tabIndex={ctx.onOpenDiffFile ? 0 : undefined}
            title={ctx.onOpenDiffFile ? 'Open file in side panel' : undefined}
          >
            <TurnEditsCard
              assistantMessageId={message.id}
              initialCount={editCount}
              variant="inline"
              isLatestTurn={isLatestTurnWithEdits}
              defaultExpanded={isHighlighted}
            />
          </div>
        ) : null}
      </MessageContent>
    </Message>
  );
}

// Skip re-render when this row's visible content and flags are unchanged. We
// deliberately compare `signature` (content) rather than `message` identity:
// coalesceAssistantRuns hands us fresh objects every token, so identity always
// differs even when nothing visible changed. `ctx` is memoized by the parent.
const MessageRow = memo(
  MessageRowImpl,
  (a, b) =>
    a.signature === b.signature &&
    a.isStreamingMessage === b.isStreamingMessage &&
    a.isLatestTurnWithEdits === b.isLatestTurnWithEdits &&
    a.isHighlighted === b.isHighlighted &&
    a.isJustCompletedTurn === b.isJustCompletedTurn &&
    a.ctx === b.ctx,
);

/** A render bug in one message must degrade to a placeholder, not unmount the
 *  transcript — or worse, bubble into useChat's stream flush and surface as a
 *  fake "Sunny couldn't reply" agent error. When the row's content signature
 *  changes (stream delta, history reconcile) it retries after a short delay —
 *  the delay bounds a deterministic crash in the live streaming row (whose
 *  signature changes every throttled flush) to ~1 retry/sec instead of 20. */
const ROW_RETRY_MS = 1000;

class MessageRowBoundary extends Component<
  { messageId: string; signature: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  private failedSignature: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('[transcript] message render failed', error);
    this.failedSignature = this.props.signature;
  }

  componentDidUpdate() {
    if (
      this.state.failed &&
      this.failedSignature !== null &&
      this.props.signature !== this.failedSignature &&
      !this.retryTimer
    ) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.setState({ failed: false });
      }, ROW_RETRY_MS);
    }
  }

  componentWillUnmount() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          className="py-1 text-xs text-stone-400"
          data-message-id={this.props.messageId}
          data-testid="message-render-error"
        >
          This message couldn’t be displayed.
        </div>
      );
    }
    return this.props.children;
  }
}

export function AIElementsTranscript({
  messages: uiMessages,
  hasAssistant,
  showGreeting,
  assistantGreeting,
  showWorkingIndicator,
  turnLinkBase,
  onTurnLinkShareGate,
  highlightedDiffId,
  scrollToBottomRef,
  isStreaming = false,
  onOpenDiffFile,
  latestTurnJustCompleted = false,
  knownFilePaths = [],
  workspaceId,
  onOpenWikiFile,
}: AIElementsTranscriptProps) {
  // Stable wrappers for the open callbacks. The parent recreates these whenever
  // its file map changes (handleOpenEditedFileInline depends on workspaceFiles,
  // which churns as the agent writes files — i.e. exactly while suggestions
  // stream), and their identity would otherwise force rowCtx (and every row) to
  // re-render. The wrappers read the latest callback from a ref, so behavior
  // stays current without churning identity.
  const openWikiFileRef = useRef(onOpenWikiFile);
  openWikiFileRef.current = onOpenWikiFile;
  const openDiffFileRef = useRef(onOpenDiffFile);
  openDiffFileRef.current = onOpenDiffFile;
  const turnLinkShareGateRef = useRef(onTurnLinkShareGate);
  turnLinkShareGateRef.current = onTurnLinkShareGate;
  const stableOpenWikiFile = useCallback((path: string) => openWikiFileRef.current?.(path), []);
  const stableOpenDiffFile = useCallback(
    (assistantMessageId: string) => openDiffFileRef.current?.(assistantMessageId),
    [],
  );
  const stableTurnLinkShareGate = useCallback(() => turnLinkShareGateRef.current?.(), []);
  // Only hand the stable wrappers through when the parent actually supplied a
  // handler — otherwise a current-workspace markdown link would be intercepted
  // (preventDefault) with nothing to open, making it inert instead of
  // navigating. Mirrors the pre-memo behavior where the raw (possibly
  // undefined) callbacks were passed straight through.
  const hasOpenWikiFile = Boolean(onOpenWikiFile);
  const hasOpenDiffFile = Boolean(onOpenDiffFile);
  const hasTurnLinkShareGate = Boolean(onTurnLinkShareGate);
  const wikiOpener = hasOpenWikiFile ? stableOpenWikiFile : undefined;

  const markdownFileLinkComponents = useMemo(
    () => workspaceFileLinkComponents(wikiOpener, workspaceId),
    [wikiOpener, workspaceId],
  );

  // One stable context object for all rows (see RowCtx). With the callbacks
  // ref-stabilized above and knownFilePaths memoized at the call site, this only
  // changes when the file set or turn-link actually changes — never per token.
  const rowCtx = useMemo<RowCtx>(
    () => ({
      knownFilePaths,
      linkComponents: markdownFileLinkComponents,
      onOpenWikiFile: wikiOpener,
      onOpenDiffFile: hasOpenDiffFile ? stableOpenDiffFile : undefined,
      turnLinkBase,
      onTurnLinkShareGate: hasTurnLinkShareGate ? stableTurnLinkShareGate : undefined,
    }),
    [knownFilePaths, markdownFileLinkComponents, wikiOpener, stableOpenDiffFile, hasOpenDiffFile, turnLinkBase, hasTurnLinkShareGate, stableTurnLinkShareGate],
  );

  // renderMessages: merge a turn's split-across-messages tool steps into one
  // bubble so consecutive tool calls collapse into a single "Ran N tools" badge.
  // Memoized — this O(N) walk otherwise re-ran on every streaming token, and its
  // always-new array reference forced the whole transcript to reconcile per token.
  const renderMessages = useMemo(() => coalesceAssistantRuns(uiMessages), [uiMessages]);
  // Freeze-detector context: transcript length is one of the freeze drivers.
  useEffect(() => {
    setFreezeContext({ chatMessages: renderMessages.length });
  }, [renderMessages.length]);

  if (!hasAssistant) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl py-12 text-center text-stone-400">
          <p className="mb-2 text-lg">Add an assistant to start chatting</p>
          <p className="text-sm">
            Invite an assistant from the dashboard to collaborate here.
          </p>
        </div>
      </div>
    );
  }

  // Track the latest assistant message that has turn edits so the diff
  // card can pulse / highlight as "latest turn" the way the legacy
  // renderer did.
  let latestAssistantWithEditsId: string | null = null;
  for (let i = renderMessages.length - 1; i >= 0; i--) {
    const m = renderMessages[i];
    if (m && m.role === 'assistant' && messageHasTurnEdits(m)) {
      latestAssistantWithEditsId = m.id;
      break;
    }
  }

  // The generic typing bubble should retire the instant the live assistant
  // reply has any renderable part (reasoning/tool/compile/text), even though
  // the REST-derived `showWorkingIndicator` only knows about message.content.
  const latestMessage = renderMessages[renderMessages.length - 1];
  const latestAssistantId =
    latestMessage && latestMessage.role === 'assistant' ? latestMessage.id : null;
  const latestAssistantHasParts =
    latestMessage && latestMessage.role === 'assistant'
      ? hasRenderableAssistantParts(latestMessage)
      : false;

  return (
    <Conversation
      className="flex-1"
      contextRef={(ctx: StickToBottomContext | null) => {
        if (scrollToBottomRef) {
          scrollToBottomRef.current = ctx ? () => ctx.scrollToBottom() : null;
        }
      }}
    >
      <ConversationContent
        className="mx-auto min-h-full w-full max-w-2xl justify-start"
        data-testid="chat-transcript-content"
      >
        {showGreeting && assistantGreeting ? (
          <Message from="assistant">
            <MessageContent>
              <MessageResponse>{assistantGreeting}</MessageResponse>
            </MessageContent>
          </Message>
        ) : null}

        {renderMessages.map((message) => {
          const signature = messageRenderSignature(message);
          return (
            <MessageRowBoundary key={message.id} messageId={message.id} signature={signature}>
              <MessageRow
                message={message}
                ctx={rowCtx}
                signature={signature}
                isStreamingMessage={
                  isStreaming && message.role === 'assistant' && message.id === latestAssistantId
                }
                isLatestTurnWithEdits={message.id === latestAssistantWithEditsId}
                isHighlighted={Boolean(highlightedDiffId) && message.id === highlightedDiffId}
                isJustCompletedTurn={
                  latestTurnJustCompleted &&
                  latestAssistantId !== null &&
                  message.id === latestAssistantId
                }
              />
            </MessageRowBoundary>
          );
        })}

        {showWorkingIndicator && !latestAssistantHasParts ? (
          <div className="py-1">
            <div className="inline-flex items-center gap-1 rounded-2xl rounded-bl-sm bg-stone-100 px-3 py-2">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:300ms]" />
            </div>
          </div>
        ) : null}

        <ConversationScrollButton />
      </ConversationContent>
    </Conversation>
  );
}
