// Login persistence for the headless sidecar (serve.sh --install): one
// supervisor unit that starts `node <bundle>` at login and keeps it alive.
// One daemon is enough for every shared folder — boot resumes ALL shares
// from the ledger (bridges.resumeAll) and the daemon-side token refresh
// covers each of them, so the unit never needs per-folder arguments.
//
// macOS: a LaunchAgent (~/Library/LaunchAgents). Linux: a systemd user unit.
// Windows: a per-user Scheduled Task at logon (schtasks) driving a hidden
// restart-loop wrapper. The loop IS the supervisor: it relaunches on crash
// and after a self-update exit, the two behaviors --supervised counts on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const PERSIST_LABEL = 'md.sundial.serve';

const xmlEscape = (value) =>
  String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/** Pure builders, exported for tests. `node` and `bundle` must be ABSOLUTE
 *  and stable across reboots (the owned runtime under ~/.sundial/runtime or
 *  a system node — never a temp path). */
export function buildLaunchAgentPlist({ node, bundle, app, home, port }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PERSIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(bundle)}</string>
    <string>--supervised</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SUNDIAL_REMOTE_ORIGIN</key><string>${xmlEscape(app)}</string>
    <key>SUNDIAL_LOCAL_HOME</key><string>${xmlEscape(home)}</string>
    <key>SUNDIAL_LOCAL_PORT</key><string>${xmlEscape(String(port))}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(home, 'serve-launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(home, 'serve-launchd.log'))}</string>
</dict>
</plist>
`;
}

export function buildSystemdUnit({ node, bundle, app, home, port }) {
  return `[Unit]
Description=Sundial local sync daemon (serve.sh)

[Service]
ExecStart=${node} ${bundle} --supervised
Environment=SUNDIAL_REMOTE_ORIGIN=${app}
Environment=SUNDIAL_LOCAL_HOME=${home}
Environment=SUNDIAL_LOCAL_PORT=${port}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** Windows wrapper pair, exported for tests. The .cmd is the supervisor: an
 *  infinite relaunch loop with the env the unit files carry on the other
 *  platforms. The .vbs launches it with window style 0 so no console pops at
 *  every logon. Paths are embedded quoted; cmd's %VAR% expansion never fires
 *  on these literals. */
export function buildWindowsTaskCmd({ node, bundle, app, home, port }) {
  return [
    '@echo off',
    `set "SUNDIAL_REMOTE_ORIGIN=${app}"`,
    `set "SUNDIAL_LOCAL_HOME=${home}"`,
    `set "SUNDIAL_LOCAL_PORT=${port}"`,
    ':loop',
    `"${node}" "${bundle}" --supervised >> "${path.join(home, 'serve-task.log')}" 2>&1`,
    'timeout /t 5 /nobreak >nul',
    'goto loop',
    '',
  ].join('\r\n');
}

export function buildWindowsTaskVbs({ cmdPath }) {
  // Wscript.Shell.Run: 0 = hidden window, False = do not wait.
  return `CreateObject("WScript.Shell").Run """${cmdPath}""", 0, False\r\n`;
}

const launchAgentPath = () => path.join(os.homedir(), 'Library/LaunchAgents', `${PERSIST_LABEL}.plist`);
const systemdUnitPath = () => path.join(os.homedir(), '.config/systemd/user', `${PERSIST_LABEL}.service`);
const windowsCmdPath = (home) => path.join(home, 'serve-task.cmd');
const windowsVbsPath = (home) => path.join(home, 'serve-task.vbs');

/** Whether a login unit can actually be installed HERE: platform support
 *  plus, on Linux, a LIVE systemd user manager. WSL distros and servers
 *  often have none; `systemctl --user` then dies with a dead-bus error,
 *  which once took the running sync down with it. Probed BEFORE any
 *  install so the failure mode is "keep syncing in the foreground and say
 *  so loudly", never a dead daemon. */
export function persistenceAvailable() {
  if (process.platform === 'darwin') return { ok: true };
  if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Query', '/TN', PERSIST_LABEL], { stdio: 'ignore' });
      return { ok: true };
    } catch {
      // Query fails when the task simply does not exist yet — probe the
      // binary itself instead: schtasks with no args prints usage and exits
      // 0 on every stock Windows.
      try {
        execFileSync('schtasks', ['/?'], { stdio: 'ignore' });
        return { ok: true };
      } catch {
        return { ok: false, reason: 'schtasks is unavailable; the login task cannot be created.' };
      }
    }
  }
  if (process.platform !== 'linux') {
    return { ok: false, reason: `no login service on ${process.platform}` };
  }
  try {
    const state = execFileSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).trim();
    return { ok: true, state };
  } catch (error) {
    // Non-zero exit still prints the state; 'degraded' (some units failed)
    // is a WORKING manager. Only an unreachable one disqualifies.
    const state = `${error?.stdout ?? ''}`.trim();
    if (/^(running|degraded|starting|maintenance)$/.test(state)) return { ok: true, state };
    const detail = `${error?.stderr ?? ''}`.trim() || state || error?.message || 'systemctl --user unreachable';
    return {
      ok: false,
      reason: `no systemd user session (${detail}). On WSL: add "[boot]\\nsystemd=true" to /etc/wsl.conf, run "wsl --shutdown", and re-open the distro.`,
    };
  }
}

/** Whether this install's login unit is already on disk (not whether it is
 *  currently running — pair with a /health probe for that). Lets a re-run
 *  recognize "already installed" instead of fighting the supervised daemon
 *  for the port and reporting failure while everything is healthy. */
export function persistenceInstalled(home) {
  try {
    if (process.platform === 'darwin') return fs.existsSync(launchAgentPath());
    if (process.platform === 'linux') return fs.existsSync(systemdUnitPath());
    if (process.platform === 'win32') return fs.existsSync(windowsCmdPath(home));
  } catch { /* unreadable home — treat as not installed */ }
  return false;
}

/** Install the login unit and start it NOW. The caller must have released
 *  the port first (close the in-process daemon before calling), or the
 *  supervised copy boots straight into the defer/exit path and launchd
 *  throttles it as a crash loop. Returns a human-readable summary line. */
export function installPersistence({ node, bundle, app, home, port, log = () => {} }) {
  if (process.platform === 'darwin') {
    const plist = launchAgentPath();
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, buildLaunchAgentPlist({ node, bundle, app, home, port }));
    const domain = `gui/${process.getuid?.() ?? ''}`;
    // Re-install is the common path (new folder, new deploy): boot out any
    // prior copy first; failures there just mean it wasn't loaded.
    try { execFileSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' }); } catch { /* not loaded */ }
    try {
      execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' });
    } catch {
      // Older macOS fallback.
      execFileSync('launchctl', ['load', '-w', plist]);
    }
    return `installed LaunchAgent ${plist} (starts at login, restarts on crash)`;
  }
  if (process.platform === 'linux') {
    const unit = systemdUnitPath();
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, buildSystemdUnit({ node, bundle, app, home, port }));
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', '--now', `${PERSIST_LABEL}.service`], { stdio: 'ignore' });
    return `installed systemd user unit ${unit} (starts at login, restarts on crash)`;
  }
  if (process.platform === 'win32') {
    const cmd = windowsCmdPath(home);
    const vbs = windowsVbsPath(home);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(cmd, buildWindowsTaskCmd({ node, bundle, app, home, port }));
    fs.writeFileSync(vbs, buildWindowsTaskVbs({ cmdPath: cmd }));
    // Per-user logon task, no admin required. /F replaces an existing task
    // (the common re-install path); /Run starts it NOW so persistence does
    // not wait for the next logon.
    execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', PERSIST_LABEL, '/TR', `wscript.exe "${vbs}"`], { stdio: 'ignore' });
    execFileSync('schtasks', ['/Run', '/TN', PERSIST_LABEL], { stdio: 'ignore' });
    return `installed Scheduled Task ${PERSIST_LABEL} (starts at logon, restarts on crash)`;
  }
  log(`[sundial-local] --install is not supported on ${process.platform}`);
  return `persistence not supported on ${process.platform}`;
}

/** Remove the login unit (and stop the supervised daemon). */
export function uninstallPersistence({ log = () => {}, home = null } = {}) {
  if (process.platform === 'darwin') {
    const plist = launchAgentPath();
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}`, plist], { stdio: 'ignore' }); } catch { /* not loaded */ }
    fs.rmSync(plist, { force: true });
    return `removed ${plist}`;
  }
  if (process.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', `${PERSIST_LABEL}.service`], { stdio: 'ignore' }); } catch { /* not enabled */ }
    fs.rmSync(systemdUnitPath(), { force: true });
    return `removed ${systemdUnitPath()}`;
  }
  if (process.platform === 'win32') {
    try { execFileSync('schtasks', ['/End', '/TN', PERSIST_LABEL], { stdio: 'ignore' }); } catch { /* not running */ }
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', PERSIST_LABEL], { stdio: 'ignore' }); } catch { /* not installed */ }
    const base = home ?? path.join(os.homedir(), '.sundial', 'desktop');
    fs.rmSync(windowsCmdPath(base), { force: true });
    fs.rmSync(windowsVbsPath(base), { force: true });
    return `removed Scheduled Task ${PERSIST_LABEL}`;
  }
  log(`[sundial-local] nothing to uninstall on ${process.platform}`);
  return 'nothing to uninstall';
}
