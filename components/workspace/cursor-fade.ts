/**
 * Google-Docs-style collaborator name flags: the flag shows on cursor move /
 * typing, then fades out while idle (CSS `sundial-cursor-label-idle-fade`).
 *
 * y-prosemirror keys each remote cursor widget by clientId, so ProseMirror
 * REUSES the same `.sundial-cursor` DOM node when a collaborator moves — it
 * never rebuilds it (see tests/collab/cursor-label-fade.test.ts). A one-shot
 * CSS animation on a reused node won't replay, so we restart it by hand when a
 * collaborator's awareness changes — scoped to the clients that actually
 * changed, so idle peers (and your own typing, which only updates your own
 * awareness) are left untouched.
 */

/**
 * Build the caret for a remote collaborator. y-prosemirror invokes the cursor
 * builder as `createCursor(user, clientId)` (y-prosemirror 1.3.7, dist line
 * ~1918), so we stamp `data-cid` to let restartCursorLabelFade() target the
 * caret when this collaborator later moves.
 */
export function buildCursorCaret(
  user: { name?: string; color?: string },
  clientId?: number,
): HTMLElement {
  const caret = document.createElement('span');
  caret.classList.add('sundial-cursor');
  if (clientId != null) caret.dataset.cid = String(clientId);
  if (String(user.name ?? '').toLowerCase().includes('sunny')) {
    caret.classList.add('sundial-cursor--sunny');
  }
  caret.style.borderColor = user.color ?? '';

  const label = document.createElement('span');
  label.classList.add('sundial-cursor__label');
  label.style.backgroundColor = user.color ?? '';
  label.textContent = user.name ?? '';

  caret.append(label);
  return caret;
}

/** Replay the idle-fade for the given clients' name flags (restarts the CSS animation). */
export function restartCursorLabelFade(root: ParentNode, clientIds: Iterable<number>): void {
  for (const cid of clientIds) {
    const label = root.querySelector<HTMLElement>(
      `.sundial-cursor[data-cid="${cid}"] .sundial-cursor__label`,
    );
    if (!label) continue;
    label.style.animation = 'none';
    void label.offsetWidth; // force reflow so the next assignment replays it
    label.style.animation = '';
  }
}
