import { Extension, getSchema } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table } from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import { replaceFromMarkdown, serializeDoc } from '@/lib/crdt-js/markdown_yjs.mjs';
import { imageWidthAttribute } from '@/lib/markdown/image-attrs.mjs';
import { Frontmatter } from '@/lib/tiptap/frontmatter';
import { ObsidianBlockquote, ObsidianLink } from '@/lib/tiptap/obsidian';
import { allowSuggestionBlockMarks, SuggestionDocument, SuggestionNodeAttributes, InsertionMark, DeletionMark, ModificationMark } from '@/lib/workspace/suggestion-marks';

export type PMDoc = ProseMirrorNode;
export { proseMirrorToMarkdown } from '@/lib/markdown/serializer';

// The crdt-js codec emits a `marker` attribute on hardBreak nodes to preserve
// the original `  ` / `\` (or soft-break) form across a round trip. Declare it
// on the schema so y-prosemirror reads those nodes without rejecting the attr.
// Exported so the live editor (components/workspace/collab-editor.tsx) registers
// the SAME attribute — otherwise an editor round trip drops `marker` and the
// `  ` vs `\` hard-break form is lost on the next snapshot/download.
export const HardBreakMarker = Extension.create({
  name: 'hardBreakMarker',
  addGlobalAttributes() {
    return [{ types: ['hardBreak'], attributes: { marker: { default: null } } }];
  },
});

// Same deal for bullet lists: the codec records the source bullet style
// (`*` / `+`; `-` is the unmarked default) on a `marker` attribute so a
// starred Obsidian list round-trips byte-identical instead of being rewritten
// to dashes. Registered here AND in the live editor for the same reason as
// HardBreakMarker above.
export const BulletMarker = Extension.create({
  name: 'bulletMarker',
  addGlobalAttributes() {
    return [{ types: ['bulletList'], attributes: { marker: { default: null } } }];
  },
});

// Source-fidelity attrs the crdt-js codec emits, declared for the same reason
// as HardBreakMarker (an editor round trip must not drop them): `marker` on
// horizontalRule (`***` / `___` variants), `indented` on codeBlock (4-space
// blocks), and `align` on table cells (from `:---:` separators). `align` also
// renders as text-align so column alignment is visible in the editor.
// Each attr keeps an HTML bridge (`data-*` parse + render) because the plain-
// markdown paste path re-parses `markdownToHtml` output through the ProseMirror
// DOMParser — without it, pasted `***` / indented code / `:---:` tables would
// silently degrade to the default forms on the next serialization.
export const MarkdownSourceFidelity = Extension.create({
  name: 'markdownSourceFidelity',
  addGlobalAttributes() {
    const dataAttr = (name: string, validate?: (raw: string) => boolean) => ({
      default: null as string | null,
      // Clipboard-controlled: pasted HTML can carry any `data-*` value, and
      // these attrs serialize back into MARKDOWN SOURCE — an unvalidated
      // marker would emit invisible arbitrary document content on save.
      parseHTML: (el: HTMLElement) => {
        const raw = el.getAttribute(`data-${name}`);
        return raw && (!validate || validate(raw)) ? raw : null;
      },
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs[name] ? { [`data-${name}`]: attrs[name] } : {},
    });
    // The thematic-break spellings the markdown parser emits (parser.mjs
    // MD_HR, sans indent — the marker serializes at column 0).
    const HR_MARKER = /^(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})$/;
    return [
      { types: ['horizontalRule'], attributes: { marker: dataAttr('marker', (raw) => HR_MARKER.test(raw)) } },
      { types: ['codeBlock'], attributes: { indented: dataAttr('indented', (raw) => raw === 'true') } },
      {
        types: ['tableHeader', 'tableCell'],
        attributes: {
          align: {
            default: null,
            // Fall back to the inline text-align so aligned cells pasted from
            // outside HTML (not our renderer) keep their alignment too. Both
            // sources are clipboard-controlled, so only the three known tokens
            // are accepted — anything else (e.g. a crafted `data-align` smuggling
            // extra CSS declarations) is dropped, and renderHTML re-validates so
            // a hostile value can never reach the style attribute.
            parseHTML: (el: HTMLElement) => {
              const value = el.getAttribute('data-align') ?? el.style?.textAlign;
              return value === 'left' || value === 'center' || value === 'right' ? value : null;
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              const a = attrs.align;
              return a === 'left' || a === 'center' || a === 'right'
                ? { 'data-align': a, style: `text-align: ${a}` }
                : {};
            },
          },
        },
      },
    ];
  },
});

export const markdownSchema = getSchema([
  // v3 StarterKit bundles `link` + `underline`. Disable `link` (ObsidianLink
  // provides it) and `blockquote` (ObsidianBlockquote provides it); StarterKit's
  // bundled `underline` replaces the formerly-standalone extension (same package,
  // same `underline` mark — round-trip is unchanged, guarded by the codec
  // cross-equivalence tests).
  allowSuggestionBlockMarks(StarterKit.configure({
    document: false,
    blockquote: false,
    link: false,
  })),
  SuggestionDocument,
  SuggestionNodeAttributes,
  HardBreakMarker,
  BulletMarker,
  MarkdownSourceFidelity,
  // Raw YAML frontmatter block — must match the editor's extension list so the
  // codec-built Y.Doc stays y-prosemirror-readable (see codec cross-equivalence).
  Frontmatter,
  allowSuggestionBlockMarks(ObsidianBlockquote),
  Highlight,
  // Inline-HTML subset marks (`<sub>`/`<sup>`; `<u>` comes from StarterKit).
  // Must match the live editor's markdownFormattingExtensions.
  Subscript,
  Superscript,
  TextStyle,
  TextAlign.configure({ types: ['image'], alignments: ['left', 'center', 'right'] }),
  // Override Tiptap's default `isAllowedUri`: its regex (`[^a-z+.-:]`) treats
  // `.-:` as a range and ends up excluding `/`, so workspace-relative paths
  // like `tutorial/paper.tex` get their href stripped during parse/render.
  // The markdown codec already calls `sanitizeUrl` on hrefs, so blocking the
  // common XSS schemes here is enough.
  ObsidianLink.configure({
    isAllowedUri: (url) => !/^\s*(?:javascript|vbscript|data):/i.test(url ?? ''),
  }),
  // `width` attr so a resized image (`{width=N}`) survives the PM round-trip
  // this schema drives (suggestion diffs, snapshot import) — must mirror the
  // editor's WorkspaceImage schema.
  Image.extend({ addAttributes() { return { ...this.parent?.(), ...imageWidthAttribute }; } }),
  allowSuggestionBlockMarks(Table.configure({ resizable: false })),
  allowSuggestionBlockMarks(TableRow),
  allowSuggestionBlockMarks(TableHeader),
  allowSuggestionBlockMarks(TableCell),
  // Suggestion marks must be in the schema so PM JSON ↔ node conversion can
  // round-trip a doc that carries pending suggestions (must match the editor).
  InsertionMark,
  DeletionMark,
  ModificationMark,
]);

// Through the single codec: markdown → Y.Doc (markdown_yjs) → ProseMirror JSON
// → PM node. No markdown→HTML→DOM build (it needed jsdom server-side and
// silently corrupted code-fence-followed-by-block documents).
export function markdownToProseMirror(md: string): PMDoc {
  const json = yDocToProsemirrorJSON(markdownToYDoc(md), 'default');
  return ProseMirrorNode.fromJSON(markdownSchema, json);
}

// markdown ↔ Y.Doc go through the single crdt-js codec (parser.mjs AST → Yjs),
// the same one Hocuspocus / agent-edit / the sandbox use. There is no second
// implementation: the editor, snapshot import and the server build and
// serialize identically. (The old markdown→HTML→DOM build lived here and
// silently corrupted code-fence-followed-by-block documents; it's gone.)
export function markdownToYDoc(md: string): Y.Doc {
  const doc = new Y.Doc();
  replaceFromMarkdown(doc, md);
  return doc;
}

export function yDocToMarkdown(doc: Y.Doc): string {
  return serializeDoc(doc);
}
