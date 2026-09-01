import { Node as PMNode, DOMSerializer, type DOMOutputSpec } from '@tiptap/pm/model';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { markdownToHtml, renderMathInPlainText } from '@/lib/markdown/html.mjs';
import { markdownSchema } from '@/lib/markdown/codec';
import { Y, applyMarkdownDiff, applyMarkdownSuggestion } from '@/lib/crdt-js/markdown_yjs.mjs';
import type { TurnEditLine } from '@/lib/workspace/turn-edits';
import {
  alignDeletionMarkdownToAddition,
  buildLineChangeHighlights,
  computeInlineAddedRangesForBlock,
  normalizeMatchLine,
  pickPairedAdditionLine,
  type LineChangePair,
  type TextRange,
} from '@/lib/workspace/inline-word-diff';

const LIST_TAGS = new Set(['UL', 'OL']);

/** Mirror `collectEditorBlockPositions` — one decoration target per block/listItem. */
export function collectHtmlDecorationTargets(root: ParentNode): HTMLElement[] {
  const blocks: HTMLElement[] = [];

  const visitList = (list: HTMLElement) => {
    for (const child of Array.from(list.children)) {
      if (child.tagName !== 'LI') continue;
      const li = child as HTMLElement;
      blocks.push(li);
      for (const nested of Array.from(li.children)) {
        if (LIST_TAGS.has(nested.tagName)) {
          visitList(nested as HTMLElement);
        }
      }
    }
  };

  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (LIST_TAGS.has(child.tagName)) {
      visitList(child);
      continue;
    }
    blocks.push(child);
  }

  return blocks;
}

function positionClass(index: number, total: number): string {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  return `${isFirst ? ' diff-pending-first' : ''}${isLast ? ' diff-pending-last' : ''}${
    !isFirst && !isLast ? ' diff-pending-mid' : ''
  }`;
}

/** Decorate parsed markdown blocks with pending-addition or -deletion classes. */
function decorateBlockHtml(
  html: string,
  kind: 'addition' | 'deletion',
  doc: Document = document,
): string {
  const container = doc.createElement('div');
  container.innerHTML = html;
  const className = kind === 'addition' ? 'diff-pending-addition' : 'diff-pending-deletion';
  const targets = collectHtmlDecorationTargets(container);
  targets.forEach((el, index) => {
    el.classList.add(className);
    for (const cls of positionClass(index, targets.length).trim().split(/\s+/)) {
      if (cls) el.classList.add(cls);
    }
  });
  return container.innerHTML;
}

/** Decorate parsed markdown blocks with the same classes the TipTap plugin uses. */
export function decorateAdditionHtml(html: string, doc: Document = document): string {
  return decorateBlockHtml(html, 'addition', doc);
}

/** Decorate parsed markdown blocks for the deletion ghost (mirrors additions). */
export function decorateDeletionHtml(html: string, doc: Document = document): string {
  return decorateBlockHtml(html, 'deletion', doc);
}

/** Wrap exact character ranges inside rendered markdown HTML (post-parse). */
export function applyTextRangesToHtml(
  html: string,
  ranges: TextRange[],
  doc: Document = document,
  className = 'diff-inline-added',
): string {
  if (!html || ranges.length === 0) return html;
  const container = doc.createElement('div');
  container.innerHTML = html;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    if (range.start >= range.end) continue;
    wrapTextRange(container, range, doc, className);
  }
  return container.innerHTML;
}

function wrapTextRange(root: ParentNode, range: TextRange, doc: Document, className: string) {
  let cursor = 0;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const text = n as Text;
    const len = text.data.length;
    if (len === 0) continue;
    nodes.push({ node: text, start: cursor, end: cursor + len });
    cursor += len;
  }

  for (const entry of nodes) {
    const overlapStart = Math.max(range.start, entry.start);
    const overlapEnd = Math.min(range.end, entry.end);
    if (overlapStart >= overlapEnd) continue;

    const localStart = overlapStart - entry.start;
    const localEnd = overlapEnd - entry.start;
    const text = entry.node;
    const len = text.data.length;
    const span = doc.createElement('span');
    span.className = className;

    if (localStart === 0 && localEnd === len) {
      text.parentNode?.replaceChild(span, text);
      span.appendChild(text);
      continue;
    }

    const tail = text.splitText(localEnd);
    const mid = text.splitText(localStart);
    span.appendChild(mid);
    text.parentNode?.insertBefore(span, tail);
  }
}

function isListItemLine(line: string): boolean {
  return /^(\s*)([-*+]|\d+\.)\s/.test(line);
}

function listIndent(line: string): string {
  return line.match(/^(\s*)/)?.[1] ?? '';
}

/** Single `\n` only when markdown should emit one block (list run, heading → list). */
function shouldJoinWithSingleNewline(prevLine: string, nextLine: string): boolean {
  if (/^#{1,6}\s/.test(prevLine) && isListItemLine(nextLine)) return true;
  if (isListItemLine(prevLine) && isListItemLine(nextLine)) {
    return listIndent(prevLine) === listIndent(nextLine);
  }
  return false;
}

function joinHighlightMarkdown(highlights: LineChangePair[]): string {
  if (highlights.length === 0) return '';

  let combined = '';
  let lastLine = '';
  let pendingBlankLines = 0;

  for (const highlight of highlights) {
    if (!highlight.newLine.trim()) {
      pendingBlankLines += 1;
      continue;
    }

    if (!combined) {
      combined = highlight.newLine;
      lastLine = highlight.newLine;
      pendingBlankLines = 0;
      continue;
    }

    const sep =
      pendingBlankLines > 0
        ? '\n'.repeat(pendingBlankLines + 1)
        : shouldJoinWithSingleNewline(lastLine, highlight.newLine)
          ? '\n'
          : '\n\n';

    combined += sep + highlight.newLine;
    lastLine = highlight.newLine;
    pendingBlankLines = 0;
  }

  return combined || ' ';
}

/**
 * Apply word-level highlights inside matched decoration targets (post-parse).
 * `matchLine` identifies the rendered block; `diffAgainst` is the opposite-side
 * line whose shared words are left un-highlighted. Symmetric: additions pass
 * (newLine, oldLine) → `diff-inline-added`; deletions pass (deletionLine,
 * pairedAddition) → `diff-inline-removed`.
 */
function applyHighlightsToContainer(
  container: HTMLElement,
  items: Array<{ matchLine: string; diffAgainst: string | null }>,
  className: string,
  doc: Document,
): void {
  const targets = collectHtmlDecorationTargets(container);
  const used = new Set<HTMLElement>();

  for (const item of items) {
    if (!item.matchLine.trim()) continue;
    const norm = normalizeMatchLine(item.matchLine);
    const target = targets.find(
      (el) => !used.has(el) && normalizeMatchLine(el.textContent ?? '') === norm,
    );
    if (!target) continue;
    used.add(target);

    const plain = (target.textContent ?? '').trim();
    const ranges = computeInlineAddedRangesForBlock(plain, item.diffAgainst);
    if (ranges.length === 0) continue;

    target.innerHTML = applyTextRangesToHtml(target.innerHTML, ranges, doc, className);
  }
}

function applyLineHighlightsToContainer(
  container: HTMLElement,
  highlights: LineChangePair[],
  doc: Document,
): void {
  applyHighlightsToContainer(
    container,
    highlights.map((h) => ({ matchLine: h.newLine, diffAgainst: h.oldLine })),
    'diff-inline-added',
    doc,
  );
}

function applyDeletionHighlightsToContainer(
  container: HTMLElement,
  lines: TurnEditLine[],
  doc: Document,
): void {
  applyHighlightsToContainer(
    container,
    buildDeletionPairs(lines).map((p) => ({ matchLine: p.aligned, diffAgainst: p.pairedAddition })),
    'diff-inline-removed',
    doc,
  );
}

/**
 * Render inline math ($…$) to KaTeX inside already-built diff markup, in place.
 * The marks serializer (`buildMarkedDiffHtmlFromLines`) emits math as literal
 * `$…$` text because `markdownSchema` has no math node; without this pass the
 * chat card would show raw `$B^2 + 1$` where the editor and review panel render
 * a formula. Skips text inside code/pre. Relies on the codec keeping a `$…$`
 * span whole within one text node (inlineToWordTokens' atomic-math rule) so a
 * per-text-node render can match the delimiters even across a suggestion mark.
 */
export function renderInlineMathInHtml(root: ParentNode, doc: Document): void {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    if (t.data.includes('$') && !t.parentElement?.closest('code, pre')) targets.push(t);
  }
  for (const t of targets) {
    const html = renderMathInPlainText(t.data);
    if (!html.includes('katex')) continue; // no math actually rendered — leave as-is
    const span = doc.createElement('span');
    span.innerHTML = html;
    t.parentNode?.replaceChild(span, t);
  }
}

/** Match TipTap list DOM so widget bullets align with doc list items. */
export function normalizeDeletionWidgetHtml(html: string, doc: Document = document): string {
  const container = doc.createElement('div');
  container.innerHTML = html;
  for (const ul of container.querySelectorAll('ul')) {
    ul.setAttribute('data-type', 'bulletList');
  }
  for (const ol of container.querySelectorAll('ol')) {
    ol.setAttribute('data-type', 'orderedList');
  }
  return container.innerHTML;
}

/** Each deletion line paired with the addition it was edited from (for removed-word highlights). */
function buildDeletionPairs(
  lines: TurnEditLine[],
): Array<{ aligned: string; pairedAddition: string | null }> {
  const deletionLines = lines.filter((line) => line.type === 'deletion').map((line) => line.content);
  const additionLines = lines.filter((line) => line.type === 'addition').map((line) => line.content);
  return deletionLines.map((del, index) => ({
    // `aligned` copies a block marker (`-`, `##`, …) for same-level rendering —
    // any list addition works there. But `pairedAddition` (what removed words
    // are diffed against) must be the SAME-index addition, else multi-item
    // list edits diff `- banana old` against `- apple new`.
    aligned: alignDeletionMarkdownToAddition(del, pickPairedAdditionLine(del, additionLines, index)),
    pairedAddition: additionLines[index] ?? null,
  }));
}

function joinDeletionMarkdownFromLines(lines: TurnEditLine[]): string {
  const deletionHighlights: LineChangePair[] = buildDeletionPairs(lines).map((p) => ({
    oldLine: null,
    newLine: p.aligned,
    addedRanges: [],
  }));
  return joinHighlightMarkdown(deletionHighlights);
}

/** Build aligned deletion markdown for the editor widget (same block levels as additions). */
export function buildAlignedDeletionMarkdown(
  deletedText: string,
  lines: TurnEditLine[] | undefined,
): string {
  if (!deletedText.trim()) return '';
  if (lines?.length) return joinDeletionMarkdownFromLines(lines);
  return deletedText;
}

/** Render deleted markdown with per-block ::before highlights (matches additions). */
export function renderDeletionMarkdownHtml(
  markdown: string,
  doc: Document = document,
): string {
  const html = markdownToHtml(markdown || ' ', { renderImages: false, renderMath: true });
  return decorateDeletionHtml(html, doc);
}

export function renderAdditionMarkdownHtml(markdown: string, doc: Document = document): string {
  const html = markdownToHtml(markdown || ' ', { renderImages: false, renderMath: true });
  return decorateAdditionHtml(html, doc);
}

/** A visible stand-in for changed lines that render as nothing: blank-line-only
 *  hunks otherwise show a "+N" badge with zero green/red in the body (rich
 *  markdown paints marks on characters, and empty paragraphs have none). */
function blankLinesNoteHtml(
  count: number,
  kind: 'addition' | 'deletion',
  doc: Document,
): string {
  const p = doc.createElement('p');
  p.className = 'diff-blank-note';
  p.textContent = `${count} blank ${count === 1 ? 'line' : 'lines'} ${kind === 'addition' ? 'added' : 'removed'}`;
  return decorateBlockHtml(p.outerHTML, kind, doc);
}

/** Render post-edit additions plus a red ghost of the deleted original. */
export function buildInlineMarkdownDiffHtmlFromLines(
  lines: TurnEditLine[],
  doc?: Document,
): string {
  // SSR: skip DOM-based decoration. The client component re-renders on
  // hydration and the full decorated markup is produced there.
  const liveDoc = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!liveDoc) return '';

  const highlights = buildLineChangeHighlights(lines);
  const deletionMarkdown = joinDeletionMarkdownFromLines(lines);
  const additions = lines.filter((line) => line.type === 'addition');
  const deletions = lines.filter((line) => line.type === 'deletion');

  let additionHtml = '';
  if (additions.length > 0 && additions.every((line) => !line.content.trim())) {
    additionHtml = blankLinesNoteHtml(additions.length, 'addition', liveDoc);
  } else if (highlights.length > 0) {
    const combinedMarkdown = joinHighlightMarkdown(highlights);
    const container = liveDoc.createElement('div');
    container.innerHTML = markdownToHtml(combinedMarkdown || ' ', {
      renderImages: false,
      renderMath: true,
    });
    applyLineHighlightsToContainer(container, highlights, liveDoc);
    additionHtml = decorateAdditionHtml(container.innerHTML, liveDoc);
  }

  let deletionHtml = '';
  if (deletions.length > 0 && deletions.every((line) => !line.content.trim())) {
    deletionHtml = blankLinesNoteHtml(deletions.length, 'deletion', liveDoc);
  } else if (deletionMarkdown.trim()) {
    const delContainer = liveDoc.createElement('div');
    delContainer.innerHTML = markdownToHtml(deletionMarkdown, {
      renderImages: false,
      renderMath: true,
    });
    applyDeletionHighlightsToContainer(delContainer, lines, liveDoc);
    deletionHtml = decorateDeletionHtml(delContainer.innerHTML, liveDoc);
  }

  if (!deletionHtml) return additionHtml;
  if (!additionHtml) return deletionHtml;
  return `${deletionHtml}${additionHtml}`;
}

/**
 * Render a markdown diff hunk as the EXACT inline suggestion marks the editor
 * shows — one engine, one look. Builds the hunk's before/after into a marked
 * Y.Doc with the production codec (`applyMarkdownSuggestion`), then serializes
 * those marks to the editor's `<ins data-suggestion>` / `<del data-suggestion>`
 * HTML via the shared `markdownSchema`. So the chat card / review panel show the
 * same interleaved word-level green/red as the editor (globals.css ins/del
 * rules style bare `ins/del[data-suggestion]`, no extra CSS) — instead of the
 * old whole-removed-block-then-whole-added-block stack. Needs the DOM
 * (DOMSerializer); returns '' during SSR or on any codec error, so the caller
 * falls back to {@link buildInlineMarkdownDiffHtmlFromLines}.
 */
// The editor schema keeps structural suggestion ids (a suggested code fence /
// rule / image / blank bullet has no text to mark) in unrendered node attrs;
// paint them with the same node classes the editor's decorations use.
let structuralSerializer: DOMSerializer | null = null;
function structuralSuggestionSerializer(): DOMSerializer {
  if (structuralSerializer) return structuralSerializer;
  const base = DOMSerializer.fromSchema(markdownSchema);
  const nodes = Object.fromEntries(Object.entries(base.nodes).map(([name, toDOM]) => [name, (n: PMNode): DOMOutputSpec => {
    const spec = toDOM(n);
    const cls = n.attrs.suggestionInsertionId != null ? 'suggestion-node-insertion'
      : n.attrs.suggestionDeletionId != null ? 'suggestion-node-deletion' : null;
    if (!cls || !Array.isArray(spec)) return spec;
    const [tag, second, ...rest] = spec;
    const hasAttrs = second != null && typeof second === 'object' && !Array.isArray(second) && !('nodeType' in second);
    const attrs = hasAttrs ? (second as Record<string, string>) : {};
    return [tag, { ...attrs, class: [attrs.class, cls].filter(Boolean).join(' ') }, ...(hasAttrs ? rest : spec.slice(1))] as DOMOutputSpec;
  }]));
  structuralSerializer = new DOMSerializer(nodes, base.marks);
  return structuralSerializer;
}

export function buildMarkedDiffHtmlFromLines(lines: TurnEditLine[], doc?: Document): string {
  const liveDoc = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!liveDoc || lines.length === 0) return '';
  // A blank-line-only hunk has no characters to mark — the codec "succeeds"
  // with bare empty paragraphs (`<p></p>`), rendering an invisible diff. Bail
  // to the legacy builder, whose blank-lines note makes the change visible.
  const changed = lines.filter((l) => l.type !== 'context');
  if (changed.length > 0 && changed.every((l) => !l.content.trim())) return '';
  const before = lines.filter((l) => l.type !== 'addition').map((l) => l.content).join('\n');
  const after = lines.filter((l) => l.type !== 'deletion').map((l) => l.content).join('\n');
  if (before === after) return '';
  const ydoc = new Y.Doc();
  try {
    applyMarkdownDiff(ydoc, before);
    // No marks applied (blank-line-only / spacing edit that normalizes equal):
    // the doc still holds the plain 'before' text — don't pass that off as a
    // diff; let the caller fall back to the legacy render.
    if (!applyMarkdownSuggestion(ydoc, before, after, 'card')) return '';
    const json = yDocToProsemirrorJSON(ydoc, 'default');
    const node = PMNode.fromJSON(markdownSchema, json);
    const frag = structuralSuggestionSerializer().serializeFragment(node.content, { document: liveDoc });
    const holder = liveDoc.createElement('div');
    holder.appendChild(frag);
    // Safety net: an unchanged (context) line must NEVER render struck. When a
    // change shares a markdown block with a context line, soft line breaks
    // become hardBreak atoms that force a whole-block strike, marking unchanged
    // text. Detect that (the context line's text inside a <del>) and bail to the
    // legacy render rather than show a false deletion. (review finding)
    const struck = Array.from(holder.querySelectorAll('del[data-suggestion], .suggestion-node-deletion')).map((el) => el.textContent ?? '');
    const contextStruck = lines.some(
      (l) => l.type === 'context' && l.content.trim().length > 0 && struck.some((d) => d.includes(l.content.trim())),
    );
    if (contextStruck) return '';
    renderInlineMathInHtml(holder, liveDoc);
    return holder.innerHTML;
  } catch {
    return '';
  } finally {
    ydoc.destroy();
  }
}

/**
 * Decorated + word-highlighted deletion ghost for the editor's pending-deletion
 * widget — same removed-word highlights the chat card shows. Falls back to the
 * raw deleted text when no structured `lines` are available.
 */
export function buildDeletionWidgetHtml(
  deletedText: string,
  lines: TurnEditLine[] | undefined,
  doc: Document = document,
): string {
  const markdown = buildAlignedDeletionMarkdown(deletedText, lines);
  if (!markdown.trim()) return '';
  const container = doc.createElement('div');
  container.innerHTML = markdownToHtml(markdown, { renderImages: false, renderMath: true });
  if (lines?.length) applyDeletionHighlightsToContainer(container, lines, doc);
  return normalizeDeletionWidgetHtml(decorateDeletionHtml(container.innerHTML, doc), doc);
}

/** Shared surface class — editor TipTap typography + room for ::before bleed. */
export const DIFF_MARKDOWN_SURFACE_CLASS = 'tiptap diff-inline-doc-chunk';
