'use client';

import { useCallback, useState } from 'react';
import { CopyIcon, CheckIcon } from '@phosphor-icons/react';
import { buildMcpConnectUrl } from '@/lib/workspace/mcp-connect';

/**
 * Settings → "ChatGPT & Claude.ai": the hosted MCP connector, still in beta.
 *
 * Distinct from the local-agent flow (which brings Claude Code / Codex / Cursor
 * INTO one workspace): this connects Sundial OUT to a chat app at the account
 * level via OAuth, reaching every workspace the user can access. No token —
 * the connector URL is just this deployment's origin + /mcp, so we build it
 * client-side. Chat apps require a public https URL, so on http/localhost we
 * surface a hint instead of dead buttons.
 */
export function HostedConnectorTab() {
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const isHttps = origin.startsWith('https://');
  // Account-level (no workspace scope) — the chat apps reach every workspace.
  const mcpUrl = buildMcpConnectUrl(origin);
  // claude.ai pre-fills its "Add custom connector" dialog from these params.
  const addToClaudeUrl =
    'https://claude.ai/customize/connectors?modal=add-custom-connector' +
    `&connectorName=${encodeURIComponent('Sundial')}` +
    `&connectorUrl=${encodeURIComponent(mcpUrl)}`;

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 1600);
    } catch {
      /* clipboard denied — the URL is still visible to copy manually */
    }
  }, []);

  // ChatGPT has no add-connector deep link, so the best we can do is copy the
  // URL and open ChatGPT; the user pastes it under Developer mode.
  const addToChatGpt = useCallback(() => {
    void copy('chatgpt', mcpUrl);
    window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer');
  }, [copy, mcpUrl]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="max-w-xl px-6 py-8">
        <h2 className="flex items-center gap-2 text-base font-semibold text-stone-900">
          Use Sundial in ChatGPT &amp; Claude.ai
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700">
            Beta
          </span>
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-500">
          Add Sundial as a connector in your assistant. Sign in once, and it can then read and edit
          every workspace you can access, right from the chat. No token to copy.
        </p>

        {!isHttps ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            Chat connectors need a public <span className="font-medium">https</span> URL. You&apos;re on{' '}
            <span className="font-mono">{origin || 'this dev server'}</span>. Open this on your deployed
            Sundial to connect ChatGPT or Claude.ai.
          </div>
        ) : null}

        <a
          href={isHttps ? addToClaudeUrl : undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!isHttps}
          className={`mt-5 flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-medium text-white transition-colors ${
            isHttps ? 'bg-stone-900 hover:bg-stone-800' : 'pointer-events-none bg-stone-300'
          }`}
        >
          Add to Claude.ai
        </a>
        <p className="mt-2 text-xs text-stone-500">Opens claude.ai with Sundial pre-filled. Just confirm and sign in.</p>

        <button
          type="button"
          onClick={addToChatGpt}
          disabled={!isHttps}
          className={`mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-medium transition-colors ${
            isHttps
              ? 'border border-stone-300 bg-white text-stone-800 hover:bg-stone-50'
              : 'cursor-not-allowed border border-stone-200 bg-stone-50 text-stone-400'
          }`}
        >
          {copied === 'chatgpt' ? (
            <>
              <CheckIcon className="h-4 w-4" weight="bold" aria-hidden />
              URL copied · opening ChatGPT…
            </>
          ) : (
            'Add to ChatGPT'
          )}
        </button>
        <p className="mt-2 text-xs text-stone-500">
          Copies the URL and opens ChatGPT. There: Settings → Apps → Advanced settings → turn
          on Developer mode → Create app → paste this URL.
        </p>

        <div className="mt-5 flex items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-stone-600">{mcpUrl}</code>
          <button
            type="button"
            onClick={() => void copy('url', mcpUrl)}
            className="shrink-0 text-xs font-medium text-stone-600 underline-offset-2 hover:text-stone-900 hover:underline"
          >
            {copied === 'url' ? (
              <span className="inline-flex items-center gap-1">
                <CheckIcon className="h-3 w-3" weight="bold" aria-hidden /> Copied
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <CopyIcon className="h-3 w-3" weight="regular" aria-hidden /> Copy URL
              </span>
            )}
          </button>
        </div>
        <p className="mt-2 text-xs text-stone-400">
          Claude Desktop or any other MCP client: paste this server URL as a custom connector.
        </p>
      </div>
    </div>
  );
}
