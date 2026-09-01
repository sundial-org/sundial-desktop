'use client';

import { useEffect, useRef, useState } from 'react';
import {
  FileTextIcon,
  FolderSimpleIcon,
  GlobeHemisphereWestIcon,
  UserIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { AnchoredDropdown, isInFloatingActionMenu } from '@/components/workspace/anchored-dropdown';

/** Workspace share status glyph: private = you, shared = people, public = globe. */
function ShareStatusIcon({ status, className }: { status: string | null | undefined; className: string }) {
  if (status === 'public') {
    return <GlobeHemisphereWestIcon className={className} weight="regular" aria-hidden />;
  }
  if (status === 'shared') {
    return <UsersThreeIcon className={className} weight="regular" aria-hidden />;
  }
  return <UserIcon className={className} weight="regular" aria-hidden />;
}

/**
 * Top-right Share button (back after PR #1038 removed it — founder review
 * 2026-08-04). One button, scope on the way in: with a file open it drops a
 * menu naming what you're about to share — the file, its folder, or the
 * workspace — and routes to the share surface that already owns that scope
 * (path-share modal / local share modal / workspace modal). With no file
 * open there is only one scope, so the click goes straight to the
 * workspace modal.
 */
export function TopbarShareButton({
  shareStatus,
  fileName,
  folderPath,
  onShareFile,
  onShareFolder,
  onShareWorkspace,
}: {
  /** Workspace access status for the glyph; null (local) renders the private glyph. */
  shareStatus: string | null;
  /** Active file's display name; null when no file is open. */
  fileName: string | null;
  /** Active file's parent folder path ('' / null when at the root). */
  folderPath: string | null;
  /** Opens the share surface that owns the active file's audience. */
  onShareFile: (() => void) | null;
  /** Opens the folder-scope share for the active file's parent. */
  onShareFolder: (() => void) | null;
  onShareWorkspace: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      // The dropdown panel is portaled to document.body — the floating-menu
      // marker, not DOM ancestry, says a click landed inside it.
      if (isInFloatingActionMenu(event.target)) return;
      if (wrapRef.current && event.target instanceof Node && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const folderName = folderPath ? folderPath.split('/').pop() ?? folderPath : null;
  const scopedEntries = [
    onShareFile && fileName
      ? { key: 'file', label: fileName, icon: FileTextIcon, onSelect: onShareFile }
      : null,
    onShareFolder && folderName
      ? { key: 'folder', label: `${folderName}/`, icon: FolderSimpleIcon, onSelect: onShareFolder }
      : null,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return (
    <div ref={wrapRef} className="relative flex items-center">
      <button
        type="button"
        ref={(node) => {
          anchorRef.current = node;
        }}
        onClick={() => {
          // One scope → no menu stop on the way to it.
          if (scopedEntries.length === 0) {
            setOpen(false);
            onShareWorkspace();
            return;
          }
          setOpen((value) => !value);
        }}
        aria-label="Share"
        aria-expanded={open}
        data-testid="topbar-share"
        // Word only, no glyph (founder review 2026-08-04): the workspace
        // status icon read as mystery chrome next to a now multi-scope
        // button. Scope state lives where the scopes do — the doc header's
        // per-file icon and this menu's workspace row.
        className="bg-stone-900 text-white px-3 lg:px-4 py-1.5 rounded-lg text-sm font-medium inline-flex items-center cursor-pointer"
      >
        Share
      </button>
      <AnchoredDropdown open={open} anchorRef={anchorRef} align="right" className="w-56 rounded-md border border-stone-200 bg-white py-1 text-xs shadow-lg">
        {[
          ...scopedEntries,
          { key: 'workspace', label: 'Workspace', icon: null, onSelect: onShareWorkspace },
        ].map((entry) => (
          <button
            key={entry.key}
            type="button"
            data-testid={`topbar-share-${entry.key}`}
            onClick={() => {
              setOpen(false);
              entry.onSelect();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            {entry.icon ? (
              <entry.icon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
            ) : (
              <ShareStatusIcon status={shareStatus} className="h-3.5 w-3.5 flex-shrink-0" />
            )}
            <span className="truncate">{entry.label}</span>
          </button>
        ))}
      </AnchoredDropdown>
    </div>
  );
}
