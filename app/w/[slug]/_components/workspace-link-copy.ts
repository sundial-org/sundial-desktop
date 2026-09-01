'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { buildWorkspaceChatPath, buildWorkspaceFilePath } from '@/lib/workspace/paths';
import { PATH_SHARE_TOKEN_PARAM } from '@/lib/workspace/path-grants';
import { track } from '@/lib/analytics/track';

import type { WorkspaceRouteInput } from '@/lib/workspace/public-ids';

// The page's own route id, `local` flag included — these hooks forward it
// straight to buildWorkspacePath, which is what keeps a local project's
// links and redirects off the cloud `/w/` route.
type WorkspaceRouteId = WorkspaceRouteInput;

export function useWorkspaceLinkCopy({
  projectId,
  workspaceRouteId,
  setOpenMenuPath,
  getShareToken,
}: {
  projectId: string;
  workspaceRouteId: WorkspaceRouteId;
  setOpenMenuPath: (value: string | null) => void;
  /** WORKSPACE-ROOT grant token only (owners from the share payload, root
   *  guests from their own URL; a getter because that state loads after this
   *  hook mounts): on a root-link-shared workspace the ?pshare= token IS the
   *  capability, so copied links must carry it or recipients land on a 404.
   *  The caller owns the root-only policy — a NARROW file/chat token must
   *  never be appended here, or an unrelated copied link would leak that
   *  scope to its recipient. */
  getShareToken?: () => string | null;
}) {
  const linkFor = useCallback(
    (path: string) => {
      const token = getShareToken?.() ?? null;
      const suffix = token
        ? `${path.includes('?') ? '&' : '?'}${PATH_SHARE_TOKEN_PARAM}=${token}`
        : '';
      return `${window.location.origin}${path}${suffix}`;
    },
    [getShareToken],
  );
  const [copiedChatLinkId, setCopiedChatLinkId] = useState<string | null>(null);
  const [copiedFileLinkId, setCopiedFileLinkId] = useState<string | null>(null);
  const chatLinkCopyTimeoutRef = useRef<number | null>(null);
  const fileLinkCopyTimeoutRef = useRef<number | null>(null);

  const handleCopyChatLink = useCallback(async (chatId: string) => {
    if (!projectId) return;
    const link = linkFor(buildWorkspaceChatPath(workspaceRouteId, chatId));
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
  }, [linkFor, projectId, workspaceRouteId]);

  const handleCopyFileLink = useCallback(async (file: WorkspaceFileRow) => {
    if (!projectId) return;
    if (file.type === 'folder' || file.type === 'proposal') return;
    const link = linkFor(buildWorkspaceFilePath(workspaceRouteId, file.id));
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
  }, [linkFor, projectId, setOpenMenuPath, workspaceRouteId]);

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
