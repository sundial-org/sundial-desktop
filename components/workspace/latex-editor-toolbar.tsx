'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  ChatTextIcon,
  CircleNotchIcon,
  DotsThreeVerticalIcon,
  FunctionIcon,
  ImageIcon,
  LinkIcon,
  LinkSimpleHorizontalIcon,
  ListBulletsIcon,
  PlayIcon,
  QuotesIcon,
  SparkleIcon,
  TableIcon,
  TextBIcon,
  TextItalicIcon,
  TextTIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import {
  BOLD_SNIPPET,
  CITATION_SNIPPET,
  COMMENT_SNIPPET,
  FIGURE_SNIPPET,
  ITALIC_SNIPPET,
  LINK_SNIPPET,
  LIST_SNIPPETS,
  MATH_SNIPPETS,
  SECTION_SNIPPETS,
  TABLE_SNIPPET,
  XREF_SNIPPET,
  type LatexSnippet,
} from '@/lib/workspace/latex-snippets';
import { IconTooltip } from '@/components/collab-bubbles';
import { LATEX_SYMBOL_CATEGORIES } from '@/lib/workspace/latex-symbols';
import type { LatexViewMode } from '@/components/workspace/latex-workbench';
import type { LatexCompileController } from '@/components/workspace/use-latex-compile';
import type { CodeEditorHandle } from '@/components/workspace/collab-code-editor';
import type { LatexMainDocumentState } from '@/components/workspace/latex-main-document';

/**
 * Bind the toolbar + PDF-pane callbacks to the active code editor ref. Shared by
 * the page and inline editor panels so the optional-chaining wiring lives once.
 */
export function latexEditorRefHandlers(ref: RefObject<CodeEditorHandle | null>) {
  return {
    onInsert: (snippet: LatexSnippet) => ref.current?.insertLatexSnippet?.(snippet),
    onInsertText: (text: string) => ref.current?.insertText?.(text),
    onUndo: () => ref.current?.undo?.(),
    onRedo: () => ref.current?.redo?.(),
    onNavigateToLine: (line: number) => ref.current?.revealLine?.(line),
  };
}

interface LatexEditorToolbarProps {
  onInsert: (snippet: LatexSnippet) => void;
  onInsertText: (text: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  readOnly?: boolean;
  viewMode: LatexViewMode;
  onViewModeChange: (mode: LatexViewMode) => void;
  compile: LatexCompileController;
  /** Whether the compile button is allowed to fire (write access). */
  canCompile: boolean;
  onNavigateToLine?: (line: number) => void;
  /** Main-document resolution. Kept internal; only ambiguous/no-root states surface. */
  mainDocument?: LatexMainDocumentState;
  /** Measured toolbar width; drives the single-row overflow collapse. */
  containerWidth?: number;
  /** "Fix with Sunny" — hands the compile error to the agent (mirrors the bottom bar). */
  onFix?: () => void;
  canFix?: boolean;
  /** True while an auto-fix turn is streaming — shows a spinner and hides Fix. */
  fixInFlight?: boolean;
}

// Toolbar modes:
// - full: all authoring tools + compile controls
// - undo-compact: undo/redo + overflow trigger + compile controls
// - compact: authoring collapses to a single overflow trigger + compile controls
// - compile-only: smallest layout keeps the primary action visible
const COMPACT_TOOLBAR_MIN = 460;
const UNDO_COMPACT_TOOLBAR_MIN = 700;
const FULL_TOOLBAR_MIN = 860;

const VIEW_MODES: Array<{ id: LatexViewMode; label: string }> = [
  { id: 'source', label: 'Source' },
  { id: 'split', label: 'Split' },
  { id: 'pdf', label: 'PDF' },
];

// Shared design tokens with the markdown toolbar so the two authoring rows read
// as one system (components/workspace/markdown-toolbar.tsx).
const ICON_BTN =
  'relative inline-flex h-7 w-7 items-center justify-center rounded text-stone-600 transition-colors hover:bg-stone-200/60 hover:text-stone-900 disabled:pointer-events-none disabled:opacity-40';
const DROPDOWN_ITEM =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-stone-700 transition-colors hover:bg-stone-100 disabled:pointer-events-none disabled:opacity-40';
const POPOVER =
  'absolute top-full z-50 mt-1 rounded-lg border border-stone-200 bg-white p-1 shadow-[0_8px_24px_-12px_rgba(28,25,23,0.35)]';

function ToolbarButton({
  testId,
  label,
  disabled,
  onClick,
  className = ICON_BTN,
  children,
}: {
  testId: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className={className}
    >
      {children}
      <IconTooltip label={label} />
    </button>
  );
}

function ToolbarGroup({ children }: { children: ReactNode }) {
  return (
    <div className="ml-1 flex h-7 shrink-0 items-center gap-0.5 border-l border-stone-300 pl-2">
      {children}
    </div>
  );
}

function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open, onClose]);
  return ref;
}

/** Icon trigger + caret that opens a menu of snippets (Format / Math / List). */
function SnippetMenu({
  id,
  label,
  icon,
  snippets,
  disabled,
  onInsert,
  extra,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  snippets: LatexSnippet[];
  disabled: boolean;
  onInsert: (snippet: LatexSnippet) => void;
  /** Optional trailing menu rows (e.g. the math menu's "Symbols…" entry). */
  extra?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid={`latex-menu-trigger-${id}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-7 items-center gap-0.5 rounded px-1.5 text-stone-600 transition-colors hover:bg-stone-200/60 hover:text-stone-900 disabled:pointer-events-none disabled:opacity-40 ${
          open ? 'bg-stone-200/80 text-stone-900' : ''
        }`}
      >
        {icon}
        <CaretDownIcon className="h-3 w-3" weight="regular" aria-hidden />
        <IconTooltip label={label} open={open} />
      </button>
      {open ? (
        <div role="menu" data-testid={`latex-menu-${id}`} className={`left-0 min-w-[11rem] ${POPOVER}`}>
          {snippets.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              role="menuitem"
              data-testid={`latex-snippet-${snippet.id}`}
              onClick={() => {
                onInsert(snippet);
                setOpen(false);
              }}
              className={DROPDOWN_ITEM}
            >
              {snippet.label}
            </button>
          ))}
          {extra ? extra(() => setOpen(false)) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Ω symbol palette: category tabs + a grid of insertable glyphs. */
function SymbolPalette({
  open,
  onOpenChange,
  disabled,
  onInsertText,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  onInsertText: (text: string) => void;
}) {
  const [categoryId, setCategoryId] = useState(LATEX_SYMBOL_CATEGORIES[0].id);
  const ref = useOutsideClose(open, () => onOpenChange(false));
  const category =
    LATEX_SYMBOL_CATEGORIES.find((c) => c.id === categoryId) ?? LATEX_SYMBOL_CATEGORIES[0];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="latex-symbols-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Insert symbol"
        onClick={() => onOpenChange(!open)}
        className={`${ICON_BTN} font-serif text-[15px] leading-none ${open ? 'bg-stone-200/80 text-stone-900' : ''}`}
      >
        Ω
        <IconTooltip label="Insert symbol" open={open} />
      </button>
      {open ? (
        <div data-testid="latex-symbols-palette" className={`left-0 w-[19rem] ${POPOVER} p-2`}>
          <div className="mb-1.5 flex flex-wrap gap-0.5">
            {LATEX_SYMBOL_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                data-testid={`latex-symbol-tab-${c.id}`}
                aria-pressed={c.id === category.id}
                onClick={() => setCategoryId(c.id)}
                className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  c.id === category.id
                    ? 'bg-stone-300/70 text-stone-900'
                    : 'text-stone-500 hover:bg-stone-200/60 hover:text-stone-900'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-9 gap-0.5">
            {category.symbols.map((symbol) => (
              <button
                key={symbol.latex}
                type="button"
                data-testid={`latex-symbol-${symbol.name}`}
                title={symbol.latex}
                aria-label={symbol.name}
                onClick={() => {
                  onInsertText(symbol.latex);
                  onOpenChange(false);
                }}
                className="flex h-7 items-center justify-center rounded text-[15px] text-stone-700 transition-colors hover:bg-stone-200/60 hover:text-stone-900"
              >
                {symbol.glyph}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function LatexEditorToolbar({
  onInsert,
  onInsertText,
  onUndo,
  onRedo,
  readOnly = false,
  viewMode,
  onViewModeChange,
  compile,
  canCompile,
  onNavigateToLine,
  mainDocument,
  containerWidth = Infinity,
  onFix,
  canFix = false,
  fixInFlight = false,
}: LatexEditorToolbarProps) {
  const [logOpen, setLogOpen] = useState(false);
  const [symbolsOpen, setSymbolsOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useOutsideClose(overflowOpen, () => setOverflowOpen(false));
  const { compileLabel, busy, recompile, compileError, errorLines, logText, canRecompile } = compile;

  const measuredWidth = containerWidth === 0 ? 0 : containerWidth;
  const compileOnly = measuredWidth < COMPACT_TOOLBAR_MIN;
  const showUndoCompact = measuredWidth >= UNDO_COMPACT_TOOLBAR_MIN;
  const showFullAuthoring = measuredWidth >= FULL_TOOLBAR_MIN;
  const showOverflow = !compileOnly && !showFullAuthoring;

  const rootBlockedLabel = canRecompile ? null : mainDocument?.reason === 'ambiguous' ? 'Open a root .tex' : 'No TeX root';
  const issueCount = errorLines.length || 1;
  const statusLabel = rootBlockedLabel ?? `${issueCount} issue${issueCount === 1 ? '' : 's'}`;
  const showStatus = Boolean(rootBlockedLabel || compileError);

  const renderInsert = ({ snippet, icon }: { snippet: LatexSnippet; icon: ReactNode }) => (
    <ToolbarButton
      key={snippet.id}
      testId={`latex-insert-${snippet.id}`}
      label={snippet.label}
      disabled={readOnly}
      onClick={() => onInsert(snippet)}
    >
      {icon}
    </ToolbarButton>
  );

  const insertActions: Array<{ snippet: LatexSnippet; icon: ReactNode }> = [
    { snippet: BOLD_SNIPPET, icon: <TextBIcon className="h-4 w-4" weight="bold" aria-hidden /> },
    { snippet: ITALIC_SNIPPET, icon: <TextItalicIcon className="h-4 w-4" weight="regular" aria-hidden /> },
    { snippet: LINK_SNIPPET, icon: <LinkIcon className="h-4 w-4" weight="regular" aria-hidden /> },
    { snippet: COMMENT_SNIPPET, icon: <ChatTextIcon className="h-4 w-4" weight="regular" aria-hidden /> },
    { snippet: XREF_SNIPPET, icon: <LinkSimpleHorizontalIcon className="h-4 w-4" weight="regular" aria-hidden /> },
    { snippet: CITATION_SNIPPET, icon: <QuotesIcon className="h-4 w-4" weight="regular" aria-hidden /> },
    { snippet: FIGURE_SNIPPET, icon: <ImageIcon className="h-4 w-4" weight="regular" aria-hidden /> },
    { snippet: TABLE_SNIPPET, icon: <TableIcon className="h-4 w-4" weight="regular" aria-hidden /> },
  ];
  const overflowSnippets = [
    ...SECTION_SNIPPETS,
    ...insertActions.slice(0, 2).map((a) => a.snippet),
    ...MATH_SNIPPETS,
    ...insertActions.slice(2).map((a) => a.snippet),
    ...LIST_SNIPPETS,
  ];

  // Overflow row: same insert action, rendered as a labeled menu item.
  const overflowRow = (snippet: LatexSnippet) => (
    <button
      key={snippet.id}
      type="button"
      role="menuitem"
      data-testid={`latex-overflow-${snippet.id}`}
      disabled={readOnly}
      onClick={() => {
        onInsert(snippet);
        setOverflowOpen(false);
      }}
      className={DROPDOWN_ITEM}
    >
      {snippet.label}
    </button>
  );

  return (
    <div
      data-testid="latex-toolbar"
      role="toolbar"
      aria-label="LaTeX document toolbar"
      className={
        compileOnly
          ? 'flex w-full min-w-0 flex-nowrap items-center overflow-visible bg-transparent p-0'
          : 'flex w-full min-w-0 flex-nowrap items-center gap-x-2 overflow-visible rounded-xl border border-stone-200 bg-white px-2 py-1.5 shadow-[0_1px_2px_rgba(28,25,23,0.05)]'
      }
    >
      {/* Authoring tools — mirrors the Overleaf source toolbar order. Groups fold
          into the overflow menu (right→left) as the toolbar narrows. */}
      {!compileOnly ? (
        <div className="flex min-w-fit items-center">
          {showFullAuthoring || showUndoCompact ? (
            <>
              <ToolbarButton
                testId="latex-undo"
                onClick={onUndo}
                disabled={readOnly}
                label="Undo"
              >
                <ArrowCounterClockwiseIcon className="h-4 w-4" weight="regular" aria-hidden />
              </ToolbarButton>
              <ToolbarButton
                testId="latex-redo"
                onClick={onRedo}
                disabled={readOnly}
                label="Redo"
              >
                <ArrowClockwiseIcon className="h-4 w-4" weight="regular" aria-hidden />
              </ToolbarButton>
            </>
          ) : null}

          {showFullAuthoring ? (
            <>
              <ToolbarGroup>
                <SnippetMenu
                  id="format"
                  label="Section level"
                  icon={<TextTIcon className="h-4 w-4" weight="regular" aria-hidden />}
                  snippets={SECTION_SNIPPETS}
                  disabled={readOnly}
                  onInsert={onInsert}
                />
              </ToolbarGroup>

              <ToolbarGroup>{insertActions.slice(0, 2).map(renderInsert)}</ToolbarGroup>

              <ToolbarGroup>
                <SnippetMenu
                  id="math"
                  label="Insert math"
                  icon={<FunctionIcon className="h-4 w-4" weight="regular" aria-hidden />}
                  snippets={MATH_SNIPPETS}
                  disabled={readOnly}
                  onInsert={onInsert}
                  extra={(close) => (
                    <>
                      <div className="my-1 h-px bg-stone-100" />
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="latex-math-symbols"
                        onClick={() => {
                          close();
                          setSymbolsOpen(true);
                        }}
                        className={DROPDOWN_ITEM}
                      >
                        <span className="font-serif">Ω</span> Symbols…
                      </button>
                    </>
                  )}
                />
                <SymbolPalette
                  open={symbolsOpen}
                  onOpenChange={setSymbolsOpen}
                  disabled={readOnly}
                  onInsertText={onInsertText}
                />
              </ToolbarGroup>

              <ToolbarGroup>
                {insertActions.slice(2).map(renderInsert)}
                <SnippetMenu
                  id="list"
                  label="Insert list"
                  icon={<ListBulletsIcon className="h-4 w-4" weight="regular" aria-hidden />}
                  snippets={LIST_SNIPPETS}
                  disabled={readOnly}
                  onInsert={onInsert}
                />
              </ToolbarGroup>
            </>
          ) : null}

          {showOverflow ? (
            <div ref={overflowRef} className="relative flex h-7 shrink-0 items-center">
              <button
                type="button"
                data-testid="latex-toolbar-overflow"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-label="More tools"
                disabled={readOnly}
                onClick={() => setOverflowOpen((v) => !v)}
                className={`${ICON_BTN} ${overflowOpen ? 'bg-stone-200/80 text-stone-900' : ''}`}
              >
                <DotsThreeVerticalIcon className="h-4 w-4" weight="bold" aria-hidden />
                <IconTooltip label="More tools" open={overflowOpen} />
              </button>
              {overflowOpen ? (
                <div
                  role="menu"
                  data-testid="latex-toolbar-overflow-menu"
                  className={`left-0 min-w-[12rem] ${POPOVER}`}
                >
                  {overflowSnippets.map(overflowRow)}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Right — Source/Split/PDF + compile. Root detection stays internal unless it blocks compile. */}
      <div className="ml-auto flex min-w-0 max-w-full flex-nowrap items-center justify-end gap-2">
        {!compileOnly ? (
          <div
            className="inline-flex shrink-0 items-center overflow-hidden rounded border border-stone-200"
            role="group"
            aria-label="LaTeX view"
          >
            {VIEW_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                data-testid={`latex-view-${mode.id}`}
                aria-pressed={viewMode === mode.id}
                onClick={() => onViewModeChange(mode.id)}
                className={`inline-flex h-7 items-center border-l border-stone-200 px-2.5 text-[12px] transition-colors first:border-l-0 ${
                  viewMode === mode.id
                    ? 'bg-stone-300/70 text-stone-900'
                    : 'text-stone-600 hover:bg-stone-200/60 hover:text-stone-900'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        ) : null}

        <button
          type="button"
          data-testid="latex-compile-button"
          onClick={recompile}
          disabled={!canCompile || busy || !canRecompile}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded bg-stone-800 px-3 text-[12px] font-medium text-white transition-colors hover:bg-stone-700 disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? (
            <CircleNotchIcon className="h-3 w-3 animate-spin" weight="bold" aria-hidden />
          ) : (
            <PlayIcon className="h-3 w-3" weight="fill" aria-hidden />
          )}
          <span>{compileLabel}</span>
        </button>

        {!compileOnly && showStatus ? (
          <span
            data-testid="latex-compile-status"
            title={statusLabel}
            className={`inline-flex min-w-0 max-w-[9rem] items-center gap-1 text-[11px] font-medium ${compileError ? 'text-red-600' : 'text-stone-400'}`}
          >
            {compileError ? <WarningCircleIcon className="h-3.5 w-3.5" weight="fill" aria-hidden /> : null}
            <span className="truncate">{statusLabel}</span>
          </span>
        ) : null}

        {!compileOnly && fixInFlight ? (
          <span
            data-testid="latex-autofixing"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600"
          >
            <CircleNotchIcon className="h-3.5 w-3.5 animate-spin" weight="bold" aria-hidden />
            Auto-fixing…
          </span>
        ) : !compileOnly && compileError && canFix && onFix ? (
          <button
            type="button"
            data-testid="latex-toolbar-fix"
            onClick={onFix}
            title="Fix with Sunny"
            className="inline-flex h-7 items-center gap-1 rounded border border-indigo-300 bg-white px-2 text-[12px] font-medium text-indigo-700 transition-colors hover:bg-indigo-50"
          >
            <SparkleIcon className="h-3.5 w-3.5" weight="fill" aria-hidden />
            Fix with Sunny
          </button>
        ) : null}

        {!compileOnly && (compileError || logText) ? (
          <div className="relative">
            <button
              type="button"
              data-testid="latex-compile-log-toggle"
              aria-expanded={logOpen}
              onClick={() => setLogOpen((v) => !v)}
              className="inline-flex h-7 items-center rounded px-2 text-[12px] text-stone-600 transition-colors hover:bg-stone-200/60 hover:text-stone-900"
            >
              Log
            </button>
            {logOpen ? (
              <div data-testid="latex-compile-log" className={`right-0 w-80 ${POPOVER} p-2`}>
                {compileError ? (
                  <div className="mb-1 text-[11px] font-medium text-red-600">{compileError.message}</div>
                ) : null}
                {errorLines.length > 0 ? (
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {errorLines.map((entry) => (
                      <button
                        key={`${entry.line}:${entry.text}`}
                        type="button"
                        data-testid={`latex-log-line-${entry.line}`}
                        onClick={() => {
                          onNavigateToLine?.(entry.line);
                          setLogOpen(false);
                        }}
                        title={entry.text}
                        className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 font-mono text-[10px] text-red-700 transition-colors hover:bg-red-100"
                      >
                        l.{entry.line}
                      </button>
                    ))}
                  </div>
                ) : null}
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-stone-500">
                  {logText ? logText.split('\n').slice(-60).join('\n') : 'No log output.'}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}

      </div>
    </div>
  );
}
