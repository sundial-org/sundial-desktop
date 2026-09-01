'use client';

// The Google Docs-style File/Edit/View/Insert/Format menu bar. Removed from
// the everyday chrome in the wireframe redesign (#907) and restored here for
// the 'docs' document style only (lib/doc-style.ts) — the IDE style keeps the
// single ⋯ menu. Revived from the pre-redesign implementation (7485a7fbb~1)
// with downloads routed through the workspace data plane like
// document-actions-menu (apiFetch + path-share tokens, export hidden on local
// workspaces). Keyboard shortcuts stay owned by DocumentActionsMenu — this bar
// only lists them.
import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FindReplacePanel } from './find-replace';
import { canAlignSelection, ImageInsertField, openEditorLinkMenu } from './markdown-toolbar';
import { insertDefaultTable } from '@/lib/tiptap/slash-items';
import { setDocStylePreference } from '@/lib/doc-style';
import { isMarkdownFile } from '@/lib/sync/policy';
import { appendPathShareTokenToUrl } from '@/lib/workspace/path-share-token-client';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';

type MenuBarFile = {
  id: string;
  path: string;
  type: string;
};

interface MenuBarProps {
  editor: Editor | null;
  readOnly?: boolean;
  file?: MenuBarFile | null;
  projectId?: string | null;
  /** Local (sidecar) workspace: export is a cloud-only route — hide it. */
  localWorkspace?: boolean;
  /** Horizontal padding override (default px-3) so the bar can align flush
   *  under the Docs-style header title. */
  className?: string;
  sidebarOpen?: boolean;
  onNewFile?: () => void;
  onRename?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onToggleSidebar?: () => void;
  /** Split panes are print:hidden — printing from them would print the primary. */
  hidePrint?: boolean;
}

type MenuItem =
  | {
      type: 'action';
      label: string;
      shortcut?: string;
      onClick: () => void;
      disabled?: boolean;
    }
  | { type: 'separator' };

type Menu = {
  id: string;
  label: string;
  items: MenuItem[];
};

function MenuDropdown({
  open,
  onClose,
  anchorRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(event.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    // Escape closes the open menu — without this the dropdown only dismissed on
    // an outside click, so keyboard users had no way out.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, onClose, open]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-lg border border-stone-200 bg-white py-1 shadow-[0_8px_24px_-12px_rgba(28,25,23,0.35)]"
    >
      {children}
    </div>
  );
}

export function MarkdownMenuBar({
  editor,
  readOnly = false,
  file = null,
  projectId = null,
  localWorkspace = false,
  className = 'px-3',
  sidebarOpen,
  onNewFile,
  onRename,
  onDuplicate,
  onDelete,
  onToggleSidebar,
  hidePrint = false,
}: MenuBarProps) {
  const apiFetch = useApiFetch();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // Set when the open menu was reached by HOVERING from another open menu.
  // The mousedown that follows such a hover is "choose this menu", not
  // "toggle it closed" — it consumes the flag and keeps the menu open
  // (Codex r7: File → hover Edit → click closed the bar).
  const hoverSwitchedRef = useRef(false);
  const [findOpen, setFindOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const refs = {
    File: useRef<HTMLButtonElement | null>(null),
    Edit: useRef<HTMLButtonElement | null>(null),
    View: useRef<HTMLButtonElement | null>(null),
    Insert: useRef<HTMLButtonElement | null>(null),
    Format: useRef<HTMLButtonElement | null>(null),
  } as const;

  const close = useCallback(() => {
    hoverSwitchedRef.current = false;
    setOpenMenu(null);
  }, []);

  const run = useCallback(
    (fn: () => void) => {
      fn();
      close();
    },
    [close],
  );

  // A destroyed editor counts as absent: the menu bar renders against the last
  // (frozen) editor during file switches, and v3 throws when any command runs on
  // a destroyed editor. Folding `isDestroyed` in here disables every menu item
  // below (they all gate on `noEditor`) so none dispatch onto the dead editor.
  const noEditor = !editor || editor.isDestroyed;
  // Undo/redo commands come from the Yjs Collaboration extension, which only
  // loads once the ydoc is ready. Before that, `editor.can().undo` is undefined.
  // `editor.can()` also throws on a destroyed editor, so gate on `!noEditor`.
  const canChain = (!noEditor ? editor!.can() : undefined) as
    | Record<string, (() => boolean) | undefined>
    | undefined;
  const canUndo = typeof canChain?.undo === 'function' ? canChain.undo() : false;
  const canRedo = typeof canChain?.redo === 'function' ? canChain.redo() : false;
  const canAlign = !readOnly && !noEditor && canAlignSelection(editor!);
  const canDownload = Boolean(file && projectId && file.type !== 'folder');
  const canRename = Boolean(file && onRename && !readOnly);
  const canDuplicate = Boolean(file && onDuplicate && !readOnly && file.type !== 'folder');
  const canDelete = Boolean(file && onDelete && !readOnly);
  // New is gated by its CREATE TARGET, not the open file: the page only wires
  // onNewFile when canUploadToFolder(create parent) holds, and a read-only
  // active file says nothing about creating elsewhere (Codex round 4).
  const canCreate = Boolean(onNewFile);

  const submitImage = () => {
    const url = imageUrl.trim();
    if (!url) return;
    // Insert a real @tiptap Image node (WorkspaceImage); the codec serializes it
    // back to `![](src)`. Matches the toolbar's image inserter.
    editor!.chain().focus().setImage({ src: url }).run();
    setImageUrl('');
    setImageOpen(false);
  };

  const insertTable = () => insertDefaultTable(editor!);

  const insertTaskListItem = () => {
    // Decoration-based checkboxes (see MarkdownCheckbox in collab-editor.tsx):
    // seed a bullet-list item that begins with `[ ] `. Mirrors the toolbar's
    // checklist command — only toggle INTO a bulleted list (a blind toggle
    // would dissolve an existing one), and never double-mark a line.
    if (!editor!.isActive('bulletList')) {
      editor!.chain().focus().toggleBulletList().run();
    }
    const { $from } = editor!.state.selection;
    const paragraph = $from.parent;
    if (
      paragraph.type.name === 'paragraph' &&
      !paragraph.textContent.startsWith('[ ]') &&
      !paragraph.textContent.startsWith('[x]')
    ) {
      editor!.chain().focus().insertContentAt($from.start(), '[ ] ').run();
    }
  };

  const execCopy = () => {
    if (typeof document !== 'undefined') document.execCommand('copy');
  };
  const execCut = () => {
    if (typeof document !== 'undefined') document.execCommand('cut');
  };
  const execPaste = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) editor!.chain().focus().insertContent(text).run();
    } catch {
      /* user denied clipboard permission */
    }
  };
  const execPastePlain = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) editor!.chain().focus().insertContent({ type: 'text', text }).run();
    } catch {
      /* user denied clipboard permission */
    }
  };

  const clickDownloadAnchor = (href: string, name: string) => {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const downloadBlobAs = async (url: string, name: string, label: string) => {
    try {
      // apiFetch, not a plain anchor: in a LOCAL workspace the data plane is
      // the sidecar shim, and an anchor navigation would go straight to the
      // cloud app, which has never heard of this project.
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(`${label} failed (${res.status})`);
      const objectUrl = URL.createObjectURL(await res.blob());
      clickDownloadAnchor(objectUrl, name);
      // Deferred: WKWebView and Firefox start the anchor's navigation
      // asynchronously — revoking synchronously hands them a dead URL.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      console.error(`[${label}]`, error);
      window.alert(`Could not ${label} this document. Please try again.`);
    }
  };

  const downloadCurrentFile = () => {
    if (!file || !projectId) return;
    const params = new URLSearchParams({ projectId, fileId: file.id });
    const url = appendPathShareTokenToUrl(`/api/workspace/files/download?${params.toString()}`);
    const name = file.path.split('/').pop() ?? 'download';
    // Cloud keeps the ANCHOR: the browser streams it to disk. The local shim
    // can't be reached by an anchor at all (see downloadBlobAs).
    if (!localWorkspace) {
      clickDownloadAnchor(url, name);
      return;
    }
    void downloadBlobAs(url, name, 'download');
  };

  const exportCurrentFile = (format: 'pdf' | 'docx') => {
    if (!file || !projectId) return;
    const params = new URLSearchParams({ projectId, fileId: file.id, format });
    void downloadBlobAs(
      appendPathShareTokenToUrl(`/api/workspace/files/export?${params.toString()}`),
      `${(file.path.split('/').pop() ?? 'document').replace(/\.[^.]+$/, '')}.${format}`,
      `export as ${format.toUpperCase()}`,
    );
  };

  const fileItems: MenuItem[] = [];
  if (canCreate) {
    fileItems.push({ type: 'action', label: 'New', onClick: () => run(onNewFile!) });
  }
  if (canDuplicate) {
    fileItems.push({ type: 'action', label: 'Make a copy', onClick: () => run(onDuplicate!) });
  }
  if (canDownload) {
    fileItems.push({ type: 'action', label: 'Download', onClick: () => run(downloadCurrentFile) });
  }
  // Export is a cloud route: the local shim answers 501 — don't offer it there.
  if (canDownload && !localWorkspace && isMarkdownFile(file?.path)) {
    fileItems.push({
      type: 'action',
      label: 'Download as PDF',
      onClick: () => run(() => void exportCurrentFile('pdf')),
    });
    fileItems.push({
      type: 'action',
      label: 'Download as Word (.docx)',
      onClick: () => run(() => void exportCurrentFile('docx')),
    });
  }
  if (canRename) {
    fileItems.push({ type: 'action', label: 'Rename', onClick: () => run(onRename!) });
  }
  if (canDelete) {
    fileItems.push({ type: 'separator' });
    fileItems.push({ type: 'action', label: 'Move to trash', onClick: () => run(onDelete!) });
  }
  if (!hidePrint) {
    if (fileItems.length > 0) fileItems.push({ type: 'separator' });
    fileItems.push({
      type: 'action',
      label: 'Print',
      shortcut: '⌘P',
      onClick: () => run(() => typeof window !== 'undefined' && window.print()),
    });
  }

  // No toolbar toggle here: the Docs toolbar can never close (founder) —
  // it's where the doc controls live.
  const viewItems: MenuItem[] = [];
  if (onToggleSidebar) {
    viewItems.push({
      type: 'action',
      label: sidebarOpen ? 'Hide sidebar' : 'Show sidebar',
      onClick: () => run(onToggleSidebar),
    });
    viewItems.push({ type: 'separator' });
  }
  viewItems.push({
    type: 'action',
    label: 'Full screen',
    onClick: () => run(() => document.documentElement.requestFullscreen?.()),
  });
  // The way OUT of the Docs style. The top-left icon switch is gone (founder:
  // floating icons read as chrome the page shouldn't have), so the style
  // change lives in menus: here, the ⋮ menu, and Settings → Appearance. This
  // bar only renders in the Docs style, so the item is unconditional.
  viewItems.push({ type: 'separator' });
  viewItems.push({
    type: 'action',
    label: 'IDE view',
    onClick: () => run(() => setDocStylePreference('obsidian')),
  });

  const menus: Menu[] = [
    { id: 'File', label: 'File', items: fileItems },
    {
      id: 'Edit',
      label: 'Edit',
      items: [
        {
          type: 'action',
          label: 'Undo',
          shortcut: '⌘Z',
          disabled: noEditor || readOnly || !canUndo,
          onClick: () => run(() => editor!.chain().focus().undo().run()),
        },
        {
          type: 'action',
          label: 'Redo',
          shortcut: '⌘⇧Z',
          disabled: noEditor || readOnly || !canRedo,
          onClick: () => run(() => editor!.chain().focus().redo().run()),
        },
        { type: 'separator' },
        {
          type: 'action',
          label: 'Cut',
          shortcut: '⌘X',
          disabled: noEditor || readOnly,
          onClick: () => run(execCut),
        },
        {
          type: 'action',
          label: 'Copy',
          shortcut: '⌘C',
          disabled: noEditor,
          onClick: () => run(execCopy),
        },
        {
          type: 'action',
          label: 'Paste',
          shortcut: '⌘V',
          disabled: noEditor || readOnly,
          onClick: () => run(() => void execPaste()),
        },
        {
          type: 'action',
          label: 'Paste without formatting',
          shortcut: '⌘⇧V',
          disabled: noEditor || readOnly,
          onClick: () => run(() => void execPastePlain()),
        },
        { type: 'separator' },
        {
          type: 'action',
          label: 'Select all',
          shortcut: '⌘A',
          disabled: noEditor,
          onClick: () => run(() => editor!.chain().focus().selectAll().run()),
        },
        { type: 'separator' },
        {
          type: 'action',
          label: 'Find and replace',
          shortcut: '⌘⇧H',
          disabled: noEditor,
          onClick: () => run(() => setFindOpen(true)),
        },
        {
          type: 'action',
          label: 'Clear formatting',
          shortcut: '⌘\\',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().unsetAllMarks().clearNodes().run()),
        },
      ],
    },
    { id: 'View', label: 'View', items: viewItems },
    {
      id: 'Insert',
      label: 'Insert',
      items: [
        {
          type: 'action',
          label: 'Link',
          shortcut: '⌘K',
          disabled: noEditor || readOnly,
          onClick: () => run(() => openEditorLinkMenu(editor!)),
        },
        {
          type: 'action',
          label: 'Image',
          disabled: noEditor || readOnly,
          onClick: () => {
            close();
            setImageOpen(true);
          },
        },
        { type: 'separator' },
        {
          type: 'action',
          label: 'Table',
          disabled: noEditor || readOnly,
          onClick: () => run(insertTable),
        },
        {
          type: 'action',
          label: 'Task list',
          disabled: noEditor || readOnly,
          onClick: () => run(insertTaskListItem),
        },
        {
          type: 'action',
          label: 'Horizontal rule',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().setHorizontalRule().run()),
        },
      ],
    },
    {
      id: 'Format',
      label: 'Format',
      items: [
        {
          type: 'action',
          label: 'Bold',
          shortcut: '⌘B',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleBold().run()),
        },
        {
          type: 'action',
          label: 'Italic',
          shortcut: '⌘I',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleItalic().run()),
        },
        {
          type: 'action',
          label: 'Underline',
          shortcut: '⌘U',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleUnderline().run()),
        },
        {
          type: 'action',
          label: 'Strikethrough',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleStrike().run()),
        },
        { type: 'separator' },
        {
          type: 'action',
          label: 'Heading 1',
          shortcut: '⌘⌥1',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleHeading({ level: 1 }).run()),
        },
        {
          type: 'action',
          label: 'Heading 2',
          shortcut: '⌘⌥2',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleHeading({ level: 2 }).run()),
        },
        {
          type: 'action',
          label: 'Heading 3',
          shortcut: '⌘⌥3',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleHeading({ level: 3 }).run()),
        },
        {
          type: 'action',
          label: 'Normal text',
          shortcut: '⌘⌥0',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().setParagraph().run()),
        },
        { type: 'separator' },
        // Alignment is image-only at the schema level (images round-trip as `{align=…}`).
        {
          type: 'action',
          label: 'Align left',
          disabled: !canAlign,
          onClick: () => run(() => editor!.chain().focus().setTextAlign('left').run()),
        },
        {
          type: 'action',
          label: 'Align center',
          disabled: !canAlign,
          onClick: () => run(() => editor!.chain().focus().setTextAlign('center').run()),
        },
        {
          type: 'action',
          label: 'Align right',
          disabled: !canAlign,
          onClick: () => run(() => editor!.chain().focus().setTextAlign('right').run()),
        },
        { type: 'separator' },
        {
          type: 'action',
          label: 'Bulleted list',
          shortcut: '⌘⇧8',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleBulletList().run()),
        },
        {
          type: 'action',
          label: 'Numbered list',
          shortcut: '⌘⇧7',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleOrderedList().run()),
        },
        {
          type: 'action',
          label: 'Blockquote',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleBlockquote().run()),
        },
        {
          type: 'action',
          label: 'Code block',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleCodeBlock().run()),
        },
      ],
    },
  ];

  return (
    <>
      <div
        // py-0: the buttons' own padding is the row's only vertical air —
        // the header cluster was too tall (founder, 2026-08-14).
        className={`flex items-center gap-1 bg-transparent text-[13px] text-stone-700 ${className}`}
        role="menubar"
        data-testid="markdown-menu-bar"
      >
        {menus.map((menu) => (
          <div key={menu.id} className="relative">
            <button
              ref={refs[menu.id as keyof typeof refs]}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={openMenu === menu.id}
              data-menu-btn={menu.label}
              onMouseDown={(event) => {
                event.preventDefault();
                setImageOpen(false);
                if (openMenu === menu.id && hoverSwitchedRef.current) {
                  // Hovered here from another open menu: this click commits
                  // the switch instead of toggling closed.
                  hoverSwitchedRef.current = false;
                  return;
                }
                hoverSwitchedRef.current = false;
                setOpenMenu((cur) => (cur === menu.id ? null : menu.id));
              }}
              // Keyboard/screen-reader activation arrives as a click with
              // detail 0 (Enter/Space) — mouse clicks (detail > 0) already
              // toggled on the mousedown above and must not re-toggle here.
              onClick={(event) => {
                if (event.detail !== 0) return;
                setImageOpen(false);
                setOpenMenu((cur) => (cur === menu.id ? null : menu.id));
              }}
              onMouseEnter={() => {
                if (openMenu && openMenu !== menu.id) {
                  hoverSwitchedRef.current = true;
                  setOpenMenu(menu.id);
                }
              }}
              className={`rounded px-2.5 py-0.5 transition-colors ${
                openMenu === menu.id ? 'bg-stone-200 text-stone-900' : 'hover:bg-stone-100'
              }`}
            >
              {menu.label}
            </button>
            <MenuDropdown
              open={openMenu === menu.id}
              onClose={close}
              anchorRef={refs[menu.id as keyof typeof refs]}
            >
              {menu.items.map((item, index) => {
                if (item.type === 'separator') {
                  return <div key={`sep-${index}`} className="my-1 border-t border-stone-200" />;
                }
                return (
                  <button
                    key={`${menu.id}-${item.label}`}
                    type="button"
                    role="menuitem"
                    data-menu-item={`${menu.label}:${item.label}`}
                    disabled={item.disabled}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      if (!item.disabled) item.onClick();
                    }}
                    // Enter/Space: keyboard clicks carry detail 0; mouse
                    // clicks already ran on mousedown (see the menu button).
                    onClick={(event) => {
                      if (event.detail === 0 && !item.disabled) item.onClick();
                    }}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition-colors ${
                      item.disabled
                        ? 'cursor-not-allowed text-stone-400'
                        : 'text-stone-700 hover:bg-stone-100'
                    }`}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && (
                      <span className="ml-4 text-[11px] text-stone-400">{item.shortcut}</span>
                    )}
                  </button>
                );
              })}
            </MenuDropdown>
            {menu.id === 'Insert' && (
              // Reuse MenuDropdown so the image inserter gets the same styling +
              // outside-click/Escape handling as the menus (no native prompt).
              <MenuDropdown open={imageOpen} onClose={() => setImageOpen(false)} anchorRef={refs.Insert}>
                <ImageInsertField value={imageUrl} onChange={setImageUrl} onSubmit={submitImage} />
              </MenuDropdown>
            )}
          </div>
        ))}
      </div>
      {findOpen && editor && !editor.isDestroyed ? (
        <FindReplacePanel
          editor={editor}
          readOnly={readOnly}
          showReplace
          onClose={() => setFindOpen(false)}
        />
      ) : null}
    </>
  );
}
