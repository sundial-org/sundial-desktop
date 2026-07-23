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
};

/** lib/workspace/linked-repos.ts. */
export type LinkedRepoProvider = 'github' | 'overleaf' | 'gdocs';
