'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowSquareOutIcon,
  ArrowUUpLeftIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  EyeIcon,
  PencilSimpleIcon,
  PlusMinusIcon,
  TagIcon,
  User,
} from '@phosphor-icons/react';
import { readJsonResponse } from '@/lib/http/read-json-response';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import { CheckpointLabel } from '@/components/workspace/checkpoint-label';
import type { HistoryLabel } from '@/lib/workspace/api-shared-types';
import { TurnEditsCard } from '@/components/workspace/turn-edits-card';
import { InlineDocDiff } from '@/components/workspace/diff-review/inline-doc-diff';
import { getCachedTurnEdits, setCachedTurnEdits, subscribeTurnEditsCache } from '@/lib/workspace/turn-edits-cache';
import { Spinner } from '@/components/ui/spinner';
import { brandForAgentId } from '@/lib/workspace/agent-brand';
import type { FilePendingEditsResponse } from '@/lib/workspace/api-shared-types';
import { isHumanReviewId, parseHumanReviewId } from '@/lib/workspace/human-suggestions';
import type { TurnEditsResponse } from '@/lib/workspace/turn-edits';
import {
  classifyChangeAuthor,
  summarizeAcceptedPreview,
  type ChangeAuthorKind,
  type ChangeEntry,
  type ChangeScopeFilter,
  type WorkspaceChangesResponse,
  type WorkspaceChangesUnchanged,
} from '@/lib/workspace/workspace-changes';
import { ActionBtn, RangeCompareDetail, ReviewFilterBar, useFetchJson } from '@/components/workspace/review-panel-parts';
import { buildHandoffPrompt, groupHistorySessions, rangeDocEditIds } from '@/lib/workspace/review-range';
import { EMPTY_FILTER, bestServerScope, filterEntries, type ReviewFilter } from '@/lib/workspace/review-filters';

/** A reviewer-visible change is a *suggestion* (Keep/Undo/Revise) while it's a
 *  pending agent edit; once applied/reviewed it's history (Restore/Revise). */
function isSuggestionEntry(entry: ChangeEntry): boolean {
  return entry.editMode === 'suggest' && (entry.reviewState === 'pending' || entry.reviewState === 'partial');
}

function formatTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function scopeToQuery(scope: ChangeScopeFilter, authors: ChangeAuthorKind[]): string {
  const params = new URLSearchParams();
  if (scope.path) params.set('path', scope.path);
  if (scope.folder) params.set('folder', scope.folder);
  if (scope.chatId) params.set('chatId', scope.chatId);
  if (scope.assistantMessageId) params.set('assistantMessageId', scope.assistantMessageId);
  if (authors.length > 0 && authors.length < 3) params.set('authors', authors.join(','));
  return params.toString();
}

// Files a turn still actively proposes = files with PENDING chunks (oversized
// files carry no chunks and stay reviewable). Kept chunks are resolved too —
// counting them as active would leave an accepted suggestion pinned under
// Suggestions, because the server only tallies runs as `partial` and the 4s
// poll would keep preserving the folded local resolution.
function activeFilePaths(payload: TurnEditsResponse): string[] {
  return payload.files
    .filter((file) => file.oversized || file.chunks.some((chunk) => chunk.status === 'pending'))
    .map((file) => file.filePath);
}

/** Map a (possibly truncated) `human-<rowId>` review id to the full-history
 *  payload key by finding the run span that contains `rowId`. Non-human ids and
 *  unmatched ids pass through unchanged. */
function resolveHumanReviewId(
  reviewId: string,
  humanRuns: FilePendingEditsResponse['humanRuns'],
): string {
  if (!isHumanReviewId(reviewId)) return reviewId;
  const rowId = parseHumanReviewId(reviewId);
  if (rowId == null) return reviewId;
  const run = humanRuns.find((r) => r.firstRowId <= rowId && rowId <= r.lastRowId);
  return run?.reviewId ?? reviewId;
}

function rewritePreview(preview: string, fileCount: number): string {
  if (/^Edited \d+ files?$/i.test(preview.trim())) {
    return fileCount === 1 ? 'Edited 1 file' : `Edited ${fileCount} files`;
  }
  return preview;
}

/** A locally-applied review outcome that must survive the background poll.
 *  `decidedPaths` = the files this resolution hid (kept/undone); if any of them
 *  turn PENDING again in a cache write (an optimistic action rolled back), the
 *  resolution is stale and must clear so the poll can resurrect them. */
type LocalResolution =
  | { removed: true; decidedPaths?: string[] }
  | { removed?: false; filePaths: string[]; editedFileCount: number; messagePreview: string; decidedPaths?: string[] };

function applyResolutions(
  entries: ChangeEntry[],
  resolutions: Map<string, LocalResolution>,
): ChangeEntry[] {
  if (resolutions.size === 0) return entries;
  const out: ChangeEntry[] = [];
  for (const entry of entries) {
    const resolved = resolutions.get(entry.reviewId);
    // A resolution is an OPTIMISTIC stand-in for the server's classification —
    // it only outvotes an entry the server still calls a pending suggestion.
    // Once the index reclassifies the entry as reviewed/applied history, the
    // resolution has served its purpose: applying it would keep the entry
    // hidden (or trimmed) for the whole session, the "row disappears after I
    // click it" bug.
    if (!resolved || !isSuggestionEntry(entry)) {
      out.push(entry);
    } else if (!resolved.removed) {
      out.push({
        ...entry,
        filePaths: resolved.filePaths,
        editedFileCount: resolved.editedFileCount,
        messagePreview: resolved.messagePreview,
      });
    }
  }
  return out;
}

function AuthorAvatar({ entry, size = 'md' }: { entry: ChangeEntry; size?: 'sm' | 'md' }) {
  const { kind, id, name, imageUrl } = entry.author;
  const dim = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={name}
        className={`${dim} shrink-0 rounded-full bg-white object-cover ring-1 ring-stone-200`}
      />
    );
  }
  if (kind === 'local_agent') {
    const brand = brandForAgentId(id);
    return (
      <span
        className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-full font-semibold text-[#fff] ${size === 'sm' ? 'text-[8px]' : 'text-[10px]'}`}
        style={{ backgroundColor: brand.color }}
      >
        {brand.label}
      </span>
    );
  }
  // Human with no profile photo (e.g. an anonymous visitor).
  return (
    <span className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-500`}>
      <User weight="bold" className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
    </span>
  );
}

// Generic stand-ins the summarizer emits for empty/`done` turns, runs, and
// applied sessions ("Edited draft.md", "Edited (2×) draft.md") — they restate
// the verb and file rails, so the row hides them.
function isGenericPreview(preview: string): boolean {
  const p = preview.trim();
  return /^Edited \d+ files?$/i.test(p) || /^Suggested edits?\b/i.test(p) || /^Edited( \(\d+×\))? \S+$/.test(p);
}

type RowVerb = {
  verb: string;
  Icon: React.ComponentType<{ className?: string; weight?: 'fill' | 'bold' | 'regular'; 'aria-hidden'?: boolean }>;
  tone: string;
  weight?: 'fill' | 'bold';
};

/** What a row DID — the scan anchor of the icon+verb rail. Derived entirely
 *  from the entry. Colour is spent exactly once: amber on a still-pending
 *  Suggested (the rows that need the reviewer); everything else stays stone. */
function changeAction(entry: ChangeEntry): RowVerb {
  if (entry.kind === 'comment') {
    const event = entry.comment?.event;
    if (event === 'resolved') return { verb: 'Resolved', Icon: CheckCircleIcon, tone: 'text-stone-400' };
    if (event === 'reopened') return { verb: 'Reopened', Icon: ArrowUUpLeftIcon, tone: 'text-stone-400' };
    return { verb: 'Commented', Icon: ChatCircleIcon, tone: 'text-stone-400', weight: 'fill' };
  }
  if (entry.acceptedFrom) {
    return entry.acceptedFrom.decision === 'rejected'
      ? { verb: 'Rejected', Icon: ArrowUUpLeftIcon, tone: 'text-stone-400' }
      : { verb: 'Accepted', Icon: CheckIcon, tone: 'text-stone-400', weight: 'bold' };
  }
  if (entry.editMode === 'suggest') {
    return isSuggestionEntry(entry)
      ? { verb: 'Suggested', Icon: PlusMinusIcon, tone: 'text-orange-600' }
      : { verb: 'Reviewed', Icon: CheckIcon, tone: 'text-stone-400' };
  }
  return { verb: 'Edited', Icon: PencilSimpleIcon, tone: 'text-stone-400' };
}

/** Black workspace tooltip on hover — CSS-only (no portal/ResizeObserver) so it's
 *  test-stable and dependency-free. Shows on hover of the wrapping span. */
function Tip({ content, children }: { content: string; children: React.ReactNode }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-stone-900 px-2 py-1 text-[11px] font-medium text-stone-50 opacity-0 shadow-sm transition-opacity duration-100 group-hover/tip:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}

/** Small icon button in a row's hover action group, with a black tooltip. Stops
 *  propagation so it doesn't also select the row. */
function RowIcon({ testId, title, onClick, children }: { testId: string; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tip content={title}>
      <button
        type="button"
        data-testid={testId}
        aria-label={title}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-800"
      >
        {children}
      </button>
    </Tip>
  );
}

/** A labelled verb button in the detail's action bar, with a black tooltip that
 *  explains it (the label is short; the tip carries the why). */
function VerbBtn({ testId, tip, onClick, primary, children }: { testId: string; tip: string; onClick: () => void; primary?: boolean; children: React.ReactNode }) {
  return (
    <Tip content={tip}>
      <ActionBtn testId={testId} onClick={onClick} primary={primary}>{children}</ActionBtn>
    </Tip>
  );
}

/** Detail for a local-agent / human suggestion run: pre-fetch the single-file
 *  pending payload, then reuse TurnEditsCard's Keep/Undo rendering by reviewId. */
function RunReviewDetail({
  workspaceId,
  entry,
  onPayloadChange,
  onResolveAlias,
  hideBulkActions,
  onOpenFile,
}: {
  workspaceId: string;
  entry: ChangeEntry;
  onPayloadChange: (payload: TurnEditsResponse) => void;
  /** Report entry.reviewId ↔ canonical payload id when they differ (truncated
   *  long run), so the parent can fold a keep/undo back onto the listed entry. */
  onResolveAlias?: (entryReviewId: string, canonicalReviewId: string) => void;
  hideBulkActions?: boolean;
  onOpenFile?: (path: string) => void;
}) {
  const filePath = entry.filePaths[0] ?? '';
  const { data, error } = useFetchJson<FilePendingEditsResponse>(
    filePath
      ? `/api/workspace/file-pending-edits?workspaceId=${encodeURIComponent(workspaceId)}&filePath=${encodeURIComponent(filePath)}`
      : null,
  );
  // The panel's run id can differ from the full-history payload key: the
  // changes scan is capped at the newest N reviewable rows, so a long run
  // anchors on its first FETCHED row, while file-pending keys on the true
  // first row. Resolve via the run span that contains our anchor row, and
  // render the card under the CANONICAL id so its Keep/Undo posts, optimistic
  // cache, and the parent's fold-back all key on the id the payload is stored
  // under — otherwise a truncated long-run entry's keep would no-op.
  const payload = useMemo(() => {
    if (!data) return null;
    const canonical =
      data.payloads[entry.reviewId] ? entry.reviewId : resolveHumanReviewId(entry.reviewId, data.humanRuns ?? []);
    return data.payloads[canonical] ?? { assistantMessageId: canonical, files: [], allUndone: false };
  }, [data, entry.reviewId]);
  useEffect(() => {
    if (!payload) return;
    if (payload.assistantMessageId !== entry.reviewId) onResolveAlias?.(entry.reviewId, payload.assistantMessageId);
    // Never cache the empty unresolved-id fallback (files: [], allUndone: false):
    // a later row-level Keep reads this cache and would "succeed" posting nothing,
    // hiding the row for good. A real emptied payload still carries allUndone.
    if (payload.files.length > 0 || payload.allUndone) setCachedTurnEdits(payload.assistantMessageId, payload);
  }, [payload, entry.reviewId, onResolveAlias]);

  if (error) return <div className="px-4 py-4 text-sm text-red-600">{error}</div>;
  if (!payload) return <div className="px-4 py-4 text-sm"><Spinner label="Loading change…" /></div>;
  return (
    <TurnEditsCard
      key={payload.assistantMessageId}
      assistantMessageId={payload.assistantMessageId}
      initialPayload={payload}
      variant="panel"
      workspaceId={workspaceId}
      hideBulkActions={hideBulkActions}
      onOpenFile={onOpenFile}
      onPayloadChange={onPayloadChange}
    />
  );
}

/** Read-only detail for a comment record: what was said (or resolved) and on
 *  which quoted span. Comments are history entries, not reviewable diffs. */
function CommentDetail({ entry, onOpenFile }: { entry: ChangeEntry; onOpenFile?: (path: string) => void }) {
  const comment = entry.comment;
  const filePath = entry.filePaths[0] ?? null;
  const verb =
    comment?.event === 'resolved' ? 'Resolved a comment' : comment?.event === 'reopened' ? 'Reopened a comment' : 'Commented';
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200">
      <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-3">
        <ChatCircleIcon className="h-4 w-4 shrink-0 text-stone-400" weight="fill" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800">
          {verb}
          {filePath ? ` on ${filePath}` : ''}
        </span>
        {filePath && onOpenFile ? (
          <button
            type="button"
            onClick={() => onOpenFile(filePath)}
            title="Open this file in the editor"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 py-1 text-[12px] font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-800"
          >
            <EyeIcon className="h-3.5 w-3.5" /> Open file
          </button>
        ) : null}
      </div>
      <div className="space-y-3 px-4 py-4">
        {comment?.quote ? (
          <blockquote className="border-l-2 border-stone-200 pl-3 text-[13px] italic text-stone-500">
            {comment.quote}
          </blockquote>
        ) : null}
        {comment?.body ? <div className="whitespace-pre-wrap text-sm text-stone-700">{comment.body}</div> : null}
        {!comment?.quote && !comment?.body ? (
          <div className="text-sm text-stone-500">No comment text was recorded for this event.</div>
        ) : null}
      </div>
    </div>
  );
}

/** Read-only detail for an applied edit session (`applied-<rowId>`): a direct,
 *  already-landed edit by a human or local agent — shown, not reviewed. */
function AppliedEditDetail({ workspaceId, entry, onOpenFile }: { workspaceId: string; entry: ChangeEntry; onOpenFile?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const filePath = entry.filePaths[0] ?? '';
  const { data: payload, error } = useFetchJson<TurnEditsResponse>(
    filePath
      ? `/api/workspace/applied-edit?workspaceId=${encodeURIComponent(workspaceId)}&filePath=${encodeURIComponent(filePath)}&reviewId=${encodeURIComponent(entry.reviewId)}`
      : null,
  );

  if (error) return <div className="px-4 py-4 text-sm text-red-600">{error}</div>;
  if (!payload) return <div className="px-4 py-4 text-sm"><Spinner label="Loading change…" /></div>;
  const file = payload.files[0];
  if (!file) return <div className="px-4 py-4 text-sm text-stone-500">This edit left no reviewable diff.</div>;
  const accepted = payload.acceptedFrom;
  // Cap a long applied diff (a new file or full rewrite is all-additions, so
  // there's no unchanged context to fold) — show the first lines, expand for all.
  const MAX_LINES = 24;
  const totalLines = file.chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0);
  const truncated = !expanded && totalLines > MAX_LINES;
  let budget = MAX_LINES;
  const shownChunks = truncated
    ? file.chunks
        .map((chunk) => {
          const lines = chunk.lines.slice(0, Math.max(0, budget));
          budget -= chunk.lines.length;
          return { ...chunk, lines };
        })
        .filter((chunk) => chunk.lines.length > 0)
    : file.chunks;
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200">
      {accepted ? (
        <div className="border-b border-stone-100 bg-emerald-50/60 px-4 py-2 text-[12px] font-medium text-emerald-700">
          {summarizeAcceptedPreview(accepted)}
        </div>
      ) : null}
      <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800">{file.filePath}</span>
        <span className="shrink-0 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[10px] font-medium text-stone-400">
          {accepted ? 'Accepted' : 'Applied'}
        </span>
        {onOpenFile ? (
          <button
            type="button"
            onClick={() => onOpenFile(file.filePath)}
            title="Open this file in the editor"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 py-1 text-[12px] font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-800"
          >
            <EyeIcon className="h-3.5 w-3.5" /> Open file
          </button>
        ) : null}
      </div>
      <div className="space-y-3 px-4 py-4">
        {shownChunks.map((chunk) => (
          // Same renderer as the pending path: markdown files render as rich
          // markdown (DiffMarkdownChunk), code/LaTeX as a Monaco-style diff —
          // instead of the old monospace StaticChunk for every applied edit.
          // hideButtons keeps it read-only (an applied edit isn't reviewable).
          <div key={chunk.id} className="prose prose-sm max-w-none">
            <InlineDocDiff
              chunk={chunk}
              filePath={file.filePath}
              renderAsMarks
              hideButtons
              onKeep={() => {}}
              onUndo={() => {}}
            />
          </div>
        ))}
        {truncated ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full rounded-md border border-stone-200 px-3 py-1.5 text-[12px] font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            Show all {totalLines} lines
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ReviewPanel({
  workspaceId,
  currentChatId,
  currentUserId,
  activeFilePath,
  refreshKey,
  onHandoffToChat,
  onOpenFile,
  onOpenChatTurn,
  onClose,
  files = [],
  chats = [],
}: {
  workspaceId: string;
  currentChatId: string | null;
  /** The signed-in (or anon) author id — powers the "Me" author quick pick. */
  currentUserId?: string | null;
  /** File currently open in the editor — enables the "this file/folder" quick picks. */
  activeFilePath?: string | null;
  refreshKey?: string | number | null;
  /** Hand a preloaded message to the workspace chat (Revise / Ask / Restore with
   *  Sunny). The host opens the chat panel and fills the composer. */
  onHandoffToChat?: (text: string) => void;
  /** Open a file in the editor. `editable` is true for pending suggestions (you
   *  can edit them) and false for applied history (read-only at that point). */
  onOpenFile?: (path: string, opts: { editable: boolean }) => void;
  /** Jump to the chat turn a change came from (chat-originated changes only). */
  onOpenChatTurn?: (args: { chatId: string | null; reviewId: string }) => void;
  /** All workspace file paths — populates the Advanced file/folder pickers. */
  files?: string[];
  /** Workspace chat threads — populates the Advanced chat picker. */
  chats?: { id: string; title: string }[];
  /** Close the review column (rendered as an X in the panel's own header). */
  onClose?: () => void;
}) {
  const apiFetch = useApiFetch();
  // Default to all changes, but remember the last filter per workspace — opening
  // Review shouldn't silently pre-scope to whatever file happens to be open.
  const filterStorageKey = workspaceId ? `sundial:review-filter:${workspaceId}` : null;
  const [filter, setFilter] = useState<ReviewFilter>(() => {
    if (typeof window === 'undefined' || !filterStorageKey) return EMPTY_FILTER;
    try {
      const saved = window.localStorage.getItem(filterStorageKey);
      if (saved) return { ...EMPTY_FILTER, ...(JSON.parse(saved) as Partial<ReviewFilter>) };
    } catch {
      /* corrupt/blocked storage — fall back to all changes */
    }
    return EMPTY_FILTER;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !filterStorageKey) return;
    try {
      window.localStorage.setItem(filterStorageKey, JSON.stringify(filter));
    } catch {
      /* storage full/blocked — persistence is best-effort */
    }
  }, [filter, filterStorageKey]);
  // The compare span's two endpoints — point values from `points` ('start' |
  // reviewId | 'now'). These are the SINGLE source of truth for "compare two
  // states": the header dropdowns and the session rows both set them, and the
  // `range` below derives from them, so every path stays in sync (the Compare
  // toggle lights, the dropdowns reflect a session compare, nothing desyncs).
  const [fromPoint, setFromPoint] = useState('start');
  const [toPoint, setToPoint] = useState('now');
  // Whether the from/to dropdown row is revealed (lifted out of the filter bar so
  // Back can collapse it — otherwise it lingered showing "start → now").
  const [compareRevealed, setCompareRevealed] = useState(false);
  const [payload, setPayload] = useState<WorkspaceChangesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Older pages loaded on demand via "Show older changes". The 4s poll only
  // refreshes the first page; these stay as fetched. `cursor` is the next
  // `beforeId` (null = no more history); entries dedupe against the first page
  // by reviewId (the fresher first page wins).
  const [older, setOlder] = useState<{ entries: ChangeEntry[]; cursor: number | null; topBeforeId: number } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // A failed older-page fetch must NOT feed the panel-wide `error` (which
  // replaces the whole list) — it renders inline next to the button instead.
  const [olderError, setOlderError] = useState<string | null>(null);
  // Bumped whenever a local resolution is added or rolled back, so the merged
  // list recomputes even when neither page's identity changed. Page-1 entries
  // are rewritten in place by the resolution writers, but older-page entries
  // are hidden purely through applyResolutions at merge time — a rollback
  // (resolutionsRef delete) would otherwise never resurrect them.
  const [resolutionsVersion, setResolutionsVersion] = useState(0);
  const bumpResolutions = useCallback(() => setResolutionsVersion((v) => v + 1), []);
  // The open single-change detail (null = the list). Single-pane: the column is
  // too narrow for list + detail side by side, so it's one view at a time.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which collapsed same-author history sessions are expanded to their edits.
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());
  const lastKeyRef = useRef<string>('');
  // Single-flight guard for the index fetch. Refs, not effect-local state: the
  // effect re-runs on every `refreshKey` bump, so an effect-scoped flag would
  // let each new instance start a request while the previous one is still open.
  const inFlightRef = useRef(false);
  const missedLoadRef = useRef(false);
  const missedSpinnerRef = useRef(false);
  // Poll short-circuit: the last response's change fingerprint, echoed back as
  // `ifUnchanged=` so an idle poll costs the server two point queries instead
  // of the whole index pipeline. Periodically dropped (below) so the panel
  // still self-heals from any state the fingerprint can't see.
  const pollTokenRef = useRef<string | null>(null);
  const lastFullFetchRef = useRef(0);
  /** Set by the poll chain; called when an edit should pull the next fetch in. */
  const wakeRef = useRef<(() => void) | null>(null);
  // Local review outcomes (Keep/Undo) that must stick across background polls,
  // since the fast index can't cheaply reflect per-chunk undo state.
  const resolutionsRef = useRef<Map<string, LocalResolution>>(new Map());
  // canonical payload id -> listed entry.reviewId, for truncated long runs whose
  // detail resolves to a different (true-first-row) id. Lets a keep/undo fold
  // back onto the row the user is actually looking at.
  const reviewIdAliasRef = useRef<Map<string, string>>(new Map());
  // Every entry ever fetched this timeline, by id — lets the stale-selection
  // reset below remap a window-derived session id instead of closing the view.
  const seenEntriesRef = useRef<Map<string, ChangeEntry>>(new Map());
  const recordReviewIdAlias = useCallback((entryReviewId: string, canonicalReviewId: string) => {
    reviewIdAliasRef.current.set(canonicalReviewId, entryReviewId);
  }, []);

  // Checkpoint labels, keyed by the `doc_edits.id` (entry.docEditId) they pin.
  const [labels, setLabels] = useState<HistoryLabel[]>([]);
  const loadLabels = useCallback(() => {
    if (!workspaceId) return;
    void apiFetch(`/api/workspace/labels?projectId=${encodeURIComponent(workspaceId)}`, {
      cache: 'no-store',
    })
      .then((res) => readJsonResponse<{ labels?: HistoryLabel[] }>(res))
      .then((data) => setLabels(data?.labels ?? []))
      .catch(() => {
        /* checkpoints are non-critical chrome; ignore fetch failures */
      });
  }, [workspaceId, apiFetch]);
  useEffect(() => loadLabels(), [loadLabels]);
  const labelsByDocEditId = useMemo(
    () => new Map(labels.map((label) => [label.docEditId, label])),
    [labels],
  );

  // Authors seen this session, id → name/kind. Sticky across fetches: once the
  // author pre-filter below narrows the response, the CURRENT page alone can't
  // populate the pickers needed to build a cross-kind union ("Sunny" + a person).
  // A memo (fed by the ref) rather than the bare ref, so consumers re-run when a
  // fetch lands — serverAuthors must see a persisted id become resolvable.
  const authorDirRef = useRef<Map<string, { name: string; kind: ChangeAuthorKind }>>(new Map());
  const authorDir = useMemo(() => {
    const dir = new Map<string, { name: string; kind: ChangeAuthorKind }>();
    for (const entry of payload?.entries ?? []) {
      if (entry.author.id) dir.set(entry.author.id, { name: entry.author.name, kind: entry.author.kind });
    }
    for (const [id, v] of authorDirRef.current) if (!dir.has(id)) dir.set(id, v);
    authorDirRef.current = dir;
    return dir;
  }, [payload]);

  // Server-side author pre-filter: the kind-level SUPERSET of the union axis
  // (selected kinds ∪ each selected person/agent's kind; "Me" is human). The
  // route filters BEFORE the response cap, so a busy page dominated by another
  // author can't make a selection look "all caught up" while matching entries
  // sit past the cap. Exact narrowing (specific people, the union) stays
  // client-side; an unresolvable id disables the pre-filter — a superset fetch
  // is always safe.
  const serverAuthors = useMemo(() => {
    if (!filter.authorKinds.length && !filter.authorIds.length) return [] as ChangeAuthorKind[];
    const kinds = new Set<ChangeAuthorKind>(filter.authorKinds);
    for (const id of filter.authorIds) {
      // Directory first (actor-derived, authoritative once seen), then the same
      // id-prefix inference the server classifies with — a persisted id must
      // NEVER disable the pre-filter, or a saved filter for an author whose
      // rows sit past the first unfiltered page strands on "all caught up".
      kinds.add(id === currentUserId ? 'human' : authorDir.get(id)?.kind ?? classifyChangeAuthor(null, id));
    }
    return [...kinds];
  }, [filter.authorKinds, filter.authorIds, currentUserId, authorDir]);

  // Fetch with the best single server scope + the author-kind superset (both
  // perf/correctness hints the route understands); multi-select scope, specific
  // people, time, and checkpoints narrow client-side below. Toggling an author
  // refetches — the pre-cap server filter is what makes the chip truthful.
  const query = useMemo(() => scopeToQuery(bestServerScope(filter), serverAuthors), [filter, serverAuthors]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    // The reset key must include the workspace: /w/[slug] swaps workspaceId on
    // the SAME mounted panel, and an unchanged filter query would otherwise
    // carry workspace A's loaded older pages into workspace B. (Codex P1)
    const key = `${workspaceId}\n${query}`;
    const queryChanged = lastKeyRef.current !== key;
    if (queryChanged) {
      lastKeyRef.current = key;
      resolutionsRef.current = new Map(); // new scope/filter — drop stale resolutions
      reviewIdAliasRef.current = new Map();
      seenEntriesRef.current = new Map(); // another timeline — ids must not remap across it
      pollTokenRef.current = null; // the fingerprint attests a DIFFERENT query's page
      setPayload(null); // show the spinner, not the previous scope's stale list
      setOlder(null); // older pages belong to the previous scope's timeline
      setOlderError(null);
      setLoading(true);
      setError(null);
      setSelectedId(null); // back to the list when the scope/filter changes
      setFromPoint('start'); // a different timeline — stale compare ids no longer apply
      setToPoint('now');
      setCompareRevealed(false);
    }
    const load = async (spinner: boolean) => {
      // Never let two of these overlap: the index is the expensive query, and a
      // burst of writes would otherwise stack one request per Realtime bump. A
      // trigger that lands mid-flight is remembered (with its spinner, so a
      // scope change can't strand the panel in a loading state) and folded into
      // one prompt follow-up.
      if (inFlightRef.current) {
        missedLoadRef.current = true;
        missedSpinnerRef.current = missedSpinnerRef.current || spinner;
        return;
      }
      inFlightRef.current = true;
      if (spinner) setLoading(true);
      try {
        // Echo the fingerprint only on background polls of a page we already
        // hold, and drop it every 30s so the occasional full fetch self-heals
        // anything the fingerprint can't observe.
        const stale = Date.now() - lastFullFetchRef.current > 30_000;
        const token = !spinner && !stale ? pollTokenRef.current : null;
        const res = await apiFetch(
          `/api/workspace/changes?workspaceId=${encodeURIComponent(workspaceId)}&${query}${token ? `&ifUnchanged=${encodeURIComponent(token)}` : ''}`,
          { cache: 'no-store' },
        );
        const data = await readJsonResponse<
          (WorkspaceChangesResponse | WorkspaceChangesUnchanged) & { error?: string }
        >(res);
        if (cancelled) return;
        if (!res.ok || !data) throw new Error(data?.error || `Failed to load changes (${res.status})`);
        setError(null); // a later poll succeeded — clear any stale transient error
        pollTokenRef.current = data.pollToken ?? null;
        if ('unchanged' in data && data.unchanged) return; // the page we hold is current
        const full = data as WorkspaceChangesResponse;
        lastFullFetchRef.current = Date.now();
        const reconciled: WorkspaceChangesResponse = {
          ...full,
          entries: applyResolutions(full.entries, resolutionsRef.current),
        };
        setPayload((prev) =>
          prev && JSON.stringify(prev) === JSON.stringify(reconciled) ? prev : reconciled,
        );
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : 'Failed to load changes');
      } finally {
        inFlightRef.current = false;
        if (!cancelled && spinner) setLoading(false);
      }
    };
    // Chained, not setInterval: the index is expensive on a busy workspace, and
    // a fixed interval stacks overlapping requests once latency exceeds it
    // (observed 10–20s pileups) — schedule the next poll only after this one
    // settles. With edits waking the chain (below) the timer is just the
    // backstop; a trigger dropped mid-flight retries on the short delay so a
    // live edit lands in the timeline in ~a second, not on the 4s beat.
    let timer: number | undefined;
    const tick = (spinner: boolean) =>
      load(spinner).finally(() => {
        if (cancelled) return;
        const missed = missedLoadRef.current;
        const missedSpinner = missedSpinnerRef.current;
        missedLoadRef.current = false;
        missedSpinnerRef.current = false;
        // 2s beat only where polling is cheap — i.e. the response carried a
        // pollToken: the cloud route mints one when its ifUnchanged fast path
        // applies, and the local sidecar shim mints one because it answers
        // from SQLite (this poll is its only live signal). Scoped path-share
        // guests never get a token and every poll runs the full multi-page
        // pipeline — they keep the original 4s cadence.
        const idleMs = pollTokenRef.current ? 2000 : 4000;
        timer = window.setTimeout(() => void tick(missedSpinner), missed ? 250 : idleMs);
      });
    // An edit WAKES this chain instead of re-creating it. Restarting the effect
    // per Realtime bump would hand each new instance a lock still held by the
    // previous one, and every bump would start its own competing chain. Waking
    // reuses the single-flight guard, so a burst of writes can never put more
    // than one index query in the air no matter how fast the bumps arrive.
    wakeRef.current = () => {
      if (cancelled || inFlightRef.current) {
        missedLoadRef.current = true;
        return;
      }
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(false), 0);
    };
    void tick(queryChanged);
    return () => {
      cancelled = true;
      wakeRef.current = null;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [workspaceId, query, apiFetch]);

  // Edits wake the poll chain. Skipped on the FIRST run: the chain's own
  // effect has just started a load, and waking into that in-flight request
  // only sets `missedLoadRef`, buying a redundant second fetch of the
  // expensive index on every mount / filter change (Codex, PR #1104).
  const wakeArmedRef = useRef(false);
  useEffect(() => {
    if (!wakeArmedRef.current) {
      wakeArmedRef.current = true;
      return;
    }
    wakeRef.current?.();
  }, [refreshKey]);

  // Older-history pagination: the first page reports `nextBeforeId`; each
  // loaded older page advances the cursor. Fetched once per click — the poll
  // never re-runs these (history is immutable, only page 1 goes stale).
  //
  // `topBeforeId` is the newest boundary the older pages have claimed. The
  // polled first page's window shifts NEWER as edits arrive, so its floor
  // (`payload.nextBeforeId`) can rise above that boundary — the slice in
  // between is then in neither store. When that gap opens, the button fetches
  // from the CURRENT page-1 floor (re-walked overlap dedupes) instead of the
  // stale bottom cursor, so no history becomes unreachable. (Codex P2)
  const gapCursor =
    older && payload?.nextBeforeId != null && payload.nextBeforeId > older.topBeforeId
      ? payload.nextBeforeId
      : null;
  const olderCursor = older ? gapCursor ?? older.cursor : payload?.nextBeforeId ?? null;
  const loadOlder = useCallback(async () => {
    if (!workspaceId || olderCursor == null) return;
    const key = lastKeyRef.current; // drop the result if the scope/filter changed mid-flight
    setLoadingOlder(true);
    setOlderError(null);
    try {
      // Older pages use the server's max page size — history-heavy workspaces
      // hold thousands of sessions, and each click should cover real ground.
      const res = await apiFetch(
        `/api/workspace/changes?workspaceId=${encodeURIComponent(workspaceId)}&${query}&beforeId=${olderCursor}&limit=200`,
        { cache: 'no-store' },
      );
      const data = await readJsonResponse<WorkspaceChangesResponse & { error?: string }>(res);
      if (lastKeyRef.current !== key) return;
      if (!res.ok || !data) throw new Error(data?.error || `Failed to load older changes (${res.status})`);
      setOlder((prev) => ({
        // A gap-fill page (cursor above the claimed boundary) is NEWER than the
        // loaded pages — prepend it; pages are complete windows, so overlap
        // entries dedupe at merge and the timeline order holds either way.
        entries:
          prev && olderCursor > prev.topBeforeId
            ? [...data.entries, ...prev.entries]
            : [...(prev?.entries ?? []), ...data.entries],
        // A cursor that fails to advance would refetch the same page forever.
        cursor: data.nextBeforeId != null && data.nextBeforeId < olderCursor ? data.nextBeforeId : null,
        topBeforeId: Math.max(prev?.topBeforeId ?? 0, olderCursor),
      }));
    } catch (nextError) {
      if (lastKeyRef.current !== key) return;
      setOlderError(nextError instanceof Error ? nextError.message : 'Failed to load older changes');
    } finally {
      setLoadingOlder(false);
    }
  }, [workspaceId, query, olderCursor, apiFetch]);

  const rawEntries = useMemo(() => {
    const first = payload?.entries ?? [];
    if (!older || older.entries.length === 0) return first;
    const seen = new Set(first.map((entry) => entry.reviewId));
    // Sessions are keyed by their LAST row, so one whose rows straddle a page
    // cursor re-derives on the older page under a different id — drop an older
    // session whose anchor falls inside a kept same-path session's row span.
    const kept = [...first];
    const coveredBySpan = (entry: ChangeEntry) =>
      entry.kind === 'session' &&
      kept.some(
        (k) =>
          k.kind === 'session' &&
          k.firstRowId != null &&
          k.filePaths[0] === entry.filePaths[0] &&
          k.firstRowId <= entry.docEditId &&
          entry.docEditId < k.docEditId,
      );
    for (const entry of applyResolutions(older.entries, resolutionsRef.current)) {
      if (seen.has(entry.reviewId) || coveredBySpan(entry)) continue;
      seen.add(entry.reviewId);
      kept.push(entry);
    }
    // Pages are disjoint id windows served newest-first, so concatenation keeps
    // the timeline order EXCEPT page 1's pinned suggestions: pinning ignores
    // recency, so an old pending suggestion sits at page 1's tail, ABOVE
    // newer appended pages — breaking the newest-first order compareSession's
    // predecessor lookup and the history-session grouping assume. Reposition
    // just the suggestions by docEditId; each page's own server order (which
    // can diverge from docEditId order for scoped turns) stays untouched.
    const pending = kept.filter(isSuggestionEntry).sort((a, b) => b.docEditId - a.docEditId);
    const ordered: ChangeEntry[] = [];
    for (const entry of kept) {
      if (isSuggestionEntry(entry)) continue;
      while (pending.length > 0 && pending[0]!.docEditId >= entry.docEditId) ordered.push(pending.shift()!);
      ordered.push(entry);
    }
    ordered.push(...pending);
    return ordered;
    // resolutionsVersion re-applies resolutions after a rollback (ref mutation
    // alone can't invalidate this memo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, older, resolutionsVersion]);
  // Stable "now" per mount — time buckets don't need to tick live.
  const now = useMemo(() => Date.now(), []);
  const isCheckpoint = useCallback((id: number) => labelsByDocEditId.has(id), [labelsByDocEditId]);
  // The list = the fetched changes narrowed by every active filter axis client-side.
  const entries = useMemo(() => filterEntries(rawEntries, filter, { now, isCheckpoint }), [rawEntries, filter, now, isCheckpoint]);
  // Author counts for the quick-pick chips. An author-narrowed fetch can only
  // count the selected kinds — keep the last UNNARROWED fetch's numbers for the
  // rest (sticky, like the author directory) so toggling a chip doesn't zero
  // its siblings' badges.
  const stickyCountsRef = useRef<Record<ChangeAuthorKind, number>>({ sunny: 0, local_agent: 0, human: 0 });
  const counts = useMemo(() => {
    const fetched = payload?.authorCounts;
    if (!fetched) return stickyCountsRef.current;
    if (serverAuthors.length === 0) {
      stickyCountsRef.current = fetched;
      return fetched;
    }
    const merged = { ...stickyCountsRef.current };
    for (const kind of serverAuthors) merged[kind] = fetched[kind];
    stickyCountsRef.current = merged;
    return merged;
  }, [payload?.authorCounts, serverAuthors]);
  // Specific authors for the pickers/quick-picks: current fetch first (newest
  // first), then authors remembered from earlier fetches this session.
  const authorsByKind = useMemo(
    () => (kind: ChangeAuthorKind) => [...authorDir].filter(([, v]) => v.kind === kind).map(([id, v]) => ({ id, name: v.name })),
    [authorDir],
  );
  const agents = useMemo(() => authorsByKind('local_agent'), [authorsByKind]);
  const people = useMemo(() => authorsByKind('human'), [authorsByKind]);
  // From/To options for the header compare dropdowns: the visible entries, plus
  // any currently-selected point the view hides — a session compare anchors on
  // the session's RAW predecessor, which an author/time filter may have hidden,
  // and the dropdown must still label it.
  const pointLabel = useCallback(
    (entry: ChangeEntry) => `${entry.author.name} · ${formatTime(entry.createdAt) || 'edit'}`,
    [],
  );
  const points = useMemo(() => {
    const base = [
      { value: 'start', label: 'the start' },
      ...entries.map((entry) => ({ value: entry.reviewId, label: pointLabel(entry) })),
      { value: 'now', label: 'now' },
    ];
    for (const value of [fromPoint, toPoint]) {
      if (value === 'start' || value === 'now' || base.some((p) => p.value === value)) continue;
      const raw = rawEntries.find((entry) => entry.reviewId === value);
      if (raw) base.splice(base.length - 1, 0, { value, label: pointLabel(raw) });
    }
    return base;
  }, [entries, rawEntries, fromPoint, toPoint, pointLabel]);

  // The read-only compare span, DERIVED from the two endpoints (the single
  // source of truth) → no separate `range` state to drift out of sync. null when
  // the span is the whole doc (start→now) or the `to` point is gone. Points
  // resolve against the RAW timeline: a compare boundary can be a filter-hidden
  // entry (a session's true predecessor), and doc states are filter-independent.
  const comparing = fromPoint !== 'start' || toPoint !== 'now';
  const range = useMemo(() => {
    if (!comparing) return null;
    // "now" = the newest doc_edits.id the server's scan saw (latestDocEditId) —
    // the capped/pinned entry list alone can under-report it, and list position
    // is meaningless (lastRowId ordering ≠ docEditId anchors).
    const latest = payload?.latestDocEditId ?? (rawEntries.length ? Math.max(...rawEntries.map((e) => e.docEditId)) : null);
    const docIdOf = (value: string) =>
      value === 'start'
        ? null
        : value === 'now'
          ? latest
          : rawEntries.find((e) => e.reviewId === value)?.docEditId ?? null;
    const to = docIdOf(toPoint);
    if (to == null) return null;
    const labelOf = (value: string) => (value === 'start' ? 'the start' : value === 'now' ? 'now' : points.find((p) => p.value === value)?.label ?? value);
    return { from: docIdOf(fromPoint), to, fromLabel: labelOf(fromPoint), toLabel: labelOf(toPoint) };
  }, [comparing, fromPoint, toPoint, rawEntries, points, payload?.latestDocEditId]);

  const resetCompare = useCallback(() => { setFromPoint('start'); setToPoint('now'); }, []);
  // Picking an endpoint is "compare", not "view a single change" — drop the
  // selection so the two views never both claim the pane.
  const onFromChange = useCallback((value: string) => { setSelectedId(null); setFromPoint(value); }, []);
  const onToChange = useCallback((value: string) => { setSelectedId(null); setToPoint(value); }, []);
  const onCompareToggle = useCallback(() => {
    if (compareRevealed || comparing) { resetCompare(); setCompareRevealed(false); }
    else setCompareRevealed(true);
  }, [compareRevealed, comparing, resetCompare]);

  // Drop a stale selection/compare endpoint as the list changes, but never
  // auto-pick: single-pane starts on the list, nothing selected. A background
  // poll that trims or replaces an entry must not leave the detail or the compare
  // row pointing at a ghost id — reset the offending point to its default.
  //
  // Session ids are window-derived (`applied-<lastRowId>`), so on an actively
  // edited file every poll RENAMES the session the user just clicked — naively
  // dropping the id bounced the open detail/compare back to the list within
  // seconds. Remap a vanished session id to its successor (same file, row span
  // covering the old anchor) before giving up.
  useEffect(() => {
    // The open detail must be a VISIBLE entry; compare points only need to exist
    // in the raw timeline (a session's boundary may be a filter-hidden entry).
    const visible = (point: string) => entries.some((entry) => entry.reviewId === point);
    const fetched = (point: string) => rawEntries.some((entry) => entry.reviewId === point);
    const successor = (point: string): string | null => {
      const prev = seenEntriesRef.current.get(point);
      if (!prev || prev.kind !== 'session') return null;
      const next = rawEntries.find(
        (entry) =>
          entry.kind === 'session' &&
          entry.filePaths[0] === prev.filePaths[0] &&
          entry.firstRowId != null &&
          entry.firstRowId <= prev.docEditId &&
          prev.docEditId <= entry.docEditId,
      );
      return next?.reviewId ?? null;
    };
    setSelectedId((current) => {
      if (!current || visible(current)) return current;
      const next = successor(current);
      return next && visible(next) ? next : null;
    });
    setFromPoint((point) => (point === 'start' || point === 'now' || fetched(point) ? point : successor(point) ?? 'start'));
    setToPoint((point) => (point === 'start' || point === 'now' || fetched(point) ? point : successor(point) ?? 'now'));
    for (const entry of rawEntries) seenEntriesRef.current.set(entry.reviewId, entry);
  }, [entries, rawEntries]);

  const selected = useMemo(
    () => entries.find((entry) => entry.reviewId === selectedId) ?? null,
    [entries, selectedId],
  );

  // As the user Keeps/Undoes in the detail, fold the outcome back into the list
  // (and remember it so the next poll doesn't resurrect undone files). Stable
  // identity (no `selected` closure) keeps TurnEditsCard's cache subscription
  // from tearing down on every poll re-render; the reviewId is recovered from
  // the payload, whose `assistantMessageId` IS the reviewId for turns and runs.
  // Optimistic-keep rollback revival: the detail card flips chunks to 'kept'
  // BEFORE posting — which removes the entry here and unmounts the card (and
  // its per-id subscription). When the POST fails, the card rolls the cache
  // back to 'pending', so a GLOBAL cache listener is the only surface that
  // still sees it: clear the removed resolution and let the next poll
  // resurrect the still-pending suggestion.
  useEffect(
    () =>
      subscribeTurnEditsCache((assistantMessageId, payload) => {
        const reviewId = reviewIdAliasRef.current.get(assistantMessageId) ?? assistantMessageId;
        const resolution = resolutionsRef.current.get(reviewId);
        if (!resolution) return;
        const active = activeFilePaths(payload);
        // A decided (hidden) file that's pending again means the optimistic
        // action rolled back — trimmed leftovers included, not just removals.
        const stale = resolution.decidedPaths
          ? active.some((p) => resolution.decidedPaths!.includes(p))
          : resolution.removed === true && active.length > 0;
        if (stale) {
          resolutionsRef.current.delete(reviewId);
          bumpResolutions(); // resurrect older-page entries hidden by the rolled-back action
        }
      }),
    [bumpResolutions],
  );

  const handleDetailPayload = useCallback((next: TurnEditsResponse) => {
    // For a truncated long run the payload id is canonical while the listed entry
    // is keyed by its anchor id — map back so the right row is updated.
    const reviewId = reviewIdAliasRef.current.get(next.assistantMessageId) ?? next.assistantMessageId;
    // The card reports its INITIAL load here too, and a payload can lack pending
    // files for reasons other than a review action — a history entry's chunks
    // are already kept/undone, and an unresolvable run id yields an empty
    // payload. Folding those would remove the clicked row with no user action
    // (and the sticky resolution keeps the poll from resurrecting it). Only
    // fold payloads carrying real decisions, onto still-pending suggestions.
    // The one decision-free action response — a ledger accept's `{files: [],
    // allUndone: false}` — is still folded: the card's optimistic keep flips
    // the cached chunks to 'kept' BEFORE posting, and that write lands here.
    const decided = next.allUndone || next.files.some((file) => file.chunks.some((c) => c.status !== 'pending'));
    if (!decided) return;
    const active = new Set(activeFilePaths(next));
    // Trim the listed entry to the files still pending, recording the same as a
    // resolution so background polls can't resurrect the decided files. The
    // entry may live on page 1 OR a loaded older page — trim whichever holds it
    // (idempotent, so React double-invoking the updaters is safe).
    const trim = (list: ChangeEntry[]): ChangeEntry[] | null => {
      let touched = false;
      const entries: ChangeEntry[] = [];
      for (const entry of list) {
        // Only pending suggestions fold: a HISTORY entry's payload naturally
        // has no pending files, and recording that as a `removed` resolution
        // made the row vanish the moment it was clicked.
        if (entry.reviewId !== reviewId || !isSuggestionEntry(entry)) {
          entries.push(entry);
          continue;
        }
        touched = true;
        // Intersect with the files this entry already represents (its scope), so
        // a multi-file turn opened under a file/folder scope can't re-add the
        // out-of-scope files it also touched.
        const paths = entry.filePaths.filter((p) => active.has(p));
        const decidedPaths = entry.filePaths.filter((p) => !active.has(p));
        if (next.allUndone || paths.length === 0) {
          resolutionsRef.current.set(reviewId, { removed: true, decidedPaths: entry.filePaths });
          continue;
        }
        const messagePreview = rewritePreview(entry.messagePreview, paths.length);
        resolutionsRef.current.set(reviewId, { filePaths: paths, editedFileCount: paths.length, messagePreview, decidedPaths });
        entries.push({ ...entry, filePaths: paths, editedFileCount: paths.length, messagePreview });
      }
      return touched ? entries : null;
    };
    setPayload((prev) => {
      if (!prev) return prev;
      const entries = trim(prev.entries);
      return entries ? { ...prev, entries } : prev;
    });
    setOlder((prev) => {
      if (!prev) return prev;
      const entries = trim(prev.entries);
      return entries ? { ...prev, entries } : prev;
    });
  }, []);

  // Suggest mode is the default: pending agent edits surface as suggestions above
  // the applied history, each kept/undone/revised; history offers restore/revise.
  const suggestions = useMemo(() => entries.filter(isSuggestionEntry), [entries]);
  const history = useMemo(() => entries.filter((entry) => !isSuggestionEntry(entry)), [entries]);
  // Group over the RAW fetched timeline, breaking a run on ANY entry the current
  // view hides (suggestions, author/time/checkpoint-filtered rows). A session's
  // click compares the docEditId span, so two visible edits must never fuse
  // across hidden work the session heading wouldn't attribute. Runs then map
  // back to the visible (filter-narrowed) entries for rendering.
  const historySessions = useMemo(() => {
    // Under an author filter the fetch itself is author-narrowed (pre-cap), so
    // rawEntries is NOT the full timeline — collapsing would fuse runs across
    // never-fetched edits and a session compare would attribute hidden work.
    // Render individual rows instead; the header From/To compare still works.
    if (filter.authorKinds.length > 0 || filter.authorIds.length > 0) {
      return history.map((entry) => [entry]);
    }
    const visibleById = new Map(history.map((entry) => [entry.reviewId, entry]));
    // Comments never fuse into an edit session — they're their own row.
    return groupHistorySessions(
      rawEntries,
      undefined,
      (entry) => !visibleById.has(entry.reviewId) || entry.kind === 'comment',
    )
      .filter((run) => visibleById.has(run[0]!.reviewId))
      .map((run) => run.map((entry) => visibleById.get(entry.reviewId)!));
  }, [rawEntries, history, filter.authorKinds, filter.authorIds]);

  // Open a change's detail (single-pane). Clears any compare so the two views
  // never both claim the pane.
  const openEntry = useCallback((reviewId: string) => {
    resetCompare();
    setCompareRevealed(false);
    setSelectedId(reviewId);
  }, [resetCompare]);
  // Compare a whole session run: its span is the predecessor of the oldest edit
  // (state before the run) → the newest edit. Expressed as the two endpoints so
  // the header reflects it and the Compare toggle lights — one range model. The
  // predecessor comes from the RAW timeline: the filtered list may hide the
  // entry immediately below the session, and skipping it would silently fold
  // that hidden work into the session's diff.
  const compareSession = useCallback((oldestReviewId: string, newestReviewId: string) => {
    const olderIdx = rawEntries.findIndex((entry) => entry.reviewId === oldestReviewId);
    if (olderIdx < 0) return;
    setSelectedId(null);
    setCompareRevealed(true);
    setFromPoint(rawEntries[olderIdx + 1]?.reviewId ?? 'start');
    setToPoint(newestReviewId);
  }, [rawEntries]);
  const toggleSession = useCallback((sessionId: string) => {
    setExpandedSessions((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  // One predicate for "is this path inside the active file/folder filter" —
  // shared by the compare detail and the turn card's restriction.
  const scopeToPath = useMemo(() => {
    if (!filter.paths.length && !filter.folders.length) return undefined;
    return (path: string) =>
      filter.paths.includes(path) ||
      filter.folders.some((f) => path === f || path.startsWith(f.endsWith('/') ? f : `${f}/`));
  }, [filter.paths, filter.folders]);

  const restoreToChat = useCallback(
    (paths: string[]) => onHandoffToChat?.(buildHandoffPrompt({ kind: 'restore', files: paths })),
    [onHandoffToChat],
  );
  const askChange = useCallback(
    (entry: ChangeEntry) => onHandoffToChat?.(buildHandoffPrompt({ kind: 'ask', files: entry.filePaths })),
    [onHandoffToChat],
  );
  const openChatTurn = useCallback(
    (entry: ChangeEntry) => onOpenChatTurn?.({ chatId: entry.chatId, reviewId: entry.reviewId }),
    [onOpenChatTurn],
  );

  // Resolve a suggestion out of the list optimistically; the 4s poll reconciles
  // (so a run whose id didn't resolve server-side simply reappears, not corrupts).
  // The acted-on entry may be filter-NARROWED — only its own files were kept or
  // undone, so the raw entry's out-of-scope files must stay reviewable (as a
  // trimmed leftover entry) instead of hiding the whole turn behind a `removed`
  // resolution that outlives the filter. (Idempotent: safe under double-invoke.)
  const dropEntry = useCallback((entry: ChangeEntry) => {
    const acted = new Set(entry.filePaths);
    setPayload((prev) => {
      if (!prev) {
        resolutionsRef.current.set(entry.reviewId, { removed: true, decidedPaths: entry.filePaths });
        return prev;
      }
      let resolution: LocalResolution = { removed: true, decidedPaths: entry.filePaths };
      const nextEntries: ChangeEntry[] = [];
      for (const raw of prev.entries) {
        if (raw.reviewId !== entry.reviewId) {
          nextEntries.push(raw);
          continue;
        }
        const leftover = raw.filePaths.filter((p) => !acted.has(p));
        if (leftover.length > 0) {
          const messagePreview = rewritePreview(raw.messagePreview, leftover.length);
          resolution = { filePaths: leftover, editedFileCount: leftover.length, messagePreview, decidedPaths: entry.filePaths };
          nextEntries.push({ ...raw, filePaths: leftover, editedFileCount: leftover.length, messagePreview });
        }
      }
      resolutionsRef.current.set(entry.reviewId, resolution);
      return { ...prev, entries: nextEntries };
    });
    setSelectedId((cur) => (cur === entry.reviewId ? null : cur));
  }, []);
  const postJson = (url: string, body: unknown) =>
    apiFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }).then((res) => {
      if (!res.ok) throw new Error(`${url} → ${res.status}`);
      return res;
    });
  // Optimistic outcomes drop the row immediately, then revert if the write fails
  // so a failed Keep/Undo doesn't stay hidden forever (the `removed` resolution
  // would otherwise outvote the poll).
  const reviveOnFailure = useCallback((reviewId: string) => {
    resolutionsRef.current.delete(reviewId);
    bumpResolutions(); // older-page entries are hidden only via the merge memo
  }, [bumpResolutions]);
  // Load the diff payload a review action should act on: the shared cache, the
  // turn GET for Sunny turns, or the single-file pending payload for human/
  // local-agent runs (whose ids the agent-only GET can't resolve). Throws on a
  // failed load so optimistic drops resurrect instead of stranding.
  const loadEntryPayload = useCallback(async (entry: ChangeEntry): Promise<TurnEditsResponse> => {
    // An empty non-allUndone payload is a no-op shell (a transient GET miss the
    // detail card cached, or the unresolved-id fallback) — acting on it would
    // post nothing, "succeed", and hide a suggestion nothing resolved. Skip a
    // cached shell and refetch; if the server still returns one, fail the load
    // so the optimistic drop revives.
    const isShell = (pl: TurnEditsResponse) => pl.files.length === 0 && !pl.allUndone;
    const cached = getCachedTurnEdits(entry.reviewId);
    if (cached && !isShell(cached)) return cached;
    if (!isHumanReviewId(entry.reviewId)) {
      const res = await apiFetch(`/api/workspace/turn-edits?assistantMessageId=${encodeURIComponent(entry.reviewId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load change (${res.status})`);
      const pl = await readJsonResponse<TurnEditsResponse>(res);
      if (!pl || isShell(pl)) throw new Error('Failed to load change');
      return pl;
    }
    // Runs are single-file; resolve the (possibly truncated) id to the payload key.
    const filePath = entry.filePaths[0] ?? '';
    const res = await apiFetch(
      `/api/workspace/file-pending-edits?workspaceId=${encodeURIComponent(workspaceId)}&filePath=${encodeURIComponent(filePath)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`Failed to load change (${res.status})`);
    const data = await readJsonResponse<FilePendingEditsResponse>(res);
    const canonical = data?.payloads[entry.reviewId] ? entry.reviewId : resolveHumanReviewId(entry.reviewId, data?.humanRuns ?? []);
    const pl = data?.payloads[canonical];
    if (!pl) throw new Error('Failed to load change');
    return pl;
  }, [workspaceId, apiFetch]);
  // Keep only the pending chunks the client has SEEN (content-derived ids) —
  // '*' would also accept a hunk another collaborator added or re-edited after
  // our fetch, sight unseen. A re-edited hunk's id no longer matches, so it
  // stays pending for review (mirrors TurnEditsCard's keep-all). workspaceId
  // rides along — required for ledger-keyed `human-local-*` runs.
  const keepEntry = useCallback(async (entry: ChangeEntry) => {
    dropEntry(entry);
    try {
      const pl = await loadEntryPayload(entry);
      const scope = new Set(entry.filePaths);
      await Promise.all(pl.files
        .filter((file) => scope.has(file.filePath))
        .map((file) => {
          const chunkIds = file.chunks.filter((chunk) => chunk.status === 'pending').map((chunk) => chunk.id);
          if (chunkIds.length === 0) return null;
          return postJson('/api/workspace/turn-edits/keep-chunk', { assistantMessageId: entry.reviewId, filePath: file.filePath, chunkIds, workspaceId });
        }));
    } catch { reviveOnFailure(entry.reviewId); }
  }, [dropEntry, loadEntryPayload, reviveOnFailure, workspaceId]);
  // Undo every pending chunk. Runs (`human-<rowId>` / `human-local-*`) reject a
  // whole file with the '*' sentinel — the route targets only still-pending
  // chunks and orders the reverts internally; "undo this run" means reject the
  // rest of it, so unseen still-pending hunks are in scope (unlike Keep, which
  // must never ACCEPT unseen content). Sunny turns enumerate: only PENDING
  // chunks (an explicit id undoes regardless of decision state, so including
  // kept chunks would revert accepted edits), only the entry's own files, and
  // sequentially — each chunk's text anchor shifts as earlier ones revert.
  const undoEntry = useCallback(async (entry: ChangeEntry, reason?: string) => {
    dropEntry(entry);
    const note = reason?.trim() ? { reason: reason.trim() } : {};
    try {
      if (isHumanReviewId(entry.reviewId)) {
        await Promise.all(entry.filePaths.map((filePath) =>
          postJson('/api/workspace/turn-edits/undo-chunk', { assistantMessageId: entry.reviewId, filePath, chunkId: '*', workspaceId, ...note })));
      } else {
        const pl = await loadEntryPayload(entry);
        const scope = new Set(entry.filePaths);
        for (const file of pl.files) {
          if (!scope.has(file.filePath)) continue;
          for (const chunk of file.chunks) {
            if (chunk.status !== 'pending') continue;
            await postJson('/api/workspace/turn-edits/undo-chunk', { assistantMessageId: entry.reviewId, filePath: file.filePath, chunkId: chunk.id, workspaceId, ...note });
          }
        }
      }
    } catch { reviveOnFailure(entry.reviewId); }
  }, [dropEntry, loadEntryPayload, reviveOnFailure, workspaceId]);
  // Optional note beside the detail-pane Undo; it rides the reject to the
  // suggesting agent's /events feed. Reset when the selected entry changes.
  // Row-hover undo stays noteless and instant.
  const [undoNote, setUndoNote] = useState('');
  useEffect(() => { setUndoNote(''); }, [selected?.reviewId]);
  const keepAllSuggestions = useCallback(() => { suggestions.forEach((s) => void keepEntry(s)); }, [suggestions, keepEntry]);
  const undoAllSuggestions = useCallback(() => { suggestions.forEach((s) => void undoEntry(s)); }, [suggestions, undoEntry]);

  // Hover-revealed quick actions — suggestions keep/undo/revise, history restore/
  // ask/checkpoint. Siblings of the row button (not nested) so clicks don't select.
  const rowActions = (entry: ChangeEntry) => {
    if (entry.kind === 'comment') return null; // read-only record — no verbs
    const sug = isSuggestionEntry(entry);
    return (
      <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md bg-stone-100/95 opacity-0 shadow-sm ring-1 ring-stone-200 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        {sug ? (
          // Keep rightmost — matching Undo · Keep order everywhere else.
          <>
            <RowIcon testId={`row-undo-${entry.reviewId}`} title="Undo" onClick={() => void undoEntry(entry)}><ArrowUUpLeftIcon className="h-3.5 w-3.5" /></RowIcon>
            <RowIcon testId={`row-keep-${entry.reviewId}`} title="Keep" onClick={() => void keepEntry(entry)}><CheckIcon className="h-3.5 w-3.5" weight="bold" /></RowIcon>
          </>
        ) : (
          <>
            <RowIcon testId={`row-restore-${entry.reviewId}`} title="Restore" onClick={() => restoreToChat(entry.filePaths)}><ClockCounterClockwiseIcon className="h-3.5 w-3.5" /></RowIcon>
            <RowIcon testId={`row-ask-${entry.reviewId}`} title="Ask agent" onClick={() => askChange(entry)}><ChatCircleIcon className="h-3.5 w-3.5" /></RowIcon>
            <RowIcon testId={`row-checkpoint-${entry.reviewId}`} title="Checkpoint" onClick={() => openEntry(entry.reviewId)}><TagIcon className="h-3.5 w-3.5" /></RowIcon>
          </>
        )}
      </div>
    );
  };

  const renderEntryRow = (entry: ChangeEntry) => {
    const active = !range && entry.reviewId === selected?.reviewId;
    const fileList = entry.filePaths.join(' · ');
    const checkpoint = labelsByDocEditId.get(entry.docEditId);
    const { verb, Icon, tone, weight } = changeAction(entry);
    // Second line only when it says something the rails don't: an accepted/
    // rejected row's preview ("Accepted X's suggestion") restates the verb and
    // author columns, and the generic stand-ins restate the file list.
    const preview =
      isGenericPreview(entry.messagePreview) || entry.acceptedFrom ? '' : entry.messagePreview;
    return (
      <div key={entry.reviewId} className="group relative">
        <button
          type="button"
          data-testid={`review-entry-${entry.reviewId}`}
          onClick={() => openEntry(entry.reviewId)}
          className={`w-full rounded-lg px-2.5 py-1.5 pr-3 text-left transition-colors ${
            active ? 'bg-stone-200/80' : 'hover:bg-stone-100'
          }`}
        >
          <div className="flex items-center gap-2">
            {/* 1 — action rail. Fixed width so the verbs form a scan column. */}
            <span className="flex w-[92px] shrink-0 items-center gap-1.5">
              <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} weight={weight} aria-hidden />
              <span className="truncate text-[11px] font-medium text-stone-500">{verb}</span>
            </span>
            {/* 2 — file rail: full relative paths, truncated. */}
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-stone-700" title={fileList}>
              {fileList || 'No tracked files'}
            </span>
            {entry.chatId ? (
              <Tip content="Came from a chat thread">
                <ChatCircleIcon className="h-3 w-3 shrink-0 text-stone-300" weight="fill" aria-label="From chat" />
              </Tip>
            ) : null}
            {checkpoint ? (
              <span
                className="shrink-0 text-indigo-500"
                title={`Checkpoint: ${checkpoint.name}`}
                data-testid={`review-entry-checkpoint-${entry.reviewId}`}
              >
                <TagIcon className="h-3 w-3" weight="fill" aria-hidden />
              </span>
            ) : null}
            {/* 3 — author rail */}
            <span className="flex shrink-0 items-center gap-1">
              <AuthorAvatar entry={entry} size="sm" />
              <span className="max-w-[72px] truncate text-[11px] text-stone-500">{entry.author.name}</span>
            </span>
            {/* 4 — time rail */}
            <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-stone-400">
              {formatTime(entry.createdAt)}
            </span>
          </div>
          {preview ? (
            <div className="mt-0.5 truncate pl-[100px] text-[11px] text-stone-400">{preview}</div>
          ) : null}
        </button>
        {rowActions(entry)}
      </div>
    );
  };

  // A run of consecutive same-author edits: one collapsible row whose click
  // selects the from→to span; expand to act on the individual edits.
  const renderSessionRow = (run: ChangeEntry[]) => {
    const oldest = run[run.length - 1];
    const newest = run[0];
    const sessionId = `sess-${oldest.reviewId}`;
    // Raw timeline — must mirror compareSession's boundary or the active-row
    // highlight would never match the span the click actually sets.
    const span = rangeDocEditIds(rawEntries, oldest.reviewId, newest.reviewId);
    const expanded = expandedSessions.has(sessionId);
    const isSelected = !!range && !!span && range.from === span.from && range.to === span.to;
    // Every file the run touched — the compare span covers the whole run, so
    // the label must attribute all of it, not just the newest edit's file.
    const fileList = [...new Set(run.flatMap((entry) => entry.filePaths))].join(' · ');
    return (
      <div key={sessionId} className="relative">
        <button
          type="button"
          data-testid={`review-session-${oldest.reviewId}`}
          onClick={() => compareSession(oldest.reviewId, newest.reviewId)}
          className={`w-full rounded-lg px-2.5 py-1.5 pr-8 text-left transition-colors ${isSelected ? 'bg-stone-200/80' : 'hover:bg-stone-100'}`}
        >
          <div className="flex items-center gap-2">
            <span className="flex w-[92px] shrink-0 items-center gap-1.5">
              <PencilSimpleIcon className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
              <span className="truncate text-[11px] font-medium text-stone-500">Edited</span>
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-stone-700" title={fileList}>{fileList || 'No tracked files'}</span>
            <span className="shrink-0 rounded-full bg-stone-200/80 px-1.5 text-[9px] font-medium text-stone-500">{run.length} edits</span>
            <span className="flex shrink-0 items-center gap-1">
              <AuthorAvatar entry={newest} size="sm" />
              <span className="max-w-[72px] truncate text-[11px] text-stone-500">{newest.author.name}</span>
            </span>
            <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-stone-400">{formatTime(newest.createdAt)}</span>
          </div>
        </button>
        <button
          type="button"
          data-testid={`review-session-expand-${oldest.reviewId}`}
          onClick={() => toggleSession(sessionId)}
          title={expanded ? 'Collapse session' : 'Expand session'}
          className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-200/70 hover:text-stone-700"
        >
          {expanded ? <CaretDownIcon className="h-3.5 w-3.5" /> : <CaretRightIcon className="h-3.5 w-3.5" />}
        </button>
        {expanded ? <div className="ml-3 border-l border-stone-200 pl-1">{run.map(renderEntryRow)}</div> : null}
      </div>
    );
  };

  // Single-pane: show a change's detail (a compare range or a selected change)
  // in place of the list. One gate, derived from the two sources of truth, so
  // the branches can't drift. A range wins if both are somehow set.
  const showDetail = Boolean(range || selected);

  return (
    <div data-testid="review-panel" className="flex h-full min-h-0 flex-1 flex-col bg-stone-50">
      <ReviewFilterBar
        filter={filter}
        onChange={setFilter}
        currentChatId={currentChatId}
        currentUserId={currentUserId ?? null}
        activeFilePath={activeFilePath}
        files={files}
        chats={chats}
        counts={counts}
        agents={agents}
        people={people}
        points={points}
        fromValue={fromPoint}
        toValue={toPoint}
        onFromChange={onFromChange}
        onToChange={onToChange}
        compareRevealed={compareRevealed}
        onCompareToggle={onCompareToggle}
        onClose={onClose}
      />

      {/* Body: list + detail */}
      {loading && !payload ? (
        <Spinner label="Loading changes…" center className="min-h-0 flex-1" />
      ) : error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-red-600">{error}</div>
      ) : entries.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <CheckCircleIcon className="h-9 w-9 text-stone-300" weight="light" aria-hidden />
          <div className="mt-3 text-sm font-medium text-stone-700">You&rsquo;re all caught up</div>
          <div className="mt-1 max-w-sm text-sm text-stone-500">
            No tracked edits in this view. Widen the scope or clear the author filter to see more.
          </div>
          {/* A client-side filter can empty the fetched pages while matching
              entries sit in older history — keep pagination reachable. */}
          {olderCursor != null ? (
            <button
              type="button"
              data-testid="review-load-older"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
              className="mt-3 rounded-md px-2.5 py-2 text-[12px] font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 disabled:text-stone-400"
            >
              {loadingOlder ? 'Loading older changes…' : 'Show older changes'}
            </button>
          ) : null}
          {olderError ? (
            <div data-testid="review-load-older-error" className="mt-1 text-[11px] text-red-600">{olderError}</div>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Single-pane: the list, or a change's detail with a Back button. */}
          {showDetail ? null : (
          <aside className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-1 overflow-auto p-1.5">
              {suggestions.length > 0 ? (
                <div data-testid="review-suggestions-group" className="space-y-0.5">
                  <div className="flex items-center gap-2 px-2.5 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-stone-400">
                    <span>Suggestions · {suggestions.length}</span>
                    <span className="ml-auto flex items-center gap-2 normal-case tracking-normal">
                      <button type="button" data-testid="review-undo-all" onClick={undoAllSuggestions} className="font-medium text-stone-500 hover:text-stone-800">Undo all</button>
                      <button type="button" data-testid="review-keep-all" onClick={keepAllSuggestions} className="font-medium text-stone-500 hover:text-stone-800">Keep all</button>
                    </span>
                  </div>
                  {suggestions.map(renderEntryRow)}
                </div>
              ) : null}

              {history.length > 0 ? (
                <div data-testid="review-history-group" className="space-y-0.5">
                  <div className="px-2.5 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-stone-400">History</div>
                  {historySessions.map((run) => (run.length === 1 ? renderEntryRow(run[0]) : renderSessionRow(run)))}
                </div>
              ) : null}

              {olderCursor != null ? (
                <>
                  <button
                    type="button"
                    data-testid="review-load-older"
                    onClick={() => void loadOlder()}
                    disabled={loadingOlder}
                    className="w-full rounded-md px-2.5 py-2 text-left text-[12px] font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 disabled:text-stone-400"
                  >
                    {loadingOlder ? 'Loading older changes…' : 'Show older changes'}
                  </button>
                  {olderError ? (
                    <div data-testid="review-load-older-error" className="px-2.5 pb-1 text-[11px] text-red-600">
                      {olderError}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </aside>
          )}

          {showDetail ? (
          <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-stone-50">
            {/* One balanced header row: Back on the left, the change's verbs on
                the right — ending Checkpoint · Undo · Keep, with Keep rightmost
                to match Keep/Undo placement everywhere else. */}
            <div className="flex flex-wrap items-center gap-1.5 border-b border-stone-200 py-2 pl-1.5 pr-4">
              <button
                type="button"
                data-testid="review-back"
                onClick={() => { setSelectedId(null); resetCompare(); setCompareRevealed(false); }}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
              >
                <CaretLeftIcon className="h-3.5 w-3.5" /> All changes
              </button>
              <span className="min-w-0 flex-1" />
              {range ? (
                <>
                  <span className="shrink-0 text-[10px] text-stone-400">read-only</span>
                  <ActionBtn
                    testId="ask-about"
                    title="Ask agent what changed across this span"
                    onClick={() =>
                      onHandoffToChat?.(
                        buildHandoffPrompt({ kind: 'ask', files: [], range: { fromLabel: range.fromLabel, toLabel: range.toLabel, fromId: range.from, toId: range.to } }),
                      )
                    }
                  >
                    <ChatCircleIcon className="h-3.5 w-3.5" /> Ask agent about this
                  </ActionBtn>
                </>
              ) : selected?.kind === 'comment' ? null : selected ? (
                <>
                  {selected.chatId && onOpenChatTurn ? (
                    <VerbBtn testId="open-chat-turn" tip="Open the chat turn this change came from" onClick={() => openChatTurn(selected)}>
                      <ArrowSquareOutIcon className="h-3.5 w-3.5" /> Open chat turn
                    </VerbBtn>
                  ) : null}
                  {onHandoffToChat ? (
                    <VerbBtn testId="ask-change" tip="Ask agent about this change" onClick={() => askChange(selected)}>
                      <ChatCircleIcon className="h-3.5 w-3.5" /> Ask agent
                    </VerbBtn>
                  ) : null}
                  <Tip content="Pin a named checkpoint that includes this change">
                    <CheckpointLabel
                      projectId={workspaceId}
                      docEditId={selected.docEditId}
                      label={labelsByDocEditId.get(selected.docEditId) ?? null}
                      onLabelsChanged={loadLabels}
                    />
                  </Tip>
                  {isSuggestionEntry(selected) ? (
                    <>
                      {/* Optional reason, inline. Undo fires in ONE click and
                          carries whatever's typed (empty = no reason) — the
                          note never gates the action. */}
                      <input
                        data-testid="undo-note-input"
                        value={undoNote}
                        onChange={(e) => setUndoNote(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void undoEntry(selected, undoNote);
                        }}
                        placeholder="Why? (optional)"
                        title="Optional note sent to the agent when you undo"
                        className="h-6 w-32 shrink-0 rounded-md border border-stone-300 bg-white px-1.5 text-[11px] text-stone-700 outline-none placeholder:text-stone-400 focus:border-stone-400"
                      />
                      <VerbBtn testId="undo-change" tip="Undo this change" onClick={() => void undoEntry(selected, undoNote)}>
                        <ArrowUUpLeftIcon className="h-3.5 w-3.5" /> Undo
                      </VerbBtn>
                      <VerbBtn testId="keep-change" tip="Keep this change" primary onClick={() => void keepEntry(selected)}>
                        <CheckIcon className="h-3.5 w-3.5" weight="bold" /> Keep
                      </VerbBtn>
                    </>
                  ) : onHandoffToChat ? (
                    <VerbBtn testId="restore-ai" tip="Ask agent to restore this change onto the current version" onClick={() => restoreToChat(selected.filePaths)}>
                      <ClockCounterClockwiseIcon className="h-3.5 w-3.5" /> Restore
                    </VerbBtn>
                  ) : null}
                </>
              ) : null}
            </div>
            {range ? (
              <RangeCompareDetail
                workspaceId={workspaceId}
                from={range.from}
                to={range.to}
                // The filter means what it says: a compare under a file/folder
                // filter only shows the in-scope diffs (out-of-scope count noted).
                scopeToPath={scopeToPath}
              />
            ) : selected ? (
              <>
                <div className="min-h-0 flex-1 overflow-auto p-4">
                  {selected.kind === 'comment' ? (
                    <CommentDetail
                      key={selected.reviewId}
                      entry={selected}
                      onOpenFile={onOpenFile ? (path) => onOpenFile(path, { editable: false }) : undefined}
                    />
                  ) : selected.kind === 'turn' ? (
                    <TurnEditsCard
                      key={selected.reviewId}
                      assistantMessageId={selected.reviewId}
                      workspaceId={workspaceId}
                      initialCount={selected.editedFileCount}
                      variant="panel"
                      hideBulkActions
                      onOpenFile={onOpenFile ? (path) => onOpenFile(path, { editable: isSuggestionEntry(selected) }) : undefined}
                      // Under a file/folder filter, keep the detail to the in-scope
                      // files this entry represents.
                      restrictToPaths={scopeToPath ? selected.filePaths.filter(scopeToPath) : undefined}
                      onPayloadChange={handleDetailPayload}
                    />
                  ) : selected.kind === 'session' ? (
                    <AppliedEditDetail
                      key={selected.reviewId}
                      workspaceId={workspaceId}
                      entry={selected}
                      onOpenFile={onOpenFile ? (path) => onOpenFile(path, { editable: false }) : undefined}
                    />
                  ) : (
                    <RunReviewDetail
                      key={selected.reviewId}
                      workspaceId={workspaceId}
                      entry={selected}
                      hideBulkActions
                      onOpenFile={onOpenFile ? (path) => onOpenFile(path, { editable: isSuggestionEntry(selected) }) : undefined}
                      onPayloadChange={handleDetailPayload}
                      onResolveAlias={recordReviewIdAlias}
                    />
                  )}
                </div>
              </>
            ) : null}
          </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
