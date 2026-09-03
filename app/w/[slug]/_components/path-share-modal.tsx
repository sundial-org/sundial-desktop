'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CaretDownIcon, CheckIcon, CircleNotchIcon, GlobeSimpleIcon, LinkIcon, LockSimpleIcon, WarningIcon, XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { getInitials, pickColor } from '@/components/collab-bubbles';
import { isPathShareRole, type PathShareRole } from '@/lib/workspace/path-grants';

/**
 * Per-path sharing for CLOUD workspaces: grant one file or folder-subtree to
 * people outside the workspace (email invites and/or an anyone-with-the-link
 * `?pshare=` URL). Additive-only — talks to /api/workspace/path-shares.
 * The local-workspace analog is components/local/share-local-modal.tsx.
 */

export type PathShareMember = { id: string; email: string; userId: string | null; role: PathShareRole };
export type PathShare = {
  id: string;
  path: string | null;
  /** What the shared path was when granted — 'file' covers that path ONLY. */
  scopeKind?: 'file' | 'folder' | 'chat' | 'workspace';
  /** Chat grants (mirrored local chat shares) carry a chat id instead of a path. */
  chatId?: string | null;
  linkRole: PathShareRole | null;
  linkUrl: string | null;
  members: PathShareMember[];
};

export function usePathShares(projectId: string | null, enabled: boolean) {
  const [shares, setShares] = useState<PathShare[]>([]);
  // False until a successful load: an empty `shares` means "no grants" only
  // after that, and callers routing on coverage must not act before.
  const [loaded, setLoaded] = useState(false);
  // Switching workspaces drops the previous one's grants immediately, and
  // only the LATEST load may write state — otherwise a response in flight
  // across the switch lands as the new workspace's grants.
  const loadSeqRef = useRef(0);
  useEffect(() => {
    loadSeqRef.current += 1;
    setShares([]);
    setLoaded(false);
  }, [projectId]);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    const seq = ++loadSeqRef.current;
    try {
      const res = await fetch(`/api/workspace/path-shares?projectId=${encodeURIComponent(projectId)}`);
      if (seq !== loadSeqRef.current) return;
      // 403 = caller can't manage shares (viewer/guest) — no badges for them,
      // including STALE ones from a workspace they could manage.
      if (!res.ok) {
        setShares([]);
        setLoaded(false);
        return;
      }
      const payload = (await res.json()) as { shares?: PathShare[] };
      if (seq !== loadSeqRef.current) return;
      setShares(Array.isArray(payload.shares) ? payload.shares : []);
      // Only an authoritative answer counts: a 403/5xx/network failure leaves
      // `shares` empty or stale, which must never read as "no grants".
      setLoaded(true);
    } catch {
      if (seq !== loadSeqRef.current) return;
      // Transient — badges refresh on the next open/mutation, but what's in
      // state stopped being authoritative.
      setLoaded(false);
    }
  }, [projectId]);
  useEffect(() => {
    if (enabled) void refresh();
    // Losing manage access (or switching workspaces) must not leave the
    // previous workspace's badges rendering.
    else {
      loadSeqRef.current += 1;
      setShares([]);
      setLoaded(false);
    }
  }, [enabled, refresh]);
  // Badge set: only scopes that actually grant something today. The
  // workspace-root grant (path AND chatId null) maps to '' — the file tree
  // renders it as hover-only "covered" badges on every row. Gated on
  // `loaded`: a thrown refresh keeps `shares` for the open modal, but stale
  // rows must not keep badging a share that may have just been revoked.
  const sharedPaths = useMemo(
    () =>
      new Map(
        (loaded ? shares : [])
          .filter((s) => !s.chatId && (s.linkRole || s.members.length > 0))
          .map((s) => [s.path ?? '', s.scopeKind === 'file' ? 'file' : 'folder'] as const),
      ),
    [shares, loaded],
  );
  // Which scopes the LINK lane grants (vs named members only) — the
  // globe-vs-people icon distinction — with each grant's recorded kind so
  // consumers can apply real coverage semantics (a folder/root link covers
  // its subtree; a FILE link covers its exact path only). Same `loaded` gate
  // as the badge set.
  const linkSharedPaths = useMemo(
    () =>
      new Map(
        (loaded ? shares : [])
          .filter((s) => !s.chatId && s.linkRole)
          .map((s) => [s.path ?? '', s.scopeKind === 'file' ? 'file' : 'folder'] as const),
      ),
    [shares, loaded],
  );
  return { shares, sharedPaths, linkSharedPaths, loaded, refresh };
}

const ROLES = ['view', 'suggest', 'edit'] as const;

function roleLabel(role: PathShareRole) {
  return role === 'edit' ? 'Editor' : role === 'suggest' ? 'Commenter' : 'Viewer';
}

function RoleDropdown({
  id,
  value,
  onSelect,
  open,
  setOpen,
  disabled,
  small,
}: {
  id: string;
  value: PathShareRole;
  onSelect: (role: PathShareRole) => void;
  open: string | null;
  setOpen: (value: string | null) => void;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(open === id ? null : id);
        }}
        className={
          small
            ? 'inline-flex items-center gap-1 text-xs text-stone-600 hover:text-stone-900 disabled:opacity-50 transition-colors'
            : 'inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-2.5 text-sm bg-white hover:bg-stone-50 disabled:opacity-50 transition-colors'
        }
      >
        {roleLabel(value)}
        <CaretDownIcon className={small ? 'h-3 w-3 text-stone-400' : 'h-3.5 w-3.5 text-stone-400'} weight="regular" aria-hidden />
      </button>
      {open === id && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-stone-200 rounded-lg shadow-lg py-1 z-10 min-w-[110px]">
          {ROLES.map((role) => (
            <button
              key={role}
              type="button"
              onClick={() => {
                onSelect(role);
                setOpen(null);
              }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-stone-50 transition-colors ${value === role ? 'text-stone-900 font-medium' : 'text-stone-600'}`}
            >
              {roleLabel(role)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export type PathShareScope =
  | { kind: 'file' | 'folder'; path: string }
  // Chat grant (mirrored local chat share): view-only, no roles.
  | { kind: 'chat'; chatId: string | null; label?: string };

export function PathShareModal({
  projectId,
  scope,
  shares,
  sharesLoaded = true,
  refresh,
  onClose,
  onBeforeMutate,
  onConfirmMinted,
  mintScopeGeneration,
  onStopSharing,
  statusLine,
  broaderAccess,
}: {
  /** Null until a local scope's backing workspace exists (see onBeforeMutate). */
  projectId: string | null;
  scope: PathShareScope;
  shares: PathShare[];
  /** False while `shares` is unauthoritative (first load in flight, or a
   *  failed read). With a workspace to read from, the audience row shows a
   *  placeholder then — never a default "Restricted" that flips to "Anyone
   *  with the link" once the fetch lands. */
  sharesLoaded?: boolean;
  refresh: () => Promise<void>;
  onClose: () => void;
  /** Local scopes: runs before the first grant-minting mutation — ensures the
   *  backing workspace exists and the scope has synced into it. May return
   *  the resolved ids (workspace, mirror chat) for the mutation to use. */
  onBeforeMutate?: () => Promise<{ projectId?: string; chatId?: string; generation?: number } | void>;
  /** Local scopes: runs AFTER a grant-minting POST. Verifies (under the
   *  sidecar's per-project lock) that the scope still exists; a stop that
   *  raced the mint revokes the fresh grant and this rejects — the mint must
   *  never outlive the stop. `mintedGeneration` is the generation the POST
   *  carried, frozen so the rollback can never reach a newer re-add's. */
  onConfirmMinted?: (projectId: string, mintedGeneration?: number | null) => Promise<void>;
  /** Local scopes: this modal's sidecar scope generation. Sent on PATCH and
   *  DELETE too — a grant row id is REUSED across a stop + re-add, so it is
   *  no proof the row is still this modal's incarnation; the route
   *  predicates every mutation on it (Codex P1 round 27). */
  mintScopeGeneration?: () => number | null;
  /** Local scopes: stop syncing this scope (grants are revoked separately). */
  onStopSharing?: () => void | Promise<void>;
  statusLine?: ReactNode;
  /** Set when the WORKSPACE already grants more than this scope would (link
   *  sharing on, or members). Without it the modal's "nothing else in the
   *  workspace" promise is a lie, and a per-file link quietly hands over
   *  everything. `onRestrict` turns the workspace-wide LINK off — members and
   *  pending invites stay (the label reports them separately). */
  broaderAccess?: { label: string; onRestrict?: () => void | Promise<void> } | null;
}) {
  const isChat = scope.kind === 'chat';
  const share =
    (isChat
      ? shares.find((entry) => entry.chatId && entry.chatId === scope.chatId)
      : shares.find((entry) => entry.path === scope.path)) ?? null;
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<PathShareRole>('view');
  const [dropdown, setDropdown] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  // Live refresh: mutate can outlive the render that captured `refresh`
  // (onBeforeMutate resolves the backing workspace mid-flight, changing the
  // hook's projectId) — the stale closure would fetch against null and never
  // load the just-created share.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const name = isChat ? scope.label || 'this chat' : scope.path.split('/').pop() || scope.path;
  const isLinkShared = Boolean(share?.linkRole);
  // Reopened on an already-shared scope: `share` is null only because the
  // grants read hasn't landed — rendering the default Restricted row would
  // flash the wrong state, so hold a placeholder until the read is
  // authoritative. (No workspace to read from = provably unshared.)
  const audiencePending = Boolean(projectId) && !sharesLoaded && !share;

  const mutate = useCallback(
    async (busyKey: string, init: { method: 'POST' | 'PATCH' | 'DELETE'; body: Record<string, unknown> }) => {
      setBusy(busyKey);
      setError('');
      try {
        // POSTs mint audience on the target — local scopes first ensure the
        // backing workspace + sync exist and adopt the resolved ids.
        const resolved = init.method === 'POST' && onBeforeMutate ? await onBeforeMutate() : null;
        const targetProjectId = resolved?.projectId ?? projectId;
        if (!targetProjectId) throw new Error('Sharing is still starting. Try again in a moment.');
        const body: Record<string, unknown> = { projectId: targetProjectId, ...init.body };
        if (resolved?.chatId) body.chatId = resolved.chatId;
        // Generation-gated mutation (PR #1033): on a POST the cloud refuses a
        // mint whose generation a stop already revoked through, and on
        // PATCH/DELETE it refuses to touch a row a re-add raised past us —
        // the id alone is not proof, it survives stop + re-add.
        const generation = resolved?.generation ?? mintScopeGeneration?.() ?? null;
        if (generation != null) body.scopeGeneration = generation;
        const res = await fetch('/api/workspace/path-shares', {
          method: init.method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? 'Something went wrong');
        }
        // Mint-confirm (local scopes): the grant is only live if the sidecar
        // still records the scope — a stop that raced this mint revokes it
        // and this rejects (the catch's refresh shows the revoked state).
        if (resolved && onConfirmMinted) await onConfirmMinted(targetProjectId, resolved.generation ?? null);
        await refreshRef.current();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong');
        void refreshRef.current();
        return false;
      } finally {
        setBusy(null);
      }
    },
    [projectId, onBeforeMutate, onConfirmMinted, mintScopeGeneration],
  );

  const targetBody = () =>
    isChat ? (scope.chatId ? { chatId: scope.chatId } : {}) : { path: scope.path };

  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    // Validate BEFORE the mutation: onBeforeMutate starts the local sync
    // (content leaves the machine) — a typo'd address must not trigger that
    // just to show a validation error.
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Enter a valid email address.');
      return;
    }
    const ok = await mutate('email', {
      method: 'POST',
      body: { ...targetBody(), email, role: isChat ? 'view' : inviteRole },
    });
    if (ok) setInviteEmail('');
  };

  const handleLinkRole = (linkRole: PathShareRole | null) => {
    if (!share) {
      // First enable creates the share row + mints the token; there is
      // nothing to revoke before that.
      if (linkRole === null) return;
      return mutate('link-role', { method: 'POST', body: { ...targetBody(), linkRole } });
    }
    if (linkRole === share.linkRole) return;
    return mutate('link-role', { method: 'PATCH', body: { shareId: share.id, linkRole } });
  };

  const handleCopyLink = async () => {
    if (!share?.linkUrl) return;
    try {
      await navigator.clipboard.writeText(share.linkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Could not copy the link');
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      ariaLabel={`Share ${name}`}
      overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      panelClassName="w-full max-w-lg rounded-2xl bg-white border border-stone-200 shadow-xl"
    >
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-stone-800 truncate">Share &ldquo;{name}&rdquo;</h2>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600 transition-colors" aria-label="Close">
            <XIcon className="h-5 w-5" weight="regular" aria-hidden />
          </button>
        </div>
        <p className="text-[11px] leading-snug text-stone-400 mb-4">
          {broaderAccess
            ? `Adding people here scopes THEM to ${scope.kind === 'chat' ? 'this chat' : scope.kind === 'folder' ? 'this folder' : 'this file'}, but the whole workspace is already shared more widely.`
            : scope.kind === 'chat'
              ? 'People you add here can view this chat, nothing else.'
              : `People you add here get access to ${scope.kind === 'folder' ? 'this folder and everything inside it' : 'only this file'}, nothing else in the workspace.`}
        </p>

        {broaderAccess && (
          <div
            className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5"
            data-testid="share-broader-access"
          >
            <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" weight="regular" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] leading-snug text-amber-900">{broaderAccess.label}</div>
              {broaderAccess.onRestrict && (
                <button
                  type="button"
                  onClick={() => {
                    setBusy('restrict');
                    setError('');
                    // A rejected restrict must SAY so: silently resetting the
                    // button reads as "done" while the workspace is still
                    // wide open (Codex P2).
                    void Promise.resolve(broaderAccess.onRestrict?.())
                      .catch((err) =>
                        setError(err instanceof Error ? err.message : 'Could not restrict the workspace'),
                      )
                      .finally(() => setBusy(null));
                  }}
                  disabled={busy !== null}
                  data-testid="share-restrict-workspace"
                  className="mt-1 text-[12px] font-medium text-amber-800 underline underline-offset-2 hover:text-amber-900 disabled:opacity-50"
                >
                  {busy === 'restrict' ? 'Turning off…' : 'Turn off the whole-workspace link'}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleInvite();
              }
            }}
            placeholder="Add people by email"
            className="flex-1 rounded-lg border border-stone-200 px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-400/20 focus:border-stone-300 transition-colors"
          />
          {!isChat && (
            <RoleDropdown id="invite-role" value={inviteRole} onSelect={setInviteRole} open={dropdown} setOpen={setDropdown} />
          )}
          <button
            type="button"
            onClick={() => void handleInvite()}
            disabled={busy === 'email' || !inviteEmail.trim()}
            className="shrink-0 rounded-lg bg-stone-900 text-white px-4 py-2.5 text-sm font-medium hover:bg-stone-800 disabled:opacity-40 transition-colors"
          >
            {busy === 'email' ? 'Sending...' : 'Send'}
          </button>
        </div>
        <div className="h-5 mt-1">{error && <div className="text-xs text-rose-600">{error}</div>}</div>
      </div>

      {share && share.members.length > 0 && (
        <div className="px-5 pb-2 max-h-[280px] overflow-y-auto">
          <div className="text-xs font-medium text-stone-500 mb-2">People with access</div>
          <div className="space-y-0.5">
            {share.members.map((member) => (
              <div key={member.id} className="flex items-center gap-3 py-2 group">
                <div
                  className="h-8 w-8 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold text-[#fff]"
                  style={{ backgroundColor: pickColor(member.userId ?? member.email) }}
                >
                  {getInitials(member.email)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-stone-800 truncate">{member.email}</div>
                  {!member.userId && <div className="text-xs text-stone-400">Invited · joins on sign-in</div>}
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  {isChat ? (
                    <span className="text-xs text-stone-500">Viewer</span>
                  ) : (
                    <RoleDropdown
                      id={`member-${member.id}`}
                      value={isPathShareRole(member.role) ? member.role : 'view'}
                      onSelect={(role) => void mutate(`member-${member.id}`, { method: 'PATCH', body: { shareId: share.id, memberId: member.id, role } })}
                      open={dropdown}
                      setOpen={setDropdown}
                      disabled={busy === `member-${member.id}`}
                      small
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => void mutate(`remove-${member.id}`, { method: 'DELETE', body: { shareId: share.id, memberId: member.id } })}
                    disabled={busy === `remove-${member.id}`}
                    aria-label="Remove"
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 rounded p-1 text-stone-400 hover:text-rose-500 hover:bg-rose-50 transition-all disabled:opacity-60"
                  >
                    <XIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-5 pt-3 pb-4 border-t border-stone-100 mt-1">
        <div className="text-xs font-medium text-stone-500 mb-2">General access</div>
        {audiencePending ? (
          <div className="flex items-center gap-3" data-testid="share-audience-loading">
            <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-stone-100" />
            <div className="min-w-0 flex-1">
              <div className="h-4 w-40 animate-pulse rounded bg-stone-100" />
              <div className="mt-1.5 h-3 w-56 animate-pulse rounded bg-stone-100" />
            </div>
          </div>
        ) : (
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-stone-100 flex items-center justify-center shrink-0">
            {isLinkShared ? <GlobeSimpleIcon className="h-4 w-4 text-stone-500" weight="regular" aria-hidden /> : <LockSimpleIcon className="h-4 w-4 text-stone-400" weight="regular" aria-hidden />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="relative inline-block">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setDropdown(dropdown === 'link-access' ? null : 'link-access');
                }}
                disabled={busy === 'link-role'}
                className="inline-flex items-center gap-1 text-sm font-medium text-stone-800 hover:text-stone-900 disabled:opacity-50 transition-colors"
              >
                {isLinkShared ? 'Anyone with the link' : 'Restricted'}
                <CaretDownIcon className="h-3.5 w-3.5 text-stone-400" weight="regular" aria-hidden />
              </button>
              {dropdown === 'link-access' && (
                <div className="absolute left-0 top-full mt-1 bg-white border border-stone-200 rounded-lg shadow-lg py-1 z-10 min-w-[220px]">
                  <button
                    type="button"
                    onClick={() => {
                      void handleLinkRole(null);
                      setDropdown(null);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-stone-50 transition-colors ${!isLinkShared ? 'text-stone-900 font-medium' : 'text-stone-600'}`}
                  >
                    <div>Restricted</div>
                    <div className="text-xs text-stone-400 font-normal">Only invited people can open</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleLinkRole(share?.linkRole ?? 'view');
                      setDropdown(null);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-stone-50 transition-colors ${isLinkShared ? 'text-stone-900 font-medium' : 'text-stone-600'}`}
                  >
                    <div>Anyone with the link</div>
                    <div className="text-xs text-stone-400 font-normal">Anyone with the link can open this {scope.kind}</div>
                  </button>
                </div>
              )}
            </div>
            <div className="text-xs text-stone-400">
              {busy === 'link-role' || busy === 'email' ? (
                // The first share takes seconds on a big folder — one calm,
                // STATIC line; a silent modal reads as a dead button, and
                // data-movement narration reads as creepy.
                <span className="inline-flex items-center gap-1.5 text-stone-500" data-testid="share-preparing">
                  <CircleNotchIcon className="h-3 w-3 animate-spin" weight="bold" aria-hidden />
                  {onBeforeMutate && !share ? 'Getting your link ready…' : 'Updating…'}
                </span>
              ) : isLinkShared ? (
                `Anyone with the link can ${share?.linkRole === 'edit' ? 'edit' : share?.linkRole === 'suggest' ? 'comment' : 'view'}`
              ) : (
                `Only invited people can open this ${scope.kind}`
              )}
            </div>
          </div>
          {!isChat && isLinkShared && share?.linkRole && (
            <RoleDropdown
              id="link-role"
              value={share.linkRole}
              onSelect={(role) => void handleLinkRole(role)}
              open={dropdown}
              setOpen={setDropdown}
              disabled={busy === 'link-role'}
              small
            />
          )}
        </div>
        )}
        {statusLine ? <div className="mt-2 text-[11px] leading-snug text-stone-400" data-testid="share-status-line">{statusLine}</div> : null}
      </div>

      <div className="flex items-center justify-between px-5 py-3 border-t border-stone-100">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCopyLink()}
            disabled={!share?.linkUrl}
            className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm min-w-[120px] transition-colors ${copied ? 'border-stone-300 bg-stone-100 text-stone-800' : 'border-stone-200 text-stone-700 hover:bg-stone-50'} disabled:opacity-50`}
          >
            {copied ? <CheckIcon className="h-4 w-4" weight="regular" aria-hidden /> : <LinkIcon className="h-4 w-4" weight="regular" aria-hidden />}
            {copied ? 'Copied' : 'Copy link'}
          </button>
          {onStopSharing && (
            <button
              type="button"
              // Stopping tears down cloud twins — seconds, not milliseconds.
              // It has to say so and stay disabled, or it reads as broken and
              // gets clicked again (the second call finds nothing to stop).
              // Quiet on purpose (local-only): it stops the SYNC, which the
              // audience controls above can't — but it is not a destructive
              // act, so no red.
              onClick={() => {
                setBusy('stop');
                void Promise.resolve(onStopSharing()).finally(() => setBusy(null));
              }}
              disabled={busy !== null}
              className="text-[12px] font-medium text-stone-500 hover:text-stone-700 disabled:opacity-50"
              data-testid="share-stop"
            >
              {busy === 'stop' ? 'Stopping…' : 'Stop syncing'}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-stone-900 text-white px-5 py-2 text-sm font-medium hover:bg-stone-800 transition-colors"
        >
          Done
        </button>
      </div>
    </ModalShell>
  );
}
