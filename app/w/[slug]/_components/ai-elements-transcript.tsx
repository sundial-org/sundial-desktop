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
import { SpinnerSlot } from '@/components/ai-elements/sunny-spinner';
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
  useReasoning,
} from '@/components/ai-elements/reasoning';
import { TurnEditsCard } from '@/components/workspace/turn-edits-card';
import { isChunkLoadError, reloadPage } from '@/lib/workspace/chunk-load-error';
import { CopyLinkButton } from '@/components/workspace/copy-link-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChatCircleIcon, DetectiveIcon, GitDiffIcon, ReceiptIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { WikiLinkInline } from '@/components/workspace/wiki-link-inline';
import { textHasWikiLinks } from '@/lib/workspace/wiki-file-links';
import { formatBytes } from '@/lib/workspace/uploads';
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
  ChevronDownIcon,
  GlobeIcon,
  SparklesIcon,
} from 'lucide-react';
import { splitInlineAskContext } from '@/lib/workspace/inline-ask-context';
import { resolveCommentEvent, type CommentEvent } from '@/lib/workspace/comment-event';
import { skillToolUse, skillsUsedIn } from '@/lib/skills/tool-call';
import { isClaimVerifierSelectionAction } from '@/lib/assistants/selection-actions';
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
  /** Open one turn's whole edit set as its own surface (the end-of-turn diff
   *  icon). Absent on mobile, which has no pane tabs. */
  onOpenTurnDiff?: (assistantMessageId: string) => void;
  /** Workspace file paths for resolving `[[wiki]]` labels in user messages. */
  knownFilePaths?: string[];
  workspaceId?: string | null;
  onOpenWikiFile?: (path: string) => void;
  /** Edit-card header click — open JUST the file (no chat side-panel dock);
   *  falls back to onOpenWikiFile when absent. */
  onOpenEditedFile?: (path: string) => void;
  /** Local-mode override: builds the href for a user attachment (sidecar file
   *  URL). When absent, cloud rules apply (signed url / preview proxy). */
  attachmentHref?: (attachment: MessageAttachment) => string | null;
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

/** The assistant's visible prose for the turn — what the "copy message" icon
 *  copies. CONTIGUOUS text parts are one document (citation splits) and join
 *  with no separator; runs separated by tools/reasoning join as paragraphs. */
function messagePlainText(parts: unknown[]): string {
  const runs: string[] = [];
  let current = '';
  for (const p of parts) {
    if (isTextPart(p)) {
      current += p.text;
    } else if (current) {
      runs.push(current);
      current = '';
    }
  }
  if (current) runs.push(current);
  return runs.join('\n\n').trim();
}

function isVisibleReasoningPart(part: unknown): boolean {
  return isReasoningPart(part) && (part.text ?? part.reasoning ?? '').trim().length > 0;
}

/** Compile status as the same grey h-6 meta line as tool groups — spinner +
 *  shimmer while compiling, settled grey text after. No red/green status
 *  colors (chat design rules); the full errorTail stays reachable as a
 *  tooltip on the failed line. */
function CompileStatus({ data }: { data: CompileStatusData }) {
  const phase = data.phase ?? 'compiling';
  if (phase === 'no-tex') return null;
  const target = data.texPath ?? 'LaTeX';
  const attempt =
    typeof data.attempt === 'number' && data.attempt > 1 ? ` (attempt ${data.attempt})` : '';
  const active = phase === 'compiling';
  const failed = phase === 'failed';
  // First `! …` line is the most useful preview — tectonic puts the actual
  // `! LaTeX Error: …` near the top of the tail.
  const firstErrorLine = failed
    ? data.errorTail
        ?.split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('!'))
        ?.replace(/^!\s*/, '') ?? null
    : null;
  const label = active
    ? `Compiling ${target}…`
    : failed
      ? `Compile failed for ${target}${attempt}${firstErrorLine ? ` - ${firstErrorLine}` : ''}`
      : `Compiled ${target}${attempt}`;
  return (
    <div
      className={`my-0.5 flex h-6 items-center text-[14px] ${active ? 'text-stone-500' : 'text-stone-400'}`}
      title={failed ? data.errorTail ?? undefined : undefined}
    >
      <SpinnerSlot show={active} />
      <span className={active ? 'chat-shimmer min-w-0 truncate' : 'min-w-0 truncate'}>
        {label}
      </span>
    </div>
  );
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

/** Same-size grey dot for every state so row labels left-align; failure is a
 *  darker dot + a "failed" text suffix, never a red icon. Running pulses in
 *  brand orange. */
function toolStatusDot(state: ToolUIPart['state']): ReactNode {
  const failed = state === 'output-error' || state === 'output-denied';
  const settled = state === 'output-available' || state === 'approval-responded' || failed;
  const cls = !settled
    ? 'animate-pulse bg-[#FF7800]'
    : failed
      ? 'bg-stone-500'
      : 'bg-stone-300';
  return (
    <span className="flex w-3 shrink-0 justify-center">
      <span className={`size-1.5 rounded-full ${cls}`} />
    </span>
  );
}

/** Human verb labels: present-continuous while the tool runs, past once done.
 *  "Read {file_path: a.md}" → "Reading a.md" / "Read a.md". */
const TOOL_VERBS: Record<string, [running: string, done: string]> = {
  Read: ['Reading', 'Read'],
  Write: ['Writing', 'Wrote'],
  Edit: ['Editing', 'Edited'],
  MultiEdit: ['Editing', 'Edited'],
  NotebookEdit: ['Editing', 'Edited'],
  Bash: ['Running', 'Ran'],
  Glob: ['Searching files', 'Searched files'],
  Grep: ['Searching files', 'Searched files'],
  web_search: ['Searching the web', 'Searched the web'],
  web_fetch: ['Reading the web', 'Read the web'],
};

function humanToolLabel(part: ToolUIPart, running: boolean): string {
  const name = toolDisplayName(part);
  const verbs = TOOL_VERBS[name];
  const verb = verbs ? verbs[running ? 0 : 1] : name;
  const input = (part.input ?? null) as Record<string, unknown> | null;
  const subject = clipText(summarizeToolInput(name, input), 60);
  // Name-carrying verbs ("Searched the web") already read complete.
  if (!subject || name === 'web_search') return verb;
  return `${verb} ${subject}`;
}

/** agent-ts file tools report failures as ordinary `"Error: ..."` strings
 *  under `output-available` — for skill attribution that is a FAILED read (a
 *  real SKILL.md's content starts with frontmatter, never `Error: `). */
function toolOutputIsError(output: unknown): boolean {
  return typeof output === 'string' && output.startsWith('Error: ');
}

function toolIsActive(state: ToolUIPart['state']): boolean {
  return (
    state === 'input-streaming' ||
    state === 'input-available' ||
    state === 'approval-requested'
  );
}

/** The state an orphaned input-state part reads as once its turn is over —
 *  the grey settled dot, never the pulsing "running" one. */
function settleOrphanState(state: ToolUIPart['state']): ToolUIPart['state'] {
  return toolIsActive(state) ? 'output-available' : state;
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

/** One row inside an expanded ToolGroup: grey status dot + human label,
 *  expandable to the (clamped) input/output payload. Link-like, no button
 *  chrome. */
function ToolRow({ part, turnActive = true }: { part: ToolUIPart; turnActive?: boolean }) {
  const failed = part.state === 'output-error' || part.state === 'output-denied';
  // After the turn ends, an input-state part is an orphan, not a live run —
  // see ToolGroup's turnActive doc. Render it settled (past-tense verb, no
  // pulsing dot) instead of "Running …" forever.
  const rowActive = turnActive && toolIsActive(part.state);
  const sources = webSearchSources(part);
  // A skill read reads as its own action, not a file read — a reviewer asking
  // "which skill did it apply?" shouldn't have to decode `Read skills/…`.
  const skill = skillToolUse(toolDisplayName(part), part.input);
  const label = sources
    ? `Searched the web · ${sources.length} source${sources.length === 1 ? '' : 's'}`
    : skill
      ? skill.kind === 'entry'
        ? `Read the ${skill.id} skill`
        : `Read ${skill.id} › ${skill.path.slice(`skills/${skill.id}/`.length)}`
      : humanToolLabel(part, rowActive);
  const hasDetail =
    part.input != null ||
    part.state === 'output-available' ||
    part.state === 'output-error';

  const rowBody = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {/* Only a SUCCESSFUL read earns the skill glyph — otherwise the sparkle
          would sit where the failure dot belongs and a failed skill read would
          look like it worked. */}
      {skill && part.state === 'output-available' && !toolOutputIsError(part.output) ? (
        <span className="flex w-3 shrink-0 justify-center">
          <SparklesIcon className="size-3 text-amber-500" />
        </span>
      ) : (
        toolStatusDot(rowActive ? part.state : settleOrphanState(part.state))
      )}
      <span className="min-w-0 truncate text-stone-500">{label}</span>
      {failed ? <span className="shrink-0 text-[11px] text-stone-400">failed</span> : null}
    </div>
  );

  if (!hasDetail) {
    return <div className="flex h-6 items-center text-[14px]">{rowBody}</div>;
  }

  return (
    <Collapsible className="group/row">
      <CollapsibleTrigger className="flex h-6 w-fit max-w-full items-center gap-1 text-left text-[14px] transition-colors hover:text-stone-700">
        {rowBody}
        <ChevronDownIcon className="size-3 shrink-0 text-stone-300 opacity-0 transition-all group-hover/row:opacity-100 group-data-[state=open]/row:rotate-180 group-data-[state=open]/row:opacity-100" />
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

/** Reasoning part folded into a tool group (see renderMessageParts). */
type GroupReasoning = { type: 'reasoning'; text?: string; reasoning?: string; state?: string };

function groupReasoningText(item: GroupReasoning): string {
  return (item.text ?? item.reasoning ?? '').trim();
}

/** A thought inside an expanded tool group: same link-like row as tools,
 *  expandable to the (clamped) chain of thought. */
function ThoughtRow({ text }: { text: string }) {
  return (
    <Collapsible className="group/row">
      <CollapsibleTrigger className="flex h-6 w-fit max-w-full items-center gap-1 text-left text-[14px] transition-colors hover:text-stone-700">
        <span className="flex w-3 shrink-0 justify-center">
          <span className="size-1.5 rounded-full bg-stone-300" />
        </span>
        <span className="text-stone-500">Thought</span>
        <ChevronDownIcon className="size-3 shrink-0 text-stone-300 opacity-0 transition-all group-hover/row:opacity-100 group-data-[state=open]/row:rotate-180 group-data-[state=open]/row:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="my-1 max-h-40 overflow-auto text-[12px] leading-5 text-stone-400">{text}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A contiguous run of tool calls AND interleaved thinking as ONE fixed-height
 *  line, live or settled. While work runs the line IS the working indicator —
 *  Sunny spinner + a label narrating the current activity ("Reading
 *  paper.tex…", "Thinking…"); settled, the spinner slides away and the label
 *  becomes "Ran N tools". Nothing auto-expands or auto-collapses (that
 *  collapse was a mid-turn layout jump), and the collapsed line carries no
 *  status icons or failure counts — failures are visible in the expanded rows. */
export function ToolGroup({
  parts,
  lastReasoningStreaming = false,
  turnActive = true,
}: {
  parts: (ToolUIPart | GroupReasoning)[];
  lastReasoningStreaming?: boolean;
  /** Whether this message's turn is still streaming. Once the turn is over,
   *  nothing can still be running — a part stuck at an input state is an
   *  orphan (e.g. a mid-stream CLI retry re-minted the tool id and the first
   *  part never got its result), and rendering it as "Running X…" forever was
   *  the "status still shows the agent is running after it finished" report
   *  (team bug thread, Aug 23). Settled turns render every part settled. */
  turnActive?: boolean;
}) {
  const tools = parts.filter((p): p is ToolUIPart => isToolPart(p));
  const total = tools.length;
  const activeTools = turnActive ? tools.filter((p) => toolIsActive(p.state)) : [];
  const active = activeTools.length > 0 || lastReasoningStreaming;
  const label = lastReasoningStreaming
    ? 'Thinking…'
    : activeTools.length > 0
      ? `${humanToolLabel(activeTools[activeTools.length - 1]!, true)}…`
      : `Ran ${total} ${total === 1 ? 'tool' : 'tools'}`;

  // Skills are surfaced on the collapsed line: "which of my skills did it
  // apply?" shouldn't require expanding the run of tool calls to find out.
  // Successful reads only — a failed read means the agent never saw the skill,
  // and a chip claiming otherwise is worse than no chip.
  const skills = skillsUsedIn(
    tools
      .filter((p) => p.state === 'output-available' && !toolOutputIsError(p.output))
      .map((p) => ({ toolName: toolDisplayName(p), input: p.input })),
  );

  return (
    <Collapsible className="not-prose group my-0.5 text-[14px]">
      <CollapsibleTrigger
        data-testid="tool-group-line"
        className={`flex h-6 w-fit max-w-full items-center text-left transition-colors ${active ? 'text-stone-500 hover:text-stone-600' : 'text-stone-400 hover:text-stone-600'}`}
      >
        <SpinnerSlot show={active} />
        <span className={active ? 'chat-shimmer min-w-0 truncate' : 'min-w-0 truncate'}>
          {label}
        </span>
        {skills.map((skill) => (
          <span
            key={skill.id}
            // "Read", not "used": this is derived from the agent opening the
            // file, which is not proof it followed it. Don't claim more — and a
            // turn that only opened a supporting file never read the skill
            // itself, so it doesn't get to say it did.
            // "N of its files" stays plural at any N ("1 of its files").
            title={
              skill.readEntry
                ? `Read the ${skill.id} skill${
                    skill.referenceCount > 0 ? ` and ${skill.referenceCount} of its files` : ''
                  }`
                : `Read ${skill.referenceCount} of the ${skill.id} skill's files`
            }
            className="ml-1.5 flex min-w-0 shrink items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
          >
            <SparklesIcon className="size-2.5 shrink-0" />
            <span className="truncate">{skill.id}</span>
          </span>
        ))}
        <ChevronDownIcon className="ml-1 size-3 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-data-[state=open]:rotate-180 group-data-[state=open]:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="ml-1.5 flex flex-col border-l border-stone-200 pl-3">
          {parts.map((item, i) =>
            isToolPart(item) ? (
              <ToolRow key={item.toolCallId ?? i} part={item} turnActive={turnActive} />
            ) : groupReasoningText(item) ? (
              <ThoughtRow key={i} text={groupReasoningText(item)} />
            ) : null,
          )}
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
  // Em-dash → dash typography happens in MessageResponse's remark plugin
  // (parsed text nodes only — code/math/links structurally protected).
  const shown = useSmoothStreamedText(text, streaming);
  return (
    <MessageResponse components={components} isAnimating={streaming}>
      {shown}
    </MessageResponse>
  );
}

/** Custom trigger body: the new link-like thinking line (no box, no brain
 *  icon) — shimmer while live, "Thought for Ns" settled, chevron on hover.
 *  Reads streaming/duration from the Reasoning context so the component's
 *  settle-once machinery stays intact. */
function TranscriptReasoningLabel() {
  const { isStreaming, isOpen, duration } = useReasoning();
  if (isStreaming) {
    return (
      <span className="flex h-6 items-center text-[14px] text-stone-400">
        <span className="chat-shimmer">Thinking…</span>
      </span>
    );
  }
  return (
    <span className="flex h-6 items-center gap-1 text-[14px] text-stone-400 transition-colors hover:text-stone-600">
      <span>{duration ? `Thought for ${duration}s` : 'Thought'}</span>
      <ChevronDownIcon
        className={`size-3 shrink-0 opacity-0 transition-all group-hover/think:opacity-100 ${isOpen ? 'rotate-180 opacity-100' : ''}`}
      />
    </span>
  );
}

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
    <Reasoning defaultOpen={false} isStreaming={isStreaming} className="my-0.5 mb-0">
      <ReasoningTrigger className="group/think h-6 w-fit gap-0">
        <TranscriptReasoningLabel />
      </ReasoningTrigger>
      <ReasoningContent className="ml-1.5 mt-0 max-h-40 overflow-auto border-l border-stone-200 pl-3 text-[12px] leading-5 text-stone-400">
        {text}
      </ReasoningContent>
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
    // Empty reasoning renders nothing — even mid-stream. Models that reason
    // silently (e.g. OpenAI gpt-5) are covered by the Sunny working line
    // ("Thinking…") until summary text arrives; mounting the reasoning shimmer
    // too showed TWO Thinking lines at once (2026-07-31 feedback).
    if (!text) return null;
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
    if (isToolPart(part) || isReasoningPart(part)) {
      // Measure the contiguous meta-run: tools, reasoning, and step markers.
      // A run containing at least one tool consolidates into ONE line —
      // alternating "Thought for 2s" / "Ran 2 tools" stacks read too sparse
      // (2026-07-31 feedback). Reasoning-only runs keep the Reasoning box.
      let j = i;
      const items: (ToolUIPart | GroupReasoning)[] = [];
      let toolCount = 0;
      while (
        j < parts.length &&
        (isToolPart(parts[j]) || isStepBoundaryPart(parts[j]) || isReasoningPart(parts[j]))
      ) {
        const p = parts[j];
        if (isToolPart(p)) {
          items.push(p);
          toolCount += 1;
        } else if (isReasoningPart(p)) {
          items.push(p as GroupReasoning);
        }
        j += 1;
      }
      if (toolCount > 0) {
        const lastItem = items[items.length - 1];
        const lastReasoningStreaming =
          options.isStreamingMessage &&
          j === parts.length &&
          !!lastItem &&
          isReasoningPart(lastItem) &&
          (lastItem as { state?: string }).state !== 'done';
        nodes.push(
          <ToolGroup
            key={partKey(message, i)}
            parts={items}
            lastReasoningStreaming={lastReasoningStreaming}
            turnActive={options.isStreamingMessage}
          />,
        );
        i = j;
        continue;
      }
    }
    // Contiguous assistant text parts are ONE document. The brain persists a
    // reply as many text parts when the model's text stream is chopped up
    // (e.g. web-citation boundaries), and rendering each as its own markdown
    // block broke sentences and lists mid-way — lone "." lines, empty bullets
    // (2026-08-01, turn ef4fff20). Join them and parse once.
    if (message.role === 'assistant' && isTextPart(part)) {
      let j = i;
      let joined = '';
      while (j < parts.length && isTextPart(parts[j])) {
        joined += (parts[j] as { text: string }).text;
        j += 1;
      }
      if (joined) {
        nodes.push(
          <AssistantTextPart
            key={partKey(message, i)}
            text={joined}
            streaming={options.isStreamingMessage && j === parts.length}
            components={options.workspaceFileLinkComponents}
          />,
        );
      }
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

/** Relative turn age ("Now", "5m ago", "2h ago"…), self-ticking so "Now"
 *  becomes "1m ago" without a parent re-render. A missing/unparsable
 *  created_at (the still-streaming reply isn't persisted yet) reads "Now". */
function relativeTimeLabel(createdAt: unknown, now: number): string {
  const t = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  if (Number.isNaN(t)) return 'Now';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'Now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (d < 30) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (d < 365) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatTurnDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Three-dots turn details: model, token usage, wall-clock duration — read
 *  from message metadata (messages.model / input_tokens / output_tokens via
 *  the GET route; duration_ms stamped by the brain at finalize). Renders
 *  nothing when the turn predates the plumbing. */
function TurnMetaMenu({ meta }: { meta: Record<string, unknown> }) {
  const model = typeof meta.model === 'string' ? meta.model.split('/').pop() ?? meta.model : null;
  const input = typeof meta.input_tokens === 'number' ? meta.input_tokens : null;
  const output = typeof meta.output_tokens === 'number' ? meta.output_tokens : null;
  const duration = typeof meta.duration_ms === 'number' ? meta.duration_ms : null;
  // Whether the CURRENT open came from a pointer — closing a pointer-opened
  // menu must not refocus the trigger (focus-within would pin the
  // hover-revealed footer row), but a keyboard-opened menu must keep Radix's
  // focus restore or Escape strands focus on <body> (Codex round 15).
  const pointerOpenedRef = useRef(false);
  if (!model && input === null && output === null && duration === null) return null;
  const rows: [string, string][] = [];
  if (model) rows.push(['Model', model]);
  if (input !== null || output !== null) {
    rows.push([
      'Tokens',
      [
        input !== null ? `${formatTokenCount(input)} in` : null,
        output !== null ? `${formatTokenCount(output)} out` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ]);
  }
  if (duration !== null) rows.push(['Duration', formatTurnDuration(duration)]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Turn details"
          data-testid="turn-meta-trigger"
          onPointerDown={() => {
            pointerOpenedRef.current = true;
          }}
          onKeyDown={() => {
            pointerOpenedRef.current = false;
          }}
          className="flex h-6 w-6 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 active:bg-stone-100"
        >
          {/* weight matches CopyLinkButton's default 'bold' — the three footer
              icons must read as one family (2026-08-01 feedback). */}
          <ReceiptIcon weight="bold" className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        data-testid="turn-meta-menu"
        className="min-w-[180px] rounded-lg border-stone-200 bg-white p-1.5 shadow-sm"
        // Pointer-opened: don't refocus the trigger on close (focus-within
        // would keep the hover-revealed footer row pinned after the menu is
        // gone). Keyboard-opened: keep Radix's focus restore, or Escape
        // would strand focus on <body>.
        onCloseAutoFocus={(e) => {
          if (pointerOpenedRef.current) e.preventDefault();
        }}
      >
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-6 px-1.5 py-0.5 text-[12px]">
            <span className="text-stone-400">{label}</span>
            <span className="text-stone-600">{value}</span>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TurnTimestamp({ createdAt }: { createdAt: unknown }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const t = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  return (
    // The parent footer row is hover-revealed as a whole; hovering the stamp
    // itself shows the exact date/time as the app's black tooltip.
    <span
      className="relative ml-1 cursor-default text-[11px] text-stone-400"
      data-testid="turn-timestamp"
    >
      {relativeTimeLabel(createdAt, now)}
      {Number.isNaN(t) ? null : <IconTooltip label={new Date(t).toLocaleString()} />}
    </span>
  );
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

/** Same-origin preview-proxy URL (302 → fresh signed URL) for a composer
 *  upload, i.e. a real workspace file. Not built for text uploads (the proxy
 *  only serves blobs) or chat-attachment-bucket rows (`storagePath` set — the
 *  proxy can't serve that bucket). */
function workspaceProxyHref(attachment: MessageAttachment, workspaceId?: string | null): string | null {
  if (workspaceId && attachment.id && attachment.type !== 'text' && !attachment.storagePath) {
    return `/api/workspace/files/preview?projectId=${encodeURIComponent(workspaceId)}&fileId=${encodeURIComponent(attachment.id)}`;
  }
  return null;
}

function AttachmentChip({
  attachment,
  ctx,
}: {
  attachment: MessageAttachment;
  ctx: RowCtx;
}) {
  const name = attachment.name ?? attachment.path.split('/').pop() ?? 'attachment';
  // Inline previews auto-fetch, so they're limited to URLs WE construct (the
  // same-origin proxy, or local mode's sidecar builder). A signed_url out of
  // message metadata is client-supplied — any collaborator could plant a
  // tracking pixel — so it stays a click-only chip link.
  const constructed = ctx.attachmentHref
    ? ctx.attachmentHref(attachment)
    : workspaceProxyHref(attachment, ctx.workspaceId);
  const href = constructed ?? attachment.signedUrl ?? null;
  if (constructed && attachment.mime?.startsWith('image/')) {
    return (
      <a href={constructed} target="_blank" rel="noreferrer" data-testid="attachment-image">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed/proxied
            src, unknown dimensions; next/image can't optimize these. */}
        <img
          src={constructed}
          alt={name}
          loading="lazy"
          className="max-h-40 max-w-60 rounded-md border border-stone-200 object-cover"
        />
      </a>
    );
  }
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
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
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
  onOpenEditedFile?: (path: string) => void;
  onOpenTurnDiff?: (assistantMessageId: string) => void;
  turnLinkBase?: string;
  onTurnLinkShareGate?: () => void;
  workspaceId?: string | null;
  attachmentHref?: (attachment: MessageAttachment) => string | null;
};

type MessageRowProps = {
  message: UIMessage;
  ctx: RowCtx;
  // Compared by the memo; identifies a content change for THIS row.
  signature: string;
  isStreamingMessage: boolean;
  isLatestTurnWithEdits: boolean;
  isHighlighted: boolean;
  /** metadata.created_at, hoisted to a prop so the memo comparator sees it —
   *  the reconcile that stamps it often changes nothing else in the row. */
  createdAt: unknown;
  /** model|tokens|duration fingerprint — same reason: a metadata-only
   *  reconcile must re-render the row or the turn-details menu stays stale. */
  turnMetaKey: string;
};

/** "8:00 AM"-style stamp for the scheduled-run label; null without a date. */
function scheduledRunTime(createdAt: unknown): string | null {
  const t = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  return Number.isNaN(t)
    ? null
    : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** A doc comment that woke the agent — a quiet event card, not "the user said
 *  this in chat". The delivered text also carries a model-only instruction;
 *  resolveCommentEvent strips it. */
function CommentEventCard({ event }: { event: CommentEvent }) {
  return (
    <div
      data-testid="comment-event-card"
      className="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5 text-xs text-stone-400">
        <ChatCircleIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          <span className="text-stone-500">{event.authorName}</span>{' '}
          {event.isNewThread ? 'commented on' : 'replied on'}{' '}
          {event.filePath.split('/').pop() || event.filePath}
        </span>
      </div>
      {event.quote ? (
        <p className="mt-1.5 border-l-2 border-stone-200 pl-2 text-[12px] italic text-stone-400">
          {clipText(event.quote, 80)}
        </p>
      ) : null}
      {event.body ? (
        <p className="mt-1.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {event.body}
        </p>
      ) : null}
      {event.blocked ? (
        <p data-testid="comment-event-blocked" className="mt-1.5 text-[12px] text-amber-600">
          The agent couldn&apos;t run (usage limit reached), so this comment wasn&apos;t answered.
        </p>
      ) : null}
    </div>
  );
}

type SelectionActionEvent = {
  title: string;
  assistantName: string;
  filePath: string;
  quote: string;
};

function resolveSelectionActionEvent(meta: Record<string, unknown>): SelectionActionEvent | null {
  const raw = meta.selection_action;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const action = raw as Record<string, unknown>;
  const isClaimVerifier = isClaimVerifierSelectionAction(action);
  const title = isClaimVerifier
    ? 'Claim Verifier'
    : typeof action.title === 'string'
      ? action.title.trim()
      : '';
  const assistantName = isClaimVerifier
    ? 'Claim Verifier'
    : typeof action.assistant_name === 'string'
      ? action.assistant_name.trim()
      : '';
  const filePath = typeof action.path === 'string' ? action.path.trim() : '';
  const quote = typeof action.quote === 'string' ? action.quote.trim() : '';
  if (!title || !assistantName || !filePath || !quote) return null;
  return { title, assistantName, filePath, quote };
}

function SelectionActionEventCard({ event }: { event: SelectionActionEvent }) {
  return (
    <div
      data-testid="selection-action-event-card"
      className="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5 text-xs text-stone-400">
        <DetectiveIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          <span className="font-medium text-stone-600">{event.title}</span>
          {' · '}
          {event.filePath.split('/').pop() || event.filePath}
        </span>
        <span className="ml-auto shrink-0 text-[11px]">{event.assistantName}</span>
      </div>
      <p className="mt-1.5 border-l-2 border-stone-200 pl-2 text-[12px] italic text-stone-400">
        “{clipText(event.quote.replace(/\s+/g, ' '), 120)}”
      </p>
    </div>
  );
}

function MessageRowImpl({
  message,
  ctx,
  isStreamingMessage,
  isLatestTurnWithEdits,
  isHighlighted,
  createdAt,
}: MessageRowProps) {
  // Scheduled runs (dispatcher-tagged metadata.source): the prompt keeps its
  // bubble but carries a small "scheduled run · <time>" label; a skipped run
  // collapses to a quiet one-line note with the reason — never a red banner.
  const meta = messageMeta(message);
  const isScheduledRun = message.role === 'user' && meta.source === 'scheduled_task';
  if (isScheduledRun && meta.skipped === true) {
    const reason = typeof meta.skip_reason === 'string' && meta.skip_reason.trim() ? meta.skip_reason.trim() : null;
    return (
      <div
        data-message-id={message.id}
        data-testid="scheduled-run-skipped"
        className="py-1 text-right text-[12px] text-stone-400"
      >
        scheduled run skipped{reason ? ` · ${reason}` : ''}
      </div>
    );
  }
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (message.role === 'user' && meta.source === 'selection_action') {
    const event = resolveSelectionActionEvent(meta);
    if (event) {
      return (
        <div data-message-id={message.id} className="py-1">
          <SelectionActionEventCard event={event} />
        </div>
      );
    }
  }
  if (message.role === 'user' && meta.source === 'comment') {
    const event = resolveCommentEvent(meta, messagePlainText(parts));
    if (event) {
      return (
        <div data-message-id={message.id} className="py-1">
          <CommentEventCard event={event} />
        </div>
      );
    }
  }
  const attachments = message.role === 'user' ? messageAttachments(message) : [];
  const hasEdits = message.role === 'assistant' && messageHasTurnEdits(message);
  const editCount = hasEdits ? messageEditedFileCount(message) : null;
  const showTurnLink =
    message.role === 'assistant' &&
    Boolean(ctx.turnLinkBase) &&
    assistantHasTurnLinkTarget(message, parts);
  const turnMessageText = showTurnLink ? messagePlainText(parts) : '';
  // The end of a run shows NOTHING — no "Done", no failure label. The working
  // line below disappearing IS the completion signal (2026-07-30 feedback).
  // While streaming, exactly one line animates: the active tool line narrates
  // tool work; otherwise this working line covers thinking/writing.
  const lastPart = parts[parts.length - 1] as
    | { type?: string; state?: string; text?: string; reasoning?: string }
    | undefined;
  // An active tool line or a streaming reasoning surface narrates its own
  // progress — the working line only covers the gaps so exactly one line ever
  // animates. A trailing reasoning part narrates when it will actually render
  // something: it has text (standalone shimmer), or it's folded into a tool
  // group (whose line shows "Thinking…" even for silent reasoning). A silent
  // standalone thought renders nothing — the working line must cover it.
  const lastReasoningInToolRun = (() => {
    if (lastPart?.type !== 'reasoning') return false;
    for (let k = parts.length - 2; k >= 0; k -= 1) {
      const p = parts[k] as { type?: string };
      if (isStepBoundaryPart(p) || p?.type === 'reasoning') continue;
      return (
        typeof p?.type === 'string' &&
        (p.type.startsWith('tool-') || p.type === 'dynamic-tool')
      );
    }
    return false;
  })();
  const lastPartNarrates =
    !!lastPart &&
    typeof lastPart.type === 'string' &&
    ((lastPart.type === 'reasoning' &&
      (((lastPart.text ?? lastPart.reasoning ?? '').trim().length > 0) || lastReasoningInToolRun)) ||
      ((lastPart.type.startsWith('tool-') || lastPart.type === 'dynamic-tool') &&
        toolIsActive((lastPart as ToolUIPart).state)) ||
      // A live LaTeX compile shows its own "Compiling…" shimmer line.
      (isCompileStatusPart(lastPart) &&
        (lastPart.data?.phase ?? 'compiling') === 'compiling'));
  // Gated on renderable content: before the first renderable part the
  // transcript-level pre-token line covers the run — without this gate both
  // rendered and the start of a turn showed two "Thinking…" lines.
  const workingLabel =
    message.role === 'assistant' &&
    isStreamingMessage &&
    !lastPartNarrates &&
    hasRenderableAssistantParts(message)
      ? lastPart?.type === 'text'
        ? 'Writing…'
        : 'Thinking…'
      : null;

  return (
    <Message from={message.role} key={message.id} data-message-id={message.id}>
      {isScheduledRun ? (
        <span data-testid="scheduled-run-label" className="-mb-1 mr-1.5 self-end text-[11px] text-stone-400">
          scheduled run{scheduledRunTime(createdAt) ? ` · ${scheduledRunTime(createdAt)}` : ''}
        </span>
      ) : null}
      <MessageContent>
        {renderMessageParts(message, parts, {
          knownFilePaths: ctx.knownFilePaths,
          workspaceFileLinkComponents: ctx.linkComponents,
          onOpenWikiFile: ctx.onOpenWikiFile,
          isStreamingMessage,
        })}
        {workingLabel ? (
          <div className="flex h-6 items-center text-[14px] text-stone-500" data-testid="turn-working">
            <SpinnerSlot show />
            <span className="chat-shimmer">{workingLabel}</span>
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} ctx={ctx} />
            ))}
          </div>
        ) : null}
        {hasEdits ? (
          // Per-file edit cards own their interactions (header/double-click →
          // open the file, hover ✓/✗, caret) — no whole-area click hijack.
          <div data-diff-id={message.id} className="mt-2">
            <TurnEditsCard
              assistantMessageId={message.id}
              initialCount={editCount}
              variant="inline"
              isLatestTurn={isLatestTurnWithEdits}
              defaultExpanded={isHighlighted}
              onOpenFile={ctx.onOpenEditedFile ?? ctx.onOpenWikiFile}
            />
          </div>
        ) : null}
        {showTurnLink && ctx.turnLinkBase ? (
          // End-of-turn affordances: link, copy, turn-details menu, relative
          // timestamp. On hover-capable devices the WHOLE row hides until the
          // turn is hovered (2026-08-01 feedback) — opacity keeps the space,
          // so no layout jump; focus-within keeps it reachable by keyboard,
          // and an OPEN details menu pins the row visible even when the
          // cursor strays (the portaled menu holds focus outside the row, so
          // focus-within alone can't; Radix stamps data-state=open on the
          // trigger). Touch devices (hover:none) always see the row.
          <div
            className="mt-1 flex items-center gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100 [@media(hover:hover)]:has-[[data-state=open]]:opacity-100"
            data-testid="turn-link"
          >
            {hasEdits && ctx.onOpenTurnDiff ? (
              <button
                type="button"
                onClick={() => ctx.onOpenTurnDiff?.(message.id)}
                aria-label="Open this turn's edits"
                data-testid="turn-open-diff"
                className="relative group/tip inline-flex h-6 w-6 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
              >
                <GitDiffIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
                <IconTooltip label="Open this turn's edits" />
              </button>
            ) : null}
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
            <TurnMetaMenu meta={messageMeta(message)} />
            <TurnTimestamp createdAt={createdAt} />
          </div>
        ) : null}
      </MessageContent>
      {/* User-message footer — copy + timestamp under the bubble, hover-
          revealed like the assistant's (2026-08-01 feedback). Outside
          MessageContent: for user rows that IS the dark bubble. */}
      {message.role === 'user' ? (
        <div
          className="-mt-1 mr-1.5 flex items-center gap-0.5 self-end transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
          data-testid="user-message-footer"
        >
          <CopyLinkButton
            url={messagePlainText(parts)}
            icon="copy"
            label="Copy message"
            tooltip="Copy message"
            iconClassName="h-3.5 w-3.5"
          />
          <TurnTimestamp createdAt={createdAt} />
        </div>
      ) : null}
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
    a.createdAt === b.createdAt &&
    a.turnMetaKey === b.turnMetaKey &&
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
  { failed: boolean; stale: boolean }
> {
  state = { failed: false, stale: false };
  private failedSignature: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('[transcript] message render failed', error);
    // A chunk missing after a redeploy never heals by retry: only a reload does.
    if (isChunkLoadError(error)) {
      // componentDidUpdate may already have armed a retry for this commit.
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.failedSignature = null;
      this.setState({ stale: true });
    } else {
      this.failedSignature = this.props.signature;
    }
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
          {this.state.stale ? (
            <>
              This message needs a page refresh to display.{' '}
              <button
                type="button"
                className="underline hover:text-stone-600"
                onClick={reloadPage}
              >
                Refresh
              </button>
            </>
          ) : (
            'This message couldn’t be displayed.'
          )}
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
  onOpenTurnDiff,
  knownFilePaths = [],
  workspaceId,
  onOpenWikiFile,
  onOpenEditedFile,
  attachmentHref,
}: AIElementsTranscriptProps) {
  // Stable wrappers for the open callbacks. The parent recreates these whenever
  // its file map changes (handleOpenEditedFileInline depends on workspaceFiles,
  // which churns as the agent writes files — i.e. exactly while suggestions
  // stream), and their identity would otherwise force rowCtx (and every row) to
  // re-render. The wrappers read the latest callback from a ref, so behavior
  // stays current without churning identity.
  const openWikiFileRef = useRef(onOpenWikiFile);
  openWikiFileRef.current = onOpenWikiFile;
  const openEditedFileRef = useRef(onOpenEditedFile);
  openEditedFileRef.current = onOpenEditedFile;
  const openTurnDiffRef = useRef(onOpenTurnDiff);
  openTurnDiffRef.current = onOpenTurnDiff;
  const turnLinkShareGateRef = useRef(onTurnLinkShareGate);
  turnLinkShareGateRef.current = onTurnLinkShareGate;
  const stableOpenWikiFile = useCallback((path: string) => openWikiFileRef.current?.(path), []);
  const stableOpenEditedFile = useCallback((path: string) => openEditedFileRef.current?.(path), []);
  const stableOpenTurnDiff = useCallback(
    (assistantMessageId: string) => openTurnDiffRef.current?.(assistantMessageId),
    [],
  );
  const stableTurnLinkShareGate = useCallback(() => turnLinkShareGateRef.current?.(), []);
  // Only hand the stable wrappers through when the parent actually supplied a
  // handler — otherwise a current-workspace markdown link would be intercepted
  // (preventDefault) with nothing to open, making it inert instead of
  // navigating. Mirrors the pre-memo behavior where the raw (possibly
  // undefined) callbacks were passed straight through.
  const hasOpenWikiFile = Boolean(onOpenWikiFile);
  const hasOpenEditedFile = Boolean(onOpenEditedFile);
  const hasOpenTurnDiff = Boolean(onOpenTurnDiff);
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
      onOpenEditedFile: hasOpenEditedFile ? stableOpenEditedFile : undefined,
      onOpenTurnDiff: hasOpenTurnDiff ? stableOpenTurnDiff : undefined,
      turnLinkBase,
      onTurnLinkShareGate: hasTurnLinkShareGate ? stableTurnLinkShareGate : undefined,
      workspaceId,
      attachmentHref,
    }),
    [knownFilePaths, markdownFileLinkComponents, wikiOpener, hasOpenEditedFile, stableOpenEditedFile, stableOpenTurnDiff, hasOpenTurnDiff, turnLinkBase, hasTurnLinkShareGate, stableTurnLinkShareGate, workspaceId, attachmentHref],
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
          const meta = messageMeta(message);
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
                createdAt={meta.created_at}
                turnMetaKey={`${meta.model ?? ''}|${meta.input_tokens ?? ''}|${meta.output_tokens ?? ''}|${meta.duration_ms ?? ''}`}
              />
            </MessageRowBoundary>
          );
        })}

        {(showWorkingIndicator || isStreaming) && !latestAssistantHasParts ? (
          // Pre-first-token: same Sunny working line the streaming turn shows,
          // so the whole run has one continuous "alive" signal (no dots).
          // `isStreaming` (live useChat status, set synchronously on send) is
          // OR'd in because the REST-derived `showWorkingIndicator` is stale in
          // the send window on an existing chat: its latest-assistant row is
          // the PREVIOUS turn's reply, whose content suppressed the line until
          // the new run's row landed (2026-08-05 feedback).
          <div className="flex h-6 items-center text-[14px] text-stone-500" data-testid="turn-working">
            <SpinnerSlot show />
            <span className="chat-shimmer">Thinking…</span>
          </div>
        ) : null}

        <ConversationScrollButton />
      </ConversationContent>
    </Conversation>
  );
}
