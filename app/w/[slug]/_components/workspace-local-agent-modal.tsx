'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { XIcon, CopyIcon, CheckIcon, CircleNotchIcon } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { ModalShell } from '@/components/modal-shell';
import { SunnyLottie } from '@/components/sunny-lottie';
import { brandForAgentId } from '@/lib/workspace/agent-brand';
import { buildMcpCliCommands, buildMcpConnectUrl } from '@/lib/workspace/mcp-connect';
import type { CollaboratorBadge } from './workspace-chat-model';

export type LocalAgentJoinInfo = {
  prompt: string;
  shortPrompt?: string;
  workspaceUrl: string;
  canWrite: boolean;
  expiresAt: string;
};

export function useWorkspaceLocalAgent({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen?: () => void;
}) {
  const [showLocalAgentModal, setShowLocalAgentModal] = useState(false);
  const [localAgentJoinInfo, setLocalAgentJoinInfo] = useState<LocalAgentJoinInfo | null>(null);
  const [localAgentLoading, setLocalAgentLoading] = useState(false);
  const [localAgentError, setLocalAgentError] = useState('');
  const [localAgentCopied, setLocalAgentCopied] = useState<string | null>(null);
  // Monotonic mint sequence: a stale response from a superseded mint (rapid
  // re-open) must never overwrite the newer prompt.
  const mintSeqRef = useRef(0);

  const mintLocalAgentJoinInfo = useCallback(async () => {
    if (!projectId) return;
    const seq = ++mintSeqRef.current;
    const isStale = () => seq !== mintSeqRef.current;
    setLocalAgentLoading(true);
    setLocalAgentError('');
    // A new mint invalidates whatever was copied — the clipboard holds the
    // previous token's prompt.
    setLocalAgentCopied(null);
    try {
      const response = await fetch('/api/workspace/local-agent/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId }),
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<LocalAgentJoinInfo> & { error?: string };
      if (isStale()) return;
      if (!response.ok || !payload.prompt || !payload.workspaceUrl || !payload.expiresAt) {
        throw new Error(payload.error ?? 'Unable to create local agent link.');
      }
      setLocalAgentJoinInfo({
        prompt: payload.prompt,
        shortPrompt: typeof payload.shortPrompt === 'string' ? payload.shortPrompt : undefined,
        workspaceUrl: payload.workspaceUrl,
        canWrite: Boolean(payload.canWrite),
        expiresAt: payload.expiresAt,
      });
    } catch (error) {
      if (isStale()) return;
      setLocalAgentJoinInfo(null);
      setLocalAgentError(error instanceof Error ? error.message : 'Unable to create local agent link.');
    } finally {
      if (!isStale()) setLocalAgentLoading(false);
    }
  }, [projectId]);

  const openLocalAgentModal = useCallback(async () => {
    if (!projectId) return;
    onOpen?.();
    setShowLocalAgentModal(true);
    await mintLocalAgentJoinInfo();
  }, [onOpen, projectId, mintLocalAgentJoinInfo]);

  const copyLocalAgentText = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setLocalAgentCopied(key);
      window.setTimeout(() => {
        setLocalAgentCopied((prev) => (prev === key ? null : prev));
      }, 1600);
    } catch {
      setLocalAgentError('Copy failed');
    }
  }, []);

  return {
    showLocalAgentModal,
    setShowLocalAgentModal,
    localAgentJoinInfo,
    localAgentLoading,
    localAgentError,
    localAgentCopied,
    openLocalAgentModal,
    copyLocalAgentText,
  };
}

export function WorkspaceLocalAgentModal({
  open,
  loading,
  error,
  joinInfo,
  copied,
  onClose,
  onCopy,
  activeCollaborators,
  projectId,
}: {
  open: boolean;
  loading: boolean;
  error: string;
  joinInfo: LocalAgentJoinInfo | null;
  copied: string | null;
  onClose: () => void;
  onCopy: (kind: string, text: string) => void | Promise<void>;
  /** Current workspace UUID — scopes the MCP connect commands so the agent lands here. */
  projectId?: string;
  /** Workspace-level presence list; used to detect when the agent appears. */
  activeCollaborators: CollaboratorBadge[];
}) {
  const joinedAgent = useMemo(
    () => activeCollaborators.find((c) => c.kind === 'local-agent') ?? null,
    [activeCollaborators],
  );

  // Snapshot of agents that were already present when the modal opened, so
  // we only celebrate the *new* join. Armed at open (not after the join-info
  // mint) — the MCP tabs are usable immediately, so an agent can join before
  // /local-agent/join responds and must still be celebrated. We use a ref +
  // boolean flag instead of `Set.size === 0` as the "initialized" sentinel —
  // an empty baseline is valid and must not re-trigger initialization.
  const baselineAgentIdsRef = useRef<Set<string>>(new Set());
  const [baselineInitialized, setBaselineInitialized] = useState(false);
  useEffect(() => {
    if (!open) {
      baselineAgentIdsRef.current = new Set();
      setBaselineInitialized(false);
      return;
    }
    if (baselineInitialized) return;
    baselineAgentIdsRef.current = new Set(
      activeCollaborators.filter((c) => c.kind === 'local-agent').map((c) => c.id),
    );
    setBaselineInitialized(true);
  }, [open, activeCollaborators, baselineInitialized]);

  const freshlyJoinedAgent = useMemo(() => {
    if (!joinedAgent || !baselineInitialized) return null;
    if (baselineAgentIdsRef.current.has(joinedAgent.id)) return null;
    return joinedAgent;
  }, [joinedAgent, baselineInitialized]);

  const [celebrated, setCelebrated] = useState(false);
  useEffect(() => {
    if (freshlyJoinedAgent) setCelebrated(true);
    if (!open) setCelebrated(false);
  }, [freshlyJoinedAgent, open]);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="Bring your agent into this workspace"
      overlayClassName="fixed inset-0 z-[75] flex items-center justify-center bg-stone-950/50 backdrop-blur-sm p-4"
      panelClassName="relative w-full max-w-md overflow-hidden rounded-3xl bg-white border border-stone-200 shadow-2xl"
    >
      {celebrated && freshlyJoinedAgent ? (
        <JoinedState agent={freshlyJoinedAgent} onClose={onClose} />
      ) : (
        <ConnectState
          loading={loading}
          error={error}
          joinInfo={joinInfo}
          copied={copied}
          onClose={onClose}
          onCopy={onCopy}
          projectId={projectId}
        />
      )}
    </ModalShell>
  );
}

/** Warm gradient header with the laptop-Sunny Lottie. `agent`, when set, flies
 *  the joined agent's mark in next to Sunny. */
function WarmStage({ agent }: { agent?: CollaboratorBadge | null }) {
  const brand = agent ? brandForAgentId(agent.agentId) : null;
  return (
    <div className="relative flex h-48 items-center justify-center overflow-hidden bg-[radial-gradient(130%_130%_at_50%_-10%,#FFE7CE_0%,#FFF6EC_55%,#ffffff_100%)]">
      <div className="relative flex items-center gap-4">
        <SunnyLottie className="h-48 w-48" />
        <AnimatePresence>
          {brand && (
            <motion.div
              initial={{ scale: 0, x: -28, opacity: 0 }}
              animate={{ scale: 1, x: 0, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 380, damping: 22 }}
              className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-lg ring-1 ring-stone-200"
            >
              {brand.logoPath ? (
                <img src={brand.logoPath} alt="" className="h-9 w-9 object-contain" draggable={false} />
              ) : (
                <span className="text-xl font-semibold" style={{ color: brand.color }}>{brand.label}</span>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="absolute right-4 top-4 z-10 text-stone-400 transition-colors hover:text-stone-600"
    >
      <XIcon className="h-5 w-5" weight="regular" aria-hidden />
    </button>
  );
}

function JoinedState({
  agent,
  onClose,
}: {
  agent: CollaboratorBadge;
  onClose: () => void;
}) {
  const brand = brandForAgentId(agent.agentId);
  return (
    <>
      <CloseButton onClose={onClose} />
      <WarmStage agent={agent} />
      <div className="px-7 pb-7 pt-6 text-center">
        <h2 className="text-xl font-semibold text-stone-900">{brand.displayName} joined the workspace</h2>
        <p className="mx-auto mt-2 max-w-xs text-sm text-stone-500">
          You&apos;re connected. Keep working here — every edit it makes shows up as a tracked change.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded-xl bg-stone-900 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-800"
        >
          Continue to workspace
        </button>
      </div>
    </>
  );
}

/** Softer prompt box that fits the warm vibe — a muted inset with a tiny label,
 *  not a black terminal slab. */
function PromptPreview({ text }: { text: string }) {
  return (
    <div className="mt-5 overflow-hidden rounded-2xl border border-stone-200/80 bg-stone-50">
      <div className="flex items-center gap-1.5 border-b border-stone-200/70 px-4 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">Agent prompt</span>
      </div>
      <pre className="max-h-28 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-5 text-stone-500">
        {text}
      </pre>
    </div>
  );
}

type AgentTool = 'claude' | 'codex' | 'any';

const AGENT_TABS: { id: AgentTool; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'any', label: 'Any agent' },
];

function ConnectState({
  loading,
  error,
  joinInfo,
  copied,
  onClose,
  onCopy,
  projectId,
}: {
  loading: boolean;
  error: string;
  joinInfo: LocalAgentJoinInfo | null;
  copied: string | null;
  onClose: () => void;
  onCopy: (kind: string, text: string) => void | Promise<void>;
  projectId?: string;
}) {
  const [tab, setTab] = useState<AgentTool>('claude');
  // Claude Code / Codex connect over MCP with a one-liner scoped to this
  // workspace; "Any agent" gets the copy-paste bootstrap prompt.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const cli = buildMcpCliCommands(buildMcpConnectUrl(origin, projectId));
  const command = tab === 'claude' ? cli.claudeCode : cli.codex;
  const displayPrompt = joinInfo?.shortPrompt ?? joinInfo?.prompt ?? '';
  const copyText = tab === 'any' ? (joinInfo?.prompt ?? '') : command;
  // Switch to the persistent "waiting for your agent" state only once something
  // has actually reached the clipboard — the hook sets `copied` on success and
  // `error` on failure, so arming off `copied` avoids showing "waiting" (with the
  // primary CTA gone) when the copy was denied and nothing was put on the clipboard.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (copied) setArmed(true);
  }, [copied]);
  const handleCopy = useCallback(() => {
    void onCopy(tab, copyText);
  }, [onCopy, tab, copyText]);

  return (
    <>
      <CloseButton onClose={onClose} />
      <WarmStage />
      <div className="px-7 pb-7 pt-6">
        <h2 className="text-xl font-semibold text-stone-900">Bring your agent into this workspace</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-500">
          Run one command in your terminal — or paste the prompt into any agent. We&apos;ll watch for
          it to join, then it reads your files and edits right alongside you.
        </p>

        <div className="mt-5 flex gap-1 rounded-full border border-stone-200 bg-white p-1 text-sm">
          {AGENT_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-full px-3 py-1.5 font-medium transition-colors ${
                tab === t.id ? 'bg-stone-900 text-white' : 'text-stone-500 hover:text-stone-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {error ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {tab === 'any' ? (
          loading || !joinInfo ? (
            <div className="mt-4 h-28 rounded-2xl border border-dashed border-stone-200 bg-stone-50" />
          ) : (
            <PromptPreview text={displayPrompt} />
          )
        ) : (
          <code className="mt-4 block overflow-x-auto whitespace-nowrap rounded-2xl border border-stone-200/80 bg-stone-50 px-4 py-3 font-mono text-[11px] text-stone-600">
            {command}
          </code>
        )}
        <p className="mt-2 text-xs text-stone-400">
          {tab === 'any'
            ? 'Paste it into any agent that can run shell commands — Cursor, Gemini CLI, anything.'
            : 'Run it in your terminal and approve the sign-in — it connects straight to this workspace.'}
        </p>

        {armed ? (
          <>
            <div className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700">
              <CircleNotchIcon className="h-4 w-4 animate-spin" weight="bold" aria-hidden />
              Waiting for your agent to join…
            </div>
            <button
              type="button"
              onClick={handleCopy}
              // Empty while the Any-agent prompt is still minting (or failed) —
              // copying would overwrite the clipboard with ''.
              disabled={!copyText}
              aria-label="Copy again"
              className="mt-3 flex w-full items-center justify-center gap-1.5 text-center text-sm text-stone-500 transition-colors hover:text-stone-800 disabled:opacity-40"
            >
              {copied === tab ? (
                <>
                  <CheckIcon className="h-3.5 w-3.5" weight="bold" aria-hidden /> Copied again
                </>
              ) : (
                'Copy again'
              )}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={handleCopy}
            disabled={!copyText}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-stone-900 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-40"
          >
            <CopyIcon className="h-4 w-4" weight="regular" aria-hidden />
            {tab === 'any' ? 'Copy agent prompt' : 'Copy command'}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * Opens when a connected local-agent chip in the topbar is clicked. Shows the
 * agent and the human-side "Suggest only" switch — when on, every edit the
 * agent makes lands as a reviewable diff (and delete/rename/exec/uploads are
 * blocked), regardless of the token it holds.
 */
export function LocalAgentModeModal({
  agent,
  suggestOnly,
  saving,
  error,
  onClose,
  onSuggestOnlyChange,
}: {
  agent: CollaboratorBadge | null;
  suggestOnly: boolean;
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSuggestOnlyChange: (next: boolean) => void;
}) {
  const brand = brandForAgentId(agent?.agentId);
  return (
    <ModalShell
      open={Boolean(agent)}
      onClose={onClose}
      ariaLabel="Local agent settings"
      overlayClassName="fixed inset-0 z-[75] flex items-center justify-center bg-stone-950/50 backdrop-blur-sm p-4"
      panelClassName="w-full max-w-sm rounded-3xl bg-white border border-stone-200 shadow-2xl"
    >
      <div className="relative px-6 pt-6 pb-6">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-stone-400 transition-colors hover:text-stone-600"
        >
          <XIcon className="h-5 w-5" weight="regular" aria-hidden />
        </button>

        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: `${brand.color}1a` }}>
            {brand.logoPath ? (
              <img src={brand.logoPath} alt="" className="h-7 w-7 object-contain" draggable={false} />
            ) : (
              <span className="text-lg font-semibold" style={{ color: brand.color }}>{brand.label}</span>
            )}
          </div>
          <div>
            <h2 className="text-base font-semibold text-stone-900">{brand.displayName}</h2>
            <p className="text-xs text-stone-500">{agent?.name ?? agent?.agentId ?? ''} · connected</p>
          </div>
        </div>

        <label className="mt-5 flex cursor-pointer items-start justify-between gap-3 rounded-2xl border border-stone-200 px-4 py-3">
          <span className="text-sm">
            <span className="font-medium text-stone-900">Suggest only</span>
            <span className="mt-0.5 block text-xs text-stone-500">
              Every edit shows up as a reviewable diff you accept or reject — never a direct
              change. Delete, rename, and shell commands are blocked.
            </span>
          </span>
          <input
            type="checkbox"
            checked={suggestOnly}
            disabled={saving}
            onChange={(event) => onSuggestOnlyChange(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 rounded border-stone-300 accent-stone-900"
          />
        </label>

        {error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}
      </div>
    </ModalShell>
  );
}
