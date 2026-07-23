import type { Node } from '@tiptap/pm/model';
import { humanizeCalloutType } from '@/lib/markdown/parser.mjs';
import { imageMarkdown } from '@/lib/markdown/image-attrs.mjs';

export function proseMirrorToMarkdown(doc: Node): string {
  const lines: string[] = [];
  doc.forEach((node) => {
    lines.push(serializeNode(node, 0));
  });
  return lines.join('\n\n').replace(/^\n+|\n+$/g, '');
}

function prefixBlockquote(text: string) {
  return text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
}

function padTableCells(cells: string[], width: number) {
  return cells.concat(Array.from({ length: Math.max(0, width - cells.length) }, () => ''));
}

function serializeCallout(node: Node, listIndent: number) {
  const calloutType = (node.attrs.calloutType as string | null) ?? null;
  if (!calloutType) return '';

  const foldable = Boolean(node.attrs.calloutFoldable);
  const collapsed = Boolean(node.attrs.calloutCollapsed);
  const titleExplicit = Boolean(node.attrs.calloutTitleExplicit);
  const defaultTitle = humanizeCalloutType(calloutType);
  const headerMarker = foldable ? (collapsed ? '-' : '+') : '';

  const children: Node[] = [];
  node.forEach((child) => children.push(child));
  const firstChild = children[0] ?? null;
  const hasTitleParagraph = firstChild?.type.name === 'paragraph';
  const visibleTitle = hasTitleParagraph ? firstChild?.textContent.trim() ?? '' : '';
  const title =
    visibleTitle && (titleExplicit || visibleTitle !== defaultTitle) ? ` ${visibleTitle}` : '';

  const body = children
    .slice(hasTitleParagraph ? 1 : 0)
    .map((child) => serializeNode(child, listIndent))
    .filter((part) => part.length > 0)
    .join('\n\n');

  return prefixBlockquote([`[!${calloutType}${headerMarker}]${title}`, body].filter(Boolean).join('\n'));
}

function serializeNode(node: Node, listIndent: number): string {
  switch (node.type.name) {
    case 'paragraph':
      return serializeInline(node);
    case 'heading': {
      const level = (node.attrs.level as number) ?? 1;
      return `${'#'.repeat(level)} ${serializeInline(node)}`;
    }
    case 'bulletList': {
      const items: string[] = [];
      node.forEach((child) => items.push(serializeListItem(child, '- ', listIndent)));
      return items.join('\n');
    }
    case 'orderedList': {
      const items: string[] = [];
      let index = (node.attrs.start as number) ?? 1;
      node.forEach((child) => {
        items.push(serializeListItem(child, `${index}. `, listIndent));
        index += 1;
      });
      return items.join('\n');
    }
    case 'codeBlock': {
      const lang = (node.attrs.language as string) ?? '';
      return `\`\`\`${lang}\n${node.textContent}\n\`\`\``;
    }
    case 'blockquote': {
      if (node.attrs.calloutType) return serializeCallout(node, listIndent);
      const inner: string[] = [];
      node.forEach((child) => inner.push(serializeNode(child, listIndent)));
      return prefixBlockquote(inner.join('\n\n'));
    }
    case 'horizontalRule':
      return '---';
    case 'table':
      return serializeTable(node);
    case 'image': {
      const src = (node.attrs.src as string) ?? '';
      const alt = (node.attrs.alt as string) ?? '';
      return imageMarkdown(alt, src, {
        width: node.attrs.width as number | string | null,
        align: node.attrs.textAlign as string | null,
      });
    }
    default:
      if (node.isTextblock) return serializeInline(node);
      if (node.isBlock) {
        const parts: string[] = [];
        node.forEach((child) => parts.push(serializeNode(child, listIndent)));
        return parts.join('\n\n');
      }
      return node.textContent;
  }
}

function serializeListItem(node: Node, prefix: string, indent: number): string {
  const pad = '  '.repeat(indent);
  const parts: string[] = [];
  node.forEach((child, _offset, index) => {
    if (index === 0) parts.push(`${pad}${prefix}${serializeNode(child, indent + 1)}`);
    else parts.push(`${pad}  ${serializeNode(child, indent + 1)}`);
  });
  return parts.join('\n');
}

function serializeTable(node: Node) {
  const rows: string[][] = [];
  let columnCount = 0;

  node.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(serializeTableCell(cell)));
    columnCount = Math.max(columnCount, cells.length);
    rows.push(cells);
  });

  if (rows.length === 0) return '';

  const renderRow = (cells: string[]) =>
    `| ${padTableCells(cells, Math.max(columnCount, 1)).join(' | ')} |`;
  const separator = `| ${Array.from({ length: Math.max(columnCount, 1) }, () => '---').join(' | ')} |`;
  return [renderRow(rows[0] ?? []), separator, ...rows.slice(1).map(renderRow)].join('\n');
}

function serializeTableCell(node: Node) {
  const parts: string[] = [];
  node.forEach((child) => {
    const serialized =
      child.type.name === 'paragraph' ? serializeInline(child) : serializeNode(child, 0);
    const compact = serialized.replace(/\n+/g, '<br>').trim();
    if (compact) parts.push(compact);
  });
  return parts.join('<br>').replace(/\|/g, '\\|');
}

function serializeInline(node: Node): string {
  let result = '';
  node.forEach((child) => {
    if (child.type.name === 'hardBreak') {
      result += '\\\n';
      return;
    }

    let text = child.text ?? '';
    if (child.marks) {
      for (const mark of child.marks) {
        switch (mark.type.name) {
          case 'bold':
          case 'strong':
            text = `**${text}**`;
            break;
          case 'italic':
          case 'em':
            text = `*${text}*`;
            break;
          case 'code':
            text = `\`${text}\``;
            break;
          case 'link': {
            const obsidianType = mark.attrs.obsidianType as string | null | undefined;
            if (obsidianType === 'wiki') {
              const target = ((mark.attrs.obsidianTarget as string | null) ?? '').trim() || text;
              const alias = ((mark.attrs.obsidianAlias as string | null) ?? '').trim()
                || (text !== target ? text : '');
              text = `${mark.attrs.obsidianEmbed ? '!' : ''}[[${target}${alias ? `|${alias}` : ''}]]`;
            } else {
              text = `[${text}](${(mark.attrs.href as string) ?? ''})`;
            }
            break;
          }
          case 'strike':
            text = `~~${text}~~`;
            break;
          case 'highlight':
            text = `==${text}==`;
            break;
        }
      }
    }
    result += text;
  });
  return result;
}
