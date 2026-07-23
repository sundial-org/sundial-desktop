import * as Y from 'yjs';
import { readCodeText } from '@/lib/collab/code-text';
import { decodeUpdate } from '@/lib/collab/encoding';
import { yDocToMarkdown } from '@/lib/markdown/codec';

function extractElementText(element: Y.XmlElement): string {
  let text = '';
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      text += child.toString();
    } else if (child instanceof Y.XmlElement) {
      text += extractElementText(child);
    }
  }
  return text;
}

export function snapshotToText(base64: string): string {
  const doc = new Y.Doc();
  try {
    const update = decodeUpdate(base64);
    Y.applyUpdate(doc, update);
    const codeText = readCodeText(doc);
    if (codeText !== null) {
      return codeText;
    }
    const fragment = doc.getXmlFragment('default');
    const lines: string[] = [];
    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (node instanceof Y.XmlElement) {
        lines.push(extractElementText(node));
      } else if (node instanceof Y.XmlText) {
        lines.push(node.toString());
      }
    }
    return lines.join('\n');
  } finally {
    doc.destroy();
  }
}

export function snapshotToMarkdown(base64: string): string {
  const doc = new Y.Doc();
  try {
    const update = decodeUpdate(base64);
    Y.applyUpdate(doc, update);
    return yDocToMarkdown(doc);
  } finally {
    doc.destroy();
  }
}
