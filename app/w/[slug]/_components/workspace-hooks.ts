'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { createBrowserClient } from '@/lib/supabase/browser';
import { isInFloatingActionMenu } from '@/components/workspace/anchored-dropdown';
import { MOBILE_MEDIA_QUERY, latchPanelView } from '@/lib/workspace/layout';

import type { WorkspaceRouteInput } from '@/lib/workspace/public-ids';

// The page's own route id, `local` flag included — these hooks forward it
// straight to buildWorkspacePath, which is what keeps a local project's
// links and redirects off the cloud `/w/` route.
type WorkspaceRouteId = WorkspaceRouteInput;
type SearchParamsLike = {
  get(name: string): string | null;
  toString(): string;
};
// Unified project sidebar (workspace-v4 §4). Legacy stored values
// ('files'/'chats'/'commits') are migrated to 'project' on read in page.tsx.
type LeftRail = 'project' | null;
type WorkspaceLayoutConfig = {
  openLeftRail: LeftRail;
  /** Ordered set of open center panels (Phase 2). */
  openPanels?: ('editor' | 'chat' | 'review')[];
  /** Legacy: pre-Phase-2 layouts stored a single mode; migrated on read. */
  mode?: 'chat' | 'space';
};

const LAST_WORKSPACE_KEY = 'sundial:last-workspace';
const FRESH_WORKSPACE_LAYOUT_QUERY_PARAM = 'fresh';
/** Backoff before rebuilding the presence channel after a CHANNEL_ERROR/TIMED_OUT:
 *  exponential from base to cap with jitter, so a Realtime outage doesn't turn
 *  every open tab into a fixed-interval reconnect storm against the backend. */
const PRESENCE_REJOIN_BASE_MS = 2_000;
const PRESENCE_REJOIN_MAX_MS = 30_000;
/** Tighter cap while the tab is visible + online. A collaborator actively
 *  editing (tab focused, network up) fires neither `online` nor
 *  `visibilitychange`, so without this they'd sit invisible for the full ~30s
 *  backoff while their Hocuspocus cursor keeps flowing — the recurring
 *  "caret with no chip" symptom. Hidden/offline tabs keep the wide cap so a
 *  real outage doesn't become a reconnect storm from every backgrounded tab. */
const PRESENCE_REJOIN_VISIBLE_MAX_MS = 6_000;

/** Exponential backoff (base·2^attempts) capped by visibility, plus ≤30% jitter
 *  to de-sync tabs. Pure + exported so the reconnect cadence is unit-tested
 *  without driving the whole hook. `jitter` is injectable for determinism. */
export function nextPresenceRejoinDelay(
  attempts: number,
  visibleAndOnline: boolean,
  jitter: number = Math.random(),
): number {
  const cap = visibleAndOnline ? PRESENCE_REJOIN_VISIBLE_MAX_MS : PRESENCE_REJOIN_MAX_MS;
  const backoff = Math.min(cap, PRESENCE_REJOIN_BASE_MS * 2 ** attempts);
  return backoff + jitter * backoff * 0.3;
}

/** True when this tab is foregrounded and the browser reports connectivity —
 *  the state in which a dropped presence channel should recover fast. */
function isPresenceTabActive(): boolean {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return true;
}

function hasFreshWorkspaceLayoutQuery() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get(FRESH_WORKSPACE_LAYOUT_QUERY_PARAM) === '1';
}

/** Strip a one-shot query param WITHOUT a router navigation — a real
 *  router.replace re-fires the chat/layout deep-link intents (?chat=1 etc.)
 *  and visibly reloads the page content. Next ≥14.1 syncs useSearchParams on
 *  native replaceState, so param-keyed effects still see the change. */
function clearQueryParam(name: string) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(name)) return;
  url.searchParams.delete(name);
  const search = url.searchParams.toString();
  window.history.replaceState(window.history.state, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
}

function clearFreshWorkspaceLayoutQuery() {
  clearQueryParam(FRESH_WORKSPACE_LAYOUT_QUERY_PARAM);
}

export type SettingsTab =
  | 'context'
  | 'apps'
  | 'changes'
  | 'secrets'
  | 'workspace'
  | 'appearance'
  | 'preferences'
  | 'shortcuts'
  | 'billing'
  | 'github'
  | 'overleaf'
  | 'chatApps'
  | 'apikeys'
  | 'gettingStarted';

export type WorkspacePresencePayload = {
  /** Composite key used in the bubble row: `user:<clerkId>`, `anon:<id>`, or `agent:<agentId>`. */
  presenceKey: string;
  /** 'user' for Clerk-authenticated participants, 'anon' for cookie-only visitors, 'local-agent' for connected MCP agents. */
  kind: 'user' | 'anon' | 'local-agent';
  /** Clerk id when kind='user'; absent for anon/local-agent. */
  userId?: string | null;
  /** Raw sd_anon cookie value (no `anon:` prefix) when kind='anon'. */
  anonId?: string | null;
  /** Stable id for local agents: `ai:<agent-name>`. */
  agentId?: string | null;
  /** Human-set per-agent switch: the agent's writes land as reviewable suggestions. */
  suggestOnly?: boolean;
  name: string | null;
  username: string | null;
  imageUrl: string | null;
  /** Bubble color (pre-computed so the cursor + bubble use the same hue). */
  color?: string | null;
  /** Workspace path of the file this peer currently has focused — the
   *  click-a-bubble jump target. Null when no file is open. */
  openFilePath?: string | null;
};

export function useToolbarRowWidth() {
  const [toolbarRowWidth, setToolbarRowWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const toolbarRowCallbackRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    if (typeof ResizeObserver === 'undefined') {
      setToolbarRowWidth(node.getBoundingClientRect().width);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setToolbarRowWidth(entry.contentRect.width);
      }
    });
    observer.observe(node);
    observerRef.current = observer;
    setToolbarRowWidth(node.getBoundingClientRect().width);
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { toolbarRowWidth, toolbarRowCallbackRef };
}

export function useDocumentVisible() {
  const [isDocumentVisible, setIsDocumentVisible] = useState(true);

  useEffect(() => {
    const updateVisibility = () => {
      setIsDocumentVisible(document.visibilityState === 'visible');
    };
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  return isDocumentVisible;
}

export function useChatScrollMemory({
  chatScrollRef,
  chatEndRef,
  shouldAutoScrollRef,
  chatScrollTopByChatIdRef,
  currentChatId,
  currentChatMessages,
  isChatVisible,
}: {
  chatScrollRef: MutableRefObject<HTMLDivElement | null>;
  chatEndRef: MutableRefObject<HTMLDivElement | null>;
  shouldAutoScrollRef: MutableRefObject<boolean>;
  chatScrollTopByChatIdRef: MutableRefObject<Record<string, number>>;
  currentChatId: string | null;
  currentChatMessages: unknown[];
  /** Whether the chat transcript is on screen (any column). */
  isChatVisible: boolean;
}) {
  const saveCurrentChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el || !currentChatId) return;
    chatScrollTopByChatIdRef.current[currentChatId] = el.scrollTop;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= 96;
  }, [currentChatId]);

  const handleChatScroll = useCallback(() => {
    saveCurrentChatScroll();
  }, [saveCurrentChatScroll]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    chatEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [currentChatMessages]);

  useEffect(() => {
    if (!currentChatId) return;
    const savedScrollTop = chatScrollTopByChatIdRef.current[currentChatId];
    if (typeof savedScrollTop === 'number') {
      shouldAutoScrollRef.current = false;
      return;
    }
    shouldAutoScrollRef.current = true;
    chatEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [currentChatId]);

  useLayoutEffect(() => {
    if (!isChatVisible || !currentChatId) return;
    const el = chatScrollRef.current;
    if (!el) return;
    const savedScrollTop = chatScrollTopByChatIdRef.current[currentChatId];
    if (typeof savedScrollTop === 'number') {
      el.scrollTop = savedScrollTop;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      shouldAutoScrollRef.current = distanceFromBottom <= 96;
    } else if (shouldAutoScrollRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [currentChatId, isChatVisible]);

  return {
    handleChatScroll,
    saveCurrentChatScroll,
  };
}

export function useWorkspaceDropdownDismissal({
  openChatMenuId,
  chatMenuRef,
  setOpenChatMenuId,
  showModelPicker,
  modelPickerRef,
  setShowModelPicker,
  showAppsPicker,
  appsPickerRef,
  setShowAppsPicker,
}: {
  openChatMenuId: string | null;
  chatMenuRef: MutableRefObject<HTMLDivElement | null>;
  setOpenChatMenuId: (value: null) => void;
  showModelPicker: boolean;
  modelPickerRef: MutableRefObject<HTMLDivElement | null>;
  setShowModelPicker: (value: boolean) => void;
  showAppsPicker: boolean;
  appsPickerRef: MutableRefObject<HTMLDivElement | null>;
  setShowAppsPicker: (value: boolean) => void;
}) {
  useEffect(() => {
    if (!openChatMenuId && !showModelPicker && !showAppsPicker) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInFloatingMenu = isInFloatingActionMenu(event.target);
      if (
        openChatMenuId &&
        chatMenuRef.current &&
        !chatMenuRef.current.contains(target) &&
        !isInFloatingMenu
      ) {
        setOpenChatMenuId(null);
      }
      if (showModelPicker && modelPickerRef.current && !modelPickerRef.current.contains(target)) {
        setShowModelPicker(false);
      }
      if (showAppsPicker && appsPickerRef.current && !appsPickerRef.current.contains(target)) {
        setShowAppsPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [
    appsPickerRef,
    chatMenuRef,
    modelPickerRef,
    openChatMenuId,
    setOpenChatMenuId,
    setShowAppsPicker,
    setShowModelPicker,
    showAppsPicker,
    showModelPicker,
  ]);
}

export function useDiffDeepLinkPulse({
  deepLinkedDiffId,
  currentChatMessages,
}: {
  deepLinkedDiffId: string | null;
  currentChatMessages: { id?: string | null }[];
}) {
  useEffect(() => {
    if (!deepLinkedDiffId) return;
    if (!currentChatMessages.some((message) => message.id === deepLinkedDiffId)) return;
    let cancelled = false;
    const start = performance.now();
    const tryScroll = () => {
      if (cancelled) return;
      const target = document.querySelector(`[data-diff-id="${deepLinkedDiffId}"]`);
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('diff-deep-link-pulse');
        window.setTimeout(() => {
          target.classList.remove('diff-deep-link-pulse');
        }, 1400);
        return;
      }
      if (performance.now() - start < 4000) {
        window.setTimeout(tryScroll, 120);
      }
    };
    tryScroll();
    return () => {
      cancelled = true;
    };
  }, [deepLinkedDiffId, currentChatMessages]);
}

export function useWorkspacePresence({
  supabaseClient,
  projectId,
  user,
  anonId,
  anonDisplayName: anonNameValue,
  anonColor,
  openFilePath,
}: {
  supabaseClient: ReturnType<typeof createBrowserClient>;
  projectId: string;
  user:
    | {
        id?: string | null;
        fullName?: string | null;
        username?: string | null;
        imageUrl?: string | null;
      }
    | null
    | undefined;
  /** Stable per-browser id for logged-out visitors; ignored when `user.id` is set. */
  anonId?: string | null;
  /** Pre-computed "Anonymous <Animal>" name. */
  anonDisplayName?: string | null;
  /** Pre-computed bubble color so the cursor + bubble match. */
  anonColor?: string | null;
  /** Path of the file this browser currently has focused; broadcast so other
   *  clients can jump to this peer. Changes re-track without rejoining. */
  openFilePath?: string | null;
}) {
  const [workspacePresenceState, setWorkspacePresenceState] = useState<Record<string, WorkspacePresencePayload[]>>({});
  // Read at track() time (never an effect dep): a file switch must not tear
  // down and rejoin the presence channel, just re-announce on it.
  const openFilePathRef = useRef<string | null>(openFilePath ?? null);
  openFilePathRef.current = openFilePath ?? null;
  const retrackRef = useRef<(() => void) | null>(null);

  // Gate: only join the channel when this browser has a stable identity to
  // broadcast. Page-level access is already enforced by the layout — if the
  // workspace renders at all, canRead is implicit. Anon visitors to *private*
  // workspaces hit the 403 before this hook ever sees them.
  //
  // We deliberately do NOT gate on document.visibilityState: opening a second
  // window of the same workspace (e.g. an incognito anon visitor) reliably
  // toggles the main window's visibility, which would tear down the channel
  // and race the resubscribe sync — exactly the symptom seen in dev where the
  // first window had to be reloaded to pick up the new anon visitor. The
  // bandwidth cost of leaving the channel open on a hidden tab is a Phoenix
  // heartbeat every 30s; the UX cost of dropping presence on focus changes is
  // visibly worse.
  const presenceKey =
    user?.id ? `user:${user.id}` : anonId ? `anon:${anonId}` : null;

  useEffect(() => {
    if (!supabaseClient || !projectId || !presenceKey) {
      setWorkspacePresenceState({});
      return;
    }

    setWorkspacePresenceState({});
    const payload: WorkspacePresencePayload = user?.id
      ? {
          presenceKey,
          kind: 'user',
          userId: user.id,
          name: user.fullName ?? user.username ?? null,
          username: user.username ?? null,
          imageUrl: user.imageUrl ?? null,
          color: null,
        }
      : {
          presenceKey,
          kind: 'anon',
          anonId: anonId ?? null,
          name: anonNameValue ?? null,
          username: null,
          imageUrl: null,
          color: anonColor ?? null,
        };

    let channel: ReturnType<typeof supabaseClient.channel> | null = null;
    let rejoin: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let cancelled = false;
    // True only while the CURRENT channel is SUBSCRIBED — a re-track on a
    // joining/dead channel would just error into the void.
    let ready = false;

    const connect = () => {
      if (cancelled) return;
      ready = false;
      const ch = supabaseClient.channel(`workspace-presence-${projectId}`, {
        config: { presence: { key: presenceKey } },
      });
      channel = ch;
      const syncPresence = () => {
        // Force a fresh object reference: supabase-js's presenceState() returns
        // the *same* internal cache object across calls (mutated in place when
        // a remote presence joins). Without the spread, React's Object.is
        // bailout would skip the re-render for every change after the first —
        // bubbles would never appear until a hard page reload.
        setWorkspacePresenceState({ ...ch.presenceState<WorkspacePresencePayload>() });
      };

      ch.on('presence', { event: 'sync' }, syncPresence);
      ch.on('presence', { event: 'join' }, syncPresence);
      ch.on('presence', { event: 'leave' }, syncPresence);
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          attempts = 0;
          // The channel is healthy now: no retry is pending. Clear `rejoin`
          // (the scheduled-retry timer fires `connect` directly and never
          // nulls it) so the `online`/visibility kick below treats this as
          // healthy and stays a no-op instead of churning a working channel.
          rejoin = null;
          ready = true;
          void ch.track({ ...payload, openFilePath: openFilePathRef.current });
          return;
        }
        // CHANNEL_ERROR/TIMED_OUT leaves the channel dead and Supabase does not
        // auto-rejoin presence — an active collaborator would silently drop off
        // everyone's chip list while their Hocuspocus cursor lives on (a caret
        // with no presence chip). Tear down and rebuild; recreating the channel
        // also re-runs the client's accessToken callback, so a stale Clerk
        // token (the usual cause) is refreshed on the retry.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          if (cancelled || channel !== ch) return;
          // Null first so removeChannel's synchronous CLOSED re-entry fails the
          // `channel !== ch` guard instead of scheduling a second rejoin.
          channel = null;
          supabaseClient.removeChannel(ch);
          const delay = nextPresenceRejoinDelay(attempts, isPresenceTabActive());
          attempts += 1;
          if (rejoin) clearTimeout(rejoin);
          rejoin = setTimeout(connect, delay);
        }
      });
    };

    connect();

    retrackRef.current = () => {
      if (cancelled || !ready || !channel) return;
      void channel.track({ ...payload, openFilePath: openFilePathRef.current });
    };

    // After a prolonged drop (offline, laptop sleep, frozen tab) the backoff
    // above climbs to PRESENCE_REJOIN_MAX_MS, so a reconnecting collaborator
    // can sit invisible for up to ~30s while their Hocuspocus cursor/edits —
    // on a *separate* socket that reconnects fast — keep flowing. When the
    // browser tells us connectivity is back (`online`) or the tab is focused
    // again (`visibilitychange`), don't wait out that stale backoff: when a
    // retry is pending (`rejoin !== null`), cancel the wait and rejoin now. A
    // healthy SUBSCRIBED channel nulls `rejoin`, so this is a no-op then — no
    // churn on ordinary tab switches.
    const kickRejoin = () => {
      if (cancelled || rejoin === null) return;
      clearTimeout(rejoin);
      rejoin = null;
      attempts = 0;
      // `rejoin !== null` also covers a fired backoff timer whose connect() is
      // still mid-subscribe — `channel` then holds that in-flight channel. Tear
      // it down (null-first, mirroring the error branch) so its later SUBSCRIBED
      // can't track() a second time.
      const inflight = channel;
      channel = null;
      if (inflight) supabaseClient.removeChannel(inflight);
      connect();
    };
    const onOnline = () => kickRejoin();
    const onVisible = () => {
      if (document.visibilityState === 'visible') kickRejoin();
    };
    // Alt-tabbing back to the window can fire `focus` without a
    // `visibilitychange` (the tab was never hidden, only blurred), so listen to
    // both to collapse a stale backoff the moment the user returns.
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onOnline);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      retrackRef.current = null;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      if (rejoin) clearTimeout(rejoin);
      if (channel) {
        void channel.untrack();
        supabaseClient.removeChannel(channel);
      }
    };
  }, [
    projectId,
    supabaseClient,
    presenceKey,
    user?.id,
    user?.fullName,
    user?.username,
    user?.imageUrl,
    anonId,
    anonNameValue,
    anonColor,
  ]);

  // File switches re-announce on the live channel instead of rejoining it.
  // First render is skipped: the subscribe handshake's own track() already
  // carries the initial path (a second mount-time track would double-announce).
  const skippedInitialTrackRef = useRef(false);
  useEffect(() => {
    if (!skippedInitialTrackRef.current) {
      skippedInitialTrackRef.current = true;
      return;
    }
    retrackRef.current?.();
  }, [openFilePath]);

  return workspacePresenceState;
}

/** Live row from `local_agent_presence` projected into the same shape as
 *  Supabase Realtime presence so the chip renderer can treat both alike. */
export type LocalAgentPresenceRow = {
  workspace_id: string;
  agent_id: string;
  name: string | null;
  color: string | null;
  user_id: string | null;
  last_seen_at: string;
  suggest_only?: boolean | null;
};

// How long a connected local agent's chip stays visible after its last call.
// Deliberately generous: a local agent talks over plain HTTP (no socket), so
// "still connected" is inferred from recency. A short window made the chip
// vanish whenever the agent sat idle between turns — it must persist as long as
// the session is plausibly alive, not just while a cursor is moving. This is
// NOT the in-doc ghost-cursor TTL (collab-editor.tsx), which stays short on
// purpose so the cursor only shows during active editing.
export const LOCAL_AGENT_PRESENCE_TTL_MS = 10 * 60_000;

export function useLocalAgentPresence({
  supabaseClient,
  projectId,
}: {
  supabaseClient: ReturnType<typeof createBrowserClient>;
  projectId: string;
}): WorkspacePresencePayload[] {
  const [rows, setRows] = useState<Record<string, LocalAgentPresenceRow>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!supabaseClient || !projectId) {
      setRows({});
      return;
    }
    let cancelled = false;

    // Seed with recent rows so the chip appears immediately on page load.
    void (async () => {
      const { data } = await supabaseClient
        .from('local_agent_presence')
        .select('workspace_id, agent_id, name, color, user_id, last_seen_at, suggest_only')
        .eq('workspace_id', projectId)
        .gte('last_seen_at', new Date(Date.now() - LOCAL_AGENT_PRESENCE_TTL_MS).toISOString());
      if (cancelled || !Array.isArray(data)) return;
      const next: Record<string, LocalAgentPresenceRow> = {};
      for (const row of data as LocalAgentPresenceRow[]) next[row.agent_id] = row;
      setRows(next);
    })();

    const channel = supabaseClient
      .channel(`local-agent-presence-${projectId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'local_agent_presence',
          filter: `workspace_id=eq.${projectId}`,
        },
        (payload) => {
          const newRow = payload.new as LocalAgentPresenceRow | null;
          const oldRow = payload.old as LocalAgentPresenceRow | null;
          setRows((prev) => {
            const next = { ...prev };
            if (payload.eventType === 'DELETE' && oldRow?.agent_id) {
              delete next[oldRow.agent_id];
            } else if (newRow?.agent_id) {
              next[newRow.agent_id] = newRow;
            }
            return next;
          });
        },
      )
      .subscribe();

    // TTL sweep — drop chips whose last_seen_at fell out of the window.
    const tick = window.setInterval(() => setNow(Date.now()), 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(tick);
      supabaseClient.removeChannel(channel);
    };
  }, [projectId, supabaseClient]);

  return useMemo(() => {
    const cutoff = now - LOCAL_AGENT_PRESENCE_TTL_MS;
    return Object.values(rows)
      .filter((row) => new Date(row.last_seen_at).getTime() >= cutoff)
      .map<WorkspacePresencePayload>((row) => ({
        presenceKey: `agent:${row.agent_id}`,
        kind: 'local-agent',
        agentId: row.agent_id,
        name: row.name ?? row.agent_id.replace(/^ai:/, '') ?? 'Local agent',
        username: null,
        imageUrl: null,
        color: row.color,
        suggestOnly: row.suggest_only === true,
      }));
  }, [rows, now]);
}

// Freshness window for "the agent's cursor is in a doc" — deliberately the
// same 30s the in-doc ghost-cursor uses (collab-editor.tsx), so the topbar
// assistant bubble and the in-editor caret appear/disappear together.
export const AGENT_EDIT_PRESENCE_TTL_MS = 30_000;

/** Pure sweep: chat ids whose last agent edit is within the TTL. */
export function freshAgentEditChatIds(
  lastEditAtByChat: Record<string, number>,
  now: number,
  ttlMs: number = AGENT_EDIT_PRESENCE_TTL_MS,
): Set<string> {
  const cutoff = now - ttlMs;
  return new Set(
    Object.entries(lastEditAtByChat)
      .filter(([, at]) => at >= cutoff)
      .map(([chatId]) => chatId),
  );
}

/**
 * Chats whose agent is editing files RIGHT NOW: a `doc_edits` row with
 * actor 'agent' landed within the TTL. Drives the topbar assistant bubble
 * (founder: presence there means a cursor in a file, not chat activity).
 * Seeded from a one-shot SELECT so a mid-turn reload still shows the bubble.
 */
export function useAgentEditingChats({
  supabaseClient,
  projectId,
}: {
  supabaseClient: ReturnType<typeof createBrowserClient>;
  projectId: string | null;
}): Set<string> {
  const [lastEditAtByChat, setLastEditAtByChat] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!supabaseClient || !projectId) {
      setLastEditAtByChat({});
      return;
    }
    let cancelled = false;

    void (async () => {
      const { data } = await supabaseClient
        .from('doc_edits')
        .select('chat_id, created_at')
        .eq('workspace_id', projectId)
        .eq('actor', 'agent')
        .gte('created_at', new Date(Date.now() - AGENT_EDIT_PRESENCE_TTL_MS).toISOString());
      if (cancelled || !Array.isArray(data)) return;
      setLastEditAtByChat((prev) => {
        const next = { ...prev };
        for (const row of data as Array<{ chat_id: string | null; created_at: string }>) {
          if (!row.chat_id) continue;
          const at = new Date(row.created_at).getTime();
          if (!Number.isFinite(at)) continue;
          next[row.chat_id] = Math.max(next[row.chat_id] ?? 0, at);
        }
        return next;
      });
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated types miss realtime overloads for doc_edits
    const channel = supabaseClient.channel(`agent-edit-presence-${projectId}`) as any;
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'doc_edits',
        filter: `workspace_id=eq.${projectId}`,
      },
      (payload: { new?: Record<string, unknown> | null }) => {
        const row = payload.new;
        if (row?.actor !== 'agent' || typeof row?.chat_id !== 'string') return;
        const chatId = row.chat_id;
        setLastEditAtByChat((prev) => {
          // Bulk writes (clones) fire one event per row — skip the re-render
          // while the stored stamp is still comfortably fresh.
          const at = prev[chatId];
          if (at && Date.now() - at < 5_000) return prev;
          return { ...prev, [chatId]: Date.now() };
        });
      },
    );
    channel.subscribe();

    // TTL sweep — even with no events, expire presence past the window.
    const tick = window.setInterval(() => setNow(Date.now()), 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(tick);
      supabaseClient.removeChannel(channel);
    };
  }, [projectId, supabaseClient]);

  return useMemo(() => freshAgentEditChatIds(lastEditAtByChat, now), [lastEditAtByChat, now]);
}

export function useWorkspaceRouteIntents({
  searchParams,
  deepLinkedDiffId,
  openSettingsTab,
  setOpenLeftRail,
}: {
  searchParams: SearchParamsLike;
  deepLinkedDiffId: string | null;
  openSettingsTab: (tab: SettingsTab) => void;
  setOpenLeftRail: (value: null) => void;
}) {
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const reviewDeepLinkHandledRef = useRef<string | null>(null);
  const panelDeepLinkHandledRef = useRef<string | null>(null);

  const reviewParam = searchParams.get('review')?.trim().toLowerCase() || null;
  const panelParam = searchParams.get('panel')?.trim() || null;

  useEffect(() => {
    if (reviewParam !== 'open') return;
    if (!deepLinkedDiffId) return;
    if (reviewDeepLinkHandledRef.current === deepLinkedDiffId) return;
    reviewDeepLinkHandledRef.current = deepLinkedDiffId;
    setOpenLeftRail(null);
    setShowReviewPanel(true);
  }, [deepLinkedDiffId, reviewParam, setOpenLeftRail]);

  const closeReviewPanel = useCallback(() => {
    setShowReviewPanel(false);
    reviewDeepLinkHandledRef.current = null;
    clearQueryParam('review');
  }, []);

  useEffect(() => {
    if (!panelParam) return;
    const validTabs: SettingsTab[] = [
      'context',
      // 'apps', // Apps (Composio connectors) deep link disabled while the UI is hidden.
      'changes',
      'secrets',
      'workspace',
      'appearance',
      'preferences',
      'shortcuts',
      'github',
      'overleaf',
      'apikeys',
      'gettingStarted',
    ];
    if (!validTabs.includes(panelParam as SettingsTab)) return;
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    const handledKey = `${panelParam}:${hash}`;
    if (panelDeepLinkHandledRef.current === handledKey) return;
    panelDeepLinkHandledRef.current = handledKey;

    openSettingsTab(panelParam as SettingsTab);

    clearQueryParam('panel');

    if (hash) {
      const targetId = hash.slice(1);
      window.setTimeout(() => {
        document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 250);
    }
  }, [openSettingsTab, panelParam]);

  // NOTE: the `?modal=` param is consumed by the page's one-shot dispatcher
  // (modalDeepLinkOpenersRef) via history.replaceState — no router.replace
  // here: a real navigation would re-fire the chat/layout deep-link intents
  // and open panels behind the modal it just launched.

  return { showReviewPanel, setShowReviewPanel, closeReviewPanel };
}

export function useWorkspaceLayoutEffects({
  projectId,
  filesLoaded,
  hasMounted,
  isMobile,
  layoutConfigReady,
  setHasMounted,
  setIsMobile,
  setOpenLeftRail,
  setShowSettingsModal,
  setMobilePanel,
  setLayoutConfigReady,
  readStoredLayoutConfig,
  applyFreshDesktopLayout,
  applyStoredDesktopLayout,
  persistLayoutConfig,
  layoutConfigHydratedRef,
  freshDesktopLayoutPendingRef,
  blockFreshLayoutPersistenceRef,
}: {
  projectId: string;
  filesLoaded: boolean;
  hasMounted: boolean;
  isMobile: boolean;
  layoutConfigReady: boolean;
  setHasMounted: (value: boolean) => void;
  setIsMobile: (value: boolean) => void;
  setOpenLeftRail: (value: LeftRail) => void;
  setShowSettingsModal: (value: boolean) => void;
  setMobilePanel: (value: 'files' | null) => void;
  setLayoutConfigReady: (value: boolean) => void;
  readStoredLayoutConfig: () => Partial<WorkspaceLayoutConfig> | null;
  applyFreshDesktopLayout: (config: Partial<WorkspaceLayoutConfig> | null) => void;
  /** `arrival: true` = initial hydration → run the chat-first arrival decision;
   *  omitted = mid-session re-apply (mobile↔desktop flip) → restore as stored. */
  applyStoredDesktopLayout: (
    config: Partial<WorkspaceLayoutConfig> | null,
    opts?: { arrival?: boolean },
  ) => void;
  persistLayoutConfig: () => void;
  layoutConfigHydratedRef: MutableRefObject<boolean>;
  freshDesktopLayoutPendingRef: MutableRefObject<boolean>;
  blockFreshLayoutPersistenceRef: MutableRefObject<boolean>;
}) {
  useEffect(() => {
    setHasMounted(true);
  }, [setHasMounted]);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
    setIsMobile(mq.matches);
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [setIsMobile]);

  // Mid-session mobile↔desktop flips re-apply the stored layout. The initial
  // mount is owned by the hydration effect below (which runs the ARRIVAL
  // layout decision — chat-first landing); re-running it here would clobber
  // that, so skip until isMobile actually changes.
  const prevIsMobileForLayoutRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!hasMounted) return;
    const previous = prevIsMobileForLayoutRef.current;
    prevIsMobileForLayoutRef.current = isMobile;
    if (previous === null || previous === isMobile) return;
    if (isMobile) {
      setOpenLeftRail(null);
      setShowSettingsModal(false);
      setMobilePanel(null);
    } else {
      // Panel sessions keep their current layout across a widen past the
      // mobile breakpoint — restoring the stored desktop layout would pop
      // rails/panels the embed deliberately never opened.
      if (!latchPanelView()) {
        const storedLayout = readStoredLayoutConfig();
        if (freshDesktopLayoutPendingRef.current) {
          applyFreshDesktopLayout(storedLayout);
        } else {
          applyStoredDesktopLayout(storedLayout);
        }
      }
      setMobilePanel(null);
    }
  }, [
    applyFreshDesktopLayout,
    applyStoredDesktopLayout,
    freshDesktopLayoutPendingRef,
    hasMounted,
    isMobile,
    readStoredLayoutConfig,
    setMobilePanel,
    setOpenLeftRail,
    setShowSettingsModal,
  ]);

  useEffect(() => {
    setShowSettingsModal(false);
  }, [projectId, setShowSettingsModal]);

  useEffect(() => {
    if (layoutConfigHydratedRef.current) return;
    layoutConfigHydratedRef.current = true;
    const freshLayout = hasFreshWorkspaceLayoutQuery();
    freshDesktopLayoutPendingRef.current = freshLayout;
    blockFreshLayoutPersistenceRef.current = freshLayout;
    // Embedded panel (?view=panel — ChatGPT/Claude side views): the
    // URL-decided single-panel arrival stands on every width. Nothing
    // restored — a stored desktop layout would reopen rails and panels sized
    // for a full window — and nothing persisted for the whole session
    // (persistLayoutConfig stays gated on the latch, unlike the fresh-layout
    // block above, which lifts on first interaction).
    if (latchPanelView()) {
      setOpenLeftRail(null);
      setShowSettingsModal(false);
      if (freshLayout) clearFreshWorkspaceLayoutQuery();
      setLayoutConfigReady(true);
      return;
    }
    const mobileNow = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
    if (mobileNow) {
      setOpenLeftRail(null);
      setShowSettingsModal(false);
      if (freshLayout) {
        clearFreshWorkspaceLayoutQuery();
      }
      setLayoutConfigReady(true);
      return;
    }
    // Read only on the desktop path: the read consumes the one-time legacy-key
    // migration, and mobile — which never persists — would lose the blob.
    const storedLayout = readStoredLayoutConfig();
    if (freshLayout) {
      applyFreshDesktopLayout(storedLayout);
      clearFreshWorkspaceLayoutQuery();
    } else {
      applyStoredDesktopLayout(storedLayout, { arrival: true });
    }
    setLayoutConfigReady(true);
  }, [
    applyFreshDesktopLayout,
    applyStoredDesktopLayout,
    blockFreshLayoutPersistenceRef,
    freshDesktopLayoutPendingRef,
    layoutConfigHydratedRef,
    readStoredLayoutConfig,
    setLayoutConfigReady,
    setOpenLeftRail,
    setShowSettingsModal,
  ]);

  useEffect(() => {
    if (!blockFreshLayoutPersistenceRef.current) return;
    if (!layoutConfigReady || !filesLoaded) return;

    const unblockPersistence = () => {
      blockFreshLayoutPersistenceRef.current = false;
      freshDesktopLayoutPendingRef.current = false;
      document.removeEventListener('pointerdown', unblockPersistence, true);
      document.removeEventListener('keydown', unblockPersistence, true);
    };

    document.addEventListener('pointerdown', unblockPersistence, true);
    document.addEventListener('keydown', unblockPersistence, true);

    return () => {
      document.removeEventListener('pointerdown', unblockPersistence, true);
      document.removeEventListener('keydown', unblockPersistence, true);
    };
  }, [blockFreshLayoutPersistenceRef, filesLoaded, freshDesktopLayoutPendingRef, layoutConfigReady]);

  useEffect(() => {
    persistLayoutConfig();
  }, [persistLayoutConfig]);

  useEffect(() => {
    if (!hasMounted || !projectId) return;
    window.localStorage.setItem(LAST_WORKSPACE_KEY, projectId);
  }, [hasMounted, projectId]);
}
