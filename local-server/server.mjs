import http from 'node:http';
import os from 'node:os';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { LocalStore, coerceModelForHarness, defaultHome } from './store.mjs';
import { DocHost } from './doc-host.mjs';
import {
  copyPath, deleteFile, hasUntrackedContent, makeFolder, readTextFile, renameFile,
  safeResolveInRoot, walkProject, writeBlobAtomic, writeBlobStreamAtomic, writeTextFileAtomic,
} from './disk.mjs';
import { RootWatchers, locateRel, pickRootPrefix, projectRoots, walkAllRoots } from './roots.mjs';
import { MIME, fileKind, isIgnoredPath, normalizeRelPath, resolveInRoot } from './paths.mjs';
import { buildLocalChangeEntries, collectLocalSessions } from './history.mjs';
import { SyncBridgeManager } from './bridge.mjs';
import { compileLatexLocally } from './compile.mjs';
import { createZipNodeBuffer } from '../lib/zip/create-zip-base64.ts';
import { LocalAgentHost } from './agent/runner.mjs';
import { createAgentWriter, engineAuthorId } from './agent/tools.mjs';
import { cloneGitHubRepo, createProjectDir } from './scaffold.mjs';

/** Bumped whenever the shell/web app depends on a sidecar endpoint that older
 *  sidecars lack. A leftover instance from before an update reports a lower
 *  number (absent = 1) and gets REPLACED at boot instead of deferred to —
 *  deferring to old code is how "unknown project" reached the create dialog. */
export const SIDECAR_API_VERSION = 8; // …6: multi-root /roots endpoints; 7: /external-sessions (Claude Code / Codex transcripts); 8: self-hosted static /local UI

/** @param {{ port?: number, home?: string, log?: (message: string) => void, exitOnShutdown?: boolean }} [options] */
export async function startLocalServer({
  port = Number(process.env.SUNDIAL_LOCAL_PORT || 4848),
  home = defaultHome(),
  log,
  exitOnShutdown = false,
} = {}) {
  const store = new LocalStore(home);
  if (!log) {
    // Default logger also appends to <home>/sidecar.log — the packaged app's
    // stdout goes nowhere, and sync incidents are undebuggable without it.
    const logFile = path.join(home, 'sidecar.log');
    try {
      if (fs.statSync(logFile).size > 5_000_000) fs.rmSync(logFile);
    } catch { /* absent — start fresh */ }
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    log = (message) => {
      const line = `${new Date().toISOString()} ${message}`;
      console.log(`[sundial-local] ${line}`);
      logStream.write(`${line}\n`);
    };
  }
  const watchers = new Map(); // projectId -> ProjectWatcher
  const sseClients = new Map(); // projectId -> Set<res>

  // Per-install token, readable only by this user. Env override for tests/dev.
  const tokenPath = path.join(home, 'token');
  let token = (process.env.SUNDIAL_LOCAL_TOKEN || '').trim();
  if (!token) {
    try {
      token = fs.readFileSync(tokenPath, 'utf8').trim();
    } catch {
      token = randomBytes(24).toString('base64url');
      fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    }
  }

  const verifyToken = (candidate) => {
    if (typeof candidate !== 'string' || !candidate) return null;
    return candidate === token ? { actor: 'user', userId: 'local' } : null;
  };

  const emit = (projectId, event) => {
    const clients = sseClients.get(projectId);
    if (!clients) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(payload);
  };
  // Install-wide events (credential changes) reach every open project stream.
  const broadcast = (event) => {
    for (const projectId of sseClients.keys()) emit(projectId, event);
  };

  const docHost = new DocHost({ store, verifyToken, watchers, log });
  const agentHost = new LocalAgentHost({ store, docHost, log });
  const bridges = new SyncBridgeManager({
    store,
    docHost,
    log,
    emitFilesChanged: (projectId, path) => emit(projectId, { type: 'files-changed', path }),
    emitSharesChanged: (projectId) => emit(projectId, { type: 'shares-changed' }),
  });
  docHost.onEditorConnected = (projectId, rel) => bridges.handleLocalDocOpened(projectId, rel);
  docHost.onRemotePersist = (projectId, rel) => emit(projectId, { type: 'files-changed', path: rel });
  // Internal deletes (a rejected suggested creation) happen with the watcher
  // suppressed — propagate them like watcher deletes.
  docHost.onFileRemoved = (projectId, rel) => {
    void bridges
      .handleLocalFileEvent(projectId, rel)
      .catch((error) => log(`bridge delete failed path=${rel} error=${error?.message}`));
    emit(projectId, { type: 'files-changed', path: rel });
  };

  // One change handler per project, shared by every root's watcher — `rel` is
  // the VIRTUAL project path (extra-root events arrive prefix-qualified).
  const onWatcherChange = (project) => (rel, suppressed) => {
      void (async () => {
      // Text files sync through the doc host; kind===null covers FOLDER
      // events (deletes/renames arrive as one event for the folder path) —
      // the doc host stat-disambiguates. Blob changes skip the doc host but
      // still reach the bridges (sha-diffed blob sync).
      const kind = fileKind(rel);
      if (kind === null) {
        // Untracked kinds matter only as folder events: an existing directory
        // (create/rename destination, or a tree delete that preserved it), or
        // a vanished path with tracked rows beneath it (folder delete
        // cascade). Everything else is churn — cache files, build junk — and
        // on a huge project root (a whole home dir) forwarding it hammers the
        // doc host, the DB, and the UI's refetch loop. Skip it entirely.
        const loc = locateRel(projectRoots(store, project), rel);
        const stat = await fsp.stat(path.join(loc.root, loc.rel)).catch(() => null);
        if (stat && !stat.isDirectory()) return;
        if (!stat && !store.hasTraceUnder(project.id, rel)) return;
      }
      if (kind !== 'blob') {
        // Inside a Bash tool call's window, disk changes belong to the run
        // (Bash bypasses the agent writer) — otherwise 'external'.
        const attribution = agentHost.bashAttribution(project.id);
        void docHost
          .handleDiskChange(project.id, rel, { record: !suppressed, fromWatcher: true, ...(attribution ?? {}) })
          .then((outcome) => {
            // A swallowed stale delete echo must NOT reach the bridges (they
            // would read the still-absent path as a live local delete and
            // remove the collaborator's new cloud file); a suppressed event
            // that proved REAL still syncs + announces.
            if (outcome === 'stale-delete') return undefined;
            if (suppressed && outcome !== 'mutated') return undefined;
            if (suppressed) emit(project.id, { type: 'files-changed', path: rel });
            return bridges.handleLocalFileEvent(project.id, rel);
          })
          .catch((error) => log(`disk change failed path=${rel} error=${error?.message}`));
      } else if (!suppressed) {
        void bridges
          .handleLocalFileEvent(project.id, rel)
          .catch((error) => log(`blob change failed path=${rel} error=${error?.message}`));
      }
      if (!suppressed) emit(project.id, { type: 'files-changed', path: rel });
      })().catch((error) => log(`disk change failed path=${rel} error=${error?.message}`));
  };

  const ensureWatcher = (project) => {
    if (watchers.has(project.id)) return;
    const set = new RootWatchers();
    const onChange = onWatcherChange(project);
    for (const entry of projectRoots(store, project)) {
      try {
        set.attach(entry.prefix, entry.root, onChange);
      } catch (error) {
        // A vanished EXTRA root must not take the primary watcher down with it.
        if (!entry.prefix) throw error;
        log(`watcher failed root=${entry.root} error=${error?.message}`);
      }
    }
    watchers.set(project.id, set);
  };

  // Live-edit horizon for resume's offline-delete reconciliation: anything
  // written from HERE on happens with watchers active — but engines register
  // only after listen(), so those events are dropped and the write's mtime is
  // its only trace. Stamping at bind time instead would misread such a write
  // as an offline edit and let reconciliation delete it.
  const watchersActiveAt = Date.now();
  for (const project of store.listProjects()) {
    try {
      ensureWatcher(project);
    } catch (error) {
      log(`watcher failed project=${project.root} error=${error?.message}`);
    }
  }
  // Bridge resumption re-auths every cloud-shared doc over the network —
  // seconds per install with real shares. It must NOT gate the port bind
  // (below): the desktop shell waits ~10s for the port before creating its
  // window, and a slow resume left the webview on a dead port (blank app).
  // Kicked off after listen() succeeds instead.

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req) => {
    // Accumulate BYTES and decode once: per-chunk decoding corrupts any UTF-8
    // code point that Node happens to split across chunk boundaries (U+FFFD
    // in saved file content).
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 20_000_000) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('invalid json'), { status: 400 });
    }
  };

  const authed = (req) => {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const query = new URL(req.url || '/', 'http://localhost').searchParams.get('token');
    return verifyToken(match?.[1]?.trim() || query || '');
  };

  // ---- Remote UI proxy (packaged desktop app) -----------------------------
  // The shell loads the web app THROUGH the sidecar, so the webview origin is
  // plain-http loopback: WKWebView's mixed-content wall (an https page may
  // not fetch http://127.0.0.1) never applies, and the sidecar API + collab
  // socket are same-origin with the page. Enabled only when the shell sets
  // SUNDIAL_REMOTE_ORIGIN; the repo dev flow (localhost:3000) is unaffected.
  const remoteOrigin = (process.env.SUNDIAL_REMOTE_ORIGIN || '').trim().replace(/\/$/, '');
  let boundPort = port;
  const localOrigin = () => `http://127.0.0.1:${boundPort}`;

  /** Keep the webview on the proxy origin: remote-origin redirects become
   *  paths, and OAuth-style bounces (Clerk handshake) that would return to
   *  the remote origin are rewritten to return here instead. */
  const rewriteLocation = (value) => {
    if (value.startsWith(remoteOrigin)) return value.slice(remoteOrigin.length) || '/';
    try {
      const parsed = new URL(value);
      const back = parsed.searchParams.get('redirect_url');
      if (back?.startsWith(remoteOrigin)) {
        parsed.searchParams.set('redirect_url', localOrigin() + back.slice(remoteOrigin.length));
        return parsed.toString();
      }
    } catch { /* relative or opaque — leave as-is */ }
    return value;
  };

  /** Cookies arrive scoped for the remote host; re-scope them to the loopback
   *  origin the webview actually runs on (drop Domain, drop Secure — and
   *  SameSite=None requires Secure, so it becomes Lax; all traffic is
   *  same-origin through the proxy anyway). */
  const rewriteSetCookie = (value) =>
    value
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && !/^domain=/i.test(part) && !/^secure$/i.test(part) && !/^partitioned$/i.test(part))
      .map((part) => (/^samesite=none$/i.test(part) ? 'SameSite=Lax' : part))
      .join('; ');

  const HOP_BY_HOP = new Set(['host', 'connection', 'upgrade', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'content-length', 'accept-encoding']);
  const proxyRemote = async (req, res, url) => {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key) && typeof value === 'string') headers[key] = value;
    }
    // The trust cookie is a LOCAL secret (it gates bearer injection below) —
    // it must never reach the remote origin or its access logs. Forward the
    // rest of the cookie jar untouched.
    const cookies = String(req.headers.cookie || '').split(/;\s*/).filter(Boolean);
    const forwarded = cookies.filter((pair) => !pair.startsWith('sundial_local='));
    if (forwarded.length !== cookies.length) {
      if (forwarded.length) headers.cookie = forwarded.join('; ');
      else delete headers.cookie;
    }
    // Signed-in cloud calls without Clerk in the webview: attach the parked
    // sd_ token to /api/* forwards. Gated on the per-install cookie (set by
    // /boot) so another local process can't ride the user's session by
    // hitting the proxy port.
    const trusted = cookies.includes(`sundial_local=${token}`);
    const credentials = store.getAgentCredentials();
    const injectedAuth = Boolean(
      trusted && credentials && url.pathname.startsWith('/api/') && !headers.authorization,
    );
    if (injectedAuth) headers.authorization = `Bearer ${credentials.token}`;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const response = await fetch(`${remoteOrigin}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      redirect: 'manual',
      ...(hasBody ? { body: req, duplex: 'half' } : {}),
    }).catch((error) => {
      json(res, 502, { ok: false, error: `remote unreachable: ${error?.message}` });
      return null;
    });
    if (!response) return;
    // The cloud rejecting OUR injected token means it expired or was revoked
    // — clear it so "credentials configured" stops reading as signed in and
    // the client's send gate reopens browser sign-in (mirrors the local-step
    // runner's 401 handling). Only when the body names the bearer: sd_-aware
    // routes answer 'Invalid token' / 'Token expired' (lib/auth/verify-token);
    // Clerk-only routes can 401 with a valid sd_ token they simply never read.
    if (injectedAuth && response.status === 401) {
      const text = await response.clone().text().catch(() => '');
      // Guarded on the token still being the one we injected: a slow 401 from
      // the old token must not clear credentials a re-auth just replaced.
      if (/Invalid token|Token expired/.test(text) && store.getAgentCredentials()?.token === credentials.token) {
        store.setAgentCredentials(null);
        // Mounted auth gates learn about this server-initiated sign-out the
        // same way they learn about sign-in (DESKTOP_CREDENTIALS_EVENT).
        broadcast({ type: 'credentials-changed' });
      }
    }
    const outHeaders = {};
    response.headers.forEach((value, key) => {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(key)) return;
      outHeaders[key] = key === 'location' ? rewriteLocation(value) : value;
    });
    const setCookies = (response.headers.getSetCookie?.() ?? []).map(rewriteSetCookie);
    if (setCookies.length) outHeaders['set-cookie'] = setCookies;
    res.writeHead(response.status, outHeaders);
    if (response.body) {
      try {
        for await (const chunk of response.body) res.write(chunk);
      } catch { /* client went away mid-stream */ }
    }
    res.end();
  };
  // ---- Static desktop UI (self-hosted /local surface) ---------------------
  // The exported desktop-ui build ships with the app, so the local surface is
  // served from disk — no cloud origin in the loop for local work. Resolution:
  // env override → bundled sibling (resources/sidecar/ui) → repo build (dev).
  const uiDir = (() => {
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.SUNDIAL_UI_DIR,
      path.join(selfDir, 'ui'),
      path.join(selfDir, '../desktop-ui/out'),
    ].filter(Boolean);
    for (const dir of candidates) {
      try {
        if (fs.existsSync(path.join(dir, 'local.html'))) return path.resolve(dir);
      } catch { /* unreadable candidate */ }
    }
    return null;
  })();

  const UI_MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm',
  };

  /** Absolute file to serve for a UI path, or null to fall through. /local
   *  and /local/<id> map to the exported shells; any other path serves only
   *  when the exported file exists on disk (hashed /_next chunks, fonts,
   *  icons) — proxied cloud pages reference their own /_next build, whose
   *  paths never collide with the export's content-hashed names. Dynamic
   *  /local/<id> flight fetches (.txt) intentionally miss so the client
   *  router hard-navigates into the shell instead of hydrating `_`. */
  const uiFile = (pathname) => {
    if (!uiDir) return null;
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (rel === '/local' || rel === '/local/') rel = '/local.html';
    else if (rel.startsWith('/local/') && !rel.endsWith('.txt')) rel = '/local/_.html';
    const resolved = path.resolve(uiDir, rel.replace(/^\/+/, ''));
    if (resolved !== uiDir && !resolved.startsWith(uiDir + path.sep)) return null;
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch { /* not exported — fall through to the proxy */ }
    return null;
  };

  const serveUiFile = (req, res, filePath) => {
    const type = UI_MIME[path.extname(filePath).toLowerCase()] || MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': filePath.includes(`${path.sep}_next${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath)
      .on('error', () => res.destroy())
      .pipe(res);
  };

  // The sidecar's own API namespace; everything else belongs to the web app.
  const isSidecarPath = (pathname) =>
    pathname === '/health' || pathname === '/boot' || pathname === '/session-config' || pathname === '/agent-credentials' ||
    // '/claude-engine' is a retired sidecar path: kept in the namespace so a
    // stale client's bearer-carrying probe 404s HERE instead of being
    // proxied (with the sidecar token) to the remote origin.
    pathname === '/local-engines' || pathname === '/claude-engine' || pathname === '/shutdown' ||
    pathname === '/projects' || pathname.startsWith('/projects/');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const sidecarPath = !remoteOrigin || isSidecarPath(url.pathname);
    const origin = req.headers.origin;
    // Permissive CORS applies to the sidecar's OWN API only — proxied web-app
    // responses keep the remote's headers, so the proxy can't be used to read
    // the cloud API cross-origin from arbitrary sites.
    if (origin && sidecarPath) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      // Resume headers included: the agent-stream reconnect sends them, and a
      // rejected preflight would silently break local Sunny stream resume.
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID, X-Resume-Stream-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      // Chrome Private Network Access: a secure public origin fetching loopback.
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS' && sidecarPath) {
      res.writeHead(204);
      res.end();
      return;
    }

    (async () => {
      if (!isSidecarPath(url.pathname)) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const file = uiFile(url.pathname);
          if (file) {
            serveUiFile(req, res, file);
            return;
          }
          // Dynamic /local/<id> flight probes (.txt) must MISS locally, never
          // proxy: the cloud app also owns /local/[projectId], so a remote
          // 200 (HTML for a '<id>.txt' param) would stop the client router
          // from hard-navigating into the exported shell.
          if (uiDir && /^\/local\/.+\.txt$/.test(url.pathname)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
          }
        }
        if (remoteOrigin) {
          await proxyRemote(req, res, url);
          return;
        }
        // dev (no proxy): unknown paths fall through to the sidecar 404 below.
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, {
          ok: true,
          service: 'sundial-local',
          apiVersion: SIDECAR_API_VERSION,
          projects: store.listProjects().length,
          // Which cloud this instance proxies ('' = direct/dev). The boot
          // deferral must match on it: adopting a same-version sidecar that
          // proxies a DIFFERENT deployment strands the app on the wrong env
          // (bit us: a leftover staging sidecar answered for a prod app).
          remoteOrigin,
        });
        return;
      }
      // Shell bootstrap: prove possession of the per-install token once, get
      // the trust cookie (gates the proxy's sd_ injection) plus the fragment
      // config latch, and land on the app.
      if (req.method === 'GET' && url.pathname === '/boot') {
        const candidate = url.searchParams.get('token') || '';
        const to = url.searchParams.get('to') || '/local';
        if (!verifyToken(candidate) || !to.startsWith('/') || to.startsWith('//')) {
          json(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        res.writeHead(302, {
          'Set-Cookie': `sundial_local=${candidate}; HttpOnly; SameSite=Lax; Path=/`,
          Location: `${to}#sidecarPort=${boundPort}&sidecarToken=${candidate}`,
        });
        res.end();
        return;
      }
      // Config recovery for the packaged app: the page is SERVED by this
      // sidecar, so a same-origin fetch carrying the HttpOnly trust cookie
      // (set by /boot) can always re-learn the port + token — the app never
      // strands on lost browser storage.
      if (req.method === 'GET' && url.pathname === '/session-config') {
        const cookies = String(req.headers.cookie || '').split(/;\s*/);
        if (!cookies.includes(`sundial_local=${token}`)) {
          json(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        json(res, 200, { ok: true, port: boundPort, token });
        return;
      }
      const auth = authed(req);
      if (!auth) {
        json(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      // Replaced-on-update path: a newer sidecar asks this one to step aside
      // (flushes and stops listening; exits only when running standalone).
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        json(res, 200, { ok: true });
        log('shutdown requested (newer instance taking over)');
        setTimeout(async () => {
          await close().catch(() => {});
          if (exitOnShutdown) process.exit(0);
        }, 50);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/projects') {
        // defaultProjectsDir seeds the create/clone dialogs' Location field —
        // only the sidecar knows the machine's home directory.
        json(res, 200, {
          ok: true,
          projects: store.listProjects(),
          defaultProjectsDir: path.join(os.homedir(), 'Documents', 'Sundial'),
        });
        return;
      }
      // Scaffold a brand-new project folder (optionally from a starter pack),
      // then register it like POST /projects would.
      if (req.method === 'POST' && url.pathname === '/projects/create') {
        const body = await readBody(req);
        try {
          const root = await createProjectDir({ name: body.name, location: body.location, pack: body.pack });
          const project = store.openProject(root, typeof body.name === 'string' ? body.name.trim() : undefined);
          ensureWatcher(project);
          json(res, 200, { ok: true, project });
        } catch (error) {
          json(res, 400, { ok: false, error: error?.message || 'Failed to create project' });
        }
        return;
      }
      // Clone a GitHub repo and open it as a project. Responds when the clone
      // finishes — the client owns the progress UI.
      if (req.method === 'POST' && url.pathname === '/projects/clone') {
        const body = await readBody(req);
        try {
          const root = await cloneGitHubRepo({ input: body.url, location: body.location, name: body.name });
          const project = store.openProject(root, typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined);
          ensureWatcher(project);
          json(res, 200, { ok: true, project });
        } catch (error) {
          json(res, 400, { ok: false, error: error?.message || 'Failed to clone repository' });
        }
        return;
      }
      // Local chat engines: are the user's own Claude Code / Codex usable,
      // and which engine is the install's default for new chats?
      if (url.pathname === '/local-engines') {
        if (req.method === 'GET') {
          const [{ detectClaudeEngine }, { detectCodexEngine }] = await Promise.all([
            import('./agent/claude-runner.mjs'),
            import('./agent/codex-runner.mjs'),
          ]);
          const pick = ({ available, loggedIn }) => ({ available, loggedIn });
          json(res, 200, {
            ok: true,
            claude: pick(detectClaudeEngine()),
            codex: pick(detectCodexEngine()),
            defaultHarness: store.getSetting('default_harness'),
          });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const harness = ['vercel', 'claude', 'openai'].includes(body.defaultHarness) ? body.defaultHarness : null;
          if (!harness) {
            json(res, 400, { ok: false, error: 'defaultHarness must be vercel, claude, or openai' });
            return;
          }
          store.setSetting('default_harness', harness);
          store.adoptDefaultHarness();
          json(res, 200, { ok: true, defaultHarness: harness });
          return;
        }
      }
      // Cloud credentials for local Sunny (per install, single user). The
      // signed-in browser mints a user-scoped sd_ token and parks it here so
      // the sidecar can call the metered model-step endpoint.
      if (url.pathname === '/agent-credentials') {
        if (req.method === 'GET') {
          json(res, 200, { ok: true, configured: Boolean(store.getAgentCredentials()) });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          let apiOrigin = typeof body.apiOrigin === 'string' ? body.apiOrigin.trim().replace(/\/$/, '') : '';
          const agentToken = typeof body.token === 'string' ? body.token.trim() : '';
          if (!apiOrigin || !agentToken) {
            json(res, 400, { ok: false, error: 'apiOrigin and token are required' });
            return;
          }
          // In the packaged app the webview's origin IS this sidecar — model
          // steps must go to the cloud it proxies, not back into the proxy.
          if (remoteOrigin && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiOrigin)) {
            apiOrigin = remoteOrigin;
          }
          store.setAgentCredentials({ apiOrigin, token: agentToken });
          json(res, 200, { ok: true });
          return;
        }
        if (req.method === 'DELETE') {
          store.setAgentCredentials(null);
          json(res, 200, { ok: true });
          return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/projects') {
        const body = await readBody(req);
        const root = typeof body.root === 'string' ? path.resolve(body.root) : '';
        const stat = root ? await fsp.stat(root).catch(() => null) : null;
        if (!stat?.isDirectory()) {
          json(res, 400, { ok: false, error: 'root must be an existing directory' });
          return;
        }
        const project = store.openProject(root, typeof body.name === 'string' ? body.name : undefined);
        ensureWatcher(project);
        json(res, 200, { ok: true, project });
        return;
      }

      const projectMatch = /^\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!projectMatch) {
        json(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const project = store.getProject(projectMatch[1]);
      if (!project) {
        json(res, 404, { ok: false, error: 'unknown project' });
        return;
      }
      const sub = projectMatch[2] || '';
      // Multi-root mapping for this request: virtual project path → the owning
      // root + inner path (see roots.mjs). Primary root paths stay unprefixed.
      const roots = projectRoots(store, project);
      const locate = (rel) => locateRel(roots, rel);

      if (req.method === 'GET' && sub === '') {
        json(res, 200, { ok: true, project, roots, shares: bridges.describeShares(project.id) });
        return;
      }
      // ---- Extra roots: mount / unmount outside folders -------------------
      if (sub === '/roots') {
        if (req.method === 'POST') {
          const body = await readBody(req);
          const picked = typeof body.root === 'string' && body.root.trim() ? path.resolve(body.root.trim()) : '';
          const stat = picked ? await fsp.stat(picked).catch(() => null) : null;
          if (!stat?.isDirectory()) {
            json(res, 400, { ok: false, error: 'root must be an existing directory' });
            return;
          }
          // Canonicalize BEFORE comparing/storing: a symlink or alternate
          // spelling (/var vs /private/var) of an already-served tree must
          // read as the same root, not mount the same files twice under two
          // virtual paths (duplicate watchers, forked doc identity).
          const rootPath = await fsp.realpath(picked).catch(() => picked);
          const canonical = await Promise.all(
            roots.map(async (entry) => ({ entry, real: await fsp.realpath(entry.root).catch(() => entry.root) })),
          );
          const existing = canonical.find(({ real }) => real === rootPath);
          if (existing) {
            json(res, 200, { ok: true, root: existing.entry });
            return;
          }
          // Nested roots would double-serve (and double-watch) the overlap.
          // withSep: a filesystem root ('/', 'C:\') already ends with the
          // separator — naive `+ path.sep` would build '//' and let mounting
          // the whole filesystem slip past this guard.
          const withSep = (p) => (p.endsWith(path.sep) ? p : p + path.sep);
          const overlap = canonical.find(
            ({ real }) => rootPath.startsWith(withSep(real)) || real.startsWith(withSep(rootPath)),
          );
          if (overlap) {
            json(res, 400, { ok: false, error: 'folder overlaps a folder already in this project' });
            return;
          }
          // Prefix must not shadow an existing root prefix or a current
          // top-level entry of the primary root (deterministic -2/-3 suffix).
          const taken = new Set(roots.map((entry) => entry.prefix).filter(Boolean));
          for (const name of await fsp.readdir(project.root).catch(() => [])) taken.add(name);
          const prefix = pickRootPrefix(rootPath, taken);
          store.addExtraRoot(project.id, prefix, rootPath);
          try {
            watchers.get(project.id)?.attach(prefix, rootPath, onWatcherChange(project));
          } catch (error) {
            log(`watcher failed root=${rootPath} error=${error?.message}`);
          }
          emit(project.id, { type: 'files-changed', path: prefix });
          json(res, 200, { ok: true, root: { prefix, root: rootPath, name: path.basename(rootPath) || rootPath } });
          return;
        }
        if (req.method === 'DELETE') {
          const prefix = url.searchParams.get('prefix') || '';
          if (!store.listExtraRoots(project.id).some((row) => row.prefix === prefix)) {
            json(res, 404, { ok: false, error: 'unknown folder' });
            return;
          }
          // Detach cleanly: flush unpersisted keystrokes to disk FIRST (the
          // folder survives on disk, so a pending debounce window must not be
          // dropped by the detach), then stop the watcher, close live docs
          // under the prefix, drop store traces. Disk is never touched.
          await docHost.flushProject(project.id);
          watchers.get(project.id)?.detach(prefix);
          await docHost.detachUnder(project.id, prefix);
          store.removeExtraRoot(project.id, prefix);
          emit(project.id, { type: 'files-changed', path: prefix });
          json(res, 200, { ok: true });
          return;
        }
      }
      if (req.method === 'PATCH' && sub === '') {
        const body = await readBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          json(res, 400, { ok: false, error: 'name is required' });
          return;
        }
        json(res, 200, { ok: true, project: store.renameProject(project.id, name) });
        return;
      }
      if (req.method === 'DELETE' && sub === '') {
        await bridges.stopProject(project.id);
        watchers.get(project.id)?.close();
        watchers.delete(project.id);
        store.removeProject(project.id);
        json(res, 200, { ok: true });
        return;
      }
      // Identity survives edits and renames but not delete+recreate — the
      // editor uses a changed id to drop its cached Y.Doc for the path.
      const describeEntry = (file, id = store.ensureFileId(project.id, file.path)) => ({
        id,
        mime: MIME[path.extname(file.path).toLowerCase()] ?? null,
        ...file,
      });
      const describePath = async (rel) => {
        const loc = locate(rel);
        // rel === an extra root's prefix resolves to the mounted folder itself.
        const abs = loc.rel ? await safeResolveInRoot(loc.root, loc.rel) : loc.root;
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat) return null;
        return describeEntry({
          path: rel,
          type: stat.isDirectory() ? 'folder' : fileKind(rel) === 'text' ? 'text' : 'blob',
          size: stat.isDirectory() ? 0 : stat.size,
          updated_at: stat.mtime.toISOString(),
        });
      };

      if (req.method === 'GET' && sub === '/files') {
        const files = await walkAllRoots(roots);
        const ids = store.ensureFileIds(project.id, files.map((file) => file.path));
        json(res, 200, { ok: true, files: files.map((file) => describeEntry(file, ids.get(file.path))), roots });
        return;
      }
      if (req.method === 'GET' && sub === '/file') {
        const rel = normalizeRelPath(url.searchParams.get('path') || '');
        if (!rel || isIgnoredPath(rel)) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        const loc = locate(rel);
        const abs = loc.rel ? await safeResolveInRoot(loc.root, loc.rel) : null;
        const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
        if (!stat?.isFile()) {
          json(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const ext = path.extname(rel).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || (fileKind(rel) === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
          'Content-Length': stat.size,
        });
        // Headers are already sent — an async read error (file vanished mid-
        // stream) must sever the response, not crash the process.
        fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
        return;
      }
      if (req.method === 'PUT' && sub === '/blob') {
        // Raw-bytes upload, streamed to disk. Local projects are the user's
        // own file system — no size cap, no base64/JSON inflation (the JSON
        // rail below tops out at the 20 MB body cap).
        const rel = normalizeRelPath(url.searchParams.get('path') || '');
        if (!rel || isIgnoredPath(rel) || fileKind(rel) !== 'blob') {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        const loc = locate(rel);
        await writeBlobStreamAtomic(loc.root, loc.rel, req);
        // Suppress AFTER the write: the watcher only sees the final rename
        // (tmp paths are ignored), and a pre-write suppression window could
        // expire mid-stream on large files.
        watchers.get(project.id)?.suppress(rel);
        await bridges.handleLocalFileEvent(project.id, rel);
        emit(project.id, { type: 'files-changed', path: rel });
        json(res, 200, { ok: true, file: await describePath(rel) });
        return;
      }
      if (req.method === 'PUT' && sub === '/file') {
        const body = await readBody(req);
        const rel = normalizeRelPath(body.path || '');
        const kind = rel && !isIgnoredPath(rel) ? fileKind(rel) : null;
        // Binary upload: base64 body, no doc host involvement; share bridges
        // pick it up for sha-diffed blob sync.
        if (kind === 'blob' && typeof body.contentBase64 === 'string') {
          watchers.get(project.id)?.suppress(rel);
          const loc = locate(rel);
          await writeBlobAtomic(loc.root, loc.rel, Buffer.from(body.contentBase64, 'base64'));
          await bridges.handleLocalFileEvent(project.id, rel);
          emit(project.id, { type: 'files-changed', path: rel });
          json(res, 200, { ok: true, file: await describePath(rel) });
          return;
        }
        if (kind !== 'text') {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        // Editor image drops always send base64 — but some image types (SVG)
        // are TEXT-classified by the sync policy, so decode instead of
        // silently writing '' (which corrupted dropped SVGs).
        const content =
          typeof body.content === 'string'
            ? body.content
            : typeof body.contentBase64 === 'string'
              ? Buffer.from(body.contentBase64, 'base64').toString('utf8')
              : '';
        watchers.get(project.id)?.suppress(rel);
        const loc = locate(rel);
        await writeTextFileAtomic(loc.root, loc.rel, content);
        // Attribution flows through handleDiskChange (one ledger row, the
        // caller's actor) — a separate recordEdit here would double-record.
        await docHost.handleDiskChange(project.id, rel, { actor: auth.actor });
        await bridges.handleLocalFileEvent(project.id, rel);
        emit(project.id, { type: 'files-changed', path: rel });
        json(res, 200, { ok: true, file: await describePath(rel) });
        return;
      }
      if (req.method === 'POST' && sub === '/folder') {
        const body = await readBody(req);
        const rel = normalizeRelPath(body.path || '');
        if (!rel || isIgnoredPath(rel)) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        const loc = locate(rel);
        if (!loc.rel) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        await makeFolder(loc.root, loc.rel);
        emit(project.id, { type: 'files-changed', path: rel });
        json(res, 200, { ok: true, file: await describePath(rel) });
        return;
      }
      if (req.method === 'POST' && sub === '/copy') {
        const body = await readBody(req);
        const from = normalizeRelPath(body.from || '');
        const to = normalizeRelPath(body.to || '');
        if (!from || !to || isIgnoredPath(from) || isIgnoredPath(to)) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        const fromLoc = locate(from);
        const toLoc = locate(to);
        if (!fromLoc.rel || !toLoc.rel || fromLoc.root !== toLoc.root) {
          json(res, 400, { ok: false, error: 'cannot copy across added folders' });
          return;
        }
        // Copied text files flow through the watcher (doc host + bridges pick
        // them up as new files); emit immediately so the tree feels instant.
        await copyPath(fromLoc.root, fromLoc.rel, toLoc.rel);
        emit(project.id, { type: 'files-changed', path: to });
        json(res, 200, { ok: true, file: await describePath(to) });
        return;
      }
      if (req.method === 'GET' && sub === '/download') {
        const relFile = url.searchParams.get('path');
        const folder = url.searchParams.get('folderPath');
        const disposition = (name) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
        if (relFile && !folder) {
          const rel = normalizeRelPath(relFile);
          const loc = rel ? locate(rel) : null;
          const abs = rel && loc?.rel && !isIgnoredPath(rel) ? await safeResolveInRoot(loc.root, loc.rel) : null;
          const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
          if (!stat?.isFile()) {
            json(res, 404, { ok: false, error: 'not found' });
            return;
          }
          const ext = path.extname(rel).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Content-Disposition': disposition(path.basename(rel)),
          });
          fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
          return;
        }
        // Folder or whole-project zip (store-only). Bounded so a giant
        // project can't balloon the sidecar's memory.
        const folderRel = folder ? normalizeRelPath(folder) : '';
        const inScope = (rel) => !folderRel || rel === folderRel || rel.startsWith(`${folderRel}/`);
        const prefixLen = folderRel ? folderRel.length + 1 : 0;
        const baseName = folderRel ? path.basename(folderRel) : project.name || 'workspace';
        const entries = [];
        let total = 0;
        for (const file of await walkAllRoots(roots)) {
          if (file.type === 'folder' || !inScope(file.path)) continue;
          total += file.size;
          if (total > 200 * 1024 * 1024) {
            json(res, 413, { ok: false, error: 'folder too large to zip' });
            return;
          }
          const loc = locate(file.path);
          const abs = await safeResolveInRoot(loc.root, loc.rel).catch(() => null);
          const data = abs ? await fsp.readFile(abs).catch(() => null) : null;
          if (!data) continue;
          entries.push({ path: `${baseName}/${file.path.slice(prefixLen)}`, content: data });
        }
        const zip = await createZipNodeBuffer(entries);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zip.length,
          'Content-Disposition': disposition(`${baseName}.zip`),
        });
        res.end(zip);
        return;
      }
      if (req.method === 'POST' && sub === '/reveal') {
        const body = await readBody(req);
        const rel = normalizeRelPath(body.path || '');
        const loc = rel ? locate(rel) : null;
        const abs = loc ? (loc.rel ? await safeResolveInRoot(loc.root, loc.rel) : loc.root) : project.root;
        const { spawn } = await import('node:child_process');
        const cmd = process.platform === 'darwin'
          ? ['open', ['-R', abs]]
          : process.platform === 'win32'
            ? ['explorer', [`/select,${abs}`]]
            : ['xdg-open', [path.dirname(abs)]];
        spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && sub === '/rename') {
        const body = await readBody(req);
        const from = normalizeRelPath(body.from || '');
        const to = normalizeRelPath(body.to || '');
        if (!from || !to || isIgnoredPath(from) || isIgnoredPath(to)) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        const fromLoc = locate(from);
        const toLoc = locate(to);
        // Root prefixes themselves don't rename here (detach via /roots), and
        // entries can't move between roots — each root is its own disk tree.
        if (!fromLoc.rel || !toLoc.rel || fromLoc.root !== toLoc.root) {
          json(res, 400, { ok: false, error: 'cannot move across added folders' });
          return;
        }
        await renameFile(fromLoc.root, fromLoc.rel, toLoc.rel);
        await docHost.handleDiskRename(project.id, from, to);
        await bridges.handleLocalRename(project.id, from, to);
        store.renameCommentPaths(project.id, from, to);
        emit(project.id, { type: 'files-changed', path: to });
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'DELETE' && sub === '/file') {
        const rel = normalizeRelPath(url.searchParams.get('path') || '');
        // The ignored-path guard matters most HERE: deleteFile is recursive,
        // and .git / node_modules are exactly what it must never touch.
        const loc = locate(rel);
        // A root prefix itself never deletes through here — detaching a
        // mounted folder is DELETE /roots (and never touches the disk).
        if (!rel || !loc.rel || isIgnoredPath(rel)) {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        // Untracked content (unknown-extension files, symlinks) is invisible
        // to the listing but destroyed by this delete — probed BEFORE the rm
        // so the client can refuse to advertise an undo that couldn't bring
        // everything back.
        let untracked = await hasUntrackedContent(loc.root, loc.rel).catch(() => true);
        // Snapshot text bodies the ledger doesn't hold yet (files never edited
        // since the project opened) so undo-delete can always reconstruct. A
        // victim whose body can't be read (oversized text past MAX_TEXT_BYTES)
        // poisons restorability the same way untracked content does — undo
        // would restore stale content or nothing.
        const victims = (await walkProject(loc.root))
          .filter((file) => file.type === 'text' && (file.path === loc.rel || file.path.startsWith(`${loc.rel}/`)))
          .map((file) => ({ inner: file.path, virtual: loc.entry.prefix ? `${loc.entry.prefix}/${file.path}` : file.path }));
        for (const file of victims) {
          const text =
            docHost.getLiveText(project.id, file.virtual) ??
            (await readTextFile(loc.root, file.inner).catch(() => null))?.text;
          if (typeof text !== 'string') {
            untracked = true;
          } else if (store.latestContentBefore(project.id, file.virtual) !== text) {
            store.recordEdit({ projectId: project.id, path: file.virtual, actor: auth.actor, contentText: text });
          }
        }
        await deleteFile(loc.root, loc.rel);
        await docHost.handleDiskChange(project.id, rel, { actor: auth.actor });
        await bridges.handleLocalFileEvent(project.id, rel);
        emit(project.id, { type: 'files-changed', path: rel });
        // The undo cutoff must be STRICTLY after every ledger row this delete
        // wrote (snapshots + tombstones) — a browser-minted timestamp can tie
        // the same millisecond and make `created_at < cutoff` miss them.
        json(res, 200, { ok: true, deletedAt: new Date(Date.now() + 1).toISOString(), untracked });
        return;
      }
      if (req.method === 'GET' && sub === '/text-contents') {
        // Bulk text bodies for project-wide search/replace, preferring live
        // doc text over disk so results reflect unflushed keystrokes.
        const prefix = normalizeRelPath(url.searchParams.get('prefix') || '');
        const files = [];
        let total = 0;
        for (const file of await walkAllRoots(roots)) {
          if (file.type !== 'text') continue;
          if (prefix && file.path !== prefix && !file.path.startsWith(`${prefix}/`)) continue;
          const fileLoc = locate(file.path);
          const live = docHost.getLiveText(project.id, file.path);
          const text = live ?? (await readTextFile(fileLoc.root, fileLoc.rel).catch(() => null))?.text;
          if (typeof text !== 'string') continue;
          total += text.length;
          if (total > 30_000_000) {
            json(res, 413, { ok: false, error: 'project too large for bulk text read' });
            return;
          }
          files.push({ path: file.path, text });
        }
        json(res, 200, { ok: true, files });
        return;
      }
      // ---- Edit history (Review panel backing) ---------------------------
      if (req.method === 'GET' && sub === '/changes') {
        const beforeId = Number(url.searchParams.get('beforeId') || 0) || null;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 200);
        const relPath = url.searchParams.get('path');
        const folder = url.searchParams.get('folder');
        const actors = url.searchParams.get('actors')?.split(',') ?? null;
        const chatId = url.searchParams.get('chatId') || null;
        const scanOpts = {
          path: relPath ? normalizeRelPath(relPath) : null,
          folder: folder ? normalizeRelPath(folder) : null,
          beforeId,
        };
        // Actor/chat narrowing is two-phase: a FILTERED locator scan finds
        // where the selected author/chat was active (recent unrelated edits
        // can't bury it past the window), then grouping re-reads those
        // paths' FULL streams (≤500 rows each by retention) so interposed
        // other-author rows still split sessions — filtering rows before
        // grouping would merge adjacent sessions into a reviewId that
        // /applied-edit (which groups full history) cannot resolve.
        const locateRows = (filters) => {
          const located = store.listEditsWindow(project.id, { ...scanOpts, ...filters });
          const paths = [...new Set(located.rows.map((row) => row.path))];
          let full = paths
            .flatMap((p) => store.listPathEditsUpTo(project.id, p, (beforeId ?? Number.MAX_SAFE_INTEGER) - 1))
            .sort((a, b) => a.id - b.id);
          if (located.capped) full = full.filter((row) => row.id >= located.rows[0].id);
          return { rows: full, capped: located.capped };
        };
        let rows, capped;
        if (actors || chatId) ({ rows, capped } = locateRows({ actors, chatId }));
        else ({ rows, capped } = store.listEditsWindow(project.id, scanOpts));
        let { entries, actorCounts, nextBeforeId } = buildLocalChangeEntries(rows, {
          limit,
          scanFloor: capped ? rows[0]?.id ?? null : null,
          actors,
          chatId,
        });
        if (actors) {
          // Author-chip counts stay pre-actor-filter — recomputed over the
          // same scope minus the actor filter (chat locator when chat-scoped,
          // else the plain window). One extra local SQLite scan is cheap.
          const countRows = chatId ? locateRows({ chatId }).rows : store.listEditsWindow(project.id, scanOpts).rows;
          actorCounts = buildLocalChangeEntries(countRows, { limit: 1, chatId }).actorCounts;
        }
        // A suggest session is 'pending' while any of its staged suggestion
        // ids is still unresolved in the doc — that's what arms the panel's
        // Keep/Undo; once resolved (panel or inline ✓/✕) it's plain history.
        for (const entry of entries) {
          entry.reviewState =
            entry.editMode === 'suggest' && docHost.hasPendingSuggestions(project.id, entry.path, entry.suggestionIds)
              ? 'pending'
              : 'applied';
        }
        json(res, 200, {
          ok: true,
          entries,
          actorCounts,
          latestDocEditId: store.latestEditId(project.id),
          nextBeforeId,
        });
        return;
      }
      if (req.method === 'GET' && sub === '/applied-edit') {
        const lastRowId = Number(url.searchParams.get('lastRowId') || 0);
        // Path is derivable from the anchor row — the panel's turn-edits GET
        // only carries the `applied-<rowId>` review id.
        const rel =
          normalizeRelPath(url.searchParams.get('path') || '') || (lastRowId ? store.editPath(project.id, lastRowId) : null);
        if (!rel || !lastRowId) {
          json(res, 400, { ok: false, error: 'path and lastRowId are required' });
          return;
        }
        const rows = store.listPathEditsUpTo(project.id, rel, lastRowId);
        const session = collectLocalSessions(rows).find((s) => s.lastRowId === lastRowId);
        if (!session) {
          json(res, 404, { ok: false, error: 'unknown edit session' });
          return;
        }
        const firstIndex = rows.findIndex((row) => row.id === session.firstRowId);
        const before = firstIndex > 0 ? store.getEditContent(rows[firstIndex - 1].id) : null;
        const after = store.getEditContent(session.lastRowId);
        const deleted = after != null && after.content_text === null;
        // Reject-projection of the session's still-live marks — two jobs:
        // the diff baseline when NO earlier ledger row exists (first-ever
        // edit of a pre-existing file must not read as a whole-file "New
        // file" insertion), and the pending payload's `rejectedText` (with a
        // PARTIALLY inline-decided session, the undecided delta is
        // rejected→current, not the whole recorded diff). Null = nothing live.
        const rejected =
          !deleted && session.suggestionIds?.length
            ? await docHost.rejectedProjection(project.id, rel, session.suggestionIds)
            : null;
        json(res, 200, {
          ok: true,
          // Deletions diff against the newest recorded body — the pre-delete
          // snapshot can live INSIDE the same session (a never-edited file's
          // snapshot + tombstone land together), where the predecessor row
          // would wrongly read as "empty file deleted". Otherwise a
          // null-content predecessor is a delete marker/bridge row — the file
          // was absent (or unknowable) before this session → new file.
          beforeText: deleted
            ? store.latestContentBefore(project.id, rel, { atId: session.lastRowId }) ?? ''
            : before?.content_text ?? rejected ?? '',
          afterText: after?.content_text ?? '',
          deleted,
          session,
          rejectedText: rejected,
          currentText: deleted
            ? null
            : docHost.getLiveText(project.id, rel) ??
              (await readTextFile(locate(rel).root, locate(rel).rel).catch(() => null))?.text ??
              null,
        });
        return;
      }
      // Keep/Undo for a suggest session (`applied-<rowId>`): resolve its staged
      // suggestion ids through the doc host — live editors see the marks clear,
      // disk gets the accepted/reverted projection, a rejected creation deletes
      // its file. Idempotent: an already-resolved session is `changed: false`.
      if (req.method === 'POST' && sub === '/resolve-review') {
        const body = await readBody(req);
        const reviewId = typeof body.reviewId === 'string' ? body.reviewId : '';
        const action = body.action === 'reject' ? 'reject' : 'accept';
        const lastRowId = Number(reviewId.startsWith('applied-') ? reviewId.slice('applied-'.length) : 0);
        const rel = Number.isInteger(lastRowId) && lastRowId > 0 ? store.editPath(project.id, lastRowId) : null;
        if (!rel) {
          json(res, 404, { ok: false, error: 'unknown edit session' });
          return;
        }
        const session = collectLocalSessions(store.listPathEditsUpTo(project.id, rel, lastRowId)).find(
          (s) => s.lastRowId === lastRowId,
        );
        if (!session) {
          json(res, 404, { ok: false, error: 'unknown edit session' });
          return;
        }
        const result = await docHost.resolveSuggestions(project.id, rel, session.suggestionIds, action, {
          actor: 'user',
          chatId: session.chatId,
        });
        // changed:false is benign only when nothing is left pending (already
        // resolved elsewhere). Marks still live means the resolve DECLINED
        // (e.g. the file became unreadable) — report failure, or the panel
        // would record a decision and hide a still-pending suggestion.
        if (!result.changed && docHost.hasPendingSuggestions(project.id, rel, session.suggestionIds)) {
          json(res, 409, { ok: false, error: 'The suggestion could not be resolved — the file is unreadable.' });
          return;
        }
        if (result.changed) {
          // The resolution persisted with the watcher suppressed — nothing
          // else announces it. Sync + announce like other internal writes (a
          // rejected creation's DELETE arrives separately via onFileRemoved).
          void bridges
            .handleLocalFileEvent(project.id, rel)
            .catch((error) => log(`bridge resolve failed path=${rel} error=${error?.message}`));
          emit(project.id, { type: 'files-changed', path: rel });
        }
        // `after` = the file's text once the dust settles — with PARTIALLY
        // pre-decided sessions (one id accepted inline, the other undone
        // here) the surviving delta is what the caller must report, not the
        // whole session diff. Null = the file is gone (rejected creation).
        const after = (await readTextFile(locate(rel).root, locate(rel).rel).catch(() => null))?.text ?? null;
        json(res, 200, { ok: true, changed: result.changed, after });
        return;
      }
      if (req.method === 'GET' && sub === '/history-compare') {
        const to = Number(url.searchParams.get('to') || 0);
        const from = Number(url.searchParams.get('from') || 0) || null;
        if (!to) {
          json(res, 400, { ok: false, error: 'to is required' });
          return;
        }
        // Per-path text at each point: newest ledger row ≤ the point (null
        // content = absent). Paths older than the 500-row retention window
        // under-resolve to "absent" — same trade the cap already makes.
        const files = [];
        for (const relPath of store.listEditPaths(project.id, to)) {
          const beforeText = from ? store.editTextAt(project.id, relPath, from) : undefined;
          const afterText = store.editTextAt(project.id, relPath, to);
          const beforeExists = typeof beforeText === 'string';
          const afterExists = typeof afterText === 'string';
          if (!beforeExists && !afterExists) continue;
          if (beforeExists && afterExists && beforeText === afterText) continue;
          files.push({
            path: relPath,
            status: !beforeExists ? 'added' : !afterExists ? 'removed' : 'modified',
            beforeText: beforeText ?? '',
            afterText: afterText ?? '',
          });
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        json(res, 200, { ok: true, from, to, files });
        return;
      }
      if (sub === '/labels') {
        if (req.method === 'GET') {
          json(res, 200, { ok: true, labels: store.listHistoryLabels(project.id) });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const docEditId = Number(body.docEditId || 0);
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!Number.isInteger(docEditId) || docEditId <= 0 || !name) {
            json(res, 400, { ok: false, error: 'docEditId and name are required' });
            return;
          }
          json(res, 200, { ok: true, label: store.upsertHistoryLabel(project.id, docEditId, name.slice(0, 120)) });
          return;
        }
        if (req.method === 'DELETE') {
          const labelId = url.searchParams.get('id') || '';
          json(res, 200, { ok: true, removed: store.deleteHistoryLabel(project.id, labelId) });
          return;
        }
      }
      if (req.method === 'POST' && sub === '/history-restore') {
        const body = await readBody(req);
        const rel = normalizeRelPath(String(body.path || ''));
        if (!rel || isIgnoredPath(rel) || fileKind(rel) !== 'text') {
          json(res, 400, { ok: false, error: 'invalid path' });
          return;
        }
        // Restore is for GONE files (the undo-delete flow) — a path re-created
        // since the delete must not be clobbered by a stale undo (cloud parity).
        const restoreLoc = locate(rel);
        const existingAbs = await safeResolveInRoot(restoreLoc.root, restoreLoc.rel);
        if (await fsp.stat(existingAbs).catch(() => null)) {
          json(res, 409, { ok: false, error: 'path already exists' });
          return;
        }
        const atId = Number(body.atId || 0) || null;
        const text = store.latestContentBefore(project.id, rel, {
          atId,
          beforeCreatedAt: typeof body.beforeCreatedAt === 'string' ? body.beforeCreatedAt : null,
        });
        if (typeof text !== 'string') {
          json(res, 404, { ok: false, error: 'no recorded content for that path' });
          return;
        }
        // Same rail as a text PUT: write, fold into any live doc (attributed),
        // relay to shares, refresh the tree.
        watchers.get(project.id)?.suppress(rel);
        await writeTextFileAtomic(restoreLoc.root, restoreLoc.rel, text);
        await docHost.handleDiskChange(project.id, rel, { actor: auth.actor });
        await bridges.handleLocalFileEvent(project.id, rel);
        emit(project.id, { type: 'files-changed', path: rel });
        json(res, 200, { ok: true, file: await describePath(rel) });
        return;
      }
      if (req.method === 'GET' && sub === '/edits') {
        const rel = url.searchParams.get('path');
        json(res, 200, {
          ok: true,
          edits: store.listEdits(project.id, {
            path: rel ? normalizeRelPath(rel) : null,
            afterId: Number(url.searchParams.get('afterId') || 0),
          }),
        });
        return;
      }
      if (req.method === 'GET' && sub === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('data: {"type":"connected"}\n\n');
        let clients = sseClients.get(project.id);
        if (!clients) {
          clients = new Set();
          sseClients.set(project.id, clients);
        }
        clients.add(res);
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          clients.delete(res);
        });
        return;
      }
      // ---- Local Sunny: chats + agent runs ------------------------------
      if (req.method === 'GET' && sub === '/chats') {
        json(res, 200, { ok: true, chats: store.listChats(project.id) });
        return;
      }
      if (req.method === 'POST' && sub === '/chats') {
        const body = await readBody(req);
        // New chats default to the engine picked at onboarding — and to a
        // model that engine can run: a client that created the chat before
        // probing the default would otherwise pair e.g. a Codex chat with an
        // Anthropic model.
        const harness = typeof body.harness === 'string' ? body.harness : store.getSetting('default_harness');
        const model = coerceModelForHarness(harness, typeof body.model === 'string' ? body.model : null);
        const chat = store.createChat(project.id, {
          title: typeof body.title === 'string' ? body.title : null,
          model,
          harness,
        });
        json(res, 200, { ok: true, chat });
        return;
      }
      if (req.method === 'PATCH' && /^\/chats\/[^/]+$/.test(sub)) {
        const chatId = sub.split('/')[2];
        const body = await readBody(req);
        const patch = {};
        // Auto-generated first-message title: CAS write (only while unnamed),
        // so a user rename in flight is never clobbered.
        if (typeof body.autoTitle === 'string' && body.autoTitle.trim()) {
          store.setChatTitleIfUnset(chatId, body.autoTitle.trim());
        }
        if (typeof body.title === 'string') patch.title = body.title;
        if (typeof body.model === 'string') patch.model = body.model;
        if (typeof body.harness === 'string') patch.harness = body.harness;
        if (typeof body.archived === 'boolean') patch.archived_at = body.archived ? new Date().toISOString() : null;
        if (typeof body.pinned === 'boolean') patch.pinned = body.pinned ? 1 : 0;
        const chat = store.updateChat(chatId, patch);
        if (!chat) {
          json(res, 404, { ok: false, error: 'unknown chat' });
          return;
        }
        json(res, 200, { ok: true, chat });
        return;
      }
      // ---- External agent sessions (Claude Code / Codex transcripts on
      // disk). Read-only over the agents' own dirs — never writes there.
      if (sub === '/external-sessions' && req.method === 'GET') {
        const { listExternalSessions } = await import('./external-sessions.mjs');
        const sessions = await listExternalSessions({ roots, exclude: store.externalSessionLinks(project.id) });
        // The transcript path stays server-side: clients re-address by id.
        json(res, 200, { ok: true, sessions: sessions.map(({ path: _path, ...session }) => session) });
        return;
      }
      if (sub === '/external-sessions/messages' && req.method === 'GET') {
        const { findExternalSession, readExternalSessionMessages } = await import('./external-sessions.mjs');
        const session = await findExternalSession({
          roots,
          agent: url.searchParams.get('agent') || 'claude',
          id: url.searchParams.get('id') || '',
        });
        if (!session) {
          json(res, 404, { ok: false, error: 'unknown session' });
          return;
        }
        json(res, 200, { ok: true, messages: await readExternalSessionMessages(session) });
        return;
      }
      // Adopt a session as a real chat (the banner's Import AND Resume): the
      // transcript persists as attributed rows, and the external link makes
      // later sends continue the engine's own session natively.
      if (sub === '/external-sessions/import' && req.method === 'POST') {
        const body = await readBody(req);
        const { findExternalSession, readExternalSessionMessages } = await import('./external-sessions.mjs');
        const agent = body.agent === 'codex' ? 'codex' : 'claude';
        const session = await findExternalSession({ roots, agent, id: typeof body.id === 'string' ? body.id : '' });
        if (!session) {
          json(res, 404, { ok: false, error: 'unknown session' });
          return;
        }
        // Read the transcript BEFORE creating anything: a vanished/unreadable
        // file must fail the request without leaving an empty linked chat
        // that would block retries (linked sessions leave the listing).
        const importedRows = await readExternalSessionMessages(session);
        // Idempotent: a re-post (double-click, second window) answers the
        // already-adopted chat. From here to the end everything is synchronous
        // — one tick — so concurrent imports can't both create.
        const existing = store.findChatByExternalSession(project.id, agent, session.id);
        if (existing) {
          json(res, 200, { ok: true, chat: existing });
          return;
        }
        const chat = store.createChat(project.id, {
          title: session.title,
          harness: agent === 'codex' ? 'openai' : 'claude',
          externalAgent: agent,
          externalSessionId: session.id,
          externalCwd: session.cwd,
        });
        // `imported` marks the engine-already-knows boundary: resumed runs
        // send only rows after it (an interrupted transcript can end without
        // an assistant reply, so "after the last assistant" isn't enough).
        for (const row of importedRows) {
          store.appendChatMessage(project.id, chat.id, {
            role: row.role,
            content: row.content,
            metadata: { ...(row.metadata ?? {}), imported: true },
          });
        }
        json(res, 200, { ok: true, chat: store.getChat(chat.id) });
        return;
      }
      if (req.method === 'GET' && sub === '/chat-messages') {
        const chatId = url.searchParams.get('chatId') || '';
        json(res, 200, {
          ok: true,
          messages: store.listChatMessages(project.id, chatId, {
            afterSequence: Number(url.searchParams.get('afterSequence') || 0),
          }),
        });
        return;
      }
      if (req.method === 'POST' && sub === '/chat-messages') {
        const body = await readBody(req);
        const chatId = typeof body.chatId === 'string' ? body.chatId : '';
        const content = typeof body.content === 'string' ? body.content : '';
        const chat = chatId ? store.getChat(chatId) : null;
        if (!chat || chat.project_id !== project.id) {
          json(res, 404, { ok: false, error: 'unknown chat' });
          return;
        }
        // clientId dedup mirrors the cloud route: the browser retries the POST
        // after auto-provisioning agent credentials, and the retry must reuse
        // the already-stored row instead of duplicating the message.
        const clientId = typeof body.clientId === 'string' ? body.clientId : null;
        const message =
          store.findChatMessageByClientId(chatId, clientId) ??
          store.appendChatMessage(project.id, chatId, {
            role: 'user',
            content,
            clientId,
            metadata: { author_user_id: 'local' },
          });
        // The Claude/Codex engines run on the user's own local logins — cloud
        // credentials (sign-in + credits) gate only the cloud-step loop.
        const harness = chat.harness === 'claude' || chat.harness === 'openai' ? chat.harness : 'vercel';
        const credentials = harness === 'vercel' ? store.getAgentCredentials() : null;
        if (harness === 'vercel' && !credentials) {
          json(res, 200, { ok: true, message, agentStart: { status: 'blocked', reason: 'credentials_missing' } });
          return;
        }
        const editMode = ['view', 'suggest', 'edit'].includes(body.editMode) ? body.editMode : 'edit';
        agentHost.start({
          project,
          chatId,
          model: typeof body.model === 'string' && body.model ? body.model : chat.model,
          harness,
          credentials,
          editMode,
          writeText: createAgentWriter({
            project, docHost, watchers, bridges, emit, chatId, editMode,
            authorId: engineAuthorId(harness),
          }),
        });
        json(res, 200, { ok: true, message, agentStart: { status: 'started' } });
        return;
      }
      if (req.method === 'GET' && sub === '/agent-stream') {
        const chatId = url.searchParams.get('chatId') || '';
        const run = agentHost.activeStream(chatId);
        if (!run) {
          json(res, 404, { ok: false, error: 'no active stream' });
          return;
        }
        const offset = Number(req.headers['last-event-id'] || 0);
        const resumeId = String(req.headers['x-resume-stream-id'] || '');
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Stream-Id': run.id,
          'Access-Control-Expose-Headers': 'X-Stream-Id',
        });
        // The offset only applies to the stream it was counted against.
        const unsubscribe = run.subscribe(res, resumeId === run.id ? offset : 0);
        req.on('close', unsubscribe);
        return;
      }
      if (req.method === 'POST' && sub === '/agent-interrupt') {
        const body = await readBody(req);
        json(res, 200, { ok: true, active: agentHost.interrupt(String(body.chatId || '')) });
        return;
      }

      // ---- Doc comments (single local user; author snapshot comes from the
      // signed-in browser so echoes reconcile with optimistic renders) -------
      if (sub === '/comments') {
        const localAuthor = (candidate) =>
          candidate && typeof candidate === 'object' && typeof candidate.userId === 'string'
            ? candidate
            : { userId: 'local', name: null, username: null, imageUrl: null };
        const threadsFor = (path) => store.listCommentThreads(project.id, { path: path || null });
        if (req.method === 'GET') {
          const rel = url.searchParams.get('path');
          json(res, 200, { ok: true, threads: threadsFor(rel ? normalizeRelPath(rel) : null) });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const rel = normalizeRelPath(String(body.path || ''));
          const quote = typeof body.quote === 'string' ? body.quote.trim() : '';
          const text = typeof body.body === 'string' ? body.body.trim() : '';
          if (!rel || !quote || !text || !body.anchor || !body.head) {
            json(res, 400, { ok: false, error: 'path, quote, anchor, head, and body are required' });
            return;
          }
          store.createCommentThread(project.id, {
            path: rel,
            quote,
            anchor: body.anchor,
            head: body.head,
            body: text,
            author: localAuthor(body.author),
          });
          emit(project.id, { type: 'comments-changed', path: rel });
          json(res, 200, { ok: true, threads: threadsFor(rel) });
          return;
        }
        // PATCH (reply/edit/resolve/reopen) and DELETE (message; index 0
        // deletes the thread) — mirrors the cloud route's action semantics.
        const body = await readBody(req);
        const threadId = String(body.threadId || '');
        const thread = threadId ? store.getCommentThread(threadId) : null;
        if (!thread || thread.projectId !== project.id) {
          json(res, 404, { ok: false, error: 'Comment thread not found' });
          return;
        }
        if (req.method === 'PATCH') {
          const action = String(body.action || '');
          const text = typeof body.body === 'string' ? body.body.trim() : '';
          if (action === 'reply') {
            if (!text) {
              json(res, 400, { ok: false, error: 'body is required for replies' });
              return;
            }
            store.addCommentMessage(threadId, { body: text, author: localAuthor(body.author) });
          } else if (action === 'edit') {
            const messageId = String(body.messageId || '');
            if (!messageId || !text) {
              json(res, 400, { ok: false, error: 'messageId and body are required for edits' });
              return;
            }
            if (!store.editCommentMessage(threadId, messageId, text)) {
              json(res, 404, { ok: false, error: 'Comment message not found' });
              return;
            }
          } else if (action === 'resolve' || action === 'reopen') {
            store.setCommentThreadStatus(
              threadId,
              action === 'resolve' ? 'resolved' : 'open',
              localAuthor(body.author).userId,
            );
          } else {
            json(res, 400, { ok: false, error: 'Unsupported action' });
            return;
          }
        } else if (req.method === 'DELETE') {
          if (!store.deleteCommentMessage(threadId, String(body.messageId || ''))) {
            json(res, 404, { ok: false, error: 'Comment message not found' });
            return;
          }
        } else {
          json(res, 404, { ok: false, error: 'not found' });
          return;
        }
        emit(project.id, { type: 'comments-changed', path: thread.filePath });
        json(res, 200, { ok: true, threads: threadsFor(thread.filePath) });
        return;
      }

      if (req.method === 'POST' && sub === '/compile') {
        const body = await readBody(req);
        const rel = normalizeRelPath(body.path || '');
        if (!rel || isIgnoredPath(rel) || !rel.toLowerCase().endsWith('.tex')) {
          json(res, 400, { ok: false, error: 'path must be a .tex file' });
          return;
        }
        json(res, 200, await compileLatexLocally({
          project,
          relPath: rel,
          source: typeof body.source === 'string' ? body.source : undefined,
          docHost,
          watchers,
          emit,
        }));
        return;
      }
      if (req.method === 'POST' && sub === '/shares') {
        const body = await readBody(req);
        // Same rewrite as /agent-credentials: a loopback apiOrigin is the
        // page's own origin (a dev server, or this sidecar's proxy) — the
        // share must call the real cloud, or its REST half (poll, deletes,
        // creates) dies whenever that local server does.
        if (remoteOrigin && typeof body.apiOrigin === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(body.apiOrigin.trim().replace(/\/$/, ''))) {
          body.apiOrigin = remoteOrigin;
        }
        const share = await bridges.createShare(project.id, body);
        emit(project.id, { type: 'shares-changed' });
        json(res, 200, { ok: true, share });
        return;
      }
      if (req.method === 'DELETE' && /^\/shares\/[^/]+$/.test(sub)) {
        await bridges.removeShare(project.id, sub.split('/')[2]);
        emit(project.id, { type: 'shares-changed' });
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && /^\/shares\/[^/]+\/token$/.test(sub)) {
        // Cloud sync tokens expire after 7 days; the app re-mints one whenever
        // it opens a shared project and hands it here.
        const body = await readBody(req);
        bridges.refreshShareToken(project.id, sub.split('/')[2], String(body.token || ''));
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { ok: false, error: 'not found' });
    })().catch((error) => {
      json(res, error?.status || 500, { ok: false, error: error?.message || 'internal error' });
    });
  });

  server.on('upgrade', (request, socket, head) => {
    docHost.server.webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      docHost.hocuspocus.handleConnection(ws, request);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actualPort = server.address().port;
  boundPort = actualPort;
  log(`listening on 127.0.0.1:${actualPort}${remoteOrigin ? ` (proxying ${remoteOrigin})` : ''}`);

  // Now that the port is up (the shell's readiness probe), resume cloud share
  // bridges in the background; requests never depended on it having finished.
  // The live-edit horizon is watcher activation, not bind (see above).
  const bridgesResumed = bridges
    .resumeAll({ interactiveSince: watchersActiveAt })
    .catch((error) => log(`bridge resume failed error=${error?.message}`));

  const close = async () => {
    await docHost.flushAll();
    await bridges.stopAll();
    for (const watcher of watchers.values()) watcher.close();
    for (const clients of sseClients.values()) for (const res of clients) res.end();
    // Destroy Hocuspocus BEFORE closing the store: closing connections fires
    // async onStoreDocument hooks, which must not hit a closed database.
    await docHost.server.destroy().catch(() => {});
    await new Promise((resolve) => server.close(() => resolve()));
    // stopAll() above cancelled the background resume loop, so this joins at
    // most ONE in-flight engine.start() — after the port is already released
    // (shutdown stays fast) but before the store closes under it.
    await bridgesResumed;
    store.close();
  };

  return { server, store, docHost, agentHost, bridges, bridgesResumed, watchers, token, port: actualPort, home, close };
}

// fileURLToPath, not URL.pathname: a packaged install can live under a path
// with spaces/non-ASCII, which pathname percent-encodes and never matches.
// realpathSync: Node resolves the entry module through symlinks (macOS /tmp,
// /var), so argv[1] must be resolved the same way or they never match.
const argvPath = (() => {
  if (!process.argv[1]) return null;
  const resolved = path.resolve(process.argv[1]);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
})();
const isMain = argvPath === fileURLToPath(import.meta.url);
if (isMain) {
  // Node's default handling would crash with the stack on stderr only — a
  // Finder-launched app has no stderr, so mirror it into sidecar.log first.
  const fatal = (kind) => (error) => {
    try {
      fs.appendFileSync(
        path.join(defaultHome(), 'sidecar.log'),
        `${new Date().toISOString()} [fatal] ${kind}: ${error?.stack || error}\n`,
      );
    } catch { /* home unwritable */ }
    console.error(`[sundial-local] ${kind}:`, error);
    process.exit(1);
  };
  process.on('uncaughtException', fatal('uncaughtException'));
  process.on('unhandledRejection', fatal('unhandledRejection'));
  const boot = () => startLocalServer({ exitOnShutdown: true });
  const handle = await boot().catch(async (error) => {
    if (error?.code !== 'EADDRINUSE') throw error;
    // An earlier instance (e.g. a previous shell launch) is already serving.
    // Same install → same token file, so that instance works for us too:
    // defer to it instead of crash-splatting into the shell's console. But
    // only if OUR token actually works there — deferring to a foreign
    // instance (stale checkout, other install) leaves the app permanently
    // unauthorized against a "healthy" sidecar.
    const port = Number(process.env.SUNDIAL_LOCAL_PORT || 4848);
    const fail = (message) => {
      console.error(`[sundial-local] ${message}`);
      // Packaged installs have no visible stdout — mirror into sidecar.log so
      // a port collision is diagnosable (/local otherwise just "isn't responding").
      try { fs.appendFileSync(path.join(defaultHome(), 'sidecar.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* home unwritable */ }
      process.exit(1);
    };
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json()).catch(() => null);
    if (health?.service === 'sundial-local') {
      // Derive our token exactly like startLocalServer: env override, else the
      // per-install token file. No readable token means the listener cannot be
      // this install — a same-install instance would have written the file.
      let ourToken = (process.env.SUNDIAL_LOCAL_TOKEN || '').trim();
      if (!ourToken) {
        try { ourToken = fs.readFileSync(path.join(defaultHome(), 'token'), 'utf8').trim(); } catch { /* no token file */ }
      }
      const authorized = ourToken
        ? await fetch(`http://127.0.0.1:${port}/projects`, { headers: { Authorization: `Bearer ${ourToken}` } })
            .then((res) => res.ok)
            .catch(() => false)
        : false;
      if (authorized) {
        // Deferring is only safe when the listener serves the SAME deployment:
        // a same-version sidecar proxying another cloud (a staging build's
        // leftover) would strand this app on the wrong env — the webview
        // proxies whatever the listener points at. Older instances don't
        // report remoteOrigin (undefined) — treat as mismatch and replace.
        const ourRemoteOrigin = (process.env.SUNDIAL_REMOTE_ORIGIN || '').trim().replace(/\/$/, '');
        const sameDeployment = String(health.remoteOrigin ?? '\0') === ourRemoteOrigin;
        if ((health.apiVersion ?? 1) >= SIDECAR_API_VERSION && sameDeployment) {
          console.log(`[sundial-local] another instance already serves 127.0.0.1:${port}; deferring to it`);
          process.exit(0);
        }
        // Same install but OLDER code (it lacks endpoints the app depends on;
        // deferring is how "unknown project" reached the create dialog) or a
        // DIFFERENT deployment — replace it: ask politely (newer instances
        // expose /shutdown), then SIGTERM the listener — TERM runs its
        // flush-and-exit handler, so nothing is lost.
        console.log(
          sameDeployment
            ? `[sundial-local] outdated instance (apiVersion ${health.apiVersion ?? 1} < ${SIDECAR_API_VERSION}) on port ${port}; replacing it`
            : `[sundial-local] instance on port ${port} proxies "${health.remoteOrigin ?? 'unknown'}" but we need "${ourRemoteOrigin}"; replacing it`,
        );
        await fetch(`http://127.0.0.1:${port}/shutdown`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ourToken}` },
        }).catch(() => null);
        if (process.platform !== 'win32') {
          try {
            const { execFileSync } = await import('node:child_process');
            // -sTCP:LISTEN is load-bearing: without it lsof also lists CLIENTS
            // of the port (the shell, the webview, a test runner) and we'd
            // SIGTERM them along with the listener.
            const pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
              .split('\n')
              .map((pid) => Number(pid.trim()))
              .filter((pid) => pid && pid !== process.pid);
            for (const pid of pids) {
              try { process.kill(pid, 'SIGTERM'); } catch { /* raced its own exit */ }
            }
          } catch { /* already gone, or no lsof — the retry loop decides */ }
        }
        for (let attempt = 0; attempt < 25; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          try {
            return await boot();
          } catch (retryError) {
            if (retryError?.code !== 'EADDRINUSE') throw retryError;
          }
        }
        fail(`could not replace the outdated instance on port ${port} — quit the other Sundial and relaunch`);
      }
      fail(`an instance on 127.0.0.1:${port} rejects our token (foreign install?) — quit it or free the port`);
    }
    fail(`port ${port} is taken by something else — local projects unavailable`);
  });
  if (process.argv.includes('--print-token')) console.log(`token: ${handle.token}`);
  const shutdown = async (signal) => {
    console.log(`[sundial-local] ${signal}; flushing`);
    await handle.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
