'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SunnyAnimation } from '@/components/sunny-animation';

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
  CaretUpIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  DotsThreeVerticalIcon,
  LinkSimpleIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  layoutCommentLane,
  isOptimisticCommentId,
  type DraftDocCommentSelection,
  type DocCommentAuthor,
  type DocCommentMessage,
  type DocCommentThread,
} from '@/lib/workspace/doc-comments';

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

type CommentPanelMode = 'document' | 'workspace';

interface DocCommentsPanelProps {
  mode: CommentPanelMode;
  documentLabel: string | null;
  threads: DocCommentThread[];
  resolvedThreads?: DocCommentThread[];
  threadAnchorOffsets?: Record<string, number>;
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
  canResolve: boolean;
  loading?: boolean;
  error?: string | null;
  busyAction?: string | null;
  onModeChange: (mode: CommentPanelMode) => void;
  onSelectThread: (threadId: string | null) => void;
  onOpenWorkspaceThread: (thread: DocCommentThread) => void;
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
  'rounded-2xl border border-[#dadce0] bg-white shadow-[0_1px_2px_rgba(60,64,67,0.2),0_2px_6px_2px_rgba(60,64,67,0.1)]';
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
      className={`${className} inline-flex items-center justify-center rounded-full bg-[#f1e5d7] font-medium text-[#866646]`}
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
          ? 'bg-[#f1e5d7] text-[#634a31]'
          : 'text-[#5f6368] hover:bg-[#f6f1ea] hover:text-[#202124]'
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
        active ? 'text-[#866646]' : 'text-[#5f6368] hover:text-[#202124]'
      }`}
    >
      {children}
      {active ? (
        <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-t-full bg-[#c9a57a]" />
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
          ? 'text-[#c5221f] hover:bg-[#fce8e6]'
          : 'text-[#202124] hover:bg-[#f1f3f4]'
      }`}
    >
      {children}
    </button>
  );
}

function CommentComposer({
  currentUser,
  draftSelection,
  initialBody = '',
  canComment,
  busy,
  onSubmit,
  onCancel,
}: {
  currentUser: CurrentUser;
  draftSelection: DraftDocCommentSelection | null;
  /** Seed text — non-empty when a failed create handed the draft back. */
  initialBody?: string;
  canComment: boolean;
  busy: boolean;
  onSubmit: (body: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const textareaRef = useAutoGrowTextarea(body);
  const trimmedBody = body.trim();

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
          <div className="text-[13px] font-medium leading-5 text-[#202124]">
            {currentUser.name?.trim() || 'You'}
          </div>
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) =>
              submitOnCmdEnter(event, canComment && !busy && trimmedBody.length > 0, () =>
                void onSubmit(trimmedBody),
              )
            }
            placeholder="Comment or add others with @"
            rows={2}
            disabled={!canComment || busy}
            className="mt-2 max-h-[40vh] min-h-[44px] w-full resize-none overflow-y-auto rounded-xl border-2 border-[#c9a57a] bg-white px-3 py-2 text-[13px] leading-5 text-[#202124] outline-none transition-shadow placeholder:text-[#5f6368] focus:shadow-[0_0_0_1px_#c9a57a] disabled:cursor-not-allowed disabled:border-[#dadce0] disabled:bg-[#f8f9fa] disabled:text-[#5f6368]"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-full px-2 py-1 text-[12px] font-medium text-[#866646] transition-colors hover:bg-[#f6f1ea] disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onSubmit(trimmedBody)}
              disabled={!canComment || busy || trimmedBody.length === 0}
              className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                !canComment || busy || trimmedBody.length === 0
                  ? 'bg-[#f1f3f4] text-[#9aa0a6]'
                  : 'bg-[#f1e5d7] text-[#634a31] hover:bg-[#ead9c6]'
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
        className="whitespace-pre-wrap text-[13px] leading-5 text-[#3c4043]"
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
          className="mt-0.5 text-[12px] font-medium text-[#866646] transition-colors hover:text-[#634a31]"
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
  const canDelete = isOwnMessage && !actionsDisabled;
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
            <div className="truncate text-[13px] font-medium leading-5 text-[#202124]">
              {message.author.name?.trim() || message.author.username || 'Collaborator'}
            </div>
            <div className="text-[11px] leading-4 text-[#5f6368]">
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
                  <ClockCounterClockwiseIcon className="h-3.5 w-3.5 text-[#866646]" weight="bold" />
                ) : (
                  <CheckIcon className="h-3.5 w-3.5 text-[#866646]" weight="bold" />
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
                      className="fixed z-[80] min-w-[220px] rounded-xl border border-[#dadce0] bg-white py-1.5 shadow-[0_8px_24px_rgba(60,64,67,0.18)]"
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
            <div className="rounded-xl border border-[#80868b] bg-white px-3 py-2 transition-colors focus-within:border-[#c9a57a]">
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
                className="max-h-[40vh] min-h-[40px] w-full resize-none overflow-y-auto bg-transparent text-[13px] leading-5 text-[#202124] outline-none placeholder:text-[#5f6368] disabled:cursor-not-allowed"
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
                className="rounded-full px-2 py-1 text-[12px] font-medium text-[#866646] transition-colors hover:bg-[#f6f1ea] disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSaveEdit()}
                disabled={isEditBusy || trimmedDraftBody.length === 0}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                  isEditBusy || trimmedDraftBody.length === 0
                    ? 'bg-[#f1f3f4] text-[#9aa0a6]'
                    : 'bg-[#f1e5d7] text-[#634a31] hover:bg-[#ead9c6]'
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
  currentUserId: string | null;
  canComment: boolean;
  canResolve: boolean;
  busyAction: string | null;
  onSelect: () => void;
  onOpenWorkspaceThread: (thread: DocCommentThread) => void;
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
          ? 'border-[#eadfce] bg-[#fbf6ef]'
          : ''
      } ${thread.status === 'resolved' ? 'opacity-80' : ''}`}
    >
      <div className="space-y-3">
        {mode === 'workspace' ? (
          <div className="flex items-start justify-between gap-2">
            <p className="text-[12px] leading-5 text-[#3c4043]">
              {getWorkspaceThreadHeading(thread)}
            </p>
            <CaretUpIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#5f6368]" weight="bold" />
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

        {mode === 'document' && active && canComment && thread.status === 'open' && !isOptimistic ? (
          <div>
            <div className="rounded-xl border border-[#80868b] bg-white px-3 py-2 transition-colors focus-within:border-[#c9a57a]">
              <textarea
                ref={replyRef}
                value={replyBody}
                onChange={(event) => setReplyBody(event.target.value)}
                onKeyDown={(event) =>
                  submitOnCmdEnter(event, !isReplyBusy && replyBody.trim().length > 0, submitReply)
                }
                rows={2}
                placeholder="Reply or add others with @"
                disabled={isReplyBusy}
                className="max-h-[40vh] min-h-[40px] w-full resize-none overflow-y-auto bg-transparent text-[13px] leading-5 text-[#202124] outline-none placeholder:text-[#5f6368] disabled:cursor-not-allowed"
              />
            </div>
            {showReplyActions ? (
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setReplyBody('');
                  }}
                  disabled={isReplyBusy}
                  className="rounded-full px-2 py-1 text-[12px] font-medium text-[#866646] transition-colors hover:bg-[#f6f1ea] disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    submitReply();
                  }}
                  disabled={isReplyBusy || replyBody.trim().length === 0}
                  className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                    isReplyBusy || replyBody.trim().length === 0
                      ? 'bg-[#f1f3f4] text-[#9aa0a6]'
                      : 'bg-[#f1e5d7] text-[#634a31] hover:bg-[#ead9c6]'
                  }`}
                >
                  Reply
                </button>
              </div>
            ) : null}
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
      className={`group/lane relative flex h-full min-h-0 w-[320px] shrink-0 px-3 pb-4 ${
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
                <div className="text-[15px] font-medium tracking-[-0.01em] text-[#202124]">
                  Comments
                </div>
                <div className="mt-2 flex items-center gap-3 border-b border-[#dadce0]">
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
              <ActionButton label="Close comments" onClick={() => onClose()}>
                <XIcon className="h-3.5 w-3.5" weight="bold" />
              </ActionButton>
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
                    }}
                  >
                    <CommentComposer
                      currentUser={currentUser}
                      draftSelection={draftSelection}
                      initialBody={draftBody}
                      canComment={canComment}
                      busy={busyAction === 'create'}
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
                      zIndex: thread.id === activeThreadId ? 1 : undefined,
                    }}
                  >
                    <ThreadCard
                      mode={mode}
                      thread={thread}
                      active={thread.id === activeThreadId}
                      currentUserId={currentUserId}
                      canComment={canComment}
                      canResolve={canResolve}
                      busyAction={busyAction}
                      onSelect={() => onSelectThread(thread.id)}
                      onOpenWorkspaceThread={onOpenWorkspaceThread}
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
              <div className="rounded-xl border border-[#f3c7c3] bg-[#fce8e6] px-4 py-3 text-[12px] text-[#c5221f] shadow-[0_1px_2px_rgba(60,64,67,0.12)]">
                {error}
              </div>
            ) : null}

            {!loading && mode === 'workspace' && orderedThreads.length === 0 && resolvedThreads.length === 0 ? (
              <div className={`${COMMENT_CARD_CLASS} flex flex-col items-center gap-2 px-4 py-5 text-[12px] leading-5 text-[#5f6368]`}>
                <SunnyAnimation name="sleepy" className="w-20 opacity-90" />
                No comments across this workspace yet.
              </div>
            ) : null}

            {mode === 'workspace'
              ? orderedThreads.map((thread) => (
                  <ThreadCard
                    key={thread.clientKey ?? thread.id}
                    mode={mode}
                    thread={thread}
                    active={false}
                    currentUserId={currentUserId}
                    canComment={canComment}
                    canResolve={canResolve}
                    busyAction={busyAction}
                    onSelect={() => onSelectThread(thread.id)}
                    onOpenWorkspaceThread={onOpenWorkspaceThread}
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
                <button
                  type="button"
                  onClick={() => setShowResolved((value) => !value)}
                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-[#5f6368] transition-colors hover:bg-[#f1f3f4] hover:text-[#202124]"
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
                {showResolved ? (
                  <div className="mt-1 space-y-2">
                    {resolvedThreads.map((thread) => (
                      <ThreadCard
                        key={thread.clientKey ?? thread.id}
                        mode={mode}
                        thread={thread}
                        active={thread.id === activeThreadId}
                        currentUserId={currentUserId}
                        canComment={canComment}
                        canResolve={canResolve}
                        busyAction={busyAction}
                        onSelect={() => onSelectThread(thread.id)}
                        onOpenWorkspaceThread={onOpenWorkspaceThread}
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
