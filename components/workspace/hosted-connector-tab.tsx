'use client';

import { useCallback, useState } from 'react';
import { CaretRightIcon, CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { buildMcpCliCommands, buildMcpConnectUrl } from '@/lib/workspace/mcp-connect';

const SECONDARY_BUTTON =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50';

function CommandRow({
  label,
  command,
  copied,
  onCopy,
}: {
  label: string;
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-stone-700">{label}</span>
        <button type="button" onClick={onCopy} className={SECONDARY_BUTTON}>
          {copied ? (
            <>
              <CheckIcon className="h-3.5 w-3.5" weight="bold" aria-hidden /> Copied
            </>
          ) : (
            <>
              <CopyIcon className="h-3.5 w-3.5" weight="regular" aria-hidden /> Copy
            </>
          )}
        </button>
      </div>
      <code className="mt-2 block overflow-x-auto whitespace-nowrap font-mono text-[11px] leading-5 text-stone-600">
        {command}
      </code>
    </div>
  );
}

/**
 * The hosted MCP path is deliberately tucked under Settings → Advanced. The
 * product's primary connection surface is Open with…; this section preserves
 * direct MCP setup for people who know they need it, without making it the
 * default route.
 *
 * CLI commands are scoped to the current workspace. ChatGPT and Claude.ai use
 * the account-level connector URL so one OAuth grant can reach every workspace
 * the user can access.
 */
export function HostedConnectorSection({
  projectId,
  expanded,
  onExpandedChange,
}: {
  projectId: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const isHttps = origin.startsWith('https://');
  const accountMcpUrl = buildMcpConnectUrl(origin);
  const workspaceMcpUrl = buildMcpConnectUrl(origin, projectId);
  const cli = buildMcpCliCommands(workspaceMcpUrl);
  // claude.ai pre-fills its "Add custom connector" dialog from these params.
  const addToClaudeUrl =
    'https://claude.ai/customize/connectors?modal=add-custom-connector' +
    `&connectorName=${encodeURIComponent('Sundial')}` +
    `&connectorUrl=${encodeURIComponent(accountMcpUrl)}`;

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 1600);
    } catch {
      /* clipboard denied — commands and URL remain visible for manual copy */
    }
  }, []);

  // ChatGPT has no add-connector deep link, so copy the URL before opening it.
  const addToChatGpt = useCallback(() => {
    void copy('chatgpt', accountMcpUrl);
    window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer');
  }, [accountMcpUrl, copy]);

  return (
    <details
      open={expanded}
      onToggle={(event) => onExpandedChange(event.currentTarget.open)}
      data-testid="advanced-mcp-section"
      className="rounded-2xl border border-stone-200 bg-white"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 [&::-webkit-details-marker]:hidden">
        <CaretRightIcon
          className={`h-4 w-4 shrink-0 text-stone-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          weight="bold"
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium text-stone-900">
            MCP connections
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-700">
              Beta
            </span>
          </span>
          <span className="mt-0.5 block text-xs text-stone-500">
            Advanced setup for MCP clients and account connectors.
          </span>
        </span>
      </summary>

      <div className="border-t border-stone-200 px-4 pb-5 pt-4">
        {!isHttps ? (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            MCP connections need a public <span className="font-medium">https</span> URL. You&apos;re on{' '}
            <span className="font-mono">{origin || 'this dev server'}</span>.
          </div>
        ) : null}

        <div>
          <h3 className="text-xs font-semibold text-stone-800">Claude Code or Codex</h3>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            Run one workspace-scoped command in your terminal, then approve the sign-in.
          </p>
          <div className="mt-3 grid gap-2">
            <CommandRow
              label="Claude Code"
              command={cli.claudeCode}
              copied={copied === 'claude'}
              onCopy={() => void copy('claude', cli.claudeCode)}
            />
            <CommandRow
              label="Codex"
              command={cli.codex}
              copied={copied === 'codex'}
              onCopy={() => void copy('codex', cli.codex)}
            />
          </div>
        </div>

        <div className="mt-5 border-t border-stone-200 pt-5">
          <h3 className="text-xs font-semibold text-stone-800">ChatGPT or Claude.ai</h3>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            Add Sundial once at the account level to reach every workspace you can access.
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <a
              href={isHttps ? addToClaudeUrl : undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!isHttps}
              className={`flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-medium text-white transition-colors ${
                isHttps ? 'bg-stone-900 hover:bg-stone-800' : 'pointer-events-none bg-stone-300'
              }`}
            >
              Add to Claude.ai
            </a>
            <button
              type="button"
              onClick={addToChatGpt}
              disabled={!isHttps}
              className="flex items-center justify-center rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-stone-800 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:bg-stone-50 disabled:text-stone-400"
            >
              {copied === 'chatgpt' ? 'URL copied · opening…' : 'Add to ChatGPT'}
            </button>
          </div>
          <p className="mt-2 text-xs text-stone-500">
            ChatGPT: enable Developer mode under Settings → Apps → Advanced settings, create an app,
            then paste the copied URL.
          </p>

          <div className="mt-3 flex items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-stone-600">
              {accountMcpUrl}
            </code>
            <button
              type="button"
              onClick={() => void copy('url', accountMcpUrl)}
              className="shrink-0 text-xs font-medium text-stone-600 underline-offset-2 hover:text-stone-900 hover:underline"
            >
              {copied === 'url' ? 'Copied' : 'Copy URL'}
            </button>
          </div>
        </div>
      </div>
    </details>
  );
}
