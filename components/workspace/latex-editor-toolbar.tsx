'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  CheckIcon,
  DotsThreeIcon,
  ChatTextIcon,
  CircleNotchIcon,
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
  XIcon,
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
import { LATEX_BAR_CLASS, LATEX_ICON_BTN, type LatexViewMode } from '@/components/workspace/latex-workbench';
import { useElementWidth } from '@/components/workspace/doc-pane-header';
import type { LatexCompileController } from '@/components/workspace/use-latex-compile';
import type { LatexErrorLine } from '@/components/workspace/use-latex-compile';
import type { CodeEditorHandle } from '@/components/workspace/collab-code-editor';
import type { LatexMainDocumentState } from '@/components/workspace/latex-main-document';

/** `l.7` for the root, `intro.tex:42` for an included file. */
export function errorLineLabel(entry: LatexErrorLine): string {
  return entry.fileLabel ? `${entry.fileLabel}:${entry.line}` : `l.${entry.line}`;
}

export const UNRESOLVED_ERROR_TITLE = 'File is not in this workspace';

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
  /** Why compiling is blocked when `canCompile` is false ("Sign in to
   *  compile" / "Read-only access") — shown in the status chip so the
   *  disabled button is never silently dead. */
  compileBlockedLabel?: string | null;
  /** Makes the blocked chip actionable (e.g. open sign-in). Only passed when
   *  acting can actually unblock — a read-only collaborator gets no CTA. */
  onCompileBlockedClick?: () => void;
  onNavigateToLine?: (line: number, file?: string | null) => void;
  /**
   * Transient result of an explicit forward SyncTeX jump ("Show in PDF" in the
   * editor's right-click menu / Ctrl+Alt+J) — e.g. "Compile first". Monaco
   * actions have no surface of their own, so the hint lands here.
   */
  showInPdfHint?: string | null;
  /** Main-document resolution. Kept internal; only ambiguous/no-root states surface. */
  mainDocument?: LatexMainDocumentState;
  /** Measured toolbar width; drives the single-row overflow collapse. */
  containerWidth?: number;
  /** "Fix with Agent" — hands the compile error to the agent (in the status popover). */
  onFix?: () => void;
  canFix?: boolean;
  /** True while an auto-fix turn is streaming — shows a spinner and hides Fix. */
  fixInFlight?: boolean;
  /** Briefly pulse the Fix button: a new compile error just landed. */
  fixAttention?: boolean;
  /** First-run explanation anchored to the intentional compile error. */
  onboardingHint?: boolean;
  onDismissOnboardingHint?: () => void;
  /** Why the last Fix could not run — surfaced in the status popover. */
  fixBlocked?: LatexFixBlocked | null;
  onSignInForFix?: () => void;
  /** "Auto-fix on failure" preference (§1.11) — a row in the overflow menu. */
  autoFix?: boolean;
  onToggleAutoFix?: () => void;
  /** "Auto compile" preference (§1.2) — a row in the overflow menu. */
  autoCompile?: boolean;
  onToggleAutoCompile?: () => void;
  /** Overleaf-style split chrome: the PDF pane header seats the compile
   *  controls, so the toolbar drops its own copy (except in Source view,
   *  where the PDF pane — and its header — is collapsed). */
  showCompileControls?: boolean;
  /** Embedded panel: the bottom surface switcher owns Source/PDF. */
  hideViewSwitch?: boolean;
  /** Hairline on the divider-facing edge ('cut' chrome style). */
  edgeCut?: boolean;
}

/** A Fix send that could not run: 'signin' offers the sign-in CTA, 'error' is informational. */
export type LatexFixBlocked = { kind: 'signin' | 'error'; message: string };

interface LatexCompileControlsProps {
  viewMode: LatexViewMode;
  onViewModeChange: (mode: LatexViewMode) => void;
  compile: LatexCompileController;
  /** Whether the compile button is allowed to fire (write access). */
  canCompile: boolean;
  /** Why compiling is blocked when `canCompile` is false ("Sign in to
   *  compile" / "Read-only access") — shown in the status chip so the
   *  disabled button is never silently dead. */
  compileBlockedLabel?: string | null;
  /** Makes the blocked chip actionable (e.g. open sign-in). Only passed when
   *  acting can actually unblock — a read-only collaborator gets no CTA. */
  onCompileBlockedClick?: () => void;
  onNavigateToLine?: (line: number, file?: string | null) => void;
  mainDocument?: LatexMainDocumentState;
  onFix?: () => void;
  canFix?: boolean;
  fixInFlight?: boolean;
  fixAttention?: boolean;
  onboardingHint?: boolean;
  onDismissOnboardingHint?: () => void;
  /** Why the last Fix could not run — shown in the status popover. */
  fixBlocked?: LatexFixBlocked | null;
  /** Open sign-in (web Clerk modal / desktop handoff); enables the popover's Sign in button. */
  onSignInForFix?: () => void;
  /** Smallest layout: only the primary action plus the status chip (the chip
   *  is the sole error surface, so it never drops). */
  compact?: boolean;
  /** Narrow host (a squeezed PDF pane): keep Recompile + the view switcher +
   *  the status chip, drop the Log member. */
  hideDiagnostics?: boolean;
  /** Embedded panel (?view=panel): the layout's bottom surface switcher owns
   *  Source/PDF, so the toolbar's own Source/Split/PDF group would be a
   *  second, conflicting navigation. */
  hideViewSwitch?: boolean;
}

/** Recompile + Source/Split/PDF + compile status/log. Rendered by the editor
 *  toolbar in Source view and by the PDF pane header otherwise (Overleaf's
 *  split-chrome layout), so it lives once. The status chip anchors the compile
 *  status popover — THE error surface: it auto-opens on a failed compile
 *  (right where the user is looking after hitting Recompile) and carries the
 *  single Fix with Agent action. A green build whose log still parsed errors
 *  ("compiled with errors" — latexmk -f recovers most typos) shows an amber
 *  chip that opens the same popover on demand. */
export function LatexCompileControls({
  viewMode,
  onViewModeChange,
  compile,
  canCompile,
  compileBlockedLabel = null,
  onCompileBlockedClick,
  onNavigateToLine,
  mainDocument,
  onFix,
  canFix = false,
  fixInFlight = false,
  fixAttention = false,
  onboardingHint = false,
  onDismissOnboardingHint,
  fixBlocked = null,
  onSignInForFix,
  compact = false,
  hideDiagnostics = false,
  hideViewSwitch = false,
}: LatexCompileControlsProps) {
  const [logOpen, setLogOpen] = useState(false);
  const logAnchorRef = useRef<HTMLDivElement>(null);
  const statusAnchorRef = useRef<HTMLDivElement>(null);
  const statusPanelRef = useRef<HTMLDivElement>(null);
  const { compileLabel, busy, recompile, compileError, errorLines, logText, canRecompile, stale, lastCompiledAt } =
    compile;
  const showLog = !compact && !hideDiagnostics;

  const rootBlockedLabel = rootBlockedLabelFor(canRecompile, mainDocument);
  // No-write-access is the one blocker that used to render as a silently
  // dimmed button ("it didn't even try to compile" — user interviews). It
  // outranks the root states: without access, picking a root changes nothing.
  const accessBlockedLabel = canCompile ? null : (compileBlockedLabel ?? 'Read-only access');
  const blockedLabel = accessBlockedLabel ?? rootBlockedLabel;
  const failed = Boolean(compileError);
  // Green build, but the log still parsed jumpable errors: latexmk pushed
  // through recoverable mistakes (undefined macros, unclosed environments).
  const compiledWithErrors = !failed && errorLines.length > 0;
  const errorCount = errorLines.length || (failed ? 1 : 0);
  const statusLabel =
    blockedLabel ??
    (failed || compiledWithErrors ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : null);

  // The popover auto-opens once per NEW failure (same signature keying idea as
  // use-latex-autofix) and whenever a Fix send gets blocked — the sign-in ask
  // must surface itself. Closed by answer/outside-click/X; the chip reopens it.
  const failureKey = compileError
    ? errorLines.map((e) => `${e.line}:${e.text}`).join('|') || compileError.message
    : null;
  const [statusOpen, setStatusOpen] = useState(false);
  const openedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!failureKey) {
      openedForRef.current = null;
      return;
    }
    if (openedForRef.current === failureKey) return;
    openedForRef.current = failureKey;
    setStatusOpen(true);
  }, [failureKey]);
  useEffect(() => {
    if (fixBlocked) setStatusOpen(true);
  }, [fixBlocked]);
  // A fully clean build closes the panel — the repair (agent or manual) is the
  // natural end of the interaction. "Compiled with errors" keeps it open if
  // the user is already reading it.
  useEffect(() => {
    if (!compileError && errorLines.length === 0) setStatusOpen(false);
  }, [compileError, errorLines.length]);
  const statusOutsideRef = useOutsideClose(statusOpen, () => setStatusOpen(false), statusPanelRef);

  const statusChip = statusLabel ? (
    <div ref={statusAnchorRef} className="relative flex shrink-0 items-center">
      <div ref={statusOutsideRef} className="flex items-center">
        {blockedLabel ? (
          accessBlockedLabel && onCompileBlockedClick ? (
            <button
              type="button"
              data-testid="latex-compile-status"
              title={statusLabel ?? undefined}
              onClick={onCompileBlockedClick}
              className="inline-flex h-7 min-w-0 max-w-[9rem] items-center gap-1 rounded px-1.5 text-[11px] font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              <span className="truncate">{statusLabel}</span>
            </button>
          ) : (
            <span
              data-testid="latex-compile-status"
              title={statusLabel ?? undefined}
              className="inline-flex min-w-0 max-w-[9rem] items-center gap-1 text-[11px] font-medium text-stone-400"
            >
              <span className="truncate">{statusLabel}</span>
            </span>
          )
        ) : (
          <button
            type="button"
            data-testid="latex-compile-status"
            aria-expanded={statusOpen}
            title={failed ? 'Compile failed: show errors' : 'Compiled with errors: show them'}
            onClick={() => setStatusOpen((v) => !v)}
            className={`inline-flex h-7 min-w-0 max-w-[9rem] items-center gap-1 rounded px-1.5 text-[11px] font-medium transition-colors ${
              failed
                ? 'text-red-600 hover:bg-red-50'
                : 'text-amber-600 hover:bg-amber-50'
            }`}
          >
            <WarningCircleIcon className="h-3.5 w-3.5" weight="fill" aria-hidden />
            <span className="truncate">{statusLabel}</span>
          </button>
        )}
        {statusOpen && !blockedLabel ? (
          <CompileStatusPopover
            anchorRef={statusAnchorRef}
            panelRef={statusPanelRef}
            failed={failed}
            compileError={compileError}
            errorLines={errorLines}
            logText={logText}
            stale={stale}
            lastCompiledAt={lastCompiledAt}
            fixInFlight={fixInFlight}
            fixAttention={fixAttention}
            onboardingHint={onboardingHint}
            onDismissOnboardingHint={onDismissOnboardingHint}
            fixBlocked={fixBlocked}
            canFix={canFix}
            onFix={onFix}
            onSignInForFix={onSignInForFix}
            onNavigateToLine={onNavigateToLine}
            onClose={() => {
              setStatusOpen(false);
              if (onboardingHint) onDismissOnboardingHint?.();
            }}
          />
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <div className="flex min-w-0 max-w-full flex-nowrap items-center gap-2">
      <button
        type="button"
        data-testid="latex-compile-button"
        onClick={recompile}
        // Also held while a fix run is live: a manual recompile mid-fix
        // re-fails on the still-broken source and stomps the repair the
        // "Auto-fixing…" indicator is promising.
        disabled={!canCompile || busy || !canRecompile || fixInFlight}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded bg-stone-800 px-3 text-[12px] font-medium text-white transition-colors hover:bg-stone-700 disabled:pointer-events-none disabled:opacity-50"
      >
        {busy ? (
          <CircleNotchIcon className="h-3 w-3 animate-spin" weight="bold" aria-hidden />
        ) : (
          <PlayIcon className="h-3 w-3" weight="fill" aria-hidden />
        )}
        <span>{compileLabel}</span>
      </button>

      {!compact && !hideViewSwitch ? (
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

      {statusChip}

      {showLog && fixInFlight ? (
        <span
          data-testid="latex-autofixing"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600"
        >
          <CircleNotchIcon className="h-3.5 w-3.5 animate-spin" weight="bold" aria-hidden />
          Auto-fixing…
        </span>
      ) : null}

      {showLog && (compileError || logText) ? (
        <div ref={logAnchorRef} className="relative">
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
            <PopoverPanel
              anchorRef={logAnchorRef}
              estWidth={320}
              align="right"
              data-testid="latex-compile-log"
              className="w-80 p-2"
            >
              {compileError ? (
                <div className="mb-1 text-[11px] font-medium text-red-600">{compileError.message}</div>
              ) : null}
              {errorLines.length > 0 ? (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {errorLines.map((entry) => (
                    <button
                      key={`${entry.file ?? ''}:${entry.line}:${entry.text}`}
                      type="button"
                      data-testid={`latex-log-line-${entry.line}`}
                      disabled={!entry.file}
                      onClick={() => {
                        onNavigateToLine?.(entry.line, entry.file);
                        setLogOpen(false);
                      }}
                      title={entry.file ? entry.text : `${entry.text} (${UNRESOLVED_ERROR_TITLE})`}
                      className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 font-mono text-[10px] text-red-700 transition-colors hover:bg-red-100 disabled:cursor-default disabled:opacity-60"
                    >
                      {errorLineLabel(entry)}
                    </button>
                  ))}
                </div>
              ) : null}
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-stone-500">
                {logText ? logText.split('\n').slice(-60).join('\n') : 'No log output.'}
              </pre>
            </PopoverPanel>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatCompiledAt(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The compile status panel under the status chip: what broke, where (jumpable
 *  rows), the log tail, and the one Fix with Agent action — or, when a Fix
 *  send was blocked, the sign-in ask. Anchored where the user is already
 *  looking after a compile, replacing the old bottom-of-editor strip. */
function CompileStatusPopover({
  anchorRef,
  panelRef,
  failed,
  compileError,
  errorLines,
  logText,
  stale,
  lastCompiledAt,
  fixInFlight,
  fixAttention,
  onboardingHint,
  onDismissOnboardingHint,
  fixBlocked,
  canFix,
  onFix,
  onSignInForFix,
  onNavigateToLine,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  failed: boolean;
  compileError: { message: string } | null;
  errorLines: LatexErrorLine[];
  logText: string;
  stale: boolean;
  lastCompiledAt: number | null;
  fixInFlight: boolean;
  fixAttention: boolean;
  onboardingHint: boolean;
  onDismissOnboardingHint?: () => void;
  fixBlocked: LatexFixBlocked | null;
  canFix: boolean;
  onFix?: () => void;
  onSignInForFix?: () => void;
  onNavigateToLine?: (line: number, file?: string | null) => void;
  onClose: () => void;
}) {
  const [showFullLog, setShowFullLog] = useState(false);
  return (
    <PopoverPanel
      anchorRef={anchorRef}
      panelRef={panelRef}
      estWidth={360}
      align="right"
      role="dialog"
      data-testid="compile-status-popover"
      className="w-[22.5rem] p-3"
    >
      {onboardingHint ? (
        <div
          data-testid="onboarding-tex-coachmark"
          className="mb-3 rounded-lg border border-stone-300 bg-stone-100 p-3 shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
        >
          <div className="flex items-start gap-2.5 border-l-2 border-stone-950 pl-3">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-stone-950 text-white">
              <SparkleIcon className="h-3.5 w-3.5" weight="fill" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-stone-600">
                  Onboarding · 1 of 1
                </div>
                <button
                  type="button"
                  data-testid="onboarding-tex-skip"
                  onClick={onDismissOnboardingHint}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-stone-500 transition-colors hover:bg-white hover:text-stone-950"
                >
                  Skip onboarding
                </button>
              </div>
              <div className="mt-1 text-[13px] font-semibold text-stone-900">This error is intentional.</div>
              <p className="mt-1 text-[11px] leading-4 text-stone-600">
                Click the highlighted button below. Sunny will repair the TeX and recompile the PDF, so you can watch a reviewable agent edit land.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div
            className={`text-[12px] font-semibold ${failed ? 'text-red-600' : 'text-amber-600'}`}
          >
            {failed
              ? 'Compile failed'
              : `Compiled with ${errorLines.length} error${errorLines.length === 1 ? '' : 's'}`}
          </div>
          {failed && compileError && errorLines.length === 0 ? (
            <div className="mt-0.5 truncate text-[11px] text-stone-600" title={compileError.message}>
              {compileError.message}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          data-testid="compile-status-close"
          aria-label="Close compile status"
          onClick={onClose}
          className="rounded p-0.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
        >
          <XIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
        </button>
      </div>

      {errorLines.length > 0 ? (
        <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-auto">
          {errorLines.map((entry) => (
            <button
              key={`${entry.file ?? ''}:${entry.line}:${entry.text}`}
              type="button"
              data-testid="compile-error-row"
              disabled={!entry.file}
              onClick={() => onNavigateToLine?.(entry.line, entry.file)}
              title={entry.file ? 'Jump to line' : UNRESOLVED_ERROR_TITLE}
              className="flex min-w-0 items-baseline gap-2 rounded border border-stone-200 bg-stone-50 px-2 py-1 text-left transition-colors hover:bg-white disabled:cursor-default disabled:opacity-60 disabled:hover:bg-stone-50"
            >
              <span className={`shrink-0 font-mono text-[10px] ${failed ? 'text-red-700' : 'text-amber-700'}`}>
                {errorLineLabel(entry)}
              </span>
              <span className="min-w-0 truncate text-[11px] text-stone-700">{entry.text}</span>
            </button>
          ))}
        </div>
      ) : null}

      {logText ? (
        <div className="mt-2">
          <button
            type="button"
            data-testid="compile-status-log-toggle"
            aria-expanded={showFullLog}
            onClick={() => setShowFullLog((v) => !v)}
            className="text-[11px] font-medium text-stone-500 transition-colors hover:text-stone-800"
          >
            {showFullLog ? 'Hide log' : 'Show log'}
          </button>
          {showFullLog ? (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-stone-500">
              {logText.split('\n').slice(-60).join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[10px] text-stone-400">
          {stale && lastCompiledAt != null
            ? `Showing the last successful build (${formatCompiledAt(lastCompiledAt)})`
            : lastCompiledAt != null
              ? `Compiled ${formatCompiledAt(lastCompiledAt)}`
              : ''}
        </span>
        {fixInFlight ? (
          <span
            data-testid="compile-status-autofixing"
            className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-indigo-600"
          >
            <CircleNotchIcon className="h-3.5 w-3.5 animate-spin" weight="bold" aria-hidden />
            Auto-fixing…
          </span>
        ) : fixBlocked ? (
          <span className="flex min-w-0 shrink items-center justify-end gap-2">
            <span data-testid="compile-fix-blocked" className="min-w-0 truncate text-[11px] text-red-700">
              {fixBlocked.message}
            </span>
            {fixBlocked.kind === 'signin' && onSignInForFix ? (
              <button
                type="button"
                data-testid="compile-fix-signin"
                onClick={onSignInForFix}
                className="shrink-0 rounded bg-stone-900 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-stone-800"
              >
                Sign in
              </button>
            ) : null}
          </span>
        ) : canFix && onFix ? (
          <button
            type="button"
            data-testid="latex-toolbar-fix"
            onClick={onFix}
            className={`inline-flex h-7 shrink-0 items-center gap-1 rounded border bg-white px-2.5 text-[12px] font-medium transition-all ${
              onboardingHint
                ? 'border-stone-950 text-stone-950 ring-4 ring-stone-300 shadow-[0_6px_18px_rgba(0,0,0,0.16)] hover:bg-stone-100'
                : 'border-indigo-300 text-indigo-700 hover:bg-indigo-50'
            }${
              fixAttention ? ' latex-fix-attention' : ''
            }`}
          >
            <SparkleIcon className="h-3.5 w-3.5" weight="fill" aria-hidden />
            Fix with Agent
          </button>
        ) : null}
      </div>
    </PopoverPanel>
  );
}

// Progressive reveal: each authoring control has an estimated width and shows
// strictly left→right as the measured bar grows — one icon at a time, never a
// whole tier at once. Everything past the fit line folds into the ⋯ menu.
// Estimates: icon button 28px (h-7 w-7); menu trigger 42px (px-1.5 12 + icon
// 16 + gap-0.5 2 + caret 12); group separator 13px (ml-1 + border + pl-2);
// 2px gap-0.5 between siblings inside a ToolbarGroup.
const ICON_UNIT = 28;
const MENU_UNIT = 42;
const GROUP_START = 13;
const GROUP_GAP = 2;
// Reserved beside the authoring icons: root px-3 padding + the ⋯ trigger and
// its gap; the compile cluster (when this bar carries it) reserves its own
// estimate, shrinking to just Recompile below the compact line and growing
// when a failed compile adds the status/Fix/Log members.
const TOOLBAR_PADDING = 24 + ICON_UNIT + 8;
const COMPILE_CLUSTER_W = 300;
// The Fix button moved into the status popover, so the error-state cluster
// only grows by the chip + Log (or the auto-fixing spinner).
const COMPILE_ERROR_EXTRA_W = 180;
const COMPILE_STATUS_CHIP_W = 92;
const COMPILE_BUTTON_W = 140;
const COMPACT_COMPILE_MIN = 460;
// `group` boundaries reproduce the separator layout for whatever prefix is
// visible; ids key the render switch below.
const TOOLBAR_UNITS: ReadonlyArray<{ id: string; width: number; group: number }> = [
  { id: 'undo', width: ICON_UNIT, group: 0 },
  { id: 'redo', width: ICON_UNIT, group: 0 },
  { id: 'sections', width: MENU_UNIT, group: 1 },
  { id: 'bold', width: ICON_UNIT, group: 2 },
  { id: 'italic', width: ICON_UNIT, group: 2 },
  { id: 'math', width: MENU_UNIT, group: 3 },
  { id: 'symbols', width: ICON_UNIT, group: 3 },
  { id: 'link', width: ICON_UNIT, group: 4 },
  { id: 'comment', width: ICON_UNIT, group: 4 },
  { id: 'xref', width: ICON_UNIT, group: 4 },
  { id: 'cite', width: ICON_UNIT, group: 4 },
  { id: 'figure', width: ICON_UNIT, group: 4 },
  { id: 'table', width: ICON_UNIT, group: 4 },
  { id: 'list', width: MENU_UNIT, group: 4 },
];
// Static icon/snippet pairing for the single-button units, keyed by unit id so
// the bar and the ⋯ menu can never disagree on which snippet an id means.
const INSERT_UNITS: Record<string, { snippet: LatexSnippet; icon: ReactNode }> = {
  bold: { snippet: BOLD_SNIPPET, icon: <TextBIcon className="h-4 w-4" weight="bold" aria-hidden /> },
  italic: { snippet: ITALIC_SNIPPET, icon: <TextItalicIcon className="h-4 w-4" weight="regular" aria-hidden /> },
  link: { snippet: LINK_SNIPPET, icon: <LinkIcon className="h-4 w-4" weight="regular" aria-hidden /> },
  comment: { snippet: COMMENT_SNIPPET, icon: <ChatTextIcon className="h-4 w-4" weight="regular" aria-hidden /> },
  xref: { snippet: XREF_SNIPPET, icon: <LinkSimpleHorizontalIcon className="h-4 w-4" weight="regular" aria-hidden /> },
  cite: { snippet: CITATION_SNIPPET, icon: <QuotesIcon className="h-4 w-4" weight="regular" aria-hidden /> },
  figure: { snippet: FIGURE_SNIPPET, icon: <ImageIcon className="h-4 w-4" weight="regular" aria-hidden /> },
  table: { snippet: TABLE_SNIPPET, icon: <TableIcon className="h-4 w-4" weight="regular" aria-hidden /> },
};

const VIEW_MODES: Array<{ id: LatexViewMode; label: string }> = [
  { id: 'source', label: 'Source' },
  { id: 'split', label: 'Split' },
  { id: 'pdf', label: 'PDF' },
];

// Shared design tokens with the markdown toolbar so the two authoring rows read
// as one system (components/workspace/markdown-toolbar.tsx). The value lives in
// latex-workbench.tsx because the PDF header shares it across the seam.
// "No TeX root" is a verdict about the project, not a loading state: until
// the resolver has answered once (`resolved`), compile is blocked simply
// because nothing has resolved yet, and saying so libels a project whose
// root is about to appear — the first-open complaint on local folders.
// Module-level because the width budget must reserve chip space with exactly
// the rule the cluster renders by (the 360px overflow bug was these drifting).
function rootBlockedLabelFor(canRecompile: boolean, mainDocument?: LatexMainDocumentState) {
  return canRecompile
    ? null
    : mainDocument?.unreachable
      ? "Can't read project files"
      : mainDocument?.reason === 'ambiguous'
        ? 'Open a root .tex'
        : mainDocument && !mainDocument.resolved
          ? null
          : 'No TeX root';
}

const ICON_BTN = LATEX_ICON_BTN;
const DROPDOWN_ITEM =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-stone-700 transition-colors hover:bg-stone-100 disabled:pointer-events-none disabled:opacity-40';
const POPOVER =
  'rounded-lg border border-stone-200 bg-white p-1 shadow-[0_8px_24px_-12px_rgba(28,25,23,0.35)]';

/** Portal panel anchored under a trigger. The toolbar lives inside the
 *  workbench's overflow-hidden editor pane, so in-flow absolute menus get
 *  clipped at the divider — panels render fixed on <body> instead (same
 *  pattern as EditModeControl) and clamp to the viewport. */
function PopoverPanel({
  anchorRef,
  panelRef,
  estWidth,
  align = 'left',
  className = '',
  children,
  ...rest
}: {
  anchorRef: RefObject<HTMLElement | null>;
  panelRef?: RefObject<HTMLDivElement | null>;
  /** Estimated panel width, for viewport clamping and right-alignment. */
  estWidth: number;
  align?: 'left' | 'right';
  className?: string;
  children: ReactNode;
  role?: string;
  'data-testid'?: string;
}) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = align === 'right' ? rect.right - estWidth : rect.left;
      setPos({
        left: Math.max(12, Math.min(left, window.innerWidth - estWidth - 12)),
        top: rect.bottom + 4,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef, align, estWidth]);
  if (!pos || typeof document === 'undefined') return null;
  return createPortal(
    <div ref={panelRef} style={pos} className={`fixed z-[80] ${POPOVER} ${className}`} {...rest}>
      {children}
    </div>,
    document.body,
  );
}

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

function useOutsideClose(open: boolean, onClose: () => void, panelRef?: RefObject<HTMLDivElement | null>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => {
      const target = event.target as Node;
      // Portaled panels are outside the trigger's DOM tree — clicks inside
      // them must not count as outside.
      if (ref.current?.contains(target) || panelRef?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open, onClose, panelRef]);
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
  const panelRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(open, () => setOpen(false), panelRef);
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
        <PopoverPanel
          anchorRef={ref}
          panelRef={panelRef}
          estWidth={176}
          role="menu"
          data-testid={`latex-menu-${id}`}
          className="min-w-[11rem]"
        >
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
        </PopoverPanel>
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
  const panelRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(open, () => onOpenChange(false), panelRef);
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
        <PopoverPanel
          anchorRef={ref}
          panelRef={panelRef}
          estWidth={304}
          data-testid="latex-symbols-palette"
          className="w-[19rem] p-2"
        >
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
        </PopoverPanel>
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
  compileBlockedLabel = null,
  onCompileBlockedClick,
  onNavigateToLine,
  showInPdfHint,
  mainDocument,
  containerWidth = Infinity,
  onFix,
  canFix = false,
  fixInFlight = false,
  fixAttention = false,
  onboardingHint = false,
  onDismissOnboardingHint,
  fixBlocked = null,
  onSignInForFix,
  autoFix = false,
  onToggleAutoFix,
  autoCompile = false,
  onToggleAutoCompile,
  showCompileControls = true,
  hideViewSwitch = false,
  edgeCut = false,
}: LatexEditorToolbarProps) {
  const [symbolsOpen, setSymbolsOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowPanelRef = useRef<HTMLDivElement>(null);
  const overflowRef = useOutsideClose(overflowOpen, () => setOverflowOpen(false), overflowPanelRef);

  const measuredWidth = containerWidth === 0 ? 0 : containerWidth;
  const compactCompile = showCompileControls && measuredWidth < COMPACT_COMPILE_MIN;
  // The status chip is the sole error surface, so it shows even compact — the
  // reserve must cover it whenever the cluster will render it: errors (failed
  // OR compiled-with-errors) and the root-blocked states alike.
  const compileHasErrors = Boolean(compile.compileError) || compile.errorLines.length > 0;
  const statusChipShows =
    compileHasErrors || !canCompile || rootBlockedLabelFor(compile.canRecompile, mainDocument) !== null;
  let budget =
    measuredWidth -
    TOOLBAR_PADDING -
    (showCompileControls
      ? compactCompile
        ? COMPILE_BUTTON_W + (statusChipShows ? COMPILE_STATUS_CHIP_W : 0)
        : COMPILE_CLUSTER_W +
          // Errors grow the cluster (status chip + Log / auto-fix spinner) —
          // reserve for it, or the icons over-reveal and push those controls
          // into the pane's overflow-hidden clip exactly when they're needed.
          // Root-blocked states grow it by just the chip.
          (compileHasErrors || fixInFlight
            ? COMPILE_ERROR_EXTRA_W
            : statusChipShows
              ? COMPILE_STATUS_CHIP_W
              : 0)
      : 0);
  const visibleIds = new Set<string>();
  let lastGroup: number | null = null;
  for (const unit of TOOLBAR_UNITS) {
    // Prefix only — the reveal order IS the display order, so icons appear
    // one at a time from the left and never reshuffle.
    const cost =
      unit.width +
      (lastGroup === null ? 0 : unit.group !== lastGroup ? GROUP_START : unit.group === 0 ? 0 : GROUP_GAP);
    if (measuredWidth === 0 || budget < cost) break;
    visibleIds.add(unit.id);
    budget -= cost;
    lastGroup = unit.group;
  }
  const hiddenUnits = TOOLBAR_UNITS.filter((unit) => !visibleIds.has(unit.id));
  // The overflow menu also hosts the auto-fix / auto-compile preferences, so
  // it stays available at full width — where no control is collapsed into it.
  const hasPrefRows = Boolean(onToggleAutoFix) || Boolean(onToggleAutoCompile);
  const showOverflow = measuredWidth > 0 && (hiddenUnits.length > 0 || hasPrefRows);

  // A control folding away unmounts its popover but not the parent-held open
  // flag — without a reset, re-widening the bar would pop the palette or the
  // ⋯ menu back open unprompted.
  const symbolsVisible = visibleIds.has('symbols');
  useEffect(() => {
    if (!symbolsVisible) setSymbolsOpen(false);
  }, [symbolsVisible]);
  useEffect(() => {
    if (!showOverflow) setOverflowOpen(false);
  }, [showOverflow]);

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
  const actionRow = (id: string, label: string, run: () => void) => (
    <button
      key={id}
      type="button"
      role="menuitem"
      data-testid={`latex-overflow-${id}`}
      disabled={readOnly}
      onClick={() => {
        run();
        setOverflowOpen(false);
      }}
      className={DROPDOWN_ITEM}
    >
      {label}
    </button>
  );

  // Hidden units surface in the ⋯ menu, in display order. The symbol palette
  // needs its trigger mounted to anchor, so it has no menu fallback. Built
  // lazily — the rows only exist while the menu is open, not on every resize
  // tick of a drag.
  const overflowRows = () =>
    hiddenUnits.flatMap((unit): ReactNode[] => {
      switch (unit.id) {
        case 'undo':
          return [actionRow('undo', 'Undo', onUndo)];
        case 'redo':
          return [actionRow('redo', 'Redo', onRedo)];
        case 'sections':
          return SECTION_SNIPPETS.map(overflowRow);
        case 'math':
          return MATH_SNIPPETS.map(overflowRow);
        case 'list':
          return LIST_SNIPPETS.map(overflowRow);
        case 'symbols':
          return [];
        default: {
          const insert = INSERT_UNITS[unit.id];
          return insert ? [overflowRow(insert.snippet)] : [];
        }
      }
    });

  // The math menu's "Symbols…" entry opens the Ω palette, which anchors to
  // its own (possibly hidden) trigger — only offer it while Ω is mounted
  // (symbolsVisible, computed with the reset effects above).
  const unitNode = (id: string): ReactNode => {
    switch (id) {
      case 'undo':
        return (
          <ToolbarButton key="undo" testId="latex-undo" onClick={onUndo} disabled={readOnly} label="Undo">
            <ArrowCounterClockwiseIcon className="h-4 w-4" weight="regular" aria-hidden />
          </ToolbarButton>
        );
      case 'redo':
        return (
          <ToolbarButton key="redo" testId="latex-redo" onClick={onRedo} disabled={readOnly} label="Redo">
            <ArrowClockwiseIcon className="h-4 w-4" weight="regular" aria-hidden />
          </ToolbarButton>
        );
      case 'sections':
        return (
          <SnippetMenu
            key="sections"
            id="format"
            label="Section level"
            icon={<TextTIcon className="h-4 w-4" weight="regular" aria-hidden />}
            snippets={SECTION_SNIPPETS}
            disabled={readOnly}
            onInsert={onInsert}
          />
        );
      case 'math':
        return (
          <SnippetMenu
            key="math"
            id="math"
            label="Insert math"
            icon={<FunctionIcon className="h-4 w-4" weight="regular" aria-hidden />}
            snippets={MATH_SNIPPETS}
            disabled={readOnly}
            onInsert={onInsert}
            extra={
              symbolsVisible
                ? (close) => (
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
                  )
                : undefined
            }
          />
        );
      case 'symbols':
        return (
          <SymbolPalette
            key="symbols"
            open={symbolsOpen}
            onOpenChange={setSymbolsOpen}
            disabled={readOnly}
            onInsertText={onInsertText}
          />
        );
      case 'list':
        return (
          <SnippetMenu
            key="list"
            id="list"
            label="Insert list"
            icon={<ListBulletsIcon className="h-4 w-4" weight="regular" aria-hidden />}
            snippets={LIST_SNIPPETS}
            disabled={readOnly}
            onInsert={onInsert}
          />
        );
      default: {
        const insert = INSERT_UNITS[id];
        return insert ? renderInsert(insert) : null;
      }
    }
  };

  // Consecutive visible units of one group share a ToolbarGroup so the
  // separator layout matches the full bar for any visible prefix.
  const segments: Array<{ group: number; ids: string[] }> = [];
  for (const unit of TOOLBAR_UNITS) {
    if (!visibleIds.has(unit.id)) continue;
    const last = segments[segments.length - 1];
    if (last && last.group === unit.group) last.ids.push(unit.id);
    else segments.push({ group: unit.group, ids: [unit.id] });
  }

  return (
    <div
      data-testid="latex-toolbar"
      role="toolbar"
      aria-label="LaTeX document toolbar"
      // Flush full-bleed bar (no floating card): it caps its own pane, so it
      // only pays for its buttons plus a hairline.
      className={`${LATEX_BAR_CLASS} flex w-full min-w-0 flex-nowrap items-center gap-x-2 overflow-visible border-b border-stone-200 bg-white px-3 ${
        edgeCut ? 'border-r' : ''
      }`}
    >
      {/* Authoring tools — Overleaf source-toolbar order, revealed one icon at
          a time as the bar widens; the rest live in the ⋯ menu. */}
      {measuredWidth > 0 ? (
        <div className="flex min-w-fit items-center">
          {segments.map((segment) =>
            segment.group === 0 ? (
              <div key={`seg-${segment.group}`} className="flex items-center">
                {segment.ids.map(unitNode)}
              </div>
            ) : (
              <ToolbarGroup key={`seg-${segment.group}`}>{segment.ids.map(unitNode)}</ToolbarGroup>
            ),
          )}

          {showOverflow ? (
            <div ref={overflowRef} className="relative flex h-7 shrink-0 items-center">
              <button
                type="button"
                data-testid="latex-toolbar-overflow"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-label="More tools"
                disabled={readOnly && !hasPrefRows}
                onClick={() => setOverflowOpen((v) => !v)}
                className={`${ICON_BTN} ${overflowOpen ? 'bg-stone-200/80 text-stone-900' : ''}`}
              >
                <DotsThreeIcon className="h-4 w-4" weight="bold" aria-hidden />
                <IconTooltip label="More tools" open={overflowOpen} />
              </button>
              {overflowOpen ? (
                <PopoverPanel
                  anchorRef={overflowRef}
                  panelRef={overflowPanelRef}
                  estWidth={192}
                  role="menu"
                  data-testid="latex-toolbar-overflow-menu"
                  className="min-w-[12rem]"
                >
                  {overflowRows()}
                  {hasPrefRows ? (
                    <>
                      {hiddenUnits.length === 0 ? null : <div className="my-1 h-px bg-stone-100" />}
                      {onToggleAutoCompile ? (
                        <button
                          type="button"
                          role="menuitemcheckbox"
                          data-testid="latex-overflow-autocompile"
                          aria-checked={autoCompile}
                          onClick={onToggleAutoCompile}
                          className={DROPDOWN_ITEM}
                        >
                          <CheckIcon
                            className={`h-3.5 w-3.5 ${autoCompile ? '' : 'invisible'}`}
                            weight="bold"
                            aria-hidden
                          />
                          Auto compile
                        </button>
                      ) : null}
                      {onToggleAutoFix ? (
                        <button
                          type="button"
                          role="menuitemcheckbox"
                          data-testid="latex-overflow-autofix"
                          aria-checked={autoFix}
                          onClick={onToggleAutoFix}
                          className={DROPDOWN_ITEM}
                        >
                          <CheckIcon
                            className={`h-3.5 w-3.5 ${autoFix ? '' : 'invisible'}`}
                            weight="bold"
                            aria-hidden
                          />
                          Auto-fix on failure
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </PopoverPanel>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Right — the explicit forward-search hint ("Show in PDF" has no Monaco
          surface of its own) plus the shared compile cluster, the latter only
          while this bar is the one that must carry it (Source view / mobile). */}
      {showInPdfHint || showCompileControls ? (
        <div className="ml-auto flex min-w-0 max-w-full flex-nowrap items-center justify-end gap-2">
          {showInPdfHint ? (
            <span
              data-testid="latex-show-in-pdf-hint"
              role="status"
              className="min-w-0 truncate text-[11px] text-stone-400"
            >
              {showInPdfHint}
            </span>
          ) : null}
          {showCompileControls ? (
            <LatexCompileControls
              viewMode={viewMode}
              onViewModeChange={onViewModeChange}
              compile={compile}
              canCompile={canCompile}
              compileBlockedLabel={compileBlockedLabel}
              onCompileBlockedClick={onCompileBlockedClick}
              onNavigateToLine={onNavigateToLine}
              mainDocument={mainDocument}
              onFix={onFix}
              canFix={canFix}
              fixInFlight={fixInFlight}
              fixAttention={fixAttention}
              onboardingHint={onboardingHint}
              onDismissOnboardingHint={onDismissOnboardingHint}
              fixBlocked={fixBlocked}
              onSignInForFix={onSignInForFix}
              hideViewSwitch={hideViewSwitch}
              compact={compactCompile}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Self-measuring toolbar row: owns the ResizeObserver so a divider drag
 *  re-renders ~14 buttons, not the state of whichever page hosts it (per-pixel
 *  width state in the 14k-line workspace page re-rendered the whole app). */
export function LatexToolbarRow(props: Omit<LatexEditorToolbarProps, 'containerWidth'>) {
  const [rowRef, rowWidth] = useElementWidth();
  return (
    <div ref={rowRef} className="shrink-0">
      <LatexEditorToolbar {...props} containerWidth={rowWidth} />
    </div>
  );
}
