// Headless share driver for the curl-distributed sidecar (serve.sh → serve.mjs
// --share <folder>): registers the folder with the local server, mints an
// anon-owned hidden backing workspace + 7-day bridge token from the cloud, and
// wires the share — the exact sequence components/local/share-local-modal.tsx
// runs for the desktop app, driven over the same two HTTP APIs so the sync
// path itself (bridge.mjs) stays byte-identical to the desktop bridge.
//
// The cloud identity is the HTTP rail's anon identity: a readable key persisted
// at <home>/headless-identity, sent as the sd_anon cookie. Whoever holds it
// owns the backing workspace; the printed link carries `anon=` so the human's
// browser adopts it. claim-anon deliberately does NOT transfer local-backing
// workspaces, so this identity keeps its token-mint rights forever and sync
// survives the human signing in.
//
// Token refresh is a DAEMON capability (refreshAnonShares below), not CLI glue:
// the serve.sh server process re-mints tokens for EVERY anon-backed share it
// holds, so a deferring run can wire its folder and exit cleanly while the
// running server keeps it fresh.

import fs from 'node:fs';
import path from 'node:path';

import { generateReadableKey, isValidAnonId } from '../lib/auth/anon-identity.ts';
import { fileKindForFile, isIgnoredPath } from './paths.mjs';

/** Seeded into a CREATE from a folder with nothing syncable, so the first
 *  compile (and the landing prompt's "compile the tex file") always has a
 *  target. Attach never seeds: the existing workspace is the content. */
export const SAMPLE_MAIN_TEX = `\\documentclass{article}
\\title{Sample Document}
\\begin{document}
\\maketitle
This folder was empty when it became a Sundial workspace, so this sample
document was created for the first compile. Replace it with your own
files; local edits and workspace edits stay in sync both ways.
\\end{document}
`;

/** True when the folder holds at least one file the bridge would sync
 *  (ignored trees like .git/ and node_modules/ do not count). */
export function folderHasSyncableFile(root, rel = '') {
  let entries = [];
  try {
    entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (isIgnoredPath(childRel)) continue;
    if (entry.isDirectory()) {
      if (folderHasSyncableFile(root, childRel)) return true;
    } else if (entry.isFile() && fileKindForFile(childRel)) {
      return true;
    }
  }
  return false;
}

/** Re-mint the 7-day bridge token well before it expires. */
export const TOKEN_REFRESH_MS = 24 * 60 * 60 * 1000;

async function api(base, pathname, { method = 'GET', token, cookie, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.error ? `: ${payload.error}` : '';
    throw Object.assign(new Error(`${method} ${pathname} → ${res.status}${detail}`), {
      status: res.status,
    });
  }
  return payload;
}

const identityFile = (home) => path.join(home, 'headless-identity');

/** One valid anon identity per install (like the desktop's one signed-in
 *  user). Reused across runs and folders so re-running serve.sh converges on
 *  the same cloud ownership instead of orphaning a workspace per run. A
 *  present-but-malformed file (truncated write, hand-edit, copied ~/.sundial)
 *  is rejected and re-minted — the cloud validates the cookie with the same
 *  isValidAnonId, so keeping a bad value would 401 every run forever. */
export function ensureAnonIdentity(home) {
  const file = identityFile(home);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (isValidAnonId(existing)) return existing;
  } catch {
    /* first run */
  }
  const id = generateReadableKey();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}

/** Read the persisted identity without minting (the refresh loop must not
 *  create one). Null when absent/invalid. */
export function readAnonIdentity(home) {
  try {
    const existing = fs.readFileSync(identityFile(home), 'utf8').trim();
    return isValidAnonId(existing) ? existing : null;
  } catch {
    return null;
  }
}

/** The signed-in account's sd_ token, when this install has one for THIS
 *  cloud origin (parked by the desktop/web sign-in at /agent-credentials).
 *  Origin-checked so a token never travels to a different cloud. Null when
 *  signed out, mismatched, or the daemon predates the reveal. */
async function readUserCredentials(localOrigin, localToken, app) {
  try {
    const creds = await api(localOrigin, '/agent-credentials', { token: localToken });
    if (typeof creds?.token !== 'string' || !creds.token) return null;
    return String(creds.apiOrigin ?? '').replace(/\/$/, '') === app ? creds.token : null;
  } catch {
    return null;
  }
}

/** A --workspace ref: a full workspace URL (its `anon=`/`key=` rides along
 *  as the owning identity), a /w/ slug, or a bare uuid. */
export function parseWorkspaceRef(ref) {
  const value = String(ref ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const match = /\/w\/([^/?]+)/.exec(url.pathname);
    return {
      ws: match ? match[1] : value,
      key: url.searchParams.get('anon') || url.searchParams.get('key') || null,
    };
  } catch {
    return { ws: value, key: null };
  }
}

/**
 * Ensure `folder` is registered, shared (whole-project scope), and carrying a
 * fresh sync token. Idempotent: an existing share only gets its token
 * refreshed. Returns `{ url, workspaceId, projectId, anon, token }` — `token`
 * is the share's edit-capable rail credential on the public HTTP rail. An MCP
 * attach deliberately omits it so no durable credential enters the agent
 * transcript. Token refresh is
 * owned by the daemon (refreshAnonShares), not by this call.
 *
 * `workspace` (optional) ATTACHES the folder to an EXISTING workspace instead
 * of creating one: a URL carrying `anon=` (that key must own the workspace),
 * a slug, or a uuid. A ref WITHOUT a key falls back to this install's
 * signed-in credentials — any workspace the account can open in the browser
 * attaches with no key at all, synced and attributed as the user. The
 * bridge's normal first-sync semantics produce the union of both sides —
 * local-only files upload, workspace-only files download, same-path
 * conflicts keep the local version (the cloud copy stays in the workspace's
 * history).
 *
 * `mcpGrant` is the hosted connector's five-minute, one-use handoff. The
 * cloud exchanges it directly for this one workspace's sync credentials;
 * unlike a keyless `workspace` attach it never reads or changes this
 * machine's account-wide agent credentials.
 */
export async function runHeadlessShare({
  localOrigin,
  localToken,
  app,
  folder,
  home,
  workspace = /** @type {string | null} */ (null),
  mcpGrant = /** @type {string | null} */ (null),
}) {
  const root = path.resolve(folder);
  if (workspace && mcpGrant) throw new Error('use either --workspace or --mcp-grant, not both');
  // MCP has its own workspace-scoped identity. Do not mint an unrelated anon
  // owner merely because this install has never used the HTTP rail.
  const anon = mcpGrant ? readAnonIdentity(home) : ensureAnonIdentity(home);
  const ref = workspace ? parseWorkspaceRef(workspace) : null;
  // The identity that owns the target workspace, a three-step ladder: the
  // ref's explicit key wins; a keyless attach uses the signed-in account;
  // otherwise the install's own identity (creates, and attaching another of
  // this install's own workspaces).
  const userToken = ref && !ref.key ? await readUserCredentials(localOrigin, localToken, app) : null;
  const shareKey = ref?.key ?? (userToken ? null : anon);
  const cloudAuth = userToken ? { token: userToken } : { cookie: `sd_anon=${shareKey}` };

  const { project } = await api(localOrigin, '/projects', {
    method: 'POST',
    token: localToken,
    body: { root },
  });
  const detail = await api(localOrigin, `/projects/${project.id}`, { token: localToken });
  const shares = detail.shares ?? [];
  // A whole-project share we can just re-token. Any OTHER live scope (folder,
  // file, chat) already binds this project to a backing workspace; reuse it so
  // adding the project scope extends the same union instead of minting a
  // second workspace that would 409 ("already syncs to a different backing
  // workspace") — and orphan the loser. describeShares emits sqlite 0/1 for
  // `enabled`, so test truthiness, never `!== false`.
  const projectScope = shares.find((share) => share.scope_kind === 'project' && share.enabled);
  const reuseBacking = projectScope?.workspace_id ?? shares.find((share) => share.enabled)?.workspace_id ?? null;

  if (mcpGrant) {
    const claim = await api(app, '/api/workspace/local-agent/sync-attach', {
      method: 'POST',
      body: { grant: mcpGrant },
    });
    if (
      typeof claim?.workspaceId !== 'string' ||
      typeof claim?.workspaceUrl !== 'string' ||
      typeof claim?.collabUrl !== 'string' ||
      typeof claim?.token !== 'string' ||
      typeof claim?.refreshCredential !== 'string'
    ) {
      throw new Error('MCP sync handoff returned incomplete workspace credentials');
    }
    // A local project has one cloud twin per deployment. Never let a fresh
    // grant silently rewire an already-synced folder to another workspace.
    if (reuseBacking && reuseBacking !== claim.workspaceId) {
      throw new Error(
        `this folder already syncs to workspace ${reuseBacking}. Stop that share first to attach it elsewhere.`,
      );
    }
    await api(localOrigin, `/projects/${project.id}/shares`, {
      method: 'POST',
      token: localToken,
      body: {
        grants: true,
        workspaceId: claim.workspaceId,
        collabUrl: claim.collabUrl,
        apiOrigin: app,
        token: claim.token,
        scopeKind: 'project',
        scopePath: '',
        mintKind: 'mcp',
        refreshCredential: claim.refreshCredential,
      },
    });
    return {
      url: claim.workspaceUrl,
      workspaceId: claim.workspaceId,
      projectId: project.id,
      anon: null,
      mcp: true,
    };
  }

  if (projectScope) {
    // Already whole-project shared: just refresh its token, presenting the
    // share's own mint identity (an attached share's owner key, or the
    // signed-in account for a user-attached share).
    const usesUser = projectScope.mint_kind === 'user';
    const keptKey = usesUser ? null : projectScope.mint_key ?? anon;
    const keptToken = usesUser ? await readUserCredentials(localOrigin, localToken, app) : null;
    if (usesUser && !keptToken) {
      throw new Error(
        'this folder syncs as your Sundial account, but this machine is signed out. Sign in to Sundial here, then re-run.',
      );
    }
    const join = await mintBridgeToken({
      app,
      auth: usesUser ? { token: keptToken } : { cookie: `sd_anon=${keptKey}` },
      workspaceId: projectScope.workspace_id,
      home,
    });
    // Attaching an already-synced folder to a DIFFERENT workspace forks the
    // human's work — refuse with the state, never silently rewire.
    if (ref) {
      const currentSlug = /\/w\/([^/?]+)/.exec(join.workspaceUrl ?? '')?.[1];
      if (ref.ws !== projectScope.workspace_id && ref.ws !== currentSlug) {
        throw new Error(
          `this folder already syncs to ${join.workspaceUrl}. Stop that share first to attach it elsewhere.`,
        );
      }
    }
    await api(localOrigin, `/projects/${project.id}/shares/${projectScope.share_id ?? projectScope.id}/token`, {
      method: 'POST',
      token: localToken,
      body: { token: join.token },
    });
    return {
      url: usesUser ? join.workspaceUrl : `${join.workspaceUrl}?anon=${keptKey}`,
      workspaceId: projectScope.workspace_id,
      projectId: project.id,
      anon: keptKey,
      token: join.token,
    };
  }

  // A backing workspace persisted from a prior interrupted run: reuse it so a
  // flaky retry never mints a fresh orphan (mirrors the modal's "adopt
  // immediately"). detail.backing_workspace_id is the sidecar's own record.
  let workspaceId = ref?.ws ?? reuseBacking ?? detail.backing_workspace_id ?? null;
  if (!workspaceId) {
    // Deterministic first compile: a CREATE from a folder with nothing
    // syncable gets a sample main.tex (written locally, so it syncs like any
    // user file and is theirs to delete). Never on attach or reuse.
    if (!folderHasSyncableFile(root)) {
      try {
        fs.writeFileSync(path.join(root, 'main.tex'), SAMPLE_MAIN_TEX, { flag: 'wx' });
      } catch {
        /* raced another writer or unwritable folder — sync proceeds without */
      }
    }
    const created = await api(app, '/api/workspace', {
      method: 'POST',
      ...cloudAuth,
      body: { title: path.basename(root), seedStarter: false, kind: 'local-backing' },
    });
    workspaceId = created.project.id;
  }

  // First wire: token mint and collab-host ensure are independent (mirrors
  // share-local-modal's Promise.all — the ensure leg is the slow ~2s one).
  // For an attach, the join doubles as the access check: a 403/404 means the
  // presented identity has no access, reported before anything syncs.
  const attaching = ref ? (ref.key ? 'key' : userToken ? 'user' : 'none') : false;
  const [join, host] = await Promise.all([
    mintBridgeToken({ app, auth: cloudAuth, workspaceId, home, attaching }),
    api(app, `/api/workspace/host?workspaceId=${encodeURIComponent(workspaceId)}&ensure=1`, { ...cloudAuth }),
  ]);
  if (!host.collabUrl) throw new Error('collab host unavailable');
  await api(localOrigin, `/projects/${project.id}/shares`, {
    method: 'POST',
    token: localToken,
    body: {
      grants: true,
      // The join resolves a slug ref to the workspace UUID the bridge needs.
      workspaceId: join.workspaceId ?? workspaceId,
      collabUrl: host.collabUrl,
      apiOrigin: app,
      token: join.token,
      scopeKind: 'project',
      scopePath: '',
      // Remember the owning identity when it is not the install's own, so
      // the daemon's daily re-mint presents the right key or credentials.
      ...(userToken ? { mintKind: 'user' } : shareKey !== anon ? { mintKey: shareKey } : {}),
    },
  });
  return {
    url: userToken ? join.workspaceUrl : `${join.workspaceUrl}?anon=${shareKey}`,
    workspaceId: join.workspaceId ?? workspaceId,
    projectId: project.id,
    anon: shareKey,
    token: join.token,
  };
}

/** Mint a 7-day bridge token as the presenting identity (`auth` is a cookie
 *  for anon keys, a Bearer sd_ token for the signed-in account). A 403/404
 *  means that identity has no access: the workspace was deleted, or the
 *  identity never had it — reported per how the caller got here (`attaching`:
 *  false | 'key' | 'user' | 'none'). (claim-anon leaves local-backing
 *  anon-owned, so a sign-in does NOT cause this.) */
async function mintBridgeToken({ app, auth, workspaceId, home, attaching = false }) {
  try {
    const join = await api(app, '/api/workspace/local-agent/join', {
      method: 'POST',
      ...auth,
      body: { projectId: workspaceId, bridge: true },
    });
    if (!join.token) throw new Error('cloud returned no sync token');
    return join;
  } catch (error) {
    if (error?.status === 403 || error?.status === 404 || (attaching && error?.status === 401)) {
      const messages = {
        key:
          'cannot attach: the provided key does not own that workspace (or it was deleted). ' +
          'Ask its owner for a fresh workspace link carrying anon=.',
        user:
          'cannot attach: your Sundial account does not have access to that workspace ' +
          '(or the sign-in expired). Open it in your browser to check, sign in to Sundial ' +
          'again on this machine, or use a workspace link carrying anon=.',
        none:
          'cannot attach: the link carries no anon= key and this machine has no Sundial ' +
          'sign-in. Sign in to the Sundial app on this machine, or ask the workspace owner ' +
          'for a link carrying anon=.',
      };
      throw new Error(
        attaching
          ? `${messages[attaching] ?? messages.key} (${error.message})`
          : `the cloud workspace for this share is gone or no longer owned by this machine's identity ` +
            `(it may have been deleted). If this persists, remove ${identityFile(home)} to start a ` +
            `fresh workspace. (${error.message})`,
      );
    }
    throw error;
  }
}

/**
 * Re-mint the sync token for every anon-backed project share the daemon holds,
 * using the persisted install identity. Runs on the server process, so it
 * covers shares that a deferring `serve.sh` run wired in and then exited.
 * Shares this identity does not own (a signed-in user's own shares, which the
 * desktop client refreshes) 403/404 and are skipped silently.
 */
export async function refreshAnonShares({ localOrigin, localToken, app, home, log = (_message) => {} }) {
  const anon = readAnonIdentity(home);
  if (!app) return; // no cloud origin
  let projects;
  try {
    ({ projects } = await api(localOrigin, '/projects', { token: localToken }));
  } catch (error) {
    log(`[sundial-local] refresh: could not list projects: ${error?.message}`);
    return;
  }
  // The signed-in account's token, fetched once per sweep, only if a
  // user-minted share needs it. undefined = not fetched yet.
  let userToken;
  let warnedSignedOut = false;
  for (const project of projects ?? []) {
    let shares;
    try {
      ({ shares } = await api(localOrigin, `/projects/${project.id}`, { token: localToken }));
    } catch {
      continue;
    }
    // describeScope emits sqlite 0/1 for `enabled` — test truthiness.
    for (const share of (shares ?? []).filter((s) => s.scope_kind === 'project' && s.enabled)) {
      // The share's own mint identity wins over the install identity: the
      // signed-in account for mint_kind 'user', an attached owner key for
      // mint_key. A share with none has no headless owner here.
      let auth = null;
      if (share.mint_kind === 'mcp') {
        try {
          // The local server holds the durable credential and presents it
          // directly to its issuing deployment; it is never returned here.
          await api(localOrigin, `/projects/${project.id}/shares/${share.share_id ?? share.id}/token`, {
            method: 'POST',
            token: localToken,
            body: { refresh: true },
          });
        } catch (error) {
          if (error?.status === 401 || error?.status === 403) {
            log(
              `[sundial-local] refresh: access to ${share.workspace_id} was revoked; ` +
                'this folder is parked until you reconnect it from Sundial',
            );
          } else {
            log(`[sundial-local] refresh failed for ${share.workspace_id}: ${error?.message}`);
          }
        }
        continue;
      }
      if (share.mint_kind === 'user') {
        if (userToken === undefined) userToken = await readUserCredentials(localOrigin, localToken, app);
        if (!userToken) {
          if (!warnedSignedOut) {
            log('[sundial-local] refresh: some folders sync as your Sundial account, but this machine is signed out; sign in to Sundial to keep their tokens fresh');
            warnedSignedOut = true;
          }
          continue;
        }
        auth = { token: userToken };
      } else {
        const mintKey = share.mint_key ?? anon;
        if (!mintKey) continue;
        auth = { cookie: `sd_anon=${mintKey}` };
      }
      try {
        // Mint directly (not via mintBridgeToken, whose reworded message drops
        // the status the skip below needs).
        const join = await api(app, '/api/workspace/local-agent/join', {
          method: 'POST',
          ...auth,
          body: { projectId: share.workspace_id, bridge: true },
        });
        if (!join.token) continue;
        await api(localOrigin, `/projects/${project.id}/shares/${share.share_id ?? share.id}/token`, {
          method: 'POST',
          token: localToken,
          body: { token: join.token },
        });
      } catch (error) {
        if (share.mint_kind === 'user' && (error?.status === 401 || error?.status === 403)) {
          // The account token expired or lost access — actionable, not quiet.
          log(`[sundial-local] refresh: ${share.workspace_id} no longer mints with this machine's sign-in (${error?.status}); sign in to Sundial again to keep it syncing`);
          continue;
        }
        // 403/404 = not this identity's share (a signed-in user's own, or a
        // deleted workspace) — skip quietly. Other errors are transient; the
        // next tick retries.
        if (error?.status !== 403 && error?.status !== 404) {
          log(`[sundial-local] refresh failed for ${share.workspace_id}: ${error?.message}`);
        }
      }
    }
  }
}

/** Arm the daily daemon-side refresh; unref'd so it never holds the event loop
 *  open past shutdown. Returns the handle for clearInterval on close. */
export function armSharesRefresh({ localOrigin, localToken, app, home, log = (_message) => {}, intervalMs = TOKEN_REFRESH_MS }) {
  const timer = setInterval(() => {
    void refreshAnonShares({ localOrigin, localToken, app, home, log });
  }, intervalMs);
  timer.unref?.();
  return timer;
}
