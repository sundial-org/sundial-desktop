'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, useClerk, useUser } from '@/lib/auth/optional-auth';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { isDesktopApp } from '@/lib/desktop';
import { useDesktopCredentials } from '@/lib/local/use-desktop-credentials';
import { sidecar, type LocalProject, type LocalShare, type SidecarConfig } from '@/lib/local/sidecar';
import { ModalShell } from '@/components/modal-shell';
import { WorkspaceShareModal } from '@/app/w/[slug]/_components/workspace-share-modal';
import { PathShareModal, usePathShares } from '@/app/w/[slug]/_components/path-share-modal';
import { shareOrigin, useWorkspaceShare, type ShareInfo } from '@/app/w/[slug]/_components/workspace-share';
import { STANDARD_WORKSPACE_KIND } from '@/lib/workspace/kinds';
import { LINK_INVITE_EMAIL } from '@/lib/workspace/invites';
import { formatRelativeTimeShort } from '@/lib/format';

/** Cloud-workspace links must not yank the user out of their local project.
 *  Browsers open a new tab; the desktop shell can't (the webview drops
 *  target="_blank"), so there the link goes through the /desktop/external
 *  marker, which the shell intercepts and opens in the SYSTEM BROWSER. */
const cloudHref = (target: string) => {
  if (!isDesktopApp()) return target;
  try {
    // open_url may be absolute; the marker only ejects same-origin PATHS.
    const url = new URL(target, window.location.origin);
    if (url.origin !== window.location.origin) return target;
    return `/desktop/external?to=${encodeURIComponent(url.pathname + url.search + url.hash)}`;
  } catch {
    return target;
  }
};
const blankTarget = () => (isDesktopApp() ? undefined : '_blank');

/** `path` is the file path for path scopes, the LOCAL chat id for chat
 *  scopes; `label` is the display name (chat title) when `path` isn't
 *  presentable. */
export type ShareScope = { kind: 'project' | 'folder' | 'file' | 'chat'; path: string; label?: string };

const scopeName = (scope: { kind: string; path: string }, projectName: string) =>
  scope.kind === 'project' || !scope.path ? projectName : scope.path;

// Pre-share state for the GDocs-style modal: Restricted, nobody invited yet.
const UNSHARED_INFO: ShareInfo = {
  linkShare: null,
  isOwner: true,
  canInvite: true,
  organization: null,
  members: [],
  invites: [],
};

const contains = (outer: string, inner: string) => !outer || inner === outer || inner.startsWith(`${outer}/`);

async function api<T>(path: string, failure: string, body?: object, method?: string): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...(body
      ? { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(parsed?.error || failure);
  return parsed;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One calm question before any stop, as a REAL in-app modal — never
 *  window.confirm/alert, which the desktop (Tauri) webview refuses
 *  ("dialog.confirm not allowed. Command not found"), silently skipping the
 *  warning. Copy stays calm: people lose access, no data-retention
 *  narration. */
export function StopShareConfirmDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell
      open={open}
      onClose={onCancel}
      ariaLabel="Stop sharing?"
      overlayClassName="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      panelClassName="w-full max-w-sm rounded-2xl bg-white border border-stone-200 shadow-xl"
    >
      <div className="px-5 pt-5 pb-4" data-testid="share-stop-confirm">
        <h2 className="text-base font-semibold text-stone-800">Stop sharing?</h2>
        <p className="mt-1.5 text-sm text-stone-500">People with the link will lose access.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="share-stop-cancel"
            className="rounded-lg border border-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid="share-stop-proceed"
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
          >
            Stop sharing
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/** Shares a local scope to the cloud through ONE hidden backing workspace per
 *  project (created lazily on first share, reused forever): the sidecar syncs
 *  the union of shared scopes into it at their real relative paths, and each
 *  folder/file/chat scope's audience is a `path_shares` grant on that
 *  workspace (`?pshare=` links, per-path roles — the same modal as cloud
 *  per-path sharing). A whole-PROJECT link share is the workspace-ROOT grant
 *  (scope_kind='workspace') — the backing workspace itself stays private;
 *  email invites still use the workspace ACL. Scopes may overlap — each has
 *  its own audience. Older one-workspace-per-scope shares keep working
 *  untouched; new shares always use the backing-workspace model. */
export function ShareLocalModal({
  config,
  project,
  scope,
  shares,
  onClose,
  onShared,
}: {
  config: SidecarConfig;
  project: LocalProject;
  scope: ShareScope;
  shares: LocalShare[];
  onClose: () => void;
  onShared: () => void;
}) {
  const router = useRouter();
  const { user } = useUser();
  const { isSignedIn: clerkSignedIn } = useAuth();
  const { openSignIn } = useClerk();
  // The packaged app has no webview Clerk session — sidecar sd_ credentials
  // are its sign-in state (the proxy attaches them to the cloud calls below).
  const desktopCredentials = useDesktopCredentials(config) === true;
  const isSignedIn = clerkSignedIn || desktopCredentials;

  const enabled = shares.filter((share) => share.enabled);
  const isChatScope = scope.kind === 'chat';
  const scopePath = scope.kind === 'project' ? '' : scope.path;
  // Grants-model entries (id `scope:<n>`) carry the union share row's id.
  const scopeEntries = enabled.filter((share) => share.share_id);
  const legacyShares = enabled.filter((share) => !share.share_id);
  const entry =
    scopeEntries.find((share) => share.scope_kind === scope.kind && share.scope_path === scopePath) ?? null;
  // The one backing workspace per project: any scope entry names it; with no
  // entries left the sidecar still remembers it (backing_workspace_id).
  const [rememberedBacking, setRememberedBacking] = useState<string | null>(null);
  const currentProjectRef = useRef(project.id);
  currentProjectRef.current = project.id;
  useEffect(() => {
    let cancelled = false;
    // Project switched without a remount: the previous project's backing id
    // must never leak into this one.
    setRememberedBacking(null);
    void sidecar
      .getProject(config, project.id)
      .then(({ backing_workspace_id }) => {
        // Never CLEAR a known id: this read can resolve after a first share
        // already adopted a freshly created workspace.
        if (!cancelled) setRememberedBacking((prev) => prev ?? backing_workspace_id ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [config, project.id]);
  const backingWorkspaceId = entry?.workspace_id ?? scopeEntries[0]?.workspace_id ?? rememberedBacking;
  const mirrorChatId = isChatScope && backingWorkspaceId ? `${scope.path}:${backingWorkspaceId}` : null;

  // Legacy (one-workspace-per-scope) shares still covering or nested in this
  // scope: grants can't coexist with them (two engines would double-relay),
  // so they surface with Stop actions instead of silently failing.
  const legacyConflicts = isChatScope
    ? legacyShares.filter((share) => share.scope_kind === 'chat' && share.scope_path === scope.path)
    : legacyShares.filter(
        (share) =>
          share.scope_kind !== 'chat' &&
          (contains(share.scope_path, scopePath) || contains(scopePath, share.scope_path)),
      );

  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'visibility-public' | 'email' | 'stop' | null>(null);
  const busy = busyAction !== null;

  // Both stop paths (this scope and legacy rows) warn through the in-app
  // StopShareConfirmDialog above — a promise-based gate the stop flows await.
  const stopConfirmRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const confirmStop = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        stopConfirmRef.current?.(false); // a newer request supersedes the old
        stopConfirmRef.current = resolve;
        setStopConfirmOpen(true);
      }),
    [],
  );
  const settleStopConfirm = useCallback((confirmed: boolean) => {
    setStopConfirmOpen(false);
    const resolve = stopConfirmRef.current;
    stopConfirmRef.current = null;
    resolve?.(confirmed);
  }, []);
  // While the confirm is up, Escape/backdrop on the PARENT share modal (both
  // ModalShells listen document-wide) must dismiss only the confirm — not
  // tear down the whole share modal underneath it (Codex P3).
  const closeUnlessConfirming = useCallback(() => {
    if (stopConfirmRef.current) {
      settleStopConfirm(false);
      return;
    }
    onClose();
  }, [onClose, settleStopConfirm]);
  const stopConfirmDialog = (
    <StopShareConfirmDialog
      open={stopConfirmOpen}
      onCancel={() => settleStopConfirm(false)}
      onConfirm={() => settleStopConfirm(true)}
    />
  );

  // Sign-in gate shared by every share gesture: signed out, the gesture
  // becomes the sign-in action (DesktopAuthInterceptor routes it through the
  // browser handoff in the shell).
  const requireSignIn = useCallback(() => {
    if (isSignedIn) return true;
    openSignIn?.({ forceRedirectUrl: window.location.pathname });
    return false;
  }, [isSignedIn, openSignIn]);

  /** Ensure the backing workspace exists, this scope syncs into it, and the
   *  grant target (file/folder/mirror chat) is visible cloud-side. Single-
   *  flight per scope; a failure clears the latch so the next gesture
   *  retries. Returns the resolved ids for the grant mutation. */
  const ensureRef = useRef<Promise<{ projectId: string; chatId?: string; generation?: number }> | null>(null);
  // The sidecar generation this modal's scope is live AT (PR #1033): every
  // grant mint carries it, so the cloud can refuse mints a stop already
  // out-generationed — even when this tab dies mid-flight.
  const scopeGenerationRef = useRef<number | null>(null);
  useEffect(() => {
    ensureRef.current = null;
    scopeGenerationRef.current = null;
  }, [project.id, scope.kind, scopePath]);
  // Reopened modal on an ALREADY-shared scope: the entry prop knows the live
  // generation — without this seed, mints from the generic hook flows would
  // bypass the server-side watermark gate (Codex P1 round 10).
  const entryGeneration = entry?.generation ?? null;
  useEffect(() => {
    if (entryGeneration != null) scopeGenerationRef.current = entryGeneration;
  }, [entryGeneration]);
  const ensureScope = useCallback((): Promise<{ projectId: string; chatId?: string; generation?: number }> => {
    if (!requireSignIn()) return Promise.reject(new Error('Sign in to share'));
    const run = async () => {
      // Only FILES sync (empty folders have no cloud row to grant on), so an
      // empty scope would start syncing yet time out waiting for its grant
      // target forever — refuse up front instead (PR-bot P2).
      if (scope.kind === 'folder' || scope.kind === 'file') {
        const { files } = await sidecar.listFiles(config, project.id);
        const hasTarget = files.some(
          (file) =>
            file.type !== 'folder' &&
            (scope.kind === 'file' ? file.path === scope.path : file.path === scope.path || file.path.startsWith(`${scope.path}/`)),
        );
        if (!hasTarget) {
          throw new Error(
            scope.kind === 'file' ? 'This file no longer exists.' : 'This folder has no files to share yet.',
          );
        }
      }
      let workspaceId = backingWorkspaceId;
      let generation = entry?.generation ?? null;
      if (!entry) {
        if (legacyConflicts.length > 0) {
          throw new Error('Already shared with an older share. Stop it below first.');
        }
        if (!workspaceId) {
          const created = await api<{ project: { id: string } }>('/api/workspace', 'Failed to create workspace', {
            title: project.name,
            seedStarter: false,
            kind: 'local-backing',
          });
          workspaceId = created.project.id;
          // Adopt it IMMEDIATELY — if the host/token/sidecar steps below
          // fail, the retry must reuse this (hidden!) workspace instead of
          // minting an orphan per attempt.
          if (currentProjectRef.current === project.id) setRememberedBacking(workspaceId);
        }
        // Chat shares sync through the ledger only — no collab socket, so no
        // Hocuspocus dependency. Host ensure + token mint are independent.
        const [host, join] = await Promise.all([
          isChatScope
            ? Promise.resolve<{ collabUrl?: string }>({})
            : api<{ collabUrl?: string }>(
                `/api/workspace/host?workspaceId=${encodeURIComponent(workspaceId)}&ensure=1`,
                'Collab host unavailable',
              ),
          api<{ token?: string }>('/api/workspace/local-agent/join', 'Failed to mint sync token', {
            projectId: workspaceId,
            bridge: true,
          }),
        ]);
        if (!isChatScope && !host.collabUrl) throw new Error('Collab host unavailable');
        if (!join.token) throw new Error('Failed to mint sync token');
        const created = await sidecar.createShare(config, project.id, {
          grants: true,
          workspaceId,
          collabUrl: host.collabUrl ?? '',
          apiOrigin: window.location.origin,
          token: join.token,
          scopeKind: scope.kind,
          scopePath,
        });
        generation = created.share?.generation ?? null;
        onShared();
      }
      if (!workspaceId) throw new Error('Failed to create workspace');
      if (generation != null) scopeGenerationRef.current = generation;
      // Make the id visible to the whole modal NOW — waiting for the sidecar
      // share-list refresh leaves a window where role picks / grant fetches
      // have no workspace to target. (Skipped if the modal switched projects
      // while this flight ran — another project's id must never leak in.)
      if (currentProjectRef.current === project.id) setRememberedBacking(workspaceId);
      // Grants need their target to exist cloud-side (the path-shares API
      // fails closed on phantom paths) — wait out the scope's first sync.
      if (scope.kind !== 'project') {
        const chatId = isChatScope ? `${scope.path}:${workspaceId}` : null;
        const deadline = Date.now() + 60_000;
        for (;;) {
          const found = isChatScope
            ? await api<{ chats?: { chat: { id: string } }[] }>(
                `/api/workspace/chats?projectId=${encodeURIComponent(workspaceId)}`,
                'Failed to check sync',
              ).then((payload) => (payload.chats ?? []).some((thread) => thread.chat.id === chatId))
            : await api<{ files?: { path: string }[] }>(
                `/api/workspace/files?projectId=${encodeURIComponent(workspaceId)}`,
                'Failed to check sync',
              ).then((payload) =>
                (payload.files ?? []).some(
                  (file) => file.path === scopePath || file.path.startsWith(`${scopePath}/`),
                ),
              );
          if (found) break;
          if (Date.now() > deadline) {
            throw new Error('Still syncing to the cloud. Try again in a moment.');
          }
          await wait(1500);
        }
        return { projectId: workspaceId, ...(chatId ? { chatId } : {}), ...(generation != null ? { generation } : {}) };
      }
      return { projectId: workspaceId, ...(generation != null ? { generation } : {}) };
    };
    ensureRef.current ??= run().catch((err) => {
      ensureRef.current = null;
      throw err;
    });
    return ensureRef.current;
  }, [backingWorkspaceId, config, entry, isChatScope, legacyConflicts.length, onShared, project.id, project.name, requireSignIn, scope.kind, scope.path, scopePath]);

  // ---- Folder / file / chat scopes: the per-path grant modal --------------

  const cloud = usePathShares(backingWorkspaceId ?? null, Boolean(isSignedIn && backingWorkspaceId));

  // A scope grant is only as narrow as the WORKSPACE around it: share the
  // whole project, then share one file, and that file's link opens everything
  // — which is precisely what the per-path modal promises it won't. Load the
  // backing workspace's ACL so the modal can say so (and undo it).
  const [projectAccess, setProjectAccess] = useState<{ linkShared: boolean; others: number } | null>(null);
  const loadProjectAccess = useCallback(async () => {
    if (!backingWorkspaceId || !isSignedIn) return;
    try {
      const info = await api<{
        linkShare?: { id: string } | null;
        members?: { role: string }[];
        invites?: { email: string | null; accepted_at: string | null }[];
      }>(`/api/workspace/share?projectId=${encodeURIComponent(backingWorkspaceId)}`, 'Failed to load access');
      setProjectAccess({
        linkShared: Boolean(info.linkShare),
        // Pending invites count: accepting one grants the WHOLE project, so a
        // scope modal that ignored them would still promise "nothing else".
        // (Reusable LINK invites keep granting after acceptance — Codex P2.)
        others:
          (info.members ?? []).filter((member) => member.role !== 'owner').length +
          (info.invites ?? []).filter((invite) => !invite.accepted_at || invite.email === LINK_INVITE_EMAIL).length,
      });
    } catch {
      // Transient — silence beats a scary banner built on a failed read.
    }
  }, [backingWorkspaceId, isSignedIn]);
  useEffect(() => {
    if (scope.kind !== 'project') void loadProjectAccess();
  }, [loadProjectAccess, scope.kind]);

  const broaderAccess = useMemo(() => {
    if (scope.kind === 'project' || !projectAccess) return null;
    const { linkShared, others } = projectAccess;
    if (!linkShared && others === 0) return null;
    const audience = linkShared
      ? 'Anyone with the project link can already open this whole project'
      : `${others} ${others === 1 ? 'person has' : 'people have'} access to this whole project`;
    return {
      label: `${audience}, including this ${scope.kind}.`,
      ...(linkShared
        ? {
            onRestrict: async () => {
              // Link off = revoke the root grant (tokened or tokenless).
              await api(
                '/api/workspace/path-shares',
                'Failed to restrict the project',
                { projectId: backingWorkspaceId, scope: 'workspace' },
                'DELETE',
              );
              await loadProjectAccess();
            },
          }
        : {}),
    };
  }, [backingWorkspaceId, loadProjectAccess, projectAccess, scope.kind]);

  /** Fail-closed audience revoke on the backing workspace: every non-owner
   *  member and revocable invite, then link access in both lanes (root grant
   *  + legacy public visibility). Used where the workspace ACL is the stopped
   *  share's OWN audience: project-scope stops and legacy shares (whose
   *  workspace belongs to that share alone). Any failure throws BEFORE the
   *  sync is torn down, because a swallowed failure would leave someone with
   *  live access while the UI says sharing stopped (revoking is monotonic,
   *  so the parallel batch's partial progress only ever removes access).
   *  The LAST-scope "nothing survives → revoke everything" sweep is NOT here:
   *  it must be atomic with concurrent scope adds, so the sidecar performs it
   *  inside its per-project mutation lock (bridge.mjs withProjectLock). */
  const revokeWorkspaceAudience = useCallback(async (workspaceId: string, stoppedGeneration?: number | null) => {
    // Root grant + WATERMARK first: with a generation this DELETE raises the
    // cloud revocation watermark, and it must land BEFORE the ACL wipe below
    // — invite mints write-then-check against it, so raise-then-wipe is what
    // makes a racing invite die server-side in every interleaving. (A newer
    // re-added project scope's root grant survives the ≤-scoped delete.)
    await api(
      '/api/workspace/path-shares',
      'Failed to disable link access',
      {
        projectId: workspaceId,
        scope: 'workspace',
        ...(stoppedGeneration != null ? { stoppedGeneration } : {}),
      },
      'DELETE',
    );
    // Then ONE transactional call wipes every non-owner member, every
    // revocable invite (accepted EMAIL invites are consumed; LINK invites
    // re-admit forever, so they go regardless), and legacy public visibility
    // — serialized in Postgres against a racing invite acceptance. Per-row
    // deletes from the client would reopen the acceptance race (PR #1033).
    await api('/api/workspace/share', 'Failed to revoke access. Sharing was NOT stopped.', {
      projectId: workspaceId,
      audience: true,
    }, 'DELETE');
  }, []);

  /** Mint-confirm (Codex P1): audience minted here is only live if the
   *  sidecar still records the scope — the mint runs AFTER addShareScope
   *  released the sidecar's per-project lock, so a stop can land in between.
   *  The confirm reads under that same lock: scope gone → revoke the freshly
   *  minted audience (idempotent) and fail the gesture. Stops close the other
   *  ordering (mint confirmed before their locked removal) by re-revoking the
   *  target after the removal. */
  const confirmScopeLive = useCallback(
    async (workspaceId: string, { revokeOnError = true, mintedGeneration = null as number | null } = {}) => {
      // Runs only when the scope is PROVABLY gone (or re-added at another
      // generation) — never on a transport error, see the catch below.
      const revokeMinted = async () => {
        ensureRef.current = null;
        // Generation-scoped rollback: revoke what WE minted (≤ the generation
        // FROZEN at mint time — the live ref may have advanced to a re-added
        // scope's newer generation mid-flight, and raising the watermark
        // through THAT would revoke the share this scheme protects).
        const bound = mintedGeneration == null ? {} : { stoppedGeneration: mintedGeneration };
        if (scope.kind === 'project' && mintedGeneration != null) {
          // Generationed project mints are grants/invites the server already
          // gates (invites self-rollback in the route): the client rollback
          // only needs the ≤-scoped root delete — an unserialized full ACL
          // wipe here could strip a concurrently re-added scope's audience.
          await api('/api/workspace/path-shares', 'Failed to revoke share', {
            projectId: workspaceId,
            scope: 'workspace',
            ...bound,
          }, 'DELETE');
        } else if (scope.kind === 'project') {
          // Old sidecar (no generation): legacy full wipe is the only cover.
          await revokeWorkspaceAudience(workspaceId, null);
        } else {
          await api('/api/workspace/path-shares', 'Failed to revoke share', {
            projectId: workspaceId,
            ...(isChatScope ? { chatId: `${scopePath}:${workspaceId}` } : { path: scopePath }),
            ...bound,
          }, 'DELETE');
        }
      };
      let live = false;
      let generation: number | null = null;
      try {
        ({ live, generation = null } = await sidecar.confirmScope(config, project.id, {
          workspaceId,
          scopeKind: scope.kind,
          scopePath,
        }));
      } catch (err) {
        // UNCONFIRMED (the sidecar is unreachable, restarting, …). With a
        // generation the SERVER is the authority and no rollback belongs
        // here: a stop raises the target watermark — and the workspace-wide
        // epoch — BEFORE it wipes, and mints write-then-check, so a mint that
        // lost to a stop is already dead server-side. Deleting the target
        // grant here would instead destroy a LIVE scope's established
        // audience (its existing link and members, not just this gesture's
        // mint) over a transport blip (Codex P2 round 33). Only an
        // ungenerationed mint — old sidecar, no server-side gate at all —
        // must not outlive the doubt.
        if (revokeOnError && mintedGeneration == null) await revokeMinted();
        throw err;
      }
      // A live scope is not necessarily OUR scope: a stop + re-add in another
      // window leaves a LIVE one at a newer generation, and the gestures that
      // are not generation-guarded server-side (the root link-role PATCH)
      // would otherwise land on it. Same generation, or none on either side
      // (older sidecar / legacy scope) = the pre-generation behavior (Codex
      // P1 round 23).
      if (live && (mintedGeneration == null || generation == null || generation === mintedGeneration)) return;
      await revokeMinted();
      throw new Error('Sharing was stopped while this was starting. Try again.');
    },
    [config, isChatScope, project.id, revokeWorkspaceAudience, scope.kind, scopePath],
  );

  const stopScope = useCallback(async () => {
    if (!entry || !(await confirmStop())) return;
    setError(null);
    try {
      // Audience off first — revoke by TARGET, not a loaded row id: the stop
      // must kill the grant even when the grants fetch hasn't landed (or
      // failed), and only a successful revoke may proceed to stop the sync.
      // Generation-scoped (PR #1033): the DELETE raises the target's cloud
      // revocation watermark to this scope's generation, so a racing mint at
      // ≤ it is refused or self-deletes server-side — while a concurrently
      // RE-ADDED scope's newer-generation grant survives. No post-stop
      // re-delete: path-keyed compensations are exactly what killed re-adds.
      await api('/api/workspace/path-shares', 'Failed to revoke share', {
        projectId: entry.workspace_id,
        ...(isChatScope ? { chatId: `${scope.path}:${entry.workspace_id}` } : { path: scopePath }),
        ...(entry.generation != null ? { stoppedGeneration: entry.generation } : {}),
      }, 'DELETE');
      void cloud.refresh();
      // Then stop syncing — the cloud twins stay in the backing workspace as
      // history. `revoked`: this scope's OWN grant is already off, so the
      // sidecar skips re-revoking it (a stale bridge token must not brick a
      // stop whose audience is gone). If this was the LAST scope, the sidecar
      // sweeps every remaining audience itself, inside its project mutation
      // lock — atomically with any concurrent scope add; a FRESH bridge token
      // rides along (best-effort) so that sweep never aborts on the stored
      // stale one.
      const join = await api<{ token?: string }>('/api/workspace/local-agent/join', 'Failed to mint sync token', {
        projectId: entry.workspace_id,
        bridge: true,
      }).catch(() => null);
      await sidecar.removeShare(config, project.id, entry.id, { revoked: true, token: join?.token ?? null });
      ensureRef.current = null;
      onShared();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop sharing');
    }
  }, [cloud, config, confirmStop, entry, isChatScope, onShared, project.id, scope.path, scopePath]);

  const stopLegacyShare = useCallback(
    async (share: LocalShare) => {
      if (busy || !(await confirmStop())) return;
      setBusyAction('stop');
      setError(null);
      try {
        // A legacy share's audience is its OWN one-workspace-per-scope cloud
        // workspace's ACL/visibility — revoke it all, fail-closed, before the
        // sync stops (that workspace keeps the synced data as history, same
        // as grants-model stops).
        await revokeWorkspaceAudience(share.workspace_id);
        await sidecar.removeShare(config, project.id, share.id);
        onShared();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to stop sharing');
      } finally {
        setBusyAction(null);
      }
    },
    [busy, config, confirmStop, onShared, project.id, revokeWorkspaceAudience],
  );

  // ---- Project scope: the workspace share modal ---------------------------
  // Link audience = the workspace-ROOT grant; people audience = the
  // workspace ACL (members/invites). The backing workspace stays private.

  const [createdPublic, setCreatedPublic] = useState(false);
  const [sessionShared, setSessionShared] = useState(false);
  // The public flip renders INSTANTLY (the ensure chain takes ~2s); reverted
  // on failure. Single-flight promise so Copy link during the flight awaits
  // the same creation instead of racing it (or copying a stale clipboard).
  // Only the DISPLAY flips optimistically — handler routing stays pre-share
  // until the ensure resolves, so Copy link during the flight joins it.
  const [flipPending, setFlipPending] = useState(false);
  // Copy link can be waiting on the in-flight creation (~2s) — surface it.
  const [copyBusy, setCopyBusy] = useState(false);
  const pendingProjectShareRef = useRef<Promise<string | null> | null>(null);
  // Link role picked while the creation is still in flight (the hook is inert
  // until the workspace exists): rendered optimistically, applied on resolve.
  const [optimisticAccess, setOptimisticAccess] = useState<'view' | 'suggest' | 'edit'>('view');
  const optimisticAccessRef = useRef(optimisticAccess);
  optimisticAccessRef.current = optimisticAccess;
  const projectShared = Boolean(entry) || sessionShared;
  const workspaceShare = useWorkspaceShare({
    // Held back until the flip lands: the sidecar's share row appears (making
    // this "shared") a beat BEFORE the visibility PATCH, so an ACL fetch
    // started here would read the pre-flip row and render Restricted over the
    // share the user just made. Clearing the latch triggers a fresh read.
    projectId: (scope.kind === 'project' && projectShared && !flipPending && backingWorkspaceId) || '',
    projectKind: STANDARD_WORKSPACE_KIND,
    workspaceRouteId: (scope.kind === 'project' && projectShared && backingWorkspaceId) || '',
    currentChatId: null,
    user,
    router,
    openSignIn,
    // Invite mints stamp the scope generation so the route's watermark gate
    // (not this browser) is what makes a racing stop win (PR #1033).
    mintScopeGeneration: () => scopeGenerationRef.current,
  });
  const [notice, setNotice] = useState('');
  // Latest hook callbacks for the async flows below: the flight's closures
  // predate the workspace id, so a captured loadShareInfo would no-op.
  const loadShareInfoRef = useRef(workspaceShare.loadShareInfo);
  loadShareInfoRef.current = workspaceShare.loadShareInfo;

  // The root grant's ?pshare= link from the mint below — the copy target
  // until the hook's ACL load takes over.
  const rootLinkRef = useRef<string | null>(null);
  const mintRootGrant = useCallback(
    async (projectId: string, linkRole: 'view' | 'suggest' | 'edit') => {
      // FROZEN at mint time: the ref can advance to a re-added scope's newer
      // generation mid-flight; the rollback must only reach what WE minted.
      const minted = scopeGenerationRef.current;
      const created = await api<{ share?: { linkUrl?: string | null } }>(
        '/api/workspace/path-shares',
        'Failed to enable link access',
        {
          projectId,
          scope: 'workspace',
          linkRole,
          // Generation-gated mint: the cloud refuses this POST outright when a
          // stop already revoked through this generation — no browser
          // follow-up required (PR #1033).
          ...(minted != null ? { scopeGeneration: minted } : {}),
        },
      );
      rootLinkRef.current = created.share?.linkUrl ?? rootLinkRef.current;
      // Every root-grant mint (create, role change, convergence replay) is
      // subordinate to sidecar truth — a stopped scope revokes it and throws.
      await confirmScopeLive(projectId, { mintedGeneration: minted });
    },
    [confirmScopeLive],
  );

  const shareProject = useCallback(
    async (action: 'visibility-public' | 'email'): Promise<string | null> => {
      setBusyAction(action);
      setError(null);
      try {
        const ensured = await ensureScope();
        if (action === 'visibility-public') {
          // "Anyone with the link" = a workspace-ROOT grant on the (hidden,
          // private) backing workspace: its own token + role, instead of
          // making the backing workspace genuinely public.
          await mintRootGrant(ensured.projectId, 'view');
        }
        setSessionShared(true);
        return ensured.projectId;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Share failed');
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [ensureScope, mintRootGrant],
  );

  /** One public-flip flight per modal: the toggle starts it, Copy link joins
   *  it. The flipped state renders INSTANTLY (the ensure chain takes ~2s) and
   *  reverts on failure. */
  const startPublicShare = useCallback((): Promise<string | null> => {
    setCreatedPublic(true);
    setFlipPending(true);
    pendingProjectShareRef.current ??= shareProject('visibility-public')
      .then(async (id) => {
        if (!id) {
          // Failed — revert the optimistic flip, role included (a stale
          // Editor pick must not ride a LATER share attempt).
          setCreatedPublic(false);
          setOptimisticAccess('view');
          return id;
        }
        // Roles picked during the flight would otherwise no-op (the hook was
        // inert until the workspace existed) — apply until the applied value
        // matches the latest pick, RE-CHECKING after each await so a pick
        // landing mid-PATCH is never dropped.
        try {
          let applied: 'view' | 'suggest' | 'edit' = 'view';
          while (optimisticAccessRef.current !== applied) {
            const next: 'view' | 'suggest' | 'edit' = optimisticAccessRef.current;
            // POST upserts the root grant: role moves, token stays stable.
            await mintRootGrant(id, next);
            applied = next;
          }
          // The hook's initial GET can race the PATCHes above and land with
          // the pre-PATCH role — refetch so the display converges.
          if (applied !== 'view') await loadShareInfoRef.current();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to update link access');
        }
        return id;
      })
      .finally(() => {
        setFlipPending(false);
        pendingProjectShareRef.current = null;
      });
    return pendingProjectShareRef.current;
  }, [mintRootGrant, shareProject]);

  /** ALREADY-shared project scopes route link/invite/visibility gestures
   *  through the generic workspaceShare hook — which can MINT audience on the
   *  backing workspace with no idea the local scope exists. Same confirm as
   *  every other mint: after the hook mutation, verify the scope still lives;
   *  a stale modal acting after a stop in another window gets its fresh
   *  audience wiped and told so (Codex P1 round 4). */
  const withScopeConfirm = useCallback(
    <A extends unknown[]>(run: (...args: A) => void | Promise<void>) =>
      async (...args: A) => {
        // Frozen BEFORE the mutation — the rollback must never reach a
        // generation the ref picked up mid-flight.
        const minted = scopeGenerationRef.current;
        await run(...args);
        if (!backingWorkspaceId) return;
        try {
          // revokeOnError: false — some wrapped gestures (Copy link on an
          // existing share) mint nothing, so a transient sidecar error must
          // not wipe a healthy share's audience. A definitive dead scope
          // still revokes.
          await confirmScopeLive(backingWorkspaceId, { revokeOnError: false, mintedGeneration: minted });
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Sharing was stopped. Try again.');
          void loadShareInfoRef.current();
        }
      },
    [backingWorkspaceId, confirmScopeLive],
  );

  /** Link-role change across the share's whole lifecycle: the loaded hook
   *  once the ACL is in; a direct PATCH in the post-create/pre-ACL-load
   *  window; remembered for the in-flight creation to apply at resolve. All
   *  three render the pick optimistically — none may silently drop it. */
  const handleProjectPublicAccess = (publicAccess: 'view' | 'suggest' | 'edit' | 'none') => {
    if (publicAccess === 'none') return; // "Restricted" is the visibility control
    // ALWAYS record the latest intent: a creation flight's convergence loop
    // re-applies until the applied role matches this ref, so a pick made
    // through the loaded hook must move the target too — otherwise a still-
    // pending replay could overwrite it with an older pick.
    setOptimisticAccess(publicAccess);
    if (projectShared && workspaceShare.shareInfo) {
      void withScopeConfirm(workspaceShare.handlePublicAccessChange)(publicAccess);
      return;
    }
    // Creation in flight: its resolution applies the latest pick. Otherwise
    // the workspace already exists (ACL just hasn't loaded) — apply now, then
    // refetch the hook state so a stale in-flight GET can't roll the display
    // back to the pre-PATCH role.
    if (!pendingProjectShareRef.current && backingWorkspaceId) {
      void mintRootGrant(backingWorkspaceId, publicAccess)
        .then(() => loadShareInfoRef.current())
        .catch((err) => setError(err instanceof Error ? err.message : 'Failed to update link access'));
    }
  };

  const handleProjectVisibility = (visibility: 'private' | 'public') => {
    if (visibility !== 'public' || pendingProjectShareRef.current || busy) return;
    if (!requireSignIn()) return;
    void startPublicShare();
  };

  const handleProjectCopyLink = async () => {
    if (busy && !pendingProjectShareRef.current) return;
    if (!pendingProjectShareRef.current && !requireSignIn()) return;
    setCopyBusy(true);
    try {
      const id = await startPublicShare();
      if (!id) return;
      // The root grant's ?pshare= URL — the bare /w/<id> grants nothing now.
      const url = workspaceShare.shareInfo?.linkShare?.url ?? rootLinkRef.current;
      if (!url) {
        setError('Copy failed');
        return;
      }
      await navigator.clipboard.writeText(url);
      setNotice('Link copied');
      window.setTimeout(() => setNotice(''), 3000);
    } catch {
      setError('Copy failed');
    } finally {
      setCopyBusy(false);
    }
  };

  const handleProjectInvite = async () => {
    const email = workspaceShare.inviteEmail.trim().toLowerCase();
    // Validate BEFORE the cloud flip — a bad address must not leave the scope
    // uploaded and syncing with no invite to show for it.
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Enter a valid email address.');
      return;
    }
    if (busy) return;
    const workspaceId = await shareProject('email');
    if (!workspaceId) return;
    setBusyAction('email');
    try {
      // Frozen at mint time — the rollback must never reach a re-added
      // scope's newer generation.
      const minted = scopeGenerationRef.current;
      const sent = await api<{ emailSent?: boolean; invite?: { id?: string } }>('/api/workspace/share', 'Unable to send invite.', {
        projectId: workspaceId,
        role: workspaceShare.inviteRole,
        email,
        // Server-side gate (PR #1033): a stop that out-generations this mint
        // kills the invite in the route itself — even if this tab dies here.
        ...(minted != null ? { scopeGeneration: minted } : {}),
      });
      // The invite is audience minted post-lock too — same confirm as grants.
      // A failed/dead confirm rolls back THIS invite by id (exact: never a
      // re-added scope's audience, unlike a wipe) — the emailed link must not
      // stay redeemable behind a failure message (fail closed).
      try {
        await confirmScopeLive(workspaceId, { mintedGeneration: minted });
      } catch (confirmError) {
        if (sent.invite?.id) {
          await api('/api/workspace/share', 'Failed to revoke the invite. It may still be redeemable.', {
            projectId: workspaceId,
            inviteId: sent.invite.id,
          }, 'DELETE').catch((revokeError) => {
            // Already revoked (the stop's wipe or the server gate got it) is
            // the desired end state — anything else must surface.
            if (!(revokeError instanceof Error && /not found/i.test(revokeError.message))) throw revokeError;
          });
        }
        throw confirmError;
      }
      if (sent.emailSent) {
        setNotice(`Invite sent to ${email}`);
        window.setTimeout(() => setNotice(''), 3000);
      } else {
        setError('Invite created, but the email could not be sent.');
      }
      workspaceShare.setInviteEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send invite.');
    } finally {
      setBusyAction(null);
    }
  };

  /** Stopping the whole-project share = the workspace ACL was its audience:
   *  clear it (members out, invites revoked, link off — plus every remaining
   *  grant when this is the last scope), then stop the sidecar scope. The
   *  cloud twins stay in the backing workspace as history.
   *
   *  The ENTIRE revoke runs in the SIDECAR, inside its project lock (no
   *  `revoked` shortcut here): members/invites carry no generation, so an
   *  unserialized modal-side wipe could strip a scope RE-ADDED between this
   *  stop's checks and its wipe (two windows stop gen N, one wins, a third
   *  re-adds gen N+1 — the loser's late wipe must find the scope gone and
   *  no-op). Under the lock the wipe provably runs against the generation it
   *  stopped: a stale stop 404s instead (Codex P1 round 17). */
  const stopProjectShare = useCallback(async () => {
    if (!entry || !backingWorkspaceId || !(await confirmStop())) return;
    setBusyAction('stop');
    setError(null);
    try {
      // STALE-STOP guard (UX, not the safety line — the lock is): a clear
      // message when the sidecar says this modal's generation is no longer
      // the live one. Old sidecars report no generation and proceed.
      if (entry.generation != null) {
        const current = await sidecar.confirmScope(config, project.id, {
          workspaceId: backingWorkspaceId,
          scopeKind: scope.kind,
          scopePath,
        });
        if (!current.live || (current.generation != null && current.generation !== entry.generation)) {
          throw new Error('Sharing was already stopped from another window.');
        }
      }
      // Fresh bridge token (best-effort) so the sidecar's locked revoke —
      // root grant (watermark-raising, generation-scoped) + transactional
      // ACL wipe + last-scope sweep — never aborts on its stored stale one.
      const join = await api<{ token?: string }>('/api/workspace/local-agent/join', 'Failed to mint sync token', {
        projectId: backingWorkspaceId,
        bridge: true,
      }).catch(() => null);
      await sidecar.removeShare(config, project.id, entry.id, { token: join?.token ?? null });
      ensureRef.current = null;
      rootLinkRef.current = null;
      setSessionShared(false);
      setCreatedPublic(false);
      setOptimisticAccess('view');
      onShared();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop sharing');
    } finally {
      setBusyAction(null);
    }
  }, [backingWorkspaceId, config, confirmStop, entry, onShared, project.id, scope.kind, scopePath]);

  // ---- Shared status / conflict rows --------------------------------------

  const scopeLabel = scope.label ?? scopeName(scope, project.name);
  // Status text rules: a PARKED share (status 'error') surfaces its error —
  // that's trust-critical. Transient poll errors while active must NOT
  // replace the count (they clear on the next poll). Raw status values
  // ('inactive', 'starting') never render verbatim.
  const syncedFiles = entry?.syncedFiles ?? entry?.bridgedFiles ?? 0;
  const statusText = !entry
    ? null
    : entry.status === 'error' || (isChatScope && entry.error)
      ? entry.error ?? 'Sharing stopped'
      : entry.status !== 'active'
        ? 'Starting…'
        : isChatScope
          ? 'Chat shared'
          : scope.kind === 'file'
            ? null // "1 file shared" on a single-file scope states the obvious
            : `${syncedFiles} file${syncedFiles === 1 ? '' : 's'} shared`;

  const legacyConflictRows =
    legacyConflicts.length > 0 ? (
      <div className="mt-1">
        <div className="text-xs font-medium text-stone-500 mb-1">Shared with an older share</div>
        <div className="space-y-1">
          {legacyConflicts.map((share) => (
            <div key={share.id} className="flex items-center gap-3 rounded-lg border border-stone-200 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[13px] text-stone-700">
                {share.scope_kind === 'chat'
                  ? scopeLabel
                  : scopeName({ kind: share.scope_kind, path: share.scope_path }, project.name)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void stopLegacyShare(share)}
                className="text-[12px] font-medium text-stone-500 hover:text-stone-700 disabled:opacity-50"
                data-testid={`share-stop-${share.scope_path || 'project'}`}
              >
                Stop
              </button>
            </div>
          ))}
        </div>
      </div>
    ) : null;

  if (scope.kind !== 'project') {
    return (
      <>
      <PathShareModal
        projectId={backingWorkspaceId ?? null}
        sharesLoaded={cloud.loaded}
        scope={
          scope.kind === 'chat'
            ? { kind: 'chat', chatId: mirrorChatId, label: scopeLabel }
            : { kind: scope.kind === 'folder' ? 'folder' : 'file', path: scope.path }
        }
        shares={cloud.shares}
        refresh={cloud.refresh}
        onClose={closeUnlessConfirming}
        onBeforeMutate={ensureScope}
        onConfirmMinted={(workspaceId, mintedGeneration) =>
          confirmScopeLive(workspaceId, { mintedGeneration: mintedGeneration ?? null })
        }
        // PATCH/DELETE carry it too: a grant row id survives a stop + re-add.
        mintScopeGeneration={() => scopeGenerationRef.current}
        onStopSharing={entry ? stopScope : undefined}
        broaderAccess={broaderAccess}
        statusLine={
          <>
            {error ? <div className="text-rose-600">{error}</div> : null}
            {statusText ? <div data-testid="share-status-text">{statusText}</div> : null}
            {legacyConflictRows}
          </>
        }
      />
      {stopConfirmDialog}
      </>
    );
  }

  // GDocs anatomy even before anything is shared: the owner row keeps the
  // People section populated instead of an empty void.
  const unsharedInfo: ShareInfo = {
    ...UNSHARED_INFO,
    members: user
      ? [{
          user_id: user.id,
          role: 'owner',
          joined_at: '',
          email: user.primaryEmailAddress?.emailAddress ?? null,
          name: user.fullName ?? null,
          username: user.username ?? null,
          imageUrl: user.imageUrl ?? null,
        }]
      : [],
  };

  const openWorkspaceRow = projectShared && backingWorkspaceId ? (
    <div className="mt-1">
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-[11px] leading-snug text-stone-400" data-testid="share-status-line">
          {statusText ?? 'Starting…'}
        </span>
        <a
          href={cloudHref(`/w/${backingWorkspaceId}`)}
          target={blankTarget()}
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-stone-600 hover:text-stone-900"
          data-testid="share-open-workspace"
        >
          Open cloud workspace <ArrowSquareOutIcon className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>
    </div>
  ) : null;

  // The flip we JUST performed must not visibly bounce while the hook's first
  // ACL fetch is in flight: for a share made this session we know the
  // resulting state, so bridge the gap instead of dropping to a read-only
  // skeleton. Shares found WITHOUT a flip this session keep the strict gate.
  const sessionCreated = sessionShared || flipPending;
  const optimisticInfo: ShareInfo = {
    ...unsharedInfo,
    ...(createdPublic ? { linkShare: { role: optimisticAccess } } : {}),
  };
  return (
    <>
    <WorkspaceShareModal
      open
      subject="workspace"
      projectTitle={scopeLabel}
      userId={user?.id}
      shareInfo={
        projectShared
          ? workspaceShare.shareInfo ?? (sessionCreated ? optimisticInfo : null)
          : sessionCreated
            ? optimisticInfo // flip in flight: show the picked state instantly
            : unsharedInfo
      }
      shareError={error ?? (projectShared ? workspaceShare.shareError : '')}
      copyNotice={(projectShared && workspaceShare.copyNotice) || notice}
      // Until the cloud ACL actually loads (still fetching, or signed into an
      // account without access), the hook's optimistic defaults must not
      // surface live-looking invite / General-access controls.
      canManageShare={projectShared ? (Boolean(workspaceShare.shareInfo) || sessionCreated) && workspaceShare.canManageShare : true}
      canInviteShare={projectShared ? (Boolean(workspaceShare.shareInfo) || sessionCreated) && workspaceShare.canInviteShare : true}
      pendingEmailInvites={projectShared ? workspaceShare.pendingEmailInvites : []}
      inviteEmail={workspaceShare.inviteEmail}
      setInviteEmail={workspaceShare.setInviteEmail}
      inviteRole={workspaceShare.inviteRole}
      setInviteRole={workspaceShare.setInviteRole}
      shareDropdown={workspaceShare.shareDropdown}
      setShareDropdown={workspaceShare.setShareDropdown}
      shareBusyAction={copyBusy ? 'link' : busyAction ?? workspaceShare.shareBusyAction}
      onClose={closeUnlessConfirming}
      onCreateEmailInvite={projectShared ? withScopeConfirm(workspaceShare.handleCreateEmailInvite) : handleProjectInvite}
      onCreateLinkInvite={projectShared ? withScopeConfirm(workspaceShare.handleCreateLinkInvite) : handleProjectCopyLink}
      onUpdateMemberRole={workspaceShare.handleUpdateMemberRole}
      onRemoveMember={workspaceShare.handleRemoveMember}
      onResendInvite={workspaceShare.handleResendShareInvite}
      onRevokeInvite={workspaceShare.handleRevokeShareInvite}
      onVisibilityChange={projectShared ? withScopeConfirm(workspaceShare.handleVisibilityChange) : handleProjectVisibility}
      onPublicAccessChange={handleProjectPublicAccess}
      onOpenTeamPermissions={workspaceShare.handleOpenTeamPermissions}
      formatRelativeTime={(value) => (value ? formatRelativeTimeShort(value) : '')}
      accessCaption={
        projectShared
          ? `Synced with a cloud workspace; everything else stays on your machine.`
          : `Sharing syncs this project to a cloud workspace; everything else stays on your machine.`
      }
      bodyExtra={projectShared ? openWorkspaceRow : legacyConflictRows}
      onStopSharing={entry ? () => void stopProjectShare() : undefined}
    />
    {stopConfirmDialog}
    </>
  );
}
