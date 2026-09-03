'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  DownloadSimpleIcon,
  GithubLogoIcon,
  XIcon,
} from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { detectOS } from '@/lib/detect-os';
import { isDesktopApp, openExternalOnDesktop } from '@/lib/desktop';

/**
 * "Open with …" — the one place a workspace connects OUT to the tools people
 * already use. It first asks WHERE the user works, then shows only that
 * path's options:
 *
 * - **Web**: the paste-into-any-AI /start prompt, ChatGPT and Claude.ai
 *   opened with THAT SAME prompt prefilled (join over the HTTP rail — web
 *   agents have no shell, and ChatGPT's sandbox no network, so they never
 *   get a curl command; direct MCP setup remains in Settings → Advanced), and
 *   Overleaf / GitHub links.
 * - **Desktop**: Claude Desktop via its official deep link
 *   (claude://claude.ai/new?q= prefills the current-folder sync prompt),
 *   ChatGPT Desktop by copying that prompt (the app registers no prompt
 *   deep link), and the Sundial desktop app download (macOS build).
 *
 * Options are gated by what the visitor can actually use (OS for the desktop
 * build, https for agent prompts — agents cannot fetch a localhost /start).
 */

export type OpenWithLinkedRepo = {
  id: string;
  provider: 'github' | 'overleaf';
  label: string;
  htmlUrl: string | null;
};

/**
 * The paste-into-any-AI one-liner, shaped like the marketing /editor prompt
 * but scoped to the workspace that already exists: /start teaches the agent
 * the ropes, the workspace URL tells it where to land (the skill's
 * "human handed you a workspace URL" path) instead of creating a new one.
 */
export function buildWorkspaceStartPrompt(workspaceUrl: string): string {
  const origin = new URL(workspaceUrl).origin;
  return `Fetch ${origin}/start and follow it, then join my workspace at ${workspaceUrl} and ask what we should work on.`;
}

/**
 * The DESKTOP-app handoff prompt: the workspace, current-folder sync command,
 * and requested result. Both bootstraps default to the current working
 * directory and refuse a bare home directory or filesystem root. Desktop has
 * one prompt, intentionally ending with the requested TeX handoff. Web agents
 * get the plain start prompt instead.
 */
export function buildWorkspaceSyncPrompt(
  workspaceUrl: string,
  platform: 'posix' | 'windows' = 'posix',
): string {
  const origin = new URL(workspaceUrl).origin;
  // Windows gets the native PowerShell bootstrap; both commands deliberately
  // omit a folder so serve.ps1 / serve.sh use the current working directory.
  const command =
    platform === 'windows'
      ? `powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ${origin}/serve.ps1))) -Workspace ${workspaceUrl}"`
      : `curl -fsSL ${origin}/serve.sh | sh -s -- --workspace ${workspaceUrl}`;
  return `Workspace: ${workspaceUrl}. Run \`${command}\` to sync this folder, then show me the TeX file.`;
}

/** Claude Desktop's official deep link, in CODE mode: opens the app
 *  (launching it if needed) straight into a Code session with the prompt
 *  prefilled for review. Code mode, not chat: it has the machine's shell,
 *  so the agent can RUN the sync command instead of narrating it. The
 *  folder rides inside the prompt text (the deep link's own `folder` param
 *  needs an absolute path the browser cannot know). Documented at
 *  support.claude.com "Open Claude Desktop with a link"; q is truncated by
 *  the app around ~14k chars, far above this prompt's size. */
export function buildClaudeDesktopUrl(prompt: string): string {
  return `claude://code/new?q=${encodeURIComponent(prompt)}`;
}

/** This workspace's URL for prompts: pathname only, except `anon=` survives —
 *  it is the ownership credential on a handed-off workspace, and both the
 *  agent's HTTP access and the sync command need it. Everything else in the
 *  query (chatId etc.) is session noise that stays out of prompts. */
function promptWorkspaceUrl(): string {
  const { origin, pathname, search } = window.location;
  const anon = new URLSearchParams(search).get('anon');
  return `${origin}${pathname}${anon ? `?anon=${encodeURIComponent(anon)}` : ''}`;
}

const BRAND_ICONS: { src: string; alt: string }[] = [
  { src: '/agent-logos/openai.svg', alt: 'ChatGPT' },
  { src: '/agent-logos/claude.svg', alt: 'Claude' },
  { src: '/agent-logos/overleaf.svg', alt: 'Overleaf' },
];

/** The sidebar affordance: brand marks + label, docked above the footer. */
export function OpenWithRow({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="open-with-row"
      className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 max-sm:hidden"
    >
      <span className="flex items-center gap-1.5 font-medium">
        Open with…
      </span>
      <span className="flex items-center gap-1.5">
        {BRAND_ICONS.map((icon) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={icon.src}
            src={icon.src}
            alt={icon.alt}
            className="h-3.5 w-3.5 object-contain grayscale"
            draggable={false}
          />
        ))}
        <GithubLogoIcon className="h-3.5 w-3.5 text-stone-800" weight="fill" aria-label="GitHub" />
      </span>
    </button>
  );
}

function BrandMark({ src, alt }: { src: string; alt: string }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-stone-200 bg-white">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="h-5 w-5 object-contain" draggable={false} />
    </span>
  );
}

function OptionRow({
  icon,
  title,
  subtitle,
  action,
  testId,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  action: ReactNode;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="flex items-center gap-3 rounded-2xl border border-stone-200 px-3 py-2.5">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-stone-900">{title}</p>
        <p className="truncate text-xs text-stone-500">{subtitle}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

const ACTION_BUTTON =
  'inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300';
const ACTION_LINK =
  'inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 transition-colors hover:bg-stone-50';

type OpenWithView = 'choice' | 'web' | 'desktop';

export function OpenWithModal({
  open,
  onClose,
  linkedRepos,
  onLinkOverleaf,
  onAddRepo,
  onAddRepoHover,
}: {
  open: boolean;
  onClose: () => void;
  linkedRepos: OpenWithLinkedRepo[];
  /** Opens the Add Overleaf project flow (host closes this modal first). */
  onLinkOverleaf?: () => void;
  /** Opens the Add GitHub repo flow (host closes this modal first). */
  onAddRepo?: () => void;
  onAddRepoHover?: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  // The where-do-you-work step comes first on every open — the two paths
  // show disjoint options, so no default is assumed.
  const [view, setView] = useState<OpenWithView>('choice');
  useEffect(() => {
    if (open) setView('choice');
  }, [open]);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const isHttps = origin.startsWith('https://');
  const workspaceUrl = origin ? promptWorkspaceUrl() : '';
  const startPrompt = workspaceUrl ? buildWorkspaceStartPrompt(workspaceUrl) : '';
  // What the buttons hand over. Web ChatGPT/Claude get the SAME prompt the
  // paste box shows (join over the HTTP rail — a web agent has no shell, and
  // ChatGPT's sandbox no network, so a curl command would only confuse it).
  // Desktop apps get the current-folder sync prompt: they run commands on
  // this machine, and both bootstraps default to the folder already open.
  const desktopPlatform = detectOS() === 'windows' ? 'windows' : 'posix';
  const desktopSyncPrompt = workspaceUrl
    ? buildWorkspaceSyncPrompt(workspaceUrl, desktopPlatform)
    : '';
  const claudeWebUrl = `https://claude.ai/new?q=${encodeURIComponent(startPrompt)}`;
  const claudeDesktopUrl = buildClaudeDesktopUrl(desktopSyncPrompt);

  // The Apple Silicon build is the only desktop build; hide the option on
  // other OSes and inside the desktop shell itself.
  const showDesktopDownload = detectOS() === 'macos' && !isDesktopApp();

  const overleafProject = linkedRepos.find((repo) => repo.provider === 'overleaf' && repo.htmlUrl);
  const githubRepo = linkedRepos.find((repo) => repo.provider === 'github' && repo.htmlUrl);

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 1600);
    } catch {
      /* clipboard denied — the text stays visible to copy manually */
    }
  }, []);

  // ChatGPT prefills the composer from ?q=; the prompt is ALSO copied so a
  // logged-out redirect or an app that drops the query never strands the
  // user. The desktop shell drops window.open, but it intercepts off-site
  // navigation and hands it to the system browser — navigate in place there
  // (mirrors openExternalOnDesktop for the anchors below).
  const openChatGpt = useCallback(() => {
    void copy('chatgpt', startPrompt);
    const url = `https://chatgpt.com/?q=${encodeURIComponent(startPrompt)}`;
    if (isDesktopApp()) window.location.assign(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }, [copy, startPrompt]);

  const tabButton = (target: 'web' | 'desktop', label: string) => (
    <button
      type="button"
      data-testid={`open-with-tab-${target}`}
      onClick={() => setView(target)}
      className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        view === target ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800'
      }`}
    >
      {label}
    </button>
  );

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="Open this workspace with another tool"
      overlayClassName="fixed inset-0 z-[75] flex items-center justify-center bg-stone-950/50 backdrop-blur-sm p-4"
      panelClassName="relative w-full max-w-lg overflow-hidden rounded-3xl bg-white border border-stone-200 shadow-2xl"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 z-10 text-stone-400 transition-colors hover:text-stone-600"
      >
        <XIcon className="h-5 w-5" weight="regular" aria-hidden />
      </button>
      <div className="px-6 pb-6 pt-6" data-testid="open-with-modal">
        <h2 className="text-lg font-semibold text-stone-900">Open with…</h2>
        <p className="mt-1 text-sm text-stone-500">
          Work on this workspace from the tools you already use.
        </p>

        {view === 'choice' ? (
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              data-testid="open-with-choice-web"
              onClick={() => setView('web')}
              className="flex flex-col items-start gap-1 rounded-2xl border border-stone-200 px-4 py-3.5 text-left transition-colors hover:border-stone-400 hover:bg-stone-50"
            >
              <span className="text-sm font-medium text-stone-900">On the web</span>
              <span className="text-xs text-stone-500">
                ChatGPT or Claude in the browser, plus Overleaf and GitHub
              </span>
            </button>
            <button
              type="button"
              data-testid="open-with-choice-desktop"
              onClick={() => setView('desktop')}
              className="flex flex-col items-start gap-1 rounded-2xl border border-stone-200 px-4 py-3.5 text-left transition-colors hover:border-stone-400 hover:bg-stone-50"
            >
              <span className="text-sm font-medium text-stone-900">Desktop apps</span>
              <span className="text-xs text-stone-500">
                Claude, ChatGPT, and Sundial on this computer
              </span>
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4 flex gap-1 rounded-xl bg-stone-100 p-1">
              {tabButton('web', 'Web')}
              {tabButton('desktop', 'Desktop')}
            </div>

            {!isHttps ? (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                Agent prompts need a public <span className="font-medium">https</span> URL.
                You&apos;re on <span className="font-mono">{origin || 'this dev server'}</span>, so
                ChatGPT and Claude can only reach your deployed Sundial.
              </div>
            ) : null}

            {view === 'web' ? (
              <>
                <div className="mt-4">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
                    Paste into any AI
                  </span>
                  <div
                    className="mt-1.5 flex cursor-pointer items-start gap-2 rounded-2xl border border-stone-300 bg-white px-3 py-2.5 transition-colors hover:border-stone-400"
                    title="Click to copy"
                    onClick={() => void copy('prompt', startPrompt)}
                  >
                    <code className="min-w-0 flex-1 font-mono text-[11px] leading-5 text-stone-900">
                      {startPrompt}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copy('prompt', startPrompt)}
                      data-testid="open-with-prompt-copy"
                      className="shrink-0 text-xs font-medium text-stone-800 underline-offset-2 hover:text-stone-950 hover:underline"
                    >
                      {copied === 'prompt' ? (
                        <span className="inline-flex items-center gap-1">
                          <CheckIcon className="h-3 w-3" weight="bold" aria-hidden /> Copied
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <CopyIcon className="h-3 w-3" weight="regular" aria-hidden /> Copy
                        </span>
                      )}
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex flex-col gap-2">
                  <OptionRow
                    testId="open-with-chatgpt"
                    icon={<BrandMark src="/agent-logos/openai.svg" alt="ChatGPT" />}
                    title="ChatGPT"
                    subtitle="Opens ChatGPT with this workspace's prompt prefilled (same as the paste box)"
                    action={
                      <button type="button" onClick={openChatGpt} disabled={!isHttps} className={ACTION_BUTTON}>
                        {copied === 'chatgpt' ? (
                          <>
                            <CheckIcon className="h-3.5 w-3.5" weight="bold" aria-hidden /> Copied
                          </>
                        ) : (
                          'Open'
                        )}
                      </button>
                    }
                  />
                  <OptionRow
                    testId="open-with-claude"
                    icon={<BrandMark src="/agent-logos/claude.svg" alt="Claude" />}
                    title="Claude"
                    subtitle="Opens claude.ai with this workspace's prompt prefilled (same as the paste box)"
                    action={
                      isHttps ? (
                        <a
                          href={claudeWebUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(event) => {
                            void copy('claude', startPrompt);
                            openExternalOnDesktop(event);
                          }}
                          className={ACTION_BUTTON}
                        >
                          Open
                        </a>
                      ) : (
                        <button type="button" disabled className={ACTION_BUTTON}>
                          Open
                        </button>
                      )
                    }
                  />
                  <OptionRow
                    testId="open-with-overleaf"
                    icon={<BrandMark src="/agent-logos/overleaf.svg" alt="Overleaf" />}
                    title="Overleaf"
                    subtitle={
                      overleafProject ? overleafProject.label : 'Link an Overleaf project to this workspace'
                    }
                    action={
                      overleafProject?.htmlUrl ? (
                        <a
                          href={overleafProject.htmlUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={openExternalOnDesktop}
                          className={ACTION_LINK}
                        >
                          Open <ArrowSquareOutIcon className="h-3.5 w-3.5" aria-hidden />
                        </a>
                      ) : onLinkOverleaf ? (
                        <button type="button" onClick={onLinkOverleaf} className={ACTION_LINK}>
                          Link project
                        </button>
                      ) : null
                    }
                  />
                  <OptionRow
                    testId="open-with-github"
                    icon={
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-stone-200 bg-white">
                        <GithubLogoIcon className="h-5 w-5 text-stone-900" weight="fill" aria-hidden />
                      </span>
                    }
                    title="GitHub"
                    subtitle={githubRepo ? githubRepo.label : 'Link a GitHub repo to this workspace'}
                    action={
                      githubRepo?.htmlUrl ? (
                        <a
                          href={githubRepo.htmlUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={openExternalOnDesktop}
                          className={ACTION_LINK}
                        >
                          Open <ArrowSquareOutIcon className="h-3.5 w-3.5" aria-hidden />
                        </a>
                      ) : onAddRepo ? (
                        <button
                          type="button"
                          onClick={onAddRepo}
                          onMouseEnter={onAddRepoHover}
                          onFocus={onAddRepoHover}
                          className={ACTION_LINK}
                        >
                          Add repo
                        </button>
                      ) : null
                    }
                  />
                </div>
              </>
            ) : (
              <>
                <div className="mt-4">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
                    Paste into any desktop agent
                  </span>
                  <div
                    className="mt-1.5 flex cursor-pointer items-start gap-2 rounded-2xl border border-stone-300 bg-white px-3 py-2.5 transition-colors hover:border-stone-400"
                    title="Click to copy"
                    onClick={() => void copy('desktop-prompt', desktopSyncPrompt)}
                  >
                    <code className="min-w-0 flex-1 font-mono text-[11px] leading-5 text-stone-900">
                      {desktopSyncPrompt}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copy('desktop-prompt', desktopSyncPrompt)}
                      data-testid="open-with-desktop-prompt-copy"
                      className="shrink-0 text-xs font-medium text-stone-800 underline-offset-2 hover:text-stone-950 hover:underline"
                    >
                      {copied === 'desktop-prompt' ? (
                        <span className="inline-flex items-center gap-1">
                          <CheckIcon className="h-3 w-3" weight="bold" aria-hidden /> Copied
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <CopyIcon className="h-3 w-3" weight="regular" aria-hidden /> Copy
                        </span>
                      )}
                    </button>
                  </div>
                </div>
                <div className="mt-4 flex flex-col gap-2">
                <OptionRow
                  testId="open-with-claude-desktop"
                  icon={<BrandMark src="/agent-logos/claude.svg" alt="Claude" />}
                  title="Claude Desktop"
                  subtitle="Opens Claude with the sync prompt prefilled"
                  action={
                    isHttps ? (
                      <a
                        href={claudeDesktopUrl}
                        onClick={(event) => {
                          // Copied as well: if the app is not installed the
                          // deep link goes nowhere, and the prompt survives.
                          void copy('claude-desktop', desktopSyncPrompt);
                          openExternalOnDesktop(event);
                        }}
                        className={ACTION_BUTTON}
                      >
                        {copied === 'claude-desktop' ? (
                          <>
                            <CheckIcon className="h-3.5 w-3.5" weight="bold" aria-hidden /> Copied
                          </>
                        ) : (
                          'Open'
                        )}
                      </a>
                    ) : (
                      <button type="button" disabled className={ACTION_BUTTON}>
                        Open
                      </button>
                    )
                  }
                />
                <OptionRow
                  testId="open-with-chatgpt-desktop"
                  icon={<BrandMark src="/agent-logos/openai.svg" alt="ChatGPT" />}
                  title="ChatGPT Desktop"
                  subtitle="The app has no prompt link: copies the prompt, paste it into a new chat there"
                  action={
                    <button
                      type="button"
                      onClick={() => void copy('chatgpt-desktop', desktopSyncPrompt)}
                      disabled={!isHttps}
                      className={ACTION_BUTTON}
                    >
                      {copied === 'chatgpt-desktop' ? (
                        <>
                          <CheckIcon className="h-3.5 w-3.5" weight="bold" aria-hidden /> Copied
                        </>
                      ) : (
                        <>
                          <CopyIcon className="h-3.5 w-3.5" weight="regular" aria-hidden /> Copy prompt
                        </>
                      )}
                    </button>
                  }
                />
                {showDesktopDownload ? (
                  <OptionRow
                    testId="open-with-desktop"
                    icon={<BrandMark src="/brand/sundial-icon.svg" alt="Sundial" />}
                    title="Sundial Desktop"
                    subtitle="macOS 13.5+ · Apple Silicon"
                    action={
                      <a href="/api/desktop/download?platform=darwin-aarch64" className={ACTION_BUTTON}>
                        <DownloadSimpleIcon className="h-3.5 w-3.5" weight="bold" aria-hidden /> Download
                      </a>
                    }
                  />
                ) : null}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </ModalShell>
  );
}
