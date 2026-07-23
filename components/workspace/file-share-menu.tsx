'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, ExportIcon, LinkSimpleIcon, ShareNetworkIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';

// Per-file Share control in the doc header (replaces the bare Copy-file-link
// button). A small popover holding the file-scoped share actions — copy link
// today; per-path share links (path_shares) slot in here later.
export function FileShareMenu({
  fileUrl,
  onOpenWorkspaceShare,
  onShareFile,
}: {
  /** URL for "Copy link to file" (the old Copy-file-link behavior). */
  fileUrl: string | null;
  /** Cloud: opens the workspace share modal. */
  onOpenWorkspaceShare?: () => void;
  /** Local: share this file to a cloud workspace (sidecar bridge). */
  onShareFile?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const item = (label: string, icon: ReactNode, onClick: () => void, testid?: string) => (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Share file"
        aria-expanded={open}
        data-testid="file-share-button"
        className={`relative group/tip inline-flex h-7 w-7 items-center justify-center rounded hover:bg-stone-100 ${
          open ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'
        }`}
      >
        <ExportIcon className="h-4 w-4" weight="regular" aria-hidden />
        {open ? null : <IconTooltip label="Share file" side="bottom" />}
      </button>
      {open ? (
        <div
          data-testid="file-share-menu"
          className="absolute right-0 top-full z-40 mt-1 min-w-[200px] rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
        >
          {fileUrl
            ? item(
                copied ? 'Copied' : 'Copy link to file',
                copied ? (
                  <CheckIcon className="h-3.5 w-3.5 shrink-0 text-emerald-600" weight="bold" aria-hidden />
                ) : (
                  <LinkSimpleIcon className="h-3.5 w-3.5 shrink-0" weight="regular" aria-hidden />
                ),
                () => {
                  void navigator.clipboard.writeText(fileUrl).then(
                    () => setCopied(true),
                    () => {},
                  );
                  if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
                  copyTimerRef.current = setTimeout(() => {
                    setCopied(false);
                    setOpen(false);
                  }, 900);
                },
                'file-share-copy-link',
              )
            : null}
          {onShareFile
            ? item(
                'Share this file…',
                <ShareNetworkIcon className="h-3.5 w-3.5 shrink-0" weight="regular" aria-hidden />,
                () => {
                  setOpen(false);
                  onShareFile();
                },
                'file-share-local',
              )
            : null}
          {onOpenWorkspaceShare
            ? item(
                'Share workspace…',
                <UsersThreeIcon className="h-3.5 w-3.5 shrink-0" weight="regular" aria-hidden />,
                () => {
                  setOpen(false);
                  onOpenWorkspaceShare();
                },
                'file-share-workspace',
              )
            : null}
        </div>
      ) : null}
    </div>
  );
}
