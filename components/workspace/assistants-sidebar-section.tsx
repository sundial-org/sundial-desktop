'use client';

import { useState } from 'react';
import { SidebarSimpleIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { SidebarSectionHeader } from '@/components/workspace/sidebar-section-header';
import { Spinner } from '@/components/ui/spinner';
import { useAssistantsData } from '@/components/workspace/assistants-data';

// The sidebar Assistants section (flag-gated, docked above Chats). Expanding
// it runs the Haiku suggestion loop and shows the picks RIGHT HERE in the
// rail; clicking a pick opens the dock panel on that assistant's details, and
// the header's panel icon opens the full browser. Collapsed by default so the
// rail stays quiet until asked.

export function AssistantsSidebarSection({
  projectId,
  /** Open the dock panel — on one assistant's details when a slug is given. */
  onOpenPanel,
}: {
  projectId: string;
  onOpenPanel: (slug?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Nothing fetches (and no model runs) until the section is first expanded.
  const [everExpanded, setEverExpanded] = useState(false);
  const { assistants, suggested } = useAssistantsData(projectId, everExpanded);

  const suggestedEntries = (suggested ?? [])
    .map((slug) => assistants?.find((a) => a.slug === slug))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  return (
    <div data-testid="sidebar-assistants-section">
      <SidebarSectionHeader
        label="Assistants"
        collapsed={!expanded}
        onToggleCollapsed={() => {
          setExpanded((prev) => !prev);
          setEverExpanded(true);
        }}
        actions={
          <button
            type="button"
            onClick={() => onOpenPanel()}
            aria-label="Open assistants panel"
            data-testid="sidebar-assistants-open-panel"
            className="relative group/tip flex h-7 w-7 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-200/50 hover:text-stone-600"
          >
            <SidebarSimpleIcon className="h-4 w-4 -scale-x-100" weight="regular" aria-hidden />
            <IconTooltip label="Open assistants panel" />
          </button>
        }
      />
      {expanded ? (
        <div className="px-2 pb-2">
          {suggested === null ? (
            <div data-testid="sidebar-assistants-loading" className="px-2 py-1">
              <Spinner label="Picking for this workspace…" size={12} className="text-[12px] text-stone-400" />
            </div>
          ) : suggestedEntries.length ? (
            <>
              <div className="px-2 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600">
                Suggested
              </div>
              {suggestedEntries.map((assistant) => (
                <button
                  key={assistant.slug}
                  type="button"
                  onClick={() => onOpenPanel(assistant.slug)}
                  data-testid={`sidebar-assistant-${assistant.slug}`}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-stone-600 transition-colors hover:bg-amber-50 hover:text-stone-800"
                >
                  <span className="truncate">{assistant.name}</span>
                </button>
              ))}
            </>
          ) : (
            <div className="px-2 py-1 text-[12px] text-stone-400">No clear fits here.</div>
          )}
          <button
            type="button"
            onClick={() => onOpenPanel()}
            data-testid="sidebar-assistants-browse-all"
            className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
          >
            <span className="truncate">Browse all assistants</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
