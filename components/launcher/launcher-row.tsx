'use client';

import Link from 'next/link';
import { ChatCircleIcon, CloudIcon, FileIcon, FolderSimpleIcon } from '@phosphor-icons/react';

/** One row of a launcher list — a folder on this computer, a cloud workspace,
 *  a chat, or a shared file. Shared by the desktop home (/local) and the
 *  dashboard, so both surfaces stay one design. Renders a link when `href` is
 *  given (real navigation semantics, middle-click included), a button
 *  otherwise. `active` marks the keyboard cursor. `owner` and `location` are
 *  Drive-style right-aligned columns ("me" / a name, "Cloud" / "Local" /
 *  "Shared with you"), hidden on narrow screens; `meta` is right-aligned
 *  detail text (a date); `accessory` is a trailing control (a pin toggle) and
 *  `titleBadge` an inline control right after the title (the shared-with
 *  icon) — neither may trigger the row's navigation, so their presence splits
 *  the row into clickable body + sibling controls. */
export function LauncherRow({
  title,
  subtitle,
  kind = 'local',
  href,
  onClick,
  active = false,
  testId,
  meta,
  accessory,
  owner,
  location,
  titleBadge,
}: {
  title: string;
  subtitle: string;
  kind?: 'local' | 'cloud' | 'chat' | 'file';
  href?: string;
  onClick?: () => void;
  active?: boolean;
  testId: string;
  meta?: string;
  accessory?: React.ReactNode;
  owner?: string;
  location?: string;
  titleBadge?: React.ReactNode;
}) {
  const Icon =
    kind === 'cloud' ? CloudIcon : kind === 'chat' ? ChatCircleIcon : kind === 'file' ? FileIcon : FolderSimpleIcon;
  const rowClassName = `group flex items-center justify-between rounded-xl border bg-white px-4 py-3 text-left shadow-sm transition-colors hover:border-stone-300 hover:bg-stone-100/60 ${
    active ? 'border-stone-400 bg-stone-100/60' : 'border-stone-200'
  }`;
  const body = (
    <span className="flex min-w-0 items-center gap-3">
      <Icon className="h-5 w-5 shrink-0 text-stone-400" weight="duotone" aria-hidden />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-stone-800">{title}</span>
          {titleBadge}
        </span>
        <span className="block truncate text-xs text-stone-400">{subtitle}</span>
      </span>
    </span>
  );

  if (!meta && !accessory && !owner && !location) {
    return href ? (
      <Link href={href} className={rowClassName} data-testid={testId}>
        {body}
      </Link>
    ) : (
      <button type="button" className={rowClassName} onClick={onClick} data-testid={testId}>
        {body}
      </button>
    );
  }

  const inner = 'flex min-w-0 flex-1 items-center text-left';
  return (
    <div className={rowClassName}>
      {href ? (
        <Link href={href} className={inner} data-testid={testId}>
          {body}
        </Link>
      ) : (
        <button type="button" className={inner} onClick={onClick} data-testid={testId}>
          {body}
        </button>
      )}
      <span className="ml-3 flex shrink-0 items-center">
        {owner != null || location != null ? (
          // Column mode: every cell renders (empty included) so rows align
          // cell-for-cell across a page's lists — a row without a pin/menu
          // must not shift its Owner/Location left into the gap.
          <>
            <span data-testid="row-owner" className={`${COLUMNS.owner} truncate text-xs text-stone-400`}>
              {owner}
            </span>
            <span data-testid="row-location" className={`${COLUMNS.location} truncate text-xs text-stone-400`}>
              {location}
            </span>
            <span className={`${COLUMNS.meta} text-xs text-stone-400`}>{meta}</span>
            <span className={`${COLUMNS.actions} gap-1`}>{accessory}</span>
          </>
        ) : (
          // Plain mode (chat rows): just the date and trailing control.
          <>
            {meta ? <span className={`${COLUMNS.meta} text-xs text-stone-400`}>{meta}</span> : null}
            {accessory ? <span className={`${COLUMNS.actions} gap-1`}>{accessory}</span> : null}
          </>
        )}
      </span>
    </div>
  );
}

/** Shared cell widths — rows and the list header must agree cell-for-cell,
 *  or the Drive-style columns drift out of alignment. Owner/Location are
 *  left-aligned like GDrive's and collapse away below lg (at tablet widths
 *  they crushed titles to a few characters); the date stays — it's the one
 *  detail every width keeps. */
const COLUMNS = {
  owner: 'hidden w-28 pr-2 lg:block',
  location: 'hidden w-32 pr-2 lg:block',
  meta: 'w-auto text-right lg:w-20',
  actions: 'flex w-14 items-center justify-end',
};

/** Column titles above a launcher list (GDrive's Name / Owner / Location
 *  header row). Renders only on lg+ — below that the columns themselves are
 *  hidden. Unconditional cells, mirroring column-mode rows exactly — hiding
 *  a label here while rows keep the cell would shear the columns apart. */
export function LauncherListHeader() {
  const label = 'text-[11px] font-medium text-stone-400';
  return (
    <div aria-hidden data-testid="launcher-list-header" className="hidden items-center px-4 pb-1 lg:flex">
      <span className={`min-w-0 flex-1 ${label}`}>Name</span>
      <span className="ml-3 flex shrink-0 items-center">
        <span className={`${COLUMNS.owner} ${label}`}>Owner</span>
        <span className={`${COLUMNS.location} ${label}`}>Location</span>
        <span className={COLUMNS.meta} />
        <span className={COLUMNS.actions} />
      </span>
    </div>
  );
}
