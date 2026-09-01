'use client';

import { useState } from 'react';
import { extractAnonKey } from '@/lib/auth/anon-identity';

/**
 * The unclaimed-workspace wall: a key-gated workspace with NO account owner
 * was opened without its key (a bare /w/<slug> URL). Signing in here would
 * change nothing — claim-on-login only fires for a browser that opened the
 * `anon=` link — so instead of a dead-end sign-in wall, ask for the key.
 * The field accepts the full workspace link or the bare key; submitting
 * routes through /w/<slug>?anon=<key>, where the proxy adopts the key and
 * every existing rail (access, claim nudge, claim-on-login) takes over.
 */
export function ClaimKeyGate({
  workspacePath,
  onNavigate,
}: {
  /** The workspace path to re-enter with the key (e.g. /w/abc123). */
  workspacePath: string;
  /** Test seam; defaults to a full navigation so the proxy runs. */
  onNavigate?: (href: string) => void;
}) {
  const [value, setValue] = useState('');
  const [rejected, setRejected] = useState(false);

  const submit = () => {
    const key = extractAnonKey(value);
    if (!key) {
      setRejected(true);
      return;
    }
    const href = `${workspacePath}?anon=${encodeURIComponent(key)}`;
    if (onNavigate) onNavigate(href);
    else window.location.assign(href);
  };

  return (
    <div data-testid="claim-key-gate" className="mt-6 text-left">
      <p className="text-sm text-stone-600">
        This workspace is key-gated and has not been claimed yet. Go back to
        the AI chat where it was created; the message there carries a link
        with its key. Paste the link (or just the key) here:
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setRejected(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
          placeholder="https://…?anon=… or the key itself"
          data-testid="claim-key-input"
          className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-xs text-stone-900 placeholder:text-stone-400 focus:border-stone-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={submit}
          data-testid="claim-key-submit"
          className="shrink-0 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800"
        >
          Open
        </button>
      </div>
      {rejected ? (
        <p className="mt-2 text-xs text-rose-600" data-testid="claim-key-rejected">
          That does not look like a workspace key or link. It ends in digits,
          like <span className="font-mono">maple-fern-umber-a1b2c3-4567</span>.
        </p>
      ) : null}
    </div>
  );
}
