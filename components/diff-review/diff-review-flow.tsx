'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  Check,
  CheckCircle,
  File as FileIcon,
  FileCode,
  FileText,
} from '@phosphor-icons/react';
import { BlobFileNotice } from '@/components/workspace/diff-review/blob-file-notice';
import { OversizedFileNotice } from '@/components/workspace/diff-review/turn-edit-helpers';
import { InlineDocDiff } from '@/components/workspace/diff-review/inline-doc-diff';
import { CollabEditor, type PendingAddition } from '@/components/workspace/collab-editor';
import { CollabCodeEditor } from '@/components/workspace/collab-code-editor';
import { MarkdownToolbar } from '@/components/workspace/markdown-toolbar';
import type { TurnEditFile, TurnEditsResponse } from '@/lib/workspace/turn-edits';
import type { DiffChunk } from '@/components/workspace/diff-review/types';

const ANON_USER = { name: 'Anonymous', color: '#a8a29e' };

function fileEditorMode(filePath: string): 'markdown' | 'code' | 'unsupported' {
  if (PROSE_EXT.test(filePath)) return 'markdown';
  if (CODE_EXT.test(filePath)) return 'code';
  return 'unsupported';
}

const PROSE_EXT = /\.(md|mdx|txt)$/i;
const CODE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|rb|php|sh|sql|json|yaml|yml|toml|css|scss|html|xml)$/i;

type Screen = 'summary' | 'walkthrough' | 'done';

type FlatChunk = {
  file: TurnEditFile;
  chunkId: string;
};

function fileIconFor(path: string) {
  if (PROSE_EXT.test(path)) return FileText;
  if (CODE_EXT.test(path)) return FileCode;
  return FileIcon;
}

function fileSummaryCounts(file: TurnEditFile) {
  let adds = 0;
  let dels = 0;
  for (const c of file.chunks) {
    for (const l of c.lines) {
      if (l.type === 'addition') adds += 1;
      else if (l.type === 'deletion') dels += 1;
    }
  }
  return { adds, dels, chunks: file.chunks.length };
}

interface DiffReviewFlowProps {
  assistantMessageId: string;
  initialPayload: TurnEditsResponse;
  /** Workspace project id — required for the per-file editor preview to connect to the Sunny sandbox. */
  workspaceId?: string;
  /** Optional href for the "Open in workspace" affordance. */
  workspaceHref?: string | null;
  /** Hide Keep/Undo affordances (e.g. when the turn isn't latest or the workspace is view-only). */
  readOnly?: boolean;
  /** Heading line under the page title, e.g. "Diff · sundial-md". */
  eyebrow?: string;
  /** Mobile = max-w-md; desktop = max-w-3xl with always-visible counts in the header. */
  layout?: 'mobile' | 'desktop';
}

export function DiffReviewFlow({
  assistantMessageId,
  initialPayload,
  workspaceId,
  workspaceHref,
  readOnly = false,
  eyebrow = 'Diff review',
  layout = 'mobile',
}: DiffReviewFlowProps) {
  const [payload, setPayload] = useState<TurnEditsResponse>(initialPayload);
  // Single-chunk diffs are 90% of iMessage taps — skip the summary screen.
  // But any chunkless placeholder (blob/oversized) renders ONLY on the
  // summary: the chunk-driven walkthrough would skip it (blob-only payloads
  // would even fall straight through to "done"), so those stay on summary.
  const initialChunkCount = initialPayload.files.reduce((n, f) => n + f.chunks.length, 0);
  const hasChunklessFile = initialPayload.files.some((f) => f.blob || f.oversized);
  const initialScreen: Screen =
    initialChunkCount === 1 && !hasChunklessFile ? 'walkthrough' : 'summary';
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);

  const flat = useMemo<FlatChunk[]>(
    () =>
      payload.files.flatMap((file) =>
        file.chunks.map((chunk) => ({ file, chunkId: chunk.id })),
      ),
    [payload],
  );

  const total = flat.length;
  const current = flat[cursor] ?? null;

  const decidedCount = useMemo(
    () =>
      flat.filter((f) => {
        const file = payload.files.find((p) => p.filePath === f.file.filePath);
        const ch = file?.chunks.find((c) => c.id === f.chunkId);
        return ch && ch.status !== 'pending';
      }).length,
    [flat, payload],
  );

  const advance = useCallback(() => {
    if (cursor < total - 1) setCursor(cursor + 1);
    else setScreen('done');
  }, [cursor, total]);

  const jumpTo = useCallback((index: number) => {
    setCursor(Math.max(0, Math.min(total - 1, index)));
    setScreen('walkthrough');
  }, [total]);

  const keep = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/workspace/turn-edits/keep-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantMessageId,
          filePath: current.file.filePath,
          chunkIds: [current.chunkId],
          workspaceId,
        }),
      });
      if (res.ok) {
        const next = (await res.json()) as TurnEditsResponse;
        setPayload(next);
      }
    } finally {
      setBusy(false);
      setTimeout(advance, 180);
    }
  }, [current, assistantMessageId, workspaceId, advance, busy]);

  const undo = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/workspace/turn-edits/undo-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantMessageId,
          filePath: current.file.filePath,
          chunkId: current.chunkId,
          workspaceId,
        }),
      });
      if (res.ok) {
        const next = (await res.json()) as TurnEditsResponse;
        setPayload(next);
      }
    } finally {
      setBusy(false);
      setTimeout(advance, 200);
    }
  }, [current, assistantMessageId, workspaceId, advance, busy]);

  const start = () => {
    setScreen('walkthrough');
    setCursor(0);
  };
  const restart = () => {
    setCursor(0);
    setScreen('walkthrough');
  };

  if (payload.files.length === 0) {
    const widthClass = layout === 'desktop' ? 'max-w-3xl' : 'max-w-md';
    return (
      <div className={`mx-auto flex min-h-screen ${widthClass} flex-col px-5 pt-12 sm:pt-16`}>
        <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">
          {eyebrow}
        </div>
        <div className="mt-1 text-[22px] font-semibold leading-tight text-stone-900 sm:text-[26px]">
          All edits reviewed
        </div>
        <div className="mt-1 text-[13px] text-stone-500">
          Nothing left to review — every change in this turn has already been kept or undone.
        </div>
        {workspaceHref ? (
          <a
            href={workspaceHref}
            className="mt-6 inline-flex h-11 max-w-fit items-center gap-2 rounded-full border border-stone-200 bg-white px-5 text-[13px] font-medium text-stone-700 active:bg-stone-50"
          >
            Open workspace →
          </a>
        ) : null}
      </div>
    );
  }

  if (screen === 'summary') {
    return (
      <SummaryScreen
        files={payload.files}
        flat={flat}
        chunkCount={total}
        eyebrow={eyebrow}
        workspaceHref={workspaceHref}
        onStart={start}
        onJumpTo={jumpTo}
        layout={layout}
        decidedCount={decidedCount}
        projectId={payload.projectId ?? workspaceId}
      />
    );
  }
  if (screen === 'walkthrough' && current) {
    return (
      <WalkthroughScreen
        assistantMessageId={assistantMessageId}
        workspaceId={workspaceId}
        flat={flat}
        cursor={cursor}
        payload={payload}
        setPayload={setPayload}
        decidedCount={decidedCount}
        readOnly={readOnly}
        onKeep={keep}
        onUndo={undo}
        onPrev={() => setCursor((c) => Math.max(0, c - 1))}
        onNext={() => setCursor((c) => Math.min(total - 1, c + 1))}
        onBack={() => setScreen('summary')}
        onDone={() => setScreen('done')}
        layout={layout}
      />
    );
  }
  return (
    <DoneScreen
      decidedCount={decidedCount}
      total={total}
      onRestart={restart}
      onBack={() => setScreen('summary')}
      workspaceHref={workspaceHref}
      layout={layout}
    />
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function SummaryScreen({
  files,
  flat,
  chunkCount,
  eyebrow,
  workspaceHref,
  onStart,
  onJumpTo,
  layout,
  decidedCount,
  projectId,
}: {
  files: TurnEditFile[];
  flat: FlatChunk[];
  chunkCount: number;
  eyebrow: string;
  workspaceHref?: string | null;
  onStart: () => void;
  onJumpTo: (index: number) => void;
  layout: 'mobile' | 'desktop';
  decidedCount: number;
  projectId?: string | null;
}) {
  const widthClass = layout === 'desktop' ? 'max-w-3xl' : 'max-w-md';
  const pendingCount = chunkCount - decidedCount;
  return (
    <div className={`mx-auto flex min-h-screen ${widthClass} flex-col`}>
      <div className="flex items-start justify-between px-5 pb-3 pt-5 sm:pt-8">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">
            {eyebrow}
          </div>
          <div className="mt-0.5 flex items-baseline gap-3">
            <div className="text-[22px] font-semibold leading-tight text-stone-900 sm:text-[26px]">
              {chunkCount > 0
                ? `${chunkCount} ${chunkCount === 1 ? 'change' : 'changes'}`
                : `${files.length} ${files.length === 1 ? 'file' : 'files'}`}
            </div>
            <div className="text-[13px] text-stone-500">
              {decidedCount > 0 ? <span className="text-emerald-600">{decidedCount} decided</span> : null}
              {decidedCount > 0 && pendingCount > 0 ? ' · ' : null}
              {pendingCount > 0 ? <span>{pendingCount} unreviewed</span> : null}
            </div>
          </div>
        </div>
        {workspaceHref ? (
          <a
            href={workspaceHref}
            className="text-[12px] text-stone-500 underline-offset-2 hover:text-stone-800 hover:underline"
          >
            Open workspace →
          </a>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {files.map((file) => {
          const { adds, dels } = fileSummaryCounts(file);
          const Icon = fileIconFor(file.filePath);
          return (
            <div key={file.id} className="mb-4">
              <div className="mb-1.5 flex items-center gap-2 px-1 text-stone-700">
                <Icon weight="regular" className="h-3.5 w-3.5 text-stone-500" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.filePath}</span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-stone-500">
                  {adds > 0 ? <span className="text-emerald-600">+{adds}</span> : null}
                  {dels > 0 ? <span className="text-red-500">−{dels}</span> : null}
                  {file.isNew ? (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 text-[10px] font-medium text-emerald-700">new</span>
                  ) : null}
                </span>
              </div>
              <ul className="divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200 bg-white">
                {/* Chunkless placeholders — a binary or an over-budget file the
                    turn touched. Nothing to walk through; show the notice. */}
                {file.blob ? (
                  <li className="px-2 py-2">
                    <BlobFileNotice file={file} projectId={projectId} />
                  </li>
                ) : null}
                {file.oversized ? (
                  <li className="px-2 py-2">
                    <OversizedFileNotice file={file} />
                  </li>
                ) : null}
                {file.chunks.map((chunk) => {
                  const flatIndex = flat.findIndex(
                    (f) => f.file.id === file.id && f.chunkId === chunk.id,
                  );
                  return (
                    <li key={chunk.id}>
                      <button
                        type="button"
                        onClick={() => onJumpTo(flatIndex)}
                        className="flex w-full items-stretch gap-2 px-2 py-2 text-left active:bg-stone-50"
                      >
                        <ChunkPreview chunk={chunk} />
                        <div className="flex shrink-0 flex-col items-end justify-center gap-1 pr-1">
                          <ChunkStatusBadge status={chunk.status} />
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-stone-200 bg-white px-4 pb-6 pt-3">
        {chunkCount > 0 ? (
          <button
            type="button"
            onClick={onStart}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-stone-900 text-[14px] font-semibold text-white shadow-sm transition-opacity active:opacity-90"
          >
            {pendingCount > 0 ? 'Review remaining' : 'Open first change'}
            <ArrowRight weight="bold" className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ChunkPreview({ chunk }: { chunk: DiffChunk }) {
  const additions = chunk.lines.filter((l) => l.type === 'addition');
  const deletions = chunk.lines.filter((l) => l.type === 'deletion');
  const addText = additions.map((l) => l.content).join(' ').trim();
  const delText = deletions.map((l) => l.content).join(' ').trim();
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
  return (
    <div className="min-w-0 flex-1 space-y-0.5 text-[12px] leading-snug">
      {delText ? (
        <div className="diff-tone-del truncate" title={delText}>
          <span className="mr-1 select-none text-red-500">−</span>
          {truncate(delText, 80)}
        </div>
      ) : null}
      {addText ? (
        <div className="diff-tone-add truncate" title={addText}>
          <span className="mr-1 select-none text-emerald-600">+</span>
          {truncate(addText, 80)}
        </div>
      ) : null}
      {!addText && !delText ? (
        <div className="truncate text-stone-400">(empty edit)</div>
      ) : null}
    </div>
  );
}

function ChunkStatusBadge({ status }: { status: DiffChunk['status'] }) {
  if (status === 'kept') {
    return (
      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        kept
      </span>
    );
  }
  if (status === 'undone') {
    return (
      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
        undone
      </span>
    );
  }
  return (
    <CaretUp weight="bold" className="h-3.5 w-3.5 rotate-90 text-stone-400" />
  );
}

// ---------------------------------------------------------------------------
// Walkthrough
// ---------------------------------------------------------------------------

function WalkthroughScreen({
  assistantMessageId,
  workspaceId,
  flat,
  cursor,
  payload,
  setPayload,
  decidedCount,
  readOnly,
  onKeep,
  onUndo,
  onPrev,
  onNext,
  onBack,
  onDone,
  layout,
}: {
  assistantMessageId: string;
  workspaceId?: string;
  flat: FlatChunk[];
  cursor: number;
  payload: TurnEditsResponse;
  setPayload: (next: TurnEditsResponse) => void;
  decidedCount: number;
  readOnly: boolean;
  onKeep: () => void;
  onUndo: () => void;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
  onDone: () => void;
  layout: 'mobile' | 'desktop';
}) {
  const current = flat[cursor];
  const total = flat.length;
  const isFirst = cursor === 0;
  const isLast = cursor === total - 1;
  const liveFile = payload.files.find((f) => f.filePath === current.file.filePath);
  const liveChunk = liveFile?.chunks.find((c) => c.id === current.chunkId) ?? null;
  const status = liveChunk?.status ?? 'pending';
  const mode = fileEditorMode(current.file.filePath);
  // Without a DB `files.id` in dev's model, docName is keyed by file path against the
  // Sunny sandbox collab server. Passing `filePath` as `fileId` keeps CollabEditor happy.
  const fileId = workspaceId ? current.file.filePath : liveFile?.fileId ?? null;

  // Build pendingAdditions for the current file — each addition turns into an
  // in-editor green highlight on the matching block. canMutate is always false
  // here so the inline Keep/Undo widget doesn't render: this surface drives
  // those actions from the bottom action bar instead, to avoid duplicate UI.
  const pendingAdditionsForFile = useMemo<PendingAddition[]>(() => {
    if (!liveFile) return [];
    const out: PendingAddition[] = [];
    for (const chunk of liveFile.chunks) {
      if (chunk.status !== 'pending') continue;
      const text = chunk.lines
        .filter((l) => l.type === 'addition')
        .map((l) => l.content)
        .join('\n');
      const deletedText = chunk.lines
        .filter((l) => l.type === 'deletion')
        .map((l) => l.content)
        .join('\n');
      // Keep deletion-only chunks too: they carry no addition text but still
      // need to scope the live ledger to THIS turn, else a deletion-only review
      // leaves the ledger unfiltered and leaks another turn's highlights. (Codex P2)
      if (!text.trim() && !deletedText.trim()) continue;
      out.push({
        key: `${assistantMessageId}:${chunk.id}`,
        text,
        deletedText: deletedText.trim() ? deletedText : undefined,
        canMutate: false,
        // The code editor scopes the live ledger to the reviewed turn by this id;
        // without it the read-only review would filter out every ledger chunk and
        // show no highlights once the ledger is on. (Codex P2)
        assistantMessageId,
      });
    }
    return out;
  }, [liveFile, assistantMessageId]);

  // Inline-widget callbacks: when the user clicks Keep/Undo on a highlighted block
  // inside the editor, route through the same endpoints as the floating buttons.
  const onKeepInEditor = useCallback(
    async (key: string) => {
      const [, chunkId] = key.split(':');
      if (!chunkId) return;
      const targetFile = payload.files.find((f) => f.chunks.some((c) => c.id === chunkId));
      if (!targetFile) return;
      try {
        const res = await fetch('/api/workspace/turn-edits/keep-chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assistantMessageId,
            filePath: targetFile.filePath,
            chunkIds: [chunkId],
          }),
        });
        if (res.ok) setPayload(await res.json());
      } catch {
        /* swallow */
      }
    },
    [payload, assistantMessageId, setPayload],
  );

  const onUndoInEditor = useCallback(
    async (key: string) => {
      const [, chunkId] = key.split(':');
      if (!chunkId) return;
      const targetFile = payload.files.find((f) => f.chunks.some((c) => c.id === chunkId));
      if (!targetFile) return;
      try {
        const res = await fetch('/api/workspace/turn-edits/undo-chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assistantMessageId,
            filePath: targetFile.filePath,
            chunkId,
          }),
        });
        if (res.ok) setPayload(await res.json());
      } catch {
        /* swallow */
      }
    },
    [payload, assistantMessageId, setPayload],
  );

  // Auto-scroll the highlighted block of the current chunk into view when cursor changes.
  // Polls until the element exists, since file switches remount the editor and the
  // PendingAdditionsExtension only paints highlights after Yjs loads the snapshot.
  useEffect(() => {
    const key = `${assistantMessageId}:${current.chunkId}`;
    let cancelled = false;
    let attempts = 0;
    const tryScroll = () => {
      if (cancelled) return;
      const el = document.querySelector(`[data-diff-key="${CSS.escape(key)}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      attempts += 1;
      if (attempts < 30) setTimeout(tryScroll, 100);
    };
    const initial = setTimeout(tryScroll, 150);
    return () => {
      cancelled = true;
      clearTimeout(initial);
    };
  }, [assistantMessageId, current.chunkId, fileId]);

  const widthClass = layout === 'desktop' ? 'max-w-3xl' : 'max-w-md';
  return (
    <div className={`mx-auto flex min-h-screen ${widthClass} flex-col bg-white`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100"
        >
          <ArrowLeft weight="bold" className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] text-stone-800">
            {current.file.filePath}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-stone-400">
            Edit {cursor + 1} / {total} · {decidedCount} decided
          </div>
        </div>
        <button
          type="button"
          onClick={onDone}
          aria-label="Finish review"
          className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100"
        >
          <CheckCircle weight="bold" className="h-4 w-4" />
        </button>
      </div>

      <div className="h-1 shrink-0 bg-stone-200">
        <div
          className="h-full bg-stone-900 transition-all"
          style={{ width: `${((cursor + 1) / total) * 100}%` }}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {fileId && mode === 'markdown' ? (
          <div className="px-4 py-3">
            <CollabEditor
              key={fileId}
              fileId={fileId}
              filePath={current.file.filePath}
              workspaceId={workspaceId}
              user={ANON_USER}
              readOnly={readOnly}
              pendingAdditions={pendingAdditionsForFile}
              onKeepAddition={onKeepInEditor}
              onUndoAddition={onUndoInEditor}
            />
          </div>
        ) : fileId && mode === 'code' ? (
          <div className="px-3 py-3">
            <CollabCodeEditor
              key={fileId}
              fileId={fileId}
              filePath={current.file.filePath}
              workspaceId={workspaceId}
              user={ANON_USER}
              readOnly={readOnly}
              pendingAdditions={pendingAdditionsForFile}
              onKeepAddition={onKeepInEditor}
              onUndoAddition={onUndoInEditor}
            />
          </div>
        ) : liveChunk ? (
          <div className="px-4 py-4">
            <InlineDocDiff
              chunk={liveChunk}
              filePath={current.file.filePath}
              onKeep={onKeep}
              onUndo={onUndo}
              hideButtons
            />
          </div>
        ) : (
          <div className="px-4 py-4 text-sm text-stone-500">Chunk not found.</div>
        )}
      </div>

      <div className="shrink-0 border-t border-stone-200 bg-white px-3 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrev}
            disabled={isFirst}
            aria-label="Previous edit"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-600 active:bg-stone-100 disabled:opacity-30"
          >
            <CaretUp weight="bold" className="h-4 w-4" />
          </button>
          {!readOnly ? (
            <>
              <button
                type="button"
                onClick={onUndo}
                disabled={status === 'undone'}
                aria-label="Undo this edit"
                className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-full text-[13px] font-medium transition-colors disabled:opacity-50 ${
                  status === 'undone'
                    ? 'bg-stone-700 text-white'
                    : 'border border-stone-200 bg-white text-stone-700 active:bg-stone-50'
                }`}
              >
                <ArrowCounterClockwise weight="bold" className="h-4 w-4" />
                Undo
              </button>
              <button
                type="button"
                onClick={onKeep}
                disabled={status === 'kept'}
                aria-label="Keep this edit"
                className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-full text-[13px] font-semibold transition-colors disabled:opacity-50 ${
                  status === 'kept'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-stone-900 text-white active:bg-stone-800'
                }`}
              >
                <Check weight="bold" className="h-4 w-4" />
                Keep
              </button>
            </>
          ) : (
            <div className="flex h-11 flex-1 items-center justify-center text-[12px] text-stone-400">
              Read-only
            </div>
          )}
          <button
            type="button"
            onClick={onNext}
            disabled={isLast}
            aria-label="Next edit"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-600 active:bg-stone-100 disabled:opacity-30"
          >
            <CaretDown weight="bold" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

function DoneScreen({
  decidedCount,
  total,
  onRestart,
  onBack,
  workspaceHref,
  layout,
}: {
  decidedCount: number;
  total: number;
  onRestart: () => void;
  onBack: () => void;
  workspaceHref?: string | null;
  layout: 'mobile' | 'desktop';
}) {
  const widthClass = layout === 'desktop' ? 'max-w-3xl' : 'max-w-md';
  const allDecided = decidedCount >= total;
  const noneDecided = decidedCount === 0;
  const headline = allDecided
    ? 'Review complete'
    : noneDecided
      ? 'Closed without deciding'
      : 'Review paused';
  const iconBg = allDecided ? 'bg-emerald-50 text-emerald-600 ring-emerald-100' : 'bg-stone-100 text-stone-500 ring-stone-200';
  return (
    <div className={`mx-auto flex min-h-screen ${widthClass} flex-col`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to summary"
          className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100"
        >
          <ArrowLeft weight="bold" className="h-4 w-4" />
        </button>
        <div className="flex-1 text-center text-[13px] font-semibold text-stone-800">Done</div>
        <div className="w-9" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <div className={`flex h-16 w-16 items-center justify-center rounded-full ring-4 ${iconBg}`}>
          <CheckCircle weight={allDecided ? 'fill' : 'regular'} className="h-8 w-8" />
        </div>
        <div className="mt-4 text-[20px] font-semibold text-stone-900">{headline}</div>
        <div className="mt-1 text-[13px] text-stone-500">
          {decidedCount} of {total} decided
          {!allDecided && total - decidedCount > 0
            ? ` · ${total - decidedCount} unreviewed`
            : ''}
        </div>
        <div className="mt-6 flex w-full flex-col gap-2">
          <button
            type="button"
            onClick={onRestart}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-stone-900 text-[13px] font-semibold text-white active:opacity-90"
          >
            Review again
          </button>
          {workspaceHref ? (
            <a
              href={workspaceHref}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-full border border-stone-200 bg-white text-[13px] font-medium text-stone-700 active:bg-stone-50"
            >
              Open workspace
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
