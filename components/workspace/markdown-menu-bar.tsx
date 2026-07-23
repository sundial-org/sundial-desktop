'use client';

import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FindReplacePanel } from './find-replace';
import { ImageInsertField, openEditorLinkMenu } from './markdown-toolbar';
import { insertDefaultTable } from '@/lib/tiptap/slash-items';
import { isMarkdownFile } from '@/lib/sync/policy';

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
  sidebarOpen?: boolean;
  onNewFile?: () => void;
  onRename?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onToggleSidebar?: () => void;
  onToggleMode?: () => void;
}

type MenuItem =
  | {
      type: 'action';
      label: string;
      shortcut?: string;
      onClick: () => void;
      disabled?: boolean;
      trailing?: string;
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
  sidebarOpen,
  onNewFile,
  onRename,
  onDuplicate,
  onDelete,
  onToggleSidebar,
  onToggleMode,
}: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
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

  const close = useCallback(() => setOpenMenu(null), []);

  const run = useCallback(
    (fn: () => void) => {
      fn();
      close();
    },
    [close],
  );

  // ⌘⇧H opens Find & Replace
  useEffect(() => {
    if (!editor) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'h') {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor]);

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
  const canDownload = Boolean(file && projectId && file.type !== 'folder');
  const canRename = Boolean(file && onRename && !readOnly);
  const canDuplicate = Boolean(file && onDuplicate && !readOnly && file.type !== 'folder');
  const canDelete = Boolean(file && onDelete && !readOnly);
  const canCreate = Boolean(onNewFile && !readOnly);

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
    // just seed a bullet-list item that begins with `[ ] `.
    editor!.chain().focus().toggleBulletList().insertContent('[ ] ').run();
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

  const downloadCurrentFile = () => {
    if (!file || !projectId) return;
    const params = new URLSearchParams({ projectId, fileId: file.id });
    clickDownloadAnchor(
      `/api/workspace/files/download?${params.toString()}`,
      file.path.split('/').pop() ?? 'download',
    );
  };

  // Export goes through fetch (not a plain anchor) so a conversion failure
  // surfaces as a message instead of downloading a broken .pdf/.docx.
  const exportCurrentFile = async (format: 'pdf' | 'docx') => {
    if (!file || !projectId) return;
    const params = new URLSearchParams({ projectId, fileId: file.id, format });
    try {
      const res = await fetch(`/api/workspace/files/export?${params.toString()}`);
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const name = `${(file.path.split('/').pop() ?? 'document').replace(/\.[^.]+$/, '')}.${format}`;
      clickDownloadAnchor(url, name);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('[export]', error);
      window.alert(`Could not export as ${format.toUpperCase()}. Please try again.`);
    }
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
  if (canDownload && isMarkdownFile(file?.path)) {
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
  if (fileItems.length > 0) fileItems.push({ type: 'separator' });
  fileItems.push({
    type: 'action',
    label: 'Print',
    shortcut: '⌘P',
    onClick: () => run(() => typeof window !== 'undefined' && window.print()),
  });

  const viewItems: MenuItem[] = [];
  if (onToggleMode && !readOnly) {
    viewItems.push({
      type: 'action',
      label: 'Mode',
      trailing: readOnly ? 'Viewing' : 'Editing',
      onClick: () => run(onToggleMode),
    });
  }
  if (onToggleSidebar) {
    viewItems.push({
      type: 'action',
      label: sidebarOpen ? 'Hide sidebar' : 'Show sidebar',
      onClick: () => run(onToggleSidebar),
    });
  }
  if (viewItems.length > 0) viewItems.push({ type: 'separator' });
  viewItems.push({
    type: 'action',
    label: 'Full screen',
    onClick: () => run(() => document.documentElement.requestFullscreen?.()),
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
          label: 'Heading 4',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleHeading({ level: 4 }).run()),
        },
        {
          type: 'action',
          label: 'Heading 5',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleHeading({ level: 5 }).run()),
        },
        {
          type: 'action',
          label: 'Heading 6',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().toggleHeading({ level: 6 }).run()),
        },
        {
          type: 'action',
          label: 'Normal text',
          shortcut: '⌘⌥0',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().setParagraph().run()),
        },
        { type: 'separator' },
        {
          type: 'action',
          label: 'Align left',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().setTextAlign('left').run()),
        },
        {
          type: 'action',
          label: 'Align center',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().setTextAlign('center').run()),
        },
        {
          type: 'action',
          label: 'Align right',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().setTextAlign('right').run()),
        },
        {
          type: 'action',
          label: 'Justify',
          disabled: noEditor || readOnly,
          onClick: () => run(() => editor!.chain().focus().setTextAlign('justify').run()),
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
        className="flex items-center gap-1 bg-transparent px-3 py-1.5 text-[13px] text-stone-700"
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
                setOpenMenu((cur) => (cur === menu.id ? null : menu.id));
              }}
              onMouseEnter={() => {
                if (openMenu && openMenu !== menu.id) setOpenMenu(menu.id);
              }}
              className={`rounded px-2.5 py-1 transition-colors ${
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
                    {item.trailing && !item.shortcut && (
                      <span className="ml-4 text-[11px] text-stone-400">{item.trailing}</span>
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
      {findOpen && editor ? (
        <FindReplacePanel editor={editor} readOnly={readOnly} onClose={() => setFindOpen(false)} />
      ) : null}
    </>
  );
}
