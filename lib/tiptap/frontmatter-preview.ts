import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { parse as parseYaml } from 'yaml';
import { nodeHasPendingSuggestion } from '@/lib/workspace/suggestion-marks';

/**
 * Obsidian-style read-only Properties view for the frontmatter node, following
 * the MermaidPreview convention: when the selection is outside the block the
 * rendered key/value grid shows in place of the raw YAML; putting the cursor
 * inside (or clicking a row) reveals the raw text for editing. The document is
 * NEVER touched — the YAML is parsed for DISPLAY ONLY and never re-serialized,
 * so the byte-for-byte round-trip and text diffs are unaffected. Editing by
 * widget (typed keys, "+ Add property") is a later project.
 *
 * Invalid YAML (or a non-mapping document) keeps the raw block visible with an
 * error badge, mirroring a broken mermaid fence. A block carrying a pending
 * suggestion also stays raw so review reads as text.
 */

export type FrontmatterProperty = {
  key: string;
  kind: 'text' | 'number' | 'checkbox' | 'date' | 'list' | 'raw';
  /** Display string for text/number/date/raw kinds. */
  value: string;
  checked?: boolean;
  items?: string[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;
const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * Raw frontmatter node text (fences included) → display rows, or null when the
 * fences are broken or the inner YAML doesn't parse to a mapping (then the raw
 * block stays visible). Empty frontmatter parses to []. Pure — exported for
 * tests.
 */
export function parseFrontmatterProperties(nodeText: string): FrontmatterProperty[] | null {
  const lines = (nodeText ?? '').split('\n');
  // A raw edit can break a fence while the node is still a `frontmatter` node
  // (reparse only happens later): require both fences — matching the parser's
  // rules — before hiding the text behind the preview, or a block that will
  // reload as HR + prose would render as settled properties.
  if (lines.length < 2 || lines[0] !== '---' || !/^---\s*$/.test(lines[lines.length - 1])) return null;
  const inner = lines.slice(1, -1).join('\n');
  if (!inner.trim()) return [];
  let data: unknown;
  try {
    data = parseYaml(inner);
  } catch {
    return null;
  }
  if (data == null) return [];
  if (typeof data !== 'object' || Array.isArray(data)) return null;

  const rows: FrontmatterProperty[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'boolean') {
      rows.push({ key, kind: 'checkbox', value: String(value), checked: value });
    } else if (typeof value === 'number') {
      rows.push({ key, kind: 'number', value: String(value) });
    } else if (typeof value === 'string' && DATE_RE.test(value)) {
      rows.push({ key, kind: 'date', value });
    } else if (typeof value === 'string' || value == null) {
      rows.push({ key, kind: 'text', value: value ?? '' });
    } else if (Array.isArray(value) && value.every(isScalar)) {
      rows.push({ key, kind: 'list', value: '', items: value.map(String) });
    } else {
      // Nested mapping / mixed array — no widget over-promise, show a compact
      // inline form; the real text is one click away. A cyclic value (YAML
      // anchor referencing itself) makes JSON.stringify throw — fall back to
      // the raw view rather than blowing up decoration building.
      try {
        rows.push({ key, kind: 'raw', value: JSON.stringify(value) });
      } catch {
        return null;
      }
    }
  }
  return rows;
}

// Minimal inline stroke icons (lucide-style paths, 24×24 viewBox).
const ICON_PATHS: Record<string, string> = {
  text: 'M3 6h18M3 12h12M3 18h15',
  number: 'M4 9h16M4 15h16M10 3L8 21M16 3l-2 18',
  date: 'M8 2v4M16 2v4M3 8h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  checkbox: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  raw: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1',
  tag: 'M12 2H2v10l9.3 9.3a2 2 0 0 0 2.8 0l7.2-7.2a2 2 0 0 0 0-2.8L12 2zM7 7h.01',
  alias: 'M15 14l5-5-5-5M4 20v-7a4 4 0 0 1 4-4h12',
};

function iconFor(row: FrontmatterProperty): string {
  if (row.key === 'tags') return 'tag';
  if (row.key === 'aliases') return 'alias';
  return row.kind === 'text' ? 'text' : row.kind;
}

function iconEl(name: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name] ?? ICON_PATHS.text);
  svg.appendChild(path);
  return svg;
}

type BlockSnapshot = { pos: number; end: number; editing: boolean };
type PluginState = { decorations: DecorationSet; blocks: BlockSnapshot[] };

const selectionTouches = (selection: Selection, from: number, to: number) =>
  selection.from <= to && selection.to >= from;

function findFrontmatterBlocks(doc: ProseMirrorNode) {
  const blocks: { pos: number; end: number; node: ProseMirrorNode; source: string }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'frontmatter') return;
    blocks.push({ pos, end: pos + node.nodeSize, node, source: node.textContent });
    return false;
  });
  return blocks;
}

export const frontmatterPreviewKey = new PluginKey<PluginState>('frontmatterPreview');

const FrontmatterPreviewPlugin = ({ editor }: { editor: Editor }) => {
  let view: EditorView | null = null;
  // One collapse flag per editor: a doc has at most one real frontmatter block
  // (parser: file start only), so per-node bookkeeping isn't worth remapping.
  let collapsed = false;

  const repaint = () => {
    if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(frontmatterPreviewKey, true));
  };

  const buildPreviewEl =
    (rows: FrontmatterProperty[]) => (_view: EditorView, getPos: () => number | undefined) => {
      const root = document.createElement('div');
      root.className = 'sd-frontmatter-preview';
      root.contentEditable = 'false';

      const enterEdit = (event: MouseEvent) => {
        const pos = getPos();
        if (view == null || view.isDestroyed || !editor.isEditable || pos == null) return;
        event.preventDefault();
        const { doc } = view.state;
        const $inside = doc.resolve(Math.min(pos + 1, doc.content.size));
        view.dispatch(view.state.tr.setSelection(TextSelection.near($inside)));
        view.focus();
      };

      const header = document.createElement('div');
      header.className = 'sd-fm-header';
      const chevron = iconEl('text');
      chevron.querySelector('path')?.setAttribute('d', 'M9 18l6-6-6-6');
      chevron.classList.add('sd-fm-chevron');
      const label = document.createElement('span');
      label.textContent = collapsed && rows.length > 0 ? `Properties · ${rows.length}` : 'Properties';
      header.append(chevron, label);
      header.addEventListener('mousedown', (event) => {
        event.preventDefault();
        collapsed = !collapsed;
        repaint();
      });
      root.appendChild(header);
      if (collapsed) {
        root.classList.add('sd-fm-collapsed');
        return root;
      }

      const body = document.createElement('div');
      body.className = 'sd-fm-body';
      body.addEventListener('mousedown', enterEdit);
      if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sd-fm-empty';
        empty.textContent = 'no properties';
        body.appendChild(empty);
      }
      for (const row of rows) {
        const keyEl = document.createElement('div');
        keyEl.className = 'sd-fm-key';
        const keyText = document.createElement('span');
        keyText.textContent = row.key;
        keyEl.append(iconEl(iconFor(row)), keyText);

        const valueEl = document.createElement('div');
        valueEl.className = 'sd-fm-value';
        if (row.kind === 'list') {
          for (const item of row.items ?? []) {
            const pill = document.createElement('span');
            pill.className = 'sd-fm-pill';
            pill.textContent = item;
            valueEl.appendChild(pill);
          }
        } else if (row.kind === 'checkbox') {
          const box = document.createElement('span');
          box.className = 'sd-fm-checkbox';
          if (row.checked) box.setAttribute('data-checked', 'true');
          valueEl.appendChild(box);
        } else if (row.kind === 'raw') {
          const code = document.createElement('code');
          code.textContent = row.value;
          valueEl.appendChild(code);
        } else {
          valueEl.textContent = row.value;
        }
        body.append(keyEl, valueEl);
      }
      root.appendChild(body);
      return root;
    };

  const build = (state: EditorState): PluginState => {
    const blocks = findFrontmatterBlocks(state.doc);
    if (blocks.length === 0) return { decorations: DecorationSet.empty, blocks: [] };

    const decos: Decoration[] = [];
    const snapshots: BlockSnapshot[] = [];
    // Focus-gated, unlike mermaid: a freshly opened doc's initial selection
    // sits at doc start — INSIDE a first-block frontmatter — so without the
    // gate every note would open on raw YAML until the first click.
    const focused = view?.hasFocus() ?? false;
    for (const { pos, end, node, source } of blocks) {
      const editing = editor.isEditable && focused && selectionTouches(state.selection, pos, end);
      snapshots.push({ pos, end, editing });
      if (nodeHasPendingSuggestion(node)) continue;
      const rows = parseFrontmatterProperties(source);
      if (rows === null) {
        decos.push(Decoration.node(pos, end, { class: 'sd-frontmatter-invalid' }));
        continue;
      }
      if (editing) continue;
      decos.push(Decoration.node(pos, end, { class: 'sd-frontmatter-source-hidden' }));
      decos.push(
        Decoration.widget(pos, buildPreviewEl(rows), {
          key: `sd-frontmatter:${pos}:${collapsed ? 'c' : 'o'}:${source}`,
          side: -1,
        }),
      );
    }
    return { decorations: DecorationSet.create(state.doc, decos), blocks: snapshots };
  };

  return new Plugin<PluginState>({
    key: frontmatterPreviewKey,
    state: {
      init: (_config, state) => build(state),
      apply(tr, previous, _old, newState) {
        if (!tr.docChanged && !tr.getMeta(frontmatterPreviewKey)) {
          if (!tr.selectionSet || previous.blocks.length === 0) return previous;
          const canEdit = editor.isEditable && (view?.hasFocus() ?? false);
          const unchanged = previous.blocks.every(
            (b) => (canEdit && selectionTouches(newState.selection, b.pos, b.end)) === b.editing,
          );
          if (unchanged) return previous;
        }
        return build(newState);
      },
    },
    view(editorView: EditorView) {
      view = editorView;
      // Focus flips don't dispatch transactions; neither does setEditable().
      // Repaint on both so the editing reveal (focus-gated above) recomputes —
      // blurring the editor snaps the block back to the Properties view.
      const onFocusChange = () => repaint();
      editorView.dom.addEventListener('focus', onFocusChange);
      editorView.dom.addEventListener('blur', onFocusChange);
      let lastEditable = editor.isEditable;
      return {
        update: (v: EditorView) => {
          if (v.editable !== lastEditable) {
            lastEditable = v.editable;
            repaint();
          }
        },
        destroy: () => {
          editorView.dom.removeEventListener('focus', onFocusChange);
          editorView.dom.removeEventListener('blur', onFocusChange);
          view = null;
        },
      };
    },
    props: {
      decorations(state: EditorState) {
        return frontmatterPreviewKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
};

export const FrontmatterPreview = Extension.create({
  name: 'frontmatterPreview',

  addProseMirrorPlugins() {
    return [FrontmatterPreviewPlugin({ editor: this.editor })];
  },
});

export default FrontmatterPreview;
