'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { fetchWorkspaceHost } from '@/lib/workspace/collab-url';
import { readAnonCookie, setAnonCookie } from '@/lib/auth/anon-identity-client';
import { currentPathShareToken } from '@/lib/workspace/path-share-token-client';
import { useDocumentEditMode } from '@/lib/workspace/document-edit-mode-context';
import { useAuth } from '@/lib/auth/optional-auth';
import { documentEditModeStorageKey, readStoredEditMode } from '@/lib/workspace/edit-mode';
import type { WorkspaceInitialSnapshot } from '@/lib/workspace/route-context';

type HocuspocusWebsocketInternal = HocuspocusProviderWebsocket & {
  configuration: { providerMap: Map<string, HocuspocusProvider> };
};

function patchIdentitySafeDetach(socket: HocuspocusProviderWebsocket) {
  const typed = socket as HocuspocusWebsocketInternal;
  const original = typed.detach.bind(typed);
  typed.detach = (provider: HocuspocusProvider) => {
    const registered = typed.configuration.providerMap.get(provider.configuration.name);
    if (registered !== provider) {
      // Another provider has taken this docName's slot (StrictMode remount
      // or tab-switch overlap). Deleting now would evict the wrong one and
      // send a CloseMessage on its behalf. Skip.
      return;
    }
    original(provider);
  };
}

/** Watchdog recovery shared by both providers: a half-dead socket still
 *  reports "connected" for up to messageReconnectTimeout, stranding fresh
 *  providers on "Loading editor…" — synchronously mark it disconnected and
 *  let the built-in retry re-open it. No-op unless the socket still claims
 *  connected (the retry loop owns every other state). */
function watchdogReconnect(socket: HocuspocusProviderWebsocket) {
  return () => {
    const ws = socket as unknown as {
      status?: string;
      onClose: (p: { event: { code: number; reason: string } }) => void;
    };
    if (ws.status && ws.status !== 'connected') return;
    ws.onClose({ event: { code: 4408, reason: 'sundial-sync-watchdog' } });
  };
}

/**
 * Drop the live WebSocket so the provider's own retry loop reconnects
 * (`shouldConnect` stays true). On reconnect every attached provider re-runs
 * `onOpen → sendToken`, re-fetching the current-mode token and
 * re-authenticating — WITHOUT recreating the socket or any Y.Doc. This is how
 * an Edit↔Suggest toggle re-tags future persists (the server reads `editMode`
 * from the connection token) without tearing the document down and re-syncing.
 * If the socket hasn't opened yet (`webSocket` null) the pending initial
 * connect already picks up the new mode via the dynamic token getter.
 */
function reauthenticateSocket(socket: HocuspocusProviderWebsocket) {
  const ws = (socket as unknown as { webSocket: { close: () => void } | null }).webSocket;
  ws?.close();
}

/** One provider + Y.Doc per (workspace, docName). Survives CollabEditor
 *  remounts so the server Connection stays open and agent broadcasts keep
 *  landing even if the React subtree tears down/rebuilds. Refcount ensures
 *  we only destroy when nobody is using it anymore.
 *
 *  Keyed by docName (the path-based Hocuspocus document name), but each entry
 *  records the `fileId` it was minted for. A file deleted and then re-created
 *  at the SAME path — history restore / Cmd-Z undo, or a collaborator/agent
 *  recreating it — is a NEW row (new fileId) at the same docName. Its Y.Doc
 *  must be fresh: the server clears live docs to '' on delete (the doc_edits
 *  tombstone), so the cached provider's Y.Doc is empty, and reusing it within
 *  the release grace window would flush that empty doc over the new file's
 *  content (the "deleted-then-restored file silently clobbered" bug). On a
 *  fileId mismatch we tear the stale room down synchronously and mint a clean
 *  one; same-fileId remounts still reuse, so the StrictMode / tab-switch
 *  optimization is preserved. */
export type CachedProvider = {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  refCount: number;
  /** files.id this room was minted for — see acquireProvider. */
  fileId: string;
  /** Pending grace-period teardown (release), cleared on reuse / replace. */
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Set once torn down so a synchronous replace + a later grace fire (or a
   *  double release) can't destroy the same provider/Y.Doc twice. */
  destroyed: boolean;
  /** LRU clock for inactive entries. Active providers are never evicted. */
  lastUsedAt: number;
  /** True when the Y.Doc can paint before network sync because it was seeded
   * from a file-id-matched canonical snapshot. Edits stay gated until synced. */
  bootstrapped: boolean;
};

export type ProviderBootstrap = {
  update: Uint8Array;
};

/** Recently visited tabs stay live long enough for normal document hopping.
 * Bound both time and count: Y.Docs retain their complete CRDT struct stores,
 * so an unbounded workspace walk would otherwise grow the tab indefinitely. */
export const PROVIDER_CACHE_GRACE_MS = 5 * 60_000;
export const PROVIDER_CACHE_MAX_INACTIVE = 12;

const providerCaches = new WeakMap<
  HocuspocusProviderWebsocket,
  Map<string, CachedProvider>
>();

function cacheFor(socket: HocuspocusProviderWebsocket) {
  let cache = providerCaches.get(socket);
  if (!cache) {
    cache = new Map();
    providerCaches.set(socket, cache);
  }
  return cache;
}

function destroyCachedProvider(
  cache: Map<string, CachedProvider>,
  docName: string,
  entry: CachedProvider,
) {
  // Idempotent: a synchronous replace (acquire mismatch) and a stray grace
  // timer / double release must not destroy the same provider twice.
  if (entry.destroyed) return;
  entry.destroyed = true;
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
  // Only evict the slot if it still points at THIS entry — a newer file may
  // have already replaced it (acquire's synchronous mismatch teardown).
  if (cache.get(docName) === entry) cache.delete(docName);
  entry.provider.destroy();
  // The Y.Doc holds the file's whole CRDT struct store — destroy it too,
  // otherwise every visited file's history stays resident for the session.
  entry.ydoc.destroy();
}

function trimInactiveProviders(cache: Map<string, CachedProvider>) {
  const inactive = [...cache.entries()]
    .filter(([, entry]) => !entry.destroyed && entry.refCount <= 0)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  while (inactive.length > PROVIDER_CACHE_MAX_INACTIVE) {
    const [docName, entry] = inactive.shift()!;
    destroyCachedProvider(cache, docName, entry);
  }
}

export function acquireProvider(
  socket: HocuspocusProviderWebsocket,
  docName: string,
  fileId: string,
  token: string | (() => Promise<string>) | undefined,
  bootstrap?: ProviderBootstrap,
): CachedProvider {
  const cache = cacheFor(socket);
  const existing = cache.get(docName);
  if (existing) {
    if (existing.fileId === fileId) {
      // Same file remounting (StrictMode, tab switch, conditional render) —
      // reuse the live provider and cancel any pending teardown.
      existing.refCount += 1;
      existing.lastUsedAt = Date.now();
      if (existing.graceTimer) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
      }
      if (bootstrap && !existing.bootstrapped) {
        Y.applyUpdate(existing.ydoc, bootstrap.update, 'canonical-bootstrap');
        existing.bootstrapped = true;
      }
      return existing;
    }
    // A DIFFERENT file now owns this path (delete + recreate / restore). The
    // cached Y.Doc was emptied by the delete tombstone; reusing it would flush
    // that empty doc over the new file. Tear it down synchronously so the new
    // file binds to a fresh, server-seeded room.
    destroyCachedProvider(cache, docName, existing);
  }
  const ydoc = new Y.Doc();
  if (bootstrap) Y.applyUpdate(ydoc, bootstrap.update, 'canonical-bootstrap');
  const provider = new HocuspocusProvider({
    name: docName,
    document: ydoc,
    websocketProvider: socket,
    ...(token ? { token } : {}),
  });
  provider.attach();
  const entry: CachedProvider = {
    provider,
    ydoc,
    refCount: 1,
    fileId,
    graceTimer: null,
    destroyed: false,
    lastUsedAt: Date.now(),
    bootstrapped: Boolean(bootstrap),
  };
  cache.set(docName, entry);
  return entry;
}

export function releaseProvider(
  socket: HocuspocusProviderWebsocket,
  docName: string,
  fileId: string,
) {
  const cache = cacheFor(socket);
  const entry = cache.get(docName);
  // A newer file may have already replaced this slot (acquire's synchronous
  // mismatch teardown) — don't decref or tear down someone else's room.
  if (!entry || entry.fileId !== fileId) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entry.lastUsedAt = Date.now();
  // Hold for a short grace period so the common pattern (unmount →
  // remount within the same render tick, or tab switch away + back) just
  // reuses the provider instead of tearing down and re-syncing.
  entry.graceTimer = setTimeout(() => {
    entry.graceTimer = null;
    if (entry.refCount > 0) return;
    destroyCachedProvider(cache, docName, entry);
  }, PROVIDER_CACHE_GRACE_MS);
  trimInactiveProviders(cache);
}

/** Intent prefetch used by the file rail. Attaching the real provider starts
 * the canonical Hocuspocus sync; releasing immediately parks it in the same
 * bounded LRU the editor uses, so the later click reuses the synced Y.Doc. */
export function prefetchProvider(
  socket: HocuspocusProviderWebsocket,
  docName: string,
  fileId: string,
  token: string | (() => Promise<string>) | undefined,
) {
  const entry = acquireProvider(socket, docName, fileId, token);
  releaseProvider(socket, docName, fileId);
  return entry.provider;
}

/** Seed and attach the arrival document as soon as the shared socket exists.
 * The immediate release parks it in the bounded provider cache for the editor
 * mount, while attach begins live verification in parallel with hydration. */
export function primeProvider(
  socket: HocuspocusProviderWebsocket,
  docName: string,
  snapshot: WorkspaceInitialSnapshot,
  token: string | (() => Promise<string>) | undefined,
) {
  let update: Uint8Array;
  try {
    const binary = atob(snapshot.updateBase64);
    update = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return;
  }
  acquireProvider(socket, docName, snapshot.fileId, token, { update });
  releaseProvider(socket, docName, snapshot.fileId);
}

export type AwarenessPeer = {
  key: string;
  name: string;
  color: string | null;
  /** Doc (cache key: `<prefix><path>`) where this peer was seen — the one
   *  holding their live caret when they have one anywhere. Bubble clicks use
   *  it to jump to the peer's actual document, not the viewer's. */
  docName: string | null;
  /** True when `docName` holds a live caret (`cursor`/`selection` state). */
  hasCaret: boolean;
};

/** Remote awareness peers across every live provider on a socket. For local
 *  projects this is the presence source: the sidecar bridge relays cloud
 *  peers' awareness into the local docs, so anyone editing a shared file
 *  shows up here. Deduped by name+color — the same person holds a different
 *  awareness clientID in every doc they have open, so the doc that carries
 *  their caret (over mere membership) names where they actually are. */
export function collectAwarenessPeers(socket: HocuspocusProviderWebsocket): AwarenessPeer[] {
  const cache = providerCaches.get(socket);
  if (!cache) return [];
  const peers = new Map<string, AwarenessPeer>();
  for (const [docName, entry] of cache.entries()) {
    const awareness = entry.destroyed ? null : entry.provider.awareness;
    if (!awareness) continue;
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.clientID) return;
      const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
      const name = typeof user?.name === 'string' ? user.name.trim() : '';
      if (!name) return;
      const color = typeof user?.color === 'string' ? user.color : null;
      const key = `${name}|${color ?? ''}`;
      const hasCaret = Boolean(
        (state as { cursor?: unknown }).cursor ?? (state as { selection?: unknown }).selection,
      );
      const existing = peers.get(key);
      if (!existing) {
        peers.set(key, { key, name, color, docName, hasCaret });
      } else if (hasCaret && !existing.hasCaret) {
        existing.docName = docName;
        existing.hasCaret = true;
      }
    });
  }
  return [...peers.values()];
}

export type WorkspaceCollabSocket = {
  workspaceId: string;
  socket: HocuspocusProviderWebsocket;
  /** Returns the freshest host token; refetches when the cached one is near
   *  expiry. Pass this (not a frozen string) to HocuspocusProvider so every
   *  attach/reconnect re-authenticates — direct tokens expire after 24h, and
   *  a provider created from a stale snapshot never syncs ("Loading editor…"
   *  forever after the tab idles past the TTL). */
  getToken: () => Promise<string>;
  collabUrl: string;
  docNamePrefix?: string | null;
  /** True when this socket points at the desktop sidecar (local project) —
   *  cloud-only side channels (edit telemetry, host lookups) must not run. */
  isLocal?: boolean;
  /** Increments when the socket is re-created (e.g. new host after preemption). */
  version: number;
  /** Force the shared socket to drop and re-establish, re-syncing every
   *  attached provider. The editor sync-watchdog calls this when a provider
   *  fails to reach `synced` quickly — a half-dead socket still reports
   *  "connected" for up to `messageReconnectTimeout` (5 min), so a fresh
   *  provider (a file switch) would otherwise hang on "Loading editor…". */
  reconnect: () => void;
};

const Ctx = createContext<WorkspaceCollabSocket | null>(null);
/** True while a WorkspaceCollabSocketProvider above is still opening its first
 *  socket — editors hold their own host-fetch fallback instead of firing a
 *  request the shared socket makes redundant a frame later. */
const PendingCtx = createContext(false);

const RECONNECT_POLL_INTERVAL_MS = 5_000;

/** Validity floor below which getToken refetches instead of reusing the
 *  cached token — covers wake-from-sleep, where the socket reconnects (and
 *  re-authenticates) before the host poll has replaced the expired token. */
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

/** Direct tokens are `b64url(json).sig` with an `exp` in epoch seconds —
 *  decode it client-side so we never authenticate with an expired token.
 *  Undecodable tokens are treated as expiring. */
export function tokenExpiresWithin(token: string, seconds: number): boolean {
  try {
    const normalized = (token.split('.')[0] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp !== 'number' || payload.exp - Date.now() / 1000 < seconds;
  } catch {
    return true;
  }
}

/** Builds the token getter handed to HocuspocusProvider. Refetches when the
 *  cached token is near expiry, dedupes concurrent fetches (a post-wake
 *  re-auth storm must not fire one ensure-sandbox call per editor), and
 *  retries until it has a usable token rather than resolving with one it
 *  already classified as stale — authenticating with a known-expired token
 *  strands the provider unsynced until the next socket cycle. Retries pace
 *  at the poll interval (deduped), so an outage costs no more than the host
 *  poll already does; `isCancelled` ends the loop on context teardown. */
export function createCollabTokenGetter(opts: {
  fetchHost: () => Promise<{ token: string } | null>;
  retryDelayMs?: number;
  isCancelled?: () => boolean;
}) {
  let latestToken = '';
  // Bumped by a cache clear (`setToken('')`, which the socket context fires on
  // an Edit↔Suggest toggle). A fetch started before the clear captured the old
  // mode, so its result must NOT overwrite the cache, AND a getToken arriving
  // after the clear must NOT reuse that stale in-flight fetch — otherwise a
  // quick toggle while a provider's reconnect token fetch is in flight
  // re-authenticates with the stale mode (Codex P1/P2).
  let generation = 0;
  let inFlight: { gen: number; promise: Promise<void> } | null = null;
  const refresh = (): Promise<void> => {
    // Reuse an outstanding fetch only when it was started for the CURRENT
    // generation; a clear since then makes it stale, so start a fresh one.
    if (inFlight && inFlight.gen === generation) return inFlight.promise;
    const gen = generation;
    const promise = opts
      .fetchHost()
      .then((host) => {
        if (host && generation === gen) latestToken = host.token;
      })
      .catch(() => undefined)
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { gen, promise };
    return promise;
  };
  const getToken = async (): Promise<string> => {
    while (true) {
      if (latestToken && !tokenExpiresWithin(latestToken, TOKEN_REFRESH_MARGIN_SECONDS)) {
        return latestToken;
      }
      const genBefore = generation;
      await refresh();
      if (latestToken && !tokenExpiresWithin(latestToken, 0)) return latestToken;
      if (opts.isCancelled?.()) return latestToken;
      // A mode toggle cleared the cache mid-fetch (generation bumped): that
      // fetch's result was discarded, so refetch the current mode IMMEDIATELY
      // rather than waiting out the outage-retry backoff — otherwise the forced
      // reconnect leaves the editor unauthenticated for a poll interval.
      if (generation !== genBefore) continue;
      // The poll may also refresh the token while we wait.
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? RECONNECT_POLL_INTERVAL_MS));
    }
  };
  return {
    getToken,
    setToken: (token: string) => {
      latestToken = token;
      // An empty token is a cache clear (mode toggle) — invalidate any in-flight
      // fetch so its old-mode result can't land after the clear.
      if (token === '') generation += 1;
    },
  };
}

/**
 * Pre-warms a single Hocuspocus WebSocket for the workspace so every editor
 * that opens shares the same TLS+WS handshake. Editors consume it via
 * {@link useWorkspaceCollabSocket} and pass it to their `HocuspocusProvider`
 * as `websocketProvider`. Re-fetches the host URL whenever the socket drops,
 * so a container restart (new tunnel URL) reconnects instead of staying
 * Offline until page reload.
 */
export function WorkspaceCollabSocketProvider({
  workspaceId,
  initialHost,
  initialSnapshot,
  children,
}: {
  workspaceId: string | null;
  /** SSR-minted socket credentials (see the workspace layout): the socket
   *  opens with these immediately, and the host poll takes over refreshing. */
  initialHost?: {
    collabUrl: string;
    token: string;
    docNamePrefix: string;
    clerkUserId?: string | null;
    anonId?: string | null;
    anonMinted?: boolean;
  } | null;
  initialSnapshot?: WorkspaceInitialSnapshot | null;
  children: React.ReactNode;
}) {
  const [value, setValue] = useState<WorkspaceCollabSocket | null>(null);
  const versionRef = useRef(0);
  const { mode: editMode } = useDocumentEditMode();
  // editMode is read dynamically (not a socket-effect dep) so toggling
  // Edit↔Suggest re-authenticates the EXISTING socket rather than tearing it
  // down — see the toggle effect below.
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;
  const socketRef = useRef<HocuspocusProviderWebsocket | null>(null);
  const clearTokenRef = useRef<(() => void) | null>(null);
  // Clerk uid the ADOPTED SSR token was minted for (undefined = nothing to
  // verify). Clerk loads asynchronously, so the identity check below runs
  // once it resolves and re-authenticates in place on mismatch.
  const ssrClerkUidRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!workspaceId) {
      setValue(null);
      return;
    }
    let cancelled = false;
    let currentSocket: HocuspocusProviderWebsocket | null = null;
    let currentUrl: string | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    // `view` is a chat-only mode; the human document host only edits/suggests.
    // Read live so a mode toggle (which re-auths the socket) picks up the new
    // mode without recreating the token getter.
    const hostEditMode = () => (editModeRef.current === 'view' ? 'edit' : editModeRef.current);
    const { getToken, setToken } = createCollabTokenGetter({
      fetchHost: () => fetchWorkspaceHost(workspaceId, { ensure: true, editMode: hostEditMode() }),
      isCancelled: () => cancelled,
    });
    clearTokenRef.current = () => setToken('');

    const schedulePoll = () => {
      if (cancelled) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => {
        void connectOrRefresh();
      }, RECONNECT_POLL_INTERVAL_MS);
    };

    const adoptHost = (host: { collabUrl: string; token: string; docNamePrefix?: string | null }) => {
      setToken(host.token);
      if (host.collabUrl === currentUrl && currentSocket) {
        // URL unchanged — keep existing socket. HocuspocusProviderWebsocket has
        // its own internal retry loop; nothing to do here.
        schedulePoll();
        return;
      }
      // Default messageReconnectTimeout is 30s, which fires whenever no Yjs
      // message arrives that long — trivially hit with a single idle editor
      // since there's no cross-client awareness to keep it warm. The server
      // already sends WS-level pings every 15s, so dead sockets surface via
      // close events; extend the app-layer timeout to avoid the noisy
      // disconnect → reconnect → re-sync cycle during idle turns.
      const nextSocket = new HocuspocusProviderWebsocket({
        url: host.collabUrl,
        messageReconnectTimeout: 5 * 60_000,
      });
      // Patch detach to be identity-safe. Hocuspocus's own implementation
      // deletes providerMap[docName] without checking that the provider
      // being detached is still the registered one. In React StrictMode (or
      // any brief two-editor-same-doc overlap) the first mount's cleanup
      // thus yanks the second mount's entry and sends CloseMessage on its
      // behalf — server closes the Connection, sock=0, broadcasts go
      // nowhere. See node_modules/.pnpm/@hocuspocus+provider@3.4.4/.../
      // HocuspocusProviderWebsocket.ts `detach()`.
      patchIdentitySafeDetach(nextSocket);
      const previousSocket = currentSocket;
      currentSocket = nextSocket;
      socketRef.current = nextSocket;
      currentUrl = host.collabUrl;
      if (initialSnapshot && host.docNamePrefix) {
        primeProvider(
          nextSocket,
          `${host.docNamePrefix}${initialSnapshot.path}`,
          initialSnapshot,
          getToken,
        );
      }
      versionRef.current += 1;
      setValue({
        // Publish the RESOLVED id (docNamePrefix carries the UUID): on anon
        // ?pshare= links the layout only knows the public_id slug, while the
        // page adopts the UUID from /files — the hook must keep matching the
        // shared socket after that adoption (a one-off fallback provider
        // would freeze a 15-min grants token with no refresh).
        workspaceId: host.docNamePrefix ? host.docNamePrefix.replace(/\/$/, '') : workspaceId,
        socket: nextSocket,
        getToken,
        collabUrl: host.collabUrl,
        docNamePrefix: host.docNamePrefix ?? null,
        version: versionRef.current,
        reconnect: watchdogReconnect(nextSocket),
      });
      previousSocket?.destroy();
      schedulePoll();
    };

    const connectOrRefresh = async () => {
      if (cancelled) return;
      // Always ensure: the backend short-circuits when the stored URL still
      // probes healthy, so this only costs a Modal ensure-sandbox call when the host is
      // actually gone. Previously we only ensured on first connect, which
      // meant a transient probe failure that wiped host_url left the client
      // stuck with a dead socket forever.
      const fetchedMode = hostEditMode();
      const host = await fetchWorkspaceHost(workspaceId, {
        ensure: true,
        editMode: fetchedMode,
      }).catch(() => null);
      if (cancelled) return;
      if (!host) {
        schedulePoll();
        return;
      }
      // The mode changed while the request was in flight — e.g. a reload that
      // restores a stored Suggest session (the provider renders `edit` first,
      // then loads `suggest`), or a quick toggle during a poll. The token was
      // minted for the old mode; discard and refetch so we never create or
      // authenticate the socket with a stale mode (the toggle effect's re-auth
      // can't help here when the socket doesn't exist yet).
      if (fetchedMode !== hostEditMode()) {
        void connectOrRefresh();
        return;
      }
      adoptHost(host);
    };

    // SSR-minted credentials: open the socket NOW (TLS + WS handshake + doc
    // sync start on hydration) and let the regular poll refresh the token.
    // Adopt them only when they match what a client fetch would mint —
    // client-only credentials the layout could not see must win, because the
    // poll only refreshes the cached token and never re-authenticates the
    // already-open socket:
    //  - stored Suggest mode: the SSR token is EDIT-mode, and the mode
    //    provider above still holds the default here (its localStorage load
    //    runs in a later effect) — edits typed before the toggle re-auth
    //    would persist as direct edits. Stored `view` maps to an edit-mode
    //    socket (hostEditMode), so only `suggest` opts out.
    //  - a sticky ?pshare= token: it can elevate a workspace-readable
    //    visitor's role, and the layout never sees it.
    //  - an sd_anon cookie that no longer matches the id the token's uid
    //    derives from (another tab minted, replaced, or claim-cleared it):
    //    socket edits would attribute to the wrong anon identity. A minted
    //    id tolerates an absent cookie (we set it below); a cookie-read id
    //    requires the same cookie to still be there.
    const storedMode = readStoredEditMode(documentEditModeStorageKey(workspaceId));
    const existingAnon = readAnonCookie();
    const anonMatches = !initialHost?.anonId
      ? true
      : initialHost.anonMinted
        ? !existingAnon || existingAnon === initialHost.anonId
        : existingAnon === initialHost.anonId;
    if (initialHost && storedMode !== 'suggest' && !currentPathShareToken() && anonMatches) {
      if (initialHost.anonMinted && initialHost.anonId && !existingAnon) setAnonCookie(initialHost.anonId);
      ssrClerkUidRef.current = initialHost.clerkUserId ?? null;
      adoptHost(initialHost);
    } else {
      ssrClerkUidRef.current = undefined;
      void connectOrRefresh();
    }

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      currentSocket?.destroy();
      if (socketRef.current === currentSocket) socketRef.current = null;
      clearTokenRef.current = null;
      setValue(null);
    };
    // editMode is intentionally NOT a dep — recreating the socket would destroy
    // every cached Y.Doc and force a full re-sync ("reload the whole file" on
    // every Edit/Suggest toggle). The toggle effect below re-auths in place.
    // initialHost is a one-shot SSR value for this workspace; re-running for it
    // would rebuild the socket and drop every cached Y.Doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Clerk resolves AFTER the SSR credentials open the socket. If the live
  // identity differs from the uid the token was minted for — signed out,
  // switched accounts, or signed IN over an anonymous SSR render, all in
  // another tab before hydration — the open socket must not keep the stale
  // account's capabilities/attribution for the token's lifetime (the poll
  // only refreshes the CACHED token). Drop the cache and re-open the live WS:
  // every provider re-authenticates via getToken → fetchWorkspaceHost, which
  // reads the live cookies. One-shot per adoption.
  const { isLoaded: clerkLoaded, userId: liveClerkUserId } = useAuth();
  useEffect(() => {
    if (ssrClerkUidRef.current === undefined || !clerkLoaded) return;
    const expected = ssrClerkUidRef.current;
    ssrClerkUidRef.current = undefined;
    if ((liveClerkUserId ?? null) === expected) return;
    clearTokenRef.current?.();
    const socket = socketRef.current;
    if (socket) reauthenticateSocket(socket);
  }, [clerkLoaded, liveClerkUserId]);

  // Flipping Edit↔Suggest must re-tag future persists (the server reads
  // `editMode` from the connection token). Instead of rebuilding the socket,
  // drop the cached token and re-open the live WS: every attached provider
  // re-runs onOpen → sendToken with the fresh mode, keeping its Y.Doc — so the
  // open document never reloads. Skips the initial mount (the socket effect
  // already connects with the current mode).
  //
  // Online (the common case) is correct: the outbound queue is empty and
  // pre-toggle edits are already recorded server-side under the OLD connection
  // context, so only future edits take the new mode. Known limitation: edits
  // typed while OFFLINE (queued, unrecorded) then toggled flush under the new
  // mode on reconnect — a pre-existing property of tying mode to the connection
  // (the prior socket-rebuild had it too) that needs per-update mode signalling
  // to fix; tracked as a follow-up.
  const modeMountedRef = useRef(false);
  useEffect(() => {
    if (!modeMountedRef.current) {
      modeMountedRef.current = true;
      return;
    }
    clearTokenRef.current?.();
    const socket = socketRef.current;
    if (socket) reauthenticateSocket(socket);
  }, [editMode]);

  return (
    <PendingCtx.Provider value={value === null && Boolean(workspaceId)}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </PendingCtx.Provider>
  );
}

/**
 * Local-mode variant: binds the editors to the desktop sidecar's Hocuspocus
 * endpoint instead of the cloud. Same context, so CollabEditor /
 * CollabCodeEditor work unchanged — docName resolves to
 * `${projectId}/${filePath}`, exactly what the sidecar serves. The token is a
 * static per-install secret (no expiry), so no refresh loop is needed.
 */
export function LocalCollabSocketProvider({
  projectId,
  wsUrl,
  token,
  children,
}: {
  projectId: string;
  wsUrl: string;
  token: string;
  children: React.ReactNode;
}) {
  const [value, setValue] = useState<WorkspaceCollabSocket | null>(null);

  useEffect(() => {
    if (!projectId || !wsUrl || !token) {
      setValue(null);
      return;
    }
    const socket = new HocuspocusProviderWebsocket({
      url: wsUrl,
      messageReconnectTimeout: 5 * 60_000,
    });
    patchIdentitySafeDetach(socket);
    setValue({
      workspaceId: projectId,
      socket,
      getToken: async () => token,
      collabUrl: wsUrl,
      docNamePrefix: `${projectId}/`,
      isLocal: true,
      version: 1,
      reconnect: watchdogReconnect(socket),
    });
    return () => {
      socket.destroy();
      setValue(null);
    };
  }, [projectId, wsUrl, token]);

  // Children wait for the socket: rendering the editors one frame earlier
  // makes their no-sharedSocket fallback query the CLOUD host with a
  // local-only project id — a privacy leak and a bogus lookup.
  return <Ctx.Provider value={value}>{value ? children : null}</Ctx.Provider>;
}

export function useWorkspaceCollabSocketPending() {
  return useContext(PendingCtx);
}

/** Returns the shared socket only when it matches the caller's workspaceId. */
export function useWorkspaceCollabSocket(workspaceId: string | undefined) {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  if (!workspaceId) return null;
  if (ctx.workspaceId !== workspaceId) return null;
  return ctx;
}
