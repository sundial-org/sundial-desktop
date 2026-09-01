'use client';

import { ModalShell } from '@/components/modal-shell';

/** One calm question before an irreversible delete, as a REAL in-app modal —
 *  never window.confirm, which the desktop (Tauri) webview refuses outright
 *  and would skip the warning entirely. Styling matches StopShareConfirmDialog. */
export function DeleteChatDialog({
  open,
  chatTitle,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  chatTitle?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell
      open={open}
      onClose={onCancel}
      ariaLabel="Delete chat?"
      overlayClassName="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      panelClassName="w-full max-w-sm rounded-2xl bg-white border border-stone-200 shadow-xl"
    >
      <div className="px-5 pt-5 pb-4" data-testid="chat-delete-confirm">
        <h2 className="text-base font-semibold text-stone-800">Delete chat?</h2>
        <p className="mt-1.5 text-sm text-stone-500">
          This cannot be undone.
          {chatTitle?.trim() ? ` "${chatTitle.trim()}" and its messages will be removed.` : ''}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="chat-delete-cancel"
            className="rounded-lg border border-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid="chat-delete-proceed"
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
          >
            Delete chat
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
