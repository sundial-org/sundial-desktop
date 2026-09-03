use std::io::{BufRead, Read, Write};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

// Canonical prod host (apex 308-redirects here) so the app doesn't launch
// straight into a cross-host redirect. The `sundialDesktop` flag is how the web
// app detects the shell (lib/desktop.ts) — Tauri reaches the remote origin
// through neither its globals, init scripts, nor a custom UA, but the shell
// owns the launch URL, so the query param is the one reliable channel.
// Local-first: the app opens on the local home (open a folder, recent
// projects) — no sign-in until the user shares something.
// Baked at compile time so a staging/dogfood .app can point at another
// deployment (`SUNDIAL_BUILD_URL=… tauri build`); the SUNDIAL_URL runtime env
// var still overrides for terminal launches.
const DEFAULT_URL: &str = match option_env!("SUNDIAL_BUILD_URL") {
    Some(url) => url,
    None => "https://www.sundial.md/local?sundialDesktop=1",
};

/// `scheme://host[:port]` of the cloud deployment the app is built against.
fn remote_origin_of(url: &url::Url) -> String {
    format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.port().map(|p| format!(":{p}")).unwrap_or_default()
    )
}

/// Host with any leading `www.` stripped, so apex and www count as one site.
fn app_host(url: &url::Url) -> String {
    url.host_str()
        .map(|h| h.strip_prefix("www.").unwrap_or(h).to_string())
        .unwrap_or_default()
}

/// Same-site marker navigation: the web app navigates to a /desktop/* path
/// and the shell cancels it and performs the native action instead (the
/// webview has no filesystem dialogs or updater of its own).
fn is_marker(url: &url::Url, app_scheme: &str, app_domain: &str, path: &str) -> bool {
    url.scheme() == app_scheme && app_host(url) == app_domain && url.path() == path
}

fn is_open_folder_marker(url: &url::Url, app_scheme: &str, app_domain: &str) -> bool {
    is_marker(url, app_scheme, app_domain, "/desktop/open-folder")
}

/// Marker for "open this same-site page in the SYSTEM BROWSER" (the webview
/// drops target="_blank", and in-place navigation would yank the user away
/// from where they are). `?to=` must be a same-origin path — anything else is
/// ignored so a crafted link can't turn this into an open-redirect.
fn external_marker_url(url: &url::Url, app_scheme: &str, app_domain: &str) -> Option<url::Url> {
    if url.scheme() != app_scheme || app_host(url) != app_domain || url.path() != "/desktop/external" {
        return None;
    }
    let to = url.query_pairs().find(|(k, _)| k == "to").map(|(_, v)| v.to_string())?;
    if !to.starts_with('/') || to.starts_with("//") {
        return None;
    }
    url.join(&to).ok()
}

/// URLs handed to the system browser must never point at the loopback proxy —
/// the browser has no sidecar cookie and the user would see 127.0.0.1. Remap
/// proxy-origin URLs onto the remote origin; everything else passes through.
fn browser_url(url: &url::Url, app_domain: &str, remote: &url::Url) -> url::Url {
    if app_host(url) != app_domain || url.host_str() == remote.host_str() {
        return url.clone();
    }
    let mut out = remote.clone();
    out.set_path(url.path());
    out.set_query(url.query());
    out.set_fragment(None);
    out
}

/// Whether navigating to `url` should hand off to the system browser rather
/// than load in the webview: the sign-in handoff (/desktop-login) and any
/// genuinely off-site http(s) URL. Same-site navigation — including the
/// apex↔www redirect and every in-app route — stays in the webview, and so
/// does Clerk's frontend API (`clerk.<domain>` / `*.clerk.accounts.dev`):
/// Clerk answers the app's own page requests with a redirect through its
/// session-handshake endpoint, and ejecting that cancels the webview's
/// initial load, leaving the window permanently blank.
/// A dev shell on `localhost` counts `127.0.0.1` as the same site: it embeds
/// sidecar iframes addressed as `127.0.0.1` (the PDF preview), and WKWebView
/// routes SUBFRAME navigations through on_navigation too — a host mismatch
/// would eject the preview into the system browser. Deliberately one-way so
/// the packaged app (app_domain = `127.0.0.1`) still hands `localhost` links
/// to the browser.
fn leaves_app(url: &url::Url, app_scheme: &str, app_domain: &str, remote_domain: &str) -> bool {
    if !url.scheme().starts_with("http") {
        return false;
    }
    let host = app_host(url);
    if url.scheme() == app_scheme
        && (host == app_domain || (app_domain == "localhost" && host == "127.0.0.1"))
    {
        return url.path() == "/desktop-login";
    }
    let host = url.host_str().unwrap_or_default();
    // `clerk.<remote_domain>` covers custom Clerk frontend domains when the
    // visible app origin is the loopback proxy (app_domain = 127.0.0.1).
    !(host.ends_with(".clerk.accounts.dev")
        || host == format!("clerk.{app_domain}")
        || host == format!("clerk.{remote_domain}"))
}

/// The local sidecar (local-server/) serves local folders as projects. The
/// shell owns its lifecycle: one shared per-install token (persisted next to
/// the sidecar's own data so a restart or an already-running instance agree),
/// spawn at boot, kill on exit. The web app reaches it via the
/// `sidecarPort`/`sidecarToken` query params appended to the launch URL.
struct Sidecar {
    port: u16,
    token: String,
    child: Mutex<Option<Child>>,
}

fn sidecar_home() -> std::path::PathBuf {
    if let Ok(home) = std::env::var("SUNDIAL_LOCAL_HOME") {
        return home.into();
    }
    dirs_home().join(".sundial").join("desktop")
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(Into::into)
        .unwrap_or_else(|| ".".into())
}

/// Hex string of `words` 8-byte words straight from the OS CSPRNG.
///
/// This mints the sidecar token (filesystem access to every open project) and
/// the first-launch /redeem nonce, so `RandomState` was the wrong tool: it is
/// documented as non-cryptographic, and successive `new()` calls in one
/// process share a seed with only an incrementing counter. Panicking beats
/// degrading — a machine with no entropy source must not get a guessable
/// token — and `getrandom` was already in the dependency tree.
fn random_hex(words: usize) -> String {
    let mut bytes = vec![0u8; words * 8];
    getrandom::fill(&mut bytes).expect("OS random number generator unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn load_or_mint_token() -> String {
    let path = sidecar_home().join("token");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let token = random_hex(4);
    let _ = std::fs::create_dir_all(sidecar_home());
    if let Ok(mut file) = std::fs::File::create(&path) {
        let _ = file.write_all(token.as_bytes());
        // The token gates filesystem access — owner-only, like an SSH key.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
    token
}

/// Runs `local-server/server.mjs` from a source checkout. The sidecar needs
/// Node ≥ 23 (.ts imports via type stripping, node:sqlite unflagged), but
/// PATH `node` is whatever the launching shell defaults to — prefer the
/// pinned externalBin runtime prepare-sidecar.mjs downloads for every build.
fn repo_sidecar(dir: std::path::PathBuf) -> Command {
    // Exact per-target name — binaries/ also holds .version stamp files and
    // possibly other targets' downloads, so no directory scanning.
    let file = format!(
        "node-{}-{}",
        std::env::consts::ARCH,
        if cfg!(windows) {
            "pc-windows-msvc.exe"
        } else if cfg!(target_os = "macos") {
            "apple-darwin"
        } else {
            "unknown-linux-gnu"
        }
    );
    let pinned = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/binaries")).join(file);
    let mut cmd = Command::new(if pinned.exists() { pinned.into_os_string() } else { "node".into() });
    cmd.arg("local-server/server.mjs").current_dir(dir);
    cmd
}

/// The Node runtime Tauri ships via externalBin sits next to the app
/// executable (Contents/MacOS on macOS).
fn bundled_node() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let node = exe.parent()?.join(if cfg!(windows) { "node.exe" } else { "node" });
    node.exists().then_some(node)
}

/// Sidecar resolution: an explicit SUNDIAL_SIDECAR_DIR always wins; dev
/// builds prefer the live repo checkout (the bundle is a build-time
/// snapshot); packaged builds run the esbuild-bundled server from the app's
/// resource dir (scripts/prepare-sidecar.mjs) with the shipped Node runtime.
fn sidecar_command(app: &tauri::AppHandle) -> Option<Command> {
    if let Ok(dir) = std::env::var("SUNDIAL_SIDECAR_DIR") {
        return Some(repo_sidecar(dir.into()));
    }
    let repo = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."));
    let repo_exists = repo.join("local-server/server.mjs").exists();
    if cfg!(debug_assertions) && repo_exists {
        return Some(repo_sidecar(repo));
    }
    let bundled = app
        .path()
        .resolve("resources/sidecar/server.mjs", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|path| path.exists());
    if let Some(server) = bundled {
        let mut cmd = Command::new(bundled_node().unwrap_or_else(|| "node".into()));
        cmd.arg(server);
        return Some(cmd);
    }
    if repo_exists {
        return Some(repo_sidecar(repo));
    }
    eprintln!("[sundial] no sidecar found: neither bundled resources nor a source checkout");
    None
}

/// Shell-side lines into the sidecar's own log file: a Finder launch has no
/// visible stderr, so this is the only durable place. Epoch-seconds stamp —
/// close enough to correlate with the sidecar's ISO lines without a time dep.
fn append_sidecar_log(message: &str) {
    let path = sidecar_home().join("sidecar.log");
    let secs = std::time::UNIX_EPOCH.elapsed().map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "@{secs} {message}");
    }
}

fn spawn_sidecar(app: &tauri::AppHandle, port: u16, token: &str, remote_origin: Option<&str>) -> Option<Child> {
    let mut cmd = sidecar_command(app)?;
    // Program + args only — Command's Debug output would include the token env.
    let shown = format!("{:?} {:?}", cmd.get_program(), cmd.get_args());
    cmd.env("SUNDIAL_LOCAL_PORT", port.to_string())
        .env("SUNDIAL_LOCAL_TOKEN", token)
        // Crash stacks and Node fatal errors go to stderr, which a Finder
        // launch discards — mirror them into sidecar.log (stdout self-logs).
        .stderr(std::process::Stdio::piped());
    if let Some(origin) = remote_origin {
        cmd.env("SUNDIAL_REMOTE_ORIGIN", origin);
    }
    match cmd.spawn()
    {
        Ok(mut child) => {
            eprintln!("[sundial] sidecar spawned pid={} cmd={shown}", child.id());
            if let Some(stderr) = child.stderr.take() {
                std::thread::spawn(move || {
                    for line in std::io::BufReader::new(stderr).lines() {
                        let Ok(line) = line else { break };
                        eprintln!("{line}");
                        append_sidecar_log(&format!("[sidecar stderr] {line}"));
                    }
                });
            }
            Some(child)
        }
        Err(error) => {
            // The web app degrades to cloud-only; /local explains what to do.
            eprintln!("[sundial] sidecar spawn failed: {error} cmd={shown}");
            None
        }
    }
}

/// The webview is SERVED by the sidecar in the packaged app — if the sidecar
/// dies, every fetch and navigation strands until the user relaunches. Watch
/// the child and respawn on a crash (non-zero exit). A zero exit is
/// deliberate (deferral to another instance, external replacement) — leave it.
fn spawn_sidecar_monitor(app: tauri::AppHandle, port: u16, token: String, remote_origin: Option<String>) {
    std::thread::spawn(move || {
        let mut respawns: u32 = 0;
        let mut last_exit = std::time::Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let state = app.state::<Sidecar>();
            let mut guard = state.child.lock().unwrap();
            // Taken by kill_sidecar → the shell is exiting; stop watching.
            let Some(child) = guard.as_mut() else { break };
            let status = match child.try_wait() {
                Ok(Some(status)) => status,
                _ => continue,
            };
            if status.success() {
                *guard = None;
                break;
            }
            // A long-healthy sidecar earns a fresh budget; a crash loop doesn't.
            if last_exit.elapsed() > Duration::from_secs(300) {
                respawns = 0;
            }
            last_exit = std::time::Instant::now();
            respawns += 1;
            if respawns > 5 {
                append_sidecar_log("[shell] sidecar crash-looping; giving up — relaunch Sundial");
                *guard = None;
                break;
            }
            append_sidecar_log(&format!("[shell] sidecar exited ({status}) — respawning ({respawns}/5)"));
            *guard = spawn_sidecar(&app, port, &token, remote_origin.as_deref());
            if guard.is_none() {
                break;
            }
        }
    });
}

/// Native folder picker → open the folder as a local project: navigate to
/// /local with the sidecar credentials + picked path in the URL fragment
/// (fragments never reach the remote origin). Shared by the File ▸ Open
/// Folder… menu item and the web app's "Open a folder…" marker navigation.
fn open_folder_flow(app: tauri::AppHandle, dest: url::Url) {
    pick_folder(app.clone(), move |app, folder| {
        let Some(folder) = folder else { return };
        let Some(window) = app.get_webview_window("main") else { return };
        let sidecar = app.state::<Sidecar>();
        // Already on /local (the usual case — that's where the picker button
        // lives): change only the fragment, a same-document navigation the
        // page reacts to via its hashchange listener. Skipping the full
        // reload is what makes open-a-folder feel instant. The nonce keeps
        // the fragment unique so re-picking the same folder still fires.
        let nonce = std::time::UNIX_EPOCH.elapsed().map(|d| d.as_millis()).unwrap_or(0);
        let mut url = match window.url() {
            Ok(current) if current.path() == "/local" => current,
            _ => {
                let mut url = dest.clone();
                url.set_path("/local");
                url.query_pairs_mut().clear().append_pair("sundialDesktop", "1");
                url
            }
        };
        let fragment = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("sidecarPort", &sidecar.port.to_string())
            .append_pair("sidecarToken", &sidecar.token)
            .append_pair("openPath", &folder.to_string())
            .append_pair("pick", &nonce.to_string())
            .finish();
        url.set_fragment(Some(&fragment));
        let _ = window.navigate(url);
    });
}

/// The native folder picker lives outside the DOM, so the launcher's
/// auto-update can't see it. While this is set the shell neither announces
/// an update nor accepts a relaunch marker (a relaunch would close the picker
/// and drop the choice). It stays set through the handoff of a chosen folder
/// — the page marks itself busy only once it has the open in hand — and
/// clears at once on cancel.
static PICKER_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const OPEN_HANDOFF: Duration = Duration::from_secs(5);

fn pick_folder(
    app: tauri::AppHandle,
    done: impl FnOnce(&tauri::AppHandle, Option<tauri_plugin_dialog::FilePath>) + Send + 'static,
) {
    PICKER_OPEN.store(true, std::sync::atomic::Ordering::SeqCst);
    app.clone().dialog().file().pick_folder(move |folder| {
        let chosen = folder.is_some();
        done(&app, folder);
        if !chosen {
            PICKER_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
            announce_pending_update(&app, false);
            return;
        }
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(OPEN_HANDOFF).await;
            PICKER_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
            announce_pending_update(&app, false);
        });
    });
}

/// Re-announce a staged update; `after_open_handoff` defers it past the
/// window in which a just-picked folder is still travelling to the page.
fn announce_pending_update(app: &tauri::AppHandle, after_open_handoff: bool) {
    let Some(version) = pending_update_version(app) else { return };
    if !after_open_handoff {
        notify_update_ready(app, &version);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(OPEN_HANDOFF).await;
        notify_update_ready(&app, &version);
    });
}

/// Native folder picker for a dialog's Location field: return the choice in
/// the URL fragment (`pickedPath`) of the CURRENT page — a same-document
/// navigation the open dialog picks up via its hashchange listener. Unlike
/// open_folder_flow this must not leave the page (a dialog is open on it).
fn pick_location_flow(app: tauri::AppHandle) {
    pick_folder(app, move |app, folder| {
        let Some(folder) = folder else { return };
        let Some(window) = app.get_webview_window("main") else { return };
        let Ok(mut url) = window.url() else { return };
        let sidecar = app.state::<Sidecar>();
        let nonce = std::time::UNIX_EPOCH.elapsed().map(|d| d.as_millis()).unwrap_or(0);
        let fragment = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("sidecarPort", &sidecar.port.to_string())
            .append_pair("sidecarToken", &sidecar.token)
            .append_pair("pickedPath", &folder.to_string())
            .append_pair("pick", &nonce.to_string())
            .finish();
        url.set_fragment(Some(&fragment));
        let _ = window.navigate(url);
    });
}

/// SIGTERM first: the sidecar's shutdown handler flushes any debounced
/// document persists to disk. Force-kill only if it hasn't exited after a
/// grace period. Shared by app exit, update install, and uninstall.
fn kill_sidecar(app: &tauri::AppHandle) {
    let Some(mut child) = app.state::<Sidecar>().child.lock().unwrap().take() else { return };
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
        for _ in 0..20 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
}

// ---- Auto-update ----------------------------------------------------------
// The shell checks /api/desktop/update in the background, downloads the
// update, and announces readiness to the webview (which owns the toast UI —
// the shell has no UI surface of its own). Installing waits for the user's
// "Relaunch" (the /desktop/relaunch-update marker navigation) or, failing
// that, happens on quit so the next launch is current.

struct PendingUpdate(Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>);

/// True while `update.install` runs on its worker thread: a user quit then
/// would kill the process mid-bundle-swap, so the run loop holds the exit
/// until the install finishes (its own restart passes `code: Some`).
static INSTALLING_UPDATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// A version the user was offered by the native Check for Updates dialog:
/// its Relaunch/Later choice is theirs, so announcements for it are marked
/// `manual` and the launcher never applies it by itself.
static MANUAL_UPDATE: Mutex<Option<String>> = Mutex::new(None);

// {:?} JSON-escapes the version string for the JS literal.
fn update_ready_js(version: &str, manual: bool) -> String {
    format!(
        "window.__SUNDIAL_UPDATE_READY={v:?};window.__SUNDIAL_UPDATE_MANUAL={m};window.dispatchEvent(new CustomEvent('sundial:update-ready',{{detail:{{version:{v:?},manual:{m}}}}}));",
        v = version,
        m = manual
    )
}

fn notify_update_ready(app: &tauri::AppHandle, version: &str) {
    if PICKER_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
        return; // pick_folder re-announces when the picker returns
    }
    let manual = MANUAL_UPDATE.lock().unwrap().as_deref() == Some(version);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&update_ready_js(version, manual));
    }
}

/// Interactive offer: the native dialog decides, and the launcher's
/// automatic install stands down for this version from here on.
fn offer_update_dialog(app: &tauri::AppHandle, version: &str) {
    *MANUAL_UPDATE.lock().unwrap() = Some(version.to_string());
    notify_update_ready(app, version);
    let handle = app.clone();
    app.dialog()
        .message(format!("Sundial {version} is downloaded and ready."))
        .buttons(MessageDialogButtons::OkCancelCustom("Relaunch".into(), "Later".into()))
        .show(move |relaunch| {
            if relaunch {
                install_pending_update(&handle);
            }
        });
}

fn pending_update_version(app: &tauri::AppHandle) -> Option<String> {
    let pending = app.state::<PendingUpdate>();
    let guard = pending.0.lock().unwrap();
    guard.as_ref().map(|(update, _)| update.version.clone())
}

/// Check + download. `interactive` (the menu item) also reports "up to date"
/// and failures through dialogs; the background loop stays silent.
async fn check_for_update(app: tauri::AppHandle, interactive: bool) {
    if cfg!(debug_assertions) {
        if interactive {
            app.dialog().message("Update checks run in the packaged app.").show(|_| {});
        }
        return;
    }
    // Already downloaded and waiting — just re-announce.
    if let Some(version) = pending_update_version(&app) {
        if interactive {
            offer_update_dialog(&app, &version);
        } else {
            notify_update_ready(&app, &version);
        }
        return;
    }
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            eprintln!("[sundial] updater unavailable: {error}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            eprintln!("[sundial] update {version} available, downloading");
            match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => {
                    *app.state::<PendingUpdate>().0.lock().unwrap() = Some((update, bytes));
                    if interactive {
                        offer_update_dialog(&app, &version);
                    } else {
                        notify_update_ready(&app, &version);
                    }
                }
                Err(error) => eprintln!("[sundial] update download failed: {error}"),
            }
        }
        Ok(None) => {
            if interactive {
                app.dialog()
                    .message(format!("You're up to date (v{}).", env!("CARGO_PKG_VERSION")))
                    .show(|_| {});
            }
        }
        Err(error) => {
            eprintln!("[sundial] update check failed: {error}");
            if interactive {
                app.dialog().message(format!("Couldn't check for updates: {error}")).show(|_| {});
            }
        }
    }
}

fn install_pending_update(app: &tauri::AppHandle) {
    // Own thread: callers are webview/dialog callbacks, and this path blocks
    // (kill_sidecar waits up to 2s, install extracts the bundle) — run inline
    // it freezes the UI and the toast's "Relaunching…" state never paints.
    // Guard up BEFORE the pending slot is taken: a quit during kill_sidecar's
    // wait would otherwise find both empty and false and exit under the install.
    let taken = app.state::<PendingUpdate>().0.lock().unwrap().take();
    let Some((update, bytes)) = taken else { return };
    INSTALLING_UPDATE.store(true, std::sync::atomic::Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        // The sidecar must die BEFORE install: it flushes persists, frees the
        // port for the relaunch, and on Windows install() replaces the exe
        // and exits the process without ever returning.
        kill_sidecar(&app);
        let installed = update.install(&bytes);
        INSTALLING_UPDATE.store(false, std::sync::atomic::Ordering::SeqCst);
        if let Err(error) = installed {
            // The webview is SERVED by the sidecar just killed — without
            // recovery the app is a dead page. Restart the (still current)
            // app: fresh sidecar, and the background check re-offers the
            // update. Restart on dismiss, not before, so the dialog is seen.
            eprintln!("[sundial] update install failed: {error}");
            let handle = app.clone();
            app.dialog()
                .message(format!(
                    "Couldn't install the update: {error}\n\nSundial will restart on the current version."
                ))
                .show(move |_| handle.restart());
            return;
        }
        app.restart();
    });
}

/// App menu ▸ Uninstall Sundial…: remove the app's own data (never the user's
/// project folders), then reveal the bundle so dragging it to the Trash is
/// one motion.
fn uninstall_flow(app: tauri::AppHandle) {
    let handle = app.clone();
    app.dialog()
        .message(
            "This removes Sundial's local data: settings, the project list, and edit history kept by the app.\n\nYour project folders and files are never touched.\n\nAfterwards, drag Sundial.app to the Trash to finish.",
        )
        .title("Uninstall Sundial?")
        .buttons(MessageDialogButtons::OkCancelCustom("Remove Data".into(), "Cancel".into()))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            kill_sidecar(&handle);
            let _ = std::fs::remove_dir_all(sidecar_home());
            #[cfg(target_os = "macos")]
            if let Ok(exe) = std::env::current_exe() {
                // …/Sundial.app/Contents/MacOS/<exe> → the .app bundle.
                if let Some(bundle) = exe.ancestors().nth(3) {
                    let _ = Command::new("open").arg("-R").arg(bundle).status();
                }
            }
        });
}

// ---- First-launch handshake ------------------------------------------------
// A share/invite link survives the download → install boundary: /download
// parks the destination in a browser cookie, and on the very first launch the
// app opens the browser to /continue?port=…&nonce=… with a one-shot loopback
// listener. If the browser holds a pending link, /continue bounces it to
// /redeem here and the app opens it; otherwise the listener times out
// silently. This is the packaged app's only automatic network interaction
// besides the update check.

/// Same-origin app path only (mirrors lib/desktop-link.ts).
fn safe_app_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= 2048
        && path.chars().all(|c| c.is_ascii_graphic())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn spawn_first_launch_handshake(app: &tauri::AppHandle, remote: &url::Url, dest: &url::Url) {
    let marker = sidecar_home().join("first-launch-done");
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(sidecar_home());
    // Burn the marker up front: a crashed handshake must not re-prompt on
    // every subsequent launch.
    let _ = std::fs::write(&marker, b"1");
    let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", 0)) else { return };
    let Ok(addr) = listener.local_addr() else { return };
    let nonce = random_hex(2);
    let mut continue_url = remote.clone();
    continue_url.set_path("/continue");
    continue_url.set_query(Some(&format!("port={}&nonce={nonce}", addr.port())));
    continue_url.set_fragment(None);
    if tauri_plugin_opener::open_url(continue_url.as_str(), None::<&str>).is_err() {
        return;
    }
    let app = app.clone();
    let dest = dest.clone();
    let remote_origin = remote_origin_of(remote);
    std::thread::spawn(move || redeem_listener(listener, nonce, app, dest, remote_origin));
}

/// Accept loop for the one-shot /redeem endpoint: 3-minute lifetime, nonce
/// compared in constant time and single-use (burned on the first /redeem
/// request regardless of outcome), destination restricted to same-origin
/// paths. Stray requests (favicon probes) get 404s without burning anything.
fn redeem_listener(
    listener: std::net::TcpListener,
    nonce: String,
    app: tauri::AppHandle,
    dest: url::Url,
    remote_origin: String,
) {
    let deadline = Instant::now() + Duration::from_secs(180);
    let _ = listener.set_nonblocking(true);
    let mut served = 0u8;
    while Instant::now() < deadline && served < 20 {
        let Ok((mut stream, _)) = listener.accept().or_else(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(error)
        }) else {
            continue;
        };
        served += 1;
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let head = String::from_utf8_lossy(&buf[..n]);
        let request_path = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("");
        let Ok(parsed) = url::Url::parse(&format!("http://127.0.0.1{request_path}")) else {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            continue;
        };
        if parsed.path() != "/redeem" {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            continue;
        }
        let get = |k: &str| parsed.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.to_string());
        let ok = get("nonce").is_some_and(|candidate| constant_time_eq(&candidate, &nonce));
        let to = get("to").filter(|to| safe_app_path(to));
        if ok {
            let back = format!(
                "HTTP/1.1 302 Found\r\nLocation: {remote_origin}/continue?done=1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
            );
            let _ = stream.write_all(back.as_bytes());
            if let Some(to) = to {
                let mut target = dest.clone();
                let (path, query) = to.split_once('?').unwrap_or((to.as_str(), ""));
                target.set_path(path);
                target.set_query((!query.is_empty()).then_some(query));
                // The shell's own params must survive this hard navigation —
                // without sundialDesktop=1 the redeemed page would treat the
                // webview as a plain browser (Clerk sign-in would open
                // in-webview instead of the desktop browser handoff).
                target
                    .query_pairs_mut()
                    .append_pair("sundialDesktop", "1")
                    .append_pair("desktopVersion", env!("CARGO_PKG_VERSION"));
                target.set_fragment(None);
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.navigate(target);
                    }
                });
            }
        } else {
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        }
        // Single-use either way: one /redeem attempt per install.
        return;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let target = std::env::var("SUNDIAL_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());
    let mut remote = url::Url::parse(&target)
        .unwrap_or_else(|e| panic!("invalid SUNDIAL_URL {target:?}: {e}"));
    // The web app shows the shell version (picker header) and gates
    // shell-capability fallbacks on it; the query param is the one channel
    // the shell owns (see the sundialDesktop note above).
    remote
        .query_pairs_mut()
        .append_pair("desktopVersion", env!("CARGO_PKG_VERSION"));

    let sidecar_port: u16 = std::env::var("SUNDIAL_LOCAL_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4848);
    let sidecar_token = load_or_mint_token();

    // An https UI can't reach the plaintext-loopback sidecar (WKWebView mixed
    // content), so the packaged app loads the web app THROUGH the sidecar's
    // reverse proxy: the webview origin becomes http://127.0.0.1:<port> and
    // every sidecar API/socket is same-origin. Plain-http targets (a local
    // dev server) load directly, as before.
    let proxied = remote.scheme() == "https";
    let parsed = if proxied {
        let mut via = url::Url::parse(&format!("http://127.0.0.1:{sidecar_port}/")).unwrap();
        // /boot proves token possession once (sets the sidecar trust cookie)
        // and redirects to the app path with the fragment config latch.
        let to = format!(
            "{}{}",
            remote.path(),
            remote.query().map(|q| format!("?{q}")).unwrap_or_default()
        );
        via.set_path("/boot");
        via.query_pairs_mut()
            .append_pair("token", &sidecar_token)
            .append_pair("to", &to);
        via
    } else {
        let mut direct = remote.clone();
        // The token rides in the URL FRAGMENT: fragments never leave the
        // client, so the sidecar secret is not sent to the remote origin, its
        // CDN, or access logs. The web app reads location.hash.
        direct.set_fragment(Some(&format!(
            "sidecarPort={sidecar_port}&sidecarToken={sidecar_token}"
        )));
        direct
    };

    let app = tauri::Builder::default()
        // Must be first: re-focuses the running instance and (via the
        // deep-link feature) forwards sundial:// URLs that Windows/Linux
        // deliver as argv to a second process.
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sidecar {
            port: sidecar_port,
            token: sidecar_token.clone(),
            child: Mutex::new(None),
        })
        .manage(PendingUpdate(Mutex::new(None)))
        .setup(move |app| {
            // Spawned here, not before the builder: resolving the packaged
            // sidecar's resource path needs the app handle.
            let sidecar_remote = proxied.then(|| remote_origin_of(&remote));
            *app.state::<Sidecar>().child.lock().unwrap() = spawn_sidecar(
                app.handle(),
                sidecar_port,
                &sidecar_token,
                sidecar_remote.as_deref(),
            );
            spawn_sidecar_monitor(
                app.handle().clone(),
                sidecar_port,
                sidecar_token.clone(),
                sidecar_remote,
            );
            // True whenever the first load hits the sidecar origin: every
            // proxied (packaged) launch, and direct http targets that ARE the
            // sidecar (the self-hosted static UI in dev).
            let loads_sidecar = proxied
                || (matches!(remote.host_str(), Some("127.0.0.1") | Some("localhost"))
                    && remote.port() == Some(sidecar_port));
            if loads_sidecar {
                // The webview's FIRST load is the sidecar itself — wait for it
                // to bind (typically <300ms) so launch isn't a refused page.
                let addr = std::net::SocketAddr::from(([127, 0, 0, 1], sidecar_port));
                for _ in 0..100 {
                    if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(100)).is_ok() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
            let app_scheme = parsed.scheme().to_string();
            let app_domain = app_host(&parsed);
            let dl_handle = app.handle().clone();
            let nav_handle = app.handle().clone();
            let nav_dest = parsed.clone();
            let nav_remote = remote.clone();
            let remote_domain = app_host(&remote);
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed.clone()))
                    // Dev: parallel agent-run instances override the title so
                    // windows are distinguishable (pairs with a --config
                    // identifier/productName overlay for full isolation).
                    .title(std::env::var("SUNDIAL_WINDOW_TITLE").unwrap_or_else(|_| "Sundial".into()))
                    .inner_size(1400.0, 900.0)
                    .min_inner_size(800.0, 600.0)
                    // Tauri's own drag-drop handler swallows OS file drops
                    // before the DOM sees them — with it on, dropping an
                    // image on the file tree / chat / editor does nothing.
                    // Nothing listens to the Tauri-side events; let the
                    // webview deliver native HTML5 drop events instead.
                    .disable_drag_drop_handler()
                    // Sign-in belongs in the system browser, where the user's
                    // Google session lives; /desktop-login mints the one-time
                    // Clerk ticket that comes back through the sundial:// deep
                    // link below. Same-site pages stay in the webview. Every
                    // URL that leaves for the browser is remapped off the
                    // loopback proxy onto the remote origin first.
                    .on_navigation(move |url| {
                        // Vercel's preview-feedback widget (dev deployments
                        // only) fires navigations to vercel.live — noise, not
                        // a user intent; swallow instead of opening a browser.
                        if url.host_str().is_some_and(|h| h == "vercel.live" || h.ends_with(".vercel.live")) {
                            return false;
                        }
                        if is_open_folder_marker(url, &app_scheme, &app_domain) {
                            open_folder_flow(nav_handle.clone(), nav_dest.clone());
                            return false;
                        }
                        if is_marker(url, &app_scheme, &app_domain, "/desktop/pick-location") {
                            pick_location_flow(nav_handle.clone());
                            return false;
                        }
                        // window.print() is a silent no-op in WKWebView, so the
                        // page's Print actions navigate here instead and the
                        // shell runs the native print panel (frontend gates on
                        // desktopVersion >= 0.1.14 so older shells never 404).
                        if is_marker(url, &app_scheme, &app_domain, "/desktop/print") {
                            if let Some(window) = nav_handle.get_webview_window("main") {
                                let _ = window.print();
                            }
                            return false;
                        }
                        if is_marker(url, &app_scheme, &app_domain, "/desktop/relaunch-update") {
                            // A native picker is open (outside the DOM, so
                            // the page couldn't see it): decline — the toast
                            // drops back to its manual Relaunch.
                            if PICKER_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
                                if let Some(window) = nav_handle.get_webview_window("main") {
                                    let _ = window.eval("window.dispatchEvent(new CustomEvent('sundial:update-deferred'));");
                                }
                                return false;
                            }
                            install_pending_update(&nav_handle);
                            return false;
                        }
                        if let Some(external) = external_marker_url(url, &app_scheme, &app_domain) {
                            let external = browser_url(&external, &app_domain, &nav_remote);
                            let _ = tauri_plugin_opener::open_url(external.as_str(), None::<&str>);
                            return false;
                        }
                        if leaves_app(url, &app_scheme, &app_domain, &remote_domain) {
                            let external = browser_url(url, &app_domain, &nav_remote);
                            eprintln!("[sundial] handing off to browser: {external}");
                            let _ = tauri_plugin_opener::open_url(external.as_str(), None::<&str>);
                            return false;
                        }
                        true
                    })
                    // The update-ready announcement is a one-shot eval — a hard
                    // navigation or reload wipes it and the toast stays gone
                    // until the next hourly check. Re-announce on every load.
                    // (deferred when the load carries a picked folder — the
                    // page must take that open over before the launcher's
                    // auto-update may see the announcement.)
                    // Without a download handler the webview silently drops
                    // every download — `<a download>` blob saves included, so
                    // "Download transcript" and the file Download buttons did
                    // nothing on desktop. Route them to ~/Downloads under a
                    // collision-free name; revealing the finished file in the
                    // file manager is the user-visible receipt.
                    .on_download(move |_webview, event| {
                        match event {
                            tauri::webview::DownloadEvent::Requested { destination, .. } => {
                                let dir = dl_handle
                                    .path()
                                    .download_dir()
                                    .unwrap_or_else(|_| std::env::temp_dir());
                                let name = destination
                                    .file_name()
                                    .map(|n| n.to_os_string())
                                    .unwrap_or_else(|| "download".into());
                                let mut path = dir.join(&name);
                                let mut counter = 1u32;
                                while path.exists() {
                                    let stem = std::path::Path::new(&name)
                                        .file_stem()
                                        .map(|s| s.to_string_lossy().into_owned())
                                        .unwrap_or_else(|| "download".into());
                                    let ext = std::path::Path::new(&name)
                                        .extension()
                                        .map(|e| format!(".{}", e.to_string_lossy()))
                                        .unwrap_or_default();
                                    path = dir.join(format!("{stem} ({counter}){ext}"));
                                    counter += 1;
                                }
                                *destination = path;
                            }
                            tauri::webview::DownloadEvent::Finished { path, success, .. } => {
                                if success {
                                    if let Some(path) = path {
                                        let _ = tauri_plugin_opener::reveal_item_in_dir(path);
                                    }
                                } else {
                                    eprintln!("[sundial] download failed");
                                }
                            }
                            _ => {}
                        }
                        true
                    })
                    .on_page_load(|window, payload| {
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            let handoff = payload.url().fragment().is_some_and(|f| f.contains("openPath="));
                            announce_pending_update(window.app_handle(), handoff);
                        }
                    });
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                // Vertically centers the buttons (12px tall) in the one-bar
                // shell's h-11 (44px) top bar. macOS anchors this several px
                // higher than the raw offset, so bias down (measured: y=22
                // rendered slightly high, y=26 slightly low — 24 lands centered).
                .traffic_light_position(tauri::LogicalPosition::new(14.0, 24.0));
            let window = builder.build()?;
            // Opt-in inspector for debugging release builds in the field.
            #[cfg(feature = "devtools")]
            if std::env::var("SUNDIAL_DEVTOOLS").is_ok() {
                window.open_devtools();
            }

            // sundial://auth?ticket=…&next=… → consume the ticket in the
            // webview, forwarding the query (ticket + optional return path).
            let dest = parsed.clone();
            let handle = std::sync::Arc::new(move |urls: Vec<url::Url>| {
                for url in urls {
                    if url.query_pairs().any(|(k, _)| k == "ticket") {
                        let mut auth = dest.clone();
                        auth.set_path("/desktop-auth");
                        auth.set_query(url.query());
                        let _ = window.navigate(auth);
                    }
                }
            });
            let on_open = handle.clone();
            app.deep_link().on_open_url(move |event| on_open(event.urls()));
            // Windows/Linux deliver a cold-start deep link via argv, not
            // on_open_url; macOS queues it through on_open_url either way.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                handle(urls);
            }

            // File ▸ Open Folder… (Cmd/Ctrl+O): pick a local folder and open
            // it as a local project. The launcher page does the sidecar POST
            // (it owns the client + error surface); the shell only navigates.
            // Setting ANY menu replaces Tauri's default wholesale, so the
            // standard Edit/Window submenus must be rebuilt — without them
            // macOS routes no Cmd+C/V/X/Z/A/W/M, which is fatal in an editor.
            let open_folder = MenuItemBuilder::with_id("open-folder", "Open Folder…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            // Cmd+W closes the active tab in the web UI, not the window —
            // Close Window moves to Shift+Cmd+W (standard macOS tabbed-app
            // convention).
            let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;
            let close_window = MenuItemBuilder::with_id("close-window", "Close Window")
                .accelerator("Shift+CmdOrCtrl+W")
                .build(app)?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_folder)
                .separator()
                .item(&close_tab)
                .item(&close_window)
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let reload = MenuItemBuilder::with_id("reload", "Reload Page")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let view_menu = SubmenuBuilder::new(app, "View").item(&reload).build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .fullscreen()
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&file_menu, &edit_menu, &view_menu, &window_menu])
                .build()?;
            let check_updates = MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
            let uninstall = MenuItemBuilder::with_id("uninstall", "Uninstall Sundial…").build(app)?;
            #[cfg(target_os = "macos")]
            {
                // Keep the standard app menu (About/Quit) ahead of File.
                let app_menu = SubmenuBuilder::new(app, "Sundial")
                    .about(None)
                    .separator()
                    .item(&check_updates)
                    .item(&uninstall)
                    .separator()
                    .hide()
                    .hide_others()
                    .separator()
                    .quit()
                    .build()?;
                menu.prepend(&app_menu)?;
            }
            #[cfg(not(target_os = "macos"))]
            {
                file_menu.append(&check_updates)?;
                file_menu.append(&uninstall)?;
            }
            app.set_menu(menu)?;
            let dest = parsed.clone();
            app.on_menu_event(move |app, event| {
                if event.id() == "open-folder" {
                    open_folder_flow(app.clone(), dest.clone());
                } else if event.id() == "close-tab" {
                    // Pages without a listener ignore the event, so Cmd+W is a
                    // no-op outside the workspace UI rather than closing the app.
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("window.dispatchEvent(new CustomEvent('sundial:close-tab'))");
                    }
                } else if event.id() == "close-window" {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.close();
                    }
                } else if event.id() == "reload" {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("location.reload()");
                    }
                } else if event.id() == "check-updates" {
                    tauri::async_runtime::spawn(check_for_update(app.clone(), true));
                } else if event.id() == "uninstall" {
                    uninstall_flow(app.clone());
                }
            });

            // First-launch handshake + background update checks belong to the
            // packaged app (https target); dev shells skip both.
            if proxied {
                spawn_first_launch_handshake(app.handle(), &remote, &parsed);
            }
            if !cfg!(debug_assertions) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // First check right after boot — an update the user needs
                    // should surface immediately, and the ready toast is
                    // re-announced on every page load so checking before the
                    // webview settles loses nothing. Then hourly.
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    loop {
                        check_for_update(handle.clone(), false).await;
                        tokio::time::sleep(Duration::from_secs(3600)).await;
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        // `code: None` is user interaction (Cmd+Q, window close) — never the
        // install thread's own restart/exit, which passes a code.
        RunEvent::ExitRequested { code: None, api, .. } => {
            if INSTALLING_UPDATE.load(std::sync::atomic::Ordering::SeqCst) {
                api.prevent_exit();
                return;
            }
            // A downloaded update the user never relaunched into installs on
            // the way out, so the next launch is current. Without this an
            // install could sit on an old build across every restart (seen:
            // 0.1.3 still running a month after 0.1.10 shipped, its month-old
            // sidecar failing chats under today's UI). Off the event loop: on
            // macOS an install that needs admin authorization queues its
            // prompt onto the main thread, which this callback is holding.
            // Best effort: a failure just leaves the current build in place.
            let taken = app.state::<PendingUpdate>().0.lock().unwrap().take();
            let Some((update, bytes)) = taken else { return };
            api.prevent_exit();
            // Guard up BEFORE the worker starts: a second Cmd+Q during
            // kill_sidecar's wait would otherwise find the pending slot empty
            // and let the process exit under the install.
            INSTALLING_UPDATE.store(true, std::sync::atomic::Ordering::SeqCst);
            let handle = app.clone();
            std::thread::spawn(move || {
                kill_sidecar(&handle);
                if let Err(error) = update.install(&bytes) {
                    eprintln!("[sundial] update install on quit failed: {error}");
                }
                INSTALLING_UPDATE.store(false, std::sync::atomic::Ordering::SeqCst);
                handle.exit(0);
            });
        }
        RunEvent::Exit => kill_sidecar(app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{is_open_folder_marker, leaves_app};
    fn u(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn external_marker_ejects_same_origin_paths_only() {
        use super::external_marker_url;
        let ok = external_marker_url(
            &u("http://localhost:3000/desktop/external?to=%2Fw%2Fabc"),
            "http",
            "localhost",
        );
        assert_eq!(ok.unwrap().as_str(), "http://localhost:3000/w/abc");
        // Protocol-relative and absolute targets must be rejected (open-redirect).
        assert!(external_marker_url(
            &u("http://localhost:3000/desktop/external?to=//evil.com/x"),
            "http",
            "localhost"
        )
        .is_none());
        assert!(external_marker_url(
            &u("http://localhost:3000/desktop/external?to=https%3A%2F%2Fevil.com"),
            "http",
            "localhost"
        )
        .is_none());
        // Off-site marker pages are not ours.
        assert!(external_marker_url(&u("https://evil.com/desktop/external?to=%2Fw%2Fabc"), "https", "sundial.md").is_none());
    }

    #[test]
    fn open_folder_marker_matches_same_site_only() {
        assert!(is_open_folder_marker(&u("http://localhost:3000/desktop/open-folder"), "http", "localhost"));
        assert!(is_open_folder_marker(&u("https://www.sundial.md/desktop/open-folder"), "https", "sundial.md"));
        // Off-site or other paths are not the marker (and other paths must
        // still flow through leaves_app untouched).
        assert!(!is_open_folder_marker(&u("https://evil.com/desktop/open-folder"), "https", "sundial.md"));
        assert!(!is_open_folder_marker(&u("https://www.sundial.md/desktop/open-folders"), "https", "sundial.md"));
        assert!(!leaves_app(&u("https://www.sundial.md/desktop/open-folder"), "https", "sundial.md", "sundial.md"));
    }

    #[test]
    fn apex_and_www_variants_stay_in_app() {
        // The regression: apex→www 308 redirect must NOT open the browser.
        assert!(!leaves_app(&u("https://www.sundial.md/dashboard"), "https", "sundial.md", "sundial.md"));
        assert!(!leaves_app(&u("https://sundial.md/dashboard"), "https", "sundial.md", "sundial.md"));
        assert!(!leaves_app(&u("https://www.sundial.md/onboarding"), "https", "sundial.md", "sundial.md"));
    }

    #[test]
    fn desktop_login_hands_off() {
        assert!(leaves_app(&u("https://www.sundial.md/desktop-login?next=/x"), "https", "sundial.md", "sundial.md"));
    }

    #[test]
    fn other_sites_hand_off() {
        assert!(leaves_app(&u("https://accounts.google.com/o/oauth2"), "https", "sundial.md", "sundial.md"));
        assert!(leaves_app(&u("https://github.com/login"), "https", "sundial.md", "sundial.md"));
        // Clerk's hosted account pages are the browser's job, unlike its API.
        assert!(leaves_app(&u("https://moral-oyster-95.accounts.dev/sign-in"), "https", "sundial.md", "sundial.md"));
    }

    #[test]
    fn clerk_handshake_stays_in_app() {
        // The regression: Clerk redirects the app's own page loads through its
        // session handshake; ejecting it blanks the webview forever.
        assert!(!leaves_app(
            &u("https://moral-oyster-95.clerk.accounts.dev/v1/client/handshake?redirect_url=x"),
            "http",
            "localhost",
            "localhost"
        ));
        assert!(!leaves_app(&u("https://clerk.sundial.md/v1/client/handshake"), "https", "sundial.md", "sundial.md"));
        // But clerk.<other-domain> is not our plumbing.
        assert!(leaves_app(&u("https://clerk.evil.com/v1/client/handshake"), "https", "sundial.md", "sundial.md"));
    }

    #[test]
    fn localhost_dev_stays_in_app() {
        assert!(!leaves_app(&u("http://localhost:3000/dashboard"), "http", "localhost", "localhost"));
        assert!(leaves_app(&u("http://localhost:3000/desktop-login"), "http", "localhost", "localhost"));
    }

    #[test]
    fn dev_shell_keeps_sidecar_loopback_in_app() {
        // The regression: the PDF preview iframe loads the sidecar at
        // 127.0.0.1 while the dev shell runs on localhost; WKWebView routes
        // subframe navigations through on_navigation, so a host mismatch
        // ejected the preview into the system browser.
        assert!(!leaves_app(&u("http://127.0.0.1:5151/projects/abc/file?path=doc.pdf"), "http", "localhost", "localhost"));
        // /desktop-login still hands off, and https loopback isn't our http shell.
        assert!(leaves_app(&u("http://127.0.0.1:4848/desktop-login"), "http", "localhost", "localhost"));
        assert!(leaves_app(&u("https://127.0.0.1:9999/x"), "http", "localhost", "localhost"));
        // One-way: the packaged app (proxy origin) still ejects localhost
        // links to the browser, and the prod domain is untouched.
        assert!(leaves_app(&u("http://localhost:3000/dashboard"), "http", "127.0.0.1", "sundial.md"));
        assert!(leaves_app(&u("http://127.0.0.1:5151/x"), "https", "sundial.md", "sundial.md"));
    }

    #[test]
    fn non_http_schemes_stay() {
        assert!(!leaves_app(&u("about:blank"), "https", "sundial.md", "sundial.md"));
    }

    #[test]
    fn proxied_mode_keeps_remote_clerk_domains_in_app() {
        // Packaged app: visible origin is the loopback proxy, but the remote
        // deployment's custom Clerk frontend domain must stay in the webview.
        assert!(!leaves_app(&u("https://clerk.sundial.md/v1/client/handshake"), "http", "127.0.0.1", "sundial.md"));
        assert!(!leaves_app(&u("https://x.clerk.accounts.dev/v1/client/handshake"), "http", "127.0.0.1", "sundial.md"));
        // The remote app origin itself still ejects to the browser (cloud
        // pages are the browser's job in the packaged app), as do other sites.
        assert!(leaves_app(&u("https://dev.sundial.md/w/abc"), "http", "127.0.0.1", "dev.sundial.md"));
        assert!(leaves_app(&u("https://github.com/login"), "http", "127.0.0.1", "sundial.md"));
        // …and /desktop-login on the proxy origin hands off.
        assert!(leaves_app(&u("http://127.0.0.1:4848/desktop-login"), "http", "127.0.0.1", "sundial.md"));
    }

    #[test]
    fn browser_urls_leave_the_loopback_proxy() {
        use super::browser_url;
        let remote = u("https://dev.sundial.md/local?sundialDesktop=1");
        // Proxy-origin URLs remap onto the remote origin (path + query kept).
        assert_eq!(
            browser_url(&u("http://127.0.0.1:4848/desktop-login?next=%2Flocal"), "127.0.0.1", &remote).as_str(),
            "https://dev.sundial.md/desktop-login?next=%2Flocal"
        );
        assert_eq!(
            browser_url(&u("http://127.0.0.1:4848/w/abc"), "127.0.0.1", &remote).as_str(),
            "https://dev.sundial.md/w/abc"
        );
        // Genuinely external URLs pass through untouched.
        assert_eq!(
            browser_url(&u("https://github.com/login"), "127.0.0.1", &remote).as_str(),
            "https://github.com/login"
        );
        // Direct (non-proxied) dev: same host both sides → unchanged.
        let dev = u("http://localhost:3000/local");
        assert_eq!(
            browser_url(&u("http://localhost:3000/desktop-login"), "localhost", &dev).as_str(),
            "http://localhost:3000/desktop-login"
        );
    }

    #[test]
    fn new_markers_match_same_site_only() {
        use super::is_marker;
        assert!(is_marker(&u("https://www.sundial.md/desktop/pick-location"), "https", "sundial.md", "/desktop/pick-location"));
        assert!(is_marker(&u("http://127.0.0.1:4848/desktop/relaunch-update"), "http", "127.0.0.1", "/desktop/relaunch-update"));
        assert!(!is_marker(&u("https://evil.com/desktop/pick-location"), "https", "sundial.md", "/desktop/pick-location"));
        // Markers must not leak into leaves_app (stay in-webview if unhandled).
        assert!(!leaves_app(&u("https://www.sundial.md/desktop/relaunch-update"), "https", "sundial.md", "sundial.md"));
    }

    #[test]
    fn redeem_paths_are_same_origin_only() {
        use super::safe_app_path;
        assert!(safe_app_path("/invite/abc123"));
        assert!(safe_app_path("/w/slug?chatId=1"));
        assert!(!safe_app_path("//evil.com/x"));
        assert!(!safe_app_path("https://evil.com"));
        assert!(!safe_app_path(""));
        assert!(!safe_app_path("/a b")); // whitespace smuggled into a request line
        assert!(!safe_app_path(&format!("/{}", "x".repeat(3000))));
    }

    #[test]
    fn nonce_comparison_requires_exact_match() {
        use super::constant_time_eq;
        assert!(constant_time_eq("abc123", "abc123"));
        assert!(!constant_time_eq("abc123", "abc124"));
        assert!(!constant_time_eq("abc", "abc123"));
        assert!(!constant_time_eq("", "abc"));
    }

    #[test]
    fn update_ready_js_escapes_for_js_literal() {
        use super::update_ready_js;
        assert_eq!(
            update_ready_js("0.2.0", false),
            "window.__SUNDIAL_UPDATE_READY=\"0.2.0\";window.__SUNDIAL_UPDATE_MANUAL=false;window.dispatchEvent(new CustomEvent('sundial:update-ready',{detail:{version:\"0.2.0\",manual:false}}));"
        );
        assert!(update_ready_js("0.2.0", true).contains("manual:true"));
        // A hostile version string from the update manifest must not escape
        // the JS string literal.
        let js = update_ready_js("1.0\";alert(1);//\\", false);
        assert!(js.contains("\"1.0\\\";alert(1);//\\\\\""));
    }

    #[test]
    fn remote_origin_formats() {
        use super::remote_origin_of;
        assert_eq!(remote_origin_of(&u("https://dev.sundial.md/local?x=1")), "https://dev.sundial.md");
        assert_eq!(remote_origin_of(&u("http://localhost:3000/local")), "http://localhost:3000");
    }
}
