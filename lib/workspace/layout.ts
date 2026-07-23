export type WorkspaceViewMode = 'chat' | 'space';
export type LeftRail = 'files' | 'chats' | null;

/**
 * Workspace-v4 Phase 2 — the center column is an ordered set of open panels
 * instead of the old `mode` (chat|space) + `documentMode` (editor|review) +
 * `spaceChatPanelOpen` triple. Each panel is an independent, individually
 * closable column; the order is the left→right render order (Phase 3 reorders
 * it). These helpers are the single source of truth for the open-set
 * transitions so the chat-reliability-sensitive state stays pure and tested.
 */
export type CenterPanel = 'editor' | 'chat' | 'review';

export function isCenterPanel(value: unknown): value is CenterPanel {
  return value === 'editor' || value === 'chat' || value === 'review';
}

// Editor, Review, and Chat are fully independent columns — any combination can
// be open at once, and toggling one never affects the others.

/** Multi-toggle / X-out: drop the panel if open, else append it. */
export function togglePanel(panels: CenterPanel[], panel: CenterPanel): CenterPanel[] {
  if (panels.includes(panel)) return panels.filter((p) => p !== panel);
  return [...panels, panel];
}

/** Ensure a panel is open without disturbing the rest (idempotent). */
export function addPanel(panels: CenterPanel[], panel: CenterPanel): CenterPanel[] {
  if (panels.includes(panel)) return panels;
  return [...panels, panel];
}

/** Close a panel; a no-op when it isn't open. */
export function removePanel(panels: CenterPanel[], panel: CenterPanel): CenterPanel[] {
  return panels.includes(panel) ? panels.filter((p) => p !== panel) : panels;
}

/** Validate a persisted value into a clean, de-duplicated, ordered open-set. */
export function normalizeOpenPanels(value: unknown): CenterPanel[] {
  if (!Array.isArray(value)) return [];
  const out: CenterPanel[] = [];
  for (const entry of value) {
    if (!isCenterPanel(entry) || out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}

/** Migrate a pre-Phase-2 single `mode` into the equivalent open-set. */
export function legacyModeToOpenPanels(mode: WorkspaceViewMode | undefined): CenterPanel[] {
  return mode === 'chat' ? ['chat'] : ['editor'];
}

/**
 * Open-set to restore on reload. A deep-linked file ("?fileId=") means "show me
 * this file", so it forces the editor open even when the stored set didn't
 * have it.
 */
export function resolveRestoredOpenPanels(
  stored: unknown,
  hasDeepLinkedFile: boolean
): CenterPanel[] {
  const panels = normalizeOpenPanels(stored);
  // A deep-linked file forces the editor open alongside any other stored panels.
  if (hasDeepLinkedFile && !panels.includes('editor')) return addPanel(panels, 'editor');
  return panels;
}

/**
 * Open-set for arriving at a workspace. URL intents win: editor-intent URLs
 * (?fileId=, comment/diff anchors) land on the document, ?chat=1 forces chat
 * open. A plain workspace URL restores the workspace's stored layout — leaving
 * and coming back puts you where you left off (e.g. chat + review while
 * multitasking across workspaces) — and only a first visit (nothing stored)
 * lands on the chat box so the first act is telling the agent what you want,
 * not staring at a doc (Open-Knowledge-style onboarding; the blank-page fix).
 */
export function resolveArrivalOpenPanels(args: {
  /** Persisted openPanels (already legacy-migrated); null when nothing stored. */
  stored: CenterPanel[] | null;
  /** ?fileId= / ?filePath= — "show me this file". */
  hasDeepLinkedFile: boolean;
  /** ?commentThreadId= / ?diff= — anchors that live in the editor. */
  hasEditorAnchor: boolean;
  /** ?chat=1 or a deep-linked chat (?chatId=) — chat must be open too. */
  chatIntent: boolean;
}): CenterPanel[] {
  const editorIntent = args.hasDeepLinkedFile || args.hasEditorAnchor;
  // Editor intent forces the editor into the restored set; otherwise the
  // stored layout restores as-is. A first visit (nothing stored, no editor
  // intent) lands on the chat box, which also satisfies any chat intent.
  let panels = editorIntent
    ? resolveRestoredOpenPanels(args.stored ?? ['editor'], true)
    : args.stored ?? [];
  if (panels.length === 0) return ['chat'];
  if (args.chatIntent) panels = addPanel(panels, 'chat');
  return panels;
}

/**
 * Per-workspace localStorage key for the layout config. The bare prefix is the
 * pre-split shared key, kept only as a one-time migration source (and as the
 * fallback when no projectId is resolved).
 */
export const WORKSPACE_LAYOUT_STORAGE_KEY = 'sundial:workspace-layout';
export function workspaceLayoutStorageKey(projectId: string | null | undefined): string {
  return projectId ? `${WORKSPACE_LAYOUT_STORAGE_KEY}:${projectId}` : WORKSPACE_LAYOUT_STORAGE_KEY;
}

export type VisibleColumns = {
  editor: boolean;
  review: boolean;
  chat: boolean;
  /** Chat fills the center (old chat-first) rather than docking as a side column. */
  chatSole: boolean;
  /** Desktop-only empty center (all panels closed). */
  empty: boolean;
};

/**
 * Which center columns to render. Desktop shows every open panel side by side;
 * mobile collapses to a single panel (chat wins only when it's the lone
 * surface, otherwise the editor), and review uses a full-screen overlay rather
 * than a column. Keeping this pure makes the mobile↔desktop mapping testable.
 */
export function resolveVisibleColumns(
  openPanels: CenterPanel[],
  isMobile: boolean
): VisibleColumns {
  const hasEditor = openPanels.includes('editor');
  const hasReview = openPanels.includes('review');
  const hasChat = openPanels.includes('chat');
  if (isMobile) {
    const chat = hasChat && !hasEditor;
    return { editor: !chat, review: false, chat, chatSole: chat, empty: false };
  }
  return {
    editor: hasEditor,
    review: hasReview,
    chat: hasChat,
    chatSole: hasChat && openPanels.length === 1,
    empty: openPanels.length === 0,
  };
}

export type WorkspaceLayoutConfig = {
  openLeftRail: LeftRail;
  mode: WorkspaceViewMode;
  leftRailWidth: number;
};

export const DEFAULT_LEFT_RAIL_WIDTH = 260;
export const MIN_LEFT_RAIL_WIDTH = 220;
export const LEFT_RAIL_COLLAPSE_WIDTH = 176;
export const MAX_LEFT_RAIL_WIDTH = 640;

// Below this width the workspace switches to the single-panel mobile layout
// (drawers, mobile header). Above it — including small-desktop / tablet windows
// — it keeps the desktop column layout and the desktop header, which collapses
// progressively (see app/w/[slug]/page.tsx) rather than swapping to a different
// chrome, so "desktop but lesser width" stays consistent with wide screens.
//
// Set at the Tailwind `md` boundary (767) rather than lower, because the desktop
// layout tiles columns side by side: editor (min-w-[400px]) + chat (min-w-[360px])
// already need ~760px, and the center wrapper is overflow-hidden, so a narrower
// "desktop" range would clip the second panel instead of falling back to the
// single-panel mobile layout. Phones / small tablets (<768) get the mobile layout.
export const MOBILE_MAX_WIDTH = 767;
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

function isWorkspaceViewMode(value: unknown): value is WorkspaceViewMode {
  return value === 'chat' || value === 'space';
}

function isLeftRail(value: unknown): value is LeftRail {
  return value === 'files' || value === 'chats' || value === null;
}

export function getLeftRailForMode(mode: WorkspaceViewMode): Exclude<LeftRail, null> {
  return mode === 'chat' ? 'chats' : 'files';
}

export function syncLeftRailWithMode(mode: WorkspaceViewMode, openLeftRail: LeftRail): LeftRail {
  if (openLeftRail === null) return null;
  return getLeftRailForMode(mode);
}


/**
 * Whether a deep-linked file that no longer resolves should fall back to
 * full-screen chat. The optimistic space-mode restore assumes the file exists;
 * once files load and it's confirmed missing (and was never opened, so an
 * actively-edited file deleted mid-session isn't yanked away), a deep-linked
 * chat should take over the view instead of stranding an empty editor.
 */
export function shouldFallBackToFullScreenChat(args: {
  hasDeepLinkedFile: boolean;
  fileResolved: boolean;
  fileAlreadyOpened: boolean;
  hasSelectedChat: boolean;
  isChatMode: boolean;
}): boolean {
  if (!args.hasDeepLinkedFile || args.isChatMode) return false;
  if (args.fileResolved || args.fileAlreadyOpened) return false;
  return args.hasSelectedChat;
}

// The active chat thread always exists, so mirroring its id into the URL
// unconditionally makes every reload look like a shared file+chat deep link and
// force-reopens the chat panel. Keep chatId in the URL only while chat is open;
// the active thread is still restored from the sundial:last-chat localStorage
// pointer when chat is closed.
export function shouldMirrorChatIdToUrl(currentChatId: string | null, isChatVisible: boolean): boolean {
  return Boolean(currentChatId) && isChatVisible;
}

/** The navigational identity of an in-workspace view: which file is active and
 *  which chat is selected. Panel open/close is deliberately NOT part of it — the
 *  chatId is the *selected* chat, not "chat visible". */
export type WorkspaceViewKey = { fileId: string | null; chatId: string | null };
export type WorkspaceViewRefs = { fileRef: string | null; chatRef: string | null };

/** True once async file/chat state matches the browser entry being restored. */
export function isWorkspaceRestoreSettled(
  current: WorkspaceViewRefs,
  target: WorkspaceViewRefs,
): boolean {
  return current.fileRef === target.fileRef && current.chatRef === target.chatRef;
}

/** Mobile can show only one restored surface, so its target must be achievable. */
export function resolveWorkspaceRestoreTargetForLayout(
  target: WorkspaceViewRefs,
  isMobile: boolean,
  showChat: boolean,
): WorkspaceViewRefs {
  if (!isMobile) return target;
  return showChat
    ? { fileRef: null, chatRef: target.chatRef }
    : { fileRef: target.fileRef, chatRef: null };
}

/**
 * Whether mirroring the current view into the URL should push a new history
 * entry (a real in-workspace navigation `back` should undo) or replace the
 * current one (a transient rewrite that should stay invisible to `back`).
 *
 * Push only on a genuine view change: the active file changed, or the user
 * switched from one chat to another (both ids present and different). Before the
 * landing view has settled (`landingSettled` false) and while restoring a
 * back/forward view (`restoring`), always replace — so the workspace's landing
 * URL (including the default file that opens on a fresh workspace) folds into one
 * entry and popstate restoration never clobbers the forward stack. Promoting a
 * local draft chat to its persisted id also replaces because the draft id stops
 * resolving. Opening or closing the chat panel (chatId null↔id, same file)
 * replaces — it is layout, not navigation.
 */
export function nextWorkspaceHistoryMethod(args: {
  prev: WorkspaceViewKey;
  next: WorkspaceViewKey;
  landingSettled: boolean;
  restoring: boolean;
  promotingDraftChat: boolean;
}): 'push' | 'replace' {
  if (args.restoring || !args.landingSettled) return 'replace';
  if (args.promotingDraftChat) return 'replace';
  if (args.prev.fileId !== args.next.fileId) return 'push';
  if (args.prev.chatId && args.next.chatId && args.prev.chatId !== args.next.chatId) return 'push';
  return 'replace';
}

/**
 * On browser back/forward, what to do with the chat panel given the restored
 * URL's chatId and the panel's current state. Reopen the URL's chat unless it is
 * already the *visible* chat (matching the id alone isn't enough — the panel can
 * be closed while its thread stays selected, so `back` must reopen it); close the
 * panel when the URL carries no chat; otherwise leave it. `urlChatRef` and
 * `currentChatShortRef` are short id-refs (`toShortIdRef`) so they compare directly.
 */
export function resolvePopstateChatAction(args: {
  urlChatRef: string | null;
  currentChatShortRef: string | null;
  isChatVisible: boolean;
}): 'reopen' | 'close' | 'skip' {
  if (args.urlChatRef) {
    const sameChatShown = args.isChatVisible && args.currentChatShortRef === args.urlChatRef;
    return sameChatShown ? 'skip' : 'reopen';
  }
  return args.isChatVisible ? 'close' : 'skip';
}

// Same rule for the file: a file is always preselected (the initial-file
// heuristic runs even in chat-only layouts), so mirroring it unconditionally
// would turn every reload into an editor-intent arrival and defeat the
// chat-first landing. Keep fileId in the URL only while the editor is visible.
export function shouldMirrorFileIdToUrl(activeFileId: string | null, isEditorVisible: boolean): boolean {
  return Boolean(activeFileId) && isEditorVisible;
}

export function shouldCollapseLeftRail(width: number): boolean {
  return Number.isFinite(width) && width < LEFT_RAIL_COLLAPSE_WIDTH;
}

export function clampLeftRailWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY): number {
  const safeWidth = Number.isFinite(width) ? width : DEFAULT_LEFT_RAIL_WIDTH;
  const viewportMax = Number.isFinite(viewportWidth) ? Math.floor(viewportWidth * 0.55) : MAX_LEFT_RAIL_WIDTH;
  const maxWidth = Math.max(MIN_LEFT_RAIL_WIDTH, Math.min(MAX_LEFT_RAIL_WIDTH, viewportMax));
  return Math.round(Math.max(MIN_LEFT_RAIL_WIDTH, Math.min(maxWidth, safeWidth)));
}

export function normalizeWorkspaceLayoutConfig(
  config: Partial<WorkspaceLayoutConfig> | null | undefined,
  fallback: WorkspaceLayoutConfig = {
    openLeftRail: null,
    mode: 'space',
    leftRailWidth: DEFAULT_LEFT_RAIL_WIDTH,
  },
  viewportWidth?: number
): WorkspaceLayoutConfig {
  const mode = isWorkspaceViewMode(config?.mode) ? config.mode : fallback.mode;
  const requestedRail = isLeftRail(config?.openLeftRail) ? config.openLeftRail : fallback.openLeftRail;
  const requestedWidth =
    typeof config?.leftRailWidth === 'number' ? config.leftRailWidth : fallback.leftRailWidth;

  return {
    mode,
    openLeftRail: syncLeftRailWithMode(mode, requestedRail),
    leftRailWidth: clampLeftRailWidth(requestedWidth, viewportWidth),
  };
}
