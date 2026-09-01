/**
 * Shared Edit/Suggest mode model.
 *
 * `edit`    — changes land as final document text.
 * `suggest` — changes still apply live, but are recorded as reviewable
 *             `doc_edits` rows (Keep/Undo), rendered exactly like agent diffs.
 * `view`    — read-only: Sunny answers without editing files (the chat brain
 *             drops its write tools). Produces no `doc_edits`, so no DB change.
 *
 * The same model drives the human document toolbar control and the chat
 * composer control, and is persisted on `doc_edits.edit_mode` +
 * `messages.metadata.edit_mode`. `view` is offered on the chat composer only.
 */
export type WorkspaceEditMode = 'edit' | 'suggest' | 'view';

export const DEFAULT_EDIT_MODE: WorkspaceEditMode = 'edit';
export const DEFAULT_CHAT_EDIT_MODE: WorkspaceEditMode = 'suggest';

/** Modes offered on the chat composer (includes read-only Viewing). */
export const CHAT_EDIT_MODES: WorkspaceEditMode[] = ['edit', 'suggest', 'view'];
/** Modes offered on the document toolbar for non-markdown files. */
export const DOC_EDIT_MODES: WorkspaceEditMode[] = ['edit', 'suggest'];
/** Document toolbar modes for markdown — adds the read-only view. */
export const MARKDOWN_DOC_EDIT_MODES: WorkspaceEditMode[] = ['edit', 'suggest', 'view'];
/** Raw-markdown view: Suggesting is a rich-editor feature, so offer Edit/Read only only. */
export const RAW_MARKDOWN_DOC_EDIT_MODES: WorkspaceEditMode[] = ['edit', 'view'];

export function isEditMode(value: unknown): value is WorkspaceEditMode {
  return value === 'edit' || value === 'suggest' || value === 'view';
}

/** Coerce an arbitrary value to a valid mode, falling back to the default. */
export function coerceEditMode(
  value: unknown,
  fallback: WorkspaceEditMode = DEFAULT_EDIT_MODE,
): WorkspaceEditMode {
  return isEditMode(value) ? value : fallback;
}

export const EDIT_MODE_LABEL: Record<WorkspaceEditMode, string> = {
  edit: 'Edit',
  suggest: 'Suggest',
  view: 'View',
};

/** Tooltip / menu copy, e.g. "Edit mode". */
export const EDIT_MODE_TOOLTIP: Record<WorkspaceEditMode, string> = {
  edit: 'Edit mode',
  suggest: 'Suggest mode',
  view: 'View mode',
};

const STORAGE_PREFIX = 'sundial:edit-mode';

/** localStorage key for the human/document mode, scoped per workspace. */
export function documentEditModeStorageKey(workspaceId: string): string {
  return `${STORAGE_PREFIX}:doc:${workspaceId}`;
}

/** localStorage key for the chat composer mode, scoped per chat. */
export function chatEditModeStorageKey(chatId: string): string {
  return `${STORAGE_PREFIX}:chat:${chatId}`;
}

export function readStoredEditMode(key: string): WorkspaceEditMode | null {
  if (typeof window === 'undefined') return null;
  try {
    return coerceEditMode(window.localStorage.getItem(key), DEFAULT_EDIT_MODE);
  } catch {
    return null;
  }
}

export function writeStoredEditMode(key: string, mode: WorkspaceEditMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, mode);
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}
