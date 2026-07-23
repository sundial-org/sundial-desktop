import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness.js';

import { Y } from '../lib/crdt-js/markdown_yjs.mjs';
import { applyContentTextIfChanged, readDocumentText } from '../lib/crdt-js/document_text.mjs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { fileKind, isIgnoredPath, mimeFor, resolveInRoot } from './paths.mjs';
import { inExtraRoot } from './roots.mjs';
import { syncShareLedger } from './ledger-sync.mjs';
import { Readable } from 'node:stream';
import { deleteFile, readTextFile, walkProject, writeBlobStreamAtomic, writeTextFileAtomic } from './disk.mjs';
import { BRIDGE_ORIGIN } from './doc-host.mjs';
const MAX_BRIDGED_FILES = 500;
const CLOUD_POLL_MS = Number(process.env.SUNDIAL_BRIDGE_POLL_MS || 10_000);
// Blobs sync whole-file (sha-diffed, no CRDT) — bound the transfer size.
// Local writes themselves are uncapped; this bounds only what crosses the
// bridge (an oversized file logs a skip and simply stays local-only).
const BLOB_SYNC_MAX_BYTES = Number(process.env.SUNDIAL_BRIDGE_BLOB_MAX_BYTES || 50 * 1024 * 1024);
// TUS PATCH chunk: 6 MiB matches the browser uploader (direct-upload.ts) —
// Supabase's TUS rejects smaller NON-final chunks (S3 multipart min part),
// and this size is proven to pass the Next proxy in production.
const BLOB_UPLOAD_CHUNK_BYTES = Number(process.env.SUNDIAL_BRIDGE_BLOB_CHUNK_BYTES || 6 * 1024 * 1024);
// A bridge holds two live Y.Docs, so memory must track the WORKING SET, not
// the tree size: idle bridges close once their cloud row is confirmed, and
// reopen on local edits, a local editor connecting, or a cloud updated_at
// change seen by the poll.
const BRIDGE_IDLE_MS = Number(process.env.SUNDIAL_BRIDGE_IDLE_MS || 60_000);

/** Live two-way sync of one local file with its cloud workspace doc.
 *
 *  Both sides are Y.Docs of identical schema. Bootstrapping is safe because
 *  every text seed in the system is deterministic (identical bytes → identical
 *  ops), and once the pair has exchanged state they share history, so every
 *  later reconnect is a plain CRDT merge — offline edits on either side
 *  converge without loss. On the FIRST sync of a file whose two sides diverge,
 *  the local disk version wins (the file is being shared FROM the machine). */
class FileBridge {
  constructor({ engine, localRel, cloudPath }) {
    this.engine = engine;
    this.localRel = localRel;
    this.cloudPath = cloudPath;
    this.localDocName = `${engine.project.id}/${localRel}`;
    this.cloudDocName = `${engine.share.workspace_id}/${cloudPath}`;
    this.direct = null;
    this.provider = null;
    this.cloudDoc = null;
    this.cloudSeen = false; // file confirmed present in the cloud listing
    this.stopped = false;
    this.cancelSyncWait = null; // settles a pending waitForSync at stop()
    this.lastActivity = Date.now();
    this.onLocalUpdate = null;
    this.onCloudUpdate = null;
    this.onLocalAwareness = null;
    this.onCloudAwareness = null;
    this.relayedToLocal = new Set(); // cloud client ids mirrored into the local doc
    this.relayedToCloud = new Set(); // local client ids mirrored into the cloud doc
  }

  async start() {
    const { docHost, share, store, log } = this.engine;
    this.direct = await docHost.hocuspocus.openDirectConnection(this.localDocName, {
      actor: 'remote',
      userId: 'cloud-bridge',
    });
    const localDoc = this.direct.document;
    // "Local wins" only applies when a local FILE exists — an empty string is
    // ambiguous between "intentionally empty file" (local wins, even empty)
    // and "no file yet" (a cloud-created file being pulled; cloud wins).
    const localAbs = resolveInRoot(this.engine.project.root, this.localRel);
    const localExists = localAbs ? Boolean(await fsp.stat(localAbs).catch(() => null)) : false;

    // stop() during the awaits above found nothing to tear down (provider and
    // sync waiter don't exist yet) — bail before creating them, or a stopped
    // bridge would open a fresh socket and sit out the full 30s sync wait.
    // The throw routes cleanup through the caller's bridge.stop().
    if (this.stopped) throw Object.assign(new Error(`bridge stopped during start doc=${this.cloudDocName}`), { bridgeStopped: true });

    this.cloudDoc = new Y.Doc();
    this.provider = new HocuspocusProvider({
      websocketProvider: this.engine.ensureSocket(),
      name: this.cloudDocName,
      document: this.cloudDoc,
      // Getter, not a snapshot: a 7-day token re-minted mid-session must be
      // what re-auth on reconnect sends, or every live doc goes dark at TTL.
      token: () => this.engine.share.token,
    });
    this.provider.attach();
    await this.waitForSync();
    if (this.stopped) return;

    // Snapshot both sides HERE, in the same synchronous task as the exchange
    // and the divergence reassert below. Reading localTextBefore any earlier
    // (e.g. before waitForSync) makes the reassert apply a seconds-stale
    // snapshot over a doc the user is actively typing in — deleting the
    // keystrokes that landed during the cloud sync (the turbosundial
    // "first two words disappeared" incident).
    const localTextBefore = readDocumentText(this.localRel, localDoc);
    const cloudTextBefore = readDocumentText(this.cloudPath, this.cloudDoc);
    const firstTime = !store.hasBridgeFile(share.id, this.localRel);

    // Exchange full state both ways (missing-op diffs; shared ops dedupe).
    Y.applyUpdate(this.cloudDoc, Y.encodeStateAsUpdate(localDoc, Y.encodeStateVector(this.cloudDoc)), BRIDGE_ORIGIN);
    Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(this.cloudDoc, Y.encodeStateVector(localDoc)), BRIDGE_ORIGIN);

    this.onLocalUpdate = (update, origin) => {
      if (origin === BRIDGE_ORIGIN || this.stopped) return;
      this.lastActivity = Date.now();
      Y.applyUpdate(this.cloudDoc, update, BRIDGE_ORIGIN);
    };
    this.onCloudUpdate = (update, origin) => {
      if (origin === BRIDGE_ORIGIN || this.stopped) return;
      this.lastActivity = Date.now();
      Y.applyUpdate(localDoc, update, BRIDGE_ORIGIN);
      // Attribute the disk writeback of cloud edits to the remote side (the
      // Hocuspocus onChange for a non-connection origin carries no context).
      docHost.schedulePersist(this.localDocName, localDoc, { actor: 'remote', userId: 'cloud-bridge' });
    };
    localDoc.on('update', this.onLocalUpdate);
    this.cloudDoc.on('update', this.onCloudUpdate);

    // Live cursors: relay awareness (presence + selections) between the local
    // doc's clients (desktop editors on the sidecar server) and the cloud
    // workspace's peers. Both docs share CRDT history, so the relative
    // positions inside cursor states decode on either side. Same echo rule as
    // doc updates: BRIDGE_ORIGIN applies are never re-relayed; y-protocols'
    // clock check makes the providers' unconditional re-sends idempotent.
    const localAwareness = this.direct.document.awareness;
    const cloudAwareness = this.provider.awareness;
    const relayAwareness = (from, to, tracked) => (changed, origin) => {
      if (origin === BRIDGE_ORIGIN || this.stopped) return;
      const clients = changed.added
        .concat(changed.updated, changed.removed)
        // Own (null) state never relays; encoding needs the client's meta
        // clock, which the periodic awareness GC can have dropped already.
        .filter((id) => id !== from.clientID && from.meta.has(id));
      if (clients.length === 0) return;
      changed.removed.forEach((id) => tracked.delete(id));
      clients.forEach((id) => { if (!changed.removed.includes(id)) tracked.add(id); });
      awarenessProtocol.applyAwarenessUpdate(
        to,
        awarenessProtocol.encodeAwarenessUpdate(from, clients),
        BRIDGE_ORIGIN,
      );
    };
    this.onLocalAwareness = relayAwareness(localAwareness, cloudAwareness, this.relayedToCloud);
    this.onCloudAwareness = relayAwareness(cloudAwareness, localAwareness, this.relayedToLocal);
    localAwareness.on('update', this.onLocalAwareness);
    cloudAwareness.on('update', this.onCloudAwareness);
    // States that existed before the listeners attached (an editor already
    // open locally; cloud peers whose states arrived during waitForSync).
    for (const [from, handler] of [[localAwareness, this.onLocalAwareness], [cloudAwareness, this.onCloudAwareness]]) {
      const present = Array.from(from.getStates().keys());
      if (present.length) handler({ added: present, updated: [], removed: [] }, null);
    }

    if (!localExists && cloudTextBefore === '') {
      // An empty CLOUD file produces no updates either — materialize it on
      // disk explicitly or it never appears locally. The doc loaded without a
      // disk twin — now that one exists, delete events are live again.
      await writeTextFileAtomic(this.engine.project.root, this.localRel, '').catch(() => {});
      docHost.loadedWithoutDisk.delete(this.localDocName);
      this.engine.manager.emitFilesChanged(this.engine.project.id, this.localRel);
    }

    if (firstTime && localExists && cloudTextBefore !== '' && cloudTextBefore !== localTextBefore) {
      // Divergent histories with no common base merge into an interleaving —
      // reassert the local text on the merged base and the pair converges to
      // the disk version. Runs AFTER the relays attach (no origin on the
      // transaction, so it flows through onLocalUpdate to the cloud side).
      // Gated on a NON-EMPTY cloud side: against an empty cloud doc the
      // exchange alone already yields the local content, and the "reassert"
      // would just destructively rewrite (block delete+reinsert) a doc the
      // user may be typing in.
      applyContentTextIfChanged(this.localRel, localDoc, localTextBefore);
    } else if (firstTime && localExists && localTextBefore === '' && cloudTextBefore === '') {
      // An intentionally EMPTY local file produces no Yjs updates, so the
      // cloud side never persists and no files row is created — collaborators
      // wouldn't see `__init__.py`-style files at all. Create the row
      // explicitly; only a successful create marks the file as synced,
      // otherwise a later resume would read the missing cloud row as a remote
      // delete. The content is re-read from disk AT EXECUTION TIME, never
      // captured: a failed create queues for retry, and a retry minutes later
      // must send whatever the file holds by then — a captured '' PUT over
      // since-typed content is how Recent.md got wiped on every surface.
      const createCloudTwin = async () => {
        const disk = await readTextFile(this.engine.project.root, this.localRel).catch(() => null);
        const content =
          this.engine.docHost.getLiveText(this.engine.project.id, this.localRel) ?? disk?.text ?? '';
        const res = await this.engine.cloudFetch('/api/workspace/local-agent/file', {
          method: 'PUT',
          body: JSON.stringify({
            workspaceId: share.workspace_id,
            path: this.cloudPath,
            content,
            editMode: 'edit',
          }),
        });
        if (!res.ok) throw new Error(`empty-file cloud create failed status=${res.status}`);
        store.markBridgeFile(share.id, this.localRel);
      };
      try {
        await createCloudTwin();
      } catch {
        this.engine.queueCloudOp(`create ${this.cloudPath}`, createCloudTwin);
      }
      log(`bridge up file=${this.localRel} cloud=${this.cloudDocName}`);
      docHost.schedulePersist(this.localDocName, localDoc, { actor: 'remote', userId: 'cloud-bridge' });
      return;
    }
    store.markBridgeFile(share.id, this.localRel);

    // Flush the merged state to disk + let the cloud persist its side.
    docHost.schedulePersist(this.localDocName, localDoc, { actor: 'remote', userId: 'cloud-bridge' });
    log(`bridge up file=${this.localRel} cloud=${this.cloudDocName}`);
  }

  waitForSync() {
    if (this.provider.synced) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`cloud sync timeout doc=${this.cloudDocName}`));
      }, 30_000);
      const onSynced = () => {
        cleanup();
        resolve();
      };
      const onAuthFailed = ({ reason }) => {
        cleanup();
        reject(new Error(`cloud auth failed: ${reason}`));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.provider.off('synced', onSynced);
        this.provider.off('authenticationFailed', onAuthFailed);
        this.cancelSyncWait = null;
      };
      // stop() must not wait out the 30s timer (shutdown joins the resume
      // that may be sitting right here on an unreachable collab socket).
      this.cancelSyncWait = () => {
        cleanup();
        reject(Object.assign(new Error(`bridge stopped during sync doc=${this.cloudDocName}`), { bridgeStopped: true }));
      };
      this.provider.on('synced', onSynced);
      this.provider.on('authenticationFailed', onAuthFailed);
    });
  }

  async stop() {
    this.stopped = true;
    this.cancelSyncWait?.();
    if (this.onLocalUpdate && this.direct?.document) this.direct.document.off('update', this.onLocalUpdate);
    if (this.onCloudUpdate && this.cloudDoc) this.cloudDoc.off('update', this.onCloudUpdate);
    try {
      const localAwareness = this.direct?.document?.awareness;
      const cloudAwareness = this.provider?.awareness;
      if (this.onLocalAwareness && localAwareness) localAwareness.off('update', this.onLocalAwareness);
      if (this.onCloudAwareness && cloudAwareness) cloudAwareness.off('update', this.onCloudAwareness);
      // Ghost cursors must not outlive the relay on either side.
      if (localAwareness && this.relayedToLocal.size) {
        awarenessProtocol.removeAwarenessStates(localAwareness, [...this.relayedToLocal], BRIDGE_ORIGIN);
      }
      if (cloudAwareness && this.relayedToCloud.size) {
        awarenessProtocol.removeAwarenessStates(cloudAwareness, [...this.relayedToCloud], BRIDGE_ORIGIN);
      }
    } catch { /* awareness may already be torn down */ }
    try {
      this.provider?.detach();
      this.provider?.destroy();
    } catch { /* socket may already be gone */ }
    this.cloudDoc?.destroy();
    await this.direct?.disconnect().catch(() => {});
  }
}

/** One share = one cloud workspace synced with one scope (project root, a
 *  subfolder, or a single file) of a local project. Granular permissions fall
 *  out of this shape: only paths inside the scope are ever bridged, and who
 *  can see them is the cloud workspace's own member/invite ACL. */
class ShareEngine {
  constructor({ manager, share, project, resumeHorizon }) {
    this.manager = manager;
    this.share = share;
    this.project = project;
    // Edits with mtime AFTER this are live work the resume window couldn't
    // have processed — reconciliation rescues them from offline cloud-deletes.
    // Startup engines share the watchers-active stamp (edits can land before
    // a late engine exists); engines constructed mid-session (scope-follow
    // restart, new share) start their horizon NOW — older edits were made
    // under a live engine whose delete rails already had their chance.
    this.resumeHorizon = resumeHorizon ?? Date.now();
    this.docHost = manager.docHost;
    this.store = manager.store;
    this.log = manager.log;
    this.bridges = new Map(); // localRel -> FileBridge
    this.socket = null;
    this.pollTimer = null;
    this.status = 'starting';
    this.error = null;
    this.stopped = false;
    // Aborts in-flight cloud fetches at stop(): a hung listing request must
    // not strand the background resume — and with it, shutdown's join on it.
    this.stopAbort = new AbortController();
    // Cloud mutations (deletes/moves) that failed transiently. The share is
    // PARKED while any are pending — otherwise the poller would see the
    // still-present cloud path and pull the user's deleted/renamed file back.
    // Each poll retries them; the share revives when the queue drains.
    this.pendingCloudOps = [];
    this.opsParked = false;
    // start() runs in the background after the server binds, so editor-open /
    // watcher events can race its offline-delete reconciliation. Until that
    // finishes, previously-synced files must NOT open bridges (a bridge would
    // push local state and resurrect a cloud-deleted file) — they queue here
    // and replay after reconciliation. Never-synced files bridge immediately.
    // Armed from construction: resumeAll registers engines before starting
    // them, so events can reach an engine whose start() hasn't run yet.
    this.resuming = true;
    this.pendingResumeOpens = new Set();
    // localRel → cloud updated_at recorded when an idle bridge closed; a
    // different stamp on a later poll means cloud-side edits → reopen.
    this.syncedStamps = new Map();
    this.lastCloudListing = null; // most recent fetchCloudPaths result
    this.blobBusy = new Set(); // localRel with a blob sync in flight
    // Blob syncs that failed (or arrived before any cloud listing) — each
    // poll retries them; syncBlob no-ops once both sides agree.
    this.pendingBlobSyncs = new Set();
    this.loggedBlobSkips = new Set(); // oversized paths already warned about
    // localRel → cloud sha ('' = legacy no-sha row) refused as oversized, so
    // the 10s poll doesn't re-download the same huge blob forever. A new
    // cloud version (different sha) clears naturally by failing the compare.
    this.skippedBlobDownloads = new Map();
  }

  scopeContains(rel) {
    const scope = this.share.scope_path;
    if (!scope) return true;
    if (this.share.scope_kind === 'file') return rel === scope;
    return rel === scope || rel.startsWith(`${scope}/`);
  }

  localToCloud(rel) {
    const scope = this.share.scope_path;
    if (!scope) return rel;
    if (this.share.scope_kind === 'file') return rel.split('/').pop();
    return rel.slice(scope.length + 1);
  }

  cloudToLocal(cloudPath) {
    const scope = this.share.scope_path;
    if (!scope) return cloudPath;
    if (this.share.scope_kind === 'file') return scope;
    return `${scope}/${cloudPath}`;
  }

  /** The shared cloud socket exists only while bridges are open: an idle
   *  provider-less Hocuspocus socket cycles through message-reconnect
   *  timeouts, growing its retry backoff — a bridge reopening mid-backoff
   *  would then wait ~30s for the next attempt. Fresh socket = instant. */
  ensureSocket() {
    this.socket ??= new HocuspocusProviderWebsocket({
      url: this.share.collab_url,
      WebSocketPolyfill: WebSocket,
    });
    return this.socket;
  }

  async start() {
    if (!this.share.collab_url || !this.share.token) {
      this.status = 'error';
      this.error = 'share is missing collab_url or token';
      return;
    }
    // (`resuming` is already armed — the constructor sets it, and every
    // engine is constructed fresh immediately before its one start().)
    // Blobs ride along for delete-reconciliation (a synced blob absent from
    // this walk must read as a local delete, not get pulled back) and are
    // queued for sha-diffed sync below; only text files open CRDT bridges.
    const local = (await walkProject(this.project.root)).filter(
      (file) => (file.type === 'text' || file.type === 'blob') && this.scopeContains(file.path),
    );
    // Reconcile cloud-side deletes that happened while this sidecar was
    // offline BEFORE opening bridges: a previously-synced file (bridge_files
    // row) now absent from the cloud listing was deleted remotely — bridging
    // it first would push the stale local state back and resurrect it. If the
    // listing is unavailable (transient outage), DEFER previously-synced
    // files to the first successful poll instead of bridging blind; files
    // never synced before are always safe to bridge.
    const cloudPaths = await this.fetchCloudPaths().catch((error) => {
      this.noteError('cloud-list', error);
      return null;
    });
    // stop() can land while the listing was in flight — a stopped engine
    // must not run the destructive reconciliation below during shutdown.
    if (this.stopped) return;
    let toBridge;
    if (cloudPaths) {
      toBridge = await this.reconcileOfflineDeletes(local, cloudPaths);
      // The symmetric case: a previously-synced file deleted/renamed ON DISK
      // while the sidecar was stopped. Without this, the first poll would see
      // its cloud twin as a "new cloud file" and pull it back, undoing the
      // user's offline delete — propagate the delete instead.
      const localSet = new Set(local.map((file) => file.path));
      for (const rel of this.store.listBridgeFiles(this.share.id)) {
        if (this.stopped) return; // shutdown mid-loop: no cloud deletes on a stopped engine
        if (localSet.has(rel) || !this.scopeContains(rel)) continue;
        // The walk is a snapshot: a file created and event-bridged while the
        // listing fetch was in flight has a fresh row but isn't in localSet.
        // "Offline local delete" means absent from disk NOW — re-stat before
        // condemning, or this sweep would delete the just-created file.
        const abs = resolveInRoot(this.project.root, rel);
        const existsNow = abs ? await fsp.stat(abs).then((stat) => stat.isFile()).catch(() => false) : false;
        if (existsNow) continue;
        if (cloudPaths.all.has(this.localToCloud(rel))) {
          const cloudPath = this.localToCloud(rel);
          const run = async () => {
            await this.cloudDelete(cloudPath);
            this.store.forgetBridgeFile(this.share.id, rel);
          };
          try {
            await run();
            this.log(`bridge offline local-delete file=${rel}`);
          } catch {
            this.queueCloudOp(`delete ${cloudPath}`, run);
          }
        } else {
          this.store.forgetBridgeFile(this.share.id, rel); // gone on both sides
        }
      }
    } else {
      toBridge = local.filter((file) => !this.store.hasBridgeFile(this.share.id, file.path));
      this.deferredResume = local.filter((file) => this.store.hasBridgeFile(this.share.id, file.path));
    }
    // Reconciliation done — replay files queued while it ran (editor-opens
    // and rescued cloud-deletes). With no cloud listing there was NO
    // reconciliation: stay in `resuming` so previously-synced opens keep
    // queueing instead of bridging blind (a cloud-deleted file would be
    // pushed back); the deferred pass in pollCloud() reconciles, drains,
    // and lifts the latch on the first successful listing.
    if (cloudPaths) {
      this.resuming = false;
      await this.drainPendingResumeOpens();
    }
    await this.bridgeAll(toBridge);
    await this.pollCloud().catch((error) => this.noteError('cloud-poll', error));
    // stop() can land while the awaits above are in flight (background resume
    // cancelled at shutdown) — a stopped engine must not arm a poll interval
    // that would outlive close() and keep the process alive.
    if (this.stopped) return;
    this.pollTimer = setInterval(() => {
      void this.pollCloud().catch((error) => this.noteError('cloud-poll', error));
    }, CLOUD_POLL_MS);
    if (this.status !== 'error') this.status = 'active';
  }

  /** Bounded concurrency: files are independent, and serial waitForSync would
   *  make a large first share take minutes. Blob paths route to the sha-diffed
   *  transfer instead of a CRDT bridge. */
  async bridgeAll(files) {
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(
        files.slice(i, i + 8).map(async (file) => {
          // The list can be a stale snapshot (resume runs in the background
          // after the port binds) — a file deleted since the walk must not
          // be bridged: the delete rails own it, and a bridge would push it
          // back to the cloud as a fresh doc.
          const abs = resolveInRoot(this.project.root, file.path);
          const exists = abs ? await fsp.stat(abs).then((stat) => stat.isFile()).catch(() => false) : false;
          if (!exists) return;
          // Blobs get the first-sync snapshot's sha explicitly — syncBlob's
          // undefined fallback fetches a fresh listing PER PATH, which a
          // large first share must not do.
          await (fileKind(file.path) === 'blob'
            ? this.syncBlob(file.path, this.cachedCloudSha(file.path))
            : this.ensureBridge(file.path)
          ).catch((error) => this.noteError(file.path, error));
        }),
      );
    }
  }

  /** Cloud sha for a path from the current listing snapshot ('' = row without
   *  a sha, null = absent, undefined = no snapshot yet). */
  cachedCloudSha(localRel) {
    const listing = this.lastCloudListing;
    if (!listing) return undefined;
    const cloudPath = this.localToCloud(localRel);
    return listing.blobShas.get(cloudPath) ?? (listing.all.has(cloudPath) ? '' : null);
  }

  /** Drop local files whose cloud twin vanished while we were offline; returns
   *  the files that should still be bridged. */
  async reconcileOfflineDeletes(files, cloudPaths) {
    const kept = [];
    for (const file of files) {
      if (this.stopped) return kept; // shutdown mid-loop: no deletes on a stopped engine
      const previouslySynced = this.store.hasBridgeFile(this.share.id, file.path);
      if (!previouslySynced || cloudPaths.all.has(this.localToCloud(file.path))) {
        kept.push(file);
        continue;
      }
      if (this.share.scope_kind === 'file') {
        this.status = 'error';
        this.error = `cloud file "${this.localToCloud(file.path)}" was removed or renamed — sharing stopped, local file kept`;
        this.manager.emitSharesChanged(this.project.id);
        continue;
      }
      // Resume runs in the background AFTER the server binds, so the app is
      // already interactive: if the user edited this file since the startup
      // walk, or has it open in an editor right now, the offline cloud-delete
      // must not destroy live work. Keep the local copy; if its open queued a
      // bridge during resume, the replay in start() re-shares it (local wins),
      // otherwise it stays a plain local file until the next edit event.
      const statNow = await fsp.stat(resolveInRoot(this.project.root, file.path)).catch(() => null);
      // Measured against the moment the SERVER became interactive, not this
      // engine's walk: shares resume sequentially, so an edit can land before
      // a late engine exists. Strictly after — no slack: mtime and Date.now()
      // come from the same clock, and slack would misread a file written just
      // before a quick quit-and-relaunch as a live edit.
      const editedSinceInteractive = Boolean(statNow && statNow.mtimeMs > this.resumeHorizon);
      const openInEditor = this.docHost.connectionCount(`${this.project.id}/${file.path}`) > 0;
      // An edit/open event that landed while this loop awaited queued the
      // path for replay (or opened a bridge) — a rescue signal the stat
      // snapshot can miss: deleting now would erase the edit, and the drain
      // would skip the then-missing file.
      const queuedMeanwhile = this.pendingResumeOpens.has(file.path) || this.bridges.has(file.path);
      if (editedSinceInteractive || openInEditor || queuedMeanwhile) {
        // An editor-open event during the resume window may already have
        // opened a live bridge for this path — drop it too, or it would keep
        // relaying before reconciliation finishes.
        await this.dropBridge(file.path).catch(() => {});
        this.store.forgetBridgeFile(this.share.id, file.path);
        // Queue it for the post-reconciliation replay: the live edit wins and
        // the file re-shares. Without this, an edit made before this engine
        // existed had no event to re-bridge it and silently went unshared.
        this.pendingResumeOpens.add(file.path);
        this.log(
          `bridge offline cloud-delete skipped (local file ${openInEditor ? 'open in editor' : 'edited since startup'}, re-sharing) file=${file.path}`,
        );
        continue;
      }
      this.store.forgetBridgeFile(this.share.id, file.path);
      await deleteFile(this.project.root, file.path).catch(() => {});
      // Record the cloud-delete tombstone BEFORE the disk-change sweep so the
      // doc host's own tombstone guard sees it and doesn't double-record.
      this.store.recordEdit({ projectId: this.project.id, path: file.path, actor: 'remote', contentText: null });
      await this.docHost.handleDiskChange(this.project.id, file.path).catch(() => {});
      this.manager.emitFilesChanged(this.project.id, file.path);
      this.log(`bridge offline cloud-delete file=${file.path}`);
    }
    return kept;
  }

  noteError(where, error) {
    // A bridge torn down mid-start (rescue drop, rename, shutdown) throws on
    // purpose — that's teardown, not a sync failure the UI should flash.
    if (this.stopped || error?.bridgeStopped) return;
    const hadError = Boolean(this.error);
    this.error = `${where}: ${error?.message || error}`;
    this.log(`share ${this.share.id} ${this.error}`);
    if (/auth|401|403/i.test(String(error?.message))) {
      this.status = 'error';
      this.authError = true;
    }
    // Sync health is trust-critical UI (the user believes edits are syncing) —
    // push EVERY first error (auth park or not) instead of waiting for a
    // share create/remove to refetch.
    if (!hadError) this.manager.emitSharesChanged(this.project.id);
  }

  async ensureBridge(localRel) {
    // A parked share ('error': rejected token, or a file-share whose cloud
    // path vanished) must not silently resurrect bridges — a fresh token or
    // re-share resets the status.
    if (this.stopped || this.status === 'error' || this.bridges.has(localRel)) return;
    if (!this.scopeContains(localRel) || isIgnoredPath(localRel) || fileKind(localRel) !== 'text') return;
    // Mid-resume, a previously-synced file may be a cloud-delete awaiting
    // reconciliation — bridging it now would push local state and resurrect
    // it. Queue instead; start() replays survivors. New files bridge freely.
    if (this.resuming && this.store.hasBridgeFile(this.share.id, localRel)) {
      this.pendingResumeOpens.add(localRel);
      return;
    }
    if (this.bridges.size >= MAX_BRIDGED_FILES && !(await this.closeIdlestBridge())) {
      this.noteError(localRel, new Error(`open bridge cap (${MAX_BRIDGED_FILES}) reached`));
      return;
    }
    const bridge = new FileBridge({
      engine: this,
      localRel,
      cloudPath: this.localToCloud(localRel),
    });
    this.bridges.set(localRel, bridge);
    try {
      await bridge.start();
    } catch (error) {
      this.bridges.delete(localRel);
      await bridge.stop().catch(() => {});
      throw error;
    }
    if (this.lastCloudListing?.all.has(bridge.cloudPath)) bridge.cloudSeen = true;
  }

  /** Re-share files rescued from an offline cloud-delete or opened during
   *  resume: skip anything reconciliation deleted; text reopens a bridge,
   *  blobs go through sha-diffed sync (their forgotten row + absent cloud
   *  twin reads as a fresh local blob → upload, i.e. local wins). Runs after
   *  ANY reconciliation pass — start()'s, or the deferred one in pollCloud. */
  async drainPendingResumeOpens() {
    const pending = [...this.pendingResumeOpens];
    this.pendingResumeOpens.clear();
    for (const rel of pending) {
      if (this.stopped) return;
      const abs = resolveInRoot(this.project.root, rel);
      const exists = abs ? await fsp.stat(abs).then((stat) => stat.isFile()).catch(() => false) : false;
      if (!exists) continue;
      if (this.isBlobPath(rel)) {
        await this.syncBlob(rel).catch((error) => this.noteError(rel, error));
      } else {
        // A rescued file has no bridge row and no cloud row — dropping it
        // here would orphan it (nothing else retries it). ensureBridge can
        // fail with a throw OR decline silently (parked share, bridge cap):
        // requeue unless a bridge actually opened; pollCloud re-drains once
        // per poll until it sticks.
        await this.ensureBridge(rel).catch((error) => this.noteError(rel, error));
        // Requeue only what ensureBridge could EVER accept (mirror its gates,
        // fileKind included) — a permanently-declined rel would retry forever.
        if (!this.stopped && !this.bridges.has(rel) && this.scopeContains(rel) && !isIgnoredPath(rel) && fileKind(rel) === 'text') {
          this.pendingResumeOpens.add(rel);
        }
      }
    }
  }

  /** A bridge may close only when losing it can't lose data or misread state:
   *  first sync done (bridge_files row), cloud row confirmed in a listing —
   *  otherwise its later absence would read as a cloud delete — and no local
   *  editor holds the doc open (live typing must relay instantly). */
  closableStamp(localRel, bridge) {
    if (!bridge.cloudSeen || !this.store.hasBridgeFile(this.share.id, localRel)) return null;
    if ((bridge.direct?.document?.connections?.size ?? 0) > 0) return null;
    return this.lastCloudListing?.stamps.get(bridge.cloudPath) ?? null;
  }

  async closeBridgeKeepingSynced(localRel, stamp) {
    this.syncedStamps.set(localRel, stamp);
    await this.dropBridge(localRel);
  }

  /** Cap relief during large first shares: close the least-recently-active
   *  closable bridge (refreshing the listing so just-persisted cloud rows
   *  qualify) instead of erroring the share. */
  async closeIdlestBridge() {
    if (!this.lastCloudListing || Date.now() - this.lastCloudListing.fetchedAt > CLOUD_POLL_MS) {
      await this.fetchCloudPaths().catch(() => {});
    }
    let victim = null;
    for (const [localRel, bridge] of this.bridges.entries()) {
      const stamp = this.closableStamp(localRel, bridge);
      if (stamp === null) continue;
      if (!victim || bridge.lastActivity < victim.bridge.lastActivity) victim = { localRel, bridge, stamp };
    }
    if (!victim) return false;
    await this.closeBridgeKeepingSynced(victim.localRel, victim.stamp);
    return true;
  }

  async dropBridge(localRel) {
    const bridge = this.bridges.get(localRel);
    if (!bridge) return;
    this.bridges.delete(localRel);
    await bridge.stop().catch(() => {});
    if (this.bridges.size === 0 && this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  async cloudFetch(pathname, init = {}) {
    const response = await fetch(`${this.share.api_origin}${pathname}`, {
      ...init,
      signal: init.signal ?? this.stopAbort.signal,
      headers: {
        Authorization: `Bearer ${this.share.token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (response.status === 401 || response.status === 403) {
      this.status = 'error';
      this.authError = true;
      this.error = `cloud token rejected (${response.status})`;
      throw new Error(this.error);
    }
    return response;
  }

  async fetchCloudPaths() {
    const response = await this.cloudFetch(
      `/api/workspace/local-agent/files?workspaceId=${this.share.workspace_id}`,
    );
    if (!response.ok) throw new Error(`cloud files list failed status=${response.status}`);
    const body = await response.json();
    const cloudFiles = Array.isArray(body.files) ? body.files : [];
    this.lastCloudListing = {
      text: new Set(cloudFiles.filter((file) => file.type === 'text').map((file) => String(file.path))),
      // Deletion checks ALL cloud paths, not just text ones — a cloud-side
      // rename to a blob/other type is not a delete of the local file.
      all: new Set(cloudFiles.map((file) => String(file.path))),
      stamps: new Map(cloudFiles.map((file) => [String(file.path), String(file.updated_at ?? '')])),
      // Binary rows, content-addressed: '' = row without a blob_sha (legacy
      // storage_key upload) — present but not diffable.
      blobShas: new Map(
        cloudFiles
          .filter((file) => file.type !== 'text' && file.type !== 'folder')
          .map((file) => [String(file.path), String(file.blob_sha ?? '')]),
      ),
      fetchedAt: Date.now(),
    };
    return this.lastCloudListing;
  }

  // ---- Blob sync (images & other binaries) --------------------------------
  // No Y.Docs: whole files, content-addressed. Reuses the shared bridge_files
  // ledger so delete/rename propagation and offline reconciliation treat blobs
  // exactly like text files; blob_sync records the last sha both sides agreed
  // on, which is what turns "different" into a direction (upload vs download).

  isBlobPath(rel) {
    return this.scopeContains(rel) && !isIgnoredPath(rel) && fileKind(rel) === 'blob';
  }

  /** Disk state of a local blob. Idle polls trust the recorded mtime+size and
   *  skip rehashing; watcher-triggered syncs pass `rehash` because a rewrite
   *  can land with the same size in the same millisecond bucket. */
  async localBlobState(localRel, { rehash = false } = {}) {
    const abs = resolveInRoot(this.project.root, localRel);
    const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
    if (!stat?.isFile()) return { exists: false };
    if (stat.size > BLOB_SYNC_MAX_BYTES) return { exists: true, tooLarge: true, stat };
    const record = this.store.getBlobSync(this.share.id, localRel);
    if (!rehash && record && record.local_mtime_ms === Math.trunc(stat.mtimeMs) && record.local_size === stat.size) {
      return { exists: true, sha: record.sha, stat, bytes: null };
    }
    const bytes = await fsp.readFile(abs);
    return { exists: true, sha: createHash('sha256').update(bytes).digest('hex'), stat, bytes };
  }

  /** Reconcile one blob path with its cloud twin. `cloudSha`: sha from the
   *  latest listing; '' = cloud row without a sha; null = no cloud row;
   *  undefined = look it up. Conflict policy matches the text bridges: when
   *  both sides changed since the last agreed state, local wins. */
  async syncBlob(localRel, cloudSha = undefined, { rehash = false } = {}) {
    if (this.stopped || this.status === 'error' || !this.isBlobPath(localRel)) return;
    if (this.blobBusy.has(localRel)) {
      // A transfer is mid-flight — don't drop this trigger's intent (e.g. a
      // local edit during a download); the next poll re-reconciles it.
      this.pendingBlobSyncs.add(localRel);
      return;
    }
    this.blobBusy.add(localRel);
    // Queued until proven in sync — any throw below leaves it for the next poll.
    this.pendingBlobSyncs.add(localRel);
    try {
      if (cloudSha === undefined) {
        // Local-event path (watcher edit, rename, deferred retry): never
        // decide against the cached listing — a cloud delete since the last
        // poll would read as a stale sha and the upload would resurrect the
        // deleted file. A FRESH listing lets delete-wins see the absence.
        // (Poll/first-sync callers pass their own snapshot's sha explicitly.)
        const listing = await this.fetchCloudPaths();
        const cloudPath = this.localToCloud(localRel);
        cloudSha = listing.blobShas.get(cloudPath) ?? (listing.all.has(cloudPath) ? '' : null);
      }
      const synced = this.store.getBlobSync(this.share.id, localRel)?.sha ?? null;
      const local = await this.localBlobState(localRel, { rehash });
      if (local.tooLarge) {
        if (!this.loggedBlobSkips.has(localRel)) {
          this.loggedBlobSkips.add(localRel);
          this.log(`blob skip (over ${BLOB_SYNC_MAX_BYTES} bytes) file=${localRel}`);
        }
        // A previously synced blob rewritten past the cap becomes local-only:
        // remove the (now stale) cloud twin, then drop bridge state. Leaving
        // either behind loses data — a lingering bridge row lets a cloud
        // delete sweep reap the newer local file, and a lingering cloud row
        // would resurrect a later local delete. A failed cloud delete throws,
        // leaving this queued for the next poll.
        if (this.store.hasBridgeFile(this.share.id, localRel)) {
          await this.cloudDelete(this.localToCloud(localRel));
          this.store.forgetBridgeFile(this.share.id, localRel);
          this.log(`blob unbridged (grew over cap, now local-only) file=${localRel}`);
        }
        this.pendingBlobSyncs.delete(localRel);
        return;
      }
      if (!local.exists) {
        this.pendingBlobSyncs.delete(localRel);
        if (cloudSha === null) return; // gone on both sides
        // Previously synced + gone locally = a local delete the delete rails
        // propagate; never synced = a new cloud blob to materialize.
        if (this.store.hasBridgeFile(this.share.id, localRel)) return;
        await this.downloadBlob(localRel, cloudSha || null, null);
        return;
      }
      if (cloudSha && cloudSha === local.sha) {
        // Already identical — just record the agreement.
        this.store.markBridgeFile(this.share.id, localRel);
        this.store.recordBlobSync(this.share.id, localRel, {
          sha: local.sha,
          mtimeMs: Math.trunc(local.stat.mtimeMs),
          size: local.stat.size,
        });
        this.pendingBlobSyncs.delete(localRel);
        return;
      }
      const localChanged = local.sha !== synced;
      if (cloudSha === null) {
        if (this.store.hasBridgeFile(this.share.id, localRel)) {
          // Cloud twin deleted — the poll's delete rails mirror it locally
          // (same policy as text files); re-uploading would fight them.
          this.pendingBlobSyncs.delete(localRel);
          return;
        }
        await this.uploadBlob(localRel, local);
      } else if (localChanged) {
        // Local changed (cloud too, possibly — local wins, like first-sync).
        await this.uploadBlob(localRel, local);
      } else if (cloudSha && cloudSha !== synced) {
        await this.downloadBlob(localRel, cloudSha, local.sha);
      } else {
        // cloudSha === '' (legacy row, not diffable) and local is unchanged —
        // nothing actionable.
        this.pendingBlobSyncs.delete(localRel);
        return;
      }
      this.pendingBlobSyncs.delete(localRel);
    } finally {
      this.blobBusy.delete(localRel);
    }
  }

  async uploadBlob(localRel, local) {
    const bytes = local.bytes ?? (await fsp.readFile(resolveInRoot(this.project.root, localRel)));
    const sha = local.sha;
    const cloudPath = this.localToCloud(localRel);
    const mime = mimeFor(localRel) ?? 'application/octet-stream';
    const workspaceId = this.share.workspace_id;
    const pre = await this.cloudFetch('/api/workspace/uploads/precheck', {
      method: 'POST',
      body: JSON.stringify({ projectId: workspaceId, sha }),
    });
    if (!pre.ok) throw new Error(`blob precheck failed status=${pre.status}`);
    const { exists } = await pre.json();
    if (!exists) {
      // TUS: create the session, then a single whole-file PATCH (blobs are
      // capped well under chunking territory).
      const meta = (values) =>
        Object.entries(values)
          .map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`)
          .join(',');
      const create = await this.cloudFetch('/api/workspace/uploads/tus', {
        method: 'POST',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(bytes.length),
          'Upload-Metadata': meta({ projectId: workspaceId, sha, contentType: mime }),
        },
      });
      const location = create.headers.get('location');
      if (!(create.status === 200 || create.status === 201) || !location) {
        throw new Error(`blob upload create failed status=${create.status}`);
      }
      for (let offset = 0; offset === 0 || offset < bytes.length; offset += BLOB_UPLOAD_CHUNK_BYTES) {
        const patch = await this.cloudFetch(location, {
          method: 'PATCH',
          headers: {
            'Tus-Resumable': '1.0.0',
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
          },
          body: bytes.subarray(offset, offset + BLOB_UPLOAD_CHUNK_BYTES),
        });
        if (!patch.ok) throw new Error(`blob upload failed status=${patch.status} offset=${offset}`);
      }
    }
    const fin = await this.cloudFetch('/api/workspace/uploads/finalize', {
      method: 'POST',
      body: JSON.stringify({ projectId: workspaceId, path: cloudPath, sha, mime, replace: true }),
    });
    if (!fin.ok) throw new Error(`blob finalize failed status=${fin.status}`);
    // The cloud row exists now either way — record that before re-checking the
    // local file, so the delete/rename rails own the path from here on.
    this.store.markBridgeFile(this.share.id, localRel);
    // Deleted or rewritten while the transfer was in flight? The watcher
    // couldn't act then (no bridge_files row existed yet) — propagate the
    // delete / requeue the newer bytes instead of recording a stale sync.
    const current = await this.localBlobState(localRel, { rehash: true });
    if (!current.exists) {
      this.log(`blob upload superseded by local delete file=${localRel}`);
      await this.handleLocalFileEvent(localRel);
      return;
    }
    if (current.sha !== sha) {
      this.pendingBlobSyncs.add(localRel);
      this.log(`blob rewritten mid-upload, requeued file=${localRel}`);
      return;
    }
    this.store.recordBlobSync(this.share.id, localRel, {
      sha,
      mtimeMs: Math.trunc(current.stat.mtimeMs),
      size: current.stat.size,
    });
    this.log(`blob up file=${localRel} sha=${sha.slice(0, 8)}`);
  }

  /** `basedOnLocalSha` is the local content the download decision was judged
   *  against (null = no local file existed) — re-checked right before the
   *  write so a local edit racing the transfer is never overwritten. */
  async downloadBlob(localRel, expectedSha, basedOnLocalSha = null) {
    if (this.skippedBlobDownloads.get(localRel) === (expectedSha ?? '')) return;
    const skipOversized = () => {
      this.skippedBlobDownloads.set(localRel, expectedSha ?? '');
      if (!this.loggedBlobSkips.has(localRel)) {
        this.loggedBlobSkips.add(localRel);
        this.log(`blob skip download (over ${BLOB_SYNC_MAX_BYTES} bytes) file=${localRel}`);
      }
    };
    const cloudPath = this.localToCloud(localRel);
    const res = await this.cloudFetch(
      `/api/workspace/local-agent/file?workspaceId=${this.share.workspace_id}&path=${encodeURIComponent(cloudPath)}&raw=1&maxBytes=${BLOB_SYNC_MAX_BYTES}`,
    );
    if (res.status === 413) {
      // The route refused by row size without buffering the object.
      skipOversized();
      return;
    }
    if (!res.ok) throw new Error(`blob download failed status=${res.status}`);
    // Refuse by the declared size before pulling the body when possible.
    if (Number(res.headers.get('content-length') || 0) > BLOB_SYNC_MAX_BYTES) {
      res.body?.cancel?.().catch?.(() => {});
      skipOversized();
      return;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > BLOB_SYNC_MAX_BYTES) {
      skipOversized();
      return;
    }
    // Trust the bytes we actually got over the listing's (possibly stale) sha.
    const sha = createHash('sha256').update(bytes).digest('hex');
    // The local file may have changed (or appeared) while the transfer was in
    // flight — overwriting it would silently lose the newer local bytes.
    // Abort and requeue; the next reconcile sees local-changed and uploads
    // (local wins), preserving the advertised conflict policy.
    const current = await this.localBlobState(localRel, { rehash: true });
    if ((current.exists ? current.sha ?? '' : null) !== basedOnLocalSha && current.sha !== sha) {
      this.pendingBlobSyncs.add(localRel);
      this.log(`blob download aborted (local changed mid-transfer) file=${localRel}`);
      return;
    }
    // Stream variant: writeBlobAtomic's 10 MB cap predates the 50 MB sync
    // bound — size is already enforced above by BLOB_SYNC_MAX_BYTES.
    await writeBlobStreamAtomic(this.project.root, localRel, Readable.from(bytes));
    const abs = resolveInRoot(this.project.root, localRel);
    const stat = await fsp.stat(abs);
    this.store.markBridgeFile(this.share.id, localRel);
    this.store.recordBlobSync(this.share.id, localRel, {
      sha,
      mtimeMs: Math.trunc(stat.mtimeMs),
      size: stat.size,
    });
    this.manager.emitFilesChanged(this.project.id, localRel);
    this.log(`blob down file=${localRel} sha=${sha.slice(0, 8)}${expectedSha && sha !== expectedSha ? ' (listing was stale)' : ''}`);
  }

  queueCloudOp(label, run) {
    this.pendingCloudOps.push({ label, run });
    this.opsParked = true;
    this.status = 'error';
    this.error = `cloud sync operation failed: ${label} (retrying)`;
    this.log(`share ${this.share.id} queued retry: ${label}`);
  }

  async flushPendingCloudOps() {
    if (this.pendingCloudOps.length > 0) {
      const remaining = [];
      for (const op of this.pendingCloudOps) {
        try {
          await op.run();
        } catch {
          remaining.push(op);
        }
      }
      this.pendingCloudOps = remaining;
    }
    if (this.pendingCloudOps.length === 0 && this.opsParked && !this.authError) {
      this.opsParked = false;
      this.status = 'active';
      this.error = null;
      // Bridging was blocked while parked — pick up local scope files now.
      const local = (await walkProject(this.project.root)).filter(
        (file) => (file.type === 'text' || file.type === 'blob') && this.scopeContains(file.path),
      );
      await this.bridgeAll(local);
    }
  }

  async pollCloud() {
    if (this.stopped || !this.share.api_origin) return;
    await this.flushPendingCloudOps();
    const cloudPaths = await this.fetchCloudPaths();
    const { text: cloudTextPaths, stamps: cloudStamps } = cloudPaths;
    let cloudAllPaths = cloudPaths.all;
    // Set by any stage that can UPLOAD paths the poll-start listing predates;
    // the delete sweeps at the bottom refetch before trusting the listing.
    let listingStale = false;
    if (this.deferredResume) {
      // The listing failed at start(); now that it works, reconcile the
      // previously-synced files we deliberately held back. Runs even when the
      // deferred set is empty — the latch below must lift either way, or a
      // file synced after start() would queue resume-opens forever.
      const pending = this.deferredResume;
      this.deferredResume = null;
      await this.bridgeAll(await this.reconcileOfflineDeletes(pending, cloudPaths));
      // First successful listing after a start()-time outage: reconciliation
      // has now really run, so lift the resume latch and replay everything
      // queued since bind (start() only drains after an immediate one).
      this.resuming = false;
      await this.drainPendingResumeOpens();
      listingStale = true;
    }
    for (const cloudPath of cloudTextPaths) {
      const localRel = this.cloudToLocal(cloudPath);
      if (this.share.scope_kind === 'file' && cloudPath !== this.localToCloud(this.share.scope_path)) continue;
      if (isIgnoredPath(localRel) || fileKind(localRel) !== 'text') continue;
      const bridge = this.bridges.get(localRel);
      if (bridge) {
        bridge.cloudSeen = true;
        continue;
      }
      const synced = this.store.hasBridgeFile(this.share.id, localRel);
      // Synced file with a closed idle bridge: reopen only when the cloud row
      // moved past the stamp recorded at close (a collaborator edited it).
      if (synced && this.syncedStamps.get(localRel) === cloudStamps.get(cloudPath)) continue;
      await this.ensureBridge(localRel).catch((error) => this.noteError(localRel, error));
      const created = this.bridges.get(localRel);
      if (created) created.cloudSeen = true;
      if (synced) continue;
      // New file created in the cloud → its state flows local and the local
      // persist writes it to disk.
      this.manager.emitFilesChanged(this.project.id, localRel);
      // The disk write lands after the persist debounce, and its watcher
      // event is suppressed as an own-write — re-emit once it exists so the
      // UI's coalesced refetch can't race ahead of the file.
      setTimeout(() => {
        if (!this.stopped) this.manager.emitFilesChanged(this.project.id, localRel);
      }, 1500);
    }

    // Blobs: content-diff every cloud binary against its local twin, then
    // retry any queued blob syncs (failed transfers, local changes seen while
    // the listing was unavailable). syncBlob no-ops once the shas agree.
    for (const [cloudPath, sha] of cloudPaths.blobShas) {
      const localRel = this.cloudToLocal(cloudPath);
      if (this.share.scope_kind === 'file' && cloudPath !== this.localToCloud(this.share.scope_path)) continue;
      if (!this.isBlobPath(localRel)) continue;
      await this.syncBlob(localRel, sha).catch((error) => this.noteError(localRel, error));
    }
    if (this.pendingBlobSyncs.size > 0) {
      // ONE fresh snapshot for the whole drain: entries were queued by local
      // events/races at unknown times, so the poll-start listing may predate
      // a cloud delete (uploading against its stale sha would resurrect the
      // file) — while the undefined fallback would fan out a listing fetch
      // per path. Refetch failure falls back to the poll snapshot; the
      // transfer itself would fail on such a network anyway and requeue.
      await this.fetchCloudPaths().catch(() => null);
      for (const localRel of Array.from(this.pendingBlobSyncs)) {
        await this.syncBlob(localRel, this.cachedCloudSha(localRel)).catch((error) => this.noteError(localRel, error));
      }
      listingStale = true;
    }
    if (listingStale) {
      // Something above may have UPLOADED paths the poll-start listing
      // predates — the sweeps below would read their freshly marked
      // bridge_files rows as cloud-deleted and remove the just-uploaded
      // local files. One refetch, or no sweeps at all this poll: falling
      // back to the stale listing reaps them just the same.
      const refreshed = await this.fetchCloudPaths().catch(() => null);
      if (!refreshed) return;
      cloudAllPaths = refreshed.all;
    }

    // A bridged file that HAD been seen in the cloud and is now absent from
    // the ENTIRE cloud listing was deleted by a collaborator → mirror locally.
    for (const [localRel, bridge] of Array.from(this.bridges.entries())) {
      if (this.stopped) return; // stop() mid-poll: no disk deletes during shutdown
      if (!bridge.cloudSeen || cloudAllPaths.has(bridge.cloudPath)) continue;
      await this.dropBridge(localRel);
      if (this.share.scope_kind === 'file') {
        // A single-file share can't distinguish a cloud delete from a cloud
        // RENAME (the share is pinned to one basename) — deleting the local
        // file on absence would turn a rename into data loss. Keep the file
        // and park the share with a visible error instead.
        this.status = 'error';
        this.error = `cloud file "${bridge.cloudPath}" was removed or renamed — sharing stopped, local file kept`;
        this.log(`file-share cloud path gone file=${localRel}; share parked`);
        continue;
      }
      this.store.forgetBridgeFile(this.share.id, localRel);
      await deleteFile(this.project.root, localRel).catch(() => {});
      this.store.recordEdit({ projectId: this.project.id, path: localRel, actor: 'remote', contentText: null });
      await this.docHost.handleDiskChange(this.project.id, localRel).catch(() => {});
      this.manager.emitFilesChanged(this.project.id, localRel);
      this.log(`bridge cloud-delete file=${localRel}`);
    }

    // Synced files whose idle bridges CLOSED see collaborator deletes here:
    // bridges only close after their cloud row was confirmed in a listing, so
    // absence from the whole listing is a genuine cloud-side delete.
    for (const localRel of this.store.listBridgeFiles(this.share.id)) {
      if (this.stopped) return; // stop() mid-poll: no disk deletes during shutdown
      if (this.bridges.has(localRel) || !this.scopeContains(localRel)) continue;
      if (cloudAllPaths.has(this.localToCloud(localRel))) continue;
      if (this.share.scope_kind === 'file') {
        this.status = 'error';
        this.error = `cloud file "${this.localToCloud(localRel)}" was removed or renamed — sharing stopped, local file kept`;
        this.log(`file-share cloud path gone file=${localRel}; share parked`);
        continue;
      }
      this.syncedStamps.delete(localRel);
      this.store.forgetBridgeFile(this.share.id, localRel);
      await deleteFile(this.project.root, localRel).catch(() => {});
      this.store.recordEdit({ projectId: this.project.id, path: localRel, actor: 'remote', contentText: null });
      await this.docHost.handleDiskChange(this.project.id, localRel).catch(() => {});
      this.manager.emitFilesChanged(this.project.id, localRel);
      this.log(`bridge cloud-delete file=${localRel} (idle)`);
    }

    // Rescued files whose re-share failed transiently requeued themselves —
    // retry each poll. AFTER the delete sweeps: an upload here lands past the
    // listing this poll swept against, so it can't be misread as deleted.
    if (!this.resuming && this.pendingResumeOpens.size) await this.drainPendingResumeOpens();

    // Idle sweep: a closed bridge costs nothing and reopens on demand (local
    // edit/editor connect via events, cloud edit via the stamp check above).
    const now = Date.now();
    for (const [localRel, bridge] of Array.from(this.bridges.entries())) {
      if (now - bridge.lastActivity < BRIDGE_IDLE_MS) continue;
      const stamp = this.closableStamp(localRel, bridge);
      if (stamp !== null) await this.closeBridgeKeepingSynced(localRel, stamp);
    }

    // A full poll pass succeeded: a lingering transient error (cloud-list
    // outage, per-file timeout) is over — clear it so the UI stops warning.
    // Parked states (status 'error') stay until a token refresh / re-share.
    if (this.error && this.status === 'active') {
      this.error = null;
      this.manager.emitSharesChanged(this.project.id);
    }

    // Ship new granular ledger rows (edit attribution, chats, decisions) to
    // the cloud mirror — LAST: it's a side channel, and a large retained
    // backlog must never delay the document/file sync above. Non-fatal and
    // log-only: a failed upload retries next poll (cursors only advance on
    // ack), and a rejected side channel must not flash the trust-critical
    // sync-error UI (noteError would park the share on a 401/403 message).
    // Single-flight: setInterval overlaps a slow pass with the next poll, and
    // a concurrent pass would read a chat-version reservation as a change and
    // mint a duplicate snapshot.
    if (!this.ledgerSyncInFlight) {
      this.ledgerSyncInFlight = true;
      try {
        await syncShareLedger(this);
      } catch (error) {
        this.log(`share ${this.share.id} ledger-sync: ${error?.message || error}`);
      } finally {
        this.ledgerSyncInFlight = false;
      }
    }
  }

  async cloudDelete(cloudPath) {
    const response = await this.cloudFetch('/api/workspace/local-agent/file', {
      method: 'DELETE',
      body: JSON.stringify({ workspaceId: this.share.workspace_id, path: cloudPath, editMode: 'edit' }),
    });
    // 404 = already gone (idempotent); anything else must surface so callers
    // don't act as if the cloud side was cleaned up.
    if (!response.ok && response.status !== 404) {
      throw new Error(`cloud delete failed status=${response.status}`);
    }
  }

  /** This path plus every SYNCED descendant — open bridges and idle-closed
   *  ones alike (a deleted/renamed FOLDER arrives as one event for the folder
   *  path, and closed bridges still have cloud twins to move/delete). */
  bridgedUnder(localRel) {
    const under = new Set(
      [...this.bridges.keys(), ...this.store.listBridgeFiles(this.share.id)].filter(
        (key) => key === localRel || key.startsWith(`${localRel}/`),
      ),
    );
    return Array.from(under);
  }

  /** Local path created/changed/deleted (watcher or HTTP CRUD). */
  async handleLocalFileEvent(localRel) {
    if (this.stopped) return;
    const abs = resolveInRoot(this.project.root, localRel);
    const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
    if (stat?.isFile()) {
      if (fileKind(localRel) === 'blob') {
        // A watcher event means the bytes really moved — bypass the stat cache
        // (same-size rewrites can share its mtime bucket).
        await this.syncBlob(localRel, undefined, { rehash: true }).catch((error) => this.noteError(localRel, error));
        return;
      }
      if (this.scopeContains(localRel) && !this.bridges.has(localRel)) {
        await this.ensureBridge(localRel).catch((error) => this.noteError(localRel, error));
      }
      return;
    }
    if (stat?.isDirectory()) {
      // A tree delete can preserve the folder (protected children stay) —
      // sweep bridged descendants whose own files are gone.
      for (const rel of this.bridgedUnder(localRel)) {
        if (rel === localRel) continue;
        const relAbs = resolveInRoot(this.project.root, rel);
        const relStat = relAbs ? await fsp.stat(relAbs).catch(() => null) : null;
        if (relStat) continue;
        await this.dropBridge(rel);
        const cloudPath = this.localToCloud(rel);
        const run = async () => {
          await this.cloudDelete(cloudPath);
          this.store.forgetBridgeFile(this.share.id, rel);
        };
        try {
          await run();
        } catch {
          this.queueCloudOp(`delete ${cloudPath}`, run);
        }
      }
      return;
    }
    if (stat) return; // other non-file — nothing to bridge
    // Gone from disk: tear down this path AND any bridged descendants (a
    // folder delete fires one event for the folder), then mirror to the cloud.
    // A failed cloud delete keeps the bridge_files row (and the share error)
    // so the orphan is visible instead of silently forgotten.
    for (const rel of this.bridgedUnder(localRel)) {
      await this.dropBridge(rel);
      const cloudPath = this.localToCloud(rel);
      const run = async () => {
        await this.cloudDelete(cloudPath);
        this.store.forgetBridgeFile(this.share.id, rel);
      };
      try {
        await run();
      } catch {
        this.queueCloudOp(`delete ${cloudPath}`, run);
      }
    }
  }

  async handleLocalRename(fromRel, toRel) {
    const fromIn = this.scopeContains(fromRel);
    const toIn = this.scopeContains(toRel);
    if (!fromIn && !toIn) return;
    if (fromIn) {
      // Tear down the old-path bridges (exact file or folder subtree) and move
      // or remove the cloud side. The cloud move is attempted even when no
      // bridge is live yet (e.g. renamed before the first sync finished) so no
      // orphan doc is left at the old path; a 404 there is fine.
      const affected = this.bridgedUnder(fromRel);
      for (const rel of affected) {
        await this.dropBridge(rel);
        this.store.forgetBridgeFile(this.share.id, rel);
      }
      if (toIn) {
        const move = async () => {
          const res = await this.cloudFetch('/api/workspace/local-agent/file', {
            method: 'PATCH',
            body: JSON.stringify({
              workspaceId: this.share.workspace_id,
              sourcePath: this.localToCloud(fromRel),
              targetPath: this.localToCloud(toRel),
              editMode: 'edit',
            }),
          });
          if (!res.ok && res.status !== 404) throw new Error(`cloud move failed ${res.status}`);
        };
        try {
          await move();
        } catch {
          // Park until the move lands — re-bridging now would first-sync
          // local-wins over whatever sits at the target cloud path.
          this.queueCloudOp(`move ${this.localToCloud(fromRel)} -> ${this.localToCloud(toRel)}`, move);
        }
      } else {
        // Moved out of scope. Delete the affected CHILD paths individually —
        // when fromRel is the scope root itself its cloud path is '' (the
        // workspace root), which is not a deletable target. Failures queue
        // (parking the share) so the poller can't pull the moved file back.
        const targets = affected.length > 0 ? affected : [fromRel];
        for (const rel of targets) {
          const cloudPath = this.localToCloud(rel);
          const run = () => this.cloudDelete(cloudPath);
          try {
            await run();
          } catch {
            this.queueCloudOp(`delete ${cloudPath}`, run);
          }
        }
      }
    }
    if (!toIn) return;
    // Re-bridge whatever now exists at the new path (file or folder subtree);
    // deterministic seeds make the re-attach a no-op merge.
    const toAbs = resolveInRoot(this.project.root, toRel);
    const toStat = toAbs ? await fsp.stat(toAbs).catch(() => null) : null;
    if (toStat?.isFile()) {
      await (fileKind(toRel) === 'blob' ? this.syncBlob(toRel) : this.ensureBridge(toRel)).catch(
        (error) => this.noteError(toRel, error),
      );
    } else if (toStat?.isDirectory()) {
      const files = (await walkProject(this.project.root)).filter(
        (file) =>
          (file.type === 'text' || file.type === 'blob') &&
          (file.path === toRel || file.path.startsWith(`${toRel}/`)),
      );
      await this.bridgeAll(files);
    }
  }

  async stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    await Promise.all(Array.from(this.bridges.keys()).map((rel) => this.dropBridge(rel)));
    // After the bridges' final drops: rejects any still-hung cloud fetch so a
    // background resume blocked on it settles and shutdown's join returns.
    this.stopAbort.abort();
    this.socket?.destroy();
    this.status = 'stopped';
  }
}

export class SyncBridgeManager {
  constructor({ store, docHost, log = () => {}, emitFilesChanged = () => {}, emitSharesChanged = () => {} }) {
    this.store = store;
    this.docHost = docHost;
    this.log = log;
    /** (projectId, path) → SSE notification, so cloud-driven creates/deletes
     *  refresh the local file tree like local ones do. */
    this.emitFilesChanged = emitFilesChanged;
    /** (projectId) → SSE notification on share STATUS transitions (parked,
     *  token-rejected, revived) — the UI's syncing badges must not lie. */
    this.emitSharesChanged = emitSharesChanged;
    this.engines = new Map(); // shareId -> ShareEngine
    // Flipped by stopAll(): resumeAll() runs in the background after the
    // server binds, so shutdown must be able to cancel the remaining loop
    // instead of racing it (engines already mid-start are covered by their
    // own `stopped` flags).
    this.closed = false;
  }

  async resumeAll({ interactiveSince = Date.now() } = {}) {
    // Register every enabled share's engine SYNCHRONOUSLY (no awaits yet):
    // the server is already accepting requests, and mutation fan-outs
    // (renames, file events) only visit registered engines — a rename landing
    // while an earlier share is still resuming must not silently skip a later
    // one, or its stale scope would read the renamed files as offline
    // deletes. Engines latch pre-start events (`resuming` arms at construct).
    const pending = [];
    for (const project of this.store.listProjects()) {
      for (const share of this.store.listShares(project.id)) {
        if (!share.enabled || this.engines.has(share.id)) continue;
        const engine = new ShareEngine({ manager: this, share, project, resumeHorizon: interactiveSince });
        this.engines.set(share.id, engine);
        pending.push(engine);
      }
    }
    for (const engine of pending) {
      if (this.closed) return;
      const shareId = engine.share.id;
      // A mutation mid-resume may have replaced this engine (scope-follow
      // restart) or stopped it (share removed) — nothing left to start.
      if (this.engines.get(shareId) !== engine || engine.stopped) continue;
      // Re-read the row: a share deleted/disabled (or re-scoped) while
      // earlier shares resumed must not start from the stale snapshot.
      const current = this.store.getShare(shareId);
      if (!current?.enabled) {
        await engine.stop();
        if (this.engines.get(shareId) === engine) this.engines.delete(shareId);
        continue;
      }
      engine.share = current;
      await engine.start().catch((error) => {
        this.log(`share resume failed id=${shareId} error=${error?.message}`);
      });
      // Resume runs after the port is up, so the UI may have fetched share
      // status mid-resume ("inactive") — tell it to look again.
      this.emitSharesChanged(engine.project.id);
    }
  }

  async startEngine(share, project) {
    if (this.engines.has(share.id)) return;
    const engine = new ShareEngine({ manager: this, share, project });
    this.engines.set(share.id, engine);
    await engine.start();
  }

  async createShare(projectId, body) {
    const project = this.store.getProject(projectId);
    if (!project) throw Object.assign(new Error('unknown project'), { status: 404 });
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
    const collabUrl = typeof body.collabUrl === 'string' ? body.collabUrl.trim() : '';
    const apiOrigin = typeof body.apiOrigin === 'string' ? body.apiOrigin.trim().replace(/\/$/, '') : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const scopeKind = ['project', 'folder', 'file'].includes(body.scopeKind) ? body.scopeKind : 'project';
    const scopePath = scopeKind === 'project' ? '' : String(body.scopePath || '').trim();
    if (!workspaceId || !collabUrl || !apiOrigin || !token) {
      throw Object.assign(new Error('workspaceId, collabUrl, apiOrigin, token are required'), { status: 400 });
    }
    if (scopeKind !== 'project' && !scopePath) {
      throw Object.assign(new Error('scopePath is required for folder/file shares'), { status: 400 });
    }
    // Shares cover the PRIMARY root only: extra roots (multi-root mounts) are
    // local context, not sync scopes — their events never reach engines below.
    if (inExtraRoot(this.store, projectId, scopePath)) {
      throw Object.assign(new Error('Folders added from elsewhere on this computer cannot be shared yet.'), { status: 400 });
    }
    // Overlapping enabled scopes are rejected: two engines relay the same
    // local doc, and each filters BRIDGE_ORIGIN updates as its own echoes —
    // so a cloud edit arriving through one share would never reach the other.
    // One audience per subtree keeps sharing semantics predictable.
    const contains = (outer, inner) => !outer || inner === outer || inner.startsWith(`${outer}/`);
    const overlapping = this.store
      .listShares(projectId)
      .find((existing) => existing.enabled && (contains(existing.scope_path, scopePath) || contains(scopePath, existing.scope_path)));
    if (overlapping) {
      const label = overlapping.scope_path || 'the whole project';
      throw Object.assign(
        new Error(`Already synced by an existing share (${label}). Stop that share first.`),
        { status: 409 },
      );
    }
    const share = this.store.addShare({ projectId, workspaceId, scopePath, scopeKind, collabUrl, apiOrigin, token });
    await this.startEngine(share, project);
    return this.describeShare(share);
  }

  describeShare(share) {
    const engine = this.engines.get(share.id);
    // Never echo the token back out.
    const { token, ...safe } = share;
    return {
      ...safe,
      status: engine?.status ?? (share.enabled ? 'inactive' : 'disabled'),
      error: engine?.error ?? null,
      bridgedFiles: engine?.bridges.size ?? 0,
    };
  }

  describeShares(projectId) {
    return this.store.listShares(projectId).map((share) => this.describeShare(share));
  }

  refreshShareToken(projectId, shareId, token) {
    const share = this.store.getShare(shareId);
    if (!share || share.project_id !== projectId || !token) {
      throw Object.assign(new Error('unknown share or missing token'), { status: 400 });
    }
    this.store.updateShareToken(shareId, token);
    const engine = this.engines.get(shareId);
    if (engine) {
      engine.share.token = token;
      // A fresh token only revives TOKEN-REJECTED engines. Other parked states
      // (e.g. a file-share whose cloud path vanished) are safety stops that a
      // routine token refresh must not undo.
      if (engine.status === 'error' && engine.authError) {
        engine.status = 'active';
        engine.error = null;
        engine.authError = false;
        this.emitSharesChanged(projectId);
      }
    }
  }

  async removeShare(projectId, shareId) {
    const share = this.store.getShare(shareId);
    if (!share || share.project_id !== projectId) {
      throw Object.assign(new Error('unknown share'), { status: 404 });
    }
    const engine = this.engines.get(shareId);
    if (engine) {
      await engine.stop();
      this.engines.delete(shareId);
    }
    this.store.removeBridgeFiles(shareId);
    this.store.removeShare(shareId);
  }

  async handleLocalFileEvent(projectId, relPath) {
    if (inExtraRoot(this.store, projectId, relPath)) return;
    for (const engine of this.engines.values()) {
      if (engine.project.id === projectId && !engine.stopped) {
        await engine.handleLocalFileEvent(relPath).catch((error) => {
          this.log(`bridge local-event failed path=${relPath} error=${error?.message}`);
        });
      }
    }
  }

  /** An editor connected to a local doc: revive its idle-closed bridge so
   *  typing and cursors relay live instead of waiting on the cloud poll. */
  handleLocalDocOpened(projectId, relPath) {
    if (inExtraRoot(this.store, projectId, relPath)) return;
    for (const engine of this.engines.values()) {
      if (engine.project.id !== projectId || engine.stopped || engine.bridges.has(relPath)) continue;
      void engine.ensureBridge(relPath).catch((error) => {
        this.log(`bridge editor-open failed path=${relPath} error=${error?.message}`);
      });
    }
  }

  async handleLocalRename(projectId, fromRel, toRel) {
    if (inExtraRoot(this.store, projectId, fromRel) || inExtraRoot(this.store, projectId, toRel)) return;
    for (const [shareId, engine] of Array.from(this.engines.entries())) {
      if (engine.project.id !== projectId || engine.stopped) continue;
      const scope = engine.share.scope_path;
      if (scope && (scope === fromRel || scope.startsWith(`${fromRel}/`))) {
        // The scope root (or an ancestor folder) was renamed: the share
        // FOLLOWS it — restart the engine on the new scope. Folder scopes
        // need no cloud change (paths are scope-relative), but a FILE scope's
        // cloud path is its basename, so a basename change must move the
        // cloud doc or collaborators see both the stale and the new file.
        const newScope = scope === fromRel ? toRel : toRel + scope.slice(fromRel.length);
        let staleCloudPath = null;
        if (engine.share.scope_kind === 'file') {
          // Basenames of the SCOPE, not of the renamed path: an ancestor
          // folder rename (docs→notes with scope docs/a.md) leaves the cloud
          // doc name (a.md) untouched — moving 'docs'→'notes' in the cloud
          // would hit an unrelated file or park the share on a bogus move.
          const fromCloud = scope.split('/').pop();
          const toCloud = newScope.split('/').pop();
          if (fromCloud !== toCloud) {
            try {
              const res = await engine.cloudFetch('/api/workspace/local-agent/file', {
                method: 'PATCH',
                body: JSON.stringify({
                  workspaceId: engine.share.workspace_id,
                  sourcePath: fromCloud,
                  targetPath: toCloud,
                  editMode: 'edit',
                }),
              });
              if (!res.ok && res.status !== 404) {
                // Move refused (e.g. 409 target exists): remove the old cloud
                // doc so the restarted share can't leave a stale duplicate.
                await engine.cloudDelete(fromCloud);
              }
            } catch (error) {
              // Cloud unreachable: the restarted engine must not first-sync
              // the new basename while the old cloud doc still exists — park
              // it behind a queued cleanup of the old path.
              this.log(`file-share cloud move failed id=${shareId} error=${error?.message}`);
              staleCloudPath = fromCloud;
            }
          }
        }
        this.store.updateShareScope(shareId, newScope);
        const project = engine.project;
        await engine.stop();
        this.engines.delete(shareId);
        const share = this.store.getShare(shareId);
        if (share) {
          const next = new ShareEngine({ manager: this, share, project });
          this.engines.set(shareId, next);
          if (staleCloudPath) {
            const cloudPath = staleCloudPath;
            next.queueCloudOp(`delete ${cloudPath}`, () => next.cloudDelete(cloudPath));
          }
          await next.start().catch((error) => {
            this.log(`share scope-follow restart failed id=${shareId} error=${error?.message}`);
          });
        }
        continue;
      }
      await engine.handleLocalRename(fromRel, toRel).catch((error) => {
        this.log(`bridge rename failed from=${fromRel} error=${error?.message}`);
      });
    }
  }

  async stopProject(projectId) {
    for (const [shareId, engine] of Array.from(this.engines.entries())) {
      if (engine.project.id === projectId) {
        await engine.stop();
        this.engines.delete(shareId);
      }
    }
  }

  async stopAll() {
    this.closed = true; // cancel any in-flight background resumeAll()
    for (const [shareId, engine] of Array.from(this.engines.entries())) {
      await engine.stop();
      this.engines.delete(shareId);
    }
  }
}
