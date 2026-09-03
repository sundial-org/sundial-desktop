'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SunnyAnimation } from '@/components/sunny-animation';
import { extractSelectionActionSummary } from '@/lib/assistants/selection-action-summary';

// Submit a comment textarea on Cmd/Ctrl+Enter. The caller passes the already-
// gated submit action; it only runs when the shortcut fires and `canSubmit`.
function submitOnCmdEnter(
  event: KeyboardEvent,
  canSubmit: boolean,
  submit: () => void,
) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    if (canSubmit) submit();
  }
}
import {
  CaretDownIcon,
  CaretUpIcon,
  ChatCircleIcon,
  CheckIcon,
  CircleIcon,
  ClockCounterClockwiseIcon,
  DotsThreeVerticalIcon,
  LinkSimpleIcon,
  PaperPlaneTiltIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  layoutCommentLane,
  threadReactionEmoji,
  hasAgentMention,
  isAgentCommentAuthor,
  isOptimisticCommentId,
  findCommentMentionQuery,
  buildCommentMentionOptions,
  AGENT_MENTION_OPTION,
  type CommentMentionOption,
  type DraftDocCommentSelection,
  type DocCommentAuthor,
  type DocCommentMessage,
  type DocCommentThread,
} from '@/lib/workspace/doc-comments';
import { DEFAULT_SUNNY_AVATAR } from '@/lib/workspace/sunny-avatars';

// Grow a comment textarea to fit its content (Google-Docs style) instead of
// cropping a long comment behind a fixed 2-row box. Re-measures on every value
// change; CSS `max-h` + `overflow-y-auto` (on the element) cap it so one wall of
// text can't make the card unbounded.
function useAutoGrowTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

type CurrentUser = {
  name: string | null;
  imageUrl: string | null;
};

// Mentioning an agent in a comment is the whole summon trigger — the server links
// the thread to an agent chat and answers on it. The button only seeds the draft.
// Dragging a page selection over a card paints an (empty) textarea as one
// solid selected bar — a textarea selects whole, and user-select:none can't
// opt an editing host out. Transparent only while unfocused, so the user's
// own selection inside the box still highlights.
const commentTextareaClass =
  'max-h-[40vh] min-h-[40px] w-full resize-none overflow-y-auto bg-transparent text-[13px] leading-5 text-stone-800 outline-none [&:not(:focus)::selection]:bg-transparent placeholder:text-stone-500 disabled:cursor-not-allowed';

const AGENT_MENTION = `${AGENT_MENTION_OPTION.handle} `;
function withAgentMention(body: string) {
  return /^@(agent|sunny|claude|codex)\b/i.test(body.trimStart()) ? body : `${AGENT_MENTION}${body}`;
}

// Right-aligned pill on a thread's reply row that hands the thread to an agent.
// The new-comment composer has none — its footer is Cancel/Comment only (the
// pill crowded and clipped Comment); there, @agent is typed via autocomplete.
function DelegateToAgentButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      title="Tag @Agent so an agent answers on this thread"
      data-tour-id="delegate-pill"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border border-stone-200 px-2.5 py-1 text-[12px] font-medium text-stone-600 transition-colors hover:border-beige-300 hover:bg-beige-50 hover:text-beige-600"
    >
      <PaperPlaneTiltIcon className="h-4 w-4 shrink-0" weight="fill" aria-hidden />
      Delegate
    </button>
  );
}

// The @ autocomplete: typing "@" in a comment/reply offers the agent handle
// first, then the workspace's human collaborators. Without the agent row nobody
// discovers that a comment can be handed to an agent at all, so it is pinned to
// the top and carries a face + badge — never a product name, since users don't
// know who "Sunny" is and the engine behind the handle may be Claude or Codex.
function useMentionAutocomplete(
  value: string,
  setValue: (next: string) => void,
  ref: { current: HTMLTextAreaElement | null },
  people: readonly CommentMentionOption[] = [],
) {
  const [query, setQuery] = useState<{ start: number; text: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const options = useMemo(
    () => (query ? buildCommentMentionOptions(people, query.text) : []),
    [query, people],
  );
  const active = options.length > 0;

  // Re-derive the pending mention from the caret after every edit.
  const sync = (el: HTMLTextAreaElement) => {
    const next = findCommentMentionQuery(el.value, el.selectionStart ?? el.value.length);
    setQuery(next ? { start: next.start, text: next.query } : null);
    setHighlight(0);
  };

  const insert = (handle: string) => {
    if (!query) return;
    const tail = value.slice(query.start + 1 + query.text.length);
    // One space after the handle — never a second one when the tail has its own.
    const spacer = tail.startsWith(' ') ? '' : ' ';
    setValue(`${value.slice(0, query.start)}${handle}${spacer}${tail}`);
    setQuery(null);
    const caret = query.start + handle.length + spacer.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(caret, caret);
    });
  };

  // Returns true once it owns the keystroke, so the caller stops there.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && active) {
      event.preventDefault();
      setQuery(null);
      return true;
    }
    if (!active) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((current) => {
        const delta = event.key === 'ArrowDown' ? 1 : options.length - 1;
        return (current + delta) % options.length;
      });
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault();
      insert(options[Math.min(highlight, options.length - 1)].handle);
      return true;
    }
    return false;
  };

  return { options, highlight, setHighlight, sync, insert, onKeyDown, active };
}

function MentionMenu({
  options,
  highlight,
  onHighlight,
  onPick,
}: {
  options: readonly CommentMentionOption[];
  highlight: number;
  onHighlight: (index: number) => void;
  onPick: (handle: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Mention the agent or a collaborator"
      data-testid="comment-mention-menu"
      className="absolute left-2 top-full z-30 mt-1 w-72 rounded-xl border border-stone-200 bg-white py-1 shadow-[0_8px_24px_rgba(60,64,67,0.18)]"
    >
      {options.map((option, index) => (
        <button
          key={option.handle}
          type="button"
          role="option"
          aria-selected={index === highlight}
          data-handle={option.handle}
          data-agent={option.isAgent ? 'true' : undefined}
          onMouseEnter={() => onHighlight(index)}
          onMouseDown={(event) => {
            event.preventDefault(); // keep the textarea focused
            onPick(option.handle);
          }}
          onClick={(event) => event.stopPropagation()} // never re-open the card
          className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] ${
            index === highlight ? 'bg-beige-50' : ''
          }`}
        >
          {option.isAgent ? (
            <img
              src={DEFAULT_SUNNY_AVATAR}
              alt=""
              className="h-5 w-5 shrink-0 rounded-full object-cover ring-2 ring-beige-300"
            />
          ) : option.imageUrl ? (
            <img src={option.imageUrl} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[10px] font-medium text-stone-500">
              {option.handle[1]?.toUpperCase()}
            </span>
          )}
          <span className="shrink-0 whitespace-nowrap font-medium text-stone-800">{option.handle}</span>
          {/* The badge is what separates the one non-human row at a glance. */}
          {option.isAgent ? (
            <span className="shrink-0 rounded-full bg-beige-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-3 tracking-wide text-beige-600">
              Agent
            </span>
          ) : null}
          <span className="ml-auto min-w-0 truncate text-[11px] text-stone-400">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Which watch covers the open doc: a file-scoped one, a workspace-wide one,
 *  or none. The panel only reports it — watches are managed from the chat. */
type CommentWatchScope = 'doc' | 'workspace' | null;

/** Passive status pill: a chat is listening here. Deliberately not clickable —
 *  the doc header's "Agent watching" toggle owns starting and stopping it. */
function CommentWatchBadge() {
  return (
    <span
      data-testid="comment-watch-badge"
      title="The Agent replies to every comment here. Stop it from its chat's menu."
      className="inline-flex items-center gap-1 rounded-full bg-beige-50 px-2 py-0.5 text-[10px] leading-4 text-stone-500"
    >
      <CircleIcon className="h-2 w-2 text-beige-600" weight="fill" aria-hidden />
      agent watching
    </span>
  );
}

type CommentPanelMode = 'document' | 'workspace';

interface DocCommentsPanelProps {
  mode: CommentPanelMode;
  documentLabel: string | null;
  threads: DocCommentThread[];
  resolvedThreads?: DocCommentThread[];
  threadAnchorOffsets?: Record<string, number>;
  /** Ids (thread ids + '__draft__') a measurement pass has attempted for the
   *  current file. An offset-less card is hidden only while its id was never in
   *  a pass — after the pass that tried (and failed) it, it falls back to
   *  visible. Omitted (e.g. workspace mode) → nothing is hidden. */
  measuredAnchorIds?: ReadonlySet<string> | null;
  draftAnchorOffset?: number | null;
  activeThreadId: string | null;
  draftSelection: DraftDocCommentSelection | null;
  /** Seed text for the composer (non-empty after a failed optimistic create). */
  draftBody?: string;
  /** Set when an optimistic reply failed — re-seeds the matching reply box. */
  replyRestore?: { threadId: string; body: string; token: number } | null;
  currentUser: CurrentUser;
  currentUserId: string | null;
  canComment: boolean;
  /** Write capability driving Resolve + moderation-Delete. Pass a function of
   *  the thread's filePath so All-comments cards (which span files) each gate
   *  on their own file; a boolean applies uniformly. */
  canResolve: boolean | ((filePath: string) => boolean);
  loading?: boolean;
  error?: string | null;
  busyAction?: string | null;
  onModeChange: (mode: CommentPanelMode) => void;
  onSelectThread: (threadId: string | null) => void;
  onOpenWorkspaceThread: (thread: DocCommentThread) => void;
  /** Switch the workspace to the agent chat linked to a thread. */
  onOpenThreadChat?: (chatId: string) => void;
  /** Live run state for a linked chat: 'working' | 'idle', or null when
   *  unknown (then the reply-derived fallback applies). Idle overrides the
   *  fallback — engines like Codex answer only in the chat, never on the
   *  thread, and would otherwise read as working forever. */
  chatActivity?: (chatId: string) => 'working' | 'answering' | 'idle' | null;
  /** Watch state for the OPEN doc. Non-null renders the passive badge in the
   *  All-comments header (the document lane carries no header). */
  commentWatchScope?: CommentWatchScope;
  /** Workspace collaborators offered by the composer's `@` menu, below the
   *  always-first agent row. Exclude the current user — you don't tag yourself. */
  mentionPeople?: readonly CommentMentionOption[];
  onClose: () => void;
  onCreateComment: (body: string) => Promise<void> | void;
  onCancelDraft: () => void;
  onReply: (threadId: string, body: string) => Promise<void> | void;
  onResolve: (threadId: string) => Promise<void> | void;
  onReopen: (threadId: string) => Promise<void> | void;
  onEditMessage: (thread: DocCommentThread, messageId: string, body: string) => Promise<void> | void;
  onDeleteMessage: (thread: DocCommentThread, messageId: string) => Promise<void> | void;
  onCopyMessageLink: (thread: DocCommentThread, messageId: string) => Promise<void> | void;
}

// Cards float on the page white (no gray lane field), so they carry a real
// elevation shadow — the new-Google-Docs look.
const COMMENT_CARD_CLASS =
  'rounded-2xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(60,64,67,0.2),0_2px_6px_2px_rgba(60,64,67,0.1)]';
const COMMENT_MENU_WIDTH = 220;
const COMMENT_LANE_GAP = 12;

function formatCommentTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (date.toDateString() === new Date().toDateString()) {
    return `${time} Today`;
  }
  const day = date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
  return `${time} · ${day}`;
}

function getInitials(name: string | null | undefined) {
  const source = name?.trim() || 'U';
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function getWorkspaceThreadHeading(thread: DocCommentThread) {
  const fileName = thread.filePath.split('/').pop() ?? thread.filePath;
  const label = fileName.replace(/\.[^.]+$/, '').trim() || thread.filePath;
  return thread.quote ? `${label} · ${thread.quote}` : label;
}

function Avatar({
  author,
  size = 'md',
}: {
  author: CurrentUser | DocCommentAuthor;
  size?: 'sm' | 'md';
}) {
  const className = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-7 w-7 text-[11px]';
  if (author.imageUrl) {
    return (
      <img
        src={author.imageUrl}
        alt=""
        className={`${className} rounded-full object-cover`}
      />
    );
  }
  return (
    <div
      className={`${className} inline-flex items-center justify-center rounded-full bg-beige-200 font-medium text-beige-500`}
    >
      {getInitials(author.name)}
    </div>
  );
}

function ActionButton({
  label,
  children,
  onClick,
  disabled = false,
  active = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'bg-beige-200 text-beige-600'
          : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'
      }`}
    >
      {children}
    </button>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-1.5 py-2 text-[12px] font-medium transition-colors ${
        active ? 'text-beige-500' : 'text-stone-500 hover:text-stone-800'
      }`}
    >
      {children}
      {active ? (
        <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-t-full bg-beige-400" />
      ) : null}
    </button>
  );
}

function MenuItem({
  children,
  onClick,
  disabled = false,
  destructive = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] leading-5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        destructive
          ? 'text-red-700 hover:bg-red-50'
          : 'text-stone-800 hover:bg-stone-100'
      }`}
    >
      {children}
    </button>
  );
}

export function CommentComposer({
  currentUser,
  draftSelection,
  initialBody = '',
  canComment,
  busy,
  mentionPeople = [],
  onSubmit,
  onCancel,
}: {
  currentUser: CurrentUser;
  draftSelection: DraftDocCommentSelection | null;
  /** Seed text — non-empty when a failed create handed the draft back. */
  initialBody?: string;
  canComment: boolean;
  busy: boolean;
  /** Human collaborators for the `@` menu; the agent row is added on top. */
  mentionPeople?: readonly CommentMentionOption[];
  onSubmit: (body: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const textareaRef = useAutoGrowTextarea(body);
  const trimmedBody = body.trim();
  const mention = useMentionAutocomplete(body, setBody, textareaRef, mentionPeople);

  useEffect(() => {
    setBody(initialBody);
    // Re-seed only when the anchored selection changes — typing must not reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSelection?.quote]);

  useEffect(() => {
    if (!draftSelection) return;
    requestAnimationFrame(() => {
      // `preventScroll` is required: a bare focus() scrolls the textarea into
      // view, and because the comment composer sits in the editor's scroll
      // container the browser yanks the document back to the top (fix #14).
      textareaRef.current?.focus({ preventScroll: true });
    });
  }, [draftSelection]);

  if (!draftSelection) return null;

  return (
    <div className={`${COMMENT_CARD_CLASS} px-4 pb-3 pt-3`}>
      <div className="flex items-start gap-2.5">
        <Avatar author={currentUser} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-5 text-stone-800">
            {currentUser.name?.trim() || 'You'}
          </div>
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                mention.sync(event.target);
              }}
              onKeyDown={(event) => {
                if (mention.onKeyDown(event)) return;
                submitOnCmdEnter(event, canComment && !busy && trimmedBody.length > 0, () =>
                  void onSubmit(trimmedBody),
                );
              }}
              placeholder="Comment, or tag @Agent to get a reply"
              data-tour-id="comment-draft-input"
              rows={2}
              disabled={!canComment || busy}
              className="mt-2 max-h-[40vh] min-h-[44px] w-full resize-none overflow-y-auto rounded-xl border-2 border-beige-400 bg-white px-3 py-2 text-[13px] leading-5 text-stone-800 outline-none transition-shadow [&:not(:focus)::selection]:bg-transparent placeholder:text-stone-500 focus:shadow-[0_0_0_1px_var(--beige-dark)] disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-50 disabled:text-stone-500"
            />
            <MentionMenu
              options={mention.options}
              highlight={mention.highlight}
              onHighlight={mention.setHighlight}
              onPick={mention.insert}
            />
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="shrink-0 rounded-full px-2 py-1 text-[12px] font-medium text-beige-500 transition-colors hover:bg-stone-100 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              data-tour-id="comment-draft-post"
              onClick={() => void onSubmit(trimmedBody)}
              disabled={!canComment || busy || trimmedBody.length === 0}
              className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                !canComment || busy || trimmedBody.length === 0
                  ? 'bg-stone-100 text-stone-400'
                  : 'bg-beige-200 text-beige-600 hover:bg-beige-300'
              }`}
            >
              Comment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Long comments get clamped to a few lines with a Show more / Show less toggle,
// like Google Docs — so one wall-of-text reply can't push the whole lane around.
const COMMENT_BODY_CLAMP_LINES = 6;

function CollapsibleBody({ body }: { body: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return; // only measurable while clamped
    setOverflowing(el.scrollHeight - el.clientHeight > 4);
  }, [body, expanded]);

  return (
    <div className="mt-2">
      <p
        ref={ref}
        className="whitespace-pre-wrap text-[13px] leading-5 text-stone-700"
        style={
          expanded
            ? undefined
            : {
                display: '-webkit-box',
                WebkitLineClamp: COMMENT_BODY_CLAMP_LINES,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        {body}
      </p>
      {overflowing ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
          className="mt-0.5 text-[12px] font-medium text-beige-500 transition-colors hover:text-beige-600"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

export function ThreadMessageRow({
  thread,
  message,
  currentUserId,
  showResolve,
  isResolved,
  resolveBusy,
  canResolve,
  busyAction,
  onResolve,
  onReopen,
  onEditMessage,
  onDeleteMessage,
  onCopyMessageLink,
  isNew = false,
}: {
  thread: DocCommentThread;
  message: DocCommentMessage;
  currentUserId: string | null;
  showResolve: boolean;
  isResolved: boolean;
  resolveBusy: boolean;
  canResolve: boolean;
  busyAction: string | null;
  onResolve: () => Promise<void> | void;
  onReopen: () => Promise<void> | void;
  onEditMessage: (thread: DocCommentThread, messageId: string, body: string) => Promise<void> | void;
  onDeleteMessage: (thread: DocCommentThread, messageId: string) => Promise<void> | void;
  onCopyMessageLink: (thread: DocCommentThread, messageId: string) => Promise<void> | void;
  /** A reply that arrived while the thread was open (e.g. an agent reply) —
   *  fades + rises gently into place instead of appearing blankly. */
  isNew?: boolean;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(message.body);
  const editRef = useAutoGrowTextarea(draftBody);
  const isOwnMessage = Boolean(currentUserId && currentUserId === message.author.userId);
  const isFirstMessage = thread.messages[0]?.id === message.id;
  const isEditBusy = busyAction === `edit:${message.id}`;
  const isDeleteBusy = busyAction === `delete:${message.id}`;
  // Edit/Delete/Copy-link all key off the thread/message id; while either is
  // still an optimistic placeholder those would hit the API with a temp id
  // (404) or copy a dead link, so the whole action cluster is hidden until the
  // server id arrives (covers a pending reply inside an otherwise real thread).
  const actionsDisabled = isOptimisticCommentId(thread.id) || isOptimisticCommentId(message.id);
  const canEdit = isOwnMessage && !actionsDisabled;
  // `canResolve` carries the per-file write capability (the UI mirror of the
  // server's canWritePath), which also moderates: writers delete any message,
  // including agent-authored ones. Editing stays author-only.
  const canDelete = (isOwnMessage || canResolve) && !actionsDisabled;
  const trimmedDraftBody = draftBody.trim();
  const deleteLabel = isFirstMessage && thread.messages.length > 1 ? 'Delete thread' : 'Delete';

  useEffect(() => {
    setDraftBody(message.body);
  }, [message.body]);

  useEffect(() => {
    if (!menuOpen) return;
    const updateMenuPosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const estimatedHeight = 176;
      const left = Math.min(
        window.innerWidth - COMMENT_MENU_WIDTH - 12,
        Math.max(12, rect.right - COMMENT_MENU_WIDTH),
      );
      const top =
        rect.bottom + estimatedHeight <= window.innerHeight - 12
          ? rect.bottom + 8
          : Math.max(12, rect.top - estimatedHeight - 8);
      setMenuPosition({ left, top });
    };

    updateMenuPosition();

    const handlePointerDown = (event: MouseEvent | globalThis.MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (anchorRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    const handleResize = () => updateMenuPosition();
    const handleScroll = () => {
      if (!menuOpen) return;
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) {
        setMenuOpen(false);
        return;
      }
      updateMenuPosition();
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [menuOpen]);

  const handleSaveEdit = async () => {
    if (!canEdit || trimmedDraftBody.length === 0 || trimmedDraftBody === message.body.trim()) {
      setIsEditing(false);
      return;
    }
    await onEditMessage(thread, message.id, trimmedDraftBody);
    setIsEditing(false);
    setMenuOpen(false);
  };

  const handleDelete = async () => {
    await onDeleteMessage(thread, message.id);
    setMenuOpen(false);
  };

  const handleCopyLink = async () => {
    await onCopyMessageLink(thread, message.id);
    setMenuOpen(false);
  };

  return (
    <div className={`flex items-start gap-2.5${isNew ? ' comment-message-enter' : ''}`}>
      <Avatar author={message.author} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium leading-5 text-stone-800">
              {/* Nameless own messages read 'You' — the same word the composer
                  falls back to — so an identity-less author doesn't change
                  labels the instant the comment posts. */}
              {message.author.name?.trim() || message.author.username || (isOwnMessage ? 'You' : 'Collaborator')}
            </div>
            <div className="text-[11px] leading-4 text-stone-500">
              {formatCommentTime(message.createdAt)}
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            {showResolve && canResolve ? (
              <ActionButton
                label={isResolved ? 'Reopen comment' : 'Resolve comment'}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isResolved) {
                    void onReopen();
                  } else {
                    void onResolve();
                  }
                }}
                disabled={resolveBusy}
              >
                {isResolved ? (
                  <ClockCounterClockwiseIcon className="h-3.5 w-3.5 text-beige-500" weight="bold" />
                ) : (
                  <CheckIcon className="h-3.5 w-3.5 text-beige-500" weight="bold" />
                )}
              </ActionButton>
            ) : null}
            {actionsDisabled ? null : (
              <>
            <ActionButton
              label="Copy comment link"
              onClick={(event) => {
                event.stopPropagation();
                void handleCopyLink();
              }}
            >
              <LinkSimpleIcon className="h-3.5 w-3.5" weight="bold" />
            </ActionButton>
            <div
              ref={anchorRef}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <ActionButton
                label="Comment options"
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen((current) => !current);
                }}
                disabled={isEditBusy || isDeleteBusy}
                active={menuOpen}
              >
                <DotsThreeVerticalIcon className="h-3.5 w-3.5" weight="bold" />
              </ActionButton>
              {menuOpen && menuPosition && typeof document !== 'undefined'
                ? createPortal(
                    <div
                      ref={menuRef}
                      className="fixed z-[80] min-w-[220px] rounded-xl border border-stone-200 bg-white py-1.5 shadow-[0_8px_24px_rgba(60,64,67,0.18)]"
                      style={{
                        left: menuPosition.left,
                        top: menuPosition.top,
                        width: COMMENT_MENU_WIDTH,
                      }}
                    >
                      {canEdit ? (
                        <MenuItem
                          onClick={() => {
                            setDraftBody(message.body);
                            setIsEditing(true);
                            setMenuOpen(false);
                          }}
                        >
                          Edit
                        </MenuItem>
                      ) : null}
                      {canDelete ? (
                        <MenuItem
                          onClick={() => void handleDelete()}
                          disabled={isDeleteBusy}
                          destructive
                        >
                          {deleteLabel}
                        </MenuItem>
                      ) : null}
                      <MenuItem onClick={() => void handleCopyLink()}>
                        Copy comment link
                      </MenuItem>
                    </div>,
                    document.body,
                  )
                : null}
            </div>
              </>
            )}
          </div>
        </div>
        {isEditing ? (
          <div className="mt-2" onClick={(event) => event.stopPropagation()}>
            <div className="rounded-xl border border-stone-400 bg-white px-3 py-2 transition-colors focus-within:border-beige-400">
              <textarea
                ref={editRef}
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
                onKeyDown={(event) =>
                  submitOnCmdEnter(event, !isEditBusy && trimmedDraftBody.length > 0, () =>
                    void handleSaveEdit(),
                  )
                }
                rows={2}
                disabled={isEditBusy}
                className={commentTextareaClass}
              />
            </div>
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraftBody(message.body);
                  setIsEditing(false);
                }}
                disabled={isEditBusy}
                className="rounded-full px-2 py-1 text-[12px] font-medium text-beige-500 transition-colors hover:bg-stone-100 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSaveEdit()}
                disabled={isEditBusy || trimmedDraftBody.length === 0}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                  isEditBusy || trimmedDraftBody.length === 0
                    ? 'bg-stone-100 text-stone-400'
                    : 'bg-beige-200 text-beige-600 hover:bg-beige-300'
                }`}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <CollapsibleBody body={message.body} />
        )}
      </div>
    </div>
  );
}

/** Claim checks are comment threads, not a second inline-result system. This
 * card only changes how that typed thread is summarized in the lane; anchoring,
 * realtime, chat navigation, and persistence all remain the comment path. */
function ClaimVerificationThreadCard({
  thread,
  active,
  mode,
  chatActivity,
  onOpen,
  onOpenThreadChat,
}: {
  thread: DocCommentThread;
  active: boolean;
  mode: CommentPanelMode;
  chatActivity?: (chatId: string) => 'working' | 'answering' | 'idle' | null;
  onOpen: () => void;
  onOpenThreadChat?: (chatId: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const agentMessage = [...thread.messages]
    .reverse()
    .find((message) => isAgentCommentAuthor(message.author));
  const activity = thread.chatId ? chatActivity?.(thread.chatId) ?? null : null;
  const working =
    !agentMessage &&
    (isOptimisticCommentId(thread.id) ||
      !thread.chatId ||
      activity === 'working' ||
      activity === 'answering');
  const verdict = extractSelectionActionSummary(agentMessage?.body);
  const detailsId = `claim-verification-details-${thread.id}`;
  const statusId = `claim-verification-status-${thread.id}`;

  return (
    <article
      data-testid="claim-verification-thread-card"
      data-phase={working ? 'working' : verdict ? 'complete' : 'idle'}
      className={`${COMMENT_CARD_CLASS} w-full px-4 py-3 text-left ${
        active && mode === 'document' ? 'border-beige-200 bg-beige-50' : ''
      } ${thread.status === 'resolved' ? 'opacity-80' : ''} ${
        working ? 'comment-thread-working border-beige-300' : ''
      }`}
    >
      <div className="flex items-start gap-2.5">
        <Avatar author={{ name: 'Claim Verifier', imageUrl: null }} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            data-testid="claim-verification-select"
            aria-label="Select Claim Verifier comment"
            aria-describedby={statusId}
            onClick={onOpen}
            className="block w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beige-300"
          >
            <span className="block truncate text-[13px] font-medium leading-5 text-stone-800">
              Claim Verifier
            </span>
          </button>

          <div
            id={statusId}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="claim-verification-live-region"
            className="mt-2"
          >
            {working ? (
              <span
                data-testid="claim-verification-status"
                className="flex items-center gap-2 text-[12px] leading-5 text-stone-500"
              >
                <span
                  className="comment-agent-dot h-1.5 w-1.5 shrink-0 rounded-full bg-beige-500"
                  aria-hidden
                />
                Claim Verifier Working
              </span>
            ) : verdict ? (
              <span
                data-testid="claim-verification-verdict"
                title={verdict}
                className="block line-clamp-2 break-words text-[13px] leading-5 text-stone-700"
              >
                {verdict}
              </span>
            ) : (
              <span
                data-testid="claim-verification-status"
                className="block text-[12px] leading-5 text-stone-500"
              >
                Verification stopped
              </span>
            )}
          </div>

          <div className="mt-2 flex items-center gap-1">
            <button
              type="button"
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              onClick={(event) => {
                event.stopPropagation();
                setDetailsOpen((open) => !open);
              }}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
            >
              Details
              {detailsOpen ? (
                <CaretUpIcon className="h-3 w-3" weight="bold" aria-hidden />
              ) : (
                <CaretDownIcon className="h-3 w-3" weight="bold" aria-hidden />
              )}
            </button>
            {thread.chatId ? (
              <button
                type="button"
                data-testid="claim-verification-open-thread"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenThreadChat?.(thread.chatId!);
                }}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
              >
                <ChatCircleIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
                Open thread
              </button>
            ) : null}
          </div>

          <div
            id={detailsId}
            data-testid="claim-verification-details"
            hidden={!detailsOpen}
            className="mt-2 border-t border-stone-100 pt-2"
          >
            <div className="text-[10px] font-medium uppercase tracking-wide text-stone-400">
              Claim
            </div>
            <p
              data-testid="claim-verification-quote"
              className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-stone-600"
            >
              {thread.quote}
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

function ThreadCard({
  mode,
  thread,
  active,
  currentUserId,
  canComment,
  canResolve,
  busyAction,
  onSelect,
  onOpenWorkspaceThread,
  onOpenThreadChat,
  chatActivity,
  watched = false,
  mentionPeople = [],
  onReply,
  onResolve,
  onReopen,
  onEditMessage,
  onDeleteMessage,
  onCopyMessageLink,
  replyRestore,
}: {
  mode: CommentPanelMode;
  thread: DocCommentThread;
  active: boolean;
  /** A chat already watches this doc, so every comment reaches an agent
   *  anyway — the Delegate pill would only be noise. */
  watched?: boolean;
  currentUserId: string | null;
  canComment: boolean;
  canResolve: boolean;
  busyAction: string | null;
  onSelect: () => void;
  onOpenWorkspaceThread: (thread: DocCommentThread) => void;
  onOpenThreadChat?: (chatId: string) => void;
  /** Live run state for a linked chat: 'working' | 'idle', or null when
   *  unknown (then the reply-derived fallback applies). Idle overrides the
   *  fallback — engines like Codex answer only in the chat, never on the
   *  thread, and would otherwise read as working forever. */
  chatActivity?: (chatId: string) => 'working' | 'answering' | 'idle' | null;
  /** Human collaborators for the `@` menu; the agent row is added on top. */
  mentionPeople?: readonly CommentMentionOption[];
  onReply: (body: string) => Promise<void> | void;
  /** Set when an optimistic reply to this thread failed — re-seed the box. */
  replyRestore?: { threadId: string; body: string; token: number } | null;
  onResolve: () => Promise<void> | void;
  onReopen: () => Promise<void> | void;
  onEditMessage: (thread: DocCommentThread, messageId: string, body: string) => Promise<void> | void;
  onDeleteMessage: (thread: DocCommentThread, messageId: string) => Promise<void> | void;
  onCopyMessageLink: (thread: DocCommentThread, messageId: string) => Promise<void> | void;
}) {
  const [replyBody, setReplyBody] = useState('');
  const replyRef = useAutoGrowTextarea(replyBody);
  const replyMention = useMentionAutocomplete(replyBody, setReplyBody, replyRef, mentionPeople);
  const isResolveBusy = busyAction === `resolve:${thread.id}` || busyAction === `reopen:${thread.id}`;
  const isReplyBusy = busyAction === `reply:${thread.id}`;
  const latestMessage = thread.messages[thread.messages.length - 1] ?? null;
  // Messages present when this card first mounted don't animate (opening a thread
  // shouldn't replay every bubble); only replies that land afterwards — an agent
  // answering a review comment, a teammate replying — fade in.
  const initialMessageIdsRef = useRef<Set<string>>(new Set(thread.messages.map((m) => m.id)));
  // Workspace mode is a cross-doc index — show just the latest message per
  // thread. In the document lane show the whole conversation so earlier
  // comments are never hidden; only the reply box is gated on `active`.
  const visibleMessages =
    mode === 'workspace' ? (latestMessage ? [latestMessage] : []) : thread.messages;
  const showReplyActions = replyBody.trim().length > 0 || isReplyBusy;
  // While the thread is still an optimistic placeholder, reply/resolve would hit
  // the API with the temp id (404). Hide those actions until it reconciles.
  const isOptimistic = isOptimisticCommentId(thread.id);
  // Set once someone mentioned an agent on the thread — its dedicated chat.
  const agentChatId = thread.chatId ?? null;
  // Delegated is wider than "linked": the server mints the thread's chat AFTER
  // the POST responds, so a just-posted @agent comment has no chatId for a beat
  // — keying the pill only off chatId flashed Delegate on a thread that was
  // already handed off. Pending (optimistic/in-flight) posts count too.
  const agentDelegated =
    Boolean(agentChatId) ||
    isReplyBusy ||
    thread.messages.some((m) => isOptimisticCommentId(m.id) || hasAgentMention(m.body));
  // Live run state wins when known; otherwise fall back to "linked + the last
  // word is still a human's". Clearing the badge the moment the run stopped
  // being live hid the agent well before its answer: a triggered turn ALWAYS
  // ends with a reply (or its error) ON THE THREAD, and that lands AFTER the
  // run settles — and across the retry gaps in between, where it is briefly
  // not live at all. 'answering' is exactly that window (the sidecar's shared
  // per-chat state, so every watcher agrees), and it ends when the answer
  // lands. A run that was stopped, never started, or is already done owes
  // nothing, so it reports 'idle' and the badge clears as it always did.
  const activity = agentChatId ? chatActivity?.(agentChatId) ?? null : null;
  const answered = Boolean(latestMessage && isAgentCommentAuthor(latestMessage.author));
  const agentWorking =
    Boolean(agentChatId) &&
    (activity === 'working' || (!answered && (activity === 'answering' || activity === null)));
  // The seconds between "Reply" and the minted chat link landing used to show
  // NOTHING — a summon that looks ignored. A fresh human @Agent message with
  // no chat yet is that startup window; freshness-capped so a run that never
  // starts (brain down) can't pin "starting" to the thread forever.
  const latestSummonAt =
    latestMessage && !isAgentCommentAuthor(latestMessage.author) && hasAgentMention(latestMessage.body)
      ? Date.parse(latestMessage.createdAt)
      : null;
  const [startupNow, setStartupNow] = useState(() => Date.now());
  const summonFresh =
    latestSummonAt !== null && Number.isFinite(latestSummonAt) && startupNow - latestSummonAt < 90_000;
  const agentStarting = !agentChatId && summonFresh;
  useEffect(() => {
    // Tick only while the indicator could be showing, so it ages out even if
    // nothing else re-renders the lane.
    if (!agentStarting) return;
    const interval = window.setInterval(() => setStartupNow(Date.now()), 10_000);
    return () => window.clearInterval(interval);
  }, [agentStarting]);

  // Re-seed the reply box if an optimistic reply to this thread failed (the box
  // is cleared on submit for an instant feel, so the text would otherwise be lost).
  useEffect(() => {
    if (replyRestore && replyRestore.threadId === thread.id) setReplyBody(replyRestore.body);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyRestore?.token]);

  const submitReply = () => {
    const text = replyBody.trim();
    if (!text || isReplyBusy) return;
    setReplyBody(''); // clear instantly; the reply renders optimistically
    void onReply(text);
  };

  const handleOpen = () => {
    if (mode === 'workspace') {
      onOpenWorkspaceThread(thread);
      return;
    }
    onSelect();
  };

  if (thread.kind === 'claim_verification') {
    return (
      <ClaimVerificationThreadCard
        thread={thread}
        active={active}
        mode={mode}
        chatActivity={chatActivity}
        onOpen={handleOpen}
        onOpenThreadChat={onOpenThreadChat}
      />
    );
  }

  // An emoji reaction is a comment thread with a single one-emoji message. The
  // emoji lives ONLY here — in the margin, at its anchor's height, Google-Docs
  // style — never inline in the document. It rides the same lane as the comment
  // cards (same list, same anchor-offset layout), so a doc with both shows
  // both; a reaction is just a small pill instead of a card, so it can sit next
  // to comments without competing with them. Replying makes it an ordinary
  // thread, `threadReactionEmoji` stops matching, and it renders as a card again.
  const reaction = threadReactionEmoji(thread);
  if (reaction && latestMessage) {
    const canRemove = (Boolean(currentUserId && currentUserId === latestMessage.author.userId) || canResolve) && !isOptimistic;
    const who = latestMessage.author.name?.trim() || latestMessage.author.username || 'Collaborator';
    // Accepting a reaction IS resolving its thread: it leaves the open lane and
    // joins the resolved set, exactly like a comment (and the resolved section
    // renders it through this same branch, so it stays a pill there). Gated on
    // `canResolve` like the card's own resolve, and always shown rather than
    // only on the active pill — a two-icon pill has no clutter to protect, and
    // hiding the checkmark behind a click is the opposite of "close it".
    const showAccept = mode === 'document' && canResolve && !isOptimistic;
    const isResolved = thread.status === 'resolved';
    return (
      <div
        role="button"
        tabIndex={0}
        data-testid="comment-reaction-row"
        // Explicit: without it the accessible name is computed from the
        // contents, which swallows the Remove button's own label. The quote
        // lives here rather than on screen — a pill wide enough to show it
        // would be a card again.
        aria-label={`${reaction} reaction by ${who} on “${thread.quote}”`}
        title={`${who} reacted ${reaction} on “${thread.quote}”`}
        onClick={handleOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleOpen();
          }
        }}
        // `w-fit`, not `w-full`: the pill hugs its content so the lane still
        // reads as comments-with-reactions-beside-them, not a stack of cards.
        className={`${COMMENT_CARD_CLASS} flex w-fit max-w-full items-center gap-1.5 rounded-full py-1 pl-2.5 text-left ${
          canRemove || showAccept ? 'pr-1' : 'pr-2.5'
        } ${isResolved ? 'opacity-80' : ''} ${
          active && mode === 'document' ? 'border-beige-200 bg-beige-50' : ''
        }`}
      >
        <span className="text-[15px] leading-none" aria-hidden>
          {reaction}
        </span>
        <span className="min-w-0 truncate text-[12px] leading-5 text-stone-600">{who}</span>
        {showAccept ? (
          <ActionButton
            label={isResolved ? 'Reopen reaction' : 'Resolve reaction'}
            disabled={isResolveBusy}
            onClick={(event) => {
              event.stopPropagation();
              if (isResolved) {
                void onReopen();
              } else {
                void onResolve();
              }
            }}
          >
            {isResolved ? (
              <ClockCounterClockwiseIcon className="h-3.5 w-3.5 text-beige-500" weight="bold" />
            ) : (
              <CheckIcon className="h-3.5 w-3.5 text-beige-500" weight="bold" />
            )}
          </ActionButton>
        ) : null}
        {canRemove ? (
          <ActionButton
            label="Remove reaction"
            disabled={busyAction === `delete:${latestMessage.id}`}
            onClick={(event) => {
              event.stopPropagation();
              void onDeleteMessage(thread, latestMessage.id);
            }}
          >
            <TrashIcon className="h-3.5 w-3.5" weight="bold" />
          </ActionButton>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(event) => {
        // Only treat Enter/Space as "open thread" when the card itself is
        // focused. Otherwise the keystroke bubbles up from the reply/edit
        // textarea and we'd swallow the Space (can't type a space) and Enter
        // (can't add a newline) — the "can't press space in a comment" bug.
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleOpen();
        }
      }}
      className={`${COMMENT_CARD_CLASS} w-full px-4 py-3 text-left ${
        active && mode === 'document'
          ? 'border-beige-200 bg-beige-50'
          : ''
      } ${thread.status === 'resolved' ? 'opacity-80' : ''} ${
        agentWorking ? 'comment-thread-working border-beige-300' : ''
      }`}
    >
      <div className="space-y-3">
        {mode === 'workspace' ? (
          <div className="flex items-start justify-between gap-2">
            <p className="text-[12px] leading-5 text-stone-700">
              {getWorkspaceThreadHeading(thread)}
            </p>
            <CaretUpIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500" weight="bold" />
          </div>
        ) : null}

        {visibleMessages.map((message, index) => (
          <ThreadMessageRow
            key={message.id}
            thread={thread}
            message={message}
            isNew={!initialMessageIdsRef.current.has(message.id)}
            currentUserId={currentUserId}
            showResolve={mode === 'document' && active && index === 0 && !isOptimistic}
            isResolved={thread.status === 'resolved'}
            resolveBusy={isResolveBusy}
            canResolve={canResolve}
            busyAction={busyAction}
            onResolve={onResolve}
            onReopen={onReopen}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
            onCopyMessageLink={onCopyMessageLink}
          />
        ))}

        {agentChatId || agentStarting ? (
          <div className="flex items-center gap-2 text-[11px] leading-4 text-stone-500">
            {agentWorking || agentStarting ? (
              <>
                <span className="comment-agent-dot h-1.5 w-1.5 shrink-0 rounded-full bg-beige-500" aria-hidden />
                <span className="truncate">{agentStarting ? 'Agent is starting' : 'Agent is working'}</span>
              </>
            ) : null}
            {agentChatId ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenThreadChat?.(agentChatId);
                }}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
              >
                <ChatCircleIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
                Open chat
              </button>
            ) : null}
          </div>
        ) : null}

        {mode === 'document' && active && canComment && thread.status === 'open' && !isOptimistic ? (
          <div>
            <div className="relative">
              <div className="rounded-xl border border-stone-400 bg-white px-3 py-2 transition-colors focus-within:border-beige-400">
                <textarea
                  ref={replyRef}
                  value={replyBody}
                  onChange={(event) => {
                    setReplyBody(event.target.value);
                    replyMention.sync(event.target);
                  }}
                  onKeyDown={(event) => {
                    if (replyMention.onKeyDown(event)) return;
                    submitOnCmdEnter(event, !isReplyBusy && replyBody.trim().length > 0, submitReply);
                  }}
                  rows={2}
                  placeholder="Reply, or tag @Agent to get a reply"
                  disabled={isReplyBusy}
                  className={commentTextareaClass}
                />
              </div>
              <MentionMenu
                options={replyMention.options}
                highlight={replyMention.highlight}
                onHighlight={replyMention.setHighlight}
                onPick={replyMention.insert}
              />
            </div>
            <div className="mt-2 flex items-center justify-end gap-2">
              {/* Once the thread is delegated — a linked chat, or a mention
                  whose link is still landing — a second Delegate is noise. So
                  is one on a watched doc: the watching chat already gets every
                  comment here. */}
              {agentDelegated || watched ? null : (
                <DelegateToAgentButton
                  onClick={() => {
                    setReplyBody(withAgentMention(replyBody));
                    replyRef.current?.focus({ preventScroll: true });
                  }}
                />
              )}
              {showReplyActions ? (
                <>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setReplyBody('');
                    }}
                    disabled={isReplyBusy}
                    className="shrink-0 rounded-full px-2 py-1 text-[12px] font-medium text-beige-500 transition-colors hover:bg-stone-100 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-tour-id="reply-send"
                    onClick={(event) => {
                      event.stopPropagation();
                      submitReply();
                    }}
                    disabled={isReplyBusy || replyBody.trim().length === 0}
                    className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                      isReplyBusy || replyBody.trim().length === 0
                        ? 'bg-stone-100 text-stone-400'
                        : 'bg-beige-200 text-beige-600 hover:bg-beige-300'
                    }`}
                  >
                    Reply
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DocCommentsPanel({
  mode,
  documentLabel,
  threads,
  resolvedThreads = [],
  threadAnchorOffsets = {},
  measuredAnchorIds = null,
  draftAnchorOffset = null,
  activeThreadId,
  draftSelection,
  draftBody = '',
  replyRestore = null,
  currentUser,
  currentUserId,
  canComment,
  canResolve,
  loading = false,
  error = null,
  busyAction = null,
  onModeChange,
  onSelectThread,
  onOpenWorkspaceThread,
  onOpenThreadChat,
  chatActivity,
  commentWatchScope = null,
  mentionPeople = [],
  onClose,
  onCreateComment,
  onCancelDraft,
  onReply,
  onResolve,
  onReopen,
  onEditMessage,
  onDeleteMessage,
  onCopyMessageLink,
}: DocCommentsPanelProps) {
  const canResolvePath = (filePath: string) =>
    typeof canResolve === 'function' ? canResolve(filePath) : canResolve;
  const showWorkspaceHeader = mode === 'workspace';
  const [showResolved, setShowResolved] = useState(false);
  const visibleThreads = useMemo(
    () => threads.filter((thread) => thread.status === 'open'),
    [threads],
  );
  const orderedThreads = useMemo(() => {
    if (mode === 'workspace') {
      return visibleThreads;
    }
    return [...visibleThreads].sort((left, right) => {
      const leftOffset = threadAnchorOffsets[left.id];
      const rightOffset = threadAnchorOffsets[right.id];
      if (leftOffset !== undefined && rightOffset !== undefined && leftOffset !== rightOffset) {
        return leftOffset - rightOffset;
      }
      if (leftOffset !== undefined && rightOffset === undefined) return -1;
      if (leftOffset === undefined && rightOffset !== undefined) return 1;
      if (left.id === activeThreadId) return -1;
      if (right.id === activeThreadId) return 1;
      return Date.parse(left.createdAt) - Date.parse(right.createdAt);
    });
  }, [activeThreadId, mode, threadAnchorOffsets, visibleThreads]);
  // Resolved-only document lane: this state is only ever on screen when the
  // user explicitly opened comments on a doc whose threads are all resolved
  // (resolving the last open thread auto-releases the lane — see the
  // workspace-comments hook). So show the resolved cards outright, with no
  // Show/Hide toggle: a toggle would leave a mostly-empty 320px column in its
  // hidden state (Sean's dead-column report).
  const resolvedOnly = mode === 'document' && !draftSelection && orderedThreads.length === 0;
  // Lane layout is keyed by the stable clientKey (falls back to id), so an
  // optimistic comment reconciling to its persisted id doesn't reset its
  // measured position for a frame and re-slide. Offsets stay keyed by the real
  // thread id (that's what the editor reports), only the *layout identity* is
  // stabilized.
  const laneKeyOf = (thread: DocCommentThread) => thread.clientKey ?? thread.id;
  const docLaneItems = useMemo(
    () =>
      [
        ...(draftSelection ? [{ key: '__draft__', desiredTop: draftAnchorOffset ?? 0 }] : []),
        ...orderedThreads.map((thread) => ({
          key: laneKeyOf(thread),
          desiredTop: threadAnchorOffsets[thread.id] ?? 0,
        })),
      ].sort((left, right) => left.desiredTop - right.desiredTop),
    [draftAnchorOffset, draftSelection, orderedThreads, threadAnchorOffsets],
  );
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [docLaneTops, setDocLaneTops] = useState<Record<string, number>>({});
  const [docLaneHeight, setDocLaneHeight] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  // The focused card pins to its line and the rest flow around it. Only treat a
  // thread/draft as the focus once its anchor offset is measured, otherwise we'd
  // briefly pin it at 0 and jolt the lane.
  const activeLaneKey = activeThreadId
    ? laneKeyOf(orderedThreads.find((thread) => thread.id === activeThreadId) ?? ({ id: activeThreadId } as DocCommentThread))
    : null;
  const focusKey =
    draftSelection && draftAnchorOffset != null
      ? '__draft__'
      : activeThreadId && threadAnchorOffsets[activeThreadId] != null
        ? activeLaneKey
        : null;
  // Cards never animate `top` — every relayout snaps. The armed 220ms slide
  // this replaced read as a buggy top-to-bottom entrance (founder feedback).
  useEffect(() => {
    if (mode !== 'document') return;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setLayoutVersion((version) => version + 1);
    });
    for (const item of docLaneItems) {
      const node = itemRefs.current[item.key];
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [docLaneItems, mode]);

  useLayoutEffect(() => {
    if (mode !== 'document') {
      setDocLaneTops({});
      setDocLaneHeight(0);
      return;
    }
    const measured = docLaneItems.map((item) => {
      const height = itemRefs.current[item.key]?.getBoundingClientRect().height ?? (item.key === '__draft__' ? 140 : 110);
      // item.desiredTop is the text's vertical center; place the card so its own
      // center lands there (clamped so the top card can't float above the origin).
      return { key: item.key, desiredTop: Math.max(0, Math.round(item.desiredTop - height / 2)), height };
    });
    const nextTops = layoutCommentLane({ items: measured, focusKey, gap: COMMENT_LANE_GAP });
    let maxBottom = 0;
    for (const item of measured) {
      maxBottom = Math.max(maxBottom, (nextTops[item.key] ?? 0) + item.height);
    }

    setDocLaneTops((current) => {
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(nextTops);
      if (currentKeys.length === nextKeys.length && nextKeys.every((key) => current[key] === nextTops[key])) {
        return current;
      }
      return nextTops;
    });
    setDocLaneHeight(Math.max(0, maxBottom));
  }, [docLaneItems, focusKey, layoutVersion, mode]);

  return (
    <aside
      // Lane stays page-white; a hairline editor↔comments separator fades in
      // only while the pointer is over the lane (new-Google-Docs style).
      className={`group/lane relative flex h-full min-h-0 w-[320px] max-w-full shrink-0 px-3 pb-4 ${
        showWorkspaceHeader ? 'pt-4' : 'pt-2'
      }`}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-px bg-stone-200 opacity-0 transition-opacity duration-200 group-hover/lane:opacity-100"
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {showWorkspaceHeader ? (
          <div className="mb-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[15px] font-medium tracking-[-0.01em] text-stone-800">
                  Comments
                </div>
                <div className="mt-2 flex items-center gap-3 border-b border-stone-200">
                  {documentLabel ? (
                    <TabButton active={false} onClick={() => onModeChange('document')}>
                      This doc
                    </TabButton>
                  ) : null}
                  <TabButton active onClick={() => onModeChange('workspace')}>
                    All comments
                  </TabButton>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {commentWatchScope ? <CommentWatchBadge /> : null}
                <ActionButton label="Close comments" onClick={() => onClose()}>
                  <XIcon className="h-3.5 w-3.5" weight="bold" />
                </ActionButton>
              </div>
            </div>
          </div>
        ) : null}

        <div className={`flex-1 ${showWorkspaceHeader ? 'overflow-y-auto' : ''}`}>
          <div className="space-y-2">
            {mode === 'document' && !error && (draftSelection || orderedThreads.length > 0) ? (
              <div
                className="relative"
                style={{ minHeight: Math.max(docLaneHeight, 1) }}
              >
                {draftSelection ? (
                  <div
                    ref={(node) => {
                      itemRefs.current.__draft__ = node;
                    }}
                    className="absolute inset-x-0"
                    style={{
                      top: docLaneTops.__draft__ ?? Math.max(0, Math.round(draftAnchorOffset ?? 0)),
                      // Never paint at an unmeasured position — stay hidden
                      // until the anchor offset exists, then appear in place.
                      visibility:
                        draftAnchorOffset == null && measuredAnchorIds != null && !measuredAnchorIds.has('__draft__')
                          ? 'hidden'
                          : undefined,
                    }}
                  >
                    <CommentComposer
                      currentUser={currentUser}
                      draftSelection={draftSelection}
                      initialBody={draftBody}
                      canComment={canComment}
                      busy={busyAction === 'create'}
                      mentionPeople={mentionPeople}
                      onSubmit={onCreateComment}
                      onCancel={onCancelDraft}
                    />
                  </div>
                ) : null}

                {orderedThreads.map((thread) => (
                  <div
                    key={laneKeyOf(thread)}
                    ref={(node) => {
                      itemRefs.current[laneKeyOf(thread)] = node;
                    }}
                    data-comment-thread-id={thread.id}
                    data-comment-active={thread.id === activeThreadId ? 'true' : undefined}
                    className="absolute inset-x-0"
                    style={{
                      top: docLaneTops[laneKeyOf(thread)] ?? Math.max(0, Math.round(threadAnchorOffsets[thread.id] ?? 0)),
                      // Before the first measurement pass, an offset-less card
                      // must never paint — it would sit at the top:0 fallback
                      // and then jump to its anchor once measured (the
                      // founder's top-flash bug). It stays in the DOM (so its
                      // height feeds the layout pass) and becomes visible in
                      // place. After a pass, a thread whose anchor can't
                      // resolve falls back to visible so it stays reachable.
                      visibility:
                        threadAnchorOffsets[thread.id] == null &&
                        measuredAnchorIds != null &&
                        !measuredAnchorIds.has(thread.id)
                          ? 'hidden'
                          : undefined,
                      zIndex: thread.id === activeThreadId ? 1 : undefined,
                    }}
                  >
                    <ThreadCard
                      chatActivity={chatActivity}
                      mentionPeople={mentionPeople}
                      mode={mode}
                      thread={thread}
                      active={thread.id === activeThreadId}
                      currentUserId={currentUserId}
                      canComment={canComment}
                      canResolve={canResolvePath(thread.filePath)}
                      busyAction={busyAction}
                      // Document lane ⇒ these threads ARE the open doc, which
                      // `commentWatchScope` describes.
                      watched={commentWatchScope != null}
                      onSelect={() => onSelectThread(thread.id)}
                      onOpenWorkspaceThread={onOpenWorkspaceThread}
                      onOpenThreadChat={onOpenThreadChat}
                      onReply={(body) => onReply(thread.id, body)}
                      onResolve={() => onResolve(thread.id)}
                      onReopen={() => onReopen(thread.id)}
                      onEditMessage={onEditMessage}
                      onDeleteMessage={onDeleteMessage}
                      onCopyMessageLink={onCopyMessageLink}
                      replyRestore={replyRestore}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {!loading && error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700 shadow-[0_1px_2px_rgba(60,64,67,0.12)]">
                {error}
              </div>
            ) : null}

            {!loading && mode === 'workspace' && orderedThreads.length === 0 && resolvedThreads.length === 0 ? (
              <div className={`${COMMENT_CARD_CLASS} flex flex-col items-center gap-2 px-4 py-5 text-[12px] leading-5 text-stone-500`}>
                <SunnyAnimation name="sleepy" className="w-20 opacity-90" />
                No comments across this workspace yet.
              </div>
            ) : null}

            {mode === 'workspace'
              ? orderedThreads.map((thread) => (
                  <ThreadCard
                    chatActivity={chatActivity}
                    mentionPeople={mentionPeople}
                    key={thread.clientKey ?? thread.id}
                    mode={mode}
                    thread={thread}
                    active={false}
                    currentUserId={currentUserId}
                    canComment={canComment}
                    canResolve={canResolvePath(thread.filePath)}
                    busyAction={busyAction}
                    onSelect={() => onSelectThread(thread.id)}
                    onOpenWorkspaceThread={onOpenWorkspaceThread}
                    onOpenThreadChat={onOpenThreadChat}
                    onReply={(body) => onReply(thread.id, body)}
                    onResolve={() => onResolve(thread.id)}
                    onReopen={() => onReopen(thread.id)}
                    onEditMessage={onEditMessage}
                    onDeleteMessage={onDeleteMessage}
                    onCopyMessageLink={onCopyMessageLink}
                  />
                ))
              : null}

            {resolvedThreads.length > 0 ? (
              <div className="pt-1">
                {resolvedOnly ? null : (
                  <button
                    type="button"
                    onClick={() => setShowResolved((value) => !value)}
                    className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
                    aria-expanded={showResolved}
                  >
                    <ClockCounterClockwiseIcon className="h-3.5 w-3.5" weight="regular" />
                    <span>
                      {showResolved ? 'Hide' : 'Show'} resolved ({resolvedThreads.length})
                    </span>
                    <CaretUpIcon
                      className={`ml-auto h-3 w-3 transition-transform ${showResolved ? '' : 'rotate-180'}`}
                      weight="bold"
                    />
                  </button>
                )}
                {resolvedOnly || showResolved ? (
                  <div className="mt-1 space-y-2">
                    {resolvedThreads.map((thread) => (
                      <ThreadCard
                        chatActivity={chatActivity}
                        mentionPeople={mentionPeople}
                        key={thread.clientKey ?? thread.id}
                        mode={mode}
                        thread={thread}
                        active={thread.id === activeThreadId}
                        currentUserId={currentUserId}
                        canComment={canComment}
                        canResolve={canResolvePath(thread.filePath)}
                        busyAction={busyAction}
                        onSelect={() => onSelectThread(thread.id)}
                        onOpenWorkspaceThread={onOpenWorkspaceThread}
                        onOpenThreadChat={onOpenThreadChat}
                        onReply={(body) => onReply(thread.id, body)}
                        onResolve={() => onResolve(thread.id)}
                        onReopen={() => onReopen(thread.id)}
                        onEditMessage={onEditMessage}
                        onDeleteMessage={onDeleteMessage}
                        onCopyMessageLink={onCopyMessageLink}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  );
}
