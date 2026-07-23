'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
// LinkIcon used by the Apps (Composio connectors) button, hidden for now — re-enable later.
import { CaretDownIcon, FileIcon, PaperclipIcon, PlusIcon, QuotesIcon } from '@phosphor-icons/react';
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
  onSelectChatRuntime: (option: ChatRuntimePickerOption) => void;
  modelPickerRef: MutableRefObject<HTMLDivElement | null>;
  // Which agent runtime (harness) runs this chat, picked via the tabs at the
  // top of the model menu; the model list is filtered to the harness's provider.
  harness: ChatHarness;
  onSelectHarness: (harness: ChatHarness) => void;
  // Local workspaces: the Claude/Codex tabs run the user's OWN installed
  // agents on this machine (subscription auth); the Vercel tab is Sunny.
  // null = cloud workspace (cloud semantics).
  localEngines?: {
    claude: { available: boolean; loggedIn: boolean };
    codex: { available: boolean; loggedIn: boolean };
  } | null;
  // Local chats lock their engine once the conversation has messages —
  // switch engines by starting a new chat.
  harnessLocked?: boolean;
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
};

const WIKI_LINK_RE = /\[\[([^\]\n]+)\]\]/g;

function splitWikiTarget(raw: string): { target: string; label: string } {
  const [target = '', alias] = raw.split('|');
  const trimmedTarget = target.trim();
  return {
    target: trimmedTarget,
    label: alias?.trim() || trimmedTarget.split('/').pop() || trimmedTarget,
  };
}

function makeWikiNode(path: string, label = getFileName(path)): HTMLElement {
  const node = document.createElement('span');
  node.dataset.wikiPath = path;
  node.contentEditable = 'false';
  node.className = 'wiki-file-link inline';
  node.title = path;
  node.textContent = label;
  return node;
}

function renderComposerValue(root: HTMLElement, value: string, knownPaths: string[]) {
  root.replaceChildren();
  let lastIndex = 0;
  for (const match of value.matchAll(WIKI_LINK_RE)) {
    const full = match[0] ?? '';
    const raw = match[1] ?? '';
    const index = match.index ?? 0;
    if (index > lastIndex) root.append(document.createTextNode(value.slice(lastIndex, index)));
    const { target, label } = splitWikiTarget(raw);
    const path = resolveWikiTargetToPath(target, knownPaths) ?? target;
    root.append(makeWikiNode(path, label));
    lastIndex = index + full.length;
  }
  if (lastIndex < value.length) root.append(document.createTextNode(value.slice(lastIndex)));
}

export function serializeComposerValue(root: HTMLElement): string {
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
        out += formatWikiLink(child.dataset.wikiPath);
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
  return out;
}

export function insertPlainTextIntoComposer(root: HTMLElement, text: string) {
  const doc = root.ownerDocument;
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
      const after = serializeRange(root, afterRange);

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

function serializeRange(root: HTMLElement, range: Range): string {
  const wrapper = root.ownerDocument.createElement('div');
  wrapper.append(range.cloneContents());
  return serializeComposerValue(wrapper);
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
  onSelectChatRuntime,
  modelPickerRef,
  harness,
  onSelectHarness,
  localEngines = null,
  harnessLocked = false,
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
}: ChatComposerProps) {
  const localTextareaRef = useRef<HTMLDivElement | null>(null);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaShellRef = useRef<HTMLDivElement | null>(null);
  const toolbarRowRef = useRef<HTMLDivElement | null>(null);
  const mentionRangeRef = useRef<Range | null>(null);
  const [inputValue, setInputValue] = useState(initialValue);
  const [fileMention, setFileMention] = useState<FileMentionMatch | null>(null);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  // Whether the model picker is folded into the + menu (toolbar too narrow).
  const [modelFolded, setModelFolded] = useState(false);
  const [toolbarWidth, setToolbarWidth] = useState(0);

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

  useEffect(() => {
    const row = toolbarRowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      setToolbarWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(row);
    setToolbarWidth(row.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const setTextareaRef = useCallback(
    (node: HTMLDivElement | null) => {
      localTextareaRef.current = node;
      externalTextareaRef.current = node;
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
    // composer blurred. Retry briefly until the composer actually holds focus.
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryFocus = () => {
      const el = localTextareaRef.current;
      if (el && document.activeElement !== el) el.focus();
      attempts += 1;
      if ((el && document.activeElement === el) || attempts >= 6) {
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
  const canSend =
    hasAssistant &&
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
      range.insertNode(makeWikiNode(path));
      range.collapse(false);
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
        const nextValue = inputValue.replace(new RegExp(`\\s*\\[\\[${escaped}\\]\\]`), '');
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
  const [showMoreModels, setShowMoreModels] = useState(false);
  const selectedRuntimeOption = useMemo(
    () => chatRuntimeOptions.find((option) => option.id === currentChatModel) ?? null,
    [chatRuntimeOptions, currentChatModel]
  );
  const currentModelLabel =
    selectedRuntimeOption?.label ?? getChatModelLabel(currentChatModel, 'Model');

  // Everything that changes the toolbar row's content width (voice button,
  // model label, edit-mode label) plus its available width.
  const toolbarFitInputs =
    `${toolbarWidth}|${isVoiceSupported}|${currentModelLabel}|${editMode}`;
  const lastToolbarFitRef = useRef('');

  // The toolbar is a single row that never wraps. When the model picker doesn't
  // fit, fold it into the + menu. Whenever the fit inputs change — width OR
  // content, in either direction — re-expand and re-measure from scratch, then
  // fold if it doesn't fit. This re-tests both ways (the panel widening, or a
  // shorter model label freeing room) without reading layout on every
  // keystroke. useLayoutEffect → the fold is applied before paint, so there's
  // no flash.
  useLayoutEffect(() => {
    const row = toolbarRowRef.current;
    if (!row) return;
    if (toolbarFitInputs !== lastToolbarFitRef.current) {
      lastToolbarFitRef.current = toolbarFitInputs;
      if (modelFolded) {
        setModelFolded(false);
        return;
      }
    }
    if (!modelFolded && row.scrollWidth > row.clientWidth + 1) {
      setModelFolded(true);
    }
  }, [toolbarFitInputs, modelFolded]);

  const renderChatRuntimeOption = (option: ChatRuntimePickerOption) => {
    const isSelected = option.id === currentChatModel;
    const ProviderIcon = getProviderIcon(option);

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
        {ProviderIcon ? (
          <ProviderIcon className="h-3.5 w-3.5 shrink-0 text-stone-500" />
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span className="truncate">{option.label}</span>
      </button>
    );
  };

  const SelectedProviderIcon = selectedRuntimeOption
    ? getProviderIcon(selectedRuntimeOption)
    : getProviderIcon({ provider: currentChatModel.split('/')[0] ?? null, id: currentChatModel });

  return (
    <>
      <div className="p-4">
        <div className="max-w-2xl mx-auto space-y-2">
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
      <div className="px-3 pb-3 lg:px-6 lg:pb-4">
        <div className="max-w-2xl mx-auto">
          <div
            ref={composerTextareaShellRef}
            data-testid="composer-shell"
            className="bg-stone-200/70 border border-stone-300/60 rounded-xl relative"
          >
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
                    title={`${ambientOpenFilePath} — automatically in Sunny's context`}
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
                      className="inline-flex max-w-[min(280px,100%)] items-center gap-1 rounded-md bg-white/70 px-1.5 py-0.5 text-[11px] text-stone-600"
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
                    className="inline-flex max-w-full items-center gap-1 rounded-md bg-white/70 px-1.5 py-0.5 text-[11px] text-stone-600"
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
                  className={`pointer-events-none absolute inset-0 px-4 pb-1 text-sm leading-snug text-stone-400 ${
                    hasComposerContext ? 'pt-1.5' : 'pt-2.5'
                  }`}
                >
                  {hasAssistant ? 'What would you like to do today?' : 'Start a new chat to message Sunny'}
                </div>
              ) : null}
              <div
                ref={setTextareaRef}
                data-testid="chat-composer-input"
                role="textbox"
                contentEditable={hasAssistant}
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
                    onAction('enter', inputValue);
                  }
                }}
                className={`relative min-h-[32px] w-full whitespace-pre-wrap break-words bg-transparent px-4 pb-1 text-sm leading-snug caret-stone-900 focus:outline-none [overflow-wrap:anywhere] ${
                  hasAssistant ? '' : 'pointer-events-none opacity-60'
                } ${hasComposerContext ? 'pt-1.5' : 'pt-2.5'}`}
              />
            </div>
            <div ref={toolbarRowRef} className="flex items-center gap-1 px-2 pb-1.5 pt-0.5">
              <div className="relative" ref={setPlusContainerRef}>
                <button
                  type="button"
                  onClick={() => {
                    setShowPlusMenu((prev) => !prev);
                    setShowAppsPicker(false);
                    setShowModelPicker(false);
                  }}
                  aria-label="Add context"
                  className="relative group/tip p-1.5 rounded-lg text-stone-400 hover:text-stone-600 hover:bg-stone-200/50 disabled:cursor-not-allowed disabled:opacity-40"
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
                    {modelFolded ? (
                      <button
                        type="button"
                        onClick={() => {
                          setShowPlusMenu(false);
                          setShowAppsPicker(false);
                          setShowModelPicker(true);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
                      >
                        {SelectedProviderIcon ? (
                          // eslint-disable-next-line react-hooks/static-components -- false positive: rendering a captured component reference, not creating a new component.
                          <SelectedProviderIcon className="h-3.5 w-3.5 text-stone-500" />
                        ) : (
                          <span className="h-3.5 w-3.5" aria-hidden />
                        )}
                        <span className="flex-1 text-left">Model</span>
                        <span className="max-w-24 truncate text-[10px] text-stone-400">{currentModelLabel}</span>
                      </button>
                    ) : null}
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
                disabled={!hasAssistant}
                modes={CHAT_EDIT_MODES}
              />
              <div className="ml-auto flex items-center gap-1">
                <div className="relative" ref={modelPickerRef}>
                  {!modelFolded ? (
                    <button
                      type="button"
                      data-testid="model-picker-trigger"
                      onClick={() => {
                        setShowModelPicker(!showModelPicker);
                        setShowAppsPicker(false);
                        if (showModelPicker) setShowMoreModels(false);
                      }}
                      aria-label="Model"
                      className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-stone-600 hover:bg-stone-200/50 hover:text-stone-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="shrink-0 text-stone-400">Model:</span>
                      {SelectedProviderIcon ? (
                        // eslint-disable-next-line react-hooks/static-components -- false positive: rendering a captured component reference, not creating a new component.
                        <SelectedProviderIcon className="h-3.5 w-3.5 shrink-0 text-stone-500" />
                      ) : null}
                      <span>{currentModelLabel}</span>
                      <CaretDownIcon className="h-3 w-3 shrink-0 text-stone-400" weight="bold" aria-hidden />
                    </button>
                  ) : null}
                  {showModelPicker && (
                    <div
                      data-testid="model-picker-menu"
                      className="absolute bottom-full right-0 z-20 mb-1 w-72 rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
                    >
                      <div
                        data-testid="harness-picker"
                        role="tablist"
                        aria-label="Agent harness"
                        className="mx-1.5 mb-1 flex gap-0.5 rounded-lg bg-stone-100 p-0.5"
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
                          return (
                            <button
                              key={h}
                              type="button"
                              role="tab"
                              aria-selected={harness === h}
                              aria-disabled={locked}
                              data-testid={`harness-tab-${h}`}
                              onClick={() => {
                                if (!locked) onSelectHarness(h);
                              }}
                              className={`flex min-w-0 flex-1 items-center justify-center gap-1 truncate rounded-md px-1.5 py-1 text-center text-[11px] transition-colors ${
                                harness === h
                                  ? 'bg-white text-stone-800 shadow-sm'
                                  : locked
                                    ? 'cursor-not-allowed text-stone-300'
                                    : 'text-stone-500 hover:text-stone-700'
                              }`}
                            >
                              <span className="truncate">
                                {localEngines && h === 'vercel' ? 'Sunny' : CHAT_HARNESS_LABELS[h]}
                              </span>
                              {engine ? (
                                // Presence dot, not a checkmark — a ✓ next to a
                                // tab reads as "selected", this means "signed in
                                // on this computer" (footer spells it out).
                                <span
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${detected ? 'bg-green-500' : 'bg-stone-300'}`}
                                  data-testid={`harness-detected-${h}`}
                                  data-detected={detected}
                                  role="img"
                                  aria-label={detected ? 'Connected on this computer' : 'Not set up on this computer'}
                                />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                      <div className="max-h-[360px] overflow-y-auto">
                        {(showMoreModels ? chatRuntimeOptions : featuredOptions).map(
                          renderChatRuntimeOption,
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
                        {moreOptions.length > 0 ? (
                          <button
                            type="button"
                            data-testid="model-picker-toggle-more"
                            onClick={() => setShowMoreModels((prev) => !prev)}
                            className="mt-0.5 flex w-full items-center justify-between border-t border-stone-100 px-3 py-1.5 text-left text-[11px] text-stone-400 hover:bg-stone-50 hover:text-stone-600"
                          >
                            <span>{showMoreModels ? 'Show less' : 'More models'}</span>
                            <span aria-hidden>{showMoreModels ? '▴' : '▾'}</span>
                          </button>
                        ) : null}
                      </div>
                      <div className="border-t border-stone-100 px-3 pb-0.5 pt-1.5 text-[10px] text-stone-400">
                        {harnessLocked
                          ? 'This chat keeps its engine — start a new chat to switch'
                          : !localEngines
                            ? CHAT_HARNESS_HINTS[harness]
                            : harness === 'claude'
                              ? !localEngines.claude.available
                                ? 'Install Claude Code and run `claude login` to chat on your subscription'
                                : !localEngines.claude.loggedIn
                                  ? 'Claude Code found — run `claude login` to chat on your subscription'
                                  : 'Connected — runs on your Claude Code subscription on this computer'
                              : harness === 'openai'
                                ? !localEngines.codex.available
                                  ? 'Install Codex (`npm i -g @openai/codex`) and run `codex login` to chat on your ChatGPT subscription'
                                  : !localEngines.codex.loggedIn
                                    ? 'Codex found — run `codex login` to chat on your ChatGPT subscription'
                                    : 'Connected — runs on your ChatGPT subscription on this computer'
                                : 'Sunny — Sundial’s cloud agent · any model'}
                      </div>
                    </div>
                  )}
                </div>
                {isVoiceSupported && (
                  <button onClick={() => { toggleVoice(); }}
                    aria-label="Voice"
                    className={`relative group/tip p-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${isVoiceListening ? 'text-stone-500 bg-stone-50' : 'text-stone-400 hover:text-stone-600 hover:bg-stone-200/50'}`}>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                    </svg>
                    <IconTooltip label="Voice" side="top" />
                  </button>
                )}
                <button
                  onClick={() => onAction('button', inputValue)}
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
          </div>
        </div>
      </div>
    </>
  );
});
