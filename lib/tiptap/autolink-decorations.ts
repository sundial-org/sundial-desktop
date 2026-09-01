import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { applyIncremental } from '@/lib/tiptap/incremental-decorations';

/**
 * Bare URLs typed or pasted as plain text (`https://…`, `www.…`) render as
 * clickable links — GFM's autolink literals, as pure view-layer decorations
 * (same pattern as block IDs, math and footnotes). The text stays verbatim in
 * the Y.Doc, so the markdown round trip never turns `https://x` into
 * `[https://x](https://x)`; only the view paints an `<a>` over it. ⌘/Ctrl-click
 * opens it, like every other link in the editor (see collab-editor's `click`
 * handler, which resolves any anchor under the pointer).
 */

// One placeholder char per masked position, so offsets stay aligned and no
// match can span a masked span. Excluded from the URL charset below.
const MASK = '￼';

// Scheme'd URLs and `www.` hosts, stopping at whitespace, quotes, angle
// brackets (so `<https://x>` linkifies its inside) and the mask char.
// Trailing punctuation is trimmed after the fact — see trimTrailing.
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`￼]+/gi;

// Sentence punctuation that follows a URL far more often than it belongs to
// one (GFM's autolink-literal rule).
const TRAILING_PUNCT = new Set(['?', '!', '.', ',', ':', ';', '*', '_', '~', "'", '"']);

/** GFM trailing-punctuation trim: drop sentence punctuation and unbalanced `)`. */
function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (TRAILING_PUNCT.has(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ')') {
      const head = url.slice(0, end);
      const opens = (head.match(/\(/g) ?? []).length;
      const closes = (head.match(/\)/g) ?? []).length;
      // `(see https://x/a_(b))` — the closing paren is the sentence's, not the
      // URL's, only when it is unmatched inside the match itself.
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/** The `href` a bare URL navigates to (`www.x` has no scheme of its own). */
export function autolinkHref(text: string): string {
  return /^www\./i.test(text) ? `https://${text}` : text;
}

/** Every bare-URL range in [from, to] (defaults to the whole doc) — exported for tests. */
export function findAutolinkRanges(
  doc: ProseMirrorNode,
  from = 0,
  to = doc.content.size,
): Array<{ from: number; to: number; text: string }> {
  const out: Array<{ from: number; to: number; text: string }> = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    // Code blocks are literal source; frontmatter is raw YAML behind the
    // properties view — neither is prose the reader clicks through.
    if (node.type.name === 'codeBlock' || node.type.name === 'frontmatter') return false;
    let text = '';
    node.forEach((child) => {
      if (child.isText && child.text != null) {
        // Inline code is literal, and text already carrying a link mark is a
        // link already (its `[text](href)` alias may itself read as a URL —
        // painting a second anchor over it would fight the real one).
        const masked = child.marks.some((m) => m.type.name === 'code' || m.type.name === 'link');
        text += masked ? MASK.repeat(child.text.length) : child.text;
      } else {
        // Inline leaves (images, hard breaks) occupy one position each.
        text += MASK.repeat(child.nodeSize);
      }
    });
    BARE_URL_RE.lastIndex = 0;
    for (let m = BARE_URL_RE.exec(text); m; m = BARE_URL_RE.exec(text)) {
      const trimmed = trimTrailing(m[0]);
      // A prefix with no host behind it (`https://`, `www.`, `https://www.`)
      // isn't a link — trimming trailing punctuation can leave one bare.
      const host = trimmed.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
      if (!/^[a-z0-9]/i.test(host)) continue;
      const from = pos + 1 + m.index;
      out.push({ from, to: from + trimmed.length, text: trimmed });
    }
    return false;
  });
  return out;
}

function scanDecorations(doc: ProseMirrorNode, from: number, to: number): Decoration[] {
  return findAutolinkRanges(doc, from, to).map(({ from: f, to: t, text }) =>
    Decoration.inline(f, t, {
      nodeName: 'a',
      class: 'sd-autolink',
      href: autolinkHref(text),
      rel: 'noopener noreferrer',
      target: '_blank',
    }),
  );
}

const autolinkKey = new PluginKey<DecorationSet>('autolinkDecorations');

export const AutolinkDecorations = Extension.create({
  name: 'autolinkDecorations',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: autolinkKey,
        state: {
          init: (_config, state) =>
            DecorationSet.create(state.doc, scanDecorations(state.doc, 0, state.doc.content.size)),
          apply: (tr, previous) =>
            tr.docChanged ? applyIncremental(tr, previous, scanDecorations) : previous,
        },
        props: {
          decorations(state) {
            return autolinkKey.getState(state);
          },
        },
      }),
    ];
  },
});

export default AutolinkDecorations;
