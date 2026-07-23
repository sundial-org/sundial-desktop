// Cell-level diff for markdown tables (issue #584). A markdown table is ONE
// block whose text content concatenates every cell, so a plain text diff of the
// table lights the WHOLE table up when a single column shifts the pipes. This
// diffs STRUCTURALLY — align columns by header identity, align body rows by their
// first-column key — and reports only the genuinely-changed cells, which the
// renderer maps to cell decorations.
//
// A focused implementation (not a general data-diff dependency): in-document
// table edits are small and column/row identity is well-behaved, so LCS on
// headers + a first-column row key covers cell edits and column/row insert/delete
// without the brittleness a positional text diff has.

export type TableCellChange = {
  /** Body-row index in the AFTER table; -1 for a header cell. */
  row: number;
  /** Column index in the AFTER table (BEFORE index for a pure deletion). */
  col: number;
  kind: 'insert' | 'delete' | 'modify';
  deletedText?: string;
  insertedText?: string;
};

type Table = { headers: string[]; rows: string[][] };

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

export function parseMarkdownTable(md: string): Table | null {
  const lines = md.split('\n').map((l) => l.trim()).filter((l) => l.includes('|'));
  if (lines.length < 1) return null;
  const headers = parseRow(lines[0]!);
  let body = lines.slice(1);
  if (body.length > 0 && isSeparatorRow(parseRow(body[0]!))) body = body.slice(1);
  const rows = body.map(parseRow);
  return { headers, rows };
}

// Matched index pairs via LCS — the spine of both column and row alignment.
function lcsPairs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = eq(a[i]!, b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i]!, b[j]!)) { pairs.push([i, j]); i += 1; j += 1; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

/**
 * Structural cell-level diff of two markdown tables. Returns the changed cells
 * only; an unchanged cell never appears (so a column insert flags just the new
 * column, never the whole table). Returns null if either side isn't a table.
 */
export function diffMarkdownTable(beforeMd: string, afterMd: string): TableCellChange[] | null {
  const before = parseMarkdownTable(beforeMd);
  const after = parseMarkdownTable(afterMd);
  if (!before || !after) return null;

  const changes: TableCellChange[] = [];

  // --- Column alignment by header identity ---
  const colPairs = lcsPairs(before.headers, after.headers, (x, y) => x === y);
  const matchedAfterCols = new Set(colPairs.map(([, ac]) => ac));
  const matchedBeforeCols = new Set(colPairs.map(([bc]) => bc));
  const beforeColForAfter = new Map(colPairs.map(([bc, ac]) => [ac, bc]));

  // Header cells for inserted / removed columns.
  after.headers.forEach((h, ac) => {
    if (!matchedAfterCols.has(ac)) changes.push({ row: -1, col: ac, kind: 'insert', insertedText: h });
  });
  before.headers.forEach((h, bc) => {
    if (!matchedBeforeCols.has(bc)) changes.push({ row: -1, col: bc, kind: 'delete', deletedText: h });
  });

  // --- Row alignment by the first matched column's value (a stable key) ---
  const keyCol = colPairs[0] ?? null; // [beforeCol, afterCol]
  const keyOf = (row: string[], col: number) => (col >= 0 ? row[col] ?? '' : '');
  const rowPairs = keyCol
    ? lcsPairs(before.rows, after.rows, (x, y) => keyOf(x, keyCol[0]) === keyOf(y, keyCol[1]))
    : before.rows.map((_, i) => [i, i] as [number, number]).filter(([i]) => i < after.rows.length);
  const matchedAfterRows = new Set(rowPairs.map(([, ar]) => ar));
  const matchedBeforeRows = new Set(rowPairs.map(([br]) => br));

  // Matched rows: per-cell modify (matched columns) + insert/delete (column changes).
  for (const [br, ar] of rowPairs) {
    const beforeRow = before.rows[br]!;
    const afterRow = after.rows[ar]!;
    after.headers.forEach((_, ac) => {
      const aText = afterRow[ac] ?? '';
      if (matchedAfterCols.has(ac)) {
        const bc = beforeColForAfter.get(ac)!;
        const bText = beforeRow[bc] ?? '';
        if (bText !== aText) changes.push({ row: ar, col: ac, kind: 'modify', deletedText: bText, insertedText: aText });
      } else {
        changes.push({ row: ar, col: ac, kind: 'insert', insertedText: aText });
      }
    });
    before.headers.forEach((_, bc) => {
      if (!matchedBeforeCols.has(bc)) changes.push({ row: ar, col: bc, kind: 'delete', deletedText: beforeRow[bc] ?? '' });
    });
  }

  // Wholly inserted / removed rows.
  after.rows.forEach((row, ar) => {
    if (!matchedAfterRows.has(ar)) {
      row.forEach((cell, ac) => changes.push({ row: ar, col: ac, kind: 'insert', insertedText: cell }));
    }
  });
  before.rows.forEach((row, br) => {
    if (!matchedBeforeRows.has(br)) {
      row.forEach((cell, bc) => changes.push({ row: br, col: bc, kind: 'delete', deletedText: cell }));
    }
  });

  return changes;
}
