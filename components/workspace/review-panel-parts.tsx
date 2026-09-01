'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CaretDownIcon,
  CaretRightIcon,
  ChatCircleIcon,
  CheckIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  FunnelIcon,
  XIcon,
} from '@phosphor-icons/react';
import { Spinner } from '@/components/ui/spinner';
import { InlineDocDiff } from '@/components/workspace/diff-review/inline-doc-diff';
import { isMarkdownFile } from '@/lib/sync/policy';
import { readJsonResponse } from '@/lib/http/read-json-response';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import { buildInlineDiff, type InlineDiffLine } from '@/lib/workspace/history-diff';
import { collapseContext } from '@/lib/workspace/review-range';
import { activeFilterCount, deriveFolders, isEmptyFilter, summarizeFilter, type ReviewFilter, type WhenFilter } from '@/lib/workspace/review-filters';
import type { SnapshotFileDiff } from '@/lib/workspace/api-shared-types';
import { ANON_PREFIX, type ChangeAuthorKind } from '@/lib/workspace/workspace-changes';

const AUTHOR_KIND_LABEL: Record<ChangeAuthorKind, string> = { sunny: 'Sundial Agent', local_agent: 'local agents', human: 'you & humans' };
const toggle = <T,>(arr: T[], value: T): T[] => (arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]);
const parentFolderOf = (path: string | null | undefined): string | null => {
  if (!path) return null;
  const i = path.lastIndexOf('/');
  return i > 0 ? `${path.slice(0, i)}/` : null;
};
const baseName = (path: string) => path.split('/').pop() || path;

/** Verb button for the change/range detail header (Restore · Ask · Undo · Keep).
 *  Bordered so it unmistakably reads as a button — flat (no shadow), with the
 *  one primary action filled. */
export function ActionBtn({
  testId,
  onClick,
  title,
  primary,
  children,
}: {
  testId: string;
  onClick: () => void;
  title?: string;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium transition-colors ${
        primary
          ? 'border-stone-800 bg-stone-800 text-white hover:bg-stone-900'
          : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-50 hover:text-stone-800'
      }`}
    >
      {children}
    </button>
  );
}

function DiffLineRow({ line, plain }: { line: InlineDiffLine; plain?: boolean }) {
  const tone = plain
    ? 'text-stone-600'
    : line.type === 'added'
      ? 'bg-emerald-50 text-emerald-900'
      : line.type === 'removed'
        ? 'bg-rose-50 text-rose-900'
        : 'text-stone-500';
  return (
    <pre className={`whitespace-pre-wrap break-words px-3 py-0.5 font-mono text-[11.5px] leading-5 ${tone}`}>
      {!plain ? (
        <span className="mr-1.5 select-none text-stone-300">
          {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
        </span>
      ) : null}
      {line.text || ' '}
    </pre>
  );
}

/** Fetch a JSON payload with unmount-cancellation — the one loading shape every
 *  review detail shares (run, applied edit, compare). `null` url = don't fetch. */
export function useFetchJson<T>(url: string | null): { data: T | null; error: string | null } {
  const apiFetch = useApiFetch();
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setState({ data: null, error: null });
    void (async () => {
      try {
        const res = await apiFetch(url, { cache: 'no-store' });
        const json = await readJsonResponse<T & { error?: string }>(res);
        if (cancelled) return;
        if (!res.ok || !json) throw new Error(json?.error || `Failed to load (${res.status})`);
        setState({ data: json, error: null });
      } catch (nextError) {
        if (!cancelled) setState({ data: null, error: nextError instanceof Error ? nextError.message : 'Failed to load' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, apiFetch]);
  return state;
}

/** One file's before→after diff for a historical compare — read-only, with a
 *  context-collapsed view and an "Open full file" expansion. */
// Long all-additions markdown compares (new file / full rewrite) cap here when
// collapsed — "Open full file" shows the rest.
const MD_COMPARE_MAX_LINES = 40;

function RangeFileCard({ file }: { file: SnapshotFileDiff }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => buildInlineDiff(file.beforeText, file.afterText), [file.beforeText, file.afterText]);
  const segments = useMemo(() => collapseContext(lines, 2), [lines]);
  const added = lines.filter((l) => l.type === 'added').length;
  const removed = lines.filter((l) => l.type === 'removed').length;
  // Markdown renders as REAL rich markdown with change marks (same renderer as
  // the pending/applied paths — InlineDocDiff), not monospace +/- lines; code
  // and LaTeX keep the line diff below. Collapsed markdown shows the CHANGED
  // hunks (the same context-collapsed segments as the code path — never a head
  // slice that could hide every change), capped across hunks for huge rewrites.
  const markdown = isMarkdownFile(file.path);
  const mdChunk = (chunkLines: InlineDiffLine[], key: number | string) => ({
    id: `compare-${file.path}-${key}`,
    status: 'kept' as const,
    oldStart: 1,
    oldEnd: 1,
    newStart: 1,
    newEnd: chunkLines.length,
    lines: chunkLines.map((line, i) => ({
      type: line.type === 'added' ? ('addition' as const) : line.type === 'removed' ? ('deletion' as const) : ('context' as const),
      content: line.text,
      lineNumber: i + 1,
    })),
  });
  const mdSegments = useMemo(() => {
    if (!markdown) return null;
    if (expanded) return [{ kind: 'lines' as const, lines }];
    let budget = MD_COMPARE_MAX_LINES;
    const out: typeof segments = [];
    for (const seg of segments) {
      if (seg.kind === 'gap') { out.push(seg); continue; }
      if (budget <= 0) break;
      out.push(seg.lines.length <= budget ? seg : { kind: 'lines', lines: seg.lines.slice(0, budget) });
      budget -= seg.lines.length;
    }
    return out;
  }, [markdown, expanded, lines, segments]);
  const mdTruncated = markdown && !expanded && segments.filter((s) => s.kind === 'lines').reduce((n, s) => n + (s.kind === 'lines' ? s.lines.length : 0), 0) > MD_COMPARE_MAX_LINES;
  return (
    <article data-testid={`diff-file-${file.path}`} className="overflow-hidden rounded-xl border border-stone-200">
      <header className="flex items-center gap-2 border-b border-stone-100 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-stone-700">{file.path}</span>
        {added > 0 ? <span className="text-[10px] text-emerald-600">+{added}</span> : null}
        {removed > 0 ? <span className="text-[10px] text-rose-600">−{removed}</span> : null}
        <button
          type="button"
          data-testid={`open-file-${file.path}`}
          onClick={() => setExpanded((v) => !v)}
          className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700"
        >
          {expanded ? 'Hide file' : 'Open full file'}
          {expanded ? <CaretDownIcon className="h-3 w-3" /> : <CaretRightIcon className="h-3 w-3" />}
        </button>
      </header>
      {mdSegments ? (
        <div className="prose prose-sm max-w-none px-4 py-3">
          {mdSegments.map((seg, i) =>
            seg.kind === 'gap' ? (
              <button
                key={i}
                type="button"
                onClick={() => setExpanded(true)}
                className="block w-full py-1 text-left text-[10px] text-stone-400 hover:bg-stone-100"
              >
                ··· {seg.count} unchanged {seg.count === 1 ? 'line' : 'lines'} ···
              </button>
            ) : (
              <InlineDocDiff key={i} chunk={mdChunk(seg.lines, i)} filePath={file.path} renderAsMarks hideButtons onKeep={() => {}} onUndo={() => {}} />
            ),
          )}
          {mdTruncated ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 w-full rounded-md border border-stone-200 px-3 py-1.5 text-[12px] font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              Show all {lines.length} lines
            </button>
          ) : null}
        </div>
      ) : expanded ? (
        lines.map((line, i) => <DiffLineRow key={i} line={line} />)
      ) : (
        segments.map((seg, i) =>
          seg.kind === 'gap' ? (
            <button
              key={i}
              type="button"
              onClick={() => setExpanded(true)}
              className="block w-full px-3 py-1 text-left text-[10px] text-stone-400 hover:bg-stone-100"
            >
              ··· {seg.count} unchanged {seg.count === 1 ? 'line' : 'lines'} ···
            </button>
          ) : (
            <div key={i}>{seg.lines.map((line, j) => <DiffLineRow key={j} line={line} />)}</div>
          ),
        )
      )}
    </article>
  );
}

type CompareResponse = { from: number | null; to: number | null; files: SnapshotFileDiff[]; error?: string };

/**
 * Read-only "compare two states" detail. Fetches the real history/compare diff
 * for the [from, to] `doc_edits.id` span and renders it as inline file diffs,
 * with a "From … → …" caption and an Ask-Sunny handoff.
 */
export function RangeCompareDetail({
  workspaceId,
  from,
  to,
  scopeToPath,
}: {
  workspaceId: string;
  from: number | null;
  to: number;
  /** When set, only diffs whose path passes are shown (the panel's file/folder
   *  filter); the rest fold into an "N files outside the filter" note. */
  scopeToPath?: (path: string) => boolean;
}) {
  const params = new URLSearchParams({ projectId: workspaceId, to: String(to) });
  if (from != null) params.set('from', String(from));
  const { data, error } = useFetchJson<CompareResponse>(`/api/workspace/history/compare?${params.toString()}`);

  return (
    // The from→to span lives in the header's compare row (the editable
    // dropdowns) and the read-only marker + Ask live in the panel's detail
    // header — this is content only.
    <div data-testid="range-compare-detail" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <div className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">{error}</div>
        ) : !data ? (
          <div className="px-1 py-4"><Spinner label="Comparing versions…" /></div>
        ) : (() => {
          const shown = scopeToPath ? data.files.filter((file) => scopeToPath(file.path)) : data.files;
          const hidden = data.files.length - shown.length;
          return shown.length === 0 ? (
            <div className="rounded-xl border border-dashed border-stone-200 px-4 py-10 text-center text-[13px] text-stone-400">
              {hidden > 0
                ? `Nothing changed in the current filter. ${hidden} changed ${hidden === 1 ? 'file is' : 'files are'} outside it.`
                : 'Nothing changed between these two points.'}
            </div>
          ) : (
            <div className="space-y-3">
              {shown.map((file) => (
                <RangeFileCard key={file.path} file={file} />
              ))}
              {hidden > 0 ? (
                <div data-testid="compare-scope-note" className="px-1 text-[11px] text-stone-400">
                  {hidden} changed {hidden === 1 ? 'file' : 'files'} outside the current filter not shown.
                </div>
              ) : null}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Filter bar — one-click quick picks + an Advanced panel for the rest
 * ------------------------------------------------------------------ */

type Item = { value: string; label: string };

function QuickPick({ active, onClick, title, testId, children }: { active: boolean; onClick: () => void; title?: string; testId?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] transition-colors ${
        active ? 'bg-stone-200 font-medium text-stone-800' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
      }`}
    >
      {children}
    </button>
  );
}

function CheckRow({ label, checked, onToggle, testId }: { label: string; checked: boolean; onToggle: () => void; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={checked}
      onClick={onToggle}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors ${
        checked ? 'text-stone-800' : 'text-stone-500 hover:bg-stone-100'
      }`}
    >
      <span className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${checked ? 'border-stone-700 bg-stone-700 text-white' : 'border-stone-300'}`}>
        {checked ? <CheckIcon className="h-2.5 w-2.5" weight="bold" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-stone-400">{title}</div>
      <div className="max-h-40 overflow-auto">{children}</div>
    </div>
  );
}

/** Compact inline dropdown for the compare row — sizes to the *selected* label
 *  (a native <select> sizes to its widest option, leaving a gap before the
 *  caret). The trigger keeps the `compare-from` / `compare-to` testid. */
function InlineSelect({ testId, ariaLabel, value, options, onChange }: { testId: string; ariaLabel: string; value: string; options: Item[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  const current = options.find((o) => o.value === value);
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-stone-700 transition-colors hover:bg-stone-100"
      >
        <span className="max-w-[12rem] truncate">{current?.label ?? value}</span>
        <CaretDownIcon className="h-3 w-3 shrink-0 text-stone-400" />
      </button>
      {open ? (
        <div role="listbox" className="absolute left-0 top-full z-30 mt-1 max-h-60 min-w-[10rem] overflow-auto rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              data-testid={`${testId}-opt-${o.value}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`block w-full px-2.5 py-1 text-left text-[12px] transition-colors ${
                o.value === value ? 'bg-stone-100 font-medium text-stone-800' : 'text-stone-600 hover:bg-stone-50'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

export function ReviewFilterBar({
  filter,
  onChange,
  currentChatId,
  currentUserId,
  activeFilePath,
  files,
  chats,
  counts,
  agents,
  people,
  points,
  fromValue,
  toValue,
  onFromChange,
  onToChange,
  compareRevealed,
  onCompareToggle,
  onClose,
}: {
  filter: ReviewFilter;
  onChange: (next: ReviewFilter) => void;
  currentChatId: string | null;
  /** The signed-in (or anon) author id — powers the "Me" quick pick. */
  currentUserId?: string | null;
  activeFilePath?: string | null;
  files: string[];
  chats: { id: string; title: string }[];
  counts: Record<ChangeAuthorKind, number>;
  agents: { id: string; name: string }[];
  people: { id: string; name: string }[];
  points: Item[];
  fromValue: string;
  toValue: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  /** Whether the from/to dropdown row is revealed (owned by the panel so Back can
   *  collapse it). The row also shows whenever a span is active. */
  compareRevealed: boolean;
  /** Toggle the compare row: reveal it, or (when shown) reset + collapse it. */
  onCompareToggle: () => void;
  /** Close the review column (rendered as an X to the right of the Filter icon). */
  onClose?: () => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const set = (patch: Partial<ReviewFilter>) => onChange({ ...filter, ...patch });
  const clearAll = () => onChange({ paths: [], folders: [], chats: [], authorKinds: [], authorIds: [], when: { kind: 'any' }, checkpointsOnly: false });

  const currentFolder = parentFolderOf(activeFilePath);
  const folders = useMemo(() => deriveFolders(files), [files]);
  const chatName = (id: string) => (id === currentChatId ? 'current chat' : chats.find((c) => c.id === id)?.title ?? 'a chat');
  const authorName = (id: string) => [...agents, ...people].find((a) => a.id === id)?.name ?? id;
  const summary = summarizeFilter(filter, { chatName, authorName, authorKindLabel: (k) => AUTHOR_KIND_LABEL[k] });
  const empty = isEmptyFilter(filter);
  const activeCount = activeFilterCount(filter);
  const isToday = filter.when.kind === 'preset' && filter.when.value === 'today';
  const setWhenPreset = (value: 'today' | 'week' | 'month') =>
    set({ when: filter.when.kind === 'preset' && filter.when.value === value ? { kind: 'any' } : { kind: 'preset', value } });
  const customRange = filter.when.kind === 'range' ? filter.when : null;
  const setRange = (patch: Partial<WhenFilter & { from?: string; to?: string }>) => {
    const base = customRange ?? { kind: 'range' as const };
    set({ when: { kind: 'range', from: base.from, to: base.to, ...patch } as WhenFilter });
  };
  const visibleFiles = files.filter((f) => f.toLowerCase().includes(fileSearch.toLowerCase()));
  // People split: named humans individually ("Me" first); anonymous visitors
  // (anon: id prefix — never the display name, which real-but-unresolved users
  // can share) fold into ONE "Anonymous" toggle; unresolved identities (the
  // "Someone" server fallback) fold into a separate "Unknown" toggle so they're
  // neither mislabeled anonymous nor a column of identical rows. Quick picks
  // show Me + the latest two named others.
  const anonIds = people.filter((p) => p.id.startsWith(ANON_PREFIX)).map((p) => p.id);
  const unknownIds = people.filter((p) => !p.id.startsWith(ANON_PREFIX) && p.name === 'Someone').map((p) => p.id);
  const namedPeople = people.filter((p) => !p.id.startsWith(ANON_PREFIX) && p.name !== 'Someone');
  const groupOn = (ids: string[]) => ids.length > 0 && ids.every((id) => filter.authorIds.includes(id));
  const toggleGroup = (ids: string[]) =>
    set({
      authorIds: groupOn(ids)
        ? filter.authorIds.filter((id) => !ids.includes(id))
        : [...new Set([...filter.authorIds, ...ids])],
    });
  const quickPeople = namedPeople.filter((p) => p.id !== currentUserId).slice(0, 2);
  // Compare is tucked away by default: the header is just "Review {summary}". The
  // from/to span reveals on the Compare toggle (or stays open while a span is set
  // — including one started from a session row, so the toggle always reflects it).
  const comparing = fromValue !== 'start' || toValue !== 'now';
  const showCompare = compareRevealed || comparing;

  return (
    <div data-testid="review-filter-bar" className="shrink-0 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
        <span className="font-medium text-stone-800">Review</span>
        {/* The scope summary is the primary, discoverable way to change what
            you're reviewing — a flat chip that opens the same filter editor as
            the sliders icon. */}
        <button
          type="button"
          data-testid="review-summary"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((v) => !v)}
          title="Change what you're reviewing"
          className="inline-flex items-center gap-1 rounded-md bg-stone-100 px-2 py-0.5 text-stone-600 transition-colors hover:bg-stone-200 hover:text-stone-800"
        >
          <span className="max-w-[16rem] truncate">{summary}</span>
          <CaretDownIcon className="h-3 w-3 shrink-0 text-stone-400" />
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="compare-toggle"
            aria-pressed={showCompare}
            onClick={onCompareToggle}
            title="Compare two points in the timeline"
            className={`rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
              showCompare ? 'bg-stone-200 text-stone-800' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
            }`}
          >
            Compare
          </button>
          <button
            type="button"
            data-testid="filters-toggle"
            aria-pressed={filtersOpen}
            onClick={() => setFiltersOpen((v) => !v)}
            title="Filter changes"
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] transition-colors ${
              filtersOpen || activeCount ? 'bg-stone-200 text-stone-800' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
            }`}
          >
            <FunnelIcon className="h-3.5 w-3.5" />
            {activeCount ? <span className="tabular-nums">{activeCount}</span> : null}
          </button>
          {onClose ? (
            <button
              type="button"
              data-testid="review-column-close"
              onClick={onClose}
              aria-label="Close review"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
            >
              <XIcon className="h-4 w-4" weight="bold" />
            </button>
          ) : null}
        </div>
      </div>

      {showCompare ? (
        <div data-testid="review-compare" className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-stone-500">
          <span className="text-stone-400">from</span>
          <InlineSelect testId="compare-from" ariaLabel="Compare from" value={fromValue} options={points} onChange={onFromChange} />
          <span className="text-stone-400">to</span>
          <InlineSelect testId="compare-to" ariaLabel="Compare to" value={toValue} options={points} onChange={onToChange} />
        </div>
      ) : null}

      {filtersOpen ? (
        <div data-testid="review-advanced" className="mt-2 space-y-3 rounded-lg border border-stone-200 bg-stone-50/60 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <QuickPick testId="qp-everything" active={empty} onClick={clearAll}>Everything</QuickPick>
            {currentChatId ? (
              <QuickPick testId="qp-chat" active={filter.chats.includes(currentChatId)} onClick={() => set({ chats: toggle(filter.chats, currentChatId) })} title="Changes made in the chat you have open">
                <ChatCircleIcon className="h-3.5 w-3.5" /> current chat
              </QuickPick>
            ) : null}
            {currentFolder ? (
              <QuickPick testId="qp-folder" active={filter.folders.includes(currentFolder)} onClick={() => set({ folders: toggle(filter.folders, currentFolder) })} title="Changes in this folder">
                <FolderIcon className="h-3.5 w-3.5" /> {baseName(currentFolder.replace(/\/$/, ''))}/
              </QuickPick>
            ) : null}
            {activeFilePath ? (
              <QuickPick testId="qp-file" active={filter.paths.includes(activeFilePath)} onClick={() => set({ paths: toggle(filter.paths, activeFilePath) })} title="Changes in this file">
                <FileIcon className="h-3.5 w-3.5" /> {baseName(activeFilePath)}
              </QuickPick>
            ) : null}
            <QuickPick testId="qp-today" active={isToday} onClick={() => setWhenPreset('today')} title="Changes from today">
              <ClockIcon className="h-3.5 w-3.5" /> today
            </QuickPick>
            <span className="mx-0.5 h-4 w-px bg-stone-200" />
            {/* Author quick picks: Sunny, then Me + the latest two named people
                (specific-author toggles) — an aggregate "You & humans" chip told
                you nothing about WHO. Local agents keeps its kind toggle. */}
            <QuickPick testId="qp-author-sunny" active={filter.authorKinds.includes('sunny')} onClick={() => set({ authorKinds: toggle(filter.authorKinds, 'sunny') })}>
              Sunny
              {counts.sunny > 0 ? <span className="ml-1 tabular-nums text-stone-400">{counts.sunny}</span> : null}
            </QuickPick>
            {currentUserId ? (
              <QuickPick testId="qp-me" active={filter.authorIds.includes(currentUserId)} onClick={() => set({ authorIds: toggle(filter.authorIds, currentUserId) })} title="Changes by you">
                Me
              </QuickPick>
            ) : null}
            {quickPeople.map((p) => (
              <QuickPick key={p.id} testId={`qp-person-${p.id}`} active={filter.authorIds.includes(p.id)} onClick={() => set({ authorIds: toggle(filter.authorIds, p.id) })} title={`Changes by ${p.name}`}>
                {p.name}
              </QuickPick>
            ))}
            {counts.local_agent > 0 || agents.length > 0 || filter.authorKinds.includes('local_agent') ? (
              <QuickPick testId="qp-author-local_agent" active={filter.authorKinds.includes('local_agent')} onClick={() => set({ authorKinds: toggle(filter.authorKinds, 'local_agent') })}>
                Local agents
                <span className="ml-1 tabular-nums text-stone-400">{counts.local_agent}</span>
              </QuickPick>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-stone-200 pt-2.5 sm:grid-cols-3">
            <Section title="Chats">
              {chats.length === 0 ? <div className="px-2 text-[11px] text-stone-400">No chats</div> : null}
              {chats.map((c) => <CheckRow key={c.id} testId={`adv-chat-${c.id}`} label={c.title} checked={filter.chats.includes(c.id)} onToggle={() => set({ chats: toggle(filter.chats, c.id) })} />)}
            </Section>
            <Section title="Folders">
              {folders.length === 0 ? <div className="px-2 text-[11px] text-stone-400">No folders</div> : null}
              {folders.map((f) => <CheckRow key={f} testId={`adv-folder-${f}`} label={f} checked={filter.folders.includes(f)} onToggle={() => set({ folders: toggle(filter.folders, f) })} />)}
            </Section>
            <Section title="Files">
              <input value={fileSearch} onChange={(e) => setFileSearch(e.target.value)} placeholder="Search files…" className="mb-1 w-full rounded-md border border-stone-200 bg-white px-2 py-1 text-[12px] focus:border-orange-400 focus:outline-none" />
              {visibleFiles.map((f) => <CheckRow key={f} testId={`adv-file-${f}`} label={f} checked={filter.paths.includes(f)} onToggle={() => set({ paths: toggle(filter.paths, f) })} />)}
            </Section>
            <Section title="Local agents">
              {agents.length === 0 ? <div className="px-2 text-[11px] text-stone-400">None yet</div> : null}
              {agents.map((a) => <CheckRow key={a.id} testId={`adv-agent-${a.id}`} label={a.name} checked={filter.authorIds.includes(a.id)} onToggle={() => set({ authorIds: toggle(filter.authorIds, a.id) })} />)}
            </Section>
            <Section title="People">
              {namedPeople.length === 0 && anonIds.length === 0 && unknownIds.length === 0 ? <div className="px-2 text-[11px] text-stone-400">None yet</div> : null}
              {namedPeople.map((p) => (
                <CheckRow key={p.id} testId={`adv-person-${p.id}`} label={p.id === currentUserId ? 'Me' : p.name} checked={filter.authorIds.includes(p.id)} onToggle={() => set({ authorIds: toggle(filter.authorIds, p.id) })} />
              ))}
              {anonIds.length > 0 ? (
                <CheckRow
                  testId="adv-person-anonymous"
                  label={anonIds.length === 1 ? 'Anonymous' : `Anonymous (${anonIds.length})`}
                  checked={groupOn(anonIds)}
                  onToggle={() => toggleGroup(anonIds)}
                />
              ) : null}
              {unknownIds.length > 0 ? (
                <CheckRow
                  testId="adv-person-unknown"
                  label={unknownIds.length === 1 ? 'Unknown' : `Unknown (${unknownIds.length})`}
                  checked={groupOn(unknownIds)}
                  onToggle={() => toggleGroup(unknownIds)}
                />
              ) : null}
            </Section>
            <Section title="When">
              {(['today', 'week', 'month'] as const).map((v) => (
                <CheckRow key={v} testId={`adv-when-${v}`} label={v === 'today' ? 'Today' : v === 'week' ? 'This week' : 'This month'} checked={filter.when.kind === 'preset' && filter.when.value === v} onToggle={() => setWhenPreset(v)} />
              ))}
              <div className="mt-1 flex items-center gap-1.5 px-2">
                <input type="date" data-testid="adv-when-from" value={customRange?.from ?? ''} onChange={(e) => setRange({ from: e.target.value || undefined })} className="min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-1.5 py-1 text-[11px]" />
                <span className="text-[11px] text-stone-400">–</span>
                <input type="date" data-testid="adv-when-to" value={customRange?.to ?? ''} onChange={(e) => setRange({ to: e.target.value || undefined })} className="min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-1.5 py-1 text-[11px]" />
              </div>
              <CheckRow testId="adv-checkpoints" label="Checkpoints only" checked={filter.checkpointsOnly} onToggle={() => set({ checkpointsOnly: !filter.checkpointsOnly })} />
            </Section>
          </div>
          <div className="mt-2 flex justify-end border-t border-stone-200 pt-2">
            <button type="button" data-testid="clear-all-filters" onClick={clearAll} className="text-[12px] text-stone-400 hover:text-stone-700">Clear all filters</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
