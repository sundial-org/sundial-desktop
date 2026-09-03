'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatTeardropTextIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import type { editor as MonacoEditorType } from 'monaco-editor';
import { ensureCodeText } from '@/lib/collab/code-text';
import { MonacoEditor, getCodeEditorOptions, getCodeLanguage, defineMonacoThemes, preloadMonaco, useMonacoTheme } from '@/components/workspace/code-viewer';
import { SELECTION_SAMPLE_LIMIT } from '@/components/workspace/editor-bubble-menu';
import { SelectionActionControls } from '@/components/workspace/selection-action-controls';
import {
  INVOKE_SELECTION_ACTION_EVENT,
  MAX_SELECTION_ACTION_TEXT_CHARS,
  type WorkspaceSelectionAction,
} from '@/lib/assistants/selection-actions';
import {
  BUBBLE_LABEL_ACCENT,
  BUBBLE_SURFACE,
} from '@/components/workspace/selection-bubble-styles';
import { EditorSkeleton } from '@/components/workspace/editor-skeleton';
import {
  registerLatexCompletions,
  setLatexProjectContext,
} from '@/lib/latex/register-latex-completions';
import { fetchLatexProjectContext } from '@/lib/latex/fetch-latex-project-context';
import {
  clearAutocompleteContext,
  isAutocompleteSupportedLanguage,
  registerAutocompleteProvider,
  registerAutocompleteToggleAction,
  setAutocompleteContext,
} from '@/lib/workspace/autocomplete/monaco-inline-completions';
import { isAutocompleteEnabled } from '@/lib/workspace/autocomplete/flag';
import { attachSyncTexBindings } from '@/lib/latex/synctex-editor';
import { fetchWorkspaceHost, resolveCollabUrl, type ConnectionStatus } from '@/lib/workspace/collab-url';
import { DIFF_CHECK_ICON_SVG, DIFF_X_ICON_SVG } from '@/lib/workspace/diff-action-icons';
import { authorButton } from '@/lib/workspace/suggestion-marks';
import { AutocompleteStatusChip } from '@/components/workspace/autocomplete-status-chip';
import { SuggestionReviewBar } from '@/components/workspace/suggestion-review-bar';
import { pickColor } from '@/components/collab-bubbles';
import { isEditorImageFile } from '@/lib/workspace/heic';
import {
  acquireProvider,
  releaseProvider,
  useWorkspaceCollabSocket,
  useWorkspaceCollabSocketPending,
} from '@/lib/workspace/collab-socket-context';
import { useCollabSyncWatchdog } from '@/lib/workspace/use-collab-sync-watchdog';
import { trackYDocUserEdits } from '@/lib/analytics/document-edit-tracker';
import { track } from '@/lib/analytics/track';
import { LATEX_IMAGE_EXT_RE, relativeToTexDir, texHasGraphicx } from '@/lib/workspace/latex-image';
import { formatLatexSnippet, type LatexSnippet } from '@/lib/workspace/latex-snippets';
import type { LatexMarker } from '@/lib/workspace/latex-log-navigation';
import {
  installLatexCompileMarkers,
  LATEX_COMPILE_MARKER_OWNER,
} from '@/lib/workspace/latex-monaco-markers';
import { matchPendingHunks, type PendingHunkInput } from '@/lib/workspace/pending-hunks-match';
import { setFreezeContext, fileTypeFromPath } from '@/lib/perf/freeze-monitor';
import {
  afterNextPaint,
  finishFileSync,
  finishFileVisible,
  startFileOpen,
} from '@/lib/perf/file-open-timing';
import { codeSuggestionRender } from '@/lib/workspace/code-suggestion-render';
import { CODE_SUGGESTIONS_ROOT, CODE_RESOLVED_ROOT, acceptCodeSuggestion, rejectCodeSuggestion } from '@/lib/crdt-js/code_suggestions.mjs';
import { installCodeSuggestStaging, ledgerResolveId, type CodeSuggestMeta } from '@/lib/workspace/code-suggest-staging';

// Transaction origin tagged on a ✓/✕ accept-or-reject so the editor's
// Y.UndoManager scopes the decision into its undo stack — Cmd+Z then returns the
// suggestion to its pending (green/red) state instead of being a no-op (accept
// touches no buffer text) or a text-only revert that strands the ledger entry.
const CODE_SUGGEST_UNDO_ORIGIN = 'code-suggest-resolve';
import {
  buildLineChangeHighlights,
  computeInlineAddedRangesForBlock,
  escapeHtml,
  pickPairedAdditionLine,
  wrapRangesHtml,
  type LineChangePair,
} from '@/lib/workspace/inline-word-diff';
import { normalizeForDiff } from '@/lib/workspace/pending-additions-match';
import { isHumanReviewId } from '@/lib/workspace/human-suggestions';
import { ledgerUnbackedAdditions } from '@/lib/workspace/pending-additions';
import { isMarkdownFile } from '@/lib/sync/policy';
import type { TurnEditLine } from '@/lib/workspace/turn-edits';
import { pickCommentAtPos, retryUntilDone, type DocCommentThread, type DraftDocCommentSelection } from '@/lib/workspace/doc-comments';
import {
  buildCodeCommentSelection,
  resolveCodeCommentAnchorRange,
  resolveCodeCommentRanges,
} from '@/lib/workspace/code-comments';
import { findWordNearLine } from '@/lib/latex/reveal-word';

type CollabUser = {
  name: string;
  color: string;
  /** Presence-channel key (`user:<id>` / `anon:<id>`) broadcast into awareness
   *  so a clicked presence bubble can find this client's caret. */
  presenceKey?: string;
};

// Translate a character offset within freshly-inserted snippet text into a
// Monaco position, relative to where the insertion began (handles multi-line
// snippets like environments).
function snippetOffsetToPosition(
  monaco: typeof import('monaco-editor'),
  startPos: { lineNumber: number; column: number },
  text: string,
  offset: number,
) {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  if (lastNewline === -1) {
    return new monaco.Position(startPos.lineNumber, startPos.column + before.length);
  }
  const newlineCount = before.length - before.replace(/\n/g, '').length;
  return new monaco.Position(startPos.lineNumber + newlineCount, before.length - lastNewline);
}

export type CodeEditorHandle = {
  getText: () => string;
  /** Reveal + flash a 1-based line. With `word`, snap to that word's own line
   *  nearby (SyncTeX gives approximate lines; the double-clicked PDF word is
   *  exact) and select it, so the highlight matches what was clicked. */
  revealLine?: (line: number, word?: string) => void;
  /** Continuous scroll sync: silently bring a line to the viewport top — no
   *  focus, no flash, no cursor move — and hold this editor's own scroll
   *  reports for a beat so the panes don't ping-pong. */
  scrollToLineTop?: (line: number) => void;
  /** 1-based cursor line (SyncTeX forward search); null before Monaco mounts. */
  getCursorLine?: () => number | null;
  /** Anchor a comment on a character range of THIS file's Y.Text (the PDF
   *  selection path — Monaco's own path goes through its Comment action). */
  buildCommentSelectionFromOffsets?: (from: number, to: number) => DraftDocCommentSelection | null;
  /** Insert/wrap a LaTeX snippet at the current selection (toolbar actions). */
  insertLatexSnippet?: (snippet: LatexSnippet) => void;
  /** Insert raw text at the cursor, replacing any selection (e.g. a symbol). */
  insertText?: (text: string) => void;
  /** Native Monaco undo/redo, for the toolbar's undo/redo buttons. */
  undo?: () => void;
  redo?: () => void;
  /** Replace/insert/delete a base row (1-based line), for the editable CSV table. */
  applyCsvRowOp?: (op: { type: 'replace' | 'insertAfter' | 'delete'; line: number; text?: string }) => void;
  /** Keep (accept) or discard (reject) a pending suggestion by its addition key. */
  resolveSuggestion?: (key: string, keep: boolean) => void;
};

type Disposable = {
  dispose: () => void;
};

type MonacoBindingInstance = {
  destroy: () => void;
  // y-monaco private seams the suggest-mode staging install reads (pinned ^0.1.6).
  mux?: (fn: () => void) => void;
  _monacoChangeHandler?: { dispose: () => void };
};

type ReadyPayload = {
  editor: CodeEditorHandle;
  ydoc: Y.Doc;
};

export interface CodePendingAddition {
  /** Stable key, e.g. `${assistantMessageId}:${chunkId}`. */
  key: string;
  /** Review-unit id (`assistantMessageId` / human `human-<rowId>` run). Human
   *  runs collapse to ONE Accept/Reject for the whole action — see the overlay. */
  groupKey?: string;
  /** Addition text lines (each a single line from the diff). */
  text: string;
  /** When false, Keep/Undo affordances are hidden. */
  canMutate: boolean;
  /**
   * Full ordered hunk ops (contexts + additions + deletions) — when present,
   * the editor uses hunk-position matching to anchor the chunk by its
   * surrounding context instead of by trimmed-line equality. Falls back to
   * `text` when absent (legacy callers).
   */
  lines?: TurnEditLine[];
  /** 0-indexed expected starting line in the new file; proximity tie-break. */
  newStart?: number;
  /** Deleted line text(s), rendered as red ghost rows above the addition. */
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
  /** Assistant message id this addition came from. */
  assistantMessageId?: string;
  /** Chat id that owns the assistant message — required to switch chats on jump. */
  chatId?: string;
}

interface CollabCodeEditorProps {
  fileId: string;
  filePath: string;
  /** Overrides filePath for the Yjs room name only. Set during an in-flight
   *  optimistic move of the open file: the tree/chat already show the new
   *  path while the room must stay on the old one until the rename commits. */
  collabPath?: string;
  /** Workspace project id. When set the editor connects to the
   *  per-workspace warm host instead of the global Hocuspocus. */
  workspaceId?: string;
  /** Cloud project id authorized for workspace-global assistant actions.
   *  Omit for local workspaces and members without workspace-wide write. */
  selectionActionsProjectId?: string;
  /** The page's workspace fetch — the sidecar shim on local workspaces, so
   *  the LaTeX completion context resolves there instead of 404ing on the
   *  real Next API. Defaults to global fetch. */
  apiFetch?: typeof fetch;
  user: CollabUser;
  onReady?: (payload: ReadyPayload) => void;
  onContentChange?: (text: string) => void;
  /** Fires on every LOCAL Y.Text transaction (this tab's own typing) — remote
   *  and agent edits don't. The LaTeX auto-compile authorship gate (§1.2). */
  onLocalEdit?: () => void;
  onConnectionStatusChange?: (status: ConnectionStatus) => void;
  className?: string;
  hidden?: boolean;
  readOnly?: boolean;
  /** False for commenters: they compose suggestions but the Keep/Undo pill
   *  stays editor-only. */
  canResolveSuggestions?: boolean;
  /**
   * Document edit mode. In `suggest`, the user's local edits are staged into the
   * CRDT code-suggestion ledger synchronously (instant green/red overlay) instead
   * of being written as plain text; `edit` is the normal direct-write binding.
   */
  editMode?: 'edit' | 'suggest';
  /** Fill the parent's height (Monaco scrolls) instead of growing with content. */
  bare?: boolean;
  pendingAdditions?: CodePendingAddition[];
  onKeepAddition?: (key: string) => void;
  onUndoAddition?: (key: string) => void;
  /**
   * Fires with the editor's effective live suggestion set (merged CRDT ledger +
   * server props) whenever it changes, so an alternate surface (the CSV table)
   * can render the same diff instantly — including the user's own just-staged
   * suggest-mode edits, which the server-fed prop path only sees after a poll.
   */
  onActiveSuggestionsChange?: (additions: CodePendingAddition[]) => void;
  onJumpToTurn?: (assistantMessageId: string, chatId: string | null) => void;
  /**
   * When set (LaTeX files only), images dropped or pasted into the editor are
   * passed here for upload. Returns the uploaded file's workspace path, which
   * the editor inserts as a tex-relative `\includegraphics{…}` reference.
   */
  onImageUpload?: (file: File) => Promise<string | null>;
  /** Open comment threads for this file (Google-Docs-style inline comments). */
  commentThreads?: DocCommentThread[];
  /** Thread highlighted in the lane — gets a stronger inline highlight. */
  activeCommentThreadId?: string | null;
  /** In-progress comment selection (rendered as a draft highlight). */
  draftCommentSelection?: DraftDocCommentSelection | null;
  /** Whether the user may start a comment (drives the context-menu action). */
  canComment?: boolean;
  /** The comment lane's row element; anchor offsets are measured relative to it. */
  commentLaneRowRef?: React.RefObject<HTMLElement | null>;
  /** Clicking commented text selects that thread (null = clicked outside). */
  onSelectComment?: (threadId: string | null) => void;
  /** "Comment" action / Cmd-Opt-M built a selection to comment on. */
  onStartCommentDraft?: (selection: DraftDocCommentSelection) => void;
  /** Reports each thread's (and the draft's) vertical center for lane layout. */
  /** `attempted: false` = anchors could not be measured this pass (no lane row
   *  yet) — the lane must not treat the empty offsets as authoritative. */
  onReportCommentAnchors?: (data: {
    offsets: Record<string, number>;
    draftOffset: number | null;
    attempted?: boolean;
    /** 1-based [start, end] source lines per thread — the PDF comment pins
     *  and highlights map these through SyncTeX forward search. Reported even
     *  when the lane row is missing (`attempted: false`): line resolution
     *  doesn't need it. */
    lineSpans?: Record<string, [number, number]>;
  }) => void;
  /** Scroll to a remote collaborator's caret in this doc (bubble click).
   *  Same contract as CollabEditor's prop — y-monaco publishes the caret
   *  under awareness `selection` rather than `cursor`. */
  revealPeer?: {
    seq: number;
    presenceKey?: string | null;
    name?: string | null;
    color?: string | null;
  } | null;
  /** Reveal delivered (scrolled) or given up — the owner clears the request
   *  so a later remount of this file can't replay it. */
  onRevealPeerDone?: (seq: number) => void;
  /** Editor gained focus — presence uses this to broadcast which file the
   *  user is actually editing (split panes make "the selected file" wrong). */
  onFocused?: () => void;
  /** Continuous scroll sync: debounced top visible line as the user scrolls
   *  (quiet while a scrollToLineTop follow is landing). */
  onScrollTopLine?: (line: number) => void;
  /** LaTeX compile problems for THIS file — rendered as Monaco markers +
   *  gutter bars (spec §1.9). Omit / empty clears them. */
  compileMarkers?: LatexMarker[];
  /** Fires only after Monaco has installed a compile marker and its gutter for
   *  this open file. Used by onboarding's diagnostic-visible milestone. */
  onCompileMarkersVisible?: (filePath: string, markers: readonly LatexMarker[]) => void;
  /** Forward SyncTeX (.tex only): the "Show in PDF" context-menu action and
   *  its Ctrl/Cmd+Alt+J chord jump the PDF to the cursor line. */
  onShowInPdf?: () => void;
}

export function CollabCodeEditor({
  fileId,
  filePath,
  collabPath,
  workspaceId,
  selectionActionsProjectId,
  apiFetch,
  user,
  onReady,
  onContentChange,
  onLocalEdit,
  onConnectionStatusChange,
  className,
  hidden = false,
  readOnly = false,
  canResolveSuggestions = true,
  editMode = 'edit',
  bare = false,
  pendingAdditions,
  onKeepAddition,
  onUndoAddition,
  onActiveSuggestionsChange,
  onJumpToTurn,
  onImageUpload,
  commentThreads,
  activeCommentThreadId,
  draftCommentSelection,
  canComment = false,
  commentLaneRowRef,
  onSelectComment,
  onStartCommentDraft,
  onReportCommentAnchors,
  revealPeer,
  onRevealPeerDone,
  onFocused,
  onScrollTopLine,
  compileMarkers,
  onCompileMarkersVisible,
  onShowInPdf,
}: CollabCodeEditorProps) {
  // Attribution stamped onto suggestions the local user stages in suggest mode.
  // Read through a ref so it doesn't churn the y-monaco binding when `user` changes.
  const stagingMetaRef = useRef<CodeSuggestMeta>({ authorLabel: user.name });
  stagingMetaRef.current = { authorLabel: user.name };
  const onKeepRef = useRef(onKeepAddition);
  onKeepRef.current = onKeepAddition;
  const onImageUploadRef = useRef(onImageUpload);
  onImageUploadRef.current = onImageUpload;
  const onUndoRef = useRef(onUndoAddition);
  onUndoRef.current = onUndoAddition;
  const onActiveSuggestionsChangeRef = useRef(onActiveSuggestionsChange);
  onActiveSuggestionsChangeRef.current = onActiveSuggestionsChange;
  // `null` (not '') so the FIRST apply always emits — including an empty set,
  // so switching to a file with no suggestions clears the consumer instead of
  // leaving the previous file's set (an empty set also hashes to '').
  const lastEmittedSuggestionSigRef = useRef<string | null>(null);
  const onJumpToTurnRef = useRef(onJumpToTurn);
  onJumpToTurnRef.current = onJumpToTurn;
  const onSelectCommentRef = useRef(onSelectComment);
  onSelectCommentRef.current = onSelectComment;
  // Scroll-sync: latest callback + a suppression window (a landed follow must
  // not echo back as this editor's own scroll report).
  const onScrollTopLineRef = useRef(onScrollTopLine);
  onScrollTopLineRef.current = onScrollTopLine;
  const scrollFollowSuppressUntilRef = useRef(0);
  const scrollReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onStartCommentDraftRef = useRef(onStartCommentDraft);
  onStartCommentDraftRef.current = onStartCommentDraft;
  // A rename keeps the editor mounted (keyed by fileId) — onMount closures
  // must read the path through this ref or they'd pin the pre-rename path.
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const onCompileMarkersVisibleRef = useRef(onCompileMarkersVisible);
  onCompileMarkersVisibleRef.current = onCompileMarkersVisible;
  const onReportCommentAnchorsRef = useRef(onReportCommentAnchors);
  onReportCommentAnchorsRef.current = onReportCommentAnchors;
  // Live resolved comment ranges (`[from, to)` char offsets) for click hit-testing.
  const commentRangesRef = useRef<Array<{ id: string; from: number; to: number }>>([]);
  const commentDecorationsRef = useRef<MonacoEditorType.IEditorDecorationsCollection | null>(null);
  // Last thread we scrolled into view, so a realtime thread reload doesn't yank
  // the editor back to an already-revealed comment mid-edit.
  const lastRevealedCommentRef = useRef<string | null>(null);
  const decorationCollectionRef = useRef<MonacoEditorType.IEditorDecorationsCollection | null>(null);
  // View zones + action overlays are reconciled by KEY+signature across applies
  // so resolving one suggestion never tears down the others (the flicker bug):
  // only zones/widgets whose key disappeared or whose signature changed are
  // touched; unchanged ones are left in place.
  const viewZonesRef = useRef<Map<string, { id: string; signature: string; dom: HTMLElement }>>(new Map());
  type ActionsOverlayEntry = {
    widget: MonacoEditorType.IOverlayWidget;
    dom: HTMLElement;
    signature: string;
    /** Buffer line just BELOW which to place the pill (i.e. the line whose
     *  top sits at the bottom of the chunk). */
    placeAtLineTop: number;
    /** The chunk's own line span — the hover range that reveals this pill. */
    fromLine: number;
    toLine: number;
  };
  const actionsOverlaysRef = useRef<Map<string, ActionsOverlayEntry>>(new Map());
  // Live per-apply lookups the (possibly-reused) overlay click handler reads, so
  // a reused pill resolves against the CURRENT ledger/chunk state, not the stale
  // closure from the apply that first created it.
  const ledgerKeysRef = useRef<Set<string>>(new Set());
  // Ledger suggestion ids (groupKeys). A grouped pill (human runs) carries the
  // synthetic key `${id}:*`, which is NOT a per-hunk ledger key — resolve it by
  // this set instead so its Keep/Undo still hits the CRDT.
  const ledgerGroupKeysRef = useRef<Set<string>>(new Set());
  const chunkByKeyRef = useRef<Map<string, CodePendingAddition>>(new Map());
  // `pendingAdditions` is read through a ref + a thin effect that calls `apply()`
  // (below), instead of being an overlay-effect dependency. Re-running that effect
  // tears down + rebuilds every zone/pill (the flicker); reconciling inside a
  // single long-lived apply only touches what changed.
  const pendingAdditionsRef = useRef(pendingAdditions);
  pendingAdditionsRef.current = pendingAdditions;
  const applyOverlaysRef = useRef<(() => void) | null>(null);
  // Turns the ledger has staged this session. Once their entries resolve (the
  // ledger empties for them) we must NOT fall back to the still-stale server prop
  // and re-show a just-accepted suggestion — but a turn the ledger never staged
  // (human/local-agent direct, legacy) still renders from the prop. (Codex P1)
  const ledgerBackedTurnsRef = useRef<Set<string>>(new Set());
  const isApplyingOverlaysRef = useRef(false);
  const layoutRafRef = useRef<number | null>(null);
  // Per-line jump targets so a click anywhere on a green addition line opens
  // the chat turn that made it — same as clicking the `Sunny #N` chip.
  const lineJumpsRef = useRef<Map<number, { id: string; chatId: string | null }>>(
    new Map(),
  );

  const fallbackCollabUrl = resolveCollabUrl();
  const sharedSocket = useWorkspaceCollabSocket(workspaceId);
  const sharedSocketPending = useWorkspaceCollabSocketPending();
  // Start the Monaco download now, in parallel with the Y.Doc sync that gates
  // the editor mount below.
  useEffect(() => {
    preloadMonaco();
  }, []);
  const [hostCollabUrl, setHostCollabUrl] = useState<string | undefined>(undefined);
  const [hostToken, setHostToken] = useState<string | undefined>(undefined);
  const [hostDocNamePrefix, setHostDocNamePrefix] = useState<string | null>(null);
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

  // Feed the shared LaTeX completion provider this project's labels / `.bib`
  // keys / file paths. Best-effort and `.tex`-only; the provider is registered
  // once in onMount and reads whatever context we last set.
  useEffect(() => {
    if (!workspaceId || getCodeLanguage(filePath) !== 'latex') return;
    let cancelled = false;
    void fetchLatexProjectContext(workspaceId, apiFetch).then((context) => {
      if (!cancelled) setLatexProjectContext(context);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath, apiFetch]);

  const effectiveHostCollabUrl = sharedSocket?.collabUrl ?? hostCollabUrl;
  const effectiveDocNamePrefix = sharedSocket?.docNamePrefix ?? hostDocNamePrefix;
  const collabUrl = workspaceId ? effectiveHostCollabUrl : fallbackCollabUrl;
  const docName = workspaceId ? `${effectiveDocNamePrefix ?? ''}${collabPath ?? filePath}` : fileId;
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(collabUrl ? 'connecting' : 'local');
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [initialSyncReady, setInitialSyncReady] = useState(!collabUrl);
  const [syncVerified, setSyncVerified] = useState(!collabUrl);
  const [openedFromBootstrap, setOpenedFromBootstrap] = useState(false);
  const effectiveReadOnly = readOnly || (!!collabUrl && !syncVerified);
  const openTimingRef = useRef<ReturnType<typeof startFileOpen> | null>(null);
  if (!openTimingRef.current || openTimingRef.current.fileId !== fileId) {
    openTimingRef.current = startFileOpen(fileId, undefined, !hidden);
  }
  const [editorHeight, setEditorHeight] = useState(500);
  const monacoTheme = useMonacoTheme();
  const [editorMounted, setEditorMounted] = useState(false);
  const [bindingReady, setBindingReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const bindingRef = useRef<MonacoBindingInstance | null>(null);
  // Undo authority for the code/LaTeX editor: a Y.UndoManager over the code
  // Y.Text + the two suggestion-ledger maps, so one Cmd+Z reverts both the text
  // and the ledger together (the markdown editor's Collaboration UndoManager is
  // the same model). Cmd+Z / toolbar undo route here instead of Monaco's native
  // text-only stack. Null when the ledger is disabled (kill-switch) → native.
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const monacoEditorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);
  const monacoNsRef = useRef<typeof import('monaco-editor') | null>(null);
  const modelRef = useRef<MonacoEditorType.ITextModel | null>(null);
  const revealFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Decoration ids of the live line flash, so a repeat jump replaces it.
  const revealFlashIdsRef = useRef<string[]>([]);
  const contentSubscriptionRef = useRef<Disposable | null>(null);
  // Trailing-debounce handle for large-document onContentChange propagation.
  const contentNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentTextRef = useRef('');
  const ydocRef = useRef<Y.Doc | null>(null);
  ydocRef.current = ydoc;
  const canResolveSuggestionsRef = useRef(canResolveSuggestions);
  canResolveSuggestionsRef.current = canResolveSuggestions && !effectiveReadOnly;
  // Drives the whole-file Accept all / Reject all bar (shared with markdown —
  // see SuggestionReviewBar). Same-value sets are React no-ops, so updating it
  // from the decoration apply pass costs nothing on quiet passes.
  const [pendingReviewCount, setPendingReviewCount] = useState(0);

  // Ghost-text autocomplete context, keyed by THIS editor's model — split
  // panes mount two editors on two files, and the register-once provider
  // resolves which one it is answering for from the model it is handed.
  useEffect(() => {
    const model = monacoEditorRef.current?.getModel();
    if (!editorMounted || !model || !workspaceId) return;
    setAutocompleteContext(model, {
      projectId: workspaceId,
      filePath,
      language: getCodeLanguage(filePath),
      readOnly,
      fetchImpl: apiFetch,
    });
    return () => clearAutocompleteContext(model);
  }, [editorMounted, workspaceId, filePath, readOnly, apiFetch]);

  // Resolve a Keep/Undo by its pending-addition key — ledger-backed suggestions
  // (local user edits, agent turns the poll already staged) resolve straight in
  // the CRDT; prop-only ones fall back to the server route. Shared by the Monaco
  // overlay buttons and the CSV table's buttons so both behave identically.
  const resolveByKey = useCallback((key: string, keep: boolean) => {
    // Commenters compose suggestions but never resolve them — this is the one
    // choke point for the overlay pill, the CSV table buttons, and the
    // imperative `resolveSuggestion` handle.
    if (!canResolveSuggestionsRef.current) return;
    const ydoc = ydocRef.current;
    const resolveId = ydoc
      ? ledgerResolveId(
          key,
          ledgerKeysRef.current,
          ledgerGroupKeysRef.current,
          (k) => chunkByKeyRef.current.get(k)?.groupKey,
        )
      : null;
    if (resolveId != null && ydoc) {
      const um = undoManagerRef.current;
      um?.stopCapturing();
      const opts = { origin: CODE_SUGGEST_UNDO_ORIGIN };
      if (keep) acceptCodeSuggestion(ydoc, resolveId, opts);
      else rejectCodeSuggestion(ydoc, resolveId, opts);
      um?.stopCapturing();
    } else if (keep) {
      onKeepRef.current?.(key);
    } else {
      onUndoRef.current?.(key);
    }
  }, []);

  // Replace / insert / delete a whole base row, driving Monaco so the edit flows
  // through y-monaco (edit mode → Y.Text) or the suggest-staging interceptor
  // (suggest mode → ledger suggestion) exactly like a keystroke would. Used by
  // the editable CSV table; `line` is 1-based.
  const applyCsvRowOp = useCallback(
    (op: { type: 'replace' | 'insertAfter' | 'delete'; line: number; text?: string }) => {
      const editor = monacoEditorRef.current;
      const monaco = monacoNsRef.current;
      const model = modelRef.current;
      if (!editor || !monaco || !model) return;
      const lineCount = model.getLineCount();
      if (op.type === 'replace') {
        const ln = Math.max(1, Math.min(op.line, lineCount));
        const range = new monaco.Range(ln, 1, ln, model.getLineMaxColumn(ln));
        editor.executeEdits('csv-row-edit', [{ range, text: op.text ?? '', forceMoveMarkers: true }]);
      } else if (op.type === 'insertAfter') {
        const ln = Math.max(0, Math.min(op.line, lineCount));
        if (ln === 0) {
          editor.executeEdits('csv-row-insert', [
            { range: new monaco.Range(1, 1, 1, 1), text: `${op.text ?? ''}\n`, forceMoveMarkers: true },
          ]);
        } else {
          const col = model.getLineMaxColumn(ln);
          editor.executeEdits('csv-row-insert', [
            { range: new monaco.Range(ln, col, ln, col), text: `\n${op.text ?? ''}`, forceMoveMarkers: true },
          ]);
        }
      } else {
        const ln = Math.max(1, Math.min(op.line, lineCount));
        const range =
          lineCount === 1
            ? new monaco.Range(1, 1, 1, model.getLineMaxColumn(1))
            : ln < lineCount
              ? new monaco.Range(ln, 1, ln + 1, 1)
              : new monaco.Range(ln - 1, model.getLineMaxColumn(ln - 1), ln, model.getLineMaxColumn(ln));
        editor.executeEdits('csv-row-delete', [{ range, text: '', forceMoveMarkers: true }]);
      }
      editor.pushUndoStop();
    },
    [],
  );
  const localYdoc = useMemo(() => {
    const doc = new Y.Doc({ guid: fileId });
    ensureCodeText(doc);
    return doc;
  }, [fileId]);
  useEffect(() => () => {
    if (revealFlashTimerRef.current) clearTimeout(revealFlashTimerRef.current);
  }, []);
  // True while the current selection is programmatic (a SyncTeX word-snap
  // jump) — the selection bubble stays hidden until the user selects.
  const bubbleSuppressRef = useRef(false);
  const editorHandle = useMemo<CodeEditorHandle>(
    () => ({
      getText: () => modelRef.current?.getValue() ?? currentTextRef.current,
      getCursorLine: () => monacoEditorRef.current?.getPosition()?.lineNumber ?? null,
      scrollToLineTop: (line: number) => {
        const editor = monacoEditorRef.current;
        const model = modelRef.current;
        if (!editor || !model) return;
        const lineNumber = Math.max(1, Math.min(line, model.getLineCount()));
        scrollFollowSuppressUntilRef.current = Date.now() + 400;
        editor.setScrollTop(Math.max(0, editor.getTopForLineNumber(lineNumber) - 12));
      },
      buildCommentSelectionFromOffsets: (from: number, to: number) => {
        const ydoc = ydocRef.current;
        const model = modelRef.current;
        if (!ydoc || !model) return null;
        const text = model.getValue();
        const lo = Math.max(0, Math.min(from, to));
        const hi = Math.min(text.length, Math.max(from, to));
        if (lo >= hi) return null;
        return buildCodeCommentSelection(ydoc, lo, hi, text.slice(lo, hi));
      },
      revealLine: (line: number, word?: string) => {
        const editor = monacoEditorRef.current;
        const monaco = monacoNsRef.current;
        const model = modelRef.current;
        if (!editor || !monaco || !model) return;
        let lineNumber = Math.max(1, Math.min(line, model.getLineCount()));
        // Snap to the double-clicked word when the caller has one: SyncTeX
        // lines are approximate, the clicked word is exact — and selecting it
        // makes the editor highlight match what was clicked in the PDF.
        const wordHit = word
          ? findWordNearLine(
              (ln) => (ln >= 1 && ln <= model.getLineCount() ? model.getLineContent(ln) : null),
              lineNumber,
              word,
            )
          : null;
        if (wordHit) {
          lineNumber = wordHit.line;
          // A programmatic selection must not pop the action bubble over the
          // just-revealed code; the next real mouse/keyboard selection re-arms it.
          bubbleSuppressRef.current = true;
          editor.setSelection(
            new monaco.Range(lineNumber, wordHit.column, lineNumber, wordHit.column + wordHit.length),
          );
        } else {
          editor.setPosition({ lineNumber, column: 1 });
        }
        editor.revealLineInCenter(lineNumber);
        editor.focus();
        // Flash the line so a SyncTeX inverse / search jump is visible even when
        // the target is already on screen (short docs don't scroll).
        // Replace (not add): a second jump within the 1.5s window resets the
        // shared timer, so an added decoration would never be removed — and
        // under reduced motion the flash is a static highlight that would then
        // stay lit forever.
        revealFlashIdsRef.current = editor.deltaDecorations(revealFlashIdsRef.current, [
          { range: new monaco.Range(lineNumber, 1, lineNumber, 1), options: { isWholeLine: true, className: 'stx-line-flash' } },
        ]);
        if (revealFlashTimerRef.current) clearTimeout(revealFlashTimerRef.current);
        revealFlashTimerRef.current = setTimeout(() => {
          monacoEditorRef.current?.deltaDecorations(revealFlashIdsRef.current, []);
          revealFlashIdsRef.current = [];
        }, 1500);
      },
      insertLatexSnippet: (snippet: LatexSnippet) => {
        const editor = monacoEditorRef.current;
        const monaco = monacoNsRef.current;
        const model = modelRef.current;
        if (!editor || !monaco || !model) return;
        const selection = editor.getSelection();
        if (!selection) return;
        const selectedText = model.getValueInRange(selection);
        const { text, selectionStart, selectionEnd } = formatLatexSnippet(selectedText, snippet);
        editor.executeEdits('latex-snippet', [{ range: selection, text, forceMoveMarkers: true }]);
        const startPos = selection.getStartPosition();
        editor.setSelection(
          monaco.Range.fromPositions(
            snippetOffsetToPosition(monaco, startPos, text, selectionStart),
            snippetOffsetToPosition(monaco, startPos, text, selectionEnd),
          ),
        );
        editor.focus();
      },
      insertText: (text: string) => {
        const editor = monacoEditorRef.current;
        const monaco = monacoNsRef.current;
        const model = modelRef.current;
        if (!editor || !monaco || !model) return;
        const selection = editor.getSelection();
        if (!selection) return;
        editor.executeEdits('latex-insert-text', [
          { range: selection, text, forceMoveMarkers: true },
        ]);
        const endPos = snippetOffsetToPosition(monaco, selection.getStartPosition(), text, text.length);
        editor.setSelection(monaco.Range.fromPositions(endPos, endPos));
        editor.focus();
      },
      undo: () => {
        const editor = monacoEditorRef.current;
        if (!editor) return;
        editor.focus();
        // Prefer the suggestion-aware Y.UndoManager; fall back to Monaco's native
        // stack only when the ledger (and so the manager) is disabled.
        if (undoManagerRef.current) undoManagerRef.current.undo();
        else editor.trigger('toolbar', 'undo', null);
      },
      redo: () => {
        const editor = monacoEditorRef.current;
        if (!editor) return;
        editor.focus();
        if (undoManagerRef.current) undoManagerRef.current.redo();
        else editor.trigger('toolbar', 'redo', null);
      },
      applyCsvRowOp,
      resolveSuggestion: resolveByKey,
    }),
    [applyCsvRowOp, resolveByKey]
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      setEditorHeight(Math.max(300, window.innerHeight - rect.top - 16));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Keep the Monaco surface mounted across host/socket churn so an async
  // collabUrl transition only rebuilds the provider/binding.
  useEffect(() => {
    setConnectionStatus(collabUrl ? 'connecting' : 'local');
    setInitialSyncReady(!collabUrl);
    setSyncVerified(!collabUrl);
    setBindingReady(false);
    setProvider(null);
    if (!sharedSocket) {
      setYdoc(localYdoc);
    }
    bindingRef.current?.destroy();
    bindingRef.current = null;
    providerRef.current?.destroy();
    providerRef.current = null;
  }, [collabUrl, localYdoc, sharedSocket]);

  useEffect(() => {
    setConnectionStatus(collabUrl ? 'connecting' : 'local');
    setInitialSyncReady(!collabUrl);
    setSyncVerified(!collabUrl);
    setBindingReady(false);
    setProvider(null);
    if (!sharedSocket) {
      setYdoc(localYdoc);
    }
    setEditorMounted(false);
    currentTextRef.current = '';
    contentSubscriptionRef.current?.dispose();
    contentSubscriptionRef.current = null;
    if (contentNotifyTimerRef.current) clearTimeout(contentNotifyTimerRef.current);
    contentNotifyTimerRef.current = null;
    bindingRef.current?.destroy();
    bindingRef.current = null;
    monacoEditorRef.current = null;
    modelRef.current = null;
    providerRef.current?.destroy();
    providerRef.current = null;
  }, [fileId, localYdoc, sharedSocket]);

  useEffect(() => {
    if (!sharedSocket || !docName) {
      return;
    }

    // Token getter, not a frozen string: re-evaluated on every attach and
    // socket reconnect, so a provider created after long idle (token TTL
    // elapsed) still authenticates instead of loading forever.
    const entry = acquireProvider(sharedSocket.socket, docName, fileId, sharedSocket.getToken);
    ensureCodeText(entry.ydoc);
    entry.provider.awareness?.setLocalStateField('user', user);
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
  }, [sharedSocket, docName, fileId, user]);

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

  // The code/LaTeX undo authority — a Y.UndoManager over the code Y.Text + both
  // suggestion-ledger maps, so one Cmd+Z reverts text and ledger together (the
  // markdown editor's Collaboration UndoManager is the same model). Scoped to the
  // Y.Doc, NOT the binding: it must OUTLIVE binding rebinds (Edit↔Suggest toggle,
  // provider reconnect) so Cmd+Z still undoes edits/resolutions made just before
  // the transition. The binding effect below registers each live binding as a
  // tracked origin. Null when the ledger is off (kill-switch) or read-only →
  // native undo. Remote edits carry the provider's origin and stay untracked, so
  // Cmd+Z only ever reverts the local user's own changes (Google-Docs semantics).
  useEffect(() => {
    if (!ydoc || effectiveReadOnly) {
      undoManagerRef.current?.destroy();
      undoManagerRef.current = null;
      return;
    }
    const um = new Y.UndoManager(
      [ensureCodeText(ydoc), ydoc.getMap(CODE_SUGGESTIONS_ROOT), ydoc.getMap(CODE_RESOLVED_ROOT)],
      { trackedOrigins: new Set<unknown>([CODE_SUGGEST_UNDO_ORIGIN]) },
    );
    undoManagerRef.current = um;
    return () => {
      um.destroy();
      if (undoManagerRef.current === um) undoManagerRef.current = null;
    };
  }, [ydoc, effectiveReadOnly]);

  // Local-authorship signal: `txn.local` is true only for THIS tab's own
  // transactions (typing, undo), never for remote/agent updates applied by
  // the provider. Ref-based side effect, O(1) per transaction.
  useEffect(() => {
    if (!ydoc || !onLocalEdit) return;
    const ytext = ensureCodeText(ydoc);
    const handler = (_event: Y.YTextEvent, txn: Y.Transaction) => {
      if (txn.local) onLocalEdit();
    };
    ytext.observe(handler);
    return () => ytext.unobserve(handler);
  }, [ydoc, onLocalEdit]);

  useEffect(() => {
    const model = modelRef.current;
    const editor = monacoEditorRef.current;
    if (!editorMounted || !model || !editor || !ydoc) return;

    let cancelled = false;
    let binding: MonacoBindingInstance | null = null;
    let stagingSub: { dispose: () => void } | null = null;
    setBindingReady(false);

    void import('y-monaco').then(({ MonacoBinding }) => {
      // The editor (and its model) can be disposed while this dynamic import is
      // in flight — e.g. `initialSyncReady` flips false and @monaco-editor/react
      // unmounts the editor without this effect's deps changing, so `cancelled`
      // stays false. Binding a disposed model throws "Model is disposed!"
      // (uncaught in promise), so bail on a disposed model too.
      if (cancelled || model.isDisposed()) return;
      const ytext = ensureCodeText(ydoc);
      binding = new MonacoBinding(
        ytext,
        model,
        new Set([editor]),
        provider?.awareness ?? undefined
      );
      bindingRef.current?.destroy();
      bindingRef.current = binding;
      currentTextRef.current = model.getValue();
      onContentChange?.(currentTextRef.current);
      // Register THIS binding's origin on the doc-scoped manager above, so both
      // y-monaco's edit-mode mirror (it transacts under the binding) and the
      // suggest-mode staging below (tagged with the same binding) are undoable.
      // The manager outlives the binding, so an Edit↔Suggest toggle / reconnect
      // swaps the origin without dropping the stack.
      undoManagerRef.current?.addTrackedOrigin(binding);
      // In suggest mode, stage local edits into the code-suggestion ledger
      // synchronously (instant overlay) instead of letting y-monaco mirror them
      // as plain text — the code analog of the markdown marks model. The binding
      // origin tags each staged burst so it shares the undo stack above. Falls
      // back to the server-poll path if the staging install can't take (null).
      if (editMode === 'suggest' && !effectiveReadOnly) {
        stagingSub = installCodeSuggestStaging(binding, model, ydoc, () => stagingMetaRef.current, binding);
      }
      setBindingReady(true);
    });

    return () => {
      cancelled = true;
      stagingSub?.dispose();
      if (binding) undoManagerRef.current?.removeTrackedOrigin(binding);
      if (bindingRef.current === binding) {
        bindingRef.current = null;
        setBindingReady(false);
      }
      binding?.destroy();
    };
  }, [editorMounted, onContentChange, provider, ydoc, editMode, effectiveReadOnly]);

  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness || typeof document === 'undefined') return;

    const styleEl = document.createElement('style');
    document.head.appendChild(styleEl);

    const renderStyles = () => {
      styleEl.textContent = Array.from(awareness.getStates().entries())
        .map(([clientId, state]) => {
          const color =
            typeof state?.user?.color === 'string' && state.user.color.trim()
              ? state.user.color.trim()
              : '#f59e0b';
          return [
            `.yRemoteSelection-${clientId}{background:${color}22;}`,
            `.yRemoteSelectionHead-${clientId}{border-left:2px solid ${color};margin-left:-1px;}`,
          ].join('');
        })
        .join('\n');
    };

    renderStyles();
    awareness.on('update', renderStyles);
    return () => {
      awareness.off('update', renderStyles);
      styleEl.remove();
    };
  }, [provider]);

  // Report focus upward for presence: the file whose editor was last focused
  // is what this user is "in", regardless of which split pane holds it.
  const onFocusedRef = useRef(onFocused);
  onFocusedRef.current = onFocused;
  useEffect(() => {
    const editor = monacoEditorRef.current;
    if (!editorMounted || !editor) return;
    const sub = editor.onDidFocusEditorText(() => onFocusedRef.current?.());
    return () => sub.dispose();
  }, [editorMounted]);

  // Jump-to-peer (bubble click): find the peer's caret in this doc's awareness
  // (y-monaco publishes it as `selection`, relative positions on the ytext)
  // and center it. Awareness/binding may still be syncing right after the file
  // opens — retry across frames (~10s), then give up silently.
  const revealPeerSeqRef = useRef(0);
  const onRevealPeerDoneRef = useRef(onRevealPeerDone);
  onRevealPeerDoneRef.current = onRevealPeerDone;
  useEffect(() => {
    const req = revealPeer;
    if (!req || req.seq === revealPeerSeqRef.current) return;
    const awareness = provider?.awareness;
    if (!awareness || !ydoc) return;
    revealPeerSeqRef.current = req.seq;
    let attempts = 0;
    return retryUntilDone(
      () => {
        // Give-up must run BEFORE retryUntilDone's own frame cap (700 below)
        // exhausts, or the request would survive unreported and replay later.
        if (++attempts >= 600) {
          onRevealPeerDoneRef.current?.(req.seq);
          return true;
        }
        const editor = monacoEditorRef.current;
        const model = modelRef.current;
        if (!editor || !model || model.isDisposed()) return false;
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
          const selection = (state as { selection?: { anchor?: unknown; head?: unknown } | null })
            .selection;
          const rel = selection?.head ?? selection?.anchor;
          if (!rel) continue; // no caret published — keep retrying until timeout
          let index: number | null = null;
          try {
            const abs = Y.createAbsolutePositionFromRelativePosition(
              Y.createRelativePositionFromJSON(rel),
              ydoc,
            );
            index = abs ? abs.index : null;
          } catch {
            index = null;
          }
          if (index === null) return false; // ytext still syncing
          const position = model.getPositionAt(Math.min(index, model.getValueLength()));
          editor.revealPositionInCenter(position, 0 /* ScrollType.Smooth */);
          onRevealPeerDoneRef.current?.(req.seq);
          return true;
        }
        return false; // peer not in this room's awareness yet — retry
      },
      requestAnimationFrame,
      cancelAnimationFrame,
      700,
    );
  }, [revealPeer, provider, ydoc]);

  useEffect(() => {
    if (!collabUrl) {
      setConnectionStatus('local');
      return;
    }
    if (!provider) {
      setConnectionStatus('connecting');
      return;
    }

    const handleStatus = (event: { status: string }) => {
      setConnectionStatus(
        event.status === 'connected'
          ? 'connected'
          : event.status === 'disconnected'
            ? 'disconnected'
            : 'connecting'
      );
    };

    provider.on('status', handleStatus);
    const seed =
      (provider.configuration.websocketProvider as { status?: string } | undefined)?.status;
    if (seed) handleStatus({ status: seed });
    return () => {
      provider.off('status', handleStatus);
    };
  }, [collabUrl, provider]);

  useEffect(() => {
    onConnectionStatusChange?.(connectionStatus);
  }, [connectionStatus, onConnectionStatusChange]);

  useEffect(() => {
    const timing = openTimingRef.current;
    if (!timing || hidden || !bindingReady || !editorMounted || !ydoc || timing.fileId !== fileId || timing.visible) return;
    return afterNextPaint(() => {
      if (openTimingRef.current !== timing || hidden) return;
      const measurement = finishFileVisible(timing);
      if (!measurement) return;
      track('file_open_performance', {
        projectId: workspaceId,
        fileId,
        path: filePath,
        editor: 'code',
        phase: 'visible',
        bootstrap: openedFromBootstrap,
        elapsedMs: measurement.elapsedMs,
        openKind: measurement.openKind,
        ...(measurement.navigationElapsedMs !== undefined
          ? { navigationToVisibleMs: measurement.navigationElapsedMs }
          : {}),
      });
    });
  }, [bindingReady, editorMounted, fileId, filePath, hidden, openedFromBootstrap, workspaceId, ydoc]);

  useEffect(() => {
    const timing = openTimingRef.current;
    if (!timing || !syncVerified || !provider || timing.fileId !== fileId || timing.synced) return;
    const measurement = finishFileSync(timing);
    if (!measurement) return;
    track('file_open_performance', {
      projectId: workspaceId,
      fileId,
      path: filePath,
      editor: 'code',
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
    if (!editorMounted || !modelRef.current || !ydoc) return;
    onReady?.({ editor: editorHandle, ydoc });
  }, [editorHandle, editorMounted, onReady, ydoc]);

  useEffect(() => {
    // Local (sidecar) projects: edit telemetry would upload local file paths —
    // nothing may leave the machine for an unshared local project.
    if (!ydoc || sharedSocket?.isLocal) return;
    return trackYDocUserEdits(ydoc, {
      workspaceId,
      fileId,
      filePath,
      mode: 'code',
      readOnly: effectiveReadOnly,
      provider,
    });
  }, [ydoc, provider, workspaceId, fileId, filePath, effectiveReadOnly, sharedSocket?.isLocal]);


  // Apply / refresh inline diff decorations + overlays when pendingAdditions
  // change or the buffer changes.
  //
  //   Green addition lines  → whole-line decorations.
  //   Red deletion ghost    → view zone (full-width row, non-interactive). Font
  //                           is pinned via inline style to Monaco's fontInfo
  //                           so it matches the surrounding code exactly.
  //   Keep / Undo buttons   → content widget. View zones can't be made
  //                           reliably interactive (Monaco wraps them in a
  //                           pointer-events: none container), so we use a
  //                           content widget — which IS interactive — and
  //                           reserve a 1-line view zone immediately below the
  //                           chunk so the widget has empty space to live in
  //                           without overlapping any code line.
  useEffect(() => {
    const editor = monacoEditorRef.current;
    const model = modelRef.current;
    if (!editor || !model) return;

    // Read the active Monaco font so deletion ghosts render in the same face,
    // size, and line height as the surrounding code. EditorOption.fontInfo
    // has the runtime numeric id; we look it up dynamically to avoid pinning
    // a magic number across Monaco upgrades.
    const monacoNs =
      (globalThis as unknown as { monaco?: { editor?: { EditorOption?: Record<string, number> } } })
        .monaco;
    const fontInfoId =
      monacoNs?.editor?.EditorOption && 'fontInfo' in monacoNs.editor.EditorOption
        ? monacoNs.editor.EditorOption.fontInfo
        : null;
    const fontInfo =
      fontInfoId != null
        ? (editor.getOption(fontInfoId as unknown as number) as
            | {
                fontFamily?: string;
                fontSize?: number;
                lineHeight?: number;
              }
            | undefined)
        : undefined;
    const fontFamily =
      fontInfo?.fontFamily ||
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    const fontSizePx = fontInfo?.fontSize ?? 13;
    const lineHeightPx = fontInfo?.lineHeight ?? 20;
    const fontInfoExt = fontInfo as
      | { typicalHalfwidthCharacterWidth?: number }
      | undefined;
    const charWidthPx = fontInfoExt?.typicalHalfwidthCharacterWidth ?? fontSizePx * 0.6;

    // Two distinct X values we need:
    //   gutterEndPx : where the gutter ends and the green whole-line decoration
    //                 starts. Use this for the red deletion box's `margin-left`
    //                 so its left edge sits exactly under the green box's.
    //   glyphLeftPx : where Monaco actually paints column-1 glyphs. We measure
    //                 it directly off a real `.view-line` element because
    //                 Monaco's coordinate APIs (`getLayoutInfo().contentLeft`,
    //                 `getScrolledVisiblePosition({col: 1}).left`) both return
    //                 the gutter-end X — not the actual glyph X, which is a
    //                 few pixels further right due to internal styling.
    const readContentMetrics = () => {
      const layout = editor.getLayoutInfo();
      const contentWidth = layout?.contentWidth ?? layout?.width ?? 800;
      const gutterEndPx = layout?.contentLeft ?? 64;
      let glyphLeftPx = gutterEndPx;
      const editorDomNode = editor.getDomNode();
      if (editorDomNode) {
        const viewLine = editorDomNode.querySelector<HTMLElement>('.view-line');
        if (viewLine) {
          // Find the first non-whitespace text node so we measure the actual
          // glyph X (not whitespace that may sit at the line start).
          const walker = document.createTreeWalker(viewLine, NodeFilter.SHOW_TEXT);
          let textNode: Node | null = walker.nextNode();
          while (textNode && (!textNode.textContent || textNode.textContent.length === 0)) {
            textNode = walker.nextNode();
          }
          if (textNode && textNode.textContent) {
            const range = document.createRange();
            range.setStart(textNode, 0);
            range.setEnd(textNode, 1);
            const charRect = range.getBoundingClientRect();
            const editorRect = editorDomNode.getBoundingClientRect();
            if (charRect.width > 0 && editorRect.width > 0) {
              glyphLeftPx =
                charRect.left - editorRect.left + (editor.getScrollLeft() ?? 0);
            }
            range.detach?.();
          }
        }
      }
      return { gutterEndPx, glyphLeftPx, contentWidth };
    };

    const visualLineCountFor = (line: string, contentWidth: number) => {
      // Empty lines still take one row.
      if (line.length === 0) return 1;
      // Word-wrap is on in the code editor; approximate the wrapped row count
      // using the typical half-width character width from Monaco's fontInfo.
      const usable = Math.max(1, contentWidth - 8 /* right padding */);
      return Math.max(1, Math.ceil((line.length * charWidthPx) / usable));
    };

    // Tear-down used only by the cleanup path (unmount / deps change). The
    // apply() function does its own atomic remove+add inside a single
    // changeViewZones batch so the buffer never paints with a half-applied
    // set of zones (which is what caused the resize flicker).
    const teardownAll = () => {
      const zones = viewZonesRef.current;
      if (zones.size > 0) {
        // editor may already be disposed (cleanup fires after onDidDispose).
        try {
          editor.changeViewZones((accessor) => {
            for (const entry of zones.values()) {
              try { accessor.removeZone(entry.id); } catch { /* noop */ }
            }
          });
        } catch { /* editor disposed mid-teardown */ }
      }
      zones.clear();
      for (const entry of actionsOverlaysRef.current.values()) {
        try { editor.removeOverlayWidget(entry.widget); } catch { /* noop */ }
      }
      actionsOverlaysRef.current.clear();
    };

    const repositionActionOverlays = () => {
      if (actionsOverlaysRef.current.size === 0) return;
      const layout = editor.getLayoutInfo();
      const contentLeft = layout?.contentLeft ?? 64;
      const contentWidth = layout?.contentWidth ?? layout?.width ?? 800;
      // Read phase, then write phase: interleaving offsetWidth reads with
      // style writes forces a reflow per pill on every scroll tick.
      const placements: Array<{ dom: HTMLElement; top: number; left: number }> = [];
      for (const entry of actionsOverlaysRef.current.values()) {
        const pos = editor.getScrolledVisiblePosition({
          lineNumber: entry.placeAtLineTop,
          column: 1,
        });
        if (!pos) continue;
        // Place the pill so its TOP sits exactly one line height above the
        // anchor line's top — i.e. inside the 1-row spacer view zone we
        // reserved between the chunk and the next buffer line.
        placements.push({
          dom: entry.dom,
          top: pos.top - lineHeightPx,
          left: Math.max(contentLeft, contentLeft + contentWidth - entry.dom.offsetWidth - 8),
        });
      }
      for (const p of placements) {
        p.dom.style.top = `${p.top}px`;
        p.dom.style.left = `${p.left}px`;
      }
    };

    const apply = () => {
      // Re-entry guard: addContentWidget / changeViewZones both fire
      // onDidLayoutChange synchronously, which would otherwise re-enter apply()
      // and cause feedback loops.
      if (isApplyingOverlaysRef.current) return;
      isApplyingOverlaysRef.current = true;
      try {
        applyInner();
      } finally {
        isApplyingOverlaysRef.current = false;
      }
    };

    const applyInner = () => {
      // A layout/scroll rAF can fire after the model was disposed but before
      // this effect's cleanup cancels it — every model read below would throw.
      if (model.isDisposed()) return;
      // The LIVE CRDT code-suggestion ledger is the source of truth for code/LaTeX
      // suggestions (instant, position-exact): every code suggestion stages in it,
      // and resolving an entry clears the overlay immediately. We still MERGE the
      // server-derived `pendingAdditions` prop below for turns the ledger never
      // staged — legacy/pre-ledger rows and cross-instance turns the poll hasn't
      // staged yet (matched by `matchPendingHunks`). A turn the ledger DID stage is
      // dropped from the prop so a just-resolved suggestion can't be re-shown as
      // pending from the (not-yet-updated) prop — a real editor↔prop divergence.
      // One full-text snapshot per pass — getValue() rebuilds the whole
      // document string, which is real cost on large files.
      const bufferText = model.getValue();
      const ledger = ydoc
        ? codeSuggestionRender(ydoc, bufferText, { canMutate: !effectiveReadOnly })
        : { matches: [], chunks: [] };
      // The main editor shows every live ledger suggestion in the file; a
      // read-only REVIEW mount (diff-review-flow) passes `pendingAdditions` scoped
      // to the turn being reviewed, so scope the ledger to those turn ids too —
      // otherwise the review would render unrelated turns' suggestions. (Codex P2)
      let ledgerChunks = ledger.chunks;
      let ledgerMatches = ledger.matches;
      // A read-only review mount scopes the live ledger to the reviewed turn.
      // Scope by BOTH the agent turn id (assistantMessageId) AND the review id
      // (groupKey): a human/local-agent code suggestion's ledger chunk carries no
      // assistantMessageId (no agentTurnId) — only its `human-<rowId>` groupKey —
      // so an assistantMessageId-only scope dropped every human chunk and, with
      // the prop copy also dropped below, rendered no diff at all. (Codex P2)
      const scope = new Set(
        (pendingAdditionsRef.current ?? [])
          .flatMap((a) => [a.assistantMessageId, a.groupKey])
          .filter(Boolean),
      );
      if (readOnly) {
        ledgerChunks = ledger.chunks.filter(
          (c) => (c.assistantMessageId && scope.has(c.assistantMessageId)) || (c.groupKey && scope.has(c.groupKey)),
        );
        const keep = new Set(ledgerChunks.map((c) => c.key));
        ledgerMatches = ledger.matches.filter((m) => keep.has(m.key));
      }
      const ledgerKeys = new Set(ledgerChunks.map((c) => c.key));
      ledgerKeysRef.current = ledgerKeys;
      ledgerGroupKeysRef.current = new Set(
        ledgerChunks.map((c) => c.groupKey).filter((g): g is string => Boolean(g)),
      );
      // MERGE the live ledger with the prop path: the ledger is authoritative for
      // any turn it staged (its tombstones make a just-resolved suggestion vanish,
      // where a stale prop would re-show it), while the prop still surfaces turns
      // the ledger never staged (legacy, and backends without ledger code). Track
      // ledger-backed turns across applies so a turn that resolved to an empty
      // ledger isn't re-shown from the prop.
      for (const c of ledgerChunks) if (c.assistantMessageId) ledgerBackedTurnsRef.current.add(c.assistantMessageId);
      const additions: CodePendingAddition[] = [
        ...ledgerChunks,
        ...ledgerUnbackedAdditions(pendingAdditionsRef.current ?? [], ledgerBackedTurnsRef.current),
      ];
      // Freeze-detector context: cheap metrics so a stall report can tell whether
      // this surface's cost is doc-size- or pending-suggestion-driven. Report the
      // FULL editor field set (nulling what this surface doesn't track) so a
      // switch to/from the markdown editor overwrites its stale fields.
      setFreezeContext({
        fileType: fileTypeFromPath(filePath),
        docChars: null,
        docLines: model.getLineCount(),
        pendingSuggestions: additions.length,
      });
      const nextLineJumps = new Map<number, { id: string; chatId: string | null }>();

      // Mirror the effective suggestion set to any alternate surface (CSV table).
      // Signature-gated so an unchanged set doesn't churn the consumer.
      const emit = onActiveSuggestionsChangeRef.current;
      if (emit) {
        // Fingerprint key + mutability + content so the consumer re-renders
        // when a session flips writable↔read-only OR a suggestion is rewritten
        // under the same ledger key (edited before accepting) — both keep the
        // same key but must refresh the CSV table's diff and controls.
        const sig = additions
          .map((a) => `${a.key}:${a.canMutate ? 1 : 0}:${a.newStart ?? ''}:${a.text}${a.deletedText ?? ''}`)
          .join('|');
        if (sig !== lastEmittedSuggestionSigRef.current) {
          lastEmittedSuggestionSigRef.current = sig;
          emit(additions);
        }
      }

      // Before the empty early-return: resolving the LAST suggestion must
      // drop the count to 0 or the Accept all / Reject all bar outlives the
      // suggestions it reviews.
      setPendingReviewCount(additions.length);
      if (additions.length === 0) {
        chunkByKeyRef.current = new Map();
        teardownAll();
        decorationCollectionRef.current?.clear();
        decorationCollectionRef.current = null;
        lineJumpsRef.current = nextLineJumps;
        return;
      }

      // Surface AI attribution (Sunny #N) always, plus multi-author files and
      // human suggestions that have no chat turn to jump to.
      const distinctAuthors = new Set<string>();
      let hasSunnyAuthor = false;
      let hasUnlinkedAuthor = false;
      for (const a of additions) {
        if (a.authorLabel) distinctAuthors.add(a.authorLabel);
        // Matches the current "Agent #N" / "Sundial Agent" labels plus legacy
        // "Sunny"/"Sunny #N" rows.
        if (
          a.authorLabel === 'Sunny' ||
          a.authorLabel === 'Sundial Agent' ||
          a.authorLabel?.startsWith('Sunny #') ||
          a.authorLabel?.startsWith('Agent #')
        ) hasSunnyAuthor = true;
        if (a.authorLabel && !a.assistantMessageId) hasUnlinkedAuthor = true;
      }
      const showAuthorChip = hasSunnyAuthor || hasUnlinkedAuthor || distinctAuthors.size >= 2;

      // Build hunk inputs. Skip additions that lack the structured `lines`
      // payload — those legacy callers fall through to the trimmed-line
      // fallback below.
      const bufferLines = bufferText.split('\n');
      const hunkInputs: PendingHunkInput[] = [];
      const chunkByKey = new Map<string, CodePendingAddition>();
      chunkByKeyRef.current = chunkByKey;
      const legacyOnly: CodePendingAddition[] = [];
      for (const a of additions) {
        chunkByKey.set(a.key, a);
        if (ledgerKeys.has(a.key)) continue; // ledger entries carry exact matches
        if (Array.isArray(a.lines) && a.lines.length > 0) {
          hunkInputs.push({ key: a.key, lines: a.lines, newStart: a.newStart });
        } else {
          legacyOnly.push(a);
        }
      }
      // Ledger entries resolve to exact line ranges; prop entries still need the
      // text-matching re-location. Both feed the same decoration loop.
      const matches = [...ledgerMatches, ...matchPendingHunks(bufferLines, hunkInputs)];

      const decorations: MonacoEditorType.IModelDeltaDecoration[] = [];
      type DeletionZone = { afterLine: number; lines: string[]; htmlLines: string[]; chunkKey: string };
      type ActionsAnchor = {
        afterLine: number;
        startLine: number;
        chunkKey: string;
        grouped: boolean;
        authorLabel: string | null;
        authorVisual: CodePendingAddition['authorVisual'] | null;
        assistantMessageId: string | null;
        chatId: string | null;
      };
      const deletionZones: DeletionZone[] = [];
      const actionsAnchors: ActionsAnchor[] = [];
      // Human suggestion runs collapse to ONE Accept/Reject overlay (keyed by
      // the run id); agent turns keep their per-chunk overlays unchanged.
      const groupKeyOf = (chunk: CodePendingAddition): string | null =>
        chunk.groupKey && isHumanReviewId(chunk.groupKey) ? chunk.groupKey : null;
      const actionsRenderedForGroup = new Set<string>();

      // Markdown buffers strip markdown so a raw line matches the rendered
      // ProseMirror text; `.tex`/code buffers compare raw so backslash macros,
      // `%` comments, and `*`-form environments keep their inline-diff anchors.
      const stripMarkdown = isMarkdownFile(filePath);
      const normalizeLine = (line: string) =>
        normalizeForDiff(line, { markdown: stripMarkdown });

      for (const m of matches) {
        const chunk = chunkByKey.get(m.key);
        if (!chunk) continue;
        const lineCount = model.getLineCount();
        const highlights =
          Array.isArray(chunk.lines) && chunk.lines.length > 0
            ? buildLineChangeHighlights(chunk.lines)
            : [];
        let highlightIdx = 0;
        // Light whole-line band + stronger inline highlight on changed words.
        for (let ln = m.addStartLine; ln <= m.addEndLine && ln <= lineCount; ln += 1) {
          const lineText = model.getLineContent(ln);
          decorations.push({
            range: {
              startLineNumber: ln,
              startColumn: 1,
              endLineNumber: ln,
              endColumn: model.getLineMaxColumn(ln),
            },
            options: {
              isWholeLine: true,
              className: 'monaco-diff-pending-addition',
            },
          });
          const normLine = normalizeLine(lineText);
          let highlight: LineChangePair | null =
            highlights.find((h) => normalizeLine(h.newLine) === normLine) ??
            highlights[highlightIdx] ??
            null;
          if (highlight && normalizeLine(highlight.newLine) !== normLine) {
            highlight = null;
          }
          if (highlight) highlightIdx += 1;
          const ranges = highlight
            ? computeInlineAddedRangesForBlock(lineText, highlight.oldLine, {
                markdown: stripMarkdown,
              })
            : [];
          for (const range of ranges) {
            const startColumn = Math.min(lineText.length, range.start) + 1;
            const endColumn = Math.min(lineText.length, range.end) + 1;
            if (startColumn >= endColumn) continue;
            decorations.push({
              range: {
                startLineNumber: ln,
                startColumn,
                endLineNumber: ln,
                endColumn,
              },
              options: { inlineClassName: 'monaco-diff-inline-added' },
            });
          }
          if (chunk.assistantMessageId) {
            nextLineJumps.set(ln, {
              id: chunk.assistantMessageId,
              chatId: chunk.chatId ?? null,
            });
          }
        }
        if (m.deletedLines.length > 0) {
          // Red word-level highlights on removed lines, mirroring the green
          // additions: diff each deleted line against the addition it was
          // edited into so only the dropped words light up.
          const additionLines = Array.isArray(chunk.lines)
            ? chunk.lines.filter((l) => l.type === 'addition').map((l) => l.content)
            : [];
          const htmlLines = m.deletedLines.map((line, i) =>
            line === ''
              ? '&nbsp;'
              : wrapRangesHtml(
                  line,
                  computeInlineAddedRangesForBlock(
                    line,
                    pickPairedAdditionLine(line, additionLines, i),
                    { markdown: stripMarkdown },
                  ),
                  'monaco-diff-inline-removed',
                ),
          );
          deletionZones.push({
            afterLine: Math.max(0, m.addStartLine - 1),
            lines: m.deletedLines,
            htmlLines,
            chunkKey: m.key,
          });
        }
        if (chunk.canMutate) {
          const anchor = m.addEndLine >= m.addStartLine ? m.addEndLine : m.addStartLine - 1;
          const group = groupKeyOf(chunk);
          // One overlay per human run (at its first matched chunk); per-chunk
          // for agent turns. The `:*` key makes Keep/Undo act on the whole run.
          if (!group || !actionsRenderedForGroup.has(group)) {
            if (group) actionsRenderedForGroup.add(group);
            actionsAnchors.push({
              afterLine: Math.max(0, anchor),
              startLine: Math.max(1, m.addStartLine),
              chunkKey: group ? `${group}:*` : m.key,
              grouped: Boolean(group),
              authorLabel: showAuthorChip ? chunk.authorLabel ?? null : null,
              authorVisual: showAuthorChip ? chunk.authorVisual ?? null : null,
              assistantMessageId: chunk.assistantMessageId ?? null,
              chatId: chunk.chatId ?? null,
            });
          }
        }
      }

      // Legacy fallback: when a caller passes only `text` (no `lines`),
      // fall back to the previous trimmed-line equality matcher. This keeps
      // any non-workspace callers (tests, embedded usage) working.
      if (legacyOnly.length > 0) {
        const byText = new Map<string, CodePendingAddition>();
        for (const a of legacyOnly) {
          for (const line of a.text.split('\n')) {
            const t = line.trim();
            if (t && !byText.has(t)) byText.set(t, a);
          }
        }
        const lineCount = model.getLineCount();
        type Match = { line: number; chunk: CodePendingAddition };
        const lineMatches: Match[] = [];
        for (let line = 1; line <= lineCount; line += 1) {
          const text = model.getLineContent(line).trim();
          if (!text) continue;
          const chunk = byText.get(text);
          if (chunk) lineMatches.push({ line, chunk });
        }
        for (let i = 0; i < lineMatches.length; i += 1) {
          const m = lineMatches[i];
          const next = lineMatches[i + 1];
          const isLastInRun = !next || next.chunk.key !== m.chunk.key || next.line !== m.line + 1;
          decorations.push({
            range: { startLineNumber: m.line, startColumn: 1, endLineNumber: m.line, endColumn: model.getLineMaxColumn(m.line) },
            options: {
              isWholeLine: true,
              className: 'monaco-diff-pending-addition',
            },
          });
          if (m.chunk.assistantMessageId) {
            nextLineJumps.set(m.line, {
              id: m.chunk.assistantMessageId,
              chatId: m.chunk.chatId ?? null,
            });
          }
          if (isLastInRun && m.chunk.canMutate) {
            // Legacy text-match path is only hit by callers without hunk ops
            // (tests/embedded); human runs always carry `lines`, so they never
            // reach here — keep this per-chunk (ungrouped).
            actionsAnchors.push({
              afterLine: m.line,
              // Legacy path matches line by line, so the run's own start isn't
              // tracked — the hovered line IS the chunk.
              startLine: m.line,
              chunkKey: m.chunk.key,
              grouped: false,
              authorLabel: showAuthorChip ? m.chunk.authorLabel ?? null : null,
              authorVisual: showAuthorChip ? m.chunk.authorVisual ?? null : null,
              assistantMessageId: m.chunk.assistantMessageId ?? null,
              chatId: m.chunk.chatId ?? null,
            });
          }
        }
      }

      if (decorationCollectionRef.current) {
        decorationCollectionRef.current.set(decorations);
      } else {
        decorationCollectionRef.current = editor.createDecorationsCollection(decorations);
      }

      // Reconcile view zones by KEY+signature: only zones whose key disappeared
      // or whose signature changed are removed/added; unchanged ones are left
      // untouched. Resolving one suggestion therefore never re-creates the
      // others' deletion ghosts (the flicker bug). Still one changeViewZones
      // batch so the buffer never paints a half-applied set.
      const metrics = readContentMetrics();
      const textInsetPx = Math.max(0, metrics.glyphLeftPx - metrics.gutterEndPx);
      const usableWidth = Math.max(50, metrics.contentWidth - textInsetPx - 8);
      type DesiredZone = { key: string; signature: string; build: () => MonacoEditorType.IViewZone };
      const desiredZones: DesiredZone[] = [];
      for (const zone of deletionZones) {
        const visualRows = zone.lines.reduce(
          (sum, line) => sum + visualLineCountFor(line, usableWidth),
          0,
        );
        const heightInPx = Math.max(1, visualRows) * lineHeightPx;
        desiredZones.push({
          key: `del:${zone.chunkKey}`,
          signature: `${zone.afterLine}|${heightInPx}|${textInsetPx}|${fontFamily}|${fontSizePx}|${zone.htmlLines.join('')}`,
          build: () => {
            const dom = document.createElement('div');
            dom.className = 'monaco-diff-pending-deletion';
            dom.style.fontFamily = fontFamily;
            dom.style.fontSize = `${fontSizePx}px`;
            dom.style.lineHeight = `${lineHeightPx}px`;
            dom.style.marginLeft = '0';
            dom.style.paddingLeft = `${textInsetPx}px`;
            dom.innerHTML = zone.htmlLines
              .map((html) => `<div class="monaco-diff-pending-deletion-line">${html}</div>`)
              .join('');
            return { afterLineNumber: zone.afterLine, heightInPx, domNode: dom, suppressMouseDown: true };
          },
        });
      }
      for (const anchor of actionsAnchors) {
        desiredZones.push({
          key: `spacer:${anchor.chunkKey}`,
          signature: `${anchor.afterLine}|${anchor.assistantMessageId ?? ''}|${anchor.chatId ?? ''}`,
          build: () => {
            const spacer = document.createElement('div');
            spacer.className = 'monaco-diff-pending-actions-spacer';
            // Clicking the empty row beside the action pill also opens the chat
            // turn (the pill itself absorbs clicks on its own buttons).
            if (anchor.assistantMessageId) {
              spacer.style.cursor = 'pointer';
              const assistantMessageId = anchor.assistantMessageId;
              const chatId = anchor.chatId;
              spacer.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                onJumpToTurnRef.current?.(assistantMessageId, chatId);
              });
            }
            return { afterLineNumber: anchor.afterLine, heightInLines: 1, domNode: spacer, suppressMouseDown: true };
          },
        });
      }
      const zoneMap = viewZonesRef.current;
      const desiredZoneByKey = new Map(desiredZones.map((z) => [z.key, z]));
      editor.changeViewZones((accessor) => {
        for (const [key, entry] of zoneMap) {
          const desired = desiredZoneByKey.get(key);
          if (!desired || desired.signature !== entry.signature) {
            try { accessor.removeZone(entry.id); } catch { /* noop */ }
            zoneMap.delete(key);
          }
        }
        for (const z of desiredZones) {
          if (zoneMap.has(z.key)) continue; // unchanged — keep in place
          const zoneSpec = z.build();
          const id = accessor.addZone(zoneSpec);
          zoneMap.set(z.key, { id, signature: z.signature, dom: zoneSpec.domNode as HTMLElement });
        }
      });

      // Reconcile action pills (Monaco OVERLAY widgets — `.overlay-widgets` has
      // pointer-events: auto; positioned manually since getPosition() is null)
      // by KEY+signature, same as the view zones: a pill whose anchor/labels are
      // unchanged is left mounted, so resolving a sibling never re-creates it.
      // The click handler reads the live ledger/chunk lookups via refs, so a
      // REUSED pill still resolves against the current apply's state.
      const totalLineCount = model.getLineCount();
      const overlayMap = actionsOverlaysRef.current;
      const overlaySig = (a: ActionsAnchor) =>
        `${a.startLine}|${a.afterLine}|${a.authorLabel ?? ''}|${a.authorVisual?.imageUrl ?? a.authorVisual?.chipLabel ?? ''}|${a.grouped}|${a.assistantMessageId ?? ''}|${a.chatId ?? ''}|${a.chunkKey}|${canResolveSuggestionsRef.current}`;
      const desiredOverlayByKey = new Map(actionsAnchors.map((a) => [a.chunkKey, a]));
      for (const [key, entry] of overlayMap) {
        const anchor = desiredOverlayByKey.get(key);
        if (!anchor || overlaySig(anchor) !== entry.signature) {
          try { editor.removeOverlayWidget(entry.widget); } catch { /* noop */ }
          overlayMap.delete(key);
        }
      }
      for (const anchor of actionsAnchors) {
        // Commenters see suggestions (and who made them) but not Keep/Undo.
        if (!canResolveSuggestions && !anchor.authorLabel) continue;
        if (overlayMap.has(anchor.chunkKey)) continue; // unchanged — keep mounted
        const dom = document.createElement('div');
        dom.className = 'monaco-diff-pending-actions';
        dom.style.position = 'absolute';
        dom.style.zIndex = '5';
        // The author's avatar, not their spelled-out name: Sunny's face / the
        // agent's brand mark / an initials bubble — the same imagery as the
        // chat list, one glyph of width beside the ✓/✕, full label in the
        // tooltip. Same affordance as the markdown gutter's author icon.
        const visual = anchor.authorVisual;
        const keepTitle = anchor.grouped ? 'Accept all changes in this suggestion' : 'Accept suggestion';
        const undoTitle = anchor.grouped ? 'Reject all changes in this suggestion' : 'Reject suggestion';
        dom.innerHTML = `
          ${canResolveSuggestions ? `<button type="button" class="diff-pending-undo" data-key="${escapeHtml(anchor.chunkKey)}" aria-label="${undoTitle}" title="${undoTitle}">${DIFF_X_ICON_SVG}</button>
          <button type="button" class="diff-pending-keep" data-key="${escapeHtml(anchor.chunkKey)}" aria-label="${keepTitle}" title="${keepTitle}">${DIFF_CHECK_ICON_SVG}</button>` : ''}
        `;
        if (anchor.authorLabel) {
          // ONE author-chip implementation across surfaces (lib/workspace/
          // suggestion-marks): button-that-jumps when a chat turn exists,
          // static byline span otherwise. `diff-pending-author` keeps this
          // overlay's sizing CSS on top of the shared behavior.
          const mid = anchor.assistantMessageId;
          const anchorChatId = anchor.chatId;
          const chip = authorButton({
            label: anchor.authorLabel,
            color: visual?.imageUrl ? undefined : pickColor(anchor.authorLabel),
            imageUrl: visual?.imageUrl ?? null,
            imageRound: visual?.imageRound,
            chipLabel: visual?.chipLabel,
            chipColor: visual?.chipColor,
            ...(mid ? { onJump: () => onJumpToTurnRef.current?.(mid, anchorChatId) } : {}),
          });
          chip.classList.add('diff-pending-author');
          dom.prepend(chip);
        }
        const assistantMessageId = anchor.assistantMessageId;
        const chatId = anchor.chatId;
        const onPointerEvent = (event: MouseEvent) => {
          const target = event.target as HTMLElement;
          // The shared author chip handles its own mousedown jump; swallow the
          // paired click here so the pill's empty-space jump doesn't fire twice.
          if (target.closest('.diff-pending-author')) return;
          const keep = target.closest('.diff-pending-keep') as HTMLElement | null;
          const undo = target.closest('.diff-pending-undo') as HTMLElement | null;
          if (!keep && !undo) {
            // Clicked the pill's empty space — jump to the chat turn.
            if (event.type === 'click' && assistantMessageId) {
              event.preventDefault();
              event.stopPropagation();
              onJumpToTurnRef.current?.(assistantMessageId, chatId);
            }
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const key = (keep ?? undo)!.dataset.key;
          if (!key) return;
          // Ledger-sourced suggestions resolve directly in the CRDT (instant);
          // prop-sourced ones fall back to the server route. Shared with the CSV
          // table's buttons via `resolveByKey`, including the Cmd+Z isolation.
          resolveByKey(key, !!keep);
        };
        dom.addEventListener('mousedown', onPointerEvent);
        dom.addEventListener('click', onPointerEvent);

        const widget: MonacoEditorType.IOverlayWidget = {
          getId: () => `diff-actions-${anchor.chunkKey}`,
          getDomNode: () => dom,
          // Returning `null` tells Monaco to mount the widget but NOT to
          // position it — we set top/left manually so the pill lands inside
          // the spacer view zone regardless of word-wrap.
          getPosition: () => null,
        };
        editor.addOverlayWidget(widget);

        // The pill is anchored to the line BELOW the chunk; that's where the
        // spacer view zone sits. For chunks at the very end of the file
        // (no next line), anchor at the last line — overlay will appear at
        // its bottom (top - lineHeight becomes the bottom of the spacer).
        const placeAtLineTop =
          anchor.afterLine + 1 <= totalLineCount
            ? anchor.afterLine + 1
            : Math.max(1, anchor.afterLine);
        // Clamp the hover range into the buffer. A pure-deletion chunk has an
        // EMPTY add range (addEndLine < addStartLine), and a deletion at EOF
        // starts past the last line — an unclamped range matches no hovered
        // line, so the pill could never reveal and Keep/Undo became
        // unreachable (Codex, PR #1104 round 8). Include the pill's own row so
        // the deletion ghost + spacer count as part of the chunk.
        const clamp = (line: number) => Math.min(Math.max(line, 1), totalLineCount);
        const hoverFrom = clamp(Math.min(anchor.startLine, placeAtLineTop));
        const hoverTo = clamp(Math.max(anchor.startLine, anchor.afterLine, placeAtLineTop));
        overlayMap.set(anchor.chunkKey, {
          widget,
          dom,
          placeAtLineTop,
          fromLine: Math.min(hoverFrom, hoverTo),
          toLine: Math.max(hoverFrom, hoverTo),
          signature: overlaySig(anchor),
        });
      }
      // Position all overlays (newly-added and reused).
      repositionActionOverlays();
      lineJumpsRef.current = nextLineJumps;
    };

    applyOverlaysRef.current = apply;
    apply();
    const subContent = editor.onDidChangeModelContent(() => {
      // Re-apply on every content change so decorations stay aligned.
      apply();
    });
    // The code-suggestion ledger lives in a sibling Y.Map. Text edits already
    // re-apply via onDidChangeModelContent; this catches map-only changes — an
    // ACCEPT drops an entry without touching the buffer, and remote suggestions
    // arrive on the map — so the overlay updates instantly without a server poll.
    const suggestionsMap = ydoc?.getMap(CODE_SUGGESTIONS_ROOT);
    const onSuggestionsChange = () => apply();
    suggestionsMap?.observe(onSuggestionsChange);
    // Clicking a green addition line opens the chat turn that made the change
    // — same as clicking the `Sunny #N` chip. We don't preventDefault so the
    // cursor still lands where the user clicked.
    const subMouseDown = editor.onMouseDown((e) => {
      const lineNumber = e.target.position?.lineNumber;
      if (!lineNumber) return;
      const jump = lineJumpsRef.current.get(lineNumber);
      if (!jump) return;
      onJumpToTurnRef.current?.(jump.id, jump.chatId);
    });
    // Toggle a `data-diff-hover` attribute on the editor root so CSS can
    // swap the cursor to `pointer` when the pointer is over an addition
    // line. Monaco paints `.monaco-diff-pending-addition` on a background
    // overlay layer (not the text layer), so a pure-CSS hover rule wouldn't
    // catch it — we drive it from the actual mouse position instead.
    const editorDom = editor.getDomNode();
    // Reveal a suggestion's ✓/✕ pill only while the pointer is on its lines.
    // A file that's mostly suggestions otherwise renders a pill on every chunk
    // at once, which reads as chrome rather than as a decision to make. The
    // pill's own row counts as part of the chunk (it sits one line below the
    // last one) so the pointer can travel from the text onto the buttons.
    let hoveredPillLine: number | null | undefined;
    const setPillHover = (lineNumber: number | null) => {
      // Same line — nothing to repaint. `null` always recomputes: it covers both
      // "on the pill" and "off it onto empty space", which need opposite results.
      if (lineNumber != null && lineNumber === hoveredPillLine) return;
      hoveredPillLine = lineNumber;
      for (const entry of actionsOverlaysRef.current.values()) {
        // A pointer sitting ON the pill resolves to no buffer line (Monaco reports
        // overlay-widget hits with `position: null`), so a line-only rule would
        // hide the pill the instant you reached for ✓/✕ and drop the click. The
        // element's own :hover keeps it up while the pointer is on it.
        const on =
          (lineNumber != null && lineNumber >= entry.fromLine && lineNumber <= entry.toLine + 1) ||
          entry.dom.matches(':hover');
        entry.dom.classList.toggle('is-hovered', on);
      }
    };
    const subMouseMove = editor.onMouseMove((e) => {
      const lineNumber = e.target.position?.lineNumber ?? null;
      setPillHover(lineNumber);
      if (!editorDom) return;
      const hovering = lineNumber != null && lineJumpsRef.current.has(lineNumber);
      if (hovering) editorDom.setAttribute('data-diff-hover', '1');
      else editorDom.removeAttribute('data-diff-hover');
    });
    const subMouseLeave = editor.onMouseLeave(() => {
      setPillHover(null);
      editorDom?.removeAttribute('data-diff-hover');
    });
    // Re-apply on editor resize so the deletion view zone's wrapped-row count
    // (and therefore its height) tracks the new content width — otherwise red
    // text gets clipped when the window narrows. Debounced via rAF: a single
    // drag can fire onDidLayoutChange dozens of times per second; coalesce.
    const subLayout = editor.onDidLayoutChange(() => {
      if (layoutRafRef.current !== null) return;
      layoutRafRef.current = window.requestAnimationFrame(() => {
        layoutRafRef.current = null;
        apply();
      });
    });
    // Re-position the action pills on scroll, coalesced to one pass per frame
    // — a wheel tick fires onDidScrollChange several times.
    let scrollRaf = 0;
    const subScroll = editor.onDidScrollChange(() => {
      if (scrollRaf) return;
      scrollRaf = window.requestAnimationFrame(() => {
        scrollRaf = 0;
        repositionActionOverlays();
      });
    });
    return () => {
      subContent.dispose();
      suggestionsMap?.unobserve(onSuggestionsChange);
      subLayout.dispose();
      subScroll.dispose();
      subMouseDown.dispose();
      subMouseMove.dispose();
      subMouseLeave.dispose();
      if (layoutRafRef.current !== null) {
        window.cancelAnimationFrame(layoutRafRef.current);
        layoutRafRef.current = null;
      }
      applyOverlaysRef.current = null;
      teardownAll();
      decorationCollectionRef.current?.clear();
      decorationCollectionRef.current = null;
    };
  }, [editorMounted, ydoc, readOnly, effectiveReadOnly, canResolveSuggestions]);

  // Re-apply (reconcile, don't rebuild) when the server-derived `pendingAdditions`
  // prop changes — e.g. after a Keep/Undo refetch. Driving this through a ref
  // instead of the overlay effect's deps means a single accept/reject no longer
  // tears down + recreates every other suggestion's zone/pill (the flicker bug).
  useEffect(() => {
    applyOverlaysRef.current?.();
  }, [pendingAdditions]);

  // Inline comment highlights + lane-anchor measurement. Resolve each open
  // thread (and the in-progress draft) from its Yjs RelativePosition anchor to a
  // Monaco range, paint a highlight, and report the vertical center of each so
  // the comment lane can line its cards up with the code. Re-computes on edits
  // and scroll because the resolved offsets move with the content/viewport.
  useEffect(() => {
    const editor = monacoEditorRef.current;
    const model = modelRef.current;
    const monaco = monacoNsRef.current;
    if (!bindingReady || !editor || !model || !monaco || !ydoc) return;

    const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo) as
      | { lineHeight?: number }
      | undefined;
    const lineHeightPx = fontInfo?.lineHeight ?? 20;

    // No threads and no draft: clear any leftover decorations, report once so
    // the lane resets, and skip the scroll/content subscriptions entirely —
    // compute() below reads the FULL document text per scroll frame, which on
    // large files is real per-frame cost for nothing.
    if ((commentThreads ?? []).length === 0 && !draftCommentSelection) {
      commentRangesRef.current = [];
      commentDecorationsRef.current?.set([]);
      onReportCommentAnchorsRef.current?.({ offsets: {}, draftOffset: null, lineSpans: {} });
      return;
    }

    // Anchor ranges move only with the CONTENT; a pure scroll frame must not
    // re-read the full document text or re-resolve anchors (per-frame cost on
    // large files). Cache them per model version; scroll frames fall through
    // to the pixel measurement below.
    let rangesVersion = -1;
    let draft: { from: number; to: number } | null = null;
    const resolveRanges = () => {
      const version = model.getVersionId();
      if (version === rangesVersion) return;
      rangesVersion = version;
      const text = model.getValue();
      const ranges = resolveCodeCommentRanges(commentThreads ?? [], ydoc, text);
      draft = draftCommentSelection
        ? resolveCodeCommentAnchorRange(draftCommentSelection.anchor, draftCommentSelection.head, ydoc)
        : null;
      commentRangesRef.current = ranges;

      const decorations: MonacoEditorType.IModelDeltaDecoration[] = [];
      for (const range of ranges) {
        const start = model.getPositionAt(range.from);
        const end = model.getPositionAt(range.to);
        const active = range.id === activeCommentThreadId;
        decorations.push({
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: {
            inlineClassName: active
              ? 'monaco-comment-range-active'
              : range.status === 'resolved'
                ? 'monaco-comment-range-resolved'
                : 'monaco-comment-range',
          },
        });
      }
      if (draft) {
        const start = model.getPositionAt(draft.from);
        const end = model.getPositionAt(draft.to);
        decorations.push({
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: { inlineClassName: 'monaco-comment-draft-range' },
        });
      }
      if (commentDecorationsRef.current) {
        commentDecorationsRef.current.set(decorations);
      } else {
        commentDecorationsRef.current = editor.createDecorationsCollection(decorations);
      }
    };

    const compute = () => {
      resolveRanges();
      const ranges = commentRangesRef.current;
      const report = onReportCommentAnchorsRef.current;
      if (!report) return;
      // Source line span per thread — resolvable even when pixel offsets are
      // not (the PDF pins/highlights consume these with no lane row on screen).
      const lineSpans: Record<string, [number, number]> = {};
      for (const range of ranges) {
        lineSpans[range.id] = [
          model.getPositionAt(range.from).lineNumber,
          model.getPositionAt(Math.max(range.from, range.to - 1)).lineNumber,
        ];
      }
      const laneRow = commentLaneRowRef?.current;
      const editorDom = editor.getDomNode();
      if (!laneRow || !editorDom) {
        report({ offsets: {}, draftOffset: null, attempted: false, lineSpans });
        return;
      }
      const rowTop = laneRow.getBoundingClientRect().top;
      const editorTop = editorDom.getBoundingClientRect().top;
      const scrollTop = editor.getScrollTop();
      // getTopForLineNumber works for lines outside the rendered viewport, unlike
      // getScrolledVisiblePosition; subtract scrollTop to get viewport-relative.
      const centerOf = (from: number, to: number) => {
        const top = editor.getTopForLineNumber(model.getPositionAt(from).lineNumber) - scrollTop;
        const bottom =
          editor.getTopForLineNumber(model.getPositionAt(to).lineNumber) - scrollTop + lineHeightPx;
        return Math.max(0, Math.round(editorTop + (top + bottom) / 2 - rowTop));
      };
      const offsets: Record<string, number> = {};
      for (const range of ranges) offsets[range.id] = centerOf(range.from, range.to);
      report({ offsets, draftOffset: draft ? centerOf(draft.from, draft.to) : null, lineSpans });
    };

    // Coalesce bursts (a scroll drag fires onDidScrollChange + onDidLayoutChange
    // dozens of times/sec) into one recompute per frame, like the markdown lane.
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        compute();
      });
    };
    compute();
    const subContent = editor.onDidChangeModelContent(schedule);
    const subScroll = editor.onDidScrollChange(schedule);
    const subLayout = editor.onDidLayoutChange(schedule);
    // Clicking commented text selects that thread in the lane (Google-Docs-style).
    const subMouseDown = editor.onMouseDown((e) => {
      const pos = e.target.position;
      if (!pos) return;
      const id = pickCommentAtPos(commentRangesRef.current, model.getOffsetAt(pos));
      if (id) onSelectCommentRef.current?.(id);
    });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      subContent.dispose();
      subScroll.dispose();
      subLayout.dispose();
      subMouseDown.dispose();
      commentDecorationsRef.current?.clear();
      commentDecorationsRef.current = null;
    };
  }, [bindingReady, ydoc, commentThreads, activeCommentThreadId, draftCommentSelection, commentLaneRowRef]);

  // Scroll the active thread's range into view when it's selected from the lane
  // (or opened via a commentThreadId deep link), mirroring the markdown editor.
  // Keyed on the thread id (guarded by a ref) so a realtime reload of the same
  // active thread doesn't yank the editor mid-edit; re-runs when threads finally
  // load so a deep link selected before load still reveals.
  useEffect(() => {
    if (!activeCommentThreadId) {
      lastRevealedCommentRef.current = null;
      return;
    }
    if (lastRevealedCommentRef.current === activeCommentThreadId) return;
    const editor = monacoEditorRef.current;
    const model = modelRef.current;
    const monaco = monacoNsRef.current;
    if (!bindingReady || !editor || !model || !monaco || !ydoc) return;
    const tryReveal = () => {
      const thread = (commentThreads ?? []).find((t) => t.id === activeCommentThreadId);
      if (!thread) return false;
      // Reuse the same resolver the decorations use so the raw `string-quote`
      // anchor fallback (not the clipped/normalized display `quote`) is honored.
      const [range] = resolveCodeCommentRanges([thread], ydoc, model.getValue());
      if (!range) return false;
      lastRevealedCommentRef.current = activeCommentThreadId;
      const start = model.getPositionAt(range.from);
      const end = model.getPositionAt(range.to);
      editor.revealRangeInCenterIfOutsideViewport(
        new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      );
      return true;
    };
    if (tryReveal()) return;
    // Selected before the Y.Text finished syncing (e.g. a deep link on cold
    // load) — retry once content lands, then stop, so the comment still scrolls
    // into view instead of resolving against an empty doc and giving up.
    const sub = editor.onDidChangeModelContent(() => {
      if (tryReveal()) sub.dispose();
    });
    return () => sub.dispose();
  }, [activeCommentThreadId, bindingReady, commentThreads, ydoc]);

  // Continuous scroll sync: report the top visible line (debounced) so the
  // host can forward-map it into the PDF. Refs keep this subscription free of
  // per-render churn; the suppression window mutes the echo of an applied
  // follow. O(1) per scroll event — no document walks (keystroke-path rule).
  useEffect(() => {
    const editor = monacoEditorRef.current;
    if (!editorMounted || !editor) return;
    const sub = editor.onDidScrollChange(() => {
      if (!onScrollTopLineRef.current) return;
      if (Date.now() < scrollFollowSuppressUntilRef.current) return;
      if (scrollReportTimerRef.current) clearTimeout(scrollReportTimerRef.current);
      scrollReportTimerRef.current = setTimeout(() => {
        scrollReportTimerRef.current = null;
        const live = monacoEditorRef.current;
        const report = onScrollTopLineRef.current;
        if (!live || !report) return;
        if (Date.now() < scrollFollowSuppressUntilRef.current) return;
        const line = live.getVisibleRanges()[0]?.startLineNumber;
        if (line) report(line);
      }, 120);
    });
    return () => {
      sub.dispose();
      if (scrollReportTimerRef.current) clearTimeout(scrollReportTimerRef.current);
    };
  }, [editorMounted]);

  // "Comment" context-menu action + Cmd/Ctrl-Opt-M to comment on the selection.
  useEffect(() => {
    const editor = monacoEditorRef.current;
    const monaco = monacoNsRef.current;
    if (!editorMounted || !editor || !monaco || !ydoc || !canComment) return;
    const action = editor.addAction({
      id: 'sundial-comment',
      label: 'Comment',
      // First item in the menu — comments are the emphasized action.
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.1,
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyM,
        monaco.KeyMod.WinCtrl | monaco.KeyMod.Alt | monaco.KeyCode.KeyM,
      ],
      run: (ed) => {
        const sel = ed.getSelection();
        const m = ed.getModel();
        if (!sel || !m || sel.isEmpty()) return;
        const from = m.getOffsetAt(sel.getStartPosition());
        const to = m.getOffsetAt(sel.getEndPosition());
        const selection = buildCodeCommentSelection(ydoc, from, to, m.getValueInRange(sel));
        if (selection) onStartCommentDraftRef.current?.(selection);
      },
    });
    return () => action.dispose();
  }, [editorMounted, ydoc, canComment]);

  useEffect(() => {
    return () => {
      contentSubscriptionRef.current?.dispose();
      if (contentNotifyTimerRef.current) clearTimeout(contentNotifyTimerRef.current);
      bindingRef.current?.destroy();
      providerRef.current?.destroy();
      monacoEditorRef.current = null;
      modelRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      localYdoc.destroy();
    };
  }, [localYdoc]);

  // Image drop / paste for LaTeX files: upload the image, then insert a
  // tex-relative `\includegraphics{…}` reference at the cursor and make sure
  // the preamble pulls in graphicx.
  const isLatexFile = /\.tex$/iu.test(filePath);
  useEffect(() => {
    if (!editorMounted || !isLatexFile) return;
    const editor = monacoEditorRef.current;
    const monaco = monacoNsRef.current;
    const dom = editor?.getDomNode();
    if (!editor || !monaco || !dom) return;

    const ensureGraphicx = () => {
      const model = editor.getModel();
      if (!model) return;
      const value = model.getValue();
      if (texHasGraphicx(value)) return;
      const dcLine = value.split('\n').findIndex((l) => /\\documentclass/u.test(l));
      if (dcLine === -1) return; // a subfile — the main document owns the preamble
      editor.executeEdits('latex-graphicx', [
        { range: new monaco.Range(dcLine + 2, 1, dcLine + 2, 1), text: '\\usepackage{graphicx}\n' },
      ]);
    };

    const insertReference = (relPath: string, pos: { lineNumber: number; column: number }) => {
      const model = editor.getModel();
      if (!model) return;
      const include = `\\includegraphics[width=0.8\\textwidth]{${relPath}}`;
      const lines = model.getValue().split('\n');
      // 1-based index of `\begin{document}`, if present.
      const beginDoc = lines.findIndex((l) => /\\begin\{document\}/u.test(l)) + 1;
      const targetLine = Math.min(Math.max(pos.lineNumber, 1), model.getLineCount());
      if (beginDoc > 0 && targetLine < beginDoc) {
        // Dropping inside the preamble would break the build — never put an
        // image there. Fall back to its own line just after \begin{document}.
        const col = model.getLineMaxColumn(beginDoc);
        editor.executeEdits('latex-image', [
          { range: new monaco.Range(beginDoc, col, beginDoc, col), text: `\n${include}` },
        ]);
      } else {
        // Insert exactly where the user dropped — at the drop column.
        const col = Math.min(Math.max(pos.column, 1), model.getLineMaxColumn(targetLine));
        editor.executeEdits('latex-image', [
          { range: new monaco.Range(targetLine, col, targetLine, col), text: include },
        ]);
      }
      ensureGraphicx();
      editor.focus();
    };

    const uploadAndInsert = async (files: File[], pos: { lineNumber: number; column: number }) => {
      const upload = onImageUploadRef.current;
      if (!upload) return;
      for (const file of files) {
        const workspacePath = await upload(file);
        if (workspacePath && !editor.getModel()?.isDisposed()) {
          // Through the ref: a cross-folder move while the upload is in
          // flight must resolve relative to the file's CURRENT directory.
          insertReference(relativeToTexDir(filePathRef.current, workspacePath), pos);
        }
      }
    };

    const positionFromEvent = (event: DragEvent) =>
      editor.getTargetAtClientPoint(event.clientX, event.clientY)?.position ??
      editor.getPosition() ?? { lineNumber: 1, column: 1 };

    // Our capture-phase handler stops the drop from reaching Monaco's own
    // DragAndDropController, so it never clears its `dnd-target` drop-cursor
    // decoration. Strip any leftover ones ourselves.
    const clearDndDecorations = () => {
      const model = editor.getModel();
      if (!model) return;
      const stale = model
        .getAllDecorations()
        .filter((d) => (d.options.className ?? '').split(' ').includes('dnd-target'))
        .map((d) => d.id);
      if (stale.length) model.deltaDecorations(stale, []);
    };

    const onDrop = (event: DragEvent) => {
      if (editor.getOption(monaco.editor.EditorOption.readOnly)) return;
      const dt = event.dataTransfer;
      if (!dt) return;
      const pos = positionFromEvent(event);

      const osImages = Array.from(dt.files ?? []).filter((f) => isEditorImageFile(f));
      if (osImages.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        clearDndDecorations();
        void uploadAndInsert(osImages, pos);
        return;
      }
      // Internal drag from the workspace files panel → reference by path.
      const json = dt.getData('application/json');
      if (json) {
        let paths: string[] = [];
        try {
          const parsed: unknown = JSON.parse(json);
          if (Array.isArray(parsed)) paths = parsed.filter((p): p is string => typeof p === 'string');
        } catch {
          /* not a workspace-file drag */
        }
        const imagePaths = paths.filter((p) => LATEX_IMAGE_EXT_RE.test(p));
        if (imagePaths.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          clearDndDecorations();
          for (const p of imagePaths) insertReference(relativeToTexDir(filePathRef.current, p), pos);
        }
      }
    };

    const onDragOver = (event: DragEvent) => {
      const types = event.dataTransfer?.types;
      if (types && (types.includes('Files') || types.includes('application/json'))) {
        event.preventDefault();
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      if (editor.getOption(monaco.editor.EditorOption.readOnly)) return;
      const images = Array.from(event.clipboardData?.files ?? []).filter((f) => isEditorImageFile(f));
      if (images.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      void uploadAndInsert(images, editor.getPosition() ?? { lineNumber: 1, column: 1 });
    };

    dom.addEventListener('drop', onDrop, true);
    dom.addEventListener('dragover', onDragOver, true);
    dom.addEventListener('paste', onPaste, true);
    return () => {
      dom.removeEventListener('drop', onDrop, true);
      dom.removeEventListener('dragover', onDragOver, true);
      dom.removeEventListener('paste', onPaste, true);
    };
  }, [editorMounted, isLatexFile, filePath]);

  // Compile problems → Monaco markers (squiggle + hover) and a gutter bar per
  // line. Re-applied on every compile result and on remount; cleared when the
  // list empties (clean compile) or the editor unmounts. Gated on the binding
  // (not just the mount) so the lines exist before the decorations anchor.
  useEffect(() => {
    const editor = monacoEditorRef.current;
    const monaco = monacoNsRef.current;
    const model = editor?.getModel();
    if (!bindingReady || !editor || !monaco || !model || model.isDisposed()) return;
    const markers = compileMarkers ?? [];
    const gutter = installLatexCompileMarkers({
      monaco,
      editor,
      model,
      markers,
      onVisible: (installedMarkers) =>
        onCompileMarkersVisibleRef.current?.(filePathRef.current, installedMarkers),
    });
    return () => {
      gutter.clear();
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, LATEX_COMPILE_MARKER_OWNER, []);
    };
  }, [bindingReady, compileMarkers]);

  // Forward SyncTeX for .tex files (§4.2): "Show in PDF" in the right-click
  // menu (Ctrl/Cmd+Alt+J).
  const onShowInPdfRef = useRef(onShowInPdf);
  onShowInPdfRef.current = onShowInPdf;
  const canShowInPdf = isLatexFile && !!onShowInPdf;
  useEffect(() => {
    const editor = monacoEditorRef.current;
    const monaco = monacoNsRef.current;
    if (!editorMounted || !editor || !monaco || !canShowInPdf) return;
    return attachSyncTexBindings({ editor, monaco, onShowInPdf: () => onShowInPdfRef.current?.() });
  }, [editorMounted, canShowInPdf]);

  // Stable identity: a fresh object per render makes @monaco-editor/react call
  // editor.updateOptions() on EVERY re-render of this component.
  const editorOptions = useMemo(
    () => getCodeEditorOptions(effectiveReadOnly || !bindingReady),
    [effectiveReadOnly, bindingReady],
  );

  return (
    <div
      ref={containerRef}
      className={`${hidden ? 'hidden' : 'block'} ${bare ? 'h-full' : ''}`}
      data-code-collab-ready={bindingReady ? 'true' : 'false'}
    >
      {readOnly && (
        <div className="mb-3 flex items-center gap-1.5 text-[11px] text-stone-400">
          <LockSimpleIcon className="h-3 w-3" weight="regular" />
          <span>Read-only</span>
        </div>
      )}
      {/* Comment-only visitors have readOnly=true but must still get the
          bubble — right-click Comment and ⌘⌥M work for them, so the
          emphasized affordance has to as well. */}
      {editorMounted && !hidden && isLatexFile &&
        (!readOnly || canComment || Boolean(selectionActionsProjectId)) &&
        monacoEditorRef.current && (
          <CodeSelectionBubble
            editor={monacoEditorRef.current}
            filePath={filePath}
            selectionActionsProjectId={selectionActionsProjectId}
            ydoc={ydoc}
            canComment={canComment}
            onStartCommentDraftRef={onStartCommentDraftRef}
            suppressRef={bubbleSuppressRef}
          />
        )}
      {/* Flat: code renders directly on the white panel, like markdown (no card border). */}
      <div className={`relative overflow-hidden ${bare ? 'h-full' : ''} ${className ?? ''}`}>
        {isAutocompleteEnabled() && !readOnly ? (
          <AutocompleteStatusChip supported={isAutocompleteSupportedLanguage(getCodeLanguage(filePath))} />
        ) : null}
        {pendingReviewCount > 0 && !readOnly && canResolveSuggestions && (
          <SuggestionReviewBar
            className="absolute bottom-4 right-4 z-30"
            onAcceptAll={() => { for (const key of chunkByKeyRef.current.keys()) resolveByKey(key, true); }}
            onRejectAll={() => { for (const key of chunkByKeyRef.current.keys()) resolveByKey(key, false); }}
          />
        )}
        {!initialSyncReady ? (
          <EditorSkeleton
            variant="code"
            className={bare ? 'h-full' : ''}
            style={bare ? undefined : { height: editorHeight }}
          />
        ) : (
          <MonacoEditor
            key={fileId}
            height={bare ? '100%' : editorHeight}
            language={getCodeLanguage(filePath)}
            theme={monacoTheme}
            beforeMount={defineMonacoThemes}
            options={editorOptions}
            onMount={(editor, monaco) => {
            monacoEditorRef.current = editor;
            monacoNsRef.current = monaco;
            registerLatexCompletions(monaco);
            // Ghost text rides a different Monaco channel than the LaTeX
            // suggest widget above; both register once, per page.
            registerAutocompleteProvider(monaco);
            // Pilot-flagged surface: with the flag off the feature stays fully
            // hidden — no context-menu entry to discover it by.
            if (isAutocompleteEnabled()) registerAutocompleteToggleAction(editor);
            modelRef.current = editor.getModel();
            // The first .tex model is created before `latex` is registered, so
            // it lands as `plaintext`; re-apply the language so completions fire.
            if (modelRef.current && getCodeLanguage(filePath) === 'latex' && modelRef.current.getLanguageId() !== 'latex') {
              monaco.editor.setModelLanguage(modelRef.current, 'latex');
            }
            contentSubscriptionRef.current?.dispose();
            contentSubscriptionRef.current = editor.onDidChangeModelContent(() => {
              const text = editor.getModel()?.getValue() ?? '';
              currentTextRef.current = text;
              // Propagating every keystroke re-renders the host page with the
              // full text; on very large documents that's a per-keystroke
              // stall, so trail the burst. Point-in-time readers (save,
              // compile) pull fresh text via getText/getSource, not this.
              if (text.length < 100_000) {
                if (contentNotifyTimerRef.current) clearTimeout(contentNotifyTimerRef.current);
                contentNotifyTimerRef.current = null;
                onContentChange?.(text);
              } else if (!contentNotifyTimerRef.current) {
                contentNotifyTimerRef.current = setTimeout(() => {
                  contentNotifyTimerRef.current = null;
                  onContentChange?.(currentTextRef.current);
                }, 250);
              }
            });
            currentTextRef.current = editor.getModel()?.getValue() ?? '';
            // Chat shortcuts (mirror collab-editor's ChatContextShortcut):
            //   Cmd/Ctrl-J                    → open current chat (+ selection)
            //   +Shift                        → open fresh chat
            const dispatchChatContext = (forceNew: boolean, allowToggle = true) => {
              const sel = editor.getSelection();
              const model = editor.getModel();
              const hasSel = sel && model && !sel.isEmpty();
              const text = hasSel ? model!.getValueInRange(sel!).trim() : '';
              window.dispatchEvent(
                new CustomEvent('sundial:add-chat-context', {
                  // Cmd-J with no selection toggles the chat closed when
                  // it's already visible; with a selection it pins the
                  // selection instead. Shift variants always open fresh;
                  // menu picks (allowToggle=false) always open, never close.
                  detail: {
                    text,
                    path: filePathRef.current,
                    forceNew,
                    toggle: allowToggle && !forceNew && !text,
                  },
                }),
              );
            };
            const { KeyMod, KeyCode } = monaco;
            editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyJ, () => dispatchChatContext(false));
            editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyJ, () => dispatchChatContext(true));
            // Route Cmd/Ctrl-Z (and redo) to the suggestion-aware Y.UndoManager so
            // a Cmd+Z after a ✓/✕ returns the suggestion to pending, not Monaco's
            // native text-only stack (which can't see the ledger maps and misses an
            // accept entirely — accept changes no buffer text). When the ledger is
            // off there's no manager; fall through to native undo unchanged.
            const runUndo = () => {
              const um = undoManagerRef.current;
              if (um) um.undo();
              else editor.trigger('keyboard', 'undo', null);
            };
            const runRedo = () => {
              const um = undoManagerRef.current;
              if (um) um.redo();
              else editor.trigger('keyboard', 'redo', null);
            };
            editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, runUndo);
            editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, runRedo);
            editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, runRedo);
            // Right after Comment in the context menu; unlike ⌘J it never
            // toggles the chat closed — a menu pick always opens it. Greyed
            // out with no selection (an empty dispatch would still open, and
            // could even create, a chat).
            editor.addAction({
              id: 'sundial-add-to-chat',
              label: 'Reference in chat',
              contextMenuGroupId: 'navigation',
              contextMenuOrder: 1.2,
              precondition: 'editorHasSelection',
              run: () => dispatchChatContext(false, false),
            });
            editor.addAction({
              id: 'sundial-copy-line-link',
              label: 'Copy link to this line',
              contextMenuGroupId: 'navigation',
              contextMenuOrder: 1.5,
              run: async (ed) => {
                const pos = ed.getPosition();
                if (!pos || typeof window === 'undefined') return;
                const url = new URL(window.location.href);
                url.searchParams.set('line', String(pos.lineNumber));
                try {
                  await navigator.clipboard.writeText(url.toString());
                } catch {
                  // clipboard denied; silent — Monaco actions have no toast surface.
                }
              },
            });
            const lineParam = typeof window !== 'undefined'
              ? Number(new URL(window.location.href).searchParams.get('line'))
              : NaN;
            if (Number.isFinite(lineParam) && lineParam > 0) {
              const target = Math.floor(lineParam);
              editor.revealLineInCenter(target);
              editor.setPosition({ lineNumber: target, column: 1 });
            }
            // @monaco-editor/react disposes the editor AND its model when it
            // unmounts (e.g. initialSyncReady flips and we swap to the skeleton).
            // Reset refs + mounted flags so the binding/overlay/comment effects
            // tear down instead of touching a disposed model ("Model is
            // disposed!" → blank "page could not render" crash).
            editor.onDidDispose(() => {
              // Only reset when THIS editor is still the live one. Under rapid
              // initialSyncReady churn a stale editor's dispose can fire AFTER
              // the next editor already mounted; clobbering refs/flags then would
              // strand the live editor with no binding (collab/sync silently
              // dead) — so guard the whole body on editor identity.
              if (monacoEditorRef.current !== editor) return;
              monacoEditorRef.current = null;
              modelRef.current = null;
              contentSubscriptionRef.current?.dispose();
              contentSubscriptionRef.current = null;
              setBindingReady(false);
              setEditorMounted(false);
            });
            setEditorMounted(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ── Code selection bubble (LaTeX prototype) ──────────────────────────
 *  Custom assistant actions + Comment floating above the selection, mirroring the
 *  markdown editor's format bubble (shared class constants keep the two
 *  pixel-identical). A separate component so per-frame placement state
 *  re-renders this small portal, not the whole editor host. Body portal
 *  with fixed coords so pane transforms and the editor's overflow
 *  clipping can't swallow it.
 * ─────────────────────────────────────────────────────────────────── */
function CodeSelectionBubble({
  editor,
  filePath,
  selectionActionsProjectId,
  ydoc,
  canComment,
  onStartCommentDraftRef,
  suppressRef,
}: {
  editor: MonacoEditorType.IStandaloneCodeEditor;
  filePath: string;
  selectionActionsProjectId?: string;
  ydoc: Y.Doc | null;
  canComment: boolean;
  onStartCommentDraftRef: { current: ((selection: DraftDocCommentSelection) => void) | undefined };
  /** While true, the bubble stays hidden: the selection was made by code (a
   *  SyncTeX word-snap jump), not the user. Cleared by the next mouse or
   *  keyboard selection change. */
  suppressRef: { current: boolean };
}) {
  const [bubble, setBubble] = useState<{ top: number; left: number; below: boolean } | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raf: number | undefined;
    let blurRaf: number | undefined;
    const place = () => {
      const sel = editor.getSelection();
      const model = editor.getModel();
      const dom = editor.getDomNode();
      const bubbleHasFocus = Boolean(elRef.current?.contains(document.activeElement));
      if (
        !sel ||
        !model ||
        !dom ||
        sel.isEmpty() ||
        (!editor.hasTextFocus() && !bubbleHasFocus) ||
        suppressRef.current
      ) {
        setBubble(null);
        return;
      }
      // Whitespace-only drags have nothing to act on. Bounded scan: a full
      // getValueInRange would materialize the ENTIRE selection (megabytes on
      // select-all) on every recompute — same rule as the markdown bubble.
      const start = sel.getStartPosition();
      const end = sel.getEndPosition();
      const boundedEnd = model.getPositionAt(
        Math.min(model.getOffsetAt(end), model.getOffsetAt(start) + SELECTION_SAMPLE_LIMIT),
      );
      const sample = model.getValueInRange({
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: boundedEnd.lineNumber,
        endColumn: boundedEnd.column,
      });
      if (!sample.trim()) {
        setBubble(null);
        return;
      }
      const rect = dom.getBoundingClientRect();
      // Anchor above the selection start; on a long downward drag the start
      // scrolls out of view, so fall back to the (visible) active end.
      const visible = (pos: typeof start) => {
        const p = editor.getScrolledVisiblePosition(pos);
        return p && p.top >= 0 && p.top <= dom.clientHeight ? p : null;
      };
      let spanning = false;
      let anchor = visible(start) ?? visible(end);
      if (!anchor) {
        // Neither endpoint on screen. If the selection SPANS the viewport
        // (select-all, multi-screen drag) keep the bubble reachable at the
        // top of the visible slice; otherwise the selection is off-screen.
        const s = editor.getScrolledVisiblePosition(start);
        const e = editor.getScrolledVisiblePosition(end);
        if (!s || !e || s.top > 0 || e.top < dom.clientHeight) {
          setBubble(null);
          return;
        }
        spanning = true;
        anchor = { top: 8, left: Math.max(12, dom.clientWidth / 2 - 110), height: 0 };
      }
      // Flip below when the bubble would crowd EITHER top edge: the editor's
      // (anchor.top, so a first-line bubble doesn't sit over the toolbar) or
      // the browser viewport's (y — an outer scroller can move the editor
      // partly above the window, where only a screen-space check saves it).
      const y = rect.top + anchor.top;
      const below = spanning || y < 48 || anchor.top < 48;
      const width = elRef.current?.offsetWidth ?? 230;
      const next = {
        top: y + (below ? anchor.height + 8 : -8),
        left: Math.max(12, Math.min(rect.left + anchor.left, window.innerWidth - 12 - width)),
        below,
      };
      // Identity-stable when nothing moved so scroll ticks don't re-render.
      setBubble((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.below === next.below
          ? prev
          : next,
      );
    };
    // Per-frame sources (Monaco scroll, outer scrolls) coalesce to one rAF;
    // selection/layout changes debounce so the bubble doesn't chase a drag.
    const placeSoon = () => {
      if (raf !== undefined) return;
      raf = requestAnimationFrame(() => {
        raf = undefined;
        place();
      });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(place, 150);
    };
    const subs = [
      editor.onDidChangeCursorSelection((event) => {
        // A real user selection lifts the programmatic-selection suppression
        // (a SyncTeX jump selects the clicked word without offering actions).
        if (event.source === 'mouse' || event.source === 'keyboard') suppressRef.current = false;
        schedule();
      }),
      editor.onDidScrollChange(placeSoon),
      // Pane/window resizes move the editor without a scroll.
      editor.onDidLayoutChange(schedule),
      editor.onDidBlurEditorText(() => {
        // Keyboard users may move focus into Customize. Monaco reports the
        // blur before the browser commits that focus, so defer the check and
        // keep the selection bubble alive while one of its controls owns it.
        if (blurRaf !== undefined) cancelAnimationFrame(blurRaf);
        blurRaf = requestAnimationFrame(() => {
          blurRaf = undefined;
          if (!elRef.current?.contains(document.activeElement)) setBubble(null);
        });
      }),
    ];
    // An OUTER scroller moves the editor without any Monaco event; scroll
    // doesn't bubble but does capture (same trick as useFollowEditorScroll).
    const onOuterScroll = (event: Event) => {
      const dom = editor.getDomNode();
      if (!dom || !(event.target instanceof Node) || !event.target.contains(dom)) return;
      placeSoon();
    };
    window.addEventListener('scroll', onOuterScroll, { capture: true, passive: true });
    // The mount gate may flip while a selection is live (permissions
    // resolving, a rename toggling .tex) — place now, don't wait for an event.
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
      if (raf !== undefined) cancelAnimationFrame(raf);
      if (blurRaf !== undefined) cancelAnimationFrame(blurRaf);
      for (const sub of subs) sub.dispose();
      window.removeEventListener('scroll', onOuterScroll, { capture: true });
      setBubble(null);
    };
  }, [editor]);

  // Both actions collapse the selection to its end first — that hides the
  // bubble immediately (and the draft/chat UI takes focus anyway).
  const collapseSelection = (maxChars?: number) => {
    const sel = editor.getSelection();
    const model = editor.getModel();
    if (!sel || !model || sel.isEmpty()) return null;
    const end = sel.getEndPosition();
    const from = model.getOffsetAt(sel.getStartPosition());
    const to = model.getOffsetAt(end);
    const tooLong = typeof maxChars === 'number' && to - from > maxChars;
    const text = tooLong ? '' : model.getValueInRange(sel);
    editor.setSelection({
      startLineNumber: end.lineNumber,
      startColumn: end.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });
    setBubble(null);
    return { text, from, to, tooLong };
  };
  const invokeSelectionAction = (action: WorkspaceSelectionAction) => {
    const captured = collapseSelection(MAX_SELECTION_ACTION_TEXT_CHARS);
    const text = captured?.text.trim() ?? '';
    const selection =
      captured && !captured.tooLong && ydoc
        ? buildCodeCommentSelection(ydoc, captured.from, captured.to, captured.text)
        : null;
    if ((!text || !selection) && !captured?.tooLong) return;
    window.dispatchEvent(
      new CustomEvent(INVOKE_SELECTION_ACTION_EVENT, {
        detail: {
          action: {
            id: action.id,
            label: action.label,
            title: action.title,
            assistant_slug: action.assistant_slug,
            assistant_name: action.assistant_name,
          },
          text,
          too_long: captured?.tooLong || undefined,
          path: filePath,
          selection: selection ?? undefined,
        },
      }),
    );
  };
  const comment = () => {
    if (!ydoc) return;
    const captured = collapseSelection();
    if (!captured) return;
    const selection = buildCodeCommentSelection(ydoc, captured.from, captured.to, captured.text);
    if (selection) onStartCommentDraftRef.current?.(selection);
  };

  if (!bubble) return null;
  return createPortal(
    <div
      ref={elRef}
      data-testid="code-selection-bubble"
      className={`fixed z-[70] ${BUBBLE_SURFACE}`}
      style={{
        top: bubble.top,
        left: bubble.left,
        transform: bubble.below ? undefined : 'translateY(-100%)',
      }}
      // Keep the editor's selection/focus alive for every control in here.
      onMouseDown={(event) => event.preventDefault()}
    >
      {selectionActionsProjectId ? (
        <SelectionActionControls
          projectId={selectionActionsProjectId}
          onInvoke={invokeSelectionAction}
        />
      ) : null}
      {canComment && ydoc && (
        <button
          type="button"
          aria-label="Comment on selection ⌘⌥M"
          data-tour-id="bubble-comment"
          onClick={comment}
          className={BUBBLE_LABEL_ACCENT}
        >
          <ChatTeardropTextIcon className="h-4 w-4" weight="fill" />
          Comment
        </button>
      )}
    </div>,
    document.body,
  );
}
