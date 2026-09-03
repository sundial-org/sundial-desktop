/**
 * Best-effort error diagnostics shipping for the sidecar.
 *
 * Every log line flows through observe(). Ordinary lines only feed a small
 * ring buffer; a line that looks like an error flushes that ring (as context)
 * plus itself into a pending batch, shipped to the deployment's
 * /api/workspace/local-agent/diagnostics route with the install's OWN parked
 * user credentials — never another workspace's share token. File CONTENTS
 * never enter log lines, so none ship, and every path-valued token (absolute
 * or project-relative) is stripped before a line leaves the machine.
 *
 * Failure posture mirrors the sync heartbeat: batched, capped per day, dropped
 * on any failure, never retried into a growing queue, never blocking sync.
 * The user can turn it off in the app (isEnabled, live — no restart), and
 * SUNDIAL_NO_DIAGNOSTICS=1 disables the sink entirely.
 */

const ERROR_RX = /\b(fail|failed|fatal|error|cannot|unavailable|parked|refus\w*|mismatch|skip|EADDRINUSE|EACCES|ENOSPC|ETIMEDOUT|ECONNREFUSED)\b/i;
const ENTRY_OVERHEAD_BYTES = 32;
// Redaction takes WHOLE path values, not just known prefixes: a relative path
// (`path=Clients/Acme/merger.md`) names the user's work as plainly as an
// absolute one, and a folder name can contain spaces.
// Where a path is certain — under a registered root, home-shaped, or after a
// path key — the value runs to the path's end: a space is taken only while
// another separator lies ahead and the next word is not a `key=` pair, so
// "My Secret Project/x.md" goes whole and trailing prose ("failed") stays.
const PATH_VALUE = String.raw`(?:[^\s'"]|\s(?![\w.-]+=)(?=[^'"]*[/\\]))*`;
// The keys the sidecar logs paths under, including those whose value is often
// a bare basename with no separator for the token pass below to catch: doc=
// (doc-host), from= (rename), file=. `project=` is deliberately absent: it is
// a UUID as often as a path, and the path form always has separators.
const PATH_KEYS = 'path|root|file|dir|folder|cwd|cloud|doc|from|to';
const PATH_KEY_RX = new RegExp(String.raw`\b(${PATH_KEYS})(\s*=\s*)("[^"]*"|'[^']*'|${PATH_VALUE})`, 'gi');
const escapeRx = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Home-shaped and quoted spans, so a spaced path is covered even with no roots
// to enumerate (store closed mid-shutdown, or a path outside every project).
const HOME_PATH_RX = new RegExp(String.raw`(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)` + PATH_VALUE, 'g');
const QUOTED_RX = /'[^']*'|"[^"]*"/g;
// Then any remaining token carrying a separator, matched segment-wise so it
// stays linear. A URL keeps scheme + host, so a failing endpoint is still
// identifiable. The FIRST segment excludes "=" so `key=a/b` keeps its key;
// later ones allow it so a URL query goes with the rest of the value.
const HEAD = String.raw`[^\s'"\`<>(){}\[\],;=/\\]*`;
const TAIL = String.raw`[^\s'"\`<>(){}\[\],;/\\]*`;
const PATHY_RX = new RegExp(String.raw`(?:[a-z][a-z0-9+.-]*:\/\/)?${HEAD}(?:[/\\]${TAIL})+`, 'gi');
const URL_RX = /^([a-z][a-z0-9+.-]*:\/\/[^/\\]+)([/\\].*)?$/i;
// Last backstop: a home-shaped prefix that survived the passes above still
// carries the username.
const HOME_LIKE_RX = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\:'"]+/g;

export function diagnosticsDisabled(env = process.env) {
  return env.SUNDIAL_NO_DIAGNOSTICS === '1';
}

export function isDiagnosticLine(message) {
  return ERROR_RX.test(message);
}

/** One regex per known root, longest first so a root nested under another (or
 *  under home) is matched before its parent. Each takes the whole path, not
 *  just its prefix. */
export function buildRedactionRules(paths = []) {
  return [...new Set(paths.filter((p) => typeof p === 'string' && p.length > 2))]
    .sort((a, b) => b.length - a.length)
    .map((root) => new RegExp(escapeRx(root) + PATH_VALUE, 'g'));
}

export function applyRedaction(message, rules = []) {
  // Roots first: only they can tell where a spaced path under a known folder
  // begins, and taking the whole value leaves the token pass nothing to split.
  let out = String(message);
  for (const rule of rules) out = out.replace(rule, '<path>');
  out = out.replace(HOME_PATH_RX, '<path>');
  out = out.replace(QUOTED_RX, (match) => (/[/\\]/.test(match) ? `${match[0]}<path>${match[0]}` : match));
  out = out.replace(PATH_KEY_RX, (_match, key, equals) => `${key}${equals}<path>`);
  out = out.replace(PATHY_RX, (match) => {
    const url = URL_RX.exec(match);
    if (url) return url[2] ? `${url[1]}/<path>` : url[1];
    return '<path>';
  });
  return out.replace(HOME_LIKE_RX, '~');
}

export function redactLine(message, paths = []) {
  return applyRedaction(message, buildRedactionRules(paths));
}

export function createDiagnosticsSink({
  resolveTarget, // () => { origin, token, workspaceId? } | null
  envelope, // () => flat object of install facts
  isEnabled = () => true, // read live on every line and flush — the app's toggle
  redactionPaths = () => [], // () => absolute paths to strip from shipped lines
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

  // Reads the toggle defensively: a store closed mid-shutdown must not turn
  // logging into a throw, and an unreadable setting means "stop shipping".
  const allowed = () => {
    try {
      return isEnabled() !== false;
    } catch {
      return false;
    }
  };
  const discard = () => {
    ring.length = 0;
    pending = [];
    pendingBytes = 0;
  };

  const observe = (message) => {
    try {
      if (!allowed()) {
        if (pending.length || ring.length) discard();
        return;
      }
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
    // Turned off between arming and flushing: drop the batch, never ship it.
    if (!allowed()) {
      discard();
      return;
    }
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
    if (!target) return; // keep the (bounded) batch until credentials exist
    const batch = pending.slice(0, maxBatchLines);
    // Redacted here, not at observe time: one root lookup per batch instead of
    // one per log line, and always against the CURRENT project list.
    let rules = [];
    try {
      rules = buildRedactionRules(redactionPaths());
    } catch {
      /* store closed mid-shutdown — the regex backstop still applies */
    }
    const lines = batch.map((entry) => ({ ...entry, m: applyRedaction(entry.m, rules) }));
    pending = pending.slice(lines.length);
    pendingBytes = pending.reduce((total, entry) => total + entryBytes(entry), 0);
    if (pending.length) arm();
    let facts = {};
    try {
      facts = envelope() ?? {};
    } catch {
      /* stay shippable with an empty envelope */
    }
    // No workspaceId on the user-credential rail: these lines belong to the
    // install, not to whatever workspace happens to be shared from it.
    const body = JSON.stringify({ ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}), envelope: facts, lines });
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
