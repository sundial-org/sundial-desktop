'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatCircleIcon, ChatTeardropIcon, LinkSimpleIcon } from '@phosphor-icons/react';
import type { Editor } from '@tiptap/react';
import {
  buildDraftDocCommentSelection,
  observeCommentAnchorReflow,
  resolveDocCommentDraftRange,
  resolveDocCommentRanges,
  selectWordAtCoords,
} from '@/lib/workspace/doc-comments-client';
import {
  OPTIMISTIC_ID_PREFIX,
  type DraftDocCommentSelection,
  type DocCommentThread,
  type DocCommentMessage,
  type DocCommentAuthor,
} from '@/lib/workspace/doc-comments';
import { buildLocalProjectPath, buildWorkspacePath } from '@/lib/workspace/paths';
import { createBrowserClient } from '@/lib/supabase/browser';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { isMarkdownImageContextMenuTarget } from '@/components/workspace/collab-editor';
import { formatFileName, getFileName } from './workspace-file-helpers';

type WorkspaceRouteId = string | { id: string; public_id: string | null };
type WorkspaceCommentMode = 'document' | 'workspace';

type CommentContextMenu = {
  x: number;
  y: number;
  selection: DraftDocCommentSelection;
};

/**
 * Merge freshly-measured comment-lane anchor offsets over the previous ones,
 * keyed by the currently-open threads. Fresh offsets always win; a thread that
 * fails to resolve this pass keeps its last-known offset instead of collapsing
 * to 0. Without this, a suggestion edit that invalidates a comment's anchor (its
 * block gets delete+reinserted, or its quoted text changes) would yank every
 * affected card to the top of the lane. Pruned to open threads so resolved or
 * deleted threads don't linger.
 */
export function retainAnchorOffsets(
  current: Record<string, number>,
  next: Record<string, number>,
  openThreadIds: string[],
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const id of openThreadIds) {
    const offset = next[id] ?? current[id];
    if (offset !== undefined) merged[id] = offset;
  }
  return merged;
}

function isCreateCommentShortcut(event: KeyboardEvent) {
  const isMKey = event.code === 'KeyM' || event.key.toLowerCase() === 'm';
  if (!isMKey || event.repeat) return false;
  if (event.metaKey && event.altKey && !event.ctrlKey) return true;
  return event.ctrlKey && event.altKey && !event.metaKey;
}

type OptimisticUser = { userId: string | null; name: string | null; username: string | null; imageUrl: string | null };

// Optimistic ids are tagged so reconcile/realtime can tell a not-yet-persisted
// comment from a server one, and so the editor's anchor resolvers still render
// it (the anchor payload is the real draft selection, so it maps immediately).
function makeOptimisticId() {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `${OPTIMISTIC_ID_PREFIX}${rand}`;
}

// Order-independent deep equality — the server stores comment anchors as JSONB,
// which can reorder object keys on round-trip, so a stringify compare is unsafe.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function optimisticAuthor(user: OptimisticUser): DocCommentAuthor {
  return {
    userId: user.userId ?? 'me',
    name: user.name,
    username: user.username,
    imageUrl: user.imageUrl,
  };
}

function optimisticMessage(body: string, author: DocCommentAuthor, now: string): DocCommentMessage {
  return { id: makeOptimisticId(), body, createdAt: now, updatedAt: now, author };
}

// Keep the active selection valid across a thread-list update. Matches the
// candidate by id, then by clientKey — so when an early server echo reconciles
// an optimistic id (id swaps, clientKey keeps the optimistic id), the active
// card/highlight follows to the persisted id instead of being cleared.
function resolveActiveThreadId(threads: DocCommentThread[], candidate: string | null) {
  if (!candidate) return null;
  if (threads.some((thread) => thread.id === candidate)) return candidate;
  const echoed = threads.find((thread) => thread.clientKey === candidate);
  return echoed ? echoed.id : null;
}

async function readErrorMessage(response: Response, fallback: string) {
  const text = await response.text().catch(() => '');
  if (!text.trim()) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // fall through to raw response text
  }
  return text.trim() || fallback;
}

export function useWorkspaceComments({
  projectId,
  supabaseClient,
  fetchImpl,
  subscribeToChanges,
  isLocalProject,
  workspaceRouteId,
  activeWorkspaceFile,
  activeIsMarkdown,
  activeIsCode,
  markdownEditor,
  showRawView,
  hasRichViewer,
  showRichViewer,
  canComment,
  isMobile,
  currentUser,
  workspaceFileByPath,
  deepLinkedCommentThreadId,
  deepLinkedWorkspaceFile,
  filesLoaded,
  hasMounted,
  selectedFilePath,
  onSelectFile,
  onOpenSpace,
  showWorkspaceAppNotice,
}: {
  projectId: string;
  supabaseClient: ReturnType<typeof createBrowserClient>;
  /** Data plane for all comment reads/writes — local (sidecar) workspaces pass
   *  their emulated fetch; cloud workspaces omit it and use the real one. */
  fetchImpl?: typeof fetch;
  /** Local replacement for the Supabase realtime channel: subscribe to the
   *  sidecar's comments-changed SSE; returns an unsubscribe. */
  subscribeToChanges?: ((onChange: () => void) => () => void) | null;
  /** Local desktop project: copied links must target /local/<id>, not /w/. */
  isLocalProject?: boolean;
  workspaceRouteId: WorkspaceRouteId;
  activeWorkspaceFile: WorkspaceFileRow | null;
  activeIsMarkdown: boolean;
  /** Active file is edited in the Monaco code/LaTeX editor (comments anchor to
   *  its Y.Text and are rendered/measured by CollabCodeEditor, not here). */
  activeIsCode: boolean;
  markdownEditor: Editor | null;
  showRawView: boolean;
  hasRichViewer: boolean;
  showRichViewer: boolean;
  /** Server-side canSuggest: editors AND commenters can comment. */
  canComment: boolean;
  isMobile: boolean;
  /** The signed-in user, for optimistically-rendered comments before the
   *  server echoes back the authoritative author. */
  currentUser: { userId: string | null; name: string | null; username: string | null; imageUrl: string | null };
  workspaceFileByPath: Map<string, WorkspaceFileRow>;
  deepLinkedCommentThreadId: string | null;
  deepLinkedWorkspaceFile: WorkspaceFileRow | null;
  filesLoaded: boolean;
  hasMounted: boolean;
  selectedFilePath: string;
  onSelectFile: (path: string) => void;
  onOpenSpace: () => void;
  showWorkspaceAppNotice: (type: 'success' | 'error', message: string) => void;
}) {
  // Wrapped (not `fetchImpl ?? fetch`) so the global fetch keeps its expected
  // receiver; local workspaces pass the sidecar-emulated fetch instead.
  const api = useMemo<typeof fetch>(
    () => fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
    [fetchImpl],
  );
  const [commentThreads, setCommentThreads] = useState<DocCommentThread[]>([]);
  // The file path `commentThreads` was loaded for. Until the new file's fetch
  // resolves on a switch, `commentThreads` still holds the previous file's
  // threads; gating on this path keeps those stale threads from being shown or
  // from auto-opening the lane for the wrong file.
  const [commentThreadsPath, setCommentThreadsPath] = useState<string | null>(null);
  const [workspaceCommentThreads, setWorkspaceCommentThreads] = useState<DocCommentThread[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [workspaceCommentsLoading, setWorkspaceCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [workspaceCommentsError, setWorkspaceCommentsError] = useState<string | null>(null);
  // Comments lane is hidden by default — open via the toolbar button or
  // when the user starts a comment / clicks a thread.
  const [showCommentLane, setShowCommentLane] = useState(false);
  const [commentPanelMode, setCommentPanelMode] = useState<WorkspaceCommentMode>('document');
  const [activeCommentThreadId, setActiveCommentThreadId] = useState<string | null>(null);
  const [draftCommentSelection, setDraftCommentSelection] = useState<DraftDocCommentSelection | null>(null);
  // Seeds the composer/reply box so a failed optimistic create/reply doesn't
  // lose the text the user typed (the composer unmounts / the reply box clears).
  const [draftCommentBody, setDraftCommentBody] = useState('');
  const [replyRestore, setReplyRestore] = useState<{ threadId: string; body: string; token: number } | null>(null);
  const replyRestoreTokenRef = useRef(0);
  const [commentBusyAction, setCommentBusyAction] = useState<string | null>(null);
  const [docCommentAnchorOffsets, setDocCommentAnchorOffsets] = useState<Record<string, number>>({});
  const [draftCommentAnchorOffset, setDraftCommentAnchorOffset] = useState<number | null>(null);
  const [commentContextMenu, setCommentContextMenu] = useState<CommentContextMenu | null>(null);
  // Bumped as the editor applies CRDT-synced content, so comment anchors
  // re-resolve once the doc is populated (see the resolve memo + effect below).
  const [docSyncNonce, setDocSyncNonce] = useState(0);

  const commentMenuRef = useRef<HTMLDivElement | null>(null);
  const commentLaneRowRef = useRef<HTMLDivElement | null>(null);
  const pendingWorkspaceCommentThreadIdRef = useRef<string | null>(null);
  const activeCommentFilePathRef = useRef<string | null>(null);
  const autoCommentHandledRef = useRef<string | null>(null);
  // Maps a persisted thread id → the optimistic id it was created under, so the
  // lane card keeps a stable React key across the create→reconcile id swap (and
  // across later reloads) instead of remounting and replaying its animation.
  const clientKeyByThreadIdRef = useRef<Record<string, string>>({});
  // In-flight optimistic items, re-merged onto any server snapshot so a GET that
  // resolves mid-POST (slow initial load, or the realtime polling fallback)
  // can't drop the just-typed comment/reply until its own request reconciles.
  const pendingThreadsRef = useRef<DocCommentThread[]>([]);
  const pendingMessagesRef = useRef<Array<{ threadId: string; message: DocCommentMessage }>>([]);
  const withOptimistic = useCallback((serverThreads: DocCommentThread[], filePath: string) => {
    const map = clientKeyByThreadIdRef.current;
    let threads = serverThreads.map((thread) => {
      let clientKey = map[thread.id];
      // A realtime reload can echo the persisted row before the POST promise
      // settles (so the id→optimistic-id map isn't recorded yet). Match the echo
      // by content and bind it to the optimistic id, so the card keeps its key
      // (no remount) and the pending copy is treated as resolved (no duplicate).
      if (!clientKey) {
        const match = pendingThreadsRef.current.find(
          (p) =>
            p.filePath === filePath &&
            p.author.userId === thread.author.userId &&
            p.messages[0]?.body === thread.messages[0]?.body &&
            // The anchor/head pin the exact range — without them two same-author,
            // same-text comments on repeated content could bind to the wrong row
            // (and collide on clientKey).
            deepEqual(p.anchor, thread.anchor) &&
            deepEqual(p.head, thread.head),
        );
        if (match) {
          clientKey = match.id;
          map[thread.id] = match.id;
        }
      }
      return clientKey ? { ...thread, clientKey } : thread;
    });
    if (pendingMessagesRef.current.length) {
      threads = threads.map((thread) => {
        const extra = pendingMessagesRef.current.filter(
          (p) =>
            p.threadId === thread.id &&
            // Skip once the server echo of this reply is present (id won't match
            // the temp one, so fall back to body + author).
            !thread.messages.some(
              (m) =>
                m.id === p.message.id ||
                (m.body === p.message.body && m.author.userId === p.message.author.userId),
            ),
        );
        return extra.length ? { ...thread, messages: [...thread.messages, ...extra.map((p) => p.message)] } : thread;
      });
    }
    const stampedKeys = new Set(threads.map((thread) => thread.clientKey).filter(Boolean));
    const pendingForFile = pendingThreadsRef.current.filter(
      (p) => p.filePath === filePath && !stampedKeys.has(p.id) && !threads.some((thread) => thread.id === p.id),
    );
    return pendingForFile.length ? [...pendingForFile, ...threads] : threads;
  }, []);

  // Comments are available on both markdown (ProseMirror) and code/LaTeX
  // (Monaco) files; only the rendering surface differs. Never on mobile: the
  // comment lane has no mobile surface, so offering affordances (context menu,
  // Monaco action, highlights) would dead-end silently.
  const commentsAvailableForActiveFile = Boolean(
    !isMobile &&
      activeWorkspaceFile &&
      (activeIsMarkdown || activeIsCode) &&
      !showRawView &&
      !(hasRichViewer && showRichViewer),
  );
  const activeFilePath = commentsAvailableForActiveFile ? activeWorkspaceFile?.path ?? null : null;
  activeCommentFilePathRef.current = activeFilePath;

  // Read the editor through a ref inside callbacks/effects/memos so their
  // closures don't capture the live `Editor` instance. Capturing it leaks the
  // whole editor (and its KaTeX-heavy DOM) on every file switch — a renderer
  // OOM ("Aw, Snap!") on long sessions. Deps below still list `markdownEditor`,
  // so recomputation timing is unchanged; only the captured reference differs.
  const markdownEditorRef = useRef(markdownEditor);
  markdownEditorRef.current = markdownEditor;

  const dismissCommentContextMenu = useCallback(() => {
    setCommentContextMenu(null);
  }, []);

  // The Monaco editor measures its own anchor offsets (the markdown layout
  // effect below can't — it walks the ProseMirror view) and reports them here.
  const reportCommentAnchors = useCallback(
    (data: { offsets: Record<string, number>; draftOffset: number | null }) => {
      setDocCommentAnchorOffsets((current) => {
        const currentKeys = Object.keys(current);
        const nextKeys = Object.keys(data.offsets);
        if (
          currentKeys.length === nextKeys.length &&
          nextKeys.every((key) => current[key] === data.offsets[key])
        ) {
          return current;
        }
        return data.offsets;
      });
      setDraftCommentAnchorOffset((current) => (current === data.draftOffset ? current : data.draftOffset));
    },
    [],
  );

  const canCommentOnActiveFile = Boolean(canComment && commentsAvailableForActiveFile);
  const openCommentThreads = useMemo(
    () =>
      commentThreadsPath === activeFilePath
        ? commentThreads.filter((thread) => thread.status === 'open')
        : [],
    [commentThreads, commentThreadsPath, activeFilePath],
  );
  const openWorkspaceCommentThreads = useMemo(
    () => workspaceCommentThreads.filter((thread) => thread.status === 'open'),
    [workspaceCommentThreads],
  );
  // Resolved threads for the active scope, newest first. Surfaced separately so
  // the panel can show a "Resolved" section — otherwise resolving a comment
  // hides it forever with no way to view or reopen it.
  const displayedResolvedThreads = useMemo(() => {
    // In document scope, gate on commentThreadsPath like openCommentThreads so a
    // file switch doesn't flash the previous file's resolved threads.
    const source =
      commentPanelMode === 'workspace'
        ? workspaceCommentThreads
        : commentThreadsPath === activeFilePath
          ? commentThreads
          : [];
    return source
      .filter((thread) => thread.status === 'resolved')
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [commentPanelMode, commentThreads, commentThreadsPath, activeFilePath, workspaceCommentThreads]);
  const resolvedCommentRanges = useMemo(
    // `docSyncNonce` is a dep so ranges re-resolve as CRDT content lands: the
    // provider can fire `synced` (editor mounts) before all doc updates apply,
    // so on first open the anchors resolve against an empty doc → nothing shows
    // until reload. The effect below bumps the nonce until every thread maps.
    () => resolveDocCommentRanges(openCommentThreads, markdownEditorRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- docSyncNonce is an intentional re-resolve trigger
    [markdownEditor, openCommentThreads, docSyncNonce],
  );
  const openCommentCount = openCommentThreads.length;
  const allCommentsResolved = resolvedCommentRanges.length >= openCommentCount;
  useEffect(() => {
    const editor = markdownEditorRef.current;
    if (!editor || editor.isDestroyed || openCommentCount === 0 || allCommentsResolved) return;
    // The initial CRDT sync applies content in a handful of transactions; nudge
    // the resolve memo on each until every open thread maps. Cap it so a thread
    // whose anchor never resolves (e.g. its quoted text was deleted) can't turn
    // steady-state typing into a per-keystroke re-resolve. Keyed on the count
    // (not the array identity) so a realtime comment-reload that returns the
    // same threads doesn't re-arm the whole window.
    let bumps = 0;
    const onUpdate = () => {
      setDocSyncNonce((value) => value + 1);
      if (++bumps >= 10) editor.off('update', onUpdate);
    };
    editor.on('update', onUpdate);
    // Re-resolve once on arm: content can land between the (empty) resolve above
    // and this passive effect subscribing, so that single sync `update` would
    // fire with no listener attached. The re-run reads the editor's live state,
    // covering the render→effect gap, not just future updates.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot re-resolve to close the mount-timing gap
    onUpdate();
    return () => {
      editor.off('update', onUpdate);
    };
  }, [markdownEditor, openCommentCount, allCommentsResolved]);
  const draftCommentRange = useMemo(
    () => resolveDocCommentDraftRange(draftCommentSelection, markdownEditorRef.current),
    [draftCommentSelection, markdownEditor],
  );
  const commentsLaneToggled =
    !isMobile &&
    showCommentLane &&
    (commentPanelMode === 'workspace' || commentsAvailableForActiveFile);
  const showInlineCommentLane =
    !isMobile &&
    (commentPanelMode === 'workspace'
      ? showCommentLane
      : commentsAvailableForActiveFile &&
        (draftCommentSelection !== null ||
          (showCommentLane &&
            (openCommentThreads.length > 0 || displayedResolvedThreads.length > 0))));
  const displayedCommentThreads = commentPanelMode === 'workspace' ? openWorkspaceCommentThreads : openCommentThreads;
  const displayedCommentsLoading = commentPanelMode === 'workspace' ? workspaceCommentsLoading : commentsLoading;
  const displayedCommentsError = commentPanelMode === 'workspace' ? workspaceCommentsError : commentsError;
  const commentBadgeCount =
    commentPanelMode === 'workspace' ? openWorkspaceCommentThreads.length : openCommentThreads.length;
  // Open + resolved threads on the active file — the doc-header toggle only
  // renders when this is non-zero (commenting starts from the selection bubble).
  const activeFileCommentCount = commentThreadsPath === activeFilePath ? commentThreads.length : 0;
  const commentDocumentLabel = activeWorkspaceFile
    ? formatFileName(getFileName(activeWorkspaceFile.path))
    : null;

  useLayoutEffect(() => {
    const editor = markdownEditorRef.current;
    if (!editor || editor.isDestroyed || commentPanelMode !== 'document' || !activeIsMarkdown) {
      // For code files the Monaco editor owns the offsets (via
      // reportCommentAnchors); don't clear them out from under it here.
      if (!activeIsCode) {
        setDocCommentAnchorOffsets({});
        setDraftCommentAnchorOffset(null);
      }
      return;
    }
    const rowNode = commentLaneRowRef.current;
    if (!rowNode) {
      setDocCommentAnchorOffsets({});
      setDraftCommentAnchorOffset(null);
      return;
    }

    let frame = 0;
    // Vertical center of a commented range, relative to the lane row. The panel
    // centers each card on this so the card's middle lines up with the text
    // (nicer than top-aligning). Spans the whole range when both ends map;
    // falls back to the start line when the end can't be measured.
    const rangeCenter = (from: number, to: number, rowTop: number) => {
      const start = editor.view.coordsAtPos(from);
      let top = start.top;
      let bottom = start.bottom;
      try {
        const end = editor.view.coordsAtPos(to);
        top = Math.min(top, end.top);
        bottom = Math.max(bottom, end.bottom);
      } catch {
        // Multi-line end not laid out yet → center on the start line.
      }
      return Math.max(0, Math.round((top + bottom) / 2 - rowTop));
    };
    const updateAnchorOffsets = () => {
      frame = 0;
      const rowRect = rowNode.getBoundingClientRect();
      const nextOffsets: Record<string, number> = {};
      for (const range of resolvedCommentRanges) {
        try {
          nextOffsets[range.id] = rangeCenter(range.from, range.to, rowRect.top);
        } catch {
          // Ignore anchors that no longer map cleanly during transient editor updates.
        }
      }
      let nextDraftOffset: number | null = null;
      if (draftCommentRange) {
        try {
          nextDraftOffset = rangeCenter(draftCommentRange.from, draftCommentRange.to, rowRect.top);
        } catch {
          nextDraftOffset = null;
        }
      }
      setDocCommentAnchorOffsets((current) => {
        const next = retainAnchorOffsets(current, nextOffsets, openCommentThreads.map((t) => t.id));
        const currentKeys = Object.keys(current);
        const nextKeys = Object.keys(next);
        if (currentKeys.length === nextKeys.length && nextKeys.every((key) => current[key] === next[key])) {
          return current;
        }
        return next;
      });
      setDraftCommentAnchorOffset((current) => (current === nextDraftOffset ? current : nextDraftOffset));
    };
    const scheduleAnchorOffsets = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateAnchorOffsets);
    };

    scheduleAnchorOffsets();
    const teardownReflow = observeCommentAnchorReflow(editor, scheduleAnchorOffsets);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      teardownReflow();
    };
  }, [activeIsCode, activeIsMarkdown, commentPanelMode, draftCommentRange, markdownEditor, openCommentThreads, resolvedCommentRanges]);

  const loadComments = useCallback(
    async (filePath: string, preferredThreadId?: string | null) => {
      if (!projectId) return;
      setCommentsLoading(true);
      setCommentsError(null);
      try {
        const response = await api(
          `/api/workspace/comments?projectId=${encodeURIComponent(projectId)}&filePath=${encodeURIComponent(filePath)}`,
        );
        if (!response.ok) {
          throw new Error(await readErrorMessage(response, 'Failed to load comments'));
        }
        const payload = (await response.json()) as { threads?: DocCommentThread[] };
        if (activeCommentFilePathRef.current !== filePath) return;
        const threads = withOptimistic(Array.isArray(payload.threads) ? payload.threads : [], filePath);
        setCommentThreads(threads);
        setCommentThreadsPath(filePath);
        setActiveCommentThreadId((current) => resolveActiveThreadId(threads, preferredThreadId ?? current));
        if (preferredThreadId) {
          pendingWorkspaceCommentThreadIdRef.current = null;
        }
      } catch (error) {
        if (activeCommentFilePathRef.current !== filePath) return;
        setCommentThreads([]);
        setCommentThreadsPath(filePath);
        setCommentsError(error instanceof Error ? error.message : 'Failed to load comments');
      } finally {
        if (activeCommentFilePathRef.current === filePath) {
          setCommentsLoading(false);
        }
      }
    },
    [api, projectId, withOptimistic],
  );

  const loadWorkspaceComments = useCallback(async () => {
    if (!projectId) return;
    setWorkspaceCommentsLoading(true);
    setWorkspaceCommentsError(null);
    try {
      const response = await api(
        `/api/workspace/comments?projectId=${encodeURIComponent(projectId)}&scope=workspace`,
      );
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, 'Failed to load workspace comments'));
      }
      const payload = (await response.json()) as { threads?: DocCommentThread[] };
      setWorkspaceCommentThreads(Array.isArray(payload.threads) ? payload.threads : []);
    } catch (error) {
      setWorkspaceCommentThreads([]);
      setWorkspaceCommentsError(error instanceof Error ? error.message : 'Failed to load workspace comments');
    } finally {
      setWorkspaceCommentsLoading(false);
    }
  }, [api, projectId]);

  const refreshWorkspaceComments = useCallback(() => {
    void loadWorkspaceComments();
  }, [loadWorkspaceComments]);

  const openCommentDraft = useCallback((selection: DraftDocCommentSelection) => {
    setCommentPanelMode('document');
    setDraftCommentSelection(selection);
    setDraftCommentBody('');
    setCommentContextMenu(null);
    setShowCommentLane(true);
    setActiveCommentThreadId(null);
  }, []);

  const openChatWithSelection = useCallback(
    (selection: DraftDocCommentSelection) => {
      dismissCommentContextMenu();
      window.dispatchEvent(
        new CustomEvent('sundial:add-chat-context', {
          detail: {
            text: selection.quote,
            path: activeWorkspaceFile?.path ?? null,
          },
        }),
      );
    },
    [activeWorkspaceFile?.path, dismissCommentContextMenu],
  );

  const openWorkspaceCommentThread = useCallback(
    (thread: DocCommentThread) => {
      const targetFile = workspaceFileByPath.get(thread.filePath);
      if (!targetFile) {
        setWorkspaceCommentsError(`Couldn't open ${thread.filePath}`);
        return;
      }
      pendingWorkspaceCommentThreadIdRef.current = thread.id;
      setCommentPanelMode('document');
      setShowCommentLane(true);
      setCommentContextMenu(null);
      setDraftCommentSelection(null);
      onSelectFile(targetFile.path);
      setActiveCommentThreadId(thread.id);
    },
    [onSelectFile, workspaceFileByPath],
  );

  const startCommentDraft = useCallback(() => {
    const editor = markdownEditorRef.current;
    if (!editor || !canCommentOnActiveFile) return false;
    const selection = buildDraftDocCommentSelection(editor);
    if (!selection) return false;
    openCommentDraft(selection);
    return true;
  }, [canCommentOnActiveFile, markdownEditor, openCommentDraft]);

  const applyCommentThreads = useCallback(
    (filePath: string, threads: DocCommentThread[], preferredThreadId?: string | null) => {
      // Tag with the path the mutation was issued for, NOT the current ref: if the
      // user switched files while the request was in flight, the ref already points
      // at the new file and these threads would render on the wrong document. Tagging
      // with `filePath` lets the `commentThreadsPath === activeFilePath` gate drop them.
      const decorated = withOptimistic(threads, filePath);
      setCommentThreads(decorated);
      setCommentThreadsPath(filePath);
      setCommentsError(null);
      setActiveCommentThreadId((current) => resolveActiveThreadId(decorated, preferredThreadId ?? current));
    },
    [withOptimistic],
  );

  const createComment = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!projectId || !activeWorkspaceFile || !draftCommentSelection || !trimmed) return;
      const filePath = activeWorkspaceFile.path;
      const selection = draftCommentSelection;
      const now = new Date().toISOString();
      const author = optimisticAuthor(currentUser);
      // Show the comment the instant Enter is pressed — the draft selection
      // carries the real anchor payload, so the editor resolves + highlights it
      // immediately; the POST then reconciles it into the server thread.
      const optimistic: DocCommentThread = {
        id: makeOptimisticId(),
        projectId,
        fileId: activeWorkspaceFile.id,
        filePath,
        quote: selection.quote,
        anchor: selection.anchor,
        head: selection.head,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        resolvedByUserId: null,
        author,
        messages: [optimisticMessage(trimmed, author, now)],
      };
      pendingThreadsRef.current = [...pendingThreadsRef.current, optimistic];
      // Drop any threads still held from a previous file (they're only gated by
      // commentThreadsPath, not cleared) so starting a comment before the new
      // file's load resolves can't surface the old file's threads in this lane.
      setCommentThreads((current) => [optimistic, ...current.filter((thread) => thread.filePath === filePath)]);
      setCommentThreadsPath(filePath);
      setActiveCommentThreadId(optimistic.id);
      setDraftCommentSelection(null);
      setShowCommentLane(true);
      setCommentsError(null);
      setCommentBusyAction('create');
      try {
        const response = await api('/api/workspace/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            filePath,
            quote: selection.quote,
            anchor: selection.anchor,
            head: selection.head,
            body: trimmed,
            // Cloud derives the author server-side (and ignores this); the
            // local sidecar has no identity provider and echoes it back, which
            // is what lets `withOptimistic` reconcile by author.userId.
            author,
          }),
        });
        if (!response.ok) {
          throw new Error(await readErrorMessage(response, 'Failed to create comment'));
        }
        const payload = (await response.json()) as { threads?: DocCommentThread[] };
        const threads = Array.isArray(payload.threads) ? payload.threads : [];
        // Newest thread is first (server orders by updated_at desc), so it
        // becomes the active selection as the optimistic card is swapped out.
        // Bind the persisted row to the optimistic id so the card keeps the same
        // React key (no remount / re-animation) through reconcile and reloads.
        pendingThreadsRef.current = pendingThreadsRef.current.filter((t) => t.id !== optimistic.id);
        const created = threads[0]?.id ?? null;
        if (created) {
          clientKeyByThreadIdRef.current[created] = optimistic.id;
          // Carry the optimistic card's measured lane offset onto the persisted
          // id. The offset map is keyed by thread id; without this the persisted
          // id has no offset for a frame, the card's `top` falls back to 0, and
          // the armed lane transition re-slides it — the "arrives again" bug.
          setDocCommentAnchorOffsets((prev) =>
            prev[optimistic.id] === undefined ? prev : { ...prev, [created]: prev[optimistic.id] },
          );
        }
        applyCommentThreads(filePath, threads, created);
        refreshWorkspaceComments();
      } catch (error) {
        pendingThreadsRef.current = pendingThreadsRef.current.filter((t) => t.id !== optimistic.id);
        // Roll back the optimistic thread.
        setCommentThreads((current) => current.filter((thread) => thread.id !== optimistic.id));
        setActiveCommentThreadId((current) => (current === optimistic.id ? null : current));
        // Hand the draft back — with the typed body — only if the user is still
        // on the originating file; otherwise restoring A's anchor under B would
        // let a retry create a comment anchored to the wrong document.
        if (activeCommentFilePathRef.current === filePath) {
          setDraftCommentBody(trimmed);
          setDraftCommentSelection(selection);
          setCommentsError(error instanceof Error ? error.message : 'Failed to create comment');
        }
      } finally {
        setCommentBusyAction(null);
      }
    },
    [activeWorkspaceFile, api, applyCommentThreads, currentUser, draftCommentSelection, projectId, refreshWorkspaceComments],
  );

  const replyToComment = useCallback(
    async (threadId: string, body: string) => {
      const trimmed = body.trim();
      if (!projectId || !activeWorkspaceFile || !trimmed) return;
      const filePath = activeWorkspaceFile.path;
      const now = new Date().toISOString();
      const message = optimisticMessage(trimmed, optimisticAuthor(currentUser), now);
      pendingMessagesRef.current = [...pendingMessagesRef.current, { threadId, message }];
      // Append the reply instantly, then reconcile from the server response.
      setCommentThreads((current) =>
        current.map((thread) =>
          thread.id === threadId
            ? { ...thread, updatedAt: now, messages: [...thread.messages, message] }
            : thread,
        ),
      );
      setCommentsError(null);
      setCommentBusyAction(`reply:${threadId}`);
      try {
        const response = await api('/api/workspace/comments', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            filePath,
            threadId,
            action: 'reply',
            body: trimmed,
            author: message.author, // ignored by cloud; echoed by the sidecar
          }),
        });
        if (!response.ok) {
          throw new Error(await readErrorMessage(response, 'Failed to reply'));
        }
        const payload = (await response.json()) as { threads?: DocCommentThread[] };
        pendingMessagesRef.current = pendingMessagesRef.current.filter((p) => p.message.id !== message.id);
        applyCommentThreads(filePath, Array.isArray(payload.threads) ? payload.threads : [], threadId);
        refreshWorkspaceComments();
      } catch (error) {
        pendingMessagesRef.current = pendingMessagesRef.current.filter((p) => p.message.id !== message.id);
        // Roll back just the optimistic message and hand the text back to the
        // reply box (it cleared on submit) so a transient failure doesn't lose it.
        setCommentThreads((current) =>
          current.map((thread) =>
            thread.id === threadId
              ? { ...thread, messages: thread.messages.filter((m) => m.id !== message.id) }
              : thread,
          ),
        );
        replyRestoreTokenRef.current += 1;
        setReplyRestore({ threadId, body: trimmed, token: replyRestoreTokenRef.current });
        setCommentsError(error instanceof Error ? error.message : 'Failed to reply');
      } finally {
        setCommentBusyAction(null);
      }
    },
    [activeWorkspaceFile, api, applyCommentThreads, currentUser, projectId, refreshWorkspaceComments],
  );

  const updateCommentStatus = useCallback(
    async (threadId: string, action: 'resolve' | 'reopen') => {
      if (!projectId || !activeWorkspaceFile) return;
      setCommentBusyAction(`${action}:${threadId}`);
      try {
        const response = await api('/api/workspace/comments', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            filePath: activeWorkspaceFile.path,
            threadId,
            action,
          }),
        });
        if (!response.ok) {
          throw new Error(
            await readErrorMessage(
              response,
              action === 'resolve' ? 'Failed to resolve comment' : 'Failed to reopen comment',
            ),
          );
        }
        const payload = (await response.json()) as { threads?: DocCommentThread[] };
        applyCommentThreads(
          activeWorkspaceFile.path,
          Array.isArray(payload.threads) ? payload.threads : [],
          action === 'resolve' ? null : threadId,
        );
        refreshWorkspaceComments();
      } catch (error) {
        setCommentsError(
          error instanceof Error
            ? error.message
            : action === 'resolve'
              ? 'Failed to resolve comment'
              : 'Failed to reopen comment',
        );
      } finally {
        setCommentBusyAction(null);
      }
    },
    [activeWorkspaceFile, api, applyCommentThreads, projectId, refreshWorkspaceComments],
  );

  const editCommentMessage = useCallback(
    async (thread: DocCommentThread, messageId: string, body: string) => {
      if (!projectId || !body.trim()) return;
      setCommentBusyAction(`edit:${messageId}`);
      try {
        const response = await api('/api/workspace/comments', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            filePath: thread.filePath,
            threadId: thread.id,
            messageId,
            action: 'edit',
            body: body.trim(),
          }),
        });
        if (!response.ok) {
          throw new Error(await readErrorMessage(response, 'Failed to edit comment'));
        }
        const payload = (await response.json()) as { threads?: DocCommentThread[] };
        if (activeWorkspaceFile?.path === thread.filePath) {
          applyCommentThreads(thread.filePath, Array.isArray(payload.threads) ? payload.threads : [], thread.id);
        }
        refreshWorkspaceComments();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to edit comment';
        setCommentsError(message);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        setCommentBusyAction(null);
      }
    },
    [activeWorkspaceFile, api, applyCommentThreads, projectId, refreshWorkspaceComments],
  );

  const deleteCommentMessage = useCallback(
    async (thread: DocCommentThread, messageId: string) => {
      if (!projectId) return;
      setCommentBusyAction(`delete:${messageId}`);
      try {
        const response = await api('/api/workspace/comments', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            filePath: thread.filePath,
            threadId: thread.id,
            messageId,
          }),
        });
        if (!response.ok) {
          throw new Error(await readErrorMessage(response, 'Failed to delete comment'));
        }
        const payload = (await response.json()) as { threads?: DocCommentThread[] };
        if (activeWorkspaceFile?.path === thread.filePath) {
          applyCommentThreads(thread.filePath, Array.isArray(payload.threads) ? payload.threads : [], thread.id);
        }
        refreshWorkspaceComments();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete comment';
        setCommentsError(message);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        setCommentBusyAction(null);
      }
    },
    [activeWorkspaceFile, api, applyCommentThreads, projectId, refreshWorkspaceComments],
  );

  const copyCommentLink = useCallback(
    async (thread: DocCommentThread, _messageId: string) => {
      if (typeof window === 'undefined' || !navigator.clipboard?.writeText) {
        showWorkspaceAppNotice('error', 'Clipboard access is not available in this browser.');
        return;
      }
      const params = { filePath: thread.filePath, commentThreadId: thread.id };
      const href = isLocalProject
        ? buildLocalProjectPath(projectId, params)
        : buildWorkspacePath(workspaceRouteId, params);
      const url = new URL(href, window.location.origin).toString();
      try {
        await navigator.clipboard.writeText(url);
        showWorkspaceAppNotice('success', 'Comment link copied.');
      } catch {
        showWorkspaceAppNotice('error', 'Failed to copy comment link.');
      }
    },
    [showWorkspaceAppNotice, workspaceRouteId, isLocalProject, projectId],
  );

  const resetActiveComment = useCallback(() => {
    setDraftCommentSelection(null);
    setCommentContextMenu(null);
    setActiveCommentThreadId(null);
  }, []);

  const cancelDraft = useCallback(() => {
    setDraftCommentSelection(null);
    setDraftCommentBody('');
  }, []);

  const closeLane = useCallback(() => {
    setShowCommentLane(false);
    resetActiveComment();
  }, [resetActiveComment]);

  const handleModeChange = useCallback(
    (mode: WorkspaceCommentMode) => {
      resetActiveComment();
      setShowCommentLane(true);
      setCommentPanelMode(mode);
      if (mode === 'workspace') {
        void loadWorkspaceComments();
      }
    },
    [loadWorkspaceComments, resetActiveComment],
  );

  const selectThread = useCallback((threadId: string | null) => {
    setCommentPanelMode('document');
    setDraftCommentSelection(null);
    setActiveCommentThreadId(threadId);
    // Clicking commented text (or a card) reveals the lane so the selected
    // thread's emphasis is actually visible, Google-Docs style.
    if (threadId) setShowCommentLane(true);
  }, []);

  const toggleCommentLane = useCallback(() => {
    const targetMode = commentsAvailableForActiveFile ? 'document' : 'workspace';
    const shouldClose = showCommentLane && commentPanelMode === targetMode;
    setCommentContextMenu(null);
    setDraftCommentSelection(null);
    setCommentPanelMode(targetMode);
    if (targetMode === 'workspace') {
      setActiveCommentThreadId(null);
    }
    setShowCommentLane(!shouldClose);
    if (shouldClose) {
      setActiveCommentThreadId(null);
    }
  }, [commentPanelMode, commentsAvailableForActiveFile, showCommentLane]);

  useEffect(() => {
    if (!projectId || !activeWorkspaceFile || !commentsAvailableForActiveFile) {
      setCommentThreads([]);
      setCommentThreadsPath(activeFilePath);
      setCommentsLoading(false);
      setCommentsError(null);
      return;
    }
    void loadComments(activeWorkspaceFile.path, pendingWorkspaceCommentThreadIdRef.current);
  }, [activeFilePath, commentsAvailableForActiveFile, activeWorkspaceFile, loadComments, projectId]);

  useEffect(() => {
    if (!projectId || !showCommentLane || commentPanelMode !== 'workspace') return;
    void loadWorkspaceComments();
  }, [commentPanelMode, loadWorkspaceComments, projectId, showCommentLane]);

  useEffect(() => {
    if (!projectId || !supabaseClient) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- realtime overloads
    const channel = supabaseClient.channel(`workspace-comments-${projectId}`) as any;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;
    const reloadNow = () => {
      if (disposed) return;
      const currentPath = activeCommentFilePathRef.current;
      if (currentPath) {
        void loadComments(currentPath);
      }
      void loadWorkspaceComments();
    };
    const scheduleReload = () => {
      if (disposed || reloadTimer) return;
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        reloadNow();
      }, 150);
    };
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'doc_comment_threads', filter: `project_id=eq.${projectId}` },
      scheduleReload,
    );
    // Realtime is silently flaky on some envs (CHANNEL_ERROR) — when it isn't
    // healthy, fall back to a short poll so agent/teammate comment replies still
    // surface within a few seconds instead of waiting on a dead subscription.
    // The `disposed` guard matters: cleanup's removeChannel() fires this callback
    // with CLOSED, and without it we'd start a poller after teardown that leaks.
    channel.subscribe((status: string) => {
      if (disposed) return;
      if (status === 'SUBSCRIBED') {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (!pollTimer) pollTimer = setInterval(reloadNow, 4000);
      }
    });
    return () => {
      disposed = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      if (pollTimer) clearInterval(pollTimer);
      supabaseClient.removeChannel(channel);
    };
  }, [loadComments, loadWorkspaceComments, projectId, supabaseClient]);

  // Local workspaces have no Supabase realtime; the sidecar's SSE stream
  // (comments-changed) fills the same role with the same debounced reload.
  useEffect(() => {
    if (!projectId || !subscribeToChanges) return;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeToChanges(() => {
      if (reloadTimer) return;
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        const currentPath = activeCommentFilePathRef.current;
        if (currentPath) void loadComments(currentPath);
        void loadWorkspaceComments();
      }, 150);
    });
    return () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      unsubscribe();
    };
  }, [loadComments, loadWorkspaceComments, projectId, subscribeToChanges]);

  useEffect(() => {
    if (!canCommentOnActiveFile || !markdownEditorRef.current) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isCreateCommentShortcut(event)) {
        dismissCommentContextMenu();
        event.preventDefault();
        event.stopPropagation();
        startCommentDraft();
      }
      if (event.key === 'Escape') {
        dismissCommentContextMenu();
      }
    };
    // The editor bubble menu's Comment button — same flow as the shortcut.
    // preventDefault signals "draft opened" back to the button, which then
    // collapses the text selection so the bubble yields to the composer.
    const handleStartDraftEvent = (event: Event) => {
      dismissCommentContextMenu();
      if (startCommentDraft()) event.preventDefault();
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('sundial:start-comment-draft', handleStartDraftEvent);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('sundial:start-comment-draft', handleStartDraftEvent);
    };
  }, [canCommentOnActiveFile, dismissCommentContextMenu, markdownEditor, startCommentDraft]);

  useEffect(() => {
    const editor = markdownEditorRef.current;
    if (!canCommentOnActiveFile || !editor) return;
    const dom = editor.view.dom;
    const handleContextMenu = (event: MouseEvent) => {
      if (isMarkdownImageContextMenuTarget(event.target)) return;
      // No prior selection? Right-click collapses it to the click point, so
      // grab the word under the pointer first — otherwise there's nothing to
      // comment on and we'd fall through to the browser's native menu.
      selectWordAtCoords(editor.view, event.clientX, event.clientY);
      const selection = buildDraftDocCommentSelection(editor);
      if (!selection) return;
      event.preventDefault();
      // Block CollabEditor's fallback context-menu handler so we don't end up
      // with two stacked menus (the full comment menu + the link-only fallback).
      event.stopImmediatePropagation();
      setCommentContextMenu({
        x: event.clientX,
        y: event.clientY,
        selection,
      });
    };
    dom.addEventListener('contextmenu', handleContextMenu, true);
    return () => {
      dom.removeEventListener('contextmenu', handleContextMenu, true);
    };
  }, [canCommentOnActiveFile, markdownEditor]);

  useEffect(() => {
    window.addEventListener('sundial:add-chat-context', dismissCommentContextMenu);
    return () => window.removeEventListener('sundial:add-chat-context', dismissCommentContextMenu);
  }, [dismissCommentContextMenu]);

  useEffect(() => {
    if (!commentContextMenu) return;
    const close = () => setCommentContextMenu(null);
    const handleMouseDown = (event: MouseEvent) => {
      if (commentMenuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [commentContextMenu]);

  useEffect(() => {
    const key = projectId && deepLinkedCommentThreadId ? `${projectId}:${deepLinkedCommentThreadId}` : null;
    if (!key) {
      autoCommentHandledRef.current = null;
      return;
    }
    if (!hasMounted || !filesLoaded || !deepLinkedWorkspaceFile) return;
    if (selectedFilePath !== deepLinkedWorkspaceFile.path) return;
    if (autoCommentHandledRef.current === key) return;
    autoCommentHandledRef.current = key;

    pendingWorkspaceCommentThreadIdRef.current = deepLinkedCommentThreadId;
    setCommentPanelMode('document');
    setShowCommentLane(true);
    setDraftCommentSelection(null);
    setCommentContextMenu(null);
    setActiveCommentThreadId(deepLinkedCommentThreadId);
    onOpenSpace();
  }, [
    deepLinkedCommentThreadId,
    deepLinkedWorkspaceFile,
    filesLoaded,
    hasMounted,
    onOpenSpace,
    projectId,
    selectedFilePath,
  ]);

  return {
    commentLaneRowRef,
    commentsAvailableForActiveFile,
    canCommentOnActiveFile,
    resolvedCommentRanges,
    draftCommentRange,
    openCommentThreads,
    reportCommentAnchors,
    showInlineCommentLane,
    commentsLaneToggled,
    displayedCommentThreads,
    displayedResolvedThreads,
    displayedCommentsLoading,
    displayedCommentsError,
    commentBadgeCount,
    activeFileCommentCount,
    commentDocumentLabel,
    commentPanelMode,
    docCommentAnchorOffsets,
    draftCommentAnchorOffset,
    activeCommentThreadId,
    draftCommentSelection,
    draftCommentBody,
    replyRestore,
    commentBusyAction,
    toggleCommentLane,
    resetActiveComment,
    handleModeChange,
    selectThread,
    openWorkspaceCommentThread,
    closeLane,
    createComment,
    cancelDraft,
    replyToComment,
    updateCommentStatus,
    editCommentMessage,
    deleteCommentMessage,
    copyCommentLink,
    contextMenu: commentContextMenu,
    openContextMenuDraft: openCommentDraft,
    openContextMenuChat: openChatWithSelection,
    dismissContextMenu: dismissCommentContextMenu,
    commentMenuRef,
  };
}

export function WorkspaceCommentContextMenu({
  menu,
  menuRef,
  onOpenDraft,
  onOpenChat,
  onAddLink,
}: {
  menu: CommentContextMenu | null;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onOpenDraft: (selection: DraftDocCommentSelection) => void;
  onOpenChat: (selection: DraftDocCommentSelection) => void;
  onAddLink?: () => void;
}) {
  if (!menu) return null;
  return (
    <div
      ref={menuRef}
      className="fixed z-[65] min-w-[220px] rounded-xl border border-[#dadce0] bg-white p-1.5 shadow-[0_1px_2px_rgba(60,64,67,0.3),0_2px_6px_2px_rgba(60,64,67,0.15)]"
      style={{
        top: Math.max(12, menu.y - 1),
        left: Math.max(12, menu.x - 1),
      }}
    >
      <button
        type="button"
        onClick={() => onOpenChat(menu.selection)}
        className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm text-[#202124] transition-colors hover:bg-[#f1f3f4]"
      >
        <span className="inline-flex items-center gap-2">
          <ChatCircleIcon className="h-4 w-4 text-[#5f6368]" weight="regular" />
          Open chat
        </span>
      </button>
      <button
        type="button"
        onClick={() => onOpenDraft(menu.selection)}
        className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm text-[#202124] transition-colors hover:bg-[#f1f3f4]"
      >
        <span className="inline-flex items-center gap-2">
          <ChatTeardropIcon className="h-4 w-4 text-[#5f6368]" weight="regular" />
          Comment
        </span>
        <span className="text-[11px] text-[#5f6368]">Cmd Opt M</span>
      </button>
      {onAddLink ? (
        <button
          type="button"
          onClick={onAddLink}
          className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm text-[#202124] transition-colors hover:bg-[#f1f3f4]"
        >
          <span className="inline-flex items-center gap-2">
            <LinkSimpleIcon className="h-4 w-4 text-[#5f6368]" weight="regular" />
            Add link
          </span>
          <span className="text-[11px] text-[#5f6368]">⌘K</span>
        </button>
      ) : null}
    </div>
  );
}
