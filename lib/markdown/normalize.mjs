const FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})/;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;

function normalizeFenceMarker(line) {
  const match = line.match(FENCE_PATTERN);
  return match ? match[2][0] : null;
}

function trimOuterPipes(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '');
}

export function splitMarkdownTableRow(line) {
  const trimmed = trimOuterPipes(line);
  if (!trimmed) {
    return [''];
  }

  const cells = [];
  let current = '';
  let escaping = false;

  for (const char of trimmed) {
    if (char === '|' && !escaping) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
    escaping = char === '\\' && !escaping;
    if (char !== '\\') {
      escaping = false;
    }
  }

  cells.push(current.trim());
  return cells;
}

export function isMarkdownTableRow(line) {
  const trimmed = line.trim();
  return trimmed.includes('|') && splitMarkdownTableRow(trimmed).length >= 2;
}

export function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => TABLE_SEPARATOR_CELL_PATTERN.test(cell.replace(/\s+/g, '')));
}

function normalizeMarkdownTableRow(line) {
  return `| ${splitMarkdownTableRow(line).join(' | ')} |`;
}

function normalizeMarkdownTableSeparator(line) {
  return `| ${splitMarkdownTableRow(line)
    .map((cell) => cell.replace(/\s+/g, ''))
    .join(' | ')} |`;
}

function findNextNonBlankLineIndex(lines, startIndex) {
  let index = startIndex;
  while (index < lines.length && !lines[index]?.trim()) {
    index += 1;
  }
  return index;
}

export function normalizeMarkdownForRendering(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const normalized = [];
  let activeFence = null;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const fenceMarker = normalizeFenceMarker(line.trim());
    if (fenceMarker) {
      activeFence = activeFence === fenceMarker ? null : fenceMarker;
      normalized.push(line);
      index += 1;
      continue;
    }

    if (activeFence || !isMarkdownTableRow(line)) {
      normalized.push(line);
      index += 1;
      continue;
    }

    const tableLines = [];
    let nextIndex = index;

    while (nextIndex < lines.length) {
      const candidate = lines[nextIndex];
      if (normalizeFenceMarker(candidate.trim())) {
        break;
      }
      if (isMarkdownTableRow(candidate)) {
        tableLines.push(candidate);
        nextIndex += 1;
        continue;
      }
      if (!candidate.trim()) {
        const nextContentIndex = findNextNonBlankLineIndex(lines, nextIndex + 1);
        if (nextContentIndex < lines.length && isMarkdownTableRow(lines[nextContentIndex] ?? '')) {
          nextIndex = nextContentIndex;
          continue;
        }
        break;
      }
      break;
    }

    if (tableLines.length >= 2 && isMarkdownTableSeparator(tableLines[1])) {
      normalized.push(normalizeMarkdownTableRow(tableLines[0]));
      normalized.push(normalizeMarkdownTableSeparator(tableLines[1]));
      if (tableLines.length > 2) {
        normalized.push(...tableLines.slice(2).map(normalizeMarkdownTableRow));
      }
      index = nextIndex;
      continue;
    }

    normalized.push(line);
    index += 1;
  }

  return normalized.join('\n');
}
