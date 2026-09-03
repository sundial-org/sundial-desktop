'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
// LinkIcon used by the Apps (Composio connectors) button, hidden for now — re-enable later.
import { CaretDownIcon, CaretLeftIcon, CpuIcon, FileIcon, FolderIcon, PaperclipIcon, PlusIcon, QuotesIcon, XIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { Spinner } from '@/components/ui/spinner';
import { ChatAppsPicker } from './chat-apps-picker';
import { getProviderIcon } from '@/components/workspace/provider-icons';
import type { ConnectedAppSummary } from '@/lib/composio/types';
import { formatBytes } from '@/lib/workspace/uploads';
import type { PendingUpload } from '@/components/workspace/use-workspace-uploads';
import {
  buildChatRuntimePicker,
  getChatModelLabel,
  modelsForHarness,
  CHAT_HARNESSES,
  CHAT_HARNESS_LABELS,
  CHAT_HARNESS_HINTS,
  type ChatHarness,
  type ChatRuntimePickerOption,
  type ModelPickerOption,
} from '@/lib/workspace/chat-runtime';
import {
  FilePickerPopover,
  formatRelativeUpdatedAt,
  rankFilePaths,
  type FilePickerItem,
} from '@/components/workspace/file-picker-popover';
import { EditModeControl } from '@/components/workspace/edit-mode-control';
import { CHAT_EDIT_MODES, type WorkspaceEditMode } from '@/lib/workspace/edit-mode';
import {
  contextFilesFromWikiText,
  detectFileMention,
  extractWikiLinkTargets,
  formatWikiLink,
  resolveWikiTargetToPath,
  type FileMentionMatch,
} from '@/lib/workspace/wiki-file-links';
import { formatFileName, getFileName, getFolderPath } from './workspace-file-helpers';

type MentionableFile = {
  path: string;
  updatedAt: string | null;
};

type SendTrigger = 'enter' | 'button';
type MessageAttachment = {
  id: string;
  path: string;
  name?: string | null;
  mime?: string | null;
  size?: number | null;
  type?: 'text' | 'binary';
  signedUrl?: string | null;
  storagePath?: string | null;
};
type ContextSnippet = {
  id: string;
  text: string;
  path: string | null;
};

type ChatComposerProps = {
  chatId: string | null;
  showGroupChatUi: boolean;
  hasAssistant: boolean;
  /** Non-null disables the whole composer with this message as the
      placeholder (e.g. path-share guests: Sunny has no per-path rails yet). */
  disabledNotice?: string | null;
  initialValue: string;
  textareaRef: MutableRefObject<HTMLElement | null>;
  shouldFocus: boolean;
  onFocusHandled: () => void;
  onDraftChange: (chatId: string, value: string) => void;
  onAction: (sendTrigger: SendTrigger, content: string) => void;
  attachments: MessageAttachment[];
  onRemoveAttachment: (attachment: MessageAttachment) => void;
  contextSnippets: ContextSnippet[];
  onRemoveContextSnippet: (snippetId: string) => void;
  uploads: PendingUpload[];
  onRemoveUpload: (uploadId: string) => void;
  onAttachFiles: (files: File[]) => void;
  // Open a file in the editor — used by wiki-link chips typed into the composer.
  onOpenEditedFile: (path: string) => void;
  // The file currently open in the editor. Already sent to the agent as
  // context (path + metadata) — surfaced here as a display-only indicator so
  // the user can see it's in context. Not removable, and does not change what
  // is sent. Null when no file is open (e.g. chat-only mode).
  openFilePath: string | null;
  mentionableFiles: MentionableFile[];
  connectedApps: ConnectedAppSummary[];
  connectedAppsLoading: boolean;
  showAppsPicker: boolean;
  setShowAppsPicker: (value: boolean) => void;
  appsPickerRef: MutableRefObject<HTMLDivElement | null>;
  currentChatId: string | null;
  reloadConnectedApps: () => Promise<void> | void;
  showModelPicker: boolean;
  setShowModelPicker: (value: boolean) => void;
  currentChatModel: string;
  // Signed-out sender with free anonymous runs left: sends execute on the
  // pinned cheap model regardless of the picker, so the menu says so.
  anonModelPinned?: boolean;
  onSelectChatRuntime: (option: ChatRuntimePickerOption) => void;
  modelPickerRef: MutableRefObject<HTMLDivElement | null>;
  // Which agent runtime (harness) runs this chat, picked via the tabs at the
  // top of the model menu; the model list is filtered to the harness's provider.
  harness: ChatHarness;
  onSelectHarness: (harness: ChatHarness) => void;
  // Local workspaces: the Claude/Codex rows run the user's OWN installed
  // agents on this machine (subscription auth); the Sundial Agent row is
  // the cloud agent. null = cloud workspace (cloud semantics).
  localEngines?: {
    claude: { available: boolean; loggedIn: boolean };
    codex: { available: boolean; loggedIn: boolean };
  } | null;
  // Cloud workspaces: the signed-in payer's credential per engine, so the
  // Claude Code / Codex rows can say whose account a turn runs on and prompt
  // the connect flow (mirror of the desktop rows' localEngines status).
  // null = local workspace or signed out (rows keep their generic hints).
  cloudEngineAuth?: { claude: 'subscription' | 'api-key' | null; openai: 'api-key' | null } | null;
  /** Opens Settings → API keys (the connect/BYOK panel) from a row's prompt. */
  onConnectEngine?: () => void;
  // Local chats lock their engine once the conversation has messages —
  // switch engines by starting a new chat.
  harnessLocked?: boolean;
  /** Starts a fresh chat already set to that agent. Given, a locked row stops
   *  being a dead end: it offers the new chat in place instead of silently
   *  refusing the click. Omitted (or absent) leaves the row explanatory only. */
  onNewChatWithHarness?: (harness: ChatHarness) => void;
  models: ModelPickerOption[];
  modelsLoading: boolean;
  modelsEmptyReason: string | null;
  isVoiceSupported: boolean;
  isVoiceListening: boolean;
  toggleVoice: () => void;
  isChatInterruptible: boolean;
  chatUploadsInFlight: boolean;
  sendActionTitle: string;
  editMode: WorkspaceEditMode;
  onEditModeChange: (mode: WorkspaceEditMode) => void;
  // Folder this chat was started from (chats.folder_scope). Display-only —
  // null/empty for whole-workspace chats, which show no chip.
  folderScope?: string | null;
  // Path whose new doc comments are fed to this chat (chats.comment_watch_path);
  // '*' = whole workspace, null = not listening (no chip).
  commentWatchPath?: string | null;
  onClearCommentWatch?: () => void;
  /** Runs a `/watch`-family command instead of sending it ('*' = whole
   *  workspace, null = stop). Omitted for draft chats — with no server row to
   *  PATCH the commands stay un-intercepted (and unadvertised) rather than
   *  swallowing the message. */
  onCommentWatchCommand?: (path: string | null) => void;
};

// The composer's only slash commands. Matched on the WHOLE trimmed message, so
// a mid-message slash or `/watchx` is ordinary text and still reaches the agent.
const SLASH_COMMANDS = [
  { command: '/watch', action: 'doc', hint: 'agent reads new comments on the open doc' },
  { command: '/watch all', action: 'all', hint: 'agent reads new comments anywhere in this workspace' },
  { command: '/unwatch', action: 'off', hint: 'stop listening to comments' },
] as const;

type WatchAction = (typeof SLASH_COMMANDS)[number]['action'];

/** Normalized draft text, so `  /Watch   all ` matches (and completes) too. */
function slashText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseWatchCommand(value: string): WatchAction | null {
  const text = slashText(value);
  return SLASH_COMMANDS.find((entry) => entry.command === text)?.action ?? null;
}

const WIKI_LINK_RE = /\[\[([^\]\n]+)\]\]/g;

function splitWikiTarget(raw: string): { target: string; label: string } {
  const [target = '', alias] = raw.split('|');
  const trimmedTarget = target.trim();
  return {
    target: trimmedTarget,
    label: alias?.trim() || trimmedTarget.split('/').pop() || trimmedTarget,
  };
}

function makeWikiNode(path: string, label = getFileName(path), rawTarget?: string): HTMLElement {
  const node = document.createElement('span');
  node.dataset.wikiPath = path;
  // A fragment-carrying target ([[note#Heading]]) resolves to the note for
  // the chip, but serialization must re-emit the original target — otherwise
  // a restored draft silently loses its #fragment.
  if (rawTarget && rawTarget !== path && rawTarget.includes('#')) {
    node.dataset.wikiTarget = rawTarget;
  }
  node.contentEditable = 'false';
  node.className = 'wiki-file-link inline';
  node.title = path;
  node.textContent = label;
  return node;
}

export function renderComposerValue(root: HTMLElement, value: string, knownPaths: string[]) {
  root.replaceChildren();
  let lastIndex = 0;
  for (const match of value.matchAll(WIKI_LINK_RE)) {
    const full = match[0] ?? '';
    const raw = match[1] ?? '';
    const index = match.index ?? 0;
    if (index > lastIndex) root.append(document.createTextNode(value.slice(lastIndex, index)));
    const { target, label } = splitWikiTarget(raw);
    const path = resolveWikiTargetToPath(target, knownPaths) ?? target;
    root.append(makeWikiNode(path, label, target));
    lastIndex = index + full.length;
  }
  if (lastIndex < value.length) root.append(document.createTextNode(value.slice(lastIndex)));
  ensureEditableLine(root);
}

/** WebKit paints no caret in an EMPTY contenteditable — there is no line box to
 *  anchor it to — so a fresh or cleared composer showed no cursor in the desktop
 *  WKWebView until the first character was typed. Keep the standard
 *  contenteditable filler (`<br>`) in an empty editor so a caret line always
 *  exists; `serializeComposerValue` treats one trailing root-level `<br>` as
 *  that invisible filler, per the same convention browsers use. */
export function ensureEditableLine(root: HTMLElement) {
  if (!root.hasChildNodes()) root.append(root.ownerDocument.createElement('br'));
}

function isFillerOnly(root: HTMLElement): boolean {
  return (
    root.childNodes.length === 1 &&
    root.firstChild instanceof HTMLElement &&
    root.firstChild.tagName === 'BR'
  );
}

export function serializeComposerValue(
  root: HTMLElement,
  // The whole-composer read treats one trailing root-level <br> as the caret
  // filler (see ensureEditableLine). Cloned RANGE fragments must keep theirs —
  // a prefix like `abc<br>` legitimately ends in a line break.
  { stripTrailingFiller = true } = {},
): string {
  // contentEditable represents newlines as block elements (<div>/<p>) and <br>,
  // not literal "\n". Reading textContent alone glues every line together — which
  // turned multi-line messages into a single line (e.g. a leading `## ` heading
  // then swallowed the whole message). Walk the tree and re-emit line breaks.
  let out = '';
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent ?? '';
        return;
      }
      if (!(child instanceof HTMLElement)) return;
      if (child.dataset.wikiPath) {
        out += formatWikiLink(child.dataset.wikiTarget ?? child.dataset.wikiPath);
        return;
      }
      if (child.tagName === 'BR') {
        out += '\n';
        return;
      }
      // Block children start a new visual line; prefix a newline unless we're at
      // the very start or already on a fresh line.
      if (
        (child.tagName === 'DIV' || child.tagName === 'P') &&
        out !== '' &&
        !out.endsWith('\n')
      ) {
        out += '\n';
      }
      walk(child);
    });
  };
  walk(root);
  // One trailing root-level <br> is the invisible caret filler (see
  // ensureEditableLine), not content — browsers keep it after "abc<br>" and in
  // an empty editor, and pressing Shift+Enter at the end inserts TWO <br>s.
  const last = root.lastChild;
  if (
    stripTrailingFiller &&
    last instanceof HTMLElement &&
    last.tagName === 'BR' &&
    out.endsWith('\n')
  ) {
    out = out.slice(0, -1);
  }
  return out;
}

export function insertPlainTextIntoComposer(root: HTMLElement, text: string) {
  const doc = root.ownerDocument;
  // Drop the caret filler before inserting — text must not land after it (a
  // leading phantom newline). Removing it snaps any range inside to (root, 0).
  if (isFillerOnly(root)) root.replaceChildren();
  const selection = doc.getSelection();
  let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const ownsSelection = range && root.contains(range.commonAncestorContainer);

  if (!range || !ownsSelection) {
    range = doc.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
  }

  if (!range.collapsed) {
    const selectedText = serializeRange(root, range);
    if (selectedText.includes('\n') || startsAtComposerLineBoundary(root, range)) {
      const beforeRange = doc.createRange();
      beforeRange.setStart(root, 0);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      const before = serializeRange(root, beforeRange);

      const afterRange = doc.createRange();
      afterRange.setStart(range.endContainer, range.endOffset);
      afterRange.setEnd(root, root.childNodes.length);
      // The suffix runs to the end of the draft, so its trailing <br> is the
      // whole-draft caret filler — strip it like a whole-composer read would.
      const after = serializeRange(root, afterRange, { stripTrailingFiller: true });

      const nextValue = before + text + after;
      const node = doc.createTextNode(nextValue);
      root.replaceChildren(node);

      range = doc.createRange();
      range.setStart(node, before.length + text.length);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
  }

  range = moveCollapsedLineBoundaryIntoBlock(root, range);
  range.deleteContents();
  const node = doc.createTextNode(text);
  range.insertNode(node);
  range.setStart(node, text.length);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

// Fragments keep trailing <br>s by default (a prefix like `abc<br>` ends in a
// REAL line break). A suffix fragment that runs to the end of the draft shares
// the whole-draft convention instead — its trailing <br> IS the caret filler —
// so those callers pass stripTrailingFiller: true.
function serializeRange(
  root: HTMLElement,
  range: Range,
  opts: { stripTrailingFiller?: boolean } = { stripTrailingFiller: false },
): string {
  const wrapper = root.ownerDocument.createElement('div');
  wrapper.append(range.cloneContents());
  return serializeComposerValue(wrapper, opts);
}

function startsAtComposerLineBoundary(root: HTMLElement, range: Range): boolean {
  if (range.startContainer === root) {
    return isComposerLineBoundaryNode(root.childNodes[range.startOffset] ?? null);
  }
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;
  if (range.startOffset !== (range.startContainer.textContent ?? '').length) return false;
  const topLevel = directChildOf(root, range.startContainer);
  return isComposerLineBoundaryNode(topLevel?.nextSibling ?? null);
}

function directChildOf(root: HTMLElement, node: Node): Node | null {
  let current: Node | null = node;
  while (current?.parentNode && current.parentNode !== root) current = current.parentNode;
  return current?.parentNode === root ? current : null;
}

function isComposerLineBoundaryNode(node: Node | null): boolean {
  return node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P' || node.tagName === 'BR');
}

function moveCollapsedLineBoundaryIntoBlock(root: HTMLElement, range: Range): Range {
  if (!range.collapsed) return range;
  const target = blockAfterRangeStart(root, range);
  if (!target) return range;
  const nextRange = root.ownerDocument.createRange();
  nextRange.selectNodeContents(target);
  nextRange.collapse(true);
  return nextRange;
}

function blockAfterRangeStart(root: HTMLElement, range: Range): HTMLElement | null {
  let next: Node | null = null;
  if (range.startContainer === root) {
    next = root.childNodes[range.startOffset] ?? null;
  } else if (
    range.startContainer.nodeType === Node.TEXT_NODE &&
    range.startOffset === (range.startContainer.textContent ?? '').length
  ) {
    const topLevel = directChildOf(root, range.startContainer);
    next = topLevel?.nextSibling ?? null;
  }
  return next instanceof HTMLElement && (next.tagName === 'DIV' || next.tagName === 'P') ? next : null;
}

export const ChatComposer = memo(function ChatComposer({
  chatId,
  showGroupChatUi,
  hasAssistant,
  disabledNotice = null,
  initialValue,
  textareaRef: externalTextareaRef,
  shouldFocus,
  onFocusHandled,
  onDraftChange,
  onAction,
  attachments,
  onRemoveAttachment,
  contextSnippets,
  onRemoveContextSnippet,
  uploads,
  onRemoveUpload,
  onAttachFiles,
  onOpenEditedFile,
  openFilePath,
  mentionableFiles,
  connectedApps,
  connectedAppsLoading,
  showAppsPicker,
  setShowAppsPicker,
  appsPickerRef,
  currentChatId,
  reloadConnectedApps,
  showModelPicker,
  setShowModelPicker,
  currentChatModel,
  anonModelPinned = false,
  onSelectChatRuntime,
  modelPickerRef,
  harness,
  onSelectHarness,
  cloudEngineAuth,
  onConnectEngine,
  localEngines = null,
  harnessLocked = false,
  onNewChatWithHarness,
  models,
  modelsLoading,
  modelsEmptyReason,
  isVoiceSupported,
  isVoiceListening,
  toggleVoice,
  isChatInterruptible,
  chatUploadsInFlight,
  sendActionTitle,
  editMode,
  onEditModeChange,
  folderScope = null,
  commentWatchPath = null,
  onClearCommentWatch,
  onCommentWatchCommand,
}: ChatComposerProps) {
  const localTextareaRef = useRef<HTMLDivElement | null>(null);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaShellRef = useRef<HTMLDivElement | null>(null);
  const mentionRangeRef = useRef<Range | null>(null);
  const [inputValue, setInputValue] = useState(initialValue);
  const [fileMention, setFileMention] = useState<FileMentionMatch | null>(null);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const [slashHighlight, setSlashHighlight] = useState(0);
  // Escape dismisses the slash picker for the draft as typed; editing re-opens it.
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
  const [showPlusMenu, setShowPlusMenu] = useState(false);

  const setPlusContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      plusMenuRef.current = node;
      appsPickerRef.current = node;
    },
    [appsPickerRef],
  );

  useEffect(() => {
    if (!showPlusMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPlusMenu]);

  const setTextareaRef = useCallback(
    (node: HTMLDivElement | null) => {
      localTextareaRef.current = node;
      externalTextareaRef.current = node;
      // JSX renders the editor with no children; give the empty editor its
      // caret filler on mount (fresh chat, post-send remount).
      if (node) ensureEditableLine(node);
    },
    [externalTextareaRef],
  );

  const resizeChatInput = useCallback(() => {
    const el = localTextareaRef.current;
    if (!el) return;
    // Grow with the prompt up to ~45% of the viewport, then scroll — a fixed
    // cap felt cramped for large prompts.
    const max = Math.max(160, Math.round(window.innerHeight * 0.45));
    el.style.maxHeight = `${max}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, []);

  const workspaceFilePaths = useMemo(
    () => mentionableFiles.map((file) => file.path),
    [mentionableFiles],
  );
  const workspaceFilePathsRef = useRef(workspaceFilePaths);

  useEffect(() => {
    workspaceFilePathsRef.current = workspaceFilePaths;
  }, [workspaceFilePaths]);

  useEffect(() => {
    resizeChatInput();
  }, [inputValue, resizeChatInput]);

  useEffect(() => {
    window.addEventListener('resize', resizeChatInput);
    return () => window.removeEventListener('resize', resizeChatInput);
  }, [resizeChatInput]);

  useEffect(() => {
    const el = localTextareaRef.current;
    setInputValue(initialValue);
    // Never rewrite the contenteditable DOM while the user is focused in it:
    // `renderComposerValue` calls `replaceChildren`, which collapses the
    // browser selection and snaps the caret to the start. Plain typing keeps
    // this same composer instance mounted (only `onDraftChange`, no version
    // bump), and the live DOM is already the source of truth. Every external
    // fill (voice, fill-composer, send-clear, chat switch) remounts via the
    // composer `key`, so it lands here on a fresh, unfocused mount instead.
    if (
      el &&
      el.ownerDocument.activeElement !== el &&
      serializeComposerValue(el) !== initialValue
    ) {
      renderComposerValue(el, initialValue, workspaceFilePathsRef.current);
    }
  }, [chatId, initialValue]);

  useEffect(() => {
    if (!shouldFocus || !chatId || !hasAssistant) return;
    // A single focus() loses a race on "new chat": the assistant-picker menu
    // closes and restores focus to <body> just after we focus, leaving the
    // composer blurred. Retry until the composer actually HOLDS focus, because
    // the steal lands after we've already focused — the old loop checked focus
    // in the same tick it called focus(), declared success, and stopped.
    //
    // Three rules keep this from becoming a focus fight:
    //  - focus must survive two consecutive ticks before we call it settled;
    //  - we only focus over what was already focused when the chat opened (the
    //    trigger keeps focus in Chrome, and a menu restores focus to it on
    //    close) or over <body> (the picker's steal). Anything ELSE is the user
    //    choosing a new target after the fact — a file in the tree, a toolbar
    //    button — and we stand down immediately rather than yanking the caret
    //    back every 40ms for the rest of the window;
    //  - a missing ref waits on the SAME budget, so a composer that never
    //    mounts can't leave a 40ms timer polling forever with the focus request
    //    unresolved.
    const FOCUS_BUDGET = 25; // ~1s at 40ms, covering a late picker close.
    let attempts = 0;
    let held = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Captured before the first focus() so it is the pre-existing focus, not
    // anything this effect caused.
    const openedFrom = document.activeElement;
    /** A place the user could be typing — never take the caret out of one. */
    const isTextEntry = (node: Element | null) =>
      node instanceof HTMLElement &&
      (node.isContentEditable ||
        node.tagName === 'INPUT' ||
        node.tagName === 'TEXTAREA' ||
        node.tagName === 'SELECT');
    /** Focus we may take: the opening trigger, or nothing focused at all. */
    const isOurs = (node: Element | null) =>
      !isTextEntry(node) && (!node || node === document.body || node === openedFrom);
    const spend = () => {
      attempts += 1;
      return attempts >= FOCUS_BUDGET;
    };
    const tryFocus = () => {
      const el = localTextareaRef.current;
      if (!el) {
        if (spend()) {
          onFocusHandled();
          return;
        }
        timer = setTimeout(tryFocus, 40);
        return;
      }
      const active = document.activeElement;
      if (active === el) {
        held += 1;
      } else if (isOurs(active)) {
        el.focus();
        held = 0;
      } else {
        onFocusHandled();
        return;
      }
      if (held >= 2 || spend()) {
        onFocusHandled();
        return;
      }
      timer = setTimeout(tryFocus, 40);
    };
    const frame = window.requestAnimationFrame(tryFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, [chatId, hasAssistant, onFocusHandled, shouldFocus]);

  const updatedAtByPath = useMemo(
    () => new Map(mentionableFiles.map((file) => [file.path, file.updatedAt])),
    [mentionableFiles],
  );
  const mentionPaths = useMemo(
    () => mentionableFiles.map((file) => file.path),
    [mentionableFiles],
  );
  const rankedMentionPaths = useMemo(
    () => rankFilePaths(mentionPaths, fileMention?.query ?? '', updatedAtByPath),
    [mentionPaths, fileMention?.query, updatedAtByPath],
  );
  const mentionPickerItems: FilePickerItem[] = useMemo(
    () =>
      rankedMentionPaths.map((path) => {
        const folder = getFolderPath(path);
        const rel = formatRelativeUpdatedAt(updatedAtByPath.get(path));
        const secondary =
          fileMention?.query.trim() ?
            folder || null
          : [folder, rel].filter(Boolean).join(' · ') || null;
        return { path, secondary };
      }),
    [rankedMentionPaths, fileMention?.query, updatedAtByPath],
  );

  useEffect(() => {
    setMentionHighlight(0);
  }, [fileMention?.query]);

  useEffect(() => {
    setSlashHighlight(0);
  }, [inputValue]);

  // Only files the user explicitly tags (via [[wiki links]]) get a pill. The
  // open file is still sent to the agent as context, just not shown here.
  const mergedContextFiles = useMemo(
    () => contextFilesFromWikiText(inputValue, workspaceFilePaths).slice(0, 10),
    [inputValue, workspaceFilePaths],
  );
  const snippetPaths = useMemo(
    () => new Set(contextSnippets.map((s) => s.path).filter((p): p is string => Boolean(p))),
    [contextSnippets],
  );
  const visibleContextFiles = useMemo(
    () => mergedContextFiles.filter((file) => !snippetPaths.has(file.path)),
    [mergedContextFiles, snippetPaths],
  );
  // Display-only indicator for the open file. Suppressed when the same file is
  // already surfaced as an explicit [[wiki]] pill or a quoted snippet, so we
  // never show it twice.
  const ambientOpenFilePath = useMemo(() => {
    if (!openFilePath) return null;
    if (mergedContextFiles.some((file) => file.path === openFilePath)) return null;
    if (snippetPaths.has(openFilePath)) return null;
    return openFilePath;
  }, [openFilePath, mergedContextFiles, snippetPaths]);
  const hasComposerContext =
    contextSnippets.length > 0 || visibleContextFiles.length > 0 || Boolean(ambientOpenFilePath);

  const hasDraftText = inputValue.trim().length > 0;
  const hasAttachments = attachments.length > 0;
  const hasContextSnippets = contextSnippets.length > 0;
  const composerEnabled = hasAssistant && !disabledNotice;
  const canSend =
    composerEnabled &&
    (hasDraftText || hasAttachments || hasContextSnippets) &&
    !chatUploadsInFlight;

  useEffect(() => {
    if (!fileMention) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const shell = composerTextareaShellRef.current;
      if (!shell) return;
      if (shell.querySelector('[role="listbox"]')?.contains(target)) return;
      if (localTextareaRef.current?.contains(target)) return;
      setFileMention(null);
      setMentionHighlight(0);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [fileMention]);

  const pickMentionFile = useCallback(
    (path: string) => {
      if (!fileMention || !chatId) return;
      const el = localTextareaRef.current;
      const range = mentionRangeRef.current;
      if (!el || !range) return;
      range.deleteContents();
      // The caret must land INSIDE a text node: merely "after" a trailing
      // contentEditable=false chip (no text node to live in), WebKit paints it
      // in the wrong place — outside the composer box or at position 0 — which
      // read as an invisible caret in the desktop WKWebView. Reuse the text
      // node that already follows the mention (mid-draft completion — adding a
      // space there would shove one before existing punctuation/words);
      // otherwise append a space spacer, which is also the natural
      // end-of-draft post-mention UX.
      const chip = makeWikiNode(path);
      range.insertNode(chip);
      let anchor = chip.nextSibling;
      while (anchor?.nodeType === Node.TEXT_NODE && anchor.textContent === '') {
        anchor = anchor.nextSibling;
      }
      if (anchor?.nodeType === Node.TEXT_NODE) {
        range.setStart(anchor, 0);
      } else {
        const space = document.createTextNode(' ');
        chip.after(space);
        range.setStart(space, 1);
      }
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const nextValue = serializeComposerValue(el);
      setInputValue(nextValue);
      onDraftChange(chatId, nextValue);
      setFileMention(null);
      setMentionHighlight(0);
      mentionRangeRef.current = null;
      requestAnimationFrame(() => {
        localTextareaRef.current?.focus();
      });
    },
    [chatId, fileMention, onDraftChange],
  );

  const removeMentionedFile = useCallback(
    (path: string) => {
      if (!chatId) return;
      for (const target of extractWikiLinkTargets(inputValue)) {
        if (resolveWikiTargetToPath(target, workspaceFilePaths) !== path) continue;
        const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Remove the token plus AT MOST ONE adjacent space, preferring the
        // trailing one (the spacer pickMentionFile inserts). This keeps every
        // neighborhood intact: `Read [[x]], then` → `Read, then` (leading
        // space eaten), `See: [[x]] next` → `See: next` (trailing eaten),
        // `a [[x]] b` → `a b`, and a lone `[[x]] ` → ``.
        const match = inputValue.match(new RegExp(`\\[\\[${escaped}\\]\\]`));
        if (match?.index === undefined) continue;
        let start = match.index;
        let end = start + match[0].length;
        if (inputValue[end] === ' ') end += 1;
        else if (start > 0 && /\s/.test(inputValue[start - 1] ?? '')) start -= 1;
        const nextValue = inputValue.slice(0, start) + inputValue.slice(end);
        const el = localTextareaRef.current;
        if (el) renderComposerValue(el, nextValue, workspaceFilePaths);
        setInputValue(nextValue);
        onDraftChange(chatId, nextValue);
        requestAnimationFrame(() => localTextareaRef.current?.focus());
        return;
      }
    },
    [chatId, inputValue, onDraftChange, workspaceFilePaths],
  );

  const syncDraftFromEditor = useCallback(() => {
    if (!chatId) return;
    const el = localTextareaRef.current;
    if (!el) return;
    // Deleting the last character can leave a truly empty editor (WebKit) —
    // restore the filler so the caret stays visible.
    ensureEditableLine(el);
    const nextValue = serializeComposerValue(el);
    setInputValue(nextValue);
    onDraftChange(chatId, nextValue);
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    if (!selection || !anchor || !el.contains(anchor)) {
      setFileMention(null);
      mentionRangeRef.current = null;
      return;
    }
    if (anchor.nodeType !== Node.TEXT_NODE) {
      setFileMention(null);
      mentionRangeRef.current = null;
      return;
    }
    const textNode = anchor as Text;
    const offset = selection.anchorOffset;
    const match = detectFileMention(textNode.data, offset);
    if (!match) {
      setFileMention(null);
      mentionRangeRef.current = null;
      return;
    }
    const range = document.createRange();
    range.setStart(textNode, match.start);
    range.setEnd(textNode, offset);
    mentionRangeRef.current = range;
    setFileMention(match);
  }, [chatId, onDraftChange]);

  // Write both the editor DOM and the draft state (the box is uncontrolled).
  const setComposerText = (next: string, caretToEnd = false) => {
    const el = localTextareaRef.current;
    if (el) {
      renderComposerValue(el, next, workspaceFilePathsRef.current);
      if (caretToEnd) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    setInputValue(next);
    if (chatId) onDraftChange(chatId, next);
  };

  const runWatchCommand = (action: WatchAction) => {
    // `/watch` is doc-scoped by contract — with no open doc it must NOT
    // silently widen to the whole workspace (that's `/watch all`). Refuse:
    // the draft stays put and the picker (which hides `/watch` in that
    // state) shows the alternatives (Codex P2).
    if (action === 'doc' && !openFilePath) return;
    onCommentWatchCommand?.(action === 'off' ? null : action === 'all' ? '*' : openFilePath);
    setComposerText('');
  };

  // Sending, with the `/watch` family peeled off first: a command runs locally
  // and clears the box — it is never persisted as a message nor sent to the agent.
  // While a turn streams the send control IS Stop, so the interception is off
  // entirely: Enter must stay inert and the button must interrupt, not swallow
  // the draft and leave the agent running (Codex P2).
  const send = (trigger: SendTrigger) => {
    const command = isChatInterruptible ? null : parseWatchCommand(inputValue);
    if (!command || !onCommentWatchCommand) {
      onAction(trigger, inputValue);
      return;
    }
    runWatchCommand(command);
  };

  // Discoverability: the commands matching what's typed so far, as a picker.
  // Hidden while streaming — it would advertise commands that can't run.
  const slashPickerOpen = Boolean(onCommentWatchCommand) && !isChatInterruptible && inputValue.startsWith('/');
  const slashOptions = slashPickerOpen
      ? SLASH_COMMANDS.filter(
          (entry) =>
            entry.command.startsWith(slashText(inputValue)) &&
            // Doc-scoped `/watch` needs an open doc — otherwise offer only
            // `/watch all` / `/unwatch` so the choice is explicit.
            (entry.action !== 'doc' || Boolean(openFilePath)),
        )
      : [];
  // A draft that IS exactly `/watch` with no doc open must not commit the
  // workspace-wide row that would otherwise sit highlighted under Enter:
  // nothing is preselected, Enter refuses, and the picker says why (Codex P2).
  const docWatchUnavailable = slashPickerOpen && !openFilePath && slashText(inputValue) === '/watch';
  const showSlashHint =
    (slashOptions.length > 0 || docWatchUnavailable) && slashDismissedFor !== inputValue;
  const slashChoice = docWatchUnavailable
    ? undefined
    : slashOptions[Math.min(slashHighlight, slashOptions.length - 1)];

  // While a turn is running we let the button stay live so the user can click
  // it as an explicit stop, even with an empty input.
  const sendDisabled = !canSend && !isChatInterruptible;
  // When a non-default harness is selected, only its provider's models can run,
  // so the picker only offers those.
  const visibleModels = useMemo(() => modelsForHarness(models, harness), [models, harness]);
  const {
    allOptions: chatRuntimeOptions,
    featuredSections,
    moreSections,
  } = useMemo(() => buildChatRuntimePicker(visibleModels), [visibleModels]);
  const featuredOptions = useMemo(
    () => featuredSections.flatMap((section) => section.options),
    [featuredSections]
  );
  const moreOptions = useMemo(
    () => moreSections.flatMap((section) => section.options),
    [moreSections]
  );
  // `null` = untouched, so the picker can default itself open: a chat whose
  // model has been demoted out of the featured row (a newer sibling took the
  // slot) would otherwise show no selected entry until "More models" is
  // clicked. An explicit toggle wins until the picker closes.
  const [showMoreModels, setShowMoreModels] = useState<boolean | null>(null);
  const modelsExpanded =
    showMoreModels ?? moreOptions.some((option) => option.id === currentChatModel);
  const [modelSearch, setModelSearch] = useState('');
  // A non-empty query replaces the browse view with a flat match list
  // (options are already featured-first / newest-first, so matches read in
  // relevance order).
  const modelQuery = modelSearch.trim().toLowerCase();
  const modelSearchResults = useMemo(
    () =>
      modelQuery
        ? chatRuntimeOptions.filter((option) =>
            `${option.label} ${option.id} ${option.providerLabel}`.toLowerCase().includes(modelQuery),
          )
        : null,
    [chatRuntimeOptions, modelQuery],
  );
  // Drop the override on *every* close path — the trigger, an outside click,
  // picking a model — so the next open re-derives its default.
  useEffect(() => {
    if (!showModelPicker) {
      setShowMoreModels(null);
      setModelSearch('');
    }
  }, [showModelPicker]);
  const [showHarnessFlyout, setShowHarnessFlyout] = useState(false);
  const selectedRuntimeOption = useMemo(
    () => chatRuntimeOptions.find((option) => option.id === currentChatModel) ?? null,
    [chatRuntimeOptions, currentChatModel]
  );
  const currentModelLabel =
    selectedRuntimeOption?.label ?? getChatModelLabel(currentChatModel, 'Model');

  // Stored without surrounding slashes; the chip renders it as `<path>/`.
  const folderScopeLabel = folderScope?.trim().replace(/^\/+|\/+$/g, '') ?? '';
  const watchedPath = commentWatchPath?.trim() ?? '';
  const commentWatchLabel =
    watchedPath === '*' ? 'whole workspace' : watchedPath.split('/').pop() ?? '';
  const watching = commentWatchLabel.length > 0;

  const renderChatRuntimeOption = (option: ChatRuntimePickerOption) => {
    const isSelected = option.id === currentChatModel;
    // Providers without a brand icon get a neutral placeholder so rows align.
    const ProviderIcon = getProviderIcon(option) ?? CpuIcon;

    return (
      <button
        key={option.id}
        type="button"
        data-testid="model-picker-option"
        data-model-id={option.id}
        data-model-provider={option.provider}
        data-selected={isSelected ? 'true' : 'false'}
        onClick={() => {
          setShowModelPicker(false);
          onSelectChatRuntime(option);
        }}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-stone-50 ${
          isSelected ? 'bg-stone-50 text-stone-800' : 'text-stone-700'
        }`}
      >
        <ProviderIcon className="h-3.5 w-3.5 shrink-0 text-stone-500" />
        <span className="truncate">{option.label}</span>
      </button>
    );
  };

  const SelectedProviderIcon =
    (selectedRuntimeOption
      ? getProviderIcon(selectedRuntimeOption)
      : getProviderIcon({ provider: currentChatModel.split('/')[0] ?? null, id: currentChatModel })) ??
    CpuIcon;

  return (
    <>
      {/* Only when there's something to show: this block used to render its
          padding unconditionally, costing 32px of transcript height on every
          chat that had no uploads or attachments — which is nearly all of them. */}
      {uploads.length > 0 || attachments.length > 0 ? (
      <div className="pt-4 pb-2">
        <div className="max-w-2xl mx-auto px-4 space-y-2">
          {uploads.length > 0 && (
            <div className="space-y-1">
              {uploads.map((upload) => (
                <div key={upload.id} className="flex items-center gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">
                  <span className="truncate">{upload.name}</span>
                  {upload.status === 'error' ? (
                    <span className="ml-auto flex items-center gap-2 text-rose-500">
                      {upload.error ?? 'Upload failed'}
                      <button
                        type="button"
                        onClick={() => onRemoveUpload(upload.id)}
                        aria-label="Dismiss"
                        className="relative group/tip text-stone-400 hover:text-stone-600"
                      >
                        ✕
                        <IconTooltip label="Dismiss" />
                      </button>
                    </span>
                  ) : (
                    <div className="ml-auto flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-stone-200">
                        <div
                          className="h-full bg-stone-500 transition-all"
                          style={{ width: `${Math.round(upload.progress * 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-stone-400">{Math.round(upload.progress * 100)}%</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex items-center gap-2 rounded-lg bg-stone-100 px-2 py-1 text-xs text-stone-600"
                >
                  <svg className="h-3.5 w-3.5 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.586-6.586a4 4 0 10-5.656-5.656L5.636 10.93a6 6 0 108.485 8.485l6.586-6.586" />
                  </svg>
                  <span className="max-w-[180px] truncate">{formatFileName(getFileName(attachment.path))}</span>
                  {attachment.size ? (
                    <span className="text-[10px] text-stone-400">{formatBytes(attachment.size)}</span>
                  ) : null}
                  {chatId && (
                    <button
                      type="button"
                      onClick={() => onRemoveAttachment(attachment)}
                      aria-label="Remove"
                      className="relative group/tip text-stone-400 hover:text-stone-600"
                    >
                      ✕
                      <IconTooltip label="Remove" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      ) : null}
      {/* The padding sits INSIDE the max-w-2xl cap, mirroring the transcript's
          own `mx-auto max-w-2xl` + `p-4`. Outside the cap it would be ignored
          once the pane got wider than 2xl, leaving the composer 16px prouder
          than the message and diff cards; inside, the edges line up at every
          pane width. */}
      <div className="pb-3">
        <div className="max-w-2xl mx-auto px-4">
          <div className="relative">
          <div
            ref={composerTextareaShellRef}
            data-testid="composer-shell"
            // Flat at rest, but with real contrast: a lighter field and a solid
            // border, so the toolbar's dark glyphs and their stone-300 hover
            // fill both read (the old stone-400-on-stone-200 toolbar looked
            // disabled — Florent, 2026-08-06).
            className="bg-stone-100 border border-stone-300 rounded-xl relative"
          >
            {showSlashHint ? (
              <div
                role="listbox"
                aria-label="Slash commands"
                data-testid="composer-slash-hint"
                className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden rounded-xl border border-stone-200 bg-white p-1.5 shadow-[0_1px_2px_rgba(60,64,67,0.3),0_2px_6px_2px_rgba(60,64,67,0.15)]"
              >
                {slashOptions.map((entry, index) => (
                  <button
                    key={entry.command}
                    type="button"
                    role="option"
                    aria-selected={entry === slashChoice}
                    onMouseEnter={() => setSlashHighlight(index)}
                    onMouseDown={(event) => event.preventDefault()} // keep the caret in the box
                    onClick={() => runWatchCommand(entry.action)}
                    className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left text-[12px] ${
                      entry === slashChoice ? 'bg-stone-100' : ''
                    }`}
                  >
                    <span className="font-medium text-stone-700">{entry.command}</span>
                    <span className="truncate text-stone-400">{entry.hint}</span>
                  </button>
                ))}
                {docWatchUnavailable ? (
                  <p data-testid="composer-slash-note" className="px-2 py-1 text-[12px] text-stone-400">
                    <span className="font-medium text-stone-500">/watch</span> needs an open document
                  </p>
                ) : null}
              </div>
            ) : null}
            {fileMention && mentionPickerItems.length > 0 ? (
              <FilePickerPopover
                items={mentionPickerItems}
                highlightedIndex={Math.min(
                  mentionHighlight,
                  Math.max(0, mentionPickerItems.length - 1),
                )}
                onHighlight={setMentionHighlight}
                onPick={(item) => pickMentionFile(item.path)}
                position={{ left: 0, top: 0 }}
                positionMode="inline"
                header={fileMention.query.trim() ? undefined : 'Recent files'}
              />
            ) : null}
            {hasComposerContext ? (
              <div className="flex flex-wrap items-center gap-1 px-3 pt-2 pb-0.5">
                {ambientOpenFilePath ? (
                  <span
                    data-testid="composer-open-file-chip"
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-stone-300/70 px-1.5 py-0.5 text-[11px] text-stone-500"
                    title={`${ambientOpenFilePath} · automatically in the agent's context`}
                  >
                    <FileIcon className="h-3 w-3 shrink-0 text-stone-400" aria-hidden />
                    <span className="max-w-[180px] truncate">
                      {formatFileName(getFileName(ambientOpenFilePath))}
                    </span>
                  </span>
                ) : null}
                {contextSnippets.map((snippet) => {
                  const fileName = snippet.path
                    ? snippet.path.split('/').pop() ?? snippet.path
                    : null;
                  return (
                    <span
                      key={snippet.id}
                      className="inline-flex max-w-[min(280px,100%)] items-center gap-1 rounded-md border border-stone-200 bg-white px-1.5 py-0.5 text-[11px] text-stone-600"
                      title={snippet.text}
                    >
                      <QuotesIcon className="h-3 w-3 shrink-0 text-stone-400" weight="fill" aria-hidden />
                      {fileName ? (
                        <span className="max-w-[90px] truncate text-stone-400">{fileName}</span>
                      ) : null}
                      <span className="max-w-[160px] truncate">{snippet.text}</span>
                      <button
                        type="button"
                        onClick={() => onRemoveContextSnippet(snippet.id)}
                        aria-label="Remove quoted context"
                        className="shrink-0 rounded px-0.5 text-[10px] leading-none text-stone-400 hover:text-stone-600"
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
                {visibleContextFiles.map((file) => (
                  <span
                    key={`ctx:${file.path}`}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-stone-200 bg-white px-1.5 py-0.5 text-[11px] text-stone-600"
                    title={file.path}
                  >
                    <FileIcon className="h-3 w-3 shrink-0 text-stone-400" aria-hidden />
                    <span className="max-w-[180px] truncate">
                      {formatFileName(getFileName(file.path))}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeMentionedFile(file.path)}
                      aria-label="Remove file from context"
                      className="shrink-0 rounded px-0.5 text-[10px] leading-none text-stone-400 hover:text-stone-600"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="relative">
              {!inputValue ? (
                <div
                  aria-hidden
                  className={`pointer-events-none absolute inset-0 px-4 pb-1 text-sm leading-snug text-stone-500 ${
                    hasComposerContext ? 'pt-1.5' : 'pt-2.5'
                  }`}
                >
                  {disabledNotice ?? (hasAssistant ? 'What would you like to do today?' : 'Start a new chat to message Sundial Agent')}
                </div>
              ) : null}
              <div
                ref={setTextareaRef}
                data-testid="chat-composer-input"
                role="textbox"
                contentEditable={composerEnabled}
                suppressContentEditableWarning
                spellCheck={false}
                onInput={syncDraftFromEditor}
                onKeyUp={syncDraftFromEditor}
                onPaste={(event) => {
                  event.preventDefault();
                  const text = event.clipboardData.getData('text/plain');
                  insertPlainTextIntoComposer(event.currentTarget, text);
                  syncDraftFromEditor();
                }}
                onClick={(event) => {
                  const node = (event.target as HTMLElement | null)?.closest(
                    '[data-wiki-path]',
                  ) as HTMLElement | null;
                  const path = node?.dataset.wikiPath;
                  if (!node || !path) return;
                  event.preventDefault();
                  onOpenEditedFile(path);
                }}
                onKeyDown={(event) => {
                  // Slash picker owns these keys ONLY while it shows — closed,
                  // Enter/Tab/arrows keep their ordinary composer behavior.
                  if (showSlashHint && slashChoice) {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      const delta = event.key === 'ArrowDown' ? 1 : slashOptions.length - 1;
                      // Clamp first: a narrowed list must move from the row the
                      // user actually sees highlighted, never a stale index.
                      setSlashHighlight(
                        (current) => (Math.min(current, slashOptions.length - 1) + delta) % slashOptions.length,
                      );
                      return;
                    }
                    if (event.key === 'Tab') {
                      // Complete the text only — Enter is what commits.
                      event.preventDefault();
                      setComposerText(slashChoice.command, true);
                      return;
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      runWatchCommand(slashChoice.action);
                      return;
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setSlashDismissedFor(inputValue);
                      return;
                    }
                  }
                  if (fileMention && mentionPickerItems.length > 0) {
                    const last = mentionPickerItems.length - 1;
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setMentionHighlight((current) => Math.min(current + 1, last));
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setMentionHighlight((current) => Math.max(current - 1, 0));
                      return;
                    }
                    if (event.key === 'PageDown') {
                      event.preventDefault();
                      setMentionHighlight((current) => Math.min(current + 8, last));
                      return;
                    }
                    if (event.key === 'PageUp') {
                      event.preventDefault();
                      setMentionHighlight((current) => Math.max(current - 8, 0));
                      return;
                    }
                    if (event.key === 'Home') {
                      event.preventDefault();
                      setMentionHighlight(0);
                      return;
                    }
                    if (event.key === 'End') {
                      event.preventDefault();
                      setMentionHighlight(last);
                      return;
                    }
                    if (event.key === 'Enter' || event.key === 'Tab') {
                      event.preventDefault();
                      const item = mentionPickerItems[mentionHighlight] ?? mentionPickerItems[0];
                      if (item) pickMentionFile(item.path);
                      return;
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setFileMention(null);
                      return;
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send('enter');
                  }
                }}
                className={`relative min-h-[32px] w-full whitespace-pre-wrap break-words bg-transparent px-4 pb-1 text-sm leading-snug caret-stone-900 focus:outline-none [overflow-wrap:anywhere] ${
                  composerEnabled ? '' : 'pointer-events-none opacity-60'
                } ${hasComposerContext ? 'pt-1.5' : 'pt-2.5'}`}
              />
            </div>
            {/* @container/toolbar: the model trigger drops to its icon when
                this row is narrow (see below), which depends on the row's own
                width, not the viewport's. */}
            <div className="@container/toolbar flex items-center gap-1 px-2 pb-1.5 pt-0.5">
              <div className="relative" ref={setPlusContainerRef}>
                <button
                  type="button"
                  onClick={() => {
                    setShowPlusMenu((prev) => !prev);
                    setShowAppsPicker(false);
                    setShowModelPicker(false);
                  }}
                  aria-label="Add context"
                  className="relative group/tip p-1.5 rounded-lg text-stone-700 transition-colors hover:text-stone-900 hover:bg-stone-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <PlusIcon className="w-4 h-4" aria-hidden />
                  <IconTooltip
                    label="Add context"
                    side="top"
                    open={showPlusMenu || showAppsPicker || showModelPicker}
                  />
                </button>
                <input
                  ref={chatFileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    const files = event.target.files;
                    if (!files || files.length === 0) return;
                    onAttachFiles(Array.from(files));
                    event.target.value = '';
                  }}
                />
                {showPlusMenu && (
                  <div className="absolute bottom-full left-0 mb-1 w-48 bg-white rounded-xl shadow-lg border border-stone-200 z-50 py-1">
                    <button
                      type="button"
                      onClick={() => {
                        setShowPlusMenu(false);
                        chatFileInputRef.current?.click();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
                    >
                      <PaperclipIcon className="h-3.5 w-3.5 text-stone-500" aria-hidden />
                      <span className="flex-1 text-left">Attach files</span>
                    </button>
                    {/* Apps (Composio connectors) hidden from the UI for now — re-enable later.
                    <button
                      type="button"
                      onClick={() => {
                        setShowPlusMenu(false);
                        setShowAppsPicker(true);
                        setShowModelPicker(false);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
                    >
                      <LinkIcon className="h-3.5 w-3.5 text-stone-500" aria-hidden />
                      <span className="flex-1 text-left">Apps</span>
                      {connectedApps.length > 0 && (
                        <span className="text-[10px] text-stone-400">{connectedApps.length}</span>
                      )}
                    </button>
                    */}
                  </div>
                )}
                <ChatAppsPicker
                  open={showAppsPicker}
                  connectedApps={connectedApps}
                  connectedAppsLoading={connectedAppsLoading}
                  currentChatId={currentChatId}
                  reloadConnectedApps={reloadConnectedApps}
                />
              </div>
              <EditModeControl
                mode={editMode}
                onChange={onEditModeChange}
                menuPlacement="up"
                tone="strong"
                disabled={!hasAssistant}
                modes={CHAT_EDIT_MODES}
                // Last label to go: only a row too narrow for even the icons
                // drops it (the tooltip and aria-label still name the mode).
                labelClassName="hidden @[17rem]/toolbar:block"
              />
              {folderScopeLabel ? (
                <span
                  data-testid="composer-folder-scope"
                  title={`This chat works from ${folderScopeLabel}/`}
                  className="flex min-w-0 max-w-[180px] items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] text-stone-500"
                >
                  <FolderIcon className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
                  <span className="hidden truncate @[19rem]/toolbar:block">{folderScopeLabel}/</span>
                </span>
              ) : null}
              <div className="ml-auto flex min-w-0 items-center gap-1">
                {/* No `relative`: a `right-0` w-72 menu anchored here opened off
                    the left edge of the screen on a narrow panel (measured
                    -22px at 360px wide, worse below). It anchors to the
                    composer shell instead, which is always on-screen. */}
                <div className="flex min-w-[30px] items-center gap-1" ref={modelPickerRef}>
                  {/* The trigger is on the toolbar at every panel width: it used
                      to fold away into the + menu, which read as "the model
                      selector went missing". A narrow row drops the label and
                      caret for the provider icon alone (30px, the container's
                      floor); a long model name truncates. */}
                  <button
                    type="button"
                    data-testid="model-picker-trigger"
                    onClick={() => {
                      setShowModelPicker(!showModelPicker);
                      setShowAppsPicker(false);
                      setShowHarnessFlyout(false);
                    }}
                    aria-label={`Model: ${currentModelLabel}`}
                    title={currentModelLabel}
                    className="flex min-w-0 items-center gap-1.5 overflow-hidden rounded-lg px-2 py-1 text-[13px] font-medium text-stone-700 transition-colors hover:bg-stone-300 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {/* eslint-disable-next-line react-hooks/static-components -- false positive: rendering a captured component reference, not creating a new component. */}
                    <SelectedProviderIcon className="h-3.5 w-3.5 shrink-0 text-stone-600" />
                    <span className="hidden truncate @[19rem]/toolbar:block">{currentModelLabel}</span>
                    <CaretDownIcon
                      className="hidden h-3 w-3 shrink-0 text-stone-600 @[19rem]/toolbar:block"
                      weight="bold"
                      aria-hidden
                    />
                  </button>
                  {showModelPicker && (
                    <div
                      data-testid="model-picker-menu"
                      className="absolute bottom-full right-0 z-20 mb-1 w-72 rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
                    >
                      {anonModelPinned && (
                        <div
                          data-testid="anon-model-pin-note"
                          className="mx-1.5 mb-1 rounded-md bg-stone-50 px-2 py-1.5 text-[11px] leading-snug text-stone-500"
                        >
                          Free runs use {getChatModelLabel(currentChatModel, 'this model')}. Sign in
                          to pick other models.
                        </div>
                      )}
                      {/* Compact agent row — the descriptive rows open in a
                          side flyout so switching agents never resizes the
                          menu (the inline rows made the whole thing jump). */}
                      <div className="relative mx-1.5 mb-1">
                        <button
                          type="button"
                          data-testid="harness-flyout-trigger"
                          aria-haspopup="menu"
                          aria-expanded={showHarnessFlyout}
                          onClick={() => setShowHarnessFlyout((prev) => !prev)}
                          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[12px] text-stone-600 hover:bg-stone-50"
                        >
                          <span className="text-stone-400">Agent:</span>
                          <span className="font-medium text-stone-800">{CHAT_HARNESS_LABELS[harness]}</span>
                          {(() => {
                            const engine =
                              localEngines && harness === 'claude'
                                ? localEngines.claude
                                : localEngines && harness === 'openai'
                                  ? localEngines.codex
                                  : null;
                            return engine ? (
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${engine.available && engine.loggedIn ? 'bg-green-500' : 'bg-stone-300'}`}
                                aria-hidden
                              />
                            ) : null;
                          })()}
                          <CaretLeftIcon
                            className={`ml-auto h-3 w-3 text-stone-400 transition-transform ${showHarnessFlyout ? '-rotate-180' : ''}`}
                            aria-hidden
                          />
                        </button>
                        {showHarnessFlyout && (
                          <div
                            data-testid="harness-picker"
                            role="tablist"
                            aria-label="Agent harness"
                            // Above the menu, always — the old beside-the-menu
                            // (right-full) variant escaped the chat pane and got
                            // clipped at the pane boundary in split view
                            // (2026-07-31). Overlay, never inline, so the menu
                            // itself never resizes.
                            className="absolute bottom-full left-0 mb-1 flex w-full flex-col gap-0.5 rounded-lg border border-stone-200 bg-white p-1 shadow-lg"
                          >
                            {CHAT_HARNESSES.map((h) => {
                              const engine =
                                localEngines && h === 'claude'
                                  ? localEngines.claude
                                  : localEngines && h === 'openai'
                                    ? localEngines.codex
                                    : null;
                              const detected = Boolean(engine?.available && engine?.loggedIn);
                              const locked = harnessLocked && h !== harness;
                              // A locked row used to swallow its own click with
                              // no explanation. Offer the only move that works
                              // (a fresh chat on that agent) right on the row,
                              // and say why on hover.
                              const relocatable = locked && Boolean(onNewChatWithHarness);
                              // One line under each agent naming what running
                              // it means here — connection state included, so
                              // the presence dot never stands alone. Cloud rows
                              // mirror the desktop contract: say whose account
                              // pays, and prompt the connect flow when it's
                              // Sundial's.
                              const cloudAuth = !engine && cloudEngineAuth && h !== 'vercel'
                                ? (h === 'claude' ? cloudEngineAuth.claude : cloudEngineAuth.openai)
                                : null;
                              // When the row's engine has no user credential,
                              // clicking the row ALSO opens the connect panel
                              // (Settings → API keys): one button, one action —
                              // a separate tiny link next to a silent row read
                              // as the row doing nothing (dev feedback).
                              const rowOpensConnect = Boolean(
                                !engine && cloudEngineAuth && onConnectEngine && h !== 'vercel' && !cloudAuth,
                              );
                              const status = !engine
                                ? !cloudEngineAuth || h === 'vercel'
                                  ? CHAT_HARNESS_HINTS[h]
                                  : cloudAuth === 'subscription'
                                    ? 'Running on your Claude plan'
                                    : cloudAuth === 'api-key'
                                      ? h === 'claude'
                                        ? 'Running on your Anthropic API key'
                                        : 'Running on your OpenAI API key'
                                      : h === 'claude'
                                        ? 'Connect your Claude subscription to run on your plan'
                                        : 'Add your OpenAI API key to run on your account'
                                : h === 'claude'
                                  ? !engine.available
                                    ? 'Install Claude Code to chat on your subscription'
                                    : !engine.loggedIn
                                      ? 'Run `claude login` to connect your subscription'
                                      : 'Claude subscription connected'
                                  : !engine.available
                                    ? 'Install Codex to chat on your ChatGPT subscription'
                                    : !engine.loggedIn
                                      ? 'Run `codex login` to connect your subscription'
                                      : 'ChatGPT subscription connected';
                              return (
                                <button
                                  key={h}
                                  type="button"
                                  role="tab"
                                  aria-selected={harness === h}
                                  aria-disabled={locked && !relocatable}
                                  data-locked={locked || undefined}
                                  data-testid={`harness-tab-${h}`}
                                  onClick={() => {
                                    if (locked) {
                                      if (!relocatable) return;
                                      onNewChatWithHarness?.(h);
                                      setShowHarnessFlyout(false);
                                      setShowModelPicker(false);
                                      return;
                                    }
                                    onSelectHarness(h);
                                    setShowHarnessFlyout(false);
                                    if (rowOpensConnect) {
                                      // The chat still switches to this agent —
                                      // it runs on credits until they connect.
                                      setShowModelPicker(false);
                                      onConnectEngine?.();
                                    }
                                  }}
                                  className={`relative flex flex-col items-start rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                                    harness === h
                                      ? 'border-stone-300 bg-stone-50'
                                      : locked && !relocatable
                                        ? 'cursor-not-allowed border-transparent opacity-50'
                                        : 'border-transparent hover:bg-stone-50'
                                  }`}
                                >
                                  {locked ? (
                                    <IconTooltip
                                      label={`This chat is running ${CHAT_HARNESS_LABELS[harness]}. Create a new chat to use ${CHAT_HARNESS_LABELS[h]}.`}
                                      side="top"
                                      align="left"
                                    />
                                  ) : null}
                                  <span className="flex w-full items-center gap-1.5 text-[13px] font-medium text-stone-800">
                                    {CHAT_HARNESS_LABELS[h]}
                                    {engine || cloudAuth ? (
                                      // Presence dot, not a checkmark — a ✓
                                      // would read as "selected"; the status
                                      // line spells out what the color means.
                                      <span
                                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${detected || cloudAuth ? 'bg-green-500' : 'bg-stone-300'}`}
                                        data-testid={`harness-detected-${h}`}
                                        data-detected={detected || Boolean(cloudAuth)}
                                        role="img"
                                        aria-label={
                                          engine
                                            ? detected
                                              ? 'Connected on this computer'
                                              : 'Not set up on this computer'
                                            : 'Connected to your account'
                                        }
                                      />
                                    ) : null}
                                    {relocatable ? (
                                      <span
                                        data-testid={`harness-new-chat-${h}`}
                                        className="ml-auto shrink-0 rounded-full border border-stone-200 px-1.5 py-0.5 text-[10px] font-medium text-stone-500"
                                      >
                                        New chat
                                      </span>
                                    ) : null}
                                  </span>
                                  <span
                                    className="text-[11px] text-stone-400"
                                    data-testid={rowOpensConnect ? `harness-connect-${h}` : undefined}
                                  >
                                    {locked
                                      ? relocatable
                                        ? `Create a new chat to use ${CHAT_HARNESS_LABELS[h]}`
                                        : 'Create a new chat to use a different agent'
                                      : status}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <div className="border-t border-stone-100 px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-stone-400">
                        Model
                      </div>
                      {modelsExpanded ? (
                        <input
                          data-testid="model-picker-search"
                          value={modelSearch}
                          onChange={(event) => setModelSearch(event.target.value)}
                          placeholder="Search models"
                          autoFocus
                          className="w-full border-b border-stone-100 bg-transparent px-3 py-1.5 text-sm text-stone-700 placeholder:text-stone-400 focus:outline-none"
                        />
                      ) : null}
                      <div className="max-h-[300px] overflow-y-auto">
                        {modelSearchResults ? (
                          modelSearchResults.length > 0 ? (
                            modelSearchResults.map(renderChatRuntimeOption)
                          ) : (
                            <div className="px-3 py-1.5 text-[11px] text-stone-400">
                              No models match
                            </div>
                          )
                        ) : (
                          <>
                            {featuredOptions.map(renderChatRuntimeOption)}
                            {modelsExpanded
                              ? moreSections.map((section) => (
                                  <div key={section.key}>
                                    <div
                                      data-testid="model-picker-section-label"
                                      className="border-t border-stone-100 px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-stone-400"
                                    >
                                      {section.label}
                                    </div>
                                    {section.options.map(renderChatRuntimeOption)}
                                  </div>
                                ))
                              : null}
                          </>
                        )}
                        {modelsLoading ? (
                          <Spinner label="Loading…" size={13} className="px-3 py-1.5 text-[11px]" />
                        ) : null}
                        {!modelsLoading &&
                        visibleModels.length === 0 &&
                        modelsEmptyReason ? (
                          <div className="px-3 py-1.5 text-[11px] text-stone-400">
                            {modelsEmptyReason}
                          </div>
                        ) : null}
                        {moreOptions.length > 0 && !modelSearchResults ? (
                          <button
                            type="button"
                            data-testid="model-picker-toggle-more"
                            onClick={() => setShowMoreModels(!modelsExpanded)}
                            className="mt-0.5 flex w-full items-center justify-between border-t border-stone-100 px-3 py-1.5 text-left text-[11px] text-stone-400 hover:bg-stone-50 hover:text-stone-600"
                          >
                            <span>{modelsExpanded ? 'Show less' : 'More models'}</span>
                            <span aria-hidden>{modelsExpanded ? '▴' : '▾'}</span>
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
                {isVoiceSupported && (
                  <button onClick={() => { toggleVoice(); }}
                    aria-label="Voice"
                    className={`relative group/tip p-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${isVoiceListening ? 'bg-stone-300 text-stone-900' : 'text-stone-700 hover:text-stone-900 hover:bg-stone-300'}`}>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                    </svg>
                    <IconTooltip label="Voice" side="top" />
                  </button>
                )}
                <button
                  onClick={() => send('button')}
                  disabled={sendDisabled}
                  aria-label={sendActionTitle}
                  className={`p-1.5 rounded-full disabled:opacity-30 disabled:cursor-not-allowed ${isChatInterruptible ? 'bg-stone-200 text-stone-700 border border-stone-300 hover:bg-stone-300' : 'bg-stone-900 text-white hover:bg-stone-800'}`}>
                  {isChatInterruptible ? (
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-6 6m6-6l6 6" /></svg>
                  )}
                </button>
              </div>
            </div>
            {watching ? (
              // The bar is clipped by a copy of the composer's rounded rect, so
              // its ends taper with the corners instead of looking chopped.
              <span
                aria-hidden
                data-testid="composer-watch-bar"
                className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl"
              >
                <span className="composer-watch-bar absolute inset-x-0 bottom-0 h-[3px]" />
              </span>
            ) : null}
          </div>
          </div>
          {watching ? (
            <div
              data-testid="composer-comment-watch"
              className="mt-1 flex items-center justify-center gap-1.5 text-[10px] leading-4 text-stone-400"
            >
              <span className="truncate">listening to comments in {commentWatchLabel}</span>
              <button
                type="button"
                onClick={onClearCommentWatch}
                aria-label="Stop watching comments"
                className="rounded p-0.5 hover:text-stone-600"
              >
                <XIcon className="h-2.5 w-2.5" weight="bold" aria-hidden />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
});
