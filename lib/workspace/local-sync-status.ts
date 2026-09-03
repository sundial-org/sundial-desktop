import type { SupabaseClient } from '@supabase/supabase-js';

export const WORKSPACE_LOCAL_SYNC_PHASES = ['scanning', 'syncing', 'up_to_date', 'error'] as const;
export const WORKSPACE_LOCAL_SYNC_STALE_MS = 60_000;

export type WorkspaceLocalSyncPhase = (typeof WORKSPACE_LOCAL_SYNC_PHASES)[number];
export type WorkspaceLocalSyncDisplayPhase = WorkspaceLocalSyncPhase | 'unknown' | 'offline';

export type WorkspaceLocalSyncReport = {
  workspaceId: string;
  sourceId: string;
  generation: number;
  sequence: number;
  phase: WorkspaceLocalSyncPhase;
  completedFiles: number;
  totalFiles: number | null;
  pendingFiles: number;
  skippedFiles: number;
  skippedByReason: Record<string, number>;
  error: string | null;
  clientVersion: string | null;
  sessionId: string | null;
  /** Client-reported time. It is diagnostic only; Postgres owns updated_at. */
  observedAt: string | null;
};

export type WorkspaceLocalSyncStatusRow = {
  workspace_id: string;
  source_id: string;
  generation: number | string;
  sequence: number | string;
  phase: string;
  completed_files: number | string;
  total_files: number | string | null;
  pending_files: number | string;
  skipped_files: number | string;
  skipped_by_reason: unknown;
  error: string | null;
  client_version: string | null;
  session_id: string | null;
  observed_at: string | null;
  updated_at: string;
};

/** A workspace-level view. Counts come from the freshest source, never a sum:
 * multiple machines can mirror overlapping scopes into the same workspace. */
export type WorkspaceLocalSyncStatus = {
  state: 'unknown' | 'reported' | 'offline';
  phase: WorkspaceLocalSyncDisplayPhase;
  reportedPhase: WorkspaceLocalSyncPhase | null;
  sourceCount: number;
  sourceId: string | null;
  generation: number | null;
  sequence: number | null;
  completedFiles: number;
  totalFiles: number | null;
  pendingFiles: number;
  skippedFiles: number;
  skippedByReason: Record<string, number>;
  error: string | null;
  clientVersion: string | null;
  sessionId: string | null;
  observedAt: string | null;
  updatedAt: string | null;
};

export type WorkspaceLocalSyncReportParseResult =
  | { ok: true; report: WorkspaceLocalSyncReport }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const REASON_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type CountResult<T> = { ok: true; value: T } | { ok: false; error: string };

function readCount(value: unknown, name: string): CountResult<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: `${name} must be a non-negative safe integer` };
  }
  return { ok: true, value };
}

function readNullableCount(value: unknown, name: string): CountResult<number | null> {
  if (value === null) return { ok: true, value: null };
  const result = readCount(value, name);
  return result.ok ? result : { ok: false, error: `${name} must be a non-negative safe integer or null` };
}

function cleanOptionalText(value: unknown, name: string, maxLength: number) {
  if (value === undefined || value === null || value === '') {
    return { ok: true as const, value: null };
  }
  if (typeof value !== 'string') return { ok: false as const, error: `${name} must be a string` };
  if (value.length > maxLength * 2) {
    return { ok: false as const, error: `${name} must be between 1 and ${maxLength} characters` };
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned.length > maxLength) {
    return { ok: false as const, error: `${name} must be between 1 and ${maxLength} characters` };
  }
  return { ok: true as const, value: cleaned };
}

export function sanitizeWorkspaceLocalSyncError(value: string): string | null {
  const cleaned = value.slice(0, 2_048)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bsd_[a-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\b(?:github_pat_|gh[oprsu]_)[a-z0-9_]{16,}\b/gi, '[redacted]')
    .replace(/([?&](?:token|secret|password|api[_-]?key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .trim();
  return cleaned ? cleaned.slice(0, 512) : null;
}

/** Validate the small, version-tolerant bridge payload before it reaches RPC. */
export function parseWorkspaceLocalSyncReport(input: unknown): WorkspaceLocalSyncReportParseResult {
  const body = asRecord(input);
  if (!body) return { ok: false, error: 'Request body must be a JSON object' };

  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
  if (!UUID_RE.test(workspaceId)) return { ok: false, error: 'workspaceId must be a UUID' };
  if (!SOURCE_ID_RE.test(sourceId)) return { ok: false, error: 'sourceId is invalid' };
  if (!WORKSPACE_LOCAL_SYNC_PHASES.includes(body.phase as WorkspaceLocalSyncPhase)) {
    return { ok: false, error: 'phase must be scanning, syncing, up_to_date, or error' };
  }

  const generation = readCount(body.generation, 'generation');
  const sequence = readCount(body.sequence, 'sequence');
  const completedFiles = readCount(body.completedFiles, 'completedFiles');
  const totalFiles = readNullableCount(body.totalFiles, 'totalFiles');
  const pendingFiles = readCount(body.pendingFiles, 'pendingFiles');
  const skippedFiles = readCount(body.skippedFiles, 'skippedFiles');
  if (!generation.ok) return generation;
  if (!sequence.ok) return sequence;
  if (!completedFiles.ok) return completedFiles;
  if (!totalFiles.ok) return totalFiles;
  if (!pendingFiles.ok) return pendingFiles;
  if (!skippedFiles.ok) return skippedFiles;

  if (
    totalFiles.value !== null &&
    (completedFiles.value > totalFiles.value || pendingFiles.value !== totalFiles.value - completedFiles.value)
  ) {
    return { ok: false, error: 'totalFiles must equal completedFiles plus pendingFiles' };
  }
  if (
    body.phase === 'up_to_date' &&
    (totalFiles.value === null || pendingFiles.value !== 0 || completedFiles.value !== totalFiles.value)
  ) {
    return { ok: false, error: 'up_to_date requires a known, fully completed total' };
  }

  const rawReasons = asRecord(body.skippedByReason);
  if (!rawReasons || Object.keys(rawReasons).length > 32) {
    return { ok: false, error: 'skippedByReason must be an object with at most 32 entries' };
  }
  const skippedByReason: Record<string, number> = {};
  for (const [reason, value] of Object.entries(rawReasons)) {
    const count = readCount(value, `skippedByReason.${reason}`);
    if (!REASON_RE.test(reason) || !count.ok) {
      return { ok: false, error: 'skippedByReason contains an invalid reason or count' };
    }
    skippedByReason[reason] = count.value;
  }
  if (JSON.stringify(skippedByReason).length > 4096) {
    return { ok: false, error: 'skippedByReason is too large' };
  }

  if (body.error !== undefined && body.error !== null && typeof body.error !== 'string') {
    return { ok: false, error: 'error must be a string' };
  }
  const clientVersion = cleanOptionalText(body.clientVersion, 'clientVersion', 80);
  const sessionId = cleanOptionalText(body.sessionId, 'sessionId', 160);
  if (!clientVersion.ok) return clientVersion;
  if (!sessionId.ok) return sessionId;

  let observedAt: string | null = null;
  if (body.updatedAt !== undefined && body.updatedAt !== null) {
    if (typeof body.updatedAt !== 'string' || body.updatedAt.length > 64) {
      return { ok: false, error: 'updatedAt must be an ISO timestamp' };
    }
    const time = Date.parse(body.updatedAt);
    if (!Number.isFinite(time)) return { ok: false, error: 'updatedAt must be an ISO timestamp' };
    observedAt = new Date(time).toISOString();
  }

  return {
    ok: true,
    report: {
      workspaceId,
      sourceId,
      generation: generation.value,
      sequence: sequence.value,
      phase: body.phase as WorkspaceLocalSyncPhase,
      completedFiles: completedFiles.value,
      totalFiles: totalFiles.value,
      pendingFiles: pendingFiles.value,
      skippedFiles: skippedFiles.value,
      skippedByReason,
      error: body.phase === 'error' && typeof body.error === 'string'
        ? sanitizeWorkspaceLocalSyncError(body.error)
        : null,
      clientVersion: clientVersion.value,
      sessionId: sessionId.value,
      observedAt,
    },
  };
}

function databaseCount(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function databaseReasons(value: unknown): Record<string, number> {
  const input = asRecord(value);
  if (!input) return {};
  return Object.fromEntries(
    Object.entries(input)
      .filter(([reason, count]) => REASON_RE.test(reason) && databaseCount(count) === Number(count))
      .map(([reason, count]) => [reason, databaseCount(count)]),
  );
}

export function aggregateWorkspaceLocalSyncStatus(
  rows: WorkspaceLocalSyncStatusRow[],
  options: { now?: number; staleAfterMs?: number } = {},
): WorkspaceLocalSyncStatus {
  if (rows.length === 0) {
    return {
      state: 'unknown', phase: 'unknown', reportedPhase: null, sourceCount: 0,
      sourceId: null, generation: null, sequence: null, completedFiles: 0,
      totalFiles: null, pendingFiles: 0, skippedFiles: 0, skippedByReason: {},
      error: null, clientVersion: null, sessionId: null, observedAt: null, updatedAt: null,
    };
  }

  const timestamp = (row: WorkspaceLocalSyncStatusRow) => Date.parse(row.updated_at);
  const freshest = [...rows].sort((a, b) => {
    const byTime = (Number.isFinite(timestamp(b)) ? timestamp(b) : -Infinity)
      - (Number.isFinite(timestamp(a)) ? timestamp(a) : -Infinity);
    return byTime || b.source_id.localeCompare(a.source_id);
  })[0];
  const reportedPhase = WORKSPACE_LOCAL_SYNC_PHASES.includes(freshest.phase as WorkspaceLocalSyncPhase)
    ? (freshest.phase as WorkspaceLocalSyncPhase)
    : null;
  const updatedMs = timestamp(freshest);
  const stale = !Number.isFinite(updatedMs)
    || (options.now ?? Date.now()) - updatedMs > (options.staleAfterMs ?? WORKSPACE_LOCAL_SYNC_STALE_MS);

  return {
    state: reportedPhase === null ? 'unknown' : stale ? 'offline' : 'reported',
    phase: reportedPhase === null ? 'unknown' : stale ? 'offline' : reportedPhase,
    reportedPhase,
    sourceCount: new Set(rows.map((row) => row.source_id)).size,
    sourceId: freshest.source_id,
    generation: databaseCount(freshest.generation),
    sequence: databaseCount(freshest.sequence),
    completedFiles: databaseCount(freshest.completed_files),
    totalFiles: freshest.total_files === null ? null : databaseCount(freshest.total_files),
    pendingFiles: databaseCount(freshest.pending_files),
    skippedFiles: databaseCount(freshest.skipped_files),
    skippedByReason: databaseReasons(freshest.skipped_by_reason),
    error: freshest.error,
    clientVersion: freshest.client_version,
    sessionId: freshest.session_id,
    observedAt: freshest.observed_at,
    updatedAt: freshest.updated_at,
  };
}

export async function loadWorkspaceLocalSyncStatus(
  supabase: SupabaseClient,
  workspaceId: string,
  options?: { now?: number; staleAfterMs?: number },
): Promise<WorkspaceLocalSyncStatus> {
  const { data, error } = await supabase
    .from('workspace_local_sync_status')
    .select(
      'workspace_id, source_id, generation, sequence, phase, completed_files, total_files, pending_files, skipped_files, skipped_by_reason, error, client_version, session_id, observed_at, updated_at',
    )
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return aggregateWorkspaceLocalSyncStatus((data ?? []) as WorkspaceLocalSyncStatusRow[], options);
}
