'use client';

import { useCallback, useMemo, useState } from 'react';
import { CaretUpIcon, MagnifyingGlassIcon, SortAscendingIcon } from '@phosphor-icons/react';
import Papa from 'papaparse';
import type { PendingAddition } from '@/components/workspace/collab-editor';
import { computeCsvDiffRows, type CsvRowSource } from '@/lib/workspace/csv-row-diff';

export type CsvRowOp = { type: 'replace' | 'insertAfter' | 'delete'; line: number; text?: string };

interface CSVViewerProps {
  content: string;
  fileName: string;
  /** Unaccepted agent/human suggestions for this file; rendered as an in-table diff. */
  pendingAdditions?: PendingAddition[];
  /** When true, cells are editable and add/delete-row controls show. */
  editable?: boolean;
  /** When true, an edit becomes a suggestion — show live red(old)/green(new) as you type. */
  suggesting?: boolean;
  /** Apply a base-row edit (1-based physical line) — drives the underlying CRDT/Monaco. */
  onRowOp?: (op: CsvRowOp) => void;
  /** Keep (accept) or discard (reject) a pending suggestion by its addition key. */
  onResolveSuggestion?: (key: string, keep: boolean) => void;
}

type SortDirection = 'asc' | 'desc' | null;

// One display row maps to a physical line in the doc (`line`, -1 for a deleted
// ghost that no longer exists in `content`). `kind` carries the diff state so a
// single grid renders edits and suggestions together — never a read-only mode.
type DisplayRow =
  | { kind: 'unchanged'; cells: string[]; line: number }
  | { kind: 'added'; cells: string[]; line: number; source?: CsvRowSource }
  | { kind: 'deleted'; cells: string[]; line: number; source?: CsvRowSource }
  | { kind: 'modified'; oldCells: string[]; newCells: string[]; line: number; source?: CsvRowSource };

type DisplayItem = { type: 'row'; row: DisplayRow } | { type: 'gap'; count: number };

const PAGE_SIZE = 50;
const DIFF_CONTEXT = 3;

/** Collapse runs of unchanged rows longer than 2×context into a gap marker (review only). */
function collapseUnchangedRuns(rows: DisplayRow[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== 'unchanged') {
      out.push({ type: 'row', row: rows[i]! });
      i += 1;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === 'unchanged') j += 1;
    const runLen = j - i;
    if (runLen <= 2 * DIFF_CONTEXT + 1) {
      for (let k = i; k < j; k += 1) out.push({ type: 'row', row: rows[k]! });
    } else {
      for (let k = i; k < i + DIFF_CONTEXT; k += 1) out.push({ type: 'row', row: rows[k]! });
      out.push({ type: 'gap', count: runLen - 2 * DIFF_CONTEXT });
      for (let k = j - DIFF_CONTEXT; k < j; k += 1) out.push({ type: 'row', row: rows[k]! });
    }
    i = j;
  }
  return out;
}

const ROW_BG: Record<DisplayRow['kind'], string> = {
  unchanged: '',
  added: 'bg-emerald-50/50',
  deleted: 'bg-red-50/50',
  modified: 'bg-amber-50/30',
};
const ROW_GLYPH: Record<DisplayRow['kind'], { glyph: string; cls: string }> = {
  unchanged: { glyph: '', cls: 'text-stone-300' },
  added: { glyph: '+', cls: 'text-emerald-600' },
  deleted: { glyph: '−', cls: 'text-red-500' },
  modified: { glyph: '~', cls: 'text-amber-600' },
};

export function CSVViewer({
  content,
  fileName,
  pendingAdditions,
  editable = false,
  suggesting = false,
  onRowOp,
  onResolveSuggestion,
}: CSVViewerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [currentPage, setCurrentPage] = useState(0);
  // Live in-cell diff: the cell being edited, with its original value and the
  // current draft, so red(old)/green(new) shows as you type — before blur
  // stages the real suggestion.
  const [liveEdit, setLiveEdit] = useState<{ line: number; col: number; original: string; draft: string } | null>(null);

  // Detect the delimiter once from the content (Papa autodetects `;`/`|`/`,`),
  // forcing tab only for .tsv — then reuse it for both the table and the diff
  // so a pending suggestion can't collapse a semicolon-delimited CSV's columns.
  const delimiter = useMemo(() => {
    if (fileName.endsWith('.tsv')) return '\t';
    return Papa.parse(content, { preview: 20 }).meta.delimiter || ',';
  }, [content, fileName]);
  const splitCells = useCallback(
    (line: string): string[] => {
      const row = Papa.parse<string[]>(line, { delimiter }).data[0];
      return Array.isArray(row) ? row : [line];
    },
    [delimiter],
  );
  const serializeRow = useCallback(
    (cells: string[]): string => Papa.unparse([cells], { delimiter }).replace(/\r?\n$/, ''),
    [delimiter],
  );

  const parsed = useMemo(
    () => Papa.parse<string[]>(content.trim(), { delimiter, skipEmptyLines: true }),
    [content, delimiter],
  );

  // 1-based physical line number of each non-empty line (the Monaco/Y.Text
  // coordinate). [0] = header, [i+1] = data row i. Used to drive row edits back
  // into the doc. When the count diverges from the parse (embedded newlines),
  // editing is disabled to avoid corrupting a multi-line record.
  const lineNumbers = useMemo(() => {
    const nums: number[] = [];
    content.replace(/\r\n/g, '\n').split('\n').forEach((l, i) => {
      if (l !== '') nums.push(i + 1);
    });
    return nums;
  }, [content]);

  // A quoted field can hold an embedded newline (one Papa record spanning
  // several physical lines). The diff path matches physical lines (as the
  // backend hunks do), so skip the inline diff for such files rather than
  // fracture the record into broken rows.
  const hasMultilineRecords = useMemo(
    () => parsed.data.some((row) => row.some((cell) => typeof cell === 'string' && cell.includes('\n'))),
    [parsed.data],
  );

  const diff = useMemo(
    () =>
      pendingAdditions?.length && !hasMultilineRecords
        ? computeCsvDiffRows(content, pendingAdditions, splitCells)
        : null,
    [content, pendingAdditions, splitCells, hasMultilineRecords],
  );

  const headers = diff?.header ?? parsed.data[0] ?? [];
  const headerLine = lineNumbers[0] ?? 1;
  const colCount = useMemo(() => {
    let n = headers.length;
    for (const r of diff?.rows ?? []) {
      n = Math.max(n, r.kind === 'modified' ? Math.max(r.oldCells.length, r.newCells.length) : r.cells.length);
    }
    return Math.max(n, 1);
  }, [headers.length, diff]);

  // Editing maps display rows → physical lines 1:1, which only holds when the
  // parse and the non-empty line count agree (no embedded-newline records).
  const canEdit = editable && !!onRowOp && lineNumbers.length === parsed.data.length;

  // Unified row model: the diff sequence (when suggestions exist) or the plain
  // parsed rows. Non-deleted rows carry their physical line so they stay
  // editable even while a diff is showing — deleted ghosts (gone from
  // `content`) get line -1 and render as a non-editable red strike.
  const allRows = useMemo<DisplayRow[]>(() => {
    if (diff) {
      let dataIdx = 0;
      return diff.rows.map((r): DisplayRow => {
        if (r.kind === 'deleted') return { kind: 'deleted', cells: r.cells, line: -1, source: r.source };
        const line = lineNumbers[1 + dataIdx] ?? -1;
        dataIdx += 1;
        if (r.kind === 'modified') return { kind: 'modified', oldCells: r.oldCells, newCells: r.newCells, line, source: r.source };
        if (r.kind === 'added') return { kind: 'added', cells: r.cells, line, source: r.source };
        return { kind: 'unchanged', cells: r.cells, line };
      });
    }
    return parsed.data.slice(1).map((cells, i): DisplayRow => ({ kind: 'unchanged', cells, line: lineNumbers[i + 1] ?? -1 }));
  }, [diff, parsed.data, lineNumbers]);

  const effectiveCells = useCallback(
    (row: DisplayRow): string[] => (row.kind === 'modified' ? row.newCells : row.cells),
    [],
  );

  const filteredRows = useMemo(() => {
    if (!searchQuery.trim()) return allRows;
    const q = searchQuery.toLowerCase();
    return allRows.filter((row) => {
      const cells = row.kind === 'modified' ? [...row.oldCells, ...row.newCells] : row.cells;
      return cells.some((cell) => cell?.toLowerCase().includes(q));
    });
  }, [allRows, searchQuery]);

  // Sorting only makes sense for a clean grid; with a pending diff we keep
  // document order so additions/deletions stay anchored to their neighbours.
  const canSort = !diff;
  const sortedRows = useMemo(() => {
    if (!canSort || sortColumn === null || sortDirection === null) return filteredRows;
    const col = sortColumn;
    const dir = sortDirection === 'asc' ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const va = effectiveCells(a)[col] ?? '';
      const vb = effectiveCells(b)[col] ?? '';
      const na = Number(va);
      const nb = Number(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && va !== '' && vb !== '') return (na - nb) * dir;
      return va.localeCompare(vb) * dir;
    });
  }, [canSort, filteredRows, sortColumn, sortDirection, effectiveCells]);

  const commitCell = useCallback(
    (row: DisplayRow, colIdx: number, value: string) => {
      const base = effectiveCells(row);
      if (!onRowOp || row.line < 0 || (base[colIdx] ?? '') === value) return;
      const next = [...base];
      while (next.length <= colIdx) next.push('');
      next[colIdx] = value;
      onRowOp({ type: 'replace', line: row.line, text: serializeRow(next) });
    },
    [onRowOp, serializeRow, effectiveCells],
  );
  const deleteRow = useCallback(
    (row: DisplayRow) => {
      if (onRowOp && row.line >= 0) onRowOp({ type: 'delete', line: row.line });
    },
    [onRowOp],
  );
  const addRow = useCallback(() => {
    if (!onRowOp) return;
    const withLine = [...allRows].reverse().find((r) => r.line >= 0);
    const afterLine = withLine ? withLine.line : headerLine;
    onRowOp({ type: 'insertAfter', line: afterLine, text: serializeRow(headers.map(() => '')) });
  }, [onRowOp, allRows, headerLine, headers, serializeRow]);

  // Read-only review (chat / view mode) collapses long unchanged runs to a few
  // rows of context around each change. The editable grid never collapses —
  // every row must stay reachable to edit — and paginates instead.
  const collapsed = !canEdit && !!diff;
  const totalPages = collapsed ? 1 : Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages - 1);
  const items = useMemo<DisplayItem[]>(() => {
    if (collapsed) return collapseUnchangedRuns(sortedRows);
    return sortedRows
      .slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
      .map((row) => ({ type: 'row' as const, row }));
  }, [collapsed, sortedRows, safePage]);

  const handleSort = useCallback(
    (colIndex: number) => {
      if (!canSort) return;
      if (sortColumn === colIndex) {
        if (sortDirection === 'asc') setSortDirection('desc');
        else if (sortDirection === 'desc') {
          setSortColumn(null);
          setSortDirection(null);
        }
      } else {
        setSortColumn(colIndex);
        setSortDirection('asc');
      }
      setCurrentPage(0);
    },
    [canSort, sortColumn, sortDirection],
  );

  const handleSearch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setCurrentPage(0);
  }, []);

  if (headers.length === 0) {
    return (
      <div className="border border-dashed border-stone-200 rounded-xl p-6 text-sm text-stone-500">
        No data found in this file.
      </div>
    );
  }

  const cols = Array.from({ length: colCount });
  const showActions = !!onResolveSuggestion && !!diff;
  const summary = diff
    ? [
        diff.addedCount > 0 ? `${diff.addedCount} added` : null,
        diff.deletedCount > 0 ? `${diff.deletedCount} removed` : null,
        diff.modifiedCount > 0 ? `${diff.modifiedCount} changed` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : `${sortedRows.length.toLocaleString()} row${sortedRows.length !== 1 ? 's' : ''} · ${headers.length} column${headers.length !== 1 ? 's' : ''}`;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-xs">
          <MagnifyingGlassIcon
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400"
            weight="regular"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={handleSearch}
            placeholder="Search rows..."
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-stone-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-stone-300 focus:border-stone-300 text-stone-700 placeholder:text-stone-400"
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-xs text-stone-400">{summary}</div>
          {canEdit && (
            <button
              type="button"
              onClick={addRow}
              className="px-2 py-1 text-xs rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-50 hover:text-stone-700"
            >
              + Add row
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="border border-stone-200 rounded-xl overflow-hidden bg-white">
        <div className="overflow-x-auto max-h-[65vh]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10">
              <tr className="bg-stone-50 border-b border-stone-200">
                <th className="px-3 py-2 text-left text-[10px] font-medium text-stone-400 uppercase tracking-wider w-12 shrink-0">
                  #
                </th>
                {cols.map((_, i) => {
                  const headerModified = diff?.headerKind === 'modified';
                  return (
                    <th
                      key={i}
                      className={`px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider whitespace-nowrap select-none transition-colors ${
                        diff?.headerKind === 'added'
                          ? 'text-emerald-700'
                          : diff?.headerKind === 'deleted'
                            ? 'text-red-500 line-through decoration-red-400/60'
                            : 'text-stone-500'
                      } ${canSort ? 'cursor-pointer hover:bg-stone-100' : ''}`}
                      onClick={() => handleSort(i)}
                    >
                      <span className="inline-flex items-center gap-1">
                        {headerModified ? (
                          <ModifiedCell oldValue={diff!.headerOldCells?.[i] ?? ''} newValue={headers[i] ?? ''} />
                        ) : (
                          headers[i] || `Column ${i + 1}`
                        )}
                        {canSort && sortColumn === i && (
                          <CaretUpIcon
                            className={`w-3 h-3 transition-transform ${sortDirection === 'desc' ? 'rotate-180' : ''}`}
                            weight="bold"
                          />
                        )}
                        {canSort && sortColumn !== i && (
                          <SortAscendingIcon className="w-3 h-3 text-stone-300" weight="regular" />
                        )}
                      </span>
                    </th>
                  );
                })}
                {showActions && (
                  <th className="w-20 shrink-0 px-2 py-2 text-right">
                    {diff?.headerSource?.canMutate && (
                      <ResolveButtons source={diff.headerSource} onResolve={onResolveSuggestion!} alwaysShow />
                    )}
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {items.map((item, rowIdx) => {
                if (item.type === 'gap') {
                  return (
                    <tr key={`gap-${rowIdx}`} className="bg-stone-50/50">
                      <td
                        colSpan={colCount + 1 + (showActions ? 1 : 0)}
                        className="px-3 py-1 text-center text-[11px] text-stone-400 select-none"
                      >
                        {item.count} unchanged row{item.count !== 1 ? 's' : ''}
                      </td>
                    </tr>
                  );
                }
                const { row } = item;
                const mark = ROW_GLYPH[row.kind];
                const source = row.kind !== 'unchanged' ? row.source : undefined;
                const canResolve = showActions && !!source && source.canMutate;
                const rowEditable = canEdit && row.kind !== 'deleted' && row.line >= 0;
                return (
                  <tr
                    key={row.line >= 0 ? `${row.kind}:${row.line}` : `del:${safePage}:${rowIdx}`}
                    className={`group transition-colors ${ROW_BG[row.kind]} ${row.kind === 'unchanged' ? 'hover:bg-stone-50/40' : ''}`}
                  >
                    <td className={`px-3 py-1.5 font-mono tabular-nums select-none relative ${mark.cls}`}>
                      {rowEditable && row.kind === 'unchanged' && (
                        <button
                          type="button"
                          onClick={() => deleteRow(row)}
                          title="Delete row"
                          className="absolute inset-y-0 left-0.5 my-auto h-4 w-4 hidden group-hover:flex items-center justify-center rounded text-stone-400 hover:text-red-500 hover:bg-red-50"
                        >
                          ×
                        </button>
                      )}
                      <span className={rowEditable && row.kind === 'unchanged' ? 'group-hover:opacity-0' : ''}>
                        {mark.glyph || safePage * PAGE_SIZE + rowIdx + 1}
                      </span>
                    </td>
                    {cols.map((_, colIdx) => (
                      <Cell
                        key={colIdx}
                        row={row}
                        colIdx={colIdx}
                        editable={rowEditable}
                        suggesting={suggesting}
                        liveEdit={liveEdit}
                        setLiveEdit={setLiveEdit}
                        commitCell={commitCell}
                      />
                    ))}
                    {showActions && (
                      <td className="px-2 py-1.5 whitespace-nowrap text-right align-middle">
                        {canResolve && source && (
                          <ResolveButtons source={source} onResolve={onResolveSuggestion!} />
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={colCount + 1 + (showActions ? 1 : 0)} className="px-3 py-8 text-center text-stone-400">
                    {searchQuery ? 'No matching rows' : 'No data'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-xs text-stone-400">
            Page {safePage + 1} of {totalPages}
          </div>
          <div className="flex items-center gap-1">
            <PageButton label="First" onClick={() => setCurrentPage(0)} disabled={safePage === 0} />
            <PageButton label="Prev" onClick={() => setCurrentPage((p) => Math.max(0, p - 1))} disabled={safePage === 0} />
            <PageButton label="Next" onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1} />
            <PageButton label="Last" onClick={() => setCurrentPage(totalPages - 1)} disabled={safePage >= totalPages - 1} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cell ────────────────────────────────────────────────────────────────────

function Cell({
  row,
  colIdx,
  editable,
  suggesting,
  liveEdit,
  setLiveEdit,
  commitCell,
}: {
  row: DisplayRow;
  colIdx: number;
  editable: boolean;
  suggesting: boolean;
  liveEdit: { line: number; col: number; original: string; draft: string } | null;
  setLiveEdit: React.Dispatch<React.SetStateAction<{ line: number; col: number; original: string; draft: string } | null>>;
  commitCell: (row: DisplayRow, colIdx: number, value: string) => void;
}) {
  const newValue = row.kind === 'modified' ? row.newCells[colIdx] ?? '' : row.cells[colIdx] ?? '';
  const stagedOld =
    row.kind === 'modified' && (row.oldCells[colIdx] ?? '') !== newValue
      ? row.oldCells[colIdx] ?? ''
      : '';
  const isStagedChange = row.kind === 'added' || stagedOld !== '' || (row.kind === 'modified' && (row.oldCells[colIdx] ?? '') !== newValue);

  // Non-editable: deleted ghost, or read-only contexts (chat/view).
  if (!editable) {
    if (row.kind === 'modified') {
      return (
        <td className="px-3 py-1.5 max-w-[300px]">
          <ModifiedCell oldValue={row.oldCells[colIdx] ?? ''} newValue={newValue} />
        </td>
      );
    }
    const tone =
      row.kind === 'added'
        ? 'text-emerald-700'
        : row.kind === 'deleted'
          ? 'text-red-500 line-through decoration-red-400/60'
          : 'text-stone-700';
    return (
      <td className={`px-3 py-1.5 max-w-[300px] truncate ${tone}`} title={newValue}>
        {newValue}
      </td>
    );
  }

  const isLive =
    suggesting && liveEdit?.line === row.line && liveEdit.col === colIdx && liveEdit.draft !== liveEdit.original;
  const showOld = isLive ? liveEdit!.original : stagedOld;
  const greenTint = isLive || isStagedChange;

  return (
    <td className="p-0 max-w-[320px]">
      <div className="flex items-center gap-1.5 px-3">
        {showOld !== '' && (
          <span className="text-red-500 line-through decoration-red-400/70 bg-red-50 rounded px-1 whitespace-nowrap shrink-0">
            {showOld}
          </span>
        )}
        <input
          // Keyed by value so an external change (accepted suggestion, agent
          // edit) resets the uncontrolled input.
          key={`${row.line}:${colIdx}:${newValue}`}
          defaultValue={newValue}
          onFocus={(e) => setLiveEdit({ line: row.line, col: colIdx, original: newValue, draft: e.target.value })}
          onChange={(e) =>
            setLiveEdit((p) => (p && p.line === row.line && p.col === colIdx ? { ...p, draft: e.target.value } : p))
          }
          onBlur={(e) => {
            commitCell(row, colIdx, e.target.value);
            setLiveEdit(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              (e.target as HTMLInputElement).value = newValue;
              setLiveEdit(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className={`w-full bg-transparent py-1.5 focus:outline-none rounded ${
            greenTint
              ? 'text-emerald-700 bg-emerald-50 px-1'
              : 'text-stone-700 px-0 focus:bg-emerald-50/40 focus:ring-1 focus:ring-inset focus:ring-emerald-300'
          }`}
        />
      </div>
    </td>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────────

function ResolveButtons({
  source,
  onResolve,
  alwaysShow = false,
}: {
  source: CsvRowSource;
  onResolve: (key: string, keep: boolean) => void;
  alwaysShow?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 transition-opacity ${alwaysShow ? '' : 'opacity-0 group-hover:opacity-100'}`}
      title={source.authorLabel ? `Suggested by ${source.authorLabel}` : undefined}
    >
      <button
        type="button"
        onClick={() => onResolve(source.key, true)}
        title="Keep this change"
        className="h-5 w-5 flex items-center justify-center rounded border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
      >
        ✓
      </button>
      <button
        type="button"
        onClick={() => onResolve(source.key, false)}
        title="Discard this change"
        className="h-5 w-5 flex items-center justify-center rounded border border-stone-200 text-stone-400 hover:bg-red-50 hover:text-red-600 hover:border-red-200"
      >
        ✕
      </button>
    </span>
  );
}

function ModifiedCell({ oldValue, newValue }: { oldValue: string; newValue: string }) {
  if (oldValue === newValue) return <span className="text-stone-700">{newValue}</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      {oldValue !== '' && (
        <span className="text-red-500 line-through decoration-red-400/70 bg-red-50 rounded px-1">{oldValue}</span>
      )}
      {newValue !== '' && <span className="text-emerald-700 bg-emerald-50 rounded px-1">{newValue}</span>}
    </span>
  );
}

function PageButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-2 py-1 text-xs rounded border border-stone-200 text-stone-500 hover:bg-stone-50 disabled:opacity-30 disabled:cursor-not-allowed"
    >
      {label}
    </button>
  );
}
