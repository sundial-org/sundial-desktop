import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { parseWikiTarget, resolveWorkspacePath } from '@/lib/markdown/anchors.mjs';
import { markdownAnchorHtml } from '@/lib/markdown/html.mjs';
import { HTML_PREVIEW_SANDBOX, isDarkTheme, wrapHtmlPreviewSrcDoc } from '@/lib/tiptap/html-preview';
import { wikiAliasBase } from '@/lib/workspace/wiki-anchor-picker';

/**
 * Read-only transclusion for `![[note]]` / `![[note#heading]]` /
 * `![[note#^id]]`, following the editor's math/mermaid convention: the embed
 * stays literal marked text in the Y.Doc (codec, sync and diffs untouched);
 * this plugin only paints a rendered card over it while the selection is
 * outside. Caret inside — or a click on the card in an editable doc — reveals
 * the source chip for editing. The card body is the shared AST→HTML renderer
 * scoped to the anchor's block range; nested wiki syntax inside the section
 * renders as plain links (never fetched), so embed depth is 1 by construction.
 *
 * Unresolvable targets keep the source chip visible with a broken-embed
 * underline instead of hiding real document text behind an error card.
 */

export type EmbedPreviewOptions = {
  /** Workspace file paths for Obsidian-style target resolution. */
  getPaths?: () => string[];
  /** Markdown text of a note; resolves null when unreadable. */
  fetchNoteText?: (path: string) => Promise<string | null>;
  /** Path of the file being edited — the target of a same-file `![[#Anchor]]`. */
  getCurrentPath?: () => string | null;
  /** Live markdown of the file being edited. Read straight from the open doc
   *  rather than refetched, so a same-file embed reflects unsynced keystrokes. */
  getCurrentText?: () => string | null;
  /** Workspace-relative image src → displayable URL (signed proxy). */
  resolveImageSrc?: (src: string) => string;
  /** Open the embed's target (routed like a wiki-link navigation). */
  onOpen?: (target: string) => void;
  /** Content cache TTL; stale entries revalidate in the background. */
  ttlMs?: number;
};

const IMAGE_TARGET_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
// `![[page.html]]` — the file's own markup rendered live, in the same
// sandboxed srcdoc frame (and with the same theme bridge) as inline raw HTML.
const HTML_TARGET_RE = /\.html?$/i;
// Obsidian image sizing `![[img.png|300]]` / `![[img.png|300x200]]`: the size
// rides in the alias slot. Bytes stay untouched — only the rendered <img>
// gets the dimensions.
const ALIAS_SIZE_RE = /^(\d{1,5})(?:x(\d{1,5}))?$/;

let frameTokenSeq = 0;

type EmbedRange = { from: number; to: number; target: string; alias: string };

/** Contiguous text ranges carrying an embed wiki-link mark — exported for tests. */
export function findEmbedRanges(doc: ProseMirrorNode): EmbedRange[] {
  const out: EmbedRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find(
      (m) => m.type.name === 'link' && m.attrs.obsidianType === 'wiki' && m.attrs.obsidianEmbed,
    );
    if (!mark) return;
    const target = String(mark.attrs.obsidianTarget ?? '').trim();
    if (!target) return;
    const alias = String(mark.attrs.obsidianAlias ?? '').trim();
    const last = out[out.length - 1];
    // Alias must match too: `![[img|100]]![[img|300]]` is two embeds with
    // different size specs, not one split across text nodes.
    if (last && last.to === pos && last.target === target && last.alias === alias) {
      last.to = pos + node.nodeSize;
    } else {
      out.push({ from: pos, to: pos + node.nodeSize, target, alias });
    }
  });
  return out;
}

// Inclusive on both boundaries, matching Mathematics/Mermaid.
const selectionTouches = (selection: Selection, from: number, to: number) =>
  selection.from <= to && selection.to >= from;

// Same zero-size hiding the Mathematics extension uses — the source text keeps
// its positions (selection mapping, remote carets) while the card shows.
const HIDE_STYLE =
  'display: inline-block; height: 0; opacity: 0; overflow: hidden; position: absolute; width: 0;';

type RangeSnapshot = { from: number; to: number; editing: boolean };
type PluginState = { decorations: DecorationSet; ranges: RangeSnapshot[] };

export const embedPreviewKey = new PluginKey<PluginState>('embedPreview');

const EmbedPreviewPlugin = (options: EmbedPreviewOptions & { editor: Editor }) => {
  const { editor } = options;
  const ttlMs = options.ttlMs ?? 30_000;

  // Note text per resolved path, stale-while-revalidate; rendered HTML per
  // (path + anchor), keyed to the content generation that produced it.
  const contentByPath = new Map<string, { text: string | null; at: number }>();
  const inflight = new Set<string>();
  const htmlByKey = new Map<string, { html: string | null; at: number }>();
  // Generation stamp for the OPEN file's text. The html cache keys on `at`, so
  // same-file embeds must get a new stamp whenever the doc text changes —
  // Date.now() would churn the cache on every keystroke instead.
  let liveSeq = 0;
  let liveTextLast: string | null = null;
  let view: EditorView | null = null;

  const repaint = () => {
    if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(embedPreviewKey, true));
  };

  const fetchContent = (path: string) => {
    const fetcher = options.fetchNoteText;
    if (!fetcher || inflight.has(path)) return;
    inflight.add(path);
    void fetcher(path)
      .catch(() => null)
      .then((text) => {
        contentByPath.set(path, { text, at: Date.now() });
        inflight.delete(path);
        repaint();
      });
  };

  const htmlFor = (
    path: string,
    anchor: { heading: string | null; headingPath?: string[] | null; blockId: string | null },
  ) => {
    const content = contentByPath.get(path);
    if (!content || content.text == null) return undefined;
    const key = `${path}#${anchor.heading ?? ''}|${(anchor.headingPath ?? []).join('>')}#^${anchor.blockId ?? ''}`;
    const cached = htmlByKey.get(key);
    if (cached && cached.at === content.at) return cached.html;
    const html = markdownAnchorHtml(content.text, anchor, {
      variant: 'document',
      resolveImageSrc: options.resolveImageSrc,
    });
    if (htmlByKey.size > 100) htmlByKey.delete(htmlByKey.keys().next().value as string);
    htmlByKey.set(key, { html, at: content.at });
    return html;
  };

  const selectSource = (from: number) => {
    if (!view || view.isDestroyed) return;
    const $pos = view.state.doc.resolve(Math.min(from + 1, view.state.doc.content.size));
    view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
    view.focus();
  };

  const buildCard = (html: string, title: string, target: string, from: number) => () => {
    const el = document.createElement('div');
    el.className = 'sd-embed-card';
    el.contentEditable = 'false';
    const header = document.createElement('div');
    header.className = 'sd-embed-card__header';
    const label = document.createElement('span');
    label.className = 'sd-embed-card__title';
    label.textContent = title;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'sd-embed-card__open';
    open.title = 'Open source note';
    open.textContent = '↗';
    open.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onOpen?.(target);
    });
    header.append(label, open);
    const body = document.createElement('div');
    body.className = 'sd-embed-card__body markdown-content';
    body.innerHTML = html; // shared AST→HTML renderer output (escaped + URL-sanitized)
    el.append(header, body);
    el.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (editor.isEditable) selectSource(from);
      else options.onOpen?.(target);
    });
    return el;
  };

  const buildImage = (src: string, target: string, from: number, alias: string) => () => {
    const el = document.createElement('span');
    el.className = 'sd-embed-image';
    el.contentEditable = 'false';
    const img = document.createElement('img');
    img.src = options.resolveImageSrc ? options.resolveImageSrc(src) : src;
    img.alt = target;
    const size = alias.match(ALIAS_SIZE_RE);
    if (size) {
      img.width = Number(size[1]);
      if (size[2]) img.height = Number(size[2]);
    }
    el.appendChild(img);
    el.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (editor.isEditable) selectSource(from);
    });
    return el;
  };

  // `![[page.html]]` — same chrome as a note card, but the body is the shared
  // sandboxed HTML preview frame (opaque origin, height-reported, theme bridge)
  // instead of rendered markdown. The workspace file is untrusted content.
  const buildHtmlFrame = (source: string, title: string, target: string, from: number) => () => {
    const el = document.createElement('div');
    el.className = 'sd-embed-card sd-embed-card--html';
    el.contentEditable = 'false';
    const header = document.createElement('div');
    header.className = 'sd-embed-card__header';
    const label = document.createElement('span');
    label.className = 'sd-embed-card__title';
    label.textContent = title;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'sd-embed-card__open';
    open.title = 'Open source file';
    open.textContent = '↗';
    open.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onOpen?.(target);
    });
    header.append(label, open);

    const token = `sd-embed-html-${++frameTokenSeq}`;
    const iframe = document.createElement('iframe');
    iframe.className = 'sd-html-preview-frame';
    iframe.setAttribute('sandbox', HTML_PREVIEW_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.title = title;
    iframe.srcdoc = wrapHtmlPreviewSrcDoc(source, token, isDarkTheme());
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { sdHtmlPreview?: string; h?: number } | null;
      if (!data || data.sdHtmlPreview !== token || typeof data.h !== 'number') return;
      iframe.style.height = `${Math.max(24, Math.min(1600, Math.ceil(data.h)))}px`;
    };
    window.addEventListener('message', onMessage);
    (el as HTMLElement & { sdCleanup?: () => void }).sdCleanup = () =>
      window.removeEventListener('message', onMessage);

    el.append(header, iframe);
    header.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (editor.isEditable) selectSource(from);
      else options.onOpen?.(target);
    });
    return el;
  };

  const build = (state: EditorState): PluginState => {
    const ranges = findEmbedRanges(state.doc);
    if (ranges.length === 0) return { decorations: DecorationSet.empty, ranges: [] };

    const isEditable = editor.isEditable;
    const paths = options.getPaths?.() ?? [];
    const decos: Decoration[] = [];
    const snapshots: RangeSnapshot[] = [];
    // Serializing the doc isn't free, so do it lazily and only once per build,
    // and only if a same-file embed actually needs it.
    let liveTextForBuild: string | null | undefined;
    const readLiveText = () => {
      if (liveTextForBuild === undefined) liveTextForBuild = options.getCurrentText?.() ?? null;
      return liveTextForBuild;
    };

    for (const range of ranges) {
      const { from, to, target, alias } = range;
      const isEditing = isEditable && selectionTouches(state.selection, from, to);
      snapshots.push({ from, to, editing: isEditing });
      if (isEditing) continue;

      const { path, heading, headingPath, blockId } = parseWikiTarget(target);
      // An empty path is a SAME-FILE anchor (`![[#Summary]]`, `![[#^id]]`) —
      // the same spelling link navigation already supports. Resolve it against
      // the open file instead of reporting a broken embed.
      const currentPath = options.getCurrentPath?.() ?? null;
      const resolvedPath = path ? resolveWorkspacePath(path, paths) : currentPath;
      if (!resolvedPath) {
        decos.push(Decoration.inline(from, to, { class: 'sd-embed-broken' }));
        continue;
      }

      if (IMAGE_TARGET_RE.test(resolvedPath)) {
        decos.push(Decoration.inline(from, to, { class: 'sd-embed-source-hidden', style: HIDE_STYLE }));
        decos.push(
          Decoration.widget(from, buildImage(resolvedPath, target, from, alias), {
            key: `sd-embed-img:${from}:${resolvedPath}:${alias}`,
            side: -1,
          }),
        );
        continue;
      }

      if (HTML_TARGET_RE.test(resolvedPath)) {
        const content = contentByPath.get(resolvedPath);
        if (!content || Date.now() - content.at > ttlMs) fetchContent(resolvedPath);
        if (content?.text == null) {
          // Loading keeps the source chip; a settled miss flags it broken.
          if (content) decos.push(Decoration.inline(from, to, { class: 'sd-embed-broken' }));
          continue;
        }
        decos.push(Decoration.inline(from, to, { class: 'sd-embed-source-hidden', style: HIDE_STYLE }));
        decos.push(
          // Content stamp + theme in the key: a refetch or light/dark flip
          // must mint a fresh frame (the srcdoc bakes both in).
          Decoration.widget(
            from,
            buildHtmlFrame(content.text, wikiAliasBase(resolvedPath), target, from),
            {
              key: `sd-embed-html:${from}:${resolvedPath}:${content.at}:${isDarkTheme() ? 'd' : 'l'}`,
              side: -1,
              destroy: (node) => (node as HTMLElement & { sdCleanup?: () => void }).sdCleanup?.(),
            },
          ),
        );
        continue;
      }

      const isCurrentFile = currentPath != null && resolvedPath === currentPath;
      if (isCurrentFile) {
        // Serialized at most once per build (see liveTextForBuild below).
        const liveText = readLiveText();
        if (liveText != null) {
          if (liveText !== liveTextLast) {
            liveTextLast = liveText;
            liveSeq += 1;
          }
          contentByPath.set(resolvedPath, { text: liveText, at: liveSeq });
        }
      }
      const content = contentByPath.get(resolvedPath);
      // The open file is never refetched — its text comes from the live doc.
      if (!isCurrentFile && (!content || Date.now() - content.at > ttlMs)) fetchContent(resolvedPath);
      const html = htmlFor(resolvedPath, {
        heading: heading ?? null,
        headingPath: headingPath ?? null,
        blockId: blockId ?? null,
      });
      if (html == null) {
        // Loading, unreadable, or anchor missing — keep the source chip
        // visible; flag settled failures.
        if (content && (content.text == null || html === null)) {
          decos.push(Decoration.inline(from, to, { class: 'sd-embed-broken' }));
        }
        continue;
      }

      const title =
        wikiAliasBase(resolvedPath) + (heading ? ` › ${heading}` : blockId ? ` › ^${blockId}` : '');
      decos.push(Decoration.inline(from, to, { class: 'sd-embed-source-hidden', style: HIDE_STYLE }));
      decos.push(
        Decoration.widget(from, buildCard(html, title, target, from), {
          key: `sd-embed:${from}:${target}:${content?.at ?? 0}`,
          side: -1,
        }),
      );
    }

    return { decorations: DecorationSet.create(state.doc, decos), ranges: snapshots };
  };

  return new Plugin<PluginState>({
    key: embedPreviewKey,
    state: {
      init: (_config, state) => build(state),
      apply(tr, previous, _old, newState) {
        if (!tr.docChanged && !tr.getMeta(embedPreviewKey)) {
          if (!tr.selectionSet || previous.ranges.length === 0) return previous;
          const isEditable = editor.isEditable;
          const unchanged = previous.ranges.every(
            (r) => (isEditable && selectionTouches(newState.selection, r.from, r.to)) === r.editing,
          );
          if (unchanged) return previous;
        }
        return build(newState);
      },
    },
    view(editorView: EditorView) {
      view = editorView;
      let lastEditable = editor.isEditable;
      // A light/dark flip only toggles a class on <html>; the html-embed
      // frames bake the theme into their srcdoc, so nudge a rebuild.
      let lastTheme = isDarkTheme();
      const themeObserver =
        typeof MutationObserver === 'undefined'
          ? null
          : new MutationObserver(() => {
              if (isDarkTheme() !== lastTheme) {
                lastTheme = isDarkTheme();
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
          view = null;
        },
      };
    },
    props: {
      decorations(state: EditorState) {
        return embedPreviewKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
};

export const EmbedPreview = Extension.create<EmbedPreviewOptions>({
  name: 'embedPreview',

  addOptions() {
    return {
      getPaths: undefined,
      fetchNoteText: undefined,
      getCurrentPath: undefined,
      getCurrentText: undefined,
      resolveImageSrc: undefined,
      onOpen: undefined,
      ttlMs: 30_000,
    };
  },

  addProseMirrorPlugins() {
    // Without a fetcher there is nothing to render — stay inert (galleries,
    // secondary mounts) and keep today's chip styling.
    if (!this.options.fetchNoteText) return [];
    return [EmbedPreviewPlugin({ ...this.options, editor: this.editor })];
  },
});

export default EmbedPreview;
