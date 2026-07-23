import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Selection, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { renderMermaidExclusive } from '@/lib/markdown/mermaid-render';
import { nodeHasPendingSuggestion } from '@/lib/workspace/suggestion-marks';

/**
 * Live preview for ```mermaid code blocks, following the editor's math
 * convention: when the selection is outside the block the rendered SVG shows
 * in place of the fence source; putting the cursor inside (or clicking the
 * diagram) reveals the source for editing. The document itself is never
 * touched — a mermaid block stays an ordinary codeBlock in the Y.Doc, so the
 * codec, sync and diffs are unaffected.
 *
 * Rendering is async (mermaid loads lazily, ~1.5 MB) and debounced, and a
 * source superseded by a newer edit cancels its pending render — an agent
 * streaming through the fence costs one render per settle, not per keystroke.
 * While a newer render is PENDING the block's last good SVG stays up (guarded
 * by a source-similarity check so a reorder can't show the wrong diagram); a
 * source that settles broken reveals the fence with an error badge, so a
 * reader is never left looking at a diagram that misrepresents the doc.
 */

/** Resolves to SVG markup; rejects when the source doesn't parse. */
export type MermaidRenderer = (source: string, dark: boolean) => Promise<string>;

let mermaidSeq = 0;

// All initialize+render pairs (chat's Streamdown plugin included) go through
// the shared lock in lib/markdown/mermaid-render — mermaid is a global
// singleton, and an unlocked render from another surface mid-sequence would
// swap the config under us.
export const renderMermaidSvg: MermaidRenderer = (source, dark) =>
  renderMermaidExclusive(
    { theme: dark ? 'dark' : 'default' },
    `sd-mermaid-${++mermaidSeq}`,
    source,
    { parse: true },
  );

function isDarkTheme(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/** Heuristic "same diagram across an edit": the two sources share at least
 *  half of the shorter one as common prefix + suffix. A streamed agent edit
 *  passes; a reordered different diagram fails — so the stale-SVG fallback can
 *  never paint the wrong diagram over a block. */
export function similarSource(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min === 0) return false;
  let prefix = 0;
  while (prefix < min && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < min - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  return prefix + suffix >= min / 2;
}

type MermaidBlock = { pos: number; end: number; node: ProseMirrorNode; source: string };

function findMermaidBlocks(doc: ProseMirrorNode): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return;
    if (String(node.attrs.language ?? '').trim().toLowerCase() !== 'mermaid') return false;
    blocks.push({ pos, end: pos + node.nodeSize, node, source: node.textContent });
    return false;
  });
  return blocks;
}

// Inclusive on both boundaries, matching Mathematics: a selection touching the
// block (select-all included) reveals the source.
const selectionTouches = (selection: Selection, from: number, to: number) =>
  selection.from <= to && selection.to >= from;

export type MermaidPreviewOptions = {
  /** Injectable for tests; defaults to the lazy mermaid renderer. */
  renderer: MermaidRenderer;
  debounceMs: number;
};

type BlockSnapshot = { pos: number; end: number; editing: boolean };
type PluginState = { decorations: DecorationSet; blocks: BlockSnapshot[] };

export const mermaidPreviewKey = new PluginKey<PluginState>('mermaidPreview');

const MermaidPreviewPlugin = (options: MermaidPreviewOptions & { editor: Editor }) => {
  const { renderer, debounceMs, editor } = options;

  // Per-editor render state. Cache keys are `<theme> <source>` so a theme
  // flip or source edit re-renders; a block whose current source has no SVG
  // yet falls back to its own last good render. Block identity for that
  // fallback is the block's POSITION, remapped through every doc change (an
  // ordinal would shift when a diagram is inserted/removed above), plus a
  // source-similarity check for in-place replacement.
  const svgByKey = new Map<string, string>();
  const failedKeys = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastGoodByPos = new Map<number, { source: string; svg: string; theme: string }>();
  let view: EditorView | null = null;

  const remapLastGood = (tr: Transaction) => {
    if (lastGoodByPos.size === 0) return;
    const entries = [...lastGoodByPos];
    lastGoodByPos.clear();
    for (const [pos, entry] of entries) {
      const mapped = tr.mapping.mapResult(pos);
      if (!mapped.deleted) lastGoodByPos.set(mapped.pos, entry);
    }
  };

  const themeName = () => (isDarkTheme() ? 'dark' : 'light');
  const keyFor = (source: string, theme: string) => `${theme} ${source}`;

  const evictOldest = (collection: Map<string, unknown> | Set<string>, max: number) => {
    if (collection.size >= max) collection.delete(collection.keys().next().value as string);
  };

  const repaint = () => {
    if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(mermaidPreviewKey, true));
  };

  const scheduleRender = (source: string, theme: string) => {
    const key = keyFor(source, theme);
    if (svgByKey.has(key) || failedKeys.has(key) || timers.has(key)) return;
    const timer = setTimeout(() => {
      renderer(source, theme === 'dark')
        .then((svg) => {
          evictOldest(svgByKey, 100);
          svgByKey.set(key, svg);
        })
        .catch(() => {
          evictOldest(failedKeys, 200);
          failedKeys.add(key);
        })
        .finally(() => {
          timers.delete(key);
          repaint();
        });
    }, debounceMs);
    timers.set(key, timer);
  };

  const buildPreviewEl =
    (svg: string) => (_view: EditorView, getPos: () => number | undefined) => {
      const el = document.createElement('div');
      el.className = 'sd-mermaid-preview';
      el.contentEditable = 'false';
      el.innerHTML = svg; // mermaid output, sanitized by securityLevel: 'strict'
      el.addEventListener('mousedown', (event) => {
        const pos = getPos();
        if (view == null || view.isDestroyed || !editor.isEditable || pos == null) return;
        event.preventDefault();
        const { doc } = view.state;
        const $inside = doc.resolve(Math.min(pos + 1, doc.content.size));
        view.dispatch(view.state.tr.setSelection(TextSelection.near($inside)));
        view.focus();
      });
      return el;
    };

  const build = (state: EditorState): PluginState => {
    const blocks = findMermaidBlocks(state.doc);
    if (blocks.length === 0) return { decorations: DecorationSet.empty, blocks: [] };

    const isEditable = editor.isEditable;
    const theme = themeName();
    const decos: Decoration[] = [];
    const snapshots: BlockSnapshot[] = [];
    const wantedKeys = new Set<string>();

    for (const block of blocks) {
      const { pos, end, node, source } = block;
      const isEditing = isEditable && selectionTouches(state.selection, pos, end);
      snapshots.push({ pos, end, editing: isEditing });
      if (!source.trim() || nodeHasPendingSuggestion(node)) continue;

      const key = keyFor(source, theme);
      wantedKeys.add(key);
      let svg = svgByKey.get(key) ?? null;
      let fromFallback = false;
      const failed = failedKeys.has(key);
      if (svg) {
        lastGoodByPos.set(pos, { source, svg, theme });
      } else if (!failed) {
        // Render pending: keep the block's last good SVG up meanwhile so a
        // streamed edit doesn't flash raw source. Once a source SETTLES as
        // broken the fence shows with a badge instead — a reader (who may not
        // be able to click in) is never left looking at an outdated diagram.
        scheduleRender(source, theme);
        const lastGood = lastGoodByPos.get(pos);
        if (lastGood && lastGood.theme === theme && similarSource(lastGood.source, source)) {
          svg = lastGood.svg;
          fromFallback = true;
        }
      }

      if (isEditing || !svg) {
        // Source visible; flag it when the settled source is broken.
        if (failed) decos.push(Decoration.node(pos, end, { class: 'sd-mermaid-invalid' }));
        continue;
      }
      decos.push(Decoration.node(pos, end, { class: 'sd-mermaid-source-hidden' }));
      decos.push(
        // The key must encode WHICH svg is painted, not just the source — a
        // fallback paint under the new source's key would otherwise keep its
        // DOM when the real render lands (same key → ProseMirror reuses it).
        Decoration.widget(pos, buildPreviewEl(svg), {
          key: `sd-mermaid:${pos}:${fromFallback ? 'fb' : 'ok'}:${key}`,
          side: -1,
        }),
      );
    }

    // A newer source supersedes any still-pending render of this block's
    // previous text — cancel it so streamed edits don't queue a render per
    // intermediate keystroke.
    for (const [key, timer] of timers) {
      if (!wantedKeys.has(key)) {
        clearTimeout(timer);
        timers.delete(key);
      }
    }

    return { decorations: DecorationSet.create(state.doc, decos), blocks: snapshots };
  };

  return new Plugin<PluginState>({
    key: mermaidPreviewKey,
    state: {
      init: (_config, state) => build(state),
      apply(tr, previous, _old, newState) {
        if (tr.docChanged) remapLastGood(tr);
        if (!tr.docChanged && !tr.getMeta(mermaidPreviewKey)) {
          if (!tr.selectionSet || previous.blocks.length === 0) return previous;
          // Selection-only: positions are unchanged, so just check whether any
          // block's editing state flipped before paying for a rebuild.
          const isEditable = editor.isEditable;
          const unchanged = previous.blocks.every(
            (b) => (isEditable && selectionTouches(newState.selection, b.pos, b.end)) === b.editing,
          );
          if (unchanged) return previous;
        }
        return build(newState);
      },
    },
    view(editorView: EditorView) {
      view = editorView;
      // setEditable() doesn't dispatch a transaction, and a light/dark flip
      // only toggles a class on <html> — nudge a repaint for both so previews
      // (and their baked-in mermaid theme) recompute.
      let lastEditable = editor.isEditable;
      let lastTheme = themeName();
      const themeObserver =
        typeof MutationObserver === 'undefined'
          ? null
          : new MutationObserver(() => {
              if (themeName() !== lastTheme) {
                lastTheme = themeName();
                repaint();
              }
            });
      themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return {
        update: (v: EditorView) => {
          if (v.editable !== lastEditable) {
            lastEditable = v.editable;
            repaint();
          }
        },
        destroy: () => {
          themeObserver?.disconnect();
          for (const timer of timers.values()) clearTimeout(timer);
          timers.clear();
          view = null;
        },
      };
    },
    props: {
      decorations(state: EditorState) {
        return mermaidPreviewKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
};

export const MermaidPreview = Extension.create<MermaidPreviewOptions>({
  name: 'mermaidPreview',

  addOptions() {
    return { renderer: renderMermaidSvg, debounceMs: 300 };
  },

  addProseMirrorPlugins() {
    return [MermaidPreviewPlugin({ ...this.options, editor: this.editor })];
  },
});

export default MermaidPreview;
