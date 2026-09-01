'use client';

import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, memo, type DragEvent, type MutableRefObject, type ReactNode , type CSSProperties } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SunnyAnimation } from '@/components/sunny-animation';
import { SunnyLottie } from '@/components/sunny-lottie';
import { isLatexSourceFile } from '@/lib/sync/policy';
import { useAuth, useClerk, useUser, SignInButton } from '@/lib/auth/optional-auth';
import {
  CaretDownIcon,
  CaretRightIcon,
  CaretUpIcon,
  ChatTeardropIcon,
  ChatCircleDotsIcon,
  TextAaIcon,
  ChatTextIcon,
  CreditCardIcon,
  CloudIcon,
  DiscordLogoIcon,
  DotsThreeVerticalIcon,
  StackSimpleIcon,
  EyeIcon,
  GlobeHemisphereWestIcon,
  LockSimpleIcon,
  FileTextIcon,
  GearSixIcon,
  SignOutIcon,
  GithubLogoIcon,
  DetectiveIcon,
  KeyIcon,
  KeyboardIcon,
  LightningIcon,
  ListBulletsIcon,
  ListIcon,
  SparkleIcon,
  MegaphoneIcon,
  NotePencilIcon,
  PaintBrushIcon,
  ClockCounterClockwiseIcon,
  SidebarSimpleIcon,
  SunIcon,
  // PlugsConnectedIcon, // Apps (Composio connectors) icon hidden for now
  PlusIcon,
  UsersThreeIcon,
  XIcon,
  CheckCircleIcon,
} from '@phosphor-icons/react';
import { HumanBubble, AgentBubble, IconTooltip, pickColor, getInitials } from '@/components/collab-bubbles';
import { DISCORD_INVITE_URL, FEEDBACK_FORM_URL } from '@/lib/company';
import { brandForAgentId } from '@/lib/workspace/agent-brand';
import { getAssistantBrand } from '@/components/workspace/provider-icons';
import {
  addPanel,
  chatFirstArrivalPending,
  legacyModeToOpenPanels,
  normalizeOpenPanels,
  removePanel,
  resolveArrivalOpenPanels,
  resolveRestoredOpenPanels,
  resolveWorkspaceRestoreTargetForLayout,
  resolveVisibleColumns,
  isWorkspaceRestoreSettled,
  shouldMirrorChatIdToUrl,
  nextWorkspaceHistoryMethod,
  resolvePopstateChatAction,
  shouldMirrorFileIdToUrl,
  shouldSwapArrivalToDocument,
  latchPanelView,
  readPaneSnapshot,
  persistPaneSnapshot,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  workspaceLayoutStorageKey,
  type CenterPanel,
  type WorkspaceViewKey,
  type WorkspaceViewRefs,
} from '@/lib/workspace/layout';
import { pickDefaultDocument } from '@/lib/workspace/default-document';
import { fetchWithDeadline } from '@/lib/workspace/fetch-deadline';
import { ANON_AUTHOR_PREFIX, anonDisplayName, toAnonAuthorId } from '@/lib/auth/anon-identity';
import { createLocalBinaryUpload, createLocalWorkspaceFetch } from '@/lib/local/workspace-api';
import { ApiFetchProvider } from '@/lib/workspace/api-fetch-context';
import { getLaunchParam, resolveSidecarConfig, sidecar as localSidecar, type SidecarConfig } from '@/lib/local/sidecar';
import { workspaceTitleLabel } from '@/lib/local/project-label';
import { desktopCredentialsUsable } from '@/lib/local/desktop-creds';
import { useDesktopCredentials } from '@/lib/local/use-desktop-credentials';
import { useDesktopProfile } from '@/lib/local/use-desktop-profile';
import { useLocalShares } from '@/lib/local/use-local-shares';
import { useLocalFileEventsKey } from '@/lib/local/use-local-file-events-key';
import { excludeSelfPeers, useLocalCollabPresence } from '@/lib/local/use-local-presence';
import { prefetchProvider, useWorkspaceCollabSocket } from '@/lib/workspace/collab-socket-context';
import { deriveShowOffline, useCollabSocketStatus } from '@/lib/workspace/collab-offline';
import { ShareLocalModal, type ShareScope } from '@/components/local/share-local-modal';
import { useClaimAnonOnLogin } from '@/lib/auth/use-claim-anon-on-login';
import { buildReturnPath } from '@/lib/auth/use-require-signin';
import type { Editor } from '@tiptap/react';
import { CollabEditor, type PendingAddition, type RevealPeerRequest } from '@/components/workspace/collab-editor';
import { EditorTabStrip } from '@/components/workspace/editor-tab-strip';
import { preloadMonaco } from '@/components/workspace/code-viewer';
import { PaneDropOverlay, SplitEditorPaneReviewBody, useDocAlignLeft } from '@/components/workspace/split-editor-pane';
import { useDocStyle } from '@/lib/doc-style';
import {
  closeTab as closePaneTab,
  collapseToPrimaryPane,
  createInitialPanes,
  dropTabElsewhere,
  resolveOpenTargetPaneId,
  EDITOR_TAB_MIME,
  flattenPanesForWeb,
  MAX_EDITOR_PANES,
  moveTab as movePaneTab,
  normalizePanes,
  openTab as openPaneTab,
  openToSide as openPaneToSide,
  panesSnapshot,
  PRIMARY_PANE_ID,
  pruneEmptyPanes,
  RAIL_PANE_ID,
  enforceSingleActiveChat,
  openWithChatAside,
  replaceActiveTab,
  isPathWithin,
  remapPanePaths,
  remapPath,
  removePanePaths,
  splitWithTab,
  syncPrimaryActive,
  type DropZone,
  type EditorPane,
  type TabDragPayload,
} from '@/lib/workspace/editor-panes';
import { chatTab, chatIdOfTab, diffTab, diffIdOfTab, isChatTab, isDiffTab, isLauncherTab, isReviewTab, isSpecialTab, reviewTab, reviewChatIdOfTab, LAUNCHER_TAB } from '@/lib/workspace/editor-tabs';
import { parseWikiTarget, resolveWorkspacePath } from '@/lib/markdown/anchors.mjs';
import { scrollEditorToAnchor, type WikiAnchor } from '@/lib/workspace/anchor-navigation';
import type { CodeEditorHandle } from '@/components/workspace/collab-code-editor';
import type { CommandPaletteAction } from '@/components/workspace/command-palette';
import type {
  PdfCommentMarker,
  PdfCommentSelection,
  SyncTexJump,
} from '@/components/workspace/latex-pdf-viewer';
import { matchPdfSelectionToSource } from '@/lib/latex/pdf-comment-anchor';
import type { LatexViewMode } from '@/components/workspace/latex-workbench';
import { PanelSurfaceSwitcher, type PanelNavTarget } from '@/components/workspace/panel-surface-switcher';
import { applyPanelCommand, usePanelControl } from './_components/use-panel-control';
import type { PanelSurface } from '@/lib/workspace/panel-control';
import { LatexCompileControls, LatexToolbarRow, latexEditorRefHandlers, type LatexFixBlocked } from '@/components/workspace/latex-editor-toolbar';
import { useLatexCompile, type LocalEditTracker } from '@/components/workspace/use-latex-compile';
import { useLatexAutoFix, useLatexAutoCompilePref } from '@/components/workspace/use-latex-autofix';
import { useLatexAnalytics } from '@/components/workspace/use-latex-analytics';
import { buildCompileFixPrompt } from '@/lib/latex/fix-prompt';
import { LATEX_FIX_CHAT_KIND, LATEX_FIX_CHAT_TITLE, LATEX_FIX_CHAT_MODEL, ensureLatexFixChat } from '@/lib/latex/fix-chat';
import { parseSyncTex, pathFromRoot, pathRelativeToRoot, type SyncTexIndex } from '@/lib/latex/synctex';
import { latexCompileTarget, useLatexMainDocument } from '@/components/workspace/latex-main-document';
import { buildActionableWorkspacePendingAdditions, buildSuggestionAuthors, defaultAuthorLabel } from '@/lib/workspace/pending-additions';
import { buildAuthorshipRanges } from '@/lib/workspace/authorship-lens';
import { readJsonResponse } from '@/lib/http/read-json-response';
import type { FileBlameResponse } from '@/lib/workspace/api-shared-types';
import { pollFilesUntilSettled as pollFilesUntilSettledLoop } from '@/lib/workspace/poll-files-until-settled';
import { scrollFraction, restoreScrollFraction } from '@/lib/workspace/scroll-fraction';
import { buildSunnyAvatarMap, DEFAULT_SUNNY_AVATAR } from '@/lib/workspace/sunny-avatars';
import {
  chatEditModeStorageKey,
  coerceEditMode,
  DEFAULT_CHAT_EDIT_MODE,
  DOC_EDIT_MODES,
  MARKDOWN_DOC_EDIT_MODES,
  RAW_MARKDOWN_DOC_EDIT_MODES,
  writeStoredEditMode,
  type WorkspaceEditMode,
} from '@/lib/workspace/edit-mode';
import {
  editedFilesForLatestTurn,
  editedPathsFromLatestTurnToolParts,
  resolveEditedPathToWorkspacePath,
} from '@/lib/workspace/turn-edited-files';
import { useFilePendingTurns, type FilePendingTurn } from '@/lib/workspace/use-file-pending-turns';
import { useDocEditsRealtimeKey } from '@/lib/workspace/use-doc-edits-realtime-key';
import { buildPendingEditsInvalidationToken } from '@/lib/workspace/pending-edits-invalidation';
import { useChatTurnEdits } from '@/lib/workspace/use-chat-turn-edits';
import { CreditBalancePill } from '@/components/workspace/credit-balance-pill';
import dynamic from 'next/dynamic';
import { useLinkedRepos } from '@/lib/workspace/use-linked-repos';
import { SchedulesPanel, ChatHeaderScheduleText } from '@/components/workspace/schedules-panel';
import { track } from '@/lib/analytics/track';
import { MarkdownTOC } from '@/components/workspace/markdown-toc';
import type { TocHeading } from '@/lib/markdown/toc';
import { MarkdownEditorFrame, type MarkdownPageChrome } from '@/components/workspace/markdown-editor-frame';
import { EditModeControl } from '@/components/workspace/edit-mode-control';
import { useDocumentEditMode } from '@/lib/workspace/document-edit-mode-context';
import { MarkdownToolbar, ToolbarOverflowItems, toolbarTierFlags, type ToolbarTierFlags } from '@/components/workspace/markdown-toolbar';
import { MarkdownMenuBar } from '@/components/workspace/markdown-menu-bar';
import { DocumentActionsMenu } from '@/components/workspace/document-actions-menu';
import { DocPaneHeader } from '@/components/workspace/doc-pane-header';
import { Spinner } from '@/components/ui/spinner';
import { commentMentionHandle } from '@/lib/workspace/doc-comments';
import { resolveCommentIdentity } from '@/lib/workspace/comment-identity';
import { useWorkspaceUploads } from '@/components/workspace/use-workspace-uploads';
import { uploadImageFromEditor } from '@/lib/workspace/upload-image-from-editor';
import { safeGetEditorText } from '@/lib/workspace/safe-editor-text';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { createBrowserClient } from '@/lib/supabase/browser';
import { useVoiceInput } from '@/lib/hooks/use-voice-input';
import { useAfterFirstPaint } from '@/lib/hooks/use-after-first-paint';
import { MAX_ZIP_ENTRY_COUNT, ensureUniquePath, formatBytes, resolveDraftPath, sanitizeFilename } from '@/lib/workspace/uploads';
import { dropEntriesFrom, readDroppedEntries } from '@/lib/workspace/dropped-entries';
import { type WorkspaceKind } from '@/lib/workspace/kinds';
import { ModalShell } from '@/components/modal-shell';
import { WorkspaceTab, SecretsTab, findRootAgentsFile } from '@/components/workspace/config-tab';
import { PreferencesSection, ShortcutsSection } from '@/components/workspace/preferences-section';
import {
  applyAutocompleteFlagFromUrl,
  isAutocompleteEnabled,
} from '@/lib/workspace/autocomplete/flag';
import { getFlag, hydrateFlags, setFlag } from '@/lib/flags/client';
import {
  DEFAULT_AUTOCOMPLETE_MODE,
  getAutocompleteMode,
  isAutocompleteMode,
  setAutocompleteMode,
  type AutocompleteMode,
} from '@/lib/workspace/autocomplete/mode';
import { flagDefaults, resolveFlags } from '@/lib/flags/registry';
import { AppearanceSection } from '@/components/workspace/appearance-section';
import { getCachedTurnEdits, setTurnEditsCacheWorkspace } from '@/lib/workspace/turn-edits-cache';
import {
  clerkNeverLoads,
  hideTopBarPreferred,
  isDesktopApp as isDesktopShell,
  openExternalOnDesktop,
  setHideTopBarPreferred,
} from '@/lib/desktop';
import { formatShortcut, isMacPlatform } from '@/lib/workspace/shortcuts';
import { computeSessionDurationSeconds } from '@/lib/workspace/agent-runtime';
import {
  buildWorkspacePath,
  buildWorkspaceFilePath,
  buildWorkspaceChatPath,
} from '@/lib/workspace/paths';
import { CopyLinkButton } from '@/components/workspace/copy-link-button';
import { FileShareButton } from '@/components/workspace/file-share-button';
import { EditableChatTitle } from '@/components/workspace/editable-chat-title';
import { findByIdRef, findIndexByIdRef, resolveWorkspaceId, toShortIdRef } from '@/lib/workspace/public-ids';
import {
  useWorkspaceRoute,
  type WorkspaceInitialFilesPayload,
} from '@/lib/workspace/route-context';
import {
  hasTextTransport,
  usesGroupChatPresentation,
} from '@/lib/workspace/chat-transport-summary';
import { resolveTranscriptUserLabel } from '@/lib/workspace/transcript-speaker';
import { chatFolderRelation } from '@/lib/workspace/chat-placement';
import {
  CHAT_HARNESS_LABELS,
  DEFAULT_MODEL_REF,
  getChatModelLabel,
  normalizeChatModelRef,
  parseChatHarness,
  coerceModelForHarness,
  type ChatHarness,
  type ChatRuntimePickerOption,
} from '@/lib/workspace/chat-runtime';
import { engineDetected, stampableHarness } from '@/lib/workspace/default-harness';
import { useChatModels } from '@/lib/workspace/use-models';
import {
  buildChatTranscript,
  conversationMessages,
  type TranscriptMessage,
} from '@/lib/workspace/chat-transcript';
import type { ConnectedAppSummary } from '@/lib/composio/types';
import { useWorkspaceAppConnectionCallback } from './_components/workspace-app-connection';
import {
  useActiveChatForeignUserMessages,
  useFillComposerEvent,
  useCurrentChatEffects,
  useWorkspaceChatStatusRealtime,
  useChatStreamActivity,
  useInitialWorkspaceChatSelection,
  usePersistLastChat,
  useWorkspaceChatListEffects,
  useWorkspaceChatSidebarEffects,
} from './_components/workspace-chat-runtime-effects';
import { backfillTurnRows, useSundialChat } from '@/lib/agent/use-sundial-chat';
import { isHardStreamOpenFailure, isSendStartFailure } from '@/lib/agent/sundial-chat-transport';
import { decideChatAction } from '@/lib/agent/chat-action';
import { useWorkspaceFileLifecycle, type WorkspaceStorageUsage } from './_components/workspace-file-lifecycle';
import {
  useWorkspaceActiveFileEffects,
  useWorkspaceFileEditingEffects,
  useWorkspaceFileInputEffects,
} from './_components/workspace-file-ui-effects';
import { useWorkspaceShare, useWorkspaceAudienceProbe, shareOrigin, isLinkSharedInfo } from './_components/workspace-share';
import { PathShareModal, usePathShares } from './_components/path-share-modal';
import {
  broaderAccessLabel,
  fileShareModalScope,
  fileShareStatus,
  fileShareTarget,
  localSharedScopeMap,
  overlappingPathShares,
} from './_components/file-share-status';
import { PATH_SHARE_TOKEN_PARAM, holdsRootGrantOnly, pathCapability, type PathGrant } from '@/lib/workspace/path-grants';
import { appendPathShareTokenToUrl, currentPathShareToken, withPathShareToken } from '@/lib/workspace/path-share-token-client';
import { usePathShareRealtimeAuthReady } from '@/lib/workspace/use-path-share-realtime-ready';
import { DocColumnControls, DocFileNameControl } from './_components/doc-column-controls';
import { useWorkspaceComments, WorkspaceCommentContextMenu } from './_components/workspace-comments';
import { TopbarShareButton } from './_components/topbar-share-button';
import { LocalAgentModeModal, WorkspaceLocalAgentModal, useWorkspaceLocalAgent } from './_components/workspace-local-agent-modal';
import { useWorkspaceLinkCopy } from './_components/workspace-link-copy';
import { ClaimOwnershipNudge, SidebarIdentity } from './_components/sidebar-identity';
import { ClaimKeyGate } from './_components/claim-key-gate';
import { readAnonCookie } from '@/lib/auth/anon-identity-client';
import { useWorkspaceNotice, WorkspaceNoticeToast } from './_components/workspace-notice';
import { useWorkspaceStartupIntents } from './_components/workspace-startup-intents';
import { useWorkspaceSwitcher, WorkspaceSwitcherMenu } from './_components/workspace-switcher';
import {
  clipText,
  formatCostUsd,
  formatLoopActorPhase,
  formatLoopBudgetValue,
  formatLoopStatusLabel,
  formatSessionDurationSeconds,
  getAssistantStatusDotClass,
  getLoopStatusPillClass,
  getMessageMetadata,
  getParticipantMetadata,
  normalizeChatMessage,
  parseFiniteNumber,
  toChatPreviewText,
  toChatPreviewTextFromMessage,
  DRAFT_CHAT_PREFIX,
  isDraftChatId,
  canManageChat,
  canPinChat,
  type ChatStatus,
  type ChatLoopLatestStep,
  type ChatLoopSummary,
  type ChatMessage,
  type ChatParticipant,
  type ChatContextSnippet,
  type CollaboratorBadge,
  type MessageAttachment,
} from './_components/workspace-chat-model';
import { FilesTabPanel } from './_components/files-tab-panel';
import { ProjectSidebar } from './_components/project-sidebar';
import { SundialSupport } from '@/components/support/sundial-support';
import { ShellNavControls, SidebarTopChrome } from './_components/sidebar-top-chrome';
import { GetSetUpCard } from '@/components/desktop/get-set-up-card';
import { OpenWithModal, OpenWithRow } from '@/components/workspace/open-with-modal';
import { WorkspaceCreationOverlay, WorkspaceRouteLoading } from '@/components/workspace/workspace-route-loading';
import { WELCOME_TEX_INITIAL_COMPILE_ERROR, WELCOME_TEX_PATH } from '@/lib/workspace/welcome-doc';
import {
  clearOnboardingCreationTiming,
  onboardingElapsedMs,
  STARTER_DIAGNOSTIC_BUDGET_MS,
  WORKSPACE_VISIBLE_BUDGET_MS,
} from '@/lib/workspace/onboarding-performance';
import { markOnboardingLandingDone, readOnboardingLandingDone } from '@/lib/workspace/onboarding-tour';
import {
  DEFAULT_SIDEBAR_SECTIONS,
  expandSection,
  isSectionCollapsed,
  normalizeSidebarSections,
  toggleSectionCollapsed,
  type SidebarSection,
  type SidebarSectionState,
} from '@/lib/workspace/sidebar-sections';
import { prefetchRepositories } from '@/lib/github/repos-client';
import {
  computeReorder,
  mergeParentOrder,
  readFileOrder,
  ROOT_ORDER_KEY,
  sameFileOrder,
  sanitizeFileOrder,
  sortByManualOrder,
  writeFileOrder,
  type FileOrderMap,
} from '@/lib/workspace/file-order';
import { AnchoredDropdown, isInFloatingActionMenu } from '@/components/workspace/anchored-dropdown';
import {
  shouldCollapseLatexPdfForChatOpen,
  isAgentTurnJustFinished,
  isAgentTurnJustStarted,
  type LatexChatCollapseState,
} from '@/lib/workspace/latex-layout';
import { buildLatexMarkers, resolveLatexLogPath } from '@/lib/workspace/latex-log-navigation';
import { WorkspaceChatPane } from './_components/workspace-chat-pane';
import { ChatArrivalHero, EmptyChatPrompt } from './_components/chat-arrival-hero';
import { LocalEngineNotice } from './_components/local-engine-notice';
import { DocStatsSpan } from './_components/doc-stats';
import { PaneResizeHandle, ResizeHandle } from './_components/resize-handle';
import {
  useDocumentVisible,
  useChatScrollMemory,
  useDiffDeepLinkPulse,
  useToolbarRowWidth,
  useWorkspaceDropdownDismissal,
  useWorkspacePresence,
  useLocalAgentPresence,
  useAgentEditingChats,
  useWorkspaceRouteIntents,
  useWorkspaceLayoutEffects,
  type SettingsTab,
} from './_components/workspace-hooks';
import {
  formatFileName,
  formatRelativeTime,
  getFileName,
  getFolderPath,
  getSidebarListItemStateClasses,
  isBinaryFile,
  isCodeFile,
  isCsvFile,
  isHtmlFile,
  isImageFile,
  isAgentMetadataPath,
  isJsonFile,
  isMarkdownFile,
  isMetaPath,
  isOfficeFile,
  isPdfFile,
  isTexFile,
  LocalRootGlyph,
  setSidebarDragGhost,
  shouldDefaultRichViewer,
  WorkspaceEntryIcon,
} from './_components/workspace-file-helpers';

// The document-first route should not download every modal, settings surface,
// review tool, and uncommon viewer before a Markdown file can paint. These
// chunks are requested only when their existing render guards become true.
const AddSkillModal = dynamic(
  () => import('@/components/workspace/add-skill-modal').then((module) => module.AddSkillModal),
  { ssr: false },
);
const CollabCodeEditor = dynamic(
  () => import('@/components/workspace/collab-code-editor').then((module) => module.CollabCodeEditor),
  { ssr: false },
);
const CommandPalette = dynamic(
  () => import('@/components/workspace/command-palette').then((module) => module.CommandPalette),
  { ssr: false },
);
const LatexPdfPane = dynamic(
  () => import('@/components/workspace/latex-pdf-pane').then((module) => module.LatexPdfPane),
  { ssr: false },
);
const LatexWorkbench = dynamic(
  () => import('@/components/workspace/latex-workbench').then((module) => module.LatexWorkbench),
  { ssr: false },
);
const SyncTexTipCard = dynamic(
  () => import('@/components/workspace/synctex-tip-card').then((module) => module.SyncTexTipCard),
  { ssr: false },
);
const AutoFixSuggestionCard = dynamic(
  () => import('@/components/workspace/autofix-suggestion-card').then((module) => module.AutoFixSuggestionCard),
  { ssr: false },
);
const BillingSection = dynamic(
  () => import('@/components/workspace/billing-section').then((module) => module.BillingSection),
  { ssr: false },
);
const UserGitHubTab = dynamic(
  () => import('@/components/workspace/user-github-tab').then((module) => module.UserGitHubTab),
  { ssr: false },
);
const UserOverleafTab = dynamic(
  () => import('@/components/workspace/user-overleaf-tab').then((module) => module.UserOverleafTab),
  { ssr: false },
);
const UserApiKeysTab = dynamic(
  () => import('@/components/workspace/user-api-keys-tab').then((module) => module.UserApiKeysTab),
  { ssr: false },
);
const AddRepoModal = dynamic(
  () => import('@/components/workspace/add-repo-modal').then((module) => module.AddRepoModal),
  { ssr: false },
);
const AddOverleafModal = dynamic(
  () => import('@/components/workspace/add-overleaf-modal').then((module) => module.AddOverleafModal),
  { ssr: false },
);
const LinkTextChatModal = dynamic(
  () => import('@/components/workspace/link-text-chat-modal').then((module) => module.LinkTextChatModal),
  { ssr: false },
);
const CloudAgentSignInModal = dynamic(
  () => import('@/components/workspace/cloud-agent-signin-modal').then((module) => module.CloudAgentSignInModal),
  { ssr: false },
);
const CommitsRail = dynamic(
  () => import('@/components/workspace/commits-rail').then((module) => module.CommitsRail),
  { ssr: false },
);
const CommitDiffViewer = dynamic(
  () => import('@/components/workspace/commit-diff-viewer').then((module) => module.CommitDiffViewer),
  { ssr: false },
);
const RawMarkdownEditor = dynamic(
  () => import('@/components/workspace/raw-markdown-editor').then((module) => module.RawMarkdownEditor),
  { ssr: false },
);
const DocCommentsPanel = dynamic(
  () => import('@/components/workspace/doc-comments-panel').then((module) => module.DocCommentsPanel),
  { ssr: false },
);
const ImageViewer = dynamic(
  () => import('@/components/workspace/viewers/image-viewer').then((module) => module.ImageViewer),
  { ssr: false },
);
const CSVViewer = dynamic(
  () => import('@/components/workspace/viewers/csv-viewer').then((module) => module.CSVViewer),
  { ssr: false },
);
const JSONViewer = dynamic(
  () => import('@/components/workspace/viewers/json-viewer').then((module) => module.JSONViewer),
  { ssr: false },
);
const HTMLViewer = dynamic(
  () => import('@/components/workspace/viewers/html-viewer').then((module) => module.HTMLViewer),
  { ssr: false },
);
const ReviewPanel = dynamic(
  () => import('@/components/workspace/review-panel').then((module) => module.ReviewPanel),
  { ssr: false },
);
const DiffReviewPanel = dynamic(
  () => import('@/components/workspace/diff-review-panel').then((module) => module.DiffReviewPanel),
  { ssr: false },
);
const ChatDiffPanel = dynamic(
  () => import('@/components/workspace/chat-diff-panel').then((module) => module.ChatDiffPanel),
  { ssr: false },
);
const TurnDiffPanel = dynamic(
  () => import('@/components/workspace/chat-diff-panel').then((module) => module.TurnDiffPanel),
  { ssr: false },
);
const AuthorshipHoverCard = dynamic(
  () => import('@/components/workspace/authorship-hover-card').then((module) => module.AuthorshipHoverCard),
  { ssr: false },
);
const AppsPanel = dynamic(
  () => import('./_components/apps-panel').then((module) => module.AppsPanel),
  { ssr: false },
);
const WorkspaceShareModal = dynamic(
  () => import('./_components/workspace-share-modal').then((module) => module.WorkspaceShareModal),
  { ssr: false },
);
const HostedConnectorTab = dynamic(
  () => import('@/components/workspace/hosted-connector-tab').then((module) => module.HostedConnectorTab),
  { ssr: false },
);
const DeleteChatDialog = dynamic(
  () => import('./_components/delete-chat-dialog').then((module) => module.DeleteChatDialog),
  { ssr: false },
);
const STREAM_IDLE_TIMEOUT_MS = 800;
const STALE_SESSION_MS = 60_000;
const STARTING_STATUS_GRACE_MS = 20_000;
const INITIAL_CHAT_MESSAGE_LIMIT = 200;
const LAST_FILE_KEY_PREFIX = 'sundial:last-file:';

// A logged-out send opens Clerk sign-in, which reloads the tab on success and
// would drop the in-memory composer draft. Stash it in sessionStorage (survives
// same-tab reloads, auto-clears when the tab closes) keyed by workspace, and
// take it back once on return.
// Snippets render as markdown blockquotes prepended to the message body.
// Sunny sees them as quoted anchor context; the user sees them as tag chips.
// One formatter for both the composer send path and the inline ask.
function formatSnippetBlock(snippets: Array<{ text: string; path: string | null }>): string {
  return snippets
    .map((s) => {
      const header = s.path ? `> _from \`${s.path}\`:_\n` : '';
      const body = s.text.split('\n').map((line) => `> ${line}`).join('\n');
      return `${header}${body}`;
    })
    .join('\n\n');
}

// Shown once per install, the first time a chat actually runs on a local engine.
const LOCAL_ENGINE_NOTICE_KEY = 'sundial:local-engine-notice';
const PENDING_DRAFT_KEY = 'sundial:pending-send-draft';
function stashPendingDraft(projectId: string | null | undefined, text: string) {
  if (typeof window === 'undefined' || !projectId || !text.trim()) return;
  try {
    window.sessionStorage.setItem(PENDING_DRAFT_KEY, JSON.stringify({ projectId, text }));
  } catch {
    /* sessionStorage unavailable (private-mode quota) — draft just won't persist */
  }
}
function takePendingDraft(projectId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { projectId?: string; text?: string };
    if (parsed.projectId !== projectId || typeof parsed.text !== 'string') return null;
    window.sessionStorage.removeItem(PENDING_DRAFT_KEY);
    return parsed.text;
  } catch {
    return null;
  }
}
const DEFAULT_SHOW_META_FILES = false;
/** Eye toggle for agent metadata files (AGENTS.md, skills/, logs/) — visible by default. */
const SHOW_AGENT_META_FILES_KEY = 'sundial:files:show-agent-metadata';
// Max files a single delete may capture for undo — beyond this, undo is skipped.
// Max files a single delete may queue for Cmd+Z restore — beyond this, skip
// (reconstructing thousands of files from history isn't a sane undo).
const UNDO_DELETE_LIMIT = 50;
// One delete's worth of restorable paths: text files (reconstructed from the
// doc_edits ledger) and explicit folder rows (recreated empty, so an
// empty-folder delete is undoable too). `before` is the server tombstone
// timestamp, passed to restore so it rebuilds *this* incarnation, not a later
// same-path one; null for folder-only deletes, which need no boundary.
type DeletedEntry = { folders: string[]; texts: string[]; before: string | null };
const getChatActivityTime = (
  chat: Pick<ChatRow, 'last_message_at' | 'created_at'>
): number =>
  Date.parse(chat.last_message_at ?? '') ||
  Date.parse(chat.created_at ?? '') ||
  0;
const isChatPinned = (chat: Pick<ChatRow, 'pinned_at' | 'is_pinned' | 'pinned'>): boolean => {
  if (typeof chat.is_pinned === 'boolean') return chat.is_pinned;
  if (typeof chat.pinned === 'boolean') return chat.pinned;
  return Boolean(chat.pinned_at);
};

type SendTrigger = 'enter' | 'button';

type ChatKind = 'direct' | 'group';

type ChatRow = {
  id: string;
  chat_kind?: ChatKind | null;
  model?: string | null;
  harness?: string | null;
  /** Local (sidecar) summaries only — engine lock before the transcript loads. */
  message_count?: number;
  pinned_at?: string | null;
  is_pinned?: boolean | null;
  pinned?: boolean | null;
  last_message_at?: string | null;
  archived_at?: string | null;
  preview_text?: string | null;
  unread_count?: number | null;
  is_active?: boolean | null;
  title?: string | null;
  /** One-line agent-written goal summary (generated server-side; optional). */
  goal_summary?: string | null;
  /** Folder the chat was started in ("New chat in this folder"); null = whole workspace. */
  folder_scope?: string | null;
  /** Purpose marker for special chats (e.g. 'latex_fix'); null = ordinary chat. */
  kind?: string | null;
  /** Path whose new comments are fed to this chat ('*' = whole workspace); null = off. */
  comment_watch_path?: string | null;
  /** The watched file's id — authoritative across renames (the path goes stale). */
  comment_watch_file_id?: string | null;
  /** Folders the chat's turns edited files in (doc_edits attribution). */
  touched_folders?: string[] | null;
  transport_types?: string[] | null;
  participants?: ChatParticipant[] | null;
  sunny_number?: number | null;
  created_at?: string | null;
  /** Local projects only: a read-only external agent session (Claude Code /
   *  Codex transcript on disk) surfaced in the chat list. */
  external_session?: ExternalSessionRef | null;
};

type ExternalSessionRef = { agent: string; session_id: string; cwd: string };
const getExternalSession = (chat: Pick<ChatRow, 'external_session'> | null): ExternalSessionRef | null =>
  chat?.external_session ?? null;
const externalAgentLabel = (external: ExternalSessionRef) =>
  CHAT_HARNESS_LABELS[external.agent === 'codex' ? 'openai' : 'claude'];
const externalAgentAuthorId = (external: ExternalSessionRef) => (external.agent === 'codex' ? 'ai:codex' : 'ai:claude-code');

/** Chat-list / header badge for an external agent session: the agent's brand
 *  mark, full size (no framing — a ring made the mark unreadable at 15px). */
function ExternalAgentBadge({ external, className = 'h-[15px] w-[15px]' }: { external: ExternalSessionRef; className?: string }) {
  const brand = brandForAgentId(externalAgentAuthorId(external));
  return brand.logoPath ? (
    <img
      src={brand.logoPath}
      alt=""
      aria-hidden
      className={`${className} flex-shrink-0 object-contain`}
      draggable={false}
    />
  ) : (
    <span
      aria-hidden
      className={`flex ${className} flex-shrink-0 items-center justify-center rounded-[4px] text-[9px] font-semibold`}
      style={{ color: brand.color }}
    >
      {brand.label}
    </span>
  );
}

type ChatThread = {
  chat: ChatRow;
};

type ChatSessionMetrics = {
  lastMessageAt: string | null;
  totalCostUsd: number | null;
  totalRuntimeSeconds: number;
};

type UserTeam = {
  id: string;
  name: string;
  slug: string;
  icon_emoji: string | null;
};

type DraftEntry = {
  id: string;
  type: 'text' | 'folder';
  parentPath: string | null;
  name: string;
};


function paneSquashStyle(zone: DropZone | undefined): CSSProperties | undefined {
  if (zone === 'right') return { marginRight: '50%' };
  if (zone === 'left') return { marginLeft: '50%' };
  return undefined;
}

type RenameEntry = {
  path: string;
  name: string;
  source: 'list' | 'header' | 'tab';
  /** Stable file ID so header rename stays visible across path changes */
  fileId?: string;
  /** Tab renames only: the same path can be open in several panes, so the
   *  rename input must render in exactly the pane that was double-clicked. */
  paneId?: string;
};


type ChatSurface = { type: 'direct'; chatId: string | null };

type WorkspaceViewMode = 'chat' | 'space';
// Workspace-v4 §4: one unified project sidebar column (Files + Chats + Sync),
// not the old mutually-exclusive files/chats/commits rails.
type LeftRail = 'project' | null;

type WorkspaceLayoutConfig = {
  openLeftRail: LeftRail;
  /** Ordered set of open center panels (Phase 2). */
  openPanels: CenterPanel[];
  // Accordion sidebar: which sections are showing + each one's collapse state.
  sidebarSections?: SidebarSectionState[];
  /** Legacy: pre-Phase-2 layouts stored a single mode; migrated on read. */
  mode?: WorkspaceViewMode;
};

const LEFT_RAIL_WIDTH = 260;
const LEFT_RAIL_MIN_WIDTH = 200;
const LEFT_RAIL_MAX_WIDTH = 480;
// Review docks fixed-width to the left of the editor when both are open, with a
// draggable divider between them (mirrors the chat column's right dock).
const REVIEW_PANEL_DEFAULT_WIDTH = 480;
const REVIEW_PANEL_MIN_WIDTH = 320;
const LEFT_RAIL_WIDTH_STORAGE_KEY = 'sundial:left-rail-width';
const REVIEW_PANEL_WIDTH_STORAGE_KEY = 'sundial:review-panel-width';
/** Width share a chat opened FROM a comment thread takes of the pane row — the
 *  document keeps the rest. The even split every other open gets crushed the
 *  doc (founder); the pane resize handle's own floor is 0.2, so this sits
 *  comfortably above the narrowest width the layout supports. */
const NARROW_CHAT_PANE_SHARE = 0.3;

// Top-bar center-panel switcher: one pill of three independent toggles. Any
// combination of Editor, Review, and Chat can be open at once.

function WorkspaceChangesIcon() {
  return <ListIcon className="ws-icon" weight="regular" aria-hidden />;
}
function WorkspaceInstructionsIcon() {
  return <FileTextIcon className="ws-icon" weight="regular" aria-hidden />;
}
function WorkspaceSecretsIcon() {
  return <DetectiveIcon className="ws-icon" weight="regular" aria-hidden />;
}
// Apps (Composio connectors) hidden from the UI for now — re-enable later.
// function WorkspaceAppsIcon() {
//   return <PlugsConnectedIcon className="ws-icon" weight="regular" aria-hidden />;
// }
function WorkspaceContextIcon() {
  return <GearSixIcon className="ws-icon" weight="regular" aria-hidden />;
}
function WorkspacePreferencesIcon() {
  return <GearSixIcon className="ws-icon" weight="regular" aria-hidden />;
}
function WorkspaceAppearanceIcon() {
  return <PaintBrushIcon className="ws-icon" weight="regular" aria-hidden />;
}
function downloadBlob(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function formatFileTitle(path: string) {
  const parts = path.split('/');
  if (parts.length <= 1) return formatFileName(parts[0]);
  return (
    <span className="inline-flex items-center gap-3">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-3">
          {i > 0 && <CaretRightIcon className="w-3 h-3 text-stone-400" weight="bold" aria-hidden />}
          <span>{formatFileName(p)}</span>
        </span>
      ))}
    </span>
  );
}

function formatCountLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinPreviewNames(names: string[], fallback: string) {
  if (names.length === 0) return fallback;
  if (names.length === 1) return names[0] ?? fallback;
  if (names.length === 2) return `${names[0]} + ${names[1]}`;
  return `${names[0]} +${names.length - 1}`;
}

function getChatKind(chat?: Pick<ChatRow, 'chat_kind'> | null): ChatKind {
  return chat?.chat_kind === 'group' ? 'group' : 'direct';
}

function getDirectChatAssistantId(
  _chat?: Pick<ChatRow, 'chat_kind'> | null
) {
  // v3: assistants surface removed; no per-chat assistant binding.
  return null;
}

function getChatParticipants(chat?: Pick<ChatRow, 'participants'> | null): ChatParticipant[] {
  return Array.isArray(chat?.participants)
    ? chat.participants.filter((participant): participant is ChatParticipant => Boolean(participant))
    : [];
}

function buildGroupChatDisplayName(
  chat: Pick<ChatRow, 'title'>,
  _ignored?: unknown
) {
  return chat.title?.trim() || 'Group chat';
}

function TransportBadge({ label }: { label: string }) {
  const isTextTransport = label === 'text';
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-sky-700"
      title={isTextTransport ? 'iMessage / RCS' : label}
    >
      {isTextTransport ? <ChatTeardropIcon className="h-3 w-3" weight="fill" aria-hidden /> : null}
      <span className={isTextTransport ? 'normal-case' : undefined}>{label}</span>
    </span>
  );
}

function formatRelativeTimeShort(value?: string | null) {
  if (!value) return 'new';
  const date = new Date(value);
  const timestamp = date.getTime();
  if (Number.isNaN(timestamp)) return 'new';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());
  if (timestamp >= startOfWeek.getTime()) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);
  }
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}


function formatAbsoluteDateTime(value?: string | null) {
  if (!value) return 'Not available yet';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'Not available yet';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

function findShareableWorkspaceFile(files: WorkspaceFileRow[], fileId: string | null) {
  const file = findByIdRef(files, fileId, (item) => item.id);
  return file && file.type !== 'folder' && file.type !== 'proposal' ? file : null;
}

function findShareableWorkspaceFileByPath(files: WorkspaceFileRow[], filePath: string | null) {
  if (!filePath) return null;
  return files.find((file) => file.path === filePath && file.type !== 'folder' && file.type !== 'proposal') ?? null;
}

export default function WorkspacePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectSlug = typeof params.slug === 'string' ? params.slug : Array.isArray(params.slug) ? params.slug[0] : '';
  const workspaceRouteContext = useWorkspaceRoute();
  // Anon ?pshare= links land on a public_id slug the layout can't resolve
  // server-side (it can't read the token). The files payload returns the real
  // UUID once the token authorizes; adopt it so realtime subscriptions
  // (files.project_id=eq.…) and API calls match UUID-keyed rows.
  const [resolvedProjectId, setResolvedProjectId] = useState<string | null>(null);
  // The server-resolved id wins: the route context carries the raw slug when
  // the layout couldn't resolve it (it never sees the token).
  const projectId = resolvedProjectId ?? workspaceRouteContext?.projectId ?? resolveWorkspaceId(projectSlug);
  const initialFilesPayload = workspaceRouteContext?.initialFiles ?? null;
  const reportedServerTimingRef = useRef(false);
  useEffect(() => {
    const spans = workspaceRouteContext?.initialServerTiming;
    if (reportedServerTimingRef.current || !spans?.length) return;
    reportedServerTimingRef.current = true;
    track('workspace_open_server_performance', {
      projectId,
      spans: Object.fromEntries(spans.map(({ name, durationMs }) => [name, Math.round(durationMs)])),
    });
  }, [projectId, workspaceRouteContext?.initialServerTiming]);
  // Local (desktop sidecar) mode: same page, swapped data plane. `apiFetch`
  // emulates /api/workspace/* against the sidecar; cloud-only features gate
  // on `isLocalWorkspace` below.
  const localConfig: SidecarConfig | null = workspaceRouteContext?.local?.config ?? null;
  const isLocalWorkspace = Boolean(localConfig);
  // Cloud-only hooks take this instead of ad-hoc falsy sentinels: null/empty
  // disables each hook via its own !projectId guard, and the name says why.
  const cloudProjectId = isLocalWorkspace ? null : projectId;
  const apiFetch = useMemo<typeof fetch>(
    () =>
      localConfig && projectId
        ? createLocalWorkspaceFetch(localConfig, projectId)
        : // Cloud: forward the sticky ?pshare= link token — an anonymous
          // path-share guest's only credential — on every workspace call.
          withPathShareToken((input, init) => fetch(input, init)),
    [localConfig, projectId],
  );
  // Local mode serves attachment previews/links from the sidecar, not the
  // cloud preview proxy (which knows nothing about sidecar project ids).
  const localAttachmentHref = useMemo(
    () =>
      localConfig && projectId
        ? (attachment: MessageAttachment) =>
            attachment.path ? localSidecar.fileUrl(localConfig, projectId, attachment.path) : null
        : undefined,
    [localConfig, projectId],
  );
  // Local engines (the user's own Claude Code / Codex installs) + the engine
  // new chats run on. There is no upfront chooser: the sidecar resolves the
  // default from detection (Claude Code, then Codex, else Sunny) unless the
  // user made an explicit pick. Optimistic until the probe answers: engines
  // assumed detected (a wrong guess only mislabels a hint — the run surfaces
  // the real error), defaultHarness undefined = probe in flight.
  const [localEngines, setLocalEngines] = useState<{
    claude: { available: boolean; loggedIn: boolean };
    codex: { available: boolean; loggedIn: boolean };
    defaultHarness: ChatHarness | undefined;
  }>({
    claude: { available: true, loggedIn: true },
    codex: { available: true, loggedIn: true },
    defaultHarness: undefined,
  });
  // Mirror the sidecar's own adoption (adoptDefaultHarness): drafts and empty
  // rows follow the install default, so the chip is truthful before the first
  // message and the send gate reads the engine the run will actually use.
  const adoptDefaultHarnessLocally = useCallback((harness: ChatHarness | null) => {
    if (!harness) return; // implicit cloud fallback: rows stay unstamped
    setChatThreads((prev) =>
      prev.map((thread) =>
        thread.chat.harness == null &&
        (isDraftChatId(thread.chat.id) || (thread.chat.message_count ?? 0) === 0)
          ? {
              ...thread,
              chat: {
                ...thread.chat,
                harness,
                model: thread.chat.model ? coerceModelForHarness(harness, thread.chat.model) : thread.chat.model,
              },
            }
          : thread,
      ),
    );
  }, []);
  useEffect(() => {
    if (!localConfig) return;
    let cancelled = false;
    localSidecar
      .localEngines(localConfig)
      .then(({ claude, codex, defaultHarness }) => {
        if (cancelled) return;
        const harness = parseChatHarness(defaultHarness);
        setLocalEngines({ claude, codex, defaultHarness: harness });
        // The implicit cloud fallback is deliberately NOT stamped: a row (or a
        // draft that promotes into one) carrying 'vercel' could never follow a
        // CLI installed later. Unstamped already reads as the Agent.
        adoptDefaultHarnessLocally(stampableHarness(harness));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [adoptDefaultHarnessLocally, localConfig]);
  const localEnginesRef = useRef(localEngines);
  localEnginesRef.current = localEngines;
  // First-use explanation for a local engine: one inline line, once per
  // install (the chip carries the standing answer after that).
  const [localEngineNotice, setLocalEngineNotice] = useState<ChatHarness | null>(null);
  const noteLocalEngineUse = useCallback((harness: ChatHarness) => {
    // Only once the engine is actually usable: a missing or logged-out CLI
    // fails the turn, and burning the once-ever key there would mean the run
    // that DOES work never gets its explanation.
    const engines = localEnginesRef.current;
    if (!engineDetected(harness === 'claude' ? engines.claude : engines.codex)) return;
    try {
      if (localStorage.getItem(LOCAL_ENGINE_NOTICE_KEY)) return;
      localStorage.setItem(LOCAL_ENGINE_NOTICE_KEY, '1');
    } catch {
      return; // no storage → never nag, rather than nag on every send
    }
    setLocalEngineNotice(harness);
  }, []);
  const dismissLocalEngineNotice = useCallback(() => setLocalEngineNotice(null), []);
  // Local presence: awareness peers on the sidecar socket (cloud presence is
  // a Supabase channel local projects don't have). Inert when cloud.
  const workspaceCollabSocket = useWorkspaceCollabSocket(projectId ?? undefined);
  const localCollabPeers = useLocalCollabPresence(workspaceCollabSocket, isLocalWorkspace);
  // Local projects: the Offline chip reads the sidecar socket itself — the
  // per-editor status below never updates when a chat tab holds the primary
  // pane (no editor mounted), which stranded it on 'connecting' → "Offline"
  // in a perfectly healthy workspace. Idle (null) when cloud.
  const localSocketStatus = useCollabSocketStatus(isLocalWorkspace ? workspaceCollabSocket : null);
  // Every url this page (and the hooks it feeds) builds for itself runs
  // through buildWorkspacePath, so `local` is what keeps a sidecar project id
  // off the cloud `/w/` route — as a return path it came back to "Workspace
  // not found", and as a copied link it named a workspace nobody can open.
  const workspaceRouteId = useMemo(
    () =>
      isLocalWorkspace
        ? { id: projectId, local: true }
        : workspaceRouteContext?.publicId
          ? { id: projectId, public_id: workspaceRouteContext.publicId }
          : projectId,
    [isLocalWorkspace, projectId, workspaceRouteContext?.publicId]
  );
  const selectedTeamId = searchParams.get('team')?.trim() || null;
  const deepLinkedFileId = searchParams.get('fileId')?.trim() || null;
  const deepLinkedFilePath = searchParams.get('filePath')?.trim() || null;
  const onboardingTexIntent = searchParams.get('onboarding') === 'tex';
  const onboardingPerfReportedRef = useRef<string | null>(null);
  const onboardingGuideReportedRef = useRef<string | null>(null);
  const [showOnboardingTexGuide, setShowOnboardingTexGuide] = useState(false);
  const deepLinkedChatId = searchParams.get('chatId')?.trim() || null;
  // Open the chat panel on load: a deep-linked chat (chatId only lands in the
  // URL while chat is open or via a shared chat link, so either way it must be
  // visible — arrival otherwise restores a stored layout that may lack chat),
  // or the explicit `chat=1` onboarding deep-link.
  const deepLinkChatIntent = Boolean(deepLinkedChatId) || searchParams.get('chat') === '1';
  const freshTemplateChatIntent = Boolean(
    searchParams.get('fresh') && workspaceRouteContext?.initialFiles?.templateSlug,
  );
  const urlMirrorReadyRef = useRef(false);
  // SPA back-nav: the last view mirrored into the URL, whether the non-empty
  // landing view has settled (so its URL replaces rather than pushes — the
  // default-file open on a fresh workspace is landing, not a back step), and
  // whether a back/forward restoration is in flight (forces replace, never push).
  const lastMirroredViewKeyRef = useRef<WorkspaceViewKey>({ fileId: null, chatId: null });
  const landingViewSettledRef = useRef(false);
  const restoringViewFromPopstateRef = useRef(false);
  const restoringViewTargetRef = useRef<WorkspaceViewRefs | null>(null);
  const deepLinkedCommentThreadId = searchParams.get('commentThreadId')?.trim() || null;
  const deepLinkedDiffId = searchParams.get('diff')?.trim() || null;
  const deepLinkedTurnId = searchParams.get('turnId')?.trim() || null;
  const callbackConnectedAccountId =
    searchParams.get('connected_account_id')?.trim() ||
    searchParams.get('connectedAccountId')?.trim() ||
    searchParams.get('id')?.trim() ||
    null;
  const callbackStatus = searchParams.get('status')?.trim().toLowerCase() || null;
  const lastFileStorageKey = projectId ? `${LAST_FILE_KEY_PREFIX}${projectId}` : '';
  const router = useRouter();
  const { user, isLoaded: isAuthLoaded } = useUser();
  const { openSignIn, signOut: clerkSignOut } = useClerk();
  const [hasMounted, setHasMounted] = useState(false);
  const backgroundDataReady = useAfterFirstPaint(hasMounted, projectId);
  // True only inside the macOS Tauri desktop wrapper, which uses an overlay
  // title bar — the traffic-light buttons float over our top bar, so the left
  // controls need to clear them. Defaults false; web/SSR is untouched.
  const [isDesktopApp, setIsDesktopApp] = useState(false);
  // Tabs/splits are DESKTOP-SHELL chrome (any OS): the browser already has its
  // own tab row, so the web shell renders no strips — fixed doc-left /
  // chat-right, clicks replace what's displayed (founder call). Distinct from
  // isDesktopApp, which gates macOS traffic-light padding + drag regions.
  const [desktopTabs, setDesktopTabs] = useState(false);
  // The desktop shell regardless of the top-bar preference — gates the
  // Settings → Appearance Tabs/No tabs choice (the web build has no choice:
  // it only ever runs bar-less).
  const [inDesktopShell, setInDesktopShell] = useState(false);
  useEffect(() => {
    // Desktop shell detected via the launch-URL flag (see lib/desktop.ts);
    // Tauri exposes neither its globals nor a custom UA on the remote origin.
    if (!isDesktopShell()) return;
    setInDesktopShell(true);
    // The "No tabs" preference puts the shell on the web's bar-less
    // no-tabs layout — every desktopTabs branch downgrades with it.
    setDesktopTabs(!hideTopBarPreferred());
    // macOS traffic-light chrome (72px pad + drag regions) only in the REAL
    // shell: Tauri's webview is WKWebView, whose UA carries no "Chrome/"
    // token. A Chrome tab testing with ?sundialDesktop=1 has no traffic
    // lights to clear — the pad just shoved Home/Sidebar toward the middle.
    if (navigator.userAgent.includes('Macintosh') && !navigator.userAgent.includes('Chrome')) {
      setIsDesktopApp(true);
    }
  }, []);
  // ⌘ vs Ctrl for shortcut hints. Defaults Mac and corrects after mount so
  // SSR markup stays stable (same pattern as the theme preference).
  const macShortcuts = hasMounted ? isMacPlatform() : true;
  // Stable per-browser anonymous id used for cursor name/color. The cookie
  // is the source of truth — minted server-side on the first
  // /api/workspace/host call so the Hocuspocus token always carries a uid.
  // Here we just read it back, polling briefly because the host fetch fires
  // from a parent context provider and may not have completed on first paint.
  const [anonId, setAnonId] = useState<string | null>(null);
  useEffect(() => {
    if (user) return; // logged-in visitors don't need an anon id
    let cancelled = false;
    void import('@/lib/auth/anon-identity-client').then(
      ({ readAnonCookie, ensureAnonCookie }) => {
        const tryRead = (attempt: number) => {
          if (cancelled) return;
          const existing = readAnonCookie();
          if (existing) {
            setAnonId(existing);
            return;
          }
          if (attempt >= 5) {
            // Final fallback: mint client-side so cursors aren't generic.
            const minted = ensureAnonCookie();
            if (minted) setAnonId(minted);
            return;
          }
          window.setTimeout(() => tryRead(attempt + 1), 200);
        };
        tryRead(0);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [user]);
  // Claim-on-login refetches access as soon as the transfer lands, so an
  // access wall / stale rights clear without a manual reload (the 15s files
  // poll is only the fallback). reloadFiles is defined later — go via ref.
  useClaimAnonOnLogin(Boolean(user?.id) && !workspaceRouteContext?.local, () => {
    void reloadFilesRef.current?.(false);
  });
  // For ownership comparisons in the transcript: signed-in users compare by
  // Clerk id; anon users compare by their `anon:<rawId>` identity, which is
  // what /api/workspace/messages stamps into metadata.author_user_id.
  const effectiveCurrentUserId = useMemo(
    () => user?.id ?? (anonId ? toAnonAuthorId(anonId) : null),
    [user?.id, anonId],
  );
  const [isMobile, setIsMobile] = useState(false);
  // 'files' is the unified side panel (files + chats stacked).
  type MobilePanel = 'files' | null;
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  // Below Tailwind's `lg` (1024px) the center-panel switcher drops its text
  // labels (`hidden lg:inline`), leaving three mute icon buttons. Track that
  // range so those buttons can surface the tab name as a hover tooltip only
  // when the visible label is gone — no redundant tooltip at wide widths.
  const [tabLabelsCollapsed, setTabLabelsCollapsed] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const update = () => setTabLabelsCollapsed(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // UI state
  // The unified project sidebar is collapsed by default on first visit;
  // `applyStoredDesktopLayout` overrides this from localStorage.
  const [openLeftRail, setOpenLeftRail] = useState<LeftRail>(null);
  // The sidebar is one stacked column (Files, then Chats, then Sync when a
  // repo is linked); `sidebarSections` holds each section's collapse state and
  // also gates the commit diff viewer (meaningful only while Sync is expanded).
  const [sidebarSections, setSidebarSections] = useState<SidebarSectionState[]>(() => [
    ...DEFAULT_SIDEBAR_SECTIONS,
  ]);
  const toggleSidebarSectionCollapsed = useCallback(
    (section: SidebarSection) => setSidebarSections((prev) => toggleSectionCollapsed(prev, section)),
    [],
  );
  const toggleLeftRail = useCallback(
    (rail: Exclude<LeftRail, null>) => setOpenLeftRail((cur) => (cur === rail ? null : rail)),
    [],
  );
  // Expand the Sync section (used by the add-modals' "Open Sync panel"
  // shortcut), opening the rail if it was collapsed.
  const openSyncSection = useCallback(() => {
    setSidebarSections((prev) => expandSection(prev, 'sync'));
    setOpenLeftRail('project');
  }, []);
  const [leftRailWidth, setLeftRailWidth] = useState<number>(LEFT_RAIL_WIDTH);
  const [reviewPanelWidth, setReviewPanelWidth] = useState<number>(REVIEW_PANEL_DEFAULT_WIDTH);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const lr = parseInt(window.localStorage.getItem(LEFT_RAIL_WIDTH_STORAGE_KEY) ?? '', 10);
      if (Number.isFinite(lr)) {
        setLeftRailWidth(Math.min(Math.max(lr, LEFT_RAIL_MIN_WIDTH), LEFT_RAIL_MAX_WIDTH));
      }
      const rv = parseInt(window.localStorage.getItem(REVIEW_PANEL_WIDTH_STORAGE_KEY) ?? '', 10);
      if (Number.isFinite(rv)) {
        setReviewPanelWidth(Math.max(rv, REVIEW_PANEL_MIN_WIDTH));
      }
      // The chat-open intent (shared file+chat, ?chat=1, fresh template) now
      // folds into the center open-set restore in applyStored/FreshDesktopLayout.
      window.localStorage.removeItem('sundial:space-chat-panel-collapsed');
      window.localStorage.removeItem('sundial:space-chat-panel-open');
    } catch {}
  }, []);
  const handleLeftRailCommit = useCallback((width: number) => {
    setLeftRailWidth(width);
    try {
      window.localStorage.setItem(LEFT_RAIL_WIDTH_STORAGE_KEY, String(width));
    } catch {}
  }, []);
  const handleReviewPanelCommit = useCallback((width: number) => {
    setReviewPanelWidth(width);
    try {
      window.localStorage.setItem(REVIEW_PANEL_WIDTH_STORAGE_KEY, String(width));
    } catch {}
  }, []);
  const getReviewPanelMax = useCallback(
    () => Math.max(window.innerWidth - 500, REVIEW_PANEL_MIN_WIDTH + 200),
    [],
  );
  // Workspace-v4 Phase 2 — the center is an ordered set of open panels. This is
  // the single source of truth; `mode` (chat|space) below is derived for the
  // mobile single-panel layout and the chat-visibility effects. See
  // lib/workspace/layout.ts for the pure open-set transitions.
  // The initial open-set is the ARRIVAL decision, taken from the URL alone
  // (same on server and client, so hydration is consistent): a plain workspace
  // URL lands on the DOCUMENT on every form factor, editor-intent URLs land on
  // the document too, and only an explicit chat link lands on chat. The desktop
  // hydration effect re-applies this with the STORED layout folded in
  // (applyStoredDesktopLayout {arrival:true}); mobile keeps this URL-only
  // decision. Because the no-stored-layout answer is now the SAME on both
  // passes (['editor']), the common arrival no longer changes its mind after
  // hydration — the file-first landing is decided before first paint.
  const [openPanels, setOpenPanels] = useState<CenterPanel[]>(() =>
    // A fresh template pick shows its seeded document beside chat (matches
    // applyFreshDesktopLayout; on mobile the editor wins the single panel).
    freshTemplateChatIntent
      ? ['editor', 'chat']
      : resolveArrivalOpenPanels({
          stored: null,
          hasDeepLinkedFile: Boolean(deepLinkedFileId || deepLinkedFilePath),
          hasEditorAnchor: Boolean(deepLinkedCommentThreadId || deepLinkedDiffId),
          chatIntent: deepLinkChatIntent,
        }),
  );
  // True while the center shows chat alone on arrival. Since file-first
  // arrival that means an explicit chat link or a stored chat-only layout, so
  // the only thing still keyed off it is the read-only visitor swap below.
  const arrivalChatDefaultRef = useRef(openPanels.length === 1 && openPanels[0] === 'chat');
  /** The initial-file heuristic's pick on a chat-sole arrival (explicit chat
   *  link / stored chat-only layout): composer context, NOT an open intent —
   *  the pane mirror must skip it once, or the document paints for a frame
   *  before the arrival chat claims the pane. Never set on the file-first
   *  default, where the pick IS the landing surface. */
  const arrivalPreselectRef = useRef<string | null>(null);
  /** True only when the non-owner swap below replaced the plain chat-first
   *  arrival with the document — the one case the legacy chat-reveal must
   *  not undo. Explicit chat links / restored layouts keep their reveal. */
  const arrivalSwappedToDocRef = useRef(false);
  /** Whether the arrival found a stored layout for this workspace (set where
   *  the stored-layout restore decides it) — a first visit is the absence. */
  const arrivalHadStoredLayoutRef = useRef(false);
  const [showRawView, setShowRawView] = useState(false);
  // Raw ↔ rendered swap: the two views have different total heights inside the
  // shared `doc-editor-body` scroll container, so a naive toggle clamps scrollTop
  // to 0 (jumps to the top). Capture the scroll *fraction* at click time (see the
  // toggle button) and re-assert it after the swap so the reading position is
  // preserved — restoreScrollFraction re-applies across frames because the
  // rendered view's ProseMirror content expands asynchronously after un-hiding.
  const docEditorBodyRef = useRef<HTMLDivElement>(null);
  const docScrollFractionRef = useRef(0);
  // Restore only after a genuine raw⟷rendered toggle (flag set in the toolbar
  // button's onClick). `showRawView` also flips for other reasons — opening a
  // non-Markdown file calls setShowRawView(false) — and those paths must NOT
  // re-apply the stale Markdown fraction to the newly opened file, so we gate on
  // this explicit flag rather than the showRawView value alone. Starting false
  // also skips the mount run (no frame-spin / fighting an initial deep-link).
  const pendingRestoreRef = useRef(false);
  useLayoutEffect(() => {
    if (!pendingRestoreRef.current) return;
    pendingRestoreRef.current = false;
    const el = docEditorBodyRef.current;
    if (el) return restoreScrollFraction(el, docScrollFractionRef.current);
  }, [showRawView]);
  // URL escape hatch for ghost-text autocomplete: `?autocomplete=on|off`
  // flips the flag once at page load, before any editor mounts — for this
  // load only, never persisted. The Settings → Advanced switch is the only
  // thing that saves; the value is remembered here so the account hydration
  // below skips (not clobbers) the overridden key.
  useEffect(() => {
    urlAutocompleteOverrideRef.current = applyAutocompleteFlagFromUrl();
  }, []);
  // Obsidian-style inline title: render the file name as the document's H1
  // above the content (display only — never written into the markdown).
  // Toggled from the ⋯ menu; persists per browser.
  const [showDocTitle, setShowDocTitle] = useState(false);
  useEffect(() => {
    try {
      setShowDocTitle(window.localStorage.getItem('sundial:show-doc-title') === '1');
    } catch {
      /* localStorage unavailable — keep the default */
    }
  }, []);
  const toggleDocTitle = useCallback(() => {
    setShowDocTitle((prev) => {
      try {
        window.localStorage.setItem('sundial:show-doc-title', prev ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !prev;
    });
  }, []);
  // The formatting toolbar is OFF by default in the IDE style (founder,
  // 2026-08-13, reversing the one-day-old open default). An explicit open via
  // Aa writes '1' and sticks per browser. The Google Docs style doesn't
  // consult this at all — its toolbar can NEVER close (docsPage || … at every
  // gate), exactly like Google Docs itself.
  const [showFormatToolbar, setShowFormatToolbar] = useState(false);
  useEffect(() => {
    try {
      setShowFormatToolbar(window.localStorage.getItem('sundial:show-format-toolbar') === '1');
    } catch {
      /* localStorage unavailable — keep the default */
    }
  }, []);
  const toggleFormatToolbar = useCallback(() => {
    setShowFormatToolbar((prev) => {
      try {
        window.localStorage.setItem('sundial:show-format-toolbar', prev ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !prev;
    });
  }, []);
  // Mobile file view keeps a single chrome row: the formatting toolbar stays
  // collapsed until the merged top bar's caret expands it.
  const [mobileToolbarExpanded, setMobileToolbarExpanded] = useState(false);
  // External-toolbar-driven editor settings (main workspace view)
  const [editorZoom, setEditorZoom] = useState(100);
  const [editorLineHeight, setEditorLineHeight] = useState(1.5);
  const { toolbarRowWidth, toolbarRowCallbackRef } = useToolbarRowWidth();
  const [collabStatus, setCollabStatus] = useState<'local' | 'connecting' | 'connected' | 'disconnected'>('connecting');
  const [connectingGraceElapsed, setConnectingGraceElapsed] = useState(false);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  // Mirror for callbacks that must read the current threads without taking
  // them as a dep (e.g. promotion retries recovering a draft's folder scope).
  const chatThreadsRef = useRef<ChatThread[]>(chatThreads);
  chatThreadsRef.current = chatThreads;
  // Rail folder-focus (mirrored up from FilesTabPanel): the chat list scopes
  // to chats that live in — or touched files under — the focused folder.
  const [focusedSidebarFolder, setFocusedSidebarFolder] = useState<string | null>(null);
  // Doc-header breadcrumb → sidebar: clicking a folder crumb opens the rail
  // scoped to that folder (nonce re-fires a repeat click on the same crumb).
  const [sidebarFolderFocusIntent, setSidebarFolderFocusIntent] = useState<{
    path: string;
    nonce: number;
  } | null>(null);
  const [selectedChatIndex, setSelectedChatIndex] = useState(0);
  const [selectedChatSurface, setSelectedChatSurface] = useState<ChatSurface>({ type: 'direct', chatId: null });
  const [connectedApps, setConnectedApps] = useState<ConnectedAppSummary[]>([]);
  const [connectedAppsLoading, setConnectedAppsLoading] = useState(false);
  const [connectedAppsLoaded, setConnectedAppsLoaded] = useState(false);
  const [preferredChatModel, setPreferredChatModel] = useState<string>(DEFAULT_MODEL_REF);
  // The user's saved default model (single source of truth, loaded once at
  // startup). null = not loaded yet. Seeds `preferredChatModel` for new chats
  // and backs the Settings → Models picker.
  const [savedDefaultModel, setSavedDefaultModel] = useState<string | null>(null);
  // The autocomplete override from the same /api/user/preferences payload:
  // `undefined` while it loads, `null` for "no override, use the server
  // default". Owned here, like the default model, so the Settings panel never
  // issues a second GET of a document this component already holds.
  const [savedAutocompleteModel, setSavedAutocompleteModel] = useState<string | null | undefined>(
    undefined,
  );
  // The account-backed flags object (every lib/flags/registry key resolved),
  // from the same payload. `undefined` while it loads. The client flag store
  // mirrors it so synchronous readers (e.g. the Monaco provider) keep working.
  const [savedFlags, setSavedFlags] = useState<Record<string, boolean> | undefined>(undefined);
  // The autocomplete behavior mode from the same payload; the client store
  // mirrors it for the Monaco provider's synchronous reads.
  const [savedAutocompleteMode, setSavedAutocompleteMode] = useState<AutocompleteMode | undefined>(
    undefined,
  );
  // An explicit `?autocomplete=on|off` this load — a runtime-only override
  // (never persisted anywhere): remembered so account hydration skips it.
  const urlAutocompleteOverrideRef = useRef<boolean | null>(null);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAppsPicker, setShowAppsPicker] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<'assistant' | 'model_only'>('assistant');
  const [defaultAssistantId, setDefaultAssistantId] = useState<string | null>(null);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const lastSyncedTimezoneRef = useRef<string | null>(null);
  const [userTeams, setUserTeams] = useState<UserTeam[]>([]);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const appsPickerRef = useRef<HTMLDivElement>(null);
  const appConnectionHandledRef = useRef<string | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showAddRepoModal, setShowAddRepoModal] = useState(false);
  // null = closed; 'create' arrives via "＋ New schedule" with the form open.
  const [schedulesPanelMode, setSchedulesPanelMode] = useState<null | 'list' | 'create'>(null);
  const [showAddOverleafModal, setShowAddOverleafModal] = useState(false);
  const [showOpenWithModal, setShowOpenWithModal] = useState(false);
  const [showAddSkillModal, setShowAddSkillModal] = useState(false);
  const [linkedReposRefreshKey, setLinkedReposRefreshKey] = useState(0);
  const [selectedCommit, setSelectedCommit] = useState<{ repoId: string; sha: string } | null>(null);
  const {
    repos: linkedRepos,
    findRepoForPath: findLinkedRepoForPath,
    refetch: refetchLinkedRepos,
  } = useLinkedRepos(
    cloudProjectId ?? '',
    linkedReposRefreshKey,
    backgroundDataReady || showAddRepoModal || showAddOverleafModal || showOpenWithModal,
  );
  // `?modal=` deep links (share/sign-in return paths, starter-doc links) are
  // dispatched by a single consume-and-clear effect near the modal openers.
  const modalDeepLinkParam = searchParams.get('modal');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState<string>(''); // Full path for document lookup
  // In-flight optimistic move of the OPEN file: tree/selection already show
  // `to`, but the collab room must stay bound to `from` until the server
  // rename commits (rooms are keyed by path; binding early seeds an empty doc).
  const [pendingOpenFileMove, setPendingOpenFileMove] = useState<{ from: string; to: string } | null>(null);
  // Lets a chat send fired during that window await the move and freeze the
  // settled path into the message (either would be wrong if frozen mid-move).
  // `current` is the path a send would see mid-flight (the optimistic target,
  // or the still-old path for await-first renames).
  const openFileMoveRef = useRef<{ current: string; settled: Promise<string> } | null>(null);
  const [pendingEditedFilePath, setPendingEditedFilePath] = useState<string | null>(null);
  // Editor panes (Obsidian-style tabs + drag-to-split). Pane 0 is the primary
  // editor column — the full chrome (toolbars, comments, LaTeX, chat context)
  // stays bound to it and its active tab mirrors selectedFilePath. Secondary
  // panes host lite collab editors. Transitions live in lib/workspace/editor-panes.
  const [editorPanes, setEditorPanes] = useState<EditorPane[]>(createInitialPanes);
  // Relative pane widths — flex-grow share per pane id, set by dragging the
  // boundary between panes (PaneResizeHandle). Reset to equal whenever the
  // pane set changes; session-local (ids aren't persisted, so neither is this).
  const [paneGrow, setPaneGrow] = useState<Record<string, number>>({});
  /** Armed with the pre-open pane-id key by the comment lane's "Open chat":
   *  NARROW_CHAT_PANE_SHARE is applied only when the open actually created the
   *  split, so a reused (possibly user-resized) pane keeps its width. */
  const narrowChatPaneArmedRef = useRef<string | null>(null);
  const paneIdsKey = editorPanes.map((p) => p.id).join('|');
  useEffect(() => setPaneGrow({}), [paneIdsKey]);
  const handlePaneResizeCommit = useCallback((fractions: number[]) => {
    setPaneGrow(Object.fromEntries(editorPanesRef.current.map((p, i) => [p.id, fractions[i] ?? 1])));
  }, []);
  // The right dock (PR #907 right panel): History (the review timeline) or
  // Outline. Closed by default; the top-bar toggle reopens the last-used view.
  const [rightDockView, setRightDockView] = useState<'history' | 'outline' | 'support' | null>(null);
  const [supportPanelHost, setSupportPanelHost] = useState<HTMLDivElement | null>(null);
  const rightDockLastViewRef = useRef<'history' | 'outline' | 'support'>('history');
  const openRightDock = useCallback((view: 'history' | 'outline' | 'support') => {
    rightDockLastViewRef.current = view;
    setRightDockView(view);
    // A selected Sync commit short-circuits the center to the diff viewer —
    // drop it so the dock actually appears beside the editor.
    setSelectedCommit(null);
  }, []);
  useEffect(() => {
    if (savedFlags && !savedFlags.sundial_support_enabled) {
      setRightDockView((current) => (current === 'support' ? null : current));
    }
  }, [savedFlags]);
  // The pinned top-right cluster (dock toggle · Share) overlays
  // whichever strip row runs beneath it — its measured width is reserved as
  // right padding there so tabs/icons never slide under Share.
  const [topbarRightWidth, setTopbarRightWidth] = useState(0);
  const topbarRightObserver = useRef<ResizeObserver | null>(null);
  const topbarRightRef = useCallback((el: HTMLDivElement | null) => {
    topbarRightObserver.current?.disconnect();
    topbarRightObserver.current = null;
    if (!el) {
      setTopbarRightWidth(0);
      return;
    }
    const measure = () => setTopbarRightWidth(el.offsetWidth);
    topbarRightObserver.current = new ResizeObserver(measure);
    topbarRightObserver.current.observe(el);
    measure();
  }, []);
  // The floating Home/Sidebar cluster (top bar hidden + rail collapsed),
  // measured the same way: a sole chat's header shifts right by this width so
  // its title never runs under the floating controls.
  const [topbarLeftFloatWidth, setTopbarLeftFloatWidth] = useState(0);
  const topbarLeftFloatObserver = useRef<ResizeObserver | null>(null);
  const topbarLeftFloatRef = useCallback((el: HTMLDivElement | null) => {
    topbarLeftFloatObserver.current?.disconnect();
    topbarLeftFloatObserver.current = null;
    if (!el) {
      setTopbarLeftFloatWidth(0);
      return;
    }
    const measure = () => setTopbarLeftFloatWidth(el.offsetWidth);
    topbarLeftFloatObserver.current = new ResizeObserver(measure);
    topbarLeftFloatObserver.current.observe(el);
    measure();
  }, []);
  // The control cluster seated INSIDE the formatting toolbar (mode picker,
  // and in the Docs style Aa + ⋮ too) — measured so the toolbar's responsive
  // tiers get only what's left and the two clusters can't collide. Separate
  // from docControlsRef: the IDE header keeps that one for title centering
  // while its toolbar carries this cluster at the same time.
  const [toolbarControlsWidth, setToolbarControlsWidth] = useState(0);
  const toolbarControlsObserver = useRef<ResizeObserver | null>(null);
  const toolbarControlsRef = useCallback((el: HTMLDivElement | null) => {
    toolbarControlsObserver.current?.disconnect();
    toolbarControlsObserver.current = null;
    if (!el) {
      setToolbarControlsWidth(0);
      return;
    }
    const measure = () => setToolbarControlsWidth(el.offsetWidth);
    toolbarControlsObserver.current = new ResizeObserver(measure);
    toolbarControlsObserver.current.observe(el);
    measure();
  }, []);
  // The doc header BAR itself, measured for the collapse breakpoint: when the
  // pane gets this tight the always-on controls fold into the ⋯ menu so the
  // title keeps room. (Bar width = pane width, so collapsing the controls
  // can't feed back into this measurement.)
  const [docHeaderWidth, setDocHeaderWidth] = useState(0);
  const docHeaderObserver = useRef<ResizeObserver | null>(null);
  const docHeaderRef = useCallback((el: HTMLDivElement | null) => {
    docHeaderObserver.current?.disconnect();
    docHeaderObserver.current = null;
    if (!el) {
      setDocHeaderWidth(0);
      return;
    }
    const measure = () => setDocHeaderWidth(el.offsetWidth);
    docHeaderObserver.current = new ResizeObserver(measure);
    docHeaderObserver.current.observe(el);
    measure();
  }, []);
  // Mobile's merged bar isn't the doc header row, so it gets the viewport
  // signal instead: below this width the same collapse applies.
  const [isNarrowMobile, setIsNarrowMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 479px)');
    const update = () => setIsNarrowMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const collapseDocControls = isMobile ? isNarrowMobile : docHeaderWidth > 0 && docHeaderWidth < 460;
  const editorPanesRef = useRef(editorPanes);
  editorPanesRef.current = editorPanes;
  // Split panes' live markdown editors, keyed by pane id — the page-built
  // header/⋮ chrome binds to the pane's own editor. Setters are memoized per
  // pane so the pane body's effect doesn't re-fire every render.
  const [paneEditors, setPaneEditors] = useState<Record<string, Editor | null>>({});
  const paneEditorSetters = useRef(new Map<string, (editor: Editor | null) => void>());
  const paneEditorSetter = (paneId: string) => {
    let setter = paneEditorSetters.current.get(paneId);
    if (!setter) {
      setter = (editor) =>
        setPaneEditors((prev) => (prev[paneId] === editor ? prev : { ...prev, [paneId]: editor }));
      paneEditorSetters.current.set(paneId, setter);
    }
    return setter;
  };
  // The pane the user last acted on (tab click / drop / ＋ launcher) — the
  // desktop ⌘W close targets it; ids are session-local, so a pruned id just
  // falls back to the primary.
  const lastFocusedPaneIdRef = useRef(PRIMARY_PANE_ID);
  // Rendered twin of the ref: which pane's chrome owns pane-scoped keyboard
  // shortcuts (⌘F). Set on pointer-down in a pane, like the ref.
  const [focusedPaneId, setFocusedPaneId] = useState(PRIMARY_PANE_ID);
  // "No tabs" (desktop shell only, Settings → Appearance): dropping the strips
  // reduces any multi-pane layout the same way a web arrival does — the
  // visible file + the visible chat — since without tabs the extra panes are
  // unreachable. Flattened OUTSIDE the state updater: flattening mints fresh
  // pane ids (impure), so a re-run updater would commit different ids than
  // the ⌘W focus remap saw. One flatten, one id set — the focus follows the
  // pane that kept the focused surface (else the primary), or Close Tab over
  // a focused chat would fall back to closing the doc.
  const setTabsEnabled = useCallback(
    (enabled: boolean) => {
      if (enabled === desktopTabs) return;
      setHideTopBarPreferred(!enabled);
      if (!enabled) {
        const prev = editorPanesRef.current;
        const focused = prev.find((p) => p.id === lastFocusedPaneIdRef.current);
        // The FOCUSED pane's surface survives the flatten: ordered first, it
        // is the file (or chat) flattenPanesForWeb keeps — otherwise a user
        // working in a second doc pane would silently get the first doc.
        const ordered = focused ? [focused, ...prev.filter((p) => p !== focused)] : prev;
        const next = flattenPanesForWeb(ordered);
        lastFocusedPaneIdRef.current =
          (focused?.active ? next.find((p) => p.active === focused.active)?.id : undefined) ??
          next[0].id;
        // The selection mirror binds the primary's active tab — hand it the
        // survivor, or the mirror would swap the old selection straight back.
        const primaryActive = next[0].active;
        if (primaryActive && !isSpecialTab(primaryActive)) setSelectedFilePath(primaryActive);
        setEditorPanes(next);
      }
      setDesktopTabs(enabled);
    },
    [desktopTabs],
  );
  // Assigned once openChatById exists — pane transitions that land a chat tab
  // active re-point the live chat through it (see applyPaneTransition).
  const openChatByIdRef = useRef<(chatId: string, opts?: { sidePanel?: boolean }) => unknown>(
    () => undefined,
  );
  // Explicit file opens (tree click, review jump, deep link) claim exactly ONE
  // pane — the FOCUSED pane when it shows a document, else the first pane that
  // does (resolveOpenTargetPaneId; files-left/chats-right). Picking "the first
  // file pane" outright meant a rail click always swapped the LEFTMOST
  // document, changing a pane the user wasn't working in. With only a chat
  // visible the doc claims the primary and the chat docks aside instead of
  // being displaced. When an open displaces the last visible chat, the legacy
  // 'chat' reveal intent must go with it or a reload re-covers the doc with
  // the chat tab.
  const claimPrimaryWithFile = useCallback(
    (path: string, opts?: { append?: boolean; chatAside?: boolean }) => {
      setEditorPanes((prev) => {
        const targetId = resolveOpenTargetPaneId(prev, 'file', lastFocusedPaneIdRef.current, path);
        const filePane = targetId ? prev.find((p) => p.id === targetId) : undefined;
        const next =
          opts?.chatAside ||
          (!opts?.append && !filePane && prev.some((p) => isChatTab(p.active)))
            ? openWithChatAside(prev, path)
            : opts?.append
              ? openPaneTab(prev, PRIMARY_PANE_ID, path)
              : replaceActiveTab(prev, filePane?.id ?? PRIMARY_PANE_ID, path);
        const chatStillVisible = next.some((pane) => isChatTab(pane.active));
        // Outside the updater (React may run it twice); removePanel is idempotent.
        queueMicrotask(() => {
          if (!chatStillVisible) setOpenPanels((op) => removePanel(op, 'chat'));
          // Rail-opened files never fire a pane pointer event — stamp ⌘W's
          // focus ref at the pane that now shows the file.
          const shown = next.find((pane) => pane.active === path);
          if (shown) lastFocusedPaneIdRef.current = shown.id;
          // This claim OWNS the selection: selectedFilePath names the PRIMARY
          // pane's document, so an open that landed in a side pane must leave
          // it alone (callers that set it optimistically converge here).
          const primaryActive = next[0].active;
          if (primaryActive && !isSpecialTab(primaryActive)) setSelectedFilePath(primaryActive);
        });
        return next;
      });
    },
    [],
  );
  const [editorTabDragActive, setEditorTabDragActive] = useState(false);
  /** Which project's pane snapshot has been restored — re-arms on workspace
   *  switch so the next project loads its own layout (and the save effect
   *  can't write the old layout under the new key meanwhile). */
  const editorPanesRestoredRef = useRef<string | null>(null);
  /** Reactive mirror of the ref: the visibility gate and the chat-first
   *  arrival decision both need to re-render when the restore lands, so the
   *  first VISIBLE frame is always post-restore (no doc-then-chat frame). */
  const [panesRestoredFor, setPanesRestoredFor] = useState<string | null>(null);
  const restoredSnapshotHadTabsRef = useRef(false);
  // Same room-binding freeze as pendingOpenFileMove, but for files open in
  // SECONDARY panes: their tabs remap optimistically on a move, and binding
  // the not-yet-committed path would seed an empty doc (rooms are keyed by
  // path). Maps a pane's room back to the pre-move path until the PATCH
  // settles. A list because a multi-select drag fires concurrent moves.
  const [pendingPaneMoves, setPendingPaneMoves] = useState<{ from: string; to: string }[]>([]);
  // Which pane a dragged tab hovers, and on which edge — that pane's content
  // squashes aside (Obsidian-style) to preview the post-split layout.
  const [paneDropZone, setPaneDropZone] = useState<{ paneId: string; zone: DropZone } | null>(null);
  const handleTabDragChange = useCallback((dragging: boolean) => {
    // Web (no-tabs) shell: no strips, no split overlays — never arm the drag.
    if (dragging && !desktopTabs) return;
    setEditorTabDragActive(dragging);
    if (!dragging) setPaneDropZone(null);
  }, [desktopTabs]);
  const handlePaneZoneChange = useCallback((paneId: string, zone: DropZone | null) => {
    setPaneDropZone(zone && zone !== 'center' ? { paneId, zone } : null);
  }, []);
  // Which columns actually render. Mobile keeps the single-panel open-set
  // model; on desktop chats live as PANE TABS (PR #907 shell), so chat
  // visibility — what the realtime/list/scroll-restore effects key off —
  // derives from the panes, and `openPanels` only carries reveal intent.
  const visibleColumns = resolveVisibleColumns(openPanels, isMobile);
  // Embedded agent layout (?view=panel, latched inside side-panel browsers):
  // one surface at a time. Post-mount only — the rail can't be open during
  // hydration in panel mode, so this never diverges from the server pass.
  const panelViewActive = hasMounted && latchPanelView();
  // Chat-first arrival, before the chat id resolves: the pane renders the
  // chat surface from the FIRST paint instead of mounting the preselected
  // document and yanking it once the chat tab lands (the arrival flash).
  const arrivalChatPending = chatFirstArrivalPending({
    openPanels,
    isMobile,
    anyPaneTabs: editorPanes.some((pane) => pane.tabs.length > 0),
    // Reactive (state, not the ref): the shell only becomes visible once the
    // restore has landed (see the visibility gate), so the FIRST visible
    // frame already knows whether the snapshot had tabs — a stale ['chat']
    // open-set never paints chat over restoring tabs, and a no-snapshot
    // arrival is chat-owned from its very first paint.
    panesRestored: panesRestoredFor === projectId,
  });
  // Desktop-only: mobile renders the legacy column layout, and a pane
  // snapshot restored from a desktop session must not hijack its editor.
  const primaryChatActive = !isMobile && (isChatTab(editorPanes[0].active) || arrivalChatPending);
  const primaryLauncherActive = !isMobile && isLauncherTab(editorPanes[0].active);
  const primaryReviewActive = !isMobile && isReviewTab(editorPanes[0].active);
  const primaryDiffActive = !isMobile && isDiffTab(editorPanes[0].active);
  const paneChatVisible = editorPanes.some((p) => isChatTab(p.active));
  const paneFileVisible = editorPanes.some((p) => p.active !== '' && !isSpecialTab(p.active));
  const isEditorVisible = isMobile ? openPanels.includes('editor') : paneFileVisible;
  // The file whose editor last had focus — what presence broadcasts as "the
  // file this user is in". selectedFilePath alone names the PRIMARY pane's
  // file, which is wrong while the user types in a secondary split pane.
  const [focusedEditorPath, setFocusedEditorPath] = useState<string | null>(null);
  const handleEditorFocusedPath = useCallback((path: string) => setFocusedEditorPath(path), []);
  // A file is ON SCREEN only when some pane's ACTIVE tab is that file. The
  // primary selection can survive as a background tab under an active chat/
  // launcher tab while a secondary pane keeps isEditorVisible true — such a
  // file must be neither broadcast in presence nor offered as a Share scope.
  const paneShowsFile = useCallback(
    (path: string) =>
      isMobile
        ? isEditorVisible && path === selectedFilePath
        : editorPanes.some((pane) => pane.active === path),
    [isMobile, isEditorVisible, selectedFilePath, editorPanes],
  );
  // The Sync commit viewer replaces the whole editor column (doc header
  // included) — one flag naming its render condition. While it covers the
  // editor, no pane file is really on screen: presence must not broadcast
  // one and the Share menu must not offer one.
  const commitDiffOpen = Boolean(
    selectedCommit &&
      linkedRepos.length > 0 &&
      openLeftRail === 'project' &&
      !isSectionCollapsed(sidebarSections, 'sync'),
  );
  const isReviewVisible = isMobile ? openPanels.includes('review') : rightDockView === 'history';
  const isChatVisible = isMobile ? visibleColumns.chat : paneChatVisible;
  // 'chat' === chat is the sole surface (old full-chat mode); on desktop that
  // is a chat tab alone in a single pane.
  const mode: WorkspaceViewMode = isMobile
    ? isChatVisible && !isEditorVisible && !isReviewVisible
      ? 'chat'
      : 'space'
    : primaryChatActive && editorPanes.length === 1
      ? 'chat'
      : 'space';
  // A chat opens as a tab: replace-on-open in the pane already holding it
  // (else the primary), demoting any other pane's active chat — the workspace
  // runs ONE live chat stream (use-sundial-chat is instantiated once).
  /** Tab an open just handed to a pane, awaiting its focus stamp. */
  const pendingFocusTabRef = useRef<string | null>(null);
  /** Bumped by each chat-tab open so the reconcile effect runs once per open. */
  const [chatTabOpenSeq, setChatTabOpenSeq] = useState(0);
  const openChatTabInPanes = useCallback((chatId: string, opts?: { side?: boolean; append?: boolean; paneId?: string }) => {
    const tab = chatTab(chatId);
    const transition = (prev: EditorPane[]) => {
      // Already on screen: the click just focuses that pane. No pane's active
      // tab changes — re-running the open below could otherwise move the chat
      // into a different pane and blank the one it left. (Not for `append`:
      // the ＋ launcher must still consume its own tab, which the paths below
      // handle.)
      const shown = opts?.append ? undefined : prev.find((p) => p.active === tab);
      if (shown) return enforceSingleActiveChat(prev, shown.id);
      const holder = prev.find((p) => p.tabs.includes(tab));
      if (opts?.append && !holder) {
        // ＋ launcher: a NEW leaf beside the current tab, never replacing it —
        // in the pane whose ＋ was clicked (pane ids are session-local, so an
        // unknown id falls back to the primary).
        const paneId =
          opts.paneId && prev.some((p) => p.id === opts.paneId) ? opts.paneId : PRIMARY_PANE_ID;
        return enforceSingleActiveChat(openPaneTab(prev, paneId, tab), paneId);
      }
      // side: with only a FILE visible the chat SPLITS to the right of it
      // (files-left/chats-right) instead of replacing it; falls through to
      // replace when the primary is empty/chat, or when some pane already
      // shows a chat (then the click replaces the DISPLAYED chat, not the
      // doc). A background copy of the tab travels with the open — one tab
      // lives in exactly one pane, and a copy left behind is what a later
      // rail click would hijack.
      if (
        opts?.side &&
        prev[0].active !== '' &&
        !isChatTab(prev[0].active) &&
        !prev.some((p) => isChatTab(p.active))
      ) {
        const base = holder ? dropTabElsewhere(prev, tab) : prev;
        const next = openPaneToSide(base, tab);
        const pane = next.find((p) => p.tabs.includes(tab));
        return pane ? enforceSingleActiveChat(next, pane.id) : next;
      }
      // Replace-on-open per GROUP: in a doc+chat split, a chat opened from
      // the rail replaces the chat PANE's tab — never the document, and never
      // a pane that merely holds this chat BEHIND its active tab (that
      // background-holder-wins rule swapped the document in one pane and the
      // chat in another from a single rail click — the onboarding report).
      const paneId =
        resolveOpenTargetPaneId(prev, 'chat', lastFocusedPaneIdRef.current) ??
        holder?.id ??
        PRIMARY_PANE_ID;
      const base = dropTabElsewhere(prev, tab, paneId);
      return enforceSingleActiveChat(replaceActiveTab(base, paneId, tab), paneId);
    };
    // Nothing but the transition goes in the updater. React REPLAYS queued
    // updaters on later renders, so a side effect scheduled from inside runs
    // again and again: the old queueMicrotask + setSelectedFilePath pair
    // re-armed itself every render and spun the workspace at React's
    // update-depth ceiling (2026-08-06). Selection and focus reconcile from
    // the COMMITTED panes in the effect below.
    setEditorPanes(transition);
    pendingFocusTabRef.current = tab;
    setChatTabOpenSeq((seq) => seq + 1);
  }, []);
  // Reconcile ONE chat-tab open, once, against the panes it committed.
  // Replace-on-open can close the selected file's tab, so a selection no pane
  // holds any more clears. Deliberately keyed on the open counter, not on
  // `editorPanes`: inside the pane updater React's updater replay re-armed the
  // side effect forever (an update-depth loop), and on every pane change it
  // fought the restore/deep-link effects that set a selection before its tab
  // exists (both observed 2026-08-06).
  useEffect(() => {
    if (!chatTabOpenSeq) return;
    const panes = editorPanesRef.current;
    setSelectedFilePath((sel) => (sel && !panes.some((pane) => pane.tabs.includes(sel)) ? '' : sel));
    const tab = pendingFocusTabRef.current;
    pendingFocusTabRef.current = null;
    // Rail/header-opened chats fire no pane pointer event — stamp ⌘W's focus
    // ref at the pane that now shows the chat.
    const shown = tab ? panes.find((pane) => pane.active === tab) : null;
    if (shown) lastFocusedPaneIdRef.current = shown.id;
    // A chat opened from a comment thread lands NARROW instead of taking half
    // the window. Consumed on every chat open (never left armed), and only
    // honored when this open changed the pane set — i.e. it created the split.
    const armed = narrowChatPaneArmedRef.current;
    narrowChatPaneArmedRef.current = null;
    const idsKey = panes.map((pane) => pane.id).join('|');
    if (armed !== null && armed !== idsKey && shown && shown.id !== PRIMARY_PANE_ID) {
      const share = NARROW_CHAT_PANE_SHARE;
      setPaneGrow(
        Object.fromEntries(
          panes.map((pane) => [pane.id, pane.id === shown.id ? share : (1 - share) / (panes.length - 1)]),
        ),
      );
    }
  }, [chatTabOpenSeq]);

  // Assigned once currentChatId exists; lets the early reveal primitives
  // (openCenterPanel/setWorkspaceViewMode) open the current chat's tab.
  const openChatTabForCurrentRef = useRef<(opts?: { side?: boolean }) => void>(() => {});
  // Assigned once closeActiveChatTab exists (the Cmd+J toggle-close path).
  const closeActiveChatTabRef = useRef<() => void>(() => {});
  const [showMetaFiles, setShowMetaFiles] = useState(DEFAULT_SHOW_META_FILES); // Toggle for showing meta/config files
  // Agent metadata files (AGENTS.md, skills/, logs/) — visible by default,
  // hidden via the tree's eye toggle. Persisted per browser.
  const [showAgentMetaFiles, setShowAgentMetaFiles] = useState(true);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SHOW_AGENT_META_FILES_KEY);
      if (stored !== null) setShowAgentMetaFiles(stored !== '0');
    } catch {
      // localStorage unavailable — keep the default
    }
  }, []);
  const toggleAgentMetaFiles = useCallback(() => {
    setShowAgentMetaFiles((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SHOW_AGENT_META_FILES_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  }, []);
  const [accessError, setAccessError] = useState<'signin' | 'forbidden' | 'not-found' | null>(null);
  // Key-gated AND unclaimed (anon-owned, no account owner): the wall swaps
  // its dead-end sign-in for the claim-key field — signing in without the
  // handoff cookie would change nothing (claim-on-login never fires).
  const [accessClaimable, setAccessClaimable] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('workspace');
  const [canWrite, setCanWrite] = useState(true);
  // Optimistic true (like canWrite): the arrival swap below only fires once a
  // payload proves the visitor is NOT the owner. Reset on project switch so a
  // non-owned workspace's state never leaks into the next arrival.
  const [isOwner, setIsOwner] = useState(true);
  const [canSuggest, setCanSuggest] = useState(true);
  const [canComment, setCanComment] = useState(true);
  const [canAccessSecrets, setCanAccessSecrets] = useState<boolean | null>(null);
  // Path-share grants elevate per-file capability past the workspace baseline
  // (guests AND read-only members); `isScopedGuest` = access exists ONLY via
  // grants (drives the guest-only UI states, e.g. the disabled composer).
  const [pathGrants, setPathGrants] = useState<PathGrant[]>([]);
  // Chat ids a scoped guest may read (shared local chats).
  const [chatGrants, setChatGrants] = useState<string[]>([]);
  const [isScopedGuest, setIsScopedGuest] = useState(false);
  // Ref mirror so stable callbacks (loadChatThreads) read it without deps churn.
  const isScopedGuestRef = useRef(isScopedGuest);
  isScopedGuestRef.current = isScopedGuest;
  const chatGrantsRef = useRef(chatGrants);
  chatGrantsRef.current = chatGrants;
  const canWriteWorkspacePath = useCallback(
    (path: string) =>
      pathCapability({ canWrite, canSuggest, canComment }, pathGrants, path).canWrite,
    [canWrite, canSuggest, canComment, pathGrants],
  );
  // Can the caller create files inside `targetFolder` (null = workspace
  // root)? Probes a child name — folder grants cover any descendant.
  const canUploadToFolder = useCallback(
    (targetFolder: string | null) =>
      canWriteWorkspacePath(targetFolder ? `${targetFolder}/upload.tmp` : 'upload.tmp'),
    [canWriteWorkspacePath],
  );
  // Client mirror of the server's canCreatePath: brand-new content (and
  // compiles, whose artifacts are creates) needs workspace write or a FOLDER
  // edit grant covering the path — exact-file grants never qualify.
  const canCreateWorkspacePath = useCallback(
    (path: string | null) =>
      canWrite ||
      (Boolean(path) &&
        pathGrants.some(
          (grant) =>
            grant.role === 'edit' &&
            grant.kind !== 'file' &&
            Boolean(path?.startsWith(`${grant.path}/`)),
        )),
    [canWrite, pathGrants],
  );
  const [editorPageChrome, setEditorPageChrome] = useState<MarkdownPageChrome>({
    margin: 'normal',
    header: false,
    footer: false,
  });
  const { mode: documentEditMode, setMode: setDocumentEditMode } = useDocumentEditMode();
  const [projectTitle, setProjectTitle] = useState('Untitled workspace');
  const [projectStatus, setProjectStatus] = useState<'active' | 'archived'>('active');
  const [projectKind, setProjectKind] = useState<WorkspaceKind | null>(null);
  const [projectCreatedAt, setProjectCreatedAt] = useState<string | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const [showWorkspaceSwitcher, setShowWorkspaceSwitcher] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);
  /** Chat awaiting the delete confirmation (null = dialog closed). */
  const [chatPendingDelete, setChatPendingDelete] = useState<{ id: string; title: string | null } | null>(null);
  const [chatDetailsChatId, setChatDetailsChatId] = useState<string | null>(null);
  // Per-chat "Connect to mobile" — opens LinkTextChatModal for this chat id.
  const [linkTextChatId, setLinkTextChatId] = useState<string | null>(null);
  const messageInputByChatIdRef = useRef<Record<string, string>>({});
  // draft chat id → its promoted real id (written by replaceDraftChat). Lets
  // the inline-ask send verify the on-screen chat really came from ITS draft.
  const draftPromotionsRef = useRef<Record<string, string>>({});
  // deleted real chat id → the draft that replaced it (the demote mirror of
  // draftPromotionsRef, written by demoteChatToDraft).
  const demotedDraftByRealIdRef = useRef<Record<string, string>>({});
  // chat id → the FIRST id of its promote/demote lineage. The composer is
  // keyed by this instead of the raw chat id so the mid-typing draft→real id
  // swap keeps the same composer instance mounted — a remount here restored
  // the text but parked the caret at position 0, displacing the first typed
  // character to the end ("hi there" → "therehi ").
  const chatLineageIdRef = useRef<Record<string, string>>({});
  // Follow the promotion/demotion mappings from a possibly-stale chat id to
  // the live one. Composer events and upload completions can report under an
  // id the swap already retired (their remount/round-trip races it).
  const resolveLiveChatId = useCallback((chatId: string) => {
    // Fixed point with cycle protection: every promote/demote appends a hop,
    // so a long-running upload may need to cross arbitrarily many swaps.
    let id = chatId;
    const seen = new Set<string>([id]);
    for (;;) {
      const next = isDraftChatId(id)
        ? draftPromotionsRef.current[id]
        : demotedDraftByRealIdRef.current[id];
      if (!next || seen.has(next)) break;
      seen.add(next);
      id = next;
    }
    return id;
  }, []);
  // Real chat ids that exist ONLY because the composer was typed into (no
  // message sent yet). Fully backspacing their composer deletes the row again —
  // a chat may live in the DB only while a message is drafted or sent. The set
  // is mirrored to localStorage (arm/disarm below) so a cleanup interrupted by
  // a reload or a failed DELETE is finished on the next load instead of
  // leaving the empty row behind forever.
  const typedEmptyChatIdsRef = useRef(new Set<string>());
  // Both persistence keys are scoped by the signed-in identity as well as the
  // project: drafts are private input, and a project-only key would show user
  // A's unsent text to user B after an account switch in the same browser.
  const draftStorageScope = user?.id ?? 'anon';
  const typedEmptyStorageKey = projectId
    ? `sundial:chat-cleanup:${draftStorageScope}:${projectId}`
    : null;
  const persistTypedEmptyMarker = useCallback(
    (chatId: string, armed: boolean) => {
      if (!typedEmptyStorageKey || typeof window === 'undefined') return;
      try {
        const stored = new Set<string>(
          JSON.parse(window.localStorage.getItem(typedEmptyStorageKey) ?? '[]') as string[]
        );
        if (armed) stored.add(chatId);
        else stored.delete(chatId);
        if (stored.size === 0) window.localStorage.removeItem(typedEmptyStorageKey);
        else window.localStorage.setItem(typedEmptyStorageKey, JSON.stringify([...stored]));
      } catch {
        // localStorage unavailable — cleanup still works within this session.
      }
    },
    [typedEmptyStorageKey]
  );
  const armTypedEmpty = useCallback(
    (chatId: string) => {
      typedEmptyChatIdsRef.current.add(chatId);
      persistTypedEmptyMarker(chatId, true);
    },
    [persistTypedEmptyMarker]
  );
  const disarmTypedEmpty = useCallback(
    (chatId: string) => {
      const wasArmed = typedEmptyChatIdsRef.current.delete(chatId);
      persistTypedEmptyMarker(chatId, false);
      return wasArmed;
    },
    [persistTypedEmptyMarker]
  );
  const sectionAppendsByChatIdRef = useRef<Record<string, Record<string, string>>>({});
  const [messageDraftVersion, setMessageDraftVersion] = useState(0);
  const [attachmentsByChatId, setAttachmentsByChatId] = useState<Record<string, MessageAttachment[]>>({});
  const [contextSnippetsByChatId, setContextSnippetsByChatId] = useState<
    Record<string, ChatContextSnippet[]>
  >({});
  const [isChatDropActive, setIsChatDropActive] = useState(false);
  const [isFilesDropActive, setIsFilesDropActive] = useState(false);
  const [shouldFocusChatInput, setShouldFocusChatInput] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileRow[]>([]);
  // Local multi-root projects: every root (primary first, prefix '') — extra
  // mounted folders render as their own top-level tree sections.
  const [localRoots, setLocalRoots] = useState<{ prefix: string; root: string; name: string }[]>([]);
  const [spaceInstructions, setSpaceInstructions] = useState<string>(
    workspaceRouteContext?.initialFiles?.spaceInstructions ?? '',
  );
  const [workspaceStorageUsage, setWorkspaceStorageUsage] = useState<WorkspaceStorageUsage | null>(null);
  const [filesLoaded, setFilesLoaded] = useState(false);
  // Docs vs IDE is chosen FOR you, never asked (founder, 2026-08-10: a new user
  // has no basis for the answer), and the answer is always IDE (founder,
  // 2026-08-12) — the flat surface, with the formatting bar open. That is
  // `getDocStylePreference`'s unset value, so an arrival writes nothing at all:
  // no per-workspace inference, no share-guest slice deciding this device's
  // style. A stored pref (document ⋯ menu / Settings → Appearance) still wins,
  // because it is the only thing that ever writes the key.

  const deepLinkedWorkspaceFile = useMemo(
    () =>
      deepLinkedFileId
        ? findShareableWorkspaceFile(workspaceFiles, deepLinkedFileId)
        : findShareableWorkspaceFileByPath(workspaceFiles, deepLinkedFilePath),
    [workspaceFiles, deepLinkedFileId, deepLinkedFilePath],
  );
  const standaloneDiffHref = deepLinkedDiffId
    ? `/d/${encodeURIComponent(deepLinkedDiffId)}`
    : null;
  const [binaryPreviewUrl, setBinaryPreviewUrl] = useState<string | null>(null);
  const [binaryPreviewStatus, setBinaryPreviewStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [binaryPreviewNonce, setBinaryPreviewNonce] = useState(0);
  const [showRichViewer, setShowRichViewer] = useState(true);
  const [viewerContent, setViewerContent] = useState<string | null>(null);
  // The code editor's live (CRDT-ledger-merged) suggestion set for the active
  // file, so the CSV table shows the user's own just-staged edits instantly —
  // the server-fed `spacePendingAdditions` only sees them after a poll. Null
  // until the editor first emits (table falls back to the server set).
  const [csvLiveSuggestions, setCsvLiveSuggestions] = useState<PendingAddition[] | null>(null);
  const [chatStatusById, setChatStatusById] = useState<Record<string, ChatStatus>>({});
  const [chatSessionById, setChatSessionById] = useState<Record<string, string>>({});
  const [chatSessionMetricsById, setChatSessionMetricsById] = useState<Record<string, ChatSessionMetrics>>({});
  const [chatLoopById, setChatLoopById] = useState<Record<string, ChatLoopSummary | null>>({});
  const [interruptingChatIds, setInterruptingChatIds] = useState<Record<string, boolean>>({});
  const [interruptErrorByChatId, setInterruptErrorByChatId] = useState<Record<string, string>>({});
  const [streamActivityByChatId, setStreamActivityByChatId] = useState<Record<string, number>>({});
  const [chatMessagesById, setChatMessagesById] = useState<Record<string, ChatMessage[]>>({});
  const isDocumentVisible = useDocumentVisible();
  const [showAssistantPicker, setShowAssistantPicker] = useState(false);
  const [assistantPickerCueVisible, setAssistantPickerCueVisible] = useState(false);
  const [showPrototypeGroupModal, setShowPrototypeGroupModal] = useState(false);
  const [prototypeGroupName, setPrototypeGroupName] = useState('');
  const [prototypeGroupTeammateIds, setPrototypeGroupTeammateIds] = useState<string[]>([]);
  const [groupChatCreateError, setGroupChatCreateError] = useState<string | null>(null);
  const [isCreatingGroupChat, setIsCreatingGroupChat] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [draftEntry, setDraftEntry] = useState<DraftEntry | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // Manual sidebar order (drag-to-reorder). Shared workspace state; the
  // localStorage read is just the paint cache so the arranged tree shows
  // before the files payload lands.
  const [fileOrder, setFileOrder] = useState<FileOrderMap>({});
  useEffect(() => {
    setFileOrder(projectId ? readFileOrder(projectId) : {});
  }, [projectId]);
  // Bumped by every drag. `reloadFiles` captures it before its fetch and drops
  // the payload's order if it moved in flight — same generation guard the file
  // list itself uses (filesGenRef), for the same reason.
  const fileOrderGenRef = useRef(0);
  const [renameEntry, setRenameEntry] = useState<RenameEntry | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null);
  // The ⌘K command palette (files + actions) — opened by Cmd/Ctrl+K or the
  // sidebar search bar. (⌘T is its own surface: the New-tab launcher tab.)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Set when the palette was opened FROM a New-tab chooser ("Open file"):
  // the picked file must fill THAT pane (consuming its launcher tab), not
  // whichever pane handleFileClick would claim. Not cleared by onClose —
  // the palette closes before it routes the choice — so every non-chooser
  // open path resets it instead. Stale values are harmless: it only applies
  // while the target pane still shows the launcher.
  const [paletteTargetPaneId, setPaletteTargetPaneId] = useState<string | null>(null);
  const pendingRevealLineRef = useRef<number | null>(null);
  // Root-grant token for every copied workspace URL (the useWorkspaceShare
  // state loads further down — refs bridge the hook order). The sticky URL
  // token is only reusable when it PROVABLY resolves to the root grant: any
  // narrower grant alongside (a tokenless public workspace opened via a
  // narrower ?pshare link, say) means the sticky token may be that narrow
  // capability, and embedding it would leak the stronger scope to every
  // recipient (PR-bot findings on #997 and #1052).
  const rootShareTokenRef = useRef<string | null>(null);
  const holdsRootGrantRef = useRef(false);
  holdsRootGrantRef.current = holdsRootGrantOnly(pathGrants);
  const {
    copiedChatLinkId,
    handleCopyChatLink,
    handleCopyFileLink,
  } = useWorkspaceLinkCopy({
    projectId,
    workspaceRouteId,
    setOpenMenuPath,
    getShareToken: useCallback(
      () =>
        rootShareTokenRef.current ??
        (holdsRootGrantRef.current ? currentPathShareToken() : null),
      [],
    ),
  });
  const [layoutConfigReady, setLayoutConfigReady] = useState(false);

  const layoutConfigHydratedRef = useRef(false);
  const freshDesktopLayoutPendingRef = useRef(false);
  const blockFreshLayoutPersistenceRef = useRef(false);
  // A client-side workspace switch swaps projectId without a remount. Re-arm
  // hydration and gate persistence (render-phase, before any effect can write)
  // so the next workspace restores its own stored layout instead of inheriting
  // — and overwriting it with — the previous one's in-memory state.
  const layoutProjectIdRef = useRef(projectId);
  if (layoutProjectIdRef.current !== projectId) {
    layoutProjectIdRef.current = projectId;
    layoutConfigHydratedRef.current = false;
    urlMirrorReadyRef.current = false;
    lastMirroredViewKeyRef.current = { fileId: null, chatId: null };
    landingViewSettledRef.current = false;
    restoringViewFromPopstateRef.current = false;
    restoringViewTargetRef.current = null;
    if (layoutConfigReady) setLayoutConfigReady(false);
  }

  const mainContentRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  const chatMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const chatMessagesByIdRef = useRef<Record<string, ChatMessage[]>>({});
  const chatMessageLoadPromisesRef = useRef<Map<string, Promise<ChatMessage[]>>>(new Map());
  const lastMarkedReadSequenceByChatIdRef = useRef<Record<string, number>>({});
  const shouldAutoScrollRef = useRef(true);
  const chatScrollTopByChatIdRef = useRef<Record<string, number>>({});
  const chatInputRef = useRef<HTMLElement | null>(null);
  const richEditorRef = useRef<Editor | null>(null);
  const textEditorRef = useRef<CodeEditorHandle | null>(null);
  const fileUploadInputRef = useRef<HTMLInputElement>(null);

  const [readyFileId, setReadyFileId] = useState<string | null>(null);
  const activeFileIdRef = useRef<string | null>(null);
  /** Debounced content visibility — stays true during fast file switches to prevent flicker */
  const [fileContentVisible, setFileContentVisible] = useState(true);
  const [markdownEditor, setMarkdownEditor] = useState<Editor | null>(null);
  /** Cache of the latest markdown editor. We keep it even after it's destroyed:
   *  on a markdown→markdown switch the old instance is torn down before the new
   *  one finishes syncing, and dropping the reference here would blank the
   *  external formatting toolbar mid-switch. Tiptap's read APIs (isActive / can /
   *  getAttributes / state) are safe on a destroyed editor — they return the last
   *  values — so the toolbar simply freezes on its final state until the new
   *  editor takes over, instead of flickering out and back. */
  const lastValidMarkdownEditorRef = useRef<Editor | null>(null);
  if (markdownEditor && !markdownEditor.isDestroyed) {
    lastValidMarkdownEditorRef.current = markdownEditor;
  }
  const toolbarEditor = lastValidMarkdownEditorRef.current;
  const fileHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // textEditorRef can dangle on a *destroyed* markdown editor when the editor
  // panel is closed (review-only) and no new editor mounts to replace it — so
  // switching to a LaTeX root and compiling would read getText() off the dead
  // editor and throw. safeGetEditorText centralises the destroyed/throwing guard.
  const readEditorText = useCallback((): string | null => safeGetEditorText(textEditorRef.current), []);

  const handleEditorReady = useCallback(
    ({ editor }: { editor: Editor }) => {
      richEditorRef.current = editor;
      setMarkdownEditor(editor);
      textEditorRef.current = editor;
      // Seed viewer content from editor once CRDT is hydrated
      const text = safeGetEditorText(editor);
      if (text) setViewerContent(text);
      setReadyFileId(activeFileIdRef.current);
    },
    []
  );

  const handleCodeEditorReady = useCallback(
    ({ editor }: { editor: CodeEditorHandle }) => {
      richEditorRef.current = null;
      setMarkdownEditor(null);
      textEditorRef.current = editor;
      setViewerContent(editor.getText());
      setReadyFileId(activeFileIdRef.current);
      // A project-search result opened this file; reveal the match line once the
      // freshly-mounted editor is ready (§12.2).
      if (pendingRevealLineRef.current != null) {
        const line = pendingRevealLineRef.current;
        pendingRevealLineRef.current = null;
        requestAnimationFrame(() => editor.revealLine?.(line));
      }
    },
    []
  );

  const handleViewerContentChange = useCallback((text?: string) => {
    // Keep viewer content in sync with live CRDT updates
    if (typeof text === 'string') {
      setViewerContent(text);
      return;
    }
    const editorText = readEditorText();
    if (editorText != null) setViewerContent(editorText);
  }, [readEditorText]);

  // Voice input — shared hook with onboarding
  const currentChatRef = useRef<{ id: string } | null>(null);
  // Composer drafts persist locally (per project) so drafted chats keep their
  // text across reloads — a drafted row without its text is exactly the
  // clutter the lazy chat lifecycle exists to avoid. Draft-id entries persist
  // too: a draft whose promotion kept failing (offline) is resurrected as a
  // fresh local draft at the next load instead of losing the text.
  const chatDraftStorageKey = projectId
    ? `sundial:chat-drafts:${draftStorageScope}:${projectId}`
    : null;
  const persistChatDraft = useCallback(
    (chatId: string, text: string) => {
      if (!chatDraftStorageKey || typeof window === 'undefined') return;
      try {
        const stored = JSON.parse(
          window.localStorage.getItem(chatDraftStorageKey) ?? '{}'
        ) as Record<string, string>;
        if (text) stored[chatId] = text;
        else delete stored[chatId];
        if (Object.keys(stored).length === 0) window.localStorage.removeItem(chatDraftStorageKey);
        else window.localStorage.setItem(chatDraftStorageKey, JSON.stringify(stored));
      } catch {
        // localStorage unavailable (private mode, quota) — drafts stay in-memory.
      }
    },
    [chatDraftStorageKey]
  );
  // Read through a ref so setStoredMessageDraft keeps a STABLE identity —
  // one-shot listeners (⌘J context, voice) capture it once, and a
  // project-scoped closure would strand their writes on the initial storage
  // key when a ?pshare= link adopts the workspace UUID after load.
  const persistChatDraftRef = useRef(persistChatDraft);
  persistChatDraftRef.current = persistChatDraft;
  const setStoredMessageDraft = useCallback((chatId: string, text: string, notify = false) => {
    if (!chatId) return;
    if (text) {
      messageInputByChatIdRef.current[chatId] = text;
    } else {
      delete messageInputByChatIdRef.current[chatId];
    }
    persistChatDraftRef.current(chatId, text);
    if (notify) {
      setMessageDraftVersion((prev) => prev + 1);
    }
  }, []);

  // `switchToChat` reveals the chat panel without disturbing the rest. Stable
  // so useFillComposerEvent doesn't re-subscribe its window listener each render.
  const revealChatPanel = useCallback((next: WorkspaceViewMode) => {
    if (next === 'chat') setOpenPanels((prev) => addPanel(prev, 'chat'));
  }, []);
  useFillComposerEvent({
    currentChatRef,
    messageInputByChatIdRef,
    sectionAppendsByChatIdRef,
    setStoredMessageDraft,
    setShouldFocusChatInput,
    setMode: revealChatPanel,
  });

  // CollabEditor chat shortcuts dispatch `sundial:add-chat-context`:
  //   Cmd/Ctrl-J                 → toggle the current chat open/closed,
  //                                or pin the selection when there is one
  //   +Shift                     → always open a fresh chat
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const openPanelsRef = useRef(openPanels);
  openPanelsRef.current = openPanels;
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  // Whether the chat transcript is actually on screen (not just in the open-set);
  // see isChatVisible. Read by chat list/unread effects so they don't act on a
  // hidden transcript (e.g. mobile ['editor','chat']).
  const isChatVisibleRef = useRef(isChatVisible);
  isChatVisibleRef.current = isChatVisible;
  const startAssistantChatRef = useRef<
    | ((
        assistantId: string | null,
        assistantInfo?: unknown,
        opts?: { forceNew?: boolean; keepMode?: boolean }
      ) => Promise<string | null>)
    | null
  >(null);
  const promoteDraftWithSettingsRef = useRef<
    ((draftId: string) => Promise<ChatThread | null>) | null
  >(null);
  useEffect(() => {
    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<{
        text?: string;
        path?: string | null;
        forceNew?: boolean;
        toggle?: boolean;
        instruction?: string;
        /** Caret placement relative to `text` for "/ai" in-place asks —
         *  without it Sunny knows which doc but not where. */
        caret?: 'inside' | 'after' | 'start';
      }>).detail;
      const text = detail?.text?.trim() ?? '';
      const path = detail?.path ?? null;
      const forceNew = Boolean(detail?.forceNew);
      // Toggle close when the user retriggers the shortcut on an already-open
      // chat. Shift variants (forceNew) skip this and open a fresh chat.
      // Desktop chat visibility lives in the PANES (a chat tab), not the
      // open-set — close the tab, or the toggle can't hide the transcript.
      const chatIsVisible = isChatVisibleRef.current;
      if (detail?.toggle && !forceNew && chatIsVisible) {
        // Save the transcript scroll before the chat surface unmounts.
        const el = chatScrollRef.current;
        const chatId = currentChatRef.current?.id ?? null;
        if (chatId && el) {
          chatScrollTopByChatIdRef.current[chatId] = el.scrollTop;
          shouldAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 96;
        }
        setShowAssistantPicker(false);
        closeActiveChatTabRef.current();
        return;
      }
      // No current chat (threads still loading, or all chats deleted) must
      // not turn "Ask Sunny"/⌘J into a silent no-op — start one instead.
      const priorChatId = currentChatRef.current?.id ?? null;
      const createdFresh = forceNew || !priorChatId;
      const chatId = createdFresh
        ? (await startAssistantChatRef.current?.(null, null, {
            forceNew: true,
            keepMode: modeRef.current === 'space',
          })) ?? null
        : priorChatId;
      if (!chatId) return;
      // Desktop transcripts live in pane tabs — the open-set alone renders
      // nothing, so a closed chat tab must reopen (docked beside a doc).
      // Fresh drafts already opened their tab in startDraftChat.
      if (!isMobileRef.current && !createdFresh) {
        // A selection-driven open lands NARROW like the comment lane's "Open
        // chat": an even split crushes the document the selection came from.
        // Armed with the pre-open pane key, so a reused (possibly resized)
        // pane keeps its width. Plain ⌘J (no selection) keeps the even split.
        if (text || detail?.instruction?.trim()) {
          narrowChatPaneArmedRef.current = editorPanesRef.current.map((pane) => pane.id).join('|');
        }
        openChatTabForCurrentRef.current({ side: true });
      }
      // Inline ask (selection popup / "/ai …"): send a full turn immediately —
      // quoted anchor context + instruction — instead of pinning a snippet and
      // waiting for the user to type in the composer.
      const instruction = detail?.instruction?.trim() ?? '';
      if (instruction) {
        const quote = text
          ? formatSnippetBlock([{ text, path }])
          : path
            ? `> _in \`${path}\`_`
            : '';
        // "/ai" in-place asks: pin the caret POSITION in prose, or Sunny
        // gets the doc but not the spot and edits the wrong place.
        const where =
          detail?.caret === 'inside'
            ? 'My cursor is on the quoted line, so apply this right there.'
            : detail?.caret === 'after'
              ? 'My cursor is on an empty line immediately after the quoted text, so write there.'
              : detail?.caret === 'start'
                ? 'My cursor is at the top of the document.'
                : '';
        // Drafts only persist on demand (first keystroke or send) — this
        // auto-send IS the demand, so promote explicitly (with the draft's
        // own model/harness); without it the settled() wait below would
        // always time out into the degraded path.
        if (isDraftChatId(chatId)) {
          await promoteDraftWithSettingsRef.current?.(chatId);
        }
        // Wait for a PROMOTED (non-draft) current chat before sending: a
        // draft id would make handleSendMessage promote mid-send and trip its
        // `chat.id !== currentChatId` guard, silently dropping the turn
        // (Codex P1 on #790). Settle ONLY on the target chat itself or its
        // recorded promotion (draftPromotionsRef) — "any non-draft chat"
        // would hit whatever chat the user switched to mid-promotion.
        const settled = () => {
          const cur = currentChatRef.current?.id;
          if (!cur || isDraftChatId(cur)) return false;
          return cur === chatId || cur === draftPromotionsRef.current[chatId];
        };
        for (let i = 0; i < 40 && !settled(); i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // While Sunny is mid-reply in this chat, a direct send would
        // cancel-and-replace the run and lose the rest of the answer — the
        // composer's Stop/send UX blocks this; degrade to a prefilled draft
        // + pinned snippet instead (same as the unsettled path below).
        if (settled() && (createdFresh || !isChatInterruptibleRef.current)) {
          setOpenPanels((prev) => addPanel(prev, 'chat'));
          handleSendMessageRef.current?.(
            [quote, where, instruction].filter(Boolean).join('\n\n'),
            { standalone: true },
          );
          return;
        }
        // Busy chat or state never caught up — degrade to a prefilled draft +
        // pinned snippet below so nothing typed is lost. Target the chat
        // that's actually on screen, not a possibly-superseded draft id. The
        // pin only covers a non-empty anchor, so fold the path-only quote and
        // the cursor note into the draft (Codex P2 on #790).
        // Merge with (never clobber) a follow-up the user was already
        // composing while Sunny streamed.
        const draftChatId = currentChatRef.current?.id ?? chatId;
        const priorDraft = messageInputByChatIdRef.current[draftChatId] ?? '';
        setStoredMessageDraft(
          draftChatId,
          [priorDraft, text ? '' : quote, where, instruction].filter(Boolean).join('\n\n'),
          true,
        );
      }
      if (text) {
        setContextSnippetsByChatId((prev) => {
          const list = prev[chatId] ?? [];
          if (list.some((s) => s.text === text && s.path === path)) return prev;
          return {
            ...prev,
            [chatId]: [
              ...list,
              { id: crypto.randomUUID(), text, path },
            ],
          };
        });
      }
      setShouldFocusChatInput(true);
      // Reveal the chat panel beside whatever is already open.
      setOpenPanels((prev) => addPanel(prev, 'chat'));
    };
    window.addEventListener('sundial:add-chat-context', handler);
    return () => window.removeEventListener('sundial:add-chat-context', handler);
  }, []);

  // Window-level fallback for Cmd/Ctrl-J (and Cmd/Ctrl-Shift-J for a new chat).
  // The editor bindings only fire while the editor has focus; once we open
  // the chat composer focus moves there, so the next press of the same
  // shortcut would otherwise be a no-op. The editor's bindings call
  // preventDefault when they fire, so we check `defaultPrevented` to avoid
  // double-dispatching when both fire.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'j') return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      window.dispatchEvent(
        new CustomEvent('sundial:add-chat-context', {
          detail: {
            text: '',
            path: null,
            forceNew: event.shiftKey,
            toggle: !event.shiftKey,
          },
        }),
      );
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Cmd/Ctrl+K (the sidebar search bar's shortcut) toggles the command
  // palette, and so do ⌘O (Obsidian's quick switcher), ⌘P (VS Code's quick
  // open) and ⌘⇧P (VS Code's command palette — ours is one unified surface,
  // files ranked first, actions last). Browsers let all of these be
  // prevented, unlike ⌘N/⌘T; in the desktop shell the native File menu
  // consumes ⌘O (Open folder) before the webview sees it, so quick open is
  // ⌘P there. The markdown editor claims ⌘K first — link popover — but only
  // with a NON-EMPTY selection, and preventDefaults when it fires; an empty
  // caret falls through here. Monaco likewise preventDefaults the keys it
  // owns inside code files.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'k' && key !== 'o' && key !== 'p') return;
      if (event.shiftKey && key !== 'p') return;
      event.preventDefault();
      setPaletteTargetPaneId(null);
      setCommandPaletteOpen((open) => !open);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const removeContextSnippet = useCallback((chatId: string, snippetId: string) => {
    setContextSnippetsByChatId((prev) => {
      const list = prev[chatId];
      if (!list) return prev;
      const next = list.filter((s) => s.id !== snippetId);
      if (next.length === list.length) return prev;
      const out = { ...prev };
      if (next.length === 0) delete out[chatId];
      else out[chatId] = next;
      return out;
    });
  }, []);

  const moveStoredMessageDraft = useCallback((fromChatId: string, toChatId: string, notify = false) => {
    if (!fromChatId || !toChatId || fromChatId === toChatId) return;
    const draft = messageInputByChatIdRef.current[fromChatId];
    delete messageInputByChatIdRef.current[fromChatId];
    if (draft) {
      messageInputByChatIdRef.current[toChatId] = draft;
    } else {
      delete messageInputByChatIdRef.current[toChatId];
    }
    persistChatDraftRef.current(fromChatId, '');
    persistChatDraftRef.current(toChatId, draft ?? '');
    if (notify) {
      setMessageDraftVersion((prev) => prev + 1);
    }
  }, []);
  const { isListening: isVoiceListening, isSupported: isVoiceSupported, toggleListening: toggleVoice } = useVoiceInput({
    onTranscript: (text) => {
      const chatId = currentChatRef.current?.id;
      if (chatId) {
        setStoredMessageDraft(chatId, text, true);
      }
    },
  });

  const didSetInitialFileRef = useRef(false);
  const didSetInitialChatRef = useRef(false);
  const didAutoOpenInitialChatRef = useRef(false);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  const draftIdRef = useRef(0);
  const cancelDraftRef = useRef(false);
  // The tab-strip launcher's "new TAB" intent for the next committed draft.
  const filesChannelRef = useRef<BroadcastChannel | null>(null);
  // Bumped by every optimistic file-tree mutation (create/delete/move/rename).
  // `reloadFiles` captures it before its fetch and drops the result if it
  // changed in flight — a poll/realtime reload whose GET predates the mutation
  // would otherwise clobber the optimistic update (resurrect a deleted file,
  // un-move a moved one).
  const filesGenRef = useRef(0);
  // Self-reference for the initial-load retry below (reloadFiles is defined
  // later and would otherwise not be callable from inside itself).
  const reloadFilesRef = useRef<((shouldSetInitial?: boolean) => Promise<number | undefined>) | null>(null);
  const emptyRetryProjectRef = useRef<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  /** Stores the click X-offset for header renames so cursor is placed at click position */
  const renameClickOffsetRef = useRef<{ x: number; text: string } | null>(null);
  /** Defers folder toggle so a double-click can cancel it and enter rename instead */
  const folderClickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Tracks the last-clicked file path for shift+click range selection */
  const lastClickedPathRef = useRef<string | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const assistantPickerRef = useRef<HTMLDivElement | null>(null);
  const assistantPickerCueTimeoutRef = useRef<number | null>(null);
  const optimisticStartingUntilByChatIdRef = useRef<Map<string, number>>(new Map());
  // Comment-watch toggles: per-chat request chain + latest-wins token, so a
  // rapid start→stop can't leave the server watching behind a stopped chip.
  const commentWatchSeqRef = useRef<Map<string, number>>(new Map());
  const commentWatchQueueRef = useRef<Map<string, Promise<void>>>(new Map());
  // Last value the SERVER confirmed per chat — what a failed toggle reverts to.
  const commentWatchConfirmedRef = useRef<Map<string, string | null>>(new Map());
  // Chats with a toggle PATCH in flight — loadChatThreads must not overwrite
  // their confirmed value with a read that may predate the landing PATCH.
  const commentWatchPendingRef = useRef<Map<string, number>>(new Map());
  const draftPromotionByIdRef = useRef<Map<string, Promise<ChatThread | null>>>(new Map());
  // In-flight model/harness PATCHes per chat. A send must not race these: the
  // runner reads chats.model/chats.harness at turn start, so a turn fired
  // before the PATCH lands would run on the old settings.
  const pendingChatSettingsByIdRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const streamTimeoutsRef = useRef<Record<string, number>>({});
  const isArchived = projectStatus === 'archived';
  const archivedTag = isArchived ? (
    <span className="relative inline-flex items-center group">
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-500 cursor-default select-none">
        archived
      </span>
      <span className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 w-56 -translate-x-1/2 rounded-md bg-stone-900 px-2 py-1 text-[11px] text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        Marked as archived. You can still interact with this workspace as usual.
      </span>
    </span>
  ) : null;
  const archiveActionLabel = isArchiving
    ? isArchived
      ? 'Unarchiving...'
      : 'Archiving...'
    : isArchived
      ? 'Unarchive workspace'
      : 'Archive workspace';
  // Gate the browser Supabase client on Clerk being loaded. supabase-js calls
  // the accessToken callback once at construction and uses the result for the
  // initial Realtime auth; if Clerk hasn't loaded by then, the first batch of
  // channels (workspace-files, workspace-chats, workspace-doc-edits, etc.)
  // subscribe with no JWT and silently lose deliveries once RLS is enabled.
  // Holding the client null until isLoaded ensures every channel subscribes
  // with the JWT in its join payload. For anon visitors isLoaded still flips
  // true (just with no session) so the anon flow is unaffected.
  const { isLoaded: isClerkLoaded, isSignedIn: isClerkSignedIn } = useAuth();
  // Read Clerk auth state via a ref inside `reloadFiles` so it doesn't have
  // to depend on these values — otherwise the bootstrap effect in
  // useWorkspaceFileLifecycle would re-run (and reset workspace state) every
  // time Clerk hydrates or sign-in flips.
  const clerkAuthRef = useRef({ isLoaded: isClerkLoaded, isSignedIn: Boolean(isClerkSignedIn) });
  clerkAuthRef.current = { isLoaded: isClerkLoaded, isSignedIn: Boolean(isClerkSignedIn) };
  // Packaged-app sign-in exists only as sd_ credentials parked in the sidecar
  // (clerk-js never loads in the webview) — count it for the identity UI.
  // Cloud workspaces have no localConfig but are still served through the
  // sidecar proxy, so recover its config the same way the send path does.
  const [desktopConfig, setDesktopConfig] = useState<SidecarConfig | null>(localConfig);
  useEffect(() => {
    if (localConfig) {
      setDesktopConfig(localConfig);
      return;
    }
    let cancelled = false;
    void resolveSidecarConfig().then((config) => {
      if (!cancelled) setDesktopConfig(config);
    });
    return () => {
      cancelled = true;
    };
  }, [localConfig]);
  const desktopSignedIn = useDesktopCredentials(desktopConfig) === true;
  const desktopProfile = useDesktopProfile(desktopSignedIn && !user);
  // Local projects never touch Supabase — a null client no-ops every realtime
  // hook (presence, files channel, comments, doc-edits) in one place. Anonymous
  // `?pshare=` guests additionally wait for their realtime JWT mint: a channel
  // subscribed before the socket has auth claims stays event-less forever.
  const pshareRealtimeReady = usePathShareRealtimeAuthReady();
  const supabaseClient = useMemo(
    () => (isClerkLoaded && pshareRealtimeReady && !isLocalWorkspace ? createBrowserClient() : null),
    [isClerkLoaded, pshareRealtimeReady, isLocalWorkspace],
  );
  const workspacePresenceState = useWorkspacePresence({
    supabaseClient,
    projectId,
    user,
    anonId,
    anonDisplayName: anonId ? anonDisplayName(anonId) : null,
    anonColor: anonId ? pickColor(`${ANON_AUTHOR_PREFIX}${anonId}`) : null,
    // Broadcast which file this browser is in so other clients' bubble
    // clicks can jump straight to us. The last-FOCUSED editor's file wins
    // (split panes make the primary selection wrong); either way only a file
    // some pane actively SHOWS is broadcast — the primary selection can be a
    // background tab under an active chat tab, and in chat mode
    // selectedFilePath lingers after the editor (and its caret) unmounts.
    // While the commit diff covers the editor column no pane file is truly
    // on screen — same gate as the Share menu's file scopes.
    openFilePath:
      !isEditorVisible || commitDiffOpen
        ? null
        : focusedEditorPath && paneShowsFile(focusedEditorPath)
          ? focusedEditorPath
          : selectedFilePath && paneShowsFile(selectedFilePath)
            ? selectedFilePath
            : null,
  });
  const localAgentPresence = useLocalAgentPresence({ supabaseClient, projectId });
  // Cloud chats whose agent has a fresh doc_edits row — the "cursor in a
  // file" signal gating the topbar assistant bubble.
  const agentEditingChatIds = useAgentEditingChats({ supabaseClient, projectId: cloudProjectId });
  const existingPaths = useMemo(() => new Set(workspaceFiles.map((file) => file.path)), [workspaceFiles]);

  // Mirror the selected file into the primary pane (replace semantics — a bare
  // file-tree click swaps the active tab, exactly the pre-tabs behavior).
  // Desktop-only: mobile renders no tab UI, and mirroring there would mutate
  // the restored desktop layout mid-session (it re-syncs once on resize).
  useEffect(() => {
    if (isMobile) return;
    // …except the chat-first arrival's preselection: the arrival's draft chat
    // and the file list race, so mirroring here flashes the document and then
    // yanks it. Strictly one-shot — the marker is spent on the first selection
    // either way, so it can never skip a later, real one. (A rail click opens
    // the file through handleFileClick, not through this mirror.)
    const preselected = selectedFilePath && selectedFilePath === arrivalPreselectRef.current;
    if (selectedFilePath) arrivalPreselectRef.current = null;
    if (preselected) return;
    setEditorPanes((prev) => syncPrimaryActive(prev, selectedFilePath));
  }, [isMobile, selectedFilePath]);
  // …and the reverse reconcile: the primary's editor chrome renders
  // `selectedFilePath`, so the two must never disagree. The mirror above
  // deliberately leaves the primary alone when the selection is already ON
  // SCREEN in a side pane (a bare selection change must not open a second
  // copy), so snap the selection back to the primary's own tab — otherwise
  // its body would render a file its tab strip doesn't show. A selection
  // sitting in the primary's BACKGROUND (behind a chat/diff tab) is the
  // legitimate case and stays untouched.
  useEffect(() => {
    if (isMobile || !selectedFilePath) return;
    const pane = editorPanes[0];
    if (pane.tabs.includes(selectedFilePath) || isSpecialTab(pane.active) || !pane.active) return;
    if (!editorPanes.some((p, i) => i > 0 && p.active === selectedFilePath)) return;
    setSelectedFilePath(pane.active);
  }, [editorPanes, isMobile, selectedFilePath]);
  // Restore the persisted pane layout once the file list can validate it…
  useEffect(() => {
    if (!projectId || !filesLoaded || editorPanesRestoredRef.current === projectId) return;
    editorPanesRestoredRef.current = projectId;
    setPanesRestoredFor(projectId);
    // No (or corrupted) snapshot starts clean — also what drops the previous
    // workspace's panes after an in-place workspace switch.
    let restored = createInitialPanes();
    try {
      const raw = readPaneSnapshot(projectId);
      if (raw) restored = normalizePanes(JSON.parse(raw), existingPaths);
    } catch {
      /* corrupted snapshot — start clean */
    }
    // No-tabs shell (web build, or desktop with the top bar hidden): a
    // snapshot (possibly saved by a tabbed session) reduces to the visible
    // file + whether a chat is open. Read the latched flag + preference
    // directly — the desktopTabs state may not have settled yet.
    if (!isDesktopShell() || hideTopBarPreferred()) restored = flattenPanesForWeb(restored);
    // Whether a real snapshot restored content — the legacy chat-reveal
    // effect must not replace a restored file tab, but a first arrival
    // (whose auto-selected file merely mirrored into the pane) still gets
    // its full-width chat.
    restoredSnapshotHadTabsRef.current = restored.some((p) => p.tabs.length > 0);
    // A lifecycle-AUTO-selected file that the snapshot already shows in a
    // split pane must not duplicate into a deliberately-empty primary —
    // restore the layout exactly as saved instead.
    if (
      !deepLinkedFileId &&
      !deepLinkedFilePath &&
      selectedFilePath &&
      restored[0].tabs.length === 0 &&
      restored.some((p, i) => i > 0 && p.tabs.includes(selectedFilePath))
    ) {
      setSelectedFilePath('');
      setEditorPanes(restored);
      return;
    }
    // …but never let the snapshot displace the file already on screen
    // (deep link or first click won the race).
    const deepPath = deepLinkedWorkspaceFile?.path ?? null;
    setEditorPanes((prev) => {
      const prevActive = prev[0].active;
      // The auto-draft (or an early chat activation) can win the race before
      // this restore runs: keep the restored file layout and dock the
      // already-open chat BESIDE it — syncPrimaryActive would treat the chat
      // tab like a file path and replace the restored primary tab.
      if (isChatTab(prevActive)) {
        if (!restored.some((p) => p.tabs.length > 0)) return prev;
        const next = openPaneToSide(restored, prevActive);
        const holder = next.find((p) => p.tabs.includes(prevActive));
        return holder ? enforceSingleActiveChat(next, holder.id) : next;
      }
      const merged = syncPrimaryActive(restored, prevActive);
      // The deep-linked file claims the primary pane; a restored chat docks aside.
      return deepPath ? openWithChatAside(merged, deepPath) : merged;
    });
    // A restored active chat tab must drive the live chat — otherwise the
    // surface would show whichever chat the last-chat pointer restored. That
    // includes a primary chat a deep link displaced: openWithChatAside keeps
    // it VISIBLE (active in a side pane), so it owns the transcript too.
    const restoredChat = restored.find((pane) => isChatTab(pane.active));
    if (restoredChat) {
      void openChatByIdRef.current(chatIdOfTab(restoredChat.active)!);
    }
  }, [projectId, filesLoaded, existingPaths, deepLinkedFileId, deepLinkedFilePath, deepLinkedWorkspaceFile, selectedFilePath]);
  // The deep-linked doc's claim, replayed once everything it races has run:
  // the file list (the id→path memo resolves late), the pane restore (whose
  // snapshot may hold an active chat), and the arrival chat reveal. Runs after
  // the restore effect in the same commit, so nothing overwrites it.
  const deepLinkClaimedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (isMobile || !filesLoaded || !deepLinkedWorkspaceFile) return;
    if (editorPanesRestoredRef.current !== projectId) return;
    if (deepLinkClaimedForRef.current === deepLinkedWorkspaceFile.id) return;
    deepLinkClaimedForRef.current = deepLinkedWorkspaceFile.id;
    claimPrimaryWithFile(deepLinkedWorkspaceFile.path, { chatAside: true });
  }, [claimPrimaryWithFile, deepLinkedWorkspaceFile, filesLoaded, isMobile, projectId]);
  // …and save on every change after that. Mobile never renders the tab/split
  // UI but selectedFilePath still mutates the panes through the mirror — a
  // phone visit must not overwrite the saved desktop layout.
  useEffect(() => {
    // layoutConfigReady is the repo's "hydration settled" persistence gate —
    // before it, isMobile can still hold its pre-matchMedia initial false.
    // Panel sessions never persist (gated inside persistPaneSnapshot).
    if (isMobile || !layoutConfigReady || !projectId || editorPanesRestoredRef.current !== projectId) return;
    persistPaneSnapshot(projectId, panesSnapshot(editorPanes));
  }, [editorPanes, isMobile, layoutConfigReady, projectId]);

  // Optimistic file-tree edit: marks a local mutation so an in-flight reload
  // can't overwrite it (see `filesGenRef`). Stable identity for the memoized
  // create/delete/move handlers.
  const mutateWorkspaceFiles = useCallback(
    (updater: (prev: WorkspaceFileRow[]) => WorkspaceFileRow[]) => {
      filesGenRef.current += 1;
      setWorkspaceFiles(updater);
    },
    [],
  );

  const upsertWorkspaceFile = (file: WorkspaceFileRow) => {
    mutateWorkspaceFiles((prev) => {
      const existingIndex = prev.findIndex((entry) => entry.id === file.id || entry.path === file.path);
      if (existingIndex === -1) {
        return [...prev, file];
      }
      const next = [...prev];
      next[existingIndex] = file;
      return next;
    });
  };

  const buildAttachmentFromFile = (file: WorkspaceFileRow): MessageAttachment => ({
    id: file.id,
    path: file.path,
    mime: file.mime ?? null,
    size: typeof file.size === 'number' ? file.size : null,
    type: isBinaryFile(file) ? 'binary' : 'text',
  });

  const addChatAttachment = (chatId: string, attachment: MessageAttachment) => {
    setAttachmentsByChatId((prev) => ({
      ...prev,
      [chatId]: [...(prev[chatId] ?? []), attachment],
    }));
  };

  const removeChatAttachment = (chatId: string, attachment: MessageAttachment) => {
    setAttachmentsByChatId((prev) => ({
      ...prev,
      [chatId]: (prev[chatId] ?? []).filter((item) => item.id !== attachment.id),
    }));
    if (attachment.path) {
      void deletePath(attachment.path);
    }
  };

  const localBinaryUpload = useMemo(
    () => (localConfig && projectId ? createLocalBinaryUpload(localConfig, projectId) : undefined),
    [localConfig, projectId],
  );
  const { uploads, queueUploads, removeUpload, reportUploadError } = useWorkspaceUploads({
    projectId,
    // Path-share editors can upload inside their granted subtree — every
    // queue call site gates per target (canUploadToFolder), so the hook's
    // workspace-wide flag only needs to not block grant holders outright.
    canWrite: canWrite || pathGrants.some((grant) => grant.role === 'edit'),
    existingPaths,
    fetchImpl: apiFetch,
    uploadBinary: localBinaryUpload,
    onUploadComplete: (file, upload) => {
      upsertWorkspaceFile(file);
      if (upload.target === 'chat' && upload.chatId) {
        // The chat's id may have swapped (draft promotion / empty-chat
        // demotion) while the upload was in flight — attach to the live id
        // or the finished upload lands on a retired key and vanishes.
        addChatAttachment(resolveLiveChatId(upload.chatId), buildAttachmentFromFile(file));
      }
    },
    onFilesChanged: () => filesChannelRef.current?.postMessage({ type: 'refresh' }),
  });

  const handleEditorImageDrop = useCallback(
    async (file: File) => {
      if (!projectId || !canUploadToFolder('assets')) return null;
      try {
        const result = await uploadImageFromEditor({
          projectId,
          file,
          existingPaths,
          uploadBinary: localBinaryUpload,
        });
        filesChannelRef.current?.postMessage({ type: 'refresh' });
        return { src: result.path, alt: result.alt };
      } catch (error) {
        console.error('[editor] image drop upload failed', error);
        reportUploadError(file.name, error instanceof Error ? error.message : 'Image upload failed.');
        return null;
      }
    },
    [projectId, canUploadToFolder, existingPaths, localBinaryUpload, reportUploadError],
  );

  const layoutStorageKey = workspaceLayoutStorageKey(projectId);
  const readStoredLayoutConfig = useCallback((): Partial<WorkspaceLayoutConfig> | null => {
    if (typeof window === 'undefined') return null;
    let stored = window.localStorage.getItem(layoutStorageKey);
    if (!stored && projectId) {
      // Adopt the pre-split shared layout once, then clear it — otherwise one
      // frozen blob keeps seeding the first visit of every other workspace.
      // Read-only adoption: the normal persist path writes it under the
      // per-workspace key once hydration applies it, while a fresh-workspace
      // arrival (persistence blocked) deliberately never stores it.
      stored = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
      if (stored) {
        try {
          window.localStorage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
        } catch {}
      }
    }
    if (!stored) return null;
    try {
      return JSON.parse(stored) as Partial<WorkspaceLayoutConfig>;
    } catch {
      return null;
    }
  }, [layoutStorageKey, projectId]);

  const applyStoredDesktopLayout = useCallback(
    (config: Partial<WorkspaceLayoutConfig> | null, opts?: { arrival?: boolean }) => {
      // Treat a missing layout (first device, cleared storage, incognito) as an
      // empty config so URL deep-link intents (?chat=1, ?fileId=) are still honored.
      const cfg = config ?? {};
      // Migrate legacy rails ('files'/'chats'/'commits') to the unified column.
      const stored = cfg.openLeftRail as unknown as string | null | undefined;
      // A first visit opens the file rail everywhere: the arrival lands on a
      // document, and the tree beside it is what makes the workspace legible
      // (and where the Chats section lives).
      const arrivalRail: LeftRail = 'project';
      if (stored === null) setOpenLeftRail(null);
      else if (stored != null) setOpenLeftRail('project');
      // Nothing stored on an arrival = first visit; apply the default so a soft
      // workspace switch can't leak the previous workspace's rail into the new
      // workspace's persisted layout.
      else if (opts?.arrival) setOpenLeftRail(arrivalRail);
      const hasDeepLinkedFile = Boolean(deepLinkedFileId || deepLinkedFilePath);
      // Prefer the stored open-set; migrate a legacy single `mode` if that's all
      // we have. `null` means nothing stored.
      const storedPanels = Array.isArray(cfg.openPanels)
        ? normalizeOpenPanels(cfg.openPanels)
        : cfg.mode != null
          ? legacyModeToOpenPanels(cfg.mode)
          : null;
      if (opts?.arrival) {
        const panels = resolveArrivalOpenPanels({
          stored: storedPanels,
          hasDeepLinkedFile,
          hasEditorAnchor: Boolean(deepLinkedCommentThreadId || deepLinkedDiffId),
          chatIntent: deepLinkChatIntent,
        });
        // Chat-sole landing (explicit chat link, or a stored chat-only
        // layout): remember it so the async access check can swap read-only
        // visitors to the doc, and put the caret in the composer — arriving
        // here means "say what you want". The rail is NOT forced here: a first
        // visit already took the shell default above, and on a return visit
        // the rail the user left behind is theirs, chat-only layout or not.
        arrivalChatDefaultRef.current = panels.length === 1 && panels[0] === 'chat';
        arrivalSwappedToDocRef.current = false; // new arrival, new decision
        // First visit = nothing stored — the non-owner swap keys off this.
        arrivalHadStoredLayoutRef.current = storedPanels !== null;
        if (arrivalChatDefaultRef.current) setShouldFocusChatInput(true);
        setOpenPanels(panels);
      } else if (storedPanels || hasDeepLinkedFile || deepLinkChatIntent) {
        // Mid-session re-apply (mobile↔desktop flip): restore what the user had
        // open, never re-run the arrival decision under their feet.
        let panels = resolveRestoredOpenPanels(storedPanels ?? ['editor'], hasDeepLinkedFile);
        if (deepLinkChatIntent) panels = addPanel(panels, 'chat');
        setOpenPanels(panels);
      }
      // Accordion sidebar layout (Phase 1). Single-select: a legacy config that
      // stored several visible sections collapses to the first (canonical) one.
      const restoredSections = normalizeSidebarSections(cfg.sidebarSections);
      if (restoredSections) setSidebarSections(restoredSections);
      else if (opts?.arrival) setSidebarSections([...DEFAULT_SIDEBAR_SECTIONS]);
    },
    [deepLinkChatIntent, deepLinkedCommentThreadId, deepLinkedDiffId, deepLinkedFileId, deepLinkedFilePath]
  );

  const applyFreshDesktopLayout = useCallback(
    (_config: Partial<WorkspaceLayoutConfig> | null) => {
      setOpenLeftRail('project');
      setShowSettingsModal(false);
      // A just-created workspace lands on its seeded welcome.md with the file
      // tree beside it; a template pick keeps its document beside the chat.
      // Same value the URL-only initializer already chose, so the fresh
      // arrival never repaints from chat to document after hydration.
      setOpenPanels(freshTemplateChatIntent ? ['editor', 'chat'] : ['editor']);
      arrivalChatDefaultRef.current = false;
      arrivalSwappedToDocRef.current = false;
      arrivalHadStoredLayoutRef.current = false;
      if (freshTemplateChatIntent) setShouldFocusChatInput(true);
      setSidebarSections([...DEFAULT_SIDEBAR_SECTIONS]);
    },
    [freshTemplateChatIntent]
  );

  const persistLayoutConfig = useCallback(
    (overrides: Partial<WorkspaceLayoutConfig> = {}) => {
      // latchPanelView: an embedded panel session (?view=panel) never
      // persists — unlike the fresh-layout block, this gate holds for the
      // whole session, so the embed can't clobber the real-browser layout.
      if (!hasMounted || !projectId || !layoutConfigReady || isMobile || blockFreshLayoutPersistenceRef.current || latchPanelView()) return;
      const config: WorkspaceLayoutConfig = {
        openLeftRail,
        openPanels,
        sidebarSections,
        ...overrides,
      };
      window.localStorage.setItem(layoutStorageKey, JSON.stringify(config));
    },
    [
      hasMounted,
      isMobile,
      layoutConfigReady,
      layoutStorageKey,
      openLeftRail,
      openPanels,
      projectId,
      sidebarSections,
    ]
  );

  // Layout persistence is desktop-only (persistLayoutConfig's isMobile guard,
  // re-run on every layout change via useWorkspaceLayoutEffects): mobile shows
  // the URL-only arrival — never the stored layout — so a mobile visit writing
  // its state would only clobber the workspace's saved desktop split.

  // Save the chat transcript scroll before the chat column unmounts so
  // reopening lands where the user left off (the old chat-mode exit behavior).
  const saveChatScrollPosition = useCallback(() => {
    const el = chatScrollRef.current;
    const chatId = currentChatRef.current?.id ?? null;
    if (chatId && el) {
      chatScrollTopByChatIdRef.current[chatId] = el.scrollTop;
      shouldAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 96;
    }
  }, []);

  const openCenterPanel = useCallback(
    (panel: CenterPanel, opts?: { chatId?: string; side?: boolean; append?: boolean }) => {
      // Opening a center panel drops any selected commit so the columns show
      // instead of the commit diff viewer keeping the center (Phase 1 behavior).
      setSelectedCommit(null);
      // Desktop: review lives in the right dock, chats are pane tabs.
      if (panel === 'review' && !isMobile) {
        openRightDock('history');
        return;
      }
      setOpenPanels((prev) => addPanel(prev, panel));
      // Chat-switching callers pass the target chatId — the currentChat ref
      // still points at the previous chat when they fire, and auto-opening it
      // would replace the primary doc with a stale chat tab.
      if (panel === 'chat' && !isMobile) {
        if (opts?.chatId) openChatTabInPanes(opts.chatId, { side: opts.side, append: opts.append });
        // `side` matters here too: on the file-first landing the chat is
        // opened from the rail while a document owns the pane, and it must
        // dock BESIDE that document rather than replace it.
        else openChatTabForCurrentRef.current({ side: opts?.side });
      }
    },
    [isMobile, openChatTabInPanes, openRightDock],
  );

  // Review-panel handoff: Revise / Ask / Restore-with-Sunny open the chat and
  // drop a preloaded message into the composer (the host-owned `fill-composer`
  // seam already focuses the input and reveals the chat surface).
  const handleReviewHandoffToChat = useCallback(
    (text: string) => {
      openCenterPanel('chat');
      window.dispatchEvent(new CustomEvent('sundial:fill-composer', { detail: { text, switchToChat: true } }));
    },
    [openCenterPanel],
  );

  const closeCenterPanel = useCallback(
    (panel: CenterPanel) => {
      if (panel === 'chat') {
        saveChatScrollPosition();
        setShowAssistantPicker(false);
      }
      setOpenPanels((prev) => removePanel(prev, panel));
    },
    [saveChatScrollPosition]
  );


  // Compat shim for the file/chat handlers that still think in chat|space.
  // Mobile shows one panel → replace; desktop is additive (panels coexist).
  const setWorkspaceViewMode = useCallback(
    (nextMode: WorkspaceViewMode) => {
      const target: CenterPanel = nextMode === 'chat' ? 'chat' : 'editor';
      // Opening a center panel drops any selected commit so the columns show
      // instead of the commit diff viewer keeping the center (Phase 1 behavior).
      setSelectedCommit(null);
      if (isMobile) {
        if (target !== 'chat' && openPanelsRef.current.includes('chat')) saveChatScrollPosition();
        setOpenPanels([target]);
      } else {
        setOpenPanels((prev) => addPanel(prev, target));
        if (target === 'chat') openChatTabForCurrentRef.current();
      }
      setShowAssistantPicker(false);
    },
    [isMobile, saveChatScrollPosition]
  );

  const closeSettingsModal = useCallback(() => {
    setShowSettingsModal(false);
  }, []);

  const openSettingsTab = useCallback((tab: SettingsTab) => {
    if (isMobile) {
      // Mobile only exposes chats/files/diff/file/chat; context/apps/config/prefs
      // are desktop-only. Drop the request silently rather than mapping to a missing surface.
      return;
    }
    setSettingsTab(tab);
    setShowSettingsModal(true);
  }, [isMobile]);

  // Pending "the Sundial Agent needs an account" prompt, raised by the send
  // gate instead of jumping straight to Clerk (and, on desktop, to the system
  // browser). Holds the resume path and the message that was being sent.
  const [cloudSignInPrompt, setCloudSignInPrompt] = useState<{
    redirectUrl?: string;
    draft: string;
  } | null>(null);
  // Free anonymous runs left on an anon-owned workspace (null: not anon-owned
  // / unknown). Fed by the files payload; read at send time only, so a ref —
  // it must not re-render anything, and staleness just means the server gate
  // gives the honest answer instead.
  const anonRunsRemainingRef = useRef<number | null>(null);

  // Integrations are account-scoped. A logged-out user clicking one goes
  // straight to Clerk sign-in — NOT a connect modal with the sign-in modal
  // stacked on top — and lands back on the integration surface via the
  // deep-link param after signing in (so the modal/tab reopens).
  const connectOrSignIn = useCallback(
    (open: () => void, params: Record<string, string>) => {
      // While Clerk is still hydrating we can't tell signed-in from logged-out,
      // so open the surface — it has its own load-gated sign-in gate and won't
      // show connect UI to an anon user. Only redirect to Clerk once we know.
      if (!isClerkLoaded || isClerkSignedIn) {
        open();
        return;
      }
      openSignIn({ redirectUrl: buildReturnPath(params) });
    },
    [isClerkLoaded, isClerkSignedIn, openSignIn],
  );

  const { showReviewPanel, closeReviewPanel } = useWorkspaceRouteIntents({
    searchParams,
    deepLinkedDiffId,
    openSettingsTab,
    setOpenLeftRail,
  });

  // The review panel is an open-set member; the `?review=open` deep-link intent
  // opens it as a column (desktop only — mobile uses the full-screen overlay).
  useEffect(() => {
    if (showReviewPanel && !isMobile) openCenterPanel('review');
  }, [showReviewPanel, isMobile, openCenterPanel]);

  // Closing the review column clears the deep-link intent + URL param too.
  const closeReviewColumn = useCallback(() => {
    closeReviewPanel();
    setRightDockView((prev) => (prev === 'history' ? null : prev));
    setOpenPanels((prev) => removePanel(prev, 'review'));
  }, [closeReviewPanel]);
  // Any dock close clears a ?review= intent too (no-op otherwise) — a reload
  // or copied link must not reopen a review the user dismissed, and a stale
  // 'review' in the persisted open-set must not restore a hidden layout.
  const closeRightDock = useCallback(() => {
    closeReviewPanel();
    setRightDockView(null);
    setOpenPanels((prev) => removePanel(prev, 'review'));
  }, [closeReviewPanel]);

  const handleWorkspaceSwitch = useCallback(
    (workspaceId: string) => {
      persistLayoutConfig();
      window.localStorage.setItem('sundial:last-workspace', workspaceId);
    },
    [persistLayoutConfig]
  );


  const reloadFiles = useCallback(
    async (shouldSetInitial = true, preloaded?: WorkspaceInitialFilesPayload) => {
      if (!projectId) return;
      type FilesPayload = {
        files: WorkspaceFileRow[];
        workspaceId?: string;
        canWrite?: boolean;
        isOwner?: boolean;
        canSuggest?: boolean;
        canComment?: boolean;
        canAccessSecrets?: boolean;
        isMember?: boolean;
        anonRunsRemaining?: number | null;
        pathGrants?: PathGrant[];
        chatGrants?: string[];
        scoped?: boolean;
        projectTitle?: string | null;
        projectStatus?: 'active' | 'archived' | null;
        projectKind?: WorkspaceKind | null;
        projectCreatedAt?: string | null;
        hostUrl?: string | null;
        cold?: boolean;
        localRoots?: { prefix: string; root: string; name: string }[];
        fileOrder?: FileOrderMap;
      };
      let payload: FilesPayload;
      // Generation at the moment this reload's data was fetched; used below to
      // skip a file-list overwrite that a local mutation has since superseded.
      let fetchGen: number | null = null;
      // Same idea for the sidebar order, captured BEFORE the fetch: an
      // in-flight check at apply time would still let a GET that started
      // before a drag — and resolved after its PUT finished — snap the tree
      // back under the cursor.
      const orderGen = fileOrderGenRef.current;
      // SSR-preloaded files (first paint) skip the fetch entirely.
      if (preloaded) {
        setAccessError(null);
        payload = preloaded;
      } else {
        fetchGen = filesGenRef.current;
        const res = await apiFetch(`/api/workspace/files?projectId=${projectId}`);
        if (!res.ok) {
          const denial = (await res.json().catch(() => null)) as { claimable?: boolean } | null;
          setAccessClaimable(Boolean(denial?.claimable));
          // 401 = caller had no recognized identity — on a background poll
          // (shouldSetInitial=false) this is usually a transient Clerk JWT
          // refresh race on tab wake-up; the next poll repopulates state, so
          // don't flash "Sign in". Surface it on the initial load, or once
          // Clerk has loaded and confirms the session is gone (real sign-out).
          // 403 = authenticated but access revoked, and 404 = workspace
          // deleted; both are permanent and always surface.
          if (res.status === 401) {
            const clerk = clerkAuthRef.current;
            if (shouldSetInitial || (clerk.isLoaded && !clerk.isSignedIn)) {
              setAccessError('signin');
            }
          } else if (res.status === 403) {
            setAccessError('forbidden');
          } else if (res.status === 404) {
            setAccessError('not-found');
          }
          return;
        }
        setAccessError(null);
        payload = (await res.json()) as FilesPayload;
      }
      const filesList = payload.files ?? [];
      const hostUnavailable = filesList.length === 0 && payload.cold && !payload.hostUrl;
      // A local file-tree mutation committed while this fetch was in flight — its
      // snapshot predates the change and would clobber the optimistic update
      // (resurrect a deleted file, un-move a moved one). Apply the rest of the
      // payload but leave the file list to the mutation's own follow-up reload.
      const listApplied = fetchGen === null || filesGenRef.current === fetchGen;
      if (listApplied) {
        setWorkspaceFiles((previous) => (hostUnavailable && previous.length > 0 ? previous : filesList));
      }
      setFilesLoaded(true);
      // The initial load SKIPPED its list (a mutation raced the fetch), so the
      // tree is empty but marked loaded, and nothing re-triggers it until the
      // 15s poll — the reported "opened my project, no files; reopening fixed
      // it". Re-fetch immediately. Once per project: a second miss falls back
      // to the poll rather than spinning.
      if (!listApplied && shouldSetInitial && emptyRetryProjectRef.current !== projectId) {
        emptyRetryProjectRef.current = projectId;
        void reloadFilesRef.current?.(true);
      }
      if (payload.localRoots) setLocalRoots(payload.localRoots);
      // The workspace's shared sidebar arrangement. Dropped when a drag landed
      // while this reload was in flight (its payload predates the drag), and
      // short-circuited when it already matches, so a poll can't churn the
      // tree's memos every cycle.
      if (payload.fileOrder && fileOrderGenRef.current === orderGen) {
        const incoming = sanitizeFileOrder(payload.fileOrder);
        setFileOrder((prev) => (sameFileOrder(prev, incoming) ? prev : incoming));
        writeFileOrder(projectId, incoming);
      }
      if (typeof payload.canWrite === 'boolean') {
        setCanWrite(payload.canWrite);
        setCanSuggest(payload.canSuggest ?? payload.canWrite);
        setCanComment(payload.canComment ?? payload.canWrite);
      }
      if (typeof payload.anonRunsRemaining === 'number' || payload.anonRunsRemaining === null) {
        anonRunsRemainingRef.current = payload.anonRunsRemaining;
      }
      if (typeof payload.isOwner === 'boolean') setIsOwner(payload.isOwner);
      setCanAccessSecrets(Boolean(payload.canAccessSecrets));
      // Both servers (files route + SSR preload) always include the field;
      // a payload WITHOUT it predates grants support and must not clear
      // capability a previous response delivered.
      if (Array.isArray(payload.pathGrants)) {
        setPathGrants(payload.pathGrants);
        setChatGrants(payload.chatGrants ?? []);
        setIsScopedGuest(Boolean(payload.scoped));
      }
      if (typeof payload.workspaceId === 'string' && payload.workspaceId) {
        setResolvedProjectId(payload.workspaceId); // no-op re-set for members
      }
      if (typeof payload.projectTitle === 'string') {
        setProjectTitle(payload.projectTitle);
      }
      if (payload.projectStatus === 'active' || payload.projectStatus === 'archived') {
        setProjectStatus(payload.projectStatus);
      }
      if (payload.projectKind === 'standard') {
        setProjectKind(payload.projectKind);
      }
      if (payload.projectCreatedAt) setProjectCreatedAt(payload.projectCreatedAt);
      // Legacy CRDT-snapshot prefetch is gone under Sunny sandbox — Supabase
      // no longer stores Yjs snapshots and the live host hydrates from the
      // plain text on disk during the Hocuspocus `onLoadDocument` hook.

      // `listApplied`: never seed the selection from a list we just REJECTED
      // (a rename/move/delete raced this fetch). Selecting from it would also
      // set didSetInitialFileRef, so the retry above could refresh the tree but
      // never replace the stale pick — an empty editor, or a tab for a file
      // that no longer exists, until you click something else.
      if (listApplied && !didSetInitialFileRef.current && shouldSetInitial && filesList.length) {
        let initialPath: string | null = null;
        let storedPath: string | null = null;
        const deepLinkedFile =
          findShareableWorkspaceFile(filesList, deepLinkedFileId)
          ?? findShareableWorkspaceFileByPath(filesList, deepLinkedFilePath);

        if (deepLinkedFile) {
          initialPath = deepLinkedFile.path;
          if (isMetaPath(initialPath)) {
            setShowMetaFiles(true);
          }
          if (isAgentMetadataPath(initialPath)) {
            setShowAgentMetaFiles(true);
          }
        }

        if (!initialPath && lastFileStorageKey && typeof window !== 'undefined') {
          try {
            storedPath = window.localStorage.getItem(lastFileStorageKey);
          } catch {
            storedPath = null;
          }
        }

        if (storedPath) {
          const storedFile = filesList.find((file) => file.path === storedPath);
          if (storedFile && storedFile.type !== 'proposal' && storedFile.type !== 'folder') {
            initialPath = storedFile.path;
            if (isMetaPath(initialPath)) {
              setShowMetaFiles(true);
            }
            if (isAgentMetadataPath(initialPath)) {
              setShowAgentMetaFiles(true);
            }
          } else if (lastFileStorageKey && typeof window !== 'undefined') {
            try {
              window.localStorage.removeItem(lastFileStorageKey);
            } catch {
              // ignore
            }
          }
        }

        if (!initialPath) {
          // Most recently edited text doc → root README → tree order, with
          // non-content files excluded (lib/workspace/default-document.ts).
          // Returning visitors are handled above by `storedPath`.
          initialPath = pickDefaultDocument(filesList)?.path ?? null;
        }

        if (initialPath) {
          // A chat-first arrival lands on the chat box: this pick is context
          // only, so keep it out of the panes (see arrivalPreselectRef).
          // Desktop-only, like the mirror it defers — mobile never runs the
          // mirror, so the marker would survive to clobber a later resize.
          if (arrivalChatDefaultRef.current && !isMobileRef.current) arrivalPreselectRef.current = initialPath;
          setSelectedFilePath(initialPath);
          // A ?fileId=/?filePath= deep link is explicit intent: it claims the
          // primary pane even over a restored chat tab. The background
          // heuristic (stored/first file) must not — the selectedFilePath
          // mirror parks those as background tabs instead.
          if (deepLinkedFile && initialPath === deepLinkedFile.path) {
            claimPrimaryWithFile(initialPath, { chatAside: true });
          }
          didSetInitialFileRef.current = true;
        }
      }
      return filesList.length;
    },
    [claimPrimaryWithFile, deepLinkedFileId, deepLinkedFilePath, lastFileStorageKey, projectId, apiFetch]
  );
  reloadFilesRef.current = reloadFiles;

  // Local projects: the sidecar's SSE stream replaces Supabase realtime for
  // tree invalidation (external edits, agent writes, sync). Coalesce bursts.
  useEffect(() => {
    if (!localConfig || !projectId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = localSidecar.subscribe(localConfig, projectId, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reloadFiles(false).catch(() => {}), 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [localConfig, projectId, reloadFiles]);

  // Repo clones mirror files into the doc store asynchronously — minutes for a
  // large repo (the mirror is deliberately paced to keep the DB responsive). A
  // one-shot reload when the clone action returns renders an empty tree that
  // never recovers. Poll until the count is stable, then stop.
  const filesSettlePollRef = useRef(0);
  const pollFilesUntilSettled = useCallback(() => {
    const generation = ++filesSettlePollRef.current;
    void pollFilesUntilSettledLoop({
      reload: () => reloadFiles(false),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      shouldContinue: () => filesSettlePollRef.current === generation,
    });
  }, [reloadFiles]);

  const resetWorkspaceProjectState = useCallback(() => {
    didSetInitialChatRef.current = false;
    didAutoOpenInitialChatRef.current = false;
    setChatsLoaded(false);
    setChatLoadError(null);
    setChatsProjectId(null);
    setChatThreads([]);
    setSelectedChatIndex(0);
    setSelectedChatSurface({ type: 'direct', chatId: null });
    setGroupChatCreateError(null);
    setIsCreatingGroupChat(false);
    setPreferencesLoaded(false);
    setFilesLoaded(false);
    // Back to the optimistic default until the new workspace's payload lands —
    // a previous workspace's non-owner state must not leak into this arrival.
    setIsOwner(true);
  }, []);

  useWorkspaceFileLifecycle({
    projectId,
    initialFilesPayload,
    filesLoaded,
    workspaceFilesLength: workspaceFiles.length,
    projectTitle,
    lastFileStorageKey,
    selectedFilePath,
    showMetaFiles,
    supabaseClient,
    storageUsageEnabled: !isLocalWorkspace && backgroundDataReady,
    reloadFiles,
    didSetInitialFileRef,
    filesChannelRef,
    onProjectReset: resetWorkspaceProjectState,
    setWorkspaceStorageUsage,
    setShowMetaFiles,
    setExpandedFolders,
  });

  const startProjectTitleEdit = useCallback(() => {
    if (!canWrite) return;
    setShowWorkspaceSwitcher(false);
    setEditingTitleValue(projectTitle);
    setIsEditingTitle(true);
  }, [canWrite, projectTitle]);

  const toggleWorkspaceSwitcher = useCallback(() => {
    persistLayoutConfig();
    setShowWorkspaceSwitcher((value) => !value);
  }, [persistLayoutConfig]);

  const saveProjectTitle = useCallback(
    async (newTitle: string) => {
      const trimmed = newTitle.trim();
      if (!projectId || !trimmed || trimmed === projectTitle) {
        setIsEditingTitle(false);
        return;
      }
      setProjectTitle(trimmed);
      setIsEditingTitle(false);
      try {
        const res = await apiFetch('/api/workspace', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, title: trimmed }),
        });
        if (!res.ok) {
          throw new Error('Failed to update workspace title');
        }
        const payload = (await res.json().catch(() => null)) as { project?: { title?: string | null } } | null;
        if (typeof payload?.project?.title === 'string' && payload.project.title.trim()) {
          setProjectTitle(payload.project.title.trim());
        }
      } catch {
        // Revert on failure
        setProjectTitle(projectTitle);
      }
    },
    [projectId, projectTitle]
  );

  const setWorkspaceArchiveStatus = useCallback(
    async (status: 'active' | 'archived') => {
      if (!projectId) return false;
      setIsArchiving(true);
      try {
        const res = await apiFetch('/api/workspace', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, status }),
        });
        if (!res.ok) return false;
        const payload = (await res.json().catch(() => null)) as { project?: { status?: string | null } } | null;
        if (payload?.project?.status === 'active' || payload?.project?.status === 'archived') {
          setProjectStatus(payload.project.status);
        } else {
          setProjectStatus(status);
        }
        return true;
      } catch {
        return false;
      } finally {
        setIsArchiving(false);
      }
    },
    [projectId]
  );

  const archiveWorkspace = useCallback(async () => {
    const ok = await setWorkspaceArchiveStatus('archived');
    if (ok) {
      router.push('/dashboard');
    }
  }, [router, setWorkspaceArchiveStatus]);

  const unarchiveWorkspace = useCallback(async () => {
    await setWorkspaceArchiveStatus('active');
  }, [setWorkspaceArchiveStatus]);

  const { workspaceSwitcherRef, workspaceSwitcherPos, otherWorkspaces, localProjects } = useWorkspaceSwitcher({
    projectId,
    userId: user?.id,
    show: showWorkspaceSwitcher,
    setShow: setShowWorkspaceSwitcher,
  });

  useWorkspaceDropdownDismissal({
    openChatMenuId,
    chatMenuRef,
    setOpenChatMenuId,
    showModelPicker,
    modelPickerRef,
    setShowModelPicker,
    showAppsPicker,
    appsPickerRef,
    setShowAppsPicker,
  });

  const {
    showLocalAgentModal,
    setShowLocalAgentModal,
    localAgentJoinInfo,
    localAgentLoading,
    localAgentError,
    localAgentCopied,
    openLocalAgentModal,
    copyLocalAgentText,
  } = useWorkspaceLocalAgent({
    projectId,
    onOpen: () => {
      setShowShareModal(false);
      setShareDropdown(null);
    },
  });

  // `?modal=` deep-link dispatch: connectOrSignIn return paths (addRepo /
  // addOverleaf / chatApps) and the seeded starter docs' `?modal=connectAgent`
  // link (routed here by the editor's `?`-href handler). One-shot: open, then
  // strip the param — otherwise closing doesn't stick (any re-render re-fires
  // an opener with unstable identity), reloads/shared URLs re-open the modal,
  // and re-clicking the same doc link is a no-op (searchParams never change).
  // Openers live in a ref so the effect keys on the param alone.
  const modalDeepLinkOpenersRef = useRef<Record<string, () => void>>({});
  // All four targets are cloud-workspace connect flows (the file-tree menu
  // gates them the same way) — a local project ignores integration deep links.
  modalDeepLinkOpenersRef.current = isLocalWorkspace
    ? {}
    : {
        addRepo: () => setShowAddRepoModal(true),
        addOverleaf: () => setShowAddOverleafModal(true),
        chatApps: () => openSettingsTab('chatApps'),
        connectAgent: () => void openLocalAgentModal(),
        openWith: () => setShowOpenWithModal(true),
      };
  useEffect(() => {
    const open = modalDeepLinkParam ? modalDeepLinkOpenersRef.current[modalDeepLinkParam] : null;
    if (!open) return;
    open();
    const url = new URL(window.location.href);
    url.searchParams.delete('modal');
    window.history.replaceState(null, '', url);
  }, [modalDeepLinkParam]);

  // Clicking a connected agent's chip opens its settings (Suggest only switch).
  const [localAgentModeAgentId, setLocalAgentModeAgentId] = useState<string | null>(null);
  const [localAgentModeSaving, setLocalAgentModeSaving] = useState(false);
  const [localAgentModeError, setLocalAgentModeError] = useState<string | null>(null);
  // Optimistic value while the realtime presence row catches up.
  const [localAgentModeOptimistic, setLocalAgentModeOptimistic] = useState<boolean | null>(null);
  const handleLocalAgentSuggestOnlyChange = useCallback(
    async (agentId: string, next: boolean) => {
      setLocalAgentModeSaving(true);
      setLocalAgentModeError(null);
      setLocalAgentModeOptimistic(next);
      try {
        const response = await apiFetch('/api/workspace/local-agent/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, agentId, suggestOnly: next }),
        });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? 'Unable to update agent mode.');
      } catch (error) {
        setLocalAgentModeOptimistic(null);
        setLocalAgentModeError(error instanceof Error ? error.message : 'Unable to update agent mode.');
      } finally {
        setLocalAgentModeSaving(false);
      }
    },
    [projectId],
  );

  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [chatLoadError, setChatLoadError] = useState<string | null>(null);
  const [chatsProjectId, setChatsProjectId] = useState<string | null>(null);
  // The chat-first landing is the OWNER's (founder, 2026-08-05): anyone
  // arriving at a workspace they don't own has to look at it first before
  // chatting, so non-owners get swapped to the default document. Access
  // resolves async (the files payload carries canWrite/isOwner), so the swap
  // fires only while the untouched arrival default is still up. Read-only
  // visitors always swap (chat isn't theirs to drive); can-write members only
  // on a first visit — a stored chat-only layout is their own choice.
  // A workspace with no DOCUMENT to show (a local chat-share mirror; or one
  // holding only folders/proposals) can't be swapped onto: there the visitor
  // came for the conversation, so land on the newest real chat instead of an
  // empty editor.
  useEffect(() => {
    const swap = shouldSwapArrivalToDocument({
      isOwner,
      canWrite,
      chatArrivalDefault: arrivalChatDefaultRef.current,
      hadStoredLayout: arrivalHadStoredLayoutRef.current,
      // An EXPLICIT chat link (?chatId= / ?chat=1) lands on chat even for
      // guests (the mirror-chat share case) — only the plain default gets
      // swapped. draft-* ids are SESSION-LOCAL: a URL copied from the owner's
      // address bar carries their dead draft id, no chat intent for a guest.
      explicitChatIntent:
        deepLinkChatIntent && !String(deepLinkedChatId ?? '').startsWith('draft-'),
    });
    if (!swap) return;
    if (!filesLoaded) return;
    // Gate on having something OPENABLE, not on the row count: a workspace of
    // only folders/proposals has rows but no document, and swapping there
    // would strand the visitor on an empty editor ("Nothing open").
    const firstDocPath = pickDefaultDocument(workspaceFiles)?.path ?? '';
    if (!firstDocPath) {
      if (!chatsLoaded) return;
      const mirror = chatThreads.find((thread) => !thread.chat.id.startsWith('draft-'));
      if (mirror) {
        arrivalChatDefaultRef.current = false;
        void openChatByIdRef.current(mirror.chat.id);
      }
      return; // nothing to open: the arrival hero is all there is
    }
    arrivalChatDefaultRef.current = false;
    arrivalSwappedToDocRef.current = true;
    setOpenPanels((prev) => (prev.length === 1 && prev[0] === 'chat' ? ['editor'] : prev));
    // Desktop chat visibility lives in the panes: demote any active chat tab
    // to its nearest file tab so the visitor lands on the document. A fresh
    // guest has NO file tabs yet — demotion alone lands on '' and the chat
    // hero stays up — so open the workspace's first document instead.
    setEditorPanes((prev) => {
      let changed = false;
      const next = prev.map((pane) => {
        if (!isChatTab(pane.active)) return pane;
        changed = true;
        const files = pane.tabs.filter((t) => !isChatTab(t));
        return { ...pane, active: files[files.length - 1] ?? '' };
      });
      // Nothing left showing (a fresh guest may have NO tabs at all — the
      // chat hero renders without a pane tab): open the first document.
      if (!next.some((pane) => pane.active)) {
        // Outside the updater (React may run it twice): the doc body resolves
        // the file from selectedFilePath, not the pane tab alone.
        queueMicrotask(() => setSelectedFilePath(firstDocPath));
        return openPaneTab(next, next[0]?.id ?? PRIMARY_PANE_ID, firstDocPath);
      }
      return changed ? next : prev;
    });
    // The visitor lands on the document with the file tree open — arriving at
    // someone else's workspace means orienting by seeing what was shared.
    setOpenLeftRail('project');
  }, [canWrite, isOwner, deepLinkChatIntent, deepLinkedChatId, filesLoaded, workspaceFiles, chatsLoaded, chatThreads]);
  // last_message_at recorded when the client marked a chat read — lets a stale
  // chat-list refresh be ignored when it tries to re-raise a count we cleared.
  const readMarkedAtByChatIdRef = useRef<Record<string, string>>({});
  const clearUnreadForChat = useCallback((chatId: string | null | undefined) => {
    if (!chatId) return;
    setChatThreads((prev) =>
      prev.map((thread) => {
        if (thread.chat.id === chatId && Math.max(0, Number(thread.chat.unread_count ?? 0)) > 0) {
          if (thread.chat.last_message_at) {
            readMarkedAtByChatIdRef.current[chatId] = thread.chat.last_message_at;
          }
          return { ...thread, chat: { ...thread.chat, unread_count: 0 } };
        }
        return thread;
      })
    );
  }, []);
  // One-shot history fetch for a chat we haven't loaded yet. Once useChat is
  // mounted for the active chat, it owns the message list — we deliberately
  // do NOT re-fetch over REST while a chat is live. The old backfill /
  // refetch helpers were the second source of truth that caused duplicate
  // bubbles and ghost speaker attribution. If we ever need recovery for
  // missed messages while backgrounded, the SSE transport's resume path
  // (see SundialChatTransport.reconnectToStream) is the correct layer.
  const ensureChatMessagesLoaded = useCallback(async (
    chatId: string,
    // `fromSequence` — the submitted user row's sequence — extends the read
    // back to cover a whole turn. An uncapped turn persists far more rows than
    // one page, so a reconcile after a cold reattach would otherwise leave the
    // turn's middle (its announcements and tool rows) in neither the replayed
    // stream nor this page: permanently missing from the transcript.
    options?: { force?: boolean; fromSequence?: number; findTurnStart?: boolean },
  ): Promise<ChatMessage[]> => {
    if (!chatId || isDraftChatId(chatId)) return [];
    const cached = chatMessagesByIdRef.current[chatId];
    if (cached && cached.length > 0 && !options?.force) return cached;
    const existingPromise = chatMessageLoadPromisesRef.current.get(chatId);
    if (existingPromise && !options?.force) return existingPromise;
    let loadPromise: Promise<ChatMessage[]> | null = null;
    loadPromise = (async () => {
      const params = new URLSearchParams({ chatId, limit: String(INITIAL_CHAT_MESSAGE_LIMIT) });
      let normalized: ChatMessage[];
      try {
        const res = await apiFetch(`/api/workspace/messages?${params.toString()}`);
        if (!res.ok) return chatMessagesByIdRef.current[chatId] ?? [];
        const payload = (await res.json()) as { messages: ChatMessage[] };
        normalized = (payload.messages ?? []).map(normalizeChatMessage);
        if (typeof options?.fromSequence === 'number' || options?.findTurnStart) {
          normalized = await backfillTurnRows(normalized, {
            chatId,
            fromSequence: options.fromSequence,
            findTurnStart: options.findTurnStart,
            fetchImpl: apiFetch,
            normalize: normalizeChatMessage,
            pageSize: INITIAL_CHAT_MESSAGE_LIMIT,
          });
        }
      } catch {
        // Network failure — keep whatever we already have rather than rejecting
        // (callers use `void`/`.then` without a catch).
        return chatMessagesByIdRef.current[chatId] ?? [];
      }
      // Only commit if a newer force-refresh hasn't superseded us, so a slow
      // stale load can't clobber fresh history.
      if (chatMessageLoadPromisesRef.current.get(chatId) === loadPromise) {
        setChatMessagesById((prev) => ({ ...prev, [chatId]: normalized }));
      }
      return normalized;
    })().finally(() => {
      if (chatMessageLoadPromisesRef.current.get(chatId) === loadPromise) {
        chatMessageLoadPromisesRef.current.delete(chatId);
      }
    });
    chatMessageLoadPromisesRef.current.set(chatId, loadPromise);
    return loadPromise;
  }, []);
  const markChatRead = useCallback(async (chatId: string | null | undefined, lastReadSequence?: number | null) => {
    if (!chatId || isDraftChatId(chatId) || typeof lastReadSequence !== 'number') return;
    const previousMarkedSequence = lastMarkedReadSequenceByChatIdRef.current[chatId] ?? 0;
    if (lastReadSequence <= previousMarkedSequence) return;
    lastMarkedReadSequenceByChatIdRef.current[chatId] = lastReadSequence;
    try {
      const res = await apiFetch('/api/workspace/messages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, lastReadSequence }),
      });
      if (!res.ok) {
        if ((lastMarkedReadSequenceByChatIdRef.current[chatId] ?? 0) <= lastReadSequence) {
          lastMarkedReadSequenceByChatIdRef.current[chatId] = previousMarkedSequence;
        }
        return;
      }
      const payload = (await res.json().catch(() => null)) as { lastReadSequence?: number } | null;
      const persistedSequence =
        typeof payload?.lastReadSequence === 'number' ? payload.lastReadSequence : lastReadSequence;
      lastMarkedReadSequenceByChatIdRef.current[chatId] = Math.max(
        lastMarkedReadSequenceByChatIdRef.current[chatId] ?? 0,
        persistedSequence
      );
    } catch {
      if ((lastMarkedReadSequenceByChatIdRef.current[chatId] ?? 0) <= lastReadSequence) {
        lastMarkedReadSequenceByChatIdRef.current[chatId] = previousMarkedSequence;
      }
      // Ignore read-mark failures; local UI is still cleared and the next refresh can retry.
    }
  }, []);
  const loadChatThreads = useCallback(async (): Promise<ChatThread[]> => {
    if (!projectId) return [];
    // Path-grant-only guests skip chats entirely (the route would return an
    // empty list); chat-grant guests fetch — the route scopes the list to
    // exactly their granted chats.
    if (isScopedGuestRef.current && chatGrantsRef.current.length === 0) return [];
    const activeProjectId = projectId;
    try {
      const params = new URLSearchParams({ projectId: activeProjectId });
      const res = await apiFetch(`/api/workspace/chats?${params.toString()}`);
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setChatLoadError(
          typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error
            : 'Failed to load chats'
        );
        return [];
      }
      const payload = (await res.json()) as { chats: ChatThread[] };
      const visibleCurrentChatId =
        isChatVisibleRef.current && document.visibilityState === 'visible'
          ? currentChatRef.current?.id ?? null
          : null;
      let chats = payload.chats ?? [];
      setChatLoadError(null);
      setChatThreads((prev) => {
        chats = chats.map((thread) => {
          if (Math.max(0, Number(thread.chat.unread_count ?? 0)) === 0) return thread;
          // Zero the chat you're looking at, and ignore a stale refresh that
          // re-raises a chat you just read (no newer message since you read it).
          const readAt = readMarkedAtByChatIdRef.current[thread.chat.id];
          const staleReRaise =
            readAt && (!thread.chat.last_message_at || thread.chat.last_message_at <= readAt);
          if (thread.chat.id === visibleCurrentChatId || staleReRaise) {
            return { ...thread, chat: { ...thread.chat, unread_count: 0 } };
          }
          return thread;
        });
        // Preserve in-flight optimistic drafts so a concurrent server refresh
        // doesn't wipe them out before promoteDraftChat resolves.
        const drafts = prev.filter((thread) => isDraftChatId(thread.chat.id));
        return drafts.length > 0 ? [...chats, ...drafts] : chats;
      });
      setChatsProjectId(activeProjectId);
      // Server truth refreshes the confirmed watch map too — listen_comments,
      // another tab, or any server-side change would otherwise leave a stale
      // entry for a later failed toggle to "revert" to. Skipped while a toggle
      // PATCH is in flight: this read may predate the value about to land.
      for (const thread of chats) {
        if (!commentWatchPendingRef.current.has(thread.chat.id)) {
          commentWatchConfirmedRef.current.set(thread.chat.id, thread.chat.comment_watch_path ?? null);
        }
      }
      return chats;
    } catch {
      setChatLoadError('Failed to load chats');
      return [];
    } finally {
      setChatsLoaded(true);
    }
    // Reads chat visibility via openPanelsRef so toggling panels doesn't churn
    // this callback's identity (which would re-subscribe the realtime channel).
  }, [projectId]);

  const workspaceRealtimeChatIdsKey = useMemo(() => {
    if (chatsProjectId !== projectId) return '';
    return Array.from(
      new Set(
        chatThreads
          .map((thread) => thread.chat.id)
          .filter((chatId): chatId is string => Boolean(chatId) && !isDraftChatId(chatId))
      )
    )
      .sort()
      .join(',');
  }, [chatThreads, chatsProjectId, projectId]);
  const workspaceRealtimeChatIds = useMemo(
    () => (workspaceRealtimeChatIdsKey ? workspaceRealtimeChatIdsKey.split(',') : []),
    [workspaceRealtimeChatIdsKey]
  );

  useWorkspaceChatListEffects<ChatThread>({
    projectId,
    isChatVisible,
    workspaceRealtimeChatIds,
    supabaseClient,
    currentChatRef,
    loadChatThreads,
    setChatsLoaded,
  });

  // Local first-message naming completion (see nameLocalChatFromFirstMessage):
  // adopt the settled title immediately — rail, header, and tab labels all
  // derive from chatThreads, and waiting for the 10s list poll left them on
  // "New chat" long after the title landed in the sidecar store. Unset-guarded
  // like the sidecar CAS, so an optimistic in-flight rename is never clobbered.
  useEffect(() => {
    if (!isLocalWorkspace) return;
    const handleTitled = (event: Event) => {
      const { chatId, title } = (event as CustomEvent<{ chatId?: string; title?: string }>).detail ?? {};
      if (!chatId || !title) return;
      setChatThreads((prev) =>
        prev.map((thread) =>
          // Same unnamed set as the sidecar CAS: blank or the legacy defaults.
          thread.chat.id === chatId && ['', 'New Chat', 'New chat'].includes(thread.chat.title?.trim() ?? '')
            ? { ...thread, chat: { ...thread.chat, title } }
            : thread,
        ),
      );
    };
    window.addEventListener('sundial:local-chat-titled', handleTitled);
    return () => window.removeEventListener('sundial:local-chat-titled', handleTitled);
  }, [isLocalWorkspace]);



  const {
    notice: workspaceAppNotice,
    showNotice: showWorkspaceAppNotice,
    clearNotice: clearWorkspaceAppNotice,
  } = useWorkspaceNotice();

  const loadConnectedApps = useCallback(async () => {
    if (!user?.id) {
      setConnectedApps([]);
      setConnectedAppsLoading(false);
      setConnectedAppsLoaded(true);
      return;
    }

    setConnectedAppsLoading(true);
    try {
      const response = await fetch('/api/user/apps', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Failed to load connected apps.');
      }
      const payload = (await response.json()) as { apps?: ConnectedAppSummary[] };
      setConnectedApps(Array.isArray(payload.apps) ? payload.apps : []);
    } catch {
      setConnectedApps([]);
    } finally {
      setConnectedAppsLoading(false);
      setConnectedAppsLoaded(true);
    }
  }, [user?.id]);

  useEffect(() => {
    setConnectedAppsLoaded(false);
    setConnectedApps([]);
  }, [user?.id]);

  useEffect(() => {
    const appsVisible = showAppsPicker || (showSettingsModal && settingsTab === 'apps');
    if (!appsVisible || connectedAppsLoaded || connectedAppsLoading) return;
    void loadConnectedApps();
  }, [
    connectedAppsLoaded,
    connectedAppsLoading,
    loadConnectedApps,
    settingsTab,
    showAppsPicker,
    showSettingsModal,
  ]);

  // Single load of the user's saved model preferences. This is the one place
  // they are read; the default model seeds the next-chat model and the Settings
  // picker, the autocomplete override feeds the Settings picker beside it, and
  // this flips `preferencesLoaded` (the startup gate) independently of the
  // Settings panel ever opening.
  useEffect(() => {
    // Wait for Clerk to settle: a signed-in user is briefly null while
    // hydrating, and treating that as anonymous would seed new chats (and the
    // startup auto-chat) with the app default before the saved one loads.
    if (!hasMounted || !isAuthLoaded) return;
    if (!user?.id) {
      setSavedDefaultModel(DEFAULT_MODEL_REF);
      setSavedAutocompleteModel(null);
      // No account to read from — the per-browser flag store (URL /
      // localStorage) is all an anonymous visitor has.
      setSavedFlags({ ...flagDefaults(), autocomplete_enabled: isAutocompleteEnabled() });
      setSavedAutocompleteMode(getAutocompleteMode());
      setPreferencesLoaded(true);
      return;
    }
    let cancelled = false;
    const settle = (
      saved: string,
      autocomplete: string | null = null,
      // Fetch-failure fallback: keep whatever the flag store already says
      // rather than force-disabling a browser that had a flag on.
      flags: Record<string, boolean> = {
        ...flagDefaults(),
        autocomplete_enabled: isAutocompleteEnabled(),
        pdf_comments_enabled: getFlag('pdf_comments_enabled'),
      },
      // Fetch-failure fallback: keep whatever the store already says.
      mode: AutocompleteMode = getAutocompleteMode(),
    ) => {
      if (cancelled) return;
      setSavedDefaultModel(saved);
      setSavedAutocompleteModel(autocomplete);
      setAutocompleteMode(mode);
      setSavedAutocompleteMode(mode);
      // An explicit `?autocomplete=on|off` outranks the account for THIS load
      // only: it sits in the store's in-memory cache, so hydration skips that
      // key to not clobber it. Nothing is persisted — a link must never
      // durably opt anyone in — and the Settings switch keeps showing the
      // saved account value, the only thing a toggle there changes.
      const urlOverride = urlAutocompleteOverrideRef.current;
      hydrateFlags(flags, urlOverride !== null ? ['autocomplete_enabled'] : []);
      setSavedFlags(flags);
      // Only seed the next-chat model while it's still the untouched app default
      // — never clobber a model the user (or an open chat) already chose.
      setPreferredChatModel((prev) => (prev === DEFAULT_MODEL_REF ? saved : prev));
      setPreferencesLoaded(true);
    };
    fetch('/api/user/preferences')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(
        (prefs: {
          default_model?: string | null;
          autocomplete_model?: string | null;
          autocomplete_mode?: string | null;
          flags?: Record<string, boolean>;
        }) =>
          settle(
            normalizeChatModelRef(prefs.default_model?.trim() || DEFAULT_MODEL_REF),
            typeof prefs.autocomplete_model === 'string' ? prefs.autocomplete_model : null,
            resolveFlags(prefs.flags),
            isAutocompleteMode(prefs.autocomplete_mode) ? prefs.autocomplete_mode : DEFAULT_AUTOCOMPLETE_MODE,
          )
      )
      .catch(() => settle(DEFAULT_MODEL_REF));
    return () => {
      cancelled = true;
    };
  }, [hasMounted, isAuthLoaded, user?.id, projectId]);

  const handleAutocompleteModeChange = useCallback((mode: AutocompleteMode) => {
    setSavedAutocompleteMode(mode);
    // Mirror into the client store so open editors switch behavior live.
    setAutocompleteMode(mode);
  }, []);

  const handleFlagChange = useCallback((key: string, enabled: boolean) => {
    setSavedFlags((prev) => ({ ...(prev ?? flagDefaults()), [key]: enabled }));
    // Mirror into the client flag store so open editors follow without a
    // reload — e.g. the Monaco provider reads it synchronously per request.
    setFlag(key, enabled);
  }, []);

  const handlePreferencesSectionChange = useCallback(
    (values: { defaultModel: string }) => {
      const next = values.defaultModel?.trim();
      if (!next) return;
      const normalized = normalizeChatModelRef(next);
      setSavedDefaultModel(normalized);
      setPreferredChatModel(normalized);
    },
    []
  );

  const renderAppsPanel = (layout: 'desktop' | 'mobile') => (
    <AppsPanel
      layout={layout}
      connectedApps={connectedApps}
      connectedAppsLoading={connectedAppsLoading}
      // Settings is a workspace-level action — no chat to resume. (The composer
      // picker passes the real chat id so connecting mid-conversation resumes.)
      currentChatId={null}
      reloadConnectedApps={loadConnectedApps}
    />
  );

  const renderPreferencesPanel = (layout: 'desktop' | 'mobile') => {
    const isMobileLayout = layout === 'mobile';

    return (
      <div className={isMobileLayout ? 'px-4 py-3' : 'flex-1 overflow-auto px-4 py-4'}>
        <div className="space-y-4">
          <PreferencesSection
            projectId={projectId}
            value={savedDefaultModel}
            autocompleteValue={savedAutocompleteModel}
            flags={savedFlags}
            autocompleteMode={savedAutocompleteMode}
            onChange={handlePreferencesSectionChange}
            onAutocompleteChange={setSavedAutocompleteModel}
            onFlagChange={handleFlagChange}
            onAutocompleteModeChange={handleAutocompleteModeChange}
            canSavePreferences={Boolean(user?.id)}
          />
        </div>
      </div>
    );
  };

  const renderShortcutsPanel = (layout: 'desktop' | 'mobile') => (
    <div className={layout === 'mobile' ? 'px-4 py-3' : 'flex-1 overflow-auto px-4 py-4'}>
      <ShortcutsSection desktopShell={desktopTabs} />
    </div>
  );

  const renderContextOverviewPanel = (layout: 'desktop' | 'mobile') => {
    const isMobileLayout = layout === 'mobile';
    const containerClassName = isMobileLayout ? 'px-4 py-3' : 'flex-1 overflow-auto px-4 py-4';

    return (
      <div className={containerClassName}>
        <div className="space-y-4">
          <section className="rounded-2xl border border-stone-200 bg-white p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
              Chat
            </div>
            {currentChat ? (
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Type</div>
                    <div className="mt-1 text-sm font-medium text-stone-800">
                      {currentChatUsesGroupPresentation ? 'Group chat' : 'Direct chat'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Default responder</div>
                    <div className="mt-1 text-sm font-medium text-stone-800">Sundial Agent</div>
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Runtime</div>
                    <div className="mt-1 text-sm font-medium text-stone-800">
                      {formatLoopStatusLabel(currentLoopSummary?.status ?? (currentChatStatus === 'working' || currentChatStatus === 'starting' ? 'running' : 'stopped'))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Last activity</div>
                    <div className="mt-1 text-sm font-medium text-stone-800">
                      {currentChat.last_message_at ? formatRelativeTime(currentChat.last_message_at) : 'No activity yet'}
                    </div>
                  </div>
                </div>
                <div className="text-xs leading-5 text-stone-500">
                  {currentChatUsesGroupPresentation
                    ? 'Group responder selection is explicit per message; no chat-space links are persisted in this wave.'
                    : 'This chat stays scoped to the current workspace and uses the existing direct-chat runtime path.'}
                </div>
              </div>
            ) : (
              <div className="mt-3 text-sm text-stone-500">Select a chat to inspect its participants and runtime.</div>
            )}
          </section>

          <section className="rounded-2xl border border-stone-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                Runtime
              </div>
              {currentLoopSummary ? (
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${getLoopStatusPillClass(currentLoopSummary.status)}`}>
                  {formatLoopStatusLabel(currentLoopSummary.status)}
                </span>
              ) : null}
            </div>
            {currentChat ? (
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Session</div>
                    <div className="mt-1 text-sm font-medium text-stone-800">
                      {currentSessionId ? clipText(currentSessionId, 18) : 'No active session'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Runtime</div>
                    <div className="mt-1 text-sm font-medium text-stone-800">
                      {formatSessionDurationSeconds(currentChatRuntimeSeconds) ?? 'Not available yet'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Cost</div>
                    <div className="mt-1 text-sm font-medium text-stone-800">
                      {formatCostUsd(currentSessionMetrics?.totalCostUsd) ?? 'Not available yet'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Latest step</div>
                    <div className="mt-1 text-sm font-medium text-stone-800">
                      {currentLoopActorPhase ?? 'No loop activity yet'}
                    </div>
                  </div>
                </div>
                {currentLoopSummary ? (
                  <div className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-3 text-xs leading-5 text-stone-500">
                    {`iter ${currentLoopSummary.turnCount} · ${formatLoopBudgetValue(currentLoopSummary.budgetType, currentLoopSummary.budgetUsed)} / ${formatLoopBudgetValue(currentLoopSummary.budgetType, currentLoopSummary.budgetLimit)}`}
                    {currentLoopSummary.stopReason && currentLoopSummary.status !== 'running'
                      ? ` · ${clipText(currentLoopSummary.stopReason, 120)}`
                      : ''}
                  </div>
                ) : (
                  <div className="text-sm text-stone-500">No loop runs recorded for this chat yet.</div>
                )}
              </div>
            ) : (
              <div className="mt-3 text-sm text-stone-500">Select a chat to inspect session and loop state.</div>
            )}
          </section>

          <section className="rounded-2xl border border-stone-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                Participants
              </div>
              <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-[11px] font-medium text-stone-500">
                {formatCountLabel(Math.max(0, currentChatParticipants.length), 'participant', 'participants')}
              </span>
            </div>
            {currentChatParticipants.length > 0 ? (
              <div className="mt-3 grid gap-2">
                {currentChatParticipants.map((participant) => {
                  const collaborator =
                    participant.user_id && participant.user_id === user?.id
                      ? workspaceChatCollaborators.find((entry) => entry.id === participant.user_id) ?? null
                      : (participant.user_id ? collaboratorById.get(participant.user_id) ?? null : null);
                  const metadata = getParticipantMetadata(participant);
                  const label = resolveTranscriptUserLabel({
                    authorUserId: participant.user_id,
                    currentUserId: user?.id ?? null,
                    collaborator: collaborator
                      ? {
                          name: collaborator.name,
                          username: collaborator.username ?? null,
                        }
                      : null,
                    transportAuthorDisplayName:
                      typeof metadata?.transport_display_name === 'string'
                        ? metadata.transport_display_name
                        : null,
                    transportAuthorUsername:
                      typeof metadata?.transport_username === 'string'
                        ? metadata.transport_username
                        : null,
                  });
                  const displayName =
                    participant.user_id && participant.user_id === user?.id
                      ? 'You'
                      : collaborator?.name ?? label;

                  return (
                    <div key={participant.id} className="flex items-center gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-3 py-3">
                      <HumanBubble
                        id={participant.user_id ?? participant.id}
                        name={displayName}
                        imageUrl={collaborator?.imageUrl ?? null}
                        initials={collaborator?.initials ?? getInitials(displayName)}
                        label={label}
                        size="md"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-stone-800">
                          {displayName}
                        </div>
                        <div className="truncate text-[11px] text-stone-500">Human participant</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="mt-3 text-sm text-stone-500">Participants will appear here once the chat is loaded.</div>
            )}
          </section>

        </div>
      </div>
    );
  };


  const renderContextTabButton = (
    tab: SettingsTab,
    label: string,
    icon: ReactNode,
    onClick?: () => void,
  ) => (
    <button
      type="button"
      onClick={onClick ?? (() => setSettingsTab(tab))}
      className={`group/tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
        settingsTab === tab
          ? 'bg-stone-200/70 text-stone-800'
          : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
      }`}
    >
      <span className={`shrink-0 transition-colors ${settingsTab === tab ? 'text-orange' : 'text-stone-400 group-hover/tab:text-orange'}`}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );

  const chatThreadsForCurrentProject = useMemo(
    () => (chatsProjectId === projectId ? chatThreads : []),
    [chatThreads, chatsProjectId, projectId]
  );

  // Feed the Review panel's Advanced file/chat pickers and the ⌘K palette.
  const reviewFiles = useMemo(
    () => workspaceFiles.filter((file) => file.type !== 'folder').map((file) => file.path),
    [workspaceFiles],
  );
  const reviewChats = useMemo(
    () => chatThreadsForCurrentProject.map((thread) => ({ id: thread.chat.id, title: thread.chat.title?.trim() || 'New chat' })),
    [chatThreadsForCurrentProject],
  );

  useInitialWorkspaceChatSelection<ChatThread>({
    projectId,
    chatThreadsForCurrentProject,
    selectedChatIndex,
    deepLinkedChatId,
    didSetInitialChatRef,
    setSelectedChatIndex,
    setSelectedChatSurface,
  });

  const selectedDirectChatId = selectedChatSurface.chatId;
  const currentThread =
    selectedDirectChatId
      ? chatThreadsForCurrentProject.find((thread) => thread.chat.id === selectedDirectChatId) ?? null
      : null;
  const currentAssistant = null;
  const currentChat = currentThread?.chat ?? null;
  const currentChatKind = getChatKind(currentChat);
  const currentChatHasTextTransport = hasTextTransport(currentChat);
  const currentChatUsesGroupPresentation = usesGroupChatPresentation(
    currentChatKind,
    currentChat
  );
  const currentChatParticipants = useMemo(
    () => getChatParticipants(currentChat),
    [currentChat]
  );
  const currentChatAssistantById = useMemo(() => new Map<string, { name: string; emoji: string }>(), []);
  const currentDefaultResponder = null;
  const currentResponderLabel: string | null = null;
  const currentChatId = currentChat?.id ?? null;
  // Read-only external agent session open in the chat pane: no composer —
  // the banner's Import/Resume adopts it as a real chat first.
  const currentChatExternal = getExternalSession(currentChat);
  const [externalActionBusy, setExternalActionBusy] = useState(false);
  const [externalActionError, setExternalActionError] = useState<string | null>(null);
  const adoptExternalSession = useCallback(
    async (external: ExternalSessionRef) => {
      setExternalActionBusy(true);
      setExternalActionError(null);
      try {
        const res = await apiFetch('/api/workspace/external-sessions/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: external.agent, sessionId: external.session_id }),
        });
        const payload = (await res.json().catch(() => null)) as
          | { chat?: { chat?: { id?: string } }; error?: string }
          | null;
        const newChatId = payload?.chat?.chat?.id;
        if (!res.ok || !newChatId) {
          setExternalActionError(payload?.error || 'Could not import this session.');
          return;
        }
        // The adopted session leaves the external listing and re-enters as a
        // real chat — refresh and land there (composer focused for Resume).
        await openChatByIdRef.current(newChatId);
      } catch {
        setExternalActionError('Could not import this session.');
      } finally {
        setExternalActionBusy(false);
      }
    },
    [apiFetch]
  );

  // Rehydrate a draft stashed before an anon→sign-in reload (see stashPendingDraft).
  // Runs once a chat is mounted; skips if the user already typed something new.
  const pendingDraftRestored = useRef(false);
  useEffect(() => {
    if (pendingDraftRestored.current || !projectId || !currentChatId) return;
    const text = takePendingDraft(projectId);
    if (text === null) return;
    pendingDraftRestored.current = true;
    if (!(messageInputByChatIdRef.current[currentChatId] ?? '').trim()) {
      setStoredMessageDraft(currentChatId, text, true);
    }
  }, [projectId, currentChatId, setStoredMessageDraft]);

  const {
    showShareModal,
    setShowShareModal,
    shareInfo,
    shareError,
    inviteEmail,
    setInviteEmail,
    inviteRole,
    setInviteRole,
    shareBusyAction,
    shareDropdown,
    setShareDropdown,
    copyNotice,
    canManageShare,
    canInviteShare,
    canShowShareControls,
    pendingEmailInvites,
    shareStatus,
    workspaceAudience,
    handleOpenShare,
    handleCopyInvite,
    handleCreateLinkInvite,
    handleCreateEmailInvite,
    handleVisibilityChange: changeVisibility,
    handlePublicAccessChange: changePublicAccess,
    handleUpdateMemberRole,
    handleRemoveMember,
    handleResendShareInvite,
    handleRevokeShareInvite,
    handleOpenTeamPermissions,
  } = useWorkspaceShare({
    // Cloud ACL sharing doesn't apply to a local folder — local shares go
    // through the local share modal instead.
    projectId: cloudProjectId ?? '',
    projectKind,
    workspaceRouteId,
    currentChatId,
    user,
    router,
    openSignIn,
    eagerLoad: backgroundDataReady,
  });
  // Local sharing: any tree node (or the whole project) shares to a cloud
  // workspace via the sidecar bridge — invites live on that workspace's ACL,
  // so per-file / per-subfolder audiences are separate shares.
  const [localShareScope, setLocalShareScope] = useState<ShareScope | null>(null);
  // Cloud per-path sharing (path_shares): grant one file/folder to people
  // outside the workspace. Loaded for share managers only (the API 403s
  // everyone else, which the hook treats as "no badges").
  const [pathShareScope, setPathShareScope] = useState<{ path: string; kind: 'file' | 'folder' } | null>(null);
  const {
    shares: cloudPathShares,
    sharedPaths: cloudSharedScopePaths,
    loaded: cloudPathSharesLoaded,
    refresh: refreshCloudPathShares,
  // `canInviteShare` is optimistic-true before /api/workspace/share answers
  // (it 403s for pshare guests), so scoped guests are excluded explicitly.
  } = usePathShares(
    cloudProjectId,
    !isLocalWorkspace && canInviteShare && !isScopedGuest && (backgroundDataReady || Boolean(pathShareScope)),
  );
  const { shares: localShares, refreshShares: refreshLocalShares } = useLocalShares(
    localConfig,
    isLocalWorkspace ? projectId : null,
  );
  // The sidecar knows what's SYNCED (enabled), not who can see it — the
  // audience lives in the backing workspace's grants, and the share modal can
  // empty it without stopping the sync. Read those grants so a synced-but-
  // private scope stops reading "Shared with people" (see localSharedScopeMap).
  // Only enabled grants-model rows (share_id names the union share row) may
  // pick the backing id — a stale or legacy row first in the list would read
  // grants from the wrong workspace and mark live scopes private.
  const localBackingWorkspaceId = isLocalWorkspace
    ? (localShares.find((share) => share.enabled && share.share_id)?.workspace_id ?? null)
    : null;
  // No signed-in gate (like useLocalShares): the packaged app's auth is the
  // proxy-injected sd_ bearer, not a Clerk user. Signed-out just 403s into
  // loaded=false, and the sync-state answer stands.
  const {
    sharedPaths: localBackingAudience,
    linkSharedPaths: localBackingLinkPaths,
    loaded: localBackingAudienceLoaded,
    refresh: refreshLocalBackingAudience,
  } = usePathShares(localBackingWorkspaceId, Boolean(localBackingWorkspaceId));
  // A PROJECT scope's audience lives in the backing workspace's ACL (members,
  // invites, org) plus the link lane — a path-grants read can't see it.
  const { audience: localBackingAclAudience, lane: localBackingAclLane, refresh: refreshLocalBackingAcl } =
    useWorkspaceAudienceProbe(localBackingWorkspaceId);
  const localSharedScopePaths = useMemo(
    () =>
      localSharedScopeMap(
        localShares,
        localBackingAudienceLoaded ? localBackingAudience : null,
        localBackingAclAudience,
        {
          // Lane answers ride the same authoritative reads: unloaded = no
          // lane claim, the scope stays 'shared' (the pre-lane icon).
          linkPaths: localBackingAudienceLoaded ? localBackingLinkPaths : null,
          projectLane: localBackingAclLane,
        },
      ),
    [localShares, localBackingAudience, localBackingAudienceLoaded, localBackingAclAudience, localBackingAclLane, localBackingLinkPaths],
  );
  // Tree badges consume only the recorded kind — identical to before (the
  // blue-dot logic itself is untouched).
  const localSharedScopeKinds = useMemo(
    () => new Map(Array.from(localSharedScopePaths, ([p, v]) => [p, v.kind] as const)),
    [localSharedScopePaths],
  );

  const openShare = useCallback(() => {
    if (isLocalWorkspace) setLocalShareScope({ kind: 'project', path: '' });
    else handleOpenShare();
  }, [isLocalWorkspace, handleOpenShare]);
  // Defined after openShare — the menu's Share entry is the workspace-level
  // share entry point (the top bar carries no Share button).
  const workspaceSwitcherMenu = showWorkspaceSwitcher ? (
    <WorkspaceSwitcherMenu
      position={workspaceSwitcherPos}
      otherWorkspaces={otherWorkspaces}
      localProjects={localProjects}
      canWrite={canWrite}
      isArchived={isArchived}
      isArchiving={isArchiving}
      archiveActionLabel={archiveActionLabel}
      canArchive={!isLocalWorkspace}
      onShare={
        canShowShareControls
          ? () => {
              setShowWorkspaceSwitcher(false);
              openShare();
            }
          : undefined
      }
      shareStatus={isLocalWorkspace ? null : shareStatus}
      onSwitchWorkspace={(workspaceId) => {
        handleWorkspaceSwitch(workspaceId);
        setShowWorkspaceSwitcher(false);
      }}
      onRename={startProjectTitleEdit}
      onNewWorkspace={() => {
        persistLayoutConfig();
        setShowWorkspaceSwitcher(false);
      }}
      onDashboard={() => {
        persistLayoutConfig();
        setShowWorkspaceSwitcher(false);
      }}
      onToggleArchive={() => {
        setShowWorkspaceSwitcher(false);
        if (isArchived) {
          void unarchiveWorkspace();
        } else {
          void archiveWorkspace();
        }
      }}
    />
  ) : null;
  // Chat share: the full GDocs-style modal. A chat link is the workspace URL +
  // chatId, so people and general access are the workspace's (shown as
  // inherited); invites minted here are chat-targeted workspace invites.
  // Local chats open the local share modal at CHAT scope — sharing mirrors
  // just that conversation to a cloud workspace, never the project's files.
  const [showChatShareModal, setShowChatShareModal] = useState(false);
  // The chat header's ⋮ menu (founder: chats need one) — mirrors the sidebar
  // chat-row ⋮ for the OPEN chat. Same outside-click/Escape dismissal as the
  // other AnchoredDropdown menus.
  const [chatHeaderMenuOpen, setChatHeaderMenuOpen] = useState(false);
  const chatHeaderMenuWrapRef = useRef<HTMLDivElement | null>(null);
  const chatHeaderMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!chatHeaderMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      // The panel itself is portaled to document.body — recognize clicks
      // inside it by the floating-menu marker, not DOM ancestry.
      if (isInFloatingActionMenu(event.target)) return;
      if (!chatHeaderMenuWrapRef.current?.contains(event.target as Node)) setChatHeaderMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChatHeaderMenuOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [chatHeaderMenuOpen]);

  const workspaceChatCollaborators = useMemo<CollaboratorBadge[]>(() => {
    if (shareInfo?.members?.length) {
      const seen = new Set<string>();
      return shareInfo.members
        .filter((member) => {
          if (!member.user_id) return false;
          if (seen.has(member.user_id)) return false;
          seen.add(member.user_id);
          return true;
        })
        .map((member) => {
          const displayName = member.name ?? member.username ?? member.email ?? `User ${member.user_id.slice(0, 6)}`;
          const resolvedUsername =
            member.user_id === user?.id ? user?.username ?? member.username ?? null : member.username ?? null;
          return {
            id: member.user_id,
            name: displayName,
            initials: getInitials(displayName),
            isYou: member.user_id === user?.id,
            imageUrl: member.imageUrl ?? null,
            username: resolvedUsername,
            email: member.email ?? null,
          };
        });
    }
    const name = user?.fullName || user?.username || 'You';
    const id = user?.id ?? 'guest';
    return [
      {
        id,
        name,
        initials: getInitials(name),
        isYou: true,
        imageUrl: user?.imageUrl ?? null,
        username: user?.username ?? null,
        email:
          user?.primaryEmailAddress?.emailAddress ??
          user?.emailAddresses?.[0]?.emailAddress ??
          null,
      },
    ];
  }, [shareInfo?.members, user]);
  const collaboratorById = useMemo(
    () => new Map(workspaceChatCollaborators.map((collaborator) => [collaborator.id, collaborator])),
    [workspaceChatCollaborators]
  );
  // Human rows of the comment composer's `@` menu (the agent row is pinned on
  // top by the builder). Self excluded — you don't tag yourself.
  const commentMentionPeople = useMemo(
    () =>
      workspaceChatCollaborators
        .filter((collaborator) => !collaborator.isYou)
        .map((collaborator) => ({
          handle: commentMentionHandle(collaborator),
          label: collaborator.name,
          imageUrl: collaborator.imageUrl,
        })),
    [workspaceChatCollaborators],
  );
  const resolvePendingEditAuthorLabel = useCallback(
    (turn: FilePendingTurn) => {
      const authorId = turn.authorId;
      if (authorId?.startsWith(ANON_AUTHOR_PREFIX)) return anonDisplayName(authorId);
      if (authorId && authorId === user?.id) return 'You';
      const collaborator = authorId ? collaboratorById.get(authorId) : null;
      if (collaborator?.name) return collaborator.isYou ? 'You' : collaborator.name;
      return defaultAuthorLabel(turn);
    },
    [collaboratorById, user?.id],
  );
  const activeWorkspaceCollaborators = useMemo<CollaboratorBadge[]>(() => {
    const selfPresenceKey = user?.id
      ? `user:${user.id}`
      : anonId
        ? `anon:${anonId}`
        : null;
    const active = Object.entries(workspacePresenceState)
      .map(([key, metas]): CollaboratorBadge | null => {
        const latestMeta = [...metas].reverse().find((meta) => meta?.presenceKey) ?? null;
        const presenceKey = latestMeta?.presenceKey ?? key;
        if (!presenceKey || presenceKey === selfPresenceKey) return null;
        // Anon rows: lean on the Anonymous <Animal> name baked into the
        // payload; HumanBubble derives the swatch from `pickColor(id)`, so
        // passing the `anon:<id>` presenceKey as the id keeps the bubble
        // color in sync with the cursor color.
        if (latestMeta?.kind === 'anon') {
          const name = latestMeta.name ?? 'Anonymous';
          return {
            id: presenceKey,
            name,
            initials: getInitials(name),
            isYou: false,
            imageUrl: null,
            username: null,
            email: null,
          };
        }
        const clerkId = latestMeta?.userId ?? null;
        if (!clerkId) return null;
        const member = collaboratorById.get(clerkId);
        const name =
          member?.name ??
          latestMeta?.name ??
          latestMeta?.username ??
          `User ${clerkId.slice(0, 6)}`;
        return {
          id: clerkId,
          name,
          initials: member?.initials ?? getInitials(name),
          isYou: false,
          imageUrl: member?.imageUrl ?? latestMeta?.imageUrl ?? null,
          username: member?.username ?? latestMeta?.username ?? null,
          email: member?.email ?? null,
        };
      })
      .filter((entry): entry is CollaboratorBadge => Boolean(entry));

    for (const agent of localAgentPresence) {
      const name = agent.name ?? 'Local agent';
      active.push({
        id: agent.presenceKey,
        name,
        initials: getInitials(name),
        isYou: false,
        imageUrl: null,
        username: null,
        email: null,
        kind: 'local-agent',
        agentId: agent.agentId ?? null,
        suggestOnly: agent.suggestOnly === true,
      });
    }

    active.sort((a, b) => a.name.localeCompare(b.name));
    return active;
  }, [anonId, collaboratorById, user?.id, workspacePresenceState, localAgentPresence]);
  const currentChatLabel =
    currentChat?.title?.trim() ||
    (currentChatUsesGroupPresentation
      ? currentChat
        ? buildGroupChatDisplayName(currentChat, currentAssistant)
        : null
      : !currentAssistant
        ? getChatModelLabel(currentChat?.model, 'Model')
        : '') ||
    'this chat';
  // The chat header leads with the conversation title (matching the chat list);
  // the Sunny identity moves to a switcher on the right. Untitled chats fall
  // back to "New chat" rather than repeating the Sunny number shown on the right.
  const currentChatHeaderTitle =
    currentChat?.title?.trim() ||
    (currentChatUsesGroupPresentation && currentChat
      ? buildGroupChatDisplayName(currentChat, currentAssistant)
      : null) ||
    'New chat';
  const currentChatLink =
    currentChatId && !isDraftChatId(currentChatId) && typeof window !== 'undefined'
      ? `${window.location.origin}${buildWorkspaceChatPath(workspaceRouteId, currentChatId)}`
      : '';
  // (Below currentChatHeaderTitle on purpose — the deps close over it.)
  // Local chats share at CHAT scope: only this conversation mirrors to the
  // cloud. Draft chats aren't persisted yet, so they fall back to the
  // whole-project share surface.
  const openChatShare = useCallback(() => {
    if (!isLocalWorkspace) return setShowChatShareModal(true);
    setLocalShareScope(
      currentChatId && !isDraftChatId(currentChatId)
        ? { kind: 'chat', path: currentChatId, label: currentChatHeaderTitle }
        : { kind: 'project', path: '' },
    );
  }, [isLocalWorkspace, currentChatId, currentChatHeaderTitle]);
  // Copy link from the chat share modal: link-shared chats copy the chat URL
  // itself; restricted workspaces fall back to the hook, which mints/copies a
  // viewer invite link targeted at this chat.
  rootShareTokenRef.current = (() => {
    const url = shareInfo?.linkShare?.url;
    if (!url) return null;
    try {
      return new URL(url).searchParams.get(PATH_SHARE_TOKEN_PARAM);
    } catch {
      return null;
    }
  })();
  const handleChatShareCopyLink = useCallback(() => {
    const linkShare = shareInfo?.linkShare ?? null;
    // Restricted + able to invite → mint/copy a chat-targeted viewer invite
    // link. Otherwise copy the chat URL itself: it works for anyone on a
    // link-shared workspace and existing members on a restricted one. A
    // TOKENED root share admits by token, so the chat URL must carry it —
    // without ?pshare the recipient lands on a 404, and the bare root link
    // would lose the chat target (tokenless shares admit on the bare URL).
    // Cloud links use the public origin (desktop shells serve from a
    // loopback proxy a collaborator can't reach).
    if (currentChatId && !isDraftChatId(currentChatId) && (linkShare?.url || !canInviteShare)) {
      const chatUrl = `${shareOrigin()}${buildWorkspaceChatPath(workspaceRouteId, currentChatId)}`;
      // Owners parse the token from linkShare.url; ROOT-link guests reuse the
      // token off their own URL only when their grants prove it IS the root
      // token (narrow file/chat tokens must never ride an unrelated link —
      // they'd leak that scope). Token-less viewer MEMBERS copy the bare URL
      // — valid for every member, the same reach they had on a restricted
      // workspace.
      const token =
        (linkShare?.url ? new URL(linkShare.url).searchParams.get(PATH_SHARE_TOKEN_PARAM) : null) ??
        (holdsRootGrantRef.current ? currentPathShareToken() : null);
      return handleCopyInvite(token ? `${chatUrl}&${PATH_SHARE_TOKEN_PARAM}=${token}` : chatUrl);
    }
    return handleCreateLinkInvite();
  }, [shareInfo?.linkShare, currentChatId, canInviteShare, workspaceRouteId, handleCopyInvite, handleCreateLinkInvite]);
  // A turn link is dead until someone else can open it: cloud chats need the
  // workspace shared (members/invites/link access); local chats live only on
  // this machine — a share mirrors their transcript to the cloud ledger, but
  // nothing renders it there yet — so they stay gated (the button opens the
  // share modal instead of copying).
  const chatShareReady = !isLocalWorkspace && shareStatus !== 'private';
  const currentChatModel = normalizeChatModelRef(currentChat?.model ?? preferredChatModel);
  const currentChatHarness = parseChatHarness(currentChat?.harness);
  const [chatEditModeByChatId, setChatEditModeByChatId] = useState<Record<string, WorkspaceEditMode>>({});
  const chatEditMode = currentChatId
    ? chatEditModeByChatId[currentChatId] ?? DEFAULT_CHAT_EDIT_MODE
    : DEFAULT_CHAT_EDIT_MODE;
  const chatEditModeRef = useRef(chatEditMode);
  chatEditModeRef.current = chatEditMode;
  useEffect(() => {
    if (!currentChatId || chatEditModeByChatId[currentChatId] !== undefined) return;
    const stored = coerceEditMode(
      typeof window === 'undefined'
        ? null
        : window.localStorage.getItem(chatEditModeStorageKey(currentChatId)),
      DEFAULT_CHAT_EDIT_MODE,
    );
    setChatEditModeByChatId((prev) =>
      prev[currentChatId] !== undefined ? prev : { ...prev, [currentChatId]: stored },
    );
  }, [currentChatId, chatEditModeByChatId]);
  const handleChatEditModeChange = useCallback(
    (next: WorkspaceEditMode) => {
      if (!currentChatId) return;
      setChatEditModeByChatId((prev) => ({ ...prev, [currentChatId]: next }));
      writeStoredEditMode(chatEditModeStorageKey(currentChatId), next);
    },
    [currentChatId],
  );
  const {
    models: models,
    loading: modelsLoading,
    emptyReason: modelsEmptyReason,
  } = useChatModels(
    projectId ?? null,
    showModelPicker || (showSettingsModal && settingsTab === 'preferences'),
    apiFetch,
  );
  currentChatRef.current = currentChat;
  chatMessagesByIdRef.current = chatMessagesById;
  const currentAttachments = currentChatId ? attachmentsByChatId[currentChatId] ?? [] : [];
  const currentContextSnippets = currentChatId
    ? contextSnippetsByChatId[currentChatId] ?? []
    : [];
  const effectiveOpenFilePath = useMemo(() => {
    if (!currentChatId) return null;
    // Deliberately the post-move path even while an open-file move is still
    // in flight: this is frozen into the message row at send time, and the
    // agent resolves it seconds later — after the rename has committed, when
    // the pre-move path would be the permanently dead one.
    return mode === 'space' ? selectedFilePath || null : null;
  }, [currentChatId, mode, selectedFilePath]);
  // Uploads stay keyed to the chat id they STARTED under; resolve BOTH sides
  // through the promotion/demotion mappings — the upload's key and the
  // rendered currentChatId can sit on opposite ends of an id swap for a
  // render, and an unmatched comparison would open the send gate (and empty
  // the strip) while the attachment is still uploading.
  const liveCurrentChatId = currentChatId ? resolveLiveChatId(currentChatId) : null;
  const chatUploads = useMemo(
    () =>
      uploads.filter(
        (upload) =>
          upload.target === 'chat' &&
          !!upload.chatId &&
          resolveLiveChatId(upload.chatId) === liveCurrentChatId
      ),
    [liveCurrentChatId, resolveLiveChatId, uploads]
  );
  const chatUploadsInFlight = useMemo(
    () =>
      uploads.some(
        (upload) =>
          upload.target === 'chat' &&
          !!upload.chatId &&
          resolveLiveChatId(upload.chatId) === liveCurrentChatId &&
          upload.status !== 'error'
      ),
    [liveCurrentChatId, resolveLiveChatId, uploads]
  );
  const fileUploads = useMemo(
    () => uploads.filter((upload) => upload.target === 'files'),
    [uploads]
  );
  const currentChatMessages = useMemo(
    () => (currentChatId ? chatMessagesById[currentChatId] || [] : []),
    [currentChatId, chatMessagesById]
  );
  const { handleChatScroll } = useChatScrollMemory({
    chatScrollRef,
    chatEndRef,
    shouldAutoScrollRef,
    chatScrollTopByChatIdRef,
    currentChatId,
    currentChatMessages,
    isChatVisible,
  });
  const currentChatChangesRefreshKey =
    currentChatMessages[currentChatMessages.length - 1]?.id ?? currentChatId;

  useDiffDeepLinkPulse({ deepLinkedDiffId, currentChatMessages });
  const assistantGreeting =
    currentChatUsesGroupPresentation ? '' : '';
  const currentChatStatus = currentChatId
    ? chatStatusById[currentChatId] ?? 'idle'
    : 'idle';
  const currentChatUnreadCount = Math.max(0, Number(currentChat?.unread_count ?? 0));
  const currentSessionId = currentChatId ? chatSessionById[currentChatId] ?? null : null;
  const currentSessionMetrics = currentChatId ? chatSessionMetricsById[currentChatId] ?? null : null;
  const currentLoopSummary = currentChatId ? chatLoopById[currentChatId] ?? null : null;
  const currentChatRuntimeSeconds = computeSessionDurationSeconds({
    status: currentChatStatus,
    totalRuntimeSeconds: currentSessionMetrics?.totalRuntimeSeconds ?? 0,
    runStartedAt: currentSessionMetrics?.lastMessageAt,
  });
  const currentLoopActorPhase = formatLoopActorPhase(currentLoopSummary?.latestStep);

  // Bridge from useChat's LIVE stream status (sundialChat is created further
  // down, after this derived block) into the busy math below. After a reload
  // mid-turn, resumeStream() reattaches the SSE and this goes true for the
  // whole rest of the turn — the persisted streaming flag only covers the
  // pre-attach window (its activity pulse expires after STREAM_IDLE_TIMEOUT_MS
  // because the DB row never changes mid-turn). Self-cleaning: a dead run has
  // no stream to reattach, so this stays false and nothing pins "working".
  // Keyed by chat id: the state survives a chat switch for a render, and an
  // unkeyed boolean would attribute chat A's busy to chat B in that window.
  const [liveStreamBusy, setLiveStreamBusy] = useState<{ chatId: string | null; busy: boolean }>({
    chatId: null,
    busy: false,
  });
  const liveBusyForCurrentChat = liveStreamBusy.busy && liveStreamBusy.chatId === currentChatId;
  const latestAssistantInfo = useMemo(() => {
    for (let i = currentChatMessages.length - 1; i >= 0; i -= 1) {
      const message = currentChatMessages[i];
      if (message?.role === 'assistant') return { message, index: i };
    }
    return { message: null, index: -1 };
  }, [currentChatMessages]);
  const latestUserInfo = useMemo(() => {
    for (let i = currentChatMessages.length - 1; i >= 0; i -= 1) {
      const message = currentChatMessages[i];
      if (message?.role === 'user') return { message, index: i };
    }
    return { message: null, index: -1 };
  }, [currentChatMessages]);
  const latestAssistantMessage = latestAssistantInfo.message;
  const latestUserMessage = latestUserInfo.message;
  const latestAssistantMeta = (latestAssistantMessage?.metadata ?? null) as Record<string, unknown> | null;
  const latestAssistantInterrupted = Boolean(latestAssistantMeta?.interrupted);
  const latestAssistantStreaming = Boolean(latestAssistantMeta?.streaming) && !latestAssistantInterrupted;
  const isInterrupting = currentChatId ? Boolean(interruptingChatIds[currentChatId]) : false;
  const optimisticStartingUntil = currentChatId
    ? (optimisticStartingUntilByChatIdRef.current.get(currentChatId) ?? 0)
    : 0;
  const isOptimisticStarting = Boolean(currentChatId) && optimisticStartingUntil > Date.now();
  const latestUserSeq = typeof latestUserMessage?.sequence === 'number' ? latestUserMessage.sequence : null;
  const latestAssistantSeq =
    typeof latestAssistantMessage?.sequence === 'number' ? latestAssistantMessage.sequence : null;
  const currentChatLastSequence =
    currentChatMessages.length > 0 && typeof currentChatMessages[currentChatMessages.length - 1]?.sequence === 'number'
      ? currentChatMessages[currentChatMessages.length - 1]?.sequence ?? null
      : null;
  const hasPendingUserTurn = Boolean(
    latestUserSeq !== null
      ? latestAssistantSeq === null || latestAssistantSeq < latestUserSeq
      : latestUserInfo.index >= 0 &&
        (latestAssistantInfo.index < 0 || latestAssistantInfo.index < latestUserInfo.index)
  );
  const isChatStreaming = Boolean(
    currentChatId && latestAssistantStreaming && streamActivityByChatId[currentChatId]
  );
  useCurrentChatEffects<ChatMessage>({
    currentChatId,
    currentChatModel: currentChat?.model,
    mode,
    isChatTranscriptVisible: isChatVisible,
    isDocumentVisible,
    userId: user?.id,
    currentChatUnreadCount,
    currentChatLastSequence,
    clearUnreadForChat,
    markChatRead,
    ensureChatMessagesLoaded,
    setPreferredChatModel,
  });
  const statusCountsAsBusy =
    (currentChatStatus === 'working' || currentChatStatus === 'starting') &&
    hasPendingUserTurn &&
    !latestAssistantInterrupted;
  const hasLiveChatRun = Boolean(currentChatId) && !latestAssistantInterrupted && (
    isInterrupting ||
    isOptimisticStarting ||
    isChatStreaming ||
    liveBusyForCurrentChat ||
    statusCountsAsBusy
  );
  const isWaitingForResponseStart =
    Boolean(currentChatId) &&
    !latestAssistantInterrupted &&
    !isInterrupting &&
    !isChatStreaming &&
    (statusCountsAsBusy || isOptimisticStarting);
  // Typing bubble = "user message is the latest, no agent reply content yet."
  //
  // We deliberately do NOT use the sequence-based `hasPendingUserTurn` here.
  // In the foreign-collaborator window, the assistant UIMessage arrives via
  // `resumeStream()` carrying no `sequence` in its metadata (the harness
  // only stamps sequence on the DB row at onFinish, never on the in-flight
  // stream), so the seq predicate stays true forever → dots never go away
  // even after the full reply has rendered.
  //
  // Index + content is what `useChat`'s state naturally answers: order of
  // arrival is order of insertion into `chat.messages`, and the moment any
  // text-delta lands, `latestAssistantMessage.content` is non-empty. That
  // covers both the sending window (sendMessage appends the user row, SSE
  // appends the assistant row) AND the foreign window (Realtime fan-in
  // appends the user row, resumeStream appends the assistant row).
  const latestAssistantHasContent =
    typeof latestAssistantMessage?.content === 'string' &&
    latestAssistantMessage.content.trim().length > 0;
  const userIsLatest =
    latestUserInfo.index >= 0 &&
    (latestAssistantInfo.index < 0 || latestAssistantInfo.index < latestUserInfo.index);
  // The userIsLatest arm only covers the SEND WINDOW (POST persisted, run not
  // yet inserted its assistant row) — so it must be time-bounded. Without the
  // bound, a run that died before inserting any assistant row left the chat
  // showing "Thinking…" forever, even on a reload days later (2026-08-01,
  // chat 88d2fd22). A live run past the bound stays covered by hasLiveChatRun.
  const latestUserSentRecently = (() => {
    if (!userIsLatest) return false;
    const at = Date.parse(String(latestUserMessage?.created_at ?? ''));
    return Number.isNaN(at) ? true : Date.now() - at < 2 * 60_000;
  })();
  // The bound above is read at render time only — schedule one re-render at
  // the deadline so a dead run's working line actually clears without any
  // interaction (Codex round 8).
  const [, setWorkingWindowExpired] = useState(0);
  useEffect(() => {
    if (!userIsLatest) return;
    const at = Date.parse(String(latestUserMessage?.created_at ?? ''));
    if (Number.isNaN(at)) return;
    const remaining = at + 2 * 60_000 + 250 - Date.now();
    if (remaining <= 0) return;
    const id = setTimeout(() => setWorkingWindowExpired((t) => t + 1), remaining);
    return () => clearTimeout(id);
  }, [userIsLatest, latestUserMessage?.created_at]);
  // TS harness inserts the assistant row eagerly with empty content (so tools
  // can FK to it), so userIsLatest flips false instantly — anchor on the live
  // run state too, otherwise dots never appear in the send window.
  const showWorkingIndicator =
    Boolean(currentChatId) &&
    !latestAssistantInterrupted &&
    !latestAssistantHasContent &&
    (latestUserSentRecently || hasLiveChatRun);
  const isChatInterruptible = hasLiveChatRun;
  // Read by the inline-ask handler (registered once): a direct send while a
  // turn streams would cancel-and-replace the in-flight run (Codex P2 #790).
  const isChatInterruptibleRef = useRef(isChatInterruptible);
  isChatInterruptibleRef.current = isChatInterruptible;
  useEffect(() => {
    if (settingsTab === 'secrets' && canAccessSecrets === false) {
      setSettingsTab('workspace');
    }
  }, [canAccessSecrets, settingsTab]);

  useChatStreamActivity({
    currentChatId,
    latestAssistantMessageId: latestAssistantMessage?.id,
    latestAssistantMessageContent: latestAssistantMessage?.content,
    latestAssistantStreaming,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    streamTimeoutsRef,
    setStreamActivityByChatId,
  });
  usePersistLastChat({
    projectId,
    currentChatId,
    isDraftChatId,
  });
  const loadAgentStatuses = useCallback(async () => {
    setChatSessionById({});
    setChatSessionMetricsById({});
    setChatLoopById({});
  }, []);

  useWorkspaceAppConnectionCallback({
    projectId,
    callbackConnectedAccountId,
    callbackStatus,
    searchParams,
    router,
    workspaceRouteId,
    appConnectionHandledRef,
    optimisticStartingUntilByChatIdRef,
    startingStatusGraceMs: STARTING_STATUS_GRACE_MS,
    showWorkspaceAppNotice,
    loadAgentStatuses,
    loadConnectedApps,
    setShowAppsPicker,
    setChatStatusById,
  });

  const chatEntries = useMemo(() => {
    return chatThreadsForCurrentProject
      .map((thread, index) => ({
        ...thread,
        index,
        isArchived: Boolean(thread.chat.archived_at),
      }))
      .sort((a, b) => {
        // Optimistic drafts always pin to the very top — protects against a
        // concurrent server refresh briefly placing the freshly-created real
        // chat above the draft that spawned it.
        const aDraft = isDraftChatId(a.chat.id);
        const bDraft = isDraftChatId(b.chat.id);
        if (aDraft !== bDraft) return aDraft ? -1 : 1;
        const aTime = getChatActivityTime(a.chat);
        const bTime = getChatActivityTime(b.chat);
        if (aTime !== bTime) return bTime - aTime;
        return b.index - a.index;
      });
  }, [chatThreadsForCurrentProject]);
  const activeChats = chatEntries.filter((entry) => !entry.isArchived);
  const pinnedActiveChats = activeChats.filter((entry) => isChatPinned(entry.chat));
  const unpinnedActiveChats = activeChats.filter((entry) => !isChatPinned(entry.chat));
  const archivedChats = chatEntries.filter((entry) => entry.isArchived);
  const sunnyAvatarByChatId = useMemo(
    () => buildSunnyAvatarMap(chatEntries.map((entry) => entry.chat)),
    [chatEntries],
  );
  // Avatar imagery for the review controls' author chips: agent turns render
  // Sunny's face — instantly recognizable, where the initials chip read "SA"
  // and the bare asterisk read as anonymous chrome; a collaborator gets their
  // profile photo (initials fall back automatically), and local agents' brand
  // marks come via the builders' default.
  const resolvePendingEditAuthorVisual = useCallback(
    (turn: FilePendingTurn) => {
      const authorId = turn.authorId;
      if (!authorId || authorId.startsWith('sunny:')) {
        // imageRound:false — Sunny's PNG is a transparent-background star, so
        // the `is-mark` treatment (uncropped, no chip disc) is the one that reads.
        return { imageUrl: DEFAULT_SUNNY_AVATAR, imageRound: false };
      }
      if (authorId.startsWith('ai:')) return null; // builders default to the brand mark
      const collaborator = collaboratorById.get(authorId);
      return collaborator?.imageUrl ? { imageUrl: collaborator.imageUrl, imageRound: true } : null;
    },
    [collaboratorById],
  );
  const chatDetailsEntry = useMemo(
    () => chatEntries.find((entry) => entry.chat.id === chatDetailsChatId) ?? null,
    [chatDetailsChatId, chatEntries]
  );
  const chatDetailsStatus = chatDetailsEntry
    ? chatStatusById[chatDetailsEntry.chat.id] ?? 'idle'
    : null;
  const chatDetailsSessionMetrics = chatDetailsEntry ? chatSessionMetricsById[chatDetailsEntry.chat.id] : null;
  const chatDetailsDurationSeconds = computeSessionDurationSeconds({
    status: chatDetailsStatus ?? 'idle',
    totalRuntimeSeconds: chatDetailsSessionMetrics?.totalRuntimeSeconds ?? 0,
    runStartedAt: chatDetailsSessionMetrics?.lastMessageAt,
  });
  const chatDetailsLoopSummary = chatDetailsEntry ? chatLoopById[chatDetailsEntry.chat.id] ?? null : null;
  const chatDetailsLoopActorPhase = formatLoopActorPhase(chatDetailsLoopSummary?.latestStep);
  const chatDetailsLoopStatusLabel = chatDetailsLoopSummary ? formatLoopStatusLabel(chatDetailsLoopSummary.status) : null;
  const chatDetailsLoopStatusClass = chatDetailsLoopSummary ? getLoopStatusPillClass(chatDetailsLoopSummary.status) : null;
  const chatDetailsUsesGroupPresentation = chatDetailsEntry
    ? usesGroupChatPresentation(getChatKind(chatDetailsEntry.chat), chatDetailsEntry.chat)
    : false;
  const chatDetailsDisplayName = chatDetailsEntry
    ? (
        chatDetailsUsesGroupPresentation
          ? buildGroupChatDisplayName(chatDetailsEntry.chat)
          : getChatModelLabel(chatDetailsEntry.chat.model, 'Model')
      )
    : '';
  const chatDetailsPreview = chatDetailsEntry
    ? chatDetailsEntry.chat.preview_text?.trim() || chatDetailsEntry.chat.title?.trim() || 'New chat'
    : 'New chat';
  const chatDetailsModelLabel = chatDetailsEntry
    ? getChatModelLabel(chatDetailsEntry.chat.model)
    : getChatModelLabel(DEFAULT_MODEL_REF);
  // The current chat's live run keeps the bubble "working" for the whole turn
  // — tool calls included — because the SSE stream stays open while tools run.
  // The brain also stamps metadata.streaming=true on the up-front assistant
  // row (cleared at the final persist), so DB-driven status now sees in-flight
  // turns too; this live override still matters because the DB row never
  // updates mid-turn, so a persisted-row watcher alone can't track activity.
  const effectiveChatStatus = useCallback(
    (chatId: string): ChatStatus =>
      chatId === currentChatId && hasLiveChatRun
        ? 'working'
        : chatStatusById[chatId] ?? 'idle',
    [chatStatusById, currentChatId, hasLiveChatRun],
  );
  useWorkspaceChatSidebarEffects<ChatThread>({
    projectId,
    chatsLoaded,
    chatsProjectId,
    selectedDirectChatId,
    currentThread,
    chatThreadsForCurrentProject,
    loadAgentStatuses,
    setSelectedChatIndex,
    setSelectedChatSurface,
  });

  // useChat owns the active chat's live state. The transport POSTs to the
  // existing /api/workspace/messages endpoint (attachments + RLS + anon
  // auth preserved there) and consumes SSE from /api/workspace/agent-stream.
  // Initial history comes from chatMessagesById (loaded via Sundial's REST
  // flow on chat mount); useChat takes over for live updates after that.
  const useChatActive = !!currentChatId && !isDraftChatId(currentChatId);
  const initialMessagesForUseChat = useMemo(
    () => (useChatActive && currentChatId ? chatMessagesById[currentChatId] ?? [] : []),
    // Tracks chatMessagesById so the late-arrival case (REST history
    // resolves after useChat mounts with an empty list) reaches the hook.
    // useSundialChat's own effect handles the once-per-chat semantics —
    // it only re-applies on a chat swap or when we previously initialized
    // with [], so passing a fresher value here can't clobber streaming.
    [currentChatId, useChatActive, chatMessagesById],
  );
  const sundialChat = useSundialChat({
    chatId: useChatActive ? currentChatId : null,
    initialMessages: initialMessagesForUseChat,
    enabled: useChatActive,
    fetchImpl: apiFetch,
    // Recover a turn whose SSE was severed and finished server-side before we
    // could resume: force-fetch the canonical persisted rows so useChat can
    // replace the frozen half-rendered bubble (a DONE stream can't be replayed).
    reloadHistory: useCallback(
      (chatId: string, opts?: { fromSequence?: number; findTurnStart?: boolean }) =>
        ensureChatMessagesLoaded(chatId, {
          force: true,
          fromSequence: opts?.fromSequence,
          findTurnStart: opts?.findTurnStart,
        }),
      [ensureChatMessagesLoaded],
    ),
  });
  const sundialChatRef = useRef(sundialChat);
  sundialChatRef.current = sundialChat;
  const currentChatIdRef = useRef(currentChatId);
  openChatTabForCurrentRef.current = (opts?: { side?: boolean }) => {
    if (currentChatId) openChatTabInPanes(currentChatId, opts);
  };
  currentChatIdRef.current = currentChatId;
  // Feed the live stream status back into the busy math above (see the
  // liveStreamBusy declaration for why this bridge exists).
  const sundialChatBusy = sundialChat.status === 'streaming' || sundialChat.status === 'submitted';
  useEffect(() => {
    setLiveStreamBusy({ chatId: currentChatId, busy: sundialChatBusy });
  }, [sundialChatBusy, currentChatId]);
  // Retire the optimistic 'starting' grace the moment the live stream settles.
  // Without this the composer stays on "Interrupt" until the full grace window
  // (20s) elapses after send, seconds after the reply visibly finished. Scoped
  // to a same-chat streaming→settled transition so a chat switch can't clear a
  // freshly-armed grace on the destination chat.
  const lastLiveStreamStatusRef = useRef<{ chatId: string | null; status: string }>({
    chatId: null,
    status: 'idle',
  });
  useEffect(() => {
    const prev = lastLiveStreamStatusRef.current;
    lastLiveStreamStatusRef.current = { chatId: currentChatId, status: sundialChat.status };
    if (!currentChatId || prev.chatId !== currentChatId) return;
    const wasLive = prev.status === 'streaming' || prev.status === 'submitted';
    // Only a CLEAN settle retires the grace. On 'error' the run may well still
    // be live on the brain (a transient SSE drop — the transport/recovery path
    // owns it); clearing here would force chatStatusById to idle over the
    // realtime 'working' status and let a follow-up send cancel the run.
    const settled = sundialChat.status === 'idle';
    if (!wasLive || !settled) return;
    if (optimisticStartingUntilByChatIdRef.current.delete(currentChatId)) {
      // A ref delete doesn't re-render; flip the status too so the composer
      // re-evaluates now rather than at the grace expiry.
      setChatStatusById((prevStatus) => ({ ...prevStatus, [currentChatId]: 'idle' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sundialChat.status, currentChatId]);

  // Live chat messages for turn-edit invalidation. The transcript renders
  // `sundialChat.messages` (SSE metadata); REST-seeded `chatMessagesById`
  // does not get `has_turn_edits` until a full history reload.
  const liveChatMessagesForEdits = useMemo(
    () => (useChatActive ? sundialChat.messages : currentChatMessages),
    [currentChatMessages, sundialChat.messages, useChatActive],
  );

  // Cross-user "Sunny is working" presence: subscribe to messages across
  // every chat in this workspace so the agent bubble lights up when another
  // collaborator's chat starts a turn. Local optimistic updates from the
  // send path remain authoritative — we only flip when the row genuinely
  // advances the status.
  useWorkspaceChatStatusRealtime({
    supabaseClient,
    projectId,
    chatIds: useMemo(
      () =>
        chatThreadsForCurrentProject
          .map((thread) => thread.chat.id)
          .filter((id) => Boolean(id) && !isDraftChatId(id)),
      [chatThreadsForCurrentProject],
    ),
    setChatStatusById,
    // Terminal persisted state for the ACTIVE chat settles a live view whose
    // SSE reader wedged on a half-open socket (it never errors, so useChat
    // stays 'streaming' and the tab shows "working" until reload). Refs so
    // the subscription reads the current chat + hook instance.
    onAssistantSettled: useCallback(
      (settledChatId: string, assistantRowId: string | null, rowSequence: number | null) => {
        if (settledChatId !== currentChatIdRef.current) return;
        sundialChatRef.current.settleFromPersistedRun(assistantRowId, rowSequence);
      },
      [],
    ),
  });

  // Multi-user fan-in for the active chat: when another collaborator
  // posts a message in the chat I'm currently viewing, mirror it into
  // useChat's state + reconnect to the resumable stream so the agent's
  // reply streams in live. INSERT-only + role='user' → tiny surface,
  // no UPDATE chatter, none of the original Realtime pain.
  useActiveChatForeignUserMessages({
    supabaseClient,
    currentChatId,
    isDraftChatId,
    currentUserId: effectiveCurrentUserId ?? null,
    appendForeignUserMessage: sundialChat.appendForeignUserMessage,
    resumeStream: sundialChat.resumeStream,
  });

  // Local comment deliveries: the sidecar's chats-changed stands in for the
  // cloud's chats + messages realtime — refresh the rail, and when the
  // delivery hit the OPEN chat, pull the new rows into the transcript and
  // reattach the run's stream (mirrors the cloud fan-in above).
  useEffect(() => {
    if (!localConfig || !projectId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = localSidecar.subscribe(localConfig, projectId, (event) => {
      if (event.type !== 'chats-changed') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadChatThreads(), 300);
      const openChatId = currentChatRef.current?.id ?? null;
      const eventChatId = (event as { chatId?: string }).chatId ?? null;
      if (!openChatId || eventChatId !== openChatId) return;
      void (async () => {
        try {
          const res = await apiFetch(`/api/workspace/messages?chatId=${encodeURIComponent(openChatId)}`);
          if (!res.ok) return;
          const { messages } = (await res.json()) as { messages?: ChatMessage[] };
          for (const row of messages ?? []) {
            if (row.role !== 'user') continue;
            if ((row.metadata as Record<string, unknown> | null)?.source !== 'comment') continue;
            sundialChatRef.current?.appendForeignUserMessage(row);
          }
          sundialChatRef.current?.resumeStream();
        } catch {
          // Best-effort; the rail refresh above still surfaces the delivery.
        }
      })();
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [localConfig, projectId, loadChatThreads, apiFetch]);

  // Derived state
  const toolUseMap = useMemo(() => {
    const map = new Map<string, { name: string; input: Record<string, unknown> | null }>();
    currentChatMessages.forEach((message) => {
      if (message.role !== 'system' || !message.metadata) return;
      const meta = message.metadata as Record<string, unknown>;
      if (meta.type !== 'tool_use') return;
      const toolUseId = typeof meta.tool_use_id === 'string' ? meta.tool_use_id : null;
      const tool = (meta.tool ?? {}) as Record<string, unknown>;
      if (!toolUseId) return;
      map.set(toolUseId, {
        name: typeof tool.name === 'string' ? tool.name : 'Tool',
        input: (tool.input ?? null) as Record<string, unknown> | null,
      });
    });
    return map;
  }, [currentChatMessages]);
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    currentChatMessages.forEach((message) => {
      if (message.role !== 'system' || !message.metadata) return;
      const meta = message.metadata as Record<string, unknown>;
      if (meta.type !== 'tool_result') return;
      const toolUseId = typeof meta.tool_use_id === 'string' ? meta.tool_use_id : null;
      if (!toolUseId) return;
      map.set(toolUseId, message);
    });
    return map;
  }, [currentChatMessages]);
  const sendActionTitle = isChatInterruptible
    ? 'Stop'
    : chatUploadsInFlight
      ? 'Uploading files...'
      : 'Send message';
  const visibleFiles = useMemo(
    () =>
      workspaceFiles.filter(
        (file) =>
          file.type !== 'proposal' &&
          (showMetaFiles || !isMetaPath(file.path)) &&
          (showAgentMetaFiles || !isAgentMetadataPath(file.path)),
      ),
    [showAgentMetaFiles, showMetaFiles, workspaceFiles]
  );
  // Root AGENTS.md — when present, the workspace-instructions panel edits this
  // file instead of `projects.space_instructions` (the brain prefers the file).
  const agentsFile = useMemo(() => findRootAgentsFile(workspaceFiles), [workspaceFiles]);
  const handleAgentsFileCreated = useCallback(
    (file: WorkspaceFileRow) => {
      mutateWorkspaceFiles((prev) =>
        prev.some((entry) => entry.path === file.path) ? prev : [...prev, file],
      );
      filesChannelRef.current?.postMessage({ type: 'refresh' });
    },
    [mutateWorkspaceFiles],
  );
  const wikiLinkSuggestions = useMemo(
    () =>
      visibleFiles
        .filter((file) => file.type !== 'folder')
        .map((file) => file.path)
        .sort((a, b) => a.localeCompare(b)),
    [visibleFiles]
  );
  const mentionableFiles = useMemo(
    () =>
      visibleFiles
        .filter((file) => file.type !== 'folder')
        .map((file) => ({ path: file.path, updatedAt: file.updated_at }))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    [visibleFiles]
  );
  // Stable identity for the transcript's knownFilePaths: a fresh `.map()` in the
  // JSX would change every render and defeat the per-row transcript memo.
  const mentionableFilePaths = useMemo(
    () => mentionableFiles.map((file) => file.path),
    [mentionableFiles],
  );
  const rootFiles = useMemo(() => {
    const sorted = visibleFiles
      .filter((file) => file.type !== 'folder' && !file.path.includes('/'))
      .sort((a, b) => a.path.localeCompare(b.path));
    return sortByManualOrder(sorted, (file) => file.path, fileOrder[ROOT_ORDER_KEY]);
  }, [visibleFiles, fileOrder]);
  const folderPaths = useMemo(() => {
    const folderSet = new Set<string>();
    const addFolderWithParents = (folderPath: string) => {
      let current: string | null = folderPath;
      while (current) {
        folderSet.add(current);
        current = getFolderPath(current);
      }
    };
    visibleFiles.forEach((file) => {
      if (file.type === 'folder') {
        addFolderWithParents(file.path);
        return;
      }
      const folder = getFolderPath(file.path);
      if (folder) {
        addFolderWithParents(folder);
      }
    });
    return Array.from(folderSet).sort((a, b) => a.localeCompare(b));
  }, [visibleFiles]);
  const filesByFolder = useMemo(() => {
    const map: Record<string, WorkspaceFileRow[]> = {};
    folderPaths.forEach((folder) => {
      map[folder] = [];
    });
    visibleFiles.forEach((file) => {
      if (file.type === 'folder') return;
      const folder = getFolderPath(file.path);
      if (!folder) return;
      if (!map[folder]) {
        map[folder] = [];
      }
      map[folder].push(file);
    });
    Object.entries(map).forEach(([folder, list]) => {
      list.sort((a, b) => a.path.localeCompare(b.path));
      map[folder] = sortByManualOrder(list, (file) => getFileName(file.path), fileOrder[folder]);
    });
    return map;
  }, [folderPaths, visibleFiles, fileOrder]);
  const foldersByParent = useMemo(() => {
    const map: Record<string, string[]> = { __root__: [] };
    folderPaths.forEach((folder) => {
      const parent = getFolderPath(folder) ?? '__root__';
      if (!map[parent]) {
        map[parent] = [];
      }
      map[parent].push(folder);
    });
    Object.entries(map).forEach(([parent, list]) => {
      list.sort((a, b) => a.localeCompare(b));
      map[parent] = sortByManualOrder(list, getFileName, fileOrder[parent]);
    });
    return map;
  }, [folderPaths, fileOrder]);
  // Drag-to-reorder within one parent: rewrite that parent's manual order from
  // its current display order (folders and files interleaved per the stored
  // order — matching render, where a file can sit above a folder).
  const handleReorderEntries = useCallback(
    (draggedPaths: string[], targetPath: string, position: 'before' | 'after') => {
      if (!projectId || draggedPaths.length === 0) return;
      const parent = getFolderPath(targetPath) ?? ROOT_ORDER_KEY;
      if (!draggedPaths.every((path) => (getFolderPath(path) ?? ROOT_ORDER_KEY) === parent)) return;
      const folderNames = (foldersByParent[parent] ?? []).map(getFileName);
      const fileNames = (parent === ROOT_ORDER_KEY ? rootFiles : filesByFolder[parent] ?? []).map(
        (file) => getFileName(file.path),
      );
      const names = computeReorder(
        sortByManualOrder([...folderNames, ...fileNames], (name) => name, fileOrder[parent]),
        draggedPaths.map(getFileName),
        getFileName(targetPath),
        position,
      );
      const next = mergeParentOrder(fileOrder, parent, names);
      setFileOrder(next);
      // Optimistic: the cache paints instantly and carries an offline drag
      // until the next load. (A path-share guest editing inside their subtree
      // is refused the workspace-wide write and reverts on the next poll —
      // one tree for the workspace beats a subtree view rewriting it.)
      writeFileOrder(projectId, next);
      fileOrderGenRef.current += 1;
      void apiFetch('/api/workspace/file-order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, parent, names }),
      }).catch(() => null);
    },
    [projectId, fileOrder, foldersByParent, filesByFolder, rootFiles, apiFetch],
  );
  /** Flat list of file paths in visual render order (for shift+click range
   *  selection) — folders and files interleaved per fileOrder, matching the
   *  tree's renderChildren. */
  const flatVisiblePaths = useMemo(() => {
    const paths: string[] = [];
    const walk = (parentKey: string, folders: string[], files: WorkspaceFileRow[]) => {
      const children = sortByManualOrder(
        [
          ...folders.map((path) => ({ path, isFolder: true })),
          ...files.map((file) => ({ path: file.path, isFolder: false })),
        ],
        (child) => getFileName(child.path),
        fileOrder[parentKey],
      );
      for (const child of children) {
        if (!child.isFolder) paths.push(child.path);
        else if (expandedFolders.has(child.path))
          walk(child.path, foldersByParent[child.path] ?? [], filesByFolder[child.path] ?? []);
      }
    };
    walk(ROOT_ORDER_KEY, foldersByParent.__root__ ?? [], rootFiles);
    return paths;
  }, [rootFiles, foldersByParent, filesByFolder, expandedFolders, fileOrder]);
  const collabUser = useMemo(() => {
    // presenceKey mirrors the Supabase presence channel key — the bridge that
    // lets a clicked bubble find this client's caret in a doc's awareness.
    if (user) {
      return {
        name: user.fullName || user.username || 'You',
        color: pickColor(user.id),
        presenceKey: `user:${user.id}`,
      };
    }
    if (anonId) {
      return {
        name: anonDisplayName(anonId),
        color: pickColor(`${ANON_AUTHOR_PREFIX}${anonId}`),
        presenceKey: `anon:${anonId}`,
      };
    }
    return { name: 'Guest', color: pickColor('guest') };
  }, [user, anonId]);
  // Local-mode presence chips from awareness peers.
  const localPeerBadges = useMemo<CollaboratorBadge[]>(() => {
    if (!isLocalWorkspace) return [];
    return excludeSelfPeers(localCollabPeers, collabUser)
      .map((peer) => ({
        id: peer.key,
        name: peer.name,
        initials: getInitials(peer.name),
        isYou: false,
        imageUrl: null,
        username: null,
        email: null,
        color: peer.color,
      }));
  }, [isLocalWorkspace, localCollabPeers, collabUser]);
  const workspaceFileByPath = useMemo(() => {
    return new Map(workspaceFiles.map((file) => [file.path, file]));
  }, [workspaceFiles]);
  // Fallback via the pre-move path: a background reload racing an in-flight
  // open-file move can briefly restore the old server paths — without it the
  // lookup at the new path misses and the editor unmounts mid-move.
  const activeWorkspaceFile = selectedFilePath
    ? workspaceFileByPath.get(selectedFilePath)
      ?? (pendingOpenFileMove && selectedFilePath === pendingOpenFileMove.to
        ? workspaceFileByPath.get(pendingOpenFileMove.from)
        : null)
      // Same race for a PANE-only move activated mid-flight: the selection is
      // the remapped `to` path while a stale reload only has `from` — resolve
      // to the old row (whose path also keeps the collab room pre-move).
      ?? (() => {
        const m = pendingPaneMoves.find((mv) => isPathWithin(selectedFilePath, mv.to));
        return m ? workspaceFileByPath.get(remapPath(selectedFilePath, m.to, m.from)) : null;
      })()
      ?? null
    : null;
  activeFileIdRef.current = activeWorkspaceFile?.id ?? null;
  const fileContentReady = readyFileId === (activeWorkspaceFile?.id ?? null);
  // While an optimistic move of the open file is in flight, the editor keeps
  // its collab ROOM on the pre-move path (the editors' collabPath prop) — the
  // server-side rename hasn't committed yet, and rooms are keyed by path
  // (binding early seeds an empty doc). Everything else (tree, selection,
  // URL, chat snippet paths via filePath) already shows the new path.
  // Same freeze for a pane-only move the user activates mid-flight (clicking
  // a remapped background tab): the selection never moved, so only
  // pendingPaneMoves knows the rename is still uncommitted.
  const activeFrozenPaneMove = activeWorkspaceFile
    ? pendingPaneMoves.find((m) => isPathWithin(activeWorkspaceFile.path, m.to))
    : undefined;
  const activeCollabPath =
    pendingOpenFileMove && activeWorkspaceFile?.path === pendingOpenFileMove.to
      ? pendingOpenFileMove.from
      : activeFrozenPaneMove && activeWorkspaceFile
        ? remapPath(activeWorkspaceFile.path, activeFrozenPaneMove.to, activeFrozenPaneMove.from)
        : activeWorkspaceFile?.path ?? '';

  // ── Wiki-link anchor navigation ([[note#heading]], [[note#^id]]) ──────
  // Cmd-click / hover-card open on a wiki link routes the RAW target here:
  // resolve the path Obsidian-style, then scroll to the anchor — directly for
  // the open file, or parked in a ref until the target file's editor reports
  // ready (same pattern as pendingRevealLineRef for search results).
  const pendingWikiAnchorRef = useRef<{ path: string; anchor: WikiAnchor } | null>(null);
  const wikiAnchorMissNotice = useCallback(
    (anchor: WikiAnchor) => {
      showWorkspaceAppNotice(
        'error',
        anchor.heading ? `Heading “${anchor.heading}” not found` : `Block ^${anchor.blockId} not found`,
      );
    },
    [showWorkspaceAppNotice],
  );
  const handleWikiNavigate = useCallback(
    (rawTarget: string) => {
      const { path, heading, headingPath, blockId } = parseWikiTarget(rawTarget);
      const anchor: WikiAnchor | null =
        heading || blockId ? { heading, headingPath, blockId } : null;
      const targetPath = path ? resolveWorkspacePath(path, wikiLinkSuggestions) : selectedFilePath;
      if (!targetPath) {
        showWorkspaceAppNotice('error', `No file matching “${path}” in this workspace`);
        return;
      }
      if (targetPath === selectedFilePath) {
        if (anchor && !scrollEditorToAnchor(richEditorRef.current, anchor)) wikiAnchorMissNotice(anchor);
        return;
      }
      pendingWikiAnchorRef.current = anchor ? { path: targetPath, anchor } : null;
      setSelectedFilePath(targetPath);
      // The selection alone isn't enough in the panes shell: a path with no
      // open tab is pruned right back out (see the panes sync effect), so the
      // jump would silently no-op. Claim a pane for the target like every
      // other "open this file" path does.
      if (!isMobile) {
        claimPrimaryWithFile(targetPath);
        setOpenLeftRail('project');
      } else {
        openCenterPanel('editor');
      }
    },
    [
      claimPrimaryWithFile,
      isMobile,
      openCenterPanel,
      selectedFilePath,
      showWorkspaceAppNotice,
      wikiAnchorMissNotice,
      wikiLinkSuggestions,
    ],
  );
  /** Markdown text of a workspace note, for `[[note#` anchor autocomplete. */
  const fetchWikiNoteText = useCallback(
    async (path: string): Promise<string | null> => {
      try {
        const params = new URLSearchParams({ projectId, path });
        const res = await apiFetch(`/api/workspace/file-content?${params.toString()}`);
        if (!res.ok) return null;
        const data = (await res.json().catch(() => null)) as { exists?: boolean; content?: string } | null;
        return data?.exists ? String(data.content ?? '') : null;
      } catch {
        return null;
      }
    },
    [apiFetch, projectId],
  );

  useEffect(() => {
    const pending = pendingWikiAnchorRef.current;
    if (!pending || !fileContentReady) return;
    pendingWikiAnchorRef.current = null;
    if (pending.path !== selectedFilePath) return;
    if (scrollEditorToAnchor(richEditorRef.current, pending.anchor)) return;
    // The Y.Doc can hydrate a beat after ready — retry once before reporting.
    const timer = window.setTimeout(() => {
      if (!scrollEditorToAnchor(richEditorRef.current, pending.anchor)) {
        wikiAnchorMissNotice(pending.anchor);
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [fileContentReady, selectedFilePath, wikiAnchorMissNotice]);

  // Mirror the open file AND chat into the URL so it can be copied/shared
  // directly (2026-06-05 feedback). With both present, the link reopens the
  // same file+chat split. The page reads `?fileId=`/`?chatId=` on load and on
  // back/forward (see the popstate effect below). A genuine in-workspace
  // navigation (switch file, or switch to a different chat) pushes a history
  // entry so `back` returns to the previous view; everything else (the landing
  // settle, opening/closing the chat panel, popstate restoration) replaces, so
  // `back` never gets trapped and the forward stack is never clobbered.
  // `useSearchParams()` does not observe pushState/replaceState, so this can't
  // loop through the deep-link effects.
  const activeFileIdForUrl = activeWorkspaceFile?.id ?? null;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    // Don't strip a shared link's params before hydration consumes them: on
    // the first renders ?fileId/?chatId are set while the async file/chat
    // selection hasn't populated activeFileIdForUrl/currentChatId yet, and
    // mirroring then would rewrite the deep link away. Once hydration lands a
    // file/chat, the gate opens permanently (the ref survives later closes).
    if (!urlMirrorReadyRef.current) {
      if (
        (url.searchParams.get('fileId') && !activeFileIdForUrl) ||
        (url.searchParams.get('chatId') && !currentChatId)
      ) {
        return;
      }
      urlMirrorReadyRef.current = true;
    }
    // An app-connection callback is pending: its handler reads ?chatId= (full
    // id, needed verbatim by connection-complete) and clears its own params
    // via router.replace — don't rewrite the URL out from under it.
    if (callbackConnectedAccountId) {
      return;
    }
    url.searchParams.delete('filePath');
    // Both mirrors are visibility-gated (see shouldMirrorFileIdToUrl /
    // shouldMirrorChatIdToUrl): a reload should reopen what was on screen,
    // not read a background selection back as a deep-link intent. A
    // comment/diff anchor keeps its file target regardless — dropping fileId
    // there would leave an anchor URL that reloads with no file to resolve.
    const hasEditorAnchorParam = Boolean(
      url.searchParams.get('commentThreadId') || url.searchParams.get('diff'),
    );
    // Review counts as file intent too: a review-only layout (editor closed)
    // must reload into its document context, not the chat landing.
    if (
      shouldMirrorFileIdToUrl(
        activeFileIdForUrl,
        isEditorVisible || isReviewVisible || hasEditorAnchorParam,
      )
    ) {
      url.searchParams.set('fileId', toShortIdRef(activeFileIdForUrl!));
    } else url.searchParams.delete('fileId');
    if (shouldMirrorChatIdToUrl(currentChatId, isChatVisible)) url.searchParams.set('chatId', toShortIdRef(currentChatId!));
    else url.searchParams.delete('chatId');
    const mirroredViewRefs: WorkspaceViewRefs = {
      fileRef: url.searchParams.get('fileId'),
      chatRef: url.searchParams.get('chatId'),
    };
    if (
      restoringViewFromPopstateRef.current
      && restoringViewTargetRef.current
      && !isWorkspaceRestoreSettled(mirroredViewRefs, restoringViewTargetRef.current)
    ) {
      // File selection can settle before an uncached chat finishes loading.
      // Keep the popped URL intact until both halves match its target.
      return;
    }
    const next = `${url.pathname}${url.search}${url.hash}`;
    const nextViewKey: WorkspaceViewKey = { fileId: activeFileIdForUrl, chatId: currentChatId };
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      const method = nextWorkspaceHistoryMethod({
        prev: lastMirroredViewKeyRef.current,
        next: nextViewKey,
        landingSettled: landingViewSettledRef.current,
        restoring: restoringViewFromPopstateRef.current,
        promotingDraftChat: Boolean(
          lastMirroredViewKeyRef.current.chatId
          && nextViewKey.chatId
          && draftPromotionsRef.current[lastMirroredViewKeyRef.current.chatId] === nextViewKey.chatId
        ),
      });
      window.history[method === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', next);
    }
    // State has caught up to the popped entry. Re-arm push even when settling
    // required a normalization replace (for example, a full id to a short ref).
    restoringViewFromPopstateRef.current = false;
    restoringViewTargetRef.current = null;
    // The landing view has settled once a real file/chat is open — the default
    // file that loads on a fresh workspace replaces (landing), and only genuine
    // navigations after it push.
    if (nextViewKey.fileId || nextViewKey.chatId) landingViewSettledRef.current = true;
    lastMirroredViewKeyRef.current = nextViewKey;
  }, [activeFileIdForUrl, callbackConnectedAccountId, currentChatId, isChatVisible, isEditorVisible, isReviewVisible]);
  const activeImageFile = useMemo(
    () => (isImageFile(activeWorkspaceFile) ? activeWorkspaceFile : null),
    [activeWorkspaceFile]
  );
  const activePdfFile = useMemo(
    () => (isPdfFile(activeWorkspaceFile) ? activeWorkspaceFile : null),
    [activeWorkspaceFile]
  );
  // Office previews convert through the cloud pool, keyed to cloud project
  // ids — no pool route for local workspaces yet.
  const activeOfficeFile = useMemo(
    () => (!isLocalWorkspace && isOfficeFile(activeWorkspaceFile) ? activeWorkspaceFile : null),
    [activeWorkspaceFile, isLocalWorkspace]
  );
  const activePreviewFile = useMemo(
    () => activeImageFile ?? activePdfFile ?? activeOfficeFile,
    [activeImageFile, activePdfFile, activeOfficeFile]
  );
  const activePreviewKind = activeImageFile ? 'image' : activePdfFile ? 'pdf' : activeOfficeFile ? 'office' : null;
  // Office previews are converted PDFs — one flag for every renders-as-PDF surface.
  const previewRendersPdf = activePreviewKind === 'pdf' || activePreviewKind === 'office';
  const previewNoun = activePreviewKind === 'pdf' ? 'PDF' : activePreviewKind === 'office' ? 'document' : 'image';
  const activeTexFile = useMemo(() => isTexFile(activeWorkspaceFile), [activeWorkspaceFile]);
  const activeCodeFile = useMemo(() => isCodeFile(activeWorkspaceFile), [activeWorkspaceFile]);
  const activeIsMarkdown = useMemo(() => isMarkdownFile(activeWorkspaceFile), [activeWorkspaceFile]);
  // Edit-mode options for the active document: markdown adds the read-only View;
  // raw markdown drops Suggesting (a rich-editor feature); other types stay
  // Edit/Suggest. The workspace-global mode is coerced to one this document
  // supports, so the editor's read-only state and the toolbar never reflect an
  // unsupported mode (e.g. View on a LaTeX file, or Suggesting in raw markdown).
  // Per-file capability: path-share grants elevate the workspace baseline on
  // their covered subtree — max(baseline, covering grant role), mirroring the
  // server's canWritePath/canSuggestPath.
  const activeFileCap = useMemo(
    () =>
      pathCapability(
        { canWrite, canSuggest, canComment },
        pathGrants,
        activeWorkspaceFile?.path ?? null,
        // Anonymous suggest grants get a read-only socket (PR #835 compose
        // boundary) — their UI stays comment-only.
        Boolean(user),
      ),
    [canWrite, canSuggest, canComment, pathGrants, activeWorkspaceFile?.path, user],
  );
  // Commenters (canSuggest without canWrite) get an editable editor locked to
  // Suggesting — their typing lands as reviewable suggestions, GDocs-style.
  const documentReadOnly = !activeFileCap.canWrite && !activeFileCap.canSuggest;
  const docEditModes = !activeIsMarkdown
    ? DOC_EDIT_MODES
    : showRawView
      ? RAW_MARKDOWN_DOC_EDIT_MODES
      : MARKDOWN_DOC_EDIT_MODES;
  // Commenters are pinned to Suggesting (View where the surface has no
  // Suggesting, e.g. raw markdown) — they never get direct Edit.
  const effectiveDocEditMode: WorkspaceEditMode = !activeFileCap.canWrite
    ? docEditModes.includes('suggest')
      ? 'suggest'
      : 'view'
    : docEditModes.includes(documentEditMode)
      ? documentEditMode
      : 'edit';
  const documentEditorReadOnly = documentReadOnly || effectiveDocEditMode === 'view';
  // Raw markdown has no Suggesting: if a doc was in Suggesting when raw view
  // opens, switch it to Editing so raw writes don't persist as suggestions.
  // (Editors only — commenters must never land in Editing.)
  useEffect(() => {
    if (activeFileCap.canWrite && showRawView && activeIsMarkdown && documentEditMode === 'suggest') {
      setDocumentEditMode('edit');
    }
  }, [activeFileCap.canWrite, showRawView, activeIsMarkdown, documentEditMode, setDocumentEditMode]);
  // Pin commenters to Suggesting: the editors read the stored mode from
  // context (default 'edit'), and their socket token/UI must only suggest.
  useEffect(() => {
    if (!activeFileCap.canWrite && activeFileCap.canSuggest && documentEditMode !== 'suggest') {
      setDocumentEditMode('suggest');
    }
  }, [activeFileCap.canWrite, activeFileCap.canSuggest, documentEditMode, setDocumentEditMode]);
  // Monaco-edited files (plain code and LaTeX) support inline comments
  // anchored to their Y.Text; `isCodeFile` covers `.tex` via its generic text
  // fallback.
  const activeIsCode = activeCodeFile;
  const activeWorkspaceFileId = activeWorkspaceFile?.id ?? null;
  const activeWorkspaceFileType = activeWorkspaceFile?.type ?? null;
  const activeWorkspaceFileResetKey = activeWorkspaceFile
    ? `${activeWorkspaceFile.id}:${activeWorkspaceFile.path}:${activeWorkspaceFile.type}`
    : null;
  const activeWorkspaceDefaultsToRichViewer = shouldDefaultRichViewer(activeWorkspaceFile);

  // LaTeX document chrome: Source/Split/PDF view + shared compile lifecycle.
  // The hook stays inert (texPath null) for non-LaTeX files.
  const activeTexFileKey = activeTexFile ? activeWorkspaceFileResetKey : null;
  const [latexViewMode, setLatexViewMode] = useState<LatexViewMode>('split');
  // The tex doc whose view mode the user explicitly picked (toolbar/divider) —
  // an explicit choice must survive chat close/reopen (no auto-collapse).
  const latexViewModePinnedKeyRef = useRef<string | null>(null);
  const handleLatexViewModeChange = useCallback(
    (mode: LatexViewMode) => {
      latexViewModePinnedKeyRef.current = activeTexFileKey;
      setLatexViewMode(mode);
    },
    [activeTexFileKey],
  );
  useEffect(() => {
    if (activeTexFileKey) {
      latexViewModePinnedKeyRef.current = null;
      // The embedded panel (?view=panel) shows ONE surface at a time, so a
      // tex file lands on Source (the documented filePath=main.tex contract);
      // agents steer to pdf. The full editor keeps its Split default.
      setLatexViewMode(latchPanelView() ? 'source' : 'split');
    }
  }, [activeTexFileKey]);
  const previousLatexChatCollapseStateRef = useRef<LatexChatCollapseState>({
    chatOpen: false,
    texFileKey: null,
  });
  useEffect(() => {
    const next = { chatOpen: isChatVisible, texFileKey: activeTexFileKey };
    const pinned = latexViewModePinnedKeyRef.current === activeTexFileKey && activeTexFileKey != null;
    if (shouldCollapseLatexPdfForChatOpen(previousLatexChatCollapseStateRef.current, next, pinned)) {
      setLatexViewMode('source');
    }
    previousLatexChatCollapseStateRef.current = next;
  }, [activeTexFileKey, isChatVisible]);
  // Main-document resolution (W1.root §3): the resolved root is the compile
  // target, regardless of which file is open. The dropdown lives in the chrome.
  const texFileSignature = useMemo(
    () => workspaceFiles.filter((f) => isTexFile(f)).map((f) => f.path).sort().join('|'),
    [workspaceFiles]
  );
  const latexMainDocument = useLatexMainDocument({
    projectId,
    activeFile: activeWorkspaceFile?.path ?? null,
    texFileSignature,
    // Paused while an open-file move settles: resolving mid-window can cache
    // a pre-rename root; the enabled flip on settle forces a fresh fetch.
    enabled: activeTexFile && !pendingOpenFileMove,
    fetchImpl: apiFetch,
  });
  // The root whose diagnostics the user is navigating (handleLatexNavigate):
  // opening an included child of a multi-root directory re-resolves as
  // `ambiguous`, which would drop the compile state mid-navigation — keep that
  // root as the target while it is still a candidate. Scoped to the navigated
  // child (and the root itself): any other open file ignores the pin, so it
  // can't leak onto unrelated ambiguous fragments.
  const [latexNavPin, setLatexNavPin] = useState<{ root: string; child: string } | null>(null);
  const activePath = activeWorkspaceFile?.path ?? null;
  const latexPinnedRoot =
    latexNavPin && (activePath === latexNavPin.child || activePath === latexNavPin.root)
      ? latexNavPin.root
      : null;
  // Leaving both the pinned root and its child ends the navigation — drop the
  // pin so returning to that child later re-resolves normally. A pinned root
  // that no longer EXISTS (deleted by the user or an agent while the child
  // stays open) goes too: nothing would falsify it otherwise, and every
  // compile would keep posting the dead path.
  useEffect(() => {
    if (!latexNavPin) return;
    const leftBothFiles = activePath !== latexNavPin.child && activePath !== latexNavPin.root;
    if (leftBothFiles || !workspaceFileByPath.has(latexNavPin.root)) setLatexNavPin(null);
  }, [activePath, latexNavPin, workspaceFileByPath]);
  const latexRootPath = latexCompileTarget(
    latexMainDocument,
    activeTexFile ? activePath : null,
    latexPinnedRoot,
  );
  // Live editor source only describes the open file — only forward it when the
  // open file *is* the root. Otherwise compile the root from the doc store.
  const activeIsRoot = Boolean(latexRootPath && latexRootPath === activeWorkspaceFile?.path);
  // Compile-log paths (root-dir-relative / sandbox-absolute) → workspace paths,
  // so errors inside \input'd children navigate and mark the right file. Only
  // .tex targets: opening anything else leaves the LaTeX surface (and its
  // markers) behind, so those rows stay informational.
  const resolveLatexLog = useCallback(
    (file: string | null) =>
      resolveLatexLogPath(file, latexRootPath, (p) => {
        const type = workspaceFileByPath.get(p)?.type;
        return type != null && type !== 'folder' && /\.tex$/i.test(p);
      }),
    [latexRootPath, workspaceFileByPath],
  );
  // Auto compile (§1.2): per-user pref (default on for cloud workspaces) and
  // the tab's local-typing tracker. The tracker is one mutable object bumped
  // per local Y.Doc transaction — never React state, so typing costs no extra
  // page renders (the O(change) keystroke invariant).
  const { autoCompile: latexAutoCompile, toggleAutoCompile: toggleLatexAutoCompile } = useLatexAutoCompilePref();
  const latexLocalEditsRef = useRef<LocalEditTracker>({ version: 0, lastEditAt: 0 });
  const noteLatexLocalEdit = useCallback(() => {
    const tracker = latexLocalEditsRef.current;
    tracker.version += 1;
    tracker.lastEditAt = Date.now();
  }, []);
  const latexCompile = useLatexCompile({
    projectId,
    chatId: currentChatId,
    // Inert while an open-file move is settling: the mount probe would 404 on
    // the optimistic path and auto-compile artifacts there before the server
    // rename moves the old ones — colliding with the rename itself.
    texPath: activeTexFile && !pendingOpenFileMove ? latexRootPath : null,
    // Per-path: path-share editors compile inside their FOLDER grant even
    // while the workspace baseline is read-only (mirrors the route's
    // canCreatePath — exact-file grants can't compile).
    canWrite: latexRootPath ? canCreateWorkspacePath(latexRootPath) : canWrite,
    source: activeIsRoot ? viewerContent : null,
    getSource: activeIsRoot ? () => readEditorText() ?? viewerContent : undefined,
    compileWithoutSource: activeTexFile && Boolean(latexRootPath) && !activeIsRoot,
    fetchImpl: apiFetch,
    liveRefresh: !isLocalWorkspace,
    resolveLogPath: resolveLatexLog,
    initialCompileError:
      onboardingTexIntent && latexRootPath === WELCOME_TEX_PATH
        ? WELCOME_TEX_INITIAL_COMPILE_ERROR
        : null,
    // Cloud only: local projects already have the sidecar's own file-watch
    // recompile loop, and their PDFs never ride liveRefresh.
    autoCompile: latexAutoCompile && !isLocalWorkspace,
    // Agent edits compile brain-side at turn end (agent-ts/src/latex/
    // autocompile.ts) — the browser must not duplicate that or surface the
    // transient failures its self-heal loop is about to fix. Any live run
    // counts: the current chat's stream AND background chats (the hidden
    // LaTeX fix chat included), whose runs land in chatStatusById. Also held
    // while the root is re-resolving after a file switch: an auto compile
    // fired then would build the WRONG root and seed the new one as clean.
    holdAutoCompile:
      sundialChatBusy ||
      !latexMainDocument.resolved ||
      Object.values(chatStatusById).some((s) => s === 'working' || s === 'starting'),
    localEdits: latexLocalEditsRef.current,
    // The open file's live text is the change clock — for a fragment too (the
    // compile reads the fragment from the doc store, persisted ~1s behind).
    editedSource: activeTexFile ? viewerContent : null,
    editedPath: activeWorkspaceFile?.path ?? null,
  });
  const latexMarkers = useMemo(
    () => buildLatexMarkers(latexCompile.problems, activeTexFile ? activeWorkspaceFile?.path ?? null : null),
    [latexCompile.problems, activeTexFile, activeWorkspaceFile?.path],
  );

  // Local projects: no brain background-compiles .tex edits, so agent/external
  // writes (the sidecar only emits those — user typing is watcher-suppressed)
  // trigger a debounced recompile. This is what makes "Fix with Agent" refresh
  // the PDF locally, standing in for the cloud's Supabase liveRefresh.
  const latexRecompileRef = useRef(latexCompile.recompile);
  latexRecompileRef.current = latexCompile.recompile;
  // A refresh landing MID-compile must not be dropped (recompile() no-ops
  // while busy) — park it and fire once the current compile/load settles.
  const latexBusyRef = useRef(latexCompile.busy);
  latexBusyRef.current = latexCompile.busy;
  const pendingLocalRecompileRef = useRef(false);
  useEffect(() => {
    if (!latexCompile.busy && pendingLocalRecompileRef.current) {
      pendingLocalRecompileRef.current = false;
      latexRecompileRef.current();
    }
  }, [latexCompile.busy]);
  useEffect(() => {
    if (!localConfig || !projectId || !activeTexFile) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = localSidecar.subscribe(localConfig, projectId, (event) => {
      // Any LaTeX SOURCE (.tex/.bib/.sty/.cls/.bst — policy.json) affects the
      // build; the compile reads the whole project from disk.
      if (event.type !== 'files-changed' || !isLatexSourceFile(event.path)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (latexBusyRef.current) pendingLocalRecompileRef.current = true;
        else latexRecompileRef.current();
      }, 800);
    });
    return () => {
      pendingLocalRecompileRef.current = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [localConfig, projectId, activeTexFile]);

  // SyncTeX click-to-source (W4.synctex). Fetch + parse the root's
  // `<root>.synctex.gz` whenever a fresh PDF lands (pdfUrl is a per-compile blob
  // URL). Gestures no-op when the index is absent (older/sandbox compiles).
  const [synctexIndex, setSynctexIndex] = useState<SyncTexIndex | null>(null);
  useEffect(() => {
    // Cleared up front: the old index describes the previous PDF, so forward
    // search must not jump by it while the new artifact downloads.
    setSynctexIndex(null);
    if (!projectId || !latexRootPath || !latexCompile.pdfUrl) return;
    const synctexPath = latexRootPath.replace(/\.tex$/i, '.synctex.gz');
    const controller = new AbortController();
    (async () => {
      try {
        const params = new URLSearchParams({ projectId, path: synctexPath });
        const res = await apiFetch(`/api/workspace/files/download?${params}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) return;
        const index = await parseSyncTex(await res.arrayBuffer());
        if (!controller.signal.aborted) setSynctexIndex(index);
      } catch {
        // Index stays null — SyncTeX is best-effort.
      }
    })();
    return () => controller.abort();
  }, [projectId, latexRootPath, latexCompile.pdfUrl]);

  // Upload an image dropped/pasted into the LaTeX editor into an `images/`
  // folder beside the .tex file; returns the workspace path. The editor turns
  // it into a tex-relative `\includegraphics{…}` reference.
  const handleLatexImageUpload = useCallback(
    async (file: File): Promise<string | null> => {
      if (!projectId || !activeWorkspaceFile) return null;
      const texPath = activeWorkspaceFile.path;
      const texDir = texPath.includes('/') ? texPath.slice(0, texPath.lastIndexOf('/')) : '';
      if (!canUploadToFolder(texDir ? `${texDir}/images` : 'images')) return null;
      try {
        const result = await uploadImageFromEditor({
          projectId,
          file,
          existingPaths,
          folder: texDir ? `${texDir}/images` : 'images',
          uploadBinary: localBinaryUpload,
        });
        filesChannelRef.current?.postMessage({ type: 'refresh' });
        return result.path;
      } catch (error) {
        console.error('[latex] image upload failed', error);
        return null;
      }
    },
    [projectId, canUploadToFolder, activeWorkspaceFile, existingPaths, localBinaryUpload],
  );
  const activeCsvFile = useMemo(() => isCsvFile(activeWorkspaceFile), [activeWorkspaceFile]);
  // Drop the prior file's live suggestion set on switch; the new file's editor
  // re-emits once it binds (else a stale diff flashes on the new CSV).
  useEffect(() => {
    setCsvLiveSuggestions(null);
  }, [activeWorkspaceFileId]);
  const activeJsonFile = useMemo(() => isJsonFile(activeWorkspaceFile), [activeWorkspaceFile]);
  const activeHtmlFile = useMemo(() => isHtmlFile(activeWorkspaceFile), [activeWorkspaceFile]);
  const hasRichViewer = activeCsvFile || activeJsonFile || activeHtmlFile;
  const richViewerKind = activeCsvFile ? 'csv' as const : activeJsonFile ? 'json' as const : activeHtmlFile ? 'html' as const : null;
  const openSpaceFromCommentDeepLink = useCallback(() => {
    setWorkspaceViewMode('space');
    if (isMobile) {
      setMobilePanel(null);
    }
  }, [isMobile, setWorkspaceViewMode]);

  // Local comments realtime: filter the sidecar's SSE stream down to
  // comments-changed so the hook reloads exactly when its store changes.
  const subscribeLocalCommentsChanged = useMemo(
    () =>
      localConfig && projectId
        ? (onChange: () => void) =>
            localSidecar.subscribe(localConfig, projectId, (event) => {
              if (event.type === 'comments-changed') onChange();
            })
        : null,
    [localConfig, projectId],
  );

  // The commenting identity — the composer, optimistically-rendered comments,
  // and "is this mine?" ownership all read it. It must be the SAME identity the
  // server stamps on a sent comment, or the draft shows a stranger (a nameless
  // "You") that turns into the real person the moment it posts. The id has to
  // match too: withOptimistic binds the server echo by author id, and the
  // author-only actions (edit, delete) gate on it.
  const commentCurrentUser = useMemo(
    () =>
      resolveCommentIdentity({
        userId: user?.id ?? null,
        fullName: user?.fullName ?? null,
        username: user?.username ?? null,
        imageUrl: user?.imageUrl ?? null,
        desktopProfile,
        anonId,
      }),
    [user?.id, user?.fullName, user?.username, user?.imageUrl, desktopProfile, anonId],
  );

  // PDF comments (dark launch): comment on the compiled preview, anchored to
  // the LaTeX source through SyncTeX. Account-backed flag, Settings → Advanced;
  // `savedFlags` is live state, so the toggle applies without a reload.
  // `?pdfcomments=on|off` is a session-only escape hatch (autocomplete's URL
  // pattern): in-memory for this page load, never localStorage or the account.
  const [pdfCommentsUrlOverride, setPdfCommentsUrlOverride] = useState<boolean | null>(null);
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('pdfcomments');
    if (value === 'on' || value === 'off') setPdfCommentsUrlOverride(value === 'on');
  }, []);
  const pdfCommentsEnabled = pdfCommentsUrlOverride ?? savedFlags?.pdf_comments_enabled ?? false;

  const {
    commentLaneRowRef,
    commentsAvailableForActiveFile,
    canCommentOnActiveFile,
    resolvedCommentRanges,
    draftCommentRange,
    openCommentThreads,
    reportCommentAnchors,
    showInlineCommentLane,
    commentsLaneToggled,
    displayedCommentThreads,
    displayedResolvedThreads,
    displayedCommentsLoading,
    displayedCommentsError,
    commentBadgeCount,
    activeFileCommentCount,
    commentDocumentLabel,
    commentPanelMode,
    docCommentAnchorOffsets,
    commentAnchorLines,
    measuredCommentAnchorIds,
    draftCommentAnchorOffset,
    activeCommentThreadId,
    draftCommentSelection,
    draftCommentBody,
    replyRestore: commentReplyRestore,
    commentBusyAction,
    toggleCommentLane,
    resetActiveComment,
    handleModeChange: handleCommentModeChange,
    selectThread: selectCommentThread,
    openWorkspaceCommentThread,
    closeLane: closeCommentLane,
    createComment,
    cancelDraft: cancelCommentDraft,
    replyToComment,
    updateCommentStatus,
    editCommentMessage,
    deleteCommentMessage,
    copyCommentLink,
    contextMenu: commentContextMenu,
    openContextMenuDraft: openCommentDraft,
    openContextMenuChat: openCommentChat,
    dismissContextMenu: dismissCommentContextMenu,
    commentMenuRef,
  } = useWorkspaceComments({
    projectId,
    supabaseClient,
    // Local projects: reads/writes go to the sidecar store through the
    // emulated fetch; its SSE stream replaces the Supabase realtime channel.
    fetchImpl: apiFetch,
    subscribeToChanges: subscribeLocalCommentsChanged,
    isLocalProject: Boolean(localConfig),
    workspaceRouteId,
    activeWorkspaceFile,
    activeIsMarkdown,
    activeIsCode,
    markdownEditor,
    // PDF-only LaTeX view hides the source pane (width 0), so the commentable
    // surface isn't on screen — gate comments off like raw markdown view.
    // With PDF comments on, the PDF itself is the commentable surface (the
    // hidden Monaco instance still resolves anchors), so the gate lifts.
    showRawView: showRawView || (activeTexFile && latexViewMode === 'pdf' && !pdfCommentsEnabled),
    hasRichViewer,
    showRichViewer,
    canComment: activeFileCap.canComment,
    isMobile,
    currentUser: commentCurrentUser,
    workspaceFileByPath,
    deepLinkedCommentThreadId,
    deepLinkedWorkspaceFile,
    filesLoaded,
    hasMounted,
    selectedFilePath,
    onSelectFile: setSelectedFilePath,
    onOpenSpace: openSpaceFromCommentDeepLink,
    showWorkspaceAppNotice,
    initialLoadEnabled: backgroundDataReady,
  });

  // Loud claim nudge: an anon OWNER who is signed out is one lost link away
  // from a lost workspace. Points at the Log in button; claim-on-login does
  // the actual claiming. Session-dismissible; latch read after mount so the
  // server render and first client render stay identical.
  const [claimNudgeDismissed, setClaimNudgeDismissed] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem('sundial:claim-nudge-dismissed') === '1') setClaimNudgeDismissed(true);
    } catch {
      /* storage denied — nudge shows, dismiss just won't persist */
    }
  }, []);
  const dismissClaimNudge = useCallback(() => {
    setClaimNudgeDismissed(true);
    try {
      sessionStorage.setItem('sundial:claim-nudge-dismissed', '1');
    } catch {
      /* per-render dismiss still holds */
    }
  }, []);

  // Creation decided eligibility and encoded it in the URL. `filePath` lets
  // the server preload this exact Y.Doc; `onboarding=tex` claims the primary
  // pane without a checklist request or a file-download verification probe.
  useEffect(() => {
    if (!onboardingTexIntent || !filesLoaded || !workspaceFileByPath.has(WELCOME_TEX_PATH)) return;
    if (localConfig || pathGrants.length > 0) return;
    if (!canWrite || panelViewActive) return;
    if (selectedFilePath !== WELCOME_TEX_PATH) {
      setSelectedFilePath(WELCOME_TEX_PATH);
      claimPrimaryWithFile(WELCOME_TEX_PATH);
    }
  }, [
    onboardingTexIntent,
    filesLoaded,
    workspaceFileByPath,
    localConfig,
    pathGrants.length,
    canWrite,
    panelViewActive,
    selectedFilePath,
    claimPrimaryWithFile,
  ]);

  useEffect(() => {
    const eligible =
      onboardingTexIntent &&
      filesLoaded &&
      workspaceFileByPath.has(WELCOME_TEX_PATH) &&
      canWrite &&
      !panelViewActive &&
      !readOnboardingLandingDone();
    setShowOnboardingTexGuide(eligible);
    if (eligible && onboardingGuideReportedRef.current !== projectId) {
      onboardingGuideReportedRef.current = projectId;
      track('onboarding_tex_guide_shown', { projectId });
    }
  }, [canWrite, filesLoaded, onboardingTexIntent, panelViewActive, projectId, workspaceFileByPath]);

  const dismissOnboardingTexGuide = useCallback(() => {
    markOnboardingLandingDone();
    setShowOnboardingTexGuide(false);
    track('onboarding_tex_guide_skipped', { projectId });
  }, [projectId]);

  useEffect(() => {
    if (!onboardingTexIntent || !filesLoaded || onboardingPerfReportedRef.current === projectId) return;
    if (!workspaceFileByPath.has(WELCOME_TEX_PATH)) return;
    onboardingPerfReportedRef.current = projectId;
    const elapsedMs = Math.round(onboardingElapsedMs());
    const navigationElapsedMs = Math.round(performance.now());
    track('onboarding_workspace_visible', {
      projectId,
      elapsedMs,
      budgetMs: WORKSPACE_VISIBLE_BUDGET_MS,
      withinBudget: elapsedMs <= WORKSPACE_VISIBLE_BUDGET_MS,
    });
    // The known error is supplied synchronously to the compile controller in
    // this same render, so this is also the diagnostic-visible milestone.
    track('onboarding_diagnostic_visible', {
      projectId,
      elapsedMs: navigationElapsedMs,
      budgetMs: STARTER_DIAGNOSTIC_BUDGET_MS,
      withinBudget: navigationElapsedMs <= STARTER_DIAGNOSTIC_BUDGET_MS,
    });
    clearOnboardingCreationTiming();
  }, [filesLoaded, onboardingTexIntent, projectId, workspaceFileByPath]);

  // Single invalidation token feeding the inline-diff hook. Combines every
  // upstream "you should refetch now" signal we have:
  //  - `docEditsRealtimeKey`: Supabase Realtime INSERT on `doc_edits`
  //    (+ visibility/focus revalidation inside the hook).
  //  - per-message `(id, has_turn_edits, edited_file_count)` fingerprint:
  //    mirrors the chat panel's own auto-expand trigger so the inline
  //    overlay refreshes in the same tick the chat card pops in.
  const docEditsRealtimeKey = useDocEditsRealtimeKey(supabaseClient, projectId);
  // Turn-edit payloads are cached by review id, and LOCAL ids (`applied-<n>`)
  // repeat across projects — bind the cache to the open workspace so a second
  // local project can't read the first one's diffs (Codex, PR #1104 round 20).
  useEffect(() => {
    setTurnEditsCacheWorkspace(projectId ?? null);
  }, [projectId]);
  // Local stand-in for the `doc_edits` Realtime channel — see the hook.
  const localFileEventsKey = useLocalFileEventsKey(localConfig, projectId);
  const pendingEditsInvalidationToken = useMemo(
    () =>
      buildPendingEditsInvalidationToken({
        docEditsRealtimeKey,
        messages: liveChatMessagesForEdits,
        localFileEventsKey,
      }),
    [docEditsRealtimeKey, liveChatMessagesForEdits, localFileEventsKey],
  );
  // Authoritative source for the "Edited in this response" composer chip: the
  // `doc_edits` table, surfaced via `/api/workspace/chat-turn-edits`. Reuses
  // `pendingEditsInvalidationToken` so we refetch on Realtime INSERTs *and*
  // when the assistant message's `has_turn_edits`/`edited_file_count` flip —
  // the latter is the only signal we get when the brain back-fills
  // `assistant_message_id` on Bash-written rows at end-of-turn (UPDATEs that
  // never reach the INSERT-only realtime channel).
  const currentChatTurnEdits = useChatTurnEdits(cloudProjectId ? currentChatId : null, pendingEditsInvalidationToken);
  const editedFilesForCurrentTurn = useMemo<string[]>(() => {
    if (!currentChatTurnEdits) return [];
    // Compute the turn boundary from the SAME array we scan — using the
    // REST-derived `latestUserInfo.index` against the live array drifted and
    // bled the previous turn's files into a no-edit follow-up.
    return editedFilesForLatestTurn(
      liveChatMessagesForEdits,
      currentChatTurnEdits.turns,
      (filePath) => {
        const file = workspaceFileByPath.get(filePath);
        return Boolean(file && (file.type === 'folder' || file.type === 'proposal'));
      },
    );
  }, [currentChatTurnEdits, liveChatMessagesForEdits, workspaceFileByPath]);

  // Chat-first landing payoff: the first agent edit slides the editor in on the
  // edited file, so the user lands on the tracked changes instead of reading
  // about them secondhand in chat. Armed only when a turn STARTS while chat is
  // the sole panel — arriving at an old chat whose last turn edited files must
  // not yank the layout — and fires at most once per chat. Cloud chats report
  // edits via doc_edits (`editedFilesForCurrentTurn`); local-engine chats have
  // no doc_edits, so fall back to the turn's Write/Edit tool parts.
  // Armed FOR a specific chat id — a stale arm from a no-edit turn must not
  // fire on another chat whose latest turn happens to have historical edits.
  const firstEditRevealArmedForRef = useRef<string | null>(null);
  // Snapshot of (last user id | candidate list) taken AT ARM TIME. The status
  // can flip before the new user row reaches the live array (cross-user
  // realtime), when the candidates still describe the PREVIOUS turn — only
  // reveal once this key has advanced, i.e. an edit attributable to the turn
  // that armed us.
  const firstEditRevealBaselineRef = useRef<string | null>(null);
  const firstEditRevealChatRef = useRef<string | null>(null);
  const previousChatStatusForRevealRef = useRef(currentChatStatus);
  const firstEditRevealCandidates = useMemo(
    () =>
      editedFilesForCurrentTurn.length
        ? editedFilesForCurrentTurn
        : editedPathsFromLatestTurnToolParts(liveChatMessagesForEdits),
    [editedFilesForCurrentTurn, liveChatMessagesForEdits],
  );
  // Topbar assistant bubbles — founder: presence there means the agent's
  // cursor is IN a file, not that a chat is running. A run only surfaces a
  // bubble while it has fresh file-editing activity: a doc_edits row within
  // the ghost-cursor TTL (cloud), or — for local-engine chats, which write
  // no doc_edits — live Write/Edit tool parts on the current chat's turn.
  const activeAssistantBubbles = useMemo(
    () =>
      chatEntries.filter((entry) => {
        if (entry.isArchived) return false;
        const status = effectiveChatStatus(entry.chat.id);
        if (status !== 'working' && status !== 'starting') return false;
        if (agentEditingChatIds.has(entry.chat.id)) return true;
        return (
          !cloudProjectId &&
          entry.chat.id === currentChatId &&
          hasLiveChatRun &&
          firstEditRevealCandidates.length > 0
        );
      }),
    [
      agentEditingChatIds,
      chatEntries,
      cloudProjectId,
      currentChatId,
      effectiveChatStatus,
      firstEditRevealCandidates,
      hasLiveChatRun,
    ]
  );
  const firstEditRevealKey = useMemo(() => {
    let lastUserId: string | null = null;
    for (let i = liveChatMessagesForEdits.length - 1; i >= 0; i -= 1) {
      if (liveChatMessagesForEdits[i]?.role === 'user') {
        lastUserId = liveChatMessagesForEdits[i]?.id ?? null;
        break;
      }
    }
    return `${lastUserId}|${firstEditRevealCandidates.join(',')}`;
  }, [firstEditRevealCandidates, liveChatMessagesForEdits]);
  useEffect(() => {
    const previous = previousChatStatusForRevealRef.current;
    previousChatStatusForRevealRef.current = currentChatStatus;
    if (isAgentTurnJustStarted(previous, currentChatStatus)) {
      // Desktop only, deliberately: there the editor opens BESIDE the chat
      // (additive). On mobile it would replace the streaming transcript — the
      // single panel — mid-turn; the diff card in the transcript is the
      // mobile affordance for jumping to the edit.
      const arm = visibleColumns.chatSole && !isMobile;
      firstEditRevealArmedForRef.current = arm ? currentChatId : null;
      firstEditRevealBaselineRef.current = arm ? firstEditRevealKey : null;
    }
  }, [currentChatId, currentChatStatus, firstEditRevealKey, isMobile, visibleColumns.chatSole]);
  useEffect(() => {
    if (!currentChatId || firstEditRevealArmedForRef.current !== currentChatId) return;
    if (firstEditRevealChatRef.current === currentChatId) return;
    // The user opened another panel mid-turn — they're arranging the space
    // themselves, don't fight them.
    if (!visibleColumns.chatSole || isMobile) {
      firstEditRevealArmedForRef.current = null;
      return;
    }
    // Nothing new since arming — these candidates predate the armed turn.
    if (firstEditRevealKey === firstEditRevealBaselineRef.current) return;
    const isOpenable = (path: string) => {
      const file = workspaceFileByPath.get(path);
      return Boolean(file && file.type !== 'folder' && file.type !== 'proposal');
    };
    for (const candidate of firstEditRevealCandidates) {
      const resolved = resolveEditedPathToWorkspacePath(candidate, isOpenable, () =>
        [...workspaceFileByPath.keys()].filter(isOpenable),
      );
      if (!resolved) continue;
      firstEditRevealArmedForRef.current = null;
      firstEditRevealChatRef.current = currentChatId;
      arrivalChatDefaultRef.current = false;
      // Desktop: the chat stays put (it's the active tab) and the edited doc
      // slides in as a side pane — the wireframe's split, not a mode swap.
      // The selection follows so review state / URL / composer context key
      // off the revealed file (the pane mirror skips paths open in a pane).
      // Web (no-tabs) shell: files-left/chats-right — the doc claims the
      // primary and the chat docks to its right instead.
      if (!isMobile && isChatTab(editorPanesRef.current[0].active)) {
        if (desktopTabs) setEditorPanes((prev) => openPaneToSide(prev, resolved));
        else claimPrimaryWithFile(resolved, { chatAside: true });
        setSelectedFilePath(resolved);
      } else {
        setSelectedFilePath(resolved);
        openCenterPanel('editor');
      }
      return;
    }
  }, [
    claimPrimaryWithFile,
    currentChatId,
    desktopTabs,
    firstEditRevealCandidates,
    firstEditRevealKey,
    isMobile,
    openCenterPanel,
    visibleColumns.chatSole,
    workspaceFileByPath,
  ]);

  // §15.5 — after a Sunny turn that touched the open LaTeX file, recompile so
  // the preview reflects the new content. Turn-edit rows arrive async (the brain
  // back-fills `assistant_message_id` at end-of-turn), so we arm on the
  // status→finished rising edge and fire once `editedFilesForCurrentTurn`
  // confirms the active .tex was edited; a fresh turn disarms a stale wait.
  const previousChatStatusForLatexRef = useRef(currentChatStatus);
  const awaitingLatexTurnRecompileRef = useRef(false);
  useEffect(() => {
    const previous = previousChatStatusForLatexRef.current;
    previousChatStatusForLatexRef.current = currentChatStatus;
    if (isAgentTurnJustStarted(previous, currentChatStatus)) {
      awaitingLatexTurnRecompileRef.current = false;
    }
    if (isAgentTurnJustFinished(previous, currentChatStatus)) {
      awaitingLatexTurnRecompileRef.current = true;
    }
    if (!awaitingLatexTurnRecompileRef.current) return;
    if (!activeTexFile || !activeWorkspaceFile) return;
    if (!editedFilesForCurrentTurn.includes(activeWorkspaceFile.path)) return;
    awaitingLatexTurnRecompileRef.current = false;
    latexCompile.recompile();
  }, [
    currentChatStatus,
    editedFilesForCurrentTurn,
    activeTexFile,
    activeWorkspaceFile,
    latexCompile,
  ]);

  // Not cloud-gated: local workspaces answer through the sidecar shim, so the
  // suggestion gutter's author chip works on desktop too.
  const spaceFilePendingTurns = useFilePendingTurns(
    backgroundDataReady ? projectId : null,
    activeWorkspaceFile?.path ?? null,
    pendingEditsInvalidationToken,
    apiFetch,
  );
  const spacePendingAdditions = useMemo(
    () =>
      buildActionableWorkspacePendingAdditions({
        turns: spaceFilePendingTurns.turns,
        filePath: activeWorkspaceFile?.path,
        resolveAuthorLabel: resolvePendingEditAuthorLabel,
        resolveAuthorVisual: resolvePendingEditAuthorVisual,
      }),
    [spaceFilePendingTurns.turns, activeWorkspaceFile?.path, resolvePendingEditAuthorLabel, resolvePendingEditAuthorVisual],
  );
  // Authorship lens (formatting bar): band the WHOLE document by who wrote each
  // line, with "Author · when" in the margin. Data comes from /file-blame on
  // toggle — off by default, it's a lens you reach for, not the reading state.
  const [showAuthorship, setShowAuthorship] = useState(false);
  const [blameLines, setBlameLines] = useState<FileBlameResponse['lines'] | null>(null);
  // The sticky link token in force, re-read on every URL change: a second,
  // narrower ?pshare= link for the same workspace must re-key the lens, or
  // attribution fetched under the WIDER grant stays painted (Codex, PR #1104
  // round 33). searchParams is the re-render signal for in-app navigation.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- searchParams IS the dep: the token lives in the URL/sessionStorage, not in React state.
  const blameShareToken = useMemo(() => currentPathShareToken(), [searchParams]);
  useEffect(() => {
    setShowAuthorship(false);
    setBlameLines(null);
  }, [activeWorkspaceFile?.path]);
  useEffect(() => {
    // A token change repaints from scratch — never leave the old grant's
    // names/timestamps up while the new fetch runs.
    setBlameLines(null);
  }, [blameShareToken]);
  useEffect(() => {
    if (!showAuthorship || !cloudProjectId || !activeWorkspaceFile?.path) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/workspace/file-blame?workspaceId=${encodeURIComponent(cloudProjectId)}&filePath=${encodeURIComponent(activeWorkspaceFile.path)}`,
          { cache: 'no-store' },
        );
        const data = await readJsonResponse<FileBlameResponse & { error?: string }>(res);
        if (!res.ok || !data) throw new Error(data?.error || `Failed to load authorship (${res.status})`);
        // Authorized under the token in force when the fetch STARTED — a
        // narrower link opening mid-flight must not paint this answer.
        if (currentPathShareToken() !== blameShareToken) return;
        if (!cancelled) setBlameLines(data.lines);
      } catch {
        if (!cancelled) setBlameLines([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // pendingEditsInvalidationToken: re-blame after new edits land while the lens is on.
  }, [showAuthorship, cloudProjectId, activeWorkspaceFile?.path, apiFetch, pendingEditsInvalidationToken, blameShareToken]);
  const handleJumpToTurnRef = useRef<(assistantMessageId: string, chatId: string | null) => void>(() => {});
  const authorshipRanges = useMemo(
    () =>
      showAuthorship && blameLines
        ? buildAuthorshipRanges(blameLines, {
            resolveLabel: (authorId) => resolvePendingEditAuthorLabel({ authorId } as FilePendingTurn),
            formatWhen: (createdAt) => (createdAt ? formatRelativeTime(createdAt) : null),
            resolveVisual: (line) =>
              resolvePendingEditAuthorVisual({ authorId: line.authorId, chatId: line.chatId } as FilePendingTurn),
          }).map((range) => ({
            ...range,
            // The path the attributing EDIT was written at: after a move the
            // turn's diff is still filed under the source path, so stamping the
            // open file made the hover card miss it (Codex, PR #1104 round 30).
            filePath: range.filePath ?? activeWorkspaceFile?.path ?? null,
            // Same affordance as the suggestion chips: the margin annotation
            // opens the turn that wrote these lines.
            onJump: range.assistantMessageId
              ? () => handleJumpToTurnRef.current(range.assistantMessageId!, range.chatId ?? null)
              : undefined,
          }))
        : [],
    [showAuthorship, blameLines, resolvePendingEditAuthorLabel, resolvePendingEditAuthorVisual],
  );
  // Who suggested each markdown line, for the review gutter's profile icon.
  const spaceSuggestionAuthors = useMemo(
    () =>
      buildSuggestionAuthors({
        turns: spaceFilePendingTurns.turns,
        suggestionTurns: spaceFilePendingTurns.suggestionTurns,
        resolveAuthorLabel: resolvePendingEditAuthorLabel,
        resolveAuthorVisual: resolvePendingEditAuthorVisual,
      }),
    [spaceFilePendingTurns.turns, spaceFilePendingTurns.suggestionTurns, resolvePendingEditAuthorLabel, resolvePendingEditAuthorVisual],
  );
  // Keys are `${reviewId}:${chunkId}` for a single chunk, or `${reviewId}:*`
  // for a whole human suggestion run (one Accept/Reject for the paste). The
  // reviewId (a UUID or `human-<rowId>`) never contains a colon, so the first
  // segment is the id and the rest is the chunk id / `*`.
  const handleSpaceKeepAddition = useCallback(
    (key: string) => {
      const idx = key.indexOf(':');
      const assistantMessageId = idx >= 0 ? key.slice(0, idx) : '';
      const chunkId = idx >= 0 ? key.slice(idx + 1) : '';
      if (!assistantMessageId || !chunkId || !activeWorkspaceFile?.path) return;
      spaceFilePendingTurns.keepChunk(assistantMessageId, activeWorkspaceFile.path, chunkId);
    },
    [spaceFilePendingTurns, activeWorkspaceFile?.path],
  );
  const handleSpaceUndoAddition = useCallback(
    (key: string) => {
      const idx = key.indexOf(':');
      const assistantMessageId = idx >= 0 ? key.slice(0, idx) : '';
      const chunkId = idx >= 0 ? key.slice(idx + 1) : '';
      if (!assistantMessageId || !chunkId || !activeWorkspaceFile?.path) return;
      void spaceFilePendingTurns.undoChunk(assistantMessageId, activeWorkspaceFile.path, chunkId);
    },
    [spaceFilePendingTurns, activeWorkspaceFile?.path],
  );
  // CSV table → code editor: row edits and suggestion accept/reject reuse the
  // editor's machinery (Monaco executeEdits → Y.Text/ledger; ledger resolve).
  const handleCsvRowOp = useCallback(
    (op: { type: 'replace' | 'insertAfter' | 'delete'; line: number; text?: string }) => {
      textEditorRef.current?.applyCsvRowOp?.(op);
    },
    [],
  );
  const handleCsvResolveSuggestion = useCallback((key: string, keep: boolean) => {
    textEditorRef.current?.resolveSuggestion?.(key, keep);
  }, []);
  const handleJumpToTurn = useCallback(
    (assistantMessageId: string, chatId: string | null) => {
      // Switch to the chat that owns this turn before scrolling — otherwise
      // the message lookup hits whatever chat happens to be open (typically
      // the most recent), so every click would land on the same message.
      if (chatId) {
        setSelectedChatSurface((prev) =>
          prev.type === 'direct' && prev.chatId === chatId
            ? prev
            : { type: 'direct', chatId },
        );
        const idx = chatThreadsForCurrentProject.findIndex(
          (thread) => thread.chat.id === chatId,
        );
        if (idx >= 0) setSelectedChatIndex(idx);
        void ensureChatMessagesLoaded(chatId);
      }
      // Make sure the chat is visible: mobile swaps the main view; desktop
      // opens the chat column beside whatever is already open.
      if (isMobile) {
        setWorkspaceViewMode('chat');
      } else {
        // side: review/turn chips reveal the chat BESIDE the doc they
        // annotate (falls through to full-width when nothing is open).
        openCenterPanel('chat', chatId ? { chatId, side: true } : undefined);
      }
      // Poll until the message DOM node exists — the chat panel needs to
      // mount and `ensureChatMessagesLoaded` may still be in flight when
      // the click fires, so a one-shot timeout would frequently miss.
      const start = performance.now();
      const tryScroll = () => {
        // The editor's `Sunny #N` chip also carries `data-message-id`, so
        // restrict to the chat transcript's div wrappers — otherwise the
        // query lands on the button you just clicked and never reaches the
        // chat message.
        const target = document.querySelector(
          `div[data-message-id="${assistantMessageId}"]`,
        ) as HTMLElement | null;
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('chat-message-pulse');
          window.setTimeout(() => target.classList.remove('chat-message-pulse'), 1600);
          return;
        }
        if (performance.now() - start < 4000) {
          window.setTimeout(tryScroll, 120);
        }
      };
      tryScroll();
    },
    [chatThreadsForCurrentProject, ensureChatMessagesLoaded, isMobile, openCenterPanel, setWorkspaceViewMode],
  );
  handleJumpToTurnRef.current = handleJumpToTurn;

  // Deep link: `?turnId=…` scrolls to + pulses that assistant turn once the
  // chat is open. The transcript's stick-to-bottom pins to the newest message
  // on mount, so we poll for the turn and re-assert an instant center-scroll
  // for a short window to win that race. Consume each turnId once.
  const consumedTurnIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkedTurnId || !currentChatId) return;
    if (consumedTurnIdRef.current === deepLinkedTurnId) return;
    consumedTurnIdRef.current = deepLinkedTurnId;
    void ensureChatMessagesLoaded(currentChatId);
    const start = performance.now();
    let pulsed = false;
    const tick = () => {
      const el = document.querySelector(
        `div[data-message-id="${deepLinkedTurnId}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: 'center' });
        if (!pulsed) {
          pulsed = true;
          el.classList.add('chat-message-pulse');
          window.setTimeout(() => el.classList.remove('chat-message-pulse'), 1600);
        }
      }
      if (performance.now() - start < 2500) window.setTimeout(tick, 250);
    };
    tick();
  }, [deepLinkedTurnId, currentChatId, ensureChatMessagesLoaded]);

  // Opening the comments rail ensures the editor panel is open so the lane is
  // actually visible (it lives in the editor body). Review is a separate column,
  // so it stays put; the chat column also coexists. Rising-edge only.
  const prevCommentsLaneOpenRef = useRef(false);
  useEffect(() => {
    if (commentsLaneToggled && !prevCommentsLaneOpenRef.current) {
      openCenterPanel('editor');
    }
    prevCommentsLaneOpenRef.current = commentsLaneToggled;
  }, [commentsLaneToggled, openCenterPanel]);

  const isMarkdownEditing = activeIsMarkdown && !showRawView;
  const isTextSurface = activeCodeFile || activeIsMarkdown;
  // Dev experiment (localStorage `sundial:doc-align` = 'left'): left-align the
  // markdown document column instead of centering it. pl-12! outbids the
  // responsive px-* paddings on the same container.
  const docCentered = !(useDocAlignLeft() && activeIsMarkdown);
  // Google Docs document style (document ⋯ menu): the markdown page is a
  // white card on a gray desk with symmetric page margins — the pre-redesign
  // look. The frame supplies the card; this shell supplies the desk.
  // Independent of the desktop Tabs/No tabs arrangement (founder,
  // 2026-08-05): the Docs chrome renders under the tab strip too — same as
  // real Google Docs living inside a browser tab.
  const docsPage = useDocStyle() === 'docs';
  // Code files anchor left instead of centering — only the markdown page card
  // centers. (LaTeX has its own full-bleed workbench, so mx-auto is moot there.)
  const codeAlignLeft = activeCodeFile && !activeTexFile;
  // Mobile file view is a single chrome row: the toolbar (and its menu row)
  // stay collapsed until the top bar's toggle expands them — and without the
  // toolbar row, the document tucks up close under the bar. Only files that
  // actually render the toolbar (markdown / tex) carry the state; other
  // surfaces must not inherit padding from a toggle they never show.
  const mobileToolbarCollapsed =
    isMobile && mode === 'space' && !mobileToolbarExpanded && (activeIsMarkdown || activeTexFile);
  const contentWidthClass =
    activeTexFile || previewRendersPdf
      ? 'max-w-none'
      : hasRichViewer || isTextSurface
        ? 'max-w-5xl'
        : 'max-w-3xl';
  const contentPaddingClass =
    activeTexFile
      ? 'h-full'
      : previewRendersPdf
        ? 'px-2 py-2 sm:px-3 sm:py-3'
        : mobileToolbarCollapsed
          ? 'px-3 pt-1.5 pb-3'
          : activeCodeFile
            ? // Code starts near the top of the pane — no dead space above.
              'px-3 lg:px-6 pt-1.5 pb-3 lg:pb-4'
            : isTextSurface
              ? 'px-3 lg:px-6 py-3 lg:py-4'
              : // Markdown: the frame inside already supplies the page's top
                // margin, so this wrapper only pads the bottom — stacking both
                // pushed the first line ~80px down the pane.
                'px-3 lg:px-6 pt-1 pb-4 lg:pb-8';
  // Google-Docs-style comment rail: for desktop markdown the editor keeps a
  // constant width and stays centered when there are no comments; when the lane
  // opens, an animated rail slides in from the right (0 → 320px) and the editor
  // glides left to make room — no resize, no jump, and no off-center gutter when
  // empty. `mdCommentLane` drives that animated layout (markdown only — the code
  // editor stays full-width and uses the static `reserveCommentLane` rail like
  // the workspace "All comments" lane on non-markdown files).
  const mdCommentLane = commentsAvailableForActiveFile && activeIsMarkdown;
  const reserveCommentLane = mdCommentLane || showInlineCommentLane;
  // LaTeX keeps its full-bleed, full-height split layout even when the lane is
  // open — the rail joins the split itself instead of narrowing the page.
  const laneNarrowsContent = reserveCommentLane && !activeTexFile;
  // Outline lane (wireframe right panel). Headings are derived from the rendered
  // `.tiptap` DOM — not the markdown source — so each item's index matches the
  // Nth heading element the click handler scrolls to. Comments win when both
  // lanes are open.
  const [outlineHeadings, setOutlineHeadings] = useState<TocHeading[]>([]);
  const outlineFlashRef = useRef<{ el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);
  const outlineLaneOpen = rightDockView === 'outline' && activeIsMarkdown && !primaryChatActive;
  useEffect(() => {
    if (!outlineLaneOpen) return;
    const compute = () => {
      const els = docEditorBodyRef.current?.querySelectorAll('.tiptap :is(h1,h2,h3,h4,h5,h6)');
      setOutlineHeadings(
        Array.from(els ?? [], (el, index) => ({
          level: Number(el.tagName[1]),
          text: el.textContent ?? '',
          index,
        })),
      );
    };
    compute();
    if (!markdownEditor || markdownEditor.isDestroyed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(compute, 500);
    };
    markdownEditor.on('update', onUpdate);
    return () => {
      clearTimeout(timer);
      markdownEditor.off('update', onUpdate);
    };
  }, [outlineLaneOpen, markdownEditor]);
  const handleOutlineSelect = useCallback((heading: TocHeading) => {
    const el = docEditorBodyRef.current?.querySelectorAll<HTMLElement>(
      '.tiptap :is(h1,h2,h3,h4,h5,h6)',
    )[heading.index];
    if (!el) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    const prev = outlineFlashRef.current;
    if (prev) {
      clearTimeout(prev.timer);
      prev.el.style.backgroundColor = '';
    }
    el.style.transition = 'background-color 300ms ease';
    el.style.backgroundColor = 'rgba(231, 196, 158, 0.4)';
    outlineFlashRef.current = {
      el,
      timer: setTimeout(() => {
        el.style.backgroundColor = '';
        outlineFlashRef.current = null;
      }, 900),
    };
  }, []);
  useEffect(
    () => () => {
      if (outlineFlashRef.current) clearTimeout(outlineFlashRef.current.timer);
    },
    [],
  );
  // Zoom >100% widens the markdown page card itself (its max-width scales with
  // the zoom) up to the available width, instead of inflating text inside a
  // fixed-width card. Applied to both the outer scroll container and the card
  // wrapper, whose base caps differ.
  const mdZoomWiden = isMarkdownEditing && editorZoom > 100;
  const zoomWidenedMax = (base: string) =>
    mdZoomWiden ? { maxWidth: `min(100%, calc(${base} * ${editorZoom / 100}))` } : undefined;
  // Comment wiring for the Monaco code editor (plain code and LaTeX).
  const codeCommentProps = {
    commentThreads: openCommentThreads,
    activeCommentThreadId,
    draftCommentSelection,
    canComment: canCommentOnActiveFile,
    commentLaneRowRef,
    onSelectComment: selectCommentThread,
    onStartCommentDraft: openCommentDraft,
    onReportCommentAnchors: reportCommentAnchors,
  };
  // Watching is a property of the DOC (any chat whose watch covers it). The
  // panel only reports it — watches are managed from the chat.
  const watchedDocPath = activeWorkspaceFile?.path ?? null;
  const docWatcher = watchedDocPath
    ? chatThreadsForCurrentProject.find(
        (t) =>
          t.chat.comment_watch_path === '*' ||
          t.chat.comment_watch_path === watchedDocPath ||
          // A cloud rename leaves the stored path stale while deliveries keep
          // matching on the file id — the badge follows the id (Codex P2).
          (Boolean(t.chat.comment_watch_file_id) && t.chat.comment_watch_file_id === activeWorkspaceFileId),
      )?.chat ?? null
    : null;
  // The comment lane column, shared by the markdown and code editor branches.
  // Markdown toggles its width 0↔320 with NO transition: animating the width
  // rewraps the doc continuously, so the anchor offsets measured pre-open go
  // stale and the cards visibly chase their anchors down the lane (the
  // "comments appear at the top then jump to the bottom" founder bug). An
  // instant open reflows once, and the lane measures that final layout
  // synchronously before paint (see the anchor-offset effect).
  // `-ml-8` closes half the dead space between the document text and the first
  // card: the doc column's rightmost 56px are page padding (empty), so pulling
  // the lane 32px into it only tightens the gutter — the cards keep their own
  // width, and the lane's right edge (and the scrollbar beside it) doesn't
  // move. Applied in both lane states, so opening/closing still doesn't shift
  // the document.
  const commentLaneColumn = reserveCommentLane ? (
    <div
      // Docs style: NO -ml-8 pull — the sheet ends at a real border there,
      // so tucking the cards 32px into it overlapped the page edge; the
      // "empty page padding" the pull exploits only exists in the flat style.
      // Nor in a narrow pane: the page padding is pane-relative and shrinks
      // below the 32px pull, which would both overlap the text and skew the
      // doc 16px right. The clamp is a step on the row width (% of the
      // containing block): 0 below 1000px, the full 2rem above — minus the open
      // 320px lane the frame is then ≥ 660px, where its normal padding is back
      // above 32px.
      className={mdCommentLane ? 'shrink-0 overflow-hidden' : 'shrink-0'}
      // min(320px, 40%): in a narrow pane (chat + doc side by side) a fixed
      // 320px lane starved the document down to a sliver — the lane yields
      // first, the doc keeps ≥60% of the row. Wide panes still get the full
      // 320 (the panel's own max-w follows this width).
      style={
        mdCommentLane
          ? {
              width: showInlineCommentLane ? 'min(320px, 40%)' : 0,
              marginLeft: docsPage ? undefined : 'calc(-1 * clamp(0px, (100% - 1000px) * 1000, 2rem))',
            }
          : undefined
      }
      aria-hidden={!showInlineCommentLane}
    >
      {showInlineCommentLane ? (
        <DocCommentsPanel
          // Live run state for thread "Agent is working" badges: realtime/live
          // status for cloud chats, the sidecar's `running` flag for local
          // ones (v17+); null = unknown → the panel's reply-derived fallback.
          chatActivity={(chatId) => {
            if (chatId === currentChatId && hasLiveChatRun) return 'working';
            const status = chatStatusById[chatId];
            if (status) return status === 'working' || status === 'starting' ? 'working' : 'idle';
            const local = chatThreadsForCurrentProject.find((t) => t.chat.id === chatId)?.chat as
              | { running?: boolean; answering?: boolean }
              | undefined;
            if (typeof local?.running === 'boolean') {
              if (local.running) return 'working';
              // Settled, but a started run may still owe the thread its answer
              // (v21+, and it spans the retry gaps). A SHARED row, so every
              // watcher agrees. Absent, false, stopped, or never-ran all mean
              // plain 'idle' — nothing is coming, so the badge clears.
              return local.answering ? 'answering' : 'idle';
            }
            return null;
          }}
          mode={commentPanelMode}
          documentLabel={commentDocumentLabel}
          threads={displayedCommentThreads}
          resolvedThreads={displayedResolvedThreads}
          threadAnchorOffsets={docCommentAnchorOffsets}
          measuredAnchorIds={measuredCommentAnchorIds}
          draftAnchorOffset={draftCommentAnchorOffset}
          activeThreadId={activeCommentThreadId}
          draftSelection={draftCommentSelection}
          draftBody={draftCommentBody}
          replyRestore={commentReplyRestore}
          currentUser={commentCurrentUser}
          // The identity the server attributes a comment to — anon and desktop
          // (sd_) authors own their comments too, so the author-only actions
          // (edit, delete) must key off the same id the optimistic author uses.
          currentUserId={commentCurrentUser.userId}
          canComment={canCommentOnActiveFile}
          // Per-file: each card gates Resolve/Delete on ITS file's write
          // capability (All-comments cards span files; the comments routes
          // authorize per path), so a path-share editor acts on their granted
          // file even while workspace-level canWrite is false.
          canResolve={canWriteWorkspacePath}
          loading={displayedCommentsLoading}
          error={displayedCommentsError}
          busyAction={commentBusyAction}
          onModeChange={handleCommentModeChange}
          onSelectThread={selectCommentThread}
          onOpenWorkspaceThread={openWorkspaceCommentThread}
          // A thread that summoned an agent carries its chat — open it beside
          // the doc, NARROW (the even split crushed the document), via the
          // pane-grow arming above. openChatById lives further down; the ref is
          // the same switch.
          onOpenThreadChat={(chatId) => {
            narrowChatPaneArmedRef.current = editorPanesRef.current.map((pane) => pane.id).join('|');
            void openChatByIdRef.current(chatId, { sidePanel: true });
          }}
          commentWatchScope={docWatcher ? (docWatcher.comment_watch_path === '*' ? 'workspace' : 'doc') : null}
          mentionPeople={commentMentionPeople}
          onClose={closeCommentLane}
          onCreateComment={createComment}
          onCancelDraft={cancelCommentDraft}
          onReply={replyToComment}
          onResolve={(threadId) => updateCommentStatus(threadId, 'resolve')}
          onReopen={(threadId) => updateCommentStatus(threadId, 'reopen')}
          onEditMessage={editCommentMessage}
          onDeleteMessage={deleteCommentMessage}
          onCopyMessageLink={copyCommentLink}
        />
      ) : null}
    </div>
  ) : null;
  const pdfPreviewUrl =
    previewRendersPdf && binaryPreviewUrl
      ? `${binaryPreviewUrl}#view=FitH&zoom=page-width&navpanes=0&pagemode=none`
      : null;
  const visibleCollaborators = hasMounted
    ? [...activeWorkspaceCollaborators, ...localPeerBadges]
    : [];
  // Tab labels: files show their name, chat tabs their chat title, diff tabs
  // a fixed label — the strip itself stays string-tab agnostic.
  const tabLabel = useCallback(
    (tab: string) => {
      const chatId = chatIdOfTab(tab);
      if (chatId !== null) {
        const promoted = draftPromotionsRef.current[chatId];
        const thread = chatThreadsForCurrentProject.find(
          (t) => t.chat.id === chatId || t.chat.id === promoted,
        );
        return thread?.chat.title?.trim() || 'New chat';
      }
      if (diffIdOfTab(tab) !== null) return 'Turn edits';
      if (isReviewTab(tab)) {
        const scopedChatId = reviewChatIdOfTab(tab);
        if (!scopedChatId) return 'Review';
        const thread = chatThreadsForCurrentProject.find((t) => t.chat.id === scopedChatId);
        return `Edits · ${thread?.chat.title?.trim() || 'chat'}`;
      }
      if (isLauncherTab(tab)) return 'New tab';
      return formatFileName(getFileName(tab));
    },
    [chatThreadsForCurrentProject],
  );
  const isChatMode = mode === 'chat';
  const isSpaceMode = mode === 'space';
  // Center columns to render (computed once above as `visibleColumns`).
  // Editor, Review, and Chat are independent columns rendered left→right; editor
  // and review flex to share space, and chat docks as a fixed, resizable side
  // column.
  // Desktop: the editor column ALWAYS renders — it hosts the pane system,
  // where chats are tabs (PR #907 shell) — and the legacy chat column is
  // mobile-only. The desktop empty state lives inside the panes.
  const editorColumnVisible = isMobile ? visibleColumns.editor : true;

  const chatColumnVisible = isMobile && visibleColumns.chat;
  const chatColumnSole = chatColumnVisible;

  // Review docks left of the editor with a draggable divider between them; it
  // only takes a fixed width when the editor is also open (otherwise it flexes
  // to fill, like the editor does alone).

  // Project top bar (Slice 3): a Sidebar toggle on the left edge and a Chat
  // toggle on the right edge — each sits on the side of the panel it controls.
  // The sidebar is the unified 'project' rail (Slice 1), so this just toggles
  // it open/closed.
  const toggleSidebar = useCallback(() => {
    const next: LeftRail = openLeftRail ? null : 'project';
    setOpenLeftRail(next);
    persistLayoutConfig({ openLeftRail: next });
  }, [openLeftRail, persistLayoutConfig]);
  // Dragging the rail's border to the screen edge collapses it (the toggle
  // button reopens it); the committed width is preserved for the reopen.
  const collapseSidebar = useCallback(() => {
    setOpenLeftRail(null);
    persistLayoutConfig({ openLeftRail: null });
  }, [persistLayoutConfig]);
  const isEditableFileOpen =
    editorColumnVisible &&
    canWrite &&
    !!activeWorkspaceFile &&
    activeWorkspaceFile.type !== 'folder' &&
    !isBinaryFile(activeWorkspaceFile) &&
    !activeCodeFile;
  const effectiveCollabStatus = isLocalWorkspace ? localSocketStatus : collabStatus;
  const showOffline = deriveShowOffline({
    isLocalWorkspace,
    status: effectiveCollabStatus,
    isEditableFileOpen,
    connectingGraceElapsed,
  });

  useWorkspaceActiveFileEffects({
    projectId,
    activeIsMarkdown,
    activeWorkspaceDefaultsToRichViewer,
    activeWorkspaceFileId,
    activeWorkspaceFileResetKey,
    activeWorkspaceFileType,
    fileContentReady,
    // These two only feed the connecting-grace timer: local tracks the sidecar
    // socket (file open or not — a dead sidecar takes chats down too).
    isEditableFileOpen: isLocalWorkspace || isEditableFileOpen,
    collabStatus: effectiveCollabStatus,
    activePreviewFile,
    binaryPreviewNonce,
    richEditorRef,
    textEditorRef,
    fileHideTimerRef,
    resetActiveComment,
    setShowRawView,
    setShowRichViewer,
    setMarkdownEditor,
    setReadyFileId,
    setViewerContent,
    setFileContentVisible,
    setConnectingGraceElapsed,
    setBinaryPreviewUrl,
    setBinaryPreviewStatus,
    fetchImpl: apiFetch,
  });

  useWorkspaceLayoutEffects({
    projectId,
    filesLoaded,
    hasMounted,
    isMobile,
    layoutConfigReady,
    setHasMounted,
    setIsMobile,
    setOpenLeftRail,
    setShowSettingsModal,
    setMobilePanel,
    setLayoutConfigReady,
    readStoredLayoutConfig,
    applyFreshDesktopLayout,
    applyStoredDesktopLayout,
    persistLayoutConfig,
    layoutConfigHydratedRef,
    freshDesktopLayoutPendingRef,
    blockFreshLayoutPersistenceRef,
  });

  useWorkspaceFileInputEffects({
    draftEntry,
    renameEntry,
    openMenuPath,
    draftInputRef,
    renameInputRef,
    renameClickOffsetRef,
    fileMenuRef,
    cancelDraftRef,
    setOpenMenuPath,
  });

  const buildDraftName = useCallback((type: DraftEntry['type'], parentPath: string | null) => {
    const baseName = type === 'folder' ? 'New Folder' : 'untitled';
    const ext = type === 'folder' ? '' : '.md';
    // Case-INSENSITIVELY taken: on a local workspace's disk (macOS/Windows)
    // `untitled.md` IS `Untitled.md`, and the sidecar refuses to create one
    // over the other — a generated name must never land on that refusal.
    const taken = new Set([...existingPaths].map((entry) => entry.toLowerCase()));
    let name = `${baseName}${ext}`;
    let path = parentPath ? `${parentPath}/${name}` : name;
    if (!taken.has(path.toLowerCase())) return name;
    let index = 2;
    while (taken.has(path.toLowerCase())) {
      name = `${baseName}-${index}${ext}`;
      path = parentPath ? `${parentPath}/${name}` : name;
      index += 1;
    }
    return name;
  }, [existingPaths]);

  // The sidebar's create target (drafts, the Files header ＋, its Upload):
  // a rail focused into a folder creates THERE — it's what the tree shows —
  // else next to the active file, else the root.
  const sidebarCreateParent =
    focusedSidebarFolder ??
    (activeWorkspaceFile
      ? activeWorkspaceFile.type === 'folder'
        ? activeWorkspaceFile.path
        : getFolderPath(activeWorkspaceFile.path)
      : null);

  const beginDraft = useCallback((type: DraftEntry['type']) => {
    if (draftEntry) return;
    const parentPath = sidebarCreateParent;
    // Per-folder capability: a path-share editor creates inside their
    // granted subtree even while workspace-wide canWrite is false.
    if (!canUploadToFolder(parentPath)) return;
    // The draft input renders in the section BODY — with Files collapsed the
    // header ＋ would otherwise start an invisible draft (a no-op to the user).
    setSidebarSections((prev) => expandSection(prev, 'files'));
    const name = buildDraftName(type, parentPath);
    setDraftEntry({
      id: `draft-${draftIdRef.current++}`,
      type,
      parentPath,
      name,
    });
    if (parentPath) {
      setExpandedFolders((prev) => new Set(prev).add(parentPath));
    }
  }, [buildDraftName, canUploadToFolder, draftEntry, sidebarCreateParent]);

  const commitDraft = useCallback(async () => {
    if (!draftEntry || !projectId) return;
    if (cancelDraftRef.current) {
      cancelDraftRef.current = false;
      return;
    }
    // Slashes in the draft name create nested folders (VS Code/Obsidian).
    const rawPath = resolveDraftPath(draftEntry.name, draftEntry.type, draftEntry.parentPath);
    if (!rawPath) {
      setDraftEntry(null);
      return;
    }
    const finalPath = ensureUniquePath(rawPath, existingPaths);
    if (!canWriteWorkspacePath(finalPath)) {
      setDraftEntry(null);
      return;
    }

    const res = await apiFetch('/api/workspace/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, path: finalPath, type: draftEntry.type }),
    });
    if (!res.ok) {
      // A refused create used to vanish without a word — the draft row just
      // disappeared and nothing appeared in the tree. Say why (a local disk
      // rejects a name that differs only in case from an existing file).
      setDraftEntry(null);
      const message = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      showWorkspaceAppNotice('error', message || 'Could not create that file');
      return;
    }
    const payload = (await res.json()) as { file: WorkspaceFileRow };
    mutateWorkspaceFiles((prev) => [...prev, payload.file]);
    setDraftEntry(null);
    filesChannelRef.current?.postMessage({ type: 'refresh' });
    // Reveal the new entry: expand every ancestor folder (a slash path can
    // mint them on the fly) and a new folder itself.
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      const path = payload.file.path;
      for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
        next.add(path.slice(0, i));
      }
      if (payload.file.type === 'folder') next.add(path);
      return next;
    });
    if (payload.file.type !== 'folder') {
      setSelectedFilePath(payload.file.path);
      // Explicit create SHOWS the file — claim the primary pane even over an
      // active chat tab (the sync mirror alone treats it as background).
      if (!isMobile) claimPrimaryWithFile(payload.file.path, { append: false });
      setWorkspaceViewMode('space');
    }
  }, [canWriteWorkspacePath, claimPrimaryWithFile, draftEntry, existingPaths, isMobile, projectId, setWorkspaceViewMode, showWorkspaceAppNotice]);

  const cancelDraft = useCallback(() => {
    cancelDraftRef.current = true;
    setDraftEntry(null);
  }, []);

  // ⌘N: create the file NOW under a generated name and open it as a tab —
  // VS Code's new-file, not a rename box revealed in a rail that may be
  // collapsed (in which case the old flow looked like nothing happened).
  // Deliberately no auto-rename: the caret belongs in the document, and a
  // focused name field would swallow the first thing the user types.
  // The folder a pane-scoped create lands in: the pane's file (for a launcher
  // tab, the file it was opened BESIDE), else the primary selection. Shared by
  // createFileAndOpen and the New-tab chooser's gating so they can't disagree
  // on whether a create is possible (path-share editors have folder grants
  // without workspace-wide canWrite).
  const createParentForPane = useCallback(
    (pane: EditorPane | undefined) => {
      const paneActive = pane
        ? isLauncherTab(pane.active)
          ? [...pane.tabs].reverse().find((t) => !isSpecialTab(t)) ?? null
          : pane.active
        : null;
      const contextFile =
        paneActive && !isChatTab(paneActive)
          ? workspaceFileByPath.get(paneActive) ?? null
          : activeWorkspaceFile;
      return contextFile
        ? contextFile.type === 'folder'
          ? contextFile.path
          : getFolderPath(contextFile.path)
        : null;
    },
    [activeWorkspaceFile, workspaceFileByPath],
  );

  const createFileAndOpen = useCallback(async (paneId?: string) => {
    if (!projectId) return;
    // Folder context follows the TARGET pane: a split pane's ＋ creates next
    // to that pane's file, not next to the primary selection.
    const parentPath = createParentForPane(
      paneId ? editorPanesRef.current.find((p) => p.id === paneId) : undefined,
    );
    if (!canUploadToFolder(parentPath)) return;
    const name = buildDraftName('text', parentPath);
    const finalPath = ensureUniquePath(parentPath ? `${parentPath}/${name}` : name, existingPaths);
    if (!canWriteWorkspacePath(finalPath)) return;
    const res = await apiFetch('/api/workspace/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, path: finalPath, type: 'text' }),
    });
    if (!res.ok) {
      const message = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      showWorkspaceAppNotice('error', message || 'Could not create that file');
      return;
    }
    const payload = (await res.json()) as { file: WorkspaceFileRow };
    mutateWorkspaceFiles((prev) => [...prev, payload.file]);
    filesChannelRef.current?.postMessage({ type: 'refresh' });
    if (paneId && paneId !== PRIMARY_PANE_ID && editorPanesRef.current.some((p) => p.id === paneId)) {
      // A split pane's own ＋: the doc belongs to THAT pane; the primary
      // selection (composer context) stays put, like secondary tab clicks.
      setEditorPanes((prev) => {
        // The pane can close during the create await — the file EXISTS, so
        // never drop it on the floor: fall back to the primary pane.
        const alive = prev.some((p) => p.id === paneId);
        if (!alive) queueMicrotask(() => setSelectedFilePath(payload.file.path));
        return openPaneTab(prev, alive ? paneId : PRIMARY_PANE_ID, payload.file.path);
      });
    } else {
      setSelectedFilePath(payload.file.path);
      if (!isMobile) claimPrimaryWithFile(payload.file.path, { append: true });
    }
    setWorkspaceViewMode('space');
  }, [
    apiFetch,
    buildDraftName,
    canUploadToFolder,
    canWriteWorkspacePath,
    claimPrimaryWithFile,
    createParentForPane,
    existingPaths,
    isMobile,
    mutateWorkspaceFiles,
    projectId,
    setWorkspaceViewMode,
    showWorkspaceAppNotice,
  ]);

  const beginRename = useCallback((path: string, source: RenameEntry['source'], opts?: { fileId?: string; clickEvent?: React.MouseEvent; paneId?: string }) => {
    if (!canWriteWorkspacePath(path)) return;
    const name = getFileName(path);
    // For header renames, only strip .md (the "document" extension);
    // keep other extensions (e.g. .json, .py) visible so they aren't lost.
    const displayName = source === 'header' || source === 'tab'
      ? (name.toLowerCase().endsWith('.md') ? name.replace(/\.md$/i, '') : name)
      : name;

    // Capture click position so we can place the cursor at the right spot
    if (opts?.clickEvent && source === 'header') {
      const target = opts.clickEvent.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      renameClickOffsetRef.current = { x: opts.clickEvent.clientX - rect.left, text: displayName };
    } else {
      renameClickOffsetRef.current = null;
    }

    setRenameEntry({ path, name: displayName, source, fileId: opts?.fileId, paneId: opts?.paneId });
  }, [canWriteWorkspacePath]);

  const commitRename = async () => {
    if (!renameEntry) return;
    if (!canWriteWorkspacePath(renameEntry.path)) return;
    const sourcePath = renameEntry.path;
    const sourceFile = workspaceFileByPath.get(sourcePath);
    const hasChildren = workspaceFiles.some((file) => file.path.startsWith(`${sourcePath}/`));
    const sourceType = sourceFile?.type ?? (hasChildren ? 'folder' : 'text');

    let name = sanitizeFilename(renameEntry.name.trim());
    if (!name) {
      setRenameEntry(null);
      return;
    }
    if (
      sourceType !== 'folder' &&
      (renameEntry.source === 'header' || renameEntry.source === 'tab') &&
      sourcePath.toLowerCase().endsWith('.md') &&
      !name.toLowerCase().endsWith('.md')
    ) {
      name = `${name}.md`;
    } else if (sourceType !== 'folder' && !name.includes('.')) {
      name = `${name}.md`;
    }
    const parentPath = getFolderPath(sourcePath);
    const rawTargetPath = parentPath ? `${parentPath}/${name}` : name;
    if (rawTargetPath === sourcePath) {
      setRenameEntry(null);
      return;
    }

    const targetPath = ensureUniquePath(rawTargetPath, existingPaths);
    await movePath(sourcePath, targetPath);
    setRenameEntry(null);
  };

  const cancelRename = useCallback(() => {
    setRenameEntry(null);
  }, []);

  // Cmd/Ctrl+Z restores the most recently deleted file(s) through the shared
  // History restore substrate (PR #599) — the same ledger path the History panel
  // uses: it reconstructs a deleted text file's last content from the append-only
  // doc_edits log and refuses (409) to clobber a path that's been re-created
  // since. Undo only has to remember which text paths a delete removed — no
  // client-side content capture, no second restore mechanism. Scoped to text
  // files + folders (folders reappear when their children restore); a selection
  // containing a binary upload is skipped, since the ledger can't reconstruct it
  // and a partial restore is worse than none. Huge subtrees are skipped too.
  const deletedHistoryRef = useRef<DeletedEntry[]>([]);
  const [hasDeletedHistory, setHasDeletedHistory] = useState(false);
  // Bumped once per processed delete batch (after the undo-eligibility
  // decision) — e2e specs wait on it instead of racing the DELETE response.
  const [deleteSeq, setDeleteSeq] = useState(0);

  // Pane-state transitions are pure (lib/workspace/editor-panes); these
  // handlers apply them and forward a primary-active hand-off into
  // selectedFilePath so the full editor chrome follows.
  const applyPaneTransition = useCallback(
    (
      transition: (prev: EditorPane[]) => { panes: EditorPane[]; primaryActive?: string },
      opts?: { preferPaneId?: string; preferTab?: string },
    ) => {
      // A transition can land a chat tab active (drop/close-neighbor): keep the
      // single-live-chat invariant and re-point the live stream at it; a
      // transition that hides the last active chat withdraws the legacy
      // reveal intent so nothing re-opens the tab behind the user's back.
      // The pane write is functional (a pure transition re-run against the
      // latest state, so racing tab updates survive); the hand-off decisions
      // below work from the ref-snapshot prediction — same inputs, same pure
      // helper.
      // A transition can leave TWO active chats (dropping a chat into a pane
      // while another pane's chat is active) — the pane the user acted on
      // wins, so the just-dropped chat isn't demoted back.
      const pickChatPane = (panes: EditorPane[]) => {
        // The dragged tab itself first (a split lands it in a NEW pane id),
        // then the acted-on pane, then any active chat.
        const byTab =
          opts?.preferTab && isChatTab(opts.preferTab)
            ? panes.find((p) => p.active === opts.preferTab)
            : undefined;
        const byPane = opts?.preferPaneId
          ? panes.find((p) => p.id === opts.preferPaneId && isChatTab(p.active))
          : undefined;
        return byTab ?? byPane ?? panes.find((p) => isChatTab(p.active));
      };
      const result = transition(editorPanesRef.current);
      setEditorPanes((prev) => {
        const res = transition(prev);
        const acp = pickChatPane(res.panes);
        // Every pane transition re-points ⌘W at the acted-on tab's pane (a
        // split lands the tab in a NEW pane id), else the acted-on pane —
        // body/edge drops fire no pointer event inside the destination. The
        // same file can be ACTIVE in two panes, so a bare match-by-tab can
        // hit a bystander copy: prefer the acted-on pane showing the tab,
        // then the pane the tab BECAME active in, then any holder, then the
        // pane. Computed HERE, on the committed result — the ref-snapshot
        // prediction above sees a different pane id (nextPaneId() runs per
        // transition call). Stamped via microtask: on a double-invoked
        // updater the committed invocation's microtask runs last.
        const showsTab = (p: EditorPane) => p.active === opts?.preferTab;
        const focusPane = opts?.preferTab
          ? (opts.preferPaneId
              ? res.panes.find((p) => p.id === opts.preferPaneId && showsTab(p))
              : undefined) ??
            res.panes.find(
              (p) => showsTab(p) && prev.find((b) => b.id === p.id)?.active !== opts.preferTab,
            ) ??
            res.panes.find(showsTab) ??
            (opts.preferPaneId ? res.panes.find((p) => p.id === opts.preferPaneId) : undefined)
          : opts?.preferPaneId
            ? res.panes.find((p) => p.id === opts.preferPaneId)
            : undefined;
        // A pane that collapsed under the transition (its last tab closed or
        // dragged away) can't hold the focus: it falls to the primary — the
        // pane that ADOPTED a collapsed primary's content — so ⌘W and the
        // rail's focused-pane targeting never chase a dead id.
        const nextFocusId = focusPane
          ? focusPane.id
          : res.panes.some((p) => p.id === lastFocusedPaneIdRef.current)
            ? null
            : res.panes[0].id;
        if (nextFocusId) {
          queueMicrotask(() => {
            lastFocusedPaneIdRef.current = nextFocusId;
          });
        }
        return acp ? enforceSingleActiveChat(res.panes, acp.id) : res.panes;
      });
      const activeChatPane = pickChatPane(result.panes);
      if (result.primaryActive !== undefined) {
        if (!isSpecialTab(result.primaryActive)) setSelectedFilePath(result.primaryActive);
        // A chat/diff neighbor took the slot: keep the selection only while
        // its file is still open somewhere, or the composer/URL would keep
        // advertising a closed file.
        else setSelectedFilePath((prev) => (prev && result.panes.some((p) => p.tabs.includes(prev)) ? prev : ''));
      } else if (!isMobileRef.current) {
        // Unchanged active tab can still close the SELECTED file (a background
        // tab behind an active chat) — drop a selection no pane holds. Desktop
        // only: mobile doesn't mirror its selection into the panes.
        setSelectedFilePath((prev) => (prev && !result.panes.some((p) => p.tabs.includes(prev)) ? '' : prev));
      }
      const chatId = activeChatPane ? chatIdOfTab(activeChatPane.active) : null;
      if (chatId && chatId !== currentChatIdRef.current) void openChatByIdRef.current(chatId);
      // Desktop-only: on mobile the open-set IS the chat visibility, and a
      // pane mirror without chat tabs must not close the chat view.
      if (!activeChatPane && !isMobileRef.current) {
        saveChatScrollPosition();
        setOpenPanels((prev) => removePanel(prev, 'chat'));
      }
      return result;
    },
    [saveChatScrollPosition],
  );

  const deletePaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0 || !paths.every((path) => canWriteWorkspacePath(path))) return;
    if (!projectId) return;
    if (paths.length === 0) return;

    const results = await Promise.all(
      paths.map((path) =>
        apiFetch('/api/workspace/files', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, path }),
        }),
      ),
    );
    // Undo eligibility comes entirely from the server's report of what it
    // actually removed — never the client's (possibly stale) file list. A delete
    // is undoable only if every removed row was reconstructable (text/folder):
    // `restorable: null` means a binary went too, so a partial restore would
    // silently lose it. `deletedAt` (server tombstone time) is the restore
    // boundary, robust to client clock skew / a last-moment autosave.
    const succeeded: string[] = [];
    const folders = new Set<string>();
    const texts = new Set<string>();
    let undoable = true;
    let deletedCount = 0;
    let before: string | null = null;
    for (let i = 0; i < paths.length; i += 1) {
      if (!results[i]?.ok) continue;
      succeeded.push(paths[i]);
      const body = (await results[i].json().catch(() => null)) as {
        deleted?: unknown;
        deletedAt?: unknown;
        restorable?: { folders?: unknown; texts?: unknown } | null;
      } | null;
      if (Array.isArray(body?.deleted)) deletedCount += body.deleted.length;
      if (typeof body?.deletedAt === 'string' && (before === null || body.deletedAt > before)) before = body.deletedAt;
      if (body?.restorable == null) undoable = false;
      else {
        if (Array.isArray(body.restorable.folders)) for (const f of body.restorable.folders) folders.add(String(f));
        if (Array.isArray(body.restorable.texts)) for (const t of body.restorable.texts) texts.add(String(t));
      }
    }
    if (succeeded.length === 0) return;
    // Skip huge subtrees — reconstructing thousands of files isn't a sane undo.
    if (undoable && deletedCount <= UNDO_DELETE_LIMIT && folders.size + texts.size > 0) {
      deletedHistoryRef.current.push({ folders: [...folders], texts: [...texts], before });
      setHasDeletedHistory(true);
    } else if (deletedCount > 0) {
      // A real but non-undoable delete (a binary, or an oversized subtree) is the
      // user's latest action — drop any earlier undo so Cmd+Z doesn't resurrect
      // an older, unrelated delete instead of doing nothing.
      deletedHistoryRef.current = [];
      setHasDeletedHistory(false);
    }
    setDeleteSeq((s) => s + 1);
    mutateWorkspaceFiles((prev) =>
      prev.filter((file) => !succeeded.some((p) => file.path === p || file.path.startsWith(`${p}/`))),
    );
    // Close every tab under the deleted paths; when the primary pane's active
    // tab dies its neighbor takes over ('' when the pane emptied — the old
    // clear-selection behavior). applyPaneTransition forwards the hand-off
    // (selection, a promoted chat tab's live-chat switch, single-live-chat).
    const paneResult = applyPaneTransition((prev) => removePanePaths(prev, succeeded));
    if (
      paneResult.primaryActive === undefined &&
      selectedFilePath &&
      succeeded.some((p) => selectedFilePath === p || selectedFilePath.startsWith(`${p}/`))
    ) {
      setSelectedFilePath('');
    }
    setSelectedPaths(new Set());
    setOpenMenuPath(null);
    filesChannelRef.current?.postMessage({ type: 'refresh' });
  }, [applyPaneTransition, canWriteWorkspacePath, projectId, selectedFilePath]);

  const restoreLastDeletedPaths = useCallback(async () => {
    if (!projectId) return;
    // No per-path pre-gate here: an entry was only ever pushed after passing
    // the delete's own gate, and for a grant-elevated member the delete
    // itself RETIRES the grant — the restore rails re-authorize server-side
    // via the own-delete verification, which the vanished grant would
    // wrongly block from the client.
    const next = deletedHistoryRef.current[deletedHistoryRef.current.length - 1];
    if (!next) return;
    const entry = deletedHistoryRef.current.pop();
    setHasDeletedHistory(deletedHistoryRef.current.length > 0);
    if (!entry) return;
    // Snapshot the live tree first: if an ancestor of a restore target has since
    // become a file (e.g. the deleted folder was replaced by a file), restoring
    // a descendant under it would make an invalid file-with-children tree. Skip
    // those. Best-effort — if the read fails, fall back to attempting the restore.
    const liveType = new Map<string, string>();
    try {
      const res = await apiFetch(`/api/workspace/files?projectId=${encodeURIComponent(projectId)}`);
      if (res.ok) {
        for (const file of (((await res.json()) as { files?: Array<{ path?: string; type?: string }> })?.files ?? [])) {
          if (typeof file?.path === 'string') liveType.set(file.path, typeof file.type === 'string' ? file.type : '');
        }
      }
    } catch {
      /* fall through with an empty map */
    }
    const blockedByFile = (path: string) => {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const ancestor = liveType.get(parts.slice(0, i).join('/'));
        if (ancestor !== undefined && ancestor !== 'folder') return true;
      }
      return false;
    };
    // Recreate explicit (empty) folder rows, shallowest first, so an empty-folder
    // delete is restorable. Skip a path already occupied by a file, or sitting
    // under one — recreating it would corrupt the tree.
    for (const path of [...entry.folders].sort((a, b) => a.length - b.length)) {
      const occupant = liveType.get(path);
      if ((occupant !== undefined && occupant !== 'folder') || blockedByFile(path)) continue;
      if (occupant === undefined) {
        const res = await apiFetch('/api/workspace/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Restore rail: keep deferred path shares alive across delete+undo.
          body: JSON.stringify({ projectId, path, type: 'folder', preservePathShares: true }),
        }).catch(() => null);
        // Mark a folder only on a successful create — a file racing onto this
        // path conflicts, and descendants must then stay blocked (non-folder).
        liveType.set(path, res && res.ok ? 'folder' : '');
      }
    }
    // Reconstruct each deleted text file from the ledger. The endpoint 409s a
    // path re-created since the delete, so a stale undo never clobbers it.
    await Promise.all(
      entry.texts
        .filter((path) => !blockedByFile(path))
        .map((path) =>
          apiFetch('/api/workspace/history/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // beforeCreatedAt bounds the reconstruct to this delete's incarnation.
            body: JSON.stringify({ projectId, path, beforeCreatedAt: entry.before }),
          }).catch(() => null),
        ),
    );
    await reloadFiles(false);
    filesChannelRef.current?.postMessage({ type: 'refresh' });
    const top = [...entry.folders, ...entry.texts].sort((a, b) => a.length - b.length)[0];
    if (top) {
      const parent = getFolderPath(top);
      if (parent) setExpandedFolders((prev) => new Set(prev).add(parent));
      setSelectedPaths(new Set([top]));
    }
  }, [projectId, reloadFiles]);

  const deletePath = useCallback(
    (path: string) => deletePaths([path]),
    [deletePaths],
  );

  const duplicatePath = useCallback(async (sourcePath: string) => {
    if (!canWrite || !projectId) return;
    const res = await apiFetch('/api/workspace/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, sourcePath }),
    });
    setOpenMenuPath(null);
    if (!res.ok) return;
    const { file } = (await res.json()) as { file: WorkspaceFileRow };
    // Reload to pull in the whole copied subtree (the response is just its root).
    await reloadFiles(false);
    filesChannelRef.current?.postMessage({ type: 'refresh' });
    // Reveal + highlight the copy like a file manager, without yanking the editor.
    const parent = getFolderPath(file.path);
    if (parent) setExpandedFolders((prev) => new Set(prev).add(parent));
    setSelectedPaths(new Set([file.path]));
  }, [canWrite, projectId, reloadFiles]);

  // Owner-only agent lock. Optimism-free: flip local state only after the
  // server confirms, and surface failures (403 for non-owners) as a toast.
  const toggleFileLock = useCallback(async (file: WorkspaceFileRow) => {
    if (!projectId) return;
    const locked = !file.is_locked;
    const res = await fetch('/api/workspace/files/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, path: file.path, locked }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      showWorkspaceAppNotice(
        'error',
        res.status === 403
          ? 'Only the workspace owner can lock files'
          : payload?.error ?? 'Could not update the file lock',
      );
      return;
    }
    mutateWorkspaceFiles((prev) =>
      prev.map((entry) => (entry.path === file.path ? { ...entry, is_locked: locked } : entry)),
    );
    filesChannelRef.current?.postMessage({ type: 'refresh' });
  }, [mutateWorkspaceFiles, projectId, showWorkspaceAppNotice]);

  const downloadFromWorkspaceApi = useCallback((params: URLSearchParams, fileName: string) => {
    const anchor = document.createElement('a');
    // Local projects download straight from the sidecar (path-addressed).
    anchor.href =
      localConfig && projectId
        ? localSidecar.downloadUrl(localConfig, projectId, {
            path: params.get('path') ?? undefined,
            folderPath: params.get('folderPath') ?? undefined,
          })
        : // Anchor navigations can't carry headers — path-share guests need
          // the token in the URL (the server accepts ?pshare=).
          appendPathShareTokenToUrl(`/api/workspace/files/download?${params.toString()}`);
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [localConfig, projectId]);

  const buildFileUrl = useCallback((file: WorkspaceFileRow) => {
    if (typeof window === 'undefined') return '';
    if (file.type === 'folder' || file.type === 'proposal') return '';
    return `${window.location.origin}${buildWorkspaceFilePath(workspaceRouteId, file.id)}`;
  }, [workspaceRouteId]);

  const downloadFile = useCallback((file: WorkspaceFileRow) => {
    if (!projectId) return;
    const fileName = sanitizeFilename(getFileName(file.path)) || 'download';

    // Only a live editor beats the doc store (it may hold unsaved keystrokes).
    // Without one (e.g. review-only, editor destroyed) fall through to the API,
    // which serves the persisted text — viewerContent can be stale or empty.
    const content = file.type === 'text' && activeWorkspaceFile?.id === file.id ? readEditorText() : null;
    if (content != null) {
      downloadBlob(new Blob([content], { type: file.mime ?? 'text/plain;charset=utf-8' }), fileName);
      setOpenMenuPath(null);
      return;
    }

    const params = new URLSearchParams({
      projectId,
      fileId: file.id,
      path: file.path,
    });
    downloadFromWorkspaceApi(params, fileName);
    setOpenMenuPath(null);
  }, [activeWorkspaceFile?.id, downloadFromWorkspaceApi, projectId, readEditorText]);

  const downloadFolder = useCallback((folderPath: string) => {
    if (!projectId) return;
    const params = new URLSearchParams({ projectId, folderPath });
    const fileName = `${sanitizeFilename(getFileName(folderPath)) || 'folder'}.zip`;
    downloadFromWorkspaceApi(params, fileName);
    setOpenMenuPath(null);
  }, [downloadFromWorkspaceApi, projectId]);

  const duplicateFile = useCallback(async (file: WorkspaceFileRow) => {
    if (!canWrite || !projectId || file.type === 'folder') return;
    // Reuse the latest persisted snapshot as the copy's seed — this is the
    // exact mirror-safe pattern: Yjs state → new doc_snapshots row on POST.
    let initialSnapshotBase64: string | null = null;
    if (file.type === 'text') {
      try {
        const snapRes = await apiFetch(`/api/workspace/snapshots?fileId=${file.id}`);
        if (snapRes.ok) {
          const body = (await snapRes.json()) as { snapshot?: string | null };
          if (body.snapshot) initialSnapshotBase64 = body.snapshot;
        }
      } catch {
        /* fall back to empty doc */
      }
    }
    const name = getFileName(file.path);
    const dotIdx = name.lastIndexOf('.');
    const stem = dotIdx > 0 ? name.slice(0, dotIdx) : name;
    const ext = dotIdx > 0 ? name.slice(dotIdx) : '';
    const parent = getFolderPath(file.path);
    const rawPath = parent ? `${parent}/${stem} copy${ext}` : `${stem} copy${ext}`;
    const finalPath = ensureUniquePath(rawPath, existingPaths);
    const res = await apiFetch('/api/workspace/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        path: finalPath,
        type: file.type,
        mime: file.mime,
        initialSnapshotBase64,
      }),
    });
    if (!res.ok) return;
    const payload = (await res.json()) as { file: WorkspaceFileRow };
    mutateWorkspaceFiles((prev) => [...prev, payload.file]);
    filesChannelRef.current?.postMessage({ type: 'refresh' });
    if (payload.file.type !== 'folder') {
      setSelectedFilePath(payload.file.path);
      // Explicit duplicate SHOWS the copy — claim the primary pane even over
      // an active chat tab (the sync mirror alone treats it as background).
      if (!isMobile) claimPrimaryWithFile(payload.file.path);
      setWorkspaceViewMode('space');
    }
  }, [canWrite, claimPrimaryWithFile, existingPaths, isMobile, projectId, setWorkspaceViewMode]);

  const downloadWorkspaceZip = useCallback(() => {
    if (!projectId) return;
    const params = new URLSearchParams({ projectId });
    const fileName = `${sanitizeFilename(projectTitle.trim()) || 'workspace'}.zip`;
    downloadFromWorkspaceApi(params, fileName);
    setOpenMenuPath(null);
  }, [downloadFromWorkspaceApi, projectId, projectTitle]);

  // Handle file/folder click
  const handleFileClick = useCallback((file: WorkspaceFileRow) => {
    if (file.type === 'folder') return;
    // Explicit open: wireframe replace-on-open. The selectedFilePath mirror
    // deliberately never displaces an active chat tab, so the click itself
    // must claim the pane (withdrawing the chat reveal intent with it) — and
    // the claim, which knows WHICH pane took the file, owns the selection.
    // Setting it here too pulled the primary onto a file opened in a side
    // pane, so a single rail click changed both panes.
    if (isMobile) setSelectedFilePath(file.path);
    else claimPrimaryWithFile(file.path);
    setWorkspaceViewMode('space');
    // Opening a file means "show me the editor". The center diff viewer would
    // otherwise keep precedence while Sync stays in the (now multi-section)
    // sidebar, so drop the commit selection to reveal the editor.
    setSelectedCommit(null);
    if (isMobile) {
      setMobilePanel(null);
    }
  }, [claimPrimaryWithFile, isMobile, setWorkspaceViewMode]);

  const prefetchWorkspaceFile = useCallback((file: WorkspaceFileRow) => {
    if (!workspaceCollabSocket || file.type === 'folder') return;
    const docName = `${workspaceCollabSocket.docNamePrefix ?? ''}${file.path}`;
    prefetchProvider(
      workspaceCollabSocket.socket,
      docName,
      file.id,
      workspaceCollabSocket.getToken,
    );
    if (!isMarkdownFile(file)) preloadMonaco();
  }, [workspaceCollabSocket]);

  // ---- Panel surface switching (?view=panel: one surface at a time) -------
  // Every target maps to an EXISTING single-surface action; nothing here adds
  // a pane. Shared by the human's floating switcher and the agent's /g/show
  // broadcasts (usePanelControl below).
  // The file the panel last SHOWED. The chat tab can replace the file tab
  // and clear the selection, so without this the doc button falls through to
  // the workspace default instead of returning to the document the human was
  // just reading.
  const panelLastFilePathRef = useRef<string | null>(null);
  useEffect(() => {
    if (panelViewActive && selectedFilePath) panelLastFilePathRef.current = selectedFilePath;
  }, [panelViewActive, selectedFilePath]);
  const showPanelSurface = useCallback(
    (surface: PanelNavTarget, fileOverride?: WorkspaceFileRow) => {
      if (surface === 'files') {
        setOpenLeftRail('project');
        return;
      }
      setOpenLeftRail(null);
      if (surface === 'review') {
        // The SAME ReviewPanel the right dock hosts, rendered full-width in
        // panel view. (The all-scope review TAB renders null: unscoped tabs
        // are no longer creatable, which showed as a blank surface.)
        openRightDock('history');
        return;
      }
      closeRightDock();
      if (surface === 'chat') {
        openChatTabForCurrentRef.current();
        return;
      }
      // doc / source / split / pdf: make sure the FILE holds the pane (the
      // chat tab may) before driving the LaTeX view mode. A /g/show command
      // carrying its own path passes that file in — selectedFilePath is still
      // the PREVIOUS render's selection here, so reading it would reopen the
      // stale file over the one the command just scheduled. A chat-primary
      // panel can have CLEARED the selection, so fall back to the last file
      // tab still open in the panes — otherwise the doc button silently does
      // nothing, which is a dead end in the one-surface layout.
      const lastPaneFile = [...editorPanesRef.current[0].tabs]
        .reverse()
        .find((tab) => tab && !isSpecialTab(tab));
      const lastShown = panelLastFilePathRef.current;
      const file =
        fileOverride ??
        // Source from an open compiled PDF: jump to its .tex twin.
        (surface === 'source' && selectedFilePath?.endsWith('.pdf')
          ? workspaceFileByPath.get(selectedFilePath.replace(/\.pdf$/, '.tex'))
          : undefined) ??
        (selectedFilePath ? workspaceFileByPath.get(selectedFilePath) : undefined) ??
        (lastShown ? workspaceFileByPath.get(lastShown) : undefined) ??
        (lastPaneFile ? workspaceFileByPath.get(lastPaneFile) : undefined) ??
        // Chat-only pane and nothing ever shown (a chat-default arrival): the
        // doc button still has to land SOMEWHERE — the workspace default doc.
        pickDefaultDocument(workspaceFiles) ??
        undefined;
      if (file && file.type !== 'folder') handleFileClick(file);
      if (surface === 'source' || surface === 'pdf') {
        handleLatexViewModeChange(surface);
      }
    },
    [closeRightDock, handleFileClick, handleLatexViewModeChange, openRightDock, selectedFilePath, workspaceFileByPath, workspaceFiles],
  );
  usePanelControl({
    enabled: panelViewActive,
    projectId,
    supabaseClient,
    onCommand: (command) =>
      applyPanelCommand(command, workspaceFileByPath, handleFileClick, showPanelSurface),
  });
  // Embedded panel: ONE pane ever renders. Chat-aside docking (a deep link
  // claiming primary, the chat reveal) and restored splits collapse to the
  // primary pane; their tabs stay reachable as background tabs behind the
  // switcher's surfaces. Identity-stable when already single (no loop).
  useEffect(() => {
    if (!panelViewActive) return;
    setEditorPanes((prev) => collapseToPrimaryPane(prev));
  }, [editorPanes, panelViewActive]);
  const panelActiveSurface: PanelNavTarget =
    openLeftRail === 'project'
      ? 'files'
      : rightDockView === 'history'
        ? 'review'
        : primaryChatActive
          ? 'chat'
          : primaryReviewActive
            ? 'review'
            : activeTexFile
              ? (latexViewMode === 'split' ? 'source' : latexViewMode)
              : activeWorkspaceFile?.path.endsWith('.pdf')
                ? 'pdf'
                : 'doc';
  // A compiled PDF opened as the panel surface: its source twin (same path,
  // .tex) gets a Source entry in the switcher, so the human can jump from
  // output to source without the file tree. (Re-applied after the
  // feat/pdf-comments merge resolved #1554's hunks away, 2026-08-27.)
  const activePdfTexTwin =
    panelViewActive && activeWorkspaceFile?.path.endsWith('.pdf')
      ? workspaceFileByPath.get(activeWorkspaceFile.path.replace(/\.pdf$/, '.tex'))
      : undefined;
  const panelSurfaces = useMemo<Array<{ id: PanelNavTarget; label: string }>>(
    () => [
      { id: 'files', label: 'Files' },
      ...(activeTexFile || activePdfTexTwin
        ? ([
            { id: 'source', label: 'Source' },
            { id: 'pdf', label: 'PDF' },
          ] as Array<{ id: PanelNavTarget; label: string }>)
        : [{ id: 'doc', label: 'Doc' } as { id: PanelNavTarget; label: string }]),
      { id: 'chat', label: 'Chat' },
      // Review = the edits surface the (shed) right dock would host. Home
      // stays a top-corner button, not a surface (founder 2026-08-26).
      { id: 'review', label: 'Review' },
    ],
    [activePdfTexTwin, activeTexFile],
  );

  // Bubble-click jump: open the file the peer broadcast in presence, then ask
  // that file's editor to center their live awareness caret. Local mode (and
  // clients that predate openFilePath) broadcast no path — the current file is
  // tried instead, where the awareness match still finds a same-doc peer.
  const [peerReveal, setPeerReveal] = useState<(RevealPeerRequest & { path: string }) | null>(null);
  const peerRevealSeqRef = useRef(0);
  const jumpToCollaborator = useCallback(
    (badge: { id: string; name: string; color?: string | null }) => {
      const presenceKey = isLocalWorkspace
        ? null // local badge ids are name|color composites, not presence keys
        : badge.id.includes(':')
          ? badge.id
          : `user:${badge.id}`;
      const metas = presenceKey ? workspacePresenceState[presenceKey] ?? [] : [];
      const openPath = [...metas].reverse().find((meta) => meta?.openFilePath)?.openFilePath ?? null;
      // Local mode: awareness (not Supabase presence) knows the peer's doc —
      // strip the socket's docName prefix back to a workspace path.
      const localPeerDocName = isLocalWorkspace
        ? localCollabPeers.find((peer) => peer.key === badge.id)?.docName ?? null
        : null;
      const localPrefix = workspaceCollabSocket?.docNamePrefix ?? '';
      const localPeerPath =
        localPeerDocName && localPrefix && localPeerDocName.startsWith(localPrefix)
          ? localPeerDocName.slice(localPrefix.length)
          : localPeerDocName;
      const path = (isLocalWorkspace ? localPeerPath : openPath) ?? selectedFilePath;
      if (!path) return;
      if (path !== selectedFilePath) {
        const file = workspaceFileByPath.get(path);
        if (!file) return; // peer is in a file this client can't see
        handleFileClick(file);
      }
      setPeerReveal({
        seq: ++peerRevealSeqRef.current,
        presenceKey,
        name: badge.name,
        color: badge.color ?? null,
        path,
      });
    },
    [
      isLocalWorkspace,
      workspacePresenceState,
      selectedFilePath,
      workspaceFileByPath,
      handleFileClick,
      localCollabPeers,
      workspaceCollabSocket,
    ],
  );
  // A reveal request is one-shot: the editor reports delivery (or give-up) so
  // a later remount of the same file can't replay the scroll…
  const handlePeerRevealDone = useCallback((seq: number) => {
    setPeerReveal((prev) => (prev && prev.seq === seq ? null : prev));
  }, []);
  // …and navigating off the target file cancels an undelivered request (the
  // click itself lands on the target, so this only fires on real navigation).
  useEffect(() => {
    if (peerReveal && selectedFilePath !== peerReveal.path) setPeerReveal(null);
  }, [peerReveal, selectedFilePath]);

  // ---- Editor pane/tab actions (Obsidian-style tabs + drag-to-split) ----

  const handlePaneTabActivate = useCallback(
    (paneId: string, path: string) => {
      lastFocusedPaneIdRef.current = paneId;
      if (isChatTab(path)) {
        const chatId = chatIdOfTab(path)!;
        setEditorPanes((prev) => enforceSingleActiveChat(openPaneTab(prev, paneId, path), paneId));
        void openChatByIdRef.current(chatId);
        return;
      }
      // Non-file surfaces (the New-tab chooser, a review timeline, a turn's
      // diff): not workspace paths — just activate them. Without this the
      // primary-pane branch below would look them up as file paths, find
      // nothing, and return, leaving the tab permanently un-reactivatable. (On
      // the primary this leaves selectedFilePath as the background file,
      // exactly like chat tabs do.)
      if (isSpecialTab(path)) {
        setEditorPanes((prev) => openPaneTab(prev, paneId, path));
        return;
      }
      // A file tab activates in the pane it was CLICKED in — always, and in
      // that pane only. Routing the primary's tabs through the rail open path
      // (handleFileClick → claimPrimaryWithFile) re-picked the pane by
      // heuristic: with a chat active in the primary, clicking one of its file
      // tabs swapped ANOTHER pane's document and left the clicked tab inert
      // ("some tabs became completely unclickable" — the onboarding report).
      // The primary's selection follows its own active tab (its editor chrome
      // renders selectedFilePath), including a path only pendingPaneMoves can
      // resolve while an in-flight move settles.
      applyPaneTransition(
        (prev) => ({
          panes: openPaneTab(prev, paneId, path),
          primaryActive: paneId === PRIMARY_PANE_ID ? path : undefined,
        }),
        { preferPaneId: paneId, preferTab: path },
      );
      setWorkspaceViewMode('space');
      setSelectedCommit(null);
    },
    [applyPaneTransition, setWorkspaceViewMode],
  );

  const handlePaneTabClose = useCallback(
    (paneId: string, path: string) =>
      void applyPaneTransition((prev) => closePaneTab(prev, paneId, path), { preferPaneId: paneId }),
    [applyPaneTransition],
  );

  // Desktop ⌘W: the shell's menu dispatches this instead of closing the
  // window — close the focused pane's active tab through the normal path.
  // Gated on inDesktopShell (the any-OS shell flag), not isDesktopApp
  // (Windows/Linux shells intercept Ctrl+W too) and not desktopTabs: the
  // native File ▸ Close Tab / ⌘W menu keeps dispatching this with the top
  // bar hidden, where closing the focused pane's active surface still means
  // "close the displayed file/chat".
  useEffect(() => {
    if (!inDesktopShell) return;
    const onCloseTab = () => {
      const panes = editorPanesRef.current;
      const pane = panes.find((p) => p.id === lastFocusedPaneIdRef.current) ?? panes[0];
      if (pane?.active) handlePaneTabClose(pane.id, pane.active);
    };
    window.addEventListener('sundial:close-tab', onCloseTab);
    return () => window.removeEventListener('sundial:close-tab', onCloseTab);
  }, [inDesktopShell, handlePaneTabClose]);

  // The chat header's X: close the chat TAB wherever it lives (desktop);
  // mobile still closes the legacy column.
  const closeActiveChatTab = useCallback(() => {
    const pane = editorPanesRef.current.find((p) => isChatTab(p.active));
    if (pane && !isMobile) handlePaneTabClose(pane.id, pane.active);
    else closeCenterPanel('chat');
  }, [closeCenterPanel, handlePaneTabClose, isMobile]);
  closeActiveChatTabRef.current = closeActiveChatTab;

  // Both drop handlers also clear the drag-active state: a drop that unmounts
  // the source tab can leave the browser's dragend firing on a detached node
  // that React never sees, which would strand the overlay over the panes.
  const handlePaneTabDrop = useCallback(
    (paneId: string, payload: TabDragPayload, index: number) => {
      applyPaneTransition((prev) => movePaneTab(prev, payload, { paneId, index }), {
        preferPaneId: paneId,
        preferTab: payload.path,
      });
      handleTabDragChange(false);
    },
    [applyPaneTransition, handleTabDragChange],
  );

  const handlePaneBodyDrop = useCallback(
    (targetPaneId: string, payload: TabDragPayload, zone: DropZone) => {
      applyPaneTransition(
        (prev) =>
          zone === 'center'
            ? movePaneTab(prev, payload, { paneId: targetPaneId, index: -1 })
            : splitWithTab(prev, payload, targetPaneId, zone),
        { preferPaneId: targetPaneId, preferTab: payload.path },
      );
      handleTabDragChange(false);
    },
    [applyPaneTransition, handleTabDragChange],
  );

  // Tab right-click ▸ Split right: the tab duplicates into a NEW pane beside
  // its own (rail-source, so a pane's sole tab splits too — VS Code
  // semantics; the drag-to-edge split keeps its move semantics). No
  // preferPaneId: the source pane still shows the tab, and applyPaneTransition's
  // became-active rule is what lands focus on the new pane.
  const handleTabSplitRight = useCallback(
    (paneId: string, path: string) => {
      // Files only: duplicating a chat tab would trip the single-live-chat
      // demotion (a fresh pane showing nothing), and diff/launcher tabs are
      // one-shot surfaces.
      if (isSpecialTab(path)) return;
      applyPaneTransition(
        (prev) => splitWithTab(prev, { paneId: RAIL_PANE_ID, path }, paneId, 'right'),
        { preferTab: path },
      );
    },
    [applyPaneTransition],
  );

  const handleOpenInNewTab = useCallback(
    (file: WorkspaceFileRow) => {
      if (file.type === 'folder') return;
      // Append semantics: claim BEFORE handleFileClick so its replace-claim
      // sees the appended tab already active (same-tick via the ref) and
      // no-ops instead of replacing a neighbor.
      if (!isMobile) claimPrimaryWithFile(file.path, { append: true });
      handleFileClick(file);
    },
    [claimPrimaryWithFile, handleFileClick, isMobile],
  );

  const handleOpenToSide = useCallback(
    (file: WorkspaceFileRow) => {
      if (file.type === 'folder') return;
      if (isMobile) {
        handleFileClick(file);
        return;
      }
      setEditorPanes((prev) => openPaneToSide(prev, file.path));
      setWorkspaceViewMode('space');
      setSelectedCommit(null);
    },
    [handleFileClick, isMobile, setWorkspaceViewMode],
  );

  // Tab renames share the header/tree pipeline (beginRename/commitRename):
  // same sanitize, extension, and unique-path rules, same optimistic move.
  const handleBeginTabRename = useCallback(
    (paneId: string, path: string) => {
      // Same gate as the header filename control: no renames from document
      // chrome for read-only users or while the doc is in Viewing mode.
      if (!canWrite || documentEditorReadOnly) return;
      const file = workspaceFileByPath.get(path);
      if (file) beginRename(path, 'tab', { fileId: file.id, paneId });
    },
    [beginRename, canWrite, documentEditorReadOnly, workspaceFileByPath],
  );
  const handleTabRenameValueChange = useCallback((name: string) => {
    setRenameEntry((prev) => (prev ? { ...prev, name } : prev));
  }, []);

  const openFileAtLine = useCallback(
    (result: { path: string; line: number }) => {
      const file = workspaceFileByPath.get(result.path);
      if (!file || file.type === 'folder') return;
      if (result.path === selectedFilePath) {
        // Already open — reveal directly, no remount to wait on.
        if (result.line > 0) textEditorRef.current?.revealLine?.(result.line);
        return;
      }
      pendingRevealLineRef.current = result.line > 0 ? result.line : null;
      handleFileClick(file);
    },
    [handleFileClick, selectedFilePath, workspaceFileByPath],
  );

  // Inverse SyncTeX: resolve a file (relative to the compiled root's directory)
  // to a workspace path, then open it at the matched line (handles already-open
  // vs remount-then-reveal).
  // First-time teaching card for the double-click jump: the gesture silently
  // scrolls the editor, which reads as "the app moved me" to a newcomer. Shown
  // once per browser, on the first inverse jump that actually resolves.
  const [showSynctexTip, setShowSynctexTip] = useState(false);
  const dismissSynctexTip = useCallback(() => {
    setShowSynctexTip(false);
    try {
      localStorage.setItem('sundial:synctex-tip-seen', '1');
    } catch {
      /* storage denied: the in-session dismissal still holds */
    }
  }, []);
  const handleSynctexInverse = useCallback(
    (file: string, line: number) => {
      const candidates = [pathFromRoot(latexRootPath ?? '', file), file];
      let resolved = candidates.find((p) => workspaceFileByPath.has(p));
      if (!resolved) {
        const base = file.slice(file.lastIndexOf('/') + 1);
        for (const path of workspaceFileByPath.keys()) {
          if (path.slice(path.lastIndexOf('/') + 1) === base) {
            resolved = path;
            break;
          }
        }
      }
      if (!resolved) return;
      openFileAtLine({ path: resolved, line });
      try {
        if (localStorage.getItem('sundial:synctex-tip-seen') !== '1') setShowSynctexTip(true);
      } catch {
        /* storage denied: skip the tip rather than re-showing it forever */
      }
    },
    [latexRootPath, workspaceFileByPath, openFileAtLine],
  );

  // PDF comments (pdf_comments_enabled): each open thread's source line (from
  // the Monaco anchor pass) projected onto the PDF via SyncTeX forward search.
  // The PDF is a projection — comments stay anchored in source, so recompiles,
  // the Overleaf mirror, and Sunny's comment trigger all work unchanged.
  const pdfCommentMarkers = useMemo<PdfCommentMarker[] | null>(() => {
    if (!pdfCommentsEnabled || !synctexIndex || !activeTexFile || !activeWorkspaceFile) return null;
    const rel = pathRelativeToRoot(latexRootPath ?? activeWorkspaceFile.path, activeWorkspaceFile.path);
    const markers: PdfCommentMarker[] = [];
    for (const thread of openCommentThreads) {
      const line = commentAnchorLines[thread.id];
      if (!line) continue;
      const hit = synctexIndex.forward(rel, line);
      if (!hit) continue;
      markers.push({
        id: thread.id,
        page: hit.page,
        yPt: hit.y,
        active: thread.id === activeCommentThreadId,
      });
    }
    return markers.length > 0 ? markers : null;
  }, [pdfCommentsEnabled, synctexIndex, activeTexFile, activeWorkspaceFile, latexRootPath, openCommentThreads, commentAnchorLines, activeCommentThreadId]);

  // A PDF text selection confirmed as a comment: SyncTeX inverse resolves the
  // page point to a source line, the matcher narrows it to the selected span,
  // and the normal draft flow takes over (Yjs anchor + quote, same as Monaco's
  // own Comment action). A hit into another source file (an \input'd child
  // while the root is open) falls back to jump-to-source.
  const handlePdfCommentSelection = useCallback(
    (sel: PdfCommentSelection) => {
      if (!synctexIndex || !activeWorkspaceFile) return;
      const hit = synctexIndex.inverse(sel.page, sel.xPt, sel.yPt);
      if (!hit) return;
      const targetPath = pathFromRoot(latexRootPath ?? activeWorkspaceFile.path, hit.file);
      const handle = textEditorRef.current;
      if (targetPath === activeWorkspaceFile.path && handle?.buildCommentSelectionFromOffsets) {
        const range = matchPdfSelectionToSource(handle.getText(), hit.line, sel.text);
        if (range) {
          const selection = handle.buildCommentSelectionFromOffsets(range.from, range.to);
          if (selection) {
            openCommentDraft(selection);
            return;
          }
        }
      }
      handleSynctexInverse(hit.file, hit.line);
    },
    [synctexIndex, activeWorkspaceFile, latexRootPath, openCommentDraft, handleSynctexInverse],
  );

  // Compile-error row click: `file` is the resolved workspace path (root or an
  // included child) — open it if needed, then reveal + flash the line.
  const handleLatexNavigate = useCallback(
    (line: number, file?: string | null) => {
      if (file) {
        // A root that is momentarily re-resolving must not DROP the pin — the
        // stale-pin effect below already retires it once the user leaves both
        // files, and clearing it here would hand the compile to the child.
        if (latexRootPath) setLatexNavPin({ root: latexRootPath, child: file });
        openFileAtLine({ path: file, line });
      } else if (activeIsRoot) textEditorRef.current?.revealLine?.(line);
    },
    [activeIsRoot, latexRootPath, openFileAtLine],
  );

  // Forward SyncTeX (§4.2): cursor line → PDF point. The jump is always
  // explicit (the editor's "Show in PDF" / Ctrl+Alt+J), so it opens a collapsed
  // pane, flashes the target, and reports a hint when it can't resolve.
  const [synctexJump, setSynctexJump] = useState<SyncTexJump | null>(null);
  const forwardSyncTex = useCallback(
    (line: number | null | undefined): string | null => {
      if (!synctexIndex) return 'Compile first';
      const path = activeWorkspaceFile?.path;
      if (!line || !path) return null;
      const hit = synctexIndex.forward(pathRelativeToRoot(latexRootPath ?? '', path), line);
      if (!hit) return 'No PDF position for this line';
      if (latexViewMode === 'source') handleLatexViewModeChange('split');
      setSynctexJump({ ...hit, nonce: Date.now() });
      return null;
    },
    [synctexIndex, activeWorkspaceFile?.path, latexRootPath, latexViewMode, handleLatexViewModeChange],
  );

  // Monaco actions have no surface for feedback, so the hint lands in the
  // LaTeX toolbar and clears itself. Carries a nonce: repeating the same hint
  // must restart the timer, not be swallowed as an identical state value.
  const [synctexHint, setSynctexHint] = useState<{ text: string; nonce: number } | null>(null);
  const handleSynctexForward = useCallback(() => {
    const text = forwardSyncTex(textEditorRef.current?.getCursorLine?.());
    setSynctexHint(text ? { text, nonce: Date.now() } : null);
  }, [forwardSyncTex]);
  useEffect(() => {
    if (!synctexHint) return;
    const t = setTimeout(() => setSynctexHint(null), 2000);
    return () => clearTimeout(t);
  }, [synctexHint]);

  // Where an explicitly opened tab lands — a file, a turn's diff, the review
  // timeline: beside the chat while the chat holds the primary pane (the
  // slide-in split), otherwise claiming the primary tab. Web (no-tabs) shell:
  // the tab claims the primary and chat docks right instead.
  const openPaneTabBesideChat = useCallback(
    (tab: string) => {
      if (isMobile) return;
      if (desktopTabs && isChatTab(editorPanesRef.current[0].active)) {
        setEditorPanes((prev) => openPaneToSide(prev, tab));
      } else {
        claimPrimaryWithFile(tab);
      }
      // Additive: the surface opens beside any open chat (no need to re-open it).
      setWorkspaceViewMode('space');
    },
    [claimPrimaryWithFile, desktopTabs, isMobile, setWorkspaceViewMode],
  );
  const openEditedFileInlinePath = useCallback((path: string) => {
    setPendingEditedFilePath(null);
    setSelectedFilePath(path);
    if (!isMobile) setOpenLeftRail('project');
    // Placement is the shared rule (openPaneTabBesideChat); the rest is what
    // makes this a FILE open — selection, the rail, the mobile panel. The
    // opener no-ops on mobile (no panes), so set the view mode here too.
    openPaneTabBesideChat(path);
    if (isMobile) {
      setWorkspaceViewMode('space');
      setMobilePanel(null);
    }
  }, [isMobile, openPaneTabBesideChat, setWorkspaceViewMode]);

  const handleOpenEditedFileInline = useCallback((path: string) => {
    const file = workspaceFileByPath.get(path);
    if (!file || file.type === 'folder' || file.type === 'proposal') {
      // Not in the map yet (a just-created Sunny file before the list reload
      // lands) — remember it and open it when the reload arrives.
      setPendingEditedFilePath(path);
      void reloadFiles(false);
      return;
    }
    openEditedFileInlinePath(path);
  }, [openEditedFileInlinePath, reloadFiles, workspaceFileByPath]);

  const handleReturnToChatFromSpace = useCallback(() => {
    setWorkspaceViewMode('chat');
  }, [setWorkspaceViewMode]);

  // Opening a file from a chat surface (edit card, diff tab) keeps the chat
  // BESIDE it — claiming the whole pane lost the conversation you were reading
  // (2026-08-06 founder feedback, reversing the 2026-08-01 file-only open).
  const handleOpenFileFromEditCard = handleOpenEditedFileInline;

  // Closes the file view back to chat-only. Lives on the no-tabs window's
  // top-LEFT corner (macOS convention, founder) — the old top-right header ×
  // was removed on founder feedback.
  const closeActiveFileView = useCallback(() => {
    if (!isMobile) {
      // ONE transition that keeps closing visible file tabs until none remain
      // — iterating outside the updater misses panes closeTab PROMOTES into
      // new ids (closing the primary renames a secondary to 'primary', so a
      // stale pane list left the promoted document open — Codex on #1039).
      applyPaneTransition((prev) => {
        let panes = prev;
        let primaryActive: string | undefined;
        for (let guard = 0; guard < 64; guard += 1) {
          const pane = panes.find((p) => p.active !== '' && !isSpecialTab(p.active));
          if (!pane) break;
          const res = closePaneTab(panes, pane.id, pane.active);
          panes = res.panes;
          primaryActive = res.primaryActive ?? primaryActive;
        }
        return { panes, primaryActive };
      });
    }
    setWorkspaceViewMode('chat');
  }, [applyPaneTransition, isMobile, setWorkspaceViewMode]);

  const handleOpenTurnDiff = useCallback(
    (assistantMessageId: string) => openPaneTabBesideChat(diffTab(assistantMessageId)),
    [openPaneTabBesideChat],
  );
  const handleOpenChatEdits = useCallback(
    (chatId: string) => openPaneTabBesideChat(reviewTab(chatId)),
    [openPaneTabBesideChat],
  );

  useWorkspaceFileEditingEffects({
    workspaceFileByPath,
    pendingEditedFilePath,
    openEditedFileInlinePath,
  });

  function renderMobileFolder(folder: string): React.ReactNode {
    const isExpanded = expandedFolders.has(folder);
    const childFolders = foldersByParent[folder] ?? [];
    const folderFiles = filesByFolder[folder] ?? [];
    const folderLabel = formatFileName(getFileName(folder));

    return (
      <div key={folder} className="space-y-0.5">
        <button
          type="button"
          onClick={() => {
            setExpandedFolders((prev) => {
              const next = new Set(prev);
              if (next.has(folder)) next.delete(folder);
              else next.add(folder);
              return next;
            });
          }}
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${getSidebarListItemStateClasses(false)}`}
        >
          <CaretDownIcon
            className={`h-4 w-4 flex-shrink-0 text-stone-400 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
            weight="bold"
            aria-hidden
          />
          <WorkspaceEntryIcon path={folder} isFolder className="h-[18px] w-[18px] flex-shrink-0" />
          <span className="truncate">{folderLabel}</span>
        </button>
        {isExpanded && (
          <div className="ml-4 space-y-0.5">
            {childFolders.map((child) => renderMobileFolder(child))}
            {folderFiles.map((file) => {
              const isSelected = selectedFilePath === file.path;
              return (
                <div
                  key={file.id}
                  onClick={() => handleFileClick(file)}
                  onPointerEnter={() => prefetchWorkspaceFile(file)}
                  onPointerDown={() => prefetchWorkspaceFile(file)}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${getSidebarListItemStateClasses(isSelected)}`}
                >
                  <WorkspaceEntryIcon
                    path={file.path}
                    className="h-[18px] w-[18px] flex-shrink-0"
                  />
                  <span className="truncate">{formatFileName(getFileName(file.path))}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const closeAssistantPicker = useCallback(() => {
    if (assistantPickerCueTimeoutRef.current !== null) {
      window.clearTimeout(assistantPickerCueTimeoutRef.current);
      assistantPickerCueTimeoutRef.current = null;
    }
    setAssistantPickerCueVisible(false);
    setShowAssistantPicker(false);
    setPickerQuery('');
  }, []);

  // Dismiss the new-chat / assistant-picker menu on an outside click or Escape.
  useEffect(() => {
    if (!showAssistantPicker) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (assistantPickerRef.current?.contains(target)) return;
      closeAssistantPicker();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAssistantPicker();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showAssistantPicker, closeAssistantPicker]);

  // v3: useWorkspaceAssistantPickerEffects removed; assistant picker UI is dead.

  const activateDirectChat = useCallback(
    (
      chatId: string,
      {
        index,
        focusComposer = false,
        sidePanel = false,
        appendTab = false,
      }: { index?: number; focusComposer?: boolean; sidePanel?: boolean; appendTab?: boolean } = {}
    ) => {
      if (typeof index === 'number') {
        setSelectedChatIndex(index);
      }
      setSelectedChatSurface({ type: 'direct', chatId });
      setOpenChatMenuId(null);
      clearUnreadForChat(chatId);
      // Explicit switch: refetch history (the cache can be stale — e.g. a run
      // that finished while we were away updates the assistant row in place,
      // keeping its id/sequence) and apply it to the live chat unless a stream
      // is in flight. The seed effect's sequence check can't catch a same-row
      // content change, and the SSE resume only covers still-running turns.
      void ensureChatMessagesLoaded(chatId, { force: true }).then((messages) => {
        if (!messages.length || currentChatIdRef.current !== chatId) return;
        const live = sundialChatRef.current;
        if (live.status === 'streaming' || live.status === 'submitted') return;
        live.setMessages(messages);
      });
      if (focusComposer) {
        setShouldFocusChatInput(true);
      }
      // Reveal the chat: mobile swaps the main view; desktop opens the chat
      // column beside whatever is open (a deep-linked file+chat keeps the
      // editor). openCenterPanel/setWorkspaceViewMode drop any selected commit.
      if (isMobile) {
        setWorkspaceViewMode('chat');
        setMobilePanel(null);
      } else {
        openCenterPanel('chat', { chatId, side: sidePanel, append: appendTab });
      }
    },
    [clearUnreadForChat, ensureChatMessagesLoaded, isMobile, openCenterPanel, setWorkspaceViewMode]
  );

  // Review panel → open a change's file in the editor. (`editable` is advisory
  // for now: a suggestion is editable, applied history is read-only — both open
  // the current editor view; a read-only-at-version mode can layer on later.)
  const handleOpenReviewFile = useCallback(
    (path: string) => {
      setSelectedFilePath(path);
      claimPrimaryWithFile(path);
      openCenterPanel('editor');
    },
    [claimPrimaryWithFile, openCenterPanel],
  );
  // Review panel → jump to the chat turn a change came from. A chat-originated
  // change's reviewId IS its assistant message id, so reuse the turn-jump path
  // (loads the chat, scrolls to the message, pulses it) instead of just
  // activating the chat and landing wherever the transcript happened to be.
  const handleOpenReviewChatTurn = useCallback(
    ({ chatId, reviewId }: { chatId: string | null; reviewId: string }) => {
      if (chatId) handleJumpToTurn(reviewId, chatId);
    },
    [handleJumpToTurn],
  );

  // A chat's pane tab follows its id swap (promotion and demotion) — same
  // tab, new id.
  const retargetChatTab = useCallback((fromId: string, toId: string) => {
    const fromTab = chatTab(fromId);
    const toTab = chatTab(toId);
    setEditorPanes((prev) =>
      prev.some((p) => p.tabs.includes(fromTab))
        ? prev.map((p) => ({
            ...p,
            tabs: p.tabs.map((t) => (t === fromTab ? toTab : t)),
            active: p.active === fromTab ? toTab : p.active,
          }))
        : prev,
    );
  }, []);

  const replaceDraftChat = useCallback((draftId: string, realThread: ChatThread) => {
    draftPromotionsRef.current[draftId] = realThread.chat.id;
    chatLineageIdRef.current[realThread.chat.id] = chatLineageIdRef.current[draftId] ?? draftId;
    retargetChatTab(draftId, realThread.chat.id);
    setChatThreads((prev) => {
      const draftEntry = prev.find((thread) => thread.chat.id === draftId);
      const realAlreadyPresent = prev.some(
        (thread) => thread.chat.id === realThread.chat.id
      );
      // Preserve the draft's optimistic last_message_at so the chat stays
      // pinned to the top of the rail through promotion.
      const enrichedReal: ChatThread = {
        ...realThread,
        chat: {
          ...realThread.chat,
          last_message_at:
            realThread.chat.last_message_at ?? draftEntry?.chat.last_message_at ?? null,
          // Keep the draft's folder scope if the server dropped it (a
          // pre-migration DB) so the chat doesn't vanish from a focused rail.
          folder_scope: realThread.chat.folder_scope ?? draftEntry?.chat.folder_scope ?? null,
          // A rename that raced the promotion POST lives only on the draft
          // thread — keep it visible; renameChat PATCHes it onto the real row.
          title: realThread.chat.title ?? draftEntry?.chat.title ?? null,
        },
      };
      if (draftEntry && realAlreadyPresent) {
        // Race: loadChatThreads added the real chat while the draft was still
        // in flight. Drop the draft to avoid a duplicate.
        return prev.filter((thread) => thread.chat.id !== draftId);
      }
      if (draftEntry) {
        return prev.map((thread) => (thread.chat.id === draftId ? enrichedReal : thread));
      }
      return realAlreadyPresent ? prev : [...prev, enrichedReal];
    });
    setSelectedChatSurface((prev) =>
      prev.type === 'direct' && prev.chatId === draftId
        ? { type: 'direct', chatId: realThread.chat.id }
        : prev
    );
    // The composer is keyed by the chat's LINEAGE id (chatLineageIdRef), so
    // this id swap keeps the same instance mounted: focus, text, and caret all
    // survive mid-typing promotion. No notify — a draft-version bump would
    // force the remount the lineage key exists to prevent.
    moveStoredMessageDraft(draftId, realThread.chat.id, false);
    setAttachmentsByChatId((prev) => {
      if (!(draftId in prev)) return prev;
      const draftAttachments = prev[draftId] ?? [];
      const { [draftId]: _draftAttachments, ...rest } = prev;
      if (draftAttachments.length === 0) {
        return rest;
      }
      return { ...rest, [realThread.chat.id]: draftAttachments };
    });
    setChatMessagesById((prev) => {
      if (!(draftId in prev)) return prev;
      const { [draftId]: draftMessages, ...rest } = prev;
      return draftMessages && draftMessages.length > 0
        ? { ...rest, [realThread.chat.id]: draftMessages }
        : rest;
    });
    // Ask Sunny/⌘J with no current chat stores the selection under the draft
    // id before promotion — carry it over or the context chip vanishes.
    setContextSnippetsByChatId((prev) => {
      if (!(draftId in prev)) return prev;
      const { [draftId]: draftSnippets, ...rest } = prev;
      return draftSnippets && draftSnippets.length > 0
        ? { ...rest, [realThread.chat.id]: [...(rest[realThread.chat.id] ?? []), ...draftSnippets] }
        : rest;
    });
  }, [moveStoredMessageDraft, retargetChatTab]);

  const promoteDraftChat = useCallback(
    async (
      draftId: string,
      assistantId: string | null | undefined,
      modelOverride?: string,
      // Local drafts carry their engine explicitly: the sidecar's stored
      // default may still be persisting when a fast first send promotes.
      harnessOverride?: ChatHarness,
      folderScope?: string
    ): Promise<ChatThread | null> => {
      // Don't gate on user?.id — anon visitors on anon-owned workspaces
      // need to be able to promote drafts too. The /api/workspace/chats
      // route handles the anon case (verifyOptionalAuth + canWrite check
      // via getProjectAccess's anon-owned branch).
      if (!projectId || !canWrite) return null;
      const apiAssistantId = assistantId ?? null;
      const existing = draftPromotionByIdRef.current.get(draftId);
      if (existing) {
        return await existing;
      }
      // Retry paths (send, settings) don't re-pass folderScope — the draft row
      // itself carries it, so a failed first promotion can't drop the scope.
      // Same for a rename made while still a draft: the title rides along.
      const draftChat = chatThreadsRef.current.find((thread) => thread.chat.id === draftId)?.chat;
      const effectiveFolderScope = folderScope ?? draftChat?.folder_scope ?? undefined;
      const draftTitle = draftChat?.title ?? null;
      const promotion = (async () => {
        try {
          const createRes = await apiFetch('/api/workspace/chats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId,
              assistantId: apiAssistantId,
              model: modelOverride ?? normalizeChatModelRef(preferredChatModel),
              ...(harnessOverride ? { harness: harnessOverride } : {}),
              ...(effectiveFolderScope ? { folderScope: effectiveFolderScope } : {}),
              ...(draftTitle ? { title: draftTitle } : {}),
            }),
          });
          if (!createRes.ok) return null;
          const createPayload = (await createRes.json()) as { chat?: ChatThread };
          if (!createPayload.chat) return null;
          const realThread = createPayload.chat;
          replaceDraftChat(draftId, realThread);
          return realThread;
        } catch {
          return null;
        }
      })();
      draftPromotionByIdRef.current.set(draftId, promotion);
      const result = await promotion;
      // Keep successful promotions cached: a late caller still holding the
      // draft id (stale closure) must resolve to the same real chat, never
      // re-POST a duplicate. Failed attempts clear so the next action retries.
      if (!result) draftPromotionByIdRef.current.delete(draftId);
      return result;
    },
    [canWrite, preferredChatModel, projectId, replaceDraftChat, user?.id]
  );

  // Create a local-only draft chat. Nothing is persisted here: the row reaches
  // the DB only once a message is drafted (first typed character promotes, see
  // handleComposerDraftChange) or sent (promoteDraftChat in the send path).
  const startDraftChat = useCallback(
    (
      _assistantId: string | null,
      _assistantInfo: unknown,
      opts?: {
        model?: string;
        appendTab?: boolean;
        sideTab?: boolean;
        paneId?: string;
        folderScope?: string;
        /** Force the draft's engine (the picker's "New chat with this agent"),
         *  overriding the install default. */
        harness?: ChatHarness;
        /** Add to the rail without stealing selection/tab/focus (draft rehydration). */
        background?: boolean;
        /** Select the draft but do NOT give it a pane tab — the chat column is
         *  closed (file-first arrival) and must not slide in over the document.
         *  It opens ready the moment the user opens chat from the rail. */
        deferTab?: boolean;
      }
    ) => {
      if (projectId) {
        setChatsProjectId(projectId);
      }
      const draftId = `${DRAFT_CHAT_PREFIX}${crypto.randomUUID()}`;
      // Local drafts inherit the default engine — and a model that engine can
      // actually run (a Codex chat must not carry an Anthropic model). While
      // the probe is in flight (undefined) the draft carries NO harness: the
      // sidecar stamps its stored default at promotion, which the optimistic
      // guess must not override.
      // An explicit "New chat with this agent" pick is stamped verbatim (even
      // the cloud agent); an inferred install default goes through
      // stampableHarness so the implicit cloud fallback stays off the row.
      const draftHarness =
        opts?.harness ?? (isLocalWorkspace ? stampableHarness(localEnginesRef.current.defaultHarness) : null);
      const effectiveModel = draftHarness
        ? coerceModelForHarness(draftHarness, normalizeChatModelRef(opts?.model ?? preferredChatModel))
        : normalizeChatModelRef(opts?.model ?? preferredChatModel);
      // Stamp last_message_at = now so the optimistic draft sorts to the top
      // immediately, even when other chats have recent activity. We carry this
      // forward onto the real thread inside replaceDraftChat if the server
      // hasn't recorded any activity yet.
      const draftNow = new Date().toISOString();
      const draftThread: ChatThread = {
        chat: {
          id: draftId,
          model: effectiveModel,
          // Local drafts start on the install's default engine (the sidecar
          // stamps the same default on the persisted row at promotion).
          ...(draftHarness ? { harness: draftHarness } : {}),
          ...(opts?.folderScope ? { folder_scope: opts.folderScope } : {}),
          last_message_at: draftNow,
          archived_at: null,
          preview_text: null,
          unread_count: 0,
          title: null,
          created_at: draftNow,
        },
      };
      setChatThreads((prev) => {
        const next = [...prev, draftThread];
        if (!opts?.background) setSelectedChatIndex(next.length - 1);
        return next;
      });
      if (!opts?.background) {
        setSelectedChatSurface({ type: 'direct', chatId: draftId });
        if (!isMobile && !opts?.deferTab) {
          openChatTabInPanes(draftId, { append: opts?.appendTab, side: opts?.sideTab, paneId: opts?.paneId });
        }
        if (!opts?.deferTab) setShouldFocusChatInput(true);
        closeAssistantPicker();
      }
      return draftId;
    },
    [closeAssistantPicker, isMobile, openChatTabInPanes, preferredChatModel, projectId]
  );

  // First typed character → the draft becomes a real row (a chat may exist in
  // the DB only while a message is drafted or sent); fully backspacing a
  // typed-only chat deletes the row again (demoteTypedChatIfEmpty).
  const demoteTypedChatIfEmptyRef = useRef<(realId: string) => void>(() => {});
  // In-flight demote DELETE per real chat id — a send that races one awaits it
  // so it never dispatches a message into a row that is being deleted.
  const pendingChatDemotionByIdRef = useRef<Map<string, Promise<boolean>>>(new Map());
  // Promotion-failure cooldown: a failing server gets one retry per window,
  // not one per keystroke.
  const draftPromotionFailedAtRef = useRef<Map<string, number>>(new Map());

  // Promote with the DRAFT's own settings (model coerced for its engine at
  // creation, harness when the draft carries one) — same as the send path. A
  // promotion that stamped preferredChatModel instead could persist a model
  // the chat's engine can't run.
  const promoteDraftWithItsSettings = useCallback(
    async (draftId: string) => {
      const draft = chatThreadsRef.current.find((t) => t.chat.id === draftId)?.chat;
      return promoteDraftChat(
        draftId,
        null,
        draft ? normalizeChatModelRef(draft.model) : undefined,
        draft?.harness ? parseChatHarness(draft.harness) : undefined,
      );
    },
    [promoteDraftChat],
  );
  promoteDraftWithSettingsRef.current = promoteDraftWithItsSettings;

  const promoteTypedDraft = useCallback(
    (draftId: string) => {
      const failedAt = draftPromotionFailedAtRef.current.get(draftId);
      if (failedAt && Date.now() - failedAt < 5_000) return;
      void (async () => {
        const realThread = await promoteDraftWithItsSettings(draftId);
        if (!realThread) {
          draftPromotionFailedAtRef.current.set(draftId, Date.now());
          return;
        }
        draftPromotionFailedAtRef.current.delete(draftId);
        // Local workspaces never arm: the sidecar has no chat DELETE, so a
        // demote could only fail-retry forever. Their rows keep the old
        // keep-on-empty behavior.
        if (isLocalWorkspace) return;
        armTypedEmpty(realThread.chat.id);
        // Backspaced to empty while the promotion was in flight — take the
        // row back out.
        if (!messageInputByChatIdRef.current[realThread.chat.id]) {
          demoteTypedChatIfEmptyRef.current(realThread.chat.id);
        }
      })();
    },
    [armTypedEmpty, isLocalWorkspace, promoteDraftWithItsSettings],
  );

  // Reverse of replaceDraftChat: the empty row was deleted, so the open chat
  // surface becomes a local draft again — same tab and settings, new draft id.
  const demoteChatToDraft = useCallback(
    (realId: string) => {
      const draftId = `${DRAFT_CHAT_PREFIX}${crypto.randomUUID()}`;
      chatLineageIdRef.current[draftId] = chatLineageIdRef.current[realId] ?? realId;
      retargetChatTab(realId, draftId);
      const prior = chatThreadsRef.current.find((t) => t.chat.id === realId);
      const draftNow = new Date().toISOString();
      const draftThread: ChatThread = {
        chat: {
          ...(prior?.chat ?? {
            model: normalizeChatModelRef(preferredChatModel),
            last_message_at: draftNow,
            archived_at: null,
            created_at: draftNow,
          }),
          id: draftId,
          title: null,
          preview_text: null,
          unread_count: 0,
        },
      };
      setChatThreads((prev) => {
        const index = prev.findIndex((t) => t.chat.id === realId);
        if (index === -1) return [...prev, draftThread];
        const next = [...prev];
        next[index] = draftThread;
        return next;
      });
      setSelectedChatSurface((prev) =>
        prev.type === 'direct' && prev.chatId === realId ? { type: 'direct', chatId: draftId } : prev
      );
      // Same lineage-keyed swap as replaceDraftChat — the composer instance
      // (and its focus/caret) stays mounted through the id change.
      moveStoredMessageDraft(realId, draftId, false);
      const moveKey = <T,>(prev: Record<string, T[]>): Record<string, T[]> => {
        if (!(realId in prev)) return prev;
        const { [realId]: moved, ...rest } = prev;
        return moved && moved.length > 0 ? { ...rest, [draftId]: moved } : rest;
      };
      setAttachmentsByChatId(moveKey);
      setContextSnippetsByChatId(moveKey);
      setChatMessagesById(moveKey);
      // Retire the promotion PROMISE cache for the deleted row (a stale
      // closure must never PATCH/send against it), but REPOINT the id map at
      // the replacement draft: resolveLiveChatId chains from the original
      // draft id (e.g. an upload still keyed to it) must land here, not on a
      // retired id.
      for (const [dId, rId] of Object.entries(draftPromotionsRef.current)) {
        if (rId === realId) {
          draftPromotionsRef.current[dId] = draftId;
          draftPromotionByIdRef.current.delete(dId);
        }
      }
      demotedDraftByRealIdRef.current[realId] = draftId;
      return draftId;
    },
    [moveStoredMessageDraft, preferredChatModel, retargetChatTab],
  );

  const demoteTypedChatIfEmpty = useCallback(
    async (realId: string) => {
      if (!typedEmptyChatIdsRef.current.has(realId)) return;
      if (pendingChatDemotionByIdRef.current.has(realId)) return;
      // Typed again before we ran — still drafted, keep the row.
      if (messageInputByChatIdRef.current[realId]) return;
      // A watch PATCH is mid-flight (/watch clears the composer right after
      // dispatching it) — deleting now would race it. Stay armed; a later
      // empty transition re-checks against the settled watch state.
      if (commentWatchPendingRef.current.has(realId)) return;
      // A rename, pin, or comment watch is explicit investment in this chat —
      // clearing a text box must never destroy it. Disarm instead of deleting.
      // The thread may still be keyed by the DRAFT id (chatThreadsRef syncs on
      // the render after replaceDraftChat, and the promotion continuation can
      // demote before that) — fall back through the promotion map so a rename
      // made mid-promotion is never missed.
      const draftIdForReal = Object.entries(draftPromotionsRef.current).find(
        ([, rId]) => rId === realId
      )?.[0];
      const chat =
        chatThreadsRef.current.find((t) => t.chat.id === realId)?.chat ??
        (draftIdForReal
          ? chatThreadsRef.current.find((t) => t.chat.id === draftIdForReal)?.chat
          : undefined);
      if (
        chat?.title ||
        chat?.pinned ||
        chat?.pinned_at ||
        chat?.is_pinned ||
        chat?.comment_watch_path ||
        chat?.comment_watch_file_id ||
        (chat?.transport_types ?? []).length > 0
      ) {
        disarmTypedEmpty(realId);
        return;
      }
      const demotion = (async () => {
        let res: Response;
        try {
          res = await apiFetch(`/api/workspace/chats?chatId=${encodeURIComponent(realId)}`, {
            method: 'DELETE',
          });
        } catch {
          // Transient failure — stay armed so the next empty transition retries.
          return false;
        }
        if (res.status === 409) {
          // A message landed first — the chat legitimately exists now.
          disarmTypedEmpty(realId);
          return false;
        }
        // Any other error is treated as transient — stay armed and retry on
        // the next empty transition. (Notably NOT 404-as-deleted: on local
        // workspaces this call reaches the sidecar, where a missing DELETE
        // route would 404 and wrongly demote a chat that still exists.)
        if (!res.ok) return false;
        disarmTypedEmpty(realId);
        const draftId = demoteChatToDraft(realId);
        // Typing raced the DELETE — the text moved to the new draft id, which
        // must promote again.
        if (messageInputByChatIdRef.current[draftId]) promoteTypedDraft(draftId);
        return true;
      })();
      pendingChatDemotionByIdRef.current.set(realId, demotion);
      try {
        await demotion;
      } finally {
        pendingChatDemotionByIdRef.current.delete(realId);
      }
    },
    [apiFetch, demoteChatToDraft, disarmTypedEmpty, promoteTypedDraft],
  );
  demoteTypedChatIfEmptyRef.current = (realId) => void demoteTypedChatIfEmpty(realId);

  // Composer keystrokes drive the draft⇄row lifecycle: the first character
  // creates the row, emptying a typed-only chat removes it.
  // The composer can report under a stale id mid-swap (its remount races both
  // promotion and demotion): resolve to the live id, or a backspace-to-empty
  // in that window gets undone by the remount's restored text, and retyped
  // text lands under a deleted chat.
  const handleComposerDraftChange = useCallback(
    (chatId: string, text: string) => {
      const effectiveId = resolveLiveChatId(chatId);
      if (effectiveId !== chatId) {
        // Keep the stale-mounted composer's slot in sync without persisting
        // under a dead id.
        if (text) messageInputByChatIdRef.current[chatId] = text;
        else delete messageInputByChatIdRef.current[chatId];
      }
      setStoredMessageDraft(effectiveId, text);
      if (text) {
        if (isDraftChatId(effectiveId)) promoteTypedDraft(effectiveId);
      } else if (typedEmptyChatIdsRef.current.has(effectiveId)) {
        void demoteTypedChatIfEmpty(effectiveId);
      }
    },
    [demoteTypedChatIfEmpty, promoteTypedDraft, resolveLiveChatId, setStoredMessageDraft],
  );

  const startAssistantChat = useCallback(
    async (
      assistantId: string | null,
      assistantInfo?: unknown,
      {
        forceNew = false,
        model: modelOverride,
        keepMode = false,
        appendTab = false,
        sideTab = false,
        paneId,
        folderScope,
        harness,
      }: {
        forceNew?: boolean;
        model?: string;
        keepMode?: boolean;
        appendTab?: boolean;
        /** Split beside a visible document instead of replacing it. */
        sideTab?: boolean;
        paneId?: string;
        folderScope?: string;
        harness?: ChatHarness;
      } = {}
    ) => {
      if (!isChatMode && !keepMode) {
        setWorkspaceViewMode('chat');
      }
      if (isMobile) {
        setMobilePanel(null);
      }
      // A new chat starts on the user's saved default model — not whatever the
      // currently-open chat happens to use (preferredChatModel tracks the open
      // chat). An explicit override (e.g. harness switch) still wins.
      const effectiveModel = normalizeChatModelRef(
        modelOverride ?? savedDefaultModel ?? preferredChatModel
      );
      return startDraftChat(assistantId, assistantInfo ?? null, { model: effectiveModel, appendTab, sideTab, paneId, folderScope, harness });
    },
    [
      activateDirectChat,
      closeAssistantPicker,
      isChatMode,
      isMobile,
      preferredChatModel,
      savedDefaultModel,
      setWorkspaceViewMode,
      startDraftChat,
    ]
  );
  startAssistantChatRef.current = startAssistantChat;

  // "New chat in this folder": the chat is stored scoped to the folder
  // (chats.folder_scope — the rail's folder-focus filter reads it). The scope
  // is shown as a chip in the composer; it used to be typed into the draft as
  // "Working in `folder/`: ", which put chrome inside the user's own message.
  const startChatInFolder = useCallback(
    (folder: string) => {
      openCenterPanel('chat', { side: true });
      // '' = a root section's "New chat here" (multi-root primary): the whole
      // project is the scope, so start a plain unscoped chat.
      void startAssistantChat(null, null, {
        forceNew: true,
        keepMode: true,
        sideTab: true,
        ...(folder ? { folderScope: folder } : {}),
      });
    },
    [openCenterPanel, startAssistantChat]
  );

  // "Add folder…" (desktop local projects): the shell's native picker returns
  // via a `pickedPath` fragment rewrite — a same-document navigation (see
  // tauri pick_location_flow). The picked folder mounts into the project as an
  // extra top-level root (sidecar POST /roots): watched, editable, first-class
  // in the tree — not just a composer mention.
  const awaitingContextFolderRef = useRef(false);
  const handleAddContextFolder = useCallback(() => {
    awaitingContextFolderRef.current = true;
    window.location.assign('/desktop/pick-location');
  }, []);
  useEffect(() => {
    if (!localConfig || !projectId) return;
    const onHashChange = () => {
      if (!awaitingContextFolderRef.current) return;
      const picked = getLaunchParam('pickedPath');
      if (!picked) return;
      awaitingContextFolderRef.current = false;
      void localSidecar
        .addRoot(localConfig, projectId, picked)
        // The mount arrives as ONE collapsed sibling section (wireframe:
        // contexts start folded) — never auto-expanded, which dumped the
        // whole tree above the chat list and shoved the rail's chats out of
        // view (founder: "my chats flickered / I lost my chat").
        .then(() => reloadFiles(false))
        .catch((error: unknown) => {
          showWorkspaceAppNotice('error', error instanceof Error ? error.message : 'Could not add the folder');
        });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [localConfig, projectId, reloadFiles, showWorkspaceAppNotice]);

  // Root-row menu: detach a mounted folder (never deletes anything on disk —
  // confirm-free by design).
  const handleRemoveRootFolder = useCallback(
    (prefix: string) => {
      if (!localConfig || !projectId) return;
      void localSidecar
        .removeRoot(localConfig, projectId, prefix)
        .then(() => {
          // Forget the detached tree's expansion — a future mount reusing the
          // prefix must arrive collapsed, not inherit this state.
          setExpandedFolders((prev) => {
            const kept = [...prev].filter((f) => f !== prefix && !f.startsWith(`${prefix}/`));
            return kept.length === prev.size ? prev : new Set(kept);
          });
          return reloadFiles(false);
        })
        .catch((error: unknown) => {
          showWorkspaceAppNotice('error', error instanceof Error ? error.message : 'Could not remove the folder');
        });
    },
    [localConfig, projectId, reloadFiles, showWorkspaceAppNotice],
  );

  // Rehydrate locally-persisted composer drafts once the chat list is in.
  // A restored drafted chat that holds nothing else (direct, transportless,
  // untitled, unpinned, no preview ⇒ no messages) re-arms the typed-empty
  // cleanup, so backspacing it to empty still deletes the row even across a
  // reload. A stored DRAFT-id entry is a draft whose promotion never landed
  // (offline session) — resurrect it as a fresh local draft. Entries whose
  // chat is missing are left alone: the list may be partial after a failed
  // load, and pruning on that would wipe the user's saved drafts.
  const draftsHydratedProjectRef = useRef<string | null>(null);
  const autoDraftProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || !chatsLoaded || chatsProjectId !== projectId) return;
    // One-shot per (identity scope, project): if Clerk resolves the user AFTER
    // the chat list loaded, the key changes and hydration re-runs against the
    // signed-in keys — an anon-scoped first pass must not mark the user's
    // drafts as done. (Restores are idempotent: existing composer text wins.)
    const hydrationKey = `${draftStorageScope}:${projectId}`;
    if (draftsHydratedProjectRef.current === hydrationKey) return;
    draftsHydratedProjectRef.current = hydrationKey;
    let stored: Record<string, unknown>;
    try {
      stored = JSON.parse(
        chatDraftStorageKey ? window.localStorage.getItem(chatDraftStorageKey) ?? '{}' : '{}'
      );
    } catch {
      return;
    }
    const isEmptyTypedChat = (chat: ChatRow) =>
      getChatKind(chat) === 'direct' &&
      (chat.transport_types ?? []).length === 0 &&
      !chat.preview_text &&
      !chat.archived_at &&
      !chat.title &&
      !chat.pinned &&
      !chat.pinned_at &&
      !chat.is_pinned &&
      !chat.comment_watch_path &&
      !chat.comment_watch_file_id;
    let restored = false;
    let restoredForeground = false;
    // Pass 1: real chats — restore their text and re-arm the empty cleanup.
    for (const [chatId, text] of Object.entries(stored)) {
      if (typeof text !== 'string' || !text || isDraftChatId(chatId)) continue;
      const chat = chatThreadsRef.current.find((t) => t.chat.id === chatId)?.chat;
      if (!chat) continue;
      if (!messageInputByChatIdRef.current[chatId]) {
        messageInputByChatIdRef.current[chatId] = text;
        restored = true;
      }
      if (!isLocalWorkspace && isEmptyTypedChat(chat)) armTypedEmpty(chatId);
    }
    // Pass 2: orphan DRAFT-id entries. The unload may have raced the
    // draft→real move, so the promoted row sits empty while the text is
    // still keyed by the dead draft id — adopt such a row (newest first)
    // rather than hiding the text in a background draft; resurrect a
    // background draft only when no empty typed row is left to adopt.
    for (const [chatId, text] of Object.entries(stored)) {
      if (typeof text !== 'string' || !text || !isDraftChatId(chatId)) continue;
      const adoptable = chatThreadsRef.current
        .filter(
          (t) =>
            !isDraftChatId(t.chat.id) &&
            isEmptyTypedChat(t.chat) &&
            !messageInputByChatIdRef.current[t.chat.id]
        )
        .sort((a, b) => (b.chat.created_at ?? '').localeCompare(a.chat.created_at ?? ''))[0]?.chat.id;
      if (adoptable) {
        setStoredMessageDraft(adoptable, text);
        if (!isLocalWorkspace) armTypedEmpty(adoptable);
      } else {
        // With nothing else on the rail the restored draft becomes the
        // VISIBLE one and stands in for the auto-draft below — background
        // mode there would hide the saved text behind a fresh empty draft.
        const foreground = !restoredForeground && !chatThreadsRef.current.some((t) => !t.chat.archived_at);
        const newId = startDraftChat(null, null, { background: !foreground });
        if (foreground) {
          restoredForeground = true;
          autoDraftProjectRef.current = projectId;
        }
        setStoredMessageDraft(newId, text);
      }
      persistChatDraft(chatId, '');
      restored = true;
    }
    // Pass 3: pending-cleanup markers — a DELETE interrupted by a reload or a
    // failed request left the row behind with no stored draft to re-arm it.
    // Re-arm and finish the cleanup now (the server still 409s if anything
    // landed in the meantime).
    if (!isLocalWorkspace && typeof window !== 'undefined') {
      let markers: unknown[] = [];
      try {
        markers = JSON.parse(
          typedEmptyStorageKey ? window.localStorage.getItem(typedEmptyStorageKey) ?? '[]' : '[]'
        );
      } catch {
        markers = [];
      }
      for (const chatId of markers) {
        if (typeof chatId !== 'string' || isDraftChatId(chatId)) continue;
        const chat = chatThreadsRef.current.find((t) => t.chat.id === chatId)?.chat;
        if (!chat || !isEmptyTypedChat(chat)) {
          persistTypedEmptyMarker(chatId, false);
          continue;
        }
        armTypedEmpty(chatId);
        if (!messageInputByChatIdRef.current[chatId]) void demoteTypedChatIfEmpty(chatId);
      }
    }
    if (restored) setMessageDraftVersion((prev) => prev + 1);
  }, [armTypedEmpty, chatDraftStorageKey, chatsLoaded, chatsProjectId, demoteTypedChatIfEmpty, draftStorageScope, isLocalWorkspace, persistChatDraft, persistTypedEmptyMarker, projectId, setStoredMessageDraft, startDraftChat, typedEmptyStorageKey]);

  // A workspace with no open chats lands on a dead composer ("Add an
  // assistant…") — start a fresh chat instead so it always opens ready to
  // send. (autoDraftProjectRef is declared above the hydration effect, which
  // claims it when a restored orphan draft already fills this role.)
  useEffect(() => {
    // canWrite starts optimistically TRUE and resolves with the files
    // payload — without the filesLoaded gate, a read-only visitor whose chat
    // list loads first gets a full-width draft chat opened OVER the shared
    // document the arrival just placed ("file flashes, then chat").
    if (!filesLoaded || !chatsLoaded || chatsProjectId !== projectId || !canWrite) return;
    if (autoDraftProjectRef.current === projectId) return;
    // Un-imported external sessions are read-only rows, not open chats —
    // unless the arrival explicitly targets one (stored last-chat or ?chatId=
    // deep link), in which case the transcript keeps the selection.
    const activeThreads = chatThreadsForCurrentProject.filter((thread) => !thread.chat.archived_at);
    const storedChatId = window.localStorage.getItem(`sundial:last-chat:${projectId}`);
    if (
      activeThreads.some((thread) => !getExternalSession(thread.chat) || thread.chat.id === storedChatId) ||
      findIndexByIdRef(activeThreads, deepLinkedChatId, (thread) => thread.chat.id) >= 0
    ) return;
    autoDraftProjectRef.current = projectId;
    // sideTab: a deep-linked doc keeps the primary pane — the auto-draft
    // docks aside; with nothing open it still lands full-width. deferTab: on
    // the file-first arrival the chat column is deliberately closed, so the
    // draft is selected and ready but takes no pane — a chat column sliding in
    // over the document once the chat list loads is exactly the post-load
    // pane switch the file-first landing exists to remove.
    startDraftChat(null, null, { sideTab: true, deferTab: !openPanelsRef.current.includes('chat') });
  }, [canWrite, chatsLoaded, chatsProjectId, chatThreadsForCurrentProject, deepLinkedChatId, filesLoaded, projectId, startDraftChat]);

  const cueAssistantPicker = useCallback(() => {
    if (assistantPickerCueTimeoutRef.current !== null) {
      window.clearTimeout(assistantPickerCueTimeoutRef.current);
    }
    setAssistantPickerCueVisible(true);
    assistantPickerCueTimeoutRef.current = window.setTimeout(() => {
      setAssistantPickerCueVisible(false);
      assistantPickerCueTimeoutRef.current = null;
    }, 1400);
  }, []);

  const openAssistantPickerMenu = useCallback(
    ({ guide = false, keepMode = false }: { guide?: boolean; keepMode?: boolean } = {}) => {
      // Reveal the chat so the picker has a home. `keepMode` (from the chat
      // column header) just ensures the chat column is open without disturbing
      // the editor; otherwise fall back to the mobile-aware view switch.
      if (keepMode) {
        openCenterPanel('chat');
      } else {
        setWorkspaceViewMode('chat');
      }
      if (isMobile) {
        setMobilePanel(null);
      }
      setShowAssistantPicker(true);
      setPickerQuery('');
      if (!guide) return;
      cueAssistantPicker();
      requestAnimationFrame(() => {
        assistantPickerRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest',
        });
      });
    },
    [cueAssistantPicker, isMobile, openCenterPanel, setWorkspaceViewMode]
  );

  const guideAssistantPickerFromSidebar = useCallback(() => {
    openAssistantPickerMenu({ guide: true, keepMode: true });
  }, [openAssistantPickerMenu]);

  // Assistant name in top bar — always show the dropdown so user can switch
  const showAssistantDropdown = useCallback(() => {
    if (showAssistantPicker) {
      closeAssistantPicker();
      return;
    }
    openAssistantPickerMenu();
  }, [closeAssistantPicker, openAssistantPickerMenu, showAssistantPicker]);

  const teammateCandidates = useMemo(
    () => workspaceChatCollaborators.filter((collaborator) => !collaborator.isYou),
    [workspaceChatCollaborators]
  );
  const closePrototypeGroupModal = useCallback(() => {
    setShowPrototypeGroupModal(false);
    setPrototypeGroupName('');
    setPrototypeGroupTeammateIds([]);
    setGroupChatCreateError(null);
    setIsCreatingGroupChat(false);
  }, []);
  const openPrototypeGroupModal = useCallback(() => {
    closeAssistantPicker();
    setGroupChatCreateError(null);
    setShowPrototypeGroupModal(true);
  }, [closeAssistantPicker]);
  const handleTogglePrototypeGroupTeammate = useCallback((teammateId: string) => {
    setPrototypeGroupTeammateIds((prev) =>
      prev.includes(teammateId)
        ? prev.filter((id) => id !== teammateId)
        : [...prev, teammateId]
    );
  }, []);
  const handleCreatePrototypeGroup = useCallback(async () => {
    if (!projectId || !canWrite || !user?.id) return;

    setGroupChatCreateError(null);
    setIsCreatingGroupChat(true);
    try {
      const response = await apiFetch('/api/workspace/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          chatKind: 'group',
          participantUserIds: prototypeGroupTeammateIds,
          title: prototypeGroupName.trim() || null,
          model: normalizeChatModelRef(preferredChatModel),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; chat?: ChatThread }
        | null;
      if (!response.ok || !payload?.chat) {
        setGroupChatCreateError(payload?.error ?? 'Unable to create group chat.');
        return;
      }

      const createdChat = payload.chat;
      setChatsProjectId(projectId);
      setChatThreads((prev) => {
        const existingIndex = prev.findIndex((thread) => thread.chat.id === createdChat.chat.id);
        if (existingIndex >= 0) {
          setSelectedChatIndex(existingIndex);
          return prev;
        }
        const next = [...prev, createdChat];
        setSelectedChatIndex(next.length - 1);
        return next;
      });
      setSelectedChatSurface({ type: 'direct', chatId: createdChat.chat.id });
      setShouldFocusChatInput(true);
      if (!isChatMode) {
        setWorkspaceViewMode('chat');
      }
      if (isMobile) {
        setMobilePanel(null);
      }
      closePrototypeGroupModal();
    } catch {
      setGroupChatCreateError('Unable to create group chat.');
    } finally {
      setIsCreatingGroupChat(false);
    }
  }, [
    canWrite,
    closePrototypeGroupModal,
    isChatMode,
    isMobile,
    preferredChatModel,
    projectId,
    prototypeGroupName,
    prototypeGroupTeammateIds,
    setWorkspaceViewMode,
    user?.id,
  ]);

  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  // The chat-header title rename is its own state (not `renamingChatId`), so it
  // doesn't also open the list card's rename input for the same chat — two inputs
  // sharing one state caused a blur-commit race that closed the header rename.
  const [renamingHeaderTitle, setRenamingHeaderTitle] = useState(false);
  useEffect(() => {
    setRenamingHeaderTitle(false);
  }, [currentChatId]);
  // Distinguishes a single click (select chat) from a double click (rename).
  // Tracks WHICH row is pending so a fast click on a different row selects that
  // row instead of being mistaken for a double-click.
  const chatClickRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(
    () => () => {
      if (chatClickRef.current) clearTimeout(chatClickRef.current.timer);
    },
    [],
  );
  const renameChat = useCallback(
    async (chatId: string, title: string) => {
      setRenamingChatId(null);
      if (!canWrite) return;
      const trimmed = title.trim();
      // Optimistic local update; reconcile with the server row on success.
      setChatThreads((prev) =>
        prev.map((thread) =>
          thread.chat.id === chatId
            ? { ...thread, chat: { ...thread.chat, title: trimmed || null } }
            : thread
        )
      );
      // An unpromoted draft has no row to PATCH — the title rides along at
      // promotion instead (promoteDraftChat sends it). A rename that raced an
      // in-flight promotion lands on the real row once it resolves.
      if (isDraftChatId(chatId)) {
        const promoted = await draftPromotionByIdRef.current.get(chatId);
        if (!promoted) return;
        chatId = promoted.chat.id;
      }
      const res = await apiFetch('/api/workspace/chats', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, title: trimmed }),
      });
      if (!res.ok) return;
      const payload = (await res.json()) as { chat?: ChatRow };
      if (payload.chat) {
        setChatThreads((prev) =>
          prev.map((thread) =>
            thread.chat.id === payload.chat?.id
              ? { ...thread, chat: { ...thread.chat, ...payload.chat } }
              : thread
          )
        );
      }
    },
    [canWrite]
  );

  // Archiving needs write access, NOT an identity: the route accepts anon
  // callers and local projects have no Clerk user at all. Gating this on
  // `user?.id` is what made "Archive chat" a no-op on the desktop app.
  const toggleChatArchive = useCallback(
    async (chatId: string, archived: boolean) => {
      if (!canManageChat(canWrite, chatId)) return;
      const res = await apiFetch('/api/workspace/chats', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, archived }),
      });
      if (!res.ok) {
        // Never fail silently here: a dead menu item reads as a broken app.
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        showWorkspaceAppNotice('error', payload?.error || `Could not ${archived ? 'archive' : 'unarchive'} the chat`);
        return;
      }
      const payload = (await res.json()) as { chat?: ChatRow };
      if (payload.chat) {
        setChatThreads((prev) =>
          prev.map((thread) =>
            thread.chat.id === payload.chat?.id
              ? { ...thread, chat: { ...thread.chat, ...payload.chat } }
              : thread
          )
        );
      }
    },
    [apiFetch, canWrite, showWorkspaceAppNotice]
  );

  // Explicit, confirmed "Delete chat": the chat AND its transcript go. The row
  // leaves the rail immediately; the pane-prune effect closes its tabs, and the
  // hand-off below keeps a live surface under the user instead of a blank one.
  const deleteChat = useCallback(
    async (chatId: string) => {
      if (!canManageChat(canWrite, chatId)) return;
      const res = await apiFetch(
        `/api/workspace/chats?chatId=${encodeURIComponent(chatId)}&mode=purge`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        showWorkspaceAppNotice('error', payload?.error || 'Could not delete the chat');
        return;
      }
      const wasOpen = currentChatIdRef.current === chatId;
      setChatThreads((prev) => prev.filter((thread) => thread.chat.id !== chatId));
      if (!wasOpen) return;
      // Land on the rail's next ACTIVE chat (archived ones live in Settings);
      // with none left, open a fresh draft so the composer is never dead.
      const next = chatThreadsRef.current
        .filter((thread) => thread.chat.id !== chatId && !thread.chat.archived_at)
        .sort((a, b) => getChatActivityTime(b.chat) - getChatActivityTime(a.chat))[0];
      if (next) activateDirectChat(next.chat.id);
      else startDraftChat(null, null);
    },
    [activateDirectChat, apiFetch, canWrite, showWorkspaceAppNotice, startDraftChat]
  );

  const toggleChatPin = useCallback(
    async (chatId: string, pinned: boolean) => {
      if (!user?.id) return;
      const res = await apiFetch('/api/workspace/chats', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, pinned }),
      });
      if (!res.ok) return;
      const payload = (await res.json()) as { chat?: ChatRow };
      if (payload.chat) {
        setChatThreads((prev) =>
          prev.map((thread) =>
            thread.chat.id === payload.chat?.id
              ? { ...thread, chat: { ...thread.chat, ...payload.chat } }
              : thread
          )
        );
      }
    },
    [user?.id]
  );


  const clearInterruptError = useCallback((chatId: string) => {
    setInterruptErrorByChatId((prev) => {
      if (!prev[chatId]) return prev;
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
  }, []);

  const handleInterruptChat = useCallback(async () => {
    if (!currentChatId) return;
    if (interruptingChatIds[currentChatId]) return;
    const chatId = currentChatId;
    setInterruptingChatIds((prev) => ({ ...prev, [chatId]: true }));
    clearInterruptError(chatId);
    // LOCAL only: a send stuck in 'submitted' (the sidecar POST never answered
    // — no proxy timeout exists on that hop) has no server run to settle, so
    // abort the client transport too, or the chat stays interruptible forever
    // and every Enter is silently ignored. Freeing that socket also lets the
    // interrupt POST out of the starved pool. Cloud keeps the reader attached:
    // its 'submitted' also spans healthy pre-first-token thinking, and its
    // settle/auto-resume recovery is exactly what an abort would disarm.
    if (localConfig && sundialChatRef.current?.status === 'submitted') sundialChatRef.current.stop();
    optimisticStartingUntilByChatIdRef.current.delete(chatId);
    setChatStatusById((prev) => {
      if (prev[chatId] !== 'starting') return prev;
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
    try {
      // Bounded: the escape hatch must not itself wedge on a starved pool —
      // finally always re-arms the button and a failure hits the banner below.
      const res = await fetchWithDeadline(
        apiFetch,
        '/api/agent/interrupt',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId }),
        },
        10_000,
      );
      const payload = (await res.json().catch(() => ({}))) as { error?: string; active?: boolean };
      if (!res.ok) {
        throw new Error(payload?.error || `Stop failed (${res.status})`);
      }
      // The brain had no such run to cancel (`active:false`) — it already
      // finished, or a deploy moved it. Reporting success would leave the chat
      // pinned on "working" with nothing left to end it, so re-check the turn
      // against persisted rows: a terminal row settles the view, a live run is
      // left alone.
      if (payload?.active === false) sundialChatRef.current?.settleIfTerminal();
    } catch (error) {
      // Surface it. A swallowed interrupt looks identical to "nothing happened"
      // — exactly the anon-401 bug that hid here for so long.
      setInterruptErrorByChatId((prev) => ({
        ...prev,
        [chatId]: error instanceof Error ? error.message : 'Could not stop Sundial Agent',
      }));
    } finally {
      setInterruptingChatIds((prev) => {
        if (!prev[chatId]) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
    }
  }, [apiFetch, clearInterruptError, currentChatId, interruptingChatIds, localConfig]);

  // Send message handler
  const handleSendMessage = async (
    contentOverride?: string,
    // standalone: the content is a complete self-contained turn (inline ask)
    // — leave the composer's draft/attachments/pinned snippets alone instead
    // of consuming them into this send (Codex P2 on #790).
    opts?: { standalone?: boolean },
  ) => {
    if (!currentChat) return;
    const standalone = Boolean(opts?.standalone && contentOverride);
    // A standalone send carries no composer attachments, so an in-flight
    // composer upload must not swallow it (Codex P2 on #790).
    if (chatUploadsInFlight && !standalone) return;
    const rawContent = (contentOverride ?? messageInputByChatIdRef.current[currentChat.id] ?? '').trim();
    const attachments = standalone ? [] : currentAttachments;
    const snippets = standalone ? [] : contextSnippetsByChatId[currentChat.id] ?? [];
    if (
      !rawContent &&
      attachments.length === 0 &&
      snippets.length === 0
    ) {
      return;
    }
    // A demote DELETE may be in flight for this chat (type → clear → retype →
    // send inside one round-trip). Settle it first: if the row was deleted,
    // the surface already swapped to a fresh draft carrying this text — this
    // send would target the dead id, so replay it against the replacement
    // draft instead of dropping the user's Enter.
    const pendingDemotion = pendingChatDemotionByIdRef.current.get(currentChat.id);
    if (pendingDemotion && (await pendingDemotion.catch(() => false))) {
      const demotedTo = demotedDraftByRealIdRef.current[currentChat.id];
      for (let i = 0; i < 40 && currentChatRef.current?.id !== demotedTo; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (demotedTo && currentChatRef.current?.id === demotedTo) {
        handleSendMessageRef.current?.(contentOverride ?? undefined, opts);
      }
      return;
    }
    // Sending needs a billable (signed-in) account: an anon web sender has no
    // payer, so the credit gate would block the run with signin_required and
    // strand the message behind a never-resolving typing indicator. Intercept
    // before storing anything and open Clerk sign-in instead. Stash the typed
    // text in sessionStorage first — Clerk reloads the page on success, which
    // would otherwise drop the in-memory draft — and rehydrate it on return.
    // Local projects in the packaged app carry no webview Clerk session —
    // there, the sidecar's sd_ credentials ARE the billable account. A local
    // chat on the Claude/Codex engines has NO payer at all (it runs on the
    // user's own local login), so it never gates on sign-in. If the engine
    // probe is still in flight, ask the sidecar directly instead of guessing:
    // a wrong guess either nags sign-in on an engine chat or persists a Sunny
    // message that then dies on credentials_missing. Drafts inherit the
    // install default (promotion stamps it) and so do empty rows (the sidecar
    // adopts them, mirrored above); a null-harness chat WITH messages is a
    // legacy row the sidecar keeps running as Sunny.
    const inheritsInstallDefault =
      isLocalWorkspace && (isDraftChatId(currentChat.id) || (currentChat.message_count ?? 0) === 0);
    let chatEngine: ChatHarness | undefined = currentChat.harness
      ? parseChatHarness(currentChat.harness)
      : inheritsInstallDefault
        ? localEnginesRef.current.defaultHarness
        : ('vercel' as const);
    if (isLocalWorkspace && chatEngine === undefined && localConfig) {
      chatEngine = await localSidecar
        .localEngines(localConfig)
        .then(({ defaultHarness }) => parseChatHarness(defaultHarness))
        .catch(() => undefined);
    }
    const localEngineChat = isLocalWorkspace && (chatEngine === 'claude' || chatEngine === 'openai');
    if (
      !localEngineChat &&
      (clerkAuthRef.current.isLoaded || clerkNeverLoads()) &&
      !clerkAuthRef.current.isSignedIn &&
      // Anonymous free-taste runs left: send instead of nagging — the server
      // gate is the authority and serves it (or answers signin_required,
      // which the transport surfaces honestly, if this count went stale).
      !((anonRunsRemainingRef.current ?? 0) > 0)
    ) {
      // Cloud workspaces opened in the packaged app have no localConfig, but
      // the loopback sidecar still holds the sd_ credentials that authenticate
      // every /api call — resolve it globally or every send would nag sign-in.
      const config = localConfig ?? (await resolveSidecarConfig());
      const desktopCredentials = config ? await desktopCredentialsUsable(config) : false;
      if (!desktopCredentials) {
        // Never hand off to sign-in unannounced: in the desktop shell that
        // handoff throws the system browser in front of the app. Explain the
        // cloud-account requirement first and let the user opt in — the typed
        // text rides on the prompt and is only stashed for the post-auth
        // reload if they go through with it (a cancelled send must not
        // resurrect its text on some later sign-in).
        setCloudSignInPrompt({ redirectUrl: buildReturnPath({}), draft: rawContent });
        return;
      }
    }
    // First time a local engine actually runs something: say so once, inline.
    if (localEngineChat && chatEngine) noteLocalEngineUse(chatEngine);
    // A new turn supersedes any stale "couldn't stop" banner from before.
    clearInterruptError(currentChat.id);
    const snippetBlock = formatSnippetBlock(snippets);
    const content = snippetBlock
      ? rawContent
        ? `${snippetBlock}\n\n${rawContent}`
        : snippetBlock
      : rawContent;
    let chat = currentChat;

    // A just-picked model/harness may still be PATCHing; the runner reads both
    // from the chats row at turn start, so let it land before sending. Checked
    // under the pre-promotion (possibly draft) id here and the real id below —
    // the PATCH registers under whichever ids it knows.
    await pendingChatSettingsByIdRef.current.get(chat.id);

    // If this is a draft chat, persist it to the database first.
    // No user?.id gate — anon visitors on anon-owned workspaces need to
    // promote too. promoteDraftChat's own gates handle the rest.
    let promotedThisSend = false;
    if (isDraftChatId(chat.id) && projectId && canWrite) {
      promotedThisSend = true;
      const draftId = chat.id;
      // Promote with the draft's own model, not preferredChatModel (which may
      // have drifted to another open chat).
      const realThread = await promoteDraftChat(
        draftId,
        null,
        normalizeChatModelRef(chat.model),
        // Only a draft that KNOWS its engine overrides — a pre-probe local
        // draft has none and defers to the sidecar's stored default.
        chat.harness ? parseChatHarness(chat.harness) : undefined,
      );
      if (!realThread) return;
      chat = realThread.chat;
      await pendingChatSettingsByIdRef.current.get(chat.id);
    }
    const previousChatStatus = chatStatusById[chat.id];
    const restoreChatStatus = () => {
      optimisticStartingUntilByChatIdRef.current.delete(chat.id);
      setChatStatusById((prev) => {
        const next = { ...prev };
        if (previousChatStatus) {
          next[chat.id] = previousChatStatus;
        } else {
          delete next[chat.id];
        }
        return next;
      });
    };
    setChatStatusById((prev) => ({
      ...prev,
      [chat.id]: prev[chat.id] === 'working' ? prev[chat.id] : 'starting',
    }));
    optimisticStartingUntilByChatIdRef.current.set(chat.id, Date.now() + STARTING_STATUS_GRACE_MS);

    // Delegate to useSundialChat. The transport POSTs to
    // /api/workspace/messages (attachments + RLS + anon auth) and opens
    // SSE for the streamed reply. useChat owns the message state and
    // adds the user message synchronously, so we don't run a separate
    // optimistic pass here.
    // A fast FIRST Enter races its own draft's promotion: `chat` is already
    // the promoted row while this render's currentChatId is still the draft
    // id and the chat sender hasn't mounted. That's the same chat, not a
    // swap — wait for the id swap instead of silently dropping the send.
    if (chat.id !== currentChatId && currentChatId && draftPromotionsRef.current[currentChatId] === chat.id) {
      for (let i = 0; i < 40 && (currentChatRef.current?.id !== chat.id || !sundialChatRef.current); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!sundialChatRef.current || chat.id !== (currentChatRef.current?.id ?? currentChatId)) {
      // Defensive: chat swap raced ahead of the send. Restore status and
      // let the next send (with the right chatId) take over.
      restoreChatStatus();
      return;
    }

    // A real send is happening — the typed-empty cleanup must never delete
    // this chat now. Remember whether it WAS armed: a send that fails before
    // persisting anything re-arms below, or the empty row would be orphaned.
    const wasArmedTypedEmpty = disarmTypedEmpty(chat.id);

    // Clear composer + attachments + snippets before the await so the UI
    // feels instant — matches what the old optimistic flow gave us. A
    // standalone send never consumed any of them, so it leaves them alone.
    if (!standalone) {
      setStoredMessageDraft(chat.id, '', currentChatRef.current?.id === chat.id);
      if (attachments.length > 0) {
        setAttachmentsByChatId((prev) => ({ ...prev, [chat.id]: [] }));
      }
      if (snippets.length > 0) {
        setContextSnippetsByChatId((prev) => {
          if (!prev[chat.id]) return prev;
          const out = { ...prev };
          delete out[chat.id];
          return out;
        });
      }
    }

    // Optimistic sidebar update — the streamed reply lands too late for
    // the sidebar preview to feel responsive otherwise.
    setChatThreads((prev) =>
      prev.map((thread) =>
        thread.chat.id === chat.id
          ? {
              ...thread,
              chat: {
                ...thread.chat,
                last_message_at: new Date().toISOString(),
                preview_text: toChatPreviewText(content) ?? thread.chat.preview_text ?? null,
                unread_count: 0,
              },
            }
          : thread
      )
    );

    // If the open file is mid-move, wait (≤ one PATCH round-trip) for it to
    // settle — the path is frozen into the message row and resolved by the
    // agent, so freezing either the old or new path mid-flight can strand it.
    // Capture the sender and edit mode first: a chat switch during the await
    // rebinds both refs, and the message belongs to the chat it was typed in.
    const chatSender = sundialChatRef.current;
    const editMode = chatEditModeRef.current;
    // Reported to callers that need to know the send actually landed (the
    // LaTeX fix flow gates its resolution-eligible attempt on it).
    let sent = false;
    let openFilePath = effectiveOpenFilePath;
    const inFlightMove = openFileMoveRef.current;
    if (openFilePath && inFlightMove && openFilePath === inFlightMove.current) {
      openFilePath = await inFlightMove.settled;
    }

    try {
      await chatSender.send(content, {
        attachments,
        openFilePath,
        sendMode: 'fullsend',
        editMode,
      });
      track('message_sent', {
        chatId: chat.id,
        projectId,
        contentLength: content.length,
        hasAttachments: attachments.length > 0,
        sendMode: 'fullsend',
      });
      sent = true;
    } catch (err) {
      restoreChatStatus();
      if (attachments.length > 0) {
        setAttachmentsByChatId((prev) => ({ ...prev, [chat.id]: attachments }));
      }
      // The message may never have been persisted — re-arm the typed-empty
      // cleanup and let the server decide: if the row really is still empty
      // it comes back out; if the message DID land, the DELETE 409s. A row
      // this very send created (attachment-only draft, restored draft,
      // inline ask) was never armed by typing, so arm it here too.
      if ((wasArmedTypedEmpty || promotedThisSend) && !isLocalWorkspace) {
        armTypedEmpty(chat.id);
        if (!messageInputByChatIdRef.current[chat.id]) {
          void demoteTypedChatIfEmpty(chat.id);
        }
      }
      console.warn('[handleSendMessage] sundialChat.send failed', err);
    }

    if (canWrite && user?.id) {
      window.setTimeout(() => {
        void loadAgentStatuses();
      }, 300);
    }
    return sent;
  };

  // Persist per-chat settings (model and/or harness). Applies the optimistic
  // update immediately (on the draft id if the chat is still promoting, so the
  // picker reflects the choice at once), promotes drafts before PATCHing so the
  // change lands on the persisted row, and registers the PATCH in
  // pendingChatSettingsByIdRef so a send can't race it. Reverts on failure.
  const patchChatSettings = async (
    chatId: string,
    next: { model?: string; harness?: ChatHarness },
    previous: { model: string; harness: ChatHarness },
  ) => {
    const apply = (id: string, model: string, harness: ChatHarness) =>
      setChatThreads((prev) =>
        prev.map((t) => (t.chat.id === id ? { ...t, chat: { ...t.chat, model, harness } } : t))
      );
    const nextModel = next.model ?? previous.model;
    const nextHarness = next.harness ?? previous.harness;

    apply(chatId, nextModel, nextHarness);
    // Register the pending work under the current (possibly draft) id BEFORE
    // any await, so a send racing this click always finds it — and again under
    // the real id once promotion resolves it. Earlier in-flight entries are
    // kept to serialize behind: two quick clicks must PATCH in click order or
    // an out-of-order response leaves the row on the stale value.
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const priors = [pendingChatSettingsByIdRef.current.get(chatId)];
    pendingChatSettingsByIdRef.current.set(chatId, settled);
    let targetChatId = chatId;
    try {
      // An unpromoted draft has no row to PATCH — and must not get one for a
      // mere settings pick (rows exist only once a message is drafted or
      // sent). The draft thread carries the settings; promotion stamps both
      // model and harness through the create POST.
      if (isDraftChatId(targetChatId) && !draftPromotionByIdRef.current.has(targetChatId)) {
        return;
      }
      if (isDraftChatId(targetChatId)) {
        // The draft is already promoting (typing raced this click); await
        // (or retry) the promotion so the PATCH lands on the real row, which is
        // where the runner reads chats.model / chats.harness from. A failed
        // promotion is a failure: fall through to the revert so the UI doesn't
        // keep showing settings that were never persisted.
        const promoted = await promoteDraftChat(targetChatId, null);
        if (!promoted) throw new Error('Draft promotion failed');
        targetChatId = promoted.chat.id;
        // replaceDraftChat swapped in the server thread; re-apply on the real id.
        apply(targetChatId, nextModel, nextHarness);
        priors.push(pendingChatSettingsByIdRef.current.get(targetChatId));
        pendingChatSettingsByIdRef.current.set(targetChatId, settled);
      }
      await Promise.all(priors);
      // Always PATCH the complete desired pair, not just the changed field: a
      // queued update must persist the whole state its optimistic UI shows, so
      // a failed predecessor (e.g. the harness click before this model click)
      // can't leave the row half-updated behind a converged-looking UI.
      const res = await apiFetch('/api/workspace/chats', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: targetChatId, model: nextModel, harness: nextHarness }),
      });
      if (!res.ok) throw new Error('Unable to update chat settings');
    } catch {
      // Roll back only while this is still the newest settings click for the
      // chat — a newer click has already applied its own optimistic value and
      // owns the UI (its PATCH decides the final state).
      if (pendingChatSettingsByIdRef.current.get(targetChatId) === settled) {
        apply(targetChatId, previous.model, previous.harness);
        if (next.model) setPreferredChatModel(previous.model);
      }
    } finally {
      settle();
      for (const id of [chatId, targetChatId]) {
        if (pendingChatSettingsByIdRef.current.get(id) === settled) {
          pendingChatSettingsByIdRef.current.delete(id);
        }
      }
    }
  };

  const handleSelectChatRuntime = async (option: ChatRuntimePickerOption) => {
    const nextModel = normalizeChatModelRef(option.id);
    setPreferredChatModel(nextModel);
    setShowModelPicker(false);
    if (!currentChatId || nextModel === currentChatModel) return;
    await patchChatSettings(
      currentChatId,
      { model: nextModel },
      { model: currentChatModel, harness: currentChatHarness },
    );
  };

  // Switch the chat's agent harness (the tabs in the model picker). The
  // Claude/OpenAI harnesses only run their own provider's models, so switching
  // into one coerces the model to a sensible default for that provider when the
  // current one differs.
  const handleSelectChatHarness = async (nextHarness: ChatHarness) => {
    if (!currentChatId || nextHarness === currentChatHarness) return;
    // An explicit pick outranks detection for FUTURE chats too — nobody wants
    // to re-pick every chat. This chat is switched by the PATCH below. Other
    // empty chats follow only once the sidecar acks: stamping ahead of (or
    // despite) a failed POST would let a send skip the sign-in gate while the
    // sidecar still runs them as Sunny.
    if (isLocalWorkspace && localConfig) {
      setLocalEngines((prev) => ({ ...prev, defaultHarness: nextHarness }));
      void localSidecar
        .setDefaultHarness(localConfig, nextHarness)
        .then(() => adoptDefaultHarnessLocally(nextHarness))
        .catch(() => {});
    }
    const nextModel = coerceModelForHarness(nextHarness, currentChatModel);
    await patchChatSettings(
      currentChatId,
      { harness: nextHarness, ...(nextModel !== currentChatModel ? { model: nextModel } : {}) },
      { model: currentChatModel, harness: currentChatHarness },
    );
  };

  // A chat's engine is fixed once it has messages (history and local session
  // lineage belong to that engine), so the picker's locked rows offer the only
  // move that works instead of refusing the click: a fresh chat on that agent.
  const startChatWithHarness = (nextHarness: ChatHarness) => {
    openCenterPanel('chat');
    void startAssistantChat(null, null, { forceNew: true, keepMode: true, harness: nextHarness });
  };

  // Comment listening: a chat with chats.comment_watch_path set receives every
  // new human doc comment on that path ('*' = whole workspace) as a message.
  const setCommentWatch = async (chatId: string, path: string | null) => {
    // Watching from a row-less draft is explicit investment in the chat —
    // promote first so the PATCH has a row to land on (the watch then also
    // guards the chat against typed-empty cleanup).
    if (isDraftChatId(chatId)) {
      const promoted = await promoteDraftWithItsSettings(chatId);
      if (!promoted) return;
      chatId = promoted.chat.id;
      // Armed so a failed watch PATCH doesn't leak the empty row; a landed
      // watch is kept by the comment_watch guard.
      if (!isLocalWorkspace) armTypedEmpty(chatId);
    }
    // Seed the confirmed map NOW, before this call's optimistic apply — the
    // first toggle for a chat is the only moment the thread state still holds
    // the server's value. Seeding lazily inside the queued callback would read
    // a later call's optimistic state instead (a superseded predecessor never
    // rolls back or seeds), leaving a failed retry to "revert" to the wrong
    // side while the server keeps waking the agent.
    if (!commentWatchConfirmedRef.current.has(chatId)) {
      commentWatchConfirmedRef.current.set(
        chatId,
        chatThreadsForCurrentProject.find((t) => t.chat.id === chatId)?.chat.comment_watch_path ?? null,
      );
    }
    const apply = (value: string | null) =>
      setChatThreads((prev) =>
        prev.map((t) => (t.chat.id === chatId ? { ...t, chat: { ...t.chat, comment_watch_path: value } } : t))
      );
    apply(path);
    // Toggling faster than the round-trip must not let an older PATCH land
    // last: requests are CHAINED per chat (server order = click order) and a
    // superseded one neither rolls back nor reconciles — a hidden watch left
    // enabled behind a "stopped" chip would wake the agent and spend credits.
    const seq = (commentWatchSeqRef.current.get(chatId) ?? 0) + 1;
    commentWatchSeqRef.current.set(chatId, seq);
    commentWatchPendingRef.current.set(chatId, (commentWatchPendingRef.current.get(chatId) ?? 0) + 1);
    const chained = (commentWatchQueueRef.current.get(chatId) ?? Promise.resolve()).then(async () => {
      if (commentWatchSeqRef.current.get(chatId) !== seq) return; // superseded
      // Read the confirmed value HERE — after our predecessors settled — so a
      // rapid stop→start reverts to what the server actually holds, not to an
      // optimistic value captured before the earlier request answered. The map
      // is always populated: seeded above on the chat's first toggle, updated
      // by every successful PATCH after.
      const confirmed = commentWatchConfirmedRef.current.get(chatId) ?? null;
      try {
        const res = await apiFetch('/api/workspace/chats', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, commentWatchPath: path }),
        });
        if (res.ok) commentWatchConfirmedRef.current.set(chatId, path);
        else if (commentWatchSeqRef.current.get(chatId) === seq) apply(confirmed);
      } catch {
        // A network-layer rejection must roll the optimistic chip back too.
        if (commentWatchSeqRef.current.get(chatId) === seq) apply(confirmed);
      }
    }).finally(() => {
      const remaining = (commentWatchPendingRef.current.get(chatId) ?? 1) - 1;
      if (remaining <= 0) commentWatchPendingRef.current.delete(chatId);
      else commentWatchPendingRef.current.set(chatId, remaining);
    });
    commentWatchQueueRef.current.set(chatId, chained);
    await chained;
  };

  const handleChatAction = (sendTrigger: SendTrigger = 'button', contentOverride?: string) => {
    // Classic stop/send UX on web: while a turn streams the button is a Stop
    // button (interrupt regardless of any draft) and Enter is inert, so the user
    // can compose a follow-up without aborting the reply — stop first, then send.
    const decision = decideChatAction(isChatInterruptible, sendTrigger);
    if (decision === 'interrupt') {
      void handleInterruptChat();
      return;
    }
    if (decision === 'ignore') return;
    // Pin the transcript to the bottom when the user sends, even if they had
    // scrolled up to read earlier messages.
    scrollChatToBottomRef.current?.();
    void handleSendMessage(contentOverride);
  };
  const handleSendMessageRef = useRef(handleSendMessage);
  handleSendMessageRef.current = handleSendMessage;
  const scrollChatToBottomRef = useRef<(() => void) | null>(null);

  // "Fix with Agent" (§1.10) / auto-fix (§1.11) / Cmd+Enter (§1.5): hand the
  // failing root + trimmed error tail to the project's ONE dedicated fix chat
  // (kind='latex_fix', created on first use) as a normal turn — never to
  // whatever chat happens to be open. No new agent endpoint — Sunny edits the
  // .tex and self-heals as usual.
  const [fixInFlight, setFixInFlight] = useState(false);
  const [latexFixChatId, setLatexFixChatId] = useState<string | null>(null);
  // Why the last Fix could not run — the compile status popover surfaces it,
  // with a Sign in CTA for the 'signin' kind (anon out of free runs, or a
  // signed-out editor).
  const [latexFixBlocked, setLatexFixBlocked] = useState<LatexFixBlocked | null>(null);
  // The send is fire-and-forget, so "busy" outlives the POST: hold the Fix
  // affordances until the fix chat's run settles, or a second click would
  // cancel-and-replace the repair mid-flight. Run liveness reads like the
  // rail badges do — realtime status for cloud chats, the sidecar's `running`
  // flag for local ones — and a short grace covers the gap between the POST
  // returning and the first liveness signal.
  const [latexFixGraceUntil, setLatexFixGraceUntil] = useState<number | null>(null);
  const latexFixChatStatus = latexFixChatId ? chatStatusById[latexFixChatId] : undefined;
  const latexFixThread = latexFixChatId
    ? (chatThreadsForCurrentProject.find((t) => t.chat.id === latexFixChatId)?.chat as
        | { running?: boolean; answering?: boolean }
        | undefined)
    : undefined;
  // After a no-start (blocked/error), the already-persisted user row's
  // realtime INSERT can still flip this chat to 'starting' with no run ever
  // coming — suppress that phantom until the next successful send. A real
  // run shows as 'working' / running and is never suppressed.
  const latexFixSuppressStartingRef = useRef<string | null>(null);
  const latexFixStartingSuppressed =
    latexFixChatId != null && latexFixSuppressStartingRef.current === latexFixChatId;
  // `answering` covers the local gap where a started run still owes its
  // reply while `running` reads false — same treatment as the comment badges.
  const latexFixRealRun =
    latexFixChatStatus === 'working' || Boolean(latexFixThread?.running) || Boolean(latexFixThread?.answering);
  const latexFixRunLive =
    latexFixRealRun || (latexFixChatStatus === 'starting' && !latexFixStartingSuppressed);
  // Seeded-'starting' bookkeeping: the seed guarantees an instant hold on a
  // brand-new fix chat (the realtime subscription can lag the chat-list
  // commit); grace expiry retires a seed no feed ever advanced, so a surface
  // without that feed (local) can never stick busy forever.
  const latexFixSeededRef = useRef<string | null>(null);
  const clearLatexFixSeed = useCallback(() => {
    const seeded = latexFixSeededRef.current;
    if (!seeded) return;
    latexFixSeededRef.current = null;
    setChatStatusById((prev) => (prev[seeded] === 'starting' ? { ...prev, [seeded]: 'idle' } : prev));
  }, []);
  // A real signal makes the seed obsolete the moment it appears — without
  // this, a local run observed via `running` leaves the seeded 'starting'
  // behind, and nothing on that surface ever overwrites it after the run.
  useEffect(() => {
    if (!latexFixRealRun) return;
    clearLatexFixSeed();
    if (latexFixPendingStartRef.current) {
      latexFixPendingStartRef.current = false;
      latexFixStartedRef.current();
    }
  }, [latexFixRealRun, clearLatexFixSeed]);
  // Failsafe: a hidden chat's terminal Realtime event can be missed (tab
  // sleep mid-run) and nothing else reconciles the map for non-open chats —
  // a live status that never transitions releases the hold after 5 minutes.
  // Covers 'starting' too (a realtime echo can re-seed it after the grace),
  // or a stuck one would hold Fix and auto-fix hostage with no way out.
  // Compile-fix runs are short; a genuine marathon merely becomes re-fixable.
  useEffect(() => {
    if (!latexFixChatId) return;
    const status = latexFixChatStatus;
    if (status !== 'working' && status !== 'starting') return;
    const chatId = latexFixChatId;
    const timer = setTimeout(() => {
      setChatStatusById((prev) => (prev[chatId] === status ? { ...prev, [chatId]: 'idle' } : prev));
    }, 5 * 60_000);
    return () => clearTimeout(timer);
  }, [latexFixChatId, latexFixChatStatus]);
  useEffect(() => {
    if (latexFixGraceUntil == null) return;
    // Only a REAL signal retires the grace — the seeded 'starting' must not
    // cancel the very timer that exists to retire the seed.
    if (latexFixRealRun) return setLatexFixGraceUntil(null);
    const timer = setTimeout(() => {
      setLatexFixGraceUntil(null);
      clearLatexFixSeed();
    }, Math.max(0, latexFixGraceUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [latexFixGraceUntil, latexFixRealRun, clearLatexFixSeed]);
  const latexFixBusy = fixInFlight || latexFixRunLive || latexFixGraceUntil != null;
  const latexFixBusyRef = useRef(latexFixBusy);
  latexFixBusyRef.current = latexFixBusy;
  // Rapid Fix clicks share the in-flight find-or-create — never two creates.
  const latexFixEnsureRef = useRef<Promise<string | null> | null>(null);
  const ensureLatexFixChatId = useCallback(() => {
    return (latexFixEnsureRef.current ??= ensureLatexFixChat({
      threads: chatThreadsForCurrentProject,
      refreshThreads: loadChatThreads,
      createChat: async () => {
        try {
          const res = await apiFetch('/api/workspace/chats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, kind: LATEX_FIX_CHAT_KIND, title: LATEX_FIX_CHAT_TITLE, model: LATEX_FIX_CHAT_MODEL }),
          });
          if (!res.ok) return null;
          const payload = (await res.json()) as { chat?: { chat?: { id?: string } } };
          return payload.chat?.chat?.id ?? null;
        } catch {
          return null;
        }
      },
      archiveChat: async (chatId) => {
        await apiFetch('/api/workspace/chats', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, archived: true }),
        });
      },
      // A fix chat from before the fast-model pin still runs the workspace
      // default; pin it to the fast fix model on reuse (fire-and-forget).
      setChatModel: async (chatId) => {
        await apiFetch('/api/workspace/chats', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, model: LATEX_FIX_CHAT_MODEL }),
        });
      },
    }).finally(() => {
      latexFixEnsureRef.current = null;
    }));
  }, [apiFetch, chatThreadsForCurrentProject, loadChatThreads, projectId]);
  const latexFixClickedRef = useRef<() => void>(() => {});
  const latexFixStartedRef = useRef<() => void>(() => {});
  // Armed by the visible-chat send; the run's liveness signal (below) commits
  // the resolution-eligible attempt at the acceptance boundary.
  const latexFixPendingStartRef = useRef(false);
  const handleLatexFix = useCallback(() => {
    if (!activeWorkspaceFile) return;
    const target = latexRootPath ?? activeWorkspaceFile.path;
    // Capture the failure at click time — the compile state can move on while
    // the fix chat is found/created. When the open file IS the failing root,
    // its live text rides along so the fix turn can Edit without a Read
    // round trip (a visible chunk of the fix latency).
    const fixSource = target === activeWorkspaceFile.path ? readEditorText() : null;
    const prompt = buildCompileFixPrompt(target, latexCompile.errorLines, latexCompile.logText, fixSource);
    if (latexFixBusyRef.current) return; // a second send would cancel-and-replace the running repair
    latexFixClickedRef.current();
    setFixInFlight(true);
    setLatexFixBlocked(null);
    void (async () => {
      try {
        // Same pre-send auth gate as the composer, checked BEFORE creating
        // the chat or persisting anything, so an unsigned editor gets the
        // message instead of a dead prompt row in a hidden chat. Local is
        // harness-aware like the composer: a Claude/Codex engine chat runs on
        // the user's own local login and never gates; a local Sunny chat
        // needs usable sd_ credentials.
        if (localConfig) {
          const fixThread = chatThreadsForCurrentProject.find(
            (t) => (t.chat as { kind?: string | null }).kind === LATEX_FIX_CHAT_KIND && !t.chat.archived_at,
          );
          const fixHarness = fixThread?.chat.harness
            ? parseChatHarness(fixThread.chat.harness)
            : localEnginesRef.current.defaultHarness;
          if (fixHarness !== 'claude' && fixHarness !== 'openai') {
            const desktopCredentials = await desktopCredentialsUsable(localConfig);
            if (!desktopCredentials)
              return setLatexFixBlocked({ kind: 'signin', message: 'Sign in to let the agent fix this.' });
          }
        } else if (
          (clerkAuthRef.current.isLoaded || clerkNeverLoads()) &&
          !clerkAuthRef.current.isSignedIn &&
          // Anonymous free-taste runs left: attempt the fix — the server gate
          // is the authority and serves it, exactly like the composer.
          !((anonRunsRemainingRef.current ?? 0) > 0)
        ) {
          const config = await resolveSidecarConfig();
          const desktopCredentials = config ? await desktopCredentialsUsable(config) : false;
          if (!desktopCredentials)
            return setLatexFixBlocked({ kind: 'signin', message: 'Sign in to let the agent fix this.' });
        }
        const fixChatId = await ensureLatexFixChatId();
        if (!fixChatId)
          return setLatexFixBlocked({ kind: 'error', message: 'Could not open the fix chat.' });
        setLatexFixChatId(fixChatId);
        if (currentChatRef.current?.id === fixChatId && sundialChatRef.current) {
          // The fix chat IS the open chat: send through the live transport so
          // the turn shows in the visible transcript (the realtime hook skips
          // own INSERTs, assuming own sends ride useChat). Same grace hold as
          // the hidden path — the async send can pause (engine probe, model
          // PATCH) before any liveness signal exists.
          latexFixSuppressStartingRef.current = null;
          setLatexFixGraceUntil(Date.now() + 8_000);
          // The send promise resolves only after the whole streamed turn, so
          // the attempt is committed when the run's liveness signal lands
          // (latexFixRealRun effect) — the transport's acceptance boundary —
          // and disarmed if the send reports it never landed.
          latexFixPendingStartRef.current = true;
          void Promise.resolve(handleSendMessageRef.current?.(prompt, { standalone: true })).then(
            (sent) => {
              if (!sent) latexFixPendingStartRef.current = false;
            },
          );
          return;
        }
        // Instant hold before the POST: the run's first events can beat the
        // realtime subscription to a chat React only just learned about.
        setChatStatusById((prev) => (prev[fixChatId] ? prev : { ...prev, [fixChatId]: 'starting' }));
        latexFixSeededRef.current = fixChatId;
        // Fire-and-forget into the dedicated fix chat — no chat swap, no pane
        // churn; the user stays in their document and their open conversation.
        // The rail's running indicator is the feedback, and the fix lands as
        // inline suggestions. Explicit suggest mode: this send bypasses the
        // composer, so it must not inherit anything looser.
        const res = await apiFetch('/api/workspace/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: fixChatId, content: prompt, clientId: crypto.randomUUID(), editMode: 'suggest' }),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          agentStart?: { ok?: boolean; status?: string; reason?: string; rescued?: boolean };
        };
        // This path bypasses the composer's sign-in gate, so a blocked or
        // failed start must surface here — a silent no-op reads as "Fix is
        // broken", and holding busy for a run that never started sticks the
        // button forever.
        const noStart = () => {
          latexFixSuppressStartingRef.current = fixChatId;
          clearLatexFixSeed();
        };
        if (!res.ok) {
          noStart();
          return setLatexFixBlocked({ kind: 'error', message: 'Fix failed to send. Try again.' });
        }
        const start = payload.agentStart;
        if (start?.status === 'blocked') {
          noStart();
          return setLatexFixBlocked(
            start.reason === 'signin_required' || start.reason === 'credentials_missing'
              ? { kind: 'signin', message: 'Sign in to let the agent fix this.' }
              : start.reason === 'out_of_credits'
                ? { kind: 'signin', message: 'Out of free agent runs. Sign in to keep fixing.' }
                : { kind: 'error', message: 'The agent could not start. Try again.' },
          );
        }
        if (start && (start.ok === false || start.status === 'error')) {
          noStart();
          return setLatexFixBlocked({ kind: 'error', message: 'The agent could not start. Try again.' });
        }
        latexFixSuppressStartingRef.current = null; // a real run is coming
        latexFixStartedRef.current();
        // Hold busy until the run's liveness signal lands. A rescued turn
        // (deploy checkpoint: the sweep answers it later, under a fresh
        // stream) gets a much longer leash — re-arming early would let the
        // next click cancel-and-replace the repair still owed.
        setLatexFixGraceUntil(Date.now() + (start?.rescued ? 90_000 : 8_000));
      } catch {
        clearLatexFixSeed();
        setLatexFixBlocked({ kind: 'error', message: 'Fix failed to send. Try again.' });
      } finally {
        setFixInFlight(false);
      }
    })();
  }, [activeWorkspaceFile, latexRootPath, latexCompile.errorLines, latexCompile.logText, readEditorText, ensureLatexFixChatId, apiFetch, clearLatexFixSeed, localConfig, chatThreadsForCurrentProject]);
  const canLatexFix = canWrite;
  const handleGuidedLatexFix = useCallback(() => {
    if (showOnboardingTexGuide) {
      markOnboardingLandingDone();
      setShowOnboardingTexGuide(false);
      track('onboarding_tex_guide_completed', { projectId });
    }
    handleLatexFix();
  }, [handleLatexFix, projectId, showOnboardingTexGuide]);
  const {
    autoFix: latexAutoFix,
    toggleAutoFix: toggleLatexAutoFix,
    fixAttention: latexFixAttention,
    suggestAutoFix: latexSuggestAutoFix,
    resolveAutoFixSuggestion: resolveLatexAutoFixSuggestion,
    noteFixRequested: noteLatexFixRequested,
  } = useLatexAutoFix({
    compileError: latexCompile.compileError,
    errorLines: latexCompile.errorLines,
    compiling: latexCompile.compiling,
    canFix: canLatexFix && !latexFixBusy,
    onFix: handleLatexFix,
    texPath: activeTexFile ? latexRootPath : null,
    fixBusy: latexFixBusy,
    localEdits: latexLocalEditsRef.current,
  });
  const {
    onFixClicked: trackLatexFixClicked,
    onFixStarted: trackLatexFixStarted,
    onAutoFixSuggestionOutcome: trackLatexAutoFixSuggestion,
  } = useLatexAnalytics({
    projectId,
    texPath: activeTexFile ? latexRootPath : null,
    texFileCount: texFileSignature ? texFileSignature.split('|').length : 0,
    workspaceCreatedAt: projectCreatedAt,
    compileError: latexCompile.compileError,
    compiling: latexCompile.compiling,
    canFix: canLatexFix,
    autoFix: latexAutoFix,
    autoFixSuggested: latexSuggestAutoFix,
  });
  latexFixClickedRef.current = () => trackLatexFixClicked(latexAutoFix);
  latexFixStartedRef.current = () => {
    trackLatexFixStarted(latexAutoFix);
    // Arms the one-time "enable auto-fix?" offer for when this run goes green.
    // Bound to the run's acceptance boundary, not the click: a failed send
    // followed by a manual green must not claim "Fixed."
    noteLatexFixRequested();
  };
  const handleLatexAutoFixSuggestion = useCallback(
    (accepted: boolean) => {
      resolveLatexAutoFixSuggestion(accepted);
      trackLatexAutoFixSuggestion(accepted);
    },
    [resolveLatexAutoFixSuggestion, trackLatexAutoFixSuggestion],
  );
  // A blocked Fix's Sign in CTA (status popover). Comes back to this workspace
  // after Clerk, like every other in-workspace sign-in entry.
  const handleLatexFixSignIn = useCallback(() => {
    setLatexFixBlocked(null);
    openSignIn({ redirectUrl: buildReturnPath({}) });
  }, [openSignIn]);
  // One prop block for every seat of the compile cluster (mobile toolbar,
  // Source-view toolbar, PDF pane header) — spelled once so the three can't
  // drift. Compile-permission mirrors the route's canCreatePath: folder edit
  // grants compile, exact-file grants don't (the button would only ever 403).
  const canCompileLatex = canCreateWorkspacePath(latexRootPath);
  const latexCompileProps = {
    viewMode: latexViewMode,
    onViewModeChange: handleLatexViewModeChange,
    // Panel layout: the bottom surface switcher owns Source/PDF; the
    // toolbar's own Source/Split/PDF group would be a second navigation.
    hideViewSwitch: panelViewActive,
    compile: latexCompile,
    canCompile: canCompileLatex,
    // The blocked chip names the reason the button is disabled; signed-out
    // visitors also get the sign-in CTA (signing in is what unblocks them —
    // for a signed-in read-only collaborator it wouldn't, so no CTA).
    compileBlockedLabel: canCompileLatex ? null : isClerkSignedIn ? 'Read-only access' : 'Sign in to compile',
    onCompileBlockedClick: !canCompileLatex && !isClerkSignedIn ? handleLatexFixSignIn : undefined,
    mainDocument: latexMainDocument,
    onFix: handleGuidedLatexFix,
    canFix: canLatexFix,
    fixInFlight: latexFixBusy,
    fixAttention: latexFixAttention,
    onboardingHint:
      showOnboardingTexGuide && onboardingTexIntent && latexRootPath === WELCOME_TEX_PATH,
    onDismissOnboardingHint: dismissOnboardingTexGuide,
    fixBlocked: latexFixBlocked,
    onSignInForFix: handleLatexFixSignIn,
    onNavigateToLine: handleLatexNavigate,
  };

  // Cmd/Ctrl+Enter inside the LaTeX editor asks Sunny to fix the current compile
  // errors (§1.5). Scoped to the Monaco DOM so it never steals the chat box's
  // own Cmd+Enter send.
  useEffect(() => {
    if (!activeTexFile || !canLatexFix) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
      if (!latexCompile.compileError) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.monaco-editor')) return;
      event.preventDefault();
      handleGuidedLatexFix();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeTexFile, canLatexFix, latexCompile.compileError, handleGuidedLatexFix]);

  const handleInterruptLoop = useCallback(() => {
    void handleInterruptChat();
  }, [handleInterruptChat]);

  // beginDraft gates per target folder (path-share editors create inside
  // their granted subtree without workspace-wide canWrite).
  const handleCreateFile = useCallback(() => {
    beginDraft('text');
  }, [beginDraft]);

  const handleCreateFolder = useCallback(() => {
    beginDraft('folder');
  }, [beginDraft]);

  // ⌘T — Obsidian-style: a real "New tab" tab whose body asks what to put in
  // it (create / open / chat / connect). The tab is transient — whatever opens
  // next in its pane consumes it in place (openTab/replaceActiveTab).
  const openLauncherTab = useCallback(() => {
    const panes = editorPanesRef.current;
    const paneId = panes.find((p) => p.id === lastFocusedPaneIdRef.current)?.id ?? PRIMARY_PANE_ID;
    lastFocusedPaneIdRef.current = paneId;
    setEditorPanes((prev) => openPaneTab(prev, paneId, LAUNCHER_TAB));
  }, []);

  // Command-palette actions: only commands the page already exposes elsewhere,
  // each reusing that surface's handler (and its gating).
  const paletteActions = useMemo<CommandPaletteAction[]>(() => {
    const actions: CommandPaletteAction[] = [];
    if (canWrite) {
      actions.push({
        id: 'new-file',
        label: 'New file',
        keywords: 'create document',
        // ⌘N only ever fires in the desktop shell (browsers reserve it), so
        // the hint would be a lie on the web. The tree's draft input: name
        // and place the file before it exists. (⌘T's create-straight-away
        // path lives on the New-tab panel now.)
        shortcut: desktopTabs ? formatShortcut('Mod+N', macShortcuts) : undefined,
        run: () => {
          setOpenLeftRail('project');
          setSidebarSections((prev) => expandSection(prev, 'files'));
          handleCreateFile();
        },
      });
      actions.push({
        id: 'new-folder',
        label: 'New folder',
        keywords: 'create directory',
        run: () => {
          setOpenLeftRail('project');
          setSidebarSections((prev) => expandSection(prev, 'files'));
          handleCreateFolder();
        },
      });
      actions.push({
        id: 'new-chat',
        label: 'New chat',
        keywords: 'sunny conversation',
        shortcut: formatShortcut('Mod+Shift+J', macShortcuts),
        run: () => {
          openCenterPanel('chat');
          void startAssistantChat(null, null, { forceNew: true, keepMode: true });
        },
      });
      // The rail's New-chat surfaces no longer host this (sidepanel 0.1) —
      // the ⌘T chooser is its home now, same gating the rail entry had.
      if (!isLocalWorkspace) {
        actions.push({
          id: 'connect-local-agent',
          label: 'Connect local agent',
          keywords: 'claude code codex bridge attach',
          run: () => void openLocalAgentModal(),
        });
      }
    }
    if (!isMobile) {
      actions.push({
        id: 'toggle-sidebar',
        label: 'Toggle sidebar',
        keywords: 'left panel files',
        run: toggleSidebar,
      });
      actions.push({
        id: 'toggle-history',
        label: rightDockView === 'history' ? 'Close history' : 'Open history',
        keywords: 'review dock edits versions timeline',
        run: () => (rightDockView === 'history' ? closeRightDock() : openRightDock('history')),
      });
      actions.push({
        id: 'keyboard-shortcuts',
        label: 'Keyboard shortcuts',
        keywords: 'keys hotkeys bindings help',
        run: () => openSettingsTab('shortcuts'),
      });
    }
    if (canWrite && activeWorkspaceFile && !documentReadOnly && docEditModes.includes('suggest')) {
      actions.push({
        id: 'toggle-edit-mode',
        label: effectiveDocEditMode === 'suggest' ? 'Switch to Edit' : 'Switch to Suggest',
        keywords: 'edit suggest mode',
        run: () => setDocumentEditMode(effectiveDocEditMode === 'suggest' ? 'edit' : 'suggest'),
      });
    }
    if (projectId) {
      actions.push({
        id: 'download-zip',
        label: 'Download workspace as zip',
        keywords: 'export archive',
        run: downloadWorkspaceZip,
      });
    }
    return actions;
  }, [
    activeWorkspaceFile,
    canWrite,
    closeRightDock,
    createFileAndOpen,
    docEditModes,
    documentReadOnly,
    downloadWorkspaceZip,
    effectiveDocEditMode,
    desktopTabs,
    handleCreateFile,
    handleCreateFolder,
    isLocalWorkspace,
    isMobile,
    macShortcuts,
    openCenterPanel,
    openLocalAgentModal,
    openRightDock,
    openPaneTabBesideChat,
    openSettingsTab,
    projectId,
    rightDockView,
    setDocumentEditMode,
    startAssistantChat,
    toggleSidebar,
  ]);

  // Open / recently used files surface first in the palette's empty state:
  // the selected file, then every open editor-pane tab.
  const paletteOpenFiles = useMemo(() => {
    const paths = editorPanes.flatMap((pane) => pane.tabs.filter((tab) => !isSpecialTab(tab)));
    return selectedFilePath ? [selectedFilePath, ...paths] : paths;
  }, [editorPanes, selectedFilePath]);

  // Palette chats: rail order, rail display titles ("New chat" placeholder for
  // untitled). rankChats drops the archived ones — those live in Settings.
  const paletteChats = useMemo(
    () =>
      chatEntries.map((entry) => ({
        id: entry.chat.id,
        title: usesGroupChatPresentation(entry.chat.chat_kind, entry.chat)
          ? buildGroupChatDisplayName(entry.chat)
          : entry.chat.title?.trim() || 'New chat',
        archived: entry.isArchived,
      })),
    [chatEntries],
  );

  // Desktop shell only: browsers reserve ⌘N/⌘T for new windows/tabs, so
  // binding them there could never fire.
  //   ⌘N → create a document and open it in the editor (VS Code).
  //   ⌘T → an empty tab that asks what to open (Obsidian).
  // Gated on desktopTabs, not isDesktopApp: the latter is the macOS
  // traffic-light signal, so binding on it left a Windows desktop user
  // without ⌘N/⌘T for no reason.
  useEffect(() => {
    if (!desktopTabs) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        // Pressed while a chooser tab is focused, the create fills THAT pane
        // (same targeting as ⌘O) — the bare call would use the primary
        // selection's context and strand a secondary pane's New tab.
        event.preventDefault();
        const panes = editorPanesRef.current;
        const pane = panes.find((p) => p.id === lastFocusedPaneIdRef.current) ?? panes[0];
        void createFileAndOpen(pane && isLauncherTab(pane.active) ? pane.id : undefined);
      } else if (key === 't') {
        event.preventDefault();
        openLauncherTab();
      } else if (key === 'o') {
        // ⌘O — "Open file": the palette's file search (the New-tab panel
        // advertises this shortcut, so it must exist as a binding too).
        // Pressed while a chooser tab is focused, the pick fills that pane.
        event.preventDefault();
        const panes = editorPanesRef.current;
        const pane = panes.find((p) => p.id === lastFocusedPaneIdRef.current) ?? panes[0];
        setPaletteTargetPaneId(pane && isLauncherTab(pane.active) ? pane.id : null);
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [desktopTabs, createFileAndOpen, openLauncherTab]);

  const movePath = useCallback(async (sourcePath: string, targetPath: string, { skipReload = false } = {}) => {
    // Per-path: a path-share editor may move within the granted subtree —
    // both ends must be writable (mirrors the server's check).
    if (!canWriteWorkspacePath(sourcePath) || !canWriteWorkspacePath(targetPath)) return;
    if (!projectId) return;
    if (!sourcePath || !targetPath) return;
    if (sourcePath === targetPath) return;
    if (existingPaths.has(targetPath)) return;

    const sourceFile = workspaceFileByPath.get(sourcePath);
    const hasChildren = workspaceFiles.some((file) => file.path.startsWith(`${sourcePath}/`));
    if (!sourceFile && !hasChildren) return;

    const sourceType = sourceFile?.type ?? (hasChildren ? 'folder' : 'text');
    if (sourceType === 'folder' && targetPath.startsWith(`${sourcePath}/`)) return;
    if (
      sourceType === 'folder' &&
      workspaceFiles.some((file) => file.path === targetPath || file.path.startsWith(`${targetPath}/`))
    ) {
      return;
    }

    // Exact path or descendant — a bare prefix match would also catch
    // sibling paths like `${sourcePath}-old`.
    const within = (path: string, base: string) => path === base || path.startsWith(`${base}/`);
    // Exactly what the optimistic move touched, so rollback restores only
    // that — an inverse prefix remap could also catch pre-existing rows
    // already under targetPath (file moved onto an implicit-folder prefix).
    const movedIds = new Set<string>();
    const movedFolders = new Map<string, string>(); // remapped name -> original
    const applyLocalMove = () => {
      // Also keeps activeWorkspaceFile from going null between the
      // selectedFilePath change and the reloadFiles completion.
      mutateWorkspaceFiles((prev) =>
        prev.map((file) => {
          if (within(file.path, sourcePath)) {
            movedIds.add(file.id);
            return { ...file, path: `${targetPath}${file.path.slice(sourcePath.length)}` };
          }
          return file;
        }),
      );
      if (selectedFilePath && within(selectedFilePath, sourcePath)) {
        setSelectedFilePath(`${targetPath}${selectedFilePath.slice(sourcePath.length)}`);
      }
      setEditorPanes((prev) => remapPanePaths(prev, sourcePath, targetPath));
      setExpandedFolders((prev) => {
        const next = new Set<string>();
        prev.forEach((folder) => {
          if (within(folder, sourcePath)) {
            const to = `${targetPath}${folder.slice(sourcePath.length)}`;
            movedFolders.set(to, folder);
            next.add(to);
          } else {
            next.add(folder);
          }
        });
        return next;
      });
    };

    // Optimistic: reflect the move before the PATCH so the drop feels instant
    // (the round-trip takes 1-2s on Vercel); a failure rolls back below. When
    // the move carries the OPEN file, the collab room must NOT follow yet —
    // rooms are keyed by path and the server rename hasn't committed —
    // so record the remap and keep the editor bound to the old path
    // (activeCollabPath) until the PATCH succeeds.
    const movedSelection =
      selectedFilePath && within(selectedFilePath, sourcePath)
        ? { from: selectedFilePath, to: `${targetPath}${selectedFilePath.slice(sourcePath.length)}` }
        : null;
    // One open-file move at a time: a chained drag before the first PATCH
    // settles would point pendingOpenFileMove's `from` at a path the server
    // doesn't have yet, rebinding the editor to a not-yet-existing room.
    if (movedSelection && pendingOpenFileMove) return;
    // A rename that changes the extension changes the editor SURFACE
    // (markdown/code/latex/viewer) — rendering the new surface against the old
    // room's doc shape is worse than the wait, so only such renames stay
    // await-first. Moves keep the filename, so drops are always optimistic.
    const ext = (path: string) => path.slice(path.lastIndexOf('/') + 1).split('.').slice(1).join('.');
    // Same rule for files open as ANY pane tab (inactive primary tabs
    // included): an extension change swaps that tab's editor surface on
    // activation, so the remap must wait for the commit too.
    const paneOpenAffected = editorPanes.some((p) =>
      p.tabs.some((tab) => within(tab, sourcePath)),
    );
    const awaitFirst = Boolean(
      (movedSelection && ext(movedSelection.from) !== ext(movedSelection.to)) ||
        (paneOpenAffected && ext(sourcePath) !== ext(targetPath)),
    );
    // Resolves with the path that survives the move: `to` on commit, `from`
    // on rollback. Chat sends in the window await this before freezing a path.
    let settleMove: (finalPath: string) => void = () => {};
    if (movedSelection) {
      openFileMoveRef.current = {
        current: awaitFirst ? movedSelection.from : movedSelection.to,
        settled: new Promise<string>((resolve) => { settleMove = resolve; }),
      };
    }
    if (!awaitFirst) {
      if (movedSelection) setPendingOpenFileMove(movedSelection);
      setPendingPaneMoves((prev) => [...prev, { from: sourcePath, to: targetPath }]);
      applyLocalMove();
    }

    let ok = false;
    let failure: string | null = null;
    let linkUpdates: { files: number; links: number } | null = null;
    try {
      const res = await apiFetch('/api/workspace/files', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, sourcePath, targetPath }),
      });
      ok = res.ok;
      if (!res.ok) {
        failure = ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? null;
      }
      if (res.ok) {
        // Obsidian-style rename link maintenance: the server rewrote inbound
        // [[wikilinks]] — surface how many, like Obsidian's notice.
        const data = (await res.json().catch(() => null)) as
          | { linkUpdates?: { files?: number; links?: number } }
          | null;
        const updated = data?.linkUpdates;
        if (updated && Number(updated.links) > 0) {
          linkUpdates = { files: Number(updated.files ?? 0), links: Number(updated.links) };
        }
      }
    } catch {
      // network failure — treated as not ok below
    }
    if (!ok) {
      // A rejected rename/move rolls back to a tree that looks untouched, so
      // without this the refusal reads as "nothing happened" (the local disk
      // refuses a target differing only in case from another file).
      if (failure) showWorkspaceAppNotice('error', failure);
      if (movedSelection) {
        settleMove(movedSelection.from);
        openFileMoveRef.current = null;
      }
      if (awaitFirst) return; // nothing was applied yet
      // Roll the optimistic state back locally — the reload is only
      // best-effort reconciliation (on a dead network it fails too, and a
      // non-ok reload leaves the list untouched).
      mutateWorkspaceFiles((prev) =>
        prev.map((file) =>
          movedIds.has(file.id) && within(file.path, targetPath)
            ? { ...file, path: `${sourcePath}${file.path.slice(targetPath.length)}` }
            : file,
        ),
      );
      setExpandedFolders((prev) => {
        const next = new Set<string>();
        prev.forEach((folder) => next.add(movedFolders.get(folder) ?? folder));
        return next;
      });
      if (movedSelection) {
        setSelectedFilePath((current) => (current === movedSelection.to ? movedSelection.from : current));
        setPendingOpenFileMove(null);
      }
      setEditorPanes((prev) => remapPanePaths(prev, targetPath, sourcePath));
      setPendingPaneMoves((prev) =>
        prev.filter((m) => m.from !== sourcePath || m.to !== targetPath),
      );
      await reloadFiles(false).catch(() => {});
      return;
    }
    if (awaitFirst) {
      applyLocalMove(); // surface-changing rename: apply only once committed
    } else {
      // Rename committed server-side — the editors may now bind the new path.
      // A stale background reload may have restored the old paths mid-flight,
      // so re-apply the local move (a no-op otherwise) before dropping the
      // fallbacks, or the open file — selection or a split-pane tab — would
      // go null until the next reload.
      applyLocalMove();
      if (movedSelection) setPendingOpenFileMove(null);
    }
    if (movedSelection) {
      settleMove(movedSelection.to);
      openFileMoveRef.current = null;
    }
    // Rename committed — secondary panes may bind the new room path now.
    setPendingPaneMoves((prev) =>
      prev.filter((m) => m.from !== sourcePath || m.to !== targetPath),
    );
    if (linkUpdates) {
      const links = `${linkUpdates.links} link${linkUpdates.links === 1 ? '' : 's'}`;
      const files = `${linkUpdates.files} file${linkUpdates.files === 1 ? '' : 's'}`;
      showWorkspaceAppNotice('success', `Updated ${links} in ${files}`);
    }

    if (!skipReload) {
      await reloadFiles(false);
      filesChannelRef.current?.postMessage({ type: 'refresh' });
      // Renaming a synced mount re-keys its imported_path server-side; refetch
      // the linked-repo list so the badge follows the folder instead of clinging
      // to the now-gone old path.
      setLinkedReposRefreshKey((k) => k + 1);
    }
  }, [canWriteWorkspacePath, editorPanes, existingPaths, pendingOpenFileMove, projectId, reloadFiles, selectedFilePath, showWorkspaceAppNotice, workspaceFileByPath, workspaceFiles]);

  const moveItem = useCallback(async (sourcePath: string, targetFolder: string | null, { skipReload = false } = {}) => {
    if (!sourcePath) return;
    const name = getFileName(sourcePath);
    const targetPath = targetFolder ? `${targetFolder}/${name}` : name;
    await movePath(sourcePath, targetPath, { skipReload });
  }, [movePath]);

  const handleFileDragStart = useCallback((event: DragEvent<HTMLDivElement>, filePath: string) => {
    if (!canWriteWorkspacePath(filePath)) return;
    const selection =
      selectedPaths.size > 0 && selectedPaths.has(filePath)
        ? Array.from(selectedPaths)
        : [filePath];
    if (!selectedPaths.has(filePath)) {
      setSelectedPaths(new Set([filePath]));
    }
    event.dataTransfer.setData('application/json', JSON.stringify(selection));
    event.dataTransfer.setData('text/plain', filePath);
    // Rail→pane drag: the same drag can drop on a tab strip / pane edge to
    // open (or split) the file there — the pure helpers treat the 'rail'
    // source as insert-only (no source pane to remove from).
    event.dataTransfer.setData(
      EDITOR_TAB_MIME,
      JSON.stringify({ paneId: RAIL_PANE_ID, path: filePath } satisfies TabDragPayload),
    );
    event.dataTransfer.effectAllowed = 'move';
    setSidebarDragGhost(event, selection.length > 1 ? `${selection.length} files` : getFileName(filePath));
    if (!isMobile) {
      handleTabDragChange(true);
      // The tree rows have no page-level dragend hook — disarm from the row.
      event.currentTarget.addEventListener('dragend', () => handleTabDragChange(false), { once: true });
    }
  }, [canWriteWorkspacePath, handleTabDragChange, isMobile, selectedPaths]);

  const handleDrop = useCallback(async (event: DragEvent<HTMLDivElement>, targetFolder: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    setIsFilesDropActive(false);
    // Entries MUST be snapshotted before the first await — they go stale once
    // the drop handler yields, which is what surfaced the raw NotFoundError.
    const entries = dropEntriesFrom(event.dataTransfer);
    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    if (entries || droppedFiles.length > 0) {
      // Per-target: path-share editors may upload into their granted subtree.
      if (!canUploadToFolder(targetFolder)) return;
      setDragOverPath(null);
      if (entries) {
        const { files, truncated } = await readDroppedEntries(entries);
        if (files.length > 0) queueUploads(files, 'files', targetFolder);
        else reportUploadError(entries[0].name, 'Nothing to upload in there.');
        if (truncated) {
          reportUploadError(entries[0].name, `Only the first ${MAX_ZIP_ENTRY_COUNT.toLocaleString()} files were queued.`);
        }
        return;
      }
      queueUploads(droppedFiles, 'files', targetFolder);
      return;
    }
    if (!canWrite && pathGrants.length === 0) return;
    const listData = event.dataTransfer.getData('application/json');
    const sourcePath = event.dataTransfer.getData('text/plain');
    setDragOverPath(null);
    let paths: string[] = [];
    if (listData) {
      try {
        const parsed = JSON.parse(listData);
        if (Array.isArray(parsed)) {
          paths = parsed.filter((item) => typeof item === 'string');
        }
      } catch {
        // ignore invalid payload
      }
    }
    if (!paths.length && sourcePath) {
      paths = [sourcePath];
    }
    if (paths.length === 0) return;
    // Drop entries whose ancestor is also selected — the ancestor's move
    // carries them, and racing a child move against its parent's can strand it.
    const roots = paths.filter(
      (path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)),
    );
    // Fire all moves at once: each applies its optimistic update synchronously
    // (the whole selection snaps into place in one frame), PATCHes run
    // concurrently, and the single reload below reconciles.
    await Promise.all(roots.map((path) => moveItem(path, targetFolder, { skipReload: true })));
    // Single reload + refresh after all moves complete
    await reloadFiles(false);
    filesChannelRef.current?.postMessage({ type: 'refresh' });
    // A dragged synced mount has its imported_path re-keyed server-side — refetch
    // linked repos so the badge follows it (movePath does this for direct moves,
    // but DnD passes skipReload so the per-move bump is skipped).
    setLinkedReposRefreshKey((k) => k + 1);
    // Clear multi-selection after move
    setSelectedPaths(new Set());
  }, [canWrite, canUploadToFolder, pathGrants.length, moveItem, queueUploads, reloadFiles, reportUploadError]);
  const queueFileUploadsToFolder = useCallback((files: File[], targetFolder: string | null) => {
    queueUploads(files, 'files', targetFolder);
  }, [queueUploads]);

  // Rail clicks carry side semantics (files-left/chats-right): with only a
  // file open the chat splits to its right; with a chat already displayed the
  // click replaces that chat; a sole chat pane replaces in place.
  const selectChat = (index: number, { focusComposer = false }: { focusComposer?: boolean } = {}) => {
    const chatId = chatThreadsForCurrentProject[index]?.chat.id;
    if (!chatId) return;
    // A rail-opened chat lands NARROW like the comment lane's "Open chat" —
    // an even split collapses the document. Armed with the pre-open pane key,
    // so a reused (possibly resized) pane keeps its width.
    if (!isMobile) narrowChatPaneArmedRef.current = editorPanesRef.current.map((pane) => pane.id).join('|');
    activateDirectChat(chatId, { index, focusComposer, sidePanel: true });
  };

  const openChatById = useCallback(
    async (
      chatId: string,
      { sidePanel = false, appendTab = false }: { sidePanel?: boolean; appendTab?: boolean } = {},
    ) => {
      const selectFromThreads = (threads: ChatThread[]) => {
        // `chatId` may be a short id-prefix ref from a shared link; activate
        // with the resolved full id (see findIndexByIdRef).
        const targetIndex = findIndexByIdRef(threads, chatId, (entry) => entry.chat.id);
        if (targetIndex < 0) return null;
        const target = threads[targetIndex];
        activateDirectChat(target.chat.id, {
          index: targetIndex,
          focusComposer: true,
          sidePanel,
          appendTab,
        });
        return target.chat.id;
      };

      // Resolve against the current project's threads only — the raw cache
      // can briefly hold the previous workspace's threads, and a prefix ref
      // must never match across projects.
      const existingChatId = selectFromThreads(chatThreadsForCurrentProject);
      if (existingChatId) return existingChatId;
      const refreshedThreads = await loadChatThreads();
      return selectFromThreads(refreshedThreads);
    },
    [activateDirectChat, chatThreadsForCurrentProject, loadChatThreads]
  );
  openChatByIdRef.current = openChatById;

  // Legacy stored layouts carried chat in `openPanels` with no chat tab in the
  // pane snapshot — reveal the restored chat as a tab exactly once. (Also a
  // harmless no-op right after fresh-arrival drafts open their own tab.)
  const initialChatRevealRef = useRef<string | null>(null);
  useEffect(() => {
    if (isMobile || initialChatRevealRef.current === projectId || !currentChatId) return;
    if (!openPanels.includes('chat')) return;
    // A non-owner whose plain chat-first arrival was just swapped to the
    // document (effect above — same commit, so this closure still sees the
    // pre-swap openPanels) must not get the chat re-revealed over it.
    // Explicit chat intents (deep links, restored layouts) reveal as usual.
    if (arrivalSwappedToDocRef.current) return;
    // Run only after the snapshot restore (same-commit ordering: the restore
    // effect is declared earlier, so the filesLoaded dep re-fires this after
    // it) — a restored layout gets to veto the legacy migration below.
    if (editorPanesRestoredRef.current !== projectId) return;
    initialChatRevealRef.current = projectId;
    // A deep-linked doc owns the primary pane: a shared file+chat link (or a
    // stale stored chat intent) docks the chat BESIDE it, never over it.
    // Gated on the RESOLVED file — a stale file param with a valid chat must
    // land full-width chat, not an empty primary plus side chat.
    if (deepLinkedWorkspaceFile) {
      const tab = chatTab(currentChatId);
      setEditorPanes((prev) => {
        const holder = prev.find((pane) => pane.tabs.includes(tab));
        if (holder?.active === tab) return prev;
        const next = openPaneToSide(prev, tab);
        const pane = next.find((p) => p.tabs.includes(tab));
        return pane ? enforceSingleActiveChat(next, pane.id) : next;
      });
      return;
    }
    // A restored snapshot with content already encodes its chat tabs — a
    // stale legacy 'chat' intent must not replace a restored file tab.
    if (restoredSnapshotHadTabsRef.current) return;
    // Legacy editor+chat layouts (pre-tabs open-set, no pane snapshot yet):
    // keep the mirrored file primary and dock the chat beside it. A chat-only
    // arrival (open-set ['chat']) still lands full-width via side's fallback.
    openChatTabInPanes(currentChatId, { side: openPanels.includes('editor') });
  }, [canWrite, currentChatId, deepLinkedWorkspaceFile, filesLoaded, isMobile, openChatTabInPanes, openPanels, projectId]);

  // Restored pane snapshots can hold chat tabs whose chats are gone (deleted
  // chats, dead drafts from an old session): prune them once this project's
  // chat list is authoritative. Live drafts stay — they're in the list.
  useEffect(() => {
    if (!chatsLoaded || chatsProjectId !== projectId) return;
    const known = new Set(chatThreadsForCurrentProject.map((t) => t.chat.id));
    // Ref-snapshot pattern (applyPaneTransition): compute outside the updater
    // so the selection hand-off below can follow the pruned result.
    const prev = editorPanesRef.current;
    let changed = false;
    const next = prev.map((pane) => {
      const tabs = pane.tabs.filter((t) => {
        const id = chatIdOfTab(t);
        return id === null || known.has(id);
      });
      if (tabs.length === pane.tabs.length) return pane;
      changed = true;
      const active = tabs.includes(pane.active) ? pane.active : tabs[tabs.length - 1] ?? '';
      return { ...pane, tabs, active };
    });
    if (!changed) return;
    let result = pruneEmptyPanes(next);
    // Pruning the ACTIVE chat of a chat-ONLY snapshot must not leave a
    // blank surface the reveal effect already vetoed on — fall back to the
    // current live chat. A surviving file tab keeps the layout instead.
    // Desktop only (mobile has no tab UI).
    if (
      !isMobileRef.current &&
      prev.some((p) => isChatTab(p.active)) &&
      !result.some((p) => p.tabs.length > 0)
    ) {
      const cur = currentChatIdRef.current;
      if (cur && known.has(cur)) {
        const tab = chatTab(cur);
        result = enforceSingleActiveChat(replaceActiveTab(result, result[0].id, tab), result[0].id);
      }
    }
    setEditorPanes(result);
    // Pruning can change panes[0].active with no user action (the chat fell
    // back to a file tab, or a secondary promoted into the emptied primary):
    // keep the selection in sync — applyPaneTransition's rule — or the
    // editor body renders blank under a tab strip showing the file. Desktop
    // only: mobile doesn't mirror its selection into the panes.
    if (isMobileRef.current) return;
    const active = result[0].active;
    setSelectedFilePath((sel) =>
      sel && result.some((p) => p.tabs.includes(sel)) ? sel : isSpecialTab(active) ? '' : active,
    );
  }, [chatsLoaded, chatsProjectId, projectId, chatThreadsForCurrentProject]);

  // SPA back-nav (2026-06-05 feedback): restore the in-workspace view on browser
  // back/forward. The mirror effect pushes a history entry per genuine
  // navigation; here we read the file+chat back out of the URL and re-apply them
  // through the normal handlers. `restoringViewFromPopstateRef` forces the mirror
  // to replace (never push) until state catches up, so the forward stack is
  // preserved. Only same-pathname entries are ours: our writes only ever change
  // the query, so a pathname change means the entry leaves this workspace (the
  // dashboard, or another project) — a real route change we leave to Next. Match
  // the live pathname rather than a `/w/` prefix: `app/local/[projectId]` renders
  // this very page, and an in-place workspace switch keeps it mounted. Files and
  // pathname change often — read them via refs so this listener subscribes once.
  // Track the DOM pathname, not usePathname(): the static desktop export
  // serves one placeholder route for every /local/<id>, so the router's
  // pathname reports the shell path there and would reject every entry.
  const pathname = usePathname();
  const workspacePathnameRef = useRef(pathname);
  workspacePathnameRef.current = typeof window === 'undefined' ? pathname : window.location.pathname;
  const workspaceFilesRef = useRef(workspaceFiles);
  workspaceFilesRef.current = workspaceFiles;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => {
      if (window.location.pathname !== workspacePathnameRef.current) return;
      restoringViewFromPopstateRef.current = true;
      const params = new URLSearchParams(window.location.search);
      const fileRef = params.get('fileId')?.trim() || null;
      const filePathRef = params.get('filePath')?.trim() || null;
      const chatRef = params.get('chatId')?.trim() || null;
      const file =
        (fileRef ? findShareableWorkspaceFile(workspaceFilesRef.current, fileRef) : null) ??
        (filePathRef ? findShareableWorkspaceFileByPath(workspaceFilesRef.current, filePathRef) : null);
      const fileSurfaceVisible =
        openPanelsRef.current.includes('editor') || openPanelsRef.current.includes('review');
      const staleFileTarget = Boolean((fileRef || filePathRef) && !file);
      const currentChatRef = currentChatIdRef.current;
      const chatAction = resolvePopstateChatAction({
        urlChatRef: chatRef,
        currentChatShortRef: currentChatRef ? toShortIdRef(currentChatRef) : null,
        isChatVisible: isChatVisibleRef.current,
      });
      restoringViewTargetRef.current = resolveWorkspaceRestoreTargetForLayout(
        {
          fileRef: file
            ? toShortIdRef(file.id)
            : (fileRef || filePathRef) && fileSurfaceVisible && activeFileIdRef.current
              ? toShortIdRef(activeFileIdRef.current)
              : null,
          chatRef: chatRef ? toShortIdRef(chatRef) : null,
        },
        isMobile,
        chatAction === 'reopen' || (chatAction === 'skip' && Boolean(chatRef) && !file && !fileSurfaceVisible),
      );
      let restorePending = false;
      if (staleFileTarget) {
        // A deleted/renamed file cannot trigger a selection render. Normalize
        // this history entry immediately to the still-visible file (or none)
        // so the restore guard cannot remain armed forever.
        const normalized = new URL(window.location.href);
        normalized.searchParams.delete('filePath');
        if (restoringViewTargetRef.current.fileRef) {
          normalized.searchParams.set('fileId', restoringViewTargetRef.current.fileRef);
        } else {
          normalized.searchParams.delete('fileId');
        }
        window.history.replaceState(
          window.history.state,
          '',
          `${normalized.pathname}${normalized.search}${normalized.hash}`,
        );
      }
      if (file) {
        restorePending = activeFileIdRef.current !== file.id || !fileSurfaceVisible;
        setSelectedFilePath(file.path);
        // fileId is visibility-gated: its presence means a file surface was
        // open in this history entry. Restore one when the current entry had
        // neither editor nor review visible.
        if (!fileSurfaceVisible) openCenterPanel('editor');
      } else if (!fileRef && !filePathRef && fileSurfaceVisible) {
        restorePending = true;
        // Likewise, no file ref means the restored entry was chat/empty-only.
        setOpenPanels((prev) => removePanel(removePanel(prev, 'editor'), 'review'));
      }
      if (chatAction === 'reopen') {
        restorePending = true;
        const requestedChatRef = toShortIdRef(chatRef!);
        void openChatById(chatRef!).then((openedChatId) => {
          // A stale history entry must not leave future navigations in replace
          // mode forever when its chat can no longer be resolved.
          if (restoringViewTargetRef.current?.chatRef !== requestedChatRef) return;
          if (!openedChatId) {
            restoringViewFromPopstateRef.current = false;
            restoringViewTargetRef.current = null;
          } else {
            // Prefix refs from older/shared links may be 6–7 characters. Match
            // the canonical 8-character ref the mirror writes after selection.
            restoringViewTargetRef.current.chatRef = toShortIdRef(openedChatId);
          }
        });
      } else if (chatAction === 'close') {
        restorePending = true;
        closeCenterPanel('chat');
      }
      if (!restorePending) {
        restoringViewFromPopstateRef.current = false;
        restoringViewTargetRef.current = null;
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [closeCenterPanel, isMobile, openCenterPanel, openChatById]);

  useWorkspaceStartupIntents({
    hasMounted,
    projectId,
    chatsLoaded,
    chatsProjectId,
    preferencesLoaded,
    filesLoaded,
    chatThreadsCount: chatThreadsForCurrentProject.length,
    isChatMode,
    chatSurfaceOpen: openPanels.includes('chat'),
    isMobile,
    canWrite,
    deepLinkedFileId,
    deepLinkedFilePath,
    deepLinkedWorkspaceFile,
    selectedDirectChatId,
    didAutoOpenInitialChatRef,
    startBlankChat: () => startAssistantChat(null, null),
    openChatById,
    setWorkspaceViewMode,
    // Stale deep-linked file → chat takes over the whole center (close editor).
    revealChatFullScreen: () => {
      setSelectedCommit(null);
      setOpenPanels(['chat']);
    },
    setSelectedFilePath,
    setMobilePanel,
    setShowMetaFiles,
  });

  // Mirrors the Chats-list "+ New" dropdown (project-sidebar): a compact list,
  // not the avatar/subtitle cards — keep the two menus identical.
  const renderAssistantPickerMenu = () => (
    <div className="absolute left-0 top-full z-50 mt-1.5 w-44 max-w-[calc(100vw-2rem)] rounded-lg border border-stone-200 bg-white py-1 text-xs shadow-lg">
      <button
        type="button"
        onClick={() => void startAssistantChat(null, null, { forceNew: true })}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
      >
        <ChatTeardropIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
        New chat
      </button>
      {!isLocalWorkspace && (
        <button
          type="button"
          onClick={() => {
            closeAssistantPicker();
            void openLocalAgentModal();
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
        >
          <LightningIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
          Connect local agent
        </button>
      )}
    </div>
  );

  const assistantPickerTriggerClassName = assistantPickerCueVisible
    ? 'bg-amber-50 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]'
    : showAssistantPicker
      ? 'bg-stone-50'
      : 'hover:bg-stone-50';

  const renderAssistantCard = (entry: (typeof chatEntries)[number], layout: 'desktop' | 'mobile' = 'desktop') => {
    const { chat, index, isArchived } = entry;
    const isSelected = selectedDirectChatId === chat.id;
    const external = getExternalSession(chat);
    const isGroupChat = getChatKind(chat) === 'group';
    const isTextChat = hasTextTransport(chat);
    const showGroupChatUi = usesGroupChatPresentation(chat.chat_kind, chat);
    const isPinned = isChatPinned(chat);
    // Title leads; the Sunny number lives in the subtitle, so untitled chats
    // read "New chat" rather than repeating "Sunny #n" on both lines.
    const displayName = showGroupChatUi
      ? buildGroupChatDisplayName(chat)
      : chat.title?.trim() || 'New chat';
    const status = chatStatusById[chat.id] ?? 'idle';
    // Folder-focused rail: how this chat relates to the focused folder
    // ('touched' draws the dashed icon; 'here'/'sub' render plain).
    const folderRelation =
      layout === 'desktop' && focusedSidebarFolder
        ? chatFolderRelation(chat, focusedSidebarFolder)
        : null;
    const activityLabel = formatRelativeTimeShort(chat?.last_message_at);
    const activityTitle = chat?.last_message_at ? formatRelativeTime(chat.last_message_at) : 'No activity yet';
    const canArchive = canManageChat(canWrite, chat?.id);
    const canTogglePin = canPinChat(user?.id, chat?.id);
    const canCopyChatLink = Boolean(chat?.id && !isDraftChatId(chat.id));
    const rawPreview = chat?.preview_text?.trim() || '';
    const defaultResponderLabel = 'No default responder';
    const participantCount = showGroupChatUi
      ? Math.max(1, getChatParticipants(chat).length)
      : 1;
    const chatPreview = showGroupChatUi
      ? [
          `Default: ${defaultResponderLabel}`,
          rawPreview || `${formatCountLabel(participantCount, 'participant', 'participants')}`,
        ]
          .filter(Boolean)
          .join(' \u00b7 ')
      : rawPreview ||
        (isTextChat ? 'Text' : chat?.title?.trim() || 'New chat');
    // Direct chats show the agent-written goal summary when present, else
    // "#<sunny number> · <model>" (groups keep their participant/default-
    // responder summary).
    const cardSubtitle = showGroupChatUi
      ? chatPreview
      : external
        ? `${externalAgentLabel(external)} · ran in ${external.cwd}`
        : chat.goal_summary?.trim() ||
        [
          typeof chat.sunny_number === 'number' ? `#${chat.sunny_number}` : 'Sundial Agent',
          chat.model ? getChatModelLabel(chat.model) : null,
        ]
          .filter(Boolean)
          .join(' · ');
    const unreadCount = Math.max(0, Number(chat.unread_count ?? 0));
    const hasUnread = unreadCount > 0;
    const isChatMenuOpen = openChatMenuId === chat.id;
    const chatHoverLink = canCopyChatLink && typeof window !== 'undefined'
      ? `${window.location.origin}${buildWorkspaceChatPath(workspaceRouteId, chat.id)}`
      : '';
    // External sessions get no actions menu: rename/pin/archive/copy-link all
    // assume a real chat row the sidecar owns.
    const chatMenu = external ? null : (
      <div
        className={`relative shrink-0 flex items-center gap-0.5 ${isChatMenuOpen ? 'z-20' : ''}`}
        ref={isChatMenuOpen ? chatMenuRef : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        {chatHoverLink ? (
          <span className="opacity-0 group-hover:opacity-100 transition-opacity">
            <CopyLinkButton url={chatHoverLink} label="Copy chat link" tooltip="Copy chat link" className="h-6 w-6" />
          </span>
        ) : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            // Capture the actual clicked button: the chat rail renders in both
            // desktop and (hidden) mobile layouts, so a shared render-time ref
            // would be claimed by the wrong copy.
            chatMenuTriggerRef.current = event.currentTarget;
            setOpenChatMenuId((prev) => (prev === chat.id ? null : chat.id));
          }}
          aria-label="Chat actions"
          aria-haspopup="menu"
          aria-expanded={isChatMenuOpen}
          className={`relative group/tip flex h-6 w-6 items-center justify-center rounded-full ${
            isChatMenuOpen
              ? 'bg-stone-200 text-stone-600'
              : 'text-stone-400 hover:bg-stone-100 hover:text-stone-600'
          }`}
        >
          <DotsThreeVerticalIcon className="h-4 w-4" weight="bold" aria-hidden />
          <IconTooltip label="Chat actions" open={isChatMenuOpen} />
        </button>
        <AnchoredDropdown
          open={isChatMenuOpen}
          anchorRef={chatMenuTriggerRef}
          align="right"
          className="w-44 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
        >
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setOpenChatMenuId(null);
                setChatDetailsChatId(chat.id);
              }}
              className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
            >
              View details
            </button>
            {/* Every edit this chat ever made, in the review timeline — the
                whole-chat counterpart to a turn's diff. Tabs-only surface. */}
            {isMobile ? null : (
              <button
                type="button"
                data-testid="chat-menu-view-edits"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  handleOpenChatEdits(chat.id);
                }}
                className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                View all edits
              </button>
            )}
            {canArchive && !showGroupChatUi ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  setRenamingChatId(chat.id);
                }}
                className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                Rename
              </button>
            ) : null}
            {/* Text-chat linking is cloud-only (Clerk phone + linq tables) —
                local-backing workspaces are also hidden from iMessage /chats. */}
            {canWrite && !isLocalWorkspace ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  // Linking a row-less draft to mobile is explicit investment —
                  // promote first so the link modal targets a real row (the
                  // transport then guards it against typed-empty cleanup).
                  if (isDraftChatId(chat.id)) {
                    void promoteDraftWithItsSettings(chat.id).then((promoted) => {
                      if (!promoted) return;
                      // Armed so a dismissed modal doesn't leak the empty row
                      // (cleanup or the reload marker sweep takes it back); a
                      // completed link is kept by the transport guard.
                      armTypedEmpty(promoted.chat.id);
                      setLinkTextChatId(promoted.chat.id);
                    });
                    return;
                  }
                  setLinkTextChatId(chat.id);
                }}
                className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                Connect to mobile
              </button>
            ) : null}
            {canCopyChatLink ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  void handleCopyChatLink(chat.id);
                }}
                className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                {copiedChatLinkId === chat.id ? 'Copied link' : 'Copy chat link'}
              </button>
            ) : null}
            {canWrite ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  // Whole-workspace watch; a narrower path is set by the agent.
                  void setCommentWatch(chat.id, chat.comment_watch_path ? null : '*');
                }}
                className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                {chat.comment_watch_path ? 'Stop watching comments' : 'Watch comments'}
              </button>
            ) : null}
            {/* Moved out of the chat header (founder: too loaded) — the
                export pages the OPEN chat's history, so only its row offers it. */}
            {chat?.id && chat.id === currentChatId && sundialChat.messages.length > 0 ? (
              <button
                type="button"
                data-testid="chat-download-transcript"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  void downloadChatTranscript();
                }}
                className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                Download transcript
              </button>
            ) : null}
            {canTogglePin ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  void toggleChatPin(chat.id, !isPinned);
                }}
                className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                {isPinned ? 'Unpin chat' : 'Pin chat'}
              </button>
            ) : null}
            {canArchive ? (
              <>
              <button
                type="button"
                data-testid="chat-menu-archive"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  void toggleChatArchive(chat.id, !isArchived);
                }}
                className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                {isArchived ? 'Unarchive chat' : 'Archive chat'}
              </button>
              <button
                type="button"
                data-testid="chat-menu-delete"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  setChatPendingDelete({ id: chat.id, title: chat.title ?? null });
                }}
                className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
              >
                Delete chat
              </button>
              </>
            ) : null}
        </AnchoredDropdown>
      </div>
    );

    return (
      <div
        key={chat.id}
        data-testid="workspace-chat-card"
        data-chat-id={chat.id}
        title={external ? `${externalAgentLabel(external)} · ran in ${external.cwd}` : undefined}
        role="button"
        tabIndex={0}
        // Rail→pane drag: drop the chat on a tab strip / pane edge to open
        // (or split) it there, same payload contract as strip tab drags.
        // Desktop-shell only — the web shell has no strips or split targets.
        draggable={!isMobile && desktopTabs && renamingChatId !== chat.id}
        onDragStart={(event) => {
          event.dataTransfer.setData(
            EDITOR_TAB_MIME,
            JSON.stringify({ paneId: RAIL_PANE_ID, path: chatTab(chat.id) } satisfies TabDragPayload),
          );
          event.dataTransfer.effectAllowed = 'move';
          handleTabDragChange(true);
        }}
        onDragEnd={() => handleTabDragChange(false)}
        onClick={() => {
          // A double-click must NOT also select — selecting focuses the
          // composer, which steals focus from the rename input and closes it.
          // Debounce the single-click select; a second click on the SAME row
          // cancels it and renames instead (matches the Files list).
          const pending = chatClickRef.current;
          if (pending?.id === chat.id) {
            clearTimeout(pending.timer);
            chatClickRef.current = null;
            // External sessions are read-only rows — no rename, just open.
            if (external) selectChat(index, { focusComposer: false });
            else setRenamingChatId(chat.id);
            return;
          }
          if (pending) clearTimeout(pending.timer); // a different row — drop it
          chatClickRef.current = {
            id: chat.id,
            timer: setTimeout(() => {
              chatClickRef.current = null;
              selectChat(index, { focusComposer: true });
            }, 200),
          };
        }}
        onKeyDown={(event) => {
          if (renamingChatId === chat.id) return; // the rename input owns keys
          if (event.key === 'Enter') {
            // Enter on a focused row starts a rename (matches Files); Space opens.
            event.preventDefault();
            if (external) selectChat(index, { focusComposer: false });
            else setRenamingChatId(chat.id);
          } else if (event.key === ' ') {
            event.preventDefault();
            selectChat(index, { focusComposer: true });
          }
        }}
        // Right-click opens the row's actions menu (matches Files rows) —
        // without this the desktop shell surfaces the raw WebKit menu.
        // External transcripts have no menu; a renaming row keeps the native
        // menu so the input's copy/paste stays reachable.
        onContextMenu={
          external || renamingChatId === chat.id
            ? undefined
            : (event) => {
                event.preventDefault();
                event.stopPropagation();
                chatMenuTriggerRef.current = event.currentTarget.querySelector<HTMLButtonElement>(
                  '[aria-label="Chat actions"]',
                );
                // Open, never toggle: the outside-click closer already ran on
                // this same right-click's mousedown, so a toggle would re-open.
                setOpenChatMenuId(chat.id);
              }
        }
        className={`group relative w-full cursor-pointer text-left ${
          layout === 'desktop'
            ? 'flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm'
            : 'rounded-xl px-2.5 py-1.5'
        } ${
          // Above sibling rows' z-30 hover controls, so the open actions menu
          // (an inline fixed child) cleanly covers overlapped rows instead of
          // their link/chevron painting through it.
          isChatMenuOpen ? 'z-40' : ''
        } ${getSidebarListItemStateClasses(isSelected)}`}
      >
        {layout === 'desktop' ? (
          <>
            {/* Wireframe chat row: icon + title only — no subtitle, no
                timestamp. The goal_summary/model data stays on the chat.
                Touched-only chats (folder-focused rail: edited files here but
                live elsewhere) get the wireframe's dashed-outline icon. */}
            {showGroupChatUi ? (
              <UsersThreeIcon className="h-[15px] w-[15px] flex-shrink-0 text-stone-400" weight="regular" aria-hidden />
            ) : external ? (
              <ExternalAgentBadge external={external} />
            ) : folderRelation === 'touched' ? (
              <span
                title={`Edited files in ${focusedSidebarFolder}/ · started elsewhere`}
                className="flex h-[17px] w-[17px] flex-shrink-0 items-center justify-center rounded-[5px] border border-dashed border-stone-300"
              >
                <ChatTeardropIcon className="h-[13px] w-[13px] text-stone-400" weight="regular" aria-hidden />
              </span>
            ) : (
              <ChatTeardropIcon className="h-[15px] w-[15px] flex-shrink-0 text-stone-400" weight="regular" aria-hidden />
            )}
            <EditableChatTitle
              className={`min-w-0 flex-1 truncate leading-5 ${hasUnread ? 'font-semibold text-stone-900' : 'text-stone-700'}`}
              value={displayName}
              initialDraft={chat.title?.trim() || ''}
              editing={renamingChatId === chat.id}
              onCommit={(next) => void renameChat(chat.id, next)}
              onCancel={() => setRenamingChatId(null)}
            />
            {chat.is_active ? (
              <span
                data-testid="chat-agent-running"
                role="status"
                aria-label="Agent running"
                title="Agent running"
                className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-500"
              />
            ) : null}
            {isTextChat ? <TransportBadge label="text" /> : null}
            {/* In-flow, display-swapped (badge ⇄ actions): the hover actions
                must take real layout space so the title TRUNCATES under them
                instead of the icons painting over its last characters. */}
            <div className="ml-auto flex h-5 shrink-0 items-center justify-end">
              {hasUnread ? (
                <span
                  className={`min-w-5 items-center justify-center rounded-full bg-[#FF7628] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-[#fff] ${
                    isChatMenuOpen ? 'hidden' : 'inline-flex group-hover:hidden'
                  }`}
                >
                  {unreadCount}
                </span>
              ) : null}
              <div
                className={`items-center justify-end ${
                  isChatMenuOpen ? 'flex' : 'hidden group-hover:flex'
                }`}
              >
                {chatMenu}
              </div>
            </div>
          </>
        ) : (
        <div className="flex items-center gap-2">
          {/* No avatar on direct-chat cards (wireframe: title + goal line
              only); group chats keep their compact participants glyph. */}
          {showGroupChatUi ? (
            <div className="relative shrink-0">
              <div className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-md border border-stone-200 bg-stone-100 text-stone-600">
                <UsersThreeIcon className="h-3 w-3" weight="regular" aria-hidden />
              </div>
              <span className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white ${getAssistantStatusDotClass(status)}`} />
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <EditableChatTitle
                    className={`min-w-0 truncate text-sm leading-4 ${hasUnread ? 'font-semibold text-stone-900' : 'font-medium text-stone-700'}`}
                    value={displayName}
                    initialDraft={chat.title?.trim() || ''}
                    editing={renamingChatId === chat.id}
                    onCommit={(next) => void renameChat(chat.id, next)}
                    onCancel={() => setRenamingChatId(null)}
                  />
                  {chat.is_active ? (
                    // Server-derived "run in flight" (latest message is an
                    // assistant row with no terminal marker) — unlike the
                    // realtime avatar dot, this survives page loads.
                    <span
                      data-testid="chat-agent-running"
                      role="status"
                      aria-label="Agent running"
                      title="Agent running"
                      className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-500"
                    />
                  ) : null}
                  {isTextChat ? <TransportBadge label="text" /> : null}
                </div>
                <div className={`mt-0.5 truncate pr-1 text-[13px] leading-4 ${hasUnread ? 'font-semibold text-stone-700' : 'text-stone-500'}`}>
                  {cardSubtitle}
                </div>
              </div>
              {isMobile ? (
                <div className="flex shrink-0 items-start gap-1.5">
                  <div className="flex min-w-9 flex-col items-end gap-0 pt-0.5">
                    <span className={`text-[11px] ${hasUnread ? 'font-medium text-[#FF7628]' : 'text-stone-400'}`} title={activityTitle}>
                      {activityLabel}
                    </span>
                    {hasUnread ? (
                      <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[#FF7628] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-[#fff]">
                        {unreadCount}
                      </span>
                    ) : null}
                  </div>
                  {chatMenu}
                </div>
              ) : (
                <div className="w-9 shrink-0">
                  <div className="flex h-4 items-center justify-end">
                    <span
                      className={`block max-w-full truncate text-[11px] ${hasUnread ? 'font-medium text-[#FF7628]' : 'text-stone-400'}`}
                      title={activityTitle}
                    >
                      {activityLabel}
                    </span>
                  </div>
                  <div className="relative mt-0.5 flex h-4 items-center justify-end">
                    {hasUnread ? (
                      <span
                        className={`inline-flex min-w-5 items-center justify-center rounded-full bg-[#FF7628] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-[#fff] ${
                          isChatMenuOpen ? 'opacity-0' : 'group-hover:opacity-0'
                        }`}
                      >
                        {unreadCount}
                      </span>
                    ) : null}
                    <div
                      className={`absolute inset-y-0 right-0 z-30 flex items-center justify-end ${
                        isChatMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}
                    >
                      {chatMenu}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        )}
      </div>
    );
  };

  const renderChatRail = (layout: 'desktop' | 'mobile') => {
    const emptyTextClass = `px-3 py-2 ${layout === 'mobile' ? 'text-sm' : 'text-xs'} text-stone-400`;
    const sectionLabelClass = 'px-2 py-1 text-[11px] font-medium text-stone-400';
    // Desktop (wireframe): a flat, label-less list, pinned chats first.
    // Mobile keeps its labeled Pinned/Chats groups.
    const showLabels = layout === 'mobile';
    // Folder-focused rail (desktop): only chats scoped to the folder or a
    // descendant ('here'/'sub'), or that touched files under it ('touched').
    const folderFocus = layout === 'desktop' ? focusedSidebarFolder : null;
    const inFocus = (entry: (typeof chatEntries)[number]) =>
      !folderFocus || chatFolderRelation(entry.chat, folderFocus) !== null;
    const railPinned = pinnedActiveChats.filter(inFocus);
    const railUnpinned = unpinnedActiveChats.filter(inFocus);

    return (
      <>
        {railPinned.length > 0 ? (
          <div className={showLabels ? 'mb-1' : undefined}>
            {showLabels ? <div className={sectionLabelClass}>Pinned</div> : null}
            <div className={showLabels ? 'space-y-1' : 'space-y-0.5'}>
              {railPinned.map((entry) => renderAssistantCard(entry, layout))}
            </div>
          </div>
        ) : null}
        <div>
          {showLabels ? (
            <div className={sectionLabelClass}>{railPinned.length > 0 ? 'All' : 'Chats'}</div>
          ) : null}
          {chatLoadError && chatThreads.length === 0 ? (
            // The initial load can 403 before the files payload marks the
            // caller scoped — never surface that as an error to share guests.
            chatsLoaded && !isScopedGuest ? <div className={emptyTextClass}>{chatLoadError}</div> : null
          ) : chatThreads.length === 0 ? (
            chatsLoaded ? <div className={emptyTextClass}>No chats yet.</div> : null
          ) : activeChats.length === 0 ? (
            <div className={emptyTextClass}>No active chats.</div>
          ) : folderFocus && railPinned.length + railUnpinned.length === 0 ? (
            <div className={emptyTextClass}>No chats here yet.</div>
          ) : railUnpinned.length > 0 ? (
            <div className={showLabels ? 'space-y-1' : 'space-y-0.5'}>
              {railUnpinned.map((entry) => renderAssistantCard(entry, layout))}
            </div>
          ) : null}
        </div>
        {/* Archived chats never render in the rail — they live in Settings →
            Workspace, where they can be unarchived. */}
      </>
    );
  };

  if (accessError) {
    // Unclaimed key-gated workspace: whatever the denial status, the fix is
    // the KEY (from the AI chat that created it), never a sign-in.
    const claimGate = accessError !== 'not-found' && accessClaimable;
    const title = claimGate
      ? 'Claim this workspace'
      : accessError === 'not-found'
        ? 'Workspace not found'
        : accessError === 'signin'
          ? 'Sign in required'
          : 'Private workspace';
    const message = claimGate
      ? ''
      : accessError === 'not-found'
        ? 'This workspace does not exist or has been deleted.'
        : accessError === 'signin'
          ? 'Please sign in to request access to this workspace.'
          : 'You do not have access to this workspace.';
    // Styled like the onboarding welcome step: Sunny front and center on the
    // stone backdrop, orange pill CTA. Sign-in gets the laptop Lottie; the
    // dead ends (not-found / forbidden) get the shrug.
    return (
      <div className="min-h-screen bg-stone-50 text-stone-800 flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center animate-fade-in-up">
          {accessError === 'signin' ? (
            <SunnyLottie className="mx-auto mb-2 h-40 w-full max-w-[16rem]" />
          ) : (
            <SunnyAnimation name="shrug" className="mx-auto mb-4 h-36 w-36 object-contain" />
          )}
          <h1 className="text-2xl font-medium leading-tight">{title}</h1>
          {message ? <p className="mt-3 text-stone-600">{message}</p> : null}
          {claimGate ? <ClaimKeyGate workspacePath={buildWorkspacePath(workspaceRouteId)} /> : null}
          {!claimGate && accessError === 'signin' && (
            <SignInButton mode="modal" forceRedirectUrl={buildWorkspacePath(workspaceRouteId)}>
              <button className="mt-8 flex w-full items-center justify-center gap-2 rounded-full bg-orange-500 py-3 text-sm font-medium text-white transition-all hover:bg-orange-600">
                Sign in
              </button>
            </SignInButton>
          )}
        </div>
      </div>
    );
  }

  // The open file's own sharing: which Share surface its header button opens,
  // and the access it already has (icon + status pill).
  const activeFileIsExtraRoot = localRoots.some(
    (entry) => entry.prefix && activeWorkspaceFile?.path.split('/', 1)[0] === entry.prefix,
  );
  const activeFileShareTarget = fileShareTarget({
    isLocalWorkspace,
    isExtraRootPath: activeFileIsExtraRoot,
    canInviteShare,
    isScopedGuest,
    sharingLoaded: Boolean(shareInfo) && cloudPathSharesLoaded,
    isSignedIn: Boolean(user),
  });
  const activeFileShare = fileShareStatus({
    path: activeWorkspaceFile?.path,
    isLocalWorkspace,
    isExtraRootPath: activeFileIsExtraRoot,
    localSharedScopePaths,
    cloudPathShares,
    cloudPathSharesLoaded,
    workspaceShareStatus: shareStatus,
    scopedGuestGrants: isScopedGuest ? pathGrants : null,
  });
  // General access lives in the path_shares ROOT grant, so both of these
  // mutate the same rows the per-file icons read — reload them or every file
  // keeps the icon of the access that was just turned off.
  const handleVisibilityChange = async (visibility: 'private' | 'public') => {
    await changeVisibility(visibility);
    await refreshCloudPathShares();
  };
  const handlePublicAccessChange = async (access: 'view' | 'suggest' | 'edit' | 'none') => {
    await changePublicAccess(access);
    await refreshCloudPathShares();
  };
  const openPathShareScope = (scope: { path: string; kind: 'file' | 'folder' }) => {
    setPathShareScope(scope);
    void refreshCloudPathShares();
  };
  // What the "Shared" label manages: the grant that covers this file, else the
  // workspace share it inherits from — and nothing at all for a scoped guest,
  // whose access to BOTH sharing endpoints is a 403.
  const activeFileShareScope = activeFileShare.scope;
  const openReportedShare = activeFileShareScope
    ? isLocalWorkspace
      ? () => setLocalShareScope(activeFileShareScope)
      : () => openPathShareScope(activeFileShareScope)
    : isScopedGuest
      ? null
      : openShare;
  // Copy-link fallback for viewers with no share modal. Only the ROOT grant's
  // token may ride a copied link — a narrow file/chat token would leak that
  // scope — so a narrow ?pshare guest gets no link at all rather than a bare
  // URL that 404s for whoever they send it to.
  const activeFileCopyUrl = (() => {
    // Local extra-root mounts never sync, so they can't be shared — no
    // copy-link fallback either, or the header hands out a link nobody
    // else can open (with no share action, the button hides instead).
    if (isLocalWorkspace && activeFileIsExtraRoot) return null;
    const url = activeWorkspaceFile ? buildFileUrl(activeWorkspaceFile) : '';
    if (!url) return null;
    const token = rootShareTokenRef.current ?? (holdsRootGrantRef.current ? currentPathShareToken() : null);
    if (token) return `${url}${url.includes('?') ? '&' : '?'}${PATH_SHARE_TOKEN_PARAM}=${encodeURIComponent(token)}`;
    return isScopedGuest ? null : url;
  })();
  // Local: share this file to a cloud workspace via the sidecar. Cloud: the
  // path-share modal, like the file rail's ⋮ → Share — the workspace modal
  // only ever offered the bare /w/<id> URL, which names no file and (post
  // root-grant) grants nothing. `fileShareModalScope` owns the choice for
  // both, so the doc header and the top bar can't drift apart on it.
  const openShareForFile = (
    path: string,
    target: ReturnType<typeof fileShareTarget>,
    share: ReturnType<typeof fileShareStatus>,
  ) => {
    const route = fileShareModalScope(path, target, share);
    if (!route) return null;
    return route.lane === 'local'
      ? () => setLocalShareScope(route.scope)
      : () => openPathShareScope(route.scope);
  };
  const openActiveFileShare = activeWorkspaceFile
    ? openShareForFile(activeWorkspaceFile.path, activeFileShareTarget, activeFileShare)
    : null;

  // Top-bar Share target: the FOCUSED pane's file when a pane shows it
  // (split panes make the primary selection wrong — Codex round 8), else the
  // visible primary selection. Null on covered/chat surfaces → workspace-only.
  const topbarShareFilePath =
    commitDiffOpen || !isEditorVisible
      ? null
      : focusedEditorPath && paneShowsFile(focusedEditorPath)
        ? focusedEditorPath
        : selectedFilePath && paneShowsFile(selectedFilePath)
          ? selectedFilePath
          : null;
  // File + parent-folder share plan for an arbitrary on-screen path — the
  // same target/covering-scope routing the doc header uses for the active
  // file (extra-root mounts and scoped guests fall out as null).
  const topbarSharePlan = (() => {
    const path = topbarShareFilePath;
    if (!path) return { fileName: null, parentDir: null, onShareFile: null, onShareFolder: null };
    const isExtraRoot = localRoots.some(
      (entry) => entry.prefix && path.split('/', 1)[0] === entry.prefix,
    );
    const target = fileShareTarget({
      isLocalWorkspace,
      isExtraRootPath: isExtraRoot,
      canInviteShare,
      isScopedGuest,
      sharingLoaded: Boolean(shareInfo) && cloudPathSharesLoaded,
      isSignedIn: Boolean(user),
    });
    const status = fileShareStatus({
      path,
      isLocalWorkspace,
      isExtraRootPath: isExtraRoot,
      localSharedScopePaths,
      cloudPathShares,
      cloudPathSharesLoaded,
      workspaceShareStatus: shareStatus,
      scopedGuestGrants: isScopedGuest ? pathGrants : null,
    });
    const onShareFile = openShareForFile(path, target, status);
    const parentDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
    const onShareFolder =
      parentDir && target === 'local'
        ? () => setLocalShareScope({ kind: 'folder', path: parentDir })
        : parentDir && target === 'path'
          ? () => openPathShareScope({ path: parentDir, kind: 'folder' })
          : null;
    return { fileName: formatFileName(getFileName(path)), parentDir, onShareFile, onShareFolder };
  })();

  // Doc-header chrome shared between the desktop editor-column strip and the
  // mobile top bar. Below the mobile breakpoint the top bar carries the file
  // identity + per-file controls itself — one chrome bar in the same
  // left-to-right order as desktop, instead of stacking a second header that
  // repeats the file name.
  // `large` = the Google Docs-style header title (docs mode); the default is
  // the compact 13px control the IDE header and mobile strip use.
  const renderDocFileNameControl = (large = false) => activeWorkspaceFile ? (
    <DocFileNameControl
      large={large}
      fileName={formatFileName(getFileName(activeWorkspaceFile.path))}
      canRename={canWrite && !documentEditorReadOnly}
      isRenaming={
        renameEntry?.source === 'header' &&
        !renameEntry.paneId &&
        (renameEntry.fileId
          ? renameEntry.fileId === activeWorkspaceFile.id
          : renameEntry.path === activeWorkspaceFile.path)
      }
      renameValue={renameEntry?.name ?? ''}
      inputRef={renameInputRef}
      onBeginRename={(event) =>
        beginRename(activeWorkspaceFile.path, 'header', {
          fileId: activeWorkspaceFile.id,
          clickEvent: event,
        })
      }
      onRenameValueChange={(name) =>
        setRenameEntry({
          path: activeWorkspaceFile.path,
          name,
          source: 'header',
          fileId: activeWorkspaceFile.id,
        })
      }
      onCommitRename={() => void commitRename()}
      onCancelRename={cancelRename}
    />
  ) : null;
  // Hoisted out of docFileControls so the no-tabs shell can seat it beside
  // the window's × (top-left) while the tabbed shell and mobile keep it at
  // the row's end. Dots are HORIZONTAL (Belinda, 2026-08-07 — one ⋯ menu,
  // matching the toolbar's own overflow glyph); the panel hugs whichever
  // corner the trigger sits in.
  // While the formatting toolbar is shown, the doc controls ride ITS right
  // end instead of the header corner — see docsHeaderControls below. In the
  // Docs style that is ALWAYS (founder: Edit/Suggest/View and the ⋯ fold
  // entirely into the bar — the toolbar row stays mounted even over the raw
  // markdown view, inert, so the controls never pop back up to the header).
  // Defined up here because docFileControls' mode-picker gate reads it.
  const controlsRideToolbar =
    !isMobile && activeIsMarkdown && (docsPage || (isMarkdownEditing && showFormatToolbar));
  // Docs style: the toolbar suppresses its own overflow trigger and its
  // condensed tiers fold into the document ⋯ menu instead — ONE dots menu on
  // the pill, not ⋯ + ⋮ side by side (Belinda's screenshot). ONE width const
  // feeds both the flags here and the toolbar's containerWidth prop below, so
  // the bar and the menu can never disagree on what's hidden.
  const toolbarContentWidth = controlsRideToolbar
    ? Math.max(0, toolbarRowWidth - toolbarControlsWidth)
    : toolbarRowWidth;
  const docsToolbarFlags = toolbarTierFlags(toolbarContentWidth);
  const docsToolbarOverflowItems =
    !isMobile &&
    docsPage &&
    isMarkdownEditing &&
    toolbarEditor &&
    // The frozen destroyed editor (file switch in flight) throws on any
    // command — the bar goes inert then, so the menu must too (Codex).
    !toolbarEditor.isDestroyed &&
    !docsToolbarFlags.showClear &&
    !documentEditorReadOnly &&
    activeFileCap.canWrite
      ? (close: () => void) => (
          <ToolbarOverflowItems
            editor={toolbarEditor}
            flags={docsToolbarFlags}
            onClose={close}
            // This menu already lists its own Print below.
            hidePrint
          />
        )
      : undefined;
  // ⌘F / ⌘⇧H belong to ONE pane: the last-clicked pane while it shows a file
  // (the same file open in two panes must not open two find bars), else the
  // primary.
  const findOwnerPaneId = editorPanes.some(
    (pane) => pane.id === focusedPaneId && pane.active && workspaceFileByPath.has(pane.active),
  )
    ? focusedPaneId
    : PRIMARY_PANE_ID;
  const docActionsMenu = activeWorkspaceFile ? (
    <DocumentActionsMenu
      findShortcuts={findOwnerPaneId === PRIMARY_PANE_ID}
      formattingItems={docsToolbarOverflowItems}
      // Horizontal ⋯ only where this IS the pill's single dots menu; the
      // IDE/mobile shells keep ⋮ beside the toolbar's own ⋯ overflow.
      horizontalDots={docsPage && !isMobile}
      // Docs view keeps the ⋮ in the RIGHT corner (no window × to sit beside),
      // so its panel hugs right; the IDE no-tabs shell seats it top-left.
      menuAlign={!isMobile && !desktopTabs && !docsPage ? 'left' : 'right'}
      editor={markdownEditor}
      readOnly={documentEditorReadOnly || !activeFileCap.canWrite}
      file={activeWorkspaceFile}
      projectId={projectId}
      fileUrl={buildFileUrl(activeWorkspaceFile) || null}
      localWorkspace={isLocalWorkspace}
      rawMarkdown={
        activeIsMarkdown
          ? {
              active: showRawView,
              onToggle: () => {
                const el = docEditorBodyRef.current;
                if (el) docScrollFractionRef.current = scrollFraction(el);
                pendingRestoreRef.current = true;
                setShowRawView((value) => !value);
              },
            }
          : null
      }
      richViewer={
        // Preview↔Source for code files with a rich viewer (CSV/JSON/HTML).
        !isMarkdownEditing && hasRichViewer
          ? { active: showRichViewer, onToggle: () => setShowRichViewer((v) => !v) }
          : null
      }
      inlineTitle={activeIsMarkdown ? { active: showDocTitle, onToggle: toggleDocTitle } : null}
      collapsed={
        collapseDocControls
          ? {
              editMode: !documentReadOnly
                ? { mode: effectiveDocEditMode, modes: docEditModes, onChange: setDocumentEditMode }
                : null,
              // No sign-in prompt anywhere (founder, 2026-08-05) — anonymous
              // visitors use Log in.
              signIn: null,
              // Desktop drops the Share item — its affordance is the status
              // icon riding next to the file name, which survives the
              // collapse. NARROW MOBILE keeps it: the status icon only
              // renders in the desktop doc header, and the mobile
              // FileShareButton is gone under this collapse.
              share: isMobile
                ? (() => {
                    const open =
                      openActiveFileShare ??
                      (!isLocalWorkspace && canShowShareControls && !isScopedGuest
                        ? openShare
                        : null);
                    return open ? { onSelect: open } : null;
                  })()
                : null,
              // Mirrors the buttons it replaces: mobile's caret covers
              // markdown AND LaTeX (compile/view toolbar); desktop Aa is
              // markdown-only.
              formatToolbar: isMobile
                ? activeIsMarkdown || activeTexFile
                  ? { active: mobileToolbarExpanded, onToggle: () => setMobileToolbarExpanded((v) => !v) }
                  : null
                : // Docs style: the toolbar can never close — no toggle item.
                  activeIsMarkdown && !docsPage
                  ? { active: showFormatToolbar, onToggle: toggleFormatToolbar }
                  : null,
              // Squished row: the comments toggle folds in here like its
              // neighbors — it's the only entry point once the icon is gone.
              comments:
                activeFileCommentCount > 0
                  ? { count: activeFileCommentCount, onToggle: toggleCommentLane }
                  : null,
            }
          : null
      }
      pdfPreviewUrl={pdfPreviewUrl}
      onRename={() =>
        // Web (no-tabs) shell: the rename input lives in the bar's file-name
        // control ('header'), not a tab.
        beginRename(activeWorkspaceFile.path, isMobile || !desktopTabs ? 'header' : 'tab', {
          fileId: activeWorkspaceFile.id,
          ...(isMobile || !desktopTabs ? {} : { paneId: PRIMARY_PANE_ID }),
        })
      }
      onDuplicate={() => void duplicateFile(activeWorkspaceFile)}
      onDelete={() => void deletePath(activeWorkspaceFile.path)}
    />
  ) : null;
  const docFileNameControl = renderDocFileNameControl();
  // A header crumb CLICK opens the rail scoped to that folder (FilesTabPanel
  // folder-focus, same as double-clicking its row).
  const focusRailFolder = (path: string) => {
    setOpenLeftRail('project');
    setSidebarSections((prev) => expandSection(prev, 'files'));
    setSidebarFolderFocusIntent({ path, nonce: Date.now() });
  };
  const docFileControls = activeWorkspaceFile ? (
    <>
      {/* Squished bar (narrow pane / small viewport): everything folds into
          the ⋯ menu — see its `collapsed` section. */}
      {/* Mode picker: rides the formatting toolbar's right end while it's
          shown (Google Docs' Editing dropdown — founder). In the Docs style
          this whole cluster IS what rides the toolbar, so it stays here; in
          the IDE style the toolbar seats its own copy, so the header drops
          this one. Mobile and non-markdown surfaces keep it here always. */}
      {!collapseDocControls && !documentReadOnly && (docsPage || !controlsRideToolbar) ? (
        <EditModeControl
          mode={effectiveDocEditMode}
          onChange={setDocumentEditMode}
          menuPlacement="down"
          modes={docEditModes}
          disabled={!activeFileCap.canWrite}
        />
      ) : null}
      {/* (No "Sign in to suggest edits" prompt — founder, 2026-08-05: the
          header stays quiet; anonymous visitors sign in via Log in.) */}
      {/* Formatting toolbar toggle — Aa, seated right before the ⋮ (founder:
          "near the 3 dots"). Desktop IDE only: mobile keeps its own
          collapsed-toolbar caret, and the Docs toolbar can NEVER close
          (founder, 2026-08-05) so it offers no toggle at all. */}
      {!collapseDocControls && !isMobile && !docsPage && activeIsMarkdown ? (
        <button
          type="button"
          onClick={toggleFormatToolbar}
          aria-pressed={showFormatToolbar}
          aria-label="Formatting toolbar"
          data-testid="format-toolbar-toggle"
          className={`relative group/tip inline-flex h-7 w-7 items-center justify-center rounded hover:bg-stone-100 ${
            showFormatToolbar ? 'text-stone-700' : 'text-stone-400 hover:text-stone-600'
          }`}
        >
          <TextAaIcon className="h-4 w-4" weight="regular" aria-hidden />
          <IconTooltip label="Formatting toolbar" />
        </button>
      ) : null}
      {/* Comments toggle — MOBILE only here: desktop's copy moved up to the
          window's top-right cluster, seated left of the right-panel toggle
          (Belinda, 2026-08-07 — Google Docs' own comment/share corner).
          Hidden while the file has zero comments — commenting starts from the
          selection bubble (⌘⌥M), not here; when the row collapses it folds
          into the ⋯ menu like its neighbors. */}
      {isMobile && !collapseDocControls && activeFileCommentCount > 0 ? (
        <button
          type="button"
          onClick={toggleCommentLane}
          aria-pressed={commentsLaneToggled}
          aria-label="Comments"
          data-testid="doc-comments-toggle"
          className={`relative group/tip inline-flex h-7 w-7 items-center justify-center rounded hover:bg-stone-100 ${
            commentsLaneToggled ? 'text-stone-700' : 'text-stone-400 hover:text-stone-600'
          }`}
        >
          <ChatTextIcon
            className="h-4 w-4"
            weight={commentsLaneToggled ? 'fill' : 'regular'}
            aria-hidden
          />
          {commentBadgeCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-white bg-[#e7c49e] px-1 text-[9px] font-semibold text-[#634a31]">
              {Math.min(commentBadgeCount, 9)}
            </span>
          ) : null}
          <IconTooltip label="Comments" />
        </button>
      ) : null}
      {/* Per-file Share button: MOBILE only — desktop's share affordance is
          the status icon riding next to the file name (founder). */}
      {isMobile && !collapseDocControls ? (
      <FileShareButton
        variant="button"
        fileUrl={activeFileCopyUrl}
        shareStatus={activeFileShare.status}
        onShareFile={openActiveFileShare ?? undefined}
        // /api/workspace/share 403s for a scoped guest, so the workspace
        // modal would only error at them — they get copy-link instead.
        onOpenWorkspaceShare={
          !isLocalWorkspace && canShowShareControls && !isScopedGuest ? openShare : undefined
        }
      />
      ) : null}
      {/* The ⋮ document-actions menu rides here (row end) in the tabbed shell
          and on mobile; the no-tabs shell seats it beside the window's × at
          the top-LEFT corner instead (founder). */}
      {isMobile || desktopTabs ? docActionsMenu : null}
    </>
  ) : null;
  // Share status rides NEXT TO THE FILE NAME (founder): a lock while the doc
  // is private, the usual audience glyphs (people / globe) once it isn't —
  // and clicking it IS the share entry point. The status variant keeps
  // FileShareButton's copy-link fallback, so a modal-less viewer (e.g. a
  // ?pshare guest) can still copy the usable file link. Desktop only; mobile
  // keeps the full-size button in its merged bar.
  const docShareStatusIcon = activeWorkspaceFile ? (
    <FileShareButton
      variant="status"
      fileUrl={activeFileCopyUrl}
      shareStatus={activeFileShare.status}
      onShareFile={openActiveFileShare ?? undefined}
      onOpenWorkspaceShare={
        !isLocalWorkspace && canShowShareControls && !isScopedGuest ? openShare : undefined
      }
    />
  ) : null;
  // Google Docs seats its mode picker and overflow at the RIGHT END OF THE
  // TOOLBAR, not in a corner above it — a floating cluster up there read as
  // app chrome bolted onto a document (founder). While the toolbar is shown,
  // the Docs style seats its WHOLE control cluster there and the IDE style
  // seats just the mode picker (its Aa/⋮ keep their header seats); with the
  // toolbar hidden — or the raw markdown view in its place — everything
  // falls back to the header corner. (controlsRideToolbar itself is defined
  // above docFileControls, whose mode-picker gate reads it.)
  const docsHeaderControls = (
    <>
      {docFileControls}
      {!isMobile && !desktopTabs ? docActionsMenu : null}
    </>
  );
  // Split panes get the SAME doc chrome as the primary — header row (path,
  // name, share status, Aa, ⋮) and the mode picker at the toolbar's right
  // end — built per file/pane from the same pieces. Per-file capability and
  // share status are derived for the pane's own file (not the page selection);
  // the mode itself is workspace-global, so picking in any pane moves all.
  const buildSplitPaneChrome = (file: WorkspaceFileRow, paneId: string, editor: Editor | null) => {
    const isMarkdown = isMarkdownFile(file);
    const cap = pathCapability({ canWrite, canSuggest, canComment }, pathGrants, file.path, Boolean(user));
    const readOnly = !cap.canWrite && !cap.canSuggest;
    const modes = isMarkdown ? MARKDOWN_DOC_EDIT_MODES : DOC_EDIT_MODES;
    const mode: WorkspaceEditMode = !cap.canWrite
      ? modes.includes('suggest')
        ? 'suggest'
        : 'view'
      : modes.includes(documentEditMode)
        ? documentEditMode
        : 'edit';
    // Same coercion as the primary: a non-markdown file has no View, so a
    // "Viewing" workspace edits it — and the pane's own picker now shows that.
    const editorReadOnly = readOnly || mode === 'view';
    const isExtraRoot = localRoots.some(
      (entry) => entry.prefix && file.path.split('/', 1)[0] === entry.prefix,
    );
    const shareTarget = fileShareTarget({
      isLocalWorkspace,
      isExtraRootPath: isExtraRoot,
      canInviteShare,
      isScopedGuest,
      sharingLoaded: Boolean(shareInfo) && cloudPathSharesLoaded,
      isSignedIn: Boolean(user),
    });
    const share = fileShareStatus({
      path: file.path,
      isLocalWorkspace,
      isExtraRootPath: isExtraRoot,
      localSharedScopePaths,
      cloudPathShares,
      cloudPathSharesLoaded,
      workspaceShareStatus: shareStatus,
      scopedGuestGrants: isScopedGuest ? pathGrants : null,
    });
    const copyUrl = (() => {
      if (isLocalWorkspace && isExtraRoot) return null;
      const url = buildFileUrl(file);
      if (!url) return null;
      const token = rootShareTokenRef.current ?? (holdsRootGrantRef.current ? currentPathShareToken() : null);
      if (token) return `${url}${url.includes('?') ? '&' : '?'}${PATH_SHARE_TOKEN_PARAM}=${encodeURIComponent(token)}`;
      return isScopedGuest ? null : url;
    })();
    const shareIcon = (
      <FileShareButton
        variant="status"
        fileUrl={copyUrl}
        shareStatus={share.status}
        onShareFile={openShareForFile(file.path, shareTarget, share) ?? undefined}
        onOpenWorkspaceShare={
          !isLocalWorkspace && canShowShareControls && !isScopedGuest ? openShare : undefined
        }
      />
    );
    const showToolbar = isMarkdown && (docsPage || showFormatToolbar);
    const nameControl = (large = false) => (
      <DocFileNameControl
        large={large}
        fileName={formatFileName(getFileName(file.path))}
        canRename={cap.canWrite && !editorReadOnly}
        isRenaming={
          renameEntry?.source === 'header' &&
          renameEntry.paneId === paneId &&
          (renameEntry.fileId ? renameEntry.fileId === file.id : renameEntry.path === file.path)
        }
        renameValue={renameEntry?.name ?? ''}
        inputRef={renameInputRef}
        onBeginRename={(event) =>
          beginRename(file.path, 'header', { fileId: file.id, clickEvent: event, paneId })
        }
        onRenameValueChange={(name) =>
          setRenameEntry({ path: file.path, name, source: 'header', fileId: file.id, paneId })
        }
        onCommitRename={() => void commitRename()}
        onCancelRename={cancelRename}
      />
    );
    const modePicker = !readOnly ? (
      <EditModeControl
        mode={mode}
        onChange={setDocumentEditMode}
        menuPlacement="down"
        modes={modes}
        disabled={!cap.canWrite}
      />
    ) : null;
    // No-tabs shell: no strip to rename in — the header's name control is
    // the rename input (same rule as the primary).
    const renameFromMenu = () =>
      beginRename(file.path, desktopTabs ? 'tab' : 'header', { fileId: file.id, paneId });
    const actionsMenu = (collapsed: boolean, flags?: ToolbarTierFlags) => (
      <DocumentActionsMenu
        // Docs style: the toolbar's condensed tiers fold in here — ONE dots
        // menu on the pill (same as the primary's docsToolbarOverflowItems).
        formattingItems={
          docsPage && flags && !flags.showClear && editor && !editor.isDestroyed && !editorReadOnly && cap.canWrite
            ? (close) => <ToolbarOverflowItems editor={editor} flags={flags} onClose={close} hidePrint />
            : undefined
        }
        horizontalDots={docsPage}
        menuAlign="right"
        editor={editor}
        readOnly={editorReadOnly || !cap.canWrite}
        file={file}
        projectId={projectId}
        fileUrl={copyUrl}
        localWorkspace={isLocalWorkspace}
        collapsed={
          collapsed
            ? {
                editMode: !readOnly ? { mode, modes, onChange: setDocumentEditMode } : null,
                signIn: null,
                share: null,
                formatToolbar:
                  isMarkdown && !docsPage
                    ? { active: showFormatToolbar, onToggle: toggleFormatToolbar }
                    : null,
                comments: null,
              }
            : null
        }
        // The pane is print:hidden — Print would print the primary doc.
        hidePrint
        findShortcuts={findOwnerPaneId === paneId}
        onRename={renameFromMenu}
        onDuplicate={() => void duplicateFile(file)}
        onDelete={() => void deletePath(file.path)}
      />
    );
    const header = docsPage && isMarkdown ? (
      // Google Docs style: the big title with the menu bar beneath it (mirrors
      // the primary's docs header; its controls ride the toolbar).
      <div className="relative flex shrink-0 items-center justify-between gap-2 px-3 pt-1 print:hidden">
        <div className="flex min-w-0 items-center">
          <WorkspaceEntryIcon
            path={file.path}
            className="ml-1.5 mr-0.5 h-8 w-8 shrink-0 text-stone-500 [stroke-width:0.9]"
          />
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-1.5 pl-1.5" title={file.path}>
              {nameControl(true)}
              {shareIcon}
            </div>
            <MarkdownMenuBar
              className="-mt-1 px-0"
              editor={editor}
              readOnly={editorReadOnly || !cap.canWrite}
              file={file}
              projectId={projectId}
              localWorkspace={isLocalWorkspace}
              sidebarOpen={openLeftRail !== null}
              hidePrint
              onRename={renameFromMenu}
              onDuplicate={() => void duplicateFile(file)}
              onDelete={() => void deletePath(file.path)}
              onToggleSidebar={toggleSidebar}
            />
          </div>
        </div>
      </div>
    ) : (
      <DocPaneHeader
        path={file.path}
        nameControl={nameControl()}
        shareIcon={shareIcon}
        tall={!desktopTabs}
        onFocusFolder={focusRailFolder}
        controls={(collapsed) => (
          <>
            {/* Mode picker rides the toolbar while it's shown (IDE style). */}
            {!collapsed && !showToolbar ? modePicker : null}
            {!collapsed && !docsPage && isMarkdown ? (
              <button
                type="button"
                onClick={toggleFormatToolbar}
                aria-pressed={showFormatToolbar}
                aria-label="Formatting toolbar"
                data-testid="format-toolbar-toggle"
                className={`relative group/tip inline-flex h-7 w-7 items-center justify-center rounded hover:bg-stone-100 ${
                  showFormatToolbar ? 'text-stone-700' : 'text-stone-400 hover:text-stone-600'
                }`}
              >
                <TextAaIcon className="h-4 w-4" weight="regular" aria-hidden />
                <IconTooltip label="Formatting toolbar" />
              </button>
            ) : null}
            {actionsMenu(collapsed)}
          </>
        )}
      />
    );
    // Same seating as the primary: IDE style seats the mode picker at the
    // pill's right end; the Docs style folds the ⋮ in there too.
    const toolbarTrailing = (flags: ToolbarTierFlags) =>
      docsPage ? (
        <>
          {modePicker}
          {actionsMenu(false, flags)}
        </>
      ) : (
        modePicker
      );
    return {
      header,
      showToolbar,
      toolbarFirst: desktopTabs && !docsPage,
      toolbarTrailing,
      readOnly: editorReadOnly,
      toolbarReadOnly: editorReadOnly || !cap.canWrite,
      editMode: (!cap.canWrite || mode === 'suggest' ? 'suggest' : 'edit') as 'edit' | 'suggest',
      canResolveSuggestions: cap.canWrite,
      forceSuggesting: !cap.canWrite,
    };
  };
  // The ONE live chat surface (single useSundialChat instance). Desktop mounts
  // it inside whichever pane shows the active chat tab; mobile mounts it as
  // the legacy sole chat column. `sole` = chat fills the center (arrival).
  // Chat → markdown file. Text parts only: tool calls, reasoning and status
  // rows are transcript chrome, not the conversation worth keeping.
  const downloadChatTranscript = async () => {
    const title = currentChatHeaderTitle || 'Chat';
    const speaker = (role: string) =>
      role === 'user' ? 'You' : currentChatHarness === 'vercel' ? 'Sunny' : CHAT_HARNESS_LABELS[currentChatHarness];
    // The live list is only the loaded window, so a long chat would export
    // silently truncated. Page backwards through the whole history — the route
    // clamps `limit` to 200 per page, so one big request is NOT enough — and
    // fall back to what's on screen if any page fails.
    let messages: TranscriptMessage[] = sundialChat.messages;
    if (currentChatId && !isDraftChatId(currentChatId)) {
      try {
        const collected: ChatMessage[] = [];
        let before: number | null = null;
        // Bounded: 200 pages is 40k messages, far past any real chat, and a
        // broken cursor can't spin here forever.
        for (let page = 0; page < 200; page += 1) {
          const params = new URLSearchParams({ chatId: currentChatId, limit: '200' });
          if (before !== null) params.set('beforeSequence', String(before));
          const res = await apiFetch(`/api/workspace/messages?${params.toString()}`);
          if (!res.ok) throw new Error(`history page failed (${res.status})`);
          const payload = (await res.json()) as {
            messages?: ChatMessage[];
            page?: { hasMore?: boolean; firstSequence?: number | null };
          };
          const batch = payload.messages ?? [];
          collected.unshift(...batch);
          const first = payload.page?.firstSequence ?? null;
          if (!payload.page?.hasMore || batch.length === 0 || first === null || first === before) break;
          before = first;
        }
        // Filter the RAW rows: normalizeChatMessage rewrites every role that
        // isn't system/assistant to 'user', so a stray `role: 'tool'` row (the
        // session loader expects those) would reach the transcript disguised
        // as something you said.
        const full = conversationMessages(
          collected.filter((row) => row.role === 'user' || row.role === 'assistant').map(normalizeChatMessage),
        );
        if (full.length > conversationMessages(messages).length) messages = full;
      } catch {
        /* keep the on-screen window */
      }
    }
    downloadBlob(
      new Blob([buildChatTranscript(title, messages, speaker)], { type: 'text/markdown;charset=utf-8' }),
      `${sanitizeFilename(title) || 'chat'}.md`,
    );
  };

  const renderChatSurface = (sole: boolean) => (
    <WorkspaceChatPane
                    variant="space-side"
                    notice={
                      localEngineNotice ? (
                        <LocalEngineNotice harness={localEngineNotice} onDismiss={dismissLocalEngineNotice} />
                      ) : undefined
                    }
                    composerKey={`${(currentChatId && chatLineageIdRef.current[currentChatId]) || currentChatId || 'no-chat'}:${messageDraftVersion}:chat`}
                    emptyState={
                      // The chat-first landing: greeting + starter prompts. Only when
                      // chat IS the workspace — an empty side chat keeps its quiet
                      // transcript. Gated on message emptiness alone (live + REST
                      // copies): last_message_at is unusable here because drafts
                      // stamp it for sort order, and history loads through
                      // ensureChatMessagesLoaded regardless of what renders, so a
                      // historical chat un-masks the moment its fetch lands.
                      sole &&
                        currentChatMessages.length === 0 &&
                        liveChatMessagesForEdits.length === 0 ? (
                        <ChatArrivalHero
                          agentName={
                            currentChatHarness === 'vercel'
                              ? 'Sunny'
                              : CHAT_HARNESS_LABELS[currentChatHarness]
                          }
                          hasChat={Boolean(currentChatId)}
                          onSendPrompt={(text) => void handleSendMessageRef.current(text, { standalone: true })}
                        />
                      ) : currentChatMessages.length === 0 &&
                        liveChatMessagesForEdits.length === 0 &&
                        !currentChatExternal ? (
                        // Ordinary empty chat: one quiet suggestion chip.
                        <EmptyChatPrompt
                          hasChat={Boolean(currentChatId)}
                          onSendPrompt={(text) => void handleSendMessageRef.current(text, { standalone: true })}
                        />
                      ) : undefined
                    }
                    canWrite={canWrite && !currentChatExternal}
                    currentChatId={currentChatId}
                    footer={
                      currentChatExternal ? (
                        <div
                          data-testid="external-session-banner"
                          className="shrink-0 border-t border-stone-200 bg-stone-50 px-4 py-3 text-xs leading-snug text-stone-600"
                        >
                          <p>Found in {externalAgentLabel(currentChatExternal)}.</p>
                          {externalActionError ? <p className="mt-1 text-red-600">{externalActionError}</p> : null}
                          <div className="mt-2 flex items-center gap-2">
                            {/* One action: importing links the chat to the engine's own
                                session, so continuing it IS resuming — no second button. */}
                            <button
                              type="button"
                              data-testid="external-session-import"
                              disabled={externalActionBusy}
                              onClick={() => void adoptExternalSession(currentChatExternal)}
                              className="rounded-md border border-stone-300 bg-white px-2.5 py-1 font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
                            >
                              {externalActionBusy ? 'Importing…' : 'Import'}
                            </button>
                          </div>
                        </div>
                      ) : undefined
                    }
                    isChatDropActive={isChatDropActive}
                    setIsChatDropActive={setIsChatDropActive}
                    onDropFiles={(droppedFiles) => {
                      if (!currentChatId) return;
                      queueUploads(droppedFiles, 'chat', null, currentChatId);
                    }}
                    streamError={sundialChat.error}
                    reconnecting={sundialChat.reconnecting}
                    interruptError={currentChatId ? interruptErrorByChatId[currentChatId] : undefined}
                    modelDeclined={sundialChat.modelDeclined}
                    beforeContent={null}                    header={
                      // On mobile the chat column is sole and the top bar
                      // already carries the chat identity (assistant picker) —
                      // a second header would just repeat it (same rule as the
                      // editor's doc header).
                      isMobile ? null : (
                      // data-chat-id is the deterministic "which chat is
                      // displayed" signal for smokes (card clicks debounce).
                      // bg-white, not stone: the pane's ACTIVE chat tab is
                      // page-colored and must fuse with this row below it.
                      <div
                        data-chat-id={currentChat?.id}
                        // No bar above (web build / desktop with it hidden):
                        // this header is the top row — h-11 so its controls
                        // center on the rail/cluster line — and it clears the
                        // pinned top-right cluster (a visible chat is always
                        // the rightmost pane in the no-tabs layout), plus,
                        // when sole with the rail collapsed, the floating
                        // Home/Sidebar cluster on the left.
                        className={`relative flex shrink-0 items-center gap-0 bg-white px-3 ${
                          desktopTabs ? 'h-9' : 'h-11'
                        }`}
                        style={
                          !desktopTabs && sole && openLeftRail === null && topbarLeftFloatWidth
                            ? { paddingLeft: topbarLeftFloatWidth }
                            : undefined
                        }
                      >
                        {/* No × in the tabs shell: the chat IS a tab and the
                            tab's own close is the one way to shut it. The
                            no-tabs shell closes each window at its own
                            top-LEFT corner (macOS convention — founder), with
                            the ⋮ chat menu seated right of it; the identity
                            centers on the window (absolute, so the side
                            clusters never push it). */}
                        {desktopTabs ? null : (
                          <button
                            type="button"
                            onClick={closeActiveChatTab}
                            aria-label="Close chat"
                            data-testid="chat-column-close"
                            className="relative group/tip inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                          >
                            <XIcon className="h-4 w-4" weight="regular" aria-hidden />
                            <IconTooltip label="Close" />
                          </button>
                        )}
                        <div
                          className="pointer-events-none absolute inset-y-0 flex items-center justify-center overflow-hidden"
                          // MEASURED obstruction band (the doc header's rule),
                          // asymmetric: a symmetric 2×max reservation starved
                          // the title of the narrow side's free space and, once
                          // negative, spilled the avatar under the pinned
                          // cluster. Left: the × + ⋮ cluster (~76px) plus the
                          // floating nav when sole with the rail collapsed;
                          // right: the pinned cluster while it overlays this
                          // header (no-tabs, dock closed). Tabbed: just the ⋮
                          // at the row end. The title centers in the free band
                          // and truncates before ever reaching either cluster.
                          style={{
                            left: !desktopTabs
                              ? 76 + (sole && openLeftRail === null ? topbarLeftFloatWidth : 0)
                              : 48,
                            right: !desktopTabs
                              ? rightDockView === null
                                ? Math.max(topbarRightWidth, 40) + 8
                                : 12
                              : 48,
                          }}
                        >
                        <div className="pointer-events-auto flex w-fit min-w-0 max-w-full items-center gap-1.5">
                          {currentChatUsesGroupPresentation ? (
                            <GearSixIcon className="h-4 w-4 shrink-0 text-stone-500" weight="regular" aria-hidden />
                          ) : currentChatExternal ? (
                            <ExternalAgentBadge external={currentChatExternal} className="h-5 w-5" />
                          ) : (
                            <span className="flex h-5 w-5 shrink-0 overflow-hidden rounded-full">
                              {/* The ONE default Sunny, never a per-chat variant
                                  (desktop's treatment): the header is identity
                                  chrome, and a rotating face read as a different
                                  product each chat. Variants stay in the playful
                                  surfaces (chat list, assistant bubbles). */}
                              <img
                                src={DEFAULT_SUNNY_AVATAR}
                                alt=""
                                className="h-full w-full object-cover"
                                draggable={false}
                              />
                            </span>
                          )}
                          <div
                            data-testid="chat-header-title"
                            className={`min-w-0 ${renamingHeaderTitle ? 'flex-1' : ''}`}
                            onDoubleClick={() => {
                              if (currentChatId && canWrite && !currentChatExternal && !isDraftChatId(currentChatId)) {
                                setRenamingHeaderTitle(true);
                              }
                            }}
                            title={
                              currentChatId && canWrite && !currentChatExternal && !isDraftChatId(currentChatId) && !renamingHeaderTitle
                                ? 'Double-click to rename'
                                : currentChatHeaderTitle
                            }
                          >
                            <EditableChatTitle
                              className="truncate text-[13px] font-medium text-stone-700"
                              value={currentChatHeaderTitle}
                              initialDraft={currentChat?.title?.trim() || ''}
                              editing={renamingHeaderTitle}
                              onCommit={(next) => {
                                setRenamingHeaderTitle(false);
                                void renameChat(currentChatId ?? '', next);
                              }}
                              onCancel={() => setRenamingHeaderTitle(false)}
                            />
                          </div>
                          {/* Share status rides next to the chat name — a
                              lock while private, the audience glyphs once
                              shared; clicking opens the share surface. Cloud
                              chats inherit the WORKSPACE's audience (the
                              chat link only opens once the workspace is
                              shared); local chats share per-chat. */}
                          {/* Not for external transcripts: their synthetic
                              external:<agent>:<id> ids have no share scope —
                              Import (the banner) comes first. */}
                          {currentChatId && !isDraftChatId(currentChatId) && !currentChatExternal
                            ? (() => {
                                const status = isLocalWorkspace ? 'private' : shareStatus;
                                const Icon =
                                  status === 'public'
                                    ? GlobeHemisphereWestIcon
                                    : status === 'shared'
                                      ? UsersThreeIcon
                                      : LockSimpleIcon;
                                const label =
                                  status === 'public'
                                    ? 'Shared by link'
                                    : status === 'shared'
                                      ? 'Shared with people'
                                      : 'Private · share';
                                return (
                                  <button
                                    type="button"
                                    onClick={openChatShare}
                                    aria-label="Share chat"
                                    data-testid="chat-share-status"
                                    data-share-status={status}
                                    className="relative group/tip inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                                  >
                                    <Icon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                                    <IconTooltip label={label} side="bottom" />
                                  </button>
                                );
                              })()
                            : null}
                          {/* Inline cadence — small muted text when this chat
                              has a schedule; opens the Schedules panel. The
                              header stays ONE line: no chip, no second row. */}
                          {projectId && currentChatId && !isDraftChatId(currentChatId) ? (
                            <ChatHeaderScheduleText
                              projectId={projectId}
                              chatId={currentChatId}
                              refresh={schedulesPanelMode}
                              onOpen={() => setSchedulesPanelMode('list')}
                            />
                          ) : null}
                          {currentChatHasTextTransport ? <TransportBadge label="text" /> : null}
                        </div>
                        </div>
                        {/* Right: the chat's ⋮ menu — mirrors the sidebar
                            chat-row ⋮ for the open chat (founder). New chat
                            lives in the pane strip's ＋ and the sidebar's
                            "New chat" row, not here. */}
                        <div
                          ref={chatHeaderMenuWrapRef}
                          className={`flex shrink-0 items-center gap-1 ${desktopTabs ? 'ml-auto' : ''}`}
                        >
                          {/* No menu for external-agent transcripts (synthetic
                              external:<agent>:<id> ids, read-only until
                              imported) — same suppression as their sidebar
                              rows; the Import banner is their one action. */}
                          {currentChat && currentChatId && !currentChatExternal ? (
                            <>
                              <button
                                ref={chatHeaderMenuTriggerRef}
                                type="button"
                                onClick={() => setChatHeaderMenuOpen((value) => !value)}
                                aria-label="Chat actions"
                                aria-haspopup="menu"
                                aria-expanded={chatHeaderMenuOpen}
                                data-testid="chat-header-menu"
                                className={`relative group/tip inline-flex h-7 w-7 items-center justify-center rounded hover:bg-stone-100 ${
                                  chatHeaderMenuOpen ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'
                                }`}
                              >
                                <DotsThreeVerticalIcon className="h-4 w-4" weight="bold" aria-hidden />
                                <IconTooltip label="Chat actions" open={chatHeaderMenuOpen} />
                              </button>
                              <AnchoredDropdown
                                open={chatHeaderMenuOpen}
                                anchorRef={chatHeaderMenuTriggerRef}
                                // The trigger sits at the window's LEFT corner
                                // in the no-tabs shell — hug that edge there.
                                align={desktopTabs ? 'right' : 'left'}
                                className="w-44 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setChatHeaderMenuOpen(false);
                                    setChatDetailsChatId(currentChatId);
                                  }}
                                  className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                                >
                                  View details
                                </button>
                                {/* Every edit this chat ever made, as one flat
                                    diff (tabs-only surface). */}
                                {!isMobile && !isDraftChatId(currentChatId) ? (
                                  <button
                                    type="button"
                                    data-testid="chat-header-view-edits"
                                    onClick={() => {
                                      setChatHeaderMenuOpen(false);
                                      handleOpenChatEdits(currentChatId);
                                    }}
                                    className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                                  >
                                    View all edits
                                  </button>
                                ) : null}
                                {canWrite && !currentChatExternal && !isDraftChatId(currentChatId) ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setChatHeaderMenuOpen(false);
                                      setRenamingHeaderTitle(true);
                                    }}
                                    className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                                  >
                                    Rename
                                  </button>
                                ) : null}
                                {!isDraftChatId(currentChatId) ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setChatHeaderMenuOpen(false);
                                      void handleCopyChatLink(currentChatId);
                                    }}
                                    className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                                  >
                                    {copiedChatLinkId === currentChatId ? 'Copied link' : 'Copy chat link'}
                                  </button>
                                ) : null}
                                {canWrite && !isDraftChatId(currentChatId) ? (
                                  <button
                                    type="button"
                                    data-testid="chat-header-watch-comments"
                                    onClick={() => {
                                      setChatHeaderMenuOpen(false);
                                      // Whole-workspace watch; a narrower path is set by the agent.
                                      void setCommentWatch(currentChatId, currentChat.comment_watch_path ? null : '*');
                                    }}
                                    className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                                  >
                                    {currentChat.comment_watch_path ? 'Stop watching comments' : 'Watch comments'}
                                  </button>
                                ) : null}
                                {sundialChat.messages.length > 0 ? (
                                  <button
                                    type="button"
                                    data-testid="chat-header-download-transcript"
                                    onClick={() => {
                                      setChatHeaderMenuOpen(false);
                                      void downloadChatTranscript();
                                    }}
                                    className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                                  >
                                    Download transcript
                                  </button>
                                ) : null}
                                {user?.id && !isDraftChatId(currentChatId) ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setChatHeaderMenuOpen(false);
                                      void toggleChatPin(currentChatId, !isChatPinned(currentChat));
                                    }}
                                    className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                                  >
                                    {isChatPinned(currentChat) ? 'Unpin chat' : 'Pin chat'}
                                  </button>
                                ) : null}
                                {canManageChat(canWrite, currentChatId)
                                  ? (() => {
                                      // THIS chat's archive state (the outer
                                      // isArchived is the workspace's).
                                      const chatArchived = Boolean(currentChat.archived_at);
                                      return (
                                        <>
                                          <button
                                            type="button"
                                            data-testid="chat-header-archive"
                                            onClick={() => {
                                              setChatHeaderMenuOpen(false);
                                              void toggleChatArchive(currentChatId, !chatArchived);
                                            }}
                                            className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                                          >
                                            {chatArchived ? 'Unarchive chat' : 'Archive chat'}
                                          </button>
                                          <button
                                            type="button"
                                            data-testid="chat-header-delete"
                                            onClick={() => {
                                              setChatHeaderMenuOpen(false);
                                              setChatPendingDelete({ id: currentChatId, title: currentChat.title ?? null });
                                            }}
                                            className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                                          >
                                            Delete chat
                                          </button>
                                        </>
                                      );
                                    })()
                                  : null}
                              </AnchoredDropdown>
                            </>
                          ) : null}
                        </div>
                      </div>
                      )
                    }
                    transcriptProps={{
                      hasAssistant: Boolean(currentChatId),
                      assistantGreeting,
                      showGreeting: Boolean(assistantGreeting && !currentChat?.last_message_at && currentChatMessages.length === 0),
                      messages: sundialChat.messages,
                      // A send/start failure means NO run exists, and a hard
                      // stream-open failure means this window can't watch one
                      // — showing "Thinking…" beside either quiet notice
                      // would contradict it (Codex rounds 12 + 21).
                      showWorkingIndicator:
                        showWorkingIndicator &&
                        !(
                          sundialChat.error &&
                          (isSendStartFailure(sundialChat.error) ||
                            isHardStreamOpenFailure(sundialChat.error))
                        ),
                      turnLinkBase: currentChatId && typeof window !== 'undefined'
                        ? `${window.location.origin}${buildWorkspaceChatPath(workspaceRouteId, currentChatId)}`
                        : undefined,
                      onTurnLinkShareGate: chatShareReady ? undefined : openChatShare,
                      highlightedDiffId: deepLinkedDiffId,
                      scrollToBottomRef: scrollChatToBottomRef,
                      isStreaming:
                        sundialChat.status === 'streaming' ||
                        sundialChat.status === 'submitted',
                      onOpenTurnDiff: isMobile ? undefined : handleOpenTurnDiff,
                      knownFilePaths: mentionableFilePaths,
                      workspaceId: projectId,
                      onOpenWikiFile: handleOpenEditedFileInline,
                      onOpenEditedFile: handleOpenFileFromEditCard,
                      attachmentHref: localAttachmentHref,
                    }}
                    composerProps={{
                      chatId: currentChatId,
                      showGroupChatUi: currentChatUsesGroupPresentation,
                      hasAssistant: Boolean(currentChatId),
                      // The brain has no per-path rails yet — it 403s scoped
                      // guests server-side, so disable the composer with a
                      // clear notice instead of a dead send. Same for ANY
                      // read-only visitor (public view links, chat-share
                      // mirrors): /api/workspace/messages 403s them. Gated on
                      // filesLoaded — canWrite optimistically starts true.
                      disabledNotice: isScopedGuest || (!canWrite && filesLoaded)
                        ? 'Chatting with Sunny isn’t available for shared-access guests yet'
                        : null,
                      initialValue: currentChatId ? (messageInputByChatIdRef.current[currentChatId] ?? '') : '',
                      textareaRef: chatInputRef,
                      shouldFocus: shouldFocusChatInput,
                      onFocusHandled: () => setShouldFocusChatInput(false),
                      onDraftChange: handleComposerDraftChange,
                      onAction: handleChatAction,
                      attachments: currentAttachments,
                      onRemoveAttachment: (attachment) => {
                        if (!currentChatId) return;
                        removeChatAttachment(currentChatId, attachment);
                      },
                      contextSnippets: currentContextSnippets,
                      onRemoveContextSnippet: (snippetId) => {
                        if (!currentChatId) return;
                        removeContextSnippet(currentChatId, snippetId);
                      },
                      uploads: chatUploads,
                      onRemoveUpload: removeUpload,
                      onAttachFiles: (files) => {
                        if (files.length === 0) return;
                        queueUploads(files, 'chat', null, currentChatId ?? undefined);
                      },
                      onOpenEditedFile: handleOpenEditedFileInline,
                      // Only advertise the open file when it still resolves to a
                      // real file — a collaborator/agent delete refreshes the file
                      // list without clearing selectedFilePath, so
                      // effectiveOpenFilePath can go stale. Display-only; what's
                      // sent to the agent is unchanged.
                      openFilePath: activeWorkspaceFile ? effectiveOpenFilePath : null,
                      // "New chat in this folder" scopes the chat server-side
                      // (chats.folder_scope); the composer shows it as a chip so
                      // the scope is visible without living in the draft text.
                      folderScope: currentChat?.folder_scope ?? null,
                      // Sunny listens to new comments on this path — the chip
                      // makes the standing watch visible (and clearable).
                      commentWatchPath: currentChat?.comment_watch_path ?? null,
                      onClearCommentWatch: currentChatId
                        ? () => void setCommentWatch(currentChatId, null)
                        : undefined,
                      // `/watch [all]` and `/unwatch` in the composer. A draft
                      // chat has no row to PATCH yet, so it gets no handler.
                      onCommentWatchCommand:
                        currentChatId && !isDraftChatId(currentChatId)
                          ? (path: string | null) => void setCommentWatch(currentChatId, path)
                          : undefined,
                      mentionableFiles,
                      connectedApps,
                      connectedAppsLoading,
                      showAppsPicker,
                      setShowAppsPicker,
                      appsPickerRef,
                      currentChatId,
                      reloadConnectedApps: loadConnectedApps,
                      showModelPicker,
                      setShowModelPicker,
                      currentChatModel,
                      onSelectChatRuntime: handleSelectChatRuntime,
                      modelPickerRef,
                      harness: currentChatHarness,
                      onSelectHarness: handleSelectChatHarness,
                      localEngines: isLocalWorkspace
                        ? { claude: localEngines.claude, codex: localEngines.codex }
                        : null,
                      // Locked the moment the conversation has ANY message.
                      // The summary's message_count covers the reload window
                      // before the transcript loads; the live list covers the
                      // first send before the summary refreshes.
                      harnessLocked:
                        isLocalWorkspace &&
                        (liveChatMessagesForEdits.length > 0 || (currentChat?.message_count ?? 0) > 0),
                      onNewChatWithHarness: canWrite ? startChatWithHarness : undefined,
                      models,
                      modelsLoading,
                      modelsEmptyReason,
                      isVoiceSupported,
                      isVoiceListening,
                      toggleVoice,
                      isChatInterruptible,
                      chatUploadsInFlight,
                      sendActionTitle,
                      editMode: chatEditMode,
                      onEditModeChange: handleChatEditModeChange,
                    }}
                  />
  );

  // ＋ opens the New-tab chooser in ITS OWN pane — the same surface as ⌘T
  // (Obsidian: every new-tab affordance lands on the "what goes here?" tab).
  // Shown to read-only visitors too: the panel itself gates its picks, and
  // "Open file" is always available.
  const renderNewTabLauncher = (paneId: string) => (
    <button
      type="button"
      onClick={() => {
        lastFocusedPaneIdRef.current = paneId;
        setEditorPanes((prev) => openPaneTab(prev, paneId, LAUNCHER_TAB));
      }}
      aria-label="New tab"
      data-testid="new-tab-launcher"
      className="relative group/tip ml-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center self-center rounded text-stone-400 hover:bg-stone-200/60 hover:text-stone-600"
    >
      <PlusIcon className="h-4 w-4" weight="bold" aria-hidden />
      <IconTooltip label="New tab" />
    </button>
  );

  // The ⌘T "New tab" body (Obsidian-style): a centered chooser for what fills
  // this tab. Every pick routes through a pane-model path that CONSUMES the
  // active launcher tab in place (openTab/replaceActiveTab), so the chosen
  // thing lands in this tab, not beside it.
  const launcherOption = (
    testId: string,
    label: string,
    onPick: () => void,
    shortcut?: string,
  ) => (
    <button
      type="button"
      data-testid={testId}
      onClick={onPick}
      className="flex items-center gap-2 text-[15px] text-stone-500 transition-colors hover:text-stone-800"
    >
      {label}
      {shortcut ? (
        <span className="rounded border border-stone-200 px-1 py-px text-[11px] text-stone-400">
          {shortcut}
        </span>
      ) : null}
    </button>
  );
  const renderLauncherPanel = (paneId: string) => (
    <div
      data-testid="new-tab-panel"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4"
    >
      {/* Gated on the ACTUAL create capability for this pane's folder context
          — path-share editors have folder edit grants without workspace-wide
          canWrite, and createFileAndOpen would let them create here. */}
      {canUploadToFolder(createParentForPane(editorPanes.find((p) => p.id === paneId)))
        ? launcherOption('new-tab-create-file', 'Create new file', () => void createFileAndOpen(paneId), '⌘N')
        : null}
      {launcherOption(
        'new-tab-open-file',
        'Open file',
        () => {
          setPaletteTargetPaneId(paneId);
          setCommandPaletteOpen(true);
        },
        '⌘O',
      )}
      {canWrite
        ? launcherOption('new-tab-new-chat', 'New chat', () =>
            void startAssistantChat(null, null, { forceNew: true, keepMode: true, appendTab: true, paneId }),
          )
        : null}
      {/* Same gating as the palette action: local workspaces ARE the local
          agent surface — nothing to connect. */}
      {canWrite && !isLocalWorkspace
        ? launcherOption('new-tab-connect-agent', 'Connect local agent', () => void openLocalAgentModal())
        : null}
    </div>
  );

  // "This chat's edits" as a tab: ONE flat diff on white — the same look as the
  // turn diff, chat-wide. The timeline (rows, filters, gray dock styling) is a
  // right-dock tool only; center surfaces read as documents (2026-08-04
  // founder direction).
  // No-tabs shell: these surfaces carry their own × (no strip to close from).
  const closeSpecialSurface = (tab: string) =>
    void applyPaneTransition((prev) => {
      const pane = prev.find((p) => p.active === tab);
      return pane ? closePaneTab(prev, pane.id, tab) : { panes: prev };
    });
  // The floating Home/Sidebar cluster sits over the LEFTMOST pane's top-left
  // corner when the rail is collapsed — a surface whose × lives there shifts
  // past it, same measure the chat header and file view use.
  const leftmostPaneInset = openLeftRail === null ? topbarLeftFloatWidth : 0;

  const renderChatEditsSurface = (tab: string, headerInsetLeft = 0) => {
    const scopedChatId = reviewChatIdOfTab(tab);
    if (!scopedChatId) return null; // unscoped review tabs are no longer creatable
    return (
      <ChatDiffPanel
        key={tab}
        chatId={scopedChatId}
        workspaceId={cloudProjectId}
        onOpenFile={handleOpenFileFromEditCard}
        onClose={desktopTabs ? undefined : () => closeSpecialSurface(tab)}
        headerInsetLeft={headerInsetLeft}
        refreshToken={pendingEditsInvalidationToken}
      />
    );
  };

  // One turn's edits as a tab — the same card the chat transcript renders, so
  // the two surfaces can never drift in styling.
  const renderDiffSurface = (tab: string, headerInsetLeft = 0) => {
    const assistantMessageId = diffIdOfTab(tab);
    if (!assistantMessageId) return null;
    return (
      <TurnDiffPanel
        key={tab}
        assistantMessageId={assistantMessageId}
        workspaceId={cloudProjectId}
        onOpenFile={handleOpenFileFromEditCard}
        onClose={desktopTabs ? undefined : () => closeSpecialSurface(tab)}
        headerInsetLeft={headerInsetLeft}
      />
    );
  };

  // Home + sidebar toggle live in the rail's top row while it's open, and at
  // the left end of the single top bar while it's collapsed — one bar total.
  // The desktop app's one home is /local (local projects + cloud workspaces
  // together) — cloud workspaces opened in the shell go back there too.
  const shellNavControls = (
    <ShellNavControls
      homeHref={isLocalWorkspace || isDesktopApp ? '/local' : '/dashboard'}
      onNavigateHome={() => persistLayoutConfig()}
      sidebarOpen={openLeftRail !== null}
      onToggleSidebar={toggleSidebar}
    />
  );
  // The collapsed-rail FLOAT in the Docs style: the sidebar toggle alone.
  // Google Docs has one mark in that corner, and even Home read as app
  // chrome floating over the page (founder) — Home rides the rail the
  // toggle reveals. The rail's own top row and the tabs strip keep the
  // full pair; the IDE float does too.
  const floatNavControls = panelViewActive ? (
    // Embedded panel: Home keeps its top corner (founder 2026-08-26); the
    // sidebar toggle stays shed — Files in the bottom switcher opens the rail.
    <ShellNavControls
      homeHref={isLocalWorkspace || isDesktopApp ? '/local' : '/dashboard'}
      sidebarOpen={openLeftRail !== null}
      onToggleSidebar={toggleSidebar}
      homeOnly
    />
  ) : docsPage ? (
    <ShellNavControls
      homeHref={isLocalWorkspace || isDesktopApp ? '/local' : '/dashboard'}
      onNavigateHome={() => persistLayoutConfig()}
      sidebarOpen={openLeftRail !== null}
      onToggleSidebar={toggleSidebar}
      minimal
    />
  ) : (
    shellNavControls
  );

  // The rail's top row carries Home + the sidebar toggle (the rail reaches
  // the window top — in the desktop shell it clears the macOS traffic
  // lights), with the ⌘K search bar below. The workspace identity moved down
  // into the Files section header (founder: the project name + picker sit
  // where the "Files" label was).
  const workspaceTitleControl = (
    <SidebarTopChrome
      navControls={shellNavControls}
      desktopPad={isDesktopApp}
      onOpenSearch={() => {
        setPaletteTargetPaneId(null);
        setCommandPaletteOpen(true);
      }}
    />
  );

  // The Files-section header slot: the root's identity — icon + name, no
  // dropdown (Home in the top chrome is the way back). Icon says what the
  // root IS: a stack for multi-folder workspaces, the local/cloud origin
  // glyph when the root is a single folder. Double-click still renames;
  // right-click opens the old workspace menu (rename / new / archive…).
  const primaryRootName = localRoots.find((entry) => !entry.prefix)?.name ?? null;
  const hasExtraRoots = localRoots.some((entry) => entry.prefix);
  const workspaceLabel = workspaceTitleLabel(projectTitle, primaryRootName, hasExtraRoots);
  // The root's kind glyph — shared by the rail identity header and the
  // mobile/collapsed headers so every screen size says the same thing.
  const workspaceKindIcon = hasExtraRoots ? (
    <StackSimpleIcon className="h-3.5 w-3.5 shrink-0 text-stone-400" weight="regular" aria-hidden />
  ) : isLocalWorkspace ? (
    <LocalRootGlyph className="h-3.5 w-3.5 shrink-0 text-stone-400" />
  ) : (
    <CloudIcon className="h-3.5 w-3.5 shrink-0 text-stone-400" weight="regular" aria-hidden />
  );
  // pl-1: the section header sits at px-3 (12px) while tree rows start at
  // 16px (px-2 scroller + px-2 row) — this lines the icon up with the rows.
  const workspaceIdentityHeader = (
    <div
      className="flex min-w-0 flex-1 items-center gap-1 pl-1"
      ref={workspaceSwitcherRef}
      data-workspace-switcher-trigger
      onContextMenu={(e) => {
        e.preventDefault();
        toggleWorkspaceSwitcher();
      }}
    >
      {isEditingTitle && canWrite ? (
        <input
          autoFocus
          size={Math.max(editingTitleValue.length + 1, 2)}
          className="min-w-0 max-w-[240px] bg-transparent text-[13px] font-semibold text-stone-700 outline-none"
          value={editingTitleValue}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setEditingTitleValue(e.target.value)}
          onBlur={() => saveProjectTitle(editingTitleValue)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveProjectTitle(editingTitleValue);
            } else if (e.key === 'Escape') {
              setIsEditingTitle(false);
            }
          }}
          maxLength={200}
        />
      ) : (
        <span
          className="flex min-w-0 items-center gap-1.5 text-left text-[13px] font-semibold text-stone-700"
          // The title is identity, not blank header area — clicking it must
          // not collapse the section (click renames, right-click = menu).
          onClick={(e) => {
            e.stopPropagation();
            startProjectTitleEdit();
          }}
          title={
            canWrite
              ? `${workspaceLabel}. Click to rename, right-click for options.`
              : workspaceLabel
          }
        >
          <span className="relative flex shrink-0 items-center">
            {workspaceKindIcon}
            <IconTooltip
              label={
                hasExtraRoots
                  ? 'Workspace · multiple folders'
                  : isLocalWorkspace
                    ? 'Local folder · on this device'
                    : 'Cloud workspace'
              }
              align="left"
            />
          </span>
          <span className="truncate" data-testid="workspace-identity-label">
            {workspaceLabel}
          </span>
        </span>
      )}
      {archivedTag}
      {/* Clicks inside the (right-click) switcher menu bubble through the
          React tree — they must not collapse the section. */}
      <span onClick={(e) => e.stopPropagation()}>{workspaceSwitcherMenu}</span>
    </div>
  );

  // Right end of the single top bar (collaborators · right dock · Share) —
  // pinned at the window's absolute top-right, independent of pane count,
  // dock state, or special views. The strip rows beneath reserve its
  // measured width as right padding.
  const topBarRightControls = (
    <div
      ref={topbarRightRef}
      // Bar chrome (border + fill) only while a bar row runs beneath it — the
      // primary strip, or the dock's icon strip. With no bar (web build /
      // desktop with it hidden, dock closed) the cluster floats bare over the
      // header rows, which reserve its measured width as right padding.
      className={`absolute right-0 top-0 z-30 flex h-11 shrink-0 items-center gap-3 pl-2 pr-3 print:hidden ${
        desktopTabs || rightDockView !== null ? 'border-b border-stone-200/60 bg-stone-100/70' : ''
      } ${
        // During a tab drag this z-30 cluster otherwise swallows dragover in
        // the top-right corner (it has no drag handlers), flipping the cursor
        // to no-drop and killing the pane drop preview around the right-panel
        // icon. pointer-events-none lets the drag fall through to the strip
        // and overlay beneath — and keeps its tooltips from popping mid-drag.
        editorTabDragActive ? 'pointer-events-none' : ''
      }`}
      data-testid="topbar-right"
      {...(isDesktopApp ? { 'data-tauri-drag-region': '' } : {})}
    >
              {showOffline && (
                <span data-testid="workspace-offline-banner" className="text-xs font-medium text-stone-900">Offline</span>
              )}
              {/* Collaborators + Assistants. Skipped entirely when empty — an
                  empty stack still costs a gap-3 slot, which the doc header
                  mirrors as dead space right of its controls. */}
              {visibleCollaborators.length || activeAssistantBubbles.length ? (
              <div className="flex -space-x-2">
                {/* Human collaborators */}
                {visibleCollaborators.map((c, i) => {
                  if (c.kind === 'local-agent') {
                    const brand = brandForAgentId(c.agentId);
                    return (
                      <AgentBubble
                        key={`collab-${i}`}
                        emoji={brand.label}
                        name={`${brand.displayName} (${c.name})`}
                        imageUrl={brand.logoPath ?? c.imageUrl}
                        size="md"
                        onClick={() => {
                          setLocalAgentModeOptimistic(null);
                          setLocalAgentModeError(null);
                          setLocalAgentModeAgentId(c.agentId ?? null);
                        }}
                        statusDotClassName="animate-pulse"
                        statusDotStyle={{ backgroundColor: brand.color }}
                        bubbleBackgroundColor={brand.logoPath ? '#ffffff' : brand.color}
                        bubbleBorderColor={brand.logoPath ? brand.color : undefined}
                        imagePadding={brand.logoPath ? 6 : undefined}
                      />
                    );
                  }
                  const label = c.username
                    ? c.name && c.name !== c.username
                      ? `${c.name} (@${c.username})`
                      : `@${c.username}`
                    : c.name;
                  return (
                    <HumanBubble
                      key={`collab-${i}`}
                      id={c.id}
                      name={c.name}
                      imageUrl={c.imageUrl}
                      initials={c.initials}
                      label={label}
                      color={c.color}
                      size="md"
                      // Jump to this collaborator: open their broadcast file
                      // and center their live caret.
                      onClick={() => jumpToCollaborator(c)}
                    />
                  );
                })}
                {/* Assistants */}
                {activeAssistantBubbles.map((entry, i) => {
                  const status = effectiveChatStatus(entry.chat.id);
                  const bubbleEmoji = '☀️';
                  const bubbleName = getChatModelLabel(entry.chat.model, 'Model');
                  // Brand the bubble by the chat's harness/model (Claude,
                  // Codex, Gemini…) — the Sunny avatar (keyed by
                  // sunny_number like the chat list) is the fallback for
                  // models without a brand icon.
                  const brand = getAssistantBrand(entry.chat.model, entry.chat.harness);
                  const bubbleImage = brand
                    ? null
                    : sunnyAvatarByChatId.get(entry.chat.id) ?? DEFAULT_SUNNY_AVATAR;
                  return (
                    <AgentBubble
                      key={`assistant-${entry.chat.id}-${i}`}
                      emoji={bubbleEmoji}
                      imageUrl={bubbleImage}
                      icon={brand ? <brand.Icon className="h-4 w-4" /> : undefined}
                      name={bubbleName}
                      size="md"
                      onClick={() => selectChat(entry.index, { focusComposer: true })}
                      statusDotClassName={status !== 'idle' ? getAssistantStatusDotClass(status) : undefined}
                      bubbleBackgroundColor={brand ? '#ffffff' : undefined}
                      bubbleTextColor={brand?.color}
                      bubbleBorderColor={brand?.color}
                    />
                  );
                })}
              </div>
              ) : null}

              {/* Per-document controls (mode picker, comments toggle, Share
                  file, raw toggle, toolbar toggle) moved into the document
                  pane itself — see [topbar-doc-controls] in the primary
                  pane. */}

              {/* Right dock (PR #907 right panel): History + Outline. ONE
                  toggle here opens/closes it; the view switchers live in the
                  dock's own icon strip (founder: buttons that change the
                  panel belong ON the panel). */}
              {!isMobile ? (
                <div className="flex items-center gap-1">
                  {/* One scale everywhere (h-8 / h-5): this cluster mirrors
                      the top-LEFT sidebar toggle, and the two panel icons at
                      different sizes read as a mistake (founder, 2026-08-05)
                      — items-center keeps the row's centers aligned even
                      where the neighbors are h-7. */}
                  {/* Comments toggle — left of the right-panel toggle
                      (Belinda, 2026-08-07: Google Docs' comment corner).
                      Same zero-comments gate as the mobile copy. */}
                  {activeFileCommentCount > 0 ? (
                    <button
                      type="button"
                      onClick={toggleCommentLane}
                      aria-pressed={commentsLaneToggled}
                      aria-label="Comments"
                      data-testid="doc-comments-toggle"
                      className={`relative group/tip inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-stone-100 ${
                        commentsLaneToggled ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'
                      }`}
                    >
                      <ChatTextIcon
                        className="h-5 w-5"
                        weight={commentsLaneToggled ? 'fill' : 'regular'}
                        aria-hidden
                      />
                      {commentBadgeCount > 0 ? (
                        <span className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-white bg-[#e7c49e] px-1 text-[9px] font-semibold text-[#634a31]">
                          {Math.min(commentBadgeCount, 9)}
                        </span>
                      ) : null}
                      <IconTooltip label="Comments" />
                    </button>
                  ) : null}
                  {panelViewActive ? null : (
                  <button
                    type="button"
                    data-testid="right-dock-toggle"
                    onClick={() =>
                      rightDockView !== null ? closeRightDock() : openRightDock(rightDockLastViewRef.current)
                    }
                    aria-pressed={rightDockView !== null}
                    aria-label="Toggle right panel"
                    className={`relative group/tip inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-stone-100 ${
                      rightDockView !== null ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'
                    }`}
                  >
                    <SidebarSimpleIcon
                      className="h-5 w-5 -scale-x-100"
                      weight="regular"
                      aria-hidden
                    />
                    <IconTooltip label="Toggle right panel" />
                  </button>
                  )}
                </div>
              ) : null}
              {/* Share (back after PR #1038 — founder review 2026-08-04):
                  scope picked on the way in — active file, its folder, or the
                  workspace — each routing to the modal that owns that scope.
                  Scoped ?pshare= guests get no button: both share endpoints
                  403 for them (same gate as the doc header's share). */}
              {canShowShareControls && !isScopedGuest ? (
                <TopbarShareButton
                  shareStatus={isLocalWorkspace ? null : shareStatus}
                  // Scopes follow the FOCUSED pane's on-screen file (null on
                  // chat-only surfaces, the commit diff view, and background
                  // tabs → plain workspace share). See topbarSharePlan.
                  fileName={topbarSharePlan.fileName}
                  folderPath={topbarSharePlan.parentDir}
                  onShareFile={topbarSharePlan.onShareFile}
                  onShareFolder={topbarSharePlan.onShareFolder}
                  onShareWorkspace={openShare}
                />
              ) : null}
    </div>
  );

  // THE Docs doc-header render condition (the header JSX gates on this too —
  // one source, so the float suppression below can't drift from it). Header
  // showing = the header row seats the collapsed-rail sidebar toggle itself
  // (in-flow, leading the file glyph), so the window-corner float stays
  // suppressed.
  const docsHeaderOwnsTopLeft =
    !isMobile &&
    docsPage &&
    activeIsMarkdown &&
    Boolean(activeWorkspaceFile) &&
    !primaryChatActive &&
    !primaryLauncherActive &&
    !primaryReviewActive &&
    !primaryDiffActive;
  // No-bar layout with the rail collapsed: Home + the sidebar toggle would
  // have no home (their bar seat is gone), so they float bare at the window's
  // top-left — the mirror of the pinned top-right cluster. Keeps the macOS
  // traffic-light clearance + a drag strip in the desktop shell.
  const topBarLeftFloat = (
    <div
      ref={topbarLeftFloatRef}
      data-testid="topbar-float-nav"
      className={`absolute left-0 top-0 z-30 flex h-11 items-center gap-1.5 pr-2 print:hidden ${
        isDesktopApp ? 'pl-[calc(72px/var(--sd-zoom,1))]' : 'pl-2'
      }`}
      {...(isDesktopApp ? { 'data-tauri-drag-region': '' } : {})}
    >
      {floatNavControls}
    </div>
  );

  // First visible paint waits for the pane-snapshot restore too (one effect
  // pass after filesLoaded): the frame that fades in already shows the right
  // pane owner — restored tabs, or the chat-first arrival — never a
  // preselected document that a later commit swaps out.
  const workspaceShellReady =
    layoutConfigReady && filesLoaded && (!projectId || panesRestoredFor === projectId);
  // `/new` first paints the generic route skeleton. Once the workspace shell
  // itself is ready, keep the SAME creation card over its real editor skeleton
  // until the seeded TeX Y.Doc has hydrated — no spinner-only gap between the
  // two loading stages.
  const onboardingWorkspaceLoading =
    onboardingTexIntent &&
    workspaceFileByPath.has(WELCOME_TEX_PATH) &&
    (activeWorkspaceFile?.path !== WELCOME_TEX_PATH || !fileContentReady);

  return (
    // Data-plane context: local workspaces route deep components' /api/workspace
    // reads (Review panel, compare, labels) through the sidecar-emulated fetch.
    <ApiFetchProvider value={apiFetch}>
    {!workspaceShellReady && (
      // The workspace below stays opacity-0 until the file list arrives — on a
      // big local folder that walk takes a while, so show progress instead of
      // a blank white page.
      <div className="fixed inset-0 z-50" data-testid="workspace-loading-overlay">
        {onboardingTexIntent ? (
          <WorkspaceRouteLoading creating />
        ) : (
          <div className="flex h-full items-center justify-center bg-white" role="status">
            <div className="flex flex-col items-center gap-3">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-stone-200 border-t-stone-500" aria-hidden />
              <span className="text-sm text-stone-400">Loading project…</span>
            </div>
          </div>
        )}
      </div>
    )}
    {workspaceShellReady && onboardingWorkspaceLoading ? <WorkspaceCreationOverlay fixed /> : null}
    {/* h-dvh, not h-screen: 100vh on iOS Safari is the LARGE viewport (URL
        bar collapsed), so with the toolbars visible the app laid out ~100px
        taller than the visible area — the composer sat behind Safari's bottom
        bar, and once iOS scrolled the window (keyboard focus) the top bar
        went off-screen instead. dvh tracks the visible viewport. */}
    <div className={`h-dvh bg-white flex flex-col transition-opacity duration-300 ${workspaceShellReady ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
      <div className="flex-1 flex overflow-hidden">
        {/* Main content area */}
        <div
          ref={mainContentRef}
          // Flat document shell: the content column is white so the doc
          // renders directly on the panel (no gray field around a boxed page).
          className="flex-1 flex flex-col min-w-[300px] bg-white"
        >
          {/* Main header */}
          {isMobile ? (
          // In the macOS shell this bar is the topmost chrome at narrow
          // widths (the desktop tab strip is !isMobile-gated), so it takes
          // over the traffic-light inset and the window drag region. The
          // attribute rides on the left group too: Tauri only starts a drag
          // when the mousedown target itself carries it, and the flex-1
          // group owns the empty stretch beside the title.
          <div
            className={`h-12 px-3 flex items-center justify-between shrink-0 ${isDesktopApp ? 'pl-[calc(72px/var(--sd-zoom,1))]' : ''}`}
            {...(isDesktopApp ? { 'data-tauri-drag-region': '' } : {})}
          >
            <>
              <div
                className="flex items-center gap-1.5 min-w-0 flex-1"
                {...(isDesktopApp ? { 'data-tauri-drag-region': '' } : {})}
              >
                {/* ONE sidebar toggle (founder: side panel view, not separate
                    chat/files icons) — opens the unified panel: files tree +
                    chats, mirroring the desktop rail. */}
                <button
                  onClick={() => setMobilePanel('files')}
                  aria-label="Toggle sidebar"
                  data-testid="mobile-sidebar-toggle"
                  className="relative group/tip p-2 -ml-1 rounded-lg hover:bg-stone-100 text-stone-400 shrink-0"
                >
                  <SidebarSimpleIcon className="w-5 h-5" weight="regular" aria-hidden />
                  <IconTooltip label="Sidebar" />
                </button>
                {/* No back arrow here (founder: too many options) — the Chats
                    toggle two icons over is the way back to the chat. */}
                {/* mobilePanel guard: while the files drawer is open, ITS
                    header hosts the rename input — a second autofocused copy
                    here would steal focus back and forth, and the loser's
                    blur commits the rename, unmounting both instantly. */}
                {isEditingTitle && canWrite && mobilePanel !== 'files' ? (
                  <div className="flex items-center gap-1 min-w-0 flex-1">
                    <input
                      autoFocus
                      className="w-full min-w-0 bg-transparent text-sm font-medium text-stone-700 outline-none"
                      value={editingTitleValue}
                      onChange={(e) => setEditingTitleValue(e.target.value)}
                      onBlur={() => saveProjectTitle(editingTitleValue)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          saveProjectTitle(editingTitleValue);
                        } else if (e.key === 'Escape') {
                          setIsEditingTitle(false);
                        }
                      }}
                      maxLength={200}
                    />
                    {archivedTag}
                  </div>
                ) : isChatMode ? (
                  <div className="relative min-w-0" ref={assistantPickerRef}>
                    <button
                      type="button"
                      onClick={showAssistantDropdown}
                      aria-haspopup="menu"
                      aria-expanded={showAssistantPicker}
                      // max-w-full (like the workspace-switcher trigger): the
                      // wrapper is a plain block div, so the content-sized
                      // button ignored its width — a long chat title pushed
                      // the caret out over the workspace-menu cloud icon.
                      className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors ${assistantPickerTriggerClassName}`}
                    >
                      {currentChatUsesGroupPresentation ? (
                        <>
                          <GearSixIcon className="h-4 w-4 shrink-0 text-stone-500" weight="regular" aria-hidden />
                          <span className="truncate text-sm font-medium text-stone-700">{currentChatLabel}</span>
                          {currentChatHasTextTransport ? <TransportBadge label="text" /> : null}
                        </>
                      ) : currentChatId ? (
                        <>
                          <span className="flex h-5 w-5 shrink-0 overflow-hidden rounded-full">
                            {/* Mobile's stand-in for the chat header — same rule:
                                the ONE default Sunny, not a per-chat variant. */}
                            <img
                              src={DEFAULT_SUNNY_AVATAR}
                              alt=""
                              className="h-full w-full object-cover"
                              draggable={false}
                            />
                          </span>
                          <span className="text-sm font-medium text-stone-700 truncate">{currentChatHeaderTitle}</span>
                          {currentChatHasTextTransport ? <TransportBadge label="text" /> : null}
                        </>
                      ) : chatsLoaded ? (
                        <span className="text-sm text-stone-500">New chat</span>
                      ) : null}
                      <CaretDownIcon className="w-3 h-3 text-stone-400 shrink-0" weight="bold" aria-hidden />
                    </button>
                    {showAssistantPicker ? renderAssistantPickerMenu() : null}
                  </div>
                ) : isSpaceMode && selectedFilePath ? (
                  docFileNameControl ?? (
                    <span className="text-sm font-medium text-stone-700 truncate">
                      {formatFileTitle(selectedFilePath)}
                    </span>
                  )
                ) : (
                  <div className="relative min-w-0" ref={workspaceSwitcherRef}>
                    {/* New identity style (sidepanel 0.1): kind icon + name,
                        no caret — tap still opens the workspace menu (mobile
                        has no right-click). */}
                    <button
                      type="button"
                      onClick={toggleWorkspaceSwitcher}
                      data-workspace-switcher-trigger
                      className="flex max-w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left hover:bg-stone-50"
                      title={canWrite ? 'Open workspace menu' : projectTitle}
                    >
                      {workspaceKindIcon}
                      <span className="truncate text-sm font-medium text-stone-700">{projectTitle}</span>
                    </button>
                    {workspaceSwitcherMenu}
                  </div>
                )}
              </div>
              <div className="flex items-center shrink-0">
                {standaloneDiffHref && isSpaceMode && selectedFilePath ? (
                  <Link
                    href={standaloneDiffHref}
                    className="mr-1 inline-flex h-8 items-center rounded-full border border-stone-200 px-2.5 text-[11px] font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-800"
                  >
                    {'<- Diff'}
                  </Link>
                ) : null}
                {!isEditingTitle && isChatMode && currentChatId ? (
                  <div className="relative" ref={workspaceSwitcherRef}>
                    <button
                      type="button"
                      onClick={toggleWorkspaceSwitcher}
                      data-workspace-switcher-trigger
                      aria-label="Workspace menu"
                      className="p-2 rounded-lg hover:bg-stone-100 text-stone-400"
                    >
                      {/* The workspace kind glyph is the menu handle now —
                          same identity language as the rail, no caret. */}
                      {workspaceKindIcon}
                    </button>
                    {workspaceSwitcherMenu}
                  </div>
                ) : null}
                {/* Per-file controls merge into this bar (same order as the
                    desktop doc header) — the editor column skips its own
                    header strip on mobile space mode. */}
                {isSpaceMode && editorColumnVisible ? docFileControls : null}
                {/* No standalone Share: the per-file button rides in the file
                    controls above; workspace share lives in the workspace
                    menu (PR #1038). */}
                {/* Single chrome row: the formatting toolbar stays collapsed
                    behind this toggle. */}
                {!collapseDocControls && isSpaceMode && editorColumnVisible && activeWorkspaceFile && (activeIsMarkdown || activeTexFile) ? (
                  <button
                    type="button"
                    onClick={() => setMobileToolbarExpanded((v) => !v)}
                    aria-pressed={mobileToolbarExpanded}
                    aria-label={mobileToolbarExpanded ? 'Hide toolbar' : 'Show toolbar'}
                    data-testid="mobile-toolbar-toggle"
                    className={`relative group/tip p-2 rounded-lg hover:bg-stone-100 ${
                      mobileToolbarExpanded ? 'text-stone-500' : 'text-stone-400'
                    }`}
                  >
                    <TextAaIcon className="w-4 h-4" weight="regular" aria-hidden />
                    <IconTooltip label={mobileToolbarExpanded ? 'Hide toolbar' : 'Show toolbar'} />
                  </button>
                ) : null}
                {/* Explicit exit from the file view back to chat — the left
                    arrow alone read as ambiguous (2026-08-01 feedback). */}
                {isSpaceMode ? (
                  <button
                    type="button"
                    onClick={handleReturnToChatFromSpace}
                    aria-label="Close file view"
                    data-testid="close-file-view"
                    className="relative group/tip p-2 rounded-lg hover:bg-stone-100 text-stone-400"
                  >
                    <XIcon className="w-4 h-4" weight="bold" aria-hidden />
                    <IconTooltip label="Close file view" />
                  </button>
                ) : null}
              </div>
            </>
          </div>
          ) : null}

          {/* Content area — flex row so left rails sit beside the content. */}
          <div className="relative flex flex-1 overflow-hidden">
            {/* Panel view: the rail OVERLAYS the single surface instead of
                squeezing it — a ~400px side-panel browser leaves no room for
                both, and the layout's contract is one surface at a time. The
                scrim click returns to the document. */}
            {!isMobile && panelViewActive && openLeftRail === 'project' ? (
              <div
                data-testid="panel-rail-scrim"
                className="absolute inset-0 z-20 bg-stone-900/20"
                onClick={() => setOpenLeftRail(null)}
              />
            ) : null}
            {!isMobile && openLeftRail === 'project' ? (
              <aside
                data-testid="project-left-rail"
                style={
                  panelViewActive
                    ? { width: leftRailWidth, maxWidth: '85%' }
                    : { width: leftRailWidth }
                }
                // In-flow at every desktop width: below lg the center columns
                // shrink (max-lg:min-w-0) so the editor stays visible beside
                // the rail instead of being covered by an overlay. Panel view
                // is the exception — see the scrim above.
                className={
                  panelViewActive
                    ? 'absolute inset-y-0 left-0 z-30 flex flex-col border-r border-stone-200 bg-stone-50 shadow-xl'
                    : 'relative flex shrink-0 flex-col border-r border-stone-200 bg-stone-50'
                }
              >
                <ResizeHandle
                  side="right"
                  min={LEFT_RAIL_MIN_WIDTH}
                  max={LEFT_RAIL_MAX_WIDTH}
                  onCommit={handleLeftRailCommit}
                  onCollapse={collapseSidebar}
                />
                <ProjectSidebar
                  header={workspaceTitleControl}
                  support={
                    savedFlags?.sundial_support_enabled === true && !isMobile ? (
                      <SundialSupport
                        workspaceId={cloudProjectId}
                        open={rightDockView === 'support'}
                        onOpenChange={(nextOpen) => {
                          if (nextOpen) openRightDock('support');
                          else setRightDockView((current) => (current === 'support' ? null : current));
                        }}
                        panelTarget={supportPanelHost}
                      />
                    ) : null
                  }
                  // "Open with …" docks above the footer (in-flow, never
                  // overlaying chats) — the checklist that used to live here
                  // moved to Settings → Get set up. Scoped share guests are
                  // viewers, not arrivals; local projects have no cloud
                  // connect surface, so both skip the row.
                  openWith={
                    // Link visitors (any pathGrants, root grants included)
                    // skip it too: the modal's paste-into-AI prompt is
                    // pathname-only, which would hand an external agent a
                    // URL their access token isn't part of.
                    !isScopedGuest && !isLocalWorkspace && pathGrants.length === 0 ? (
                      <OpenWithRow onOpen={() => setShowOpenWithModal(true)} />
                    ) : null
                  }
                  footer={
                    <div className="relative">
                    <ClaimOwnershipNudge
                      show={
                        hasMounted &&
                        (isClerkLoaded || desktopSignedIn || clerkNeverLoads()) &&
                        !(Boolean(isClerkSignedIn) || desktopSignedIn) &&
                        isOwner &&
                        filesLoaded &&
                        !workspaceRouteContext?.local &&
                        !claimNudgeDismissed
                      }
                      onLogIn={() => openSignIn?.({ forceRedirectUrl: buildWorkspacePath(workspaceRouteId) })}
                      onDismiss={dismissClaimNudge}
                      // Embedded panel browsers (ChatGPT's side panel) have no
                      // Google session, so signing in THERE is the hard path —
                      // offer the ownership link to claim in the browser that
                      // already knows them. sd_anon is the adopting identity
                      // for the standard handoff (fresh panel browser adopts
                      // the link's key), so it is the right key here.
                      claimUrl={
                        panelViewActive && hasMounted
                          ? (() => {
                              const anonId = readAnonCookie();
                              return anonId
                                ? `${window.location.origin}${buildWorkspacePath(workspaceRouteId)}?anon=${anonId}`
                                : null;
                            })()
                          : null
                      }
                    />
                    {/* Feedback + Community are icon-only and share the identity
                        row with Settings — two full-width labelled rows above it
                        cost more sidebar height than they earn. */}
                    <div className="@container/footer flex items-center gap-2">
                      <SidebarIdentity
                        hasMounted={hasMounted}
                        // clerkNeverLoads: packaged app with no/rejected sd_
                        // credentials must reach the Log in CTA, not sit on
                        // the loading placeholder forever.
                        authReady={isClerkLoaded || desktopSignedIn || clerkNeverLoads()}
                        signedIn={Boolean(isClerkSignedIn) || desktopSignedIn}
                        imageUrl={user?.imageUrl ?? desktopProfile?.imageUrl}
                        name={desktopProfile?.name ?? desktopProfile?.email ?? collabUser.name}
                        onSignIn={() => openSignIn?.({ forceRedirectUrl: buildWorkspacePath(workspaceRouteId) })}
                        // /profile is Clerk-backed — an sd_-only identity
                        // (packaged app) would land on a page that can't load.
                        onOpenProfile={() => user && router.push('/profile')}
                      />
                      {workspaceStorageUsage?.warning ? (
                        <span
                          className={`shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            workspaceStorageUsage.overLimit
                              ? 'bg-rose-100 text-rose-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}
                          title={`${formatBytes(workspaceStorageUsage.usageBytes)} of ${formatBytes(workspaceStorageUsage.limitBytes)}`}
                        >
                          {Math.round(workspaceStorageUsage.usageRatio * 100)}%
                        </span>
                      ) : null}
                      {!isLocalWorkspace && (
                        <CreditBalancePill
                          enabled={backgroundDataReady}
                          onOpenBilling={() => openSettingsTab('billing')}
                        />
                      )}
                      <a
                        href={FEEDBACK_FORM_URL}
                        target="_blank"
                        rel="noreferrer"
                        onClick={openExternalOnDesktop}
                        aria-label="Feedback"
                        className="relative group/tip flex h-7 w-7 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-200/60 hover:text-stone-600"
                      >
                        <MegaphoneIcon className="h-4 w-4" weight="regular" aria-hidden />
                        <IconTooltip label="Feedback" side="top" align="right" />
                      </a>
                      <a
                        href={DISCORD_INVITE_URL}
                        target="_blank"
                        rel="noreferrer"
                        onClick={openExternalOnDesktop}
                        aria-label="Community"
                        className="relative group/tip flex h-7 w-7 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-200/60 hover:text-stone-600"
                      >
                        <DiscordLogoIcon className="h-4 w-4" weight="regular" aria-hidden />
                        <IconTooltip label="Community" side="top" align="right" />
                      </a>
                      <button
                        type="button"
                        onClick={() => openSettingsTab('workspace')}
                        aria-label="Settings"
                        className="relative group/tip flex h-7 w-7 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-200/60 hover:text-stone-600"
                      >
                        <GearSixIcon className="h-4 w-4" weight="regular" aria-hidden />
                        {/* Footer sits at the sidebar's bottom edge — open the
                            tooltip upward so it isn't clipped below the button. */}
                        <IconTooltip label="Settings" side="top" align="right" />
                      </button>
                    </div>
                    </div>
                  }
                  filesPanel={
                    <FilesTabPanel
                      canWrite={canWrite}
                      title={workspaceIdentityHeader}
                      onReorderEntries={handleReorderEntries}
                      childOrder={fileOrder}
                      collapsed={isSectionCollapsed(sidebarSections, 'files')}
                      onToggleCollapsed={() => toggleSidebarSectionCollapsed('files')}
                      onConnectLocalAgent={isLocalWorkspace ? undefined : () => void openLocalAgentModal()}
                      // Cloud-only: the modal posts to /api/workspace/skills, and
                      // the local sidecar has no skills route to answer it.
                      // Workspace-level canWrite, not the ＋ menu's folder-scoped
                      // gate: skills/ is global metadata, and the route 403s a
                      // folder-scoped editor — don't offer a doomed modal.
                      onAddSkill={isLocalWorkspace || !canWrite ? undefined : () => setShowAddSkillModal(true)}
                      showMetaFiles={showMetaFiles}
                      setShowMetaFiles={setShowMetaFiles}
                      showAgentMetaFiles={showAgentMetaFiles}
                      onToggleAgentMetaFiles={toggleAgentMetaFiles}
                      onToggleLock={toggleFileLock}
                      canLockFiles={canAccessSecrets === true}
                      workspaceFiles={workspaceFiles}
                      selectedFilePath={selectedFilePath}
                      setSelectedFilePath={setSelectedFilePath}
                      setExpandedFolders={setExpandedFolders}
                      fileUploadInputRef={fileUploadInputRef}
                      onCreateFile={handleCreateFile}
                      onCreateFolder={handleCreateFolder}
                      // Mirrors beginDraft's target: the header ＋ must not
                      // render when creating there would silently no-op, and
                      // its Upload lands in the same folder as New file.
                      createParentPath={sidebarCreateParent}
                      canCreateEntries={canUploadToFolder(sidebarCreateParent)}
                      onQueueFileUploads={queueFileUploadsToFolder}
                      isFilesDropActive={isFilesDropActive}
                      setIsFilesDropActive={setIsFilesDropActive}
                      dragOverPath={dragOverPath}
                      setDragOverPath={setDragOverPath}
                      onDropToFolder={handleDrop}
                      fileUploads={fileUploads}
                      onRemoveUpload={removeUpload}
                      draftEntry={draftEntry}
                      setDraftEntry={setDraftEntry}
                      draftInputRef={draftInputRef}
                      draftIdRef={draftIdRef}
                      buildDraftName={buildDraftName}
                      onCommitDraft={commitDraft}
                      onCancelDraft={cancelDraft}
                      foldersByParent={foldersByParent}
                      filesByFolder={filesByFolder}
                      rootFiles={rootFiles}
                      filesLoaded={filesLoaded}
                      renameEntry={renameEntry}
                      setRenameEntry={setRenameEntry}
                      renameInputRef={renameInputRef}
                      onBeginRename={beginRename}
                      onMovePath={movePath}
                      existingPaths={existingPaths}
                      workspaceFileByPath={workspaceFileByPath}
                      selectedPaths={selectedPaths}
                      setSelectedPaths={setSelectedPaths}
                      lastClickedPathRef={lastClickedPathRef}
                      flatVisiblePaths={flatVisiblePaths}
                      onOpenFile={(file) => {
                        setSidebarSections((prev) => expandSection(prev, 'files'));
                        handleFileClick(file);
                      }}
                      onPrefetchFile={prefetchWorkspaceFile}
                      onOpenInNewTab={isMobile || !desktopTabs ? undefined : handleOpenInNewTab}
                      onOpenToSide={isMobile || !desktopTabs ? undefined : handleOpenToSide}
                      openMenuPath={openMenuPath}
                      setOpenMenuPath={setOpenMenuPath}
                      fileMenuRef={fileMenuRef}
                      onCopyFileLink={handleCopyFileLink}
                      onDownloadFile={downloadFile}
                      onDownloadFolder={downloadFolder}
                      onDownloadWorkspace={isLocalWorkspace ? undefined : downloadWorkspaceZip}
                      onNewChatInFolder={startChatInFolder}
                      onFocusedFolderChange={setFocusedSidebarFolder}
                      focusFolderIntent={sidebarFolderFocusIntent}
                      onAddContextFolder={
                        isLocalWorkspace && isDesktopApp ? handleAddContextFolder : undefined
                      }
                      localRoots={isLocalWorkspace ? localRoots : undefined}
                      onRemoveRootFolder={isLocalWorkspace ? handleRemoveRootFolder : undefined}
                      onDeletePaths={deletePaths}
                      onUndoDelete={restoreLastDeletedPaths}
                      canUndoDelete={hasDeletedHistory}
                      deleteSeq={deleteSeq}
                      onDuplicatePath={duplicatePath}
                      expandedFolders={expandedFolders}
                      onFileDragStart={handleFileDragStart}
                      findRepoForPath={findLinkedRepoForPath}
                      onShareEntry={
                        isLocalWorkspace
                          ? (path, kind) => setLocalShareScope({ kind: kind === 'folder' ? 'folder' : 'file', path })
                          : canInviteShare && !isScopedGuest
                            ? (path, kind) => {
                                setPathShareScope({ path, kind: kind === 'folder' ? 'folder' : 'file' });
                                void refreshCloudPathShares();
                              }
                            : undefined
                      }
                      onShareWorkspace={canShowShareControls ? openShare : undefined}
                      sharedScopePaths={isLocalWorkspace ? localSharedScopeKinds : cloudSharedScopePaths}
                      sharedBadgeLabel={isLocalWorkspace ? undefined : 'Shared'}
                      canWritePath={canWriteWorkspacePath}
                      hasWriteGrants={pathGrants.some((grant) => grant.role === 'edit')}
                      pinStorageKey={projectId ?? undefined}
                    />
                  }
                  chatRail={renderChatRail('desktop')}
                  onNewChat={() => {
                    // Open the chat column first so the new draft's composer is
                    // visible (keepMode skips the view switch, like the chat
                    // panel's own New-chat item). A folder-focused rail scopes
                    // the new chat to that folder (wireframe: chats started in
                    // focus mode live there).
                    if (focusedSidebarFolder) {
                      startChatInFolder(focusedSidebarFolder);
                      return;
                    }
                    // side: the file-first landing means a document usually
                    // owns the pane — the new chat docks to its right rather
                    // than replacing what the user is reading. `side` falls
                    // through to replace when the primary is already a chat.
                    openCenterPanel('chat', { side: true });
                    void startAssistantChat(null, null, { forceNew: true, keepMode: true, sideTab: true });
                  }}
                  canStartChat={canWrite}
                  onOpenSchedules={projectId ? () => setSchedulesPanelMode('list') : undefined}
                  onNewSchedule={
                    canWrite && projectId
                      ? () => {
                          // Schedules need a signed-in owner (the server
                          // refuses anon creation) — route anon clicks to
                          // sign-in instead of a form that can only fail.
                          if (!localConfig && (clerkAuthRef.current.isLoaded || clerkNeverLoads()) && !clerkAuthRef.current.isSignedIn) {
                            openSignIn({ redirectUrl: buildReturnPath({}) });
                            return;
                          }
                          setSchedulesPanelMode('create');
                        }
                      : undefined
                  }
                  chatsCollapsed={isSectionCollapsed(sidebarSections, 'chats')}
                  onToggleChats={() => toggleSidebarSectionCollapsed('chats')}
                  syncPanel={
                    linkedRepos.length > 0 ? (
                      <CommitsRail
                        projectId={projectId}
                        repos={linkedRepos}
                        collapsed={isSectionCollapsed(sidebarSections, 'sync')}
                        onToggleCollapsed={() => toggleSidebarSectionCollapsed('sync')}
                        selectedCommitSha={selectedCommit?.sha ?? null}
                        onSelectCommit={(repoId, sha) => {
                          setSidebarSections((prev) => expandSection(prev, 'sync'));
                          setSelectedCommit(sha ? { repoId, sha } : null);
                        }}
                        onActionComplete={() => {
                          setLinkedReposRefreshKey((k) => k + 1);
                          void refetchLinkedRepos();
                        }}
                      />
                    ) : undefined
                  }
                />
              </aside>
            ) : null}
            <div className="flex-1 overflow-hidden">
            {/* linkedRepos guard (inside commitDiffOpen): if the repo is
                unlinked while a commit is selected, the sidebar falls back to
                the Files tab — the stale diff viewer must drop with it. */}
            {commitDiffOpen && selectedCommit ? (
              // The commit view keeps the one-bar chrome: an empty bar row
              // under the pinned top-right cluster, viewer below.
              <div className="flex h-full flex-col">
                {!isMobile ? (
                  <div className="h-11 shrink-0 border-b border-stone-200/60 bg-stone-100/70" aria-hidden />
                ) : null}
                <div className="min-h-0 flex-1">
                  <CommitDiffViewer
                    projectId={projectId}
                    repositoryId={selectedCommit.repoId}
                    sha={selectedCommit.sha}
                    repoUrl={
                      linkedRepos.find((r) => r.id === selectedCommit.repoId)?.htmlUrl ?? null
                    }
                  />
                </div>
              </div>
            ) : (
              // print:static drops this wrapper as a positioning context so the
              // absolutely-positioned print root (the document card) anchors to
              // the page, not to this column — otherwise printing offsets the
              // doc by the left rail's width (content squished into one side).
              <div className="relative flex h-full min-w-0 print:static">
              {editorColumnVisible ? (
              // max-lg floor: the editor is flex-basis-0, so without a floor an
              // open rail + fixed-width chat column collapse it to 0px at
              // narrow desktop widths; the siblings are min-w-0 and absorb.
              // max-lg:flex-[2] keeps the editor the widest column below lg (it
              // grows 2:1:1 against the side panels, whose fixed px widths are
              // neutralised there by basis-0) — the doc is the primary surface.
              <div className="order-2 flex flex-1 overflow-hidden min-w-[400px] max-lg:min-w-[200px] max-lg:flex-[2]">
              {/* Primary pane — the full editor chrome. The strip appears only
                  once tabs/splits are in play, so the default single-file
                  layout is pixel-identical to the pre-tabs one. */}
              {/* print:static on both wrappers: [data-print-root] is absolutely
                  positioned against the PAGE in @media print — a positioned
                  ancestor here would clip/shift the printout to the pane box. */}
              <div
                data-testid="editor-pane-primary"
                className="relative flex min-w-0 flex-1 flex-col overflow-hidden print:static"
                style={{ flexGrow: paneGrow[PRIMARY_PANE_ID] ?? 1 }}
                // Any interaction inside the pane focuses it for ⌘W — tab
                // clicks alone would leave the ref stale after editing here.
                onPointerDownCapture={() => {
                  lastFocusedPaneIdRef.current = PRIMARY_PANE_ID;
                  setFocusedPaneId(PRIMARY_PANE_ID);
                }}
              >
                {/* Squash wrapper: hovering an edge zone slides the whole live
                    pane — tab strip included — into the surviving half. */}
                <div
                  data-testid="pane-squash"
                  data-squash={paneDropZone?.paneId === PRIMARY_PANE_ID ? paneDropZone.zone : undefined}
                  className="flex min-h-0 flex-1 flex-col transition-[margin] duration-150"
                  style={paneSquashStyle(
                    paneDropZone?.paneId === PRIMARY_PANE_ID ? paneDropZone.zone : undefined,
                  )}
                >
                {/* The primary pane's tab strip IS the top bar (one bar total,
                    starting right of the full-height rail). With the rail
                    collapsed, Home + the sidebar toggle lead the row. The
                    right controls are pinned absolutely at the window's
                    top-right; when this is the rightmost strip (single pane,
                    dock closed) the row reserves their width. Testid kept
                    from the old top-bar home so the shell smokes stay
                    stable. Desktop shell only, and only while the ⋮ "Hide
                    top bar" preference is off — the web build and the hidden
                    state render no bar at all (the doc/chat headers are the
                    topmost chrome; the pinned corner clusters float). */}
                {!isMobile && desktopTabs ? (
                  <div
                    data-testid="topbar-tabs"
                    className="flex shrink-0 items-stretch"
                    style={
                      editorPanes.length === 1 && rightDockView === null && topbarRightWidth
                        ? { paddingRight: topbarRightWidth }
                        : undefined
                    }
                  >
                    {openLeftRail === null ? (
                      <div
                        className={`flex shrink-0 items-center gap-1.5 border-b border-stone-200/60 bg-stone-100/70 pr-1 ${isDesktopApp ? 'pl-[calc(72px/var(--sd-zoom,1))]' : 'pl-2'}`}
                        data-testid="topbar-left"
                        {...(isDesktopApp ? { 'data-tauri-drag-region': '' } : {})}
                      >
                        {shellNavControls}
                      </div>
                    ) : null}
                    <EditorTabStrip
                      className="min-w-0 flex-1"
                      dragRegion={isDesktopApp}
                      paneId={PRIMARY_PANE_ID}
                      tabs={editorPanes[0].tabs}
                      activePath={editorPanes[0].active}
                      formatLabel={tabLabel}
                      onActivate={(path) => handlePaneTabActivate(PRIMARY_PANE_ID, path)}
                      onCloseTab={(path) => handlePaneTabClose(PRIMARY_PANE_ID, path)}
                      onDropTab={(payload, index) => handlePaneTabDrop(PRIMARY_PANE_ID, payload, index)}
                      onTabDragChange={handleTabDragChange}
                      onSplitRight={(path) => handleTabSplitRight(PRIMARY_PANE_ID, path)}
                      canSplit={editorPanes.length < MAX_EDITOR_PANES}
                      renamingPath={
                        renameEntry?.source === 'tab' && renameEntry.paneId === PRIMARY_PANE_ID
                          ? renameEntry.path
                          : null
                      }
                      renameValue={renameEntry?.name ?? ''}
                      onBeginRename={(path) => handleBeginTabRename(PRIMARY_PANE_ID, path)}
                      onRenameValueChange={handleTabRenameValueChange}
                      onCommitRename={() => void commitRename()}
                      onCancelRename={cancelRename}
                      trailing={renderNewTabLauncher(PRIMARY_PANE_ID)}
                    />
                  </div>
                ) : null}
                <div
                  // Google Docs style: the desk color runs under ALL the doc
                  // chrome (title row, menu bar, toolbar strip) — a white band
                  // above the gray desk read as a seam (Belinda, round 3).
                  className={`relative flex min-h-0 flex-1 flex-col print:static ${
                    docsPage && isMarkdownEditing ? 'bg-stone-50' : ''
                  }`}
                >
                {/* An active chat tab claims the pane: the chat surface renders
                    where the doc chrome would (the wireframe's chats-as-tabs). */}
                {primaryChatActive ? renderChatSurface(editorPanes.length === 1) : primaryLauncherActive ? renderLauncherPanel(PRIMARY_PANE_ID) : primaryReviewActive ? renderChatEditsSurface(editorPanes[0].active, leftmostPaneInset) : primaryDiffActive ? renderDiffSurface(editorPanes[0].active, leftmostPaneInset) : (<>
                {/* The file's own header row (wireframe): its identity —
                    folder path + name — leads, and the always-on controls
                    (mode picker · Aa · Share · ⋯, plus Comments when any
                    exist) close the row. Both shells: a tab label truncates
                    to ~20ch and can't show where the file sits, and the web
                    bar no longer duplicates the name. */}
                {docsHeaderOwnsTopLeft && activeWorkspaceFile ? (
                  // Google Docs style: one compact header cluster — the big
                  // title with the File/Edit/View/Insert/Format menu bar
                  // directly beneath it, controls top-right (like Docs' own
                  // comment/share corner). The path lives in the tooltip.
                  <div
                    ref={docHeaderRef}
                    data-testid="topbar-doc-controls"
                    // items-center: the controls corner floats vertically
                    // centered against the title+menus cluster, like Docs'
                    // own comment/share corner. pt-1: the cluster stays short
                    // but keeps a touch of air above the title — pt-0.5 sat
                    // the title against the window edge (founder, 2026-08-14
                    // round 2).
                    className="relative flex shrink-0 items-center justify-between gap-2 px-3 pt-1 print:hidden"
                    // Topmost chrome: clear the pinned right cluster while
                    // the doc is the rightmost surface. NO window × here:
                    // Google Docs has no close-document control (founder,
                    // 2026-08-05) — you leave via the sidebar / ⌘W; the ×
                    // stays in the IDE windows shell. No sidebar toggle up
                    // here either (Belinda, 2026-08-07 round 3) — it rides
                    // the toolbar pill's left end — so the only left
                    // clearance is the macOS traffic lights.
                    style={{
                      ...(openLeftRail === null && isDesktopApp
                        ? { paddingLeft: 'calc(72px/var(--sd-zoom,1))' }
                        : {}),
                      ...(editorPanes.length === 1 && rightDockView === null && topbarRightWidth
                        ? { paddingRight: topbarRightWidth }
                        : {}),
                    }}
                  >
                    <div className="flex min-w-0 items-center">
                      {/* Google Docs' own two-column header (Belinda,
                          2026-08-07 round 2): the file's tree glyph is its
                          own column spanning both rows — like Docs' doc
                          mark — with the title + menu bar stacked beside.
                          No sidebar toggle up here (round 3) — it rides the
                          toolbar pill's left end below. */}
                      <WorkspaceEntryIcon
                        path={activeWorkspaceFile.path}
                        // mr-0.5: the title/menu column's own text inset
                        // (10px of button padding) already provides the
                        // visual gap — a wider margin read as the icon
                        // floating loose (Belinda, round 4).
                        // The doc mark still reads as part of the title
                        // cluster, but it must not outweigh the name: at 32px
                        // the 16-grid glyph's 1.3 stroke doubles to 2.6px of
                        // near-black and pulled the eye off the title. stone-500
                        // + a hairline stroke land it near the title's own text
                        // weight; the palette remap makes it muted in dark too.
                        className="ml-1.5 mr-0.5 h-8 w-8 shrink-0 text-stone-500 [stroke-width:0.9]"
                      />
                      <div className="flex min-w-0 flex-col">
                      <div
                        // pl-1.5: the name button's own px-1 lands the title
                        // text on the menu buttons' px-2.5 text inset — the
                        // two rows read left-aligned like Docs.
                        className="flex min-w-0 items-center gap-1.5 pl-1.5"
                        title={activeWorkspaceFile.path}
                      >
                        {renderDocFileNameControl(true)}
                        {/* Share status beside the name (PR #1086 pattern). */}
                        {docShareStatusIcon}
                      </div>
                      <MarkdownMenuBar
                        // -mt-1: the menu hugs the title like Docs' own
                        // header (Belinda, round 3 — the rows sat too far
                        // apart).
                        className="-mt-1 px-0"
                        // Raw markdown view hides the Tiptap editor — hand the
                        // bar no editor so Insert/Format/Edit items go inert
                        // instead of editing the hidden rich view (Codex r5).
                        editor={isMarkdownEditing ? markdownEditor : null}
                        readOnly={documentEditorReadOnly || !activeFileCap.canWrite}
                        file={activeWorkspaceFile}
                        projectId={projectId}
                        localWorkspace={isLocalWorkspace}
                        sidebarOpen={openLeftRail !== null}
                        onNewFile={
                          // Per-folder capability, not workspace canWrite: a
                          // path-share editor creates inside their granted
                          // subtree (mirrors beginDraft's own guard — Codex).
                          canUploadToFolder(sidebarCreateParent)
                            ? () => {
                                setOpenLeftRail('project');
                                setSidebarSections((prev) => expandSection(prev, 'files'));
                                handleCreateFile();
                              }
                            : undefined
                        }
                        onRename={() =>
                          beginRename(activeWorkspaceFile.path, isMobile || !desktopTabs ? 'header' : 'tab', {
                            fileId: activeWorkspaceFile.id,
                            ...(isMobile || !desktopTabs ? {} : { paneId: PRIMARY_PANE_ID }),
                          })
                        }
                        onDuplicate={() => void duplicateFile(activeWorkspaceFile)}
                        onDelete={() => void deletePath(activeWorkspaceFile.path)}
                        onToggleSidebar={toggleSidebar}
                      />
                      </div>
                    </div>
                    {/* No controls corner at all: everything rides the
                        toolbar's right end (founder — "entirely folded into
                        the formatting bar"), which never closes in Docs. */}
                  </div>
                ) : !isMobile && activeWorkspaceFile ? (
                  <DocPaneHeader
                    headerRef={docHeaderRef}
                    collapsed={collapseDocControls}
                    path={activeWorkspaceFile.path}
                    nameControl={docFileNameControl}
                    shareIcon={docShareStatusIcon}
                    controls={() => docFileControls}
                    tall={!desktopTabs}
                    // The LaTeX split toolbars run directly beneath — a
                    // hairline makes the two chrome rows read as separate bars.
                    divider={Boolean(activeTexFile)}
                    // Only while the doc is the RIGHTMOST surface (sole pane,
                    // dock closed; a docked chat is always the last pane) it
                    // clears the pinned cluster floating over it.
                    paddingRight={
                      !desktopTabs && editorPanes.length === 1 && rightDockView === null
                        ? topbarRightWidth
                        : undefined
                    }
                    // Little-windows shell: the window's controls sit at its
                    // top-LEFT corner (macOS convention — founder): × then the
                    // ⋮ document menu. Collapsed rail: shift past the floating
                    // Home/Sidebar cluster; on the macOS shell floor at the
                    // traffic-light clearance (the measured width is 0 for the
                    // first frames, which would park the × under the lights).
                    leading={
                      !desktopTabs ? (
                        <>
                          <button
                            type="button"
                            onClick={closeActiveFileView}
                            aria-label="Close file view"
                            data-testid="close-file-view"
                            className="relative group/tip inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                          >
                            <XIcon className="h-4 w-4" weight="regular" aria-hidden />
                            <IconTooltip label="Close file view" />
                          </button>
                          {docActionsMenu}
                        </>
                      ) : undefined
                    }
                    leadingLeft={
                      openLeftRail === null && isDesktopApp
                        ? `max(${topbarLeftFloatWidth}px, calc(72px/var(--sd-zoom,1)))`
                        : openLeftRail === null && topbarLeftFloatWidth
                          ? topbarLeftFloatWidth
                          : 8
                    }
                    // The mirrored obstruction grows when this row is topmost:
                    // the pinned right cluster joins the doc controls while the
                    // doc is the rightmost surface, and with the rail collapsed
                    // the floating Home/Sidebar cluster obstructs the left.
                    mirrorRight={
                      !desktopTabs && editorPanes.length === 1 && rightDockView === null
                        ? topbarRightWidth
                        : 0
                    }
                    mirrorLeft={
                      !desktopTabs
                        ? (openLeftRail === null
                            ? Math.max(topbarLeftFloatWidth, isDesktopApp ? 72 : 0)
                            : 0) + 76
                        : 0
                    }
                    onFocusFolder={focusRailFolder}
                  />
                ) : null}
                {/* On mobile space mode the top bar already carries the file
                    identity + controls — skip this strip so chrome stays one
                    bar (the file name never appears twice). */}
                {!isMobile || isSpaceMode ? null : activeWorkspaceFile ? (
                  <DocColumnControls
                    onClose={() => closeCenterPanel('editor')}
                    leftSlot={docFileNameControl}
                    rightSlot={docFileControls}
                  />
                ) : (
                  <DocColumnControls
                    onClose={() => closeCenterPanel('editor')}
                    leftSlot={
                      <span className="text-[13px] font-medium text-stone-400">No file open</span>
                    }
                  />
                )}
                {/* Desktop Docs: the ROW is permanent for markdown files —
                    the toolbar can never close, and it carries the doc
                    controls even over the raw view (inert strip, live ⋮).
                    Everywhere else the row needs the RICH view
                    (isMarkdownEditing): a live toolbar over the hidden rich
                    view would format at a stale selection (Codex r6). */}
                {activeWorkspaceFile &&
                (isMobile
                  ? !mobileToolbarCollapsed && isMarkdownEditing
                  : docsPage
                    ? activeIsMarkdown
                    : showFormatToolbar && isMarkdownEditing) ? (
                  <div
                    ref={toolbarRowCallbackRef}
                    // Docs: pt-1 — the header cluster above is part of the
                    // same tight stack (Belinda, 2026-08-07).
                    // Title row first, bar under it — every shell, web and
                    // desktop alike (founder, 2026-08-18: the desktop-only
                    // order-first experiment is reverted).
                    className={`px-3 shrink-0 ${docsPage && !isMobile ? 'pb-1 pt-0.5' : 'py-1'}`}
                  >
                    <div
                      // One pill for both styles: the flat stone-200 bar read
                      // as a gray slab in Docs (founder, 2026-08-14) — the
                      // buttons carry their own hover gray, the pill stays
                      // quiet white like the IDE's.
                      className="flex items-stretch rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.05)]"
                    >
                      {/* Collapsed-rail sidebar toggle: seated with the
                          toolbar's OWN icon buttons (Belinda, round 3 — it
                          read as broken chrome alone under the bar and
                          crowded the title beside it). Styled as a toolbar
                          button, split off by the toolbar's separator.
                          Keeps the float-nav + toggle testids — it IS the
                          collapsed-rail nav; the rail's top row takes over
                          the moment it opens. */}
                      {docsHeaderOwnsTopLeft && !desktopTabs && openLeftRail === null ? (
                        <div
                          data-testid="topbar-float-nav"
                          className="flex shrink-0 items-center self-center pl-1.5"
                        >
                          <button
                            type="button"
                            onClick={toggleSidebar}
                            aria-pressed={false}
                            aria-label="Toggle sidebar"
                            data-testid="topbar-sidebar-toggle"
                            className="relative group/tip inline-flex h-7 w-7 items-center justify-center rounded text-stone-600 transition-colors hover:bg-stone-200/60 hover:text-stone-900"
                          >
                            <SidebarSimpleIcon className="h-4 w-4" weight="regular" aria-hidden />
                            <IconTooltip label="Sidebar" />
                          </button>
                          <div className="mx-1 h-5 w-px shrink-0 bg-stone-300" aria-hidden />
                        </div>
                      ) : null}
                      <div className="min-w-0 flex-1">
                        {/* Keep the row mounted (reserving the toolbar's height)
                            while the editor instance is briefly null on a
                            markdown→markdown switch, so the chrome never
                            collapses and the frame doesn't flicker/jump.
                            isMarkdownEditing too: the Docs row stays up over
                            the RAW view, where a live toolbar would format
                            the hidden rich view (Codex r6) — inert strip. */}
                        {isMarkdownEditing && toolbarEditor ? (
                          <MarkdownToolbar
                            editor={toolbarEditor}
                            // Commenters: formatting/structural commands can't
                            // be staged as suggestion marks — keep them
                            // disabled, not silently applying untracked edits.
                            readOnly={documentEditorReadOnly || !activeFileCap.canWrite}
                            // The doc controls sit in this same pill while
                            // they ride the toolbar, so the formatting groups
                            // get what's left — otherwise the bar reveals a
                            // tier it can't fit and the two clusters collide.
                            // Shared with docsToolbarFlags above.
                            containerWidth={toolbarContentWidth}
                            zoom={editorZoom}
                            onZoomChange={setEditorZoom}
                            lineHeight={editorLineHeight}
                            onLineHeightChange={setEditorLineHeight}
                            pageChrome={editorPageChrome}
                            onPageChromeChange={setEditorPageChrome}
                            // Docs: the condensed tiers live in the document ⋯
                            // menu at this pill's right end — no second dots
                            // trigger on the bar itself.
                            hideOverflowMenu={docsPage && !isMobile}
                            authorshipLens={showAuthorship}
                            // Cloud-only: blame comes from /api/workspace/file-blame,
                            // which the local sidecar has no counterpart for — so the
                            // toggle isn't rendered there rather than flipping a lens
                            // that can never paint (Codex, PR #1104 round 7).
                            onToggleAuthorshipLens={
                              cloudProjectId ? () => setShowAuthorship((on) => !on) : undefined
                            }
                          />
                        ) : (
                          <div className="h-9" aria-hidden />
                        )}
                      </div>
                      {/* Google Docs' own layout: the mode picker (and, in
                          the Docs style, Aa + ⋮ with it) closes the toolbar
                          row. The IDE header keeps its Aa/⋮ — only the mode
                          picker moves down here. */}
                      {controlsRideToolbar ? (
                        <div
                          ref={toolbarControlsRef}
                          className="flex shrink-0 items-center gap-1 pr-1.5"
                        >
                          {docsPage ? (
                            docsHeaderControls
                          ) : !collapseDocControls && !documentReadOnly ? (
                            <EditModeControl
                              mode={effectiveDocEditMode}
                              onChange={setDocumentEditMode}
                              menuPlacement="down"
                              modes={docEditModes}
                              disabled={!activeFileCap.canWrite}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {/* Mobile keeps the single full-width bar; on desktop the
                    chrome splits Overleaf-style — formatting toolbar over the
                    editor pane, compile controls in the PDF pane header (both
                    seated inside LatexWorkbench below). */}
                {!mobileToolbarCollapsed && activeTexFile && activeWorkspaceFile && isMobile ? (
                  <LatexToolbarRow
                    {...latexEditorRefHandlers(textEditorRef)}
                    {...latexCompileProps}
                    readOnly={documentEditorReadOnly}
                    autoFix={latexAutoFix}
                    onToggleAutoFix={toggleLatexAutoFix}
                    autoCompile={latexAutoCompile}
                    onToggleAutoCompile={isLocalWorkspace ? undefined : toggleLatexAutoCompile}
                    showInPdfHint={synctexHint?.text ?? null}
                  />

                ) : null}
                <div
                  ref={docEditorBodyRef}
                  data-testid="doc-editor-body"
                  // Desk color comes from the pane column above (one source).
                  className="flex-1 min-h-0 overflow-auto"
                >
                  {activeWorkspaceFile ? (
                    <div
                      className={`${laneNarrowsContent ? 'max-w-[1380px]' : contentWidthClass} ${codeAlignLeft ? '' : docCentered ? 'mx-auto' : 'pl-12!'} ${laneNarrowsContent ? 'px-3 py-4 lg:py-8' : contentPaddingClass}`}
                      style={zoomWidenedMax(laneNarrowsContent ? '1380px' : '64rem')}
                    >
                      <div className={activeTexFile ? 'h-full' : undefined}>
                        <div
                          className={`transition-opacity duration-200 ${
                            activeTexFile ? 'h-full ' : ''
                          }${
                            isTextSurface
                              ? 'opacity-100'
                              : fileContentVisible
                                ? 'opacity-100'
                                : 'opacity-0'
                          }`}
                        >
                      {activeWorkspaceFile.type === 'folder' ? (
                        <div className="border border-dashed border-stone-200 rounded-xl p-6 text-sm text-stone-500">
                          Folders don&apos;t have a preview yet. Create a file inside to get started.
                        </div>
                      ) : isBinaryFile(activeWorkspaceFile) ? (
                        activePreviewFile ? (
                          <div
                            className={
                              binaryPreviewStatus !== 'loading' && pdfPreviewUrl
                                ? 'text-sm text-stone-500'
                                : 'border border-dashed border-stone-200 rounded-xl p-6 text-sm text-stone-500'
                            }
                          >
                            {binaryPreviewStatus === 'loading' && (
                              <Spinner
                                label={
                                  activePreviewKind === 'office'
                                    ? 'Preparing document preview…'
                                    : `Loading ${previewNoun} preview…`
                                }
                              />
                            )}
                            {binaryPreviewStatus === 'error' && (
                              <div className="space-y-3">
                                <div>Unable to load {previewNoun} preview.</div>
                                <button
                                  type="button"
                                  onClick={() => setBinaryPreviewNonce((value) => value + 1)}
                                  className="inline-flex items-center gap-1 rounded-md border border-stone-200 px-2.5 py-1 text-xs text-stone-600 hover:bg-stone-50"
                                >
                                  Retry
                                </button>
                              </div>
                            )}
                            {binaryPreviewStatus !== 'loading' && binaryPreviewUrl && activePreviewKind === 'image' && (
                              <ImageViewer
                                src={binaryPreviewUrl}
                                alt={formatFileName(getFileName(activePreviewFile.path))}
                              />
                            )}
                            {binaryPreviewStatus !== 'loading' && binaryPreviewUrl && previewRendersPdf && (
                              // PDF.js viewer, not a native-viewer <iframe>: links
                              // clicked inside the native viewer navigate the frame
                              // itself, and sites that refuse framing (CSP
                              // frame-ancestors) white the pane out instead of opening.
                              <div className="h-[calc(100vh-6.5rem)] min-h-[520px] overflow-hidden rounded-2xl bg-white">
                                <LatexPdfPane
                                  // The viewer treats fileUrl swaps as recompiles
                                  // (keeps scroll/page state) — a different file
                                  // must remount with fresh state instead.
                                  // stateKey then restores that file's own
                                  // last position from the viewer cache.
                                  key={activePreviewFile.id}
                                  stateKey={activePreviewFile.id}
                                  texPath={activePreviewFile.path}
                                  pdfUrl={binaryPreviewUrl}
                                />
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="border border-dashed border-stone-200 rounded-xl p-6 text-sm text-stone-500">
                            Binary file preview isn&apos;t available yet.
                          </div>
                        )
                      ) : activeTexFile ? (
                        <div
                          ref={reserveCommentLane ? commentLaneRowRef : null}
                          // relative: seats the floating auto-fix offer card.
                          className="relative flex h-full min-h-0 min-w-0 flex-col"
                        >
                          <div className="min-h-0 flex-1">
                            {/* Chrome junction: 'cut' (full-height divider,
                                edgeCut/headerCut hairlines on the bars) was
                                chosen over 'low' — to flip back, pass
                                dividerChrome="shim" here and drop the
                                edgeCut/headerCut props. */}
                            <LatexWorkbench
                              isMobile={isMobile}
                              viewMode={latexViewMode}
                              onViewModeChange={handleLatexViewModeChange}
                              // The lane joins the split BETWEEN the editor and the
                              // PDF — parked to the right of the workbench it read as
                              // "comments on the PDF" and sat a pane away from the text.
                              commentLane={commentLaneColumn}
                              editor={(
                                <div className="flex h-full min-h-0 flex-col">
                                  {/* Formatting toolbar rides the editor pane
                                      (Overleaf): it collapses with the pane in
                                      PDF view, and carries the compile cluster
                                      only in Source view, where the PDF header
                                      that normally seats it is collapsed. */}
                                  {!isMobile ? (
                                    <LatexToolbarRow
                                      {...latexEditorRefHandlers(textEditorRef)}
                                      {...latexCompileProps}
                                      readOnly={documentEditorReadOnly}
                                      autoFix={latexAutoFix}
                                      onToggleAutoFix={toggleLatexAutoFix}
                                      autoCompile={latexAutoCompile}
                                      onToggleAutoCompile={isLocalWorkspace ? undefined : toggleLatexAutoCompile}
                                      showInPdfHint={synctexHint?.text ?? null}
                                      showCompileControls={latexViewMode === 'source'}
                                      edgeCut
                                    />
                                  ) : null}
                                  <div className="min-h-0 flex-1 overflow-hidden">
                                <CollabCodeEditor
                                  key={activeWorkspaceFile.id}
                                  fileId={activeWorkspaceFile.id}
                                  filePath={activeWorkspaceFile.path}
                                  collabPath={activeCollabPath}
                                  workspaceId={projectId}
                                  apiFetch={apiFetch}
                                  user={collabUser}
                                  readOnly={documentEditorReadOnly}
                                  canResolveSuggestions={activeFileCap.canWrite}
                                  editMode={effectiveDocEditMode === 'suggest' ? 'suggest' : 'edit'}
                                  bare
                                  compileMarkers={latexMarkers}
                                  onImageUpload={handleLatexImageUpload}
                                  onReady={handleCodeEditorReady}
                                  onContentChange={handleViewerContentChange}
                                  onLocalEdit={activeTexFile ? noteLatexLocalEdit : undefined}
                                  onConnectionStatusChange={setCollabStatus}
                                  pendingAdditions={spacePendingAdditions}
                                  onKeepAddition={handleSpaceKeepAddition}
                                  onUndoAddition={handleSpaceUndoAddition}
                                  onJumpToTurn={handleJumpToTurn}
                                  revealPeer={peerReveal?.path === activeWorkspaceFile.path ? peerReveal : null}
                                  onRevealPeerDone={handlePeerRevealDone}
                                  onFocused={() => handleEditorFocusedPath(activeWorkspaceFile.path)}
                                  onShowInPdf={handleSynctexForward}
                                  {...codeCommentProps}
                                />
                                  </div>
                                </div>
                              )}
                              preview={(
                                <LatexPdfPane
                                  // File id, not path: common names (main.tex)
                                  // would restore positions across workspaces,
                                  // and a same-path file swap must remount so
                                  // the mount-time state restore applies.
                                  key={`${activeWorkspaceFile.id}:latex-pane`}
                                  stateKey={activeWorkspaceFile.id}
                                  texPath={activeWorkspaceFile.path}
                                  compileRootPath={latexRootPath}
                                  pdfUrl={latexCompile.pdfUrl}
                                  synctex={synctexIndex}
                                  onInverseSearch={handleSynctexInverse}
                                  jumpTarget={synctexJump}
                                  commentMarkers={pdfCommentMarkers}
                                  onMarkerClick={pdfCommentsEnabled ? selectCommentThread : undefined}
                                  // synctexIndex gates the offer itself: with
                                  // no line map (pre-compile, older artifact)
                                  // the bubble would silently do nothing.
                                  onCommentSelection={
                                    pdfCommentsEnabled && canCommentOnActiveFile && synctexIndex
                                      ? handlePdfCommentSelection
                                      : undefined
                                  }
                                  // Overleaf-style: the compile cluster tops
                                  // the PDF pane — except in Source view,
                                  // where the collapsed pane stays mounted and
                                  // the toolbar seats the cluster instead
                                  // (rendering both would double every compile
                                  // control in the DOM). Mobile keeps it on
                                  // the full-width toolbar. `dense` (narrow
                                  // pane) sheds the cluster's diagnostics; the
                                  // bottom summary bar still carries them.
                                  headerCut
                                  headerLeft={
                                    !isMobile && latexViewMode !== 'source'
                                      ? ({ dense }: { dense: boolean }) => (
                                          <LatexCompileControls
                                            {...latexCompileProps}
                                            hideDiagnostics={dense}
                                          />
                                        )
                                      : undefined
                                  }
                                />
                              )}
                            />
                          </div>
                          {latexSuggestAutoFix ? (
                            <AutoFixSuggestionCard onAnswer={handleLatexAutoFixSuggestion} />
                          ) : showSynctexTip ? (
                            // Same floating slot; the auto-fix offer (an actual
                            // question) outranks the one-time teaching card.
                            <SyncTexTipCard onDismiss={dismissSynctexTip} />
                          ) : null}
                        </div>
                      ) : activeCodeFile ? (
                        <>
                          {hasRichViewer && showRichViewer && (
                            viewerContent !== null ? (
                              <>
                                {activeCsvFile && (
                                  <CSVViewer
                                    content={viewerContent}
                                    fileName={getFileName(activeWorkspaceFile.path)}
                                    // Only the editor's live ledger-merged set —
                                    // NOT the raw server `spacePendingAdditions`,
                                    // which still lists turns resolved in the
                                    // ledger and would re-show them as pending.
                                    pendingAdditions={csvLiveSuggestions ?? undefined}
                                    editable={!documentEditorReadOnly}
                                    suggesting={effectiveDocEditMode === 'suggest'}
                                    onRowOp={handleCsvRowOp}
                                    onResolveSuggestion={activeFileCap.canWrite ? handleCsvResolveSuggestion : undefined}
                                  />
                                )}
                                {activeJsonFile && (
                                  <JSONViewer
                                    content={viewerContent}
                                    fileName={getFileName(activeWorkspaceFile.path)}
                                  />
                                )}
                                {activeHtmlFile && (
                                  <HTMLViewer
                                    key={activeWorkspaceFile.id}
                                    content={viewerContent}
                                    fileName={getFileName(activeWorkspaceFile.path)}
                                  />
                                )}
                              </>
                            ) : (
                              <div className="border border-dashed border-stone-200 rounded-xl p-6 text-sm">
                                <Spinner label="Loading file content…" />
                              </div>
                            )
                          )}
                          <div
                            ref={reserveCommentLane ? commentLaneRowRef : null}
                            className={reserveCommentLane ? 'flex min-h-0 gap-3' : 'block'}
                          >
                            <div className="min-w-0 flex-1">
                              <CollabCodeEditor
                                key={activeWorkspaceFile.id}
                                fileId={activeWorkspaceFile.id}
                                filePath={activeWorkspaceFile.path}
                                collabPath={activeCollabPath}
                                workspaceId={projectId}
                                apiFetch={apiFetch}
                                user={collabUser}
                                readOnly={documentEditorReadOnly}
                                canResolveSuggestions={activeFileCap.canWrite}
                                editMode={effectiveDocEditMode === 'suggest' ? 'suggest' : 'edit'}
                                hidden={hasRichViewer && showRichViewer}
                                onReady={handleCodeEditorReady}
                                onContentChange={handleViewerContentChange}
                                onLocalEdit={activeTexFile ? noteLatexLocalEdit : undefined}
                                onConnectionStatusChange={setCollabStatus}
                                pendingAdditions={spacePendingAdditions}
                                onKeepAddition={handleSpaceKeepAddition}
                                onUndoAddition={handleSpaceUndoAddition}
                                onActiveSuggestionsChange={
                                  activeCsvFile
                                    ? (a) => setCsvLiveSuggestions(a as PendingAddition[])
                                    : undefined
                                }
                                onJumpToTurn={handleJumpToTurn}
                                revealPeer={peerReveal?.path === activeWorkspaceFile.path ? peerReveal : null}
                                onRevealPeerDone={handlePeerRevealDone}
                                onFocused={() => handleEditorFocusedPath(activeWorkspaceFile.path)}
                                {...codeCommentProps}
                              />
                            </div>
                            {commentLaneColumn}
                          </div>
                        </>
                      ) : (
                        <>
                          {showRawView && isMarkdownFile(activeWorkspaceFile) && markdownEditor ? (
                            <RawMarkdownEditor
                              editor={markdownEditor}
                              readOnly={documentEditorReadOnly}
                            />
                          ) : null}
                          {hasRichViewer && showRichViewer && (
                            viewerContent !== null ? (
                              <>
                                {activeCsvFile && (
                                  <CSVViewer
                                    content={viewerContent}
                                    fileName={getFileName(activeWorkspaceFile.path)}
                                    pendingAdditions={spacePendingAdditions}
                                  />
                                )}
                                {activeJsonFile && (
                                  <JSONViewer
                                    content={viewerContent}
                                    fileName={getFileName(activeWorkspaceFile.path)}
                                  />
                                )}
                                {activeHtmlFile && (
                                  <HTMLViewer
                                    key={activeWorkspaceFile.id}
                                    content={viewerContent}
                                    fileName={getFileName(activeWorkspaceFile.path)}
                                  />
                                )}
                              </>
                            ) : (
                              <div className="border border-dashed border-stone-200 rounded-xl p-6 text-sm">
                                <Spinner label="Loading file content…" />
                              </div>
                            )
                          )}
                          <div
                            ref={reserveCommentLane ? commentLaneRowRef : null}
                            className={
                              mdCommentLane
                                ? `flex min-h-0 ${docCentered ? 'justify-center' : 'justify-start'}`
                                : reserveCommentLane
                                  ? 'flex min-h-0 gap-3'
                                  : 'block'
                            }
                          >
                            <div
                              className={
                                mdCommentLane
                                  ? 'min-w-0 w-full max-w-5xl'
                                  : reserveCommentLane
                                    ? 'min-w-0 flex-1 max-w-5xl'
                                    : 'min-w-0 flex-1'
                              }
                              style={zoomWidenedMax('64rem')}
                            >
                              <MarkdownEditorFrame
                                editor={isMarkdownFile(activeWorkspaceFile) ? markdownEditor : null}
                                readOnly={documentEditorReadOnly}
                                showToolbar={false}
                                zoom={editorZoom}
                                lineHeight={editorLineHeight}
                                pageChrome={editorPageChrome}
                                hidden={
                                  showRawView ||
                                  (hasRichViewer && showRichViewer) ||
                                  !isMarkdownFile(activeWorkspaceFile)
                                }
                              >
                                {/* Inline title (⋯ → Show file title): the doc's
                                    H1 is the file name, display-only — mirrors
                                    .tiptap h1 metrics, never touches the
                                    markdown itself. */}
                                {showDocTitle && activeIsMarkdown && !showRawView ? (
                                  <h1 className="mb-3 text-[1.875rem] font-bold leading-[1.2]">
                                    {formatFileName(getFileName(activeWorkspaceFile.path)).replace(/\.[^.]+$/, '')}
                                  </h1>
                                ) : null}
                                <CollabEditor
                                  key={activeWorkspaceFile.id}
                                  fileId={activeWorkspaceFile.id}
                                  filePath={activeWorkspaceFile.path}
                                  collabPath={activeCollabPath}
                                  workspaceId={projectId}
                                  user={collabUser}
                                  readOnly={documentEditorReadOnly}
                                  canResolveSuggestions={activeFileCap.canWrite}
                                  forceSuggesting={!activeFileCap.canWrite}
                                  codeMode={hasRichViewer}
                                  hidden={showRawView || (hasRichViewer && showRichViewer)}
                                  onReady={handleEditorReady}
                                  onContentChange={hasRichViewer && showRichViewer ? handleViewerContentChange : undefined}
                                  onConnectionStatusChange={setCollabStatus}
                                  pendingAdditions={spacePendingAdditions}
                                  suggestionAuthors={spaceSuggestionAuthors}
                                  attributionRanges={showAuthorship ? authorshipRanges : undefined}
                                  onKeepAddition={handleSpaceKeepAddition}
                                  onUndoAddition={handleSpaceUndoAddition}
                                  onJumpToTurn={handleJumpToTurn}
                                  onNavigateToFile={(file) => {
                                    if (!file) return;
                                    // Claim a pane like every other open path:
                                    // a bare selection can't move the primary
                                    // when the file is already displayed in a
                                    // side pane, and the claim is what keeps
                                    // the primary's body and strip in step.
                                    if (isMobile) setSelectedFilePath(file);
                                    else {
                                      claimPrimaryWithFile(file);
                                      setOpenLeftRail('project');
                                    }
                                  }}
                                  onNavigateToWikiTarget={handleWikiNavigate}
                                  fetchWikiNoteText={fetchWikiNoteText}
                                  wikiLinkSuggestions={wikiLinkSuggestions}
                                  commentRanges={resolvedCommentRanges}
                                  draftCommentRange={draftCommentRange}
                                  activeCommentThreadId={activeCommentThreadId}
                                  onSelectComment={selectCommentThread}
                                  onImageDrop={handleEditorImageDrop}
                                  revealPeer={peerReveal?.path === activeWorkspaceFile.path ? peerReveal : null}
                                  onRevealPeerDone={handlePeerRevealDone}
                                  onFocused={() => handleEditorFocusedPath(activeWorkspaceFile.path)}
                                />
                              </MarkdownEditorFrame>
                            </div>
                            {commentLaneColumn}
                          </div>
                        </>
                      )}
                      </div>
                      </div>
                    </div>
                  ) : filesLoaded && chatsLoaded ? (
                    // Only once both lists have landed: "nothing open" is a
                    // statement about the workspace, and asserting it over a
                    // still-booting one is the arrival flash the founder read
                    // as an error.
                    <div className="flex flex-col items-center justify-center gap-3 h-full text-stone-400">
                      {/* Sunny scanning for something to open — the current
                          animation rig, same as every other empty surface. */}
                      <SunnyAnimation name="telescope" className="w-28 opacity-90" />
                      <p>Nothing open. Pick a file or chat from the sidebar.</p>
                    </div>
                  ) : null}
                </div>
                {/* Status pill: quiet file facts anchored INTO this doc pane's
                    bottom-right corner (never window-fixed, so it can't overlay
                    chats, empty states, or other panes). bottom-0/right-0 with
                    the radius + hairline on the two inner edges only, so it
                    reads as chrome rather than a card floating over the
                    document. Primary pane, real file documents only. */}
                {!isMobile &&
                activeWorkspaceFile &&
                activeWorkspaceFile.type !== 'folder' &&
                activeWorkspaceFile.type !== 'proposal' &&
                !isBinaryFile(activeWorkspaceFile) ? (
                  <div
                    data-testid="status-pill"
                    className="absolute bottom-0 right-0 z-20 flex items-center gap-1 rounded-tl-md border-l border-t border-stone-200 bg-white px-2.5 py-1 text-[11px] text-stone-500 print:hidden"
                  >
                    {/* Word/char counts live in their own component — the
                        per-keystroke updates must not re-render this page. */}
                    <DocStatsSpan editor={activeIsMarkdown ? markdownEditor : null} />
                    {/* Relative ("now", "5h", "Yesterday") — the full
                        date+time spent far more width than it earned. */}
                    <span
                      title={(() => {
                        const raw = activeWorkspaceFile.updated_at ?? activeWorkspaceFile.created_at;
                        return raw
                          ? new Date(raw).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                          : undefined;
                      })()}
                    >
                      {(() => {
                        const raw = activeWorkspaceFile.updated_at ?? activeWorkspaceFile.created_at;
                        return raw ? `Edited ${formatRelativeTimeShort(raw)}` : 'Edited recently';
                      })()}
                    </span>
                    {(isLocalWorkspace || canShowShareControls) && activeFileShare.status !== 'private' ? (
                      // Manages what it reports: the grant that actually
                      // covers this file (its own or an ancestor folder's),
                      // else the workspace share it inherits from. A scoped
                      // guest manages neither — for them it's a plain label.
                      openReportedShare ? (
                        <button type="button" onClick={openReportedShare} className="underline hover:text-stone-700">
                          · Shared
                        </button>
                      ) : (
                        <span>· Shared</span>
                      )
                    ) : isLocalWorkspace ? (
                      // Founder: unshared local files just say "Local" — no
                      // privacy sentence.
                      <span>· Local</span>
                    ) : null}
                  </div>
                ) : null}
                </>)}
                </div>
                </div>
                {editorTabDragActive && !isMobile ? (
                  <PaneDropOverlay
                    canSplit={editorPanes.length < MAX_EDITOR_PANES}
                    onDropTab={(payload, zone) => handlePaneBodyDrop(PRIMARY_PANE_ID, payload, zone)}
                    onZoneChange={(zone) => handlePaneZoneChange(PRIMARY_PANE_ID, zone)}
                  />
                ) : null}
              </div>
              {/* Secondary panes — lite collab editors created by splits. */}
              {!isMobile && projectId
                ? editorPanes.slice(1).map((paneEntry) => {
                    // Fallback via the pre-move path: a background reload
                    // racing an in-flight move can briefly restore the old
                    // server paths (same rule as activeWorkspaceFile).
                    const paneEntryMove = paneEntry.active
                      ? pendingPaneMoves.find((m) => isPathWithin(paneEntry.active, m.to))
                      : undefined;
                    const paneFile = paneEntry.active
                      ? workspaceFileByPath.get(paneEntry.active) ??
                        (paneEntryMove
                          ? workspaceFileByPath.get(
                              remapPath(paneEntry.active, paneEntryMove.to, paneEntryMove.from),
                            ) ?? null
                          : null)
                      : null;
                    // Keep the collab room on the pre-move path while a move
                    // covering this file is in flight (see pendingPaneMoves).
                    const frozenMove = paneFile
                      ? pendingPaneMoves.find((m) => isPathWithin(paneFile.path, m.to))
                      : undefined;
                    const paneCollabPath =
                      paneFile && frozenMove
                        ? remapPath(paneFile.path, frozenMove.to, frozenMove.from)
                        : paneFile?.path;
                    const paneChrome =
                      paneFile && paneFile.type !== 'folder' && !isBinaryFile(paneFile)
                        ? buildSplitPaneChrome(paneFile, paneEntry.id, paneEditors[paneEntry.id] ?? null)
                        : null;
                    return (
                      <div
                        key={paneEntry.id}
                        data-testid="editor-pane-secondary"
                        className="relative flex min-w-0 flex-1 flex-col overflow-hidden border-l border-stone-200 print:hidden"
                        style={{ flexGrow: paneGrow[paneEntry.id] ?? 1 }}
                        onPointerDownCapture={() => {
                          lastFocusedPaneIdRef.current = paneEntry.id;
                          setFocusedPaneId(paneEntry.id);
                        }}
                      >
                        {/* Boundary drag: resize this pane against its left
                            neighbor. Hidden during tab drags so the drop
                            overlay's left zone stays reachable at the edge. */}
                        {!editorTabDragActive ? (
                          <PaneResizeHandle onCommit={handlePaneResizeCommit} />
                        ) : null}
                        <div
                          data-testid="pane-squash"
                          data-squash={paneDropZone?.paneId === paneEntry.id ? paneDropZone.zone : undefined}
                          className="flex min-h-0 flex-1 flex-col transition-[margin] duration-150"
                          style={paneSquashStyle(
                            paneDropZone?.paneId === paneEntry.id ? paneDropZone.zone : undefined,
                          )}
                        >
                        {desktopTabs ? (
                        <div
                          className="flex shrink-0 items-stretch"
                          // The rightmost strip runs under the pinned top-right
                          // cluster while the dock is closed — reserve its width.
                          style={
                            paneEntry.id === editorPanes[editorPanes.length - 1].id &&
                            rightDockView === null &&
                            topbarRightWidth
                              ? { paddingRight: topbarRightWidth }
                              : undefined
                          }
                        >
                        <EditorTabStrip
                          className="min-w-0 flex-1"
                          dragRegion={isDesktopApp}
                          paneId={paneEntry.id}
                          tabs={paneEntry.tabs}
                          activePath={paneEntry.active}
                          formatLabel={tabLabel}
                          onActivate={(path) => handlePaneTabActivate(paneEntry.id, path)}
                          onCloseTab={(path) => handlePaneTabClose(paneEntry.id, path)}
                          onDropTab={(payload, index) => handlePaneTabDrop(paneEntry.id, payload, index)}
                          onTabDragChange={handleTabDragChange}
                          onSplitRight={(path) => handleTabSplitRight(paneEntry.id, path)}
                          canSplit={editorPanes.length < MAX_EDITOR_PANES}
                          renamingPath={
                            renameEntry?.source === 'tab' && renameEntry.paneId === paneEntry.id
                              ? renameEntry.path
                              : null
                          }
                          renameValue={renameEntry?.name ?? ''}
                          onBeginRename={(path) => handleBeginTabRename(paneEntry.id, path)}
                          onRenameValueChange={handleTabRenameValueChange}
                          onCommitRename={() => void commitRename()}
                          onCancelRename={cancelRename}
                          trailing={renderNewTabLauncher(paneEntry.id)}
                        />
                        </div>
                        ) : null}
                        <div className="relative flex min-h-0 flex-1 flex-col">
                          {isChatTab(paneEntry.active) ? renderChatSurface(false) : isLauncherTab(paneEntry.active) ? renderLauncherPanel(paneEntry.id) : isReviewTab(paneEntry.active) ? renderChatEditsSurface(paneEntry.active) : isDiffTab(paneEntry.active) ? renderDiffSurface(paneEntry.active) : (
                          <SplitEditorPaneReviewBody
                            file={paneFile}
                            collabPath={paneCollabPath}
                            onEditorFocused={handleEditorFocusedPath}
                            isMarkdown={isMarkdownFile(paneFile)}
                            isBinary={isBinaryFile(paneFile)}
                            workspaceId={projectId}
                            user={collabUser}
                            onMarkdownEditor={paneEditorSetter(paneEntry.id)}
                            // The primary's doc chrome + mode semantics, per
                            // file: header row, toolbar controls, and the
                            // same commenter pins (suggest-only, never resolve).
                            {...(paneChrome ?? {
                              readOnly: documentReadOnly || documentEditMode === 'view',
                              editMode: !canWrite || documentEditMode === 'suggest' ? 'suggest' : 'edit',
                              canResolveSuggestions: canWrite,
                              forceSuggesting: !canWrite,
                            })}
                            // Each split fetches its own pending turns, so
                            // Sunny's diffs stay reviewable in a pane showing
                            // a file other than the page's selection.
                            reviewWorkspaceId={projectId}
                            reviewApiFetch={apiFetch}
                            reviewInvalidationToken={pendingEditsInvalidationToken}
                            resolveAuthorLabel={resolvePendingEditAuthorLabel}
                            resolveAuthorVisual={resolvePendingEditAuthorVisual}
                            onJumpToTurn={handleJumpToTurn}
                          />
                          )}
                        </div>
                        </div>
                        {editorTabDragActive ? (
                          <PaneDropOverlay
                            canSplit={editorPanes.length < MAX_EDITOR_PANES}
                            onDropTab={(payload, zone) => handlePaneBodyDrop(paneEntry.id, payload, zone)}
                            onZoneChange={(zone) => handlePaneZoneChange(paneEntry.id, zone)}
                          />
                        ) : null}
                      </div>
                    );
                  })
                : null}
              </div>
              ) : null}
              {!isMobile && rightDockView !== null ? (
                <div
                  data-testid="right-dock"
                  style={panelViewActive ? undefined : { width: reviewPanelWidth }}
                  // max-lg:flex-1 gives it flex-basis 0, so the resized px width
                  // is ignored below lg and the flex-[2] editor keeps priority.
                  // Panel view: the dock IS the one surface, overlaying the pane
                  // full-width (the rail overlay at z-20 still wins above it).
                  className={panelViewActive
                    ? 'absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden bg-stone-50'
                    : 'order-3 relative flex min-h-0 min-w-[320px] max-lg:min-w-0 max-lg:flex-1 flex-col overflow-hidden bg-stone-50 border-l border-stone-200'}
                >
                  {panelViewActive ? null : (
                  <ResizeHandle
                    side="left"
                    min={REVIEW_PANEL_MIN_WIDTH}
                    max={getReviewPanelMax}
                    onCommit={(width) => handleReviewPanelCommit(Math.max(width, REVIEW_PANEL_MIN_WIDTH))}
                    onCollapse={closeRightDock}
                    // Below lg the center panels auto-share (flex, not px width),
                    // so the drag is a no-op there — drop the handle rather than
                    // leave a dead, misleading target.
                    className="max-lg:hidden"
                  />
                  )}
                  {/* The dock's own icon strip (Open Knowledge pattern): the
                      view switchers live ON the panel they change. The
                      deep-linked diff's Review link trails last — lower-key
                      than its old top-bar spot. Right padding clears the
                      pinned top-right cluster overlaying this row. */}
                  <div
                    data-testid="right-dock-strip"
                    className="flex h-11 shrink-0 items-center gap-1 border-b border-stone-200/60 bg-stone-100/70 px-2"
                    style={topbarRightWidth ? { paddingRight: topbarRightWidth + 8 } : undefined}
                  >
                    <button
                      type="button"
                      data-testid="dock-view-outline"
                      onClick={() => openRightDock('outline')}
                      aria-pressed={rightDockView === 'outline'}
                      aria-label="Outline"
                      className={`relative group/tip inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-stone-100 ${
                        rightDockView === 'outline' ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'
                      }`}
                    >
                      <ListBulletsIcon className="h-5 w-5" weight={rightDockView === 'outline' ? 'bold' : 'regular'} aria-hidden />
                      <IconTooltip label="Outline" />
                    </button>
                    <button
                      type="button"
                      data-testid="dock-view-history"
                      onClick={() => openRightDock('history')}
                      aria-pressed={rightDockView === 'history'}
                      aria-label="History"
                      className={`relative group/tip inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-stone-100 ${
                        rightDockView === 'history' ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'
                      }`}
                    >
                      <ClockCounterClockwiseIcon className="h-5 w-5" weight={rightDockView === 'history' ? 'bold' : 'regular'} aria-hidden />
                      <IconTooltip label="History" />
                    </button>
                    {savedFlags?.sundial_support_enabled === true ? (
                      <button
                        type="button"
                        data-testid="dock-view-support"
                        onClick={() => openRightDock('support')}
                        aria-pressed={rightDockView === 'support'}
                        aria-label="Sundial Support"
                        className={`relative group/tip inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-stone-100 ${
                          rightDockView === 'support' ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'
                        }`}
                      >
                        <ChatCircleDotsIcon className="h-5 w-5" weight={rightDockView === 'support' ? 'bold' : 'regular'} aria-hidden />
                        <IconTooltip label="Support" />
                      </button>
                    ) : null}
                    {standaloneDiffHref && isSpaceMode && selectedFilePath ? (
                      <Link
                        href={standaloneDiffHref}
                        className="ml-auto inline-flex h-7 shrink-0 items-center rounded-full border border-stone-200 px-2.5 text-[11px] font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-800"
                      >
                        Review
                      </Link>
                    ) : null}
                  </div>
                  {rightDockView === 'support' ? (
                    <div
                      ref={setSupportPanelHost}
                      data-testid="sundial-support-panel-host"
                      className="flex min-h-0 flex-1 flex-col"
                    />
                  ) : rightDockView === 'outline' ? (
                    <div data-testid="outline-lane" className="flex min-h-0 flex-1 flex-col py-2">
                      <MarkdownTOC headings={outlineLaneOpen ? outlineHeadings : []} onSelect={handleOutlineSelect} />
                      {!outlineLaneOpen ? (
                        <div className="px-4 py-2 text-xs text-stone-400">Open a markdown file to see its outline.</div>
                      ) : outlineHeadings.length === 0 ? (
                        <div className="px-4 py-2 text-xs text-stone-400">No headings yet</div>
                      ) : null}
                    </div>
                  ) : deepLinkedDiffId ? (
                    <>
                      <div className="flex h-9 shrink-0 items-center justify-between gap-2 bg-stone-50 px-3">
                        <span className="text-[13px] font-medium text-stone-700">Review</span>
                        <button
                          type="button"
                          onClick={closeReviewColumn}
                          aria-label="Close review"
                          data-testid="review-column-close"
                          className="relative group/tip inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                        >
                          <XIcon className="h-4 w-4" weight="bold" aria-hidden />
                          <IconTooltip label="Close" />
                        </button>
                      </div>
                      <div className="flex-1 min-h-0 overflow-auto">
                        <DiffReviewPanel
                          assistantMessageId={deepLinkedDiffId}
                          workspaceTitle={projectTitle}
                          workspaceHref={`/d/${encodeURIComponent(deepLinkedDiffId)}`}
                          onClose={closeReviewColumn}
                        />
                      </div>
                    </>
                  ) : (
                    <ReviewPanel
                      workspaceId={projectId}
                      currentChatId={currentChatId}
                      currentUserId={effectiveCurrentUserId}
                      activeFilePath={
                        activeWorkspaceFile && activeWorkspaceFile.type !== 'folder'
                          ? activeWorkspaceFile.path
                          : null
                      }
                      // Same Realtime `doc_edits` signal the inline diff overlay
                      // rides, so the timeline reflects your own typing (and a
                      // collaborator's) about a second after it persists,
                      // instead of on the panel's 4s backstop poll.
                      refreshKey={pendingEditsInvalidationToken}
                      onHandoffToChat={handleReviewHandoffToChat}
                      onOpenFile={handleOpenReviewFile}
                      onOpenChatTurn={handleOpenReviewChatTurn}
                      onClose={closeReviewColumn}
                      files={reviewFiles}
                      chats={reviewChats}
                    />
                  )}
                </div>
              ) : null}
              {/* Authorship lens hover card — before/after for the annotated run. */}
      {!isMobile && showAuthorship ? <AuthorshipHoverCard onOpenTurn={handleJumpToTurn} /> : null}
      {chatColumnVisible ? (
                // min-w-0: without it this flex child bottoms out at its
                // content's min width (the composer toolbar row), overflowing
                // narrow phones — the send/mic/model controls clipped off the
                // right edge, and the composer's own fold-into-＋ logic never
                // engaged because it measured the inflated row.
                <div className="order-3 relative flex min-h-0 min-w-0 flex-1 flex-col bg-stone-50">
                  {renderChatSurface(true)}
                </div>
              ) : null}
              </div>
            )}
            </div>
            {/* Pinned top-right cluster — absolute against this content row so
                it survives splits, the right dock, and the commit diff view. */}
            {!isMobile ? topBarRightControls : null}
            {!isMobile && !desktopTabs && openLeftRail === null && !docsHeaderOwnsTopLeft
              ? topBarLeftFloat
              : null}
          </div>

        </div>

      </div>

      <WorkspaceCommentContextMenu
        menu={commentContextMenu}
        menuRef={commentMenuRef}
        onOpenDraft={openCommentDraft}
        onOpenChat={openCommentChat}
        onAddLink={() => {
          dismissCommentContextMenu();
          // Editor listens for this on the window and opens the link inserter
          // for the currently-selected range (preserved through the menu).
          window.dispatchEvent(new CustomEvent('sundial:open-link-menu'));
        }}
      />

      {showAddRepoModal ? <AddRepoModal
        open={showAddRepoModal}
        onClose={() => setShowAddRepoModal(false)}
        projectId={projectId}
        onLinked={() => {
          setLinkedReposRefreshKey((k) => k + 1);
          // The clone action returns before the sandbox→doc-store mirror has
          // landed anything (minutes for large repos), and realtime drops
          // events on insert bursts — poll the tree until the count settles.
          pollFilesUntilSettled();
          // Land the user where push/pull/commit live for the repo they just added.
          openSyncSection();
        }}
      /> : null}
      {showAddOverleafModal ? <AddOverleafModal
        open={showAddOverleafModal}
        onClose={() => setShowAddOverleafModal(false)}
        projectId={projectId}
        onLinked={() => {
          setLinkedReposRefreshKey((k) => k + 1);
          pollFilesUntilSettled();
          openSyncSection();
        }}
        linkedProjects={linkedRepos
          .filter((r) => r.provider === 'overleaf')
          .map((r) => ({ id: r.id, label: r.repoLabel, joinLink: r.bridgeState?.joinLink ?? null }))}
        onOpenSync={openSyncSection}
      /> : null}
      <OpenWithModal
        open={showOpenWithModal}
        onClose={() => setShowOpenWithModal(false)}
        linkedRepos={linkedRepos.map((r) => ({
          id: r.id,
          provider: r.provider,
          label: r.repoLabel,
          htmlUrl: r.htmlUrl,
        }))}
        // Link flows hand off to the existing modals (sign-in gated, with the
        // return-trip deep link reopening them after Clerk).
        onLinkOverleaf={
          canWrite
            ? () => {
                setShowOpenWithModal(false);
                connectOrSignIn(() => setShowAddOverleafModal(true), { modal: 'addOverleaf' });
              }
            : undefined
        }
        onAddRepo={
          canWrite
            ? () => {
                setShowOpenWithModal(false);
                connectOrSignIn(() => setShowAddRepoModal(true), { modal: 'addRepo' });
              }
            : undefined
        }
        onAddRepoHover={() => prefetchRepositories(user?.id)}
      />
      {cloudSignInPrompt ? <CloudAgentSignInModal
        open={cloudSignInPrompt !== null}
        onCancel={() => setCloudSignInPrompt(null)}
        onSignIn={() => {
          const prompt = cloudSignInPrompt;
          setCloudSignInPrompt(null);
          if (!prompt) return;
          // Clerk reloads the page on success, which would drop the in-memory
          // draft — park it so the return trip rehydrates the composer.
          stashPendingDraft(projectId, prompt.draft);
          openSignIn(prompt.redirectUrl ? { redirectUrl: prompt.redirectUrl } : undefined);
        }}
      /> : null}
      {showAddSkillModal && <AddSkillModal
        open={showAddSkillModal}
        onClose={() => setShowAddSkillModal(false)}
        projectId={projectId}
        canSaveSecrets={canAccessSecrets === true}
        onAdded={(path) => {
          // `skills/` is agent metadata, so the new file would land invisible
          // if the eye toggle is off — reveal it, then open it.
          setShowAgentMetaFiles(true);
          setSelectedFilePath(path);
          pollFilesUntilSettled();
        }}
      />}
      {linkTextChatId ? <LinkTextChatModal
        open={Boolean(linkTextChatId)}
        chatId={linkTextChatId}
        chatLabel={chatEntries.find((entry) => entry.chat.id === linkTextChatId)?.chat.title ?? null}
        onClose={() => setLinkTextChatId(null)}
      /> : null}
      {projectId ? (
        <SchedulesPanel
          onRequireSignIn={() => {
            setSchedulesPanelMode(null);
            openSignIn({ redirectUrl: buildReturnPath({}) });
          }}
          open={schedulesPanelMode !== null}
          startInCreate={schedulesPanelMode === 'create'}
          onClose={() => setSchedulesPanelMode(null)}
          projectId={projectId}
          currentChatId={currentChatId && !isDraftChatId(currentChatId) ? currentChatId : null}
          onOpenChat={(chatId) => {
            setSchedulesPanelMode(null);
            void openChatById(chatId, { sidePanel: true });
          }}
        />
      ) : null}

      {/* Embedded panel (?view=panel): the floating surface switcher — every
          button REPLACES the single surface, mirroring the /g/show contract.
          Mobile widths keep their own one-surface nav. */}
      {panelViewActive && !isMobile ? (
        <PanelSurfaceSwitcher
          surfaces={panelSurfaces}
          active={panelActiveSurface}
          onSelect={showPanelSurface}
        />
      ) : null}

      {commandPaletteOpen ? <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        files={reviewFiles}
        priorityFiles={paletteOpenFiles}
        onOpenFile={(path) => {
          const file = workspaceFileByPath.get(path);
          if (!file || file.type === 'folder') return;
          setSidebarSections((prev) => expandSection(prev, 'files'));
          // A chooser-launched palette fills the CHOOSER's pane — in a split,
          // handleFileClick would claim whichever pane shows a file and
          // strand the New tab. replaceActiveTab consumes the launcher there.
          const targetPane = paletteTargetPaneId
            ? editorPanesRef.current.find((p) => p.id === paletteTargetPaneId)
            : undefined;
          if (targetPane && isLauncherTab(targetPane.active) && !isMobile) {
            setEditorPanes((prev) => {
              const next = replaceActiveTab(prev, targetPane.id, file.path);
              // Same withdrawal claimPrimaryWithFile does: a chooser opened
              // over a chat tab leaves the legacy 'chat' reveal intent set,
              // and a reload would re-cover the picked file with the chat.
              const chatStillVisible = next.some((pane) => isChatTab(pane.active));
              queueMicrotask(() => {
                if (!chatStillVisible) setOpenPanels((op) => removePanel(op, 'chat'));
              });
              return next;
            });
            lastFocusedPaneIdRef.current = targetPane.id;
            if (targetPane.id === PRIMARY_PANE_ID) {
              setSelectedFilePath(file.path);
              setSelectedCommit(null);
            }
            setWorkspaceViewMode('space');
            return;
          }
          // Replace semantics — handleFileClick is what every other open path
          // uses (an active launcher tab in the claimed pane is consumed).
          handleFileClick(file);
        }}
        chats={paletteChats}
        // Same semantics as clicking the chat in the rail — desktop shell
        // opens the chat tab (sundial-chat://), web shell replaces on the
        // right. A chooser-launched palette instead fills the CHOOSER's pane
        // (handlePaneTabActivate's chat path), consuming its launcher tab.
        onOpenChat={(chatId) => {
          const targetPane = paletteTargetPaneId
            ? editorPanesRef.current.find((p) => p.id === paletteTargetPaneId)
            : undefined;
          if (targetPane && isLauncherTab(targetPane.active) && !isMobile) {
            lastFocusedPaneIdRef.current = targetPane.id;
            setEditorPanes((prev) =>
              enforceSingleActiveChat(openPaneTab(prev, targetPane.id, chatTab(chatId)), targetPane.id),
            );
            void openChatByIdRef.current(chatId);
            return;
          }
          void openChatById(chatId, { sidePanel: true });
        }}
        // Chooser mode ("Open file" from a New-tab panel) is a file/chat
        // SEARCH: the global action rows would bypass the target-pane
        // consumption path (and the panel already offers create/chat/connect
        // itself), so they hide.
        actions={paletteTargetPaneId ? [] : paletteActions}
      /> : null}

      <ModalShell
        open={!isMobile && showSettingsModal}
        onClose={closeSettingsModal}
        ariaLabel="Workspace context"
        panelClassName="relative flex h-[min(88vh,860px)] w-full max-w-4xl flex-row overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-xl"
      >
        <button
          type="button"
          onClick={closeSettingsModal}
          aria-label="Close"
          className="absolute right-3 top-3 z-20 group/tip inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
        >
          <XIcon className="h-4 w-4" weight="bold" aria-hidden />
          <IconTooltip label="Close" />
        </button>

        <aside className="flex w-52 shrink-0 flex-col gap-4 border-r border-stone-200 bg-stone-50 p-3">
          <div className="flex items-center gap-2 px-2 pb-1 pt-1">
            <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md bg-orange text-white">
              <SunIcon className="h-3 w-3" weight="fill" aria-hidden />
            </span>
            <span className="text-[13.5px] font-medium text-stone-800">Settings</span>
          </div>
          <div className="space-y-0.5">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
              User
            </div>
            {renderContextTabButton('appearance', 'Appearance', <WorkspaceAppearanceIcon />)}
            {renderContextTabButton('preferences', 'Advanced', <WorkspacePreferencesIcon />)}
            {renderContextTabButton(
              'shortcuts',
              'Shortcuts',
              <KeyboardIcon className="h-4 w-4" weight="fill" aria-hidden />,
            )}
            {renderContextTabButton(
              'billing',
              'Billing',
              <CreditCardIcon className="h-4 w-4" weight="fill" aria-hidden />,
            )}
            {/* Apps (Composio connectors) hidden from the UI for now — re-enable later. */}
            {/* {renderContextTabButton('apps', 'Apps', <WorkspaceAppsIcon />)} */}
            {/* Integration tabs are cloud-workspace features (bridges sync into
                the cloud doc store) — hidden for local projects. */}
            {!isLocalWorkspace &&
              renderContextTabButton(
                'github',
                'GitHub',
                <GithubLogoIcon className="h-4 w-4" weight="fill" aria-hidden />,
              )}
            {!isLocalWorkspace &&
              renderContextTabButton(
                'overleaf',
                'Overleaf',
                <FileTextIcon className="h-4 w-4" weight="fill" aria-hidden />,
              )}
            {renderContextTabButton(
              'apikeys',
              'API keys',
              <KeyIcon className="h-4 w-4" weight="fill" aria-hidden />,
            )}
            {!isLocalWorkspace &&
              renderContextTabButton(
                'chatApps',
                'ChatGPT & Claude.ai',
                <SparkleIcon className="h-4 w-4" weight="fill" aria-hidden />,
              )}
            {/* The onboarding checklist's home since it left the sidebar. */}
            {renderContextTabButton(
              'gettingStarted',
              'Get set up',
              <CheckCircleIcon className="h-4 w-4" weight="fill" aria-hidden />,
            )}
          </div>
          <div className="space-y-0.5">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
              Workspace
            </div>
            {renderContextTabButton('workspace', 'Workspace', <WorkspaceInstructionsIcon />)}
            {canAccessSecrets === true && renderContextTabButton('secrets', 'Secrets', <WorkspaceSecretsIcon />)}
          </div>
          {/* Absent without a Clerk session to end (see OptionalClerkMethods). */}
          {clerkSignOut ? (
            <div className="mt-auto border-t border-stone-200 pt-2">
              <button
                type="button"
                onClick={() => void clerkSignOut({ redirectUrl: '/' })}
                data-testid="settings-sign-out"
                className="group/tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                <SignOutIcon className="h-4 w-4 shrink-0 text-stone-400 transition-colors group-hover/tab:text-orange" weight="regular" aria-hidden />
                <span className="truncate">Sign out</span>
              </button>
            </div>
          ) : null}
        </aside>

        <div className="flex min-h-0 flex-1 flex-col bg-white">
          {settingsTab === 'context' && renderContextOverviewPanel('desktop')}
          {settingsTab === 'apps' && renderAppsPanel('desktop')}
          {settingsTab === 'changes' && (
            <ReviewPanel
              workspaceId={projectId}
              currentChatId={currentChatId}
              currentUserId={effectiveCurrentUserId}
              // Folders aren't files: the "this file" quick pick filters by exact
              // path, so a selected folder must not pose as the active file
              // (mirrors the review-column mount's guard).
              activeFilePath={
                activeWorkspaceFile && activeWorkspaceFile.type !== 'folder'
                  ? activeWorkspaceFile.path
                  : null
              }
              refreshKey={currentChatChangesRefreshKey}
              onHandoffToChat={handleReviewHandoffToChat}
              onOpenFile={handleOpenReviewFile}
              onOpenChatTurn={handleOpenReviewChatTurn}
              files={reviewFiles}
              chats={reviewChats}
            />
          )}

          {settingsTab === 'workspace' && (
            <WorkspaceTab
              workspaceId={projectId}
              canWrite={canWrite}
              isOwner={isOwner}
              spaceInstructions={spaceInstructions}
              onSpaceInstructionsChange={setSpaceInstructions}
              agentsFile={agentsFile}
              onAgentsFileCreated={handleAgentsFileCreated}
              templateSlug={workspaceRouteContext?.initialFiles?.templateSlug ?? null}
              templateName={workspaceRouteContext?.initialFiles?.templateName ?? null}
              templateDefaultAddendum={workspaceRouteContext?.initialFiles?.templateDefaultAddendum ?? null}
              templateAddendumOverride={workspaceRouteContext?.initialFiles?.templateAddendumOverride ?? null}
              archivedChats={archivedChats.map((entry) => ({ id: entry.chat.id, title: entry.chat.title ?? null }))}
              onUnarchiveChat={canWrite ? (chatId) => void toggleChatArchive(chatId, false) : undefined}
            />
          )}

          {settingsTab === 'secrets' && canAccessSecrets === true && (
            <SecretsTab
              workspaceId={projectId}
              canWrite={canWrite}
            />
          )}

          {settingsTab === 'appearance' && (
            <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
              <AppearanceSection
                // Tabs/No tabs is desktop-shell chrome — the web build is
                // always tab-less, so the section hides there.
                tabs={desktopTabs}
                onSelectTabs={inDesktopShell ? setTabsEnabled : undefined}
              />
            </div>
          )}

          {settingsTab === 'preferences' && renderPreferencesPanel('desktop')}
          {settingsTab === 'shortcuts' && renderShortcutsPanel('desktop')}

          {settingsTab === 'billing' && (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <BillingSection />
            </div>
          )}

          {settingsTab === 'github' && !isLocalWorkspace && <UserGitHubTab />}

          {settingsTab === 'overleaf' && !isLocalWorkspace && <UserOverleafTab />}

          {settingsTab === 'apikeys' && <UserApiKeysTab />}

          {settingsTab === 'chatApps' && !isLocalWorkspace && <HostedConnectorTab />}
          {settingsTab === 'gettingStarted' && (
            <div className="max-w-xl px-6 py-8">
              <GetSetUpCard config={localConfig} projectId={projectId} />
            </div>
          )}
        </div>
      </ModalShell>


      <ModalShell
        open={showPrototypeGroupModal}
        onClose={closePrototypeGroupModal}
        ariaLabel="New group chat"
        overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 p-4"
        panelClassName="w-full max-w-2xl overflow-hidden rounded-[1.75rem] border border-stone-200 bg-white shadow-xl"
      >
        <div className="border-b border-stone-200 px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                New group chat
              </div>
              <h2 className="mt-2 text-lg font-semibold text-stone-900 sm:text-xl">
                Start a shared room for this workspace
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500">
                Group chats can include multiple teammates and assistants. Pick the participants and choose who responds by default when nobody is explicitly targeted.
              </p>
            </div>
            <button
              type="button"
              onClick={closePrototypeGroupModal}
              aria-label="Close"
              className="relative group/tip inline-flex h-9 w-9 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
            >
              <XIcon className="h-4 w-4" weight="bold" aria-hidden />
              <IconTooltip label="Close" />
            </button>
          </div>
        </div>

        <div className="max-h-[72vh] overflow-y-auto bg-stone-50 px-5 py-5 sm:px-6">
          <div className="space-y-5">
            <div className="rounded-2xl border border-stone-200 bg-white p-4">
              <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                Group name
              </label>
              <input
                value={prototypeGroupName}
                onChange={(event) => setPrototypeGroupName(event.target.value)}
                placeholder="Design review, launch pod, operations sync..."
                className="mt-3 w-full rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-800 outline-none transition-colors placeholder:text-stone-400 focus:border-stone-300 focus:bg-white"
              />
            </div>

            <div className="rounded-2xl border border-stone-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                    Teammates
                  </div>
                  <p className="mt-1 text-sm text-stone-500">
                    You are automatically included. Add the teammates who should share this group.
                  </p>
                </div>
                <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-[11px] font-medium text-stone-500">
                  {formatCountLabel(1 + prototypeGroupTeammateIds.length, 'person', 'people')}
                </span>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {teammateCandidates.length > 0 ? (
                  teammateCandidates.map((teammate) => {
                    const isSelected = prototypeGroupTeammateIds.includes(teammate.id);
                    return (
                      <button
                        key={teammate.id}
                        type="button"
                        onClick={() => handleTogglePrototypeGroupTeammate(teammate.id)}
                        className={`flex items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-colors ${
                          isSelected
                            ? 'border-stone-300 bg-stone-50 text-stone-700'
                            : 'border-stone-200 bg-stone-50 text-stone-700 hover:border-stone-300 hover:bg-white'
                        }`}
                      >
                        <HumanBubble
                          id={teammate.id}
                          name={teammate.name}
                          imageUrl={teammate.imageUrl}
                          initials={teammate.initials}
                          label={teammate.username ? `@${teammate.username}` : teammate.email ?? teammate.name}
                          size="md"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{teammate.name}</div>
                          {(teammate.username || teammate.email) && (
                            <div className="truncate text-[11px] text-stone-500">
                              {teammate.username ? `@${teammate.username}` : teammate.email}
                            </div>
                          )}
                        </div>
                        {isSelected ? <CheckCircleIcon className="h-4 w-4 shrink-0" weight="fill" aria-hidden /> : null}
                      </button>
                    );
                  })
                ) : (
                  <div className="rounded-2xl border border-dashed border-stone-200 bg-stone-50 px-4 py-4 text-sm text-stone-400">
                    No teammates in this workspace yet.
                  </div>
                )}
              </div>
            </div>

            {groupChatCreateError ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {groupChatCreateError}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-stone-200 bg-white px-5 py-4 sm:px-6">
          <div className="text-[11px] leading-5 text-stone-500">
            The chat will open immediately in this workspace and use the selected default responder until a message override is chosen.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closePrototypeGroupModal}
              disabled={isCreatingGroupChat}
              className="rounded-full border border-stone-200 px-4 py-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreatePrototypeGroup()}
              disabled={isCreatingGroupChat}
              className="rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isCreatingGroupChat ? 'Creating…' : 'Create group chat'}
            </button>
          </div>
        </div>
      </ModalShell>

      {/* Mobile overlay panels */}
      {/* The unified mobile side panel ('files' is a legacy name): files tree
          + chats stacked, mirroring the desktop rail — the old separate chats
          drawer folded in here (founder: one side panel, not two icons). */}
      {isMobile && mobilePanel === 'files' && (
        // h-dvh (not inset-0): the visible-viewport height, so the bottom of
        // the list can't hide behind iOS Safari's toolbar (inset-0 spans the
        // taller layout viewport).
        <div className="fixed inset-x-0 top-0 z-50 h-dvh bg-white flex flex-col">
          <div className="h-12 px-4 flex items-center justify-between border-b border-stone-100 shrink-0">
            {/* The files list is the workspace's contents, so its header
                carries the workspace identity + switcher — the only workspace
                menu on mobile while a file fills the main view (the merged
                top bar there is per-file chrome). */}
            <div className="relative flex min-w-0 flex-1 items-center gap-2" ref={workspaceSwitcherRef}>
              {isEditingTitle && canWrite ? (
                <input
                  autoFocus
                  className="w-full min-w-0 bg-transparent text-sm font-semibold text-stone-800 outline-none"
                  value={editingTitleValue}
                  onChange={(e) => setEditingTitleValue(e.target.value)}
                  onBlur={() => saveProjectTitle(editingTitleValue)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      saveProjectTitle(editingTitleValue);
                    } else if (e.key === 'Escape') {
                      setIsEditingTitle(false);
                    }
                  }}
                  maxLength={200}
                />
              ) : (
                <button
                  type="button"
                  onClick={toggleWorkspaceSwitcher}
                  data-workspace-switcher-trigger
                  className="flex min-w-0 items-center gap-1.5 rounded-lg text-left"
                  title={projectTitle}
                >
                  {/* New identity style: kind icon + name, no caret — tap
                      opens the workspace menu (mobile has no right-click). */}
                  {workspaceKindIcon}
                  <span className="truncate text-sm font-semibold text-stone-800">{projectTitle}</span>
                </button>
              )}
              {workspaceSwitcherMenu}
            </div>
            <div className="flex items-center gap-1">
              {canWrite && (
                <button
                  onClick={() => void handleCreateFile()}
                  aria-label="New file"
                  className="relative group/tip h-9 w-9 flex items-center justify-center rounded-lg text-stone-400 hover:text-stone-600 hover:bg-stone-100"
                >
                  <PlusIcon className="w-4 h-4" weight="bold" aria-hidden />
                  <IconTooltip label="New file" />
                </button>
              )}
              <button onClick={() => setMobilePanel(null)} aria-label="Close" className="p-2 -mr-1 rounded-lg hover:bg-stone-100 text-stone-400">
                <XIcon className="w-5 h-5" weight="bold" aria-hidden />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto px-4 py-3">
            <div className="space-y-3">
              <div className="space-y-0.5">
                {(foldersByParent.__root__ ?? []).map((folder) => renderMobileFolder(folder))}
                {rootFiles.map((file) => {
                  const isSelected = selectedFilePath === file.path;
                  return (
                    <div
                      key={file.id}
                      onClick={() => handleFileClick(file)}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${getSidebarListItemStateClasses(isSelected)}`}
                    >
                      <WorkspaceEntryIcon
                        path={file.path}
                        className="h-[18px] w-[18px] flex-shrink-0"
                      />
                      <span className="truncate">{formatFileName(getFileName(file.path))}</span>
                    </div>
                  );
                })}
              </div>
              {(foldersByParent.__root__ ?? []).length === 0 && rootFiles.length === 0 && filesLoaded && (
                <div className="px-1 text-sm text-stone-400">No files yet.</div>
              )}
              <div className="border-t border-stone-100 pt-3">
                <div className="mb-1 flex items-center justify-between px-1">
                  <span className="text-sm font-semibold text-stone-800">Chats</span>
                  {canWrite && (
                    <button
                      type="button"
                      onClick={guideAssistantPickerFromSidebar}
                      aria-label="New chat"
                      data-testid="new-chat-button"
                      className="relative group/tip p-1.5 rounded-lg hover:bg-stone-100 text-stone-500"
                    >
                      <PlusIcon className="w-4 h-4" weight="bold" aria-hidden />
                      <IconTooltip label="New chat" />
                    </button>
                  )}
                </div>
                <div className="space-y-1">{renderChatRail('mobile')}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isMobile && showReviewPanel && deepLinkedDiffId ? (
        // h-dvh: same iOS visible-viewport rule as the files drawer — the
        // review footer actions must not sit behind Safari's bottom bar.
        <div data-testid="mobile-diff-review" className="fixed inset-x-0 top-0 z-50 flex h-dvh flex-col bg-white">
          <DiffReviewPanel
            assistantMessageId={deepLinkedDiffId}
            workspaceTitle={projectTitle}
            workspaceHref={`/d/${encodeURIComponent(deepLinkedDiffId)}`}
            onClose={closeReviewPanel}
          />
        </div>
      ) : null}

      <ModalShell
        open={Boolean(chatDetailsEntry)}
        onClose={() => setChatDetailsChatId(null)}
        ariaLabel="Chat details"
        overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
        panelClassName="w-full max-w-md rounded-2xl border border-stone-200 bg-white shadow-xl"
      >
        {chatDetailsEntry ? (
          <div className="px-5 pt-5 pb-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-stone-400">
                  Chat details
                </div>
                <h2 className="mt-2 truncate text-base font-semibold text-stone-800">{chatDetailsDisplayName}</h2>
                {typeof chatDetailsEntry.chat.sunny_number === 'number' && (
                  <div className="mt-0.5 text-[11px] font-medium text-amber-700">
                    Agent #{chatDetailsEntry.chat.sunny_number}
                  </div>
                )}
                <p className="mt-1 truncate text-sm text-stone-500">{chatDetailsPreview}</p>
              </div>
              <button
                type="button"
                onClick={() => setChatDetailsChatId(null)}
                aria-label="Close"
                className="relative group/tip rounded-lg p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
              >
                <XIcon className="h-5 w-5" weight="bold" aria-hidden />
                <IconTooltip label="Close" />
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Model</div>
                <div className="mt-1 text-sm font-medium text-stone-800">{chatDetailsModelLabel}</div>
              </div>
              <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Last activity</div>
                <div className="mt-1 text-sm font-medium text-stone-800">
                  {formatAbsoluteDateTime(chatDetailsEntry.chat.last_message_at)}
                </div>
              </div>
              <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Runtime</div>
                <div className="mt-1 text-sm font-medium text-stone-800">
                  {formatSessionDurationSeconds(chatDetailsDurationSeconds) ?? 'Not available yet'}
                </div>
              </div>
              <div className="rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Cost</div>
                <div className="mt-1 text-sm font-medium text-stone-800">
                  {formatCostUsd(chatDetailsSessionMetrics?.totalCostUsd) ?? 'Not available yet'}
                </div>
              </div>
            </div>

            {chatDetailsLoopSummary ? (
              <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 px-3 py-3">
                <div className="mb-2 flex items-center gap-2 text-sm text-stone-800">
                  <span className="font-medium">Loop mode</span>
                  {chatDetailsLoopStatusLabel && chatDetailsLoopStatusClass ? (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${chatDetailsLoopStatusClass}`}>
                      {chatDetailsLoopStatusLabel}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-1 text-xs text-stone-700">
                  <div>
                    Budget {formatLoopBudgetValue(chatDetailsLoopSummary.budgetType, chatDetailsLoopSummary.budgetUsed)} /{' '}
                    {formatLoopBudgetValue(chatDetailsLoopSummary.budgetType, chatDetailsLoopSummary.budgetLimit)}
                  </div>
                  <div>Iterations {chatDetailsLoopSummary.turnCount}</div>
                  {chatDetailsLoopActorPhase ? <div>{chatDetailsLoopActorPhase}</div> : null}
                  {chatDetailsLoopSummary.latestStep?.what ? <div>{clipText(chatDetailsLoopSummary.latestStep.what, 120)}</div> : null}
                </div>
              </div>
            ) : null}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setChatDetailsChatId(null)}
                className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800"
              >
                Close
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>

      {localConfig && projectId && localShareScope ? (
        <ShareLocalModal
          config={localConfig}
          project={{ id: projectId, name: projectTitle || 'Local project', root: '', created_at: '' }}
          scope={localShareScope}
          shares={localShares}
          onClose={() => {
            setLocalShareScope(null);
            // The modal mutates the backing workspace's grants and ACL
            // through its OWN reads — re-read ours or the header keeps
            // reporting an audience the modal just emptied.
            void refreshLocalBackingAudience();
            void refreshLocalBackingAcl();
          }}
          onShared={() => {
            void refreshLocalShares();
            void refreshLocalBackingAudience();
            void refreshLocalBackingAcl();
            void reloadFiles(false);
          }}
        />
      ) : null}

      {!isLocalWorkspace && pathShareScope && cloudProjectId ? (
        <PathShareModal
          projectId={cloudProjectId}
          scope={pathShareScope}
          shares={cloudPathShares}
          sharesLoaded={cloudPathSharesLoaded}
          refresh={refreshCloudPathShares}
          onClose={() => setPathShareScope(null)}
          // A per-path grant is only as narrow as the workspace around it —
          // its link, its own audience, and any grant above or inside this
          // scope. Name them rather than let a scoped share imply scoped
          // access; this modal lists none of them.
          broaderAccess={(() => {
            const label = broaderAccessLabel({
              scopeKind: pathShareScope.kind,
              linkShared: isLinkSharedInfo(shareInfo),
              // NOT `shareStatus === 'shared'`: the status collapses to
              // 'public' when a link is also on, and the named audience —
              // still there after the link is revoked — would go unnamed.
              workspaceAudience,
              overlaps: overlappingPathShares(cloudPathShares, pathShareScope.path),
            });
            if (!label) return null;
            return {
              label,
              ...(isLinkSharedInfo(shareInfo) && shareInfo?.isOwner
                ? { onRestrict: () => handleVisibilityChange('private') }
                : {}),
            };
          })()}
        />
      ) : null}

      {canShowShareControls && showShareModal ? <WorkspaceShareModal
        open={canShowShareControls && showShareModal}
        projectTitle={projectTitle}
        userId={user?.id}
        shareInfo={shareInfo}
        shareError={shareError}
        copyNotice={copyNotice}
        canManageShare={canManageShare}
        canInviteShare={canInviteShare}
        pendingEmailInvites={pendingEmailInvites}
        inviteEmail={inviteEmail}
        setInviteEmail={setInviteEmail}
        inviteRole={inviteRole}
        setInviteRole={setInviteRole}
        shareDropdown={shareDropdown}
        setShareDropdown={setShareDropdown}
        shareBusyAction={shareBusyAction}
        onClose={() => {
          setShowShareModal(false);
          setShareDropdown(null);
        }}
        onCreateEmailInvite={handleCreateEmailInvite}
        onCreateLinkInvite={handleCreateLinkInvite}
        onUpdateMemberRole={handleUpdateMemberRole}
        onRemoveMember={handleRemoveMember}
        onResendInvite={handleResendShareInvite}
        onRevokeInvite={handleRevokeShareInvite}
        onVisibilityChange={handleVisibilityChange}
        onPublicAccessChange={handlePublicAccessChange}
        onOpenTeamPermissions={handleOpenTeamPermissions}
        onOpenLocalAgent={isLocalWorkspace ? undefined : openLocalAgentModal}
        formatRelativeTime={formatRelativeTimeShort}
      /> : null}

      {/* Chat share — the full GDocs modal against the workspace ACL (chats
          inherit it): people, chat-targeted workspace invites, and the
          workspace's general access, which gates whether the chat link opens.
          Local chats never open this — openChatShare routes them to the local
          share modal. */}
      {showChatShareModal && currentChatLink ? <WorkspaceShareModal
        open={showChatShareModal && Boolean(currentChatLink)}
        subject="chat"
        projectTitle={currentChatHeaderTitle}
        userId={user?.id}
        shareInfo={shareInfo}
        shareError={shareError}
        copyNotice={copyNotice}
        canManageShare={canManageShare}
        canInviteShare={canInviteShare}
        pendingEmailInvites={pendingEmailInvites}
        inviteEmail={inviteEmail}
        setInviteEmail={setInviteEmail}
        inviteRole={inviteRole}
        setInviteRole={setInviteRole}
        shareDropdown={shareDropdown}
        setShareDropdown={setShareDropdown}
        shareBusyAction={shareBusyAction}
        onClose={() => {
          setShowChatShareModal(false);
          setShareDropdown(null);
        }}
        onCreateEmailInvite={handleCreateEmailInvite}
        onCreateLinkInvite={handleChatShareCopyLink}
        onUpdateMemberRole={handleUpdateMemberRole}
        onRemoveMember={handleRemoveMember}
        onResendInvite={handleResendShareInvite}
        onRevokeInvite={handleRevokeShareInvite}
        onVisibilityChange={handleVisibilityChange}
        onPublicAccessChange={handlePublicAccessChange}
        onOpenTeamPermissions={handleOpenTeamPermissions}
        formatRelativeTime={formatRelativeTimeShort}
        accessCaption="General access applies to the whole workspace, including this chat."
      /> : null}

      <WorkspaceLocalAgentModal
        open={showLocalAgentModal}
        loading={localAgentLoading}
        error={localAgentError}
        joinInfo={localAgentJoinInfo}
        copied={localAgentCopied}
        onClose={() => setShowLocalAgentModal(false)}
        onCopy={copyLocalAgentText}
        activeCollaborators={activeWorkspaceCollaborators}
        projectId={projectId}
      />

      {(() => {
        const agent = localAgentModeAgentId
          ? activeWorkspaceCollaborators.find(
              (c) => c.kind === 'local-agent' && c.agentId === localAgentModeAgentId,
            ) ?? null
          : null;
        return (
          <LocalAgentModeModal
            agent={agent}
            suggestOnly={localAgentModeOptimistic ?? agent?.suggestOnly ?? false}
            saving={localAgentModeSaving}
            error={localAgentModeError}
            onClose={() => setLocalAgentModeAgentId(null)}
            onSuggestOnlyChange={(next) => {
              if (agent?.agentId) void handleLocalAgentSuggestOnlyChange(agent.agentId, next);
            }}
          />
        );
      })()}

      {chatPendingDelete ? <DeleteChatDialog
        open={Boolean(chatPendingDelete)}
        chatTitle={chatPendingDelete?.title ?? null}
        onCancel={() => setChatPendingDelete(null)}
        onConfirm={() => {
          const target = chatPendingDelete;
          setChatPendingDelete(null);
          if (target) void deleteChat(target.id);
        }}
      /> : null}

      <WorkspaceNoticeToast notice={workspaceAppNotice} onClose={clearWorkspaceAppNotice} />

    </div>
    </ApiFetchProvider>
  );
}
