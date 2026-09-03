"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  GlobeIcon,
  HashIcon,
  LinkBreakIcon,
  LinkSimpleIcon,
  LockSimpleIcon,
  ParagraphIcon,
  PencilSimpleIcon,
} from '@phosphor-icons/react';
import { useAuth } from '@/lib/auth/optional-auth';
import { getSpellcheckPreference } from '@/lib/spellcheck';
import { usePathShareRealtimeAuthReady } from '@/lib/workspace/use-path-share-realtime-ready';
import { EditorContent, useEditor, type Editor, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
// v3's CollaborationCaret fixes the v2 awareness-listener leak upstream (the v2
// extension never removed its `update` listener, leaking the whole editor on
// every file switch → renderer OOM "Aw Snap" on long math-heavy sessions), so
// the former local leak-shim is gone.
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { attributionMatchKey } from '@/lib/workspace/authorship-lens';
import type { SuggestionAuthorInfo } from '@/lib/workspace/pending-additions';
import { allowSuggestionBlockMarks, SuggestionDocument, SuggestionNodeAttributes, InsertionMark, DeletionMark, ModificationMark, SuggestionChanges, stripDeletedText, flattenSuggestions, refreshSuggestionReview } from '@/lib/workspace/suggestion-marks';
import { recordMarkdownSuggestionResolution, recordRejectCascadeOutcome, serializeDoc } from '@/lib/crdt-js/markdown_yjs.mjs';
import {
  buildAnchorSuggestions,
  resolveAnchorNotePath,
  splitAnchorQuery,
  wikiAliasBase,
  type WikiAnchorSuggestion,
} from '@/lib/workspace/wiki-anchor-picker';
import { setFreezeContext, fileTypeFromPath } from '@/lib/perf/freeze-monitor';
import {
  afterNextPaint,
  finishFileSync,
  finishFileVisible,
  startFileOpen,
} from '@/lib/perf/file-open-timing';
import { useDocumentEditMode } from '@/lib/workspace/document-edit-mode-context';
import { isEditorImageFile } from '@/lib/workspace/heic';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table } from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import Placeholder from '@tiptap/extension-placeholder';
import Image, { type ImageOptions } from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
// Decoration-based KaTeX (vendored from the v2 extension): math stays as plain
// `$…$` text in the Y.Doc so the markdown round-trip is lossless. See the file
// header for why we don't use v3's node-based mathematics extension.
import AutolinkDecorations from '@/lib/tiptap/autolink-decorations';
import BlockIdBadges from '@/lib/tiptap/block-id-decorations';
import EmbedPreview from '@/lib/tiptap/embed-preview';
import Mathematics, { MATH_TEXT_REGEX } from '@/lib/tiptap/math-decorations';
import TagCommentDecorations, { outsideSourceComment } from '@/lib/tiptap/tag-comment-decorations';
import FootnoteDecorations, { outsideFootnote } from '@/lib/tiptap/footnote-decorations';
import CodeBlockShiki from '@/lib/tiptap/code-block-shiki';
import MermaidPreview from '@/lib/tiptap/mermaid-preview';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { DOMParser as ProseMirrorDOMParser, Slice, type Mark as ProseMirrorMark, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { markdownToHtml } from '@/lib/markdown/html.mjs';
import { isGoogleDocsClipboardHtml, normalizeGoogleDocsHtml } from '@/lib/markdown/google-docs-paste';
import {
  isProseMirrorClipboardHtml,
  pasteLooksLikeMarkdown,
  shouldDeferToHtmlPaste,
} from '@/lib/markdown/paste-routing';
import { resolveLinkTargetToPath } from '@/lib/workspace/wiki-file-links';
import { ObsidianBlockquote, ObsidianLink } from '@/lib/tiptap/obsidian';
import { CalloutFold } from '@/lib/tiptap/callout-fold';
import { FoldGutter } from '@/lib/tiptap/fold';
import { ListJoin } from '@/lib/tiptap/list-join';
import { ListPaste, pasteListBesideChildren } from '@/lib/tiptap/list-paste';
import { CHECKBOX_RE, checkboxStateAt } from '@/lib/markdown/checkbox';
import { BulletMarker, HardBreakMarker, MarkdownSourceFidelity } from '@/lib/markdown/codec';
import { Frontmatter } from '@/lib/tiptap/frontmatter';
import { SuggestionReviewBar } from '@/components/workspace/suggestion-review-bar';
import { FrontmatterPreview } from '@/lib/tiptap/frontmatter-preview';
import { FrontmatterNormalize } from '@/lib/tiptap/frontmatter-normalize';
import { HtmlPreview, type HtmlPreviewOptions } from '@/lib/tiptap/html-preview';
import { PointerSelection } from '@/lib/tiptap/pointer-selection';
import { ScopedSelectAll } from '@/lib/tiptap/scoped-select-all';
import { CaretEdgeScroll } from '@/lib/tiptap/caret-edge-scroll';
import { TableShiftSelection } from '@/lib/tiptap/table-shift-selection';
import { applyIncremental, changedBlockSpan } from '@/lib/tiptap/incremental-decorations';
import { EditorTabGuard, UndoBoundaries } from '@/lib/tiptap/structural-keys';
// Keeps the text selection visibly highlighted while DOM focus is elsewhere
// (e.g. the chat input right after "Ask Sunny") — decoration-only.
import { Selection as BlurSelectionHighlight } from '@tiptap/extensions';
import {
  EditorBubbleMenu,
  EditorCalloutControls,
  EditorTableControls,
} from '@/components/workspace/editor-bubble-menu';
import { EditorSlashMenu } from '@/components/workspace/editor-slash-menu';
import { EditorAskInput } from '@/components/workspace/editor-ask-input';
// Static on purpose: the popup opens via a window event, and a lazily-mounted
// listener races the first click (the event fires before the chunk mounts —
// the user's first rewrite would silently no-op). The popup itself is a light
// shell; it lazy-loads its heavy diff/codec internals on open.
import { EditorRewritePopup } from '@/components/workspace/editor-rewrite-popup';
// Same idiom for the whole AI-tools family (Prism / resize / factcheck /
// pangram / image gen): static light shells, window-event opened, heavy
// anchor/codec internals lazy-loaded on open.
import { EditorPrismPopup } from '@/components/workspace/editor-prism-popup';
import { EditorLengthResize } from '@/components/workspace/editor-length-resize';
import { EditorPangramPopup } from '@/components/workspace/editor-pangram-popup';
import { EditorImageGenPopup } from '@/components/workspace/editor-image-gen';
import {
  computeCommentScroll,
  pickCommentAtPos,
  retryUntilDone,
  type ResolvedDocCommentRange,
} from '@/lib/workspace/doc-comments';
import { fetchWorkspaceHost, resolveCollabUrl, type ConnectionStatus } from '@/lib/workspace/collab-url';
import { resolvePosition } from '@/lib/workspace/rewrite-anchor';
import { selectWordAtCoords } from '@/lib/workspace/doc-comments-client';
import { resolveWorkspaceImageSrc, unresolveWorkspaceImageSrc } from '@/lib/workspace/image-src';
import { imageMarkdown, imageWidthAttribute, parseAltSizeSpec } from '@/lib/markdown/image-attrs.mjs';
import { trackYDocUserEdits } from '@/lib/analytics/document-edit-tracker';
import { track } from '@/lib/analytics/track';
import {
  buildDeletionWidgetHtml,
} from '@/lib/workspace/diff-markdown-html';
import type { TurnEditLine } from '@/lib/workspace/turn-edits';
import {
  acquireProvider,
  releaseProvider,
  useWorkspaceCollabSocket,
  useWorkspaceCollabSocketPending,
} from '@/lib/workspace/collab-socket-context';
import { useCollabSyncWatchdog } from '@/lib/workspace/use-collab-sync-watchdog';
import { AgentGhostCursor } from '@/components/workspace/agent-ghost-cursor';
import { EditorSkeleton } from '@/components/workspace/editor-skeleton';
import { buildCursorCaret, restartCursorLabelFade } from '@/components/workspace/cursor-fade';
import { brandForAgentId } from '@/lib/workspace/agent-brand';
import { DIFF_CHECK_ICON_SVG, DIFF_X_ICON_SVG } from '@/lib/workspace/diff-action-icons';
import { createBrowserClient } from '@/lib/supabase/browser';

type CollabUser = {
  name: string;
  color: string;
  /** Presence-channel key (`user:<id>` / `anon:<id>`) broadcast into awareness
   *  so a clicked presence bubble can find this client's caret. */
  presenceKey?: string;
};

/** One-shot ask to scroll this editor to a remote collaborator's caret.
 *  `seq` distinguishes repeat clicks on the same peer. */
export type RevealPeerRequest = {
  seq: number;
  presenceKey?: string | null;
  /** Fallback identity for peers with no presenceKey in awareness (older
   *  clients, local-mode composites): the bubble's name/color pair. */
  name?: string | null;
  color?: string | null;
};

type ReadyPayload = {
  editor: Editor;
  ydoc: Y.Doc;
};

export interface PendingAddition {
  /** Stable key, e.g. `${assistantMessageId}:${chunkId}`. */
  key: string;
  /**
   * Review-unit id this chunk belongs to (the `assistantMessageId` / human
   * `human-<rowId>` run id). Multiple chunks of one human paste/typing burst
   * share a groupKey so the overlay shows ONE Accept/Reject for the whole
   * action instead of one per server-diff chunk.
   */
  groupKey?: string;
  /** Addition text — multi-line OK. The plugin matches block text against each non-empty line. */
  text: string;
  /** When false, Keep/Undo buttons are hidden (older turn). */
  canMutate: boolean;
  /**
   * Optional deletion text — used to compute word-level highlights against the
   * post-edit block. Rendered as a red ghost above additions (no strikethrough).
   */
  deletedText?: string;
  /** Optional short author label (e.g. `Sunny #354`, `turboblitz`). */
  authorLabel?: string;
  /** Avatar imagery for the author chip (Sunny face / brand mark / overrides). */
  authorVisual?: {
    imageUrl?: string | null;
    imageRound?: boolean;
    chipLabel?: string;
    chipColor?: string;
  };
  /** Assistant message id this addition came from — used to jump to the turn. */
  assistantMessageId?: string;
  /** Chat id that owns the assistant message — required to switch chats on jump. */
  chatId?: string;
  /**
   * Full ordered hunk ops (consumed by the code/Tex editor for hunk-position
   * matching). Ignored by the markdown editor which uses block matching.
   */
  lines?: TurnEditLine[];
  /** 0-indexed expected starting line in the new file. */
  newStart?: number;
}

export interface AttributionPaintRange {
  key: string;
  text: string;
  authorLabel: string;
  toolCallId?: string | null;
  colorIndex: number;
  /** Share-redacted occurrence: consumes its positional slot (so later
   *  same-text copies stay aligned) but paints no band and no annotation. */
  hidden?: boolean;
  /** "Author · when" margin annotation (the authorship lens). Only rendered on
   *  the first block of a consecutive same-annotation run. */
  sideLabel?: string;
  /** Avatar beside the margin label — same imagery as the chat list. */
  avatarUrl?: string | null;
  avatarRound?: boolean;
  /** Chat turn behind this attribution; clicking the label jumps to it. */
  assistantMessageId?: string | null;
  chatId?: string | null;
  onJump?: () => void;
  /** File the ranges belong to — carried into the hover-card event. */
  filePath?: string | null;
  /** Which copy of a repeated block this is among the SAME turn's copies
   *  (document order) — disambiguates duplicate-text hovers. */
  occurrence?: number;
}

interface CollabEditorProps {
  fileId: string;
  /** Workspace project id. When set the editor connects to the
   *  per-workspace Sunny sandbox instead of the global Hocuspocus. */
  workspaceId?: string;
  /** Cloud project id authorized for workspace-global assistant actions.
   *  Omit for local workspaces and members without workspace-wide write. */
  selectionActionsProjectId?: string;
  /** Path on the workspace volume. Used as the Yjs document name when the
   *  Sunny sandbox connection is active. */
  filePath?: string;
  /** Overrides filePath for the Yjs room name only. Set during an in-flight
   *  optimistic move of the open file: the tree/chat already show the new
   *  path while the room must stay on the old one until the rename commits. */
  collabPath?: string;
  placeholder?: string;
  user: CollabUser;
  initialContent?: Record<string, unknown> | string | null;
  onReady?: (payload: ReadyPayload) => void;
  onContentChange?: () => void;
  onConnectionStatusChange?: (status: ConnectionStatus) => void;
  className?: string;
  hidden?: boolean;
  readOnly?: boolean;
  /** False for commenters: they compose suggestions but the ✓/✕ resolve
   *  controls (per-group, per-block, accept/reject-all) stay editor-only. */
  canResolveSuggestions?: boolean;
  /** True for commenters: suggesting is on regardless of the stored edit
   *  mode, synchronously from the first render — no edit-mode window. */
  forceSuggesting?: boolean;
  codeMode?: boolean;
  wikiLinkSuggestions?: string[];
  onNavigateToFile?: (file: string | null) => void;
  /** Raw wiki target (`note#Heading`, `note#^id`, `#Heading`, …) from a
   *  Cmd-click / hover-card open. The workspace resolves path + anchor and
   *  owns the scroll/toast; absent, wiki targets fall back to
   *  `onNavigateToFile` with the raw string (legacy path-only behavior). */
  onNavigateToWikiTarget?: (target: string) => void;
  /** Markdown text of another workspace note, for `[[note#` anchor
   *  autocomplete (the open file reads its own live doc instead). */
  fetchWikiNoteText?: (path: string) => Promise<string | null>;
  style?: CSSProperties;
  /** Server-derived pending additions for a review surface. The markdown editor
   *  renders suggestions from live Y.Doc marks, so these are currently a no-op
   *  here — but the diff-review walkthrough still passes them (and may render a
   *  payload-based fallback for non-marked turns), so keep them on the type. */
  pendingAdditions?: PendingAddition[];
  onKeepAddition?: (key: string) => void;
  onUndoAddition?: (key: string) => void;
  onJumpToTurn?: (assistantMessageId: string, chatId: string | null) => void;
  /** Suggestion mark id → author + turn, for the review gutter's profile icon
   *  (click = open that chat turn). Markdown only. */
  suggestionAuthors?: Record<string, SuggestionAuthorInfo>;
  /** External comment ranges resolved against the current Yjs document. */
  commentRanges?: ResolvedDocCommentRange[];
  /** Temporary draft range for a new comment being composed. */
  draftCommentRange?: { from: number; to: number } | null;
  /** The currently selected comment thread. */
  activeCommentThreadId?: string | null;
  /** Called when the user clicks text inside a comment range — selects that
   *  thread in the lane (Google-Docs-style "emphasize the comment on the right"). */
  onSelectComment?: (threadId: string) => void;
  /** Best-effort history attribution paint ranges for the active document. */
  attributionRanges?: AttributionPaintRange[];
  /**
   * Called when an image is dropped or pasted into the editor. Returns the
   * `src`/`alt` to insert, or `null` to skip insertion. The editor handles
   * preventDefault + node insertion; the caller handles the upload.
   */
  onImageDrop?: (file: File) => Promise<{ src: string; alt: string } | null>;
  /** Scroll to a remote collaborator's caret in this doc (bubble click). */
  revealPeer?: RevealPeerRequest | null;
  /** Reveal delivered (scrolled) or given up — the owner clears the request
   *  so a later remount of this file can't replay it. */
  onRevealPeerDone?: (seq: number) => void;
  /** Editor gained focus — presence uses this to broadcast which file the
   *  user is actually editing (split panes make "the selected file" wrong). */
  onFocused?: () => void;
}

type LinkMenuRect = { left: number; right: number; top: number; bottom: number };

type LinkMenuState = {
  /** `wiki` = triggered by typing `[[`; `link` = triggered by Cmd-K / "Add link". */
  mode: 'wiki' | 'link';
  /** Range in the doc that will be replaced when a suggestion is picked. */
  from: number;
  to: number;
  /** Doc position used to recompute the screen rect on scroll/resize. */
  anchorPos: number;
  /** In `wiki` mode this mirrors the doc text after `[[`. In `link` mode it's the URL/search input. */
  query: string;
  /** Link-mode only: editable display text for the link. */
  label?: string;
  /**
   * True once the user has typed in the Text field. Lets us safely overwrite
   * the displayed label when they pick a different file from the menu — but
   * only when the label is still the auto-derived one (the basename of the
   * previously-linked file or the selected text), not a custom string they
   * intentionally authored.
   */
  labelEdited?: boolean;
  /** Anchor rectangle in viewport coords. Updated on scroll/resize. */
  rect: LinkMenuRect;
  /** Selected text captured at open time. */
  selectionText?: string;
  /** True when editing an existing link (vs creating a new one). */
  editing?: boolean;
  /** Wiki mode only: the query contains `#`, so the menu lists the target
   *  note's headings (`#`) or blocks (`#^`) instead of files. */
  anchor?: {
    path: string;
    kind: 'heading' | 'block';
    query: string;
    /** The query had no file part (`[[#Intro]]`) — emit a PATHLESS target so
     *  the self-link survives a rename, exactly like a hand-typed one. */
    sameFile: boolean;
  } | null;
};

type LinkHoverCardState = {
  /** Range of the link mark in the doc. */
  from: number;
  to: number;
  /** Resolved navigation target — `obsidianTarget` for wiki links, `href` otherwise. */
  href: string;
  /** True for `![[…]]` embeds. */
  isWiki: boolean;
  /** Anchor rectangle in viewport coords. Updated on scroll/resize. */
  rect: LinkMenuRect;
  anchorPos: number;
};

type LinkMenuItem =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string; label: string }
  | { kind: 'anchor'; suggestion: WikiAnchorSuggestion };

/** Target note text backing the anchor items. `status` distinguishes a fetch
 *  still in flight from one that came back empty — `content: null` alone made
 *  an unreadable file (the picker lists every non-folder file) sit on
 *  "Loading…" forever instead of saying there are no matches. */
type AnchorNoteState = {
  path: string;
  content: string | null;
  status: 'loading' | 'ready' | 'error';
};

const URL_RE = /^(?:https?:\/\/|mailto:|tel:)/i;

/**
 * Find an in-progress file-picker trigger in the text immediately before the
 * caret. Two trigger styles are supported (Obsidian + Slack/Notion-ish):
 *
 *   - `[[query`  — anywhere; the query continues until the user types `]]`,
 *                  a newline, or moves the caret away.
 *   - `@query`   — only at start-of-block or after whitespace/punctuation, so
 *                  ordinary text with `@` (emails, mentions in prose) doesn't
 *                  pop the menu unintentionally.
 *
 * Both produce the same `mode: 'wiki'` state (the picker logic is identical);
 * only the trigger range differs so the apply step replaces the trigger glyphs
 * along with the typed query.
 */
// Obsidian-style `[[file]]` linking (Alexis #8): typing `[[` (or `@`) opens an
// inline file picker anchored at the caret — no command palette. The query is
// the text after `[[` up to the cursor; selecting a suggestion inserts a wiki
// link node. See `buildLinkMenuItems` / `applyLinkChoice` for the menu + apply.
function activeWikiLinkQuery(view: EditorView): LinkMenuState | null {
  const { state } = view;
  const { selection } = state;
  if (!selection.empty) return null;

  const { $from } = selection;
  const parentStart = $from.start();
  const beforeCursor = state.doc.textBetween(parentStart, selection.from, '\n', '\0');

  let triggerIndex = -1;
  let query = '';
  const wikiIdx = beforeCursor.lastIndexOf('[[');
  if (wikiIdx !== -1) {
    const candidate = beforeCursor.slice(wikiIdx + 2);
    if (!candidate.includes(']]') && !candidate.includes('\n')) {
      triggerIndex = wikiIdx;
      query = candidate;
    }
  }
  if (triggerIndex === -1) {
    // `@` trigger: must be at start-of-block or preceded by whitespace /
    // common sentence punctuation. NB: `!` is intentionally NOT in the
    // preceding-chars set — a wiki link inserted right after `!` round-trips
    // through markdown as `![[…]]` which the parser re-reads as an embed,
    // and embeds get the soft-yellow chip styling. Excluding `!` here keeps
    // the trigger from setting that trap. Query can't contain whitespace,
    // brackets, newlines, or another `@` (so `user@example.com` typed after
    // the first hit doesn't extend the menu through the email address).
    const atMatch = beforeCursor.match(/(?:^|[\s(,;:?])@([^\s\[\]\n@]*)$/);
    if (atMatch) {
      const matchedQuery = atMatch[1] ?? '';
      triggerIndex = beforeCursor.length - matchedQuery.length - 1;
      query = matchedQuery;
    }
  }
  if (triggerIndex === -1) return null;

  const anchorPos = selection.from;
  let rect: LinkMenuRect;
  try {
    rect = view.coordsAtPos(anchorPos);
  } catch {
    return null;
  }

  return {
    mode: 'wiki',
    from: parentStart + triggerIndex,
    to: anchorPos,
    anchorPos,
    query,
    rect,
  };
}

/**
 * Typed-out wiki link: the closing `]]` of `[[target|alias]]` converts the
 * whole token to a wiki link mark without the autocomplete menu — the same
 * mark the picker inserts and exactly what the markdown codec produces for
 * literal `[[…]]` on reload, so live and round-tripped docs agree. Dangling
 * targets are allowed, matching the codec. Returns true when handled.
 */
export function linkifyTypedWikiLink(view: EditorView, from: number, to: number, text: string): boolean {
  if (text !== ']') return false;
  const { state } = view;
  const linkMark = state.schema.marks.link;
  if (!linkMark) return false;
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code) return false;
  // Inline code too: the markdown parser keeps `[[…]]` inside code spans
  // literal, so live typing must as well (Codex P2).
  const codeMark = state.schema.marks.code;
  if (codeMark && (state.storedMarks ?? $from.marks()).some((mark) => mark.type === codeMark)) {
    return false;
  }
  const blockStart = $from.start();
  // Same position arithmetic as activeWikiLinkQuery: 1 char per position.
  const withClose = state.doc.textBetween(blockStart, from, '\n', '\0') + text;
  if (!withClose.endsWith(']]')) return false;
  const open = withClose.lastIndexOf('[[');
  if (open === -1) return false;
  const inner = withClose.slice(open + 2, withClose.length - 2);
  if (!inner.trim() || /[\[\]\n]/.test(inner)) return false;
  // `![[…]]` is an embed token — leave it as text (the codec renders it as an
  // embed on reload; linkifying here would silently drop the `!` semantics).
  if (open > 0 && withClose[open - 1] === '!') return false;

  const [rawTarget, rawAlias] = inner.split('|', 2);
  const target = rawTarget.trim();
  const alias = rawAlias?.trim() ?? '';
  if (!target) return false;
  // Display alias || target — what the markdown parser shows for this token.
  // Keep the OTHER active marks (bold/italic/…): the parser keeps surrounding
  // marks for `**[[foo]]**`, so live typing must too (Codex P2).
  const display = alias || target;
  const carried = (state.storedMarks ?? $from.marks()).filter(
    (mark) => mark.type !== linkMark,
  );
  const node = state.schema.text(display, [
    ...carried,
    linkMark.create({
      href: '#',
      obsidianType: 'wiki',
      obsidianTarget: target,
      obsidianAlias: alias || null,
      obsidianEmbed: false,
    }),
  ]);
  const tr = state.tr.replaceWith(blockStart + open, to, node);
  tr.setSelection(TextSelection.create(tr.doc, blockStart + open + display.length));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function fileMatches(paths: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return paths
    .filter((path) => {
      if (!q) return true;
      const basename = path.split('/').pop()?.toLowerCase() ?? path.toLowerCase();
      return path.toLowerCase().includes(q) || basename.includes(q);
    })
    // Generous cap; the menu's scroll container handles overflow.
    .slice(0, 200);
}

function buildLinkMenuItems(
  state: LinkMenuState,
  suggestions: string[],
  anchorNote?: AnchorNoteState | null,
): LinkMenuItem[] {
  if (state.mode === 'wiki' && state.anchor) {
    if (!anchorNote || anchorNote.path !== state.anchor.path || anchorNote.content == null) return [];
    return buildAnchorSuggestions(anchorNote.content, state.anchor.path, {
      filePart: '',
      kind: state.anchor.kind,
      anchorQuery: state.anchor.query,
    }).map((suggestion) => ({ kind: 'anchor' as const, suggestion }));
  }
  const items: LinkMenuItem[] = [];
  const trimmed = state.query.trim();
  if (state.mode === 'link' && trimmed.length > 0) {
    // Any non-empty input is a valid link target — URLs, internal paths,
    // anchor refs (`#section`), even `mailto:` shortcuts. Label it
    // explicitly so the user knows what will happen when they pick it.
    const isUrl = URL_RE.test(trimmed);
    items.push({
      kind: 'url',
      url: trimmed,
      label: isUrl ? 'Use this URL' : 'Use as link',
    });
  }
  for (const path of fileMatches(suggestions, state.query)) {
    items.push({ kind: 'file', path });
  }
  return items;
}

/** Resolve a link mark at `pos`, expanding to the full contiguous run. */
function getLinkRangeAt(
  state: EditorState,
  pos: number,
): { from: number; to: number; mark: ProseMirrorMark } | null {
  const linkType = state.schema.marks.link;
  if (!linkType) return null;
  const $pos = state.doc.resolve(pos);
  const parentStart = $pos.start();
  const parentEnd = $pos.end();

  const markAt = (p: number): ProseMirrorMark | null => {
    if (p < parentStart || p >= parentEnd) return null;
    const node = state.doc.nodeAt(p);
    return node?.marks.find((m) => m.type === linkType) ?? null;
  };

  // Prefer the character to the right of `pos`; fall back to the left so a
  // cursor parked at the end of a link still resolves.
  const mark = markAt(pos) ?? markAt(pos - 1);
  if (!mark) return null;

  let from = pos;
  while (from > parentStart) {
    const m = markAt(from - 1);
    if (!m || !m.eq(mark)) break;
    from -= 1;
  }
  let to = pos;
  while (to < parentEnd) {
    const m = markAt(to);
    if (!m || !m.eq(mark)) break;
    to += 1;
  }
  if (from === to) return null;
  return { from, to, mark };
}

function resolveLinkTarget(mark: ProseMirrorMark): string {
  const target = (mark.attrs.obsidianTarget as string | null | undefined)?.trim();
  if (target) return target;
  return (mark.attrs.href as string | undefined) ?? '';
}

/** Replace the trigger/selection range with wiki-marked `text` (shared by the
 *  file and anchor picker branches — includes the leading-`!` embed guard). */
function insertWikiLinkText(view: EditorView, state: LinkMenuState, text: string, attrs: Record<string, unknown>) {
  const schema = view.state.schema;
  const linkMark = schema.marks.link;
  if (!linkMark) return;
  // Guard against a wiki link landing immediately after `!` — when the doc
  // round-trips through markdown that becomes `![[…]]`, the parser flags it
  // as an embed and the embed CSS turns the link into a yellow chip. Strip
  // a single leading `!` so the inserted link can't accidentally become an
  // embed on reload.
  let insertFrom = state.from;
  if (state.from > 0) {
    const prevChar = view.state.doc.textBetween(state.from - 1, state.from, '\n', '\0');
    if (prevChar === '!') insertFrom = state.from - 1;
  }
  const node = schema.text(text, [linkMark.create(attrs)]);
  const tr = view.state.tr.replaceWith(insertFrom, state.to, node);
  tr.setSelection(TextSelection.create(tr.doc, insertFrom + text.length));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function applyLinkChoice(
  view: EditorView,
  state: LinkMenuState,
  item: LinkMenuItem,
) {
  const schema = view.state.schema;
  const linkMark = schema.marks.link;
  if (!linkMark) return;

  if (item.kind === 'anchor') {
    const s = item.suggestion;
    // `[[#Intro]]` must stay pathless: baking in the current path would break
    // the self-link the moment the note is renamed or moved.
    const prefix = state.anchor?.sameFile ? '' : s.path;
    let target: string;
    let text: string;
    if (s.kind === 'heading') {
      target = `${prefix}#${s.heading}`;
      text = s.heading;
    } else {
      // Only blocks that already carry an ID are listed — see listBlockAnchors.
      target = `${prefix}#^${s.id}`;
      text = `${wikiAliasBase(s.path)} ^${s.id}`;
    }
    insertWikiLinkText(view, state, text, {
      href: '#',
      obsidianType: 'wiki',
      obsidianTarget: target,
      obsidianAlias: text,
      obsidianEmbed: false,
    });
    return;
  }

  const isFile = item.kind === 'file';
  // Show just the file's basename in the doc — the full path goes on the
  // mark (so navigation and serialization still work). Markdown serializer
  // emits `[[full/path|basename]]` whenever the displayed text differs from
  // the target, so this round-trips losslessly.
  const basename = isFile ? (item.path.split('/').pop() ?? item.path) : '';
  const fallbackLabel = isFile ? basename : item.url;
  // In *edit* mode the label was pre-filled from the previously-linked
  // file's basename. If the user then picks a different file without
  // touching the Text field, follow the new file (otherwise the label
  // stays stuck on "hello.md" after they retargeted to "world.md"). When
  // creating a *new* link, the prefilled label came from the user's own
  // selection ("click here") — always preserve that.
  const labelIsCustom = !!(state.labelEdited && state.label && state.label.trim());
  const overrideLabel = isFile && state.editing && !labelIsCustom;
  const rawLabel = overrideLabel
    ? fallbackLabel
    : (state.label ?? state.selectionText ?? fallbackLabel);
  const text = rawLabel.trim() ? rawLabel : fallbackLabel;
  const alias = isFile && text !== item.path ? text : null;
  const mark = linkMark.create(
    isFile
      ? {
          href: '#',
          obsidianType: 'wiki',
          obsidianTarget: item.path,
          obsidianAlias: alias,
          obsidianEmbed: false,
        }
      : { href: item.url },
  );

  // Guard against a wiki link landing immediately after `!` — when the doc
  // round-trips through markdown that becomes `![[…]]`, the parser flags it
  // as an embed and the embed CSS turns the link into a yellow chip. Strip
  // a single leading `!` so the inserted link can't accidentally become an
  // embed on reload. (Only applies to wiki/file inserts; external URLs are
  // serialized as `[label](url)` and aren't affected by an adjacent `!`.)
  let insertFrom = state.from;
  if (isFile && state.from > 0) {
    const prevChar = view.state.doc.textBetween(state.from - 1, state.from, '\n', '\0');
    if (prevChar === '!') insertFrom = state.from - 1;
  }

  // Always replace `insertFrom..state.to` with the chosen text + mark. That
  // collapses the `[[query` trigger in wiki mode, swaps a highlighted span
  // for the new label in link mode, and inserts fresh text when nothing is
  // selected — one branch covers all three.
  const node = schema.text(text, [mark]);
  const tr = view.state.tr.replaceWith(insertFrom, state.to, node);
  tr.setSelection(TextSelection.create(tr.doc, insertFrom + text.length));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// Keep browser hard reload available in the editor by not binding Mod-Shift-r.
/* ── Cached decoration plugins ─────────────────────────────────────────
 *  ProseMirror calls a plugin's `decorations` prop on *every* view update —
 *  selection moves, remote cursor / awareness updates and IME ticks included.
 *  Rebuilding a DecorationSet (often a full-doc walk) each time is what makes
 *  a busy collab editor lag. `cachedDecorations` keeps the set in plugin
 *  state and rebuilds only when it can actually have changed: on a metadata
 *  update, or — for content-derived decorations — when the doc changes.
 *  Selection-only transactions reuse the cached set for free.
 * ───────────────────────────────────────────────────────────────────── */
type DecoState<D> = D & { decorations: DecorationSet };

function cachedDecorations<D extends object>(
  pluginKey: PluginKey<DecoState<D>>,
  initData: () => D,
  build: (doc: ProseMirrorNode, data: D) => DecorationSet,
  // true: full rebuild per doc change; false: map positions only; a scan
  // function: incremental — only the changed top-level blocks rescan (see
  // lib/tiptap/incremental-decorations).
  rebuildOnDocChange: boolean | ((doc: ProseMirrorNode, from: number, to: number) => Decoration[]),
) {
  return {
    state: {
      init(_config: unknown, instance: EditorState): DecoState<D> {
        const data = initData();
        return { ...data, decorations: build(instance.doc, data) };
      },
      apply(tr: Transaction, value: DecoState<D>, oldState: EditorState, newState: EditorState): DecoState<D> {
        const meta = tr.getMeta(pluginKey) as Partial<D> | undefined;
        if (meta) {
          const next: DecoState<D> = { ...value, ...meta };
          next.decorations = build(newState.doc, next);
          return next;
        }
        if (tr.docChanged) {
          if (typeof rebuildOnDocChange === 'function') {
            return { ...value, decorations: applyIncremental(tr, value.decorations, rebuildOnDocChange) };
          }
          if (rebuildOnDocChange) {
            return { ...value, decorations: build(newState.doc, value) };
          }
          // y-prosemirror's `_forceRerender` (fired whenever the plugin set is
          // reconfigured — e.g. the Suggest toggle unmounting the bubble/slash
          // menus, whose mount registers editor plugins) replaces the WHOLE doc
          // even when nothing changed. Mapping across that replace collapses
          // every decoration to nothing, blanking comment highlights until the
          // next server reload pushes fresh ranges. `binding` on the y-sync
          // meta marks the re-render, but does NOT imply identical content — a
          // remote update can also arrive through a full re-render — so carry
          // the current (already-mapped) decorations onto the new doc verbatim
          // ONLY when the replacement is content-equal; a content-changing
          // re-render maps like any other edit (stale absolute positions must
          // never be recreated onto a changed document).
          const rerender = Boolean(
            (tr.getMeta(ySyncPluginKey) as { binding?: unknown } | undefined)?.binding,
          );
          return {
            ...value,
            decorations: rerender && newState.doc.eq(oldState.doc)
              ? DecorationSet.create(tr.doc, value.decorations.find())
              : value.decorations.map(tr.mapping, tr.doc),
          };
        }
        return value;
      },
    },
    decorations(state: EditorState): DecorationSet {
      return pluginKey.getState(state)?.decorations ?? DecorationSet.empty;
    },
  };
}

/* ── Decoration-based markdown checkboxes ──────────────────────────
 *  Renders [ ] and [x] at the start of paragraphs as visual checkboxes.
 *  The raw text is NEVER modified by the extension — only the view changes.
 *  Clicking a checkbox toggles [ ] ↔ [x] in the underlying text.
 * ─────────────────────────────────────────────────────────────────── */

const checkboxPluginKey = new PluginKey<DecoState<Record<string, never>>>('markdownCheckbox');

// Checklist items are plain `[ ]`/`[x]` text decorations inside ordinary
// listItems (no TaskList node), so checklist NESTING is just list nesting:
// Tab → sinkListItem, Shift-Tab → liftListItem (provided by StarterKit's
// listItem). A nested `- [ ] a\n  - [ ] b` round-trips through both markdown
// codecs with the markers intact (see codec-cross-equivalence.test.ts —
// "nested checkbox list"); only the indent width differs (crdt 2 / Tiptap 4).
// This extension only adds Enter (split + seed `[ ] ` / exit on empty);
// nesting needs no extra wiring here.
const MarkdownCheckbox = Extension.create({
  name: 'markdownCheckbox',

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $from } = state.selection;

        // Walk up to find a listItem ancestor
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name !== 'listItem') continue;
          const para = $from.node(d).firstChild;
          if (!para || para.type.name !== 'paragraph') break;
          if (!checkboxStateAt(para.textContent)) break;

          // If the item is an empty checkbox (no real text after [ ]), clear and exit list
          const afterCheckbox = para.textContent.slice(3).trim();
          if (!afterCheckbox) {
            const contentStart = $from.start(d + 1);
            const contentEnd = contentStart + para.content.size;
            const tr = state.tr.delete(contentStart, contentEnd);
            editor.view.dispatch(tr);
            editor.commands.liftListItem('listItem');
            return true;
          }

          // Has text — split, then add [ ] to the new (empty) item
          return editor.chain()
            .splitListItem('listItem')
            .command(({ tr: chainTr }) => {
              const { $from: newFrom } = chainTr.selection;
              const newPara = newFrom.parent;
              if (newPara.type.name === 'paragraph' && !CHECKBOX_RE.test(newPara.textContent)) {
                chainTr.insertText('[ ] ', newFrom.pos);
              }
              return true;
            })
            .run();
        }
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    const scanCheckboxes = (doc: ProseMirrorNode, rangeFrom: number, rangeTo: number) => {
      const decos: Decoration[] = [];
      doc.nodesBetween(rangeFrom, rangeTo, (node, pos, parent) => {
        if (node.type.name !== 'paragraph') return true;
        const cb = checkboxStateAt(node.textContent);
        if (!cb) return false;
        const { state, classic } = cb;
        // Custom states only inside list items — keeps a standalone
        // paragraph citation like `[1] Ref` from growing a checkbox.
        // `parent` comes free from the walk; resolving here was O(doc)
        // per checkbox (the math-decorations O(n²) lesson).
        if (!classic && parent?.type.name !== 'listItem') return false;
        const from = pos + 1;          // start of paragraph content
        const to = from + 3;           // [<state>] is always 3 chars
        const checked = state.toLowerCase() === 'x';
        const variant = checked ? 'md-checkbox-checked'
          : classic ? 'md-checkbox-unchecked' : 'md-checkbox-custom';
        decos.push(
          Decoration.inline(from, to, {
            class: `md-checkbox ${variant}`,
            nodeName: 'span',
            // The custom state char, surfaced for CSS (`content: attr(…)`).
            ...(classic ? {} : { 'data-state': state }),
          }),
        );
        return false;
      });
      return decos;
    };
    const cache = cachedDecorations<Record<string, never>>(
      checkboxPluginKey,
      () => ({}),
      (doc) => DecorationSet.create(doc, scanCheckboxes(doc, 0, doc.content.size)),
      scanCheckboxes,
    );
    return [
      new Plugin({
        key: checkboxPluginKey,
        state: cache.state,
        props: {
          decorations: cache.decorations,
          handleDOMEvents: {
            mousedown(view, event) {
              const target = event.target as HTMLElement;
              if (!target.classList?.contains('md-checkbox')) return false;
              event.preventDefault();
              const pos = view.posAtDOM(target, 0);
              const { state } = view;
              const isChecked = target.classList.contains('md-checkbox-checked');
              const replacement = isChecked ? '[ ]' : '[x]';
              const tr = state.tr.replaceWith(pos, pos + 3, state.schema.text(replacement));
              view.dispatch(tr);
              return true;
            },
          },
        },
      }),
    ];
  },
});

/* ── Markdown images → @tiptap Image nodes ────────────────────────────
 *  Images are atomic block nodes (Google-Docs style). The codec serializes
 *  them to `![alt](src)`, so sync stays byte-stable; `src` is stored raw
 *  (workspace-relative or absolute) and resolved to a signed-URL proxy only
 *  at render time (WorkspaceImage below). */

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

/** Filename (sans extension) of a workspace path — used as the image alt. */
function imageAltFromPath(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ── Image-upload placeholders ────────────────────────────────────────
 *  Dropping/pasting an OS image kicks off a multi-second upload (hash →
 *  precheck → TUS → finalize) before the real Image node lands. Without
 *  feedback users assume the drop failed. We show an instant local-preview
 *  thumbnail (object URL) with a spinner at the drop point, then swap in the
 *  real node on success. Pure decoration — never touches the Y.Doc, so the
 *  transient `blob:` src is never synced or persisted. */
export const imageUploadKey = new PluginKey<DecorationSet>('imageUploadPlaceholder');
let imageUploadSeq = 0;

type ImageUploadMeta = { add: { id: string; pos: number; previewUrl: string } } | { remove: string[] };

function buildImagePlaceholderEl(previewUrl: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'sd-img-upload';
  el.setAttribute('contenteditable', 'false');
  const img = document.createElement('img');
  img.src = previewUrl;
  img.alt = '';
  el.appendChild(img);
  const spinner = document.createElement('span');
  spinner.className = 'sd-img-upload__spinner';
  el.appendChild(spinner);
  return el;
}

/** Exported for tests — the bare ProseMirror plugin behind the extension. */
export const imageUploadPlaceholderPlugin = new Plugin<DecorationSet>({
  key: imageUploadKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      set = set.map(tr.mapping, tr.doc);
      const meta = tr.getMeta(imageUploadKey) as ImageUploadMeta | undefined;
      if (meta && 'add' in meta) {
        const widget = Decoration.widget(meta.add.pos, buildImagePlaceholderEl(meta.add.previewUrl), {
          id: meta.add.id,
          side: -1,
        });
        return set.add(tr.doc, [widget]);
      }
      if (meta && 'remove' in meta) {
        const ids = meta.remove;
        return set.remove(set.find(undefined, undefined, (spec) => ids.includes(spec.id)));
      }
      return set;
    },
  },
  props: {
    decorations(state) {
      return imageUploadKey.getState(state);
    },
  },
});

const ImageUploadPlaceholder = Extension.create({
  name: 'imageUploadPlaceholder',
  addProseMirrorPlugins() {
    return [imageUploadPlaceholderPlugin];
  },
});

/** Current mapped position of a live placeholder, or null once it's gone. */
function imagePlaceholderPos(state: EditorState, id: string): number | null {
  const set = imageUploadKey.getState(state);
  const found = set?.find(undefined, undefined, (spec) => spec.id === id)[0];
  return found ? found.from : null;
}

/** Insert uploaded/dropped images as @tiptap Image *nodes* (src stored raw). */
export function insertImages(
  view: EditorView,
  pos: number,
  results: Array<{ src: string; alt: string } | null>,
) {
  if (view.isDestroyed) return;
  const imgs = results.filter((r): r is { src: string; alt: string } => Boolean(r));
  if (!imgs.length) return;
  // <img> HTML so @tiptap Image.parseHTML yields real image nodes; parseSlice
  // reads the raw `src` attribute (no DOM URL resolution).
  const wrapper = document.createElement('div');
  wrapper.innerHTML = imgs
    .map((r) => `<img src="${escapeHtmlAttr(r.src)}" alt="${escapeHtmlAttr(r.alt)}">`)
    .join('');
  const slice = ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(wrapper, {
    preserveWhitespace: false,
  });
  if (!slice.content.size) return;
  const at = Math.min(Math.max(pos, 0), view.state.doc.content.size);
  const tr = view.state.tr.replaceRange(at, at, slice);
  tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(at, 1))));
  view.dispatch(tr.scrollIntoView());
}

/** Upload dropped/pasted image files via `upload`, then insert the successes as
 *  Image nodes. Each file gets an instant local-preview placeholder at the drop
 *  point so the user sees the drop landed; once every upload settles the
 *  placeholders are cleared and the successes inserted in one batch, preserving
 *  drop order. A `null` result is skipped (the uploader surfaces its own error),
 *  so one failed upload never drops the others. Shared by the drop and paste
 *  handlers; exported for tests. */
export function uploadAndInsertImages(
  view: EditorView,
  pos: number,
  files: File[],
  upload: (file: File) => Promise<{ src: string; alt: string } | null>,
): Promise<void> {
  const pending = files.map((file) => {
    const id = `img-upload-${(imageUploadSeq += 1)}`;
    const previewUrl = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
    if (!view.isDestroyed && previewUrl) {
      view.dispatch(view.state.tr.setMeta(imageUploadKey, { add: { id, pos, previewUrl } }));
    }
    return { id, previewUrl, result: upload(file).catch(() => null) };
  });
  return Promise.all(pending.map((p) => p.result)).then((results) => {
    for (const p of pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    if (view.isDestroyed) return;
    // Insert at the first still-live placeholder (collab edits may have moved
    // it); fall back to the original drop point.
    const at =
      pending.map((p) => imagePlaceholderPos(view.state, p.id)).find((n): n is number => n != null) ?? pos;
    view.dispatch(view.state.tr.setMeta(imageUploadKey, { remove: pending.map((p) => p.id) }));
    insertImages(view, at, results);
  });
}

function parseHtmlSlice(view: EditorView, html: string) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  return ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(wrapper, {
    preserveWhitespace: false,
    context: view.state.selection.$from,
  });
}

/** @tiptap Image that resolves a workspace-relative `src` to the signed-URL
 *  proxy at render time only — the stored attr (and the serialized `![](src)`)
 *  is unchanged, so sync fidelity is preserved. */
const WorkspaceImage = Image.extend<ImageOptions & { workspaceId?: string }>({
  addOptions() {
    return { ...(this.parent?.() as ImageOptions), workspaceId: undefined };
  },
  // `renderHTML` emits the resolved proxy URL; reverse it on parse so a
  // copy→paste / HTML re-parse stores the raw `assets/…` path, never the
  // projectId-baked proxy URL (which corrupts the doc and breaks cross-workspace).
  addAttributes() {
    const parent = (this.parent?.() ?? {}) as Record<string, unknown>;
    return {
      ...parent,
      ...imageWidthAttribute,
      src: {
        ...(parent.src as object),
        parseHTML: (element: HTMLElement) =>
          unresolveWorkspaceImageSrc(element.getAttribute('src') ?? ''),
      },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const src = typeof HTMLAttributes.src === 'string' ? HTMLAttributes.src : '';
    return ['img', { ...HTMLAttributes, src: resolveWorkspaceImageSrc(src, this.options.workspaceId) }];
  },
  // NodeView with a corner drag handle (shown only when the image is selected).
  // Dragging resizes live; on release the final px width is written to the node
  // `width` attr → syncs through Yjs and serializes to `{width=N}` in markdown.
  addNodeView() {
    const workspaceId = this.options.workspaceId;
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span');
      dom.className = 'sundial-image';
      const img = document.createElement('img');
      const handle = document.createElement('span');
      handle.className = 'sundial-image-handle';
      handle.contentEditable = 'false';
      dom.append(img, handle);

      let current = node;
      const render = (n: ProseMirrorNode) => {
        img.src = resolveWorkspaceImageSrc(String(n.attrs.src ?? ''), workspaceId);
        img.alt = String(n.attrs.alt ?? '');
        const w = Number(n.attrs.width);
        // Obsidian sizing in the alt (`![alt|640x480](src)`) renders when no
        // explicit width attr is set; the alt bytes stay verbatim.
        const altSize = Number.isFinite(w) && w > 0 ? null : parseAltSizeSpec(img.alt);
        if (Number.isFinite(w) && w > 0) img.style.width = `${w}px`;
        else if (altSize) img.style.width = `${altSize.width}px`;
        else img.style.removeProperty('width');
        if (altSize?.height) img.style.height = `${altSize.height}px`;
        else img.style.removeProperty('height');
        // Alignment (center/right) — `left`/default leaves the image inline.
        const align = n.attrs.textAlign;
        if (align === 'center' || align === 'right') dom.dataset.align = align;
        else delete dom.dataset.align;
      };
      render(node);

      // Tear-down hook for an in-flight drag, so a mid-drag NodeView destroy /
      // file switch / pointercancel never leaks the window listeners.
      let stopDrag: (() => void) | null = null;

      handle.addEventListener('pointerdown', (event) => {
        // Read-only / View mode must not resize — the editable flag doesn't stop
        // a custom handler from dispatching, so guard explicitly.
        if (!editor.isEditable) return;
        event.preventDefault();
        event.stopPropagation();
        stopDrag?.();
        const startX = event.clientX;
        const startWidth = img.getBoundingClientRect().width;
        // Cap at the column AND the image's intrinsic size (no upscaling-blur).
        const maxWidth = Math.min(
          dom.parentElement?.getBoundingClientRect().width ?? Infinity,
          img.naturalWidth || Infinity,
        );
        let moved = false;
        const onMove = (move: PointerEvent) => {
          moved = true;
          const next = Math.max(40, Math.min(startWidth + (move.clientX - startX), maxWidth));
          img.style.width = `${Math.round(next)}px`;
        };
        const onUp = () => {
          stopDrag?.();
          // A bare click (no drag) must not write a width — that would turn a
          // no-op into a spurious user-attributed edit on a width-less image.
          if (!moved) return;
          const pos = typeof getPos === 'function' ? getPos() : null;
          if (typeof pos !== 'number' || editor.view.isDestroyed) return;
          const width = Math.round(img.getBoundingClientRect().width);
          if (width === Number(current.attrs.width)) return;
          editor.view.dispatch(editor.view.state.tr.setNodeAttribute(pos, 'width', width));
        };
        stopDrag = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          stopDrag = null;
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });

      return {
        dom,
        update: (updated: ProseMirrorNode) => {
          if (updated.type.name !== node.type.name) return false;
          current = updated;
          render(updated);
          return true;
        },
        // Drive the selection outline + handle off our own class — ProseMirror
        // fires these whenever the node is the NodeSelection, independent of
        // where it puts the default `ProseMirror-selectednode` class.
        selectNode: () => dom.classList.add('is-selected'),
        deselectNode: () => dom.classList.remove('is-selected'),
        destroy: () => stopDrag?.(),
        // The `<img>`/handle DOM we mutate (style, the handle) isn't document
        // content — only let ProseMirror act on its own selection changes.
        ignoreMutation: (mutation: MutationRecord | { type: string }) =>
          (mutation as { type: string }).type !== 'selection',
        stopEvent: (event: Event) => event.target === handle,
      };
    };
  },
});

/** text/plain clipboard serializer that keeps image leaves as `![alt](src)`.
 *  Image nodes carry no inline text, so the ProseMirror default drops them — a
 *  copy→paste through any text-only surface would silently lose the image.
 *  Exported for the image-src-preservation regression test. */
export function imageAwareClipboardText(slice: Slice): string {
  // Drop struck (deletion-marked) text first, so a copy yields the accepted
  // projection — never the strike-through — while images, hard breaks, and
  // block separators serialize exactly as before.
  const content = stripDeletedText(slice.content);
  return content.textBetween(0, content.size, '\n\n', (leaf) =>
    leaf.type.name === 'image'
      ? imageMarkdown(String(leaf.attrs.alt ?? ''), String(leaf.attrs.src ?? ''), {
          width: leaf.attrs.width,
          align: leaf.attrs.textAlign,
        })
      : (leaf.type.spec.leafText?.(leaf) ?? ''),
  );
}

export function isMarkdownImageContextMenuTarget(target: EventTarget | null): boolean {
  return (
    typeof Element !== 'undefined' &&
    target instanceof Element &&
    Boolean(target.closest('.tiptap img'))
  );
}
interface CommentDecorationsState {
  ranges: ResolvedDocCommentRange[];
  draftRange: { from: number; to: number } | null;
  activeThreadId: string | null;
  onSelectComment?: (threadId: string) => void;
}

export const commentDecorationsKey = new PluginKey<DecoState<CommentDecorationsState>>('commentDecorations');

export const CommentDecorationsExtension = Extension.create({
  name: 'commentDecorations',

  addOptions() {
    return {
      ranges: [] as ResolvedDocCommentRange[],
      draftRange: null as { from: number; to: number } | null,
      activeThreadId: null as string | null,
      onSelectComment: undefined as ((threadId: string) => void) | undefined,
    };
  },

  addProseMirrorPlugins() {
    const initialOpts = this.options;
    // Ranges are absolute positions, so on a doc change the cached set is
    // simply `.map()`-ed forward — no rebuild needed (the React side pushes
    // freshly resolved ranges via meta when they actually change).
    const cache = cachedDecorations<CommentDecorationsState>(
      commentDecorationsKey,
      () => ({
        ranges: initialOpts.ranges ?? [],
        draftRange: initialOpts.draftRange ?? null,
        activeThreadId: initialOpts.activeThreadId ?? null,
        onSelectComment: initialOpts.onSelectComment,
      }),
      (doc, data) => {
        const decos: Decoration[] = [];
        for (const range of data.ranges) {
          if (range.from >= range.to) continue;
          const isActive = range.id === data.activeThreadId;
          decos.push(
            Decoration.inline(
              range.from,
              range.to,
              {
                class: [
                  'doc-comment-range',
                  // Reactions are a lighter touch than a comment: the chip after
                  // the words carries the signal, so the text keeps a faint tint
                  // instead of the full comment highlight.
                  range.reaction
                    ? 'doc-comment-range-reaction'
                    : range.status === 'resolved'
                      ? 'doc-comment-range-resolved'
                      : 'doc-comment-range-open',
                  isActive ? 'doc-comment-range-active' : '',
                ]
                  .filter(Boolean)
                  .join(' '),
              },
              // Tag with the thread id so scroll-to-comment can read the current
              // mapped position (decorations map forward on edits; the resolved
              // `ranges` prop does not).
              { id: range.id },
            ),
          );
        }
        if (data.draftRange && data.draftRange.from < data.draftRange.to) {
          decos.push(
            Decoration.inline(data.draftRange.from, data.draftRange.to, {
              class: 'doc-comment-draft-range',
            }),
          );
        }
        return DecorationSet.create(doc, decos);
      },
      false,
    );
    return [
      new Plugin<DecoState<CommentDecorationsState>>({
        key: commentDecorationsKey,
        state: cache.state,
        props: {
          decorations: cache.decorations,
          // Click inside a comment range → select that thread in the lane. Read
          // the live decoration positions (mapped forward on edits) so the hit
          // test stays correct after typing. Return false: the click still
          // places the caret normally, we only add the selection side effect.
          handleClick(view, pos) {
            const data = commentDecorationsKey.getState(view.state);
            if (!data?.onSelectComment) return false;
            const hits = data.decorations.find(pos, pos).flatMap((deco) => {
              const id = (deco.spec as { id?: string } | null)?.id;
              return id ? [{ id, from: deco.from, to: deco.to }] : [];
            });
            const id = pickCommentAtPos(hits, pos);
            if (id) data.onSelectComment(id);
            return false;
          },
        },
      }),
    ];
  },
});

/**
 * Workspace-UI deep-link: a `?`-href in doc content (e.g. the starter docs'
 * `?modal=connectAgent`) applies to the page's query in place — Next syncs
 * useSearchParams, so param effects fire without a reload or a file lookup.
 * Only the allow-listed `modal` key is applied (doc content is multi-writer;
 * arbitrary params must not rewrite chat/file/selection state), and
 * replaceState keeps transient modal opens out of the history stack. The page
 * strips the param once consumed, so the same link works repeatedly.
 */
/** The `?modal=` value of a query-only doc href, or null when it carries
 *  none — non-modal query links (`?section=api`) are NOT ours to intercept. */
function queryHrefModal(href: string): string | null {
  return new URLSearchParams(href.slice(1)).get('modal');
}

function applyQueryHref(href: string) {
  const modal = queryHrefModal(href);
  if (!modal) return;
  const url = new URL(window.location.href);
  url.searchParams.set('modal', modal);
  window.history.replaceState(null, '', url);
}

interface AttributionPaintState {
  ranges: AttributionPaintRange[];
}

export const attributionPaintKey = new PluginKey<DecoState<AttributionPaintState>>('attributionPaint');

const AttributionPaintExtension = Extension.create({
  name: 'attributionPaint',

  addOptions() {
    return {
      ranges: [] as AttributionPaintRange[],
    };
  },

  addProseMirrorPlugins() {
    const initialOpts = this.options;
    const cache = cachedDecorations<AttributionPaintState>(
      attributionPaintKey,
      () => ({ ranges: initialOpts.ranges ?? [] }),
      (doc, data) => {
        if (!data.ranges.length) return DecorationSet.empty;

        // text → every range with that text, in document order. Same-text
        // blocks are consumed one occurrence at a time below, so repeated
        // lines keep their own author instead of all taking the first's.
        const byText = new Map<string, AttributionPaintRange[]>();
        for (const range of data.ranges) {
          const key = range.text.trim();
          if (!key) continue;
          const list = byText.get(key);
          if (list) list.push(range);
          else byText.set(key, [range]);
        }
        if (byText.size === 0) return DecorationSet.empty;
        const consumed = new Map<string, number>();
        const takeRange = (key: string): AttributionPaintRange | undefined => {
          const list = byText.get(key);
          if (!list) return undefined;
          const index = consumed.get(key) ?? 0;
          consumed.set(key, index + 1);
          // More rendered copies than blame rows (an unsaved edit duplicated a
          // line): extras go dark rather than guessing — reusing a neighbor's
          // attribution painted the wrong author, and under a share bound it
          // could resurrect provenance the redaction buried.
          return list[index];
        };

        // A block's text as it will read once its suggestions resolve: inserted
        // text kept, struck (deletion-marked) text dropped. The ranges being
        // matched are the ADDED lines of pending edits, and a block under
        // review still holds the old text beside the new — the raw textContent
        // would never match, leaving the highlight lens dark on exactly the
        // blocks it exists to light up.
        const acceptedText = (node: ProseMirrorNode): string => {
          let out = '';
          node.descendants((child: ProseMirrorNode) => {
            if (child.isText && !child.marks.some((mark) => mark.type.name === 'deletion')) {
              out += child.text ?? '';
            }
            return true;
          });
          return out;
        };
        const decos: Decoration[] = [];
        // Margin labels only where the annotation CHANGES — a five-line run by
        // one author reads as one label, not five repeats.
        let lastSideLabel: string | null = null;
        doc.descendants((node, pos) => {
          // TEXTBLOCKS only (paragraph, heading, code block). A listItem or
          // blockquote and its inner paragraph share one textContent, so
          // matching every block made a single rendered item consume TWO
          // occurrences from the per-occurrence queue — the first duplicate's
          // inner paragraph stole the second duplicate's range and painted the
          // wrong author on both. Containers still descend into their children.
          // A line that is exactly one image becomes a LEAF `image` node, not a
          // textblock, so the skip below hid it from the lens even though blame
          // emits its literal `![alt](src)` (Codex, PR #1104 round 27).
          const isImageLeaf = node.type.name === 'image';
          if (!isImageLeaf && !node.isTextblock) return;
          // A leaf under a pending DELETION isn't in the accepted document, so
          // it claims no range — otherwise a struck image could consume a
          // surviving copy's attribution and leave the real one dark (Codex,
          // PR #1104 round 33). Textblocks express this through acceptedText.
          if (isImageLeaf && node.attrs.suggestionDeletionId != null) return false;
          const rendered = isImageLeaf
            ? imageMarkdown(node.attrs.alt ?? '', node.attrs.src ?? '', {
                width: node.attrs.width,
                align: node.attrs.textAlign,
              })
            : node.textContent.trim();
          // A block under review matches ONLY on its accepted projection, and
          // one a deletion emptied matches nothing — see attributionMatchKey.
          // A leaf image carries no marks, so its literal IS the key.
          const key = isImageLeaf
            ? rendered || null
            : attributionMatchKey(rendered, acceptedText(node).trim());
          const range = key ? takeRange(key) : undefined;
          if (!range || range.hidden) {
            if (rendered) lastSideLabel = null;
            return;
          }
          const title = range.toolCallId
            ? `${range.authorLabel} via ${range.toolCallId}`
            : range.authorLabel;
          decos.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: `doc-attribution-paint doc-attribution-paint-${range.colorIndex % 6}`,
              title,
            }),
          );
          if (range.sideLabel && (node.isTextblock || isImageLeaf)) {
            // Dedup by annotation AND turn: two same-author runs from different
            // turns keep separate labels so each jumps to its own turn.
            const dedupKey = `${range.sideLabel}|${range.assistantMessageId ?? ''}`;
            if (dedupKey !== lastSideLabel) {
              const label = range.sideLabel;
              const colorIndex = range.colorIndex % 6;
              const { avatarUrl, avatarRound, onJump } = range;
              decos.push(
                Decoration.widget(
                  // Inside the block for a textblock; a leaf image has no
                  // content position, so the label rides just before it.
                  isImageLeaf ? pos : pos + 1,
                  () => {
                    const el = document.createElement('span');
                    el.className = `attribution-side-label attribution-side-label-${colorIndex}`;
                    if (avatarUrl) {
                      const img = document.createElement('img');
                      img.src = avatarUrl;
                      img.alt = '';
                      img.draggable = false;
                      img.className = avatarRound === false ? 'is-mark' : '';
                      el.append(img);
                    }
                    el.append(document.createTextNode(label));
                    el.contentEditable = 'false';
                    if (onJump) {
                      // Same affordance as the suggestion chip: the annotation
                      // opens the chat turn that wrote these lines.
                      el.classList.add('is-jumpable');
                      el.title = 'Open the chat turn';
                      el.addEventListener('mousedown', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onJump();
                      });
                    }
                    if (range.assistantMessageId && range.filePath) {
                      // Hovering the annotation opens the before/after card
                      // (AuthorshipHoverCard listens on window; the page owns
                      // the React side of the exchange).
                      el.addEventListener('mouseenter', () => {
                        const rect = el.getBoundingClientRect();
                        window.dispatchEvent(
                          new CustomEvent('sundial:authorship-hover', {
                            detail: {
                              occurrence: range.occurrence,
                              assistantMessageId: range.assistantMessageId,
                              chatId: range.chatId ?? null,
                              filePath: range.filePath,
                              lineText: range.text,
                              sideLabel: label,
                              avatarUrl: range.avatarUrl,
                              avatarRound: range.avatarRound,
                              x: rect.left,
                              y: rect.bottom,
                            },
                          }),
                        );
                      });
                      el.addEventListener('mouseleave', () => {
                        window.dispatchEvent(new CustomEvent('sundial:authorship-hover', { detail: null }));
                      });
                    }
                    return el;
                  },
                  { side: -1, key: `side-${pos}-${dedupKey}` },
                ),
              );
            }
            lastSideLabel = dedupKey;
          }
        });
        return DecorationSet.create(doc, decos);
      },
      true,
    );
    return [
      new Plugin<DecoState<AttributionPaintState>>({
        key: attributionPaintKey,
        state: cache.state,
        props: { decorations: cache.decorations },
      }),
    ];
  },
});

/* ── Chat shortcuts ─────────────────────────────────────────────────
 *  Cmd/Ctrl-J               → open the current chat (selection optional).
 *  +Shift                    → open a fresh chat instead.
 *  All paths dispatch a `sundial:add-chat-context` window event with
 *  the selected text + filePath; the workspace page handles routing.
 *  Pure event dispatch — never mutates the document.
 * ───────────────────────────────────────────────────────────────── */
const ChatContextShortcut = Extension.create<{ filePath?: string | null }>({
  name: 'chatContextShortcut',

  addOptions() {
    return { filePath: null };
  },

  addKeyboardShortcuts() {
    const filePath = this.options.filePath ?? null;
    const dispatchOpen = (editor: Editor, forceNew: boolean) => {
      const { state } = editor;
      const { from, to, empty } = state.selection;
      const text = empty ? '' : state.doc.textBetween(from, to, '\n', ' ').trim();
      window.dispatchEvent(
        new CustomEvent('sundial:add-chat-context', {
          // Cmd-J with no selection toggles the chat when it's already
          // visible; with a selection it pins the selection instead of
          // toggling (matches the old Highlight+Space pin). Shift variants
          // always open a fresh chat.
          detail: { text, path: filePath, forceNew, toggle: !forceNew && !text },
        }),
      );
      return true;
    };
    return {
      'Mod-j': ({ editor }) => dispatchOpen(editor, false),
      'Mod-Shift-j': ({ editor }) => dispatchOpen(editor, true),
    };
  },
});

/* WKWebView (the desktop shell) — and Safari broadly — substitutes U+00A0 for
 * a typed space at some inline boundaries; those land in the Y.Doc and get
 * serialized verbatim into saved markdown. Normalize NBSPs back to plain
 * spaces, scoped to LOCAL insertions only: remote (y-sync) transactions are
 * skipped so concurrent clients can't each "fix" the same char (two CRDT
 * inserts = a doubled space), and existing documents that legitimately
 * contain NBSPs are never rewritten on load. */
const NormalizeNbsp = Extension.create({
  name: 'normalizeNbsp',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          const ranges: Array<{ from: number; to: number }> = [];
          transactions.forEach((transaction, transactionIndex) => {
            if (!transaction.docChanged || transaction.getMeta(ySyncPluginKey)) return;
            transaction.steps.forEach((step, stepIndex) => {
              step.getMap().forEach((_fromA, _toA, fromB, toB) => {
                // Map each inserted range through the remaining steps and
                // transactions so positions index newState.doc.
                const rest = transaction.mapping.slice(stepIndex + 1);
                let from = rest.map(fromB, -1);
                let to = rest.map(toB, 1);
                for (let later = transactionIndex + 1; later < transactions.length; later += 1) {
                  from = transactions[later].mapping.map(from, -1);
                  to = transactions[later].mapping.map(to, 1);
                }
                ranges.push({ from, to });
              });
            });
          });
          if (ranges.length === 0) return null;

          let fix: typeof newState.tr | null = null;
          const size = newState.doc.content.size;
          for (const range of ranges) {
            const from = Math.max(0, Math.min(range.from, size));
            const to = Math.max(from, Math.min(range.to, size));
            newState.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText || !node.text?.includes('\u00a0')) return;
              const start = Math.max(from, pos);
              const end = Math.min(to, pos + node.nodeSize);
              for (let at = start; at < end; at += 1) {
                if (node.text[at - pos] !== '\u00a0') continue;
                fix ??= newState.tr;
                fix.insertText(' ', at, at + 1);
              }
            });
          }
          return fix;
        },
      }),
    ];
  },
});

const TrailingParagraphAfterTable = Extension.create({
  name: 'trailingParagraphAfterTable',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null;
          }

          const lastNode = newState.doc.lastChild;
          const paragraph = newState.schema.nodes.paragraph;
          if (!lastNode || lastNode.type.name !== 'table' || !paragraph) {
            return null;
          }

          return newState.tr.insert(newState.doc.content.size, paragraph.create());
        },
      }),
    ];
  },
});

/* ── Inner editor ──────────────────────────────────────────────────────
 *  Owns the Tiptap editor. Mounted by `CollabEditor` only once the Y.Doc
 *  (and provider, when collaborative) are ready — so the editor is built
 *  exactly once per file instead of once empty + once with collaboration.
 *  `CollabEditor` keys this on the Y.Doc guid, so a doc swap remounts it.
 * ───────────────────────────────────────────────────────────────────── */
type CollabEditorInnerProps = CollabEditorProps & {
  ydoc: Y.Doc;
  provider: HocuspocusProvider | null;
  onEditorMountedForTiming?: () => void | (() => void);
};

/**
 * The markdown editor's formatting/structural extensions (everything except the
 * collab, decoration, and interaction layers). Shared so the visual-gallery
 * harness (`/test/markdown-gallery`) renders checkboxes/images/lists/tables
 * exactly like the live editor, from one source of truth — no second list to
 * drift. The live editor spreads this, then appends its decoration + collab
 * extensions; the harness uses it standalone with content seeded by the codec.
 */
export function markdownFormattingExtensions(
  { workspaceId, filePath }: { workspaceId?: string; filePath?: HtmlPreviewOptions['filePath'] } = {},
) {
  return [
    allowSuggestionBlockMarks(StarterKit.configure({
      // v3 renamed `history` → `undoRedo`; collab provides undo/redo so it stays
      // off here. `link`/`blockquote` are disabled because ObsidianLink/
      // ObsidianBlockquote provide them; StarterKit's bundled `underline`
      // replaces the formerly-standalone extension (same `underline` mark).
      undoRedo: false,
      document: false,
      blockquote: false,
      link: false,
      // v3 StarterKit added `trailingNode`, which appends an empty paragraph
      // whenever the last block isn't a paragraph — and its appendTransaction
      // fires on load, syncing that empty paragraph into the Y.Doc just by
      // opening a file (breaks the unchanged round-trip). Disable it; our own
      // TrailingParagraphAfterTable handles the table case, gated on docChanged.
      trailingNode: false,
      // The default drop indicator is a 1px currentColor hairline — invisible
      // enough that block drags read as broken (the cursor can't help: browsers
      // ignore CSS cursors during native HTML5 drags). A bold bar is the main
      // "the drag is working" signal.
      dropcursor: { color: '#292524', width: 2 },
    })),
    SuggestionDocument,
    SuggestionNodeAttributes,
    // Structural keys are their own undo steps; Tab never leaves the editor
    // while editing (lib/tiptap/structural-keys.ts).
    UndoBoundaries,
    EditorTabGuard,
    // Double/triple click select a word / the clicked block at the ProseMirror
    // level instead of falling through to the engine's native expansion — which
    // on WebKit grabs the whole editable when the pointer misses a text run
    // (lib/tiptap/pointer-selection.ts).
    PointerSelection,
    // Backspace at the start of a list line, and Delete at its end, join it
    // with the neighbouring line instead of ListKeymap's structural lift /
    // bullet-strip (see lib/tiptap/list-join.ts).
    ListJoin,
    // Pasting list lines at the end of a bullet that has children must not hand
    // those children to the pasted content (see lib/tiptap/list-paste.ts).
    ListPaste,
    // Same hardBreak `marker` attr the codec emits, so editing a doc with
    // `  ` / `\` hard breaks doesn't drop the marker on round trip.
    HardBreakMarker,
    // Same bulletList `marker` attr (source `*` / `+` bullet style).
    BulletMarker,
    // HR marker / indented-codeBlock / table-cell align attrs (codec parity;
    // `align` also renders column alignment in the editor).
    MarkdownSourceFidelity,
    // Raw YAML frontmatter block (must match the codec's markdownSchema).
    Frontmatter,
    // Frontmatter is only valid at the doc start; an interior node (mid-document
    // paste) is rewritten to ordinary markdown via the shared codec.
    FrontmatterNormalize,
    NormalizeNbsp,
    allowSuggestionBlockMarks(ObsidianBlockquote),
    // Chevron / `•••` that toggle `calloutCollapsed` on a `[!type][-+]` callout.
    // Doc state, not view state: the toggle round-trips as the markdown marker.
    CalloutFold,
    Highlight.configure({ multicolor: true }),
    // Inline-HTML subset marks (`<sub>`/`<sup>`; `<u>` comes from StarterKit).
    // Must match the codec's markdownSchema so the round-trip is lossless.
    Subscript,
    Superscript,
    TextStyle,
    // Alignment only round-trips for images (`{align=…}`); paragraph/heading
    // alignment has no markdown form, so it is not in the schema at all. No
    // shortcuts: the stock Mod-Shift-r/j/l/e bindings would eat hard-reload
    // and the workspace's Mod-Shift-j (fresh chat) while an image is selected.
    TextAlign.extend({ addKeyboardShortcuts: () => ({}) }).configure({
      types: ['image'],
      alignments: ['left', 'center', 'right'],
    }),
    ObsidianLink.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
      defaultProtocol: 'https',
      // Tiptap's default `isAllowedUri` has a regex bug that drops the href
      // on workspace-relative paths like `tutorial/paper.tex` (the negation
      // class `[^a-z+.-:]` treats `.-:` as a range and excludes `/`). Accept
      // anything that isn't a known dangerous scheme; XSS-prone protocols
      // are already stripped by the markdown codec's `sanitizeUrl`.
      isAllowedUri: (url) => !/^\s*(?:javascript|vbscript|data):/i.test(url ?? ''),
    }),
    // Bare `https://…` / `www.…` text renders as a clickable link (GFM autolink
    // literals) without a link mark, so the markdown bytes stay untouched.
    AutolinkDecorations,
    WorkspaceImage.configure({ workspaceId }),
    // `resizable` enables prosemirror-tables' columnResizing plugin so users
    // can drag column borders. Works with `table-layout: fixed` (globals.css)
    // and the `position: relative` cells the resize handles anchor to. Column
    // widths live as `colwidth` cell attrs in the Y.Doc; the markdown codecs
    // simply drop them on export (markdown has no column widths), so agent
    // edits and the markdown round-trip are unaffected.
    allowSuggestionBlockMarks(Table.configure({ resizable: true })),
    allowSuggestionBlockMarks(TableRow),
    allowSuggestionBlockMarks(TableHeader),
    allowSuggestionBlockMarks(TableCell),
    // Shift-Arrow out of a block next to a table selects the whole table rather
    // than dying against prosemirror-tables' selection normalization.
    TableShiftSelection,
    MarkdownCheckbox,
    Mathematics.configure({
      regex: MATH_TEXT_REGEX,
      katexOptions: { throwOnError: false, strict: 'ignore' as const },
      // Math inside a %%…%% source comment stays dimmed literal source; math
      // inside a footnote's own span must not paint over the folded chip.
      shouldRenderMatch: (state, from, to) =>
        outsideSourceComment(state, from, to) && outsideFootnote(state, from, to),
    }),
    // Doc-wide comment fold state (the icon toggles ALL comments), persisted
    // per workspace as a local view preference — never written to the Y.Doc.
    TagCommentDecorations.configure({
      storageKey: workspaceId ? `sd-source-comments:${workspaceId}` : null,
    }),
    // Obsidian-style footnotes ([^ref], [^ref]: definitions, ^[inline]) as
    // view-layer decorations over literal source text.
    FootnoteDecorations,
    CodeBlockShiki,
    MermaidPreview,
    // Obsidian-style read-only Properties view over the frontmatter node;
    // cursor inside (or click) reveals the raw YAML — display-only parse,
    // the text is never re-serialized.
    FrontmatterPreview,
    HtmlPreview.configure({ workspaceId, filePath }),
    BlockIdBadges,
    // Suggestion marks live in the schema (must match the codec's markdownSchema).
    // The active suggestChanges plugin + toggle wiring is added in the editor.
    InsertionMark,
    DeletionMark,
    ModificationMark,
  ];
}

/** Blur the editor after this long without input, dropping our caret on every
 *  other client. y-prosemirror clears the awareness cursor on blur, but a
 *  backgrounded/abandoned tab keeps DOM focus, so an inactive collaborator's
 *  caret would otherwise linger forever (the "ghost cursor, no presence chip"
 *  report). */
const CURSOR_IDLE_MS = 180_000;

/**
 * Calls `onIdle` once the editor sees no activity for `idleMs`, re-armed on
 * every input *and on focus* — `focusin`/`pointerdown` matter because the timer
 * is one-shot and `onIdle` no-ops while unfocused: a session started by a bare
 * click (no pointermove/keydown after) would otherwise have no idle deadline,
 * letting its caret linger forever. The caller blurs the editor in `onIdle`:
 * blurring routes through y-prosemirror's `focusout` handler, which nulls our
 * awareness `cursor` field *and* keeps re-nulling it on every later transaction
 * while we stay unfocused — so the caret can't be resurrected by the periodic
 * ghost-cursor tick or incoming remote edits (which fire transactions that
 * would otherwise re-publish the cursor whenever `view.hasFocus()` is true).
 * Returns a teardown that removes the listeners and the pending timer.
 */
export function installIdleCursorCleanup(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  onIdle: () => void,
  idleMs = CURSOR_IDLE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onIdle, idleMs);
  };
  const events = ['pointermove', 'pointerdown', 'keydown', 'focusin'] as const;
  for (const event of events) target.addEventListener(event, arm);
  arm();
  return () => {
    if (timer) clearTimeout(timer);
    for (const event of events) target.removeEventListener(event, arm);
  };
}

/** Nearest scrollable ancestor of `node` — the container we scroll to reveal a
 *  focused comment's anchor. Returns null when nothing actually scrolls. */
function findScrollableAncestor(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function CollabEditorInner({
  fileId,
  workspaceId,
  selectionActionsProjectId,
  filePath,
  placeholder = 'Start typing...',
  user,
  initialContent = null,
  onReady,
  onContentChange,
  className,
  hidden = false,
  readOnly = false,
  canResolveSuggestions = true,
  forceSuggesting = false,
  codeMode = false,
  style,
  commentRanges,
  draftCommentRange,
  activeCommentThreadId,
  onSelectComment,
  attributionRanges,
  suggestionAuthors,
  onJumpToTurn,
  onNavigateToFile,
  onNavigateToWikiTarget,
  fetchWikiNoteText,
  onImageDrop,
  wikiLinkSuggestions,
  revealPeer,
  onRevealPeerDone,
  onFocused,
  ydoc,
  provider,
  onEditorMountedForTiming,
}: CollabEditorInnerProps) {
  // Clerk-only ON PURPOSE (not useAuthReady): this effect runs an RLS-read
  // SELECT + postgres_changes subscribe, and sd_ desktop credentials carry no
  // Supabase JWT — subscribing would just join as anon and receive nothing.
  // Desktop parity needs an sd_ -> Realtime-token path first (follow-up).
  const { isLoaded: isClerkLoaded } = useAuth();
  // Anonymous ?pshare= guests: wait for the minted realtime JWT before any
  // channel joins — a claims-less join never receives events.
  const pshareRealtimeReady = usePathShareRealtimeAuthReady();
  const { mode: documentEditMode } = useDocumentEditMode();
  // Local (sidecar) docs must not open cloud Realtime channels (ghost cursors).
  const isLocalDoc = Boolean(useWorkspaceCollabSocket(workspaceId)?.isLocal);
  // Every suggestion — human AND agent (Sunny) — lives as insertion/deletion
  // MARKS in the Y.Doc (instant, synced, position-stable); the markdown editor
  // has no text-match overlay.
  const onNavigateToFileRef = useRef(onNavigateToFile);
  onNavigateToFileRef.current = onNavigateToFile;
  const onNavigateToWikiTargetRef = useRef(onNavigateToWikiTarget);
  onNavigateToWikiTargetRef.current = onNavigateToWikiTarget;
  const fetchWikiNoteTextRef = useRef(fetchWikiNoteText);
  fetchWikiNoteTextRef.current = fetchWikiNoteText;
  const onImageDropRef = useRef(onImageDrop);
  onImageDropRef.current = onImageDrop;
  const wikiLinkSuggestionsRef = useRef(wikiLinkSuggestions ?? []);
  wikiLinkSuggestionsRef.current = wikiLinkSuggestions ?? [];
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);
  const [linkMenuIndex, setLinkMenuIndex] = useState(0);
  const linkMenuRef = useRef<LinkMenuState | null>(null);
  linkMenuRef.current = linkMenu;
  const linkMenuIndexRef = useRef(0);
  linkMenuIndexRef.current = linkMenuIndex;
  const linkLabelInputRef = useRef<HTMLInputElement | null>(null);
  const linkUrlInputRef = useRef<HTMLInputElement | null>(null);
  const linkMenuDomRef = useRef<HTMLDivElement | null>(null);
  const linkMenuListRef = useRef<HTMLDivElement | null>(null);
  const [linkHoverCard, setLinkHoverCard] = useState<LinkHoverCardState | null>(null);
  const linkHoverCardRef = useRef<LinkHoverCardState | null>(null);
  linkHoverCardRef.current = linkHoverCard;
  // Copy → checkmark feedback inside the hover card. We keep the card open so
  // the user sees the confirmation, then revert the glyph after a beat.
  const [linkCopied, setLinkCopied] = useState(false);
  const linkCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Reset the affordance whenever we point at a different link (or none).
    setLinkCopied(false);
  }, [linkHoverCard?.href]);
  useEffect(() => () => {
    if (linkCopyTimerRef.current) clearTimeout(linkCopyTimerRef.current);
  }, []);
  // Editor-level fallback right-click menu (shown only when the page-level
  // comment context menu can't fire — see the `contextmenu` handler below).
  const [editorContextMenu, setEditorContextMenu] = useState<{ x: number; y: number } | null>(null);
  // True while the doc carries any pending suggestion (agent or human) — drives
  // the whole-doc accept/reject control pinned at the editor's bottom-right.
  const [hasSuggestions, setHasSuggestions] = useState(false);
  const commentRangesRef = useRef(commentRanges ?? []);
  commentRangesRef.current = commentRanges ?? [];
  const draftCommentRangeRef = useRef(draftCommentRange ?? null);
  draftCommentRangeRef.current = draftCommentRange ?? null;
  const activeCommentThreadIdRef = useRef(activeCommentThreadId ?? null);
  activeCommentThreadIdRef.current = activeCommentThreadId ?? null;
  const onSelectCommentRef = useRef(onSelectComment);
  onSelectCommentRef.current = onSelectComment;
  const attributionRangesRef = useRef(attributionRanges ?? []);
  attributionRangesRef.current = attributionRanges ?? [];
  const suggestionAuthorsRef = useRef(suggestionAuthors);
  suggestionAuthorsRef.current = suggestionAuthors;
  const onJumpToTurnRef = useRef(onJumpToTurn);
  onJumpToTurnRef.current = onJumpToTurn;

  const closeLinkMenu = useCallback(() => {
    setLinkMenu(null);
    setLinkMenuIndex(0);
  }, []);

  // Target-note text behind `[[note#` anchor suggestions. The open file always
  // re-serializes its live doc (fresh, includes unsynced keystrokes); other
  // notes fetch once per picker session with a short TTL.
  const [anchorNote, setAnchorNote] = useState<AnchorNoteState | null>(null);
  const anchorNoteRef = useRef<AnchorNoteState | null>(null);
  anchorNoteRef.current = anchorNote;
  const anchorNoteCacheRef = useRef(new Map<string, { content: string | null; at: number }>());
  const anchorNoteSeqRef = useRef(0);
  const ANCHOR_NOTE_TTL_MS = 15_000;
  const ensureAnchorNote = useCallback(
    (path: string) => {
      const seq = ++anchorNoteSeqRef.current;
      if (path === filePath) {
        setAnchorNote({ path, content: serializeDoc(ydoc), status: 'ready' });
        return;
      }
      const cached = anchorNoteCacheRef.current.get(path);
      if (cached && Date.now() - cached.at < ANCHOR_NOTE_TTL_MS) {
        setAnchorNote({ path, content: cached.content, status: cached.content == null ? 'error' : 'ready' });
        return;
      }
      const fetcher = fetchWikiNoteTextRef.current;
      setAnchorNote({ path, content: null, status: fetcher ? 'loading' : 'error' });
      if (!fetcher) return;
      void fetcher(path)
        .catch(() => null)
        .then((content) => {
          anchorNoteCacheRef.current.set(path, { content, at: Date.now() });
          if (anchorNoteSeqRef.current === seq) {
            setAnchorNote({ path, content, status: content == null ? 'error' : 'ready' });
          }
        });
    },
    [filePath, ydoc],
  );

  /** Re-derive the wiki-mode menu from the doc. Leaves an open link-mode menu alone. */
  const refreshWikiLinkMenu = useCallback((view: EditorView) => {
    if (linkMenuRef.current?.mode === 'link') return;
    const active = activeWikiLinkQuery(view);
    if (!active) {
      setLinkMenu(null);
      setLinkMenuIndex(0);
      return;
    }
    // `note#…` / `note#^…` → anchor mode: list the target note's headings or
    // blocks. The menu stays open while the note text loads; an unresolvable
    // file part closes it (same as zero file matches below).
    const anchorMode = splitAnchorQuery(active.query);
    if (anchorMode) {
      const notePath = resolveAnchorNotePath(anchorMode, wikiLinkSuggestionsRef.current, filePath);
      if (!notePath) {
        setLinkMenu(null);
        setLinkMenuIndex(0);
        return;
      }
      const next = {
        ...active,
        anchor: {
          path: notePath,
          kind: anchorMode.kind,
          query: anchorMode.anchorQuery,
          sameFile: anchorMode.filePart === '',
        },
      };
      setLinkMenu(next);
      // Clamp (never reset) so arrow-key position survives list refreshes,
      // matching the file-mode behavior below.
      const count = buildLinkMenuItems(next, [], anchorNoteRef.current).length;
      setLinkMenuIndex((current) => Math.max(0, Math.min(current, count - 1)));
      if (anchorNoteRef.current?.path !== notePath || notePath === filePath) ensureAnchorNote(notePath);
      return;
    }
    if (fileMatches(wikiLinkSuggestionsRef.current, active.query).length === 0) {
      setLinkMenu(null);
      setLinkMenuIndex(0);
      return;
    }
    setLinkMenu(active);
    setLinkMenuIndex((current) =>
      Math.min(current, fileMatches(wikiLinkSuggestionsRef.current, active.query).length - 1),
    );
  }, [ensureAnchorNote, filePath]);

  /** Open the link-mode popover for the current selection (new link).
   *  Deliberately no clipboard read here: navigator.clipboard.readText() on
   *  open makes macOS WKWebView (the desktop shell) interpose a "Paste"
   *  permission chip before the popover — the user can paste manually. */
  const openLinkModeMenu = useCallback((view: EditorView) => {
    const { state } = view;
    const { selection } = state;
    const from = selection.from;
    const to = selection.to;
    const selectionText = from === to
      ? ''
      : state.doc.textBetween(from, to, '\n', ' ').trim();
    let rect: LinkMenuRect;
    try {
      rect = view.coordsAtPos(to);
    } catch {
      return;
    }
    setLinkHoverCard(null);
    setLinkMenu({
      mode: 'link',
      from,
      to,
      anchorPos: to,
      query: '',
      label: selectionText || undefined,
      rect,
      selectionText: selectionText || undefined,
    });
    setLinkMenuIndex(0);
    // Focus the URL input by default — the label usually doesn't need editing.
    requestAnimationFrame(() => linkUrlInputRef.current?.focus());
  }, []);

  /** Open the link-mode popover pre-populated with an existing link's values. */
  const openEditLinkMenu = useCallback(
    (view: EditorView, card: LinkHoverCardState) => {
      const { from, to, href } = card;
      const label = view.state.doc.textBetween(from, to, '', '').trim();
      let rect: LinkMenuRect;
      try {
        rect = view.coordsAtPos(to);
      } catch {
        return;
      }
      setLinkHoverCard(null);
      setLinkMenu({
        mode: 'link',
        from,
        to,
        anchorPos: to,
        // Always pre-fill the URL/search field with the current target — wiki
        // links included — so editing starts from what the user actually has.
        // (The field doubles as a file-filter for wiki links; selecting the
        // text on focus lets the user immediately type over it to repick.)
        query: href,
        label,
        rect,
        selectionText: label,
        editing: true,
      });
      setLinkMenuIndex(0);
      requestAnimationFrame(() => {
        const input = linkUrlInputRef.current;
        if (!input) return;
        input.focus();
        input.select();
      });
    },
    [],
  );

  /** Recompute the hover card from the cursor — show it when the cursor is in a link. */
  const refreshLinkHoverCard = useCallback((view: EditorView) => {
    if (linkMenuRef.current) {
      // The edit/insert popover takes precedence over the hover card.
      setLinkHoverCard(null);
      return;
    }
    const { selection } = view.state;
    if (!selection.empty) {
      setLinkHoverCard(null);
      return;
    }
    const link = getLinkRangeAt(view.state, selection.from);
    if (!link) {
      setLinkHoverCard(null);
      return;
    }
    let rect: LinkMenuRect;
    try {
      rect = view.coordsAtPos(link.from);
    } catch {
      return;
    }
    const target = resolveLinkTarget(link.mark);
    if (!target) {
      setLinkHoverCard(null);
      return;
    }
    setLinkHoverCard({
      from: link.from,
      to: link.to,
      href: target,
      isWiki: link.mark.attrs.obsidianType === 'wiki',
      rect,
      anchorPos: link.from,
    });
  }, []);

  const openExternalHref = useCallback((href: string) => {
    window.open(href, '_blank', 'noopener,noreferrer');
    setLinkHoverCard(null);
  }, []);
  const openExternalHrefRef = useRef(openExternalHref);
  openExternalHrefRef.current = openExternalHref;

  const filePathRef = useRef<string | null>(filePath ?? null);
  filePathRef.current = filePath ?? null;

  // Map a link target to an existing workspace file (Obsidian-style: exact
  // path, else basename/stem match anywhere) so pasted/imported links like
  // [[My Note]] open `notes/My Note.md` instead of a dead verbatim path.
  // Markdown hrefs (`documentRelative`) resolve against the open document's
  // directory first — Obsidian semantics; wikilink targets stay vault-wide.
  const resolveNavigationPath = useCallback(
    (target: string, documentRelative = false) =>
      resolveLinkTargetToPath(
        target,
        wikiLinkSuggestionsRef.current,
        documentRelative ? filePathRef.current : null,
      ),
    [],
  );

  const navigateToHref = useCallback((href: string, isWiki: boolean) => {
    if (isWiki) {
      if (onNavigateToWikiTargetRef.current) {
        onNavigateToWikiTargetRef.current(href);
        return;
      }
      const normalized = href.replace(/^\.\//, '').replace(/^\/+/, '');
      onNavigateToFileRef.current?.(normalized);
      return;
    }
    const isExternal = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
    if (isExternal) {
      openExternalHref(href);
      return;
    }
    if (href.startsWith('?')) {
      applyQueryHref(href);
      setLinkHoverCard(null);
      return;
    }
    if (href.startsWith('#')) return;
    onNavigateToFileRef.current?.(resolveNavigationPath(href, true));
  }, [openExternalHref, resolveNavigationPath]);

  const removeLinkAt = useCallback((view: EditorView, range: { from: number; to: number }) => {
    const linkMark = view.state.schema.marks.link;
    if (!linkMark) return;
    const tr = view.state.tr.removeMark(range.from, range.to, linkMark);
    view.dispatch(tr);
    setLinkHoverCard(null);
    view.focus();
  }, []);

  const copyToClipboard = useCallback((text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* ignore */
    }
  }, []);

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        // Getter, not the value: a rename keeps this editor mounted (and
        // `filePath` is not a useEditor dep), so relative media must resolve
        // against the CURRENT directory.
        ...markdownFormattingExtensions({ workspaceId, filePath: () => filePathRef.current }),
        // Suggestions-as-marks: in Suggest mode, a human's edits become
        // insertion/deletion marks in the Y.Doc (instant, position-stable,
        // synced) instead of being reconstructed by the server text-match
        // overlay. Inert until `setSuggesting(true)` (driven by the edit-mode
        // toggle, below).
        SuggestionChanges.configure({
          canResolve: canResolveSuggestions,
          onResolved: (ids, action) => {
            if (ydoc) recordMarkdownSuggestionResolution(ydoc, ids, action);
          },
          // Stacked-suggestion reject cascade outcome (dependent ids): same
          // recorder as the headless resolver, so surfaces converge.
          onCascade: (outcome) => {
            if (ydoc) recordRejectCascadeOutcome(ydoc, outcome);
          },
          // Read through refs: the map arrives from a fetch after the editor
          // (and usually the marks) already exist, and the effect below nudges
          // the decorations to rebuild once it lands.
          resolveAuthor: (ids) => {
            const authors = suggestionAuthorsRef.current;
            if (!authors) return null;
            for (const id of ids) {
              const author = authors[String(id)];
              if (!author) continue;
              const { chatId, assistantMessageId } = author;
              return {
                label: author.label,
                color: author.color,
                imageUrl: author.imageUrl,
                imageRound: author.imageRound,
                chipLabel: author.chipLabel,
                chipColor: author.chipColor,
                onJump: () => onJumpToTurnRef.current?.(assistantMessageId, chatId),
              };
            }
            return null;
          },
        }),
        ImageUploadPlaceholder,
        CommentDecorationsExtension.configure({
          ranges: commentRangesRef.current,
          draftRange: draftCommentRangeRef.current,
          activeThreadId: activeCommentThreadIdRef.current,
          onSelectComment: (id: string) => onSelectCommentRef.current?.(id),
        }),
        AttributionPaintExtension.configure({
          ranges: attributionRangesRef.current,
        }),
        TrailingParagraphAfterTable,
        // ![[note]] / ![[note#…]] transclusion cards (inert without a fetcher).
        EmbedPreview.configure({
          getPaths: () => wikiLinkSuggestionsRef.current,
          fetchNoteText: fetchWikiNoteText
            ? (path: string) => fetchWikiNoteTextRef.current?.(path) ?? Promise.resolve(null)
            : undefined,
          resolveImageSrc: (src: string) => resolveWorkspaceImageSrc(src, workspaceId),
          onOpen: (target: string) => onNavigateToWikiTargetRef.current?.(target),
          // Same-file embeds (`![[#Section]]`) resolve against the open file
          // and render from the LIVE doc, so they track unsynced edits.
          getCurrentPath: () => filePath ?? null,
          getCurrentText: () => {
            try {
              return serializeDoc(ydoc);
            } catch {
              return null;
            }
          },
        }),
        ChatContextShortcut.configure({ filePath: filePath ?? null }),
        // View-only Obsidian fold: collapse headings / bullets locally without
        // touching the Y.Doc (see lib/tiptap/fold.ts). Editor-surface concern,
        // so it lives here rather than in the codec-shared formatting set.
        FoldGutter,
        ScopedSelectAll,
        // After the menu-owning extensions above: its keydown handler must only
        // see arrows no menu consumed. See lib/tiptap/caret-edge-scroll.ts.
        CaretEdgeScroll,
        BlurSelectionHighlight.configure({ className: 'sd-blur-selection' }),
        AgentGhostCursor,
        ...(ydoc ? [Collaboration.configure({ document: ydoc })] : []),
        ...(provider
          ? [
              CollaborationCaret.configure({
                provider,
                user,
                // y-tiptap calls this as (user, clientId); the clientId is
                // stamped as data-cid so the idle-fade can be restarted on move.
                render: (cursorUser, clientId?: number) =>
                  buildCursorCaret(cursorUser, clientId),
              }),
            ]
          : []),
        Placeholder.configure({
          placeholder,
        }),
      ],
      editorProps: {
        attributes: {
          class: `tiptap min-h-[360px] focus:outline-none ${codeMode ? 'tiptap-code' : ''} ${className ?? ''}`,
          spellcheck: !codeMode && getSpellcheckPreference() ? 'true' : 'false',
        },
        clipboardTextSerializer: imageAwareClipboardText,
        // Copy/cut yields the accepted projection: drop struck text and strip
        // suggestion identity so pasting (even the Sundial→Sundial native slice)
        // never carries strike-through or stale accept/reject controls.
        transformCopied: (slice) => {
          const content = flattenSuggestions(slice.content);
          // A selection that was entirely struck text projects to nothing; a
          // Slice with open depth over empty content is invalid, so emptied.
          return content.size ? new Slice(content, slice.openStart, slice.openEnd) : Slice.empty;
        },
        handleTextInput: (view, from, to, text) => linkifyTypedWikiLink(view, from, to, text),
        handleDOMEvents: {
          keydown: (view, event) => {
            const menu = linkMenuRef.current;

            // Cmd/Ctrl-K with a NON-EMPTY selection: edit the current link if
            // the cursor is inside one, otherwise open the insertion popover
            // for the selection. An empty caret falls through un-prevented so
            // the page's global handler opens the command palette instead.
            if (
              !menu &&
              (event.metaKey || event.ctrlKey) &&
              !event.shiftKey &&
              !event.altKey &&
              event.key.toLowerCase() === 'k' &&
              !view.state.selection.empty
            ) {
              event.preventDefault();
              const card = linkHoverCardRef.current;
              if (card) {
                void openEditLinkMenu(view, card);
              } else {
                void openLinkModeMenu(view);
              }
              return true;
            }

            if (!menu || menu.mode !== 'wiki') return false;

            // Escape must close even with zero items — anchor mode keeps the
            // menu open while the target note loads (or matches nothing).
            if (event.key === 'Escape') {
              event.preventDefault();
              closeLinkMenu();
              return true;
            }

            const items = buildLinkMenuItems(menu, wikiLinkSuggestionsRef.current, anchorNoteRef.current);
            if (items.length === 0) return false;

            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const delta = event.key === 'ArrowDown' ? 1 : -1;
              setLinkMenuIndex((current) => (current + delta + items.length) % items.length);
              return true;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              const chosen = items[linkMenuIndexRef.current] ?? items[0];
              applyLinkChoice(view, menu, chosen);
              closeLinkMenu();
              return true;
            }
            return false;
          },
          contextmenu: (view, event) => {
            if (isMarkdownImageContextMenuTarget(event.target)) return false;
            // Fallback right-click menu: the page-level comment menu intercepts
            // first (capture phase + stopImmediatePropagation) when it has
            // everything it needs, so we only reach this handler when the
            // comment menu isn't available — e.g. the Y.js binding hasn't
            // bootstrapped yet, the file isn't commentable, or the user lacks
            // write access. Show at least an "Add link" entry so right-click
            // never falls through to the browser's native menu unexpectedly.
            if (view.editable && view.state.selection.empty) {
              // Right-click collapses any prior selection; grab the word under
              // the pointer so "Add link" has a target instead of no-op'ing.
              selectWordAtCoords(view, event.clientX, event.clientY);
            }
            const { selection } = view.state;
            if (selection.empty) return false;
            event.preventDefault();
            setEditorContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
            return true;
          },
          click: (_view, event) => {
            // A plain click that didn't select text (caret already placed by
            // ProseMirror on mouseup) opens the link, like Cmd/Ctrl-click.
            // Drag-selecting inside link text only selects. Deliberate: a
            // double-click opens on its first click too (no delayed-open
            // timer, and Safari/WKWebView popup-block window.open outside the
            // click handler); the hover card keeps Copy / Edit / Remove.
            const target = event.target as HTMLElement | null;
            if (!target) return false;
            const anchor = target.closest('a') as HTMLAnchorElement | null;
            if (!anchor) return false;
            const href = anchor.getAttribute('href');
            if (!href) return false;
            if (href.startsWith('?')) {
              // Workspace-UI deep-link (the starter docs' "Connect it to this
              // workspace" CTA). Query links WITHOUT a modal value are not a
              // file: fall through to normal editor click behavior.
              if (!queryHrefModal(href)) return false;
              event.preventDefault();
              applyQueryHref(href);
              return true;
            }
            // DOM selection, not view.state: on a plain click ProseMirror lets
            // the browser place the caret and syncs state on selectionchange.
            const collapsed = document.getSelection()?.isCollapsed !== false;
            if (!(event.metaKey || event.ctrlKey || collapsed)) return false;
            const wikiTarget = anchor.dataset.obsidianTarget;
            if (wikiTarget) {
              event.preventDefault();
              if (onNavigateToWikiTargetRef.current) onNavigateToWikiTargetRef.current(wikiTarget);
              else onNavigateToFileRef.current?.(wikiTarget);
              return true;
            }
            const isExternal = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
            if (isExternal) {
              event.preventDefault();
              openExternalHrefRef.current(href);
              return true;
            }
            if (href.startsWith('#')) return false;
            event.preventDefault();
            onNavigateToFileRef.current?.(resolveNavigationPath(href, true));
            return true;
          },
          drop: (view, event) => {
            if (codeMode) return false;
            const dt = event.dataTransfer;
            if (!dt) return false;
            const coords = { left: event.clientX, top: event.clientY };
            const dropPos = view.posAtCoords(coords)?.pos ?? view.state.selection.from;

            // External OS image files → upload, then insert.
            const osImages = Array.from(dt.files ?? []).filter((f) => isEditorImageFile(f));
            if (osImages.length > 0) {
              const handler = onImageDropRef.current;
              if (!handler) return false;
              event.preventDefault();
              void uploadAndInsertImages(view, dropPos, osImages, handler);
              return true;
            }

            // Internal drag from the workspace files panel → reference by path.
            const json = dt.getData('application/json');
            if (json) {
              let paths: string[] = [];
              try {
                const parsed: unknown = JSON.parse(json);
                if (Array.isArray(parsed)) {
                  paths = parsed.filter((p): p is string => typeof p === 'string');
                }
              } catch {
                /* not a workspace-file drag */
              }
              const imagePaths = paths.filter((p) => IMAGE_PATH_RE.test(p));
              if (imagePaths.length > 0) {
                event.preventDefault();
                insertImages(
                  view,
                  dropPos,
                  imagePaths.map((p) => ({ src: p, alt: imageAltFromPath(p) })),
                );
                return true;
              }
            }
            return false;
          },
        },
        handlePaste: (view, event) => {
          if (codeMode) return false;

          const handler = onImageDropRef.current;
          if (handler && event.clipboardData) {
            const files = Array.from(event.clipboardData.files ?? []).filter((f) => isEditorImageFile(f));
            if (files.length > 0) {
              event.preventDefault();
              void uploadAndInsertImages(view, view.state.selection.from, files, handler);
              return true;
            }
          }

          const html = event.clipboardData?.getData('text/html');
          if (
            html &&
            isGoogleDocsClipboardHtml(html, Array.from(event.clipboardData?.types ?? []))
          ) {
            const slice = parseHtmlSlice(view, normalizeGoogleDocsHtml(html));
            if (slice.content.size) {
              event.preventDefault();
              if (!pasteListBesideChildren(view, slice)) {
                view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
              }
              return true;
            }
          }

          // Sundial→Sundial copy: ProseMirror's own clipboard slice is lossless.
          // Let PM parse it natively so callouts/math/marks survive instead of
          // re-parsing the lossy text/plain through markdown.
          if (isProseMirrorClipboardHtml(html)) return false;

          const text = event.clipboardData?.getData('text/plain');
          if (!text || !pasteLooksLikeMarkdown(text)) return false;

          // Notion/web copies put rich HTML *and* a lossy text/plain on the
          // clipboard: the plain text keeps list/heading markers (so it passes
          // the markdown gate) but DROPS hyperlink URLs. Routing those through the
          // markdown path would silently delete the links (fix #7). Defer to
          // ProseMirror's native HTML paste so links + nesting survive; markdown
          // source (Obsidian, code editors) keeps `](` and stays on this path.
          if (shouldDeferToHtmlPaste(html, text)) return false;

          const slice = parseHtmlSlice(view, markdownToHtml(text, { renderImages: false }));
          if (!slice.content.size) return false;
          if (pasteListBesideChildren(view, slice)) return true;
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          return true;
        },
      },
      editable: !readOnly,
      onUpdate: ({ editor: ed }) => {
        // Freeze-detector context (cheap: no doc walk). The markdown editor's
        // per-keystroke cost scales with doc size. Report the FULL editor field
        // set (nulling what this surface doesn't track) so switching to/from the
        // code editor overwrites its stale fields instead of leaving them to
        // mis-attribute a later stall.
        setFreezeContext({
          fileType: fileTypeFromPath(filePath) ?? 'markdown',
          docChars: ed.state.doc.content.size,
          docLines: ed.state.doc.childCount,
          pendingSuggestions: null,
        });
        onContentChange?.();
      },
    },
    // `provider`/`ydoc` are stable for this component's lifetime (CollabEditor
    // only mounts it once they're ready, and keys it on the doc), so they are
    // intentionally not deps — that's what keeps the editor from being built
    // twice per file open. canResolveSuggestions is a dep so a mid-session
    // permission downgrade drops the installed ✓/✕ review controls. readOnly
    // is NOT a dep: Edit↔View flips go through setEditable below, so the view
    // (and its scroll position) survives the toggle.
    [fileId, codeMode, canResolveSuggestions]
  );

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // A rename/move keeps this editor mounted and touches no document state, so
  // nothing would tell the HTML previews that their relative `./media` refs now
  // point somewhere else. Nudge the view; the extension re-resolves if the
  // directory actually changed.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr);
  }, [editor, filePath]);

  // Drive suggestion (Google-Docs "suggesting") mode from the document edit
  // mode. When on, a human's edits become tracked insertion/deletion marks.
  // Code files use the Monaco editor's own suggestion path, so keep it off here.
  const suggesting = (documentEditMode === 'suggest' || forceSuggesting) && !readOnly && !codeMode;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.setSuggesting(suggesting);
  }, [editor, suggesting]);

  // Track whether any suggestion mark is live, so the whole-doc accept/reject
  // control only shows when there's something to review. A full-doc walk per
  // doc change is O(doc) per keystroke, so scan only the changed blocks: a
  // mark can only APPEAR inside an edit, and only a doc that currently has
  // suggestions can lose its last one (that rare path takes the full walk).
  useEffect(() => {
    if (!editor || codeMode) return;
    const hasMarkBetween = (from: number, to: number) => {
      let found = false;
      editor.state.doc.nodesBetween(from, to, (node) => {
        if (found) return false;
        if (node.isText && node.marks.some((m) => m.type.name === 'insertion' || m.type.name === 'deletion')) {
          found = true;
        }
        return !found;
      });
      return found;
    };
    // The effect's own copy is the source of truth between renders — state
    // updates are mirrored from it, never read back.
    let current = false;
    const recomputeFull = () => {
      if (editor.isDestroyed) return;
      current = hasMarkBetween(0, editor.state.doc.content.size);
      setHasSuggestions(current);
    };
    recomputeFull();
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged || editor.isDestroyed) return;
      const span = changedBlockSpan(transaction);
      if (span && hasMarkBetween(span.from, span.to)) {
        current = true;
        setHasSuggestions(true);
      } else if (current || !span) {
        // Suggestions might have vanished with the edit (accept/reject,
        // deletion), or an attr-only step hid the range — re-walk.
        recomputeFull();
      }
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
    };
  }, [editor, codeMode]);

  // Replay a collaborator's name-flag fade whenever their cursor moves. Their
  // widget DOM is reused (keyed by clientId), so the one-shot CSS fade can't
  // restart itself — we restart it for the clients that actually changed.
  useEffect(() => {
    const awareness = provider?.awareness;
    if (!editor || !awareness) return;
    const onChange = (changes: { added: number[]; updated: number[] }) => {
      if (editor.isDestroyed) return;
      restartCursorLabelFade(editor.view.dom, [...changes.added, ...changes.updated]);
    };
    awareness.on('change', onChange);
    return () => awareness.off('change', onChange);
  }, [editor, provider]);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      refreshWikiLinkMenu(editor.view);
      refreshLinkHoverCard(editor.view);
    };
    editor.on('update', update);
    editor.on('selectionUpdate', update);
    return () => {
      editor.off('update', update);
      editor.off('selectionUpdate', update);
    };
  }, [editor, refreshWikiLinkMenu, refreshLinkHoverCard]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    refreshWikiLinkMenu(editor.view);
  }, [editor, refreshWikiLinkMenu, wikiLinkSuggestions]);

  // Reposition the menu when the editor / page scrolls so the popover tracks
  // the trigger position instead of floating on top of unrelated content.
  // Skips wheel-scrolls that happen INSIDE the popover itself (those don't
  // move the editor's anchor, and re-running setState on every wheel tick
  // forces the file list to snap its scrollTop back to the active item).
  useEffect(() => {
    if (!editor || !linkMenu) return;
    const onScrollOrResize = (event?: Event) => {
      // If the scroll happened inside the popover's own scrollable area, the
      // anchor in the editor didn't move — bail before doing any work.
      const target = event?.target as Node | undefined;
      if (target && linkMenuDomRef.current?.contains(target)) return;
      const current = linkMenuRef.current;
      if (!current || editor.isDestroyed) return;
      try {
        const rect = editor.view.coordsAtPos(current.anchorPos);
        // Bail when the anchor scrolls outside the editor's viewport.
        const editorRect = editor.view.dom.getBoundingClientRect();
        if (rect.bottom < editorRect.top - 8 || rect.top > editorRect.bottom + 8) {
          closeLinkMenu();
          return;
        }
        setLinkMenu((prev) => {
          if (!prev) return prev;
          const r = prev.rect;
          if (
            r.left === rect.left &&
            r.right === rect.right &&
            r.top === rect.top &&
            r.bottom === rect.bottom
          ) {
            return prev;
          }
          return { ...prev, rect };
        });
      } catch {
        closeLinkMenu();
      }
    };
    window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [editor, linkMenu, closeLinkMenu]);

  // Dismiss the link-insertion popover when the user mouses down anywhere
  // outside of it. (The Escape key already closes it from inside the input.)
  useEffect(() => {
    if (!linkMenu) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (linkMenuDomRef.current && target && linkMenuDomRef.current.contains(target)) return;
      closeLinkMenu();
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [linkMenu, closeLinkMenu]);

  // Keep the highlighted item in view as the user arrow-keys through the list
  // (especially when they hold the key down for fast scroll). Depends on
  // `linkMenuIndex` ONLY — including `linkMenu` here would re-run the effect
  // every time the menu's anchor rect updates (e.g. when the user wheel-
  // scrolls the list), which would yank scrollTop back to the active item
  // and make manual wheel-scrolling impossible.
  useEffect(() => {
    const container = linkMenuListRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) return;
    const itemTop = active.offsetTop;
    const itemBottom = itemTop + active.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (itemTop < viewTop) {
      container.scrollTop = itemTop;
    } else if (itemBottom > viewBottom) {
      container.scrollTop = itemBottom - container.clientHeight;
    }
  }, [linkMenuIndex]);

  // The workspace-level right-click menu dispatches this event to ask us to
  // open the link inserter for the current selection. Keeps a single shared
  // context menu (Add comment / Open chat / Add link) instead of two stacks.
  useEffect(() => {
    if (!editor) return;
    const onRequest = () => {
      if (editor.isDestroyed) return;
      const card = linkHoverCardRef.current;
      if (card) {
        void openEditLinkMenu(editor.view, card);
      } else {
        void openLinkModeMenu(editor.view);
      }
    };
    window.addEventListener('sundial:open-link-menu', onRequest);
    return () => window.removeEventListener('sundial:open-link-menu', onRequest);
  }, [editor, openEditLinkMenu, openLinkModeMenu]);

  // Dismiss the fallback right-click menu on any outside interaction.
  useEffect(() => {
    if (!editorContextMenu) return;
    const close = () => setEditorContextMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, { capture: true } as EventListenerOptions);
      window.removeEventListener('blur', close);
    };
  }, [editorContextMenu]);

  // Keep the link hover card pinned to the link as the page scrolls; close it
  // if the anchor leaves the editor viewport.
  useEffect(() => {
    if (!editor || !linkHoverCard) return;
    const onScrollOrResize = () => {
      const current = linkHoverCardRef.current;
      if (!current || editor.isDestroyed) return;
      try {
        const rect = editor.view.coordsAtPos(current.anchorPos);
        const editorRect = editor.view.dom.getBoundingClientRect();
        if (rect.bottom < editorRect.top - 8 || rect.top > editorRect.bottom + 8) {
          setLinkHoverCard(null);
          return;
        }
        setLinkHoverCard((prev) => (prev ? { ...prev, rect } : prev));
      } catch {
        setLinkHoverCard(null);
      }
    };
    window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [editor, linkHoverCard]);

  // In-doc agent cursors.
  // Subscribes to local_agent_presence rows for this workspace. For every
  // fresh row (last_seen_at within the TTL) whose `last_edited_path` matches
  // this file's path, push a caret to the AgentGhostCursor extension. The
  // ledger is the source of truth: the cursor persists across remounts
  // (open file → close → re-open shows the cursor again if the agent is
  // still active) and across page reloads.
  useEffect(() => {
    if (!editor || !workspaceId || !filePath) return;
    if (isLocalDoc) return; // no cloud agent presence for sidecar docs
    if (!isClerkLoaded || !pshareRealtimeReady) return; // realtime needs the Clerk or pshare JWT
    const supabase = createBrowserClient();
    if (!supabase) return;

    const TTL_MS = 30_000;
    const rows = new Map<string, { last_seen_at: string; last_edited_path: string | null; name: string | null; color: string | null }>();

    const editorRef = editor;
    function reconcile() {
      if (!editorRef || editorRef.isDestroyed) return;
      const cutoff = Date.now() - TTL_MS;
      const active: Record<string, { agentId: string; displayName: string; color: string; logoPath: string | null }> = {};
      for (const [agentId, row] of rows.entries()) {
        if (row.last_edited_path !== filePath) continue;
        if (new Date(row.last_seen_at).getTime() < cutoff) continue;
        const brand = brandForAgentId(agentId);
        active[agentId] = {
          agentId,
          displayName: row.name ?? brand.displayName,
          color: row.color ?? brand.color,
          logoPath: brand.logoPath,
        };
      }
      editorRef.commands.setAgentGhostCursors(active);
    }

    // Seed from a one-shot SELECT so a remount instantly reflects the
    // current ledger state instead of waiting for the next Realtime event.
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('local_agent_presence')
        .select('agent_id, last_seen_at, last_edited_path, name, color')
        .eq('workspace_id', workspaceId)
        .gte('last_seen_at', new Date(Date.now() - TTL_MS).toISOString());
      if (cancelled || !Array.isArray(data)) return;
      for (const row of data) {
        rows.set(row.agent_id as string, {
          last_seen_at: row.last_seen_at as string,
          last_edited_path: (row.last_edited_path as string | null) ?? null,
          name: (row.name as string | null) ?? null,
          color: (row.color as string | null) ?? null,
        });
      }
      reconcile();
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated types miss realtime overloads
    const channel = supabase.channel(`agent-ghost-cursors-${workspaceId}`) as any;
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'local_agent_presence',
        filter: `workspace_id=eq.${workspaceId}`,
      },
      (payload: { eventType?: string; new?: Record<string, unknown> | null; old?: Record<string, unknown> | null }) => {
        const oldRow = payload.old;
        const newRow = payload.new;
        if (payload.eventType === 'DELETE' && typeof oldRow?.agent_id === 'string') {
          rows.delete(oldRow.agent_id);
        } else if (newRow && typeof newRow.agent_id === 'string') {
          rows.set(newRow.agent_id, {
            last_seen_at: (newRow.last_seen_at as string) ?? new Date().toISOString(),
            last_edited_path: (newRow.last_edited_path as string | null) ?? null,
            name: (newRow.name as string | null) ?? null,
            color: (newRow.color as string | null) ?? null,
          });
        }
        reconcile();
      },
    );
    channel.subscribe();

    // Periodic TTL sweep: even with no events, drop cursors when their row
    // ages past the window so a silent agent's caret eventually clears.
    const tick = window.setInterval(reconcile, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(tick);
      supabase.removeChannel(channel);
      if (editorRef && !editorRef.isDestroyed) editorRef.commands.setAgentGhostCursors({});
    };
  }, [editor, workspaceId, filePath, isClerkLoaded, pshareRealtimeReady, isLocalDoc]);

  // Drop our caret on everyone else's screen once this tab goes idle. Blurring
  // lets y-prosemirror clear (and keep clearing) our awareness cursor; the
  // caret returns when we refocus the editor. Blur the DOM node directly —
  // editor.commands.blur() defers via requestAnimationFrame, which never fires
  // in a backgrounded tab (the very case we need to cover).
  useEffect(() => {
    if (!editor || !provider) return; // only collaborative editors have peers
    return installIdleCursorCleanup(editor.view.dom, () => {
      if (!editor.isDestroyed && editor.isFocused) editor.view.dom.blur();
    });
  }, [editor, provider]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const tr = editor.state.tr.setMeta(commentDecorationsKey, {
      ranges: commentRanges ?? [],
      draftRange: draftCommentRange ?? null,
      activeThreadId: activeCommentThreadId ?? null,
      onSelectComment: (id: string) => onSelectCommentRef.current?.(id),
    });
    editor.view.dispatch(tr);
  }, [activeCommentThreadId, commentRanges, draftCommentRange, editor]);

  // Focusing a comment should bring its highlighted text into view — otherwise
  // with many comments the selected thread's anchor stays off-screen. Scroll
  // only when the active thread actually changes (not on every doc edit) and
  // only when the anchor isn't already comfortably visible.
  const lastScrolledCommentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const id = activeCommentThreadId ?? null;
    if (!id) {
      lastScrolledCommentRef.current = null;
      return;
    }
    if (id === lastScrolledCommentRef.current) return;
    const range = (commentRanges ?? []).find((entry) => entry.id === id);
    if (!range) return; // ranges may resolve a tick later; retry when they do
    const view = editor.view;
    // The effect's deps (active id / ranges / editor) can all stay unchanged
    // while the editor is still settling on reload, so there's no re-trigger
    // once layout resolves. Retry across frames until the anchor is measurable
    // (covers CRDT content swap, font load, image decode) — a deep-linked thread
    // selected mid-load would otherwise never scroll into view. `retryUntilDone`
    // bounds it by frame count, so a backgrounded tab still gets its attempts.
    return retryUntilDone(
      () => {
        if (editor.isDestroyed) return true;
        const scroller = findScrollableAncestor(view.dom);
        // Prefer the decoration's live position — it's mapped forward on every
        // edit, whereas `range.from/to` come from a memo that doesn't recompute
        // on local typing and would scroll to a stale offset after edits.
        const decoState = commentDecorationsKey.getState(view.state);
        const live = decoState?.decorations.find(
          0,
          view.state.doc.content.size,
          (spec) => (spec as { id?: string } | null)?.id === id,
        );
        const from = live && live.length ? live[0].from : range.from;
        const to = live && live.length ? live[0].to : range.to;
        let anchor: { top: number; bottom: number } | null = null;
        try {
          anchor = { top: view.coordsAtPos(from).top, bottom: view.coordsAtPos(to).bottom };
        } catch {
          anchor = null; // position not laid out yet
        }
        const rect = scroller?.getBoundingClientRect();
        const { handled, scrollTop } = computeCommentScroll({
          hasScroller: Boolean(scroller),
          anchor,
          viewportTop: rect?.top ?? 0,
          viewportHeight: scroller?.clientHeight ?? 0,
          scrollTop: scroller?.scrollTop ?? 0,
        });
        if (!handled) return false; // still settling — retry next frame
        lastScrolledCommentRef.current = id;
        if (scroller && scrollTop !== null) scroller.scrollTo({ top: scrollTop, behavior: 'smooth' });
        return true;
      },
      requestAnimationFrame,
      cancelAnimationFrame,
    );
  }, [activeCommentThreadId, commentRanges, editor]);

  // The editor is NOT rebuilt when `user` changes (useEditor keys on
  // fileId/codeMode/…), so an identity that resolves after mount — an anon
  // visitor's cookie fetch upgrading "Guest" to their name/color/presenceKey —
  // must be pushed into awareness directly, or remote bubble-click matching
  // (and the caret's name flag) keeps the stale identity until a remount.
  useEffect(() => {
    provider?.awareness?.setLocalStateField('user', user);
  }, [provider, user]);

  // Report focus upward for presence: the file whose editor was last focused
  // is what this user is "in", regardless of which split pane holds it.
  const onFocusedRef = useRef(onFocused);
  onFocusedRef.current = onFocused;
  useEffect(() => {
    if (!editor) return;
    const handler = () => onFocusedRef.current?.();
    editor.on('focus', handler);
    return () => {
      editor.off('focus', handler);
    };
  }, [editor]);

  // Jump-to-peer (bubble click): find the peer's caret in this doc's awareness
  // and center it. Right after the file opens, awareness/binding are still
  // syncing — retry across frames (~10s) and give up silently: a peer who
  // blurred (y-tiptap nulls `cursor`) or left has no caret to jump to.
  // Delivery AND give-up report via onRevealPeerDone so the owner clears the
  // request — a kept request would replay the scroll on a later remount.
  const revealPeerSeqRef = useRef(0);
  const onRevealPeerDoneRef = useRef(onRevealPeerDone);
  onRevealPeerDoneRef.current = onRevealPeerDone;
  useEffect(() => {
    const req = revealPeer;
    if (!req || req.seq === revealPeerSeqRef.current) return;
    if (!editor || editor.isDestroyed) return;
    const awareness = provider?.awareness;
    if (!awareness) return;
    revealPeerSeqRef.current = req.seq;
    let attempts = 0;
    return retryUntilDone(
      () => {
        if (editor.isDestroyed) return true;
        // Give-up must run BEFORE retryUntilDone's own frame cap (700 below)
        // exhausts, or the request would survive unreported and replay later.
        if (++attempts >= 600) {
          onRevealPeerDoneRef.current?.(req.seq);
          return true;
        }
        for (const [clientId, state] of awareness.getStates()) {
          if (clientId === awareness.clientID) continue;
          const peer = (state as { user?: { name?: string; color?: string; presenceKey?: string } })
            .user;
          if (!peer) continue;
          const matched =
            req.presenceKey && peer.presenceKey
              ? peer.presenceKey === req.presenceKey
              : Boolean(req.name) &&
                peer.name === req.name &&
                (!req.color || peer.color === req.color);
          if (!matched) continue;
          const cursor = (state as { cursor?: { anchor?: unknown; head?: unknown } | null }).cursor;
          const rel = (cursor?.head ?? cursor?.anchor) as Record<string, unknown> | undefined;
          if (!rel) continue; // caret cleared (blur) — keep retrying until timeout
          const pos = resolvePosition(editor, rel);
          if (pos === null) return false; // y-sync binding not ready yet
          const view = editor.view;
          let top: number;
          try {
            top = view.coordsAtPos(Math.min(pos, view.state.doc.content.size)).top;
          } catch {
            return false; // position not laid out yet
          }
          const scroller = findScrollableAncestor(view.dom);
          if (!scroller) return false;
          const rect = scroller.getBoundingClientRect();
          scroller.scrollTo({
            top: Math.max(scroller.scrollTop + top - rect.top - scroller.clientHeight * 0.4, 0),
            behavior: 'smooth',
          });
          // Replay the caret's name flag so the arrival point is unmistakable.
          restartCursorLabelFade(view.dom, [clientId]);
          onRevealPeerDoneRef.current?.(req.seq);
          return true;
        }
        return false; // peer not in this room's awareness yet — retry
      },
      requestAnimationFrame,
      cancelAnimationFrame,
      700,
    );
  }, [revealPeer, editor, provider]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const ranges = attributionRanges ?? [];
    const tr = editor.state.tr.setMeta(attributionPaintKey, { ranges });
    editor.view.dispatch(tr);
    // The authorship lens writes margin annotations — widen the right margin
    // while it's on so labels don't overlap the text. Explicit toggle, so the
    // reflow happens on a deliberate action, never mid-typing.
    editor.view.dom.classList.toggle('authorship-lens-on', ranges.some((range) => range.sideLabel));
  }, [attributionRanges, editor]);

  // The suggestion attribution fetch resolves after the marks are already
  // painted, and the review controls are built once per block — repaint them so
  // the author icon appears without waiting for the next keystroke. Gated on the
  // CONTENT, not the prop identity: the pending-turns poll hands us a fresh
  // object about once a second while anyone types, and each repaint re-walks the
  // doc and re-creates every control's DOM (dropping the hover you were aiming at).
  const lastAuthorsSigRef = useRef('');
  useEffect(() => {
    if (!editor || editor.isDestroyed || !suggestionAuthors) return;
    const signature = JSON.stringify(suggestionAuthors);
    if (signature === lastAuthorsSigRef.current) return;
    lastAuthorsSigRef.current = signature;
    refreshSuggestionReview(editor.view);
  }, [suggestionAuthors, editor]);

  useEffect(() => {
    // Skip a destroyed instance (a rebuild re-runs this while `editor` is
    // still the old one); the rebuilt editor re-fires and reports itself.
    if (!editor || editor.isDestroyed || !ydoc) return;
    const cancelTiming = onEditorMountedForTiming?.();
    onReady?.({ editor, ydoc });
    return cancelTiming;
  }, [editor, fileId, onEditorMountedForTiming, onReady, ydoc]);

  useEffect(() => {
    if (!editor) return;
    if (readOnly) return;
    if (!initialContent) return;
    if (!ydoc) return;

    const fragment = ydoc.getXmlFragment('default');
    if (fragment.length > 0) return;

    editor.commands.setContent(initialContent, { emitUpdate: false });
  }, [editor, initialContent, readOnly, ydoc]);

  // The link popover opens/closes without an editor transaction (Cmd-K,
  // Escape), but the bubble menu's shouldShow — which reads linkMenuRef —
  // only re-runs on transactions. Poke an empty one so the bubble yields to
  // the popover and returns when it closes.
  const linkMenuOpen = !!linkMenu;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr);
  }, [editor, linkMenuOpen]);

  // "/image" slash item: OS file picker → the existing drop/paste upload
  // pipeline (placeholder spinner, batch insert) at the caret.
  const pickImage = useCallback(() => {
    const handler = onImageDropRef.current;
    if (!editor || editor.isDestroyed || !handler) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.heic,.heif';
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []).filter((f) => isEditorImageFile(f));
      if (!files.length || editor.isDestroyed) return;
      void uploadAndInsertImages(editor.view, editor.state.selection.from, files, handler);
    };
    input.click();
  }, [editor]);

  if (!editor) {
    return (
      <div className={hidden ? 'hidden' : 'block'} style={style}>
        {!hidden && <EditorSkeleton />}
      </div>
    );
  }

  const linkMenuItems = linkMenu
    ? buildLinkMenuItems(linkMenu, wikiLinkSuggestions ?? [], anchorNote)
    : [];

  const pickLinkItem = (item: LinkMenuItem) => {
    if (!linkMenu || !editor) return;
    applyLinkChoice(editor.view, linkMenu, item);
    closeLinkMenu();
  };

  return (
    <div className={hidden ? 'hidden' : 'block'} style={style}>
      {readOnly && (
        <div className="mb-3 flex items-center gap-1.5 text-[11px] text-stone-400">
          <LockSimpleIcon className="h-3 w-3" weight="regular" />
          <span>Read-only</span>
        </div>
      )}
      {/* `relative`: the bubble menus are appended inside this wrapper with
          `position: absolute` — anchoring them here makes them ride natively
          with the doc when an inner column scrolls (zero-lag), instead of
          resolving against some ancestor outside the scroll container. */}
      <EditorContent editor={editor} className="relative" />
      {/* Suggest mode: these surfaces make
          structural edits (insertTable, deleteTable, setNode, clearNodes)
          that the mark-based suggestion ledger can't stage as reviewable
          suggestions — hide them rather than silently applying untracked
          changes (Codex P2 on #747). */}
      {editor && !readOnly && !codeMode && !suggesting && (
        <>
          <EditorBubbleMenu
            editor={editor}
            filePath={filePath ?? null}
            selectionActionsProjectId={selectionActionsProjectId}
            // Hides the bubble under the link popover via shouldShow. A ref
            // instead of conditional mounting: remounting a BubbleMenu
            // re-registers its plugin, reconfiguring the whole EditorState
            // on every popover toggle.
            hiddenRef={linkMenuRef}
          />
          <EditorTableControls editor={editor} />
          <EditorCalloutControls editor={editor} />
          <EditorSlashMenu
            editor={editor}
            pickImage={onImageDrop ? pickImage : undefined}
            // "/image <description>" — workspaces with an uploader wired
            // (the picked candidate goes through the same pipeline).
            generateImage={
              onImageDrop && workspaceId
                ? ({ prompt }) =>
                    window.dispatchEvent(
                      new CustomEvent('sundial:open-image-gen', {
                        detail: { prompt, source: editor.view.dom },
                      }),
                    )
                : undefined
            }
            // "/ai <instruction>" sends a turn right away; a bare "/ai" opens
            // the same inline popup as the bubble's Ask Sunny button.
            askSunny={({ text, instruction, caret }) => {
              window.dispatchEvent(
                new CustomEvent(instruction ? 'sundial:add-chat-context' : 'sundial:open-inline-ask', {
                  detail: instruction
                    ? { text, path: filePath ?? null, instruction, caret, forceNew: false, toggle: false }
                    : { text, path: filePath ?? null, caret, source: editor.view.dom },
                }),
              );
            }}
          />
          <EditorAskInput editor={editor} />
          <EditorRewritePopup
            editor={editor}
            projectId={workspaceId ?? null}
            filePath={filePath ?? null}
          />
          <EditorPrismPopup
            editor={editor}
            projectId={workspaceId ?? null}
            filePath={filePath ?? null}
          />
          <EditorLengthResize
            editor={editor}
            projectId={workspaceId ?? null}
            filePath={filePath ?? null}
          />
          <EditorPangramPopup
            editor={editor}
            projectId={workspaceId ?? null}
            filePath={filePath ?? null}
          />
          <EditorImageGenPopup
            editor={editor}
            projectId={workspaceId ?? null}
            filePath={filePath ?? null}
            upload={onImageDrop}
            insertAt={(pos, image) => insertImages(editor.view, pos, [image])}
          />
        </>
      )}
      {hasSuggestions && !readOnly && canResolveSuggestions && editor && (
        // NO `.focus()` in the chains (TipTap's focus() scrolls its selection
        // into view, yanking a reader who never placed a caret to doc
        // start/end) — the bar itself preserves editor focus via onMouseDown.
        <SuggestionReviewBar
          className="sticky bottom-4 z-30 mt-2 pr-1"
          onAcceptAll={() => editor.chain().acceptAllSuggestions().run()}
          onRejectAll={() => editor.chain().rejectAllSuggestions().run()}
        />
      )}
      {/* Anchor mode keeps the popover open with no items: it renders
          "Loading…" while the target note is fetched and "No matches"
          afterwards. Without `linkMenu.anchor` here the menu vanishes in
          exactly those states and the user gets no feedback at all. */}
      {linkMenu && (linkMenu.mode === 'link' || linkMenu.anchor || linkMenuItems.length > 0) && (
        <div
          ref={linkMenuDomRef}
          role="listbox"
          className="fixed z-50 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-stone-200 bg-white p-1.5 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
          style={{
            // Anchor the Cmd-K link popover at the caret, not the toolbar:
            // `rect` is `view.coordsAtPos(selection.to)`, clamped to the viewport.
            left: Math.min(linkMenu.rect.left, window.innerWidth - 336),
            top: linkMenu.rect.bottom + 6,
          }}
          onMouseDown={(event) => {
            // Keep editor focus alive when the user clicks the popover chrome,
            // but let inputs / buttons receive their own mouse events.
            const target = event.target as HTMLElement | null;
            if (target?.closest('input, textarea, button')) return;
            event.preventDefault();
          }}
        >
          {linkMenu.mode === 'link' && (
            <div className="space-y-1.5 px-1 pb-1.5 pt-1">
              <div className="rounded-xl border border-stone-300 bg-white px-3 py-1.5 transition-colors focus-within:border-beige-400">
                <input
                  ref={linkLabelInputRef}
                  type="text"
                  value={linkMenu.label ?? ''}
                  placeholder="Text"
                  onChange={(event) => {
                    const next = event.target.value;
                    setLinkMenu((prev) =>
                      prev ? { ...prev, label: next, labelEdited: true } : prev,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      closeLinkMenu();
                      editor.view.focus();
                      return;
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (linkMenuItems.length > 0) {
                        pickLinkItem(linkMenuItems[linkMenuIndex] ?? linkMenuItems[0]);
                      }
                    }
                  }}
                  className="w-full bg-transparent text-[13px] leading-5 text-stone-800 outline-none placeholder:text-stone-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-xl border border-stone-300 bg-white px-3 py-1.5 transition-colors focus-within:border-beige-400">
                  <input
                    ref={linkUrlInputRef}
                    type="text"
                    value={linkMenu.query}
                    placeholder="Search files or paste a link"
                    onChange={(event) => {
                      const next = event.target.value;
                      setLinkMenu((prev) => (prev ? { ...prev, query: next } : prev));
                      setLinkMenuIndex(0);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        closeLinkMenu();
                        editor.view.focus();
                        return;
                      }
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        if (linkMenuItems.length === 0) return;
                        event.preventDefault();
                        const delta = event.key === 'ArrowDown' ? 1 : -1;
                        setLinkMenuIndex(
                          (current) => (current + delta + linkMenuItems.length) % linkMenuItems.length,
                        );
                        return;
                      }
                      if (event.key === 'Enter') {
                        if (linkMenuItems.length === 0) return;
                        event.preventDefault();
                        pickLinkItem(linkMenuItems[linkMenuIndex] ?? linkMenuItems[0]);
                      }
                    }}
                    className="w-full bg-transparent text-[13px] leading-5 text-stone-800 outline-none placeholder:text-stone-500"
                  />
                </div>
                <button
                  type="button"
                  disabled={linkMenuItems.length === 0}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    if (linkMenuItems.length === 0) return;
                    pickLinkItem(linkMenuItems[linkMenuIndex] ?? linkMenuItems[0]);
                  }}
                  className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                    linkMenuItems.length === 0
                      ? 'cursor-not-allowed bg-stone-100 text-stone-400'
                      : 'bg-[#f1e5d7] text-[#634a31] hover:bg-[#ead9c6]'
                  }`}
                >
                  Apply
                </button>
              </div>
            </div>
          )}
          <div
            ref={linkMenuListRef}
            className="max-h-72 overflow-y-auto overscroll-contain"
          >
            {linkMenuItems.length === 0 ? (
              <div className="px-3 py-2 text-[13px] text-stone-500">
                {linkMenu.anchor &&
                (anchorNote?.path !== linkMenu.anchor.path || anchorNote?.status === 'loading')
                  ? 'Loading…'
                  : linkMenu.anchor && anchorNote?.status === 'error'
                    ? "Couldn't read that note"
                    : 'No matches'}
              </div>
            ) : (
              linkMenuItems.map((item, index) => {
                const active = index === linkMenuIndex;
                const primary = item.kind === 'file'
                  ? item.path.split('/').pop() ?? item.path
                  : item.kind === 'anchor'
                    ? (item.suggestion.kind === 'heading' ? item.suggestion.heading : item.suggestion.preview)
                    : item.label;
                const secondary = item.kind === 'file'
                  ? (item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '')
                  : item.kind === 'anchor'
                    ? (item.suggestion.kind === 'heading'
                        ? `H${item.suggestion.level}`
                        : `^${item.suggestion.id}`)
                    : item.url;
                const key = item.kind === 'file'
                  ? `file:${item.path}`
                  : item.kind === 'anchor'
                    ? `anchor:${index}:${item.suggestion.kind === 'heading' ? item.suggestion.heading : item.suggestion.preview}`
                    : `url:${item.url}`;
                return (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={[
                      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                      // Keyboard-driven "active" highlight + CSS-only hover.
                      // We intentionally do NOT bind onMouseEnter to set the
                      // index — when the user holds an arrow key, the list
                      // scrolls under a stationary cursor, which would fire
                      // mouseenter on the item now under the cursor and yank
                      // the highlight back to the mouse position.
                      active
                        ? 'bg-stone-100 text-stone-800'
                        : 'text-stone-800 hover:bg-stone-100/60',
                    ].join(' ')}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pickLinkItem(item);
                    }}
                  >
                    {item.kind === 'file' ? (
                      <FileTextIcon className="h-4 w-4 shrink-0 text-stone-500" weight="regular" />
                    ) : item.kind === 'anchor' ? (
                      item.suggestion.kind === 'heading' ? (
                        <HashIcon className="h-4 w-4 shrink-0 text-stone-500" weight="regular" />
                      ) : (
                        <ParagraphIcon className="h-4 w-4 shrink-0 text-stone-500" weight="regular" />
                      )
                    ) : (
                      <GlobeIcon className="h-4 w-4 shrink-0 text-stone-500" weight="regular" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{primary}</span>
                    {secondary && (
                      <span className="min-w-0 shrink truncate text-[11px] text-stone-500">
                        {secondary}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
      {linkHoverCard && !linkMenu && (
        <div
          role="dialog"
          aria-label="Link options"
          className="fixed z-40 flex items-center gap-1 rounded-xl border border-stone-200 bg-white px-2 py-1.5 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
          style={{
            left: Math.min(linkHoverCard.rect.left, window.innerWidth - 320),
            top: linkHoverCard.rect.bottom + 6,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <span
            aria-hidden
            className="flex h-5 w-5 shrink-0 items-center justify-center text-stone-400"
            title={linkHoverCard.isWiki ? 'Workspace file' : 'External link'}
          >
            {linkHoverCard.isWiki ? (
              <FileTextIcon className="h-4 w-4" weight="regular" />
            ) : (
              <GlobeIcon className="h-4 w-4" weight="regular" />
            )}
          </span>
          <button
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
              navigateToHref(linkHoverCard.href, linkHoverCard.isWiki);
            }}
            className="max-w-[220px] truncate rounded-md px-1.5 py-1 text-[13px] text-beige-600 transition-colors hover:bg-beige-100 hover:underline"
            title={linkHoverCard.href}
          >
            {linkHoverCard.href}
          </button>
          <div className="mx-1 h-4 w-px bg-stone-200" />
          <button
            type="button"
            aria-label={linkCopied ? 'Copied' : 'Copy link'}
            title={linkCopied ? 'Copied' : 'Copy link'}
            onMouseDown={(event) => {
              event.preventDefault();
              copyToClipboard(linkHoverCard.href);
              setLinkCopied(true);
              if (linkCopyTimerRef.current) clearTimeout(linkCopyTimerRef.current);
              linkCopyTimerRef.current = setTimeout(() => setLinkCopied(false), 1600);
            }}
            className={`rounded-md p-1 transition-colors ${
              linkCopied
                ? 'text-emerald-600'
                : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'
            }`}
          >
            {linkCopied ? (
              <CheckIcon
                className="h-4 w-4 animate-in zoom-in-50 duration-200"
                weight="bold"
              />
            ) : (
              <CopyIcon className="h-4 w-4" weight="regular" />
            )}
          </button>
          <button
            type="button"
            aria-label="Edit link"
            title="Edit link"
            onMouseDown={(event) => {
              event.preventDefault();
              void openEditLinkMenu(editor.view, linkHoverCard);
            }}
            className="rounded-md p-1 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
          >
            <PencilSimpleIcon className="h-4 w-4" weight="regular" />
          </button>
          <button
            type="button"
            aria-label="Remove link"
            title="Remove link"
            onMouseDown={(event) => {
              event.preventDefault();
              removeLinkAt(editor.view, { from: linkHoverCard.from, to: linkHoverCard.to });
            }}
            className="rounded-md p-1 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
          >
            <LinkBreakIcon className="h-4 w-4" weight="regular" />
          </button>
        </div>
      )}
      {editorContextMenu && (
        <div
          role="menu"
          className="fixed z-[65] min-w-[220px] rounded-xl border border-stone-200 bg-white p-1.5 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
          style={{
            top: Math.max(12, editorContextMenu.y - 1),
            left: Math.max(12, editorContextMenu.x - 1),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEditorContextMenu(null);
              void openLinkModeMenu(editor.view);
            }}
            className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm text-stone-800 transition-colors hover:bg-stone-100"
          >
            <span className="inline-flex items-center gap-2">
              <LinkSimpleIcon className="h-4 w-4 text-stone-500" weight="regular" />
              Add link
            </span>
            <span className="text-[11px] text-stone-500">⌘K</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ── CollabEditor ──────────────────────────────────────────────────────
 *  Resolves the Hocuspocus provider + Y.Doc for a file and tracks connection
 *  status, then mounts <CollabEditorInner> once the doc is ready. Gating the
 *  inner mount means the Tiptap editor is built once — against the real
 *  provider/ydoc — instead of once empty and again with collaboration.
 * ───────────────────────────────────────────────────────────────────── */
export function CollabEditor(props: CollabEditorProps) {
  const { fileId, workspaceId, filePath, collabPath, user, readOnly = false, hidden = false, style,
    onConnectionStatusChange } = props;

  const fallbackCollabUrl = resolveCollabUrl();
  const sharedSocket = useWorkspaceCollabSocket(workspaceId);
  const sharedSocketPending = useWorkspaceCollabSocketPending();
  const [hostCollabUrl, setHostCollabUrl] = useState<string | undefined>(undefined);
  const [hostToken, setHostToken] = useState<string | undefined>(undefined);
  const [hostDocNamePrefix, setHostDocNamePrefix] = useState<string | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const localYdoc = useMemo(() => new Y.Doc({ guid: fileId }), [fileId]);

  // Release the local Y.Doc's CRDT struct store when the editor unmounts or
  // the file changes — otherwise it stays resident for the whole session.
  useEffect(() => () => localYdoc.destroy(), [localYdoc]);

  useEffect(() => {
    // A shared socket that is still opening makes this fallback redundant
    // (and it would otherwise fire one throwaway /host request per mount).
    if (!workspaceId || sharedSocket || sharedSocketPending) {
      setHostCollabUrl(undefined);
      setHostToken(undefined);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      const host = await fetchWorkspaceHost(workspaceId, { signal: controller.signal }).catch(
        () => null,
      );
      if (cancelled || !host) return;
      setHostCollabUrl(host.collabUrl);
      setHostToken(host.token);
      setHostDocNamePrefix(host.docNamePrefix ?? null);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workspaceId, sharedSocket, sharedSocketPending]);

  const effectiveHostCollabUrl = sharedSocket?.collabUrl ?? hostCollabUrl;
  const effectiveDocNamePrefix = sharedSocket?.docNamePrefix ?? hostDocNamePrefix;
  const collabUrl = workspaceId ? effectiveHostCollabUrl : fallbackCollabUrl;
  const docName = workspaceId && (collabPath ?? filePath)
    ? `${effectiveDocNamePrefix ?? ''}${collabPath ?? filePath}`
    : fileId;
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(collabUrl ? 'connecting' : 'local');
  // The last status we actually displayed, persisted across provider swaps. A
  // mode toggle (Edit↔Suggest) recreates the provider, which re-runs the status
  // effect; without this the effect resets to 'connecting' and shows the new
  // provider's reconnect blip immediately, defeating the debounce. Seeding the
  // effect from this ref means a swap that was 'connected' debounces its blip.
  const lastShownStatusRef = useRef<ConnectionStatus>(collabUrl ? 'connecting' : 'local');
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [initialSyncReady, setInitialSyncReady] = useState(!collabUrl);
  const [syncVerified, setSyncVerified] = useState(!collabUrl);
  const [openedFromBootstrap, setOpenedFromBootstrap] = useState(false);
  const openTimingRef = useRef<ReturnType<typeof startFileOpen> | null>(null);
  if (!openTimingRef.current || openTimingRef.current.fileId !== fileId) {
    openTimingRef.current = startFileOpen(fileId, undefined, !hidden);
  }

  const reportEditorMounted = useCallback(() => {
    const timing = openTimingRef.current;
    if (!timing || hidden || timing.fileId !== fileId || timing.visible) return;
    return afterNextPaint(() => {
      if (openTimingRef.current !== timing || hidden) return;
      const measurement = finishFileVisible(timing);
      if (!measurement) return;
      track('file_open_performance', {
        projectId: workspaceId,
        fileId,
        path: filePath,
        editor: 'markdown',
        phase: 'visible',
        bootstrap: openedFromBootstrap,
        elapsedMs: measurement.elapsedMs,
        openKind: measurement.openKind,
        ...(measurement.navigationElapsedMs !== undefined
          ? { navigationToVisibleMs: measurement.navigationElapsedMs }
          : {}),
      });
    });
  }, [fileId, filePath, hidden, openedFromBootstrap, workspaceId]);

  useEffect(() => {
    setConnectionStatus(collabUrl ? 'connecting' : 'local');
    setInitialSyncReady(!collabUrl);
    setSyncVerified(!collabUrl);
    if (!sharedSocket) {
      setYdoc(localYdoc);
    }
    providerRef.current?.destroy();
    providerRef.current = null;
    // Intentionally do NOT `setProvider(null)` here. Effects below own the
    // provider state, and a blanket reset on every dep change would also
    // fire under React Fast Refresh (which recomputes the `localYdoc`
    // memo) — the re-acquire effect wouldn't re-run because *its* deps are
    // unchanged, leaving the editor stuck on "Loading editor…" until
    // manual reload.
  }, [collabUrl, localYdoc, sharedSocket]);

  // Acquire a provider+ydoc from the cache (keyed by docName on the shared
  // socket). Multiple CollabEditor mounts for the same file share one
  // Hocuspocus Connection — so remounts don't close the server connection,
  // and agent broadcasts keep landing even when the editor briefly tears
  // down and rebuilds.
  useEffect(() => {
    if (!sharedSocket || !docName) {
      setProvider(null);
      if (!collabUrl) setYdoc(null);
      return;
    }
    // Token getter, not a frozen string: re-evaluated on every attach and
    // socket reconnect, so a provider created after long idle (token TTL
    // elapsed) still authenticates instead of loading forever.
    const entry = acquireProvider(sharedSocket.socket, docName, fileId, sharedSocket.getToken);
    setProvider(entry.provider);
    setYdoc(entry.ydoc);
    setOpenedFromBootstrap(entry.bootstrapped);
    setInitialSyncReady(entry.bootstrapped || entry.provider.synced);
    setSyncVerified(entry.provider.synced);
    return () => {
      releaseProvider(sharedSocket.socket, docName, fileId);
    };
    // fileId is a dep: a file deleted and re-created at the SAME path keeps the
    // same docName but gets a new fileId, and must re-acquire a fresh room
    // rather than reuse the emptied one (see acquireProvider).
  }, [sharedSocket, docName, fileId]);

  useEffect(() => {
    if (sharedSocket || !collabUrl || providerRef.current) return;

    const nextProvider = new HocuspocusProvider({
      name: docName,
      document: localYdoc,
      url: collabUrl,
      ...(hostToken ? { token: hostToken } : {}),
    });
    nextProvider.awareness?.setLocalStateField('user', user);
    providerRef.current = nextProvider;
    setProvider(nextProvider);
    setYdoc(localYdoc);

    return () => {
      nextProvider.destroy();
      if (providerRef.current === nextProvider) {
        providerRef.current = null;
      }
    };
  }, [collabUrl, docName, hostToken, localYdoc, sharedSocket, user]);

  useEffect(() => {
    if (!collabUrl) {
      lastShownStatusRef.current = 'local';
      setConnectionStatus('local');
      return;
    }
    if (!provider) {
      lastShownStatusRef.current = 'connecting';
      setConnectionStatus('connecting');
      return;
    }

    // An Edit↔Suggest toggle intentionally drops + reconnects the socket to
    // re-auth with the new mode-scoped token (collab-socket-context). The doc
    // isn't re-synced and the socket is back in well under a second, so flashing
    // "offline" for that blip is misleading. Debounce the drop: only surface a
    // non-connected status if it PERSISTS past the blip window; a reconnect
    // within it never shows offline. A real outage (longer) still surfaces.
    let dropTimer: ReturnType<typeof setTimeout> | null = null;
    let shown: ConnectionStatus = lastShownStatusRef.current;
    const clearDropTimer = () => { if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; } };
    const show = (s: ConnectionStatus) => { shown = s; lastShownStatusRef.current = s; setConnectionStatus(s); };
    const handleStatus = (event: { status: string }) => {
      if (event.status === 'connected') {
        clearDropTimer();
        show('connected');
        return;
      }
      const next: ConnectionStatus = event.status === 'disconnected' ? 'disconnected' : 'connecting';
      // Already showing a non-connected state (initial connect / sustained
      // outage) → reflect it immediately; only a connected→blip transition is
      // debounced so a mode-toggle re-auth doesn't flash "offline".
      if (shown !== 'connected') { show(next); return; }
      clearDropTimer();
      dropTimer = setTimeout(() => { dropTimer = null; show(next); }, 1200);
    };

    provider.on('status', handleStatus);
    // HocuspocusProvider only forwards socket status events — attaching to an
    // already-connected shared socket doesn't replay one, so seed from the
    // socket's current status or the editor stays stuck in 'connecting'.
    const seed =
      (provider.configuration.websocketProvider as { status?: string } | undefined)?.status;
    if (seed) handleStatus({ status: seed });
    return () => {
      clearDropTimer();
      provider.off('status', handleStatus);
    };
  }, [collabUrl, provider]);

  useEffect(() => {
    if (!collabUrl) {
      setInitialSyncReady(true);
      setSyncVerified(true);
      return;
    }
    if (!provider) {
      setInitialSyncReady(false);
      setSyncVerified(false);
      return;
    }
    if (provider.synced) {
      setInitialSyncReady(true);
      setSyncVerified(true);
      return;
    }
    setSyncVerified(false);
    const markReady = () => {
      setInitialSyncReady(true);
      setSyncVerified(true);
    };
    const handleSync = (synced: boolean) => {
      if (synced) markReady();
    };
    provider.on?.('synced', markReady);
    provider.on?.('sync', handleSync);
    return () => {
      provider.off?.('synced', markReady);
      provider.off?.('sync', handleSync);
    };
  }, [collabUrl, docName, fileId, filePath, provider]);

  // Rescue a provider stranded on a half-dead-but-"connected" shared socket
  // (the "Loading editor…" forever bug on file switch / after idle).
  useCollabSyncWatchdog({
    enabled: !!collabUrl,
    provider,
    reconnect: sharedSocket?.reconnect,
    syncSignal: syncVerified,
  });

  useEffect(() => {
    onConnectionStatusChange?.(connectionStatus);
  }, [connectionStatus, onConnectionStatusChange]);

  useEffect(() => {
    const timing = openTimingRef.current;
    if (!timing || !syncVerified || !provider || timing.fileId !== fileId || timing.synced) return;
    const measurement = finishFileSync(timing);
    if (!measurement) return;
    track('file_open_performance', {
      projectId: workspaceId,
      fileId,
      path: filePath,
      editor: 'markdown',
      phase: 'sync_verified',
      bootstrap: openedFromBootstrap,
      elapsedMs: measurement.elapsedMs,
      openKind: measurement.openKind,
      ...(measurement.navigationElapsedMs !== undefined
        ? { navigationToSyncMs: measurement.navigationElapsedMs }
        : {}),
    });
  }, [fileId, filePath, openedFromBootstrap, provider, syncVerified, workspaceId]);

  useEffect(() => {
    // Local (sidecar) projects: edit telemetry would upload local file paths —
    // nothing may leave the machine for an unshared local project.
    if (!ydoc || sharedSocket?.isLocal) return;
    return trackYDocUserEdits(ydoc, {
      workspaceId,
      fileId,
      filePath,
      mode: 'collab',
      readOnly: readOnly || !syncVerified,
      provider,
    });
  }, [ydoc, provider, workspaceId, fileId, filePath, readOnly, syncVerified, sharedSocket?.isLocal]);

  // Mount the editor only once the Y.Doc is ready — and the provider too when
  // this file is collaborative. Keyed on the doc guid so a doc swap (host
  // preemption) cleanly remounts.
  const ready = !!ydoc && (!!provider || !collabUrl) && initialSyncReady;
  if (!ready) {
    return (
      <div className={hidden ? 'hidden' : 'block'} style={style}>
        {!hidden && <EditorSkeleton />}
      </div>
    );
  }

  return (
    <CollabEditorInner
      key={ydoc.guid}
      {...props}
      readOnly={readOnly || (!!collabUrl && !syncVerified)}
      ydoc={ydoc}
      provider={provider}
      onEditorMountedForTiming={reportEditorMounted}
    />
  );
}
