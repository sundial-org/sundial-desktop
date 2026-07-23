import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import { encodeUpdate } from './encoding';

const schema = getSchema([StarterKit]);

export type TiptapDocJson = {
  type: 'doc';
  content?: Array<Record<string, unknown>>;
};

export function createSnapshotFromDocJson(json: TiptapDocJson): string {
  const ydoc = prosemirrorJSONToYDoc(schema, json, 'default');
  const update = Y.encodeStateAsUpdate(ydoc);
  return encodeUpdate(update);
}

// A NUL (U+0000) can't live in a Postgres `text` column nor an empty ProseMirror
// text node, so strip it before building text nodes — this keeps the ydoc_state
// snapshot consistent with the NUL-stripped content_text mirror (see
// canonicalizeContentText), so a cold load that prefers ydoc_state_text doesn't
// resurrect the NUL the persist path already removed.
const stripNul = (text: string) => (text.includes('\0') ? text.replace(/\0/g, '') : text);

export function buildDocJsonFromText(title: string, paragraphs: string[]): TiptapDocJson {
  const content: Array<Record<string, unknown>> = [];

  const heading = stripNul(title);
  if (heading) {
    content.push({
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: heading }],
    });
  }

  paragraphs.forEach((raw) => {
    const text = stripNul(raw);
    if (!text.trim()) return;
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    });
  });

  return {
    type: 'doc',
    content,
  };
}
