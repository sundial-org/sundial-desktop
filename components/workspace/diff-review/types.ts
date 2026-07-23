export type DiffReviewMode = 'fullsend' | 'review';

export type DiffLineType = 'addition' | 'deletion' | 'context';

export type ChunkStatus = 'pending' | 'kept' | 'undone';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  lineNumber?: number;
}

export interface DiffChunk {
  id: string;
  lines: DiffLine[];
  status: ChunkStatus;
}

export interface FileDiff {
  id: string;
  filePath: string;
  isNew: boolean;
  // Chunkless placeholders (file too large to diff / binary upload) — still
  // listed and selectable, they just have no reviewable chunks.
  oversized?: boolean;
  blob?: boolean;
  chunks: DiffChunk[];
}

export interface ChatDiffSession {
  chatId: string;
  files: FileDiff[];
}
