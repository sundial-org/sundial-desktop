import { Extension, getSchema } from '@tiptap/core';
import FontFamily from '@tiptap/extension-font-family';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
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
import { FontSize } from '@/lib/tiptap/font-size';
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
  allowSuggestionBlockMarks(ObsidianBlockquote),
  Highlight,
  TextStyle,
  FontFamily,
  FontSize,
  TextAlign.configure({ types: ['heading', 'paragraph', 'image'] }),
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
