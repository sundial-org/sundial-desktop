'use client';

import { useEffect, useRef, type MutableRefObject } from 'react';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { shouldFallBackToFullScreenChat } from '@/lib/workspace/layout';
import { idMatchesRef } from '@/lib/workspace/public-ids';
import { isMetaPath } from './workspace-file-helpers';

type WorkspaceViewMode = 'chat' | 'space';

export function useWorkspaceStartupIntents({
  hasMounted,
  projectId,
  chatsLoaded,
  chatsProjectId,
  preferencesLoaded,
  filesLoaded,
  canWrite,
  chatThreadsCount,
  isChatMode,
  chatSurfaceOpen,
  isMobile,
  deepLinkedFileId,
  deepLinkedFilePath,
  deepLinkedWorkspaceFile,
  selectedDirectChatId,
  didAutoOpenInitialChatRef,
  startBlankChat,
  openChatById,
  setWorkspaceViewMode,
  revealChatFullScreen,
  setSelectedFilePath,
  setMobilePanel,
  setShowMetaFiles,
}: {
  hasMounted: boolean;
  projectId: string;
  chatsLoaded: boolean;
  chatsProjectId: string | null;
  preferencesLoaded: boolean;
  filesLoaded: boolean;
  /** Resolved with the files payload — optimistically true before that. */
  canWrite: boolean;
  chatThreadsCount: number;
  isChatMode: boolean;
  /** Chat is part of the arrival layout (explicit chat link / stored chat
   *  layout). False on the file-first default, where nothing may take the
   *  center over once the chat list resolves. */
  chatSurfaceOpen: boolean;
  isMobile: boolean;
  deepLinkedFileId: string | null;
  deepLinkedFilePath: string | null;
  deepLinkedWorkspaceFile: WorkspaceFileRow | null;
  selectedDirectChatId: string | null;
  didAutoOpenInitialChatRef: MutableRefObject<boolean>;
  startBlankChat: () => Promise<unknown>;
  openChatById: (chatId: string, opts?: { sidePanel?: boolean }) => Promise<string | null>;
  setWorkspaceViewMode: (mode: WorkspaceViewMode) => void;
  /** Replace the center with chat alone (stale deep-linked file → take over). */
  revealChatFullScreen: () => void;
  setSelectedFilePath: (path: string) => void;
  setMobilePanel: (panel: 'files' | null) => void;
  setShowMetaFiles: (value: boolean) => void;
}) {
  const autoFileHandledRef = useRef<string | null>(null);
  const autoChatHandledRef = useRef<string | null>(null);
  const autoChatPendingRef = useRef<string | null>(null);
  const staleFileFallbackRef = useRef(false);

  useEffect(() => {
    if (didAutoOpenInitialChatRef.current) return;
    if (!hasMounted || !projectId || !chatsLoaded || !preferencesLoaded) return;
    if (chatsProjectId !== projectId) return;
    if (chatThreadsCount > 0) {
      didAutoOpenInitialChatRef.current = true;
      return;
    }

    if (deepLinkedFileId || deepLinkedFilePath) {
      if (!filesLoaded) return;
      if (deepLinkedWorkspaceFile) {
        didAutoOpenInitialChatRef.current = true;
        return;
      }
    }

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('chatId')) return;

    // canWrite is optimistic until the files payload resolves — wait, or a
    // read-only guest gets a blank chat opened OVER the shared document. A
    // resolved read-only visitor never gets one: their composer is disabled,
    // and the arrival swap owns their landing surface.
    if (!filesLoaded) return;
    if (!canWrite) {
      didAutoOpenInitialChatRef.current = true;
      return;
    }

    // File-first arrival: a workspace whose chat list comes back empty must
    // not pull the center off the document the landing already placed. The
    // rail's auto-draft still gives this workspace a ready chat (page.tsx,
    // `deferTab`); opening it is the user's click on the Chats section.
    if (!chatSurfaceOpen) {
      didAutoOpenInitialChatRef.current = true;
      return;
    }

    if (!isChatMode) {
      setWorkspaceViewMode('chat');
    }

    didAutoOpenInitialChatRef.current = true;
    void startBlankChat();
  }, [
    canWrite,
    chatSurfaceOpen,
    chatThreadsCount,
    chatsProjectId,
    chatsLoaded,
    deepLinkedFileId,
    deepLinkedFilePath,
    deepLinkedWorkspaceFile,
    didAutoOpenInitialChatRef,
    filesLoaded,
    hasMounted,
    isChatMode,
    preferencesLoaded,
    projectId,
    setWorkspaceViewMode,
    startBlankChat,
  ]);

  useEffect(() => {
    const deepLinkedWorkspaceFileKey = deepLinkedFileId ?? deepLinkedFilePath;
    const key = projectId && deepLinkedWorkspaceFileKey ? `${projectId}:${deepLinkedWorkspaceFileKey}` : null;
    if (!key) {
      autoFileHandledRef.current = null;
      return;
    }
    if (!hasMounted || !filesLoaded || !deepLinkedWorkspaceFile) return;
    if (autoFileHandledRef.current === key) return;
    autoFileHandledRef.current = key;

    setSelectedFilePath(deepLinkedWorkspaceFile.path);
    setWorkspaceViewMode('space');
    if (isMobile) {
      setMobilePanel(null);
    }
    if (isMetaPath(deepLinkedWorkspaceFile.path)) {
      setShowMetaFiles(true);
    }
  }, [
    deepLinkedFileId,
    deepLinkedFilePath,
    deepLinkedWorkspaceFile,
    filesLoaded,
    hasMounted,
    isMobile,
    projectId,
    setMobilePanel,
    setSelectedFilePath,
    setShowMetaFiles,
    setWorkspaceViewMode,
  ]);

  // A deep-linked file that no longer resolves (deleted/stale share link)
  // would otherwise leave the optimistic space-mode restore showing an empty
  // editor with the chat only docked beside it. Once files load and the file
  // is confirmed missing — and was never opened (so this can't yank a session
  // whose file was later deleted) — fall back to full-screen chat so the valid
  // chat is shown, as it was before the deep-link layout changes.
  useEffect(() => {
    if (!hasMounted || !filesLoaded || staleFileFallbackRef.current) return;
    const fallBack = shouldFallBackToFullScreenChat({
      hasDeepLinkedFile: Boolean(deepLinkedFileId || deepLinkedFilePath),
      fileResolved: Boolean(deepLinkedWorkspaceFile),
      fileAlreadyOpened: Boolean(autoFileHandledRef.current),
      hasSelectedChat: Boolean(selectedDirectChatId),
      isChatMode,
    });
    if (!fallBack) return;
    staleFileFallbackRef.current = true;
    // The deep-linked file is gone — take over with full-screen chat (close the
    // empty editor) rather than additively docking chat beside it.
    revealChatFullScreen();
  }, [
    deepLinkedFileId,
    deepLinkedFilePath,
    deepLinkedWorkspaceFile,
    filesLoaded,
    hasMounted,
    isChatMode,
    selectedDirectChatId,
    revealChatFullScreen,
  ]);

  useEffect(() => {
    if (!hasMounted || !projectId || !chatsLoaded) return;
    if (chatsProjectId !== projectId) return;
    const urlParams = new URLSearchParams(window.location.search);
    const chatIdParam = urlParams.get('chatId');
    if (!chatIdParam) return;

    const key = `${projectId}:${chatIdParam}`;
    // The URL mirror writes a short id ref (see toShortIdRef), so the
    // already-selected check must match by prefix, not equality.
    if (selectedDirectChatId && idMatchesRef(selectedDirectChatId, chatIdParam)) {
      autoChatHandledRef.current = key;
      autoChatPendingRef.current = null;
      return;
    }
    if (autoChatHandledRef.current === key || autoChatPendingRef.current === key) return;

    autoChatPendingRef.current = key;
    let cancelled = false;
    // A co-deep-linked file means "show the file with the chat beside it":
    // open the chat in the side panel (both-mode) instead of taking over the
    // whole view, so the editor the layout just restored isn't yanked away.
    const sidePanel = Boolean(deepLinkedFileId || deepLinkedFilePath);
    void (async () => {
      const opened = await openChatById(chatIdParam, { sidePanel });
      if (!cancelled && opened) {
        autoChatHandledRef.current = key;
      }
      if (autoChatPendingRef.current === key) {
        autoChatPendingRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatsLoaded, chatsProjectId, deepLinkedFileId, deepLinkedFilePath, hasMounted, openChatById, projectId, selectedDirectChatId]);
}
