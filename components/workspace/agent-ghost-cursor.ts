import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export type GhostCursorBrand = {
  agentId: string;
  displayName: string;
  color: string;
  logoPath: string | null;
};

type GhostCursorState = Record<string, GhostCursorBrand>;

/** Plugin state: the active brands plus the DecorationSet derived from them.
 *  Caching the set means the doc walk runs only on brand or doc changes —
 *  not on every selection / awareness transaction. */
type GhostCursorPluginState = { brands: GhostCursorState; decorations: DecorationSet };

function buildGhostDecorations(doc: ProseMirrorNode, brands: GhostCursorState): DecorationSet {
  const list = Object.values(brands);
  if (list.length === 0) return DecorationSet.empty;
  // Find the position immediately AFTER the last text node — that's where a
  // human's caret would naturally sit after typing the last character. Using
  // doc.content.size places the widget past the doc's closing boundary, which
  // renders on a fresh empty line instead of at the end of the last sentence.
  let endPos = 0;
  doc.descendants((node, pos) => {
    if (node.isText && typeof node.text === 'string') {
      endPos = pos + node.text.length;
    }
    return true;
  });
  if (endPos === 0) {
    endPos = Math.max(0, doc.content.size - 1);
  }
  const container = document.createElement('span');
  container.className = 'sundial-agent-ghost-cursors';
  for (const brand of list) {
    container.appendChild(buildCaret(brand));
  }
  return DecorationSet.create(doc, [
    Decoration.widget(endPos, container, {
      side: 1,
      ignoreSelection: true,
      key: `agent-ghost-${list.map((b) => b.agentId).join('|')}`,
    }),
  ]);
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    agentGhostCursor: {
      /** Replace the set of active ghost cursors. Pass an empty record to clear. */
      setAgentGhostCursors: (brands: GhostCursorState) => ReturnType;
    };
  }
}

const KEY = new PluginKey<GhostCursorPluginState>('agent-ghost-cursor');

function buildCaret(brand: GhostCursorBrand): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'sundial-agent-ghost-cursor';
  wrapper.style.setProperty('--sundial-agent-color', brand.color);
  wrapper.dataset.agentId = brand.agentId;

  const caret = document.createElement('span');
  caret.className = 'sundial-agent-ghost-cursor__caret';
  wrapper.appendChild(caret);

  const label = document.createElement('span');
  label.className = 'sundial-agent-ghost-cursor__label';
  if (brand.logoPath) {
    const img = document.createElement('img');
    img.src = brand.logoPath;
    img.alt = '';
    img.className = 'sundial-agent-ghost-cursor__logo';
    label.appendChild(img);
  }
  const text = document.createElement('span');
  text.textContent = brand.displayName;
  label.appendChild(text);
  wrapper.appendChild(label);
  return wrapper;
}

/**
 * Renders a persistent caret + label at the end of the document for every
 * active local agent. State is driven from outside (presence Realtime in
 * collab-editor): one caret per agent whose `local_agent_presence` row is
 * fresh AND whose `last_edited_path` matches the current file. Cursor
 * survives switching files away and back because the presence ledger is
 * the source of truth — we just re-render on remount.
 */
export const AgentGhostCursor = Extension.create({
  name: 'agentGhostCursor',

  addProseMirrorPlugins() {
    return [
      new Plugin<GhostCursorPluginState>({
        key: KEY,
        state: {
          init: (_config: unknown, instance: EditorState): GhostCursorPluginState => ({
            brands: {},
            decorations: buildGhostDecorations(instance.doc, {}),
          }),
          apply(tr, value, _old, newState): GhostCursorPluginState {
            const meta = tr.getMeta(KEY) as GhostCursorState | undefined;
            if (meta !== undefined) {
              return { brands: meta, decorations: buildGhostDecorations(newState.doc, meta) };
            }
            if (tr.docChanged) {
              return { brands: value.brands, decorations: buildGhostDecorations(newState.doc, value.brands) };
            }
            return value;
          },
        },
        props: {
          decorations: (state) => KEY.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },

  addCommands() {
    return {
      setAgentGhostCursors:
        (brands) =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          dispatch(tr.setMeta(KEY, brands));
          return true;
        },
    };
  },
});
