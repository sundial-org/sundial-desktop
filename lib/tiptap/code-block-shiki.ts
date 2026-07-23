import { Extension, getChangedRanges } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { CODE_PLUGIN } from '@/lib/markdown/code-highlight';
import { nodeHasPendingSuggestion } from '@/lib/workspace/suggestion-marks';

/**
 * Decoration-based syntax highlighting for markdown code blocks, powered by
 * the SAME @streamdown/code shiki plugin chat messages use — one highlighter,
 * one theme pair, so a fence looks identical in a Sunny reply and in the doc.
 *
 * Like the Mathematics extension, this never touches the document: the fence
 * text in the Y.Doc stays plain, tokens are painted as inline decorations, so
 * the codec, sync and diffs are unaffected. Token colors are emitted as CSS
 * custom properties (`--sd-tok-light` / `--sd-tok-dark`) and resolved by
 * globals.css, so light/dark theme flips need no re-tokenize.
 *
 * Shiki (and each grammar) loads lazily on first use; until it's ready blocks
 * render unhighlighted and the highlight callback triggers a repaint. Edits
 * re-tokenize only the code block(s) they touch — untouched blocks keep their
 * mapped decorations (see the cachedDecorations note in collab-editor.tsx for
 * why full rebuilds per keystroke are not acceptable in a busy collab doc).
 */

export type CodeToken = { offset: number; length: number; light: string; dark: string };

/** Sync tokenizer: null = language unknown or grammar still loading (render
 *  plain). Implementations kick off async loads and signal via `subscribe`. */
export type CodeTokenizer = (code: string, language: string) => CodeToken[] | null;

/** Blocks above this size render plain — tokenizing hundred-KB pastes on every
 *  keystroke is what makes a busy collab editor lag. */
export const MAX_HIGHLIGHT_CHARS = 20_000;

/** Token decorations for one code block at `pos`, or none when the block
 *  shouldn't highlight (no language, oversized, pending suggestion, tokenizer
 *  not ready). */
function blockTokenDecorations(
  node: ProseMirrorNode,
  pos: number,
  tokenize: CodeTokenizer,
): Decoration[] {
  const language = String(node.attrs.language ?? '').trim().toLowerCase();
  if (!language || language === 'text' || language === 'plain') return [];
  const code = node.textContent;
  if (!code || code.length > MAX_HIGHLIGHT_CHARS) return [];
  if (nodeHasPendingSuggestion(node)) return [];
  const tokens = tokenize(code, language);
  if (!tokens) return [];
  const base = pos + 1; // start of the code block's text content
  const decos: Decoration[] = [];
  for (const token of tokens) {
    if (token.length <= 0) continue;
    decos.push(
      Decoration.inline(base + token.offset, base + token.offset + token.length, {
        class: 'sd-code-tok',
        style: `--sd-tok-light:${token.light};--sd-tok-dark:${token.dark}`,
      }),
    );
  }
  return decos;
}

/** Full-doc build — used on init/meta repaints, and exported for tests. */
export function buildCodeTokenDecorations(
  doc: ProseMirrorNode,
  tokenize: CodeTokenizer,
): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return;
    decos.push(...blockTokenDecorations(node, pos, tokenize));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/** Incremental update: re-tokenize only code blocks intersecting the edit;
 *  every other block keeps its position-mapped decorations. */
function updateForDocChange(
  decorations: DecorationSet,
  tr: Transaction,
  state: EditorState,
  tokenize: CodeTokenizer,
): DecorationSet {
  const mapped = decorations.map(tr.mapping, tr.doc);
  let minFrom = Infinity;
  let maxTo = -Infinity;
  getChangedRanges(tr).forEach((range) => {
    minFrom = Math.min(minFrom, range.newRange.from);
    maxTo = Math.max(maxTo, range.newRange.to);
  });
  if (minFrom === Infinity) return mapped;
  const docSize = state.doc.content.size;
  minFrom = Math.max(0, minFrom - 1);
  maxTo = Math.min(docSize, maxTo + 1);

  const decos: Decoration[] = [];
  const rebuilt: Array<[number, number]> = [];
  state.doc.nodesBetween(minFrom, maxTo, (node, pos) => {
    if (node.type.name !== 'codeBlock') return;
    rebuilt.push([pos, pos + node.nodeSize]);
    decos.push(...blockTokenDecorations(node, pos, tokenize));
    return false;
  });
  // Two removals before re-adding: the changed range itself (a fence toggled
  // back to a paragraph must lose its stale token spans) and the FULL range of
  // every rebuilt block (a partial edit re-emits the whole block's tokens, so
  // survivors outside the changed slice would duplicate).
  let next = mapped.remove(mapped.find(minFrom, maxTo));
  for (const [from, to] of rebuilt) next = next.remove(next.find(from, to));
  return next.add(state.doc, decos);
}

/* ── Default tokenizer: the shared @streamdown/code shiki plugin ─────── */

const readyListeners = new Set<() => void>();
const tokenCache = new Map<string, CodeToken[]>();
const TOKEN_CACHE_MAX = 100;

function notifyReady() {
  for (const listener of [...readyListeners]) listener();
}

/** Repaint hook: fires when shiki or a new grammar finishes loading. */
export function subscribeShikiReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

/** Dual-theme token style: an object on current shiki, but other versions
 *  serialize it to a `color:…;--shiki-dark:…` string — accept both. */
function tokenStyle(htmlStyle: string | Record<string, string> | undefined): Record<string, string> | undefined {
  if (!htmlStyle) return undefined;
  if (typeof htmlStyle === 'object') return htmlStyle;
  const out: Record<string, string> = {};
  for (const part of htmlStyle.split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0) out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return out;
}

type RawToken = {
  content: string;
  offset: number;
  htmlStyle?: string | Record<string, string>;
  // Emitted instead of htmlStyle by shiki's codeToTokensWithThemes API —
  // covered defensively in case @streamdown/code ever switches to it.
  variants?: Record<string, { color?: string }>;
};

/** Merge same-colored neighbors — cuts the decoration count several-fold. */
function toCodeTokens(lines: RawToken[][]): CodeToken[] {
  const out: CodeToken[] = [];
  for (const line of lines) {
    for (const t of line) {
      const style = tokenStyle(t.htmlStyle);
      const light = style?.color ?? t.variants?.light?.color ?? '';
      const dark = style?.['--shiki-dark'] ?? t.variants?.dark?.color ?? light;
      if (!light) continue;
      const prev = out[out.length - 1];
      if (prev && prev.light === light && prev.dark === dark && prev.offset + prev.length === t.offset) {
        prev.length += t.content.length;
      } else {
        out.push({ offset: t.offset, length: t.content.length, light, dark });
      }
    }
  }
  return out;
}

export const shikiTokenizer: CodeTokenizer = (code, language) => {
  if (!CODE_PLUGIN.supportsLanguage(language as never)) return null;
  const cacheKey = `${language} ${code}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;
  // Sync result once the grammar is loaded; null + a later callback otherwise.
  // The callback only fires on the async path, so notify can't loop.
  const result = CODE_PLUGIN.highlight(
    { code, language: language as never, themes: CODE_PLUGIN.getThemes() },
    notifyReady,
  );
  if (!result) return null;
  const tokens = toCodeTokens(result.tokens);
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    tokenCache.delete(tokenCache.keys().next().value as string); // evict oldest
  }
  tokenCache.set(cacheKey, tokens);
  return tokens;
};

/* ── Extension ────────────────────────────────────────────────────────── */

export type CodeBlockShikiOptions = {
  /** Injectable for tests; defaults to the shared shiki plugin. */
  tokenizer: CodeTokenizer;
  /** Repaint subscription matching the tokenizer; defaults to shiki's. */
  subscribe: (listener: () => void) => () => void;
};

const codeBlockShikiKey = new PluginKey<DecorationSet>('codeBlockShiki');

export const CodeBlockShiki = Extension.create<CodeBlockShikiOptions>({
  name: 'codeBlockShiki',

  addOptions() {
    return { tokenizer: shikiTokenizer, subscribe: subscribeShikiReady };
  },

  addProseMirrorPlugins() {
    const { tokenizer, subscribe } = this.options;
    return [
      new Plugin<DecorationSet>({
        key: codeBlockShikiKey,
        state: {
          init: (_config, state) => buildCodeTokenDecorations(state.doc, tokenizer),
          apply(tr, decorations, _old, newState) {
            if (tr.getMeta(codeBlockShikiKey)) {
              return buildCodeTokenDecorations(newState.doc, tokenizer);
            }
            if (tr.docChanged) return updateForDocChange(decorations, tr, newState, tokenizer);
            return decorations;
          },
        },
        view(view: EditorView) {
          const unsubscribe = subscribe(() => {
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(codeBlockShikiKey, true));
          });
          return { destroy: unsubscribe };
        },
        props: {
          decorations(state: EditorState) {
            return codeBlockShikiKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export default CodeBlockShiki;
