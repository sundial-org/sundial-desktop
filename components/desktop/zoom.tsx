'use client';

import { useEffect } from 'react';
import { isDesktopApp } from '@/lib/desktop';

// Interface zoom for the desktop shell (Cmd/Ctrl + '=' / '-' / '0'), Obsidian
// style. Uses the webview's native page zoom (reflows like browser zoom —
// unlike CSS `zoom`, which breaks 100vh layouts), so it needs the Tauri IPC
// globals: present on the loopback/localhost origins the shell serves
// (capabilities/remote-ui.json grants set-webview-zoom), absent in plain
// browsers — where Cmd+/− already zooms natively and this component no-ops.
const ZOOM_STORAGE_KEY = 'sundial:zoom';
const ZOOM_LEVELS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function storedZoom(): number {
  const parsed = Number(window.localStorage.getItem(ZOOM_STORAGE_KEY));
  return ZOOM_LEVELS.includes(parsed) ? parsed : 1;
}

async function applyZoom(factor: number) {
  window.localStorage.setItem(ZOOM_STORAGE_KEY, String(factor));
  // The macOS traffic lights are positioned natively in window points and
  // don't scale with page zoom — expose the factor so the CSS clearance pads
  // (`pl-[calc(72px/var(--sd-zoom,1))]`) stay constant in physical points.
  document.documentElement.style.setProperty('--sd-zoom', String(factor));
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().setZoom(factor);
}

export function DesktopZoomHandler() {
  // macOS WKWebView rubber-bands the ROOT frame on trackpad scroll even when
  // nothing overflows — inner scrollers chain to the document and the whole
  // fixed-layout shell visibly bounces. Root-level overscroll-behavior stops
  // the chaining. Desktop-only: browser pages should keep their native feel.
  useEffect(() => {
    if (!isDesktopApp()) return;
    document.documentElement.style.overscrollBehavior = 'none';
    document.body.style.overscrollBehavior = 'none';
  }, []);
  useEffect(() => {
    if (!isDesktopApp() || !('__TAURI_INTERNALS__' in window)) return;
    if (storedZoom() !== 1) void applyZoom(storedZoom());
    // Capture phase so an editor with focus can't swallow the shortcut.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const direction =
        event.key === '=' || event.key === '+' ? 1 : event.key === '-' || event.key === '_' ? -1 : 0;
      if (direction === 0 && event.key !== '0') return;
      event.preventDefault();
      const index = ZOOM_LEVELS.indexOf(storedZoom());
      const next =
        event.key === '0'
          ? 1
          : ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + direction))];
      void applyZoom(next);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);
  return null;
}
