'use client';

import type { Editor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { CaretDownIcon, CaretUpIcon, XIcon } from '@phosphor-icons/react';

type PluginState = {
  term: string;
  caseSensitive: boolean;
  decorations: DecorationSet;
  matches: { from: number; to: number }[];
  current: number;
};

const key = new PluginKey<PluginState>('findReplace');

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function computeMatches(doc: import('@tiptap/pm/model').Node, term: string, caseSensitive: boolean) {
  const matches: { from: number; to: number }[] = [];
  if (!term) return matches;
  const re = new RegExp(escapeRegExp(term), caseSensitive ? 'g' : 'gi');
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(node.text)) !== null) {
      matches.push({ from: pos + m.index, to: pos + m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  });
  return matches;
}

function buildDecorations(doc: import('@tiptap/pm/model').Node, matches: { from: number; to: number }[], current: number) {
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === current ? 'fr-match fr-match-active' : 'fr-match',
    }),
  );
  return DecorationSet.create(doc, decos);
}

function createPlugin() {
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
    },
  });
}

type FindReplacePanelProps = {
  editor: Editor;
  readOnly: boolean;
  onClose: () => void;
};

export function FindReplacePanel({ editor, readOnly, onClose }: FindReplacePanelProps) {
  const [term, setTerm] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [counter, setCounter] = useState({ current: -1, total: 0 });
  const termInputRef = useRef<HTMLInputElement>(null);

  const plugin = useMemo(() => createPlugin(), []);

  useEffect(() => {
    editor.registerPlugin(plugin);
    termInputRef.current?.focus();
    return () => {
      editor.unregisterPlugin(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Push term / caseSensitive into plugin state
  useEffect(() => {
    const tr = editor.state.tr.setMeta(key, { term, caseSensitive, current: 0 });
    editor.view.dispatch(tr);
    const pluginState = key.getState(editor.state);
    setCounter({
      current: pluginState?.matches.length ? 0 : -1,
      total: pluginState?.matches.length ?? 0,
    });
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
    const match = pluginState.matches[nextCurrent];
    editor.view.dispatch(editor.state.tr.setMeta(key, { current: nextCurrent }));
    editor
      .chain()
      .focus()
      .setTextSelection({ from: match.from, to: match.to })
      .scrollIntoView()
      .run();
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

  return (
    <div
      data-testid="find-replace-panel"
      className="absolute right-3 top-3 z-40 flex w-[320px] flex-col gap-2 rounded-lg border border-stone-200 bg-white p-3 text-[12px] text-stone-700 shadow-[0_8px_24px_-12px_rgba(28,25,23,0.35)]"
    >
      <div className="flex items-center gap-2">
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
              onClose();
            }
          }}
          placeholder="Find"
          className="flex-1 rounded border border-stone-200 bg-white px-2 py-1 outline-none focus:border-stone-400"
        />
        <span className="min-w-[44px] text-right text-[11px] tabular-nums text-stone-400">
          {counter.total === 0 ? '0/0' : `${counter.current + 1}/${counter.total}`}
        </span>
      </div>
      {!readOnly && (
        <input
          type="text"
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
          placeholder="Replace"
          className="rounded border border-stone-200 bg-white px-2 py-1 outline-none focus:border-stone-400"
        />
      )}
      <div className="flex items-center justify-between gap-1">
        <label className="flex items-center gap-1.5 text-[11px] text-stone-500">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => setCaseSensitive(event.target.checked)}
          />
          Match case
        </label>
        <div className="flex items-center gap-0.5">
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
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            <XIcon size={14} weight="regular" aria-hidden />
          </button>
        </div>
      </div>
      {!readOnly && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={replaceOne}
            disabled={counter.total === 0}
            className="flex-1 rounded border border-stone-200 bg-white px-2 py-1 text-[11px] text-stone-700 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
          >
            Replace
          </button>
          <button
            type="button"
            onClick={replaceAll}
            disabled={counter.total === 0}
            className="flex-1 rounded border border-stone-200 bg-stone-900 px-2 py-1 text-[11px] text-white transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
