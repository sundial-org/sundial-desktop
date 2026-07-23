import * as Y from 'yjs';

export const CODE_TEXT_ROOT = 'codetext';
const LEGACY_ROOT = 'default';

// Content-derived clientID (FNV-1a, 32-bit) for deterministic cold-load text
// seeding / suggestion staging. Lives in this leaf module (yjs-only, no codec
// deps) so the code-suggestion ledger can use it WITHOUT importing document_text
// → markdown_yjs → the markdown parser, which would drag the whole codec into the
// Monaco client bundle. (document_text re-exports this for its callers.)
/**
 * @param {string} text
 * @param {Iterable<number>} [prefixBytes] extra identity scope (e.g. a state
 *   vector for catch-ups); empty for plain content-scoped seeds.
 */
export function seedClientId(text, prefixBytes = []) {
  let h = 0x811c9dc5;
  for (const byte of prefixBytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function extractElementText(element) {
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

function extractLegacyText(fragment) {
  const lines = [];
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

function setCodeTextValue(target, text) {
  if (target.length > 0) {
    target.delete(0, target.length);
  }
  if (text) {
    target.insert(0, text);
  }
}

function clearLegacyFragment(doc) {
  if (!doc.share.has(LEGACY_ROOT)) return;
  const legacy = doc.getXmlFragment(LEGACY_ROOT);
  if (legacy.length > 0) {
    legacy.delete(0, legacy.length);
  }
}

export function readCodeText(doc) {
  if (doc.share.has(CODE_TEXT_ROOT)) {
    return doc.getText(CODE_TEXT_ROOT).toString();
  }

  if (doc.share.has(LEGACY_ROOT)) {
    return extractLegacyText(doc.getXmlFragment(LEGACY_ROOT));
  }

  return null;
}

export function replaceCodeText(doc, text) {
  doc.transact(() => {
    setCodeTextValue(doc.getText(CODE_TEXT_ROOT), text);
    clearLegacyFragment(doc);
  });
}

export function ensureCodeText(doc) {
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
