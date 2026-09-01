'use client';

import type { Editor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { CaretDownIcon, CaretUpIcon, XIcon } from '@phosphor-icons/react';

import { computeMatches, type FindMatch } from './find-matches';

type PluginState = {
  term: string;
  caseSensitive: boolean;
  decorations: DecorationSet;
  matches: FindMatch[];
  current: number;
};

const key = new PluginKey<PluginState>('findReplace');

function buildDecorations(doc: import('@tiptap/pm/model').Node, matches: FindMatch[], current: number) {
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === current ? 'fr-match fr-match-active' : 'fr-match',
    }),
  );
  return DecorationSet.create(doc, decos);
}

function createPlugin(onEscape: () => void) {
  return new Plugin<PluginState>({
    key,
    state: {
      init: () => ({
        term: '',
        caseSensitive: false,
        decorations: DecorationSet.empty,
        matches: [],
        current: -1,
      }),
      apply(tr, value) {
        const meta = tr.getMeta(key) as Partial<PluginState> | undefined;
        let next = value;
        if (meta) {
          next = { ...value, ...meta };
        }
        // Recompute on doc change or term/case change
        if (tr.docChanged || (meta && ('term' in meta || 'caseSensitive' in meta))) {
          const matches = computeMatches(tr.doc, next.term, next.caseSensitive);
          const current = matches.length === 0 ? -1 : Math.min(Math.max(next.current, 0), matches.length - 1);
          next = {
            ...next,
            matches,
            current,
            decorations: buildDecorations(tr.doc, matches, current),
          };
        } else if (meta && 'current' in meta) {
          next = { ...next, decorations: buildDecorations(tr.doc, next.matches, next.current) };
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        return key.getState(state)?.decorations ?? DecorationSet.empty;
      },
      // Escape with focus in the DOCUMENT closes the panel. Registered as a
      // ProseMirror handler (not a window listener) so precedence is exact:
      // editor overlays that claim Escape first (handleDOMEvents, keymaps)
      // stop it before it reaches this appended plugin — and a window
      // listener couldn't arbitrate anyway, since prosemirror-view
      // preventDefaults every Escape it sees (captureKeyDown).
      handleKeyDown(view, event) {
        if (event.key !== 'Escape') return false;
        onEscape();
        return true;
      },
    },
  });
}

/** The active decoration renders synchronously on dispatch, so querying it is
 *  the exact scroll target — no position math, no selection change. */
function scrollActiveMatchIntoView(editor: Editor) {
  editor.view.dom.querySelector('.fr-match-active')?.scrollIntoView({ block: 'center' });
}

const PANEL_WIDTH = 320;
const PANEL_INSET = 12;

/** The bar overlays the EDITOR PANE, and it must do so from wherever its owner
 *  happens to sit in the tree: the Docs menu bar and the IDE ⋮ menu mount it
 *  from two different pieces of chrome, and the IDE one lives inside an
 *  `absolute` 56px corner box — so a plain `absolute right-3 top-3` resolved
 *  against THAT and parked the bar off the left edge of the window, under the
 *  sidebar. Measure the editor's own scroll box and render `fixed` against it
 *  (portaled to the body) so no ancestor can re-base it. */
function resolveEditorPane(editor: Editor): HTMLElement {
  const dom = editor.view.dom as HTMLElement;
  // The pane IS the nearest scroll box: it's the one element whose bounds are
  // the visible document area (the ProseMirror node itself is as tall as the
  // whole doc). Standalone editors have none — anchor on the editor then.
  for (let node = dom.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/auto|scroll/.test(style.overflowY) || /auto|scroll/.test(style.overflowX)) return node;
  }
  return dom;
}

function useEditorPaneRect(editor: Editor) {
  // Measured on the FIRST render, not in an effect: the bar autofocuses its
  // query input on mount, and an unpositioned (hidden) first paint would have
  // nothing focusable to hand the caret to.
  const [rect, setRect] = useState(() => resolveEditorPane(editor).getBoundingClientRect());
  useEffect(() => {
    const pane = resolveEditorPane(editor);
    const measure = () => setRect(pane.getBoundingClientRect());
    measure();
    // Every reposition trigger here is a RESIZE of the pane: opening/collapsing
    // the sidebar or chat, splitting panes, zooming, resizing the window.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(pane);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [editor]);
  return rect;
}

type FindReplacePanelProps = {
  editor: Editor;
  readOnly: boolean;
  onClose: () => void;
  /** ⌘F opens the bare find bar; the ⋯ menu / ⌘⇧H add the replace controls. */
  showReplace?: boolean;
};

export function FindReplacePanel({ editor, readOnly, onClose, showReplace = false }: FindReplacePanelProps) {
  const [term, setTerm] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [counter, setCounter] = useState({ current: -1, total: 0 });
  const termInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const paneRect = useEditorPaneRect(editor);

  // Closing hands focus back to the document with the caret at the active
  // match (the browser-find convention; a caret, not a selection, so the
  // format bubble doesn't pop) WITHOUT scrolling: Tiptap's focus() default is
  // scrollIntoView, which would yank the pane back to the pre-search caret.
  // With no match nothing was navigated to, so scroll to the caret as before.
  // Plugin state is read BEFORE onClose unmounts the plugin.
  const close = () => {
    const match = editor.isDestroyed ? null : (() => {
      const pluginState = key.getState(editor.state);
      return pluginState?.matches[pluginState.current] ?? null;
    })();
    onClose();
    if (editor.isDestroyed) return;
    const chain = editor.chain();
    if (match) chain.setTextSelection(match.from);
    chain.focus(undefined, { scrollIntoView: !match }).run();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  const plugin = useMemo(() => createPlugin(() => closeRef.current()), []);

  useEffect(() => {
    editor.registerPlugin(plugin);
    termInputRef.current?.focus();
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // ⌘F while already open re-arms the bar: focus + select the query so
  // typing starts a fresh search (the browser-find convention). Escape here
  // covers only the panel's own controls; presses in the document go through
  // the plugin's handleKeyDown above, and presses on surfaces stacked over us
  // (document-actions dropdown, modals) belong to those surfaces — closing on
  // them would collapse two layers with one Escape.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const t = event.target;
        if (t instanceof Node && panelRef.current?.contains(t) && !event.defaultPrevented) closeRef.current();
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      termInputRef.current?.focus();
      termInputRef.current?.select();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Push term / caseSensitive into plugin state
  useEffect(() => {
    const tr = editor.state.tr.setMeta(key, { term, caseSensitive, current: 0 });
    editor.view.dispatch(tr);
    const pluginState = key.getState(editor.state);
    setCounter({
      current: pluginState?.matches.length ? 0 : -1,
      total: pluginState?.matches.length ?? 0,
    });
    if (pluginState?.matches.length) scrollActiveMatchIntoView(editor);
  }, [term, caseSensitive, editor]);

  // Keep counter in sync after doc changes
  useEffect(() => {
    const update = () => {
      const pluginState = key.getState(editor.state);
      setCounter({
        current: pluginState?.current ?? -1,
        total: pluginState?.matches.length ?? 0,
      });
    };
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  const step = (direction: 1 | -1) => {
    const pluginState = key.getState(editor.state);
    if (!pluginState || pluginState.matches.length === 0) return;
    const total = pluginState.matches.length;
    const nextCurrent = (pluginState.current + direction + total) % total;
    // Decoration-only: moving the editor's selection would steal focus from
    // the query input (the next Enter would type a newline into the doc) and
    // pop the formatting bubble menu over the match.
    editor.view.dispatch(editor.state.tr.setMeta(key, { current: nextCurrent }));
    scrollActiveMatchIntoView(editor);
  };

  const replaceOne = () => {
    if (readOnly) return;
    const pluginState = key.getState(editor.state);
    if (!pluginState || pluginState.matches.length === 0 || pluginState.current < 0) return;
    const match = pluginState.matches[pluginState.current];
    editor.chain().focus().insertContentAt({ from: match.from, to: match.to }, replacement).run();
  };

  const replaceAll = () => {
    if (readOnly) return;
    const pluginState = key.getState(editor.state);
    if (!pluginState || pluginState.matches.length === 0) return;
    // Replace from end to start so positions stay valid.
    const ordered = [...pluginState.matches].sort((a, b) => b.from - a.from);
    let chain = editor.chain().focus();
    for (const m of ordered) {
      chain = chain.insertContentAt({ from: m.from, to: m.to }, replacement);
    }
    chain.run();
  };

  const panel = (
    <div
      ref={panelRef}
      data-testid="find-replace-panel"
      className="fixed z-40 flex w-[320px] flex-col gap-2 rounded-lg border border-stone-200 bg-white p-3 text-[12px] text-stone-700 shadow-[0_8px_24px_-12px_rgba(28,25,23,0.35)]"
      style={{
        top: paneRect.top + PANEL_INSET,
        // Narrow panes (mobile, a tight split) can't seat the full width at
        // the inset — hug the pane's left edge instead of overflowing it.
        left: Math.max(paneRect.left, paneRect.right - PANEL_INSET - PANEL_WIDTH),
      }}
    >
      <div className="flex items-center gap-1">
        <input
          ref={termInputRef}
          type="text"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
          placeholder="Find"
          className="min-w-0 flex-1 rounded border border-stone-200 bg-white px-2 py-1 outline-none focus:border-stone-400"
        />
        <span
          data-testid="find-counter"
          className="min-w-[44px] text-right text-[11px] tabular-nums text-stone-400"
        >
          {counter.total === 0 ? '0/0' : `${counter.current + 1}/${counter.total}`}
        </span>
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label="Previous match"
          className="rounded p-1 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
        >
          <CaretUpIcon size={14} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          aria-label="Next match"
          className="rounded p-1 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
        >
          <CaretDownIcon size={14} weight="regular" aria-hidden />
        </button>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="rounded p-1 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
        >
          <XIcon size={14} weight="regular" aria-hidden />
        </button>
      </div>
      {showReplace && (
        <>
          {!readOnly && (
            <input
              type="text"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              placeholder="Replace"
              className="rounded border border-stone-200 bg-white px-2 py-1 outline-none focus:border-stone-400"
            />
          )}
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-stone-500">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(event) => setCaseSensitive(event.target.checked)}
              />
              Match case
            </label>
            {!readOnly && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={replaceOne}
                  disabled={counter.total === 0}
                  className="rounded border border-stone-200 bg-white px-2 py-1 text-[11px] text-stone-700 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
                >
                  Replace
                </button>
                <button
                  type="button"
                  onClick={replaceAll}
                  disabled={counter.total === 0}
                  className="rounded border border-stone-200 bg-stone-900 px-2 py-1 text-[11px] text-white transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300"
                >
                  Replace all
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return createPortal(panel, document.body);
}
