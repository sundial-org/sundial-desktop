/**
 * Workspace keyboard shortcuts — the single list behind the Preferences
 * panel, tooltip hints, and palette hints, plus the ⌘/Ctrl display
 * formatting. Bindings themselves live where they fire (page.tsx globals,
 * editor extensions); this module only describes them.
 */

export type ShortcutSpec = {
  id: string;
  label: string;
  /** Canonical combos like 'Mod+Shift+J' (Mod = ⌘ on Mac, Ctrl elsewhere). */
  keys: string[];
  /** Browsers reserve the combo — it only fires in the desktop app. */
  desktopApp?: boolean;
};

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /Mac|iPhone|iPad/.test(navigator.platform ?? '') || navigator.userAgent.includes('Macintosh');
}

const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥' };

/** 'Mod+Shift+J' → '⌘⇧J' on Mac, 'Ctrl+Shift+J' elsewhere. */
export function formatShortcut(combo: string, mac: boolean): string {
  const parts = combo.split('+');
  if (mac) return parts.map((part) => MAC_SYMBOLS[part] ?? part).join('');
  return parts.map((part) => (part === 'Mod' ? 'Ctrl' : part)).join('+');
}

/**
 * Everything listed in Settings → Preferences → Keyboard shortcuts.
 * `desktopShell` = the Tauri shell (any OS): its native File menu consumes
 * ⌘O for "Open folder" before the webview sees it, so quick open is ⌘P
 * there; in the browser both ⌘O (Obsidian) and ⌘P (VS Code) work.
 */
export function workspaceShortcuts({ desktopShell }: { desktopShell: boolean }): ShortcutSpec[] {
  return [
    { id: 'palette', label: 'Search files, chats, and actions', keys: ['Mod+K'] },
    { id: 'quick-open', label: 'Open a file or chat', keys: desktopShell ? ['Mod+P'] : ['Mod+O', 'Mod+P'] },
    { id: 'new-file', label: 'New file', keys: ['Mod+N'], desktopApp: true },
    { id: 'new-tab', label: 'New tab', keys: ['Mod+T'], desktopApp: true },
    { id: 'close-tab', label: 'Close tab', keys: ['Mod+W'], desktopApp: true },
    ...(desktopShell
      ? [{ id: 'open-folder', label: 'Open folder', keys: ['Mod+O'], desktopApp: true }]
      : []),
    { id: 'chat-context', label: 'Add selection to chat', keys: ['Mod+J'] },
    { id: 'new-chat', label: 'New chat', keys: ['Mod+Shift+J'] },
    { id: 'insert-link', label: 'Insert or edit link (text selected)', keys: ['Mod+K'] },
    { id: 'find', label: 'Find in document', keys: ['Mod+F'] },
    { id: 'find-replace', label: 'Find and replace', keys: ['Mod+Shift+H'] },
    { id: 'fold-all', label: 'Collapse all headings and lists', keys: ['Mod+Alt+['] },
    { id: 'unfold-all', label: 'Expand all headings and lists', keys: ['Mod+Alt+]'] },
    { id: 'new-comment', label: 'New comment', keys: ['Mod+Alt+M'] },
  ];
}

export type MarkdownSyntaxSpec = {
  id: string;
  label: string;
  /** What to type, shown verbatim (not a key combo). */
  syntax: string;
};

/**
 * Markdown typing shortcuts — text typed into the document that turns into
 * formatting, listed under the keyboard shortcuts in Settings. Like the combos
 * above this is reference copy only; the behavior lives in the editor's input
 * rules and the markdown codec.
 */
export function markdownSyntaxShortcuts(): MarkdownSyntaxSpec[] {
  return [
    { id: 'heading', label: 'Heading 1–6 (start of line)', syntax: '# … ###### + space' },
    { id: 'bullet-list', label: 'Bullet list', syntax: '- + space' },
    { id: 'numbered-list', label: 'Numbered list', syntax: '1. + space' },
    { id: 'task-list', label: 'Task list', syntax: '- [ ] + space' },
    { id: 'quote', label: 'Quote', syntax: '> + space' },
    { id: 'code-block', label: 'Code block', syntax: '```' },
    { id: 'divider', label: 'Divider', syntax: '---' },
    { id: 'bold', label: 'Bold', syntax: '**text**' },
    { id: 'italic', label: 'Italic', syntax: '*text*' },
    { id: 'strikethrough', label: 'Strikethrough', syntax: '~~text~~' },
    { id: 'inline-code', label: 'Inline code', syntax: '`text`' },
    { id: 'highlight', label: 'Highlight', syntax: '==text==' },
    { id: 'math', label: 'Math (inline / block)', syntax: '$x$ / $$x$$' },
    { id: 'wiki-link', label: 'Link to another file', syntax: '[[name]]' },
  ];
}
