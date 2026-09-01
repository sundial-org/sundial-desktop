'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { InlineDocDiff } from '@/components/workspace/diff-review/inline-doc-diff';
import { renderedBlocks } from '@/lib/workspace/file-blame-core';
import type { TurnEditChunk, TurnEditLine, TurnEditsResponse } from '@/lib/workspace/turn-edits';
import { fetchTurnEdits, getCachedTurnEdits } from '@/lib/workspace/turn-edits-cache';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';

/** Fired by the authorship lens's margin annotations (collab-editor widget). */
export type AuthorshipHoverDetail = {
  assistantMessageId: string;
  chatId: string | null;
  filePath: string;
  /** Rendered text of the hovered run's first line — picks the right chunk. */
  lineText: string;
  /** Which copy of a repeated block this is among the turn's copies. */
  occurrence?: number;
  sideLabel: string;
  avatarUrl?: string | null;
  avatarRound?: boolean;
  /** Anchor rect (viewport coords) of the annotation. */
  x: number;
  y: number;
};

export const AUTHORSHIP_HOVER_EVENT = 'sundial:authorship-hover';

/**
 * Hover card for the authorship lens: what these lines looked like BEFORE the
 * attributed turn — the turn's own before/after chunk, rendered with the same
 * components as the in-chat diff cards (2026-08-05 founder request). Hover the
 * margin annotation to open; the card holds while the pointer is on it.
 */
export function AuthorshipHoverCard({
  onOpenTurn,
}: {
  onOpenTurn?: (assistantMessageId: string, chatId: string | null) => void;
}) {
  const [detail, setDetail] = useState<AuthorshipHoverDetail | null>(null);
  const [payload, setPayload] = useState<TurnEditsResponse | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearHide = () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
    const onHover = (event: Event) => {
      const next = (event as CustomEvent<AuthorshipHoverDetail | null>).detail;
      if (next) {
        clearHide();
        setDetail(next);
        return;
      }
      // Grace period so the pointer can cross from the annotation to the card.
      clearHide();
      hideTimerRef.current = setTimeout(() => setDetail(null), 250);
    };
    window.addEventListener(AUTHORSHIP_HOVER_EVENT, onHover);
    return () => {
      window.removeEventListener(AUTHORSHIP_HOVER_EVENT, onHover);
      clearHide();
    };
  }, []);

  const assistantMessageId = detail?.assistantMessageId ?? null;
  const apiFetch = useApiFetch();
  useEffect(() => {
    if (!assistantMessageId) return;
    const cached = getCachedTurnEdits(assistantMessageId);
    if (cached) {
      setPayload(cached);
      return;
    }
    let cancelled = false;
    setPayload(null);
    // Through the shared loader, never a private fetch: it dedupes in-flight
    // requests and — the reason this matters — refuses to cache an answer
    // fetched under a share scope that has since changed (Codex, PR #1104
    // round 29). It also routes local/sidecar workspaces through their shim.
    void fetchTurnEdits(apiFetch, assistantMessageId).then((data) => {
      if (!cancelled && data) setPayload(data);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantMessageId, apiFetch]);

  // The chunk that INTRODUCED the hovered text — the edit this annotation
  // attributes.
  const chunk = useMemo(() => {
    if (!detail || !payload) return null;
    const file = payload.files.find((f) => f.filePath === detail.filePath);
    if (!file) return null;
    // Blocks the chunk ADDED: render its after-text and subtract its
    // before-text as a MULTISET (a repeated line keeps its extra copy). Both
    // sides render in the chunk's own context, because markdown needs it — a
    // table row on its own parses as a paragraph while blame's text for it is
    // the individual cell, so a per-line render could never match a table
    // (Codex, PR #1104 round 25).
    const introducedBlocks = (lines: TurnEditLine[]) => {
      const render = (skip: TurnEditLine['type']) =>
        renderedBlocks(
          lines
            .filter((line) => line.type !== skip)
            .map((line) => line.content)
            .join('\n'),
        );
      const before = new Map<string, number>();
      for (const block of render('addition')) before.set(block, (before.get(block) ?? 0) + 1);
      const blocks = render('deletion').filter((block) => {
        const seen = before.get(block) ?? 0;
        if (seen > 0) {
          before.set(block, seen - 1);
          return false;
        }
        return true;
      });
      // A row appended to an existing table can fall OUTSIDE the chunk's
      // context window (the header row is further up the file), so even in
      // context the parser sees a paragraph. Re-render such a row under a
      // synthetic delimiter to get the same per-CELL blocks blame produces —
      // the split is still the one parser's, not a hand-rolled rule.
      for (const line of lines) {
        const row = line.content.trim();
        if (line.type !== 'addition' || !row.startsWith('|')) continue;
        const columns = row.replace(/^\||\|$/g, '').split('|').length;
        // A mismatched delimiter just parses back to a paragraph, which can't
        // match anything — no false positives from the attempt.
        blocks.push(...renderedBlocks(`${row}\n|${' --- |'.repeat(columns)}`));
      }
      return blocks;
    };
    // Blame is BLOCK-level (a wrapped paragraph joins its source lines) and
    // uses the SAME walk, never a looser normalizer — that one flattened an
    // inline image to its alt text while blame keeps the codec's literal
    // `![alt](src)` (round 24). Containment, not equality: the hovered run may
    // be a whole wrapped paragraph. Best match wins, never the first: with
    // `TODO` and `TODO details` in the same file, plain first-containment
    // showed the shorter block's diff for the longer line (round 27). Among
    // EXACT matches, the annotation's occurrence index picks which duplicate's
    // chunk this is — a turn adding the same block in two hunks showed the
    // first hunk's diff for both copies (round 32).
    const exact: TurnEditChunk[] = [];
    let best: { chunk: TurnEditChunk; score: number } | null = null;
    for (const chunk of file.chunks) {
      for (const block of introducedBlocks(chunk.lines)) {
        if (!detail.lineText.includes(block)) continue;
        if (block === detail.lineText) exact.push(chunk);
        else if (!best || block.length > best.score) best = { chunk, score: block.length };
      }
    }
    if (exact.length > 0) {
      return exact[Math.min(detail.occurrence ?? 0, exact.length - 1)]!;
    }
    return best?.chunk ?? null;
  }, [detail, payload]);

  if (!detail) return null;
  const left = Math.max(12, Math.min(detail.x - 340, window.innerWidth - 452));
  const top = Math.min(detail.y + 18, window.innerHeight - 320);
  return (
    <div
      data-testid="authorship-hover-card"
      className="fixed z-40 w-[440px] overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg"
      style={{ left, top }}
      onMouseEnter={() => {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      }}
      onMouseLeave={() => setDetail(null)}
    >
      <button
        type="button"
        onClick={() => onOpenTurn?.(detail.assistantMessageId, detail.chatId)}
        className="flex w-full items-center gap-1.5 border-b border-stone-100 px-3 py-2 text-left hover:bg-stone-50"
        title="Open the chat turn"
      >
        {detail.avatarUrl ? (
          <img
            src={detail.avatarUrl}
            alt=""
            draggable={false}
            className={`h-4 w-4 ${detail.avatarRound === false ? 'object-contain' : 'rounded-full object-cover'}`}
          />
        ) : null}
        <span className="min-w-0 truncate text-[12px] font-medium text-stone-700">{detail.sideLabel}</span>
      </button>
      <div className="max-h-72 overflow-y-auto px-2 py-2">
        {chunk ? (
          <InlineDocDiff
            chunk={chunk}
            filePath={detail.filePath}
            renderAsMarks
            hideButtons
            onKeep={() => {}}
            onUndo={() => {}}
          />
        ) : payload ? (
          <div className="px-2 py-4 text-center text-[12px] text-stone-500">
            No before/after recorded for this line.
          </div>
        ) : (
          <div className="px-2 py-4 text-center text-[12px] text-stone-400">Loading change…</div>
        )}
      </div>
    </div>
  );
}
