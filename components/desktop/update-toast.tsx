'use client';

import { useEffect, useState } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { isDesktopApp } from '@/lib/desktop';

declare global {
  interface Window {
    /** Set by the Tauri shell (eval) when an update has been downloaded. */
    __SUNDIAL_UPDATE_READY?: string;
  }
}

/**
 * "Version X ready to install — Relaunch" toast for the desktop shell. The
 * shell downloads updates in the background and announces readiness by
 * setting `__SUNDIAL_UPDATE_READY` and dispatching `sundial:update-ready`
 * (it owns no UI of its own — the webview is the whole surface). Relaunch
 * navigates to the /desktop/relaunch-update marker, which the shell
 * intercepts to install and restart. Renders nothing outside the shell.
 */
export function DesktopUpdateToast() {
  const [version, setVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [relaunching, setRelaunching] = useState(false);

  useEffect(() => {
    if (!isDesktopApp()) return;
    if (window.__SUNDIAL_UPDATE_READY) setVersion(window.__SUNDIAL_UPDATE_READY);
    const onReady = (event: Event) => {
      const detail = (event as CustomEvent<{ version?: string }>).detail;
      if (detail?.version) setVersion(detail.version);
    };
    window.addEventListener('sundial:update-ready', onReady);
    return () => window.removeEventListener('sundial:update-ready', onReady);
  }, []);

  if (!version || dismissed) return null;

  return (
    <div
      className="fixed bottom-4 left-4 z-50 flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm shadow-lg"
      data-testid="desktop-update-toast"
    >
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
        {relaunching ? 'Relaunching…' : 'Relaunch'}
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        className="text-stone-400 hover:text-stone-600"
        onClick={() => setDismissed(true)}
      >
        <XIcon className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
