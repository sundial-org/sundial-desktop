import * as Y from 'yjs';

export const CODE_TEXT_ROOT = 'codetext';
const LEGACY_ROOT = 'default';

function extractElementText(element: Y.XmlElement): string {
  let text = '';
  for (let index = 0; index < element.length; index += 1) {
    const child = element.get(index);
    if (child instanceof Y.XmlElement) {
      text += extractElementText(child);
      continue;
    }
    if (child instanceof Y.XmlText) {
      text += child.toString();
      continue;
    }
    if (typeof child === 'string') {
      text += child;
    }
  }
  return text;
}

function extractLegacyText(fragment: Y.XmlFragment): string {
  const lines: string[] = [];
  let inlineText = '';

  for (let index = 0; index < fragment.length; index += 1) {
    const child = fragment.get(index);
    if (child instanceof Y.XmlElement) {
      lines.push(extractElementText(child));
      continue;
    }

    const text =
      child instanceof Y.XmlText ? child.toString() : typeof child === 'string' ? child : '';
    if (!text) continue;
    if (lines.length > 0) {
      lines.push(text);
    } else {
      inlineText += text;
    }
  }

  return lines.length > 0 ? lines.join('\n') : inlineText;
}

function setCodeTextValue(target: Y.Text, text: string) {
  if (target.length > 0) {
    target.delete(0, target.length);
  }
  if (text) {
    target.insert(0, text);
  }
}

function clearLegacyFragment(doc: Y.Doc) {
  if (!doc.share.has(LEGACY_ROOT)) return;
  const legacy = doc.getXmlFragment(LEGACY_ROOT);
  if (legacy.length > 0) {
    legacy.delete(0, legacy.length);
  }
}

export function readCodeText(doc: Y.Doc): string | null {
  if (doc.share.has(CODE_TEXT_ROOT)) {
    return doc.getText(CODE_TEXT_ROOT).toString();
  }

  if (doc.share.has(LEGACY_ROOT)) {
    return extractLegacyText(doc.getXmlFragment(LEGACY_ROOT));
  }

  return null;
}

export function replaceCodeText(doc: Y.Doc, text: string) {
  doc.transact(() => {
    setCodeTextValue(doc.getText(CODE_TEXT_ROOT), text);
    clearLegacyFragment(doc);
  });
}

export function ensureCodeText(doc: Y.Doc): Y.Text {
  if (doc.share.has(CODE_TEXT_ROOT)) {
    const codeText = doc.getText(CODE_TEXT_ROOT);
    clearLegacyFragment(doc);
    return codeText;
  }

  const legacyText = readCodeText(doc) ?? '';
  doc.transact(() => {
    setCodeTextValue(doc.getText(CODE_TEXT_ROOT), legacyText);
    clearLegacyFragment(doc);
  });
  return doc.getText(CODE_TEXT_ROOT);
}
