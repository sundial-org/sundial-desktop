'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { buildWorkspaceChatPath, buildWorkspaceFilePath } from '@/lib/workspace/paths';
import { track } from '@/lib/analytics/track';

type WorkspaceRouteId = string | { id: string; public_id: string | null };

export function useWorkspaceLinkCopy({
  projectId,
  workspaceRouteId,
  setOpenMenuPath,
}: {
  projectId: string;
  workspaceRouteId: WorkspaceRouteId;
  setOpenMenuPath: (value: string | null) => void;
}) {
  const [copiedChatLinkId, setCopiedChatLinkId] = useState<string | null>(null);
  const [copiedFileLinkId, setCopiedFileLinkId] = useState<string | null>(null);
  const chatLinkCopyTimeoutRef = useRef<number | null>(null);
  const fileLinkCopyTimeoutRef = useRef<number | null>(null);

  const handleCopyChatLink = useCallback(async (chatId: string) => {
    if (!projectId) return;
    const link = `${window.location.origin}${buildWorkspaceChatPath(workspaceRouteId, chatId)}`;
    track('share_copy_link_clicked', { projectId, chatId, kind: 'chat' });
    try {
      await navigator.clipboard.writeText(link);
      setCopiedChatLinkId(chatId);
      if (chatLinkCopyTimeoutRef.current) {
        window.clearTimeout(chatLinkCopyTimeoutRef.current);
      }
      chatLinkCopyTimeoutRef.current = window.setTimeout(() => setCopiedChatLinkId(null), 2000);
    } catch {
      setCopiedChatLinkId(null);
    }
  }, [projectId, workspaceRouteId]);

  const handleCopyFileLink = useCallback(async (file: WorkspaceFileRow) => {
    if (!projectId) return;
    if (file.type === 'folder' || file.type === 'proposal') return;
    const link = `${window.location.origin}${buildWorkspaceFilePath(workspaceRouteId, file.id)}`;
    track('share_copy_link_clicked', {
      projectId,
      fileId: file.id,
      path: file.path,
      kind: 'file',
    });
    try {
      await navigator.clipboard.writeText(link);
      setOpenMenuPath(null);
      setCopiedFileLinkId(file.id);
      if (fileLinkCopyTimeoutRef.current) {
        window.clearTimeout(fileLinkCopyTimeoutRef.current);
      }
      fileLinkCopyTimeoutRef.current = window.setTimeout(() => setCopiedFileLinkId(null), 2000);
    } catch {
      setCopiedFileLinkId(null);
    }
  }, [projectId, setOpenMenuPath, workspaceRouteId]);

  useEffect(() => {
    return () => {
      if (chatLinkCopyTimeoutRef.current) {
        window.clearTimeout(chatLinkCopyTimeoutRef.current);
      }
      if (fileLinkCopyTimeoutRef.current) {
        window.clearTimeout(fileLinkCopyTimeoutRef.current);
      }
    };
  }, []);

  return {
    copiedChatLinkId,
    copiedFileLinkId,
    handleCopyChatLink,
    handleCopyFileLink,
  };
}
