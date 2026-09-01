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
 * (?fileId=, comment/diff anchors) land on the document, ?chat=1 / ?chatId=
 * force chat open. A plain workspace URL restores the workspace's stored
 * layout — leaving and coming back puts you where you left off (e.g. chat +
 * review while multitasking across workspaces).
 *
 * A first visit (nothing stored, no URL intent) lands on the DOCUMENT
 * (founder decision, 2026-08-10 — this reverses the earlier chat-first
 * arrival). Sundial is an editor: opening on an empty chat box read as a
 * ChatGPT clone and left the file tree looking empty, so every workspace now
 * opens on a file (a new workspace's seeded welcome.md, a returning visit's
 * last file, otherwise the default document). Chat is one click away in the
 * left rail's Chats section. An explicit chat deep link still lands on chat,
 * which is what keeps shared-chat links working.
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
  // stored layout restores as-is. Nothing stored (first visit, or a persisted
  // empty center that is not a layout worth stranding an arrival on) lands on
  // the document — unless the URL explicitly asked for chat, which lands on
  // chat alone exactly as a shared chat link always has.
  let panels = editorIntent
    ? resolveRestoredOpenPanels(args.stored ?? ['editor'], true)
    : args.stored ?? [];
  if (panels.length === 0) return args.chatIntent ? ['chat'] : ['editor'];
  if (args.chatIntent) panels = addPanel(panels, 'chat');
  return panels;
}

/**
 * Whether an arrival that landed chat-sole should be swapped to the document.
 *
 * Since file-first arrival (2026-08-10) a plain URL never lands chat-sole, so
 * `chatArrivalDefault` is now only true for a STORED chat-only layout — which
 * leaves exactly one live case: a read-only visitor whose stored layout is
 * chat-only gets swapped to the document, because chat isn't theirs to drive
 * (the original security semantics). Owners and can-write members keep the
 * layout they saved, and explicit chat deep links always stay on chat.
 *
 * This is the one arrival rule that still resolves ASYNCHRONOUSLY (isOwner /
 * canWrite arrive with the files payload). It is unreachable on the default
 * path; see the precedence list in the file-first rollout notes before making
 * it reachable again.
 */
export function shouldSwapArrivalToDocument(args: {
  isOwner: boolean;
  canWrite: boolean;
  /** The untouched chat-first arrival default is still up. */
  chatArrivalDefault: boolean;
  /** A stored layout existed for this workspace (not a first visit). */
  hadStoredLayout: boolean;
  /** ?chatId= / ?chat=1 (excluding another session's dead draft- ids). */
  explicitChatIntent: boolean;
}): boolean {
  if (args.isOwner || !args.chatArrivalDefault || args.explicitChatIntent) return false;
  return !args.canWrite || !args.hadStoredLayout;
}

/**
 * A chat-sole arrival (an explicit ?chatId= / ?chat=1 link, or a stored
 * chat-only layout), before the chat id resolves: the open-set already says
 * the center belongs to chat, but no chat TAB exists yet. The primary pane must render the chat
 * surface from the FIRST paint — never mount the preselected document and
 * yank it seconds later when the chat tab lands (the arrival flash). Desktop
 * only: mobile renders the chat column directly from the open-set. Any pane
 * tab (a restored snapshot, an explicit open) means the arrival already has
 * real content and the pending window is over — and until the persisted pane
 * snapshot has been restored (`panesRestored`), the pane state can't be
 * trusted as empty, so a stale `['chat']` open-set saved alongside a snapshot
 * with real tabs must not flash the chat surface over the restoring layout.
 */
export function chatFirstArrivalPending(args: {
  openPanels: CenterPanel[];
  isMobile: boolean;
  anyPaneTabs: boolean;
  panesRestored: boolean;
}): boolean {
  if (args.isMobile || args.anyPaneTabs || !args.panesRestored) return false;
  return args.openPanels.length === 1 && args.openPanels[0] === 'chat';
}

/**
 * Per-workspace localStorage key for the layout config. The bare prefix is the
 * pre-split shared key, kept only as a one-time migration source (and as the
 * fallback when no projectId is resolved).
 */
// ---- Embedded panel view (`?view=panel`) ----------------------------------

export const PANEL_VIEW_QUERY_PARAM = 'view';
export const PANEL_VIEW_QUERY_VALUE = 'panel';
const PANEL_VIEW_STORAGE_KEY = 'sundial:panel-view';

/**
 * True when this session runs as an embedded side panel (a ChatGPT / Claude
 * desktop app view, or any host iframe): `?view=panel` on arrival, latched
 * into sessionStorage — mirroring the desktop shell's `sundialDesktop=1`
 * latch — so SPA navigation and the URL view-mirror, which rewrite the query,
 * don't silently drop the mode mid-session. Panel sessions keep the
 * URL-decided single-panel arrival: no stored-layout restore, no layout
 * persistence (an embed must never clobber the user's real-browser layout).
 */
export function latchPanelView(): boolean {
  if (typeof window === 'undefined') return false;
  const inUrl =
    new URLSearchParams(window.location.search).get(PANEL_VIEW_QUERY_PARAM) ===
    PANEL_VIEW_QUERY_VALUE;
  // The latch only persists inside an ACTUAL embed (rendered in an iframe — a
  // ChatGPT / Claude side panel). A normal top-level tab tracks the URL
  // exactly, so a human who clicks a handed-out ?view=panel link and then
  // navigates elsewhere is not stranded in panel mode with no way out (the
  // sticky-sessionStorage bug). Cross-origin frame access throws → treat as
  // embedded, which is correct for a third-party host iframe.
  let embedded: boolean;
  try {
    embedded = window.top !== window.self;
  } catch {
    embedded = true;
  }
  // A narrow window IS a side panel, param or not: humans open fresh tabs
  // inside side-panel browsers themselves (observed live, 2026-08-27), and
  // a desktop layout squeezed into 768-1023px serves nobody. Below 768 the
  // mobile one-surface layout owns the width; the URL param wins anywhere.
  const narrow = window.innerWidth >= 768 && window.innerWidth < 1024;
  try {
    if (inUrl) {
      if (embedded) window.sessionStorage.setItem(PANEL_VIEW_STORAGE_KEY, '1');
      return true;
    }
    if (narrow) return true;
    return embedded && window.sessionStorage.getItem(PANEL_VIEW_STORAGE_KEY) === '1';
  } catch {
    return inUrl || narrow; // storage disabled: the visit still shapes itself
  }
}

/** Per-workspace localStorage key for the editor pane snapshot (tab layout). */
export const EDITOR_PANES_KEY_PREFIX = 'sundial:editor-panes:';

/**
 * The saved pane snapshot, or null when this session must not read it: an
 * embedded panel (?view=panel) keeps the URL-decided single-panel arrival.
 * Restoring the real browser's desktop tab layout (often with an active chat
 * tab) would decide the embed's one visible surface instead of the URL.
 */
export function readPaneSnapshot(projectId: string): string | null {
  if (latchPanelView()) return null;
  try {
    return window.localStorage.getItem(`${EDITOR_PANES_KEY_PREFIX}${projectId}`);
  } catch {
    return null;
  }
}

/**
 * Persist the pane snapshot — except from a panel session, which must never
 * clobber the layout the user's real browser saved for the workspace.
 */
export function persistPaneSnapshot(projectId: string, snapshot: unknown): void {
  if (latchPanelView()) return;
  try {
    window.localStorage.setItem(`${EDITOR_PANES_KEY_PREFIX}${projectId}`, JSON.stringify(snapshot));
  } catch {
    /* quota / private mode */
  }
}

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
// Touch devices (coarse pointer) switch at the Tailwind `md` boundary (767):
// phones and small tablets want the drawer chrome. A mouse/trackpad window that
// merely got narrowed keeps the DESKTOP layout down to 520px, because that
// layout is where the file tree and its drag-and-drop targets live — flipping a
// 700px desktop window to the phone UI silently drops those. Below 520px even a
// single center pane is unusable, so both pointer kinds collapse. The center
// panes relax their min widths under `lg` (max-lg:min-w-*) so the 520-767 range
// renders cramped-but-usable instead of clipping.
export const MOBILE_MAX_WIDTH = 767;
export const MOBILE_FINE_POINTER_MAX_WIDTH = 520;
export const MOBILE_MEDIA_QUERY =
  `(max-width: ${MOBILE_MAX_WIDTH}px) and (any-pointer: coarse), (max-width: ${MOBILE_FINE_POINTER_MAX_WIDTH}px)`;

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
// would turn a deliberate chat-only layout into an editor-intent arrival on
// reload. Keep fileId in the URL only while the editor is visible — on the
// file-first default that means the landing URL does carry the open file,
// which is exactly the deep link a reload should reproduce.
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
