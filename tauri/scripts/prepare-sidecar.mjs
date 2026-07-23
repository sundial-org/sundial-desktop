#!/usr/bin/env node
// Packages the local-server sidecar for the desktop app.
//
// Full mode (beforeBuildCommand): esbuild-bundles local-server/server.mjs and
// every cross-repo import (lib/crdt-js, lib/zip, agent-ts descriptions, npm
// deps) into ONE self-contained ESM file under src-tauri/resources/, and
// downloads the pinned official Node runtime into src-tauri/binaries/ for
// Tauri's externalBin. The bundle removes the Node ≥ 23 type-stripping
// requirement (.ts imports are compiled away) — the shipped runtime only
// needs node:sqlite.
//
// --dev mode (beforeDevCommand): same bundle (tauri-build requires the
// resource glob to match, though dev builds run the live repo sidecar via the
// CARGO_MANIFEST_DIR fallback in lib.rs) but satisfies the externalBin build
// requirement by copying the host's own Node instead of downloading.
//
// --bundle-only [--outfile <path>]: just the esbuild step, for tests.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// LTS; node:sqlite needs no flag since 23.4. Official Node 24 binaries need
// macOS >= 13.5 — bundle.macOS.minimumSystemVersion in tauri.conf.json must
// stay at or above Node's floor or the sidecar dies silently on old Macs.
const NODE_VERSION = '24.18.0';
// From https://nodejs.org/dist/v24.18.0/SHASUMS256.txt — the archive is
// verified before anything is extracted into the signed, shipped bundle.
// Bumping NODE_VERSION means re-pinning these.
const NODE_SHA256 = {
  'node-v24.18.0-darwin-arm64.tar.gz': 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1',
  'node-v24.18.0-darwin-x64.tar.gz': 'dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080',
  'node-v24.18.0-linux-arm64.tar.gz': '6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508',
  'node-v24.18.0-linux-x64.tar.gz': '783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8',
  'node-v24.18.0-win-x64.zip': '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821',
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const srcTauri = path.resolve(scriptDir, '../src-tauri');

const args = process.argv.slice(2);
const dev = args.includes('--dev');
const bundleOnly = args.includes('--bundle-only');
const outfile = args.includes('--outfile')
  ? path.resolve(args[args.indexOf('--outfile') + 1])
  : path.join(srcTauri, 'resources/sidecar/server.mjs');

// lib/crdt-js/sync_policy.mjs reads lib/sync/policy.json at runtime relative
// to its own source location, which doesn't survive bundling — inline the
// JSON at build time instead. Fails loudly if the read it targets drifts.
const inlinePolicy = {
  name: 'inline-policy',
  setup(build) {
    build.onLoad({ filter: /[\\/]lib[\\/]crdt-js[\\/]sync_policy\.mjs$/ }, (args) => {
      const src = fs.readFileSync(args.path, 'utf8');
      const marker = "JSON.parse(readFileSync(policyPath, 'utf8'))";
      if (!src.includes(marker)) {
        throw new Error('sync_policy.mjs no longer matches the inline-policy plugin — update prepare-sidecar.mjs');
      }
      const policy = fs.readFileSync(path.join(repoRoot, 'lib/sync/policy.json'), 'utf8');
      return {
        contents: src.replace(marker, `JSON.parse(${JSON.stringify(policy)})`),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      };
    });
  },
};

async function bundleSidecar() {
  // The sidecar's bare imports (@hocuspocus/*, yjs, ws, jszip) resolve from
  // the REPO root, not tauri/node_modules — a desktop-only setup (`cd tauri
  // && pnpm install`) doesn't have them. Fail with the fix, not an esbuild
  // resolution spray.
  for (const dep of ['@hocuspocus/server', 'yjs', 'ws', 'jszip']) {
    if (!fs.existsSync(path.join(repoRoot, 'node_modules', dep))) {
      throw new Error(`sidecar dependency '${dep}' missing — run 'pnpm install' at the repo root first`);
    }
  }
  // The local Claude engine resolves the Claude Agent SDK through agent-ts
  // (agent-ts/src/harness/sdk-exports.ts) — a desktop-only setup that never
  // installed agent-ts would otherwise fail deep inside esbuild resolution.
  if (!fs.existsSync(path.join(repoRoot, 'agent-ts/node_modules/@anthropic-ai/claude-agent-sdk'))) {
    throw new Error("sidecar dependency '@anthropic-ai/claude-agent-sdk' missing — run 'pnpm install' inside agent-ts/ first");
  }
  await build({
    entryPoints: [path.join(repoRoot, 'local-server/server.mjs')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // ws's optional native accelerators; absent at runtime it falls back to JS.
    external: ['bufferutil', 'utf-8-validate'],
    // CJS deps (ws, jszip) call require() — give the ESM bundle a real one.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    plugins: [inlinePolicy],
    logLevel: 'warning',
  });
  console.log(`[prepare-sidecar] bundled sidecar -> ${path.relative(repoRoot, outfile)}`);
}

// Static /local surface (desktop-ui export) served by the sidecar — the
// self-hosted UI. Reuses an existing repo build in --dev; always rebuilds for
// release so the shipped UI matches the shipped sidecar.
function stageDesktopUi() {
  const src = path.join(repoRoot, 'desktop-ui/out');
  if (!dev || !fs.existsSync(path.join(src, 'local.html'))) {
    execFileSync(path.join(repoRoot, 'node_modules/.bin/next'), ['build', 'desktop-ui'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }
  const dest = path.join(srcTauri, 'resources/sidecar/ui');
  fs.rmSync(dest, { recursive: true, force: true });
  // Marketing-only assets ride along via the public/ symlink — don't ship them.
  const skip = new Set(['blog', 'framer', 'paradigm']);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => !skip.has(path.relative(src, from).split(path.sep)[0]),
  });
  console.log(`[prepare-sidecar] staged desktop UI -> ${path.relative(repoRoot, dest)}`);
}

// The rust target being BUILT (tauri build --target …), not necessarily the
// host: the Tauri CLI exports TAURI_ENV_TARGET_TRIPLE to hooks (verified v2.9
// dev + build); PLATFORM/ARCH cover any CLI that only sets the documented
// pair. Host platform/arch is the fallback for direct `node` invocations.
function targetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const { TAURI_ENV_PLATFORM: plat, TAURI_ENV_ARCH: arch } = process.env;
  const vendorOs = { darwin: 'apple-darwin', macos: 'apple-darwin', linux: 'unknown-linux-gnu', windows: 'pc-windows-msvc' };
  if (plat && arch && vendorOs[plat]) return `${arch}-${vendorOs[plat]}`;
  const map = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const triple = map[`${process.platform}-${process.arch}`];
  if (!triple) throw new Error(`unsupported host ${process.platform}-${process.arch}`);
  return triple;
}

// nodejs.org platform slug + archive member for a rust target triple.
function nodeDist(triple) {
  const map = {
    'aarch64-apple-darwin': 'darwin-arm64',
    'x86_64-apple-darwin': 'darwin-x64',
    'x86_64-unknown-linux-gnu': 'linux-x64',
    'aarch64-unknown-linux-gnu': 'linux-arm64',
    'x86_64-pc-windows-msvc': 'win-x64',
  };
  const slug = map[triple];
  if (!slug) throw new Error(`no Node dist mapping for target ${triple}`);
  const win = slug.startsWith('win');
  const base = `node-v${NODE_VERSION}-${slug}`;
  return {
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${base}.${win ? 'zip' : 'tar.gz'}`,
    member: win ? `${base}/node.exe` : `${base}/bin/node`,
    win,
  };
}

async function ensureNodeBinary() {
  const triple = targetTriple();
  const win = triple.includes('windows');
  const dest = path.join(srcTauri, 'binaries', `node-${triple}${win ? '.exe' : ''}`);
  const stamp = `${dest}.version`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const want = `v${NODE_VERSION} ${triple}`;
  if (dev) {
    // Dev builds run the repo sidecar with this binary too (lib.rs prefers
    // it over PATH node, which can be too old for .ts imports/node:sqlite).
    // Use the toolchain node running this script when it's new enough;
    // otherwise fall through to the pinned download. A previously
    // downloaded release runtime is always kept.
    const devWant = `dev ${process.version}`;
    const have = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '';
    const hostOk = Number(process.version.slice(1).split('.')[0]) >= 23;
    if (fs.existsSync(dest) && (have === want || (hostOk && have === devWant))) return;
    if (hostOk) {
      // Unlink first — never truncate a binary a running app may be executing.
      fs.rmSync(dest, { force: true });
      fs.copyFileSync(process.execPath, dest);
      fs.writeFileSync(stamp, devWant);
      console.log(`[prepare-sidecar] dev stub: copied host node ${process.version} -> ${path.relative(repoRoot, dest)}`);
      return;
    }
    console.log(`[prepare-sidecar] host node ${process.version} too old for the sidecar — downloading pinned runtime`);
  }

  if (fs.existsSync(dest) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return;

  const { url, member, win: zipDist } = nodeDist(triple);
  console.log(`[prepare-sidecar] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const name = url.split('/').at(-1);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== NODE_SHA256[name]) {
    throw new Error(`sha256 mismatch for ${name}: got ${digest}, pinned ${NODE_SHA256[name] ?? '(none — re-pin NODE_SHA256)'}`);
  }
  const archive = `${dest}.download`;
  fs.writeFileSync(archive, bytes);
  const extractDir = `${dest}.extract`;
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  // bsdtar (macOS, Windows 10+, most Linuxes) reads both .tar.gz and .zip.
  execFileSync('tar', ['-xf', archive, '-C', extractDir, member.replaceAll('\\', '/')]);
  // Unlink first: a dev stub copied from the host node is mode 0o555, so
  // copying onto it fails EACCES before the chmod below can widen it.
  fs.rmSync(dest, { force: true });
  fs.copyFileSync(path.join(extractDir, member), dest);
  if (!zipDist) fs.chmodSync(dest, 0o755);
  fs.rmSync(archive, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.writeFileSync(stamp, want);
  console.log(`[prepare-sidecar] node ${want} -> ${path.relative(repoRoot, dest)}`);
}

await bundleSidecar();
if (!bundleOnly) {
  stageDesktopUi();
  await ensureNodeBinary();
}
