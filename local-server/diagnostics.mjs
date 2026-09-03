/**
 * Best-effort error diagnostics shipping for the sidecar.
 *
 * Every log line flows through observe(). Ordinary lines only feed a small
 * ring buffer; a line that looks like an error flushes that ring (as context)
 * plus itself into a pending batch, shipped to the deployment's
 * /api/workspace/local-agent/diagnostics route with a share's own bridge
 * token — the exact rail the sync-progress heartbeat uses, so no new
 * credential exists. File CONTENTS never enter log lines, so none ship.
 *
 * Failure posture mirrors the heartbeat: batched, capped per day, dropped on
 * any failure, never retried into a growing queue, never blocking sync.
 * SUNDIAL_NO_DIAGNOSTICS=1 disables the sink entirely (disclosed in /start).
 */

const ERROR_RX = /\b(fail|failed|fatal|error|cannot|unavailable|parked|refus\w*|mismatch|skip|EADDRINUSE|EACCES|ENOSPC|ETIMEDOUT|ECONNREFUSED)\b/i;
const ENTRY_OVERHEAD_BYTES = 32;

export function diagnosticsDisabled(env = process.env) {
  return env.SUNDIAL_NO_DIAGNOSTICS === '1';
}

export function isDiagnosticLine(message) {
  return ERROR_RX.test(message);
}

export function createDiagnosticsSink({
  resolveTarget, // () => { origin, token, workspaceId } | null
  envelope, // () => flat object of install facts
  fetchImpl = globalThis.fetch,
  now = Date.now,
  flushMs = 30_000,
  ringSize = 40,
  maxLineChars = 2_000,
  maxBatchLines = 200,
  maxPendingBytes = 128_000,
  dailyCapBytes = 512_000,
  env = process.env,
} = {}) {
  if (diagnosticsDisabled(env)) {
    return { enabled: false, observe() {}, flush: async () => {}, stop() {} };
  }
  const ring = [];
  let pending = [];
  let pendingBytes = 0;
  let timer = null;
  let inFlight = null;
  let capDay = null;
  let shippedBytes = 0;

  const entryBytes = (entry) => entry.m.length + ENTRY_OVERHEAD_BYTES;
  const push = (entry) => {
    pending.push(entry);
    pendingBytes += entryBytes(entry);
    // Bounded always: with no reachable target (no share yet, cloud down) the
    // oldest lines fall off rather than the queue growing without limit.
    while (pendingBytes > maxPendingBytes && pending.length > 1) {
      pendingBytes -= entryBytes(pending[0]);
      pending.shift();
    }
  };
  const arm = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushMs);
    timer.unref?.();
  };

  const observe = (message) => {
    try {
      const m = String(message).slice(0, maxLineChars);
      const t = now();
      if (!ERROR_RX.test(m)) {
        ring.push({ t, m });
        if (ring.length > ringSize) ring.shift();
        return;
      }
      for (const context of ring.splice(0)) push({ ...context, ctx: true });
      push({ t, m });
      arm();
    } catch {
      /* diagnostics must never break logging */
    }
  };

  const flush = async () => {
    if (inFlight) return inFlight;
    if (!pending.length) return;
    const day = new Date(now()).toISOString().slice(0, 10);
    if (capDay !== day) {
      capDay = day;
      shippedBytes = 0;
    }
    if (shippedBytes >= dailyCapBytes) {
      pending = [];
      pendingBytes = 0;
      return;
    }
    let target = null;
    try {
      target = resolveTarget();
    } catch {
      /* store closed mid-shutdown */
    }
    if (!target) return; // keep the (bounded) batch for a later share
    const lines = pending.slice(0, maxBatchLines);
    pending = pending.slice(lines.length);
    pendingBytes = pending.reduce((total, entry) => total + entryBytes(entry), 0);
    if (pending.length) arm();
    let facts = {};
    try {
      facts = envelope() ?? {};
    } catch {
      /* stay shippable with an empty envelope */
    }
    const body = JSON.stringify({ workspaceId: target.workspaceId, envelope: facts, lines });
    shippedBytes += body.length; // count attempts: a failing route must not burn the cap slower
    inFlight = (async () => {
      try {
        const response = await fetchImpl(`${target.origin}/api/workspace/local-agent/diagnostics`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        // Release the pooled connection (same reason as the heartbeat).
        await response.arrayBuffer().catch(() => {});
      } catch {
        /* dropped — never retried */
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return { enabled: true, observe, flush, stop };
}
