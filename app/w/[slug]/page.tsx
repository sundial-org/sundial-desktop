'use client';

import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, memo, type DragEvent, type MutableRefObject, type ReactNode , type CSSProperties } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SunnyAnimation } from '@/components/sunny-animation';
import { SunnyLottie } from '@/components/sunny-lottie';
import { isLatexSourceFile } from '@/lib/sync/policy';
import { useAuth, useClerk, useUser, SignInButton } from '@/lib/auth/optional-auth';
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  CaretUpIcon,
  ChatTeardropIcon,
  MagnifyingGlassIcon,
  FilePlusIcon,
  TextAaIcon,
  ChatTextIcon,
  CodeIcon,
  CreditCardIcon,
  DiscordLogoIcon,
  ExportIcon,
  EyeIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GithubLogoIcon,
  GlobeHemisphereWestIcon,
  DetectiveIcon,
  HouseIcon,
  KeyIcon,
  LightningIcon,
  ChatsCircleIcon,
  ListIcon,
  SparkleIcon,
  MegaphoneIcon,
  NotePencilIcon,
  ClockCounterClockwiseIcon,
  SidebarSimpleIcon,
  SunIcon,
  WrenchIcon,
  // PlugsConnectedIcon, // Apps (Composio connectors) icon hidden for now
  PlusIcon,
  UserIcon,
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
  WORKSPACE_LAYOUT_STORAGE_KEY,
  workspaceLayoutStorageKey,
  type CenterPanel,
  type WorkspaceViewKey,
  type WorkspaceViewRefs,
} from '@/lib/workspace/layout';
import { ANON_AUTHOR_PREFIX, anonDisplayName, toAnonAuthorId } from '@/lib/auth/anon-identity';
import { createLocalBinaryUpload, createLocalWorkspaceFetch } from '@/lib/local/workspace-api';
import { ApiFetchProvider } from '@/lib/workspace/api-fetch-context';
import { getLaunchParam, resolveSidecarConfig, sidecar as localSidecar, type SidecarConfig } from '@/lib/local/sidecar';
import { desktopCredentialsUsable } from '@/lib/local/desktop-creds';
import { useDesktopCredentials } from '@/lib/local/use-desktop-credentials';
import { useDesktopProfile } from '@/lib/local/use-desktop-profile';
import { useLocalShares } from '@/lib/local/use-local-shares';
import { excludeSelfPeers, useLocalCollabPresence } from '@/lib/local/use-local-presence';
import { useWorkspaceCollabSocket } from '@/lib/workspace/collab-socket-context';
import { ShareLocalModal } from '@/components/local/share-local-modal';
import { useClaimAnonOnLogin } from '@/lib/auth/use-claim-anon-on-login';
import { buildReturnPath } from '@/lib/auth/use-require-signin';
import type { Editor } from '@tiptap/react';
import { CollabEditor, type PendingAddition } from '@/components/workspace/collab-editor';
import { EditorTabStrip } from '@/components/workspace/editor-tab-strip';
import { PaneDropOverlay, SplitEditorPaneReviewBody, useDocAlignLeft } from '@/components/workspace/split-editor-pane';
import {
  closeTab as closePaneTab,
  createInitialPanes,
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
import { chatTab, chatIdOfTab, diffIdOfTab, isChatTab, isSpecialTab } from '@/lib/workspace/editor-tabs';
import { CollabCodeEditor, type CodeEditorHandle } from '@/components/workspace/collab-code-editor';
import { CommandPalette, type CommandPaletteAction } from '@/components/workspace/command-palette';
import { LatexPdfPane } from '@/components/workspace/latex-pdf-pane';
import { LatexWorkbench, type LatexViewMode } from '@/components/workspace/latex-workbench';
import { LatexEditorToolbar, latexEditorRefHandlers } from '@/components/workspace/latex-editor-toolbar';
import { useLatexCompile } from '@/components/workspace/use-latex-compile';
import { CompileSummaryBar } from '@/components/workspace/compile-summary-bar';
import { buildCompileFixPrompt } from '@/lib/latex/fix-prompt';
import { parseSyncTex, type SyncTexIndex } from '@/lib/latex/synctex';
import { latexCompileTarget, useLatexMainDocument } from '@/components/workspace/latex-main-document';
import { buildActionableWorkspacePendingAdditions, defaultAuthorLabel } from '@/lib/workspace/pending-additions';
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
import { BillingSection } from '@/components/workspace/billing-section';
import { CreditBalancePill } from '@/components/workspace/credit-balance-pill';
import { UserGitHubTab } from '@/components/workspace/user-github-tab';
import { UserOverleafTab } from '@/components/workspace/user-overleaf-tab';
import { UserApiKeysTab } from '@/components/workspace/user-api-keys-tab';
import { AddRepoModal } from '@/components/workspace/add-repo-modal';
import { AddOverleafModal } from '@/components/workspace/add-overleaf-modal';
import { LinkTextChatModal } from '@/components/workspace/link-text-chat-modal';
import { useLinkedRepos } from '@/lib/workspace/use-linked-repos';
import { CommitsRail } from '@/components/workspace/commits-rail';
// Tasks (scheduled chats) hidden from the UI for now — re-enable later.
// import { TasksRail } from '@/components/workspace/tasks-rail';
import { CommitDiffViewer } from '@/components/workspace/commit-diff-viewer';
import { track } from '@/lib/analytics/track';
import { RawMarkdownEditor } from '@/components/workspace/raw-markdown-editor';
import { MarkdownTOC } from '@/components/workspace/markdown-toc';
import type { TocHeading } from '@/lib/markdown/toc';
import { MarkdownEditorFrame, type MarkdownPageChrome } from '@/components/workspace/markdown-editor-frame';
import { EditModeControl } from '@/components/workspace/edit-mode-control';
import { useDocumentEditMode } from '@/lib/workspace/document-edit-mode-context';
import { MarkdownToolbar } from '@/components/workspace/markdown-toolbar';
import { MarkdownMenuBar } from '@/components/workspace/markdown-menu-bar';
import { Spinner } from '@/components/ui/spinner';
import { DocCommentsPanel } from '@/components/workspace/doc-comments-panel';
import { ImageViewer } from '@/components/workspace/viewers/image-viewer';
import { CSVViewer } from '@/components/workspace/viewers/csv-viewer';
import { JSONViewer } from '@/components/workspace/viewers/json-viewer';
import { HTMLViewer } from '@/components/workspace/viewers/html-viewer';
import { useWorkspaceUploads } from '@/components/workspace/use-workspace-uploads';
import { uploadImageFromEditor } from '@/lib/workspace/upload-image-from-editor';
import { safeGetEditorText } from '@/lib/workspace/safe-editor-text';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { createBrowserClient } from '@/lib/supabase/browser';
import { useVoiceInput } from '@/lib/hooks/use-voice-input';
import { ensureUniquePath, formatBytes, sanitizeFilename } from '@/lib/workspace/uploads';
import { type WorkspaceKind } from '@/lib/workspace/kinds';
import { ModalShell } from '@/components/modal-shell';
import { WorkspaceTab, SecretsTab, findRootAgentsFile } from '@/components/workspace/config-tab';
import { PreferencesSection } from '@/components/workspace/preferences-section';
import { ReviewPanel } from '@/components/workspace/review-panel';
import { DiffReviewPanel } from '@/components/workspace/diff-review-panel';
import { getCachedTurnEdits } from '@/lib/workspace/turn-edits-cache';
import { clerkNeverLoads, isDesktopApp as isDesktopShell } from '@/lib/desktop';
import { computeSessionDurationSeconds } from '@/lib/workspace/agent-runtime';
import {
  buildWorkspacePath,
  buildWorkspaceFilePath,
  buildWorkspaceChatPath,
} from '@/lib/workspace/paths';
import { CopyLinkButton } from '@/components/workspace/copy-link-button';
import { FileShareMenu } from '@/components/workspace/file-share-menu';
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
import { useChatModels } from '@/lib/workspace/use-models';
import type { ConnectedAppSummary } from '@/lib/composio/types';
import { AppsPanel } from './_components/apps-panel';
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
import { useSundialChat } from '@/lib/agent/use-sundial-chat';
import { useRunCompletionCue } from '@/lib/agent/use-run-completion-cue';
import { decideChatAction } from '@/lib/agent/chat-action';
import { useWorkspaceFileLifecycle, type WorkspaceStorageUsage } from './_components/workspace-file-lifecycle';
import {
  useWorkspaceActiveFileEffects,
  useWorkspaceFileEditingEffects,
  useWorkspaceFileInputEffects,
} from './_components/workspace-file-ui-effects';
import { useWorkspaceShare, shareOrigin } from './_components/workspace-share';
import { DocColumnControls, DocFileNameControl } from './_components/doc-column-controls';
import { useWorkspaceComments, WorkspaceCommentContextMenu } from './_components/workspace-comments';
import { WorkspaceShareModal } from './_components/workspace-share-modal';
import { LocalAgentModeModal, WorkspaceLocalAgentModal, useWorkspaceLocalAgent } from './_components/workspace-local-agent-modal';
import { HostedConnectorTab } from '@/components/workspace/hosted-connector-tab';
import { useWorkspaceLinkCopy } from './_components/workspace-link-copy';
import { SidebarIdentity } from './_components/sidebar-identity';
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
  readFileOrder,
  ROOT_ORDER_KEY,
  sortByManualOrder,
  writeFileOrder,
  type FileOrderMap,
} from '@/lib/workspace/file-order';
import { AnchoredDropdown } from '@/components/workspace/anchored-dropdown';
// Scheduled tasks hidden from the UI for now — re-enable later.
// import { ScheduleChip } from '@/components/workspace/schedule-chip';
import {
  shouldCollapseLatexPdfForChatOpen,
  isAgentTurnJustFinished,
  isAgentTurnJustStarted,
  type LatexChatCollapseState,
} from '@/lib/workspace/latex-layout';
import { WorkspaceChatPane } from './_components/workspace-chat-pane';
import { LocalEngineOnboarding } from './_components/local-engine-onboarding';
import { ChatArrivalHero } from './_components/chat-arrival-hero';
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
  firstEditableTurnEditPath,
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
  setSidebarDragGhost,
  shouldDefaultRichViewer,
  WorkspaceEntryIcon,
  WorkspaceRootGlyph,
} from './_components/workspace-file-helpers';

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
const externalAgentHome = (external: ExternalSessionRef) => (external.agent === 'codex' ? '~/.codex' : '~/.claude');
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

const EDITOR_PANES_KEY_PREFIX = 'sundial:editor-panes:';

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
function WorkspaceShareStatusIcon({ status, className }: { status: string | null | undefined; className: string }) {
  if (status === 'public') {
    return <GlobeHemisphereWestIcon className={className} weight="regular" aria-hidden />;
  }
  if (status === 'shared') {
    return <UsersThreeIcon className={className} weight="regular" aria-hidden />;
  }
  return <UserIcon className={className} weight="regular" aria-hidden />;
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
  const projectId = workspaceRouteContext?.projectId ?? resolveWorkspaceId(projectSlug);
  const initialFilesPayload = workspaceRouteContext?.initialFiles ?? null;
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
        : (input, init) => fetch(input, init),
    [localConfig, projectId],
  );
  // Local engines (the user's own Claude Code / Codex installs) + the
  // install's default engine for new chats. Optimistic until the probe
  // answers: engines assumed detected (a wrong guess only mislabels a hint —
  // the run surfaces the real error) and defaultHarness assumed chosen (so
  // the first-run onboarding card never flashes for returning users).
  // defaultHarness: undefined = probe in flight (assume chosen, defer to the
  // sidecar's stored default), null = probed and never chosen (show the
  // first-run picker), value = the chosen default.
  const [localEngines, setLocalEngines] = useState<{
    claude: { available: boolean; loggedIn: boolean };
    codex: { available: boolean; loggedIn: boolean };
    defaultHarness: ChatHarness | null | undefined;
  }>({
    claude: { available: true, loggedIn: true },
    codex: { available: true, loggedIn: true },
    defaultHarness: undefined,
  });
  useEffect(() => {
    if (!localConfig) return;
    let cancelled = false;
    localSidecar
      .localEngines(localConfig)
      .then(({ claude, codex, defaultHarness }) => {
        if (cancelled) return;
        setLocalEngines({
          claude,
          codex,
          defaultHarness: defaultHarness === null ? null : parseChatHarness(defaultHarness),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [localConfig]);
  const localEnginesRef = useRef(localEngines);
  localEnginesRef.current = localEngines;
  const chooseLocalDefaultEngine = useCallback(
    (harness: ChatHarness) => {
      setLocalEngines((prev) => ({ ...prev, defaultHarness: harness }));
      // Mirror the sidecar's legacy-chat adoption (adoptDefaultHarness):
      // already-loaded empty null-harness chats follow the pick too, so their
      // labels and the pre-send engine resolution don't need a reload. Only
      // after the sidecar acks — its rows are what the run actually reads, so
      // stamping ahead of (or despite a failed) POST would let a send skip
      // the sign-in gate while the sidecar still runs the chat as Sunny.
      if (localConfig) {
        void localSidecar
          .setDefaultHarness(localConfig, harness)
          .then(() => {
            setChatThreads((prev) =>
              prev.map((thread) =>
                thread.chat.harness == null && (thread.chat.message_count ?? 0) === 0
                  ? {
                      ...thread,
                      chat: {
                        ...thread.chat,
                        harness,
                        // The sidecar coerces adopted models too — mirror it,
                        // or the picker shows a model the engine can't run.
                        model: thread.chat.model
                          ? coerceModelForHarness(harness, thread.chat.model)
                          : thread.chat.model,
                      },
                    }
                  : thread,
              ),
            );
          })
          .catch(() => {});
      }
    },
    [localConfig],
  );
  // Local presence: awareness peers on the sidecar socket (cloud presence is
  // a Supabase channel local projects don't have). Inert when cloud.
  const workspaceCollabSocket = useWorkspaceCollabSocket(projectId ?? undefined);
  const localCollabPeers = useLocalCollabPresence(workspaceCollabSocket, isLocalWorkspace);
  const workspaceRouteId = useMemo(
    () =>
      workspaceRouteContext?.publicId
        ? { id: projectId, public_id: workspaceRouteContext.publicId }
        : projectId,
    [projectId, workspaceRouteContext?.publicId]
  );
  const selectedTeamId = searchParams.get('team')?.trim() || null;
  const deepLinkedFileId = searchParams.get('fileId')?.trim() || null;
  const deepLinkedFilePath = searchParams.get('filePath')?.trim() || null;
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
  const { openSignIn } = useClerk();
  const [hasMounted, setHasMounted] = useState(false);
  // True only inside the macOS Tauri desktop wrapper, which uses an overlay
  // title bar — the traffic-light buttons float over our top bar, so the left
  // controls need to clear them. Defaults false; web/SSR is untouched.
  const [isDesktopApp, setIsDesktopApp] = useState(false);
  // Tabs/splits are DESKTOP-SHELL chrome (any OS): the browser already has its
  // own tab row, so the web shell renders no strips — fixed doc-left /
  // chat-right, clicks replace what's displayed (founder call). Distinct from
  // isDesktopApp, which gates macOS traffic-light padding + drag regions.
  const [desktopTabs, setDesktopTabs] = useState(false);
  useEffect(() => {
    // Desktop shell detected via the launch-URL flag (see lib/desktop.ts);
    // Tauri exposes neither its globals nor a custom UA on the remote origin.
    if (!isDesktopShell()) return;
    setDesktopTabs(true);
    if (navigator.userAgent.includes('Macintosh')) setIsDesktopApp(true);
  }, []);
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
  useClaimAnonOnLogin(Boolean(user?.id) && !workspaceRouteContext?.local);
  // For ownership comparisons in the transcript: signed-in users compare by
  // Clerk id; anon users compare by their `anon:<rawId>` identity, which is
  // what /api/workspace/messages stamps into metadata.author_user_id.
  const effectiveCurrentUserId = useMemo(
    () => user?.id ?? (anonId ? toAnonAuthorId(anonId) : null),
    [user?.id, anonId],
  );
  const [isMobile, setIsMobile] = useState(false);
  type MobilePanel = 'chats' | 'files' | null;
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
  // URL lands on the chat box on every form factor; editor-intent URLs land on
  // the document. The desktop hydration effect re-applies this with the STORED
  // layout folded in (applyStoredDesktopLayout {arrival:true}); mobile keeps
  // this URL-only decision.
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
  // True while the center shows the chat-first landing default (a plain-URL
  // arrival, no editor intent). Cleared once acted on: read-only visitors get
  // swapped to the doc — chat isn't theirs to drive — and the first agent edit
  // slides the editor in (see the effects below).
  const arrivalChatDefaultRef = useRef(openPanels.length === 1 && openPanels[0] === 'chat');
  /** Rail the chat-first arrival force-closed, for the read-only restore. */
  const arrivalClosedRailRef = useRef<'project' | null>(null);
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
  // The File/Edit/Insert/Format/View menu row is collapsed by default; the
  // Show/Hide-menus button in the formatting toolbar toggles it open.
  const [menusHidden, setMenusHidden] = useState(true);
  // The formatting toolbar is openable, not default chrome (PR #907 one-bar):
  // desktop hides it until toggled; the choice persists per browser.
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
  // Rail folder-focus (mirrored up from FilesTabPanel): the chat list scopes
  // to chats that live in — or touched files under — the focused folder.
  const [focusedSidebarFolder, setFocusedSidebarFolder] = useState<string | null>(null);
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
  const [showAddOverleafModal, setShowAddOverleafModal] = useState(false);
  const [linkedReposRefreshKey, setLinkedReposRefreshKey] = useState(0);
  const [selectedCommit, setSelectedCommit] = useState<{ repoId: string; sha: string } | null>(null);
  const {
    repos: linkedRepos,
    findRepoForPath: findLinkedRepoForPath,
    refetch: refetchLinkedRepos,
  } = useLinkedRepos(cloudProjectId ?? '', linkedReposRefreshKey);
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
  const paneIdsKey = editorPanes.map((p) => p.id).join('|');
  useEffect(() => setPaneGrow({}), [paneIdsKey]);
  const handlePaneResizeCommit = useCallback((fractions: number[]) => {
    setPaneGrow(Object.fromEntries(editorPanesRef.current.map((p, i) => [p.id, fractions[i] ?? 1])));
  }, []);
  // The right dock (PR #907 right panel): History (the review timeline) or
  // Outline. Closed by default; the top-bar toggle reopens the last-used view.
  const [rightDockView, setRightDockView] = useState<'history' | 'outline' | null>(null);
  const rightDockLastViewRef = useRef<'history' | 'outline'>('history');
  const openRightDock = useCallback((view: 'history' | 'outline') => {
    rightDockLastViewRef.current = view;
    setRightDockView(view);
    // A selected Sync commit short-circuits the center to the diff viewer —
    // drop it so the dock actually appears beside the editor.
    setSelectedCommit(null);
  }, []);
  // The pinned top-right cluster (comments · dock toggle · Share) overlays
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
  // The tab strip's ＋ launcher (wireframe new-tab: New file / New chat).
  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const newTabTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!showNewTabMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && newTabTriggerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-floating-action-menu]')) return;
      setShowNewTabMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowNewTabMenu(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showNewTabMenu]);
  const editorPanesRef = useRef(editorPanes);
  editorPanesRef.current = editorPanes;
  // Assigned once openChatById exists — pane transitions that land a chat tab
  // active re-point the live chat through it (see applyPaneTransition).
  const openChatByIdRef = useRef<(chatId: string) => unknown>(() => undefined);
  // Explicit file opens (tree click, review jump, deep link) claim the pane
  // currently SHOWING a file (files-left/chats-right rules: a rail file click
  // replaces the displayed file wherever it lives, falling back to the
  // primary); with only a chat visible the doc claims the primary and the
  // chat docks aside instead of being displaced. When an open displaces the
  // last visible chat, the legacy 'chat' reveal intent must go with it or a
  // reload re-covers the doc with the chat tab.
  const claimPrimaryWithFile = useCallback(
    (path: string, opts?: { append?: boolean; chatAside?: boolean }) => {
      setEditorPanes((prev) => {
        const filePane = prev.find((p) => p.active !== '' && !isSpecialTab(p.active));
        const next =
          opts?.chatAside || (!opts?.append && !filePane && prev.some((p) => isChatTab(p.active)))
            ? openWithChatAside(prev, path)
            : opts?.append
              ? openPaneTab(prev, PRIMARY_PANE_ID, path)
              : replaceActiveTab(prev, filePane?.id ?? PRIMARY_PANE_ID, path);
        const chatStillVisible = next.some((pane) => isChatTab(pane.active));
        // Outside the updater (React may run it twice); removePanel is idempotent.
        queueMicrotask(() => {
          if (!chatStillVisible) setOpenPanels((op) => removePanel(op, 'chat'));
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
  // Desktop-only: mobile renders the legacy column layout, and a pane
  // snapshot restored from a desktop session must not hijack its editor.
  const primaryChatActive = !isMobile && isChatTab(editorPanes[0].active);
  const paneChatVisible = editorPanes.some((p) => isChatTab(p.active));
  const paneFileVisible = editorPanes.some((p) => p.active !== '' && !isSpecialTab(p.active));
  const isEditorVisible = isMobile ? openPanels.includes('editor') : paneFileVisible;
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
  const openChatTabInPanes = useCallback((chatId: string, opts?: { side?: boolean; append?: boolean }) => {
    const tab = chatTab(chatId);
    const transition = (prev: EditorPane[]) => {
      const holder = prev.find((p) => p.tabs.includes(tab));
      if (opts?.append && !holder) {
        // ＋ launcher: a NEW leaf beside the current tab, never replacing it.
        return enforceSingleActiveChat(openPaneTab(prev, PRIMARY_PANE_ID, tab), PRIMARY_PANE_ID);
      }
      // side: with only a FILE visible the chat SPLITS to the right of it
      // (files-left/chats-right) instead of replacing it; falls through to
      // replace when the primary is empty/chat, or when some pane already
      // shows a chat (then the click replaces the DISPLAYED chat, not the
      // doc). A background copy of the tab in the PRIMARY moves aside too —
      // only a holder that can show the chat without displacing the doc (a
      // side pane) short-circuits to plain activation below.
      if (
        opts?.side &&
        prev[0].active !== '' &&
        !isChatTab(prev[0].active) &&
        !prev.some((p) => isChatTab(p.active))
      ) {
        const primaryBackground = holder?.id === PRIMARY_PANE_ID;
        if (!holder || primaryBackground) {
          const base = primaryBackground
            ? prev.map((p, i) => (i === 0 ? { ...p, tabs: p.tabs.filter((t) => t !== tab) } : p))
            : prev;
          const next = openPaneToSide(base, tab);
          const pane = next.find((p) => p.tabs.includes(tab));
          return pane ? enforceSingleActiveChat(next, pane.id) : next;
        }
      }
      // Replace-on-open per GROUP: in a doc+chat split, a chat opened from
      // the rail replaces the chat PANE's tab — never the document.
      const paneId =
        holder?.id ?? prev.find((p) => isChatTab(p.active))?.id ?? PRIMARY_PANE_ID;
      return enforceSingleActiveChat(replaceActiveTab(prev, paneId, tab), paneId);
    };
    const predicted = transition(editorPanesRef.current);
    setEditorPanes(transition);
    // Replace-on-open can close the selected file's tab — keep the selection
    // only while some pane still holds it (applyPaneTransition's rule).
    setSelectedFilePath((prev) => (prev && !predicted.some((p) => p.tabs.includes(prev)) ? '' : prev));
  }, []);
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('workspace');
  const [canWrite, setCanWrite] = useState(true);
  const [canSuggest, setCanSuggest] = useState(true);
  const [canComment, setCanComment] = useState(true);
  const [canAccessSecrets, setCanAccessSecrets] = useState<boolean | null>(null);
  const [editorPageChrome, setEditorPageChrome] = useState<MarkdownPageChrome>({
    margin: 'normal',
    header: false,
    footer: false,
  });
  // Commenters (canSuggest without canWrite) get an editable editor locked to
  // Suggesting — their typing lands as reviewable suggestions, GDocs-style.
  const documentReadOnly = !canWrite && !canSuggest;
  // The chat-first landing is for people who can drive the agent. Access
  // resolves async (the files payload carries canWrite), so a read-only
  // visitor on a bare link briefly sees chat — swap them to the document they
  // came for, but only while the untouched arrival default is still up.
  useEffect(() => {
    if (canWrite || !arrivalChatDefaultRef.current) return;
    arrivalChatDefaultRef.current = false;
    setOpenPanels((prev) => (prev.length === 1 && prev[0] === 'chat' ? ['editor'] : prev));
    // Desktop chat visibility lives in the panes: demote any active chat tab
    // to its nearest file tab so the visitor lands on the document.
    setEditorPanes((prev) => {
      let changed = false;
      const next = prev.map((pane) => {
        if (!isChatTab(pane.active)) return pane;
        changed = true;
        const files = pane.tabs.filter((t) => !isChatTab(t));
        return { ...pane, active: files[files.length - 1] ?? '' };
      });
      return changed ? next : prev;
    });
    // The chat-first arrival closed the rail for the hero; this visitor lands
    // on the document instead, so give them back the rail the arrival closed
    // (from the ref — persistence has already overwritten the stored layout).
    if (arrivalClosedRailRef.current) setOpenLeftRail(arrivalClosedRailRef.current);
  }, [canWrite]);
  const { mode: documentEditMode, setMode: setDocumentEditMode } = useDocumentEditMode();
  const [projectTitle, setProjectTitle] = useState('Untitled workspace');
  const [projectStatus, setProjectStatus] = useState<'active' | 'archived'>('active');
  const [projectKind, setProjectKind] = useState<WorkspaceKind | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const [showWorkspaceSwitcher, setShowWorkspaceSwitcher] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);
  const [chatDetailsChatId, setChatDetailsChatId] = useState<string | null>(null);
  // Per-chat "Connect to mobile" — opens LinkTextChatModal for this chat id.
  const [linkTextChatId, setLinkTextChatId] = useState<string | null>(null);
  const messageInputByChatIdRef = useRef<Record<string, string>>({});
  // draft chat id → its promoted real id (written by replaceDraftChat). Lets
  // the inline-ask send verify the on-screen chat really came from ITS draft.
  const draftPromotionsRef = useRef<Record<string, string>>({});
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
  // Manual sidebar order (drag-to-reorder), per workspace + device.
  const [fileOrder, setFileOrder] = useState<FileOrderMap>({});
  useEffect(() => {
    setFileOrder(projectId ? readFileOrder(projectId) : {});
  }, [projectId]);
  const [renameEntry, setRenameEntry] = useState<RenameEntry | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null);
  // The ⌘K command palette (files + actions) — opened by Cmd/Ctrl+K or the
  // sidebar search bar.
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const pendingRevealLineRef = useRef<number | null>(null);
  const {
    copiedChatLinkId,
    handleCopyChatLink,
    handleCopyFileLink,
  } = useWorkspaceLinkCopy({
    projectId,
    workspaceRouteId,
    setOpenMenuPath,
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
  const setStoredMessageDraft = useCallback((chatId: string, text: string, notify = false) => {
    if (!chatId) return;
    if (text) {
      messageInputByChatIdRef.current[chatId] = text;
    } else {
      delete messageInputByChatIdRef.current[chatId];
    }
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
            ? 'My cursor is on the quoted line — apply this right there.'
            : detail?.caret === 'after'
              ? 'My cursor is on an empty line immediately after the quoted text — write there.'
              : detail?.caret === 'start'
                ? 'My cursor is at the top of the document.'
                : '';
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
  // palette. The markdown editor claims the press first — link popover — but
  // only when it has a NON-EMPTY selection, and preventDefaults when it fires;
  // an empty caret falls through here, so ⌘K anywhere else means "palette".
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
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
  const draftAppendTabRef = useRef(false);
  const filesChannelRef = useRef<BroadcastChannel | null>(null);
  // Bumped by every optimistic file-tree mutation (create/delete/move/rename).
  // `reloadFiles` captures it before its fetch and drops the result if it
  // changed in flight — a poll/realtime reload whose GET predates the mutation
  // would otherwise clobber the optimistic update (resurrect a deleted file,
  // un-move a moved one).
  const filesGenRef = useRef(0);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  /** Stores the click X-offset for header renames so cursor is placed at click position */
  const renameClickOffsetRef = useRef<{ x: number; text: string } | null>(null);
  /** Defers folder toggle so a double-click can cancel it and enter rename instead */
  const folderClickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Tracks the last-clicked file path for shift+click range selection */
  const lastClickedPathRef = useRef<string | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const assistantPickerRef = useRef<HTMLDivElement | null>(null);
  // The same picker (one `showAssistantPicker` flag) is mounted in two places —
  // the top-bar chat name and the chat-column "+" header — which can both be
  // live in full-chat mode. Each wrapper needs its own ref so the outside-click
  // dismiss treats clicks in either menu as "inside".
  const chatHeaderPickerRef = useRef<HTMLDivElement | null>(null);
  const assistantPickerCueTimeoutRef = useRef<number | null>(null);
  const optimisticStartingUntilByChatIdRef = useRef<Map<string, number>>(new Map());
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
  const desktopSignedIn = useDesktopCredentials(desktopConfig);
  const desktopProfile = useDesktopProfile(desktopSignedIn && !user);
  // Local projects never touch Supabase — a null client no-ops every realtime
  // hook (presence, files channel, comments, doc-edits) in one place.
  const supabaseClient = useMemo(
    () => (isClerkLoaded && !isLocalWorkspace ? createBrowserClient() : null),
    [isClerkLoaded, isLocalWorkspace],
  );
  const workspacePresenceState = useWorkspacePresence({
    supabaseClient,
    projectId,
    user,
    anonId,
    anonDisplayName: anonId ? anonDisplayName(anonId) : null,
    anonColor: anonId ? pickColor(`${ANON_AUTHOR_PREFIX}${anonId}`) : null,
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
    setEditorPanes((prev) => syncPrimaryActive(prev, selectedFilePath));
  }, [isMobile, selectedFilePath]);
  // Restore the persisted pane layout once the file list can validate it…
  useEffect(() => {
    if (!projectId || !filesLoaded || editorPanesRestoredRef.current === projectId) return;
    editorPanesRestoredRef.current = projectId;
    // No (or corrupted) snapshot starts clean — also what drops the previous
    // workspace's panes after an in-place workspace switch.
    let restored = createInitialPanes();
    try {
      const raw = window.localStorage.getItem(`${EDITOR_PANES_KEY_PREFIX}${projectId}`);
      if (raw) restored = normalizePanes(JSON.parse(raw), existingPaths);
    } catch {
      /* corrupted snapshot — start clean */
    }
    // Web (no-tabs) shell: a snapshot (possibly saved by a tabbed session)
    // reduces to the visible file + whether a chat is open. Read the latched
    // flag directly — the desktopTabs state may not have settled yet.
    if (!isDesktopShell()) restored = flattenPanesForWeb(restored);
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
    if (isMobile || !layoutConfigReady || !projectId || editorPanesRestoredRef.current !== projectId) return;
    try {
      window.localStorage.setItem(
        `${EDITOR_PANES_KEY_PREFIX}${projectId}`,
        JSON.stringify(panesSnapshot(editorPanes)),
      );
    } catch {
      /* quota / private mode */
    }
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
    canWrite,
    existingPaths,
    fetchImpl: apiFetch,
    uploadBinary: localBinaryUpload,
    onUploadComplete: (file, upload) => {
      upsertWorkspaceFile(file);
      if (upload.target === 'chat' && upload.chatId) {
        addChatAttachment(upload.chatId, buildAttachmentFromFile(file));
      }
    },
    onFilesChanged: () => filesChannelRef.current?.postMessage({ type: 'refresh' }),
  });

  const handleEditorImageDrop = useCallback(
    async (file: File) => {
      if (!projectId || !canWrite) return null;
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
    [projectId, canWrite, existingPaths, localBinaryUpload, reportUploadError],
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
      if (stored === null) setOpenLeftRail(null);
      else if (stored != null) setOpenLeftRail('project');
      // Nothing stored on an arrival = first visit; apply the collapsed default
      // so a soft workspace switch can't leak the previous workspace's rail
      // into the new workspace's persisted layout.
      else if (opts?.arrival) setOpenLeftRail(null);
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
        // Chat-first landing (no editor intent in the URL): remember it so the
        // async access check can swap read-only visitors to the doc they came
        // for, and put the caret in the composer — arriving here means "say
        // what you want".
        arrivalChatDefaultRef.current = panels.length === 1 && panels[0] === 'chat';
        if (arrivalChatDefaultRef.current) {
          setShouldFocusChatInput(true);
          // Chat-first landings start without the files rail, whatever the
          // stored layout says — the empty-chat hero is the whole screen.
          // Remember what we closed in a ref: persistence writes the live
          // state, so localStorage no longer holds the pre-arrival rail by
          // the time the async access check may need to give it back.
          arrivalClosedRailRef.current = stored != null ? 'project' : null;
          setOpenLeftRail(null);
        }
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
      setOpenLeftRail(null);
      setShowSettingsModal(false);
      // A just-created workspace lands on the chat box (the seeded doc is one
      // click away); a template pick keeps its document beside the chat.
      setOpenPanels(freshTemplateChatIntent ? ['editor', 'chat'] : ['chat']);
      arrivalChatDefaultRef.current = !freshTemplateChatIntent;
      setShouldFocusChatInput(true);
      setSidebarSections([...DEFAULT_SIDEBAR_SECTIONS]);
    },
    [freshTemplateChatIntent]
  );

  const persistLayoutConfig = useCallback(
    (overrides: Partial<WorkspaceLayoutConfig> = {}) => {
      if (!hasMounted || !projectId || !layoutConfigReady || isMobile || blockFreshLayoutPersistenceRef.current) return;
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
    (panel: CenterPanel, opts?: { chatId?: string; side?: boolean }) => {
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
        if (opts?.chatId) openChatTabInPanes(opts.chatId, { side: opts.side });
        else openChatTabForCurrentRef.current();
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
        canWrite?: boolean;
        canSuggest?: boolean;
        canComment?: boolean;
        canAccessSecrets?: boolean;
        projectTitle?: string | null;
        projectStatus?: 'active' | 'archived' | null;
        projectKind?: WorkspaceKind | null;
        hostUrl?: string | null;
        cold?: boolean;
        localRoots?: { prefix: string; root: string; name: string }[];
      };
      let payload: FilesPayload;
      // Generation at the moment this reload's data was fetched; used below to
      // skip a file-list overwrite that a local mutation has since superseded.
      let fetchGen: number | null = null;
      // SSR-preloaded files (first paint) skip the fetch entirely.
      if (preloaded) {
        setAccessError(null);
        payload = preloaded;
      } else {
        fetchGen = filesGenRef.current;
        const res = await apiFetch(`/api/workspace/files?projectId=${projectId}`);
        if (!res.ok) {
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
      if (fetchGen === null || filesGenRef.current === fetchGen) {
        setWorkspaceFiles((previous) =>
          hostUnavailable && previous.length > 0 ? previous : filesList
        );
      }
      setFilesLoaded(true);
      if (payload.localRoots) setLocalRoots(payload.localRoots);
      if (typeof payload.canWrite === 'boolean') {
        setCanWrite(payload.canWrite);
        setCanSuggest(payload.canSuggest ?? payload.canWrite);
        setCanComment(payload.canComment ?? payload.canWrite);
      }
      setCanAccessSecrets(Boolean(payload.canAccessSecrets));
      if (typeof payload.projectTitle === 'string') {
        setProjectTitle(payload.projectTitle);
      }
      if (payload.projectStatus === 'active' || payload.projectStatus === 'archived') {
        setProjectStatus(payload.projectStatus);
      }
      if (payload.projectKind === 'standard') {
        setProjectKind(payload.projectKind);
      }
      // Legacy CRDT-snapshot prefetch is gone under Sunny sandbox — Supabase
      // no longer stores Yjs snapshots and the live host hydrates from the
      // plain text on disk during the Hocuspocus `onLoadDocument` hook.

      if (!didSetInitialFileRef.current && shouldSetInitial && filesList.length) {
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
          const isOpenable = (file: WorkspaceFileRow) =>
            file.type !== 'proposal' && file.type !== 'folder' && !isMetaPath(file.path);
          const basename = (path: string) => path.split('/').pop() ?? path;
          const isReadme = (path: string) => /^readme(\.[a-z0-9]+)?$/i.test(basename(path));
          const isMarkdown = (path: string) => /\.(md|mdx)$/i.test(path);
          const isLatexDoc = (path: string) => /\.tex$/i.test(path);
          const openable = filesList.filter(isOpenable);
          const rootReadme = openable.find((f) => !f.path.includes('/') && isReadme(f.path));
          const anyReadme = rootReadme ?? openable.find((f) => isReadme(f.path));
          const rootMarkdown = openable.find((f) => !f.path.includes('/') && isMarkdown(f.path));
          const firstMarkdown = rootMarkdown ?? openable.find((f) => isMarkdown(f.path));
          // main.tex first, then any root .tex, then any .tex anywhere — so
          // template workspaces land on the paper, not on a vendored .sty.
          const rootMain = openable.find((f) => !f.path.includes('/') && /^main\.tex$/i.test(f.path));
          const rootLatex = openable.find((f) => !f.path.includes('/') && isLatexDoc(f.path));
          const firstLatex = rootMain ?? rootLatex ?? openable.find((f) => isLatexDoc(f.path));
          // New visitors land on the seeded welcome.tex (the friendly intro),
          // not on their imported project files. Returning visitors are handled
          // above by `storedPath`, so this only affects a first open.
          const welcomeTex = openable.find((f) => /^welcome\.tex$/i.test(f.path));
          const firstFile =
            welcomeTex ??
            anyReadme ??
            firstMarkdown ??
            firstLatex ??
            filesList.find((file) => file.type !== 'proposal' && file.type !== 'folder') ??
            filesList[0];
          initialPath = firstFile?.path ?? null;
        }

        if (initialPath) {
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
    storageUsageEnabled: !isLocalWorkspace,
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
    options?: { force?: boolean },
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

  // Single load of the user's saved default model. This is the one place the
  // default is read; it seeds the next-chat model and the Settings picker, and
  // flips `preferencesLoaded` (the startup gate) independently of the Settings
  // panel ever opening.
  useEffect(() => {
    // Wait for Clerk to settle: a signed-in user is briefly null while
    // hydrating, and treating that as anonymous would seed new chats (and the
    // startup auto-chat) with the app default before the saved one loads.
    if (!hasMounted || !isAuthLoaded) return;
    if (!user?.id) {
      setSavedDefaultModel(DEFAULT_MODEL_REF);
      setPreferencesLoaded(true);
      return;
    }
    let cancelled = false;
    const settle = (saved: string) => {
      if (cancelled) return;
      setSavedDefaultModel(saved);
      // Only seed the next-chat model while it's still the untouched app default
      // — never clobber a model the user (or an open chat) already chose.
      setPreferredChatModel((prev) => (prev === DEFAULT_MODEL_REF ? saved : prev));
      setPreferencesLoaded(true);
    };
    fetch('/api/user/preferences')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((prefs: { default_model?: string | null }) =>
        settle(normalizeChatModelRef(prefs.default_model?.trim() || DEFAULT_MODEL_REF))
      )
      .catch(() => settle(DEFAULT_MODEL_REF));
    return () => {
      cancelled = true;
    };
  }, [hasMounted, isAuthLoaded, user?.id, projectId]);

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
            onChange={handlePreferencesSectionChange}
          />
        </div>
      </div>
    );
  };

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
                    <div className="mt-1 text-sm font-medium text-stone-800">Sunny</div>
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
    handleOpenShare,
    handleCopyInvite,
    handleCreateLinkInvite,
    handleCreateEmailInvite,
    handleVisibilityChange,
    handlePublicAccessChange,
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
  });
  // Local sharing: any tree node (or the whole project) shares to a cloud
  // workspace via the sidecar bridge — invites live on that workspace's ACL,
  // so per-file / per-subfolder audiences are separate shares.
  const [localShareScope, setLocalShareScope] = useState<{ kind: 'project' | 'folder' | 'file'; path: string } | null>(null);
  const { shares: localShares, refreshShares: refreshLocalShares } = useLocalShares(
    localConfig,
    isLocalWorkspace ? projectId : null,
  );
  const localSharedScopePaths = useMemo(
    () => new Set(localShares.filter((share) => share.enabled).map((share) => share.scope_path)),
    [localShares],
  );
  const openShare = useCallback(() => {
    if (isLocalWorkspace) setLocalShareScope({ kind: 'project', path: '' });
    else handleOpenShare();
  }, [isLocalWorkspace, handleOpenShare]);
  // Chat share: the full GDocs-style modal. A chat link is the workspace URL +
  // chatId, so people and general access are the workspace's (shown as
  // inherited); invites minted here are chat-targeted workspace invites.
  // Local chats share by syncing the backing project, so they open the local
  // share modal instead.
  const [showChatShareModal, setShowChatShareModal] = useState(false);
  const openChatShare = useCallback(() => {
    if (isLocalWorkspace) setLocalShareScope({ kind: 'project', path: '' });
    else setShowChatShareModal(true);
  }, [isLocalWorkspace]);

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
  // Copy link from the chat share modal: link-shared chats copy the chat URL
  // itself; restricted workspaces fall back to the hook, which mints/copies a
  // viewer invite link targeted at this chat.
  const handleChatShareCopyLink = useCallback(() => {
    const isPublic = shareInfo?.visibility === 'public' && shareInfo.publicAccess !== 'none';
    // Restricted + able to invite → mint/copy a chat-targeted viewer invite
    // link. Otherwise copy the plain chat URL: it works for anyone on a
    // link-shared workspace and existing members on a restricted one. Cloud
    // links use the public origin (desktop shells serve from a loopback
    // proxy a collaborator can't reach).
    if (currentChatId && !isDraftChatId(currentChatId) && (isPublic || !canInviteShare)) {
      return handleCopyInvite(`${shareOrigin()}${buildWorkspaceChatPath(workspaceRouteId, currentChatId)}`);
    }
    return handleCreateLinkInvite();
  }, [shareInfo?.visibility, shareInfo?.publicAccess, currentChatId, canInviteShare, workspaceRouteId, handleCopyInvite, handleCreateLinkInvite]);
  // A turn link is dead until someone else can open it: cloud chats need the
  // workspace shared (members/invites/link access); local chats live only on
  // this machine — even a synced project share carries files, not chats — so
  // they stay gated (the button opens the share modal instead of copying)
  // until per-chat cloud sync exists.
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
  const chatUploads = useMemo(
    () => uploads.filter((upload) => upload.target === 'chat' && upload.chatId === currentChatId),
    [currentChatId, uploads]
  );
  const chatUploadsInFlight = useMemo(
    () =>
      uploads.some(
        (upload) =>
          upload.target === 'chat' &&
          upload.chatId === currentChatId &&
          upload.status !== 'error'
      ),
    [currentChatId, uploads]
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
  // TS harness inserts the assistant row eagerly with empty content (so tools
  // can FK to it), so userIsLatest flips false instantly — anchor on the live
  // run state too, otherwise dots never appear in the send window.
  const showWorkingIndicator =
    Boolean(currentChatId) &&
    !latestAssistantInterrupted &&
    !latestAssistantHasContent &&
    (userIsLatest || hasLiveChatRun);
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
      (chatId: string) => ensureChatMessagesLoaded(chatId, { force: true }),
      [ensureChatMessagesLoaded],
    ),
  });
  const sundialChatRef = useRef(sundialChat);
  sundialChatRef.current = sundialChat;
  // Session-local "the run you watched just finished" cue for the transcript's
  // quiet "Done" marker — reloaded transcripts shouldn't grow markers.
  const completedRunChatId = useRunCompletionCue({
    // Arm from the live useChat stream too: a collaborator-started run
    // arrives via resumeStream() without ever updating the REST cache
    // behind hasLiveChatRun (Codex P3).
    hasLiveChatRun:
      hasLiveChatRun ||
      sundialChat.status === 'streaming' ||
      sundialChat.status === 'submitted',
    currentChatId,
    isInterrupting,
    latestAssistantInterrupted,
    // The cached row (currentChatMessages) can lag the live reply, which is
    // owned by useChat — a still-open SSE or a client transport error must
    // also block the cue (Codex P2s): only a fully settled, non-errored
    // stream reads as a normal finish.
    latestReplyUnsettled:
      latestAssistantMeta?.streaming === true || sundialChat.status !== 'idle',
  });
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
  // its current display order (folders first, then files — matching render).
  const handleReorderEntries = useCallback(
    (draggedPaths: string[], targetPath: string, position: 'before' | 'after') => {
      if (!projectId || draggedPaths.length === 0) return;
      const parent = getFolderPath(targetPath) ?? ROOT_ORDER_KEY;
      if (!draggedPaths.every((path) => (getFolderPath(path) ?? ROOT_ORDER_KEY) === parent)) return;
      const folderNames = (foldersByParent[parent] ?? []).map(getFileName);
      const fileNames = (parent === ROOT_ORDER_KEY ? rootFiles : filesByFolder[parent] ?? []).map(
        (file) => getFileName(file.path),
      );
      const next = {
        ...fileOrder,
        [parent]: computeReorder(
          [...folderNames, ...fileNames],
          draggedPaths.map(getFileName),
          getFileName(targetPath),
          position,
        ),
      };
      setFileOrder(next);
      writeFileOrder(projectId, next);
    },
    [projectId, fileOrder, foldersByParent, filesByFolder, rootFiles],
  );
  /** Flat list of file paths in visual render order (for shift+click range selection) */
  const flatVisiblePaths = useMemo(() => {
    const paths: string[] = [];
    // Folders first (matching render order), then root files
    const addFolder = (folder: string) => {
      if (!expandedFolders.has(folder)) return;
      const childFolders = foldersByParent[folder] ?? [];
      childFolders.forEach((cf) => addFolder(cf));
      const files = filesByFolder[folder] ?? [];
      files.forEach((f) => paths.push(f.path));
    };
    (foldersByParent['__root__'] ?? []).forEach((f) => addFolder(f));
    rootFiles.forEach((f) => paths.push(f.path));
    return paths;
  }, [rootFiles, foldersByParent, filesByFolder, expandedFolders]);
  const collabUser = useMemo(() => {
    if (user) {
      return {
        name: user.fullName || user.username || 'You',
        color: pickColor(user.id),
      };
    }
    if (anonId) {
      return {
        name: anonDisplayName(anonId),
        color: pickColor(`${ANON_AUTHOR_PREFIX}${anonId}`),
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
  const docEditModes = !activeIsMarkdown
    ? DOC_EDIT_MODES
    : showRawView
      ? RAW_MARKDOWN_DOC_EDIT_MODES
      : MARKDOWN_DOC_EDIT_MODES;
  // Commenters are pinned to Suggesting (View where the surface has no
  // Suggesting, e.g. raw markdown) — they never get direct Edit.
  const effectiveDocEditMode: WorkspaceEditMode = !canWrite
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
    if (canWrite && showRawView && activeIsMarkdown && documentEditMode === 'suggest') {
      setDocumentEditMode('edit');
    }
  }, [canWrite, showRawView, activeIsMarkdown, documentEditMode, setDocumentEditMode]);
  // Pin commenters to Suggesting: the editors read the stored mode from
  // context (default 'edit'), and their socket token/UI must only suggest.
  useEffect(() => {
    if (!canWrite && canSuggest && documentEditMode !== 'suggest') {
      setDocumentEditMode('suggest');
    }
  }, [canWrite, canSuggest, documentEditMode, setDocumentEditMode]);
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
      setLatexViewMode('split');
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
  const latexRootPath = latexCompileTarget(
    latexMainDocument,
    activeTexFile ? activeWorkspaceFile?.path ?? null : null,
  );
  // Live editor source only describes the open file — only forward it when the
  // open file *is* the root. Otherwise compile the root from the doc store.
  const activeIsRoot = Boolean(latexRootPath && latexRootPath === activeWorkspaceFile?.path);
  const latexCompile = useLatexCompile({
    projectId,
    chatId: currentChatId,
    // Inert while an open-file move is settling: the mount probe would 404 on
    // the optimistic path and auto-compile artifacts there before the server
    // rename moves the old ones — colliding with the rename itself.
    texPath: activeTexFile && !pendingOpenFileMove ? latexRootPath : null,
    canWrite,
    source: activeIsRoot ? viewerContent : null,
    getSource: activeIsRoot ? () => readEditorText() ?? viewerContent : undefined,
    compileWithoutSource: activeTexFile && Boolean(latexRootPath) && !activeIsRoot,
    fetchImpl: apiFetch,
    liveRefresh: !isLocalWorkspace,
  });

  // Local projects: no brain background-compiles .tex edits, so agent/external
  // writes (the sidecar only emits those — user typing is watcher-suppressed)
  // trigger a debounced recompile. This is what makes "Fix with Sunny" refresh
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
    if (!projectId || !latexRootPath || !latexCompile.pdfUrl) {
      setSynctexIndex(null);
      return;
    }
    const synctexPath = latexRootPath.replace(/\.tex$/i, '.synctex.gz');
    const controller = new AbortController();
    (async () => {
      try {
        const params = new URLSearchParams({ projectId, path: synctexPath });
        const res = await apiFetch(`/api/workspace/files/download?${params}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) {
          setSynctexIndex(null);
          return;
        }
        const buf = await res.arrayBuffer();
        setSynctexIndex(await parseSyncTex(buf));
      } catch {
        if (!controller.signal.aborted) setSynctexIndex(null);
      }
    })();
    return () => controller.abort();
  }, [projectId, latexRootPath, latexCompile.pdfUrl]);

  // Upload an image dropped/pasted into the LaTeX editor into an `images/`
  // folder beside the .tex file; returns the workspace path. The editor turns
  // it into a tex-relative `\includegraphics{…}` reference.
  const handleLatexImageUpload = useCallback(
    async (file: File): Promise<string | null> => {
      if (!projectId || !canWrite || !activeWorkspaceFile) return null;
      const texPath = activeWorkspaceFile.path;
      const texDir = texPath.includes('/') ? texPath.slice(0, texPath.lastIndexOf('/')) : '';
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
    [projectId, canWrite, activeWorkspaceFile, existingPaths, localBinaryUpload],
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

  // Identity for optimistically-rendered comments (before the server echoes the
  // authoritative author back). Memoized so the comment callbacks stay stable.
  const commentCurrentUser = useMemo(
    () => ({
      // Use the effective (anon-aware) author id so the optimistic author
      // matches the server echo (`anon:<id>`); otherwise withOptimistic can't
      // bind the echo and an anon comment renders as a duplicate.
      userId: effectiveCurrentUserId,
      name: user?.fullName ?? user?.username ?? 'You',
      username: user?.username ?? null,
      imageUrl: user?.imageUrl ?? null,
    }),
    [effectiveCurrentUserId, user?.fullName, user?.username, user?.imageUrl],
  );

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
    showRawView: showRawView || (activeTexFile && latexViewMode === 'pdf'),
    hasRichViewer,
    showRichViewer,
    canComment,
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
  });

  // Single invalidation token feeding the inline-diff hook. Combines every
  // upstream "you should refetch now" signal we have:
  //  - `docEditsRealtimeKey`: Supabase Realtime INSERT on `doc_edits`
  //    (+ visibility/focus revalidation inside the hook).
  //  - per-message `(id, has_turn_edits, edited_file_count)` fingerprint:
  //    mirrors the chat panel's own auto-expand trigger so the inline
  //    overlay refreshes in the same tick the chat card pops in.
  const docEditsRealtimeKey = useDocEditsRealtimeKey(supabaseClient, projectId);
  const pendingEditsInvalidationToken = useMemo(
    () =>
      buildPendingEditsInvalidationToken({
        docEditsRealtimeKey,
        messages: liveChatMessagesForEdits,
      }),
    [docEditsRealtimeKey, liveChatMessagesForEdits],
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

  const spaceFilePendingTurns = useFilePendingTurns(
    cloudProjectId,
    activeWorkspaceFile?.path ?? null,
    pendingEditsInvalidationToken,
  );
  const spacePendingAdditions = useMemo(
    () =>
      buildActionableWorkspacePendingAdditions({
        turns: spaceFilePendingTurns.turns,
        filePath: activeWorkspaceFile?.path,
        resolveAuthorLabel: resolvePendingEditAuthorLabel,
      }),
    [spaceFilePendingTurns.turns, activeWorkspaceFile?.path, resolvePendingEditAuthorLabel],
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
              : 'px-3 lg:px-6 py-4 lg:py-8';
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
  // open — the rail joins the workbench row instead of narrowing the page.
  const laneNarrowsContent = reserveCommentLane && !activeTexFile;
  // Outline lane (wireframe right panel). Headings are derived from the rendered
  // `.tiptap` DOM — not the markdown source — so each item's index matches the
  // Nth heading element the click handler scrolls to. Comments win when both
  // lanes are open.
  const [outlineHeadings, setOutlineHeadings] = useState<TocHeading[]>([]);
  // Status pill: live word/char counts for the open markdown doc. Anchored
  // inside the primary doc pane (never fixed to the window — the old pill
  // overlaid chats and empty states).
  const [docStats, setDocStats] = useState<{ words: number; chars: number } | null>(null);
  useEffect(() => {
    if (!activeIsMarkdown || !markdownEditor || markdownEditor.isDestroyed) {
      setDocStats(null);
      return;
    }
    const compute = () => {
      const text = markdownEditor.state.doc.textContent;
      setDocStats({
        words: text.trim() ? text.trim().split(/\s+/).length : 0,
        chars: text.length,
      });
    };
    compute();
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
  }, [activeIsMarkdown, markdownEditor]);
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
  // The comment lane column, shared by the markdown and code editor branches.
  // Markdown animates its width 0↔320; code uses a static rail.
  const commentLaneColumn = reserveCommentLane ? (
    <div
      className={
        mdCommentLane
          ? 'shrink-0 overflow-hidden transition-[width] duration-200 ease-out'
          : 'shrink-0'
      }
      style={mdCommentLane ? { width: showInlineCommentLane ? 320 : 0 } : undefined}
      aria-hidden={!showInlineCommentLane}
    >
      {showInlineCommentLane ? (
        <DocCommentsPanel
          mode={commentPanelMode}
          documentLabel={commentDocumentLabel}
          threads={displayedCommentThreads}
          resolvedThreads={displayedResolvedThreads}
          threadAnchorOffsets={docCommentAnchorOffsets}
          draftAnchorOffset={draftCommentAnchorOffset}
          activeThreadId={activeCommentThreadId}
          draftSelection={draftCommentSelection}
          draftBody={draftCommentBody}
          replyRestore={commentReplyRestore}
          currentUser={{
            name: user?.fullName ?? user?.username ?? 'You',
            imageUrl: user?.imageUrl ?? null,
          }}
          currentUserId={user?.id ?? null}
          canComment={canCommentOnActiveFile}
          canResolve={canWrite}
          loading={displayedCommentsLoading}
          error={displayedCommentsError}
          busyAction={commentBusyAction}
          onModeChange={handleCommentModeChange}
          onSelectThread={selectCommentThread}
          onOpenWorkspaceThread={openWorkspaceCommentThread}
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
      if (diffIdOfTab(tab) !== null) return 'Diff';
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
  const showOffline =
    isEditableFileOpen &&
    collabStatus !== 'local' &&
    (collabStatus === 'disconnected' || (collabStatus === 'connecting' && connectingGraceElapsed));

  useWorkspaceActiveFileEffects({
    projectId,
    activeIsMarkdown,
    activeWorkspaceDefaultsToRichViewer,
    activeWorkspaceFileId,
    activeWorkspaceFileResetKey,
    activeWorkspaceFileType,
    fileContentReady,
    isEditableFileOpen,
    collabStatus,
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
    let name = `${baseName}${ext}`;
    let path = parentPath ? `${parentPath}/${name}` : name;
    if (!existingPaths.has(path)) return name;
    let index = 2;
    while (existingPaths.has(path)) {
      name = `${baseName}-${index}${ext}`;
      path = parentPath ? `${parentPath}/${name}` : name;
      index += 1;
    }
    return name;
  }, [existingPaths]);

  const beginDraft = useCallback((type: DraftEntry['type']) => {
    if (!canWrite) return;
    if (draftEntry) return;
    const parentPath = activeWorkspaceFile
      ? activeWorkspaceFile.type === 'folder'
        ? activeWorkspaceFile.path
        : getFolderPath(activeWorkspaceFile.path)
      : null;
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
  }, [activeWorkspaceFile, buildDraftName, canWrite, draftEntry]);

  const commitDraft = useCallback(async () => {
    if (!canWrite) return;
    if (!draftEntry || !projectId) return;
    // Consume the launcher's new-tab intent up front — a canceled or failed
    // create must not leak it into a later unrelated create.
    const appendTab = draftAppendTabRef.current;
    draftAppendTabRef.current = false;
    if (cancelDraftRef.current) {
      cancelDraftRef.current = false;
      return;
    }
    let name = sanitizeFilename(draftEntry.name.trim());
    if (!name) {
      setDraftEntry(null);
      return;
    }
    if (draftEntry.type === 'text' && !name.includes('.')) {
      name = `${name}.md`;
    }
    const rawPath = draftEntry.parentPath ? `${draftEntry.parentPath}/${name}` : name;
    const finalPath = ensureUniquePath(rawPath, existingPaths);

    const res = await apiFetch('/api/workspace/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, path: finalPath, type: draftEntry.type }),
    });
    if (!res.ok) {
      setDraftEntry(null);
      return;
    }
    const payload = (await res.json()) as { file: WorkspaceFileRow };
    mutateWorkspaceFiles((prev) => [...prev, payload.file]);
    setDraftEntry(null);
    filesChannelRef.current?.postMessage({ type: 'refresh' });
    if (payload.file.type !== 'folder') {
      setSelectedFilePath(payload.file.path);
      // Explicit create SHOWS the file — claim the primary pane even over an
      // active chat tab (the sync mirror alone treats it as background). The
      // tab-strip launcher opts into append (a new tab, not a replace).
      if (!isMobile) claimPrimaryWithFile(payload.file.path, { append: appendTab });
      setWorkspaceViewMode('space');
    } else {
      setExpandedFolders((prev) => new Set(prev).add(payload.file.path));
    }
  }, [canWrite, claimPrimaryWithFile, draftEntry, existingPaths, isMobile, projectId, setWorkspaceViewMode]);

  const cancelDraft = useCallback(() => {
    cancelDraftRef.current = true;
    draftAppendTabRef.current = false;
    setDraftEntry(null);
  }, []);

  const beginRename = useCallback((path: string, source: RenameEntry['source'], opts?: { fileId?: string; clickEvent?: React.MouseEvent; paneId?: string }) => {
    if (!canWrite) return;
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
  }, [canWrite]);

  const commitRename = async () => {
    if (!canWrite) return;
    if (!renameEntry) return;
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
    if (!canWrite) return;
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
  }, [applyPaneTransition, canWrite, projectId, selectedFilePath]);

  const restoreLastDeletedPaths = useCallback(async () => {
    if (!canWrite || !projectId) return;
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
          body: JSON.stringify({ projectId, path, type: 'folder' }),
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
  }, [canWrite, projectId, reloadFiles]);

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
        : `/api/workspace/files/download?${params.toString()}`;
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
    setSelectedFilePath(file.path);
    // Explicit open: wireframe replace-on-open. The selectedFilePath mirror
    // deliberately never displaces an active chat tab, so the click itself
    // must claim the pane (withdrawing the chat reveal intent with it).
    if (!isMobile) claimPrimaryWithFile(file.path);
    setWorkspaceViewMode('space');
    // Opening a file means "show me the editor". The center diff viewer would
    // otherwise keep precedence while Sync stays in the (now multi-section)
    // sidebar, so drop the commit selection to reveal the editor.
    setSelectedCommit(null);
    if (isMobile) {
      setMobilePanel(null);
    }
  }, [claimPrimaryWithFile, isMobile, setWorkspaceViewMode]);

  // ---- Editor pane/tab actions (Obsidian-style tabs + drag-to-split) ----

  const handlePaneTabActivate = useCallback(
    (paneId: string, path: string) => {
      if (isChatTab(path)) {
        const chatId = chatIdOfTab(path)!;
        setEditorPanes((prev) => enforceSingleActiveChat(openPaneTab(prev, paneId, path), paneId));
        void openChatByIdRef.current(chatId);
        return;
      }
      if (paneId !== PRIMARY_PANE_ID) {
        setEditorPanes((prev) => openPaneTab(prev, paneId, path));
        return;
      }
      const file = workspaceFileByPath.get(path);
      if (file) {
        handleFileClick(file);
        return;
      }
      // The tab was optimistically remapped by an in-flight move while a
      // stale reload restored the old server paths. Keep the SELECTION on the
      // optimistic path (selecting the old row would strand the tab there
      // after the rename commits); activeWorkspaceFile and the collab room
      // resolve through pendingPaneMoves until the reload settles.
      const move = pendingPaneMoves.find((m) => isPathWithin(path, m.to));
      if (!move || !workspaceFileByPath.get(remapPath(path, move.to, move.from))) return;
      setSelectedFilePath(path);
      setWorkspaceViewMode('space');
      setSelectedCommit(null);
    },
    [handleFileClick, pendingPaneMoves, setWorkspaceViewMode, workspaceFileByPath],
  );

  const handlePaneTabClose = useCallback(
    (paneId: string, path: string) =>
      void applyPaneTransition((prev) => closePaneTab(prev, paneId, path), { preferPaneId: paneId }),
    [applyPaneTransition],
  );

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
  const handleSynctexInverse = useCallback(
    (file: string, line: number) => {
      const rootDir = latexRootPath && latexRootPath.includes('/')
        ? latexRootPath.slice(0, latexRootPath.lastIndexOf('/'))
        : '';
      const candidates = [file, rootDir ? `${rootDir}/${file}` : ''].filter(Boolean);
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
      if (resolved) openFileAtLine({ path: resolved, line });
    },
    [latexRootPath, workspaceFileByPath, openFileAtLine],
  );

  const openEditedFileInlinePath = useCallback((path: string) => {
    setPendingEditedFilePath(null);
    setSelectedFilePath(path);
    if (!isMobile) {
      setOpenLeftRail('project');
      // An explicit open from the chat must actually SHOW the doc: while the
      // chat holds the primary pane it opens beside it (the slide-in split);
      // otherwise it claims the primary tab like any explicit open. Web
      // (no-tabs) shell: doc claims the primary, chat docks right instead.
      if (desktopTabs && isChatTab(editorPanesRef.current[0].active)) {
        setEditorPanes((prev) => openPaneToSide(prev, path));
      } else {
        claimPrimaryWithFile(path);
      }
    }
    // Additive: the editor opens beside any open chat (no need to re-open it).
    setWorkspaceViewMode('space');
    if (isMobile) {
      setMobilePanel(null);
    }
  }, [claimPrimaryWithFile, desktopTabs, isMobile, setWorkspaceViewMode]);

  const handleOpenEditedFileInline = useCallback((path: string) => {
    const file = workspaceFileByPath.get(path);
    if (!file || file.type === 'folder' || file.type === 'proposal') {
      setPendingEditedFilePath(path);
      void reloadFiles(false);
      return;
    }
    openEditedFileInlinePath(path);
  }, [openEditedFileInlinePath, reloadFiles, workspaceFileByPath]);

  const handleReturnToChatFromSpace = useCallback(() => {
    setWorkspaceViewMode('chat');
  }, [setWorkspaceViewMode]);

  const handleOpenDiffFile = useCallback(
    (assistantMessageId: string) => {
      if (isMobile) return;
      // Open the source the turn changed, not a compile artifact it emitted.
      const targetPath = firstEditableTurnEditPath(getCachedTurnEdits(assistantMessageId));
      if (!targetPath) return;
      handleOpenEditedFileInline(targetPath);
    },
    [handleOpenEditedFileInline, isMobile],
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
  // The menu lives inside one of the two picker wrappers (top bar / chat header),
  // so a click in either is "inside" and must not close it.
  useEffect(() => {
    if (!showAssistantPicker) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        assistantPickerRef.current?.contains(target) ||
        chatHeaderPickerRef.current?.contains(target)
      )
        return;
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
      }: { index?: number; focusComposer?: boolean; sidePanel?: boolean } = {}
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
        openCenterPanel('chat', { chatId, side: sidePanel });
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

  const replaceDraftChat = useCallback((draftId: string, realThread: ChatThread) => {
    draftPromotionsRef.current[draftId] = realThread.chat.id;
    // The draft's pane tab follows the promotion — same tab, real id.
    const fromTab = chatTab(draftId);
    const toTab = chatTab(realThread.chat.id);
    setEditorPanes((prev) =>
      prev.some((p) => p.tabs.includes(fromTab))
        ? prev.map((p) => ({
            ...p,
            tabs: p.tabs.map((t) => (t === fromTab ? toTab : t)),
            active: p.active === fromTab ? toTab : p.active,
          }))
        : prev,
    );
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
    // Swapping the draft id for the real one remounts the composer (its key is
    // the chatId). If the user was typing in it — e.g. they just opened this
    // chat via "New chat" — re-assert focus so the remount doesn't dump focus
    // on <body>. Guarded on current focus so we never steal it from the editor.
    if (currentChatRef.current?.id === draftId && typeof document !== 'undefined') {
      const composer = chatInputRef.current;
      if (composer && (document.activeElement === composer || composer.contains(document.activeElement))) {
        setShouldFocusChatInput(true);
      }
    }
    moveStoredMessageDraft(draftId, realThread.chat.id, currentChatRef.current?.id === draftId);
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
  }, [moveStoredMessageDraft]);

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
              ...(folderScope ? { folderScope } : {}),
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

  // Create a local-only draft chat (persist immediately for prewarm)
  const startDraftChat = useCallback(
    (
      _assistantId: string | null,
      _assistantInfo: unknown,
      opts?: { model?: string; appendTab?: boolean; sideTab?: boolean; folderScope?: string }
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
      const draftHarness = isLocalWorkspace ? localEnginesRef.current.defaultHarness ?? null : null;
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
        setSelectedChatIndex(next.length - 1);
        return next;
      });
      setSelectedChatSurface({ type: 'direct', chatId: draftId });
      if (!isMobile) openChatTabInPanes(draftId, { append: opts?.appendTab, side: opts?.sideTab });
      setShouldFocusChatInput(true);
      closeAssistantPicker();
      void promoteDraftChat(draftId, null, effectiveModel, draftHarness ?? undefined, opts?.folderScope);
      return draftId;
    },
    [closeAssistantPicker, isMobile, openChatTabInPanes, preferredChatModel, projectId, promoteDraftChat]
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
        folderScope,
      }: {
        forceNew?: boolean;
        model?: string;
        keepMode?: boolean;
        appendTab?: boolean;
        folderScope?: string;
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
      return startDraftChat(assistantId, assistantInfo ?? null, { model: effectiveModel, appendTab, folderScope });
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
  // (chats.folder_scope — the rail's folder-focus filter reads it) and the
  // composer opens pre-scoped so the first message carries the context.
  const startChatInFolder = useCallback(
    (folder: string) => {
      openCenterPanel('chat');
      // '' = a root section's "New chat here" (multi-root primary): the whole
      // project is the scope, so start a plain unscoped chat.
      void startAssistantChat(null, null, {
        forceNew: true,
        keepMode: true,
        ...(folder ? { folderScope: folder } : {}),
      }).then((draftId) => {
        if (draftId && folder) setStoredMessageDraft(draftId, `Working in \`${folder}/\`: `, true);
      });
    },
    [openCenterPanel, setStoredMessageDraft, startAssistantChat]
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

  // A workspace with no open chats lands on a dead composer ("Add an
  // assistant…") — start a fresh chat instead so it always opens ready to send.
  const autoDraftProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatsLoaded || chatsProjectId !== projectId || !canWrite) return;
    if (autoDraftProjectRef.current === projectId) return;
    if (chatThreadsForCurrentProject.some((thread) => !thread.chat.archived_at)) return;
    autoDraftProjectRef.current = projectId;
    // sideTab: a deep-linked doc keeps the primary pane — the auto-draft
    // docks aside; with nothing open it still lands full-width.
    startDraftChat(null, null, { sideTab: true });
  }, [canWrite, chatsLoaded, chatsProjectId, chatThreadsForCurrentProject, projectId, startDraftChat]);

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

  const toggleChatArchive = useCallback(
    async (chatId: string, archived: boolean) => {
      if (!canWrite || !user?.id) return;
      const res = await apiFetch('/api/workspace/chats', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, archived }),
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
    [canWrite, user?.id]
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
    optimisticStartingUntilByChatIdRef.current.delete(chatId);
    setChatStatusById((prev) => {
      if (prev[chatId] !== 'starting') return prev;
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
    try {
      const res = await apiFetch('/api/agent/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload?.error || `Stop failed (${res.status})`);
      }
    } catch (error) {
      // Surface it. A swallowed interrupt looks identical to "nothing happened"
      // — exactly the anon-401 bug that hid here for so long.
      setInterruptErrorByChatId((prev) => ({
        ...prev,
        [chatId]: error instanceof Error ? error.message : 'Could not stop Sunny',
      }));
    } finally {
      setInterruptingChatIds((prev) => {
        if (!prev[chatId]) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
    }
  }, [clearInterruptError, currentChatId, interruptingChatIds]);

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
    // message that then dies on credentials_missing. Only DRAFTS inherit the
    // install default (promotion stamps it); a persisted chat with no harness
    // is a legacy row the sidecar runs as Sunny.
    let chatEngine = currentChat.harness
      ? parseChatHarness(currentChat.harness)
      : isDraftChatId(currentChat.id)
        ? localEnginesRef.current.defaultHarness
        : ('vercel' as const);
    if (isLocalWorkspace && chatEngine === undefined && localConfig) {
      chatEngine = await localSidecar
        .localEngines(localConfig)
        .then(({ defaultHarness }) => (defaultHarness === null ? null : parseChatHarness(defaultHarness)))
        .catch(() => null);
    }
    const localEngineChat = isLocalWorkspace && (chatEngine === 'claude' || chatEngine === 'openai');
    if (!localEngineChat && (clerkAuthRef.current.isLoaded || clerkNeverLoads()) && !clerkAuthRef.current.isSignedIn) {
      // Cloud workspaces opened in the packaged app have no localConfig, but
      // the loopback sidecar still holds the sd_ credentials that authenticate
      // every /api call — resolve it globally or every send would nag sign-in.
      const config = localConfig ?? (await resolveSidecarConfig());
      const desktopCredentials = config ? await desktopCredentialsUsable(config) : false;
      if (!desktopCredentials) {
        stashPendingDraft(projectId, rawContent);
        openSignIn({ redirectUrl: buildReturnPath({}) });
        return;
      }
    }
    // Sending without an explicit engine choice IS the choice — the first-run
    // card stops nagging and new chats keep this chat's engine.
    if (isLocalWorkspace && localEnginesRef.current.defaultHarness === null) {
      chooseLocalDefaultEngine(parseChatHarness(currentChat.harness));
    }
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
    if (isDraftChatId(chat.id) && projectId && canWrite) {
      const draftId = chat.id;
      // Promote with the draft's own model, not preferredChatModel (which may
      // have drifted to another open chat).
      const realThread = await promoteDraftChat(
        draftId,
        null,
        normalizeChatModelRef(chat.model),
        // Only a draft that KNOWS its engine overrides — a pre-probe draft
        // has none and defers to the sidecar's stored default.
        isLocalWorkspace && chat.harness ? parseChatHarness(chat.harness) : undefined,
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
    if (!sundialChatRef.current || chat.id !== currentChatId) {
      // Defensive: chat swap raced ahead of the send. Restore status and
      // let the next send (with the right chatId) take over.
      restoreChatStatus();
      return;
    }

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
    } catch (err) {
      restoreChatStatus();
      if (attachments.length > 0) {
        setAttachmentsByChatId((prev) => ({ ...prev, [chat.id]: attachments }));
      }
      console.warn('[handleSendMessage] sundialChat.send failed', err);
    }

    if (canWrite && user?.id) {
      window.setTimeout(() => {
        void loadAgentStatuses();
      }, 300);
    }
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
      if (isDraftChatId(targetChatId)) {
        // Drafts persist in the background the moment they're created; await
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
    const nextModel = coerceModelForHarness(nextHarness, currentChatModel);
    await patchChatSettings(
      currentChatId,
      { harness: nextHarness, ...(nextModel !== currentChatModel ? { model: nextModel } : {}) },
      { model: currentChatModel, harness: currentChatHarness },
    );
  };

  // First-run engine onboarding (local projects): the pick becomes the
  // install default AND applies to the open (draft) chat immediately.
  const handleChooseLocalEngine = (harness: ChatHarness) => {
    chooseLocalDefaultEngine(harness);
    void handleSelectChatHarness(harness);
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

  // "Fix with Sunny" (§1.10) / auto-fix (§1.11) / Cmd+Enter (§1.5): hand the
  // failing root + trimmed error tail to the current chat as a normal turn. No
  // new agent endpoint — Sunny edits the .tex and self-heals as usual.
  const [fixInFlight, setFixInFlight] = useState(false);
  const handleLatexFix = useCallback(() => {
    if (!activeWorkspaceFile) return;
    const target = latexRootPath ?? activeWorkspaceFile.path;
    setFixInFlight(true);
    handleSendMessageRef.current?.(
      buildCompileFixPrompt(target, latexCompile.errorLines, latexCompile.logText),
    );
  }, [activeWorkspaceFile, latexRootPath, latexCompile.errorLines, latexCompile.logText]);
  const canLatexFix = Boolean(currentChat) && canWrite;

  // Clear the "Auto-fixing…" indicator once the fix turn finishes streaming
  // (busy → idle), so the toolbar/bottom bar return to their resting state.
  const chatBusy =
    sundialChat.status === 'streaming' || sundialChat.status === 'submitted';
  const prevChatBusyRef = useRef(false);
  useEffect(() => {
    if (prevChatBusyRef.current && !chatBusy) setFixInFlight(false);
    prevChatBusyRef.current = chatBusy;
  }, [chatBusy]);

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
      handleLatexFix();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeTexFile, canLatexFix, latexCompile.compileError, handleLatexFix]);

  const handleInterruptLoop = useCallback(() => {
    void handleInterruptChat();
  }, [handleInterruptChat]);

  const handleCreateFile = useCallback(() => {
    if (!canWrite) return;
    beginDraft('text');
  }, [beginDraft, canWrite]);

  const handleCreateFolder = useCallback(() => {
    if (!canWrite) return;
    beginDraft('folder');
  }, [beginDraft, canWrite]);

  // Command-palette actions: only commands the page already exposes elsewhere,
  // each reusing that surface's handler (and its gating).
  const paletteActions = useMemo<CommandPaletteAction[]>(() => {
    const actions: CommandPaletteAction[] = [];
    if (canWrite) {
      actions.push({
        id: 'new-file',
        label: 'New file',
        keywords: 'create document',
        // The draft input lives in the files tree — reveal it first (same as
        // the tab strip's ＋ launcher).
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
        run: () => {
          openCenterPanel('chat');
          void startAssistantChat(null, null, { forceNew: true, keepMode: true });
        },
      });
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
    }
    if (canWrite && activeWorkspaceFile && !documentReadOnly && docEditModes.includes('suggest')) {
      actions.push({
        id: 'toggle-edit-mode',
        label: effectiveDocEditMode === 'suggest' ? 'Switch to Editing' : 'Switch to Suggesting',
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
    docEditModes,
    documentReadOnly,
    downloadWorkspaceZip,
    effectiveDocEditMode,
    handleCreateFile,
    handleCreateFolder,
    isMobile,
    openCenterPanel,
    openRightDock,
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

  // Cmd/Ctrl+N → new file, desktop shell only: browsers reserve the shortcut
  // for a new window, so binding it there could never fire. Opens the file
  // rail first — the draft input lives in the tree and must be visible.
  useEffect(() => {
    if (!isDesktopApp) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'n') return;
      event.preventDefault();
      setOpenLeftRail('project');
      handleCreateFile();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDesktopApp, handleCreateFile]);

  const movePath = useCallback(async (sourcePath: string, targetPath: string, { skipReload = false } = {}) => {
    if (!canWrite) return;
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
    try {
      const res = await apiFetch('/api/workspace/files', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, sourcePath, targetPath }),
      });
      ok = res.ok;
    } catch {
      // network failure — treated as not ok below
    }
    if (!ok) {
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

    if (!skipReload) {
      await reloadFiles(false);
      filesChannelRef.current?.postMessage({ type: 'refresh' });
      // Renaming a synced mount re-keys its imported_path server-side; refetch
      // the linked-repo list so the badge follows the folder instead of clinging
      // to the now-gone old path.
      setLinkedReposRefreshKey((k) => k + 1);
    }
  }, [canWrite, editorPanes, existingPaths, pendingOpenFileMove, projectId, reloadFiles, selectedFilePath, workspaceFileByPath, workspaceFiles]);

  const moveItem = useCallback(async (sourcePath: string, targetFolder: string | null, { skipReload = false } = {}) => {
    if (!sourcePath) return;
    const name = getFileName(sourcePath);
    const targetPath = targetFolder ? `${targetFolder}/${name}` : name;
    await movePath(sourcePath, targetPath, { skipReload });
  }, [movePath]);

  const handleFileDragStart = useCallback((event: DragEvent<HTMLDivElement>, filePath: string) => {
    if (!canWrite) return;
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
  }, [canWrite, handleTabDragChange, isMobile, selectedPaths]);

  const handleDrop = useCallback(async (event: DragEvent<HTMLDivElement>, targetFolder: string | null) => {
    if (!canWrite) return;
    event.preventDefault();
    event.stopPropagation();
    setIsFilesDropActive(false);
    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    if (droppedFiles.length > 0) {
      queueUploads(droppedFiles, 'files', targetFolder);
      setDragOverPath(null);
      return;
    }
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
  }, [canWrite, moveItem, queueUploads, reloadFiles]);
  const queueFileUploadsToFolder = useCallback((files: File[], targetFolder: string | null) => {
    queueUploads(files, 'files', targetFolder);
  }, [queueUploads]);

  // Rail clicks carry side semantics (files-left/chats-right): with only a
  // file open the chat splits to its right; with a chat already displayed the
  // click replaces that chat; a sole chat pane replaces in place.
  const selectChat = (index: number, { focusComposer = false }: { focusComposer?: boolean } = {}) => {
    const chatId = chatThreadsForCurrentProject[index]?.chat.id;
    if (!chatId) return;
    activateDirectChat(chatId, { index, focusComposer, sidePanel: true });
  };

  const openChatById = useCallback(
    async (chatId: string, { sidePanel = false }: { sidePanel?: boolean } = {}) => {
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
  }, [currentChatId, deepLinkedWorkspaceFile, filesLoaded, isMobile, openChatTabInPanes, openPanels, projectId]);

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
    isMobile,
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
  const renderAssistantPickerMenu = ({
    align = 'left',
    keepMode = false,
  }: { align?: 'left' | 'right'; keepMode?: boolean } = {}) => (
    <div className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full z-50 mt-1.5 w-44 max-w-[calc(100vw-2rem)] rounded-lg border border-stone-200 bg-white py-1 text-xs shadow-lg`}>
      <button
        type="button"
        onClick={() => void startAssistantChat(null, null, { forceNew: true, keepMode })}
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
    const canArchive = Boolean(canWrite && chat?.id && !isDraftChatId(chat.id));
    const canTogglePin = Boolean(user?.id && chat?.id && !isDraftChatId(chat.id));
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
          typeof chat.sunny_number === 'number' ? `#${chat.sunny_number}` : 'Sunny',
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
          <CaretDownIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
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
            {/* Phone/SMS "Connect to mobile" hidden from the UI for now — re-enable later.
            {canWrite ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  setLinkTextChatId(chat.id);
                }}
                className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                Connect to mobile
              </button>
            ) : null}
            */}
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
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenChatMenuId(null);
                  void toggleChatArchive(chat.id, !isArchived);
                }}
                className="w-full px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                {isArchived ? 'Unarchive chat' : 'Archive chat'}
              </button>
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
                title={`Edited files in ${focusedSidebarFolder}/ — started elsewhere`}
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
            <div className="relative ml-auto flex h-5 shrink-0 items-center justify-end">
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
            chatsLoaded ? <div className={emptyTextClass}>{chatLoadError}</div> : null
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
    const title =
      accessError === 'not-found'
        ? 'Workspace not found'
        : accessError === 'signin'
          ? 'Sign in required'
          : 'Private workspace';
    const message =
      accessError === 'not-found'
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
          <p className="mt-3 text-stone-600">{message}</p>
          {accessError === 'signin' && (
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

  // Doc-header chrome shared between the desktop editor-column strip and the
  // mobile top bar. Below the mobile breakpoint the top bar carries the file
  // identity + per-file controls itself — one chrome bar in the same
  // left-to-right order as desktop, instead of stacking a second header that
  // repeats the file name.
  const docFileNameControl = activeWorkspaceFile ? (
    <DocFileNameControl
      fileName={formatFileName(getFileName(activeWorkspaceFile.path))}
      canRename={canWrite && !documentEditorReadOnly}
      isRenaming={
        renameEntry?.source === 'header' &&
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
  const docFileControls = activeWorkspaceFile ? (
    <>
      {!documentReadOnly ? (
        <EditModeControl
          mode={effectiveDocEditMode}
          onChange={setDocumentEditMode}
          menuPlacement="down"
          modes={docEditModes}
          disabled={!canWrite}
        />
      ) : canComment && isAuthLoaded && !user ? (
        // Anonymous visitor on a Commenter link: suggesting
        // needs an identity (see canComposeSuggestions).
        <button
          type="button"
          onClick={() => openSignIn({ redirectUrl: buildReturnPath({}) })}
          className="rounded-lg px-2.5 py-1 text-[13px] text-stone-500 hover:bg-stone-100 hover:text-stone-700 transition-colors"
        >
          Sign in to suggest edits
        </button>
      ) : null}
      {pdfPreviewUrl ? (
        <a
          href={pdfPreviewUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in new tab"
          className="relative group/tip inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
        >
          <ArrowSquareOutIcon className="h-4 w-4" weight="regular" aria-hidden />
          <IconTooltip label="Open in new tab" />
        </a>
      ) : null}
      {!isMarkdownEditing && hasRichViewer ? (
        // Preview↔Source for code files with a rich viewer (CSV/JSON/HTML),
        // living beside Editing / Share instead of above the content.
        <button
          type="button"
          onClick={() => setShowRichViewer((v) => !v)}
          aria-label={showRichViewer ? 'Source' : 'Preview'}
          aria-pressed={showRichViewer}
          className={`relative group/tip inline-flex h-7 w-7 items-center justify-center rounded hover:bg-stone-100 ${
            showRichViewer ? 'text-stone-700' : 'text-stone-400 hover:text-stone-600'
          }`}
        >
          {activeCsvFile ? (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18M3 6h18M3 18h18M9 6v12M15 6v12" />
            </svg>
          ) : activeJsonFile ? (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 7V4a1 1 0 011-1h3M17 3h3a1 1 0 011 1v3M20 17v3a1 1 0 01-1 1h-3M7 21H4a1 1 0 01-1-1v-3" />
            </svg>
          ) : (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          )}
          <IconTooltip label={showRichViewer ? 'Source' : 'Preview'} />
        </button>
      ) : null}
      {activeIsMarkdown ? (
        <button
          type="button"
          onClick={() => {
            const el = docEditorBodyRef.current;
            if (el) docScrollFractionRef.current = scrollFraction(el);
            pendingRestoreRef.current = true;
            setShowRawView((value) => !value);
          }}
          aria-pressed={showRawView}
          aria-label="Raw markdown"
          data-testid="toggle-raw-markdown"
          className={`relative group/tip inline-flex h-7 w-7 items-center justify-center rounded hover:bg-stone-100 ${
            showRawView ? 'text-stone-700' : 'text-stone-400 hover:text-stone-600'
          }`}
        >
          <CodeIcon className="h-4 w-4" weight="regular" aria-hidden />
          <IconTooltip label={showRawView ? 'Rendered view' : 'Raw markdown'} />
        </button>
      ) : null}
      {/* Per-file Share (wireframe: file header, right before Comments) —
          replaces the bare Copy-file-link button. */}
      <FileShareMenu
        fileUrl={buildFileUrl(activeWorkspaceFile) || null}
        onShareFile={
          // Local: share this file to a cloud workspace — but extra-root
          // mounts can't share (shares cover the primary root only).
          isLocalWorkspace &&
          !localRoots.some((entry) => entry.prefix && activeWorkspaceFile.path.split('/', 1)[0] === entry.prefix)
            ? () => setLocalShareScope({ kind: 'file', path: activeWorkspaceFile.path })
            : undefined
        }
        onOpenWorkspaceShare={!isLocalWorkspace && canShowShareControls ? openShare : undefined}
      />
      {/* Comments toggle — lives beside Share in the file header (wireframe),
          not the window top-right. Desktop only: the lane needs the wide
          editor column. Hidden while the file has zero comments — commenting
          starts from the selection bubble (⌘⌥M), not this toggle. */}
      {!isMobile && activeFileCommentCount > 0 ? (
        <button
          type="button"
          onClick={toggleCommentLane}
          aria-pressed={commentsLaneToggled}
          aria-label="Comments"
          data-testid="doc-comments-toggle"
          className={`relative group/tip inline-flex h-7 w-7 items-center justify-center rounded hover:bg-stone-100 ${
            commentsLaneToggled ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'
          }`}
        >
          <ChatTextIcon
            className="h-4 w-4"
            weight={commentsLaneToggled ? 'fill' : 'regular'}
            aria-hidden
          />
          {commentBadgeCount > 0 ? (
            <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-white bg-[#e7c49e] px-1 text-[10px] font-semibold text-[#634a31]">
              {Math.min(commentBadgeCount, 9)}
            </span>
          ) : null}
          <IconTooltip label="Comments" />
        </button>
      ) : null}
    </>
  ) : null;
  // The ONE live chat surface (single useSundialChat instance). Desktop mounts
  // it inside whichever pane shows the active chat tab; mobile mounts it as
  // the legacy sole chat column. `sole` = chat fills the center (arrival).
  const renderChatSurface = (sole: boolean) => (
    <WorkspaceChatPane
                    variant="space-side"
                    composerKey={`${currentChatId ?? 'no-chat'}:${messageDraftVersion}:chat`}
                    emptyState={
                      isLocalWorkspace &&
                      localEngines.defaultHarness === null &&
                      liveChatMessagesForEdits.length === 0 &&
                      (currentChat?.message_count ?? 0) === 0 ? (
                        <LocalEngineOnboarding
                          engines={{ claude: localEngines.claude, codex: localEngines.codex }}
                          onChoose={handleChooseLocalEngine}
                        />
                      ) : // The chat-first landing: greeting + starter prompts. Only when
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
                          <p>
                            Rendered in place from {externalAgentHome(currentChatExternal)}…; this chat stays on your
                            Mac.
                          </p>
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
                    interruptError={currentChatId ? interruptErrorByChatId[currentChatId] : undefined}
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
                      <div data-chat-id={currentChat?.id} className="flex h-9 shrink-0 items-center justify-between gap-2 bg-white px-3">
                        {/* Left: Sunny avatar, then the title. */}
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                          {currentChatUsesGroupPresentation ? (
                            <GearSixIcon className="h-4 w-4 shrink-0 text-stone-500" weight="regular" aria-hidden />
                          ) : currentChatExternal ? (
                            <ExternalAgentBadge external={currentChatExternal} className="h-5 w-5" />
                          ) : (
                            <span className="flex h-5 w-5 shrink-0 overflow-hidden rounded-full">
                              <img
                                src={(currentChat ? sunnyAvatarByChatId.get(currentChat.id) : null) ?? '/sunnies/sundial-default.png'}
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
                          {currentChatHasTextTransport ? <TransportBadge label="text" /> : null}
                        </div>
                        {/* Right: copy chat link, "+ New" (same control as the
                            sidebar) opens the new-chat menu, then close. */}
                        <div className="flex shrink-0 items-center gap-1">
                          {currentChatLink ? (
                            <button
                              type="button"
                              onClick={openChatShare}
                              aria-label="Share chat"
                              data-testid="chat-share-button"
                              className="relative group/tip inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                            >
                              <ExportIcon className="h-4 w-4" weight="regular" aria-hidden />
                              <IconTooltip label="Share chat" side="bottom" />
                            </button>
                          ) : null}
                          <div className="relative" ref={chatHeaderPickerRef}>
                            <button
                              type="button"
                              onClick={() => {
                                if (showAssistantPicker) {
                                  closeAssistantPicker();
                                } else {
                                  openAssistantPickerMenu({ keepMode: true });
                                }
                              }}
                              aria-haspopup="menu"
                              aria-expanded={showAssistantPicker}
                              aria-label="New chat"
                              data-testid="chat-header-new"
                              className="relative group/tip inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                            >
                              <PlusIcon className="h-4 w-4" weight="bold" aria-hidden />
                              {/* Suppress the hover tooltip while the menu is open —
                                  the click keeps the button hovered, so the dark
                                  bubble would otherwise sit behind the dropdown. */}
                              <IconTooltip label="New chat" open={showAssistantPicker} />
                            </button>
                            {showAssistantPicker ? renderAssistantPickerMenu({ align: 'right', keepMode: true }) : null}
                          </div>
                          <button
                            type="button"
                            onClick={closeActiveChatTab}
                            aria-label="Close chat"
                            data-testid="chat-column-close"
                            className="relative group/tip inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                          >
                            <XIcon className="h-4 w-4" weight="bold" aria-hidden />
                            <IconTooltip label="Close" />
                          </button>
                        </div>
                      </div>
                      )
                    }
                    transcriptProps={{
                      hasAssistant: Boolean(currentChatId),
                      assistantGreeting,
                      showGreeting: Boolean(assistantGreeting && !currentChat?.last_message_at && currentChatMessages.length === 0),
                      messages: sundialChat.messages,
                      showWorkingIndicator,
                      turnLinkBase: currentChatId && typeof window !== 'undefined'
                        ? `${window.location.origin}${buildWorkspaceChatPath(workspaceRouteId, currentChatId)}`
                        : undefined,
                      onTurnLinkShareGate: chatShareReady ? undefined : openChatShare,
                      highlightedDiffId: deepLinkedDiffId,
                      scrollToBottomRef: scrollChatToBottomRef,
                      isStreaming:
                        sundialChat.status === 'streaming' ||
                        sundialChat.status === 'submitted',
                      latestTurnJustCompleted:
                        completedRunChatId !== null && completedRunChatId === currentChatId,
                      onOpenDiffFile: isMobile ? undefined : handleOpenDiffFile,
                      knownFilePaths: mentionableFilePaths,
                      workspaceId: projectId,
                      onOpenWikiFile: handleOpenEditedFileInline,
                    }}
                    composerProps={{
                      chatId: currentChatId,
                      showGroupChatUi: currentChatUsesGroupPresentation,
                      hasAssistant: Boolean(currentChatId),
                      initialValue: currentChatId ? (messageInputByChatIdRef.current[currentChatId] ?? '') : '',
                      textareaRef: chatInputRef,
                      shouldFocus: shouldFocusChatInput,
                      onFocusHandled: () => setShouldFocusChatInput(false),
                      onDraftChange: setStoredMessageDraft,
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

  const newTabLauncher = canWrite ? (
    <div className="relative flex items-center">
      <button
        ref={newTabTriggerRef}
        type="button"
        onClick={() => setShowNewTabMenu((open) => !open)}
        aria-label="New tab"
        aria-haspopup="menu"
        aria-expanded={showNewTabMenu}
        data-testid="new-tab-launcher"
        className="relative group/tip ml-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center self-center rounded text-stone-400 hover:bg-stone-200/60 hover:text-stone-600"
      >
        <PlusIcon className="h-4 w-4" weight="bold" aria-hidden />
        <IconTooltip label="New tab" open={showNewTabMenu} />
      </button>
      <AnchoredDropdown
        open={showNewTabMenu}
        anchorRef={newTabTriggerRef}
        align="left"
        className="w-44 rounded-lg border border-stone-200 bg-white py-1 text-xs shadow-lg"
      >
        <button
          type="button"
          onClick={() => {
            setShowNewTabMenu(false);
            // The draft input lives in the files tree — reveal it first. The
            // launcher means "new TAB": the committed file appends beside the
            // active tab instead of replacing it.
            draftAppendTabRef.current = true;
            setOpenLeftRail('project');
            setSidebarSections((prev) => expandSection(prev, 'files'));
            handleCreateFile();
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
        >
          <FilePlusIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
          New file
        </button>
        <button
          type="button"
          onClick={() => {
            setShowNewTabMenu(false);
            void startAssistantChat(null, null, { forceNew: true, keepMode: true, appendTab: true });
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-stone-600 hover:bg-stone-50"
        >
          <ChatTeardropIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
          New chat
        </button>
      </AnchoredDropdown>
    </div>
  ) : null;

  // Home + sidebar toggle live in the rail's top row while it's open, and at
  // the left end of the single top bar while it's collapsed — one bar total.
  const shellNavControls = (
    <>
      {/* The desktop app's one home is /local (local projects + cloud
          workspaces together) — cloud workspaces opened in the shell
          go back there too, not to the web dashboard. */}
      <Link
        href={isLocalWorkspace || isDesktopApp ? '/local' : '/dashboard'}
        onClick={() => persistLayoutConfig()}
        aria-label="Home"
        data-testid="topbar-home"
        // ml-1.5: founder-requested ~6px nudge right, in both the rail top
        // row and the collapsed-rail bar (additive to the traffic-light pad).
        className="relative group/tip ml-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600"
      >
        <HouseIcon className="h-5 w-5" weight="regular" aria-hidden />
        <IconTooltip label="Home" />
      </Link>
      <button
        type="button"
        onClick={toggleSidebar}
        aria-pressed={openLeftRail !== null}
        aria-label="Toggle sidebar"
        data-testid="topbar-sidebar-toggle"
        className={`relative group/tip inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-stone-100 ${
          openLeftRail !== null ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-600'
        }`}
      >
        <SidebarSimpleIcon
          className="h-5 w-5"
          weight={openLeftRail !== null ? 'fill' : 'regular'}
          aria-hidden
        />
        <IconTooltip label="Sidebar" />
      </button>
    </>
  );

  // The rail's top row carries Home + the sidebar toggle (the rail reaches
  // the window top — in the desktop shell it clears the macOS traffic
  // lights), with the ⌘K search bar below. The workspace identity moved down
  // into the Files section header (founder: the project name + picker sit
  // where the "Files" label was).
  const workspaceTitleControl = (
    <div className="border-b border-stone-200">
    <div
      className={`flex h-11 min-w-0 items-center gap-1.5 px-3 ${isDesktopApp ? 'pl-[72px]' : ''}`}
      {...(isDesktopApp ? { 'data-tauri-drag-region': '' } : {})}
    >
              {shellNavControls}
            </div>
    <div className="px-2 pb-2">
      <button
        type="button"
        onClick={() => setCommandPaletteOpen(true)}
        data-testid="sidebar-search-bar"
        className="flex w-full items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-left text-xs text-stone-400 shadow-[0_1px_2px_rgba(28,25,23,0.04)] transition-colors hover:border-stone-300 hover:text-stone-500"
      >
        <MagnifyingGlassIcon className="h-3.5 w-3.5 flex-shrink-0" weight="regular" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Search</span>
        <kbd className="rounded border border-stone-200 bg-stone-50 px-1 py-px font-sans text-[10px] text-stone-400">⌘K</kbd>
      </button>
    </div>
    </div>
  );

  // The Files-section header slot — the wireframe's "Workspace" title (ws
  // glyph + the word "Workspace") with the switcher caret kept on the row.
  // Double-click still renames the underlying project title; the current
  // project name lives in the tooltip and the switcher menu.
  const workspaceIdentityHeader = (
    <div className="relative flex min-w-0 flex-1 items-center gap-1" ref={workspaceSwitcherRef}>
      <div className="flex min-w-0 items-center gap-1" data-workspace-switcher-trigger>
        {isEditingTitle && canWrite ? (
          <input
            autoFocus
            size={Math.max(editingTitleValue.length + 1, 2)}
            className="min-w-0 max-w-[240px] bg-transparent text-[13px] font-semibold text-stone-700 outline-none"
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
            className={`flex min-w-0 items-center gap-1.5 text-left text-[13px] font-semibold text-stone-700 ${canWrite ? 'cursor-pointer hover:text-stone-900' : 'cursor-default'}`}
            onClick={toggleWorkspaceSwitcher}
            onDoubleClick={startProjectTitleEdit}
            title={
              canWrite
                ? `${projectTitle} — click to open the workspace menu. Double-click to rename.`
                : projectTitle
            }
          >
            <WorkspaceRootGlyph className="h-3.5 w-3.5 shrink-0 text-stone-400" />
            <span className="truncate">Workspace</span>
          </button>
        )}
        {archivedTag}
        <button
          aria-label="Switch workspace"
          className={`relative group/tip shrink-0 cursor-pointer rounded p-0.5 hover:bg-stone-100 ${isEditingTitle ? 'invisible' : ''}`}
          onClick={toggleWorkspaceSwitcher}
        >
          <CaretDownIcon
            className={`h-3 w-3 text-stone-400 transition-transform ${showWorkspaceSwitcher ? 'rotate-180' : ''}`}
            weight="bold"
            aria-hidden
          />
          <IconTooltip label="Switch workspace" open={showWorkspaceSwitcher} />
        </button>
      </div>
      {workspaceSwitcherMenu}
    </div>
  );

  // Right end of the single top bar (collaborators · right dock · Share) —
  // pinned at the window's absolute top-right (founder: Share always stays
  // there), independent of pane count, dock state, or special views.
  // The strip rows beneath reserve its measured width as right padding.
  const topBarRightControls = (
    <div
      ref={topbarRightRef}
      className="absolute right-0 top-0 z-30 flex h-11 shrink-0 items-center gap-3 border-b border-stone-200/60 bg-stone-100/70 pl-2 pr-3 print:hidden"
      data-testid="topbar-right"
      {...(isDesktopApp ? { 'data-tauri-drag-region': '' } : {})}
    >
              {showOffline && (
                <span data-testid="workspace-offline-banner" className="text-xs font-medium text-stone-900">Offline</span>
              )}
              {/* Collaborators + Assistants */}
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

              {/* Per-document controls (mode picker, comments toggle, Share
                  file, raw toggle, toolbar toggle) moved into the document
                  pane itself — see [topbar-doc-controls] in the primary
                  pane. */}

              {/* Right dock (PR #907 right panel): History + Outline. ONE
                  toggle here opens/closes it; the view switchers live in the
                  dock's own icon strip (founder: buttons that change the
                  panel belong ON the panel). */}
              {!isMobile ? (
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
                    <SidebarSimpleIcon className="h-5 w-5 -scale-x-100" weight="regular" aria-hidden />
                    <IconTooltip label="Toggle right panel" />
                  </button>
              ) : null}

              {/* Share */}
              {isLocalWorkspace && localShares.some((share) => share.enabled) && (
                <button
                  type="button"
                  onClick={openShare}
                  className="rounded-full bg-sky-500/10 px-2.5 py-0.5 text-xs text-sky-700 hover:bg-sky-500/20"
                  data-testid="share-status"
                  title="Live-syncing to the cloud — click to manage"
                >
                  {localShares.filter((share) => share.enabled).length} shared ·{' '}
                  {localShares.reduce((n, share) => n + share.bridgedFiles, 0)} files syncing
                </button>
              )}
              {canShowShareControls && (
                <button
                  type="button"
                  onClick={openShare}
                  aria-label="Share"
                  className="bg-stone-900 text-white px-2.5 lg:px-4 py-1.5 rounded-lg text-sm font-medium inline-flex items-center gap-2 cursor-pointer"
                >
                  <WorkspaceShareStatusIcon status={shareStatus} className="w-4 h-4" />
                  <span className="hidden lg:inline">Share</span>
                </button>
              )}
    </div>
  );

  return (
    // Data-plane context: local workspaces route deep components' /api/workspace
    // reads (Review panel, compare, labels) through the sidecar-emulated fetch.
    <ApiFetchProvider value={apiFetch}>
    {!(layoutConfigReady && filesLoaded) && (
      // The workspace below stays opacity-0 until the file list arrives — on a
      // big local folder that walk takes a while, so show progress instead of
      // a blank white page.
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-white" role="status" data-testid="workspace-loading-overlay">
        <div className="flex flex-col items-center gap-3">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-stone-200 border-t-stone-500" aria-hidden />
          <span className="text-sm text-stone-400">Loading project…</span>
        </div>
      </div>
    )}
    <div className={`h-screen bg-white flex flex-col transition-opacity duration-300 ${layoutConfigReady && filesLoaded ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
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
          <div className="h-12 px-3 flex items-center justify-between shrink-0">
            <>
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <button
                  onClick={() => setMobilePanel('chats')}
                  aria-label="Chats"
                  className="relative group/tip p-2 -ml-1 rounded-lg hover:bg-stone-100 text-stone-400 shrink-0"
                >
                  {/* Same chats-list icon as the desktop sidebar tab — this
                      opens the chats drawer, not a generic menu. */}
                  <ChatsCircleIcon className="w-5 h-5" weight="regular" aria-hidden />
                  <IconTooltip label="Chats" />
                </button>
                {/* The list toggles (chats above, files here) sit together on
                    the left edge, mirroring the desktop sidebar toggle. */}
                <button
                  onClick={() => {
                    if (isSpaceMode) {
                      setMobilePanel('files');
                      return;
                    }
                    setWorkspaceViewMode('space');
                    if (!selectedFilePath) {
                      setMobilePanel('files');
                    }
                  }}
                  aria-label={isSpaceMode ? 'Files' : 'Space'}
                  className="relative group/tip p-2 rounded-lg hover:bg-stone-100 text-stone-400 shrink-0"
                >
                  <FolderSimpleIcon className="w-5 h-5" weight="regular" aria-hidden />
                  <IconTooltip label={isSpaceMode ? 'Files' : 'Space'} />
                </button>
                {isSpaceMode ? (
                  <button
                    onClick={handleReturnToChatFromSpace}
                    aria-label="Back"
                    className="relative group/tip p-1.5 rounded-lg hover:bg-stone-100 text-stone-400 shrink-0"
                  >
                    <ArrowLeftIcon className="w-5 h-5" weight="regular" aria-hidden />
                    <IconTooltip label="Back" />
                  </button>
                ) : null}
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
                      className={`flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors ${assistantPickerTriggerClassName}`}
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
                            <img
                              src={(currentChat ? sunnyAvatarByChatId.get(currentChat.id) : null) ?? '/sunnies/sundial-default.png'}
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
                    <button
                      type="button"
                      onClick={toggleWorkspaceSwitcher}
                      data-workspace-switcher-trigger
                      className="flex max-w-full items-center gap-1 rounded-lg px-1.5 py-1 text-left hover:bg-stone-50"
                      title={canWrite ? 'Open workspace menu' : projectTitle}
                    >
                      <span className="truncate text-sm font-medium text-stone-700">{projectTitle}</span>
                      <CaretDownIcon
                        className={`w-3 h-3 shrink-0 text-stone-400 transition-transform ${showWorkspaceSwitcher ? 'rotate-180' : ''}`}
                        weight="bold"
                        aria-hidden
                      />
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
                      <CaretDownIcon
                        className={`w-4 h-4 transition-transform ${showWorkspaceSwitcher ? 'rotate-180' : ''}`}
                        weight="bold"
                        aria-hidden
                      />
                    </button>
                    {workspaceSwitcherMenu}
                  </div>
                ) : null}
                {/* Per-file controls merge into this bar (same order as the
                    desktop doc header) — the editor column skips its own
                    header strip on mobile space mode. */}
                {isSpaceMode && editorColumnVisible ? docFileControls : null}
                {canShowShareControls && (
                  <button
                    type="button"
                    onClick={openShare}
                    aria-label="Share"
                    className="relative group/tip p-2 rounded-lg hover:bg-stone-100 text-stone-400"
                  >
                    <WorkspaceShareStatusIcon status={shareStatus} className="w-5 h-5" />
                    <IconTooltip label="Share" />
                  </button>
                )}
                {/* Single chrome row: the formatting toolbar stays collapsed
                    behind this toggle. */}
                {isSpaceMode && editorColumnVisible && activeWorkspaceFile && (activeIsMarkdown || activeTexFile) ? (
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
                    <WrenchIcon className="w-4 h-4" weight="regular" aria-hidden />
                    <IconTooltip label={mobileToolbarExpanded ? 'Hide toolbar' : 'Show toolbar'} />
                  </button>
                ) : null}
              </div>
            </>
          </div>
          ) : null}

          {/* Content area — flex row so left rails sit beside the content. */}
          <div className="relative flex flex-1 overflow-hidden">
            {!isMobile && openLeftRail === 'project' ? (
              <aside
                data-testid="project-left-rail"
                style={{ width: leftRailWidth }}
                // In-flow at every desktop width: below lg the center columns
                // shrink (max-lg:min-w-0) so the editor stays visible beside
                // the rail instead of being covered by an overlay.
                className="relative flex shrink-0 flex-col border-r border-stone-200 bg-stone-50"
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
                  footer={
                    <div>
                      <div className="-mx-3 mb-1.5">
                        <a
                          href={FEEDBACK_FORM_URL}
                          target="_blank"
                          rel="noreferrer"
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-800"
                        >
                          <span className="flex w-6 shrink-0 items-center justify-center">
                            <MegaphoneIcon className="h-4 w-4" weight="regular" aria-hidden />
                          </span>
                          Feedback
                        </a>
                        <a
                          href={DISCORD_INVITE_URL}
                          target="_blank"
                          rel="noreferrer"
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-800"
                        >
                          <span className="flex w-6 shrink-0 items-center justify-center">
                            <DiscordLogoIcon className="h-4 w-4" weight="regular" aria-hidden />
                          </span>
                          Community
                        </a>
                      </div>
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
                      {!isLocalWorkspace && <CreditBalancePill onOpenBilling={() => openSettingsTab('billing')} />}
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
                      collapsed={isSectionCollapsed(sidebarSections, 'files')}
                      onToggleCollapsed={() => toggleSidebarSectionCollapsed('files')}
                      onAddRepo={isLocalWorkspace ? undefined : () => connectOrSignIn(() => setShowAddRepoModal(true), { modal: 'addRepo' })}
                      onAddRepoHover={() => prefetchRepositories(user?.id)}
                      onAddOverleaf={
                        isLocalWorkspace
                          ? undefined
                          : () => connectOrSignIn(() => setShowAddOverleafModal(true), { modal: 'addOverleaf' })
                      }
                      onConnectLocalAgent={isLocalWorkspace ? undefined : () => void openLocalAgentModal()}
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
                      onOpenInNewTab={isMobile || !desktopTabs ? undefined : handleOpenInNewTab}
                      onOpenToSide={isMobile || !desktopTabs ? undefined : handleOpenToSide}
                      openMenuPath={openMenuPath}
                      setOpenMenuPath={setOpenMenuPath}
                      fileMenuRef={fileMenuRef}
                      onCopyFileLink={handleCopyFileLink}
                      buildFileUrl={buildFileUrl}
                      onDownloadFile={downloadFile}
                      onDownloadFolder={downloadFolder}
                      onDownloadWorkspace={isLocalWorkspace ? undefined : downloadWorkspaceZip}
                      onNewChatInFolder={startChatInFolder}
                      onFocusedFolderChange={setFocusedSidebarFolder}
                      onAddContextFolder={
                        isLocalWorkspace && isDesktopApp ? handleAddContextFolder : undefined
                      }
                      localRoots={isLocalWorkspace ? localRoots : undefined}
                      onRemoveRootFolder={isLocalWorkspace ? handleRemoveRootFolder : undefined}
                      onDeletePaths={deletePaths}
                      onUndoDelete={restoreLastDeletedPaths}
                      canUndoDelete={hasDeletedHistory}
                      onDuplicatePath={duplicatePath}
                      expandedFolders={expandedFolders}
                      onFileDragStart={handleFileDragStart}
                      findRepoForPath={findLinkedRepoForPath}
                      onShareEntry={
                        isLocalWorkspace
                          ? (path, kind) => setLocalShareScope({ kind: kind === 'folder' ? 'folder' : 'file', path })
                          : // SEAM: per-path cloud share modals land in a separate
                            // in-flight PR — until then a cloud entry's share
                            // affordance opens the workspace-level share modal.
                            canShowShareControls
                            ? () => openShare()
                            : undefined
                      }
                      sharedScopePaths={isLocalWorkspace ? localSharedScopePaths : undefined}
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
                    openCenterPanel('chat');
                    void startAssistantChat(null, null, { forceNew: true, keepMode: true });
                  }}
                  onConnectLocalAgent={isLocalWorkspace ? undefined : () => void openLocalAgentModal()}
                  canStartChat={canWrite}
                  /* Tasks (scheduled chats) hidden from the UI for now — re-enable later.
                  tasksPanel={
                    projectId ? (
                      <TasksRail
                        projectId={projectId}
                        collapsed={isSectionCollapsed(sidebarSections, 'tasks')}
                        onToggleCollapsed={() => toggleSidebarSectionCollapsed('tasks')}
                        chatId={currentChatId && !isDraftChatId(currentChatId) ? currentChatId : null}
                        onOpenChat={(chatId) => {
                          setSidebarSections((prev) => expandSection(prev, 'chats'));
                          void openChatById(chatId, { sidePanel: true });
                        }}
                      />
                    ) : undefined
                  } */
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
            {/* linkedRepos guard: if the repo is unlinked while a commit is
                selected, the sidebar falls back to the Files tab — the stale
                diff viewer must drop with it. */}
            {selectedCommit && linkedRepos.length > 0 && openLeftRail === 'project' && !isSectionCollapsed(sidebarSections, 'sync') ? (
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
                    stable. */}
                {!isMobile ? (
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
                        className={`flex shrink-0 items-center gap-1.5 border-b border-stone-200/60 bg-stone-100/70 pr-1 ${isDesktopApp ? 'pl-[72px]' : 'pl-2'}`}
                        data-testid="topbar-left"
                        {...(isDesktopApp ? { 'data-tauri-drag-region': '' } : {})}
                      >
                        {shellNavControls}
                      </div>
                    ) : null}
                    {desktopTabs ? (
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
                      trailing={newTabLauncher}
                    />
                    ) : (
                      // Web (browser) shell: NO tabs — the browser has its own
                      // tab row. The bar keeps the shell controls and carries
                      // the open file's name (rename included); rail clicks
                      // replace the displayed file/chat instead of stacking.
                      <div
                        data-testid="topbar-web-bar"
                        className="flex h-11 min-w-0 flex-1 items-center border-b border-stone-200/60 bg-stone-100/70 px-2.5"
                      >
                        {primaryChatActive ? null : docFileNameControl}
                      </div>
                    )}
                  </div>
                ) : null}
                <div className="relative flex min-h-0 flex-1 flex-col print:static">
                {/* An active chat tab claims the pane: the chat surface renders
                    where the doc chrome would (the wireframe's chats-as-tabs). */}
                {primaryChatActive ? renderChatSurface(editorPanes.length === 1) : (<>
                {/* Per-document controls live at the pane's top-right now
                    (mode picker, links, raw + toolbar toggles) — they apply to
                    this pane's file. */}
                {!isMobile && activeWorkspaceFile ? (
                  <div
                    data-testid="topbar-doc-controls"
                    className="flex shrink-0 items-center justify-end gap-1 px-2 pt-1 print:hidden"
                  >
                    {docFileControls}
                    {activeIsMarkdown ? (
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
                  </div>
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
                {!menusHidden && !mobileToolbarCollapsed && activeWorkspaceFile && isMarkdownFile(activeWorkspaceFile) ? (
                  <div
                    data-testid="doc-menu-row"
                    className="shrink-0 border-b border-stone-200/60 bg-stone-50"
                  >
                    <MarkdownMenuBar
                      editor={markdownEditor}
                      readOnly={documentEditorReadOnly || !canWrite}
                      file={activeWorkspaceFile}
                      projectId={projectId}
                      sidebarOpen={openLeftRail !== null}
                      onNewFile={handleCreateFile}
                      onRename={() =>
                        // Web (no-tabs) shell: the rename input lives in the
                        // bar's file-name control ('header'), not a tab.
                        beginRename(activeWorkspaceFile.path, isMobile || !desktopTabs ? 'header' : 'tab', {
                          fileId: activeWorkspaceFile.id,
                          ...(isMobile || !desktopTabs ? {} : { paneId: PRIMARY_PANE_ID }),
                        })
                      }
                      onDuplicate={() => void duplicateFile(activeWorkspaceFile)}
                      onDelete={() => void deletePath(activeWorkspaceFile.path)}
                      onToggleSidebar={() => toggleLeftRail('project')}
                    />
                  </div>
                ) : null}
                {(isMobile ? !mobileToolbarCollapsed : showFormatToolbar) && activeWorkspaceFile && isMarkdownFile(activeWorkspaceFile) ? (
                  <div ref={toolbarRowCallbackRef} className="px-3 py-2 shrink-0">
                    <div className="flex items-stretch rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.05)]">
                      <div className="min-w-0 flex-1">
                        {/* Keep the row mounted (reserving the toolbar's height)
                            while the editor instance is briefly null on a
                            markdown→markdown switch, so the chrome never
                            collapses and the frame doesn't flicker/jump. */}
                        {toolbarEditor ? (
                          <MarkdownToolbar
                            editor={toolbarEditor}
                            // Commenters: formatting/structural commands can't
                            // be staged as suggestion marks — keep them
                            // disabled, not silently applying untracked edits.
                            readOnly={documentEditorReadOnly || !canWrite}
                            containerWidth={toolbarRowWidth}
                            zoom={editorZoom}
                            onZoomChange={setEditorZoom}
                            lineHeight={editorLineHeight}
                            onLineHeightChange={setEditorLineHeight}
                            pageChrome={editorPageChrome}
                            onPageChromeChange={setEditorPageChrome}
                          />
                        ) : (
                          <div className="h-10" aria-hidden />
                        )}
                      </div>
                      <button
                        type="button"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          setMenusHidden((v) => !v);
                        }}
                        aria-label={menusHidden ? 'Show menus' : 'Hide menus'}
                        aria-pressed={menusHidden}
                        className="relative group/tip inline-flex h-7 w-7 shrink-0 items-center justify-center self-center rounded px-1.5 mr-2 text-stone-600 transition-colors hover:bg-stone-200/60 hover:text-stone-900 cursor-pointer"
                      >
                        {menusHidden ? (
                          <CaretDownIcon className="h-4 w-4" weight="regular" aria-hidden />
                        ) : (
                          <CaretUpIcon className="h-4 w-4" weight="regular" aria-hidden />
                        )}
                        <IconTooltip label={menusHidden ? 'Show menus' : 'Hide menus'} />
                      </button>
                    </div>
                  </div>
                ) : null}
                {!mobileToolbarCollapsed && activeTexFile && activeWorkspaceFile ? (
                  <div ref={toolbarRowCallbackRef} className="px-3 py-2 shrink-0">
                    <LatexEditorToolbar
                      {...latexEditorRefHandlers(textEditorRef)}
                      readOnly={documentEditorReadOnly}
                      viewMode={latexViewMode}
                      onViewModeChange={handleLatexViewModeChange}
                      compile={latexCompile}
                      canCompile={canWrite}
                      mainDocument={latexMainDocument}
                      containerWidth={toolbarRowWidth}
                      onFix={handleLatexFix}
                      canFix={canLatexFix}
                      fixInFlight={fixInFlight}
                      // Error lines map to the compiled root; only let them jump
                      // the editor when the open file *is* that root (W1.root §3.3).
                      onNavigateToLine={
                        activeIsRoot ? (line) => textEditorRef.current?.revealLine?.(line) : undefined
                      }
                    />
                  </div>
                ) : null}
                <div
                  ref={docEditorBodyRef}
                  data-testid="doc-editor-body"
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
                            {binaryPreviewStatus !== 'loading' && pdfPreviewUrl && (
                              <div className="overflow-hidden rounded-2xl bg-white">
                                <iframe
                                  title={formatFileName(getFileName(activePreviewFile.path))}
                                  src={pdfPreviewUrl}
                                  className="block h-[calc(100vh-6.5rem)] min-h-[520px] w-full bg-white"
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
                          className={`flex h-full min-h-0 ${reserveCommentLane ? 'gap-3' : ''}`}
                        >
                        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
                          <div className="min-h-0 flex-1">
                            <LatexWorkbench
                              isMobile={isMobile}
                              viewMode={latexViewMode}
                              onViewModeChange={handleLatexViewModeChange}
                              editor={(
                                <CollabCodeEditor
                                  key={activeWorkspaceFile.id}
                                  fileId={activeWorkspaceFile.id}
                                  filePath={activeWorkspaceFile.path}
                                  collabPath={activeCollabPath}
                                  workspaceId={projectId}
                                  user={collabUser}
                                  readOnly={documentEditorReadOnly}
                                  canResolveSuggestions={canWrite}
                                  editMode={effectiveDocEditMode === 'suggest' ? 'suggest' : 'edit'}
                                  bare
                                  onImageUpload={handleLatexImageUpload}
                                  onReady={handleCodeEditorReady}
                                  onContentChange={handleViewerContentChange}
                                  onConnectionStatusChange={setCollabStatus}
                                  pendingAdditions={spacePendingAdditions}
                                  onKeepAddition={handleSpaceKeepAddition}
                                  onUndoAddition={handleSpaceUndoAddition}
                                  onJumpToTurn={handleJumpToTurn}
                                  {...codeCommentProps}
                                />
                              )}
                              preview={(
                                <LatexPdfPane
                                  key={`${activeWorkspaceFile.path}:latex-pane`}
                                  texPath={activeWorkspaceFile.path}
                                  pdfUrl={latexCompile.pdfUrl}
                                  synctex={synctexIndex}
                                  onInverseSearch={handleSynctexInverse}
                                />
                              )}
                            />
                          </div>
                          <CompileSummaryBar
                            compileError={latexCompile.compileError}
                            errorLines={latexCompile.errorLines}
                            logText={latexCompile.logText}
                            stale={latexCompile.stale}
                            lastCompiledAt={latexCompile.lastCompiledAt}
                            compiling={latexCompile.compiling}
                            canFix={canLatexFix}
                            onFix={handleLatexFix}
                            fixInFlight={fixInFlight}
                            // Error lines map to the compiled root; only jump the
                            // editor when the open file *is* that root (W1.root §3.3).
                            onNavigateToLine={
                              activeIsRoot ? (line) => textEditorRef.current?.revealLine?.(line) : undefined
                            }
                          />
                        </div>
                        {commentLaneColumn}
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
                                    onResolveSuggestion={canWrite ? handleCsvResolveSuggestion : undefined}
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
                                user={collabUser}
                                readOnly={documentEditorReadOnly}
                                canResolveSuggestions={canWrite}
                                editMode={effectiveDocEditMode === 'suggest' ? 'suggest' : 'edit'}
                                hidden={hasRichViewer && showRichViewer}
                                onReady={handleCodeEditorReady}
                                onContentChange={handleViewerContentChange}
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
                                showMenuBar={false}
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
                                <CollabEditor
                                  key={activeWorkspaceFile.id}
                                  fileId={activeWorkspaceFile.id}
                                  filePath={activeWorkspaceFile.path}
                                  collabPath={activeCollabPath}
                                  workspaceId={projectId}
                                  user={collabUser}
                                  readOnly={documentEditorReadOnly}
                                  canResolveSuggestions={canWrite}
                                  forceSuggesting={!canWrite}
                                  codeMode={hasRichViewer}
                                  hidden={showRawView || (hasRichViewer && showRichViewer)}
                                  onReady={handleEditorReady}
                                  onContentChange={hasRichViewer && showRichViewer ? handleViewerContentChange : undefined}
                                  onConnectionStatusChange={setCollabStatus}
                                  pendingAdditions={spacePendingAdditions}
                                  onKeepAddition={handleSpaceKeepAddition}
                                  onUndoAddition={handleSpaceUndoAddition}
                                  onJumpToTurn={handleJumpToTurn}
                                  onNavigateToFile={(file) => {
                                    if (file) {
                                      setSelectedFilePath(file);
                                      if (!isMobile) setOpenLeftRail('project');
                                    }
                                  }}
                                  wikiLinkSuggestions={wikiLinkSuggestions}
                                  commentRanges={resolvedCommentRanges}
                                  draftCommentRange={draftCommentRange}
                                  activeCommentThreadId={activeCommentThreadId}
                                  onSelectComment={selectCommentThread}
                                  onImageDrop={handleEditorImageDrop}
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
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-3 h-full text-stone-400">
                      <SunnyAnimation name="shrug" className="w-28 opacity-90" />
                      <p>Nothing open. Pick a file or chat from the sidebar.</p>
                    </div>
                  )}
                </div>
                {/* Status pill: quiet file facts anchored to THIS doc pane's
                    bottom-right (never window-fixed, so it can't overlay
                    chats, empty states, or other panes). Primary pane, real
                    file documents only — no folders/binaries. */}
                {!isMobile &&
                activeWorkspaceFile &&
                activeWorkspaceFile.type !== 'folder' &&
                activeWorkspaceFile.type !== 'proposal' &&
                !isBinaryFile(activeWorkspaceFile) ? (
                  <div
                    data-testid="status-pill"
                    className="absolute bottom-2 right-3 z-20 flex items-center gap-1 rounded-md border border-stone-200 bg-white/95 px-2.5 py-1 text-[11px] text-stone-500 shadow-sm print:hidden"
                  >
                    {docStats ? (
                      <span>
                        {docStats.words.toLocaleString()} words · {docStats.chars.toLocaleString()} characters ·{' '}
                      </span>
                    ) : null}
                    <span>
                      {(() => {
                        const raw = activeWorkspaceFile.updated_at ?? activeWorkspaceFile.created_at;
                        if (!raw) return 'Edited recently';
                        return `Edited ${new Date(raw).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
                      })()}
                    </span>
                    {isLocalWorkspace ? (
                      localSharedScopePaths.has('') ||
                      localSharedScopePaths.has(activeWorkspaceFile.path) ||
                      [...localSharedScopePaths].some(
                        (scope) => scope !== '' && activeWorkspaceFile.path.startsWith(`${scope}/`),
                      ) ? (
                        <button type="button" onClick={openShare} className="underline hover:text-stone-700">
                          · Shared
                        </button>
                      ) : (
                        // Founder: unshared local files just say "Local" — no
                        // privacy sentence.
                        <span>· Local</span>
                      )
                    ) : canShowShareControls && shareStatus !== 'private' ? (
                      <button type="button" onClick={openShare} className="underline hover:text-stone-700">
                        · Shared
                      </button>
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
                    return (
                      <div
                        key={paneEntry.id}
                        data-testid="editor-pane-secondary"
                        className="relative flex min-w-0 flex-1 flex-col overflow-hidden border-l border-stone-200 print:hidden"
                        style={{ flexGrow: paneGrow[paneEntry.id] ?? 1 }}
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
                        {desktopTabs ? (
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
                        />
                        ) : (
                          // Web shell: no strip — the chat pane's own header
                          // (title + close ×) is the surface's chrome; this
                          // empty segment keeps the one-bar line continuous.
                          <div
                            aria-hidden
                            className="h-11 min-w-0 flex-1 border-b border-stone-200/60 bg-stone-100/70"
                          />
                        )}
                        </div>
                        <div className="relative flex min-h-0 flex-1 flex-col">
                          {isChatTab(paneEntry.active) ? renderChatSurface(false) : (
                          <SplitEditorPaneReviewBody
                            file={paneFile}
                            collabPath={paneCollabPath}
                            isMarkdown={isMarkdownFile(paneFile)}
                            isBinary={isBinaryFile(paneFile)}
                            workspaceId={projectId}
                            user={collabUser}
                            // Viewing locks every split pane: unlike the
                            // primary, a split has no per-pane mode picker to
                            // surface a view→edit coercion, so an editable
                            // code pane under a "Viewing" workspace would be
                            // silent. Suggesting stages code edits as usual.
                            readOnly={documentReadOnly || documentEditMode === 'view'}
                            // Commenters are pinned to suggest synchronously —
                            // never let a pre-pin render mount direct-edit.
                            editMode={!canWrite || documentEditMode === 'suggest' ? 'suggest' : 'edit'}
                            // Commenters may propose but never resolve — the
                            // same gates the primary editors apply.
                            canResolveSuggestions={canWrite}
                            forceSuggesting={!canWrite}
                            // Each split fetches its own pending turns, so
                            // Sunny's diffs stay reviewable in a pane showing
                            // a file other than the page's selection.
                            reviewWorkspaceId={cloudProjectId}
                            reviewInvalidationToken={pendingEditsInvalidationToken}
                            resolveAuthorLabel={resolvePendingEditAuthorLabel}
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
                  style={{ width: reviewPanelWidth }}
                  // max-lg:flex-1 gives it flex-basis 0, so the resized px width
                  // is ignored below lg and the flex-[2] editor keeps priority.
                  className="order-3 relative flex min-h-0 min-w-[320px] max-lg:min-w-0 max-lg:flex-1 flex-col overflow-hidden bg-stone-50 border-l border-stone-200"
                >
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
                      <ListIcon className="h-5 w-5" weight={rightDockView === 'outline' ? 'bold' : 'regular'} aria-hidden />
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
                    {standaloneDiffHref && isSpaceMode && selectedFilePath ? (
                      <Link
                        href={standaloneDiffHref}
                        className="ml-auto inline-flex h-7 shrink-0 items-center rounded-full border border-stone-200 px-2.5 text-[11px] font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-800"
                      >
                        Review
                      </Link>
                    ) : null}
                  </div>
                  {rightDockView === 'outline' ? (
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
              {chatColumnVisible ? (
                <div className="order-3 relative flex min-h-0 flex-1 flex-col bg-stone-50">
                  {renderChatSurface(true)}
                </div>
              ) : null}
              </div>
            )}
            </div>
            {/* Pinned top-right cluster — absolute against this content row so
                it survives splits, the right dock, and the commit diff view. */}
            {!isMobile ? topBarRightControls : null}
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

      <AddRepoModal
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
      />
      <AddOverleafModal
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
          .map((r) => ({ id: r.id, label: r.repoLabel }))}
        onOpenSync={openSyncSection}
      />
      <LinkTextChatModal
        open={Boolean(linkTextChatId)}
        chatId={linkTextChatId}
        chatLabel={chatEntries.find((entry) => entry.chat.id === linkTextChatId)?.chat.title ?? null}
        onClose={() => setLinkTextChatId(null)}
      />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        files={reviewFiles}
        priorityFiles={paletteOpenFiles}
        onOpenFile={(path) => {
          const file = workspaceFileByPath.get(path);
          if (!file || file.type === 'folder') return;
          setSidebarSections((prev) => expandSection(prev, 'files'));
          handleFileClick(file);
        }}
        actions={paletteActions}
      />

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
              Workspace
            </div>
            {renderContextTabButton('workspace', 'Workspace', <WorkspaceInstructionsIcon />)}
            {canAccessSecrets === true && renderContextTabButton('secrets', 'Secrets', <WorkspaceSecretsIcon />)}
          </div>
          <div className="space-y-0.5">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
              User
            </div>
            {renderContextTabButton('preferences', 'Preferences', <WorkspacePreferencesIcon />)}
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
          </div>
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

          {settingsTab === 'preferences' && renderPreferencesPanel('desktop')}

          {settingsTab === 'billing' && (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <BillingSection />
            </div>
          )}

          {settingsTab === 'github' && !isLocalWorkspace && <UserGitHubTab />}

          {settingsTab === 'overleaf' && !isLocalWorkspace && <UserOverleafTab />}

          {settingsTab === 'apikeys' && <UserApiKeysTab />}

          {settingsTab === 'chatApps' && !isLocalWorkspace && <HostedConnectorTab />}
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
      {isMobile && mobilePanel === 'chats' && (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
          <div className="h-12 px-4 flex items-center justify-between border-b border-stone-100 shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-stone-800">Chats</span>
            </div>
            <div className="flex items-center gap-1">
              {canWrite && (
                <button
                  type="button"
                  onClick={guideAssistantPickerFromSidebar}
                  aria-label="New chat"
                  data-testid="new-chat-button"
                  className="relative group/tip p-2 rounded-lg hover:bg-stone-100 text-stone-500"
                >
                  <PlusIcon className="w-5 h-5" weight="bold" aria-hidden />
                  <IconTooltip label="New chat" />
                </button>
              )}
              <button onClick={() => setMobilePanel(null)} aria-label="Close" className="p-2 -mr-1 rounded-lg hover:bg-stone-100 text-stone-400">
                <XIcon className="w-5 h-5" weight="bold" aria-hidden />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto px-2.5 py-2.5 space-y-1">
            {renderChatRail('mobile')}
          </div>
        </div>
      )}

      {isMobile && mobilePanel === 'files' && (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
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
                  className="flex min-w-0 items-center gap-1 rounded-lg text-left"
                  title={projectTitle}
                >
                  <span className="truncate text-sm font-semibold text-stone-800">{projectTitle}</span>
                  <CaretDownIcon
                    className={`w-3 h-3 shrink-0 text-stone-400 transition-transform ${showWorkspaceSwitcher ? 'rotate-180' : ''}`}
                    weight="bold"
                    aria-hidden
                  />
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
            </div>
          </div>
        </div>
      )}

      {isMobile && showReviewPanel && deepLinkedDiffId ? (
        <div data-testid="mobile-diff-review" className="fixed inset-0 z-50 flex flex-col bg-white">
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
                    Sunny #{chatDetailsEntry.chat.sunny_number}
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
          onClose={() => setLocalShareScope(null)}
          onShared={() => {
            void refreshLocalShares();
            void reloadFiles(false);
          }}
        />
      ) : null}

      <WorkspaceShareModal
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
      />

      {/* Chat share — the full GDocs modal against the workspace ACL (chats
          inherit it): people, chat-targeted workspace invites, and the
          workspace's general access, which gates whether the chat link opens.
          Local chats never open this — openChatShare routes them to the local
          share modal. */}
      <WorkspaceShareModal
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
      />

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

      <WorkspaceNoticeToast notice={workspaceAppNotice} onClose={clearWorkspaceAppNotice} />

    </div>
    </ApiFetchProvider>
  );
}
