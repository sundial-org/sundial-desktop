// Response/view types produced by server-only query modules and rendered by
// the client UI. They live here so client code (and the open-source desktop
// surface) never imports the queries themselves; each query module re-exports
// its types from here for back-compat.

import type { ChatTurnEditSummary } from '@/lib/workspace/chat-turn-edits';
import type { TurnEditsResponse } from '@/lib/workspace/turn-edits';

/** lib/workspace/labels.ts — manual history labels. */
export type HistoryLabel = {
  id: string;
  docEditId: number;
  name: string;
  createdBy: string | null;
  createdAt: string;
};

/** lib/workspace/file-pending-edits-query.ts — see that file for field docs. */
export type FilePendingEditsResponse = {
  workspaceId: string;
  filePath: string;
  turns: ChatTurnEditSummary[];
  payloads: Record<string, TurnEditsResponse>;
  humanRuns: Array<{ firstRowId: number; lastRowId: number; reviewId: string }>;
  /** Y.Doc suggestion mark id (the agent write's `tool_call_id`) → the
   *  `assistantMessageId` that produced it. Agent marks only. */
  suggestionTurns: Record<string, string>;
};

/** lib/workspace/file-blame.ts — who introduced each line of the current text. */
export type FileBlameResponse = {
  workspaceId: string;
  filePath: string;
  lines: Array<{
    text: string;
    authorId: string | null;
    createdAt: string | null;
    assistantMessageId: string | null;
    chatId: string | null;
    /** Path-share redaction: text visible, provenance buried (slot preserved). */
    redacted?: boolean;
    /** Path the attributing edit was written at — differs from the open file
     *  after a move, and the turn's diff is filed under that path. */
    filePath?: string | null;
  }>;
};

/** lib/workspace/history-snapshot.ts — per-path diff between two snapshots. */
export type SnapshotFileDiff = {
  path: string;
  status: 'added' | 'removed' | 'modified';
  beforeText: string;
  afterText: string;
};

/** lib/workspace/model-catalog.ts — one picker entry. */
export type ModelPickerOption = {
  id: string;
  provider: string;
  providerLabel: string;
  modelId: string;
  label: string;
  reasoning: boolean;
  supportsImages: boolean;
  contextWindow: number | null;
  maxTokens: number | null;
  /** Gateway release date (unix seconds). Lets the featured row promote the
   *  newest model of a family; absent for the desktop's static local list. */
  released?: number | null;
};

/** lib/workspace/linked-repos.ts. */
export type LinkedRepoProvider = 'github' | 'overleaf' | 'gdocs';
