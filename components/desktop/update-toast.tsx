'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { XIcon } from '@phosphor-icons/react';
import { isDesktopApp } from '@/lib/desktop';

declare global {
  interface Window {
    /** Set by the Tauri shell (eval) when an update has been downloaded. */
    __SUNDIAL_UPDATE_READY?: string;
    /** The native Check for Updates dialog offered this one: its Relaunch/Later is the user's call. */
    __SUNDIAL_UPDATE_MANUAL?: boolean;
  }
}

/**
 * Desktop update surface. The shell downloads updates in the background and
 * announces readiness by setting `__SUNDIAL_UPDATE_READY` and dispatching
 * `sundial:update-ready` (it owns no UI of its own — the webview is the whole
 * surface). Relaunch navigates to the /desktop/relaunch-update marker, which
 * the shell intercepts to install and restart.
 *
 * On the launcher (`/local`, nothing open) the update applies by itself the
 * moment it's staged — there's no work to interrupt there, and it's the one
 * screen every install visits (older shells load it from the cloud, so this
 * is also what moves an install that never clicked Relaunch). Inside a
 * project it stays a "Relaunch" toast; a downloaded update the user never
 * relaunched into installs on quit anyway. It waits out an open dialog and any
 * launcher operation in flight (clone/create/open mark themselves
 * `aria-busy`): the install kills the sidecar, which would strand a half-done
 * clone, and a relaunch under a form drops what was typed. One automatic attempt
 * per version: a failed install restarts the current build (which lands on
 * the launcher again), and looping there would trap the user. Renders nothing
 * outside the shell.
 */
const AUTO_TRIED_KEY = 'sundial:autoUpdateTried';

export function DesktopUpdateToast() {
  const [version, setVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [relaunching, setRelaunching] = useState(false);
  const [manual, setManual] = useState(false);
  const onLauncher = usePathname() === '/local';

  useEffect(() => {
    if (!isDesktopApp()) return;
    if (window.__SUNDIAL_UPDATE_READY) {
      setVersion(window.__SUNDIAL_UPDATE_READY);
      setManual(window.__SUNDIAL_UPDATE_MANUAL === true);
    }
    // Shells from before the `manual` flag (the very installs this exists to
    // move) announce without it; on their launcher a "Later" in the native
    // dialog can still be overtaken by the auto-apply — accepted: nothing is
    // open there, and the update is what retires that shell.
    const onReady = (event: Event) => {
      const detail = (event as CustomEvent<{ version?: string; manual?: boolean }>).detail;
      if (!detail?.version) return;
      setVersion(detail.version);
      setManual(detail.manual === true);
    };
    // The shell declines a relaunch it can't take right now (a native picker
    // is open); the toast drops back to its manual Relaunch.
    const onDeferred = () => setRelaunching(false);
    window.addEventListener('sundial:update-ready', onReady);
    window.addEventListener('sundial:update-deferred', onDeferred);
    return () => {
      window.removeEventListener('sundial:update-ready', onReady);
      window.removeEventListener('sundial:update-deferred', onDeferred);
    };
  }, []);

  useEffect(() => {
    if (!version || !onLauncher || relaunching || manual || dismissed) return;
    try {
      if (localStorage.getItem(AUTO_TRIED_KEY) === version) return;
    } catch {
      return;
    }
    const tick = () => {
      // Native surfaces (folder picker, the shell's own dialogs) live
      // outside the DOM but take the window's focus: an unfocused window
      // isn't touched — also true on shells too old to defer for them.
      if (!document.hasFocus()) return;
      if (document.querySelector('[aria-busy="true"], [role="dialog"]')) return;
      clearInterval(timer);
      localStorage.setItem(AUTO_TRIED_KEY, version);
      setRelaunching(true);
      window.location.assign('/desktop/relaunch-update');
    };
    // Interval only, no immediate tick: a page that mounts alongside this
    // effect (e.g. the launcher receiving a just-picked folder) marks itself
    // busy in a state update the DOM won't show until its next render.
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [version, onLauncher, relaunching, manual, dismissed]);

  if (!version || dismissed) return null;

  return (
    <div
      className="fixed bottom-4 left-4 z-50 flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm shadow-lg"
      data-testid="desktop-update-toast"
    >
      {relaunching ? (
        <span className="text-stone-600">
          Updating to <span className="font-medium text-stone-800">{version}</span>…
        </span>
      ) : (
        <>
          <span className="text-stone-600">
            Version <span className="font-medium text-stone-800">{version}</span> ready to install
          </span>
          <button
            type="button"
            className="font-medium text-stone-900 underline underline-offset-4 hover:text-stone-600"
            onClick={() => {
              setRelaunching(true);
              window.location.assign('/desktop/relaunch-update');
            }}
          >
            Relaunch
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            className="text-stone-400 hover:text-stone-600"
            onClick={() => setDismissed(true)}
          >
            <XIcon className="h-3.5 w-3.5" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
