'use client';

import { stripMarkdownSyntax } from '@/lib/workspace/derive-chat-title';

export type ChatStatus = 'idle' | 'working' | 'done' | 'error' | 'starting' | 'stopped';

// Not-yet-persisted chats get a local `draft-<uuid>` id until the first send
// creates the DB row. Anything keying API calls on a chat id must skip drafts.
export const DRAFT_CHAT_PREFIX = 'draft-';
export const isDraftChatId = (id: string | null | undefined): boolean =>
  Boolean(id && id.startsWith(DRAFT_CHAT_PREFIX));

/** Rename / archive / delete: WRITE-scoped and identity-free. Both data planes
 *  gate them on write access alone, so an anon cloud visitor and a signed-out
 *  desktop-local user manage their own chats. Menu items AND their handlers
 *  must share this — gating the handler on a user id is what silently broke
 *  "Archive chat" on the desktop app's local projects. */
export const canManageChat = (canWrite: boolean, chatId: string | null | undefined): boolean =>
  Boolean(canWrite && chatId && !isDraftChatId(chatId));

/** Pinning is the exception: `chat_pins` rows are keyed by a Clerk user id, so
 *  there is nothing to write without one. */
export const canPinChat = (userId: string | null | undefined, chatId: string | null | undefined): boolean =>
  Boolean(userId && chatId && !isDraftChatId(chatId));

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  sequence?: number | null;
};

export type MessageAttachment = {
  id: string;
  path: string;
  name?: string | null;
  mime?: string | null;
  size?: number | null;
  type?: 'text' | 'binary';
  signedUrl?: string | null;
  storagePath?: string | null;
};

/** Snippet of text grabbed from an editor (Cmd/Ctrl-J with a selection) and pinned to
 *  the chat composer as a context tag. Prepended to the message body as
 *  a markdown blockquote when the user sends. */
export type ChatContextSnippet = {
  id: string;
  text: string;
  path: string | null;
};

export type ChatParticipant = {
  id: string;
  identity_key?: string | null;
  kind: 'user';
  user_id: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
};

export type ChatLoopLatestStep = {
  stepIndex: number | null;
  actor: 'planner' | 'executor' | null;
  phase: 'plan' | 'execute' | 'review' | null;
  what: string | null;
  turnCostUsd: number | null;
  cumulativeCostUsd: number | null;
};

export type ChatLoopSummary = {
  runId: string;
  loopId: string;
  status: 'running' | 'completed' | 'stopped' | 'error';
  runUntil: 'success' | 'budget' | null;
  budgetType: 'cost' | 'time';
  budgetLimit: number;
  budgetUsed: number;
  turnCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  stopReason: string | null;
  latestStep: ChatLoopLatestStep | null;
};

export type CollaboratorBadge = {
  id: string;
  name: string;
  initials: string;
  isYou: boolean;
  username: string | null;
  email: string | null;
  imageUrl: string | null;
  /** Explicit chip color (local-mode awareness peers, whose id isn't a
   *  `pickColor` seed). */
  color?: string | null;
  /** Set for live local-agent participants (Claude Code/Codex via MCP). */
  kind?: 'local-agent';
  agentId?: string | null;
  /** Human-set per-agent switch: the agent's writes land as reviewable suggestions. */
  suggestOnly?: boolean;
};


export function getToolMetadataName(tool: Record<string, unknown>, preferDisplayName = false) {
  const primary = preferDisplayName ? tool.display_name : tool.name;
  const secondary = preferDisplayName ? tool.name : tool.display_name;
  if (typeof primary === 'string' && primary.trim()) return primary.trim();
  if (typeof secondary === 'string' && secondary.trim()) return secondary.trim();
  return 'Tool';
}

export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatCostUsd(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

export function formatSessionDurationSeconds(totalSeconds?: number | null) {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return null;
  }
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  return `${days}d ${hrs}h`;
}

export function toChatPreviewText(value?: string | null) {
  if (typeof value !== 'string') return null;
  // First line with visible prose: markdown syntax strips out of the preview,
  // and a line that was ONLY syntax (a ``` fence, a bare "---") is skipped.
  for (const line of value.split(/\r?\n/u)) {
    const stripped = stripMarkdownSyntax(line).replace(/\s+/g, ' ').trim();
    if (stripped) return stripped;
  }
  return null;
}

export function toChatPreviewTextFromMessage(message: Pick<ChatMessage, 'role' | 'content'>) {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  return toChatPreviewText(message.content);
}

export function formatLoopBudgetValue(
  budgetType: 'cost' | 'time',
  value?: number | null
) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (budgetType === 'cost') {
    return numeric < 0.01 ? '$0.00' : `$${numeric.toFixed(2)}`;
  }
  return formatSessionDurationSeconds(Math.max(Math.round(numeric), 0)) ?? '0s';
}

export function getLoopBudgetProgressPercent(loop: ChatLoopSummary | null | undefined) {
  if (!loop) return 0;
  if (!Number.isFinite(loop.budgetLimit) || loop.budgetLimit <= 0) return 0;
  const ratio = loop.budgetUsed / loop.budgetLimit;
  return Math.max(0, Math.min(100, ratio * 100));
}

export function formatLoopActorPhase(step: ChatLoopLatestStep | null | undefined) {
  if (!step || !step.actor || !step.phase) return null;
  const actor = step.actor === 'planner' ? 'Planner' : 'Executor';
  const phase =
    step.phase === 'plan'
      ? 'planning'
      : step.phase === 'execute'
      ? 'executing'
      : 'reviewing';
  return `${actor} ${phase}`;
}

export function formatLoopStatusLabel(status: ChatLoopSummary['status']) {
  if (status === 'completed') return 'Completed';
  if (status === 'stopped') return 'Stopped';
  if (status === 'error') return 'Error';
  return 'Running';
}

export function getLoopStatusPillClass(status: ChatLoopSummary['status']) {
  if (status === 'completed') return 'bg-emerald-100 text-emerald-700';
  if (status === 'stopped') return 'bg-stone-200 text-stone-700';
  if (status === 'error') return 'bg-red-100 text-red-700';
  return 'bg-stone-100 text-stone-600';
}

export function normalizeChatMessage(row: {
  id: string;
  role: string;
  content: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  sequence?: number | null;
}): ChatMessage {
  return {
    id: row.id,
    role: row.role === 'system' ? 'system' : row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content ?? '',
    metadata: row.metadata ?? null,
    created_at: row.created_at ?? undefined,
    sequence: typeof row.sequence === 'number' ? row.sequence : null,
  };
}

function getMessageAttachments(message: ChatMessage): MessageAttachment[] {
  const metadata = message.metadata ?? {};
  if (typeof metadata !== 'object' || metadata === null) return [];
  const raw = (metadata as Record<string, unknown>).attachments;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : '';
      const path = typeof record.path === 'string' ? record.path : '';
      if (!id || !path) return null;
      return {
        id,
        path,
        name: typeof record.name === 'string' ? record.name : null,
        mime: typeof record.mime === 'string' ? record.mime : null,
        size: typeof record.size === 'number' ? record.size : null,
        type:
          record.type === 'text'
            ? 'text'
            : record.type === 'binary' || record.type === 'blob_ref'
              ? 'binary'
              : undefined,
        signedUrl: typeof record.signed_url === 'string' ? record.signed_url : null,
        storagePath: typeof record.storage_path === 'string' ? record.storage_path : null,
      } as MessageAttachment;
    })
    .filter((item): item is MessageAttachment => Boolean(item));
}

export function getMessageMetadata(message: ChatMessage) {
  return message.metadata && typeof message.metadata === 'object'
    ? (message.metadata as Record<string, unknown>)
    : null;
}

function isHiddenChatMessage(message: ChatMessage) {
  return getMessageMetadata(message)?.hidden === true;
}

function getMessageAuthorUserId(message: ChatMessage) {
  const authorUserId = getMessageMetadata(message)?.author_user_id;
  return typeof authorUserId === 'string' ? authorUserId : null;
}

export function getMessageMetadataString(message: ChatMessage, key: string) {
  const value = getMessageMetadata(message)?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function getParticipantMetadata(participant: ChatParticipant | null | undefined) {
  return participant?.metadata && typeof participant.metadata === 'object'
    ? participant.metadata
    : null;
}


export function summarizeToolInput(name: string, input: Record<string, unknown> | null) {
  if (!input) return '';
  const directPath = input.file_path ?? input.path;
  if (typeof directPath === 'string' && directPath) return directPath;
  if (name === 'Bash' && typeof input.command === 'string') return input.command;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.query === 'string') return input.query;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.title === 'string') return input.title;
  return '';
}

export function clipText(value: string, max = 120) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function getAssistantStatusDotClass(status?: ChatStatus) {
  if (status === 'done') return 'bg-green-500';
  if (status === 'working') return 'bg-orange-500 animate-pulse';
  if (status === 'starting') return 'bg-stone-300 animate-pulse';
  if (status === 'error') return 'bg-red-500';
  return 'bg-stone-300';
}
