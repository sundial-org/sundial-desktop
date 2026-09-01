'use client';

import { ModalShell } from '@/components/modal-shell';

/**
 * The Sundial Agent runs in the cloud on the user's Sundial account, so a
 * signed-out send has to route through sign-in. In the desktop shell that
 * sign-in is a system-browser handoff (lib/desktop beginDesktopAuth), which
 * used to fire straight off the send button: the browser jumped in front of
 * the app with nothing explaining why. Ask first, open second.
 */
export function CloudAgentSignInModal({
  open,
  onCancel,
  onSignIn,
}: {
  open: boolean;
  onCancel: () => void;
  onSignIn: () => void;
}) {
  return (
    <ModalShell open={open} onClose={onCancel} ariaLabel="Sign in to use the Sundial Agent">
      <div data-testid="cloud-agent-signin-modal" className="p-5">
        <h2 className="text-[15px] font-semibold text-stone-900">Sign in to use the Sundial Agent</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-stone-600">
          The Sundial Agent runs in the cloud on your Sundial account, so this chat needs you signed
          in. Claude Code and Codex keep running on this computer with no account.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-stone-500">
          Signing in opens your browser. Your message stays in the composer, ready to send when
          you come back.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="cloud-agent-signin-cancel"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-stone-600 hover:bg-stone-100"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="cloud-agent-signin-confirm"
            onClick={onSignIn}
            className="rounded-lg bg-stone-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-stone-800"
          >
            Sign in
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
