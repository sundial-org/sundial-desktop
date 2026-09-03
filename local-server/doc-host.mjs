import { randomUUID } from 'node:crypto';

import { Server } from '@hocuspocus/server';

import { Y, markdownSuggestionResolution, resolveSuggestion } from '../lib/crdt-js/markdown_yjs.mjs';
import {
  CODE_SUGGESTIONS_ROOT,
  acceptCodeSuggestion,
  codeSuggestionResolution,
  hasCodeSuggestion,
  rejectCodeSuggestion,
} from '../lib/crdt-js/code_suggestions.mjs';
import {
  applyContentTextIfChanged,
  applySuggestionIfChanged,
  canonicalizeContentText,
  hasAnySuggestionMark,
  hasSuggestionMark,
  isMarkdownDocument,
  readDocumentText,
  seedDocumentFromText,
} from '../lib/crdt-js/document_text.mjs';
import { snapshotResolutions, diffResolutions } from '../lib/crdt-js/suggestion_decisions.mjs';
import fsp from 'node:fs/promises';

import { contentHash } from './store.mjs';
import { fileKindForFile, isIgnoredPath, logPath, normalizeRelPath, resolveInRoot } from './paths.mjs';
import { readTextFile, writeTextFileAtomic } from './disk.mjs';
import { locateProjectPath } from './roots.mjs';

/** Yjs transaction origin for updates the cloud bridge applies to local docs.
 *  DocHost uses it to attribute persist windows; the bridge filters on it to
 *  break relay loops. */
export const BRIDGE_ORIGIN = 'sundial-cloud-bridge';

/** Doc-root meta map. `pendingCreation` holds the suggestion id that CREATED
 *  the file (empty baseline): rejecting that suggestion must delete the file,
 *  not persist an empty husk. */
const LOCAL_META_ROOT = 'sundial_localmeta';

export function parseDocumentName(documentName) {
  if (typeof documentName !== 'string') return null;
  const slash = documentName.indexOf('/');
  if (slash <= 0) return null;
  const projectId = documentName.slice(0, slash).trim();
  const relPath = normalizeRelPath(documentName.slice(slash + 1));
  if (!projectId || !relPath) return null;
  return { projectId, path: relPath };
}

/** Serves per-file Y.Docs over the Hocuspocus protocol, with the local disk as
 *  the source of truth. Docs seed from (stored CRDT state, then catch up to)
 *  the file's current bytes; edits write back debounced + atomic. The stored
 *  state keeps CRDT identity stable across restarts, so cached browser docs
 *  and the cloud bridge merge as no-ops instead of doubling. */
export class DocHost {
  constructor({ store, verifyToken, watchers, log = () => {}, persistDebounceMs = 500 }) {
    this.store = store;
    this.verifyToken = verifyToken;
    this.watchers = watchers; // Map<projectId, ProjectWatcher>
    this.log = log;
    this.persistDebounceMs = persistDebounceMs;
    this.lastDiskText = new Map(); // documentName -> last text observed/written on disk
    this.lastStateVectors = new Map(); // documentName -> Uint8Array
    this.lastPersistedDisk = new Map(); // documentName -> lastDiskText at the last completed persist
    this.canonicalCache = new Map(); // documentName -> { source, canonical } for lastDisk
    this.loadedDocs = new Set();
    this.pendingPersist = new Map(); // documentName -> timer
    this.persistChains = new Map(); // documentName -> tail of in-flight persists
    this.detached = new Set(); // externally deleted while open — writeback disabled
    this.recentDeleteHashes = new Map(); // `project hash` -> deletedAt (rename detection)
    // `project hash` -> [{ at, rel, state, contentHash, fileId }]: deleted
    // docs' persisted Y.Doc history, held briefly so a watcher rename (delete
    // + create pair from a raw `mv`) can move it to the destination. Without
    // the move, the destination re-seeds from disk bytes; the fresh seed only
    // matches the cloud copy while the bytes are IDENTICAL, so any later
    // divergence (an offline edit before a restart) forks the histories and
    // the next full sync CONCATENATES the file (the dev data-doubling bug,
    // 2026-08-24). A LIST per hash: a folder rename can hold several
    // identical-content files, each keeping its own identity. Same 10s window
    // as recentDeleteHashes.
    this.recentDeleteStates = new Map();
    // `project hash` -> [{ at, rel }]: rename destinations whose CREATE event
    // arrived before the source's delete (fs.watch guarantees no ordering
    // between a rename's two events) — #stashDeletedState fulfills these
    // instead of stashing, so adoption works in either event order.
    this.pendingAdoptions = new Map();
    // documentName -> load time, for docs that loaded while their file was
    // ABSENT on disk AND the ledger's newest row is a delete tombstone (a
    // prior generation provably existed — brand-new paths get no shield). A
    // WATCHER delete event arriving just after such a load is the old file's
    // late echo, not a deletion of this doc's generation. Cleared once the
    // file is observed on disk; swallows at most ONE event within 15s.
    this.loadedWithoutDisk = new Map();
    // documentName -> { at, live: Map<id, bool> }: cached suggestion-liveness
    // probes over STORED doc state, keyed by its updated_at — the Review
    // panel's 4s /changes poll must not decode every suggest session's doc on
    // every tick.
    this.suggestionProbes = new Map();
    // documentName -> {remote, local}: which origins wrote in the current
    // persist window. Hocuspocus fires onChange hooks asynchronously, so a
    // context passed to schedulePersist can be overwritten by a later hook —
    // origin tracking on the doc itself is what survives (see persist()).
    this.windowOrigins = new Map();
    // documentName -> Map of resolved suggestion decisions at the last update
    // (rolling). Diffed per update WITH the Yjs origin in hand, so a remote
    // (bridge) resolution in a mixed debounce window is never enqueued as a
    // local decision — only local-origin changes reach pendingDecisions, and
    // persist() flushes those with its attribution context.
    this.lastResolutions = new Map();
    this.pendingDecisions = new Map(); // documentName -> [{kind,id,decision,undone}]

    this.server = new Server({
      unloadImmediately: false,
      async onAuthenticate({ token, documentName, connectionConfig }) {
        const auth = verifyToken(token);
        const meta = parseDocumentName(documentName);
        if (!auth || !meta) throw new Error('Unauthorized');
        if (auth.projectId && auth.projectId !== meta.projectId) throw new Error('Unauthorized');
        if (!store.getProject(meta.projectId)) throw new Error('Unauthorized');
        if (isIgnoredPath(meta.path) || fileKindForFile(meta.path) !== 'text') throw new Error('Unauthorized');
        connectionConfig.readOnly = auth.readOnly === true;
        return auth;
      },
      onLoadDocument: async ({ documentName, document }) => this.loadDocument(documentName, document),
      // An editor attaching to a doc must revive its idle-closed cloud bridge
      // so cursor + keystroke relay is live while anyone has the file open.
      connected: ({ documentName }) => {
        const meta = parseDocumentName(documentName);
        if (meta) this.onEditorConnected?.(meta.projectId, meta.path);
        this.log(`editor connected doc=${logPath(documentName)} connections=${this.connectionCount(documentName)}`);
      },
      onDisconnect: async ({ documentName }) => {
        this.log(`editor disconnected doc=${logPath(documentName)} connections=${this.connectionCount(documentName)}`);
      },
      onChange: ({ documentName, document, context }) => {
        if (!this.loadedDocs.has(documentName)) return;
        this.schedulePersist(documentName, document, context);
      },
      onStoreDocument: async ({ documentName, document, context }) => {
        const pending = this.pendingPersist.get(documentName);
        if (pending) clearTimeout(pending);
        this.pendingPersist.delete(documentName);
        await this.queuePersist(documentName, document, context);
      },
      afterUnloadDocument: ({ documentName }) => {
        const pending = this.pendingPersist.get(documentName);
        if (pending) clearTimeout(pending);
        this.pendingPersist.delete(documentName);
        this.lastDiskText.delete(documentName);
        this.lastStateVectors.delete(documentName);
        this.lastPersistedDisk.delete(documentName);
        this.canonicalCache.delete(documentName);
        this.loadedDocs.delete(documentName);
        this.detached.delete(documentName);
        this.loadedWithoutDisk.delete(documentName);
        this.windowOrigins.delete(documentName);
        this.lastResolutions.delete(documentName);
        this.pendingDecisions.delete(documentName);
      },
    });
  }

  get hocuspocus() {
    return this.server.hocuspocus;
  }

  /** Virtual project path → { root, rel } under the owning root (multi-root:
   *  extra roots mount under a top-level prefix; see roots.mjs). Every disk
   *  read/write in this class must resolve through this. */
  #loc(project, relPath) {
    return locateProjectPath(this.store, project, relPath);
  }

  connectionCount(documentName) {
    return this.hocuspocus.documents.get(documentName)?.connections?.size ?? 0;
  }

  async loadDocument(documentName, document) {
    const meta = parseDocumentName(documentName);
    if (!meta) return document;
    const project = this.store.getProject(meta.projectId);
    if (!project) return document;
    if (document.getXmlFragment('default').length > 0 || document.share.has('codetext')) {
      return document;
    }
    // A missing file loads as an empty doc (creation flow); a READ FAILURE
    // (oversized, permissions) must refuse the load instead — seeding '' would
    // let the first edit or bridge sync persist over the real bytes.
    const loc = this.#loc(project, meta.path);
    const disk = await readTextFile(loc.root, loc.rel);
    const diskText = disk?.text ?? '';
    let stored = this.store.getDocState(meta.projectId, meta.path);
    let catchUp = true;
    if (stored && !disk) {
      // Stored state for a file GONE from disk. Either way, "catching up" to
      // the empty disk would mint content-DELETING ops that merge into live
      // peers (the cloud doc, a rescued re-share) and wipe their text:
      // - ledger corroborates a delete → the file is really gone; retire the
      //   state and start fresh.
      // - no tombstone (transient stat failure, broken symlink) → destroying
      //   state (suggestion marks, op identity) is unjustified; keep it and
      //   just skip the catch-up until the disk answers again.
      if (this.store.lastEditIsDelete(meta.projectId, meta.path)) {
        this.store.deleteDocState(meta.projectId, meta.path);
        stored = null;
      } else {
        catchUp = false;
      }
    }
    if (stored) {
      // Stored CRDT state first (preserves op identity + pending suggestion
      // marks), then catch up to the file's current bytes — same shape as the
      // cloud server's ydoc_state + content_text catch-up.
      Y.applyUpdate(document, stored.state);
      if (catchUp && stored.contentHash !== contentHash(diskText)) {
        applyContentTextIfChanged(meta.path, document, diskText);
      }
    } else if (diskText) {
      // Deterministic seed: identical bytes → identical ops, so a concurrent
      // seed elsewhere (cloud bridge, another lifetime) merges as a no-op.
      seedDocumentFromText(meta.path, document, diskText);
      // The seed IS this doc's lineage: save it NOW. persist()'s no-op skip
      // (state vector unchanged since load) means an unedited doc never
      // reaches the store, so every reload re-seeded a FRESH lineage —
      // harmless only while disk bytes still equal the cloud copy, and a
      // union (content doubling) the moment they diverge, with later
      // deletions unable to touch the foreign lineage's copies (live
      // 2026-08-27: sync_note.tex grew to four concatenated documents).
      this.store.saveDocState(meta.projectId, meta.path, Y.encodeStateAsUpdate(document), contentHash(diskText));
    }
    this.lastDiskText.set(documentName, diskText);
    this.lastStateVectors.set(documentName, Y.encodeStateVector(document));
    this.lastResolutions.set(documentName, snapshotResolutions(document));
    this.loadedDocs.add(documentName);
    // A delete/move can detach a doc that is already UNLOADED (no unload
    // event will ever clear the flag) — a fresh load reflects current disk
    // truth, so writeback must not stay suppressed by the old detachment.
    this.detached.delete(documentName);
    if (!disk && this.store.lastEditIsDelete(meta.projectId, meta.path)) {
      // Evidence a prior generation existed and was deleted — only then can a
      // late delete echo still be in flight. A brand-new path (creation flow,
      // cloud materialization) gets no shield: its first delete is genuine.
      this.loadedWithoutDisk.set(documentName, Date.now());
    } else {
      this.loadedWithoutDisk.delete(documentName);
    }
    document.on('update', (_update, origin) => {
      if (!this.loadedDocs.has(documentName)) return;
      const window = this.windowOrigins.get(documentName) ?? { remote: false, local: false };
      if (origin === BRIDGE_ORIGIN) window.remote = true;
      else window.local = true;
      this.windowOrigins.set(documentName, window);
      // Per-update decision diff: only LOCAL-origin resolutions queue for the
      // ledger (a bridged one was decided — and recorded — on the cloud side).
      const prev = this.lastResolutions.get(documentName);
      const next = snapshotResolutions(document);
      this.lastResolutions.set(documentName, next);
      if (!prev || origin === BRIDGE_ORIGIN) return;
      const changes = diffResolutions(prev, next);
      if (changes.length === 0) return;
      // Stamp the deciding actor NOW: a websocket update's origin is the
      // Hocuspocus connection (whose .context is its auth), and two local
      // parties resolving inside one debounce window must not all inherit
      // whichever context the final persist callback happens to carry.
      const originContext = origin && typeof origin === 'object' ? origin.context : null;
      const pending = this.pendingDecisions.get(documentName) ?? [];
      pending.push(...changes.map((change) => ({ ...change, context: originContext ?? null })));
      this.pendingDecisions.set(documentName, pending);
    });
    this.log(`load doc=${logPath(documentName)} source=${stored ? 'state' : disk ? 'disk' : 'empty'}`);
    return document;
  }

  schedulePersist(documentName, document, context) {
    const existing = this.pendingPersist.get(documentName);
    if (existing) clearTimeout(existing);
    this.pendingPersist.set(
      documentName,
      setTimeout(() => {
        this.pendingPersist.delete(documentName);
        void this.queuePersist(documentName, document, context);
      }, this.persistDebounceMs),
    );
  }

  hasPendingPersist(documentName) {
    return this.pendingPersist.has(documentName) || this.persistChains.has(documentName);
  }

  hasObservedDiskText(documentName, text) {
    return this.lastDiskText.has(documentName) && this.lastDiskText.get(documentName) === text;
  }

  /** Serialize persists per doc: the debounce timer and Hocuspocus's own
   *  onStoreDocument debounce can otherwise run persist() concurrently, both
   *  passing the state-changed check against the same prior vector and
   *  double-recording one edit in the ledger. Failures log by default;
   *  `rethrow` returns the raw attempt so a caller that must not report
   *  success on a failed persist (suggest staging) sees the rejection. */
  queuePersist(documentName, document, context, { rethrow = false } = {}) {
    const prev = this.persistChains.get(documentName) ?? Promise.resolve();
    const attempt = prev.then(() => this.persist(documentName, document, context));
    const next = attempt.catch((error) => {
      this.log(`persist failed doc=${logPath(documentName)} error=${error?.message}`);
    });
    this.persistChains.set(documentName, next);
    void next.finally(() => {
      if (this.persistChains.get(documentName) === next) this.persistChains.delete(documentName);
    });
    return rethrow ? attempt : next;
  }

  async persist(documentName, document, context) {
    const meta = parseDocumentName(documentName);
    if (!meta) return;
    const project = this.store.getProject(meta.projectId);
    if (!project) return;
    const localMeta = document.getMap(LOCAL_META_ROOT);
    const pendingCreation = localMeta.get('pendingCreation');
    const prevVector = this.lastStateVectors.get(documentName);
    const stateChanged = !prevVector || !uint8Equal(Y.encodeStateVector(document), prevVector);
    const lastDisk = this.lastDiskText.get(documentName);
    // Hocuspocus's own onStoreDocument debounce fires every couple of seconds
    // during typing on top of our 500ms timer — when neither the doc state nor
    // the observed disk text moved since the last completed persist, return
    // before paying the full-document serialize + state encode below.
    if (pendingCreation == null && !stateChanged && lastDisk === this.lastPersistedDisk.get(documentName)) {
      return;
    }
    const text = readDocumentText(meta.path, document);
    // A REJECTED creation suggestion (see pendingCreation in
    // stageAgentSuggestion) deletes the file it created — persisting would
    // leave an empty husk on disk. The marker clears only once the file's
    // content is DECIDED: the creating suggestion was accepted, or content
    // remains with nothing pending (a superseding suggestion auto-rejects
    // its predecessor, so the marker's own resolution isn't enough — the
    // creation status must survive until the replacement resolves). Cleared
    // BEFORE the state capture below, so the same persist records it
    // without an extra ledger row.
    if (pendingCreation != null) {
      const resolution = isMarkdownDocument(documentName)
        ? markdownSuggestionResolution(document, pendingCreation)
        : codeSuggestionResolution(document, pendingCreation);
      const anyPending = isMarkdownDocument(documentName)
        ? hasAnySuggestionMark(document)
        : document.getMap(CODE_SUGGESTIONS_ROOT).size > 0;
      if (resolution === 'reject' && text === '' && !anyPending) {
        // This return path skips the normal end-of-persist flush, and the
        // deferred delete below unloads the doc (clearing pendingDecisions) —
        // flush NOW or the creation-rejection decision is never recorded.
        this.flushPendingDecisions(documentName, meta, context);
        this.watchers.get(meta.projectId)?.suppress(meta.path);
        const loc = this.#loc(project, meta.path);
        const abs = resolveInRoot(loc.root, loc.rel);
        if (abs) await fsp.rm(abs, { force: true });
        // handleDiskDelete flushes/unloads THIS doc (detachUnder awaits its
        // store), which must not run inside its own persist — the flush
        // queues behind the persist chain this call sits in (deadlock).
        // Defer past the chain; the microtask beats any new debounce.
        void Promise.resolve().then(async () => {
          try {
            await this.handleDiskDelete(meta.projectId, meta.path, {
              actor: context?.actor || 'user',
              chatId: context?.chatId ?? null,
            });
            // Suppressed watcher = nothing else announces this delete — the
            // UI tree and the cloud bridge must hear it like other deletes.
            this.onFileRemoved?.(meta.projectId, meta.path);
          } catch (error) {
            this.log(`rejected-creation delete failed doc=${logPath(documentName)} error=${error?.message}`);
          }
        });
        return;
      }
      if (resolution === 'accept' || (!anyPending && text !== '')) {
        localMeta.delete('pendingCreation');
      }
    }
    const previousLength = (lastDisk ?? text).length;
    const state = Y.encodeStateAsUpdate(document);
    let textChanged = text !== lastDisk;
    // NEVER rewrite a file whose bytes are already an equivalent representation
    // of the doc — the codec normalizes style (`*` bullets, `_emphasis_`,
    // indent width…), and writing the normalized form back over an external
    // editor's save makes Sundial and Obsidian rewrite each other's bytes
    // forever. Disk keeps the user's own form; the doc holds the content.
    if (textChanged && typeof lastDisk === 'string' && this.#canonicalDisk(meta.path, documentName, lastDisk) === text) {
      textChanged = false;
    }
    if (!stateChanged && !textChanged) {
      this.lastPersistedDisk.set(documentName, lastDisk);
      return;
    }
    // A detached doc's path was deleted or renamed away — persisting ANY of
    // it (file, doc state, ledger row) under the old path resurrects a ghost.
    if (this.detached.has(documentName)) return;

    if (textChanged) {
      this.watchers.get(meta.projectId)?.suppress(meta.path);
      const loc = this.#loc(project, meta.path);
      await writeTextFileAtomic(loc.root, loc.rel, text);
      this.lastDiskText.set(documentName, text);
      // Our own serialization is its own canonical form (codec idempotence,
      // pinned by the cross-equivalence suite) — seed the cache so typing
      // persists never re-parse the whole doc just to re-learn that. Were an
      // edge doc ever non-idempotent, the cost is one extra equivalent write
      // (watcher suppressed), which converges — never a rewrite war.
      this.canonicalCache.set(documentName, { source: text, canonical: text });
      this.loadedWithoutDisk.delete(documentName);
    }
    this.store.saveDocState(meta.projectId, meta.path, state, contentHash(this.lastDiskText.get(documentName) ?? text));
    const incremental = prevVector ? Y.diffUpdate(state, prevVector) : state;
    this.lastStateVectors.set(documentName, Y.encodeStateVectorFromUpdate(state));
    // A window written ONLY by the cloud bridge is a remote edit regardless of
    // what context the (async) Hocuspocus hook handed us last.
    const window = this.windowOrigins.get(documentName);
    this.windowOrigins.delete(documentName);
    const remoteOnly = Boolean(window?.remote && !window.local);
    // Bridged cloud edits persist with the watcher suppressed, so nothing else
    // announces them — surface an SSE so the UI reacts (e.g. the local .tex
    // auto-recompile). Any remote in the window counts (a local keystroke
    // sharing the debounce must not swallow it); local-only windows stay
    // silent: the editor already has those bytes.
    if (window?.remote && textChanged) {
      this.onRemotePersist?.(meta.projectId, meta.path, { remoteOnly });
    }
    // Forensics for the launch-window wipe bug (turbosundial, unreproduced):
    // a doc collapsing to a fraction of its size in one persist window is
    // never normal typing — capture who could have written it.
    if (previousLength > 50 && text.length < previousLength / 2) {
      this.log(
        `doc-shrink doc=${logPath(documentName)} len=${previousLength}->${text.length} window=${JSON.stringify(window ?? null)} connections=${this.connectionCount(documentName)} actor=${context?.actor ?? 'none'}`,
      );
    }
    this.store.recordEdit({
      projectId: meta.projectId,
      path: meta.path,
      actor: remoteOnly ? 'remote' : context?.actor || 'user',
      authorId: remoteOnly ? 'cloud-bridge' : context?.userId ?? null,
      editMode: context?.editMode === 'suggest' ? 'suggest' : 'edit',
      chatId: remoteOnly ? null : context?.chatId ?? null,
      // The RUN's assistant message id when the caller knows it (a
      // watcher-attributed write from a run that may since have been
      // replaced) — recordEdit's chat lookup would hand it to the wrong turn.
      messageId: remoteOnly ? null : context?.messageId ?? null,
      turnResolved: remoteOnly ? false : context?.turnResolved ?? false,
      suggestionId: context?.suggestionId ?? null,
      contentText: text,
      updateB64: Buffer.from(incremental).toString('base64'),
    });
    this.flushPendingDecisions(documentName, meta, context);
    this.lastPersistedDisk.set(documentName, this.lastDiskText.get(documentName));
  }

  /** canonicalizeContentText(lastDisk), cached per doc — the full parse →
   *  serialize fixed-point pass is O(doc), and lastDisk usually repeats
   *  between persists (our own last write is seeded above; an external save
   *  is canonicalized once, here). */
  #canonicalDisk(path, documentName, source) {
    const cached = this.canonicalCache.get(documentName);
    if (cached && cached.source === source) return cached.canonical;
    const canonical = canonicalizeContentText(path, source);
    this.canonicalCache.set(documentName, { source, canonical });
    return canonical;
  }

  /** Flush LOCAL-origin suggestion decisions queued by the update handler
   *  (the local twin of the cloud recorder). Each change prefers the context
   *  captured at its own Yjs origin; `context` is the persist fallback. */
  flushPendingDecisions(documentName, meta, context) {
    const decisions = this.pendingDecisions.get(documentName);
    this.pendingDecisions.delete(documentName);
    for (const change of decisions ?? []) {
      const decided = change.context ?? context;
      this.store.recordDecision({
        projectId: meta.projectId,
        path: meta.path,
        suggestionId: change.id,
        suggestionKind: change.kind,
        decision: change.undone ? `undone:${change.decision}` : change.decision,
        actor: decided?.actor || 'user',
        authorId: decided?.userId ?? null,
      });
    }
  }

  /** Disk change (external, sidecar API, or an echo of our own write — the
   *  text compare disambiguates): fold it into any live doc. `record: false`
   *  skips the unopened-file ledger row (own-write echoes); `actor` attributes
   *  the ledger row / persist ('external' for watcher events, the API caller's
   *  actor for sidecar writes). Outcome for the caller: 'stale-delete' when a
   *  late delete echo was swallowed (must NOT reach the bridges), 'mutated'
   *  when a REAL change was staged/applied/recorded (a suppressed event that
   *  proves real must still be bridged and announced), undefined otherwise. */
  async handleDiskChange(projectId, relPath, { record = true, actor = 'external', chatId = null, messageId = null, turnResolved = false, authorId = null, editMode = 'edit', fromWatcher = false, heldSince = null } = {}) {
    const project = this.store.getProject(projectId);
    if (!project) return;
    const documentName = `${projectId}/${relPath}`;
    const document = this.hocuspocus.documents.get(documentName);
    const loc = this.#loc(project, relPath);
    const abs = resolveInRoot(loc.root, loc.rel);
    const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
    // Any event that sees the file ON DISK ends its stale-delete protection:
    // from here on, a delete event is about THIS file, not a predecessor.
    if (stat?.isFile()) this.loadedWithoutDisk.delete(documentName);

    if (!stat) {
      // Deleted — a file, or a FOLDER whose watcher event arrives as one path
      // (no doc is ever open at a folder name). Stop writeback for it and any
      // live descendants so a debounce flush can't resurrect deleted files;
      // the UI's tree refresh drops the tabs. Deletes stay DIRECT even in
      // suggest mode — the cloud made the same call (deletes/renames don't
      // stage), and locally the bytes are already gone from the user's real
      // disk: "staging" would mean resurrecting files behind the agent's back.
      // History still records the tombstone, so a restore stays one click.
      // A suppressed event can still be a REAL delete (Bash rm inside the 2s
      // window of an earlier write to the path): our own deletes markGone
      // before their echo lands, so a still-seen path proves this one real —
      // record its tombstone and tell the caller to bridge + announce it.
      const real = this.watchers.get(projectId)?.seenBefore(relPath) ?? true;
      const swallowed = await this.handleDiskDelete(projectId, relPath, {
        record: record || real,
        actor,
        chatId,
        // A delete is as much a turn edit as a write — without this a
        // watcher-attributed delete from a SUPERSEDED run falls back to the
        // chat resolver and lands in the replacement turn's diff chip.
        messageId,
        turnResolved,
        authorId,
        fromWatcher,
      });
      if (swallowed === true) return 'stale-delete';
      return real ? 'mutated' : undefined;
    }
    if (stat.isDirectory()) {
      // A tree delete can PRESERVE the folder (protected children like .git
      // stay behind) — the event then arrives for a still-existing directory,
      // but docs for its deleted children must still detach.
      await this.detachMissingUnder(projectId, relPath, { record, actor, chatId, messageId, turnResolved, authorId });
      return;
    }
    if (!stat.isFile() || fileKindForFile(relPath) !== 'text') return;
    const disk = await readTextFile(loc.root, loc.rel).catch(() => null);
    if (!disk) return; // unreadable/oversized — never treat as a delete

    // A suggest-mode run's Bash/Codex disk writes stage as suggestions (cloud
    // parity: sandbox edits stage too). Disk already holds the new bytes, so
    // the staged diff runs against the doc's last known state; with no
    // recoverable baseline it returns false and the direct paths below apply.
    const watcher = this.watchers.get(projectId);
    const seenBefore = watcher ? watcher.seenBefore(relPath) : true;
    // The definite variant (no walk-pending fallback), read BEFORE markSeen
    // below corrupts it — it persists as existence PROOF further down.
    const knownBefore = watcher ? watcher.knownBefore(relPath) === true : false;
    // Consumed on EVERY event (captures must not accumulate), used below.
    const firstSight = watcher?.takeFirstSight(relPath);
    watcher?.markSeen(relPath);
    // First-sight bytes (captured at raw event time) that differ from the
    // current ones suggest a PRIOR generation this callback coalesced over —
    // an external create + agent overwrite in one debounce window. They are
    // that generation's only surviving text. But an agent CREATION written in
    // several strokes (`>` then `>>`, truncate-and-rewrite, a large write's
    // chunk flushes) also captures mid-write. The run's attribution window
    // (`heldSince`) tells the cases apart: a capture taken before the window
    // opened cannot be the run's own stroke; one taken inside it is treated
    // as the run's own work. Without window info (direct calls), a prefix
    // capture reads as a single writer's growing intermediate. The suggest
    // rail below keeps the stricter any-difference rule: there a misread
    // creation is rejectable, and reject would delete the user's file.
    const sight = firstSight ? await firstSight : undefined;
    const firstText = sight?.text ?? undefined;
    const firstSightDiffers = typeof firstText === 'string' && firstText !== disk.text;
    // A brand-new path whose bytes match a just-deleted doc is the create
    // half of a raw `mv`: adopt the deleted doc's history before anything
    // seeds a fresh one, or the histories fork (see recentDeleteStates).
    if (!seenBefore && !this.loadedDocs.has(documentName)) {
      this.adoptRenamedState(projectId, relPath, disk.text);
    }
    const firstSightBefore =
      firstSightDiffers && (heldSince !== null ? sight.at < heldSince : !disk.text.startsWith(firstText))
        ? firstText
        : null;
    // Staging runs even for SUPPRESSED events (record=false): suppression is
    // time-based, so a real Bash write landing within 2s of the agent writer's
    // own write to the same file arrives suppressed. Echoes are told apart by
    // CONTENT — the bytes already match the doc's accepted view — not timing.
    if (actor === 'agent' && editMode === 'suggest') {
      const unchanged = this.loadedDocs.has(documentName)
        ? disk.text === this.lastDiskText.get(documentName)
        : this.store.getDocState(projectId, relPath)?.contentHash === contentHash(disk.text);
      // A path the watcher's tree (initial walk + events, delete-aware) has
      // never seen is the run's own creation — its whole content stages as an
      // insertion, like a Write-tool creation. The tree is the authority:
      // inode signals (birthtime) misread temp+rename rewrites and moved-in
      // files, and store rows/ids surviving an offline delete are stale, not
      // proof of life. A seen path keeps the lost-baseline fallback below —
      // rejecting a fabricated whole-file insertion would empty a
      // pre-existing file. A RENAME destination (bytes match a just-deleted
      // or now-missing tracked file) is not a creation either: renames stay
      // direct, and a staged creation would delete the only copy on reject.
      // Nor is a path whose FIRST-SIGHT bytes (captured at raw event time)
      // differ from the current ones: an external create + agent overwrite
      // can coalesce into this one callback, and that file is the user's.
      const newFile =
        !seenBefore &&
        !firstSightDiffers &&
        !(await this.isRenameDestination(project, contentHash(disk.text)));
      if (!unchanged) {
        if (await this.stageAgentSuggestion(projectId, relPath, disk.text, { chatId, messageId, turnResolved, authorId, newFile })) return 'mutated';
        // A content-verified change that staging DECLINED (spacing-only,
        // lost baseline) must not be swallowed by the time-based suppression
        // flag — let the direct paths below record it.
        record = true;
      }
    }

    if (!document || !this.loadedDocs.has(documentName)) {
      // Not open: just record attribution when the content actually moved.
      if (record) {
        const stored = this.store.getDocState(projectId, relPath);
        if (!stored || stored.contentHash !== contentHash(disk.text)) {
          this.#recordAgentBaseline(projectId, relPath, actor, firstSightBefore);
          // `preExisted`: a never-opened, never-edited file leaves no text to
          // recover, but the watcher's walk-seeded tree still knows the PATH
          // was there — without the stamp the turn diff labels a real
          // modification "Added". Watcher events only (a direct caller like
          // the Tier-1 writer suppress()es first, marking its own creation
          // seen), and knownBefore, not seenBefore: the walk-pending fallback
          // is uncertainty and must not persist as proof.
          this.store.recordEdit({ projectId, path: relPath, actor, authorId, chatId, messageId, turnResolved, contentText: disk.text, preExisted: (fromWatcher && knownBefore) || firstSightBefore !== null });
          return 'mutated';
        }
      }
      return;
    }

    if (disk.text === this.lastDiskText.get(documentName)) return;
    this.lastDiskText.set(documentName, disk.text);
    // BEFORE the apply: once the disk text lands in the live doc, the previous
    // text is gone, and a baseline read afterwards would snapshot the agent's
    // own result — the turn diff would then compare new against new and show
    // nothing at all.
    const priorText = this.store.hasEdits(projectId, relPath) ? null : this.knownText(projectId, relPath);
    const changed = applyContentTextIfChanged(relPath, document, disk.text);
    if (changed) {
      // The apply lands as a Yjs update → onChange → schedulePersist, which
      // records the ledger row; stamp attribution through a direct persist
      // instead so the row says 'external'.
      const pending = this.pendingPersist.get(documentName);
      if (pending) clearTimeout(pending);
      this.pendingPersist.delete(documentName);
      this.#recordAgentBaseline(projectId, relPath, actor, priorText);
      await this.persist(documentName, document, { actor, chatId, messageId, turnResolved, userId: authorId }).catch((error) => {
        this.log(`external persist failed doc=${logPath(documentName)} error=${error?.message}`);
      });
    }
    return changed ? 'mutated' : undefined;
  }

  /** Stage `contentText` as a pending SUGGESTION (markdown marks / code
   *  ledger) instead of a direct apply — the local rail for suggest-mode agent
   *  writes, mirroring the cloud doc server's suggest mutations. Disk gets the
   *  accepted-view projection (same contract as cloud `content_text`), so
   *  Read-after-write sees the doc as if the suggestion landed and a reject
   *  reverts the file through the normal persist. Returns true when staged. */
  async stageAgentSuggestion(projectId, relPath, contentText, { chatId = null, messageId = null, turnResolved = false, authorId = null, suggestionId = `a${randomUUID()}`, newFile = false } = {}) {
    const project = this.store.getProject(projectId);
    if (!project) return false;
    const loc = this.#loc(project, relPath);
    const documentName = `${projectId}/${relPath}`;
    // `agentTurnId` is the ledger's agent-authorship marker (cloud parity:
    // hocuspocus stamps assistantMessageId) — the code-suggestion pill resolves
    // it to the agent's face; without it the entry reads as an authorless human
    // stage and renders "SA" initials. The engine id (`ai:claude-code`…) stays
    // OFF the entry: agent runs post no user id, and stamping it would paint an
    // external-agent brand mark on the app's own agent.
    const meta = { chatId, agentTurnId: messageId };
    const live = this.loadedDocs.has(documentName) ? this.hocuspocus.documents.get(documentName) : null;
    // First-ever ledger touch of a PRE-EXISTING file: record its current text
    // as a baseline row first, or the session's diff has no "before" — the
    // panel would render a whole-file "New file" insertion, permanently once
    // the marks resolve (rejectedProjection only reads live marks). Watched
    // files earn this row from their first external event; a file untouched
    // since project open has none.
    if (!newFile && !this.store.hasEdits(projectId, relPath)) {
      const baseline = live
        ? readDocumentText(relPath, live)
        : (await readTextFile(loc.root, loc.rel).catch(() => null))?.text;
      if (baseline && baseline !== contentText) {
        // actor 'baseline': a content snapshot, not an edit anyone made —
        // history grouping hides it so no phantom "External app" session
        // appears; diffs and restore still read its content like any row.
        this.store.recordEdit({ projectId, path: relPath, actor: 'baseline', contentText: baseline });
      }
    }
    if (live) {
      // Creation marker only when the file doesn't exist on disk (by stat —
      // an unreadable file still EXISTS) or the caller vouched the path as
      // the run's own creation (a Bash creation already wrote the bytes) — an
      // existing empty file must revert to empty on reject, not be deleted.
      const liveAbs = resolveInRoot(loc.root, loc.rel);
      const creates =
        readDocumentText(relPath, live) === '' &&
        (newFile || !(liveAbs && (await fsp.stat(liveAbs).catch(() => null))));
      if (!applySuggestionIfChanged(relPath, live, contentText, suggestionId, meta)) return false;
      if (creates) live.getMap(LOCAL_META_ROOT).set('pendingCreation', String(suggestionId));
      // Same shape as handleDiskChange: cancel the hook-scheduled persist and
      // stamp attribution through a direct one so the row says suggest/agent.
      const pending = this.pendingPersist.get(documentName);
      if (pending) clearTimeout(pending);
      this.pendingPersist.delete(documentName);
      // rethrow: a failed disk write / state save must fail the tool call, not
      // report a staged suggestion that was never durably written.
      await this.queuePersist(documentName, live, { actor: 'agent', userId: authorId, chatId, messageId, turnResolved, editMode: 'suggest', suggestionId }, { rethrow: true });
      return true;
    }
    // Closed file: stage into the stored CRDT state (or seed a baseline).
    const scratch = new Y.Doc();
    try {
      let stored = this.store.getDocState(projectId, relPath);
      // A caller-vouched creation (watcher: an agent write at an unseen path)
      // outranks store traces: doc state surviving an offline delete is
      // stale, and diffing against it would reject-resurrect dead content.
      // The old file id retires with it — editors key delete+recreate on a
      // FRESH id to drop cached Y.Docs.
      if (newFile && stored) {
        this.store.deleteDocState(projectId, relPath);
        this.store.retireFileId(projectId, relPath);
        stored = null;
      }
      const disk = await readTextFile(loc.root, loc.rel).catch(() => null);
      if (!disk) {
        // Distinguish MISSING from UNREADABLE (oversized/permissions): an
        // existing file we can't read has no recoverable baseline — decline,
        // so it can never be marked a creation whose reject would delete it.
        const abs = resolveInRoot(loc.root, loc.rel);
        if (abs && (await fsp.stat(abs).catch(() => null))) return false;
        // MISSING with stored CRDT state = the file was deleted while the
        // sidecar wasn't watching. Disk is the source of truth: drop the stale
        // state so this write stages as a CREATION — rejecting it must delete
        // the new file, not resurrect the dead content as its baseline.
        if (stored) {
          this.store.deleteDocState(projectId, relPath);
          stored = null;
        }
      }
      if (stored) {
        Y.applyUpdate(scratch, stored.state);
        // Catch up to disk first so the suggestion diffs against what the user
        // actually has — but NOT when disk already equals the suggestion (a
        // Bash write landed before staging): folding it in would erase the
        // very diff being staged.
        if (disk && disk.text !== contentText && stored.contentHash !== contentHash(disk.text)) {
          applyContentTextIfChanged(relPath, scratch, disk.text);
        }
      } else if (disk && disk.text === contentText && !newFile) {
        // Untracked file already holding the new bytes (a Bash write beat us
        // here) — the baseline is lost, and staging against an empty doc would
        // fabricate a whole-file insertion. Fall back to a direct record.
        // `newFile` (an agent write at an unseen path) bypasses this: its
        // true baseline IS empty.
        return false;
      } else if (disk?.text && disk.text !== contentText) {
        seedDocumentFromText(relPath, scratch, disk.text);
      }
      // A brand-new file (no disk) diffs against the empty doc: the whole
      // content stages as one pending insertion, like cloud pending additions.
      if (!applySuggestionIfChanged(relPath, scratch, contentText, suggestionId, meta)) return false;
      // This suggestion CREATES the file (nothing on disk, or a vouched
      // creation): the marker lets a later reject delete it instead
      // of persisting an empty husk. A pre-existing EMPTY file is NOT a
      // creation — its reject must revert to empty, not remove it.
      if (!stored && (!disk || newFile)) {
        scratch.getMap(LOCAL_META_ROOT).set('pendingCreation', String(suggestionId));
      }
      const text = readDocumentText(relPath, scratch);
      if (disk?.text !== text) {
        this.watchers.get(projectId)?.suppress(relPath);
        await writeTextFileAtomic(loc.root, loc.rel, text);
      }
      this.store.saveDocState(projectId, relPath, Y.encodeStateAsUpdate(scratch), contentHash(text));
      this.store.recordEdit({
        projectId,
        path: relPath,
        actor: 'agent',
        authorId,
        editMode: 'suggest',
        chatId,
        messageId,
        // Without this the closed-file staging path drops the "ambiguous,
        // claim no turn" decision and recordEdit guesses from the chat again.
        turnResolved,
        suggestionId,
        contentText: text,
      });
      return true;
    } finally {
      scratch.destroy();
    }
  }

  #suggestionLive(relPath, doc, id) {
    return isMarkdownDocument(relPath) ? hasSuggestionMark(doc, id) : hasCodeSuggestion(doc, id);
  }

  /** Whether any of `ids` is still an unresolved suggestion in the file's doc
   *  — the Review panel's pending-vs-applied classification. Live docs are
   *  probed directly; closed docs decode their stored state once per state
   *  version (cached — see suggestionProbes). */
  hasPendingSuggestions(projectId, relPath, ids) {
    if (!ids?.length) return false;
    const documentName = `${projectId}/${relPath}`;
    const live = this.loadedDocs.has(documentName) ? this.hocuspocus.documents.get(documentName) : null;
    if (live) return ids.some((id) => this.#suggestionLive(relPath, live, id));
    const stored = this.store.getDocState(projectId, relPath);
    if (!stored) return false; // deleted (e.g. a rejected creation) — nothing pending
    let cached = this.suggestionProbes.get(documentName);
    if (!cached || cached.at !== stored.updatedAt) {
      cached = { at: stored.updatedAt, live: new Map() };
      this.suggestionProbes.set(documentName, cached);
    }
    if (ids.some((id) => !cached.live.has(id))) {
      const probe = new Y.Doc();
      try {
        Y.applyUpdate(probe, stored.state);
        for (const id of ids) cached.live.set(id, this.#suggestionLive(relPath, probe, id));
      } finally {
        probe.destroy();
      }
    }
    return ids.some((id) => cached.live.get(id) === true);
  }

  /** A session's PRE-suggestion text, reconstructed by reject-projecting its
   *  still-live suggestion ids on a clone — the diff baseline for a suggest
   *  session whose path has no earlier ledger row (first-ever edit of a
   *  pre-existing file). Null when none of the ids is live (resolved history
   *  keeps the ledger-derived baseline). */
  async rejectedProjection(projectId, relPath, ids) {
    if (!ids?.length) return null;
    const project = this.store.getProject(projectId);
    if (!project) return null;
    const documentName = `${projectId}/${relPath}`;
    const live = this.loadedDocs.has(documentName) ? this.hocuspocus.documents.get(documentName) : null;
    const stored = live ? null : this.store.getDocState(projectId, relPath);
    const state = live ? Y.encodeStateAsUpdate(live) : stored?.state;
    if (!state) return null;
    const probe = new Y.Doc();
    try {
      Y.applyUpdate(probe, state);
      // Same disk catch-up as resolveSuggestions: stored state can lag disk
      // for closed files, and a stale projection would render the external
      // edit inside the pending suggestion's diff. A fold that dissolves the
      // marks returns null below — the caller falls back to the recorded
      // session diff instead of misattributing.
      if (stored) {
        const loc = this.#loc(project, relPath);
        const disk = await readTextFile(loc.root, loc.rel).catch(() => null);
        if (!disk) return null;
        if (stored.contentHash !== contentHash(disk.text)) applyContentTextIfChanged(relPath, probe, disk.text);
      }
      let any = false;
      for (const id of ids) {
        if (!this.#suggestionLive(relPath, probe, id)) continue;
        if (isMarkdownDocument(relPath)) resolveSuggestion(probe, id, 'reject');
        else rejectCodeSuggestion(probe, id, { tombstone: false });
        any = true;
      }
      return any ? readDocumentText(relPath, probe) : null;
    } finally {
      probe.destroy();
    }
  }

  /** Accept/reject a session's staged suggestions by id — the Review panel's
   *  Keep/Undo rail, converging with the editor's inline ✓/✕ on the same CRDT
   *  state. Live docs mutate in place (connected editors see the marks clear);
   *  closed docs resolve on their stored state. Both persist through the
   *  normal rail, so disk gets the accepted/reverted projection and a rejected
   *  CREATION deletes its file (the pendingCreation gate in persist). */
  async resolveSuggestions(projectId, relPath, ids, action, { actor = 'user', chatId = null } = {}) {
    const project = this.store.getProject(projectId);
    if (!project || !ids?.length) return { changed: false };
    const documentName = `${projectId}/${relPath}`;
    const resolveIn = (doc) => {
      const resolvedIds = [];
      for (const id of ids) {
        if (!this.#suggestionLive(relPath, doc, id)) continue; // already decided inline
        if (isMarkdownDocument(relPath)) resolveSuggestion(doc, id, action);
        else if (action === 'accept') acceptCodeSuggestion(doc, id);
        else rejectCodeSuggestion(doc, id);
        resolvedIds.push(id);
      }
      return resolvedIds;
    };
    const live = this.loadedDocs.has(documentName) ? this.hocuspocus.documents.get(documentName) : null;
    if (live) {
      if (resolveIn(live).length === 0) return { changed: false };
      // Same shape as stageAgentSuggestion: cancel the hook-scheduled persist
      // and stamp attribution through a direct one; rethrow so a failed disk
      // write fails the request instead of reporting a resolved suggestion.
      const pending = this.pendingPersist.get(documentName);
      if (pending) clearTimeout(pending);
      this.pendingPersist.delete(documentName);
      await this.queuePersist(documentName, live, { actor, chatId }, { rethrow: true });
      return { changed: true };
    }
    const stored = this.store.getDocState(projectId, relPath);
    if (!stored) return { changed: false };
    // Stored state can lag disk: external writes to a CLOSED file record a
    // ledger row but never touch doc_states. Resolving stale state and
    // persisting its projection would clobber those edits — and a file gone
    // (or unreadable) while unwatched must not be resurrected. Reconcile
    // first, decline when disk can't answer.
    const loc = this.#loc(project, relPath);
    const disk = await readTextFile(loc.root, loc.rel).catch(() => null);
    if (!disk) {
      // UNREADABLE (oversized/permissions) still exists — leave it alone.
      const abs = resolveInRoot(loc.root, loc.rel);
      if (abs && (await fsp.stat(abs).catch(() => null))) return { changed: false };
      // Really gone (deleted while unwatched): run the standard delete
      // reconciliation so the stale doc state retires and the phantom
      // pending entry clears instead of zombie-ing at every poll.
      await this.handleDiskDelete(projectId, relPath, { actor: 'external' });
      this.onFileRemoved?.(projectId, relPath);
      return { changed: false };
    }
    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, stored.state);
      // Disk is authoritative: fold newer bytes in before resolving. The fold
      // can dissolve marks whose block changed (same as the editor's cold-load
      // catch-up) — persist the convergence even when nothing was left to
      // resolve, so the stale pending classification heals instead of the
      // entry zombie-ing at every poll.
      const caughtUp =
        stored.contentHash !== contentHash(disk.text) && applyContentTextIfChanged(relPath, scratch, disk.text);
      const resolvedIds = resolveIn(scratch);
      if (resolvedIds.length === 0 && !caughtUp) return { changed: false };
      await this.queuePersist(documentName, scratch, { actor, chatId }, { rethrow: true });
      // A scratch doc has no update listener, so nothing queued into
      // pendingDecisions — record the closed-doc decisions explicitly, or the
      // ledger loses the true local actor for panel Keep/Undo on closed files.
      for (const id of resolvedIds) {
        this.store.recordDecision({
          projectId, path: relPath, suggestionId: id,
          suggestionKind: isMarkdownDocument(relPath) ? 'markdown' : 'code',
          decision: action, actor,
        });
      }
      return { changed: true };
    } finally {
      // persist() stamped disk/state tracking for a doc that was never loaded
      // — clear it so a later real load seeds fresh from disk, not from the
      // scratch's leftovers. (Guarded: a concurrent load owns these now.)
      if (!this.loadedDocs.has(documentName)) {
        this.lastDiskText.delete(documentName);
        this.lastStateVectors.delete(documentName);
        this.lastPersistedDisk.delete(documentName);
        this.canonicalCache.delete(documentName);
      }
      scratch.destroy();
    }
  }

  /** Detach every live doc at `rel` or under `rel/` (file or folder events):
   *  stop writeback and close connections so clients rebind after the tree
   *  refresh instead of resurrecting moved/deleted files. */
  async detachUnder(projectId, rel) {
    const prefix = `${projectId}/${rel}`;
    for (const documentName of Array.from(this.hocuspocus.documents.keys())) {
      if (documentName !== prefix && !documentName.startsWith(`${prefix}/`)) continue;
      this.detached.add(documentName);
      this.hocuspocus.closeConnections(documentName);
      // Evict the loaded doc too: with connections closed it would otherwise
      // linger in memory holding the dead file's ops, and anything recreated
      // at this path (a cloud re-share, a fresh create) would bind the ZOMBIE
      // doc — skipping onLoadDocument and inheriting stale detachment and
      // stale content. If store work is still pending, Hocuspocus unloads it
      // itself right after (connections are zero); persist() skips detached
      // docs, so the interim store is a no-op.
      const document = this.hocuspocus.documents.get(documentName);
      if (document) {
        // A pending store debounce blocks the unload gate — flush it and WAIT
        // (persist() skips detached docs, so the store is a no-op) before
        // unloading, or the doc would linger until the store's own retry and
        // a recreated path could bind the zombie in between.
        const storeKey = `onStoreDocument-${documentName}`;
        if (this.hocuspocus.debouncer.isDebounced(storeKey)) {
          await Promise.resolve(this.hocuspocus.debouncer.executeNow(storeKey)).catch(() => {});
        }
        // A store already mid-execution also gates the unload — wait out its
        // exclusive section. (Its own finally re-attempts the unload too, so
        // any sub-tick residue self-heals; persist() skips detached docs.)
        await document.saveMutex.waitForUnlock().catch(() => {});
        await this.hocuspocus.unloadDocument(document);
      }
    }
  }

  async handleDiskRename(projectId, fromRel, toRel) {
    // Keystrokes typed since the last persist live only in the Y.Doc — save
    // each live doc's CURRENT state before moving the rows, or the renamed
    // path loads the pre-keystroke state and the debounce window is lost.
    // They also go straight into the RENAMED file: waiting for a future edit
    // would leave the file stale for external tools (git, greps). The state
    // is hashed against whatever actually ends up on disk, so the new path's
    // load never runs a catch-up that would revert the doc.
    const prefix = `${projectId}/${fromRel}`;
    const project = this.store.getProject(projectId);
    for (const [documentName, document] of this.hocuspocus.documents.entries()) {
      if (documentName !== prefix && !documentName.startsWith(`${prefix}/`)) continue;
      if (!this.loadedDocs.has(documentName)) continue;
      const meta = parseDocumentName(documentName);
      if (!meta) continue;
      const text = readDocumentText(meta.path, document);
      const diskText = this.lastDiskText.get(documentName);
      let onDisk = diskText ?? text;
      // Same equivalence skip as persist(): a rename must not restyle a file
      // whose bytes already express the doc (external-editor interop).
      if (text !== onDisk && project && canonicalizeContentText(meta.path, onDisk) !== text) {
        const toPath = meta.path === fromRel ? toRel : `${toRel}${meta.path.slice(fromRel.length)}`;
        this.watchers.get(projectId)?.suppress(toPath);
        try {
          const loc = this.#loc(project, toPath);
          await writeTextFileAtomic(loc.root, loc.rel, text);
          onDisk = text;
        } catch { /* keystrokes stay in the saved state; next persist retries */ }
      }
      this.store.saveDocState(meta.projectId, meta.path, Y.encodeStateAsUpdate(document), contentHash(onDisk));
    }
    this.store.renameDocState(projectId, fromRel, toRel);
    this.store.renameFileIds(projectId, fromRel, toRel);
    await this.detachUnder(projectId, fromRel);
  }

  /** Capture a to-be-deleted doc's history for rename adoption: live doc
   *  state when loaded (keystrokes since the last persist live only there),
   *  else the persisted row. Keyed by content hash — the same signal
   *  isRenameDestination matches the create half of a `mv` on. */
  #stashDeletedState(projectId, rel) {
    const documentName = `${projectId}/${rel}`;
    const document = this.loadedDocs.has(documentName)
      ? this.hocuspocus.documents.get(documentName)
      : null;
    let state = null;
    let hash = null;
    if (document) {
      state = Y.encodeStateAsUpdate(document);
      hash = contentHash(this.lastDiskText.get(documentName) ?? readDocumentText(rel, document));
    } else {
      const stored = this.store.getDocState(projectId, rel);
      if (!stored) return;
      state = stored.state;
      hash = stored.contentHash;
    }
    if (!state || !hash) return;
    // The file id too: retireFileId (the teardown below the stash call) drops
    // the row, so adoption must restore rather than rename it.
    const fileId = this.store.knownFileId(projectId, rel);
    const key = `${projectId} ${hash}`;
    const entry = { at: Date.now(), rel, state, contentHash: hash, fileId };
    // The create half already arrived and found nothing to adopt: fulfill its
    // pending claim now, before the teardown drops this state for good.
    const pending = this.#takeAdoptionMatch(this.pendingAdoptions, key, rel);
    if (pending && this.#adoptState(projectId, pending.rel, entry)) return;
    const list = this.recentDeleteStates.get(key);
    if (list) list.push(entry);
    else this.recentDeleteStates.set(key, [entry]);
  }

  /** Pop the entry pairing best with `rel` from a hash-keyed list map, after
   *  expiring stale entries: same basename first (a folder rename moves
   *  `dir/a.md` to `dir2/a.md`, and two identical-content files must each
   *  keep their own identity), else oldest first. */
  #takeAdoptionMatch(map, key, rel) {
    this.#pruneAdoptionMap(map);
    const entries = map.get(key);
    if (!entries) return null;
    const base = rel.split('/').pop();
    const index = Math.max(entries.findIndex((entry) => entry.rel.split('/').pop() === base), 0);
    const [entry] = entries.splice(index, 1);
    if (!entries.length) map.delete(key);
    return entry;
  }

  #pruneAdoptionMap(map) {
    const cutoff = Date.now() - 10_000;
    for (const [key, entries] of map) {
      const fresh = entries.filter((entry) => entry.at >= cutoff);
      if (fresh.length) map.set(key, fresh);
      else map.delete(key);
    }
  }

  /** Move a stashed doc's history and identity to `relPath`. */
  #adoptState(projectId, relPath, entry) {
    // Never clobber a destination that already has its own history.
    if (this.loadedDocs.has(`${projectId}/${relPath}`) || this.store.getDocState(projectId, relPath)) return false;
    this.store.saveDocState(projectId, relPath, entry.state, entry.contentHash);
    // Restore the file identity under the new path (retireFileId dropped, or
    // is about to drop, the source row) so the editor keeps treating it as
    // the same file.
    if (entry.fileId && !this.store.knownFileId(projectId, relPath)) {
      this.store.setFileId(projectId, relPath, entry.fileId);
    }
    this.store.renameCommentPaths(projectId, entry.rel, relPath);
    return true;
  }

  /** The create half of a watcher rename: when a brand-new path's bytes match
   *  a just-deleted doc, move that doc's history (and file identity) to the
   *  new path instead of letting the load re-seed from disk. Returns true on
   *  adoption. Exact-hash only — a near-match is a different file. */
  adoptRenamedState(projectId, relPath, diskText) {
    const key = `${projectId} ${contentHash(diskText)}`;
    const entry = this.#takeAdoptionMatch(this.recentDeleteStates, key, relPath);
    if (!entry) {
      // The create half arrived first: leave a pending claim for the delete
      // half (#stashDeletedState) to fulfill before the teardown drops the
      // source's state — otherwise the destination seeds fresh and the
      // histories fork.
      this.#pruneAdoptionMap(this.pendingAdoptions);
      const list = this.pendingAdoptions.get(key);
      if (list) list.push({ at: Date.now(), rel: relPath });
      else this.pendingAdoptions.set(key, [{ at: Date.now(), rel: relPath }]);
      return false;
    }
    return this.#adoptState(projectId, relPath, entry);
  }

  /** Remember WHAT was just deleted (by content hash): a "new" file matching
   *  a recent delete is a RENAME destination, and renames stay direct — a
   *  staged creation there would delete the only remaining copy on reject. */
  noteDeletedContent(projectId, rel) {
    const documentName = `${projectId}/${rel}`;
    const hash = this.lastDiskText.has(documentName)
      ? contentHash(this.lastDiskText.get(documentName))
      : this.store.getDocState(projectId, rel)?.contentHash ??
        this.store.lastRecordedHash(projectId, rel);
    if (hash) this.recentDeleteHashes.set(`${projectId} ${hash}`, Date.now());
  }

  /** Order-independent rename detection for a would-be creation: the bytes
   *  match either a JUST-processed delete, or a tracked path whose file is
   *  already missing on disk (the rename's delete event hasn't landed yet —
   *  fs.watch guarantees no ordering between a rename's two events). */
  async isRenameDestination(project, hash) {
    const cutoff = Date.now() - 10_000;
    for (const [key, at] of this.recentDeleteHashes) {
      if (at < cutoff) this.recentDeleteHashes.delete(key);
    }
    if (this.recentDeleteHashes.has(`${project.id} ${hash}`)) return true;
    for (const rel of this.store.pathsByContentHash(project.id, hash)) {
      const loc = this.#loc(project, rel);
      const abs = resolveInRoot(loc.root, loc.rel);
      if (abs && !(await fsp.stat(abs).catch(() => null))) return true;
    }
    return false;
  }

  async handleDiskDelete(projectId, rel, { record = true, actor = 'external', chatId = null, messageId = null, turnResolved = false, authorId = null, fromWatcher = false } = {}) {
    // fsevents can deliver a delete SECONDS late. If the doc at this exact
    // path loaded after the file was already gone, that event predates the
    // doc — detaching/purging would clobber the re-created doc and suppress
    // its first writeback (the offline-rescue re-share hit exactly this).
    // ONE-SHOT and TIME-BOUND: only the predecessor's single late echo
    // qualifies — a second delete, or one arriving well after the load, is
    // about the current generation (e.g. a rapid create+delete the watcher
    // coalesced past us) and must be honored.
    // Only WATCHER events can be stale echoes — every other caller (delete
    // API, the bridge's cloud-delete mirror) just performed the delete itself
    // and must never be swallowed, or its file resurrects via the live doc.
    const loadedAt = this.loadedWithoutDisk.get(`${projectId}/${rel}`);
    if (loadedAt !== undefined) {
      this.loadedWithoutDisk.delete(`${projectId}/${rel}`);
      // `true` = stale echo swallowed — the caller must not forward this
      // event to the bridges either (they would read the still-absent path
      // as a local delete and remove the collaborator's new cloud file).
      if (fromWatcher && Date.now() - loadedAt < 15_000) return true;
    }
    // A real delete flows on — keep the watcher's known-paths set honest so
    // a later recreation reads as a creation, and remember the content hash
    // so a rename destination is never misread as a creation.
    this.watchers.get(projectId)?.markGone(rel);
    if (fileKindForFile(rel) === 'text') this.noteDeletedContent(projectId, rel);
    // BEFORE the teardown below drops the live doc and the stored state: a
    // tombstone needs a previous row to anchor on (recordDeleteTombstone is a
    // no-op without one), so an agent deleting a file it never touched would
    // leave NOTHING in the turn diff or the history. Capture what it deleted
    // while that is still knowable.
    // Tracked paths, NOT just ledger paths: a child with only doc_state /
    // file_id (opened or listed, never edited) is exactly the case that has no
    // baseline, and deleteDocState below is about to drop its last trace.
    const childPaths =
      fileKindForFile(rel) === 'text'
        ? [rel]
        : [
            ...new Set([
              ...this.store.listEditPathsUnder(projectId, rel),
              ...this.store.listTrackedPaths(projectId, rel),
            ]),
          ];
    const deletedPaths =
      record && actor === 'agent'
        ? childPaths.filter(
            (candidate) => fileKindForFile(candidate) === 'text' && !this.store.hasEdits(projectId, candidate),
          )
        : [];
    const baselines = new Map(deletedPaths.map((candidate) => [candidate, this.knownText(projectId, candidate)]));
    // Existence, read BEFORE retireFileId below wipes it: a file that was
    // listed but never opened and never edited has no recoverable text, but it
    // was real — without this its deletion has nothing to anchor a tombstone
    // on and drops out of the turn diff entirely.
    const existedBefore = new Map(
      deletedPaths.map((candidate) => [
        candidate,
        baselines.get(candidate) !== null || this.store.hasFileId(projectId, candidate),
      ]),
    );
    // Stash each deleted text doc's history BEFORE the teardown drops it, so
    // a rename destination (the create half of a raw `mv`) can adopt it and
    // keep the CRDT history continuous across the move (see the field's
    // comment in the constructor).
    for (const candidate of fileKindForFile(rel) === 'text' ? [rel] : childPaths) {
      if (fileKindForFile(candidate) === 'text') this.#stashDeletedState(projectId, candidate);
    }
    await this.detachUnder(projectId, rel);
    this.store.deleteDocState(projectId, rel);
    this.store.retireFileId(projectId, rel);
    if (!record) return;
    const tombstone = (candidate) => {
      this.#recordAgentBaseline(projectId, candidate, actor, baselines.get(candidate) ?? null);
      this.store.recordDeleteTombstone(
        projectId,
        candidate,
        actor,
        chatId,
        authorId,
        messageId,
        turnResolved,
        existedBefore.get(candidate) ?? false,
      );
    };
    if (fileKindForFile(rel) === 'text') {
      tombstone(rel);
      return;
    }
    // A deleted FOLDER arrives as one event for the folder path — stamp every
    // tracked text child, or their history reads as still-alive forever. Same
    // union as the baseline sweep: a child the agent deleted without ever
    // editing has no ledger row to find it by.
    for (const child of childPaths) {
      if (fileKindForFile(child) === 'text') {
        this.noteDeletedContent(projectId, child);
        tombstone(child);
      }
    }
  }

  /** Per-file delete handling under a folder that itself still exists (a
   *  tree delete that preserved protected children like .git): live docs
   *  detach, and CLOSED children's stored identity/state is retired too —
   *  recreating such a path must mint a fresh file, not resurrect the old
   *  Y.Doc identity. */
  async detachMissingUnder(projectId, rel, attribution = {}) {
    const project = this.store.getProject(projectId);
    if (!project) return;
    const prefix = `${projectId}/${rel}/`;
    const candidates = new Set(this.store.listTrackedPaths(projectId, rel));
    for (const documentName of Array.from(this.hocuspocus.documents.keys())) {
      if (documentName.startsWith(prefix)) candidates.add(documentName.slice(`${projectId}/`.length));
    }
    for (const childRel of candidates) {
      const loc = this.#loc(project, childRel);
      const abs = resolveInRoot(loc.root, loc.rel);
      const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
      if (!stat) await this.handleDiskDelete(projectId, childRel, attribution);
    }
  }

  /** Live doc text when the file is open (includes unflushed keystrokes). */
  /** First-ever ledger touch of a pre-existing file by the AGENT: snapshot the
   *  text it is about to replace, or the turn's diff has no "before" and the
   *  chat's chip renders a modification as a whole-file insertion. The Tier-1
   *  writer does this before writing; the watcher path can't (disk already
   *  holds the new bytes), so the last text we still know is the live doc, then
   *  the persisted Y.Doc state. A file that has never been opened AND has no
   *  ledger history leaves no baseline anywhere — unless the watcher's
   *  first-sight capture caught a prior generation's bytes (passed in as
   *  `priorText`). Actor 'baseline' — a snapshot, not an edit anyone made. */
  #recordAgentBaseline(projectId, relPath, actor, priorText = null) {
    // An EXPLICIT priorText is the caller's own capture of what disk/doc held
    // just now, and beats stale history: a recreated file's first-sight bytes
    // must land even when an old tombstone means hasEdits — otherwise the
    // diff's "before" is the tombstone, not the user's recreated content.
    if (actor !== 'agent' || (priorText === null && this.store.hasEdits(projectId, relPath))) return;
    // `priorText` is the caller's pre-teardown or first-sight capture — the
    // open-doc and delete paths have dropped the live text by the time we run.
    const previous = priorText ?? this.knownText(projectId, relPath);
    // `null` is "we never knew this file's text"; '' is a file we know to be
    // EMPTY, and it needs its baseline just as much — without a row, a delete
    // finds no prior state and records no tombstone, so first-touching an
    // empty file then deleting it vanished from the turn diff entirely.
    if (typeof previous === 'string') {
      this.store.recordEdit({ projectId, path: relPath, actor: 'baseline', contentText: previous });
    }
  }

  /** The file's text as the sidecar still knows it: the live doc, else the
   *  persisted Y.Doc state. Null when neither exists — a file that has never
   *  been opened leaves no trace to recover once disk has moved on. */
  knownText(projectId, relPath) {
    const live = this.getLiveText(projectId, relPath);
    if (live !== null) return live;
    const stored = this.store.getDocState(projectId, relPath);
    if (!stored?.state) return null;
    const probe = new Y.Doc();
    try {
      Y.applyUpdate(probe, stored.state);
      return readDocumentText(relPath, probe);
    } catch {
      return null;
    } finally {
      probe.destroy();
    }
  }

  getLiveText(projectId, relPath) {
    const documentName = `${projectId}/${relPath}`;
    if (!this.loadedDocs.has(documentName)) return null;
    const document = this.hocuspocus.documents.get(documentName);
    return document ? readDocumentText(relPath, document) : null;
  }

  async flushAll() {
    const docs = Array.from(this.hocuspocus.documents.entries());
    await Promise.all(
      docs.map(([documentName, document]) =>
        this.persist(documentName, document, {}).catch(() => {}),
      ),
    );
  }

  /** Flush one project's live docs to disk (queued behind in-flight persists,
   *  so no double-recorded ledger rows) — compile reads the files from disk
   *  and must see unflushed keystrokes. */
  async flushProject(projectId) {
    const prefix = `${projectId}/`;
    const docs = Array.from(this.hocuspocus.documents.entries()).filter(([name]) =>
      name.startsWith(prefix),
    );
    await Promise.all(docs.map(([name, document]) => this.queuePersist(name, document, {})));
  }
}

function uint8Equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
