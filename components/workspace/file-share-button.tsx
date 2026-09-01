'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CheckIcon,
  ExportIcon,
  GlobeHemisphereWestIcon,
  LockSimpleIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';

/** What the current file's access looks like: 'public' — reachable by anyone
 *  with a link (per-path link grant, workspace root grant, or legacy public);
 *  'shared' — named people beyond the owner; 'private' — nobody else. */
export type FileShareStatus = 'private' | 'shared' | 'public';

// Per-file Share control in the doc header. One click, one outcome: the share
// modal. It used to open a popover whose two entries were "Copy link to file"
// and a "Share…" that opened that same modal — and the modal already carries
// copy-link, so the menu was a stop on the way to itself. Copy-link survives
// only as the fallback for viewers who have no share modal to open.
export function FileShareButton({
  fileUrl,
  onOpenWorkspaceShare,
  onShareFile,
  shareStatus = 'private',
  variant = 'button',
}: {
  /** URL used by the copy-link fallback when no share modal is available. */
  fileUrl: string | null;
  /** Fallback for callers with no per-file modal: the workspace share modal. */
  onOpenWorkspaceShare?: () => void;
  /** Share THIS file: the path-share modal (cloud) or the sidecar bridge
   *  share (local). Preferred over the workspace modal when available. */
  onShareFile?: () => void;
  /** Access this file already has — the icon reflects it, so the header says
   *  whether the doc is out there without opening the modal. */
  shareStatus?: FileShareStatus;
  /** 'status': the compact form riding next to the file name (PR #1086) —
   *  a lock while private, smaller hit target, own testid. Same click
   *  behavior including the copy-link fallback for modal-less viewers. */
  variant?: 'button' | 'status';
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const openShare = onShareFile ?? onOpenWorkspaceShare ?? null;
  if (!openShare && !fileUrl) return null;

  const status = variant === 'status';
  const StatusIcon =
    shareStatus === 'public'
      ? GlobeHemisphereWestIcon
      : shareStatus === 'shared'
        ? UsersThreeIcon
        : status
          ? LockSimpleIcon
          : ExportIcon;
  const statusLabel =
    shareStatus === 'public'
      ? 'Shared by link'
      : shareStatus === 'shared'
        ? 'Shared with people'
        : status
          ? 'Private · share'
          : 'Share file';
  const iconClass = status ? 'h-3.5 w-3.5' : 'h-4 w-4';

  return (
    <button
      type="button"
      onClick={() => {
        if (openShare) {
          openShare();
          return;
        }
        void navigator.clipboard.writeText(fileUrl!).then(() => setCopied(true), () => {});
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopied(false), 900);
      }}
      aria-label={openShare ? 'Share file' : 'Copy link to file'}
      data-testid={status ? 'doc-share-status' : 'file-share-button'}
      data-share-status={shareStatus}
      className={`relative group/tip inline-flex items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600 ${
        status ? 'ml-1 h-5 w-5 shrink-0' : 'h-7 w-7'
      }`}
    >
      {copied ? (
        <CheckIcon className={`${iconClass} text-emerald-600`} weight="bold" aria-hidden />
      ) : (
        <StatusIcon className={iconClass} weight="regular" aria-hidden />
      )}
      <IconTooltip label={openShare ? statusLabel : copied ? 'Copied' : 'Copy link to file'} side="bottom" />
    </button>
  );
}
