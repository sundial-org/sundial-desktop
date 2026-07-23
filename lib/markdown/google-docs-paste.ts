const GOOGLE_DOCS_WRAPPED_MIME = 'application/x-vnd.google-docs-document-slice-clip+wrapped';
const GOOGLE_DOCS_GUID_RE = /\bdocs-internal-guid-/i;
const FRAGMENT_COMMENT_RE = /<!--(?:Start|End)Fragment-->/gi;
const BULLET_MARKER_RE = /^[\s\u00a0]*([\u2022\u25e6\u25aa\u25a0\u25cf\u25cb\u25c9\u25c6\u25b8\u25b9\u25ba\u25bb\u25fe\u25fd\u25ab\u2043\u00b7*-])(?:[\s\u00a0\t]+|$)/;
const ORDERED_MARKER_RE = /^[\s\u00a0]*((?:\d+|[a-zA-Z]+))[.)](?:[\s\u00a0\t]+|$)/;
const NON_CONTENT_TAGS = new Set(['meta', 'style', 'script', 'link']);
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);
const LIST_INDENT_TOLERANCE_PX = 12;
const MIN_HEADING_DELTA_PX = 2;

type ListKind = 'bullet' | 'ordered';

type ListMarker = {
  kind: ListKind;
  rawLength: number;
  indentPx: number;
  start?: number;
};

type ListContext = {
  indentPx: number;
  kind: ListKind;
  list: HTMLUListElement | HTMLOListElement;
  lastItem: HTMLLIElement | null;
};

type HeadingMeasurement = {
  block: HTMLElement;
  fontSizePx: number;
  fontWeight: number;
  textLength: number;
};

export function isGoogleDocsClipboardHtml(
  html: string | null | undefined,
  clipboardTypes: readonly string[] = [],
): boolean {
  if (!html) return false;
  return clipboardTypes.includes(GOOGLE_DOCS_WRAPPED_MIME) || GOOGLE_DOCS_GUID_RE.test(html);
}

export function normalizeGoogleDocsHtml(html: string, doc: Document = document): string {
  const stripped = html.replace(FRAGMENT_COMMENT_RE, '').trim();
  if (!stripped) return stripped;

  const root = doc.createElement('div');
  root.style.cssText = [
    'position:fixed',
    'left:-99999px',
    'top:0',
    'visibility:hidden',
    'pointer-events:none',
    'white-space:normal',
  ].join(';');
  root.innerHTML = stripped;

  if (!doc.body) return stripped;
  doc.body.appendChild(root);

  try {
    const contentRoot = getContentRoot(root);
    unwrapBogusGoogleDocsWrappers(contentRoot);
    normalizeGoogleDocsTextNodes(contentRoot);
    inlineComputedTextStyles(contentRoot);
    normalizeGoogleDocsHighlights(contentRoot);
    stripLooseGoogleDocsBlockBreaks(contentRoot);
    normalizeGoogleDocsLists(contentRoot);
    normalizeGoogleDocsHeadings(contentRoot);
    cleanupGoogleDocsArtifacts(contentRoot);
    return contentRoot.innerHTML;
  } finally {
    root.remove();
  }
}

function getContentRoot(root: HTMLElement): HTMLElement {
  const body = root.querySelector('body');
  return body instanceof root.ownerDocument.defaultView!.HTMLElement ? body : root;
}

function unwrapBogusGoogleDocsWrappers(container: HTMLElement) {
  for (const child of Array.from(container.querySelectorAll<HTMLElement>('b'))) {
    if (!isBogusGoogleDocsWrapper(child)) continue;
    const fragment = child.ownerDocument.createDocumentFragment();
    while (child.firstChild) fragment.appendChild(child.firstChild);
    child.replaceWith(fragment);
  }
}

function isBogusGoogleDocsWrapper(node: HTMLElement): boolean {
  if (node.tagName.toLowerCase() !== 'b') return false;
  const weight = node.style.fontWeight.trim().toLowerCase();
  return GOOGLE_DOCS_GUID_RE.test(node.id) || weight === 'normal' || weight === '400';
}

function inlineComputedTextStyles(container: HTMLElement) {
  const win = container.ownerDocument.defaultView;
  if (!win) return;

  for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
    const tag = el.tagName.toLowerCase();
    if (NON_CONTENT_TAGS.has(tag)) continue;
    if (!normalizeText(el.textContent).length) continue;

    const style = win.getComputedStyle(el);
    const next = new Map<string, string>();

    if (!/^(?:strong|b|h[1-6])$/.test(tag) && fontWeightToNumber(style.fontWeight) >= 600) {
      next.set('font-weight', '700');
    }
    if (!/^(?:em|i)$/.test(tag) && style.fontStyle === 'italic') {
      next.set('font-style', 'italic');
    }
    if (style.textDecorationLine.includes('line-through')) {
      next.set('text-decoration', 'line-through');
    }
    if (style.textDecorationLine.includes('underline')) {
      const prev = next.get('text-decoration');
      next.set('text-decoration', prev ? `${prev} underline` : 'underline');
    }
    if (/^(?:p|div|h[1-6])$/.test(tag)) {
      const textAlign = style.textAlign.toLowerCase();
      if (textAlign && textAlign !== 'left' && textAlign !== 'start') {
        next.set('text-align', textAlign);
      }
    }

    for (const [name, value] of next) {
      el.style.setProperty(name, value);
    }
  }
}

function normalizeGoogleDocsTextNodes(container: HTMLElement) {
  const doc = container.ownerDocument;
  const showText = doc.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const textCtor = doc.defaultView?.Text;
  const walker = doc.createTreeWalker(container, showText);

  while (true) {
    const node = walker.nextNode();
    if (!node || (textCtor ? !(node instanceof textCtor) : node.nodeType !== 3)) break;
    const textNode = node as Text;
    textNode.data = textNode.data.replace(/\u00a0/g, ' ');
  }
}

function normalizeGoogleDocsHighlights(container: HTMLElement) {
  const win = container.ownerDocument.defaultView;
  if (!win) return;

  const elements = Array.from(container.querySelectorAll<HTMLElement>('span, font')).reverse();
  for (const el of elements) {
    if (!normalizeText(el.textContent).length) continue;
    const color = normalizeHighlightColor(win.getComputedStyle(el).backgroundColor);
    if (!color) continue;
    if (el.querySelector(':scope > mark')) continue;

    const mark = el.ownerDocument.createElement('mark');
    mark.setAttribute('data-color', color);
    while (el.firstChild) mark.appendChild(el.firstChild);
    el.style.removeProperty('background-color');
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
    el.appendChild(mark);
  }
}

function stripLooseGoogleDocsBlockBreaks(container: HTMLElement) {
  for (const br of Array.from(container.querySelectorAll('br'))) {
    const prev = meaningfulSibling(br, 'previous');
    const next = meaningfulSibling(br, 'next');
    if ((!prev || isBlockElement(prev)) && (!next || isBlockElement(next))) {
      br.remove();
    }
  }
}

function normalizeGoogleDocsLists(container: HTMLElement) {
  const blocks = topLevelContentBlocks(container);
  const stack: ListContext[] = [];

  blocks.forEach((block, index) => {
    if (/^(?:ul|ol|table|blockquote|pre|hr)$/i.test(block.tagName)) {
      stack.length = 0;
      return;
    }

    const marker = extractListMarker(block);
    if (
      !marker ||
      (isAmbiguousListMarker(block, marker) && !hasAdjacentListNeighbor(blocks, index, marker))
    ) {
      stack.length = 0;
      return;
    }

    while (
      stack.length > 0 &&
      marker.indentPx < stack[stack.length - 1].indentPx - LIST_INDENT_TOLERANCE_PX
    ) {
      stack.pop();
    }

    let current = stack[stack.length - 1];
    if (!current || marker.indentPx > current.indentPx + LIST_INDENT_TOLERANCE_PX) {
      current = createListContext(block, marker, current?.lastItem ?? null);
      stack.push(current);
    } else if (current.kind !== marker.kind) {
      stack.pop();
      const parent = stack[stack.length - 1];
      current = createListContext(
        block,
        marker,
        parent && marker.indentPx > parent.indentPx + LIST_INDENT_TOLERANCE_PX
          ? parent.lastItem
          : null,
      );
      stack.push(current);
    }

    const li = block.ownerDocument.createElement('li');
    const content = block.cloneNode(true) as HTMLElement;
    trimLeadingCharacters(content, marker.rawLength);
    pruneLeadingEmptyNodes(content);
    li.appendChild(content);
    current.list.appendChild(li);
    current.lastItem = li;
    block.remove();
  });
}

function createListContext(block: HTMLElement, marker: ListMarker, parentItem: HTMLLIElement | null) {
  const doc = block.ownerDocument;
  const list =
    marker.kind === 'ordered' ? doc.createElement('ol') : doc.createElement('ul');
  if (marker.kind === 'ordered' && marker.start && marker.start !== 1) {
    (list as HTMLOListElement).start = marker.start;
  }
  if (parentItem) parentItem.appendChild(list);
  else block.before(list);
  return {
    indentPx: marker.indentPx,
    kind: marker.kind,
    list,
    lastItem: null,
  } satisfies ListContext;
}

function normalizeGoogleDocsHeadings(container: HTMLElement) {
  const blocks = topLevelContentBlocks(container).filter((block) =>
    /^(?:p|div)$/i.test(block.tagName),
  );
  const measurements = blocks
    .map((block) => measureHeadingBlock(block))
    .filter((value): value is HeadingMeasurement => value !== null);
  if (measurements.length === 0) return;

  const baseFontSize = dominantFontSize(measurements.map((entry) => entry.fontSizePx));
  const candidates = measurements.filter(
    (entry) =>
      entry.fontSizePx >= baseFontSize + MIN_HEADING_DELTA_PX &&
      (entry.fontWeight >= 600 || entry.fontSizePx >= baseFontSize * 1.25) &&
      entry.textLength <= 240,
  );
  if (candidates.length === 0) return;

  const sizeTiers = Array.from(new Set(candidates.map((entry) => roundFontSize(entry.fontSizePx))))
    .sort((a, b) => b - a)
    .slice(0, 6);
  const levelBySize = new Map(sizeTiers.map((size, index) => [size, index + 1]));

  for (const candidate of candidates) {
    const level = levelBySize.get(roundFontSize(candidate.fontSizePx));
    if (!level) continue;
    const headingTag = `h${Math.min(level, 6)}` as keyof HTMLElementTagNameMap;
    const heading = candidate.block.ownerDocument.createElement(headingTag);
    while (candidate.block.firstChild) heading.appendChild(candidate.block.firstChild);
    const textAlign = candidate.block.style.getPropertyValue('text-align');
    if (textAlign) heading.style.setProperty('text-align', textAlign);
    stripRedundantHeadingStyles(heading);
    candidate.block.replaceWith(heading);
  }
}

function cleanupGoogleDocsArtifacts(container: HTMLElement) {
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
    const tag = el.tagName.toLowerCase();
    if (NON_CONTENT_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    if (GOOGLE_DOCS_GUID_RE.test(el.id)) el.removeAttribute('id');
    if (el.hasAttribute('class')) el.removeAttribute('class');
  }
}

function meaningfulSibling(node: Node, direction: 'previous' | 'next'): HTMLElement | null {
  const elementCtor = node.ownerDocument?.defaultView?.HTMLElement;
  let current = direction === 'previous' ? node.previousSibling : node.nextSibling;

  while (current) {
    if (current.nodeType === 3) {
      if (normalizeText(current.textContent).length) return null;
      current = direction === 'previous' ? current.previousSibling : current.nextSibling;
      continue;
    }
    if (current.nodeType === 1) {
      if (elementCtor && current instanceof elementCtor) return current;
      return current as HTMLElement;
    }
    current = direction === 'previous' ? current.previousSibling : current.nextSibling;
  }

  return null;
}

function topLevelContentBlocks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter(
    (child): child is HTMLElement =>
      child instanceof container.ownerDocument.defaultView!.HTMLElement &&
      !NON_CONTENT_TAGS.has(child.tagName.toLowerCase()),
  );
}

function extractListMarker(block: HTMLElement): ListMarker | null {
  if (!/^(?:p|div)$/i.test(block.tagName)) return null;
  const text = (block.textContent ?? '').replace(/\u00a0/g, ' ');
  if (!normalizeText(text).length) return null;

  const indentPx = blockIndentPx(block);
  const bulletMatch = text.match(BULLET_MARKER_RE);
  if (bulletMatch) {
    return {
      kind: 'bullet',
      rawLength: bulletMatch[0].length,
      indentPx,
    };
  }

  const orderedMatch = text.match(ORDERED_MARKER_RE);
  if (!orderedMatch) return null;
  return {
    kind: 'ordered',
    rawLength: orderedMatch[0].length,
    indentPx,
    start: parseOrderedStart(orderedMatch[1]),
  };
}

function isAmbiguousListMarker(block: HTMLElement, marker: ListMarker): boolean {
  const text = (block.textContent ?? '').replace(/\u00a0/g, ' ');
  const firstMarker = text.trimStart().charAt(0);
  return marker.kind === 'ordered' || ((firstMarker === '-' || firstMarker === '*') && marker.indentPx < 1);
}

function hasAdjacentListNeighbor(blocks: HTMLElement[], index: number, marker: ListMarker): boolean {
  return [blocks[index - 1], blocks[index + 1]].some((neighbor) => {
    if (!neighbor) return false;
    const other = extractListMarker(neighbor);
    if (!other || other.kind !== marker.kind) return false;
    return Math.abs(other.indentPx - marker.indentPx) <= LIST_INDENT_TOLERANCE_PX;
  });
}

function parseOrderedStart(marker: string): number | undefined {
  if (/^\d+$/.test(marker)) return Number.parseInt(marker, 10);
  return undefined;
}

function blockIndentPx(block: HTMLElement): number {
  const win = block.ownerDocument.defaultView;
  if (!win) return 0;
  const style = win.getComputedStyle(block);
  return parsePx(style.marginLeft) + parsePx(style.paddingLeft);
}

function trimLeadingCharacters(root: HTMLElement, count: number) {
  if (count <= 0) return;
  const doc = root.ownerDocument;
  const showText = doc.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const textCtor = doc.defaultView?.Text;
  const walker = doc.createTreeWalker(root, showText);
  let remaining = count;

  while (remaining > 0) {
    const node = walker.nextNode();
    if (!node || (textCtor ? !(node instanceof textCtor) : node.nodeType !== 3)) break;
    const textNode = node as Text;
    if (!textNode.data) continue;

    if (remaining >= textNode.data.length) {
      remaining -= textNode.data.length;
      textNode.data = '';
      continue;
    }

    textNode.data = textNode.data.slice(remaining);
    remaining = 0;
  }
}

function pruneLeadingEmptyNodes(node: Node) {
  const elementCtor = node.ownerDocument?.defaultView?.Element;
  while (node.firstChild) {
    const first = node.firstChild;
    if (first.nodeType === 3 && !(first.textContent ?? '').length) {
      first.remove();
      continue;
    }
    if (first.nodeType === 1) {
      pruneLeadingEmptyNodes(first);
      if (
        !normalizeText(first.textContent).length &&
        !(elementCtor && first instanceof elementCtor && first.firstElementChild)
      ) {
        first.remove();
        continue;
      }
    }
    break;
  }
}

function measureHeadingBlock(block: HTMLElement): HeadingMeasurement | null {
  const text = normalizeText(block.textContent);
  if (!text.length) return null;

  const win = block.ownerDocument.defaultView;
  if (!win) return null;

  let fontSizePx = 0;
  let fontWeight = 0;
  const nodes = [block, ...Array.from(block.querySelectorAll<HTMLElement>('*'))];
  for (const node of nodes) {
    if (!normalizeText(node.textContent).length) continue;
    const style = win.getComputedStyle(node);
    fontSizePx = Math.max(fontSizePx, parsePx(style.fontSize));
    fontWeight = Math.max(fontWeight, fontWeightToNumber(style.fontWeight));
  }

  return {
    block,
    fontSizePx,
    fontWeight,
    textLength: text.length,
  };
}

function stripRedundantHeadingStyles(heading: HTMLElement) {
  for (const el of Array.from(heading.querySelectorAll<HTMLElement>('*'))) {
    el.style.removeProperty('font-size');
    el.style.removeProperty('font-weight');
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
  }
}

function normalizeHighlightColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'transparent' || normalized === 'rgba(0, 0, 0, 0)') {
    return null;
  }
  return value;
}

function isBlockElement(node: HTMLElement): boolean {
  return BLOCK_TAGS.has(node.tagName.toLowerCase());
}

function dominantFontSize(fontSizes: number[]): number {
  const counts = new Map<number, number>();
  for (const size of fontSizes) {
    const rounded = roundFontSize(size);
    counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
  }

  let bestSize = 16;
  let bestCount = -1;
  for (const [size, count] of counts) {
    if (count > bestCount || (count === bestCount && size < bestSize)) {
      bestSize = size;
      bestCount = count;
    }
  }
  return bestSize;
}

function parsePx(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fontWeightToNumber(value: string): number {
  if (value === 'bold') return 700;
  if (value === 'normal') return 400;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 400;
}

function roundFontSize(value: number): number {
  return Math.round(value);
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}
