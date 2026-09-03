// Self-update for the SUPERVISED headless daemon (serve.sh --install): the
// login unit pins whatever bundle it was installed with, while every web
// deploy ships a matching /serve.mjs — without this, a unit-run daemon
// drifts behind the cloud forever (the exact skew SIDECAR_API_VERSION
// exists to catch). The daemon periodically fetches the origin's bundle,
// and when the bytes differ: check the release signature (update-key.mjs),
// syntax-verify with the same Node that will run it, swap atomically (old
// copy kept at .prev), and report update-applied — the caller exits cleanly
// and the supervisor relaunches onto the new code.
//
// The signature is the load-bearing half: this is an arbitrary-code channel,
// so `node --check` (which only proves the bytes PARSE) can never be the only
// gate. See update-key.mjs for the key and how it is provisioned.
//
// Unsupervised (foreground) runs must NOT restart themselves — exiting would
// stop sync with nobody to relaunch it — so they only surface the news; the
// next serve.sh run refetches anyway.

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { UPDATE_PUBLIC_KEY } from './update-key.mjs';

const execFileAsync = promisify(execFile);

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// A raw ed25519 public key carries no algorithm identifier, so wrap the 32
// key bytes in the one fixed SPKI header createPublicKey() understands. This
// is what lets update-key.mjs hold a plain 44-char base64 string a human can
// eyeball against the release key instead of a PEM block.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The embedded trust anchor as a KeyObject, or null when signing is not
 *  provisioned (empty constant) or the value is malformed. */
export function updateSigningKey(raw = UPDATE_PUBLIC_KEY) {
  const bytes = Buffer.from(String(raw || '').trim(), 'base64');
  if (bytes.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/**
 * Integrity gate for the served bundle: 'ok' when a detached ed25519
 * signature at `${app}/serve.mjs.sig` covers exactly these bytes, 'bad' when
 * the signature is missing, unfetchable or wrong, and 'unsigned' when no key
 * is embedded yet (pre-provisioning behaviour — see update-key.mjs).
 *
 * 'bad' must always refuse the swap: the running daemon keeps executing the
 * code it already verified, which is strictly safer than TLS-only trust.
 */
async function verifyServedBundle({ app, bundle, publicKey = UPDATE_PUBLIC_KEY, log = () => {} }) {
  const key = updateSigningKey(publicKey);
  if (!key) return 'unsigned';
  const res = await fetch(`${app}/serve.mjs.sig`).catch((error) => {
    log(`[sundial-local] update check: ${app}/serve.mjs.sig unreachable (${error?.message})`);
    return null;
  });
  if (!res?.ok) {
    if (res) log(`[sundial-local] update check: ${app}/serve.mjs.sig -> ${res.status}`);
    return 'bad';
  }
  const signature = Buffer.from((await res.text().catch(() => '')).trim(), 'base64');
  if (signature.length !== 64 || !verifySignature(null, bundle, key, signature)) {
    log('[sundial-local] update check: bundle signature does not verify, keeping current');
    return 'bad';
  }
  return 'ok';
}

/**
 * Compare the served bundle with the one at `bundlePath` and apply it when
 * newer. Returns 'current' | 'applied' | 'failed'. Never throws — a broken
 * network or a bad download must leave the running daemon untouched.
 *
 * `loadedHash` is the sha256 of the bundle this process actually LOADED at
 * boot. It closes the blind spot that stranded a daemon on stale code: every
 * serve.sh run overwrites the file on disk, so comparing the deployed bytes
 * to the FILE alone reports 'current' while the running process still
 * executes the old code — forever. With loadedHash, a disk file that already
 * matches the deployment but not the running code returns 'applied' (no
 * rewrite needed) so a supervised daemon relaunches onto it.
 *
 * `publicKey` defaults to the embedded release key and exists so tests can
 * drive both the armed and the not-yet-provisioned channel; nothing in
 * production passes it.
 */
export async function checkAndApplyUpdate({ app, bundlePath, nodeBin = process.execPath, log = () => {}, loadedHash = /** @type {string | null} */ (null), publicKey = UPDATE_PUBLIC_KEY }) {
  try {
    const res = await fetch(`${app}/serve.mjs`);
    if (!res.ok) {
      log(`[sundial-local] update check: ${app}/serve.mjs -> ${res.status}`);
      return 'failed';
    }
    const fresh = Buffer.from(await res.arrayBuffer());
    if (fresh.length === 0) return 'failed';
    // Before any decision, including the relaunch-onto-disk branch below: an
    // unverifiable bundle is not a candidate for anything.
    if ((await verifyServedBundle({ app, bundle: fresh, publicKey, log })) === 'bad') return 'failed';
    const current = await fsp.readFile(bundlePath).catch(() => null);
    if (current && current.equals(fresh)) {
      if (!loadedHash || loadedHash === sha256Hex(fresh)) return 'current';
      // The disk already carries the deployment (an external serve.sh run
      // replaced it) but WE are running older code. Verify the file parses,
      // then report applied so the supervisor relaunches onto it — nothing
      // to write, and no .prev: the outgoing code exists only in memory.
      try {
        await execFileAsync(nodeBin, ['--check', bundlePath]);
      } catch (error) {
        log(`[sundial-local] update check: on-disk bundle failed --check, staying on loaded code (${error?.message})`);
        return 'failed';
      }
      log('[sundial-local] update applied: disk bundle is newer than the running code');
      return 'applied';
    }

    // Never swap in a bundle the runtime can't even parse (a truncated body,
    // a CDN error page): --check parses without executing. The temp name must
    // END in .mjs — node --check refuses unknown extensions outright.
    const tmp = `${bundlePath}.update-${process.pid}.mjs`;
    await fsp.writeFile(tmp, fresh);
    try {
      await execFileAsync(nodeBin, ['--check', tmp]);
    } catch (error) {
      await fsp.rm(tmp, { force: true });
      log(`[sundial-local] update check: fetched bundle failed --check, keeping current (${error?.message})`);
      return 'failed';
    }
    // Keep the outgoing bundle for manual rollback, then swap atomically.
    if (current) await fsp.writeFile(`${bundlePath}.prev`, current);
    await fsp.rename(tmp, bundlePath);
    log('[sundial-local] update applied: new sidecar bundle in place');
    return 'applied';
  } catch (error) {
    log(`[sundial-local] update check failed: ${error?.message}`);
    return 'failed';
  }
}

/** Check on boot and every `intervalMs` (default 6h). When an update lands
 *  under supervision, `onApplied` runs (graceful shutdown → supervisor
 *  relaunch); unsupervised callers pass an onApplied that only logs. The
 *  timer is unref'd so it never holds shutdown open. */
export function armSelfUpdate({ app, bundlePath, onApplied, log = () => {}, intervalMs = 6 * 60 * 60 * 1000, loadedHash = /** @type {string | null} */ (null) }) {
  const tick = async () => {
    if ((await checkAndApplyUpdate({ app, bundlePath, log, loadedHash })) === 'applied') await onApplied();
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return timer;
}
