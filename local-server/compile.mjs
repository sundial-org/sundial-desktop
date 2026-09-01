import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readTextFile, safeResolveInRoot, writeBlobAtomic } from './disk.mjs';
import { locateProjectPath } from './roots.mjs';

/** Local LaTeX compile: the project's files are already on disk, so unlike the
 *  cloud pool (which materializes a Supabase manifest) this just runs tectonic
 *  in place. Response shape matches the cloud `/api/workspace/compile` route so
 *  `useLatexCompile` consumes both unchanged. */

const COMPILE_TIMEOUT_MS = 180_000;
const MAX_LOG_CHARS = 200_000;

/** The desktop app ships tectonic as a Tauri externalBin next to the node
 *  runtime running this sidecar (tauri/scripts/prepare-sidecar.mjs), so a
 *  fresh machine compiles without installing anything; that copy wins.
 *  GUI-launched apps inherit a minimal PATH (no /opt/homebrew/bin), so probe
 *  the common install locations explicitly. An explicit SUNDIAL_TECTONIC pin
 *  is authoritative — no silent fallback, no caching. Otherwise cache the
 *  first hit; a miss re-probes next compile so installing tectonic just works. */
export const tectonicCandidates = () =>
  process.env.SUNDIAL_TECTONIC
    ? [process.env.SUNDIAL_TECTONIC]
    : [
        path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'tectonic.exe' : 'tectonic'),
        'tectonic',
        '/opt/homebrew/bin/tectonic',
        '/usr/local/bin/tectonic',
        path.join(os.homedir(), '.cargo/bin/tectonic'),
      ];

let cachedTectonic = null;

async function findTectonic() {
  if (cachedTectonic && !process.env.SUNDIAL_TECTONIC) return cachedTectonic;
  for (const candidate of tectonicCandidates()) {
    const found = await new Promise((resolve) => {
      execFile(candidate, ['--version'], { timeout: 10_000 }, (error) => resolve(!error));
    });
    if (found) {
      cachedTectonic = process.env.SUNDIAL_TECTONIC ? null : candidate;
      return candidate;
    }
  }
  return null;
}

const truncate = (text) => (text.length > MAX_LOG_CHARS ? text.slice(-MAX_LOG_CHARS) : text);

function runTectonic(bin, args, cwd) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: COMPILE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        // Shared projects auto-compile collaborator-controlled .tex on this
        // machine — the env var enforces untrusted mode even if a candidate
        // binary predates the --untrusted flag.
        env: { ...process.env, TECTONIC_UNTRUSTED_MODE: '1' },
      },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

const CONVERGE_TIMEOUT_MS = 2_000;

/** Compile `relPath` (a `.tex` under the project root) with local tectonic.
 *  Flushes live keystrokes to disk first — the doc host is the source of
 *  truth, never a browser-side text snapshot. `source` (the editor buffer at
 *  click time) is only a freshness HINT: the Yjs update for the last
 *  keystrokes can still be in flight behind the compile POST, so wait
 *  briefly for the doc host to converge to it. It is never written anywhere
 *  — persisting browser snapshots over live docs is the first-sync data-loss
 *  bug class. Writes the PDF (and SyncTeX) next to the source like latexmk
 *  would, so the preview's initial download-by-path finds it on reopen. */
export async function compileLatexLocally({ project, relPath, source, docHost, watchers, emit }) {
  // Multi-root: the .tex may live in a mounted extra root — resolve the
  // owning root once; artifacts land next to the source in the same root.
  const loc = locateProjectPath(docHost.store, project, relPath);
  await docHost.flushProject(project.id);
  if (typeof source === 'string') {
    const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
    while ((await readTextFile(loc.root, loc.rel).catch(() => null))?.text !== source) {
      if (Date.now() > deadline) break; // divergence (e.g. a collaborator's merge) — disk wins
      await new Promise((resolve) => setTimeout(resolve, 100));
      await docHost.flushProject(project.id);
    }
  }
  const abs = await safeResolveInRoot(loc.root, loc.rel);
  if (!(await fsp.stat(abs).catch(() => null))?.isFile()) {
    return { ok: false, error: 'file not found', failureKind: 'infra' };
  }
  const tectonic = await findTectonic();
  if (!tectonic) {
    return {
      ok: false,
      failureKind: 'infra',
      error:
        'tectonic is not installed. Install it (macOS: brew install tectonic) and recompile. ' +
        'Local projects compile on this computer.',
    };
  }

  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sundial-tex-'));
  try {
    const { error, stdout, stderr } = await runTectonic(
      tectonic,
      // Basename + cwd (not the absolute path) so the log's file references
      // stay root-dir-relative, like the cloud compile pool's.
      ['--untrusted', '--outdir', outDir, '--synctex', '--keep-logs', `./${path.basename(abs)}`],
      path.dirname(abs),
    );
    const base = path.basename(relPath).replace(/\.tex$/i, '');
    const logFile = await fsp.readFile(path.join(outDir, `${base}.log`), 'utf8').catch(() => '');
    const diagnostics = { stdout: truncate(stdout), stderr: truncate(stderr), log: truncate(logFile) };
    if (error) {
      const timedOut = error.killed || error.signal === 'SIGTERM';
      return {
        ok: false,
        failureKind: timedOut ? 'infra' : 'latex',
        error: timedOut ? 'compile timed out' : 'compile_failed',
        ...diagnostics,
      };
    }
    const pdfBytes = await fsp.readFile(path.join(outDir, `${base}.pdf`)).catch(() => null);
    if (!pdfBytes?.length) {
      return { ok: false, failureKind: 'latex', error: 'compile_failed', ...diagnostics };
    }

    const pdfRel = relPath.replace(/\.tex$/i, '.pdf');
    const artifacts = [[pdfRel, pdfBytes]];
    const synctexBytes = await fsp.readFile(path.join(outDir, `${base}.synctex.gz`)).catch(() => null);
    const synctexRel = synctexBytes?.length ? relPath.replace(/\.tex$/i, '.synctex.gz') : null;
    if (synctexRel) artifacts.push([synctexRel, synctexBytes]);
    // Best-effort, uncapped (PDFs routinely exceed the 10 MB upload cap): a
    // persist hiccup must not fail a compile that already produced a PDF —
    // the response carries the bytes either way.
    for (const [artifactRel, bytes] of artifacts) {
      watchers.get(project.id)?.suppress(artifactRel);
      const artifactLoc = locateProjectPath(docHost.store, project, artifactRel);
      await writeBlobAtomic(artifactLoc.root, artifactLoc.rel, bytes, { maxBytes: Infinity }).catch(() => {});
    }
    emit(project.id, { type: 'files-changed', path: pdfRel });

    return {
      ok: true,
      path: relPath,
      pdfPath: pdfRel,
      pdfBase64: pdfBytes.toString('base64'),
      ...(synctexRel
        ? { synctexPath: synctexRel, synctexBase64: synctexBytes.toString('base64') }
        : {}),
      size: pdfBytes.length,
      ...diagnostics,
    };
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
