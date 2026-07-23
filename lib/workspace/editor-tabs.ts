/**
 * Typed tabs for the editor pane system (PR #907 shell: chats and diffs are
 * ordinary tabs beside files). A tab is still a plain string — file tabs are
 * workspace paths, non-file tabs carry a URI-style prefix that can never
 * collide with a workspace path (paths are relative and never contain "//").
 */

export const CHAT_TAB_PREFIX = 'sundial-chat://';
export const DIFF_TAB_PREFIX = 'sundial-diff://';

export const isChatTab = (tab: string) => tab.startsWith(CHAT_TAB_PREFIX);
export const isDiffTab = (tab: string) => tab.startsWith(DIFF_TAB_PREFIX);
/** Non-file tabs: never path-remapped, never validated against the file list. */
export const isSpecialTab = (tab: string) => isChatTab(tab) || isDiffTab(tab);

export const chatTab = (chatId: string) => `${CHAT_TAB_PREFIX}${chatId}`;
export const chatIdOfTab = (tab: string) => (isChatTab(tab) ? tab.slice(CHAT_TAB_PREFIX.length) : null);

/** Diff tabs key on the assistant message whose turn-edits they show. */
export const diffTab = (assistantMessageId: string) => `${DIFF_TAB_PREFIX}${assistantMessageId}`;
export const diffIdOfTab = (tab: string) => (isDiffTab(tab) ? tab.slice(DIFF_TAB_PREFIX.length) : null);
