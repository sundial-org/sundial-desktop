/**
 * Chat ↔ folder placement (desktop wireframe): a chat relates to a folder when
 * it was started there ('here'), started in a subfolder ('sub'), or only
 * edited files under it ('touched' — dashed icon in the rail). Pure module so
 * the rail's focus-mode filter stays unit-testable.
 */
export type ChatFolderRelation = 'here' | 'sub' | 'touched';

/** The chat-list fields placement reads — both optional: rows from a
 *  pre-migration DB (or the local sidecar) simply never relate. */
export type ChatPlacementFields = {
  folder_scope?: string | null;
  touched_folders?: string[] | null;
};

/** Workspace-relative folder path: trimmed, no leading/trailing slashes.
 *  Null for anything unusable (empty, non-string, absurdly long). */
export function normalizeFolderScope(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^\/+|\/+$/g, '');
  return normalized && normalized.length <= 512 ? normalized : null;
}

export function chatFolderRelation(
  chat: ChatPlacementFields,
  folder: string | null | undefined,
): ChatFolderRelation | null {
  const target = normalizeFolderScope(folder);
  if (!target) return null;
  const scope = normalizeFolderScope(chat.folder_scope);
  if (scope === target) return 'here';
  if (scope?.startsWith(`${target}/`)) return 'sub';
  const touched = Array.isArray(chat.touched_folders) ? chat.touched_folders : [];
  for (const raw of touched) {
    const touchedFolder = normalizeFolderScope(raw);
    if (touchedFolder && (touchedFolder === target || touchedFolder.startsWith(`${target}/`))) {
      return 'touched';
    }
  }
  return null;
}
