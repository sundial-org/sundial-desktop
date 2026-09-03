'use client';

import { useCallback, useEffect, useState } from 'react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEditorState, type Editor } from '@tiptap/react';
import { isNodeSelection } from '@tiptap/core';
import {
  CaretDownIcon,
  ChatTeardropTextIcon,
  ColumnsPlusRightIcon,
  LinkSimpleIcon,
  MagicWandIcon,
  QuotesIcon,
  RowsPlusBottomIcon,
  SmileyIcon,
  TextBIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';
import { REACTION_EMOJIS } from '@/lib/workspace/doc-comments';
import { CALLOUT_TYPES, resolveCalloutType } from '@/lib/markdown/callout-types.mjs';
import { humanizeCalloutType } from '@/lib/markdown/parser.mjs';
import {
  activeCallout,
  removeCallout,
  setCalloutType,
  toggleCalloutFoldable,
} from '@/lib/tiptap/callout-commands';
import { SelectionActionControls } from '@/components/workspace/selection-action-controls';
import {
  INVOKE_SELECTION_ACTION_EVENT,
  MAX_SELECTION_ACTION_TEXT_CHARS,
  type WorkspaceSelectionAction,
} from '@/lib/assistants/selection-actions';
import { buildDraftDocCommentSelection } from '@/lib/workspace/doc-comments-client';
import {
  BUBBLE_LABEL_ACCENT,
  BUBBLE_SURFACE,
} from '@/components/workspace/selection-bubble-styles';

/* ── Selection bubble menu ────────────────────────────────────────────
 *  Floating toolbar on text selection (v3 BubbleMenu, floating-ui).
 *  Deliberately few actions — the full format palette lives in the top menu
 *  bar and made this bar a wall of glyphs. Pure UI layer over commands the
 *  menu bar already exposes — no new node types, no codec impact. The two
 *  labeled controls on the right are workspace-customizable assistant actions
 *  plus Comment. Assistant actions send the selected passage through the
 *  normal chat run (`sundial:add-chat-context`); Comment starts a draft. The inline ask popup
 *  (`sundial:open-inline-ask` → editor-ask-input.tsx) lives in the AI-tools
 *  flyout; its instruction is sent as a normal chat turn and replies come
 *  back as reviewable suggestions instead of a blind replace.
 * ─────────────────────────────────────────────────────────────────── */

/** Bounded whitespace scan: a full read would materialize the ENTIRE selection
 *  (megabytes on select-all) on every debounced update. Shared with the code
 *  editor's selection bubble so both surfaces agree on what's actionable. */
export const SELECTION_SAMPLE_LIMIT = 500;

/** Exported for tests: the format bubble's visibility rule. */
export function shouldShowFormatBubble(editor: Editor): boolean {
  if (!editor.isEditable) return false;
  const { selection } = editor.state;
  if (selection.empty || isNodeSelection(selection)) return false;
  if (editor.isActive('image')) return false;
  // Whitespace-only drags (e.g. across a blank line) have nothing to format.
  const { from, to } = selection;
  return (
    editor.state.doc.textBetween(from, Math.min(to, from + SELECTION_SAMPLE_LIMIT)).trim().length > 0
  );
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

const BUBBLE_BUTTON =
  'rounded-lg p-1.5 transition-colors text-stone-600 hover:bg-stone-100 hover:text-stone-900';
export function EditorBubbleMenu({
  editor,
  filePath,
  selectionActionsProjectId,
  hiddenRef,
}: {
  editor: Editor;
  filePath: string | null;
  /** Present only for a cloud workspace whose member has workspace-wide
   *  write access. File-scoped edit grants must not expose global actions. */
  selectionActionsProjectId?: string;
  /** External veto (e.g. the link popover is open) read by shouldShow. A ref,
   *  not a prop value — remounting a BubbleMenu re-registers its ProseMirror
   *  plugin, which reconfigures the whole EditorState. */
  hiddenRef?: { current: unknown };
}) {
  useFollowEditorScroll(editor, 'formatBubbleMenu', shouldShowFormatBubble);
  // Suggest-only users never see any of this: collab-editor mounts the bubble
  // menu only when !suggesting. Workspace-global assistant actions have their
  // own stricter capability: selectionActionsProjectId is absent for local,
  // scoped-edit, and workspace-wide suggest-only users.
  const boldActive = useEditorState({
    editor,
    // Runs on EVERY transaction (remote Yjs edits + awareness included), so
    // bail before the isActive() selection walk whenever the bubble can't be
    // visible — the 99% case while typing.
    selector: ({ editor: e }) => {
      const sel = e.state.selection;
      if (sel.empty || isNodeSelection(sel)) return false;
      return e.isActive('bold');
    },
  });

  // The anchor module (it drags the markdown codec along) stays out of the
  // editor's initial bundle: it loads once on mount and the Rewrite button
  // only renders when it's ready, so the click handler is fully SYNCHRONOUS —
  // no await between reading the selection and capturing it, hence no window
  // for the doc to change under un-mapped numeric positions.
  const [anchorModule, setAnchorModule] = useState<
    typeof import('@/lib/workspace/rewrite-anchor') | null
  >(null);
  useEffect(() => {
    let live = true;
    void import('@/lib/workspace/rewrite-anchor').then((module) => {
      if (live) setAnchorModule(module);
    });
    return () => {
      live = false;
    };
  }, []);

  // Capture the selection, collapse it (hides this bubble), and open one of
  // the AI popups. Shared by Rewrite and the AI-tools flyout — every popup
  // takes the same Yjs-anchored capture so applying survives concurrent
  // edits while its generation streams.
  const openWithCapture = useCallback(
    (eventName: string) => {
      if (!anchorModule) return;
      const capture = anchorModule.captureRewriteSelection(editor);
      if (!capture) return;
      editor.commands.setTextSelection(editor.state.selection.to);
      window.dispatchEvent(new CustomEvent(eventName, { detail: { capture, source: editor.view.dom } }));
    },
    [anchorModule, editor],
  );
  const reviewRewrites = () => openWithCapture('sundial:open-rewrite-review');

  // ⌘G / Ctrl-G opens the rewrite popup on the selection (Google Docs muscle
  // memory). Bound here rather than as a tiptap shortcut because the capture
  // needs `anchorModule`, which only this component preloads. Scoped to a
  // focused editor with a live selection, and preventDefault only on that
  // path — the browser's find-next stays intact everywhere else.
  useEffect(() => {
    if (!anchorModule) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'g' && event.key !== 'G') return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (editor.isDestroyed || !editor.view.hasFocus() || !shouldShowFormatBubble(editor)) return;
      event.preventDefault();
      event.stopPropagation();
      openWithCapture('sundial:open-rewrite-review');
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions);
  }, [anchorModule, editor, openWithCapture]);

  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [emojiMenuOpen, setEmojiMenuOpen] = useState(false);
  // Leaving the selection (bubble hides) must not leave a stale open flyout
  // for the next selection.
  useEffect(() => {
    if (!aiMenuOpen && !emojiMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest(
          '[data-testid="bubble-ai-menu"], [data-testid="bubble-ai-tools"], [data-testid="bubble-emoji-menu"], [data-testid="bubble-emoji-button"]',
        )
      ) {
        return;
      }
      setAiMenuOpen(false);
      setEmojiMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeOnOutside, { capture: true });
    return () =>
      window.removeEventListener('pointerdown', closeOnOutside, { capture: true } as EventListenerOptions);
  }, [aiMenuOpen, emojiMenuOpen]);

  // React with an emoji on the selection. The reaction rides the comment
  // pipeline (workspace-comments answers this event by posting a one-emoji
  // comment), so collapsing the selection on success hides this bubble and
  // reveals the chip that just landed after the words.
  const react = (emoji: string) => {
    setEmojiMenuOpen(false);
    const request = new CustomEvent('sundial:add-doc-reaction', {
      cancelable: true,
      // `source` scopes the reaction to THIS editor: a split pane mounts a
      // second bubble menu, and the listener anchors against the PRIMARY
      // editor — without this, reacting in a side pane would post against
      // whatever the primary still had selected, in the wrong file.
      detail: { emoji, source: editor.view.dom },
    });
    window.dispatchEvent(request);
    if (request.defaultPrevented) editor.commands.setTextSelection(editor.state.selection.to);
  };

  const AI_TOOLS: { label: string; event: string; testId: string }[] = [
    { label: 'Tune', event: 'sundial:open-prism', testId: 'ai-tool-prism' },
    { label: 'Resize', event: 'sundial:open-length-resize', testId: 'ai-tool-resize' },
    { label: 'AI detection', event: 'sundial:open-pangram', testId: 'ai-tool-pangram' },
  ];

  // Collapse FIRST: it hides this bubble (the click set the plugin's
  // preventHide, which swallows the blur-hide — Codex P2 on #778) and
  // parks the caret at the selection end, which is where the inline ask
  // popup anchors itself.
  const collapseSelectionText = () => {
    const { state } = editor;
    const { from, to } = state.selection;
    const text = state.doc.textBetween(from, to, '\n', ' ').trim();
    if (text) editor.commands.setTextSelection(to);
    return text;
  };

  const askSunny = () => {
    const text = collapseSelectionText();
    if (!text) return;
    window.dispatchEvent(
      new CustomEvent('sundial:open-inline-ask', {
        // source scopes the popup to THIS editor — main + diff-review
        // editors can be mounted simultaneously.
        detail: { text, path: filePath, source: editor.view.dom },
      }),
    );
  };

  const invokeSelectionAction = (action: WorkspaceSelectionAction) => {
    const { from, to } = editor.state.selection;
    const tooLong = to - from > MAX_SELECTION_ACTION_TEXT_CHARS;
    const text = tooLong
      ? ''
      : editor.state.doc.textBetween(from, to, '\n', ' ').trim();
    const selection = tooLong ? null : buildDraftDocCommentSelection(editor);
    editor.commands.setTextSelection(to);
    if ((!text || !selection) && !tooLong) return;
    window.dispatchEvent(
      new CustomEvent(INVOKE_SELECTION_ACTION_EVENT, {
        detail: {
          action: {
            id: action.id,
            label: action.label,
            title: action.title,
            assistant_slug: action.assistant_slug,
            assistant_name: action.assistant_name,
          },
          text,
          too_long: tooLong || undefined,
          path: filePath,
          selection: selection ?? undefined,
        },
      }),
    );
  };

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="formatBubbleMenu"
      updateDelay={150}
      shouldShow={({ editor: e }) => !hiddenRef?.current && shouldShowFormatBubble(e)}
      options={{ placement: 'top', offset: 8 }}
    >
      <div
        data-testid="format-bubble-menu"
        className={BUBBLE_SURFACE}
        // Keep the editor's selection/focus alive for every control in here.
        onMouseDown={(event) => event.preventDefault()}
      >
        {/* Tooltips render ABOVE the bar (side="top"): the bubble already sits
            over the selection, and IconTooltip flips to below on its own when
            the bar is near the viewport top. */}
        <button
          type="button"
          aria-label="Bold ⌘B"
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={
            boldActive ? 'rounded-lg p-1.5 transition-colors bg-stone-100 text-stone-900' : BUBBLE_BUTTON
          }
        >
          <TextBIcon className="h-4 w-4" weight={boldActive ? 'bold' : 'regular'} />
          <IconTooltip label="Bold ⌘B" side="top" />
        </button>
        <button
          type="button"
          aria-label="Insert link ⌘K"
          onClick={() => window.dispatchEvent(new Event('sundial:open-link-menu'))}
          className={BUBBLE_BUTTON}
        >
          <LinkSimpleIcon className="h-4 w-4" weight="regular" />
          <IconTooltip label="Insert link ⌘K" side="top" />
        </button>
        <div className="mx-0.5 h-4 w-px bg-stone-200" />
        {anchorModule !== null && (
          <button
            type="button"
            aria-label="Rewrite the selection ⌘G (four variants)"
            onClick={reviewRewrites}
            className={BUBBLE_BUTTON}
            data-testid="bubble-rewrite-button"
          >
            <MagicWandIcon className="h-4 w-4" weight="regular" />
            <IconTooltip label="Rewrite ⌘G · pick from four variants" side="top" />
          </button>
        )}
        {/* NOT gated on anchorModule: "Ask agent" doesn't need the capture
            module, and gating it made the inline ask unreachable while (or if
            ever) the lazy rewrite-anchor chunk isn't loaded. Only the
            capture-based tools inside are gated. */}
        <div className="relative">
          <button
            type="button"
            aria-label="More AI tools"
            aria-expanded={aiMenuOpen}
            onClick={() => setAiMenuOpen((open) => !open)}
            className={aiMenuOpen ? 'rounded-lg p-1.5 transition-colors bg-stone-100 text-stone-900' : BUBBLE_BUTTON}
            data-testid="bubble-ai-tools"
          >
            <CaretDownIcon className="h-3.5 w-3.5" weight="regular" />
            <IconTooltip label="More AI tools" side="top" />
          </button>
          {aiMenuOpen && (
            <div
              role="menu"
              data-testid="bubble-ai-menu"
              className="absolute left-0 top-full z-10 mt-1.5 w-36 rounded-xl border border-stone-200 bg-white p-1 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
            >
              <button
                type="button"
                role="menuitem"
                data-testid="ai-tool-ask"
                onClick={() => {
                  setAiMenuOpen(false);
                  askSunny();
                }}
                className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] font-medium text-stone-700 transition-colors hover:bg-stone-100"
              >
                Ask agent
              </button>
              {anchorModule !== null &&
                AI_TOOLS.map((tool) => (
                  <button
                    key={tool.event}
                    type="button"
                    role="menuitem"
                    data-testid={tool.testId}
                    onClick={() => {
                      setAiMenuOpen(false);
                      openWithCapture(tool.event);
                    }}
                    className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] font-medium text-stone-700 transition-colors hover:bg-stone-100"
                  >
                    {tool.label}
                  </button>
                ))}
            </div>
          )}
        </div>
        <div className="relative">
          <button
            type="button"
            aria-label="React with an emoji"
            aria-expanded={emojiMenuOpen}
            data-testid="bubble-emoji-button"
            onClick={() => setEmojiMenuOpen((open) => !open)}
            className={
              emojiMenuOpen ? 'rounded-lg p-1.5 transition-colors bg-stone-100 text-stone-900' : BUBBLE_BUTTON
            }
          >
            <SmileyIcon className="h-4 w-4" weight="regular" />
            <IconTooltip label="React with an emoji" side="top" />
          </button>
          {emojiMenuOpen && (
            <div
              role="menu"
              aria-label="React with an emoji"
              data-testid="bubble-emoji-menu"
              className="absolute left-0 top-full z-10 mt-1.5 flex items-center gap-0.5 rounded-xl border border-stone-200 bg-white p-1 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
            >
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  aria-label={`React ${emoji}`}
                  data-testid={`bubble-emoji-${emoji}`}
                  onClick={() => react(emoji)}
                  className="rounded-lg px-1.5 py-1 text-[15px] leading-none transition-colors hover:bg-stone-100"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mx-0.5 h-4 w-px bg-stone-200" />
        {selectionActionsProjectId ? (
          <SelectionActionControls
            projectId={selectionActionsProjectId}
            onInvoke={invokeSelectionAction}
          />
        ) : null}
        <button
          type="button"
          aria-label="Comment on selection ⌘⌥M"
          className={BUBBLE_LABEL_ACCENT}
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
        >
          <ChatTeardropTextIcon className="h-4 w-4" weight="fill" />
          Comment
          <IconTooltip label="Comment on selection ⌘⌥M" side="top" />
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
    editor.commands.focus(undefined, { scrollIntoView: false });
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

/* ── Callout controls ─────────────────────────────────────────────────
 *  Small floating bar when the caret sits in a callout with nothing
 *  selected — same idiom as the table controls above (a text selection shows
 *  the format bubble instead, so the three never overlap).
 *
 *  Every action is an attribute edit on the existing blockquote
 *  (lib/tiptap/callout-commands.ts): the type picker, the `-`/`+` fold marker
 *  and "turn into quote" all keep the callout's content — and its
 *  collaborators' positions — intact. The type swatches paint the SAME
 *  `--sd-callout-icon` mask the callouts themselves use, so the menu always
 *  shows exactly what you'll get.
 * ─────────────────────────────────────────────────────────────────── */

/** Exported for tests: the callout bar's visibility rule. Mirrors the table
 *  bar's cheap-check-first shape — empty selection, then the ancestor walk.
 *  Inside a table the table bar wins, so the two can never stack. */
export function shouldShowCalloutControls(editor: Editor): boolean {
  return (
    editor.state.selection.empty &&
    editor.isEditable &&
    !editor.isActive('table') &&
    !!activeCallout(editor.state)
  );
}

export function EditorCalloutControls({ editor }: { editor: Editor }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  useFollowEditorScroll(editor, 'calloutControlsMenu', shouldShowCalloutControls);

  const callout = useEditorState({
    editor,
    // Runs on EVERY transaction — bail before the ancestor walk whenever the bar
    // can't be visible, which is the whole time you're typing outside a callout.
    selector: ({ editor: e }) => {
      if (!e.state.selection.empty) return null;
      const active = activeCallout(e.state);
      if (!active) return null;
      return {
        type: String(active.node.attrs.calloutType),
        foldable: !!active.node.attrs.calloutFoldable,
      };
    },
    // Without this the selector's fresh object re-renders the bar on every
    // keystroke and every remote edit.
    equalityFn: (a, b) => a?.type === b?.type && a?.foldable === b?.foldable,
  });

  // Leaving a callout (or landing on another) must not inherit an open picker.
  useEffect(() => {
    if (!callout) setPickerOpen(false);
  }, [callout]);

  // Re-place the bar AFTER its contents render. floating-ui positions a `top`
  // placement by subtracting the bar's own height from the reference — and the
  // plugin measures during the same transaction that reveals the bar, while the
  // contents below are still unmounted and the height is 0. The bar then landed
  // with its TOP where its bottom belonged and grew down over the line you were
  // typing on (intermittently: it was correct whenever the contents happened to
  // be mounted already). Re-running the plugin's documented reposition once the
  // real height exists is the fix.
  useEffect(() => {
    if (!callout || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta('calloutControlsMenu', 'updatePosition'));
  }, [callout, pickerOpen, editor]);

  const resolved = callout && resolveCalloutType(callout.type);
  const swatch = (type: string) => {
    const canonical = resolveCalloutType(type);
    return (
      <span
        aria-hidden
        className="sd-callout-icon h-4 w-4"
        data-callout={type}
        {...(canonical ? { 'data-callout-resolved': canonical } : {})}
      />
    );
  };

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="calloutControlsMenu"
      shouldShow={({ editor: e }) => shouldShowCalloutControls(e)}
      // Anchored to the CALLOUT, not the caret (the plugin's default). The bar
      // then sits above the block's own top edge instead of wherever you happen
      // to be typing — it can't cover the text, and it stays put as the caret
      // moves through the callout instead of chasing it line to line.
      getReferencedVirtualElement={() => {
        const active = activeCallout(editor.state);
        const dom = active && editor.view.nodeDOM(active.pos);
        if (!(dom instanceof HTMLElement)) return null;
        return {
          getBoundingClientRect: () => dom.getBoundingClientRect(),
          getClientRects: () => [dom.getBoundingClientRect()],
        };
      }}
      options={{ placement: 'top-start', offset: 8 }}
    >
      {/* The BubbleMenu is mounted unconditionally: remounting one re-registers
          its ProseMirror plugin (reconfiguring the whole EditorState), and a
          menu that only mounts once its content exists never gets the chance to
          show. `shouldShow` alone decides visibility. */}
      {callout && (
        <div
          data-testid="callout-controls-menu"
          className="relative flex items-center gap-0.5 rounded-xl border border-stone-200 bg-white p-1 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
          // Keep the caret — and so the bar itself — put while clicking.
          onMouseDown={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && pickerOpen) {
              event.stopPropagation();
              setPickerOpen(false);
            }
          }}
        >
          <button
            type="button"
            // The button's TEXT is the current type, so it needs an explicit
            // label to stay findable (by users and by tests) as the type changes.
            aria-label={`Callout type: ${humanizeCalloutType(callout.type)}`}
            title="Callout type"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
          >
            {swatch(callout.type)}
            {humanizeCalloutType(callout.type)}
            <CaretDownIcon className="h-3 w-3" weight="regular" />
          </button>
          <div className="mx-0.5 h-4 w-px bg-stone-200" />
          <button
            type="button"
            aria-label="Foldable"
            title={callout.foldable ? 'Not foldable' : 'Make foldable'}
            aria-pressed={callout.foldable}
            onClick={() => toggleCalloutFoldable(editor)}
            className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors hover:bg-stone-100 hover:text-stone-900 ${
              callout.foldable ? 'bg-stone-100 text-stone-900' : 'text-stone-600'
            }`}
          >
            {/* No glyph: a caret here read as "opens a menu" when this is a
                toggle. The pressed background is the state. */}
            Foldable
          </button>
          <div className="mx-0.5 h-4 w-px bg-stone-200" />
          <button
            type="button"
            aria-label="Turn into a plain quote"
            title="Turn into a plain quote"
            onClick={() => removeCallout(editor)}
            className="rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
          >
            <QuotesIcon className="h-4 w-4" weight="regular" />
          </button>

          {pickerOpen && (
            <div
              role="listbox"
              aria-label="Callout type"
              data-testid="callout-type-picker"
              className="absolute left-0 top-full z-10 mt-1 grid w-[17rem] grid-cols-2 gap-0.5 rounded-xl border border-stone-200 bg-white p-1 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
            >
              {CALLOUT_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  role="option"
                  aria-selected={type === resolved}
                  onClick={() => {
                    setCalloutType(editor, type);
                    setPickerOpen(false);
                  }}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1 text-left text-[12px] font-medium transition-colors hover:bg-stone-100 hover:text-stone-900 ${
                    type === resolved ? 'bg-stone-100 text-stone-900' : 'text-stone-600'
                  }`}
                >
                  {swatch(type)}
                  {humanizeCalloutType(type)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </BubbleMenu>
  );
}
