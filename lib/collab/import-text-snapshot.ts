import * as Y from 'yjs';
import { replaceCodeText } from '@/lib/collab/code-text';
import { encodeUpdate } from '@/lib/collab/encoding';
import { markdownToYDoc } from '@/lib/markdown/codec';
import { isMarkdownFile } from '@/lib/sync/policy';

type ImportedTextFile = {
  path: string;
  content: string;
  mimeType?: string | null;
};

export function createSnapshotFromImportedText(file: ImportedTextFile) {
  const content = file.content.replace(/\r\n?/g, '\n');
  if (!isMarkdownFile(file.path, file.mimeType)) {
    const ydoc = new Y.Doc();
    try {
      replaceCodeText(ydoc, content);
      return encodeUpdate(Y.encodeStateAsUpdate(ydoc));
    } finally {
      ydoc.destroy();
    }
  }

  const ydoc = markdownToYDoc(content);
  try {
    return encodeUpdate(Y.encodeStateAsUpdate(ydoc));
  } finally {
    ydoc.destroy();
  }
}
