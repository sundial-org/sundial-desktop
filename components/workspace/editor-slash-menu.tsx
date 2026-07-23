'use client';

import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import {
  CheckSquareIcon,
  CodeBlockIcon,
  ImageSquareIcon,
  InfoIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  MathOperationsIcon,
  MinusIcon,
  QuotesIcon,
  SparkleIcon,
  TableIcon,
  TextHOneIcon,
  TextHTwoIcon,
  TextHThreeIcon,
  TextTIcon,
  type Icon,
} from '@phosphor-icons/react';
import {
  SLASH_ITEMS,
  allowSlashMenu,
  filterSlashItems,
  type SlashItem,
  type SlashItemContext,
} from '@/lib/tiptap/slash-items';

const slashPluginKey = new PluginKey('slashCommand');

const ICONS: Record<string, Icon> = {
  text: TextTIcon,
  h1: TextHOneIcon,
  h2: TextHTwoIcon,
  h3: TextHThreeIcon,
  'bullet-list': ListBulletsIcon,
  'numbered-list': ListNumbersIcon,
  task: CheckSquareIcon,
  quote: QuotesIcon,
  callout: InfoIcon,
  code: CodeBlockIcon,
  math: MathOperationsIcon,
  table: TableIcon,
  image: ImageSquareIcon,
  sparkle: SparkleIcon,
  divider: MinusIcon,
};

type MenuState = {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  clientRect: (() => DOMRect | null) | null;
};

/**
 * The "/" insert menu (Notion-style). Registers a @tiptap/suggestion plugin on
 * the live editor and renders the popup with the same look/positioning idiom
 * as the wiki-link picker in collab-editor.tsx. Items are plain data
 * (lib/tiptap/slash-items.ts); everything inserts through commands the top
 * menu bar already uses, so there's no codec impact.
 */
export function EditorSlashMenu({
  editor,
  pickImage,
  askSunny,
}: {
  editor: Editor;
  /** Present only when the surface can upload images (onImageDrop wired). */
  pickImage?: () => void;
  /** Present only when the surface can route "/ai …" to the agent. */
  askSunny?: SlashItemContext['askSunny'];
}) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [index, setIndex] = useState(0);
  // Bump to re-read clientRect() when the page scrolls/resizes under the menu.
  const [, setPositionTick] = useState(0);
  const menuRef = useRef<MenuState | null>(null);
  menuRef.current = menu;
  const indexRef = useRef(0);
  indexRef.current = index;
  const listRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const pickImageRef = useRef(pickImage);
  pickImageRef.current = pickImage;
  const askSunnyRef = useRef(askSunny);
  askSunnyRef.current = askSunny;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;

    let lastQuery: string | null = null;
    const open = (props: SuggestionProps<SlashItem, SlashItem>) => {
      setMenu({
        items: props.items,
        command: props.command,
        clientRect: props.clientRect ?? null,
      });
      if (props.query !== lastQuery) {
        // Query changed → re-ranked list, highlight returns to the top (cmdk
        // behavior). An unchanged query means a remote edit merely shifted the
        // range — keep the user's arrow-key position, just clamp it.
        lastQuery = props.query;
        setIndex(0);
      } else {
        setIndex((current) => Math.min(current, Math.max(props.items.length - 1, 0)));
      }
    };

    const plugin = Suggestion<SlashItem, SlashItem>({
      editor,
      pluginKey: slashPluginKey,
      char: '/',
      // Free-text "/ai fix the typos" needs the query to survive spaces —
      // the default exits the suggestion on the first space. Multi-word
      // queries that match nothing render no popup (items.length === 0), so
      // Enter/arrows pass through to the editor untouched.
      allowSpaces: true,
      items: ({ query }) =>
        filterSlashItems(SLASH_ITEMS, query, {
          hasImageUpload: !!pickImageRef.current,
          hasAskSunny: !!askSunnyRef.current,
        }),
      command: ({ editor: e, range, props: item }) =>
        item.run({ editor: e, range, pickImage: pickImageRef.current, askSunny: askSunnyRef.current }),
      allow: ({ state, range }) => editor.isEditable && allowSlashMenu(state, range.from),
      // The plugin activates POSITIONALLY — merely clicking the caret to just
      // after pre-existing text like `ls /code` would open the menu and steal
      // Enter/arrows. Only let a LOCAL doc change (the user typing) activate
      // it; the prev-active OR-arm keeps an already-open menu alive across
      // selection-only transactions (ArrowLeft/Right within the query,
      // awareness churn). `editor.state` inside apply() is still the
      // pre-transaction state, so this reads the previous active flag.
      shouldShow: ({ editor: e, transaction }) =>
        // Remote Yjs transactions carry the y-sync plugin meta (what
        // y-prosemirror's isChangeOrigin checks).
        (transaction.docChanged && !transaction.getMeta(ySyncPluginKey)) ||
        !!(slashPluginKey.getState(e.state) as { active?: boolean } | undefined)?.active,
      render: () => ({
        onStart: (props) => {
          lastQuery = null; // a fresh open always starts at the top
          open(props);
        },
        onUpdate: open,
        onExit: () => setMenu(null),
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          const current = menuRef.current;
          if (!current || current.items.length === 0) return false;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            setIndex((i) => (i + delta + current.items.length) % current.items.length);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const item = current.items[indexRef.current] ?? current.items[0];
            current.command(item);
            return true;
          }
          // Escape is handled by the suggestion plugin itself (dismisses and
          // fires onExit).
          return false;
        },
      }),
    });

    // PREPEND the plugin: registerPlugin default-appends, which puts the
    // suggestion's handleKeyDown AFTER every extension keymap — StarterKit's
    // Enter (splitBlock) would fire first and split the paragraph instead of
    // picking the highlighted item. First position only intercepts keys while
    // a suggestion is active. (Pinned by tests/ui/slash-menu.test.ts.)
    editor.registerPlugin(plugin, (newPlugin, plugins) => [newPlugin, ...plugins]);
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(slashPluginKey);
      setMenu(null);
    };
  }, [editor]);

  // Track the caret while the page scrolls/resizes (same idiom as the link
  // menu): the stored clientRect() re-measures, we just need a re-render.
  // Keyed on PRESENCE, not the menu object — `menu` is a fresh object per
  // keystroke, which would re-register the listeners on every typed char.
  const menuOpen = menu !== null;
  useEffect(() => {
    if (!menuOpen) return;
    const bump = () => setPositionTick((t) => t + 1);
    window.addEventListener('scroll', bump, { capture: true, passive: true });
    window.addEventListener('resize', bump);
    return () => {
      window.removeEventListener('scroll', bump, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', bump);
    };
  }, [menuOpen]);

  // Dismiss on a pointerdown outside both the popup and the editor. The popup
  // is rendered outside Tiptap's managed mount, so it has no built-in
  // outside-click dismissal, and clicking away (chat composer, sidebar)
  // dispatches no editor transaction — onExit never fires and the menu would
  // float over unrelated UI. Editor-internal clicks are left to the suggestion
  // plugin (a caret move out of range already deactivates it). Dispatch the
  // plugin's `exit` meta so its active state resets too, not just React's.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || popupRef.current?.contains(target)) return;
      if (editor.isDestroyed || editor.view.dom.contains(target)) return;
      editor.view.dispatch(editor.state.tr.setMeta(slashPluginKey, { exit: true }));
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () =>
      window.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
  }, [menuOpen, editor]);

  // Keep the highlighted item visible while arrow-keying through the list.
  useEffect(() => {
    const container = listRef.current;
    const active = container?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!container || !active) return;
    const itemTop = active.offsetTop;
    const itemBottom = itemTop + active.offsetHeight;
    if (itemTop < container.scrollTop) container.scrollTop = itemTop;
    else if (itemBottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = itemBottom - container.clientHeight;
    }
  }, [index]);

  if (!menu || menu.items.length === 0) return null;
  const rect = menu.clientRect?.();
  if (!rect) return null;

  // Flip above the caret when the list wouldn't fit below (max-h-80 = 320px
  // + padding) — otherwise a '/' typed near the viewport bottom renders the
  // menu below the fold.
  const flipUp = rect.bottom + 340 > window.innerHeight && rect.top > 340;

  return (
    <div
      ref={popupRef}
      role="listbox"
      data-testid="slash-menu"
      className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-stone-200 bg-white p-1.5 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
      style={{
        left: Math.min(rect.left, window.innerWidth - 304),
        ...(flipUp
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
      }}
    >
      <div ref={listRef} className="max-h-80 overflow-y-auto overscroll-contain">
        {menu.items.map((item, i) => {
          const ItemIcon = ICONS[item.icon] ?? TextTIcon;
          const active = i === index;
          return (
            <button
              key={item.title}
              type="button"
              role="option"
              aria-selected={active}
              className={[
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                // Keyboard-driven highlight + CSS-only hover (no onMouseEnter —
                // see the link menu for why: held arrow keys scroll the list
                // under a stationary cursor).
                active ? 'bg-stone-100' : 'hover:bg-stone-100/60',
              ].join(' ')}
              onMouseDown={(event) => {
                event.preventDefault();
                menu.command(item);
              }}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-600">
                <ItemIcon className="h-4 w-4" weight="regular" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-stone-800">
                  {item.title}
                </span>
                <span className="block truncate text-[11px] text-stone-500">
                  {item.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
