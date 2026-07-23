# Sundial Desktop (Tauri)

A native desktop wrapper around the Sundial web app. The wrapper does **not** ship its own frontend — it points a system webview at a remote Sundial URL. All routes, auth (Clerk cookies), CRDT collaboration (Hocuspocus WebSockets), and Supabase Realtime work without modification because the platform webview handles cookies, WebSockets, and modern web APIs natively.

## Targets

| Script | Loads |
| --- | --- |
| `pnpm dev` | `https://www.sundial.md/onboarding` (override with `SUNDIAL_URL`) |
| `pnpm dev:local` | `http://localhost:3000/onboarding` (run `pnpm dev` from repo root first) |
| `pnpm dev:staging` | `https://dev.sundial.md/onboarding` |
| `pnpm build` | Production bundle (`.app`, `.dmg`, etc.) loading the URL baked into `tauri.conf.json` |

The URL is read from the `SUNDIAL_URL` env var at process start. The window declared in `tauri.conf.json` is created at config-load time pointing at the prod URL; the Rust `setup` hook re-navigates it to `SUNDIAL_URL` before the user sees it.

## First-time setup

```bash
pnpm install        # repo root — the sidecar bundle resolves deps from here
(cd agent-ts && pnpm install)  # Claude Agent SDK for the sidecar's local Claude engine
cd tauri
pnpm install        # installs @tauri-apps/cli + esbuild
pnpm dev            # or `pnpm dev:local` to point at localhost:3000
```

Requires Rust (`cargo`, `rustc`) and platform-native webview deps:

- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Linux:** WebKitGTK 4.1 (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, etc.)
- **Windows:** WebView2 runtime (ships with Win11; on Win10, install from Microsoft)

## Local sidecar

The shell spawns `local-server/` (local folders as projects) at boot. `scripts/prepare-sidecar.mjs` — run automatically by the `tauri dev`/`tauri build` hooks — makes packaged builds self-contained:

- esbuild-bundles the sidecar and all its cross-repo imports into one file under `src-tauri/resources/` (inlining `lib/sync/policy.json`), so installed apps need no repo checkout, no node_modules, and no Node ≥ 23 type stripping.
- downloads the pinned official Node runtime into `src-tauri/binaries/` for Tauri's `externalBin` (dev builds just copy the host's Node to satisfy the build check).

Resolution order at runtime (`lib.rs`): `SUNDIAL_SIDECAR_DIR` override → live repo checkout (debug builds) → bundled resources + shipped Node. Both directories are generated — run `node scripts/prepare-sidecar.mjs --dev` once before a bare `cargo build`/`cargo test`.

## Auto-update & releases

Packaged builds check `https://www.sundial.md/api/desktop/update` hourly (plus App menu ▸ Check for Updates…), download in the background, and show a "ready to install — Relaunch" toast in the web UI (`components/desktop/update-toast.tsx`; the Relaunch button navigates to the `/desktop/relaunch-update` marker the shell intercepts).

Updater artifacts are minisign-signed. `createUpdaterArtifacts` is on, so **`pnpm build` requires the signing key**:

```bash
export TAURI_SIGNING_PRIVATE_KEY=$HOME/.tauri/sundial-updater.key   # accepts contents or a path; keep this file safe — losing it orphans installed apps
cd tauri && pnpm build
node ../scripts/desktop-release.mjs        # uploads artifacts + latest.json to the desktop-releases bucket (prod Supabase)
```

The matching public key lives in `tauri.conf.json` (`plugins.updater.pubkey`). The update manifest and the `/download` page both read `latest.json` from the public `desktop-releases` Supabase Storage bucket — publishing a release never needs a web redeploy.

## First-launch handshake

On the very first launch, a packaged build opens the default browser to `/continue?port=…&nonce=…` with a one-shot loopback listener (3-minute lifetime, constant-time nonce check). If the browser holds a pending link parked by `/download?next=…` (an invite or shared doc), the app opens it — the link survives the download → install boundary. Otherwise the page is just the "You're all set" welcome and the listener times out silently.

## Collaboration

The webview hits the same Hocuspocus + Supabase Realtime endpoints the browser does, so multiplayer editing, presence, and the agent stream Just Work. There is no Tauri IPC layer — the webview talks directly to `wss://` and `https://` endpoints. CSP is intentionally disabled (`csp: null`) so any origin Sundial loads (Clerk, Supabase, Hocuspocus, OpenAI, etc.) is reachable.

## Icons

`src-tauri/icons/` is generated from the Sunny mascot (`public/og-sunny-icon.png`), cropped square around the mascot (~10% margin) so it fills the dock icon. To regenerate:

```bash
pnpm tauri icon path/to/cropped-sunny.png -o src-tauri/icons
```
