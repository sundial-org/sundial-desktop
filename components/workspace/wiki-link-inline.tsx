'use client';

import { Fragment } from 'react';
import {
  resolveWikiTargetToPath,
  textHasWikiLinks,
} from '@/lib/workspace/wiki-file-links';

type WikiLinkInlineProps = {
  text: string;
  knownPaths: string[];
  onOpenFile?: (path: string) => void;
  openOnClick?: boolean;
};

const WIKI_LINK_RE = /\[\[([^\]\n]+)\]\]/g;

function splitTarget(raw: string): { target: string; label: string } {
  const [target = '', alias] = raw.split('|');
  const trimmedTarget = target.trim();
  return {
    target: trimmedTarget,
    label: (alias?.trim() || trimmedTarget.split('/').pop() || trimmedTarget),
  };
}

export function WikiLinkInline({
  text,
  knownPaths,
  onOpenFile,
  openOnClick = false,
}: WikiLinkInlineProps) {
  if (!textHasWikiLinks(text)) return <>{text}</>;

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(WIKI_LINK_RE)) {
    const full = match[0] ?? '';
    const rawTarget = match[1] ?? '';
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index));

    const { target, label } = splitTarget(rawTarget);
    const path = resolveWikiTargetToPath(target, knownPaths);
    const clickable = Boolean(path && openOnClick && onOpenFile);
    nodes.push(
      clickable ? (
        <button
          key={`${index}:${full}`}
          type="button"
          onClick={() => path && onOpenFile?.(path)}
          title={path ?? target}
          className="wiki-file-link inline cursor-pointer"
        >
          {label}
        </button>
      ) : (
        <span
          key={`${index}:${full}`}
          title={path ?? target}
          className="wiki-file-link inline"
        >
          {label}
        </span>
      ),
    );
    lastIndex = index + full.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));

  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={index}>{node}</Fragment>
      ))}
    </>
  );
}
