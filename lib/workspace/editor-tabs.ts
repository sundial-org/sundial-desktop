/**
 * Typed tabs for the editor pane system (PR #907 shell: chats and diffs are
 * ordinary tabs beside files). A tab is still a plain string — file tabs are
 * workspace paths, non-file tabs carry a URI-style prefix that can never
 * collide with a workspace path (paths are relative and never contain "//").
 */

export const CHAT_TAB_PREFIX = 'sundial-chat://';
export const DIFF_TAB_PREFIX = 'sundial-diff://';
/** The review timeline as a tab. `sundial-review://all` is the whole workspace
 *  (the same view the right dock shows); `sundial-review://chat/<id>` scopes it
 *  to one chat — every edit that chat ever made, in one place. */
export const REVIEW_TAB_PREFIX = 'sundial-review://';
/** The ⌘T "New tab" chooser (Obsidian-style). Transient: consumed in place by
 *  whatever opens next in its pane, and never restored from a snapshot. */
export const LAUNCHER_TAB = 'sundial-launcher://new';

export const isChatTab = (tab: string) => tab.startsWith(CHAT_TAB_PREFIX);
export const isDiffTab = (tab: string) => tab.startsWith(DIFF_TAB_PREFIX);
export const isReviewTab = (tab: string) => tab.startsWith(REVIEW_TAB_PREFIX);
export const isLauncherTab = (tab: string) => tab === LAUNCHER_TAB;
/** Non-file tabs: never path-remapped, never validated against the file list. */
export const isSpecialTab = (tab: string) =>
  isChatTab(tab) || isDiffTab(tab) || isReviewTab(tab) || isLauncherTab(tab);

export const chatTab = (chatId: string) => `${CHAT_TAB_PREFIX}${chatId}`;
export const chatIdOfTab = (tab: string) => (isChatTab(tab) ? tab.slice(CHAT_TAB_PREFIX.length) : null);

/** Diff tabs key on the assistant message whose turn-edits they show. */
export const diffTab = (assistantMessageId: string) => `${DIFF_TAB_PREFIX}${assistantMessageId}`;
export const diffIdOfTab = (tab: string) => (isDiffTab(tab) ? tab.slice(DIFF_TAB_PREFIX.length) : null);

export const reviewTab = (chatId?: string | null) =>
  chatId ? `${REVIEW_TAB_PREFIX}chat/${chatId}` : `${REVIEW_TAB_PREFIX}all`;
/** The chat a review tab is scoped to, or `null` for the whole workspace (and
 *  for any tab that isn't a review tab — pair it with `isReviewTab`). */
export const reviewChatIdOfTab = (tab: string): string | null => {
  if (!isReviewTab(tab)) return null;
  const scope = tab.slice(REVIEW_TAB_PREFIX.length);
  return scope.startsWith('chat/') ? scope.slice('chat/'.length) || null : null;
};
