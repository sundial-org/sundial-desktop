import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness.js';

import { Y } from '../lib/crdt-js/markdown_yjs.mjs';
import { applyContentTextIfChanged, readDocumentText } from '../lib/crdt-js/document_text.mjs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { fileKindForFile, isEnvSecretPath, isIgnoredPath, logPath, mimeFor, resolveInRoot, scopeCoversPath, windowsUnwritableReason } from './paths.mjs';
import { inExtraRoot } from './roots.mjs';
import { syncShareLedger } from './ledger-sync.mjs';
import { Readable } from 'node:stream';
import {
  createEmptyTextFileExclusive,
  deleteFile,
  fileFingerprintSync,
  fileVersionSync,
  readTextFile,
  walkProject,
  writeBlobStreamAtomic,
} from './disk.mjs';
import { BRIDGE_ORIGIN } from './doc-host.mjs';
import { buildSyncProgress, syncSkipReason, SYNC_SKIP_REASONS } from './sync-progress.mjs';
// Production working-set bound; the override keeps rollover tests small.
const MAX_BRIDGED_FILES = Math.max(
  1,
  Number.parseInt(process.env.SUNDIAL_BRIDGE_MAX_OPEN_FILES || '', 10) || 500,
);
const CLOUD_POLL_MS = Number(process.env.SUNDIAL_BRIDGE_POLL_MS || 10_000);
// Every comment-mirror request is deadline-bounded: comment reads run on the
// sidecar's /comments REQUEST path, so a wedged backing workspace must
// degrade to local-only threads, never hang the panel.
const CLOUD_COMMENTS_TIMEOUT_MS = Number(process.env.SUNDIAL_CLOUD_COMMENTS_TIMEOUT_MS || 4_000);
// How long a share stops asking a cloud that answered 404 (no mirror route).
const COMMENTS_PARK_MS = Number(process.env.SUNDIAL_CLOUD_COMMENTS_PARK_MS || 5 * 60_000);
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
// noteError() subjects that name a whole-share phase rather than a file — the
// only `where` values that are NOT a path, and so the only ones logged bare.
const ERROR_PHASES = new Set(['cloud-list', 'cloud-poll', 'ledger-sync', 'token-refresh']);
const BRIDGE_IDLE_MS = Number(process.env.SUNDIAL_BRIDGE_IDLE_MS || 60_000);
const SYNC_PROGRESS_TIMEOUT_MS = Number(process.env.SUNDIAL_SYNC_PROGRESS_TIMEOUT_MS || 4_000);
const SYNC_PROGRESS_UPDATE_MS = Number(process.env.SUNDIAL_SYNC_PROGRESS_UPDATE_MS || 500);
const SYNC_PROGRESS_HEARTBEAT_MS = Number(
  process.env.SUNDIAL_SYNC_PROGRESS_HEARTBEAT_MS || 10_000,
);

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
    this.cloudMissingAt = 0; // first absent listing; delete only after watcher settle
    this.staleEmptyMaterialization = false;
    this.staleEmptyVersion = null;
    this.stopped = false;
    this.started = false;
    this.cancelSyncWait = null; // settles a pending waitForSync at stop()
    this.lastActivity = Date.now();
    this.onLocalUpdate = null;
    this.onCloudUpdate = null;
    this.onLocalAwareness = null;
    this.onCloudAwareness = null;
    this.relayedToLocal = new Set(); // cloud client ids mirrored into the local doc
    this.relayedToCloud = new Set(); // local client ids mirrored into the cloud doc
  }

  async start({ listingStillCurrent = null } = {}) {
    const { docHost, share, store, log } = this.engine;
    const requireCurrentListing = () => {
      if (listingStillCurrent && !listingStillCurrent()) {
        throw Object.assign(new Error(`cloud listing superseded file=${this.localRel}`), {
          listingSuperseded: true,
        });
      }
    };
    requireCurrentListing();
    this.direct = await docHost.hocuspocus.openDirectConnection(this.localDocName, {
      actor: 'remote',
      userId: 'cloud-bridge',
    });
    requireCurrentListing();
    const localDoc = this.direct.document;
    // "Local wins" only applies when a local FILE exists — an empty string is
    // ambiguous between "intentionally empty file" (local wins, even empty)
    // and "no file yet" (a cloud-created file being pulled; cloud wins).
    const localAbs = resolveInRoot(this.engine.project.root, this.localRel);
    const localExists = localAbs ? Boolean(await fsp.stat(localAbs).catch(() => null)) : false;
    requireCurrentListing();

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
    requireCurrentListing();

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
      this.staleEmptyMaterialization = false;
      this.staleEmptyVersion = null;
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
      requireCurrentListing();
      try {
        await createEmptyTextFileExclusive(this.engine.project.root, this.localRel);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          // A local creation won the race after localExists was sampled. Never
          // replace it with the cloud's empty bytes; restart as local intent so
          // the new content follows the normal local-wins first-sync path.
          this.engine.retainLocalIntent(this.localRel);
          throw Object.assign(new Error(`local file appeared during bridge start file=${this.localRel}`), {
            localAppearedDuringStart: true,
          });
        }
        throw error;
      }
      docHost.watchers.get(this.engine.project.id)?.suppress(this.localRel);
      await this.engine.refreshProgressLocalPath(this.localRel);
      this.engine.scheduleProgressPublish();
      try {
        requireCurrentListing();
      } catch (error) {
        if (!error?.listingSuperseded) throw error;
        const versionBeforeRead = this.engine.localFileVersion(this.localRel);
        const disk = await readTextFile(this.engine.project.root, this.localRel).catch(() => null);
        const versionAfterRead = this.engine.localFileVersion(this.localRel);
        const ownsEmptyMaterialization =
          versionBeforeRead !== null &&
          versionBeforeRead === versionAfterRead &&
          disk?.text === '' &&
          !this.engine.pendingResumeOpens.has(this.localRel) &&
          readDocumentText(this.localRel, localDoc) === '';
        if (!ownsEmptyMaterialization) {
          // A local writer filled or replaced the exclusive empty file before
          // this stale listing was detected. Do not label those real bytes as
          // bridge-owned: tear this opener down and retry with local intent.
          this.engine.retainLocalIntent(this.localRel);
          throw Object.assign(new Error(`local file changed during bridge start file=${this.localRel}`), {
            localAppearedDuringStart: true,
          });
        }
        // Never check-then-delete here: a local writer can always land after
        // the check. Keep the live, durable bridge and let the normal two-pass
        // absent-listing rail remove this unchanged empty materialization. If
        // a local edit arrives first, the attached relay/persist guards make
        // that edit win instead.
        this.cloudSeen = true;
        this.staleEmptyMaterialization = true;
        this.staleEmptyVersion = versionAfterRead;
        store.markBridgeFile(share.id, this.localRel);
        docHost.loadedWithoutDisk.delete(this.localDocName);
        docHost.schedulePersist(this.localDocName, localDoc, { actor: 'remote', userId: 'cloud-bridge' });
        this.engine.manager.emitFilesChanged(this.engine.project.id, this.localRel);
        log(`bridge stale empty materialization awaiting confirmation file=${logPath(this.localRel)}`);
        return;
      }
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
        const live = this.engine.docHost.getLiveText(this.engine.project.id, this.localRel);
        // A connected editor can be ahead of disk while its persist is
        // pending; otherwise disk is authoritative for an external/local-agent
        // write whose debounced watcher may not have reached the Y.Doc yet.
        const content = this.engine.docHost.hasPendingPersist(this.localDocName)
          ? live ?? disk?.text ?? ''
          : disk?.text ?? live ?? '';
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
        this.engine.queueCloudOp('create', this.cloudPath, createCloudTwin);
      }
      log(`bridge up file=${logPath(this.localRel)} cloud=${logPath(this.cloudDocName)}`);
      docHost.schedulePersist(this.localDocName, localDoc, { actor: 'remote', userId: 'cloud-bridge' });
      return;
    }
    requireCurrentListing();
    if (localExists) {
      store.markBridgeFile(share.id, this.localRel);
      // Flush the merged state to disk + let the cloud persist its side.
      docHost.schedulePersist(this.localDocName, localDoc, { actor: 'remote', userId: 'cloud-bridge' });
    } else {
      // Cloud pull with no disk twin: the bridge_files row means "first sync
      // done" and every gone-from-disk rail trusts it, so the disk write must
      // land BEFORE the mark — marking first leaves a window where a watcher
      // event reads the not-yet-written file as a local delete and deletes
      // the cloud original (the 2026-09-02 mass-delete on fresh attach).
      await docHost.queuePersist(this.localDocName, localDoc, { actor: 'remote', userId: 'cloud-bridge' }, { rethrow: true });
      store.markBridgeFile(share.id, this.localRel);
    }
    log(`bridge up file=${logPath(this.localRel)} cloud=${logPath(this.cloudDocName)}`);
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

/** One share = one cloud workspace. Legacy model: one scope (project root,
 *  subfolder, single file, or chat) per workspace, cloud paths translated to
 *  be scope-relative. Grants model (scope_kind 'union'): one HIDDEN backing
 *  workspace per local project syncs the union of its share_scopes at their
 *  real relative paths; audiences live in cloud path_shares grants. */
export class ShareEngine {
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
    // Grants-model share (scope_kind 'union'): ONE engine per backing
    // workspace syncs the union of its scopes at their real relative paths
    // (identity mapping — no scope-root translation), and each scope's
    // audience is a cloud path_shares grant. Legacy shares keep the
    // one-workspace-per-scope model untouched.
    this.isUnion = share.scope_kind === 'union';
    this.scopes = this.isUnion ? this.store.listShareScopes(share.id) : [];
    this.bridges = new Map(); // localRel -> FileBridge
    this.socket = null;
    this.pollTimer = null;
    this.pollInFlight = null;
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
    // Deadline until which comment mirroring is parked (0 = never parked); set
    // when the cloud answers 404, i.e. has no mirror route. See #parkComments.
    this.commentsParkedUntil = 0;
    // start() runs in the background after the server binds, so editor-open /
    // watcher events can race its offline-delete reconciliation. Until that
    // finishes, previously-synced files must NOT open bridges (a bridge would
    // push local state and resurrect a cloud-deleted file) — they queue here
    // and replay after reconciliation. The same queue retains first-sync files
    // when the live-bridge working set is full; a later poll rotates them in.
    // Never-synced files bridge immediately while capacity remains.
    // Armed from construction: resumeAll registers engines before starting
    // them, so events can reach an engine whose start() hasn't run yet.
    this.resuming = true;
    this.deferredResume = null;
    this.pendingResumeOpens = new Set();
    // Subset of pendingResumeOpens whose raw disk bytes raced a cloud delete.
    // Do not reopen them until DocHost has ingested a stable snapshot.
    this.pendingDiskReconciles = new Set();
    // Deduplicate the one on-demand listing refresh used when concurrent
    // cap entrants find no closable bridge in the cached snapshot.
    this.capacityListingRefresh = null;
    // localRel → cloud updated_at recorded when an idle bridge closed; a
    // different stamp on a later poll means cloud-side edits → reopen.
    this.syncedStamps = new Map();
    // The matching local stat fingerprint. A disk edit can land before its
    // debounced watcher callback; compare this before mirroring a cloud delete
    // onto an idle-closed file so those new bytes are never erased.
    this.syncedLocalVersions = new Map();
    this.lastCloudListing = null; // most recent fetchCloudPaths result
    this.cloudListingRequestGeneration = 0;
    this.cloudListingPublishedGeneration = 0;
    this.cloudListingRequestsInFlight = new Set();
    this.blobBusy = new Set(); // localRel with a blob sync in flight
    // Blob syncs that failed (or arrived before any cloud listing) — each
    // poll retries them; syncBlob no-ops once both sides agree.
    this.pendingBlobSyncs = new Set();
    this.loggedBlobSkips = new Set(); // oversized paths already warned about
    // localRel → cloud sha ('' = legacy no-sha row) refused as oversized, so
    // the 10s poll doesn't re-download the same huge blob forever. A new
    // cloud version (different sha) clears naturally by failing the compare.
    this.skippedBlobDownloads = new Map();
    this.pendingOversizedUnbridges = new Set();
    // Progress is a cached union of the latest complete disk walk + cloud
    // listing. Maps key by local-relative path, so overlapping union scopes
    // and paths present on both sides count exactly once.
    this.progressLocalFiles = null;
    this.progressCloudFiles = null;
    this.progressDirtyPaths = new Set();
    this.progressFailedPaths = new Set();
    this.progressInitialSync = true;
    this.progressNeedsFinalVerification = true;
    this.progressUpdatedAt = new Date().toISOString();
    this.progressFingerprint = null;
    // The source is stable without exposing the install UUID; generation is
    // a durable process/engine epoch and sequence orders reports within it.
    this.progressSourceId = `local:${createHash('sha256')
      .update(`${this.store.installId()}:${this.project.id}`)
      .digest('hex')
      .slice(0, 32)}`;
    this.progressGeneration = this.store.nextSyncProgressGeneration(this.project.id);
    this.progressSequence = 0;
    this.progressReportInFlight = null;
    this.progressQueuedReport = null;
    this.progressReportErrorLogged = false;
    this.progressPublishTimer = null;
    this.progressHeartbeatTimer = null;
    this.progressLastReport = null;
    this.errorRevision = 0;
    // Scope-root moves whose cloud half hasn't landed (durable across
    // restarts): re-queue them, parking the engine until they drain — the
    // start()/poll guards then defer everything that would act on a cloud
    // listing these ops haven't caught up with.
    if (this.isUnion) {
      for (const move of this.store.listPendingScopeMoves(share.id)) {
        this.queueCloudOp('move', `${move.from} -> ${move.to}`, this.scopeMoveOp(move));
      }
    }
  }

  /** The cloud half of a scope-root rename, idempotent: subtree move (404 =
   *  already moved), grant move (no matching rows = already moved), then the
   *  durable marker clears. Throwing keeps the share parked for retry.
   *
   *  Deliberately NOT under the project lock: this runs from pollCloud(), and
   *  start() ends in a poll — so a locked section that restarts an engine
   *  (add/stop) would deadlock on its own lock. The ordering against a stop
   *  is bought with the watermark instead: a stop revokes through the highest
   *  generation any PENDING relocation allocated (removeShareScopeLocked), so
   *  a stamp landing before it is deleted with it, and one landing after it
   *  finds no row left to stamp. */
  scopeMoveOp(move) {
    return async () => {
      const res = await this.cloudFetch('/api/workspace/local-agent/file', {
        method: 'PATCH',
        body: JSON.stringify({
          workspaceId: this.share.workspace_id,
          sourcePath: move.from,
          targetPath: move.to,
          editMode: 'edit',
        }),
      });
      if (!res.ok && res.status !== 404) throw new Error(`cloud move failed ${res.status}`);
      // EVERY relocation this move recorded, including hops the scope has
      // since moved past: the generation is what carries the row over any
      // revocation watermark at the intermediate path, and a chained rename
      // whose middle hop transited unstamped would be swept there and never
      // reach its final path. Which scopes actually adopt it is decided
      // below, not here.
      const relocations = move.relocations ?? [];
      const grants = await this.cloudFetch('/api/workspace/local-agent/path-shares', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: this.share.workspace_id,
          fromPath: move.from,
          toPath: move.to,
          generations: Object.fromEntries(relocations.map((entry) => [entry.path, entry.generation])),
        }),
      });
      // No 404 tolerance here: "already moved" is a 200 with moved:0 — a 404
      // means the cloud lacks the route (deploy skew), and clearing the
      // durable move would break outstanding ?pshare= links with no retry.
      if (!grants.ok) throw new Error(`grant move failed ${grants.status}`);
      // Bump the local scopes only once the cloud row carries the same
      // generation. Bumping at rename time instead would hand a mint the new
      // generation while the row still sat at the old one — the mint RAISES
      // the row, and a raise over a recorded generation resets link + members
      // server-side, wiping the very audience the rename preserves.
      // ONLY the paths the route reports as stamped: a row that lost a target
      // conflict, or already carried a higher generation, kept a generation
      // the scope must not claim to have (same audience-wipe hazard, one step
      // later). A non-array reply is an older cloud that ignored `generations`
      // entirely — bumping there would strand scope above row. The store's own
      // path guard drops the rest: a scope that moved on (chained rename) or
      // was stopped no longer sits at the path this hop stamped.
      // A body we cannot READ is not "an older cloud": the move may well have
      // committed, and clearing the durable marker here would strand the scope
      // below the generation the row now carries, out of reach of a later
      // stop's watermark. Throw so the move stays queued — the route
      // re-reports an already-stamped row by value, so the retry converges.
      const outcome = await grants.json().catch(() => {
        throw new Error('grant move reply unreadable');
      });
      if (Array.isArray(outcome?.stamped)) {
        const landed = new Set(outcome.stamped);
        let bumped = false;
        for (const entry of relocations) {
          if (landed.has(entry.path)) {
            this.store.bumpShareScopeGeneration(entry.scopeId, entry.path, entry.generation);
            bumped = true;
          }
        }
        // The scopes the UI is holding just changed generation — tell it, or a
        // modal opened while this move was parked keeps revoking with the
        // pre-rename value.
        if (bumped) this.manager.emitSharesChanged(this.project.id);
      }
      this.store.removePendingScopeMove(this.share.id, move);
    };
  }

  scopeContains(rel) {
    // Chat shares carry conversation history only — no file is ever in scope.
    if (this.share.scope_kind === 'chat') return false;
    if (this.isUnion) return this.scopes.some((scope) => scopeCoversPath(scope, rel));
    const scope = this.share.scope_path;
    if (!scope) return true;
    if (this.share.scope_kind === 'file') return rel === scope;
    return rel === scope || rel.startsWith(`${scope}/`);
  }

  localToCloud(rel) {
    if (this.isUnion) return rel; // identity — cloud paths ARE local paths
    const scope = this.share.scope_path;
    if (!scope) return rel;
    if (this.share.scope_kind === 'file') return rel.split('/').pop();
    return rel.slice(scope.length + 1);
  }

  cloudToLocal(cloudPath) {
    if (this.isUnion) return cloudPath;
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

  /** Tear the shared socket down without taking the sidecar with it. Closing a
   *  ws that is still CONNECTING throws ("WebSocket was closed before the
   *  connection was established"), and the sidecar's uncaughtException handler
   *  is a process.exit — so a stop that lands mid-handshake (stop sharing right
   *  after starting one, or a slow/flaky Hocuspocus dial) would kill the local
   *  backend outright. The socket is being discarded either way. */
  destroySocket() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    // ws emits that error on a nextTick AFTER Hocuspocus's cleanupWebSocket has
    // removed its own listeners — the try/catch below can't see it, so keep a
    // listener of our own on the raw socket or it lands as uncaughtException.
    socket.webSocket?.on?.('error', () => {});
    try {
      socket.destroy();
    } catch (error) {
      this.log(`socket destroy failed (ignored) error=${error?.message}`);
    }
  }

  /** Chat legacy shares — and union shares whose scopes are all chats — sync
   *  through the ledger only: no file walk, no CRDT bridges, no collab socket. */
  get ledgerOnly() {
    if (this.share.scope_kind === 'chat') return true;
    return this.isUnion && !this.scopes.some((scope) => scope.scope_kind !== 'chat');
  }

  /** Any chat scope makes the ledger trust-critical: a shared chat has no
   *  CRDT/file fallback, so its upload failures must surface even while file
   *  sync keeps running beside it (mixed unions). */
  get ledgerCritical() {
    if (this.ledgerOnly) return true;
    return this.isUnion && this.scopes.some((scope) => scope.scope_kind === 'chat');
  }

  hasOpenBacklog() {
    return (
      this.resuming ||
      this.deferredResume !== null ||
      this.pendingResumeOpens.size > 0 ||
      this.pendingBlobSyncs.size > 0
    );
  }

  setProgressLocalFiles(files) {
    this.progressLocalFiles = new Map(
      files
        .filter((file) => file.type !== 'folder' && this.scopeContains(file.path) && !isIgnoredPath(file.path))
        .map((file) => [file.path, file]),
    );
  }

  setProgressCloudFiles(files) {
    const mapped = new Map();
    for (const file of files) {
      if (file.type === 'folder') continue;
      const cloudPath = String(file.path);
      const localRel = this.cloudToLocal(cloudPath);
      if (this.share.scope_kind === 'file' && cloudPath !== this.localToCloud(this.share.scope_path)) continue;
      if (!this.scopeContains(localRel) || isIgnoredPath(localRel)) continue;
      mapped.set(localRel, {
        path: localRel,
        type: file.type === 'text' ? 'text' : 'blob',
        size: Number(file.size ?? 0),
      });
    }
    this.progressCloudFiles = mapped;
  }

  async refreshProgressLocalPath(localRel) {
    if (!this.progressLocalFiles || !this.scopeContains(localRel) || isIgnoredPath(localRel)) return;
    const abs = resolveInRoot(this.project.root, localRel);
    const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
    // Directory mtime/watch events are not subtree deletes. Its descendants
    // remain authoritative in the cached inventory; explicit missing-child
    // rails below remove individual paths, and an absent directory removes
    // the subtree here.
    if (stat?.isDirectory()) return;
    if (!stat?.isFile()) {
      this.progressLocalFiles.delete(localRel);
      for (const path of [...this.progressLocalFiles.keys()]) {
        if (path.startsWith(`${localRel}/`)) this.progressLocalFiles.delete(path);
      }
      return;
    }
    this.progressLocalFiles.set(localRel, {
      path: localRel,
      type: fileKindForFile(localRel),
      size: stat.size,
    });
  }

  /** Close the startup watcher-registration gap before claiming completion.
   *  The poll's published cloud listing is current; re-walk disk after all
   *  of that pass's awaits, then queue any never-synced local path the first
   *  walk missed. One-sided previously-synced paths stay for delete policy. */
  async verifyProgressInventory() {
    if (this.stopped || !this.progressCloudFiles || !this.progressNeedsFinalVerification) return;
    const files = (await walkProject(this.project.root)).filter(
      (file) => (file.type === 'text' || file.type === 'blob') && this.scopeContains(file.path),
    );
    this.setProgressLocalFiles(files);
    for (const file of files) {
      if (
        !this.progressSkipReason(file.path) &&
        !this.progressCloudFiles.has(file.path) &&
        !this.store.hasBridgeFile(this.share.id, file.path) &&
        !this.bridges.has(file.path)
      ) this.pendingResumeOpens.add(file.path);
    }
    // One authoritative post-start pass closes the watcher-registration gap.
    // From here the watcher and cloud listing update the cached maps
    // incrementally; recursively statting a data-heavy project every 10s is
    // not an acceptable telemetry cost for a small partial-folder share.
    this.progressNeedsFinalVerification = false;
  }

  progressSkipReason(localRel) {
    return (
      syncSkipReason(this.progressLocalFiles?.get(localRel), { blobMaxBytes: BLOB_SYNC_MAX_BYTES }) ??
      syncSkipReason(this.progressCloudFiles?.get(localRel), { blobMaxBytes: BLOB_SYNC_MAX_BYTES }) ??
      (this.progressCloudFiles?.has(localRel) && process.platform === 'win32' && windowsUnwritableReason(localRel)
        ? SYNC_SKIP_REASONS.unwritablePath
        : null)
    );
  }

  /** A path that used to sync but is now over policy must become wholly
   *  local-only; retaining its old cloud row would silently expose stale
   *  bytes. The retry queue keeps that transition visible and durable for
   *  the life of this engine, including auth/network parks. */
  async unbridgeOversized(localRel) {
    if (!this.store.hasBridgeFile(this.share.id, localRel) || this.pendingOversizedUnbridges.has(localRel)) return;
    await this.dropBridge(localRel).catch(() => {});
    this.pendingOversizedUnbridges.add(localRel);
    const cloudPath = this.localToCloud(localRel);
    const run = async () => {
      await this.cloudDelete(cloudPath);
      this.store.forgetBridgeFile(this.share.id, localRel);
      this.pendingOversizedUnbridges.delete(localRel);
    };
    if (this.opsParked) {
      this.queueCloudOp('delete oversized', cloudPath, run);
      return;
    }
    try {
      await run();
    } catch {
      this.queueCloudOp('delete oversized', cloudPath, run);
    }
  }

  async unbridgeOversizedFiles(files) {
    for (const file of files) {
      // Cleanup is driven by LOCAL growth only. An oversized/newer cloud twin
      // is collaborator data: report/skip it, never delete it from restart.
      if (
        syncSkipReason(file, { blobMaxBytes: BLOB_SYNC_MAX_BYTES }) &&
        this.store.hasBridgeFile(this.share.id, file.path)
      ) {
        await this.unbridgeOversized(file.path);
      }
    }
  }

  progressPendingPaths() {
    const pending = new Set([
      ...this.progressDirtyPaths,
      ...this.progressFailedPaths,
      ...this.pendingResumeOpens,
      ...this.pendingBlobSyncs,
      ...this.blobBusy,
      ...(this.deferredResume ?? []).map((file) => file.path),
    ]);
    for (const [path, bridge] of this.bridges) {
      if (
        !bridge.started ||
        !bridge.provider?.synced ||
        bridge.provider.hasUnsyncedChanges ||
        this.docHost.hasPendingPersist(bridge.localDocName)
      ) pending.add(path);
    }
    // Idle-closed text paths retain the cloud stamp they last agreed with.
    // A newer listing stamp means a collaborator edit is waiting to reopen;
    // if the live cap refuses that reopen, it must remain visibly pending.
    if (this.lastCloudListing) {
      for (const [path, agreedStamp] of this.syncedStamps) {
        const currentStamp = this.lastCloudListing.stamps.get(this.localToCloud(path));
        if (currentStamp !== undefined && currentStamp !== agreedStamp) pending.add(path);
      }
    }
    // A durable bridge row represents agreement, not merely discovery. A
    // one-sided path still has a delete/download/upload decision outstanding.
    if (this.progressLocalFiles && this.progressCloudFiles) {
      for (const path of new Set([
        ...this.progressLocalFiles.keys(),
        ...this.progressCloudFiles.keys(),
      ])) {
        if (this.progressLocalFiles.has(path) !== this.progressCloudFiles.has(path)) pending.add(path);
      }
    }
    return pending;
  }

  progressForScope(scope = null) {
    const contains = scope
      ? (path) => scope.scope_kind !== 'chat' && scopeCoversPath(scope, path)
      : (path) => this.scopeContains(path);
    return buildSyncProgress({
      localFiles: this.progressLocalFiles,
      cloudFiles: this.progressCloudFiles,
      completedPaths: new Set(this.store.listBridgeFiles(this.share.id)),
      pendingPaths: this.progressPendingPaths(),
      contains,
      blobMaxBytes: BLOB_SYNC_MAX_BYTES,
      unwritable: (path) => process.platform === 'win32' && Boolean(windowsUnwritableReason(path)),
      busy:
        this.progressInitialSync ||
        // Path-addressable queues are already in pendingPaths and get scoped
        // by the builder. Only truly share-global work belongs here, or one
        // slow union scope would make every settled sibling say "syncing".
        this.pendingCloudOps.length > 0,
      error: Boolean(this.error) || this.status === 'error',
      updatedAt: this.progressUpdatedAt,
    });
  }

  publishProgress({ force = false, heartbeat = false, scheduled = false } = {}) {
    if (this.stopped || this.ledgerOnly) return;
    if (!force && !heartbeat && !scheduled) {
      this.scheduleProgressPublish();
      return;
    }
    if (force && this.progressPublishTimer) {
      clearTimeout(this.progressPublishTimer);
      this.progressPublishTimer = null;
    }
    const progress = this.progressForScope();
    const fingerprint = JSON.stringify({ ...progress, updatedAt: undefined });
    if (!force && !heartbeat && fingerprint === this.progressFingerprint) return;
    this.progressFingerprint = fingerprint;
    this.progressUpdatedAt = new Date().toISOString();
    const report = { ...progress, updatedAt: this.progressUpdatedAt };
    this.progressLastReport = report;
    this.manager.emitSharesChanged(this.project.id);
    this.queueProgressReport(report);
  }

  scheduleProgressPublish(delay = SYNC_PROGRESS_UPDATE_MS) {
    if (this.stopped || this.progressPublishTimer) return;
    this.progressPublishTimer = setTimeout(() => {
      this.progressPublishTimer = null;
      this.publishProgress({ scheduled: true });
    }, delay);
    this.progressPublishTimer.unref?.();
  }

  sendProgressHeartbeat() {
    if (this.stopped || !this.progressLastReport) return;
    // A quick authoritative poll publishes its own fresh snapshot. If a poll
    // hangs while the cached state says complete, do not keep laundering that
    // stale up_to_date state into fresh cloud heartbeats; it will age offline.
    // Known scanning/transfers keep heartbeating their non-final snapshot.
    if (this.pollInFlight && this.progressLastReport.phase === 'up_to_date') return;
    this.progressUpdatedAt = new Date().toISOString();
    this.progressLastReport = { ...this.progressLastReport, updatedAt: this.progressUpdatedAt };
    this.queueProgressReport(this.progressLastReport);
  }

  startProgressHeartbeat(delay = SYNC_PROGRESS_HEARTBEAT_MS) {
    if (this.ledgerOnly || this.progressHeartbeatTimer || !this.share.api_origin || !this.share.token) return;
    this.progressHeartbeatTimer = setInterval(() => this.sendProgressHeartbeat(), delay);
    this.progressHeartbeatTimer.unref?.();
  }

  queueProgressReport(progress) {
    if (this.ledgerOnly || !this.share.api_origin || !this.share.token || !this.share.workspace_id) return;
    this.progressQueuedReport = progress;
    if (this.progressReportInFlight) return;
    this.progressReportInFlight = (async () => {
      while (!this.stopped && this.progressQueuedReport) {
        const next = this.progressQueuedReport;
        this.progressQueuedReport = null;
        const body = {
          workspaceId: this.share.workspace_id,
          sourceId: this.progressSourceId,
          generation: this.progressGeneration,
          sequence: this.progressSequence++,
          ...next,
          // Cloud-visible copy is intentionally generic: engine.error may
          // contain an absolute local path or HTTP internals.
          error: next.phase === 'error' ? 'Some files could not sync. Check the local service.' : null,
        };
        try {
          const response = await fetch(`${this.share.api_origin}/api/workspace/local-agent/sync-status`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.share.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(SYNC_PROGRESS_TIMEOUT_MS),
          });
          // Always release/reuse Undici's connection. Even a 409/error route
          // has a small JSON body; leaving heartbeat bodies unread can exhaust
          // the shared origin pool and contend with real file-sync fetches.
          await response.arrayBuffer().catch(() => {});
          // 409 means a newer process/report already owns the cursor. It is a
          // successful terminal outcome for THIS superseded heartbeat.
          if (!response.ok && response.status !== 409 && !this.progressReportErrorLogged) {
            this.progressReportErrorLogged = true;
            this.log(`share ${this.share.id} sync-progress report failed status=${response.status} (ignored)`);
          } else if (response.ok) {
            this.progressReportErrorLogged = false;
          }
        } catch (error) {
          if (!this.progressReportErrorLogged) {
            this.progressReportErrorLogged = true;
            this.log(`share ${this.share.id} sync-progress report failed: ${error?.message || error} (ignored)`);
          }
        }
      }
    })().finally(() => {
      this.progressReportInFlight = null;
      // A report may have been queued between the loop condition and finally.
      if (!this.stopped && this.progressQueuedReport) this.queueProgressReport(this.progressQueuedReport);
    });
  }

  async start() {
    this.startProgressHeartbeat();
    this.publishProgress({ force: true });
    if (this.ledgerOnly) {
      // Chat share: the ledger mirror (chat snapshot + its messages) IS the
      // whole sync — no file walk, no CRDT bridges, no cloud file polling,
      // and no collab socket (so no collab_url requirement either).
      if (!this.share.api_origin || !this.share.token) {
        this.status = 'error';
        this.error = 'share is missing api_origin or token';
        this.progressInitialSync = false;
        this.publishProgress({ force: true });
        return;
      }
      this.progressLocalFiles = new Map();
      this.progressCloudFiles = new Map();
      this.resuming = false;
      this.status = 'active';
      await this.syncLedger();
      this.progressInitialSync = false;
      this.publishProgress({ force: true });
      if (this.stopped) return;
      this.pollTimer = setInterval(() => {
        void this.syncLedger().finally(() => this.publishProgress({ heartbeat: true }));
      }, CLOUD_POLL_MS);
      return;
    }
    if (!this.share.collab_url || !this.share.token) {
      this.status = 'error';
      this.error = 'share is missing collab_url or token';
      this.progressInitialSync = false;
      this.publishProgress({ force: true });
      return;
    }
    if (this.stopped) return;
    // (`resuming` is already armed — the constructor sets it, and every
    // engine is constructed fresh immediately before its one start().)
    // Blobs ride along for delete-reconciliation (a synced blob absent from
    // this walk must read as a local delete, not get pulled back) and are
    // queued for sha-diffed sync below; only text files open CRDT bridges.
    const localAll = (await walkProject(this.project.root)).filter(
      (file) => (file.type === 'text' || file.type === 'blob') && this.scopeContains(file.path),
    );
    this.setProgressLocalFiles(localAll);
    this.publishProgress({ force: true });
    // Oversized paths are local/cloud-visible skips, not an eternal open or
    // transfer queue. Keep them in the progress inventory, not the work list.
    const local = localAll.filter((file) => !this.progressSkipReason(file.path));
    // Reconcile cloud-side deletes that happened while this sidecar was
    // offline BEFORE opening bridges: a previously-synced file (bridge_files
    // row) now absent from the cloud listing was deleted remotely — bridging
    // it first would push the stale local state back and resurrect it. If the
    // listing is unavailable (transient outage), DEFER previously-synced
    // files to the first successful poll instead of bridging blind; files
    // never synced before are always safe to bridge. An engine born PARKED
    // (queued cloud ops — e.g. a scope-root rename whose cloud move hasn't
    // landed) defers the same way: the listing predates the queued ops, so
    // re-keyed bridge rows would misread as cloud deletes and reap the
    // just-renamed local files.
    const cloudPaths = this.opsParked
      ? null
      : await this.fetchCloudPaths().catch((error) => {
          this.noteError('cloud-list', error);
          return null;
        });
    // stop() can land while the listing was in flight — a stopped engine
    // must not run destructive cleanup during shutdown.
    if (this.stopped) return;
    // A file may have crossed the size limit while the sidecar was stopped,
    // so no watcher event exists to run the live unbridge transition. Remove
    // stale cloud ownership now (or visibly queue it) before completion.
    await this.unbridgeOversizedFiles(localAll);
    let toBridge;
    let listingStillCurrent = null;
    const deferPreviouslySynced = () => {
      listingStillCurrent = null;
      toBridge = local.filter((file) => !this.store.hasBridgeFile(this.share.id, file.path));
      this.deferredResume = local.filter((file) => this.store.hasBridgeFile(this.share.id, file.path));
    };
    if (cloudPaths && this.cloudListingIsCurrent(cloudPaths)) {
      listingStillCurrent = () => this.cloudListingIsCurrent(cloudPaths);
      const reconciled = await this.reconcileOfflineDeletes(local, cloudPaths, listingStillCurrent);
      if (reconciled === null) {
        deferPreviouslySynced();
      } else {
        toBridge = reconciled;
        // The symmetric case: a previously-synced file deleted/renamed ON DISK
        // while the sidecar was stopped. Without this, the first poll would see
        // its cloud twin as a "new cloud file" and pull it back, undoing the
        // user's offline delete — propagate the delete instead.
        const localSet = new Set(localAll.map((file) => file.path));
        for (const rel of this.store.listBridgeFiles(this.share.id)) {
          if (this.stopped) return; // shutdown mid-loop: no cloud deletes on a stopped engine
          if (!listingStillCurrent()) {
            deferPreviouslySynced();
            break;
          }
          if (localSet.has(rel) || !this.scopeContains(rel) || this.progressSkipReason(rel)) continue;
          // The walk is a snapshot: a file created and event-bridged while the
          // listing fetch was in flight has a fresh row but isn't in localSet.
          // "Offline local delete" means absent from disk NOW — re-stat before
          // condemning, or this sweep would delete the just-created file.
          const abs = resolveInRoot(this.project.root, rel);
          const existsNow = abs ? await fsp.stat(abs).then((stat) => stat.isFile()).catch(() => false) : false;
          if (!listingStillCurrent()) {
            deferPreviouslySynced();
            break;
          }
          if (existsNow) continue;
          if (cloudPaths.all.has(this.localToCloud(rel))) {
            const cloudPath = this.localToCloud(rel);
            const run = async () => {
              await this.cloudDelete(cloudPath);
              this.store.forgetBridgeFile(this.share.id, rel);
            };
            try {
              await run();
              this.log(`bridge offline local-delete file=${logPath(rel)}`);
            } catch {
              this.queueCloudOp('delete', cloudPath, run);
            }
          } else {
            this.store.forgetBridgeFile(this.share.id, rel); // gone on both sides
          }
          if (!listingStillCurrent()) {
            deferPreviouslySynced();
            break;
          }
        }
      }
    } else {
      deferPreviouslySynced();
    }
    // Reconciliation done — replay files queued while it ran (editor-opens
    // and rescued cloud-deletes). With no cloud listing there was NO
    // reconciliation: stay in `resuming` so previously-synced opens keep
    // queueing instead of bridging blind (a cloud-deleted file would be
    // pushed back); the deferred pass in pollCloud() reconciles, drains,
    // and lifts the latch on the first successful listing.
    if (listingStillCurrent) {
      const deferred = await this.bridgeAll(toBridge, { listingStillCurrent });
      if (deferred.length > 0) {
        this.deferredResume = deferred;
      } else {
        this.deferredResume = null;
        this.resuming = false;
        await this.drainPendingResumeOpens();
      }
    } else {
      await this.bridgeAll(toBridge);
    }
    await this.pollCloud().catch((error) => this.noteError('cloud-poll', error));
    // stop() can land while the awaits above are in flight (background resume
    // cancelled at shutdown) — a stopped engine must not arm a poll interval
    // that would outlive close() and keep the process alive.
    if (this.stopped) return;
    this.pollTimer = setInterval(() => {
      void this.pollCloud().catch((error) => this.noteError('cloud-poll', error));
    }, CLOUD_POLL_MS);
    if (this.status !== 'error') {
      this.status = this.hasOpenBacklog() ? 'starting' : 'active';
    }
    this.progressInitialSync = false;
    this.publishProgress({ force: true });
  }

  /** Bounded concurrency: files are independent, and serial waitForSync would
   *  make a large first share take minutes. Blob paths route to the sha-diffed
   *  transfer instead of a CRDT bridge. When a resume listing is supplied,
   *  previously-synced paths only reopen while that listing remains current;
   *  skipped paths return to the deferred reconciliation queue. */
  async bridgeAll(files, { listingStillCurrent = null } = {}) {
    const deferred = [];
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(
        files.slice(i, i + 8).map(async (file) => {
          if (this.progressSkipReason(file.path)) return;
          const guardedByListing = Boolean(
            listingStillCurrent && this.store.hasBridgeFile(this.share.id, file.path),
          );
          const current = guardedByListing ? listingStillCurrent : null;
          if (current && !current()) {
            deferred.push(file);
            return;
          }
          // The list can be a stale snapshot (resume runs in the background
          // after the port binds) — a file deleted since the walk must not
          // be bridged: the delete rails own it, and a bridge would push it
          // back to the cloud as a fresh doc.
          const abs = resolveInRoot(this.project.root, file.path);
          const exists = abs ? await fsp.stat(abs).then((stat) => stat.isFile()).catch(() => false) : false;
          if (!exists) return;
          if (current && !current()) {
            deferred.push(file);
            return;
          }
          // Blobs get the first-sync snapshot's sha explicitly — syncBlob's
          // undefined fallback fetches a fresh listing PER PATH, which a
          // large first share must not do.
          try {
            await (fileKindForFile(file.path) === 'blob'
              ? this.syncBlob(file.path, this.cachedCloudSha(file.path), { listingStillCurrent: current })
              : this.ensureBridge(file.path, {
                  retainOnFailure: !current,
                  listingStillCurrent: current,
                })
            );
          } catch (error) {
            this.noteError(file.path, error);
          }
          if (
            current &&
            (!current() || (fileKindForFile(file.path) === 'text' && !this.bridges.has(file.path)))
          ) {
            deferred.push(file);
          }
        }),
      );
      this.scheduleProgressPublish();
    }
    return deferred;
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
  async reconcileOfflineDeletes(files, cloudPaths, listingStillCurrent = null) {
    const kept = [];
    for (const file of files) {
      if (this.progressSkipReason(file.path)) continue;
      if (listingStillCurrent && !listingStillCurrent()) return null;
      if (this.stopped) return kept; // shutdown mid-loop: no deletes on a stopped engine
      const previouslySynced = this.store.hasBridgeFile(this.share.id, file.path);
      if (!previouslySynced || cloudPaths.all.has(this.localToCloud(file.path))) {
        kept.push(file);
        continue;
      }
      if (this.share.scope_kind === 'file') {
        this.status = 'error';
        this.error = `cloud file "${this.localToCloud(file.path)}" was removed or renamed. Sharing stopped, local file kept.`;
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
      if (listingStillCurrent && !listingStillCurrent()) return null;
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
        if (listingStillCurrent && !listingStillCurrent()) return null;
        this.store.forgetBridgeFile(this.share.id, file.path);
        // Queue it for the post-reconciliation replay: the live edit wins and
        // the file re-shares. Without this, an edit made before this engine
        // existed had no event to re-bridge it and silently went unshared.
        this.pendingResumeOpens.add(file.path);
        this.log(
          `bridge offline cloud-delete skipped (local file ${openInEditor ? 'open in editor' : 'edited since startup'}, re-sharing) file=${logPath(file.path)}`,
        );
        continue;
      }
      if (listingStillCurrent && !listingStillCurrent()) return null;
      await deleteFile(this.project.root, file.path).catch(() => {});
      await this.refreshProgressLocalPath(file.path);
      this.store.forgetBridgeFile(this.share.id, file.path);
      // Record the cloud-delete tombstone BEFORE the disk-change sweep so the
      // doc host's own tombstone guard sees it and doesn't double-record.
      this.store.recordEdit({ projectId: this.project.id, path: file.path, actor: 'remote', contentText: null });
      await this.docHost.handleDiskChange(this.project.id, file.path).catch(() => {});
      this.manager.emitFilesChanged(this.project.id, file.path);
      this.log(`bridge offline cloud-delete file=${logPath(file.path)}`);
    }
    return kept;
  }

  noteError(where, error) {
    // A bridge torn down mid-start (rescue drop, rename, shutdown) throws on
    // purpose — that's teardown, not a sync failure the UI should flash.
    if (this.stopped || error?.bridgeStopped) return;
    const hadError = Boolean(this.error);
    this.errorRevision += 1;
    this.error = `${where}: ${error?.message || error}`;
    if (
      typeof where === 'string' &&
      (this.progressLocalFiles?.has(where) || this.progressCloudFiles?.has(where) || this.bridges.has(where))
    ) this.progressFailedPaths.add(where);
    // `where` is a file path unless it names a whole-share phase. Paths go
    // out under file=, the key the diagnostics sink redacts — a bare name in
    // prose has no separator and nothing to key off, so it would ship as-is.
    const subject = ERROR_PHASES.has(where) ? `phase=${where}` : `file=${logPath(where)}`;
    this.log(`share ${this.share.id} ${subject} error=${error?.message || error}`);
    if (/auth|401|403/i.test(String(error?.message))) {
      this.status = 'error';
      this.authError = true;
    }
    // Sync health is trust-critical UI (the user believes edits are syncing) —
    // push EVERY first error (auth park or not) instead of waiting for a
    // share create/remove to refetch.
    if (!hadError) {
      this.manager.emitSharesChanged(this.project.id);
      this.publishProgress({ force: true });
    } else {
      this.scheduleProgressPublish();
    }
  }

  retainLocalIntent(localRel) {
    const bridge = this.bridges.get(localRel);
    if (bridge) {
      bridge.staleEmptyMaterialization = false;
      bridge.staleEmptyVersion = null;
    }
    this.pendingResumeOpens.add(localRel);
    if (this.status === 'active') this.status = 'starting';
  }

  async ensureBridge(localRel, { retainOnFailure = true, listingStillCurrent = null } = {}) {
    // A parked share ('error': rejected token, or a file-share whose cloud
    // path vanished) must not silently resurrect bridges — a fresh token or
    // re-share resets the status.
    if (this.stopped || this.bridges.has(localRel)) return;
    if (
      !this.scopeContains(localRel) ||
      isIgnoredPath(localRel) ||
      fileKindForFile(localRel) !== 'text' ||
      this.progressSkipReason(localRel)
    ) return;
    if (listingStillCurrent && !listingStillCurrent()) return;
    // A local edit/open owns this path until the provider has synced and the
    // bridge is fully installed. The marker prevents a concurrent absent
    // cloud listing from deleting those bytes while start() is still waiting.
    if (retainOnFailure) {
      this.retainLocalIntent(localRel);
    }
    if (this.status === 'error') {
      // Token refresh revives auth-parked engines without a disk re-walk, so
      // retain the local signal that arrived while credentials were stale.
      if (this.authError) {
        if (retainOnFailure) this.pendingResumeOpens.add(localRel);
      } else if (retainOnFailure) {
        this.pendingResumeOpens.delete(localRel);
      }
      return;
    }
    // Mid-resume, a previously-synced file may be a cloud-delete awaiting
    // reconciliation — bridging it now would push local state and resurrect
    // it. Queue instead; start() replays survivors. New files bridge freely.
    if (this.resuming && !listingStillCurrent && this.store.hasBridgeFile(this.share.id, localRel)) {
      if (retainOnFailure) this.pendingResumeOpens.add(localRel);
      return;
    }
    if (this.bridges.size >= MAX_BRIDGED_FILES) {
      // Queue BEFORE the listing refresh: a 401/403 parks the engine inside
      // that await, and a later token refresh must still know what to open.
      if (retainOnFailure) this.pendingResumeOpens.add(localRel);
      await this.closeIdlestBridge({ refreshIfNeeded: retainOnFailure });
    }
    // Several files start concurrently in bridgeAll(). Another opener can
    // claim the slot while closeIdlestBridge awaits teardown, so recheck the
    // gates and capacity immediately before the synchronous map reservation.
    if (this.stopped) {
      if (retainOnFailure) this.pendingResumeOpens.delete(localRel);
      return;
    }
    if (listingStillCurrent && !listingStillCurrent()) return;
    // Another concurrent opener owns this bridge and removes the pending
    // marker only after start succeeds. Keeping it meanwhile prevents an
    // overlapping poll from reporting healthy or applying a cloud delete.
    if (this.bridges.has(localRel)) return;
    if (this.status === 'error') {
      if (!this.authError && retainOnFailure) this.pendingResumeOpens.delete(localRel);
      return;
    }
    if (
      !this.scopeContains(localRel) ||
      isIgnoredPath(localRel) ||
      fileKindForFile(localRel) !== 'text' ||
      this.progressSkipReason(localRel)
    ) {
      if (retainOnFailure) this.pendingResumeOpens.delete(localRel);
      return;
    }
    if (this.bridges.size >= MAX_BRIDGED_FILES) {
      // The cap bounds the LIVE working set, not the shared tree. Cloud rows
      // can lag their first Y.Doc update, leaving no bridge safe to close yet;
      // retain this path for the next poll instead of silently truncating the
      // initial sync at MAX_BRIDGED_FILES.
      // Cloud-driven opens need no durable queue: the next listing discovers
      // them again. Only local/resume intent gets local-wins delete protection.
      if (retainOnFailure || this.pendingResumeOpens.has(localRel)) {
        this.pendingResumeOpens.add(localRel);
        if (this.status === 'active') this.status = 'starting';
        this.noteError(localRel, new Error(`open bridge cap (${MAX_BRIDGED_FILES}) reached`));
      }
      return;
    }
    if (listingStillCurrent && !listingStillCurrent()) return;
    const bridge = new FileBridge({
      engine: this,
      localRel,
      cloudPath: this.localToCloud(localRel),
    });
    this.bridges.set(localRel, bridge);
    try {
      await bridge.start({ listingStillCurrent });
    } catch (error) {
      // This opener may have been displaced while start awaited. Never tear
      // down or overwrite the retry state of a replacement bridge.
      if (this.bridges.get(localRel) === bridge) this.bridges.delete(localRel);
      await bridge.stop().catch(() => {});
      // A replacement owns this path now. Its own start result is
      // authoritative; surfacing this displaced opener's stale failure could
      // re-park an otherwise healthy share (notably after token refresh).
      if (this.bridges.has(localRel)) return;
      // A failed WebSocket/auth start has no disk re-walk after recovery.
      // Retain the path until a later poll starts it successfully.
      if (
        (retainOnFailure || this.pendingResumeOpens.has(localRel)) &&
        !this.stopped &&
        !this.bridges.has(localRel) &&
        this.scopeContains(localRel) &&
        !isIgnoredPath(localRel) &&
        fileKindForFile(localRel) === 'text'
      ) {
        this.pendingResumeOpens.add(localRel);
        if (this.status === 'active') this.status = 'starting';
      }
      if (error?.listingSuperseded || error?.localAppearedDuringStart) return;
      throw error;
    }
    if (this.bridges.get(localRel) !== bridge) return;
    bridge.started = true;
    if (
      this.lastCloudListing &&
      this.cloudListingIsCurrent(this.lastCloudListing) &&
      this.lastCloudListing.all.has(bridge.cloudPath)
    ) {
      bridge.cloudSeen = true;
      bridge.cloudMissingAt = 0;
      bridge.staleEmptyMaterialization = false;
      bridge.staleEmptyVersion = null;
    }
    this.syncedStamps.delete(localRel);
    this.syncedLocalVersions.delete(localRel);
    this.pendingResumeOpens.delete(localRel);
    this.progressFailedPaths.delete(localRel);
  }

  /** Re-share files rescued from an offline cloud-delete or opened during
   *  resume: skip anything reconciliation deleted; text reopens a bridge,
   *  blobs go through sha-diffed sync (their forgotten row + absent cloud
   *  twin reads as a fresh local blob → upload, i.e. local wins). Runs after
   *  ANY reconciliation pass — start()'s, or the deferred one in pollCloud. */
  async drainPendingResumeOpens() {
    const pending = [...this.pendingResumeOpens];
    for (const rel of pending) {
      if (this.stopped) return;
      const abs = resolveInRoot(this.project.root, rel);
      const exists = abs ? await fsp.stat(abs).then((stat) => stat.isFile()).catch(() => false) : false;
      if (!exists) {
        this.pendingResumeOpens.delete(rel);
        this.pendingDiskReconciles.delete(rel);
        continue;
      }
      await this.refreshProgressLocalPath(rel);
      if (this.progressSkipReason(rel)) {
        this.pendingResumeOpens.delete(rel);
        this.pendingDiskReconciles.delete(rel);
        continue;
      }
      if (this.isBlobPath(rel)) {
        try {
          await this.syncBlob(rel);
          // syncBlob retains its own retry marker on failure or an in-flight
          // collision. Remove this queue's marker only once that rail agrees.
          if (!this.pendingBlobSyncs.has(rel) && this.status !== 'error') {
            this.pendingResumeOpens.delete(rel);
          }
        } catch (error) {
          this.noteError(rel, error);
        }
      } else {
        // Keep unprocessed entries marked while this drain awaits: pollCloud
        // calls may overlap, and the marker protects local edits from their
        // cloud-delete sweep. ensureBridge removes it only after start wins.
        if (!this.scopeContains(rel) || isIgnoredPath(rel) || fileKindForFile(rel) !== 'text') {
          this.pendingResumeOpens.delete(rel);
          this.pendingDiskReconciles.delete(rel);
          continue;
        }
        if (this.pendingDiskReconciles.has(rel)) {
          const confirmedVersion = await this.reconcilePendingDisk(rel);
          if (confirmedVersion === null) continue;
          if (this.bridges.has(rel)) await this.dropBridge(rel);
          // bridge.stop() awaits socket/direct teardown. A raw local-agent
          // write can land in that window before its watcher callback; never
          // reopen from the just-verified (now stale) Y.Doc in that case.
          if (this.localFileVersion(rel) !== confirmedVersion) continue;
          this.pendingDiskReconciles.delete(rel);
          this.syncedStamps.delete(rel);
          this.syncedLocalVersions.delete(rel);
        }
        await this.ensureBridge(rel).catch((error) => this.noteError(rel, error));
      }
    }
  }

  async reconcilePendingDisk(localRel) {
    const documentName = `${this.project.id}/${localRel}`;
    const versionBefore = this.localFileVersion(localRel);
    const disk = await readTextFile(this.project.root, localRel).catch(() => null);
    const versionAfter = this.localFileVersion(localRel);
    if (versionBefore === null || versionBefore !== versionAfter || disk === null) return null;
    try {
      await this.docHost.handleDiskChange(this.project.id, localRel);
    } catch (error) {
      this.noteError(localRel, new Error(`disk-reconcile: ${error?.message || error}`));
      return null;
    }
    const confirmedBefore = this.localFileVersion(localRel);
    const confirmed = await readTextFile(this.project.root, localRel).catch(() => null);
    const confirmedAfter = this.localFileVersion(localRel);
    const liveText = this.docHost.getLiveText(this.project.id, localRel);
    if (
      confirmedBefore === null ||
      confirmedBefore !== confirmedAfter ||
      confirmed === null ||
      (liveText !== null && !this.docHost.hasObservedDiskText(documentName, confirmed.text))
    ) return null;
    return confirmedAfter;
  }

  /** A bridge may close only when losing it can't lose data or misread state:
   *  first sync done (bridge_files row), cloud row confirmed in a listing —
   *  otherwise its later absence would read as a cloud delete — and no local
   *  editor holds the doc open (live typing must relay instantly). */
  closableStamp(localRel, bridge) {
    if (!bridge.cloudSeen || !this.store.hasBridgeFile(this.share.id, localRel)) return null;
    if (this.pendingResumeOpens.has(localRel)) return null;
    if (!bridge.provider?.synced || bridge.provider.hasUnsyncedChanges) return null;
    if (this.docHost.hasPendingPersist(bridge.localDocName)) return null;
    if ((bridge.direct?.document?.connections?.size ?? 0) > 0) return null;
    return this.lastCloudListing?.stamps.get(bridge.cloudPath) ?? null;
  }

  localFileVersion(localRel) {
    return fileVersionSync(this.project.root, localRel);
  }

  localFileFingerprint(localRel) {
    return fileFingerprintSync(this.project.root, localRel);
  }

  async closeBridgeKeepingSynced(localRel, _stamp, expectedBridge = this.bridges.get(localRel)) {
    if (!expectedBridge || this.bridges.get(localRel) !== expectedBridge) return false;
    const versionBeforeRead = this.localFileVersion(localRel);
    const disk = await readTextFile(this.project.root, localRel).catch(() => null);
    const versionAfterRead = this.localFileVersion(localRel);
    if (this.bridges.get(localRel) !== expectedBridge) return false;
    if (
      versionBeforeRead === null ||
      versionBeforeRead !== versionAfterRead ||
      disk === null ||
      !this.docHost.hasObservedDiskText(expectedBridge.localDocName, disk.text)
    ) {
      // Raw disk bytes can arrive up to one watcher debounce before the live
      // Y.Doc sees them. Reconcile that source while the bridge is still open;
      // closing first would snapshot the unsynced edit as an agreed baseline.
      // Compare with DocHost's last observed raw bytes, not the serialized
      // Y.Doc: equivalent Markdown spellings intentionally remain noncanonical
      // on disk and can differ forever without representing an unsynced edit.
      if (disk !== null) {
        await this.docHost.handleDiskChange(this.project.id, localRel).catch(() => {});
      }
      return false;
    }
    const stamp = this.closableStamp(localRel, expectedBridge);
    if (stamp === null || this.bridges.get(localRel) !== expectedBridge) return false;
    this.syncedStamps.set(localRel, stamp);
    this.syncedLocalVersions.set(localRel, versionAfterRead);
    await this.dropBridge(localRel);
    return true;
  }

  /** Cap relief during large first shares: close the least-recently-active
   *  closable bridge (refreshing the listing so just-persisted cloud rows
   *  qualify) instead of erroring the share. */
  async closeIdlestBridge({ refreshIfNeeded = true } = {}) {
    let refreshed = false;
    const refresh = async () => {
      refreshed = true;
      this.capacityListingRefresh ??= this.fetchCloudPaths().finally(() => {
        this.capacityListingRefresh = null;
      });
      await this.capacityListingRefresh.catch(() => {});
    };
    if (
      refreshIfNeeded &&
      (!this.lastCloudListing || Date.now() - this.lastCloudListing.fetchedAt > CLOUD_POLL_MS)
    ) await refresh();
    const findVictim = () => {
      let victim = null;
      for (const [localRel, bridge] of this.bridges.entries()) {
        const stamp = this.closableStamp(localRel, bridge);
        if (stamp === null) continue;
        if (!victim || bridge.lastActivity < victim.bridge.lastActivity) victim = { localRel, bridge, stamp };
      }
      return victim;
    };
    let victim = findVictim();
    // The cached listing commonly predates first-upload rows. One fresh,
    // single-flight snapshot makes them immediately closable; if persistence
    // still lags, the pending-open queue safely retries on a later poll.
    if (!victim && !refreshed && refreshIfNeeded) {
      await refresh();
      victim = findVictim();
    }
    if (!victim) return false;
    return this.closeBridgeKeepingSynced(victim.localRel, victim.stamp, victim.bridge);
  }

  async dropBridge(localRel) {
    const bridge = this.bridges.get(localRel);
    if (!bridge) return;
    this.bridges.delete(localRel);
    await bridge.stop().catch(() => {});
    if (this.bridges.size === 0) this.destroySocket();
  }

  async cloudFetch(pathname, init = {}, { deferAuth = false } = {}) {
    const response = await fetch(`${this.share.api_origin}${pathname}`, {
      ...init,
      signal: init.signal ?? this.stopAbort.signal,
      headers: {
        Authorization: `Bearer ${this.share.token}`,
        // Only when we actually send JSON: a bodyless POST (the TUS create)
        // that claims `application/json` is rejected 400 by Supabase Storage
        // ("Body cannot be empty when content-type is set to application/json").
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers || {}),
      },
    });
    if (response.status === 401 || response.status === 403) {
      const message = `cloud token rejected (${response.status})`;
      if (!deferAuth) {
        this.status = 'error';
        this.authError = true;
        this.error = message;
      }
      throw Object.assign(new Error(message), { authRejected: true, status: response.status });
    }
    return response;
  }

  async fetchCloudPaths() {
    const generation = ++this.cloudListingRequestGeneration;
    this.cloudListingRequestsInFlight.add(generation);
    try {
      const response = await this.cloudFetch(
        `/api/workspace/local-agent/files?workspaceId=${this.share.workspace_id}`,
        {},
        { deferAuth: true },
      );
      if (!response.ok) throw new Error(`cloud files list failed status=${response.status}`);
      const body = await response.json();
      const cloudFiles = Array.isArray(body.files) ? body.files : [];
      const listing = {
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
        generation,
        files: cloudFiles,
      };
      // Completion order may differ from issue order. Publish the newest
      // COMPLETED response, never overwrite it with an older late arrival.
      if (generation < this.cloudListingPublishedGeneration) return this.lastCloudListing;
      for (const bridge of this.bridges.values()) {
        if (listing.all.has(bridge.cloudPath)) {
          bridge.cloudSeen = true;
          bridge.cloudMissingAt = 0;
          bridge.staleEmptyMaterialization = false;
          bridge.staleEmptyVersion = null;
        }
      }
      this.cloudListingPublishedGeneration = generation;
      this.lastCloudListing = listing;
      this.setProgressCloudFiles(cloudFiles);
      this.publishProgress();
      return listing;
    } catch (error) {
      if (generation < this.cloudListingPublishedGeneration) {
        if (this.lastCloudListing) return this.lastCloudListing;
        throw Object.assign(new Error('cloud listing request superseded'), { cause: error });
      }
      // A merely in-flight newer request is not authoritative yet. Abort this
      // caller instead of handing it cached paths that could drive a reopen or
      // delete after that newer request also fails.
      if (Array.from(this.cloudListingRequestsInFlight).some((candidate) => candidate > generation)) {
        throw Object.assign(new Error('cloud listing request superseded'), { cause: error });
      }
      if (error?.authRejected) this.noteError('cloud-list', error);
      throw error;
    } finally {
      this.cloudListingRequestsInFlight.delete(generation);
    }
  }

  cloudListingIsCurrent(listing) {
    return (
      this.lastCloudListing === listing &&
      listing.generation === this.cloudListingPublishedGeneration &&
      listing.generation === this.cloudListingRequestGeneration
    );
  }

  // ---- Doc comments (cloud backing store) ---------------------------------
  // Link guests comment on the BACKING workspace through the normal cloud
  // route; the local store never sees those rows. For share-covered paths the
  // sidecar therefore reads/writes cloud threads through the mirror route —
  // one store per conversation — and the poll below turns cloud-side changes
  // into the same `comments-changed` SSE the local store emits.

  supportsComments() {
    if (this.share.scope_kind === 'chat') return false;
    if (Date.now() < this.commentsParkedUntil) return false;
    return !this.isUnion || this.scopes.some((scope) => scope.scope_kind !== 'chat');
  }

  /** A cloud origin OLDER than the mirror route (an app server or deployment
   *  that predates it) answers 404 to the listing. Park mirroring for a
   *  cool-off instead of failing every poll forever: comments fall back to the
   *  local store — exactly how this share behaved before the mirror existed —
   *  and a cloud that gains the route recovers on the next probe with no
   *  sidecar restart. Logged once, on the first park, so a permanently old
   *  cloud costs one line rather than one per poll. */
  #parkComments() {
    if (!this.commentsParkedUntil) {
      this.log(
        `share ${this.share.id} comments: cloud has no comment mirror — comments stay local`,
      );
    }
    this.commentsParkedUntil = Date.now() + COMMENTS_PARK_MS;
  }

  /** Timeout + share-stop, whichever fires first. READS ONLY — aborting a
   *  non-idempotent write that the server already persisted would roll back
   *  the UI and invite a duplicating retry; mutations ride the share-stop
   *  signal like every other bridge write. */
  #commentsReadSignal() {
    return AbortSignal.any([AbortSignal.timeout(CLOUD_COMMENTS_TIMEOUT_MS), this.stopAbort.signal]);
  }

  /** Wire threads → LOCAL shape (local projectId + local rel paths,
   *  scope-filtered).
   *
   *  `rel` is the local file a PATH-SCOPED read asked for. The server answered
   *  for that file (matching by path OR file_id), so every thread it returned
   *  belongs there — including one still carrying its pre-rename path. Label
   *  those with the file the caller asked about: the UI's edit/delete/open
   *  actions key off `thread.filePath`, so a stale path aims them at a file
   *  that no longer exists. Mutation echoes pass no `rel` on purpose — there
   *  the mirror decides the authoritative path (it ignores a re-anchor onto a
   *  DIFFERENT file), and the caller must not overrule it. */
  #localizeCloudThreads(raw, rel = null) {
    return (Array.isArray(raw) ? raw : [])
      .map((thread) => ({
        ...thread,
        projectId: this.project.id,
        filePath: rel ?? this.cloudToLocal(String(thread.filePath || '')),
      }))
      .filter((thread) => this.scopeContains(thread.filePath));
  }

  /** Cloud threads translated to the LOCAL wire shape. `rel === null` lists
   *  the whole backing workspace and refreshes the id cache mutation routing
   *  reads.
   *
   *  A single-file share's "whole workspace" IS its one file, so it asks the
   *  server for that path instead: its cloudToLocal() maps EVERY cloud path
   *  onto the one local file, and an unfiltered listing would surface an
   *  unrelated backing-workspace thread as a comment on the shared file. The
   *  server scopes by path OR file_id, so a thread still anchored to the
   *  PRE-rename path comes back — a client-side path filter would instead hide
   *  the conversation with no visible thread left to mutate and re-anchor. */
  async fetchCloudComments(rel = null) {
    if (!this.supportsComments()) return [];
    // A single-file share's whole listing IS its one file.
    const localRel = rel ?? (this.share.scope_kind === 'file' ? this.share.scope_path : null);
    const cloudPath = localRel === null ? null : this.localToCloud(localRel);
    const qs = cloudPath === null ? '' : `&path=${encodeURIComponent(cloudPath)}`;
    const res = await this.cloudFetch(
      `/api/workspace/local-agent/comments/mirror?workspaceId=${this.share.workspace_id}${qs}`,
      { signal: this.#commentsReadSignal() },
    );
    // 404 means the ROUTE is absent (an older cloud): the GET handler itself
    // never 404s, so this is unambiguous — unlike a mutation, where 404 is the
    // ordinary "no such file/thread". Park quietly and keep the cache intact.
    if (res.status === 404) {
      this.#parkComments();
      return [];
    }
    if (!res.ok) throw new Error(`cloud comments list failed status=${res.status}`);
    const body = await res.json();
    const threads = this.#localizeCloudThreads(body.threads, localRel);
    // Full listings replace the cache (authoritative); file-scoped reads
    // upsert into it — a thread the panel just rendered must stay routable
    // for mutations without a second, possibly-timing-out full fetch.
    if (rel === null) {
      this.cloudComments = new Map(threads.map((thread) => [thread.id, thread]));
    } else {
      this.cloudComments ??= new Map();
      for (const thread of threads) this.cloudComments.set(thread.id, thread);
    }
    return threads;
  }

  /** POST/PATCH/DELETE against the mirror route. Payload paths are LOCAL rels
   *  (translated here); errors surface to the caller — a comment that cannot
   *  reach the shared store must fail visibly, not fork into a local-only
   *  copy the guests would never see. Returns the mirror's own echo (the
   *  mutated file's threads, localized) so the response path never depends on
   *  a SECOND cloud read that could time out and drop a persisted comment. */
  async mutateCloudComment(method, payload) {
    const body = { workspaceId: this.share.workspace_id, ...payload };
    if (typeof body.filePath === 'string') body.filePath = this.localToCloud(body.filePath);
    const res = await this.cloudFetch('/api/workspace/local-agent/comments/mirror', {
      method,
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error(parsed?.error || `cloud comment ${method} failed status=${res.status}`);
      // A 404 with NO json body is the framework's "no such route" (older
      // cloud); the mirror's own 404s ("File not found", "Comment thread not
      // found") always carry `{error}`. Park so the caller can degrade to the
      // local store instead of failing the comment — the poll that normally
      // parks first is skipped while a share is ops-parked.
      //
      // The verdict rides on THIS error, never on engine state: a concurrent
      // listing can park the engine while an unrelated failure (timeout, 500)
      // is in flight, and degrading that one to a local row would fork a
      // thread the cloud may already hold and still serve to link guests.
      if (res.status === 404 && !parsed) {
        this.#parkComments();
        error.commentsMirrorMissing = true;
      }
      throw error;
    }
    const threads = this.#localizeCloudThreads(parsed?.threads);
    // Keep the mutation-routing cache coherent: upsert the echoed threads and
    // drop the target if the echo no longer lists it (thread-body delete).
    if (this.cloudComments) {
      for (const thread of threads) this.cloudComments.set(thread.id, thread);
      if (payload.threadId && !threads.some((thread) => thread.id === payload.threadId)) {
        this.cloudComments.delete(payload.threadId);
      }
    }
    // `inserted` names OUR rows in the echoed listing (concurrent identical
    // writes make content-matching ambiguous); null from pre-`inserted`
    // mirrors — callers fall back.
    threads.inserted = parsed?.inserted ?? null;
    return threads;
  }

  /** Poll-driven change signal: refetch the backing workspace's threads and
   *  emit `comments-changed` when their fingerprint moves. Baselines silently
   *  on the first pass (reads merge live cloud data anyway). New messages
   *  observed after the baseline also flow to the manager's comment hook so a
   *  link GUEST's comment can wake local agents (owner-side posts trigger
   *  inline in /comments; the clientId dedup makes double-observes no-ops). */
  /** The delivery cursor is PERSISTED per share (bridge_comment_seen + a
   *  baseline flag in settings): a restart must not re-baseline over guest
   *  comments that arrived offline — they'd be skipped forever. */
  #loadCommentCursor() {
    if (this.commentsSeenMessageIds) return this.commentsSeenMessageIds;
    this.commentsSeenMessageIds = new Set(this.store.loadCommentSeen(this.share.id));
    this.commentsPollBaselined =
      this.store.getSetting(`comments_baselined:${this.share.id}`) === '1';
    return this.commentsSeenMessageIds;
  }

  #persistCommentSeen(messageIds) {
    if (messageIds.length) this.store.addCommentSeen(this.share.id, messageIds);
  }

  /** Inline (owner-side) deliveries mark their message ids so the next poll
   *  doesn't re-observe them as guest activity and fan them to watchers. Kept
   *  apart from the baseline flag: marking must never make a cold poll treat
   *  the whole backlog as deliverable. */
  markCommentMessageSeen(messageId) {
    if (!messageId) return;
    this.#loadCommentCursor().add(messageId);
    this.#persistCommentSeen([messageId]);
  }

  async pollCloudComments() {
    if (!this.supportsComments()) return;
    // The delivery cursor is POLL-OWNED: `cloudComments` is also updated by
    // ordinary panel reads, which would silently consume pending deliveries.
    // A stable id set also survives delete-then-add cycles counts miss.
    const seen = this.#loadCommentCursor();
    const baselined = this.commentsPollBaselined === true;
    const threads = await this.fetchCloudComments(null);
    // Parked mid-fetch (older cloud): the empty result is "we stopped asking",
    // not "the guests deleted every thread" — don't fire a change for it.
    if (!this.supportsComments()) return;
    // Baselined only once a fetch SUCCEEDED and seeded the seen set — a
    // failed first poll must not turn the next one into a backlog flood.
    this.commentsPollBaselined = true;
    this.store.setSetting(`comments_baselined:${this.share.id}`, '1');
    const fingerprint = threads
      .map((t) => `${t.id}:${t.updatedAt}:${t.status}:${t.messages.length}`)
      .sort()
      .join('|');
    const previous = this.commentsFingerprint;
    this.commentsFingerprint = fingerprint;
    if (previous !== undefined && previous !== fingerprint) {
      this.manager.emitCommentsChanged(this.project.id);
    }
    const newlySeen = [];
    for (const thread of threads) {
      for (const message of thread.messages) {
        if (seen.has(message.id)) continue;
        if (baselined && this.manager.onCloudCommentMessage) {
          // Advance the cursor ONLY on a handled delivery — a transient store
          // failure must retry next poll (clientId dedupe absorbs replays),
          // not skip the comment forever.
          let handled = false;
          try {
            handled =
              this.manager.onCloudCommentMessage(this.project.id, {
                thread,
                message,
                isNewThread: thread.messages[0]?.id === message.id,
              }) !== false;
          } catch (error) {
            this.log(`cloud comment hook failed thread=${thread.id} error=${error?.message}`);
          }
          if (!handled) continue;
        }
        seen.add(message.id);
        newlySeen.push(message.id);
      }
    }
    this.#persistCommentSeen(newlySeen);
  }

  // ---- Blob sync (images & other binaries) --------------------------------
  // No Y.Docs: whole files, content-addressed. Reuses the shared bridge_files
  // ledger so delete/rename propagation and offline reconciliation treat blobs
  // exactly like text files; blob_sync records the last sha both sides agreed
  // on, which is what turns "different" into a direction (upload vs download).

  isBlobPath(rel) {
    return this.scopeContains(rel) && !isIgnoredPath(rel) && fileKindForFile(rel) === 'blob';
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
  async syncBlob(localRel, cloudSha = undefined, { rehash = false, listingStillCurrent = null } = {}) {
    if (
      this.stopped ||
      this.status === 'error' ||
      !this.isBlobPath(localRel)
    ) return;
    if (listingStillCurrent && !listingStillCurrent()) return;
    if (this.blobBusy.has(localRel)) {
      // A transfer is mid-flight — don't drop this trigger's intent (e.g. a
      // local edit during a download); the next poll re-reconciles it.
      this.pendingBlobSyncs.add(localRel);
      if (this.status === 'active') this.status = 'starting';
      return;
    }
    this.blobBusy.add(localRel);
    // Queued until proven in sync — any throw below leaves it for the next poll.
    this.pendingBlobSyncs.add(localRel);
    if (this.status === 'active') this.status = 'starting';
    try {
      if (cloudSha === undefined) {
        // Local-event path (watcher edit, rename, deferred retry): never
        // decide against the cached listing — a cloud delete since the last
        // poll would read as a stale sha and the upload would resurrect the
        // deleted file. A FRESH listing lets delete-wins see the absence.
        // (Poll/first-sync callers pass their own snapshot's sha explicitly.)
        const listing = await this.fetchCloudPaths();
        if (listingStillCurrent && !listingStillCurrent()) return;
        const cloudPath = this.localToCloud(localRel);
        cloudSha = listing.blobShas.get(cloudPath) ?? (listing.all.has(cloudPath) ? '' : null);
      }
      const synced = this.store.getBlobSync(this.share.id, localRel)?.sha ?? null;
      const local = await this.localBlobState(localRel, { rehash });
      if (listingStillCurrent && !listingStillCurrent()) return;
      if (local.tooLarge) {
        if (!this.loggedBlobSkips.has(localRel)) {
          this.loggedBlobSkips.add(localRel);
          this.log(`blob skip (over ${BLOB_SYNC_MAX_BYTES} bytes) file=${logPath(localRel)}`);
        }
        // A previously synced blob rewritten past the cap becomes local-only:
        // remove the (now stale) cloud twin, then drop bridge state. Leaving
        // either behind loses data — a lingering bridge row lets a cloud
        // delete sweep reap the newer local file, and a lingering cloud row
        // would resurrect a later local delete. A failed cloud delete throws,
        // leaving this queued for the next poll.
        if (this.store.hasBridgeFile(this.share.id, localRel)) {
          await this.unbridgeOversized(localRel);
          this.log(`blob unbridged (grew over cap, now local-only) file=${logPath(localRel)}`);
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
      if (!this.pendingBlobSyncs.has(localRel)) this.progressFailedPaths.delete(localRel);
    }
  }

  /** One-shot upload straight to storage via a server-signed URL — the
   *  primary blob path. The cloud picks the content-addressed key and signs
   *  it; the bytes never transit the app server, so the platform's request
   *  body cap (~4.5 MB on Vercel, which 413'd a real user's main.pdf at
   *  offset 0) does not apply. Returns 'done', or 'unsupported' when the
   *  cloud predates the sign route (the TUS fallback handles those). */
  async uploadBlobDirect({ workspaceId, sha, mime, bytes }) {
    const sign = await this.cloudFetch('/api/workspace/uploads/sign', {
      method: 'POST',
      body: JSON.stringify({ projectId: workspaceId, sha }),
    });
    if (sign.status === 404 || sign.status === 405) return 'unsupported';
    if (!sign.ok) throw new Error(`blob upload sign failed status=${sign.status}`);
    const { url, exists } = await sign.json();
    if (exists) return 'done'; // same sha already in storage — nothing to upload
    if (!url) throw new Error('blob upload sign returned no url');
    // No x-upsert: the sign route only ever hands out a non-upserting URL for
    // a key it just proved absent, so a same-sha race lands as a 409 instead
    // of silently overwriting another workspace's blob.
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': mime },
      body: bytes,
      signal: this.stopAbort.signal,
    });
    if (!put.ok) throw new Error(`blob upload failed status=${put.status} (direct)`);
    return 'done';
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
    if (!exists && (await this.uploadBlobDirect({ workspaceId, sha, mime, bytes })) === 'unsupported') {
      // Older cloud without the sign route: the TUS proxy fallback. It only
      // carries blobs under the platform's request-body cap (~4.5 MB on
      // Vercel) — Supabase's TUS needs >=5 MiB non-final chunks, so bigger
      // blobs cannot ride a proxied PATCH at all; the direct path above is
      // how they upload.
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
        // Carry the upstream reason: a bare status here cost a whole
        // investigation once (the create was 400ing on a stray content-type).
        const detail = await create.text().catch(() => '');
        throw new Error(`blob upload create failed status=${create.status} ${detail.slice(0, 200)}`.trim());
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
      this.log(`blob upload superseded by local delete file=${logPath(localRel)}`);
      await this.handleLocalFileEvent(localRel);
      return;
    }
    if (current.sha !== sha) {
      this.pendingBlobSyncs.add(localRel);
      this.log(`blob rewritten mid-upload, requeued file=${logPath(localRel)}`);
      return;
    }
    this.store.recordBlobSync(this.share.id, localRel, {
      sha,
      mtimeMs: Math.trunc(current.stat.mtimeMs),
      size: current.stat.size,
    });
    this.log(`blob up file=${logPath(localRel)} sha=${sha.slice(0, 8)}`);
  }

  /** `basedOnLocalSha` is the local content the download decision was judged
   *  against (null = no local file existed) — re-checked right before the
   *  write so a local edit racing the transfer is never overwritten. */
  /** True when this cloud path cannot exist on the local filesystem (Windows
   *  reserved names, forbidden characters): skip the download LOUDLY once
   *  instead of erroring on every poll. Upload-side never hits this — the
   *  file could not have existed locally to begin with. */
  skipUnwritableLocally(localRel) {
    if (process.platform !== 'win32') return false;
    const reason = windowsUnwritableReason(localRel);
    if (!reason) return false;
    if (!this.unwritableLogged) this.unwritableLogged = new Set();
    if (!this.unwritableLogged.has(localRel)) {
      this.unwritableLogged.add(localRel);
      // Keyed (file=), like every other path this logs: the diagnostics sink
      // redacts path VALUES, and a bare name in prose would ship as-is.
      this.log(`share ${this.share.id} skip download file=${logPath(localRel)} reason=${reason} (rename it in the workspace to sync it here)`);
    }
    return true;
  }

  async downloadBlob(localRel, expectedSha, basedOnLocalSha = null) {
    if (this.skipUnwritableLocally(localRel)) return;
    if (this.skippedBlobDownloads.get(localRel) === (expectedSha ?? '')) return;
    const skipOversized = () => {
      this.skippedBlobDownloads.set(localRel, expectedSha ?? '');
      if (!this.loggedBlobSkips.has(localRel)) {
        this.loggedBlobSkips.add(localRel);
        this.log(`blob skip download (over ${BLOB_SYNC_MAX_BYTES} bytes) file=${logPath(localRel)}`);
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
      this.log(`blob download aborted (local changed mid-transfer) file=${logPath(localRel)}`);
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
    await this.refreshProgressLocalPath(localRel);
    this.scheduleProgressPublish();
    this.manager.emitFilesChanged(this.project.id, localRel);
    this.log(`blob down file=${logPath(localRel)} sha=${sha.slice(0, 8)}${expectedSha && sha !== expectedSha ? ' (listing was stale)' : ''}`);
  }

  /** `kind` is the verb (create/delete/move…), `path` the cloud path it acts
   *  on — split so the log can key the path under a name the diagnostics sink
   *  redacts, while the verb still ships. The share's error string, which the
   *  UI shows, keeps the old "<kind> <path>" wording. */
  queueCloudOp(kind, path, run) {
    const label = `${kind} ${path}`;
    this.pendingCloudOps.push({ label, run });
    this.opsParked = true;
    this.status = 'error';
    this.error = `cloud sync operation failed: ${label} (retrying)`;
    this.log(`share ${this.share.id} queued retry op=${kind} path=${logPath(path)}`);
    this.publishProgress({ force: true });
  }

  async flushPendingCloudOps() {
    if (this.pendingCloudOps.length > 0) {
      // IN ORDER, stopping at the first failure: queued ops are causally
      // ordered (a chained rename docs→papers→library queues two moves whose
      // second only makes sense after the first) — running later ops past a
      // failed earlier one would apply them against the wrong cloud state
      // (the second move's 404 would read as "already moved" and clear its
      // durable marker while the files sit at the intermediate path).
      const remaining = [];
      for (const op of this.pendingCloudOps) {
        if (remaining.length > 0) {
          remaining.push(op);
          continue;
        }
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
      this.status = this.hasOpenBacklog() ? 'starting' : 'active';
      this.error = null;
      // Bridging was blocked while parked — pick up local scope files now.
      const local = (await walkProject(this.project.root)).filter(
        (file) => (file.type === 'text' || file.type === 'blob') && this.scopeContains(file.path),
      );
      await this.bridgeAll(local);
    }
  }

  async pollCloud() {
    if (this.pollInFlight) return this.pollInFlight;
    const poll = this.pollCloudPass();
    this.pollInFlight = poll;
    try {
      return await poll;
    } catch (error) {
      // Record the failure BEFORE the finally heartbeat. Otherwise a cached
      // successful inventory can publish up_to_date while every new listing
      // is failing; cloud-report failure itself never enters this method.
      this.noteError('cloud-poll', error);
      return undefined;
    } finally {
      if (this.pollInFlight === poll) this.pollInFlight = null;
      this.publishProgress({ heartbeat: true });
    }
  }

  async pollCloudPass() {
    if (this.stopped || !this.share.api_origin) return;
    const errorRevisionAtStart = this.errorRevision;
    // A failed cloud mutation intentionally parks the share as `error`, but
    // its retry queue must still run; auth/recovery errors without queued
    // operations remain parked.
    if (this.opsParked) await this.flushPendingCloudOps();
    if (this.stopped) return;
    if (this.status === 'error') {
      // Parked share: file sync must not act on a cloud it can't trust, but
      // the side channels stay live — a doc-level auth park must not stop
      // ledger shipping or comment mirroring (each has its own park logic).
      await this.syncLedger();
      await this.pollCloudComments().catch((error) => {
        this.log(`share ${this.share.id} comments-poll: ${error?.message || error}`);
      });
      return;
    }
    // Still parked (a queued delete/move hasn't landed): the cloud is in a
    // state the queued ops haven't caught up with — pulling files or sweeping
    // deletes against it would act on exactly the paths those ops own.
    if (this.opsParked) return;
    const cloudPaths = await this.fetchCloudPaths();
    // A later-issued listing may already be in flight. This response can be
    // useful as a cache, but must not drive cloud-positive opens/downloads:
    // the newer response may be observing a deletion of one of these rows.
    if (!this.cloudListingIsCurrent(cloudPaths)) return;
    const { text: cloudTextPaths, stamps: cloudStamps } = cloudPaths;
    let deletionListing = cloudPaths;
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
      const listingStillCurrent = () => this.cloudListingIsCurrent(cloudPaths);
      const reconciled = await this.reconcileOfflineDeletes(
        pending,
        cloudPaths,
        listingStillCurrent,
      );
      if (reconciled === null) {
        this.deferredResume = pending;
        return;
      }
      const deferred = await this.bridgeAll(reconciled, { listingStillCurrent });
      if (deferred.length > 0) {
        this.deferredResume = deferred;
        return;
      }
      // First successful listing after a start()-time outage: reconciliation
      // has now really run, so lift the resume latch and replay everything
      // queued since bind (start() only drains after an immediate one).
      this.resuming = false;
      await this.drainPendingResumeOpens();
      listingStale = true;
    }
    for (const cloudPath of cloudTextPaths) {
      if (!this.cloudListingIsCurrent(cloudPaths)) return;
      const localRel = this.cloudToLocal(cloudPath);
      if (this.share.scope_kind === 'file' && cloudPath !== this.localToCloud(this.share.scope_path)) continue;
      // Union shares: cloud files outside every scope (e.g. under a since-
      // removed scope) never materialize locally.
      if (!this.scopeContains(localRel)) continue;
      if (isIgnoredPath(localRel) || fileKindForFile(localRel) !== 'text') continue;
      if (this.progressSkipReason(localRel)) continue;
      if (this.skipUnwritableLocally(localRel)) continue;
      const bridge = this.bridges.get(localRel);
      if (bridge) {
        bridge.cloudSeen = true;
        bridge.cloudMissingAt = 0;
        bridge.staleEmptyMaterialization = false;
        bridge.staleEmptyVersion = null;
        continue;
      }
      const synced = this.store.hasBridgeFile(this.share.id, localRel);
      // Synced file with a closed idle bridge: reopen only when the cloud row
      // moved past the stamp recorded at close (a collaborator edited it).
      if (synced && this.syncedStamps.get(localRel) === cloudStamps.get(cloudPath)) continue;
      await this.ensureBridge(localRel, {
        retainOnFailure: false,
        listingStillCurrent: () => this.cloudListingIsCurrent(cloudPaths),
      }).catch((error) => this.noteError(localRel, error));
      if (!this.cloudListingIsCurrent(cloudPaths)) return;
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
      if (!this.cloudListingIsCurrent(cloudPaths)) return;
      const localRel = this.cloudToLocal(cloudPath);
      if (this.share.scope_kind === 'file' && cloudPath !== this.localToCloud(this.share.scope_path)) continue;
      if (!this.isBlobPath(localRel)) continue;
      if (this.progressSkipReason(localRel)) continue;
      await this.syncBlob(localRel, sha, {
        listingStillCurrent: () => this.cloudListingIsCurrent(cloudPaths),
      }).catch((error) => this.noteError(localRel, error));
      if (!this.cloudListingIsCurrent(cloudPaths)) return;
    }
    if (this.pendingBlobSyncs.size > 0) {
      // ONE fresh snapshot for the whole drain: entries were queued by local
      // events/races at unknown times, so the poll-start listing may predate
      // a cloud delete (uploading against its stale sha would resurrect the
      // file) — while the undefined fallback would fan out a listing fetch
      // per path. Refetch failure falls back to the poll snapshot; the
      // transfer itself would fail on such a network anyway and requeue.
      const retryListing = await this.fetchCloudPaths().catch(() => null);
      if (!retryListing || !this.cloudListingIsCurrent(retryListing)) return;
      for (const localRel of Array.from(this.pendingBlobSyncs)) {
        if (!this.cloudListingIsCurrent(retryListing)) return;
        await this.syncBlob(localRel, this.cachedCloudSha(localRel), {
          listingStillCurrent: () => this.cloudListingIsCurrent(retryListing),
        }).catch((error) => this.noteError(localRel, error));
        if (!this.cloudListingIsCurrent(retryListing)) return;
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
      if (!refreshed || !this.cloudListingIsCurrent(refreshed)) return;
      deletionListing = refreshed;
      cloudAllPaths = refreshed.all;
    }

    // Listing fetches also happen outside pollCloud (blob edits and cap
    // relief). If one completes while this pass is working, absence in this
    // older snapshot is no longer authoritative enough to delete local data.
    // Re-check after every awaited bridge teardown as well.
    const deletionListingIsCurrent = () => this.cloudListingIsCurrent(deletionListing);
    let deletionListingSuperseded = !deletionListingIsCurrent();

    // A bridged file that HAD been seen in the cloud and is now absent from
    // the ENTIRE cloud listing was deleted by a collaborator → mirror locally.
    for (const [localRel, bridge] of Array.from(this.bridges.entries())) {
      if (this.stopped) return; // stop() mid-poll: no disk deletes during shutdown
      if (deletionListingSuperseded || !deletionListingIsCurrent()) {
        deletionListingSuperseded = true;
        break;
      }
      if (this.progressSkipReason(localRel)) continue;
      if (!bridge.cloudSeen || cloudAllPaths.has(bridge.cloudPath)) {
        if (cloudAllPaths.has(bridge.cloudPath)) bridge.cloudMissingAt = 0;
        continue;
      }
      // First-sync bridges are not deletable until start() records a durable
      // agreement. Otherwise a listing that predates their cloud persist can
      // erase the local source file while the provider is still starting.
      if (!this.store.hasBridgeFile(this.share.id, localRel)) continue;
      // A cloud absence racing an update that has not reached Hocuspocus yet
      // is not authoritative enough to erase the local edit.
      if (!bridge.cloudMissingAt) {
        bridge.cloudMissingAt = Date.now();
        continue;
      }
      // Give the disk watcher + local DocHost time to ingest bytes written just
      // before this listing. `synced=false` can be the expected result of a
      // real cloud delete closing the provider, so the durable safety signals
      // are an acknowledged provider, a quiescent local persist, and a second
      // absent listing after the watcher debounce window.
      if (Date.now() - bridge.cloudMissingAt < Math.max(1_000, this.docHost.persistDebounceMs * 2)) continue;
      if (bridge.provider?.hasUnsyncedChanges || this.docHost.hasPendingPersist(bridge.localDocName)) continue;
      if (this.pendingResumeOpens.has(localRel)) continue;
      // The loop is a bridge-map snapshot. A prior await may have rotated
      // this path already; never tear down the replacement by key.
      if (this.bridges.get(localRel) !== bridge) continue;
      const versionBeforeRead = this.localFileVersion(localRel);
      const disk = await readTextFile(this.project.root, localRel).catch(() => null);
      const versionAfterRead = this.localFileVersion(localRel);
      if (
        versionAfterRead !== null &&
        (
          versionBeforeRead !== versionAfterRead ||
          disk === null ||
          !this.docHost.hasObservedDiskText(bridge.localDocName, disk.text)
        )
      ) {
        // Raw bytes can precede the debounced watcher callback. The active
        // delete rail must not snapshot those bytes as an agreed baseline and
        // unlink them; ingest/re-share them as explicit local intent instead.
        this.retainLocalIntent(localRel);
        this.pendingDiskReconciles.add(localRel);
        bridge.cloudMissingAt = 0;
        continue;
      }
      const versionBeforeDrop = this.localFileVersion(localRel);
      await this.dropBridge(localRel);
      if (this.stopped) return;
      const fingerprintAfterDrop = this.localFileFingerprint(localRel);
      const versionAfterDrop = fingerprintAfterDrop?.version ?? null;
      const editedDuringDrop = versionAfterDrop !== null && versionAfterDrop !== versionBeforeDrop;
      const hasReplacement = this.bridges.has(localRel);
      const unchangedStaleEmpty =
        bridge.staleEmptyMaterialization &&
        bridge.staleEmptyVersion !== null &&
        versionBeforeDrop === bridge.staleEmptyVersion &&
        versionAfterDrop === bridge.staleEmptyVersion;
      if (editedDuringDrop && !hasReplacement) {
        // The watcher/open callback may still be queued behind this promise
        // continuation. Preserve the bytes now and make the local edit win.
        this.pendingResumeOpens.add(localRel);
        if (this.status === 'active') this.status = 'starting';
      }
      const locallyReopened = editedDuringDrop || this.pendingResumeOpens.has(localRel) || hasReplacement;
      if (!deletionListingIsCurrent() || locallyReopened) {
        // Leave the durable bridge row + local file intact. The next current
        // poll will reopen it if present or apply the confirmed delete.
        this.syncedStamps.delete(localRel);
        this.syncedLocalVersions.delete(localRel);
        if (!deletionListingIsCurrent()) {
          deletionListingSuperseded = true;
          break;
        }
        continue;
      }
      if (this.share.scope_kind === 'file' && !unchangedStaleEmpty) {
        // A single-file share can't distinguish a cloud delete from a cloud
        // RENAME (the share is pinned to one basename) — deleting the local
        // file on absence would turn a rename into data loss. Keep the file
        // and park the share with a visible error instead.
        this.status = 'error';
        this.error = `cloud file "${bridge.cloudPath}" was removed or renamed. Sharing stopped, local file kept.`;
        this.log(`file-share cloud path gone file=${logPath(localRel)}; share parked`);
        continue;
      }
      await deleteFile(this.project.root, localRel).catch(() => {});
      await this.refreshProgressLocalPath(localRel);
      this.store.forgetBridgeFile(this.share.id, localRel);
      this.store.recordEdit({ projectId: this.project.id, path: localRel, actor: 'remote', contentText: null });
      await this.docHost.handleDiskChange(this.project.id, localRel).catch(() => {});
      this.manager.emitFilesChanged(this.project.id, localRel);
      this.log(`bridge cloud-delete file=${logPath(localRel)}`);
    }

    // Synced files whose idle bridges CLOSED see collaborator deletes here:
    // bridges only close after their cloud row was confirmed in a listing, so
    // absence from the whole listing is a genuine cloud-side delete.
    for (const localRel of deletionListingSuperseded ? [] : this.store.listBridgeFiles(this.share.id)) {
      if (this.stopped) return; // stop() mid-poll: no disk deletes during shutdown
      if (!deletionListingIsCurrent()) break;
      if (this.bridges.has(localRel) || !this.scopeContains(localRel)) continue;
      if (this.progressSkipReason(localRel)) continue;
      if (cloudAllPaths.has(this.localToCloud(localRel))) continue;
      if (this.share.scope_kind === 'file') {
        this.status = 'error';
        this.error = `cloud file "${this.localToCloud(localRel)}" was removed or renamed. Sharing stopped, local file kept.`;
        this.log(`file-share cloud path gone file=${logPath(localRel)}; share parked`);
        continue;
      }
      // A local edit/open that could not get a live slot is queued to
      // re-share. It wins over a concurrent cloud delete, just like the
      // startup reconciliation rescue path above; deleting here would erase
      // the edit before the queue can drain.
      if (this.pendingResumeOpens.has(localRel)) {
        this.log(`bridge cloud-delete skipped (local file queued to re-share) file=${logPath(localRel)}`);
        continue;
      }
      const closedVersion = this.syncedLocalVersions.get(localRel);
      const currentFingerprint = this.localFileFingerprint(localRel);
      const currentVersion = currentFingerprint?.version ?? null;
      if (closedVersion !== undefined && currentVersion !== null && currentVersion !== closedVersion) {
        this.pendingResumeOpens.add(localRel);
        if (this.status === 'active') this.status = 'starting';
        this.log(`bridge cloud-delete skipped (idle local file changed, re-sharing) file=${logPath(localRel)}`);
        continue;
      }
      await deleteFile(this.project.root, localRel).catch(() => {});
      await this.refreshProgressLocalPath(localRel);
      this.syncedStamps.delete(localRel);
      this.syncedLocalVersions.delete(localRel);
      this.store.forgetBridgeFile(this.share.id, localRel);
      this.store.recordEdit({ projectId: this.project.id, path: localRel, actor: 'remote', contentText: null });
      await this.docHost.handleDiskChange(this.project.id, localRel).catch(() => {});
      this.manager.emitFilesChanged(this.project.id, localRel);
      this.log(`bridge cloud-delete file=${logPath(localRel)} (idle)`);
    }

    // Rescued files whose re-share failed transiently requeued themselves —
    // retry each poll. AFTER the delete sweeps: an upload here lands past the
    // listing this poll swept against, so it can't be misread as deleted.
    if (!this.resuming && this.pendingResumeOpens.size) await this.drainPendingResumeOpens();

    // Idle sweep: a closed bridge costs nothing and reopens on demand (local
    // edit/editor connect via events, cloud edit via the stamp check above).
    const now = Date.now();
    for (const [localRel, bridge] of Array.from(this.bridges.entries())) {
      if (this.bridges.get(localRel) !== bridge) continue;
      if (now - bridge.lastActivity < BRIDGE_IDLE_MS) continue;
      const stamp = this.closableStamp(localRel, bridge);
      if (stamp !== null) await this.closeBridgeKeepingSynced(localRel, stamp, bridge);
    }

    // The startup walk and watcher activation overlap. Verify disk again only
    // after a complete cloud pass so an event that arrived before the progress
    // inventory existed cannot make the first report claim up_to_date.
    await this.verifyProgressInventory();

    // A full poll pass succeeded: a lingering transient error (cloud-list
    // outage, per-file timeout) is over — clear it so the UI stops warning.
    // Parked states (status 'error') stay until a token refresh / re-share,
    // and ledger errors are owned by syncLedger below (clearing here would
    // flick a still-broken ledger's error off and on every poll).
    let shareHealthChanged = false;
    if (!this.hasOpenBacklog() && this.status === 'starting') {
      this.status = 'active';
      shareHealthChanged = true;
    }
    if (
      this.error &&
      this.status === 'active' &&
      !this.error.startsWith('ledger-sync') &&
      this.errorRevision === errorRevisionAtStart
    ) {
      this.error = null;
      shareHealthChanged = true;
    }
    if (shareHealthChanged) this.manager.emitSharesChanged(this.project.id);

    // Ship new granular ledger rows (edit attribution, chats, decisions) to
    // the cloud mirror — LAST: it's a side channel, and a large retained
    // backlog must never delay the document/file sync above. Non-fatal and
    // log-only: a failed upload retries next poll (cursors only advance on
    // ack), and a rejected side channel must not flash the trust-critical
    // sync-error UI (noteError would park the share on a 401/403 message).
    // Single-flight: setInterval overlaps a slow pass with the next poll, and
    // a concurrent pass would read a chat-version reservation as a change and
    // mint a duplicate snapshot.
    await this.syncLedger();

    // Cloud-side comment changes (guest threads/replies on the backing
    // workspace) become local SSE. Side channel like the ledger: log-only —
    // a failed listing must never park document sync.
    await this.pollCloudComments().catch((error) => {
      this.log(`share ${this.share.id} comments-poll: ${error?.message || error}`);
    });
  }

  async syncLedger() {
    if (this.stopped || this.ledgerSyncInFlight) return;
    this.ledgerSyncInFlight = true;
    try {
      await syncShareLedger(this);
      // For chat-bearing shares the ledger is (part of) the sync — a full
      // pass clears any lingering transient error (mirrors pollCloud's
      // recovery).
      if (this.ledgerCritical && this.error && this.status === 'active') {
        this.error = null;
        this.manager.emitSharesChanged(this.project.id);
      }
    } catch (error) {
      // Path-only shares: the ledger is a side channel — a rejected upload
      // must never park document sync that is otherwise working (log only).
      // Any CHAT scope makes it trust-critical: surface the failure
      // (noteError parks the share on auth rejections; a token refresh
      // revives it).
      if (this.ledgerCritical) this.noteError('ledger-sync', error);
      else this.log(`share ${this.share.id} ledger-sync: ${error?.message || error}`);
    } finally {
      this.ledgerSyncInFlight = false;
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

  /** Disk absence proves nothing for a path whose first materialization is
   *  still in flight (bridge starting, or its persist scheduled but not yet
   *  written) — condemning it as a local delete would delete the cloud
   *  original. A skipped real delete converges: the persist rewrites the
   *  file and the next delete event finds no pending work. */
  materializationPending(rel) {
    const bridge = this.bridges.get(rel);
    if (bridge && !bridge.started) return true;
    return this.docHost.hasPendingPersist(`${this.project.id}/${rel}`);
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
    // Env-secret files never sync (isIgnoredPath covers every rail), but a
    // silent skip would read as a bug to whoever just saved the file — say
    // it once per path, with the supported alternative.
    if (isEnvSecretPath(localRel) && this.scopeContains(localRel)) {
      if (!this.envSkipLogged) this.envSkipLogged = new Set();
      if (!this.envSkipLogged.has(localRel)) {
        this.envSkipLogged.add(localRel);
        this.log(`share ${this.share.id} secrets stay local file=${logPath(localRel)} (never synced; use workspace secrets to share configuration)`);
      }
      return;
    }
    const trackProgress = this.scopeContains(localRel) && !isIgnoredPath(localRel);
    if (trackProgress) {
      this.progressDirtyPaths.add(localRel);
      await this.refreshProgressLocalPath(localRel);
      this.scheduleProgressPublish();
    }
    try {
      const abs = resolveInRoot(this.project.root, localRel);
      const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
      if (stat?.isFile()) {
        if (syncSkipReason(this.progressLocalFiles?.get(localRel), { blobMaxBytes: BLOB_SYNC_MAX_BYTES })) {
          await this.unbridgeOversized(localRel);
          this.pendingResumeOpens.delete(localRel);
          this.pendingBlobSyncs.delete(localRel);
          if (!this.loggedProgressSkips) this.loggedProgressSkips = new Set();
          if (!this.loggedProgressSkips.has(localRel)) {
            this.loggedProgressSkips.add(localRel);
            this.log(`share ${this.share.id} sync skipped by size policy file=${logPath(localRel)}`);
          }
          return;
        }
        if (fileKindForFile(localRel) === 'blob') {
          // A watcher event means the bytes really moved — bypass the stat cache
          // (same-size rewrites can share its mtime bucket).
          await this.syncBlob(localRel, undefined, { rehash: true }).catch((error) => this.noteError(localRel, error));
          return;
        }
        if (this.scopeContains(localRel)) {
          const bridge = this.bridges.get(localRel);
          if (bridge && !bridge.started) {
            this.retainLocalIntent(localRel);
          } else if (!bridge) {
            await this.ensureBridge(localRel).catch((error) => this.noteError(localRel, error));
          }
        }
        return;
      }
      if (stat?.isDirectory()) {
        // A tree delete can preserve the folder (protected children stay) —
        // sweep bridged descendants whose own files are gone.
        for (const rel of this.bridgedUnder(localRel)) {
          if (rel === localRel) continue;
          if (this.materializationPending(rel)) continue;
          const relAbs = resolveInRoot(this.project.root, rel);
          const relStat = relAbs ? await fsp.stat(relAbs).catch(() => null) : null;
          if (relStat) continue;
          await this.refreshProgressLocalPath(rel);
          await this.dropBridge(rel);
          const cloudPath = this.localToCloud(rel);
          const run = async () => {
            await this.cloudDelete(cloudPath);
            this.store.forgetBridgeFile(this.share.id, rel);
          };
          try {
            await run();
          } catch {
            this.queueCloudOp('delete', cloudPath, run);
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
        if (this.materializationPending(rel)) continue;
        await this.dropBridge(rel);
        const cloudPath = this.localToCloud(rel);
        const run = async () => {
          await this.cloudDelete(cloudPath);
          this.store.forgetBridgeFile(this.share.id, rel);
        };
        try {
          await run();
        } catch {
          this.queueCloudOp('delete', cloudPath, run);
        }
      }
    } finally {
      if (trackProgress) {
        await this.refreshProgressLocalPath(localRel);
        this.progressDirtyPaths.delete(localRel);
        this.scheduleProgressPublish();
      }
    }
  }

  async handleLocalRename(fromRel, toRel) {
    const fromIn = this.scopeContains(fromRel);
    const toIn = this.scopeContains(toRel);
    if (!fromIn && !toIn) return;
    const progressPaths = [fromIn ? fromRel : null, toIn ? toRel : null].filter(Boolean);
    for (const path of progressPaths) this.progressDirtyPaths.add(path);
    await this.refreshProgressLocalPath(fromRel);
    await this.refreshProgressLocalPath(toRel);
    this.scheduleProgressPublish();
    try {
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
          this.queueCloudOp('move', `${this.localToCloud(fromRel)} -> ${this.localToCloud(toRel)}`, move);
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
            this.queueCloudOp('delete', cloudPath, run);
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
        await this.refreshProgressLocalPath(toRel);
        if (!this.progressSkipReason(toRel)) {
          await (fileKindForFile(toRel) === 'blob' ? this.syncBlob(toRel) : this.ensureBridge(toRel)).catch(
            (error) => this.noteError(toRel, error),
          );
        }
      } else if (toStat?.isDirectory()) {
        const files = (await walkProject(this.project.root)).filter(
          (file) =>
            (file.type === 'text' || file.type === 'blob') &&
            (file.path === toRel || file.path.startsWith(`${toRel}/`)),
        );
        if (this.progressLocalFiles) {
          for (const file of files) this.progressLocalFiles.set(file.path, file);
        }
        await this.bridgeAll(files);
      }
    } finally {
      for (const path of progressPaths) this.progressDirtyPaths.delete(path);
      this.scheduleProgressPublish();
    }
  }

  async stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.progressPublishTimer) clearTimeout(this.progressPublishTimer);
    if (this.progressHeartbeatTimer) clearInterval(this.progressHeartbeatTimer);
    await Promise.all(Array.from(this.bridges.keys()).map((rel) => this.dropBridge(rel)));
    // After the bridges' final drops: rejects any still-hung cloud fetch so a
    // background resume blocked on it settles and shutdown's join returns.
    this.stopAbort.abort();
    this.destroySocket();
    this.status = 'stopped';
  }
}

export class SyncBridgeManager {
  constructor({
    store,
    docHost,
    log = () => {},
    emitFilesChanged = () => {},
    emitSharesChanged = () => {},
    emitCommentsChanged = () => {},
    remoteOrigin = () => '',
  }) {
    this.store = store;
    this.docHost = docHost;
    this.log = log;
    /** () → the cloud origin this install proxies ('' = dev/direct). */
    this.remoteOrigin = remoteOrigin;
    /** (projectId, path) → SSE notification, so cloud-driven creates/deletes
     *  refresh the local file tree like local ones do. */
    this.emitFilesChanged = emitFilesChanged;
    /** (projectId) → SSE notification on share STATUS transitions (parked,
     *  token-rejected, revived) — the UI's syncing badges must not lie. */
    this.emitSharesChanged = emitSharesChanged;
    /** (projectId) → SSE notification when the BACKING workspace's comment
     *  threads change (guest comments/replies), mirroring the local store's
     *  own comments-changed events. */
    this.emitCommentsChanged = emitCommentsChanged;
    this.engines = new Map(); // shareId -> ShareEngine
    this.projectLocks = new Map(); // projectId -> promise-chain tail
    // Flipped by stopAll(): resumeAll() runs in the background after the
    // server binds, so shutdown must be able to cancel the remaining loop
    // instead of racing it (engines already mid-start are covered by their
    // own `stopped` flags).
    this.closed = false;
  }

  /** This install's own share rows. The ledger is ONE sqlite file per
   *  machine, shared by every sidecar that has ever run on it, and each row is
   *  bound to the deployment it was made against (`api_origin`) — its
   *  workspace, token and audience all live in that cloud's database. So
   *  another deployment's rows are not this app's to list, sync, block on or
   *  revoke: prod shows prod's shares, dev shows dev's, and each set reappears
   *  whole whenever a sidecar for that cloud runs again. (Rows a dev server
   *  wrote into the packaged app's ledger — what starting a second sidecar
   *  without SUNDIAL_LOCAL_HOME does — used to retry that dead cloud every
   *  10s, veto new shares on the same path, and answer every Stop with
   *  "Project not found".) An origin-less row predates the column and stays
   *  ours; '' (dev/direct, no proxy) claims everything, as before. */
  ownShares(projectId) {
    const ours = this.remoteOrigin();
    const rows = this.store.listShares(projectId);
    if (!ours) return rows;
    return rows.filter((share) => !share.api_origin || share.api_origin.replace(/\/$/, '') === ours);
  }

  /** The grants-model (union) row for THIS cloud. A project can hold one per
   *  deployment — nothing in the ledger makes it unique — so selecting by
   *  scope_kind alone could hand back another cloud's backing workspace and
   *  fail every later share against it with "Project not found". */
  unionShare(projectId) {
    return this.ownShares(projectId).find((share) => share.scope_kind === 'union') ?? null;
  }

  /** The project's hidden backing workspace, remembered even when no scope
   *  currently syncs (grants-model shares reuse it forever). */
  backingWorkspaceId(projectId) {
    return this.unionShare(projectId)?.workspace_id ?? null;
  }

  /** Per-project mutation lock (promise-chain mutex). Scope ADDS and STOPS
   *  must serialize: a stop's "nothing survives → revoke every audience"
   *  decision and its grant deletions are one critical section, and an add's
   *  scope recording must land either before it (the stop then narrows) or
   *  after it (the add's grant is only minted once this sidecar has recorded
   *  the scope, i.e. after the stop's deletes finished). Without the lock an
   *  add interleaving a stop could have its freshly minted grant swept by
   *  the bulk revoke — a live scope left syncing with no audience. NOT
   *  reentrant: locked sections call the `*Locked` internals, never the
   *  public wrappers. */
  withProjectLock(projectId, fn) {
    const tail = this.projectLocks.get(projectId) ?? Promise.resolve();
    const run = tail.then(fn);
    // The stored tail must never reject — one failed mutation must not
    // poison every later one.
    this.projectLocks.set(projectId, run.catch(() => {}));
    return run;
  }

  addShareScope(projectId, body) {
    return this.withProjectLock(projectId, () => this.addShareScopeLocked(projectId, body));
  }

  removeShareScope(projectId, scopeId, opts) {
    return this.withProjectLock(projectId, () => this.removeShareScopeLocked(projectId, scopeId, opts));
  }

  removeShare(projectId, shareId) {
    return this.withProjectLock(projectId, () => this.removeShareLocked(projectId, shareId));
  }

  /** Mint-confirm: grant liveness is subordinate to sidecar truth. The modal
   *  mints its cloud grant only AFTER addShareScope releases this lock, so a
   *  stop can interleave — its target revoke finds no grant yet, removes the
   *  scope, and the late mint would leave a live grant on a stopped scope.
   *  Reading under the SAME lock means the answer lands strictly outside any
   *  in-flight stop's critical section: scope gone → the caller revokes its
   *  own mint (fail-closed); scope alive → the stop hasn't run, and its
   *  post-removal re-revoke sweeps the grant when it does. */
  confirmShareScope(projectId, { workspaceId, scopeKind, scopePath }) {
    return this.withProjectLock(projectId, () => {
      const share = this.unionShare(projectId);
      const scope =
        share?.enabled && share.workspace_id === workspaceId
          ? this.store
              .listShareScopes(share.id)
              .find((entry) => entry.scope_kind === scopeKind && (scopeKind === 'project' || entry.scope_path === scopePath))
          : null;
      return { live: Boolean(scope), generation: scope?.generation ?? null };
    });
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
      for (const share of this.ownShares(project.id)) {
        if (!share.enabled || this.engines.has(share.id)) continue;
        // A union row with no scopes left has nothing to sync.
        if (share.scope_kind === 'union' && this.store.listShareScopes(share.id).length === 0) continue;
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

  /** First enabled LEGACY (pre-grants) share conflicting with (scopeKind,
   *  scopePath): two engines would double-relay the same doc and eat each
   *  other's echoes. Union scopes never conflict — one engine owns the whole
   *  union, so overlapping audiences are legal — and legacy shares are no
   *  longer creatable, so only rows predating the grants model land here. */
  findOverlap(projectId, scopeKind, scopePath) {
    const contains = (outer, inner) => !outer || inner === outer || inner.startsWith(`${outer}/`);
    const conflicts = (otherKind, otherPath) => {
      if (scopeKind === 'chat' || otherKind === 'chat') {
        return scopeKind === 'chat' && otherKind === 'chat' && otherPath === scopePath;
      }
      return contains(otherPath, scopePath) || contains(scopePath, otherPath);
    };
    for (const existing of this.ownShares(projectId)) {
      if (!existing.enabled || existing.scope_kind === 'union') continue;
      if (conflicts(existing.scope_kind, existing.scope_path)) return existing;
    }
    return null;
  }

  /** Add one scope to the project's grants-model share, creating the union
   *  share row (one per backing workspace) on first use, and (re)start its
   *  engine. Called with a fresh 7-day token every time — the row's
   *  connection info follows. */
  async addShareScopeLocked(projectId, body) {
    const project = this.store.getProject(projectId);
    if (!project) throw Object.assign(new Error('unknown project'), { status: 404 });
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
    const collabUrl = typeof body.collabUrl === 'string' ? body.collabUrl.trim() : '';
    const apiOrigin = typeof body.apiOrigin === 'string' ? body.apiOrigin.trim().replace(/\/$/, '') : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const scopeKind = ['project', 'folder', 'file', 'chat'].includes(body.scopeKind) ? body.scopeKind : 'project';
    const scopePath = scopeKind === 'project' ? '' : String(body.scopePath || '').trim();
    if (!workspaceId || !apiOrigin || !token || (!collabUrl && scopeKind !== 'chat')) {
      throw Object.assign(new Error('workspaceId, collabUrl, apiOrigin, token are required'), { status: 400 });
    }
    if (scopeKind !== 'project' && !scopePath) {
      throw Object.assign(new Error('scopePath is required for folder/file/chat shares'), { status: 400 });
    }
    if (scopeKind === 'chat') {
      const chat = this.store.getChat(scopePath);
      if (chat?.project_id !== project.id) {
        throw Object.assign(new Error('Import this chat before sharing it.'), { status: 400 });
      }
      // Watching chats can receive private comment deliveries at any moment
      // (and the watcher exclusion would otherwise silently starve the watch
      // while the chip still shows). Mirrors the cloud route's 409.
      if (chat.comment_watch_path) {
        throw Object.assign(
          new Error('This chat is watching document comments. Stop watching before sharing it.'),
          { status: 409 },
        );
      }
      // Past deliveries leak too: the scope ledger uploads the chat's whole
      // history, so a formerly-watching chat still carries private comment
      // paths/quotes/bodies. Mirrors the cloud route's history 409.
      if (this.store.chatHasCommentDeliveries(chat.id)) {
        throw Object.assign(
          new Error('This chat has received document-comment deliveries and cannot be shared.'),
          { status: 409 },
        );
      }

    }
    if (scopeKind !== 'chat' && inExtraRoot(this.store, projectId, scopePath)) {
      throw Object.assign(new Error('Folders added from elsewhere on this computer cannot be shared yet.'), { status: 400 });
    }
    const legacyOverlap = this.findOverlap(projectId, scopeKind, scopePath);
    if (legacyOverlap) {
      throw Object.assign(
        new Error(`Already covered by an older share (${legacyOverlap.scope_path || 'the whole project'}). Stop that share first.`),
        { status: 409 },
      );
    }
    let share = this.unionShare(projectId);
    if (share && share.workspace_id !== workspaceId) {
      // The backing workspace is fixed per project. A different id means it
      // was deleted/recreated cloud-side — only adoptable once no scope
      // still syncs to the old one.
      if (this.store.listShareScopes(share.id).length > 0) {
        throw Object.assign(new Error('This project already syncs to a different backing workspace.'), { status: 409 });
      }
      await this.removeShareLocked(projectId, share.id);
      share = null;
    }
    const mintKey = typeof body.mintKey === 'string' && body.mintKey.trim() ? body.mintKey.trim() : null;
    const mintKind = body.mintKind === 'user' || body.mintKind === 'mcp' ? body.mintKind : null;
    const refreshCredential =
      typeof body.refreshCredential === 'string' && body.refreshCredential.trim()
        ? body.refreshCredential.trim()
        : null;
    if (mintKind === 'mcp' && !refreshCredential) {
      throw Object.assign(new Error('refreshCredential is required for MCP folder sync'), { status: 400 });
    }
    if (!share) {
      // mintKey: the identity that owns an ATTACHED workspace (serve.sh
      // --workspace), when it differs from the install's own — the daemon's
      // daily re-mint presents it instead of the install identity.
      // mintKind 'user': re-mint with the signed-in account's credentials
      // (settings.agent_credentials) instead of any anon key.
      share = this.store.addShare({
        projectId,
        workspaceId,
        scopePath: '',
        scopeKind: 'union',
        collabUrl,
        apiOrigin,
        token,
        mintKey,
        mintKind,
        refreshCredential,
      });
    } else {
      this.store.updateShareConnection(share.id, {
        collabUrl: collabUrl || share.collab_url,
        apiOrigin,
        token,
      });
      // A fresh one-time MCP handoff rotates the workspace-scoped renewal
      // credential. Other existing-share refreshes omit mint metadata and
      // therefore keep the identity already bound to the row.
      if ('mintKind' in body || 'mintKey' in body || 'refreshCredential' in body) {
        this.store.updateShareMint(share.id, { mintKey, mintKind, refreshCredential });
      }
    }
    // Fresh scopes get the next per-project GENERATION; a re-add of a live
    // scope keeps its existing one (conflict no-op).
    const generation = this.store.nextScopeGeneration(projectId);
    const { scope, inserted } = this.store.addShareScope(share.id, { scopeKind, scopePath, generation });
    if (inserted) {
      // Self-heal sweep: a FRESH scope's target must carry no grant — anything
      // there is an orphan (a dead tab's mint for a PREVIOUS generation, or a
      // generation-less mint from an older app). Revoke through generation-1
      // with the fresh token we were just handed.
      //
      // FAIL CLOSED (Codex P2 round 33): a PRE-GENERATION (null) row is
      // indistinguishable server-side from a live legacy share adopting its
      // backfilled generation, so the mint route only resets the audience
      // when it raises over a RECORDED generation — which leaves this sweep
      // as the only thing standing between a stale null row and the re-added
      // scope inheriting its link and members. `fetch` resolves on 4xx/5xx,
      // so the status is checked too. Nothing is lost by refusing here: the
      // very next thing this flow does is mint a grant against that same
      // cloud, so an unreachable cloud cannot produce a working share anyway.
      const sweep = await fetch(`${apiOrigin}/api/workspace/local-agent/path-shares`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          ...(scopeKind === 'chat'
            ? { chatId: `${scopePath}:${workspaceId}` }
            : scopeKind === 'project'
              ? { scope: 'workspace' }
              : { path: scopePath }),
          stoppedGeneration: generation - 1,
        }),
      }).catch((error) => {
        this.log(`scope add sweep failed project=${projectId} error=${error?.message}`);
        return null;
      });
      // 403 = this token has no grant standing on the workspace AT ALL (a
      // non-owner attach: a collaborator syncing a workspace they can write
      // but do not own). There is no orphan of OURS to clear — grant mint
      // and revoke are both owner-gated, so this identity could never have
      // created one, and failing closed could not remove someone else's
      // either. The workspace's audience stays the owner's to manage;
      // proceed. Every other failure still fails closed (see above).
      if (!sweep?.ok && sweep?.status !== 403) {
        // Roll the scope back so the share is not half-added: the engine has
        // not started, and the union row (if this add created it) carries no
        // scopes, exactly like after a stop.
        this.store.removeShareScope(scope.id);
        throw Object.assign(
          new Error(
            `Could not clear a previous share on this target (${sweep ? sweep.status : 'network error'}). Sharing NOT started.`,
          ),
          { status: 502 },
        );
      }
    }
    // Dekker verify vs watch activation: the watch path writes its column
    // then re-checks shares, so we re-check the WATCH now that our scope row
    // exists — in any interleaving one side sees the other. A raced watch
    // rolls this scope back rather than shipping a watched chat's private
    // comment history to link guests.
    if (scopeKind === 'chat' && this.store.getChat(scopePath)?.comment_watch_path) {
      this.store.removeShareScope(scope.id);
      throw Object.assign(
        new Error('This chat started watching document comments while being shared; the share was rolled back.'),
        { status: 409 },
      );
    }
    const engine = await this.restartUnionEngine(projectId, share.id);
    if (engine) {
      await engine.start().catch((error) => {
        this.log(`union share start failed id=${share.id} error=${error?.message}`);
      });
    }
    return this.describeScope(this.store.getShare(share.id), scope);
  }

  /** Remove one scope: the engine narrows to the remaining union. Cloud twins
   *  are KEPT — the modal revokes the scope's audience (grants/ACL) first, so
   *  the (private, hidden) backing workspace retains the synced data as
   *  history. Bridge rows no remaining scope covers are forgotten, which
   *  detaches the retained twins from local files: later local deletes or
   *  renames never touch them, and a future re-share of the scope first-syncs
   *  against the twin like any first contact (local wins on divergence). */
  async removeShareScopeLocked(projectId, scopeId, { revoked = false, freshToken = null } = {}) {
    const scope = this.store.getShareScope(scopeId);
    const share = scope ? this.store.getShare(scope.share_id) : null;
    if (!scope || !share || share.project_id !== projectId) {
      throw Object.assign(new Error('unknown share'), { status: 404 });
    }
    // Under the project lock, so authoritative through every await below —
    // concurrent adds queue behind this whole stop.
    const remaining = this.store.listShareScopes(share.id).filter((entry) => entry.id !== scope.id);
    const pending = this.store.pendingScopeRelocations(share.id, scope.id);
    const stoppedGeneration = Math.max(scope.generation ?? 0, pending.generation);
    const revokeCloud = async (target) => {
      // A fresh caller-minted token wins over the stored one, which can be
      // 7-day-stale — the final stop must not abort on it (fail-closed
      // stays: no valid token at all still aborts with the scope intact).
      const revoke = await fetch(`${share.api_origin}/api/workspace/local-agent/path-shares`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${freshToken || share.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: share.workspace_id, ...target }),
      });
      if (!revoke.ok) {
        throw Object.assign(new Error(`audience revoke failed (${revoke.status}); sharing NOT stopped`), { status: 502 });
      }
    };
    // Fail-closed, audience BEFORE teardown; ANY failure (a cloud without the
    // route included) aborts with the scope intact — "stopped" must never
    // leave the audience live. The scope's OWN grant is skipped for `revoked`
    // callers (the modal already killed it with user auth, and repeating it
    // on a stale bridge token would brick their stop). The LAST-scope bulk is
    // never skipped: it belongs inside this locked section — that atomicity
    // with concurrent adds is the whole point (see withProjectLock).
    // …UNLESS an UNLANDED rename allocated a generation the modal cannot have
    // seen: it revoked with the generation the scope still advertises, while
    // the pending move may yet stamp the higher one onto the row — above the
    // modal's watermark, leaving a live grant on a stopped scope. That window
    // stays open as long as the cloud is unreachable, so it is worth the extra
    // (fail-closed) call on the caller's fresh token. Once a move has LANDED
    // the scope's own generation is authoritative and the skip holds again;
    // the bump emits shares-changed so clients refresh onto it.
    if (!revoked || stoppedGeneration > (scope.generation ?? 0)) {
      await revokeCloud({
        ...(scope.scope_kind === 'chat'
          ? { chatId: `${scope.scope_path}:${share.workspace_id}` }
          : scope.scope_kind === 'project'
            ? { scope: 'workspace' }
            : { path: scope.scope_path }),
        // Generation-scoped: revoke THIS scope's grant (and older orphans),
        // never a concurrently re-added scope's newer-generation grant.
        // Through the highest generation an UNLANDED rename allocated too:
        // that move may stamp it on the row at any moment (it runs off the
        // poll, outside this lock), and a watermark below the stamp would
        // leave the grant alive on a stopped scope.
        ...(stoppedGeneration ? { stoppedGeneration } : {}),
      });
    }
    // Every OTHER path an unlanded rename could still have this grant parked
    // at (the chain's origin, and each hop of a chained A→B→C). The cloud row
    // only moves when its queued move lands, so a chain stalled midway leaves
    // the grant reachable wherever it stopped — revoking only the scope's
    // current path would leave a stopped share live at B.
    for (const path of pending.paths) {
      if (path !== scope.scope_path) await revokeCloud({ path, stoppedGeneration });
    }
    if (remaining.length === 0) {
      // Nothing survives this stop: every grant and the workspace ACL come
      // off — the retained history must not stay reachable through anything.
      // The wipe has no target of its own, so it carries this project's
      // CURRENT generation counter as a workspace-wide revocation epoch: an
      // audience mint already in flight (for any target, from any window)
      // gates on it and dies, while the next scope add mints above it and
      // passes. Read, never bumped — we hold the project lock, so the counter
      // cannot move under us (Codex P1 round 32).
      await revokeCloud({ all: true, stoppedGeneration: this.store.currentScopeGeneration(projectId) });
    }
    const engine = this.engines.get(share.id);
    if (engine) {
      await engine.stop();
      this.engines.delete(share.id);
    }
    this.store.removeShareScope(scopeId);
    for (const rel of this.store.listBridgeFiles(share.id)) {
      if (scopeCoversPath(scope, rel) && !remaining.some((s) => scopeCoversPath(s, rel))) {
        this.store.forgetBridgeFile(share.id, rel);
      }
    }
    // Conversations, unlike files, do NOT stay behind as history. Strictly
    // best-effort and strictly after the audience revoke above: a failure here
    // leaves orphan mirror chats in a private workspace, never a live share,
    // and must not block the stop the user asked for.
    await this.purgeCloudChats(share, scope, remaining, freshToken).catch((error) => {
      this.log(`chat mirror purge failed share=${share.id} error=${error?.message}`);
    });
    const next = await this.restartUnionEngine(projectId, share.id);
    if (next) {
      await next.start().catch((error) => {
        this.log(`union share restart failed id=${share.id} error=${error?.message}`);
      });
    }
  }

  /** Drop the cloud twins of the chats a stopped scope mirrored: the route
   *  deletes those `chats`/`messages` and their ledger events, and nothing
   *  else. Only chat-bearing scopes have anything to purge: a folder/file
   *  stop never mirrored a conversation. A remaining scope that still mirrors
   *  a chat keeps it (a project scope covers every chat; a chat scope covers
   *  its own), so a partial stop can't take a live share's mirror with it.
   *  Clearing the version state is paired with the whole-workspace purge: it
   *  is what lets a re-share mirror from v1 into an empty workspace. */
  async purgeCloudChats(share, scope, remaining, freshToken) {
    if (scope.scope_kind !== 'project' && scope.scope_kind !== 'chat') return;
    if (scope.scope_kind === 'chat' && remaining.some((entry) => entry.scope_kind === 'project')) return;
    const kept = remaining.filter((entry) => entry.scope_kind === 'chat').map((entry) => entry.scope_path);
    let chatIds = scope.scope_kind === 'chat' ? [scope.scope_path] : null;
    if (chatIds === null && kept.length > 0) {
      chatIds = this.store.listChats(share.project_id).map((chat) => chat.id).filter((id) => !kept.includes(id));
      if (chatIds.length === 0) return;
    }
    const res = await fetch(`${share.api_origin}/api/workspace/local-ledger`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${freshToken || share.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: share.workspace_id, ...(chatIds ? { chatIds } : {}) }),
    });
    if (!res.ok) throw new Error(`status=${res.status}`);
    if (!chatIds) this.store.clearLedgerChatState(share.project_id, share.workspace_id);
  }

  /** Stop + re-create the union engine from current store state. Returns the
   *  new (unstarted) engine, or null when no scopes remain to sync. */
  async restartUnionEngine(projectId, shareId) {
    const engine = this.engines.get(shareId);
    if (engine) {
      await engine.stop();
      this.engines.delete(shareId);
    }
    const share = this.store.getShare(shareId);
    const project = this.store.getProject(projectId);
    if (!share?.enabled || !project || this.store.listShareScopes(shareId).length === 0) return null;
    const next = new ShareEngine({ manager: this, share, project });
    this.engines.set(shareId, next);
    return next;
  }

  /** Scope entries surface through the same shares list the UI already
   *  consumes: one row per scope, `scope:<id>` ids (DELETE /shares routes on
   *  the prefix), `share_id` pointing at the union row for token refresh. */
  describeScope(share, scope) {
    const engine = this.engines.get(share.id);
    const synced = scope.scope_kind === 'chat' ? [] : this.store.listBridgeFiles(share.id);
    return {
      id: `scope:${scope.id}`,
      share_id: share.id,
      project_id: share.project_id,
      workspace_id: share.workspace_id,
      scope_path: scope.scope_path,
      scope_kind: scope.scope_kind,
      generation: scope.generation ?? null,
      enabled: share.enabled,
      // Which identity re-mints this share's token (attach-to-existing);
      // null = the install's own headless identity, mint_kind 'user' = the
      // signed-in account's credentials. Localhost-token-gated surface,
      // same trust level as api_origin.
      mint_key: share.mint_key ?? null,
      mint_kind: share.mint_kind ?? null,
      created_at: scope.created_at,
      status: engine?.status ?? (share.enabled ? 'inactive' : 'disabled'),
      error: engine?.error ?? null,
      bridgedFiles: engine?.bridges.size ?? 0,
      syncedFiles: synced.filter((rel) => scopeCoversPath(scope, rel)).length,
      progress: scope.scope_kind === 'chat' ? null : engine?.progressForScope(scope) ?? null,
    };
  }

  describeShare(share) {
    const engine = this.engines.get(share.id);
    // Never echo either cloud credential back out.
    const { token, refresh_credential, ...safe } = share;
    return {
      ...safe,
      status: engine?.status ?? (share.enabled ? 'inactive' : 'disabled'),
      error: engine?.error ?? null,
      bridgedFiles: engine?.bridges.size ?? 0,
      // Durable "n files shared" count (text + blobs ever synced) — open
      // bridges idle-close, so bridges.size reads 0 on a fully shared project.
      syncedFiles: this.store.listBridgeFiles(share.id).length,
      progress: share.scope_kind === 'chat' || engine?.ledgerOnly ? null : engine?.progressForScope() ?? null,
    };
  }

  // ---- Doc comments on shared paths ---------------------------------------
  // The single comment store for a shared conversation is the CLOUD backing
  // workspace (guests can only ever see those rows); these helpers are what
  // the sidecar's /comments handler routes through.

  #commentEngines(projectId) {
    return [...this.engines.values()].filter(
      (engine) =>
        engine.project.id === projectId &&
        !engine.stopped &&
        engine.share.api_origin &&
        engine.supportsComments(),
    );
  }

  /** Cloud threads visible to this project (optionally one file's), already
   *  translated to local paths. Engines are read in PARALLEL — the panel's
   *  worst case is one read timeout, not shares × timeout. Per-engine
   *  failures degrade to fewer threads (logged) — a parked share must not
   *  500 the whole comments listing. */
  async listCloudCommentThreads(projectId, rel = null) {
    const engines = this.#commentEngines(projectId).filter(
      (engine) => rel === null || engine.scopeContains(rel),
    );
    const settled = await Promise.allSettled(engines.map((engine) => engine.fetchCloudComments(rel)));
    return settled.flatMap((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      this.log(`share ${engines[i].share.id} comments-list: ${result.reason?.message || result.reason}`);
      return [];
    });
  }

  /** Engine whose scope covers `rel`, if any — the signal that a NEW comment
   *  belongs in the cloud store instead of the local one. */
  commentEngineFor(projectId, rel) {
    return this.#commentEngines(projectId).find((engine) => engine.scopeContains(rel)) ?? null;
  }

  /** Locate a cloud thread by id for mutation routing: engine caches first,
   *  then one live refresh per engine (mutations are rare). */
  async findCloudCommentThread(projectId, threadId) {
    const engines = this.#commentEngines(projectId);
    for (const engine of engines) {
      const cached = engine.cloudComments?.get(threadId);
      if (cached) return { engine, thread: cached };
    }
    for (const engine of engines) {
      try {
        await engine.fetchCloudComments(null);
      } catch (error) {
        this.log(`share ${engine.share.id} comments-lookup: ${error?.message || error}`);
      }
      const thread = engine.cloudComments?.get(threadId);
      if (thread) return { engine, thread };
    }
    return null;
  }

  describeShares(projectId) {
    return this.ownShares(projectId).flatMap((share) =>
      share.scope_kind === 'union'
        ? this.store.listShareScopes(share.id).map((scope) => this.describeScope(share, scope))
        : [this.describeShare(share)],
    );
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
        engine.status = engine.hasOpenBacklog() ? 'starting' : 'active';
        engine.error = null;
        engine.authError = false;
        this.emitSharesChanged(projectId);
      }
    }
  }

  /** Refresh an MCP-attached share without ever returning its long-lived
   *  credential through localhost. The caller asks this token-gated endpoint
   *  to refresh the row; the sidecar presents the stored workspace-scoped
   *  credential directly to the deployment that minted it. */
  async refreshMcpShare(projectId, shareId) {
    const share = this.store.getShare(shareId);
    if (
      !share ||
      share.project_id !== projectId ||
      share.mint_kind !== 'mcp' ||
      !share.refresh_credential ||
      !share.api_origin
    ) {
      throw Object.assign(new Error('unknown MCP share'), { status: 400 });
    }
    const response = await fetch(`${share.api_origin}/api/workspace/local-agent/sync-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshCredential: share.refresh_credential }),
    }).catch((cause) => {
      throw Object.assign(new Error(`sync refresh unavailable: ${cause?.message || cause}`), { status: 502 });
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = Object.assign(
        new Error(payload?.error || `sync refresh rejected (${response.status})`),
        { status: response.status },
      );
      if (response.status === 401 || response.status === 403) {
        this.engines.get(shareId)?.noteError('token-refresh', new Error(`auth ${response.status}: ${error.message}`));
      }
      throw error;
    }
    if (payload?.workspaceId !== share.workspace_id || typeof payload?.token !== 'string' || !payload.token) {
      throw Object.assign(new Error('sync refresh returned invalid workspace credentials'), { status: 502 });
    }
    this.refreshShareToken(projectId, shareId, payload.token);
    return { ok: true };
  }

  async removeShareLocked(projectId, shareId) {
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
          this.log(`bridge local-event failed path=${logPath(relPath)} error=${error?.message}`);
        });
      }
    }
  }

  /** A cloud-origin write can finish after its idle bridge closes. Advance the
   *  closed-file fingerprint only for that source-aware completion; a later
   *  external disk edit must still differ and win over a cloud delete. */
  handleRemotePersist(projectId, relPath) {
    for (const engine of this.engines.values()) {
      if (engine.project.id !== projectId || engine.stopped) continue;
      if (engine.scopeContains(relPath) && !isIgnoredPath(relPath)) {
        void engine.refreshProgressLocalPath(relPath).then(() => engine.scheduleProgressPublish());
      }
      if (engine.bridges.has(relPath) || !engine.syncedStamps.has(relPath)) continue;
      const version = engine.localFileVersion(relPath);
      if (version === null) engine.syncedLocalVersions.delete(relPath);
      else engine.syncedLocalVersions.set(relPath, version);
    }
  }

  /** An editor connected to a local doc: revive its idle-closed bridge so
   *  typing and cursors relay live instead of waiting on the cloud poll. */
  handleLocalDocOpened(projectId, relPath) {
    if (inExtraRoot(this.store, projectId, relPath)) return;
    for (const engine of this.engines.values()) {
      if (engine.project.id !== projectId || engine.stopped) continue;
      const bridge = engine.bridges.get(relPath);
      if (bridge) {
        if (!bridge.started) {
          engine.retainLocalIntent(relPath);
        } else {
          bridge.staleEmptyMaterialization = false;
          bridge.staleEmptyVersion = null;
        }
        continue;
      }
      void engine.ensureBridge(relPath).catch((error) => {
        this.log(`bridge editor-open failed path=${logPath(relPath)} error=${error?.message}`);
      });
    }
  }

  async handleLocalRename(projectId, fromRel, toRel) {
    if (inExtraRoot(this.store, projectId, fromRel) || inExtraRoot(this.store, projectId, toRel)) return;
    for (const [shareId, engine] of Array.from(this.engines.entries())) {
      if (engine.project.id !== projectId || engine.stopped) continue;
      // Chat scopes are chat ids, not paths — never scope-follow a rename.
      if (engine.share.scope_kind === 'chat') continue;
      if (engine.isUnion) {
        await this.handleUnionRename(shareId, engine, fromRel, toRel).catch((error) => {
          this.log(`union rename failed from=${logPath(fromRel)} error=${error?.message}`);
        });
        continue;
      }
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
            next.queueCloudOp('delete', cloudPath, () => next.cloudDelete(cloudPath));
          }
          await next.start().catch((error) => {
            this.log(`share scope-follow restart failed id=${shareId} error=${error?.message}`);
          });
        }
        continue;
      }
      await engine.handleLocalRename(fromRel, toRel).catch((error) => {
        this.log(`bridge rename failed from=${logPath(fromRel)} error=${error?.message}`);
      });
    }
  }

  /** Rename under a grants-model share. When the renamed path is a shared
   *  scope root (or an ancestor of one), the scopes FOLLOW it: one cloud
   *  subtree move keeps the twins' history, the covering path_shares grants
   *  move with them (outstanding links keep working), bookkeeping re-keys,
   *  and the engine restarts on the new union. Failed cloud ops park the
   *  restarted engine behind the retry queue, same as the legacy model. */
  async handleUnionRename(shareId, engine, fromRel, toRel) {
    const affected = engine.scopes.filter(
      (scope) =>
        scope.scope_kind !== 'chat' &&
        scope.scope_path &&
        (scope.scope_path === fromRel || scope.scope_path.startsWith(`${fromRel}/`)),
    );
    if (affected.length === 0) {
      // Plain rename inside/around the union — identity mapping makes the
      // engine's own move/delete/bridge rails handle it.
      await engine.handleLocalRename(fromRel, toRel);
      return;
    }
    // Persist the WHOLE follow before any awaited teardown: the disk rename
    // already happened, so a crash mid-stop() must find the durable marker
    // (or restart reconciliation would misread re-keyed rows as cloud
    // deletes and reap the renamed local files) AND the re-keyed scopes (or
    // the share would keep pointing at the old, now-empty path). A stale
    // bridge row the still-live engine writes in this instant is harmless —
    // the narrowed scopes make every sweep skip it.
    // Fresh generations ride the follow, durably in the move marker: the
    // moved grant must land ABOVE any revocation watermark already keyed to
    // its NEW path — a previous share stopped there at a higher generation
    // would otherwise have the next mint 409 and self-delete the moved grant
    // (Codex round 31). Allocated NOW (per-project monotonic, so they clear
    // every prior watermark, and a stop can revoke through them while the
    // move is still in flight) but stamped only when the cloud move lands.
    const relocations = affected.map((scope) => ({
      scopeId: scope.id,
      path: scope.scope_path === fromRel ? toRel : toRel + scope.scope_path.slice(fromRel.length),
      generation: this.store.nextScopeGeneration(engine.project.id),
    }));
    this.store.addPendingScopeMove(shareId, { from: fromRel, to: toRel, relocations });
    this.store.renameBridgePaths(shareId, fromRel, toRel);
    for (const entry of relocations) this.store.updateShareScopePath(entry.scopeId, entry.path);
    await engine.stop();
    this.engines.delete(shareId);
    // The fresh engine re-queues the pending move from the marker (parked);
    // one eager flush completes the happy path before start, and a failure
    // keeps it parked — bridging the new paths while the old cloud twins
    // still exist would fork fresh docs at the target.
    const next = await this.restartUnionEngine(engine.project.id, shareId);
    if (!next) return;
    await next.flushPendingCloudOps().catch(() => {});
    await next.start().catch((error) => {
      this.log(`union rename restart failed id=${shareId} error=${error?.message}`);
    });
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
