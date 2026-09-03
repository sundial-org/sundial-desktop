'use client';

import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon,
  type Icon,
} from '@phosphor-icons/react';

import type { WorkspaceLocalSyncStatus } from '@/lib/workspace/local-sync-status';
import type { WorkspaceKind } from '@/lib/workspace/kinds';

type DisplayPhase = WorkspaceLocalSyncStatus['phase'];

// One card shell for every phase: white, stone border, stone text — the
// Sync-section chip idiom (see commits-rail's "Synced with GitHub"). Severity
// lives only in the icon color and the wording; no tinted surfaces.
type StatusPresentation = {
  label: string;
  detail: string | null;
  Icon: Icon;
  tone: string;
};

const FILE_COUNT_FORMATTER = new Intl.NumberFormat('en-US');

function nonNegative(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}

function skippedLabel(skippedFiles: number): string | null {
  return skippedFiles > 0 ? `${FILE_COUNT_FORMATTER.format(skippedFiles)} skipped` : null;
}

function joinDetails(...parts: Array<string | null | undefined>): string | null {
  const text = parts.filter(Boolean).join(' · ');
  return text || null;
}

function progressPercent(status: WorkspaceLocalSyncStatus): number | null {
  const total = status.totalFiles;
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  const rounded = Math.max(0, Math.round((nonNegative(status.completedFiles) / total) * 100));
  return Math.min(status.phase === 'syncing' ? 99 : 100, rounded);
}

function statusPresentation(status: WorkspaceLocalSyncStatus | null, phase: DisplayPhase): StatusPresentation {
  const completed = nonNegative(status?.completedFiles);
  const total = status?.totalFiles == null ? null : nonNegative(status.totalFiles);
  const skipped = nonNegative(status?.skippedFiles);
  const skippedText = skippedLabel(skipped);
  const sourceCount = nonNegative(status?.sourceCount);
  const multipleSources = sourceCount > 1;
  const latestSourceText = multipleSources
    ? `Latest of ${FILE_COUNT_FORMATTER.format(sourceCount)} local sources`
    : null;

  if (phase === 'unknown') {
    return {
      label: 'Local folder sync status unknown',
      detail: 'Files may still arrive.',
      Icon: WarningCircleIcon,
      tone: 'text-amber-500',
    };
  }
  if (phase === 'offline') {
    return {
      label: multipleSources ? 'Latest local source stale or offline' : 'Local folder sync stale or offline',
      detail: joinDetails(
        total === null
          ? (completed > 0 ? `${FILE_COUNT_FORMATTER.format(completed)} files synced` : null)
          : `${FILE_COUNT_FORMATTER.format(completed)} of ${FILE_COUNT_FORMATTER.format(total)} files synced`,
        skippedText,
        latestSourceText,
        'Files may be out of date.',
      ),
      Icon: WarningCircleIcon,
      tone: 'text-amber-500',
    };
  }
  if (phase === 'error') {
    return {
      label: multipleSources ? 'Latest local source sync error' : 'Local folder sync error',
      detail: joinDetails('Some files could not sync. Check the local service.', skippedText, latestSourceText),
      Icon: WarningCircleIcon,
      tone: 'text-rose-500',
    };
  }
  if (phase === 'scanning') {
    return {
      label: multipleSources ? 'Latest local source scanning' : 'Scanning local folder',
      detail: joinDetails(skippedText, latestSourceText),
      Icon: MagnifyingGlassIcon,
      tone: 'text-stone-400',
    };
  }
  if (phase === 'syncing') {
    const percent = status ? progressPercent(status) : null;
    const count = total === null
      ? `${FILE_COUNT_FORMATTER.format(completed)} files synced`
      : `${FILE_COUNT_FORMATTER.format(completed)} of ${FILE_COUNT_FORMATTER.format(total)} files`;
    return {
      label: multipleSources ? 'Latest local source syncing' : 'Syncing local folder',
      detail: joinDetails(count, percent === null ? null : `${percent}%`, skippedText, latestSourceText),
      Icon: ArrowsClockwiseIcon,
      tone: 'text-stone-400',
    };
  }

  return {
    label: multipleSources ? 'Latest local source up to date' : 'Local folder up to date',
    detail: joinDetails(
      completed > 0 ? `${FILE_COUNT_FORMATTER.format(completed)} files synced` : null,
      skippedText,
      latestSourceText,
      multipleSources ? 'Other sources may differ.' : null,
    ),
    Icon: CheckCircleIcon,
    tone: 'text-emerald-600',
  };
}

export function LocalFolderSyncStatus({
  projectKind,
  status,
}: {
  projectKind: WorkspaceKind | null;
  status: WorkspaceLocalSyncStatus | null;
}) {
  if (!status && projectKind !== 'local-backing') return null;

  const phase: DisplayPhase = status?.phase ?? 'unknown';
  const presentation = statusPresentation(status, phase);
  const percent = status && phase === 'syncing' ? progressPercent(status) : null;
  const Icon = presentation.Icon;

  return (
    <div
      data-testid="local-folder-sync-status"
      role="status"
      aria-live="polite"
      className="mx-3 my-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-2"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${presentation.tone}`} weight={phase === 'up_to_date' ? 'fill' : 'bold'} aria-hidden />
        <span className="min-w-0 truncate font-medium text-stone-700">{presentation.label}</span>
      </div>
      {presentation.detail ? (
        <div className="truncate pl-5 text-[10px] leading-4 text-stone-500" title={presentation.detail}>
          {presentation.detail}
        </div>
      ) : null}
      {percent !== null ? (
        <div
          role="progressbar"
          aria-label="Local folder sync progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="ml-5 mt-1 h-0.5 overflow-hidden rounded-full bg-stone-100"
        >
          <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}
