'use client';

import { useEffect, useState } from 'react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEditorState, type Editor } from '@tiptap/react';
import { isNodeSelection } from '@tiptap/core';
import {
  CaretDownIcon,
  ChatTeardropTextIcon,
  CodeIcon,
  ColumnsPlusRightIcon,
  HighlighterIcon,
  LinkSimpleIcon,
  RowsPlusBottomIcon,
  SparkleIcon,
  TextBIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
  TrashIcon,
} from '@phosphor-icons/react';

/* ── Selection bubble menu ────────────────────────────────────────────
 *  Floating format toolbar on text selection (v3 BubbleMenu, floating-ui).
 *  Pure UI layer over commands the top menu bar already exposes — no new
 *  node types, no codec impact. "Ask Sunny" opens the inline ask popup
 *  (`sundial:open-inline-ask` → editor-ask-input.tsx) with the selection as
 *  anchor context; the instruction is sent as a normal chat turn and replies
 *  come back as reviewable suggestions instead of a blind replace. Cmd-J
 *  still pins the selection to the chat composer for longer prompts.
 * ─────────────────────────────────────────────────────────────────── */

const BLOCK_OPTIONS: Array<{
  label: string;
  isActive: (editor: Editor) => boolean;
  apply: (editor: Editor) => void;
}> = [
  {
    label: 'Text',
    isActive: () => false, // fallback label; never highlighted explicitly
    apply: (e) => e.chain().focus().clearNodes().run(),
  },
  ...[1, 2, 3].map((level) => ({
    label: `Heading ${level}`,
    isActive: (e: Editor) => e.isActive('heading', { level }),
    apply: (e: Editor) => e.chain().focus().clearNodes().setNode('heading', { level }).run(),
  })),
  {
    label: 'Bullet list',
    isActive: (e) => e.isActive('bulletList'),
    apply: (e) => e.chain().focus().clearNodes().toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    isActive: (e) => e.isActive('orderedList'),
    apply: (e) => e.chain().focus().clearNodes().toggleOrderedList().run(),
  },
  {
    label: 'Quote',
    isActive: (e) => e.isActive('blockquote'),
    apply: (e) => e.chain().focus().clearNodes().toggleBlockquote().run(),
  },
  {
    label: 'Code',
    isActive: (e) => e.isActive('codeBlock'),
    apply: (e) => e.chain().focus().clearNodes().toggleCodeBlock().run(),
  },
];

const MARK_BUTTONS = [
  { key: 'bold', title: 'Bold (⌘B)', Icon: TextBIcon, toggle: (e: Editor) => e.chain().focus().toggleBold().run() },
  { key: 'italic', title: 'Italic (⌘I)', Icon: TextItalicIcon, toggle: (e: Editor) => e.chain().focus().toggleItalic().run() },
  { key: 'underline', title: 'Underline (⌘U)', Icon: TextUnderlineIcon, toggle: (e: Editor) => e.chain().focus().toggleUnderline().run() },
  { key: 'strike', title: 'Strikethrough', Icon: TextStrikethroughIcon, toggle: (e: Editor) => e.chain().focus().toggleStrike().run() },
  { key: 'code', title: 'Inline code', Icon: CodeIcon, toggle: (e: Editor) => e.chain().focus().toggleCode().run() },
  { key: 'highlight', title: 'Highlight', Icon: HighlighterIcon, toggle: (e: Editor) => e.chain().focus().toggleHighlight().run() },
] as const;

/** Exported for tests: the format bubble's visibility rule. */
export function shouldShowFormatBubble(editor: Editor): boolean {
  if (!editor.isEditable) return false;
  const { selection } = editor.state;
  if (selection.empty || isNodeSelection(selection)) return false;
  if (editor.isActive('image')) return false;
  // Whitespace-only drags (e.g. across a blank line) have nothing to format.
  // Bounded scan: a full textBetween would materialize the ENTIRE selection
  // (megabytes on select-all) on every debounced update.
  const { from, to } = selection;
  return editor.state.doc.textBetween(from, Math.min(to, from + 500)).trim().length > 0;
}

/** Keep `pluginKey`'s bubble glued to the doc while an inner column scrolls.
 *  The doc scrolls inside an inner column the BubbleMenu plugin never hears
 *  (its `scrollTarget` defaults to `window`). Tracking scroll from JS always
 *  trails the paint by a frame or two, which reads as the bar "lagging behind
 *  the page" — so the primary fix is CSS, not JS: the plugin appends the bar
 *  into the editor's wrapper (`view.dom.parentElement`), and EditorContent is
 *  rendered `relative`, making the bar's absolute coords resolve against the
 *  scrolled content itself. The browser then moves it WITH the doc, same
 *  frame, no listener. What's left for JS is the settle pass: flip/shift
 *  decisions are viewport-relative, so once scrolling goes quiet dispatch the
 *  plugin's documented `updatePosition` meta to let it re-clamp. Scroll
 *  events don't bubble but DO capture — one capture-phase window listener
 *  catches every scroll container; `visible` gates dispatch so ordinary
 *  scrolling (menu hidden) costs nothing. */
function useFollowEditorScroll(editor: Editor, pluginKey: string, visible: (editor: Editor) => boolean) {
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onScroll = (event: Event) => {
      if (editor.isDestroyed || !visible(editor)) return;
      // Only scrolls that move the editor itself — not the chat pane's, etc.
      if (!(event.target instanceof Node) || !event.target.contains(editor.view.dom)) return;
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        if (editor.isDestroyed) return;
        editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'updatePosition'));
      }, 80);
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      if (settle) clearTimeout(settle);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [editor, pluginKey, visible]);
}

// Shared constant so the selector's hidden-path result is referentially
// stable — useEditorState's deepEqual then costs one identity check.
const BUBBLE_HIDDEN = { marks: [] as boolean[], blockLabel: 'Text', inTable: false };

export function EditorBubbleMenu({
  editor,
  filePath,
  hiddenRef,
}: {
  editor: Editor;
  filePath: string | null;
  /** External veto (e.g. the link popover is open) read by shouldShow. A ref,
   *  not a prop value — remounting a BubbleMenu re-registers its ProseMirror
   *  plugin, which reconfigures the whole EditorState. */
  hiddenRef?: { current: unknown };
}) {
  const [typeOpen, setTypeOpen] = useState(false);
  useFollowEditorScroll(editor, 'formatBubbleMenu', shouldShowFormatBubble);
  const active = useEditorState({
    editor,
    // Runs on EVERY transaction (remote Yjs edits + awareness included), so
    // bail before the ~13 isActive() selection walks whenever the bubble
    // can't be visible — the 99% case while typing.
    selector: ({ editor: e }) => {
      const sel = e.state.selection;
      if (sel.empty || isNodeSelection(sel)) return BUBBLE_HIDDEN;
      return {
        marks: MARK_BUTTONS.map((b) => e.isActive(b.key)),
        blockLabel: BLOCK_OPTIONS.find((o) => o.isActive(e))?.label ?? 'Text',
        inTable: e.isActive('table'),
      };
    },
  });

  const askSunny = () => {
    const { state } = editor;
    const { from, to } = state.selection;
    const text = state.doc.textBetween(from, to, '\n', ' ').trim();
    if (!text) return;
    // Collapse FIRST: it hides this bubble (the click set the plugin's
    // preventHide, which swallows the blur-hide — Codex P2 on #778) and
    // parks the caret at the selection end, which is where the inline ask
    // popup anchors itself.
    editor.commands.setTextSelection(to);
    window.dispatchEvent(
      new CustomEvent('sundial:open-inline-ask', {
        // source scopes the popup to THIS editor — main + diff-review
        // editors can be mounted simultaneously.
        detail: { text, path: filePath, source: editor.view.dom },
      }),
    );
  };

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="formatBubbleMenu"
      updateDelay={150}
      shouldShow={({ editor: e }) => !hiddenRef?.current && shouldShowFormatBubble(e)}
      // onHide fires when the plugin hides the (still-mounted) element — the
      // dropdown must not survive into the next selection's bubble.
      options={{ placement: 'top', offset: 8, onHide: () => setTypeOpen(false) }}
    >
      <div
        data-testid="format-bubble-menu"
        className="flex items-center gap-0.5 rounded-xl border border-stone-200 bg-white p-1 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
        // Keep the editor's selection/focus alive for every control in here.
        onMouseDown={(event) => event.preventDefault()}
      >
        {/* No block conversions inside table cells: the markdown codec can't
            round-trip block nodes in cells (a heading degrades to literal
            "# text" on reload). Marks below stay available. */}
        {!active?.inTable && (
          <>
            <div className="relative">
              <button
                type="button"
                title="Turn into"
                onClick={() => setTypeOpen((open) => !open)}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] font-medium text-stone-700 transition-colors hover:bg-stone-100"
              >
                {active?.blockLabel ?? 'Text'}
                <CaretDownIcon className="h-3 w-3 text-stone-400" weight="bold" />
              </button>
              {typeOpen && (
                <div className="absolute left-0 top-full z-10 mt-1 min-w-[150px] rounded-xl border border-stone-200 bg-white p-1 shadow-[0_2px_8px_rgba(28,25,23,0.12)]">
                  {BLOCK_OPTIONS.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => {
                        option.apply(editor);
                        setTypeOpen(false);
                      }}
                      className={`block w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-stone-100 ${
                        option.label === active?.blockLabel ? 'font-semibold text-stone-900' : 'text-stone-700'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mx-0.5 h-4 w-px bg-stone-200" />
          </>
        )}
        {MARK_BUTTONS.map((button, i) => (
          <button
            key={button.key}
            type="button"
            title={button.title}
            onClick={() => button.toggle(editor)}
            className={`rounded-lg p-1.5 transition-colors ${
              active?.marks[i]
                ? 'bg-stone-100 text-stone-900'
                : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
            }`}
          >
            <button.Icon className="h-4 w-4" weight={active?.marks[i] ? 'bold' : 'regular'} />
          </button>
        ))}
        <button
          type="button"
          title="Add link (⌘K)"
          onClick={() => window.dispatchEvent(new Event('sundial:open-link-menu'))}
          className="rounded-lg p-1.5 text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
        >
          <LinkSimpleIcon className="h-4 w-4" weight="regular" />
        </button>
        <button
          type="button"
          title="Comment (⌘⌥M)"
          onClick={() => {
            // Cancelable: workspace-comments preventDefaults once the draft is
            // open, and collapsing the selection then hides this bubble so it
            // doesn't sit over the text while the composer has focus.
            const request = new CustomEvent('sundial:start-comment-draft', { cancelable: true });
            window.dispatchEvent(request);
            if (request.defaultPrevented) {
              editor.commands.setTextSelection(editor.state.selection.to);
            }
          }}
          className="rounded-lg p-1.5 text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
        >
          <ChatTeardropTextIcon className="h-4 w-4" weight="regular" />
        </button>
        <div className="mx-0.5 h-4 w-px bg-stone-200" />
        <button
          type="button"
          title="Ask Sunny to edit the selection (⌘J pins it to chat)"
          onClick={askSunny}
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] font-medium text-[#8a6d3b] transition-colors hover:bg-[#f7efe3]"
        >
          <SparkleIcon className="h-4 w-4" weight="fill" />
          Ask Sunny
        </button>
      </div>
    </BubbleMenu>
  );
}

/* ── Table controls ───────────────────────────────────────────────────
 *  Small floating bar when the caret sits in a table with nothing
 *  selected (a text selection shows the format bubble instead — the two
 *  never overlap). All commands come from @tiptap/extension-table.
 * ─────────────────────────────────────────────────────────────────── */

/** Exported for tests: the table bar's visibility rule. Runs synchronously on
 *  every transaction (the plugin's updateDelay only debounces non-empty
 *  selections, and this menu needs an EMPTY one) — so the cheap empty check
 *  bails first and the isActive('table') depth walk only runs for carets. */
export function shouldShowTableControls(editor: Editor): boolean {
  return editor.state.selection.empty && editor.isEditable && editor.isActive('table');
}

export function EditorTableControls({ editor }: { editor: Editor }) {
  useFollowEditorScroll(editor, 'tableControlsMenu', shouldShowTableControls);
  const run = (name: string) => {
    // Table commands are runtime-registered by the Table extension; mirror the
    // menu bar's cast instead of importing the extension for its types.
    const commands = editor.commands as unknown as Record<string, (() => boolean) | undefined>;
    editor.commands.focus();
    commands[name]?.();
  };

  const textButton = (label: string, title: string, command: string) => (
    <button
      type="button"
      title={title}
      onClick={() => run(command)}
      className="rounded-lg px-2 py-1 text-[12px] font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
    >
      {label}
    </button>
  );

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableControlsMenu"
      shouldShow={({ editor: e }) => shouldShowTableControls(e)}
      options={{ placement: 'top-start', offset: 8 }}
    >
      <div
        data-testid="table-controls-menu"
        className="flex items-center gap-0.5 rounded-xl border border-stone-200 bg-white p-1 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
        onMouseDown={(event) => event.preventDefault()}
      >
        <button
          type="button"
          title="Add row below"
          onClick={() => run('addRowAfter')}
          className="rounded-lg p-1.5 text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
        >
          <RowsPlusBottomIcon className="h-4 w-4" weight="regular" />
        </button>
        <button
          type="button"
          title="Add column right"
          onClick={() => run('addColumnAfter')}
          className="rounded-lg p-1.5 text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
        >
          <ColumnsPlusRightIcon className="h-4 w-4" weight="regular" />
        </button>
        <div className="mx-0.5 h-4 w-px bg-stone-200" />
        {textButton('− Row', 'Delete row', 'deleteRow')}
        {textButton('− Col', 'Delete column', 'deleteColumn')}
        {textButton('Header', 'Toggle header row', 'toggleHeaderRow')}
        <div className="mx-0.5 h-4 w-px bg-stone-200" />
        <button
          type="button"
          title="Delete table"
          onClick={() => run('deleteTable')}
          className="rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <TrashIcon className="h-4 w-4" weight="regular" />
        </button>
      </div>
    </BubbleMenu>
  );
}
