'use client';

// In-chat per-file edit cards (2026-08-01) — the chat rendering of a turn's
// edits, one card per touched file. The body reuses the editor's own diff
// renderer (InlineDocDiff renderAsMarks), so the preview is identical to the
// markdown editor's inline suggestion marks by construction. Design settled in
// the chat-gallery diff prototypes:
//  - always open, clamped to ~4 lines with a bottom caret to expand
//  - header: name, compact char counts, hover/focus-revealed /d/ link + ✓/✗
//  - deleted + oversized files are header-only
//  - header click / double-click anywhere opens the file in the editor
//  - flat, sentence case, no red/green status chrome outside the diff itself

import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { BlobFileNotice } from '@/components/workspace/diff-review/blob-file-notice';
import { CopyLinkButton } from '@/components/workspace/copy-link-button';
import { InlineDocDiff } from '@/components/workspace/diff-review/inline-doc-diff';
import {
  countFileChars,
  formatCompactCount,
} from '@/components/workspace/diff-review/turn-edit-helpers';
import type { TurnEditFile } from '@/lib/workspace/turn-edits';

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Exported for the chat's "all edits" tab, which renders the same card for a
 *  file merged across turns (see `lib/workspace/chat-file-edits`). */
export function ChatEditCard({
  file,
  assistantMessageId,
  projectId,
  busy,
  defaultExpanded = false,
  onKeepFile,
  onUndoFile,
  onOpenFile,
}: {
  file: TurnEditFile;
  assistantMessageId: string;
  projectId?: string;
  busy: boolean;
  /** ?diff= deep links land expanded — the link exists to reveal the changes. */
  defaultExpanded?: boolean;
  onKeepFile: (filePath: string) => void;
  onUndoFile: (filePath: string) => void;
  onOpenFile?: (filePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [clipped, setClipped] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Caret only when the clamp actually hides content — and the clamped window
  // scrolls itself to the FIRST CHANGE, not the top of the hunk: leading
  // context must never fill the whole preview (2026-08-01 feedback).
  // (ResizeObserver is absent in jsdom — fall back to the one-shot measure.)
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const check = () => {
      const isClipped = el.scrollHeight > el.clientHeight + 1;
      setClipped(isClipped);
      if (isClipped && !expanded) {
        // The changed region is the diff SURFACE (marks/code render); leading
        // context is plain prose above it. Anchoring to the surface is robust
        // regardless of which mark classes the codec emits.
        const firstChange = el.querySelector<HTMLElement>(
          '.diff-inline-doc-chunk, .diff-pending-addition, .diff-pending-deletion',
        );
        if (firstChange) {
          const top = Math.max(
            0,
            firstChange.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 6,
          );
          el.scrollTop = top;
          setScrolled(top > 1);
        }
      }
    };
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [file.chunks.length, expanded]);

  const name = baseName(file.filePath);
  const counts = countFileChars(file);
  // State machine (2026-08-01): pending chunks only exist for SUGGESTION files
  // (applied 'edit' files are born kept) — those are action items. In-doc
  // (kept/accepted) is the DEFAULT state: no label, hover reveals revert.
  // Out-of-doc gets a quiet label: 'discarded' (suggestion) / 'reverted'
  // (applied edit). NO editMode = a payload the undo routes can't act on
  // (mirrored local-agent ledger turns, pre-migration caches) — the card
  // stays informational: no accept/discard, no revert (Codex P2 on #1039).
  const mode = file.editMode;
  const pending = file.chunks.some((c) => c.status === 'pending');
  const allUndone = file.chunks.length > 0 && file.chunks.every((c) => c.status === 'undone');
  const inDoc = file.chunks.length > 0 && !pending && !allUndone;
  // Deleted and oversized files carry no reviewable body — header only.
  // Blobs (image/PDF artifacts) DO have a body: the added/updated notice and
  // image preview (Codex P2 on #1039).
  const headerOnly =
    file.isDeleted || Boolean(file.oversized) || (file.chunks.length === 0 && !file.blob);
  const sizeNote = file.oversized
    ? `Changed: file too large to show a diff${
        typeof file.lineCount === 'number' ? ` (${file.lineCount.toLocaleString()} lines)` : ''
      }.`
    : undefined;
  const open = () => onOpenFile?.(file.filePath);

  return (
    <div
      className={`group/card not-prose my-1.5 w-fit min-w-72 max-w-full rounded-xl border border-stone-200 bg-white ${
        allUndone ? 'opacity-60' : ''
      } ${busy ? 'pointer-events-none opacity-60' : ''}`}
      data-testid="chat-edit-card"
      data-file-path={file.filePath}
    >
      {/* Single click ANYWHERE in the header opens the file — action buttons
          excluded (2026-08-01 feedback; the old double-click is gone). */}
      <div
        className="flex h-8 cursor-pointer items-center gap-1.5 px-2.5"
        title={sizeNote ?? `Open ${file.filePath}`}
        onClick={(event) => {
          if ((event.target as HTMLElement | null)?.closest('button, a')) return;
          open();
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-left text-[13px] text-stone-600">
          <span
            className={`truncate font-medium ${
              file.isDeleted ? 'text-stone-400 line-through decoration-stone-300' : ''
            }`}
          >
            {name}
          </span>
          {file.isNew || file.isDeleted ? (
            <span className="shrink-0 rounded bg-stone-100 px-1 text-[10px] leading-4 text-stone-500">
              {file.isNew ? 'new' : 'deleted'}
            </span>
          ) : null}
          <span className="relative shrink-0 text-[12px] tabular-nums">
            {counts.added > 0 ? (
              <span className="text-emerald-600">+{formatCompactCount(counts.added)}</span>
            ) : null}{' '}
            {counts.deleted > 0 ? (
              <span className="text-red-400">−{formatCompactCount(counts.deleted)}</span>
            ) : null}
            <IconTooltip label={counts.unit === 'lines' ? 'lines' : 'characters'} side="top" />
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-3">
          <span className="flex items-center opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100">
            <CopyLinkButton
              url={
                typeof window === 'undefined'
                  ? ''
                  : `${window.location.origin}/d/${assistantMessageId}`
              }
              label="Copy diff link"
              tooltip="Copy diff link"
              iconClassName="h-3.5 w-3.5"
            />
          </span>
          {pending && mode ? (
            // Action item. A suggestion's ✓/✗ stay quietly visible (dimmed,
            // full on hover) — the review isn't done until you decide; a
            // (legacy) pending applied edit keeps hover-only.
            <span
              className={`flex items-center gap-1 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 ${
                mode === 'suggest' ? 'opacity-60' : 'opacity-0'
              }`}
            >
              <button
                type="button"
                className="diff-pending-undo"
                data-testid="chat-edit-discard"
                title={mode === 'suggest' ? 'Discard suggestion' : "Revert this file's edits"}
                onClick={() => onUndoFile(file.filePath)}
              >
                ✕
              </button>
              <button
                type="button"
                className="diff-pending-keep"
                data-testid="chat-edit-accept"
                title={mode === 'suggest' ? 'Accept suggestion' : "Keep this file's edits"}
                onClick={() => onKeepFile(file.filePath)}
              >
                ✓
              </button>
            </span>
          ) : inDoc && mode ? (
            // Default state (applied / accepted) — NO label; hover reveals a
            // quiet revert icon.
            <button
              type="button"
              aria-label="Revert this file's edits"
              data-testid="chat-edit-revert"
              onClick={() => onUndoFile(file.filePath)}
              className="relative flex h-6 w-6 items-center justify-center rounded text-stone-400 opacity-0 transition-all hover:bg-stone-100 hover:text-stone-700 focus-visible:opacity-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100"
            >
              <ArrowCounterClockwiseIcon weight="bold" className="h-3.5 w-3.5" />
              <IconTooltip label="Revert this file's edits" side="top" />
            </button>
          ) : allUndone ? (
            <span className="text-[11px] font-medium text-stone-400" data-testid="chat-edit-status">
              {mode === 'suggest' ? 'discarded' : 'reverted'}
            </span>
          ) : null}
        </span>
      </div>
      {headerOnly ? null : file.blob ? (
        <div className="border-t border-stone-100 px-2 py-1.5">
          <BlobFileNotice file={file} projectId={projectId} />
        </div>
      ) : (
        <div className="border-t border-stone-100">
          <div
            ref={bodyRef}
            className={`px-2 py-1.5 ${
              expanded
                ? ''
                : `max-h-24 overflow-hidden ${
                    clipped && scrolled
                      ? '[mask-image:linear-gradient(to_bottom,transparent_0,black_14px,black_calc(100%-14px),transparent_100%)]'
                      : clipped
                        ? '[mask-image:linear-gradient(to_top,transparent_0,black_16px)]'
                        : ''
                  }`
            }`}
          >
            {file.chunks.map((chunk) => (
              <InlineDocDiff
                key={chunk.id}
                chunk={chunk}
                filePath={file.filePath}
                renderAsMarks
                hideButtons
                onKeep={() => onKeepFile(file.filePath)}
                onUndo={() => onUndoFile(file.filePath)}
              />
            ))}
          </div>
          {clipped || expanded ? (
            <button
              type="button"
              aria-label={expanded ? 'Collapse diff' : 'Show full diff'}
              onClick={() => setExpanded((e) => !e)}
              className="flex h-5 w-full items-center justify-center rounded-b-xl text-stone-300 transition-colors hover:bg-stone-50 hover:text-stone-500"
            >
              <ChevronDownIcon
                className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Big turns (repo generation, mass refactors) can touch dozens of files —
 *  mounting a diff renderer per file made the transcript crawl (Codex P2 on
 *  #1039). Cards past this cap mount on demand via a quiet "N more files"
 *  line in the tool-row idiom. */
const CARD_CAP = 6;

/** All of a turn's edits as per-file cards. Keep/undo is whole-file (one
 *  suggestion-mark group per file — same semantics as TurnEditsCard). */
export function ChatEditCards({
  files,
  assistantMessageId,
  projectId,
  activeUndoKey,
  defaultExpanded = false,
  onKeepFile,
  onUndoFile,
  onOpenFile,
}: {
  files: TurnEditFile[];
  assistantMessageId: string;
  projectId?: string;
  activeUndoKey: string | null;
  /** ?diff= deep links land expanded. */
  defaultExpanded?: boolean;
  onKeepFile: (filePath: string) => void;
  onUndoFile: (filePath: string) => void;
  onOpenFile?: (filePath: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? files : files.slice(0, CARD_CAP);
  const hidden = files.length - shown.length;
  return (
    <div data-testid="chat-edit-cards">
      {shown.map((file) => (
        <ChatEditCard
          key={file.id}
          file={file}
          assistantMessageId={assistantMessageId}
          projectId={projectId}
          busy={activeUndoKey === '__all__' || activeUndoKey === `__file__:${file.filePath}`}
          defaultExpanded={defaultExpanded}
          onKeepFile={onKeepFile}
          onUndoFile={onUndoFile}
          onOpenFile={onOpenFile}
        />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          data-testid="chat-edit-cards-more"
          className="flex h-6 w-fit items-center gap-2 text-[14px] text-stone-400 transition-colors hover:text-stone-600"
        >
          <span className="flex w-3 shrink-0 justify-center">
            <span className="size-1.5 rounded-full bg-stone-300" />
          </span>
          {hidden} more {hidden === 1 ? 'file' : 'files'}
        </button>
      ) : null}
    </div>
  );
}
