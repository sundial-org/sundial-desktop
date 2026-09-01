'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon, LinkIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { cn } from '@/lib/utils';

const ICONS = { link: LinkIcon, copy: CopyIcon } as const;

interface CopyLinkButtonProps {
  /** Text written to the clipboard on click — a URL, or any text to copy. */
  url: string;
  label?: string;
  className?: string;
  iconClassName?: string;
  /** Glyph: a link icon (default) or a copy icon (e.g. "copy message"). */
  icon?: 'link' | 'copy';
  /** When set, show the app's black hover tooltip instead of the native title. */
  tooltip?: string;
  /** Tooltip side (default 'top'). */
  tooltipSide?: 'top' | 'bottom';
  /** Glyph stroke weight (default 'bold'); use 'regular' to match thin neighbors. */
  iconWeight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
  /** When set, clicking runs this instead of copying (e.g. a link that is
   *  meaningless until sharing is set up opens the share modal first). */
  onClickOverride?: () => void;
}

export function CopyLinkButton({
  url,
  label = 'Copy link',
  className,
  iconClassName,
  icon = 'link',
  tooltip,
  tooltipSide = 'top',
  iconWeight = 'bold',
  onClickOverride,
}: CopyLinkButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onClick = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (onClickOverride) {
      onClickOverride();
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState('idle'), 1500);
  }, [url, onClickOverride]);

  const buttonLabel =
    state === 'copied' ? `${label} · copied`
    : state === 'failed' ? 'Copy failed'
    : label;

  const BaseIcon = ICONS[icon];
  const Icon = state === 'copied' ? CheckIcon : BaseIcon;
  const iconColor = state === 'copied' ? 'text-emerald-600' : undefined;
  const tooltipLabel = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : tooltip;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={buttonLabel}
      title={tooltip ? undefined : buttonLabel}
      className={cn(
        'relative flex h-6 w-6 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 active:bg-stone-100',
        tooltip && 'group/tip',
        className,
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', iconColor, iconClassName)} weight={iconWeight} />
      {tooltip ? <IconTooltip label={tooltipLabel ?? ''} side={tooltipSide} /> : null}
    </button>
  );
}
