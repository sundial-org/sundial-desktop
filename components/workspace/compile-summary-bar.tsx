'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SparkleIcon, CaretDownIcon, CaretRightIcon, CircleNotchIcon } from '@phosphor-icons/react';
import type { CompileErrorState, LatexErrorLine } from '@/components/workspace/use-latex-compile';

/**
 * The compile status strip under the LaTeX editor (Waves 2–3): on success a slim
 * "Compiled 2:14 PM" line; on failure a one-line summary (§1.9), a "Fix with
 * Sunny" action (§1.10), an expandable error/log panel, and a "stale" badge when
 * a last-good PDF is still mounted (§1.4). The per-user "auto-fix on failed
 * compile" toggle (§1.11) lives here too and persists in localStorage; when on,
 * a fresh failure auto-launches the same Fix turn so Sunny self-heals visibly.
 *
 * `onFix` is a normal chat turn (see lib/latex/fix-prompt.ts) — no new endpoint.
 * Self-contained and unit-tested; the host only wires `onFix`/`onNavigateToLine`.
 */

const AUTOFIX_STORAGE_KEY = 'sundial:latex-autofix';

function formatCompiledAt(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function summarize(compileError: CompileErrorState, errorLines: LatexErrorLine[]): string {
  const first = errorLines[0];
  if (first) return `l.${first.line}: ${first.text}`;
  return compileError.message;
}

type Props = {
  compileError: CompileErrorState | null;
  errorLines: LatexErrorLine[];
  logText: string;
  stale: boolean;
  lastCompiledAt: number | null;
  compiling: boolean;
  /** Whether a fix can be sent now (write access + an open chat). */
  canFix?: boolean;
  /** Send a fix turn. Omit on surfaces with no chat — Fix + auto-fix hide. */
  onFix?: () => void;
  /** True while a fix turn is streaming — shows a spinner and hides the Fix button. */
  fixInFlight?: boolean;
  onNavigateToLine?: (line: number) => void;
};

export function CompileSummaryBar({
  compileError,
  errorLines,
  logText,
  stale,
  lastCompiledAt,
  compiling,
  canFix = false,
  onFix,
  fixInFlight = false,
  onNavigateToLine,
}: Props) {
  const fixable = Boolean(onFix);
  const [expanded, setExpanded] = useState(false);
  const [autoFix, setAutoFix] = useState(false);

  useEffect(() => {
    try {
      setAutoFix(localStorage.getItem(AUTOFIX_STORAGE_KEY) === '1');
    } catch {
      // localStorage unavailable (SSR/private mode) — default off.
    }
  }, []);

  const toggleAutoFix = useCallback(() => {
    setAutoFix((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(AUTOFIX_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore — preference simply won't persist this session.
      }
      return next;
    });
  }, []);

  // Auto-launch a Fix once per *new* failure when the toggle is on (§1.11). Keyed
  // off the *parsed* error signature (stable line:text), not the raw log tail —
  // tectonic dumps embed absolute paths/timestamps that shift between otherwise
  // identical failures and would otherwise re-fire a turn on every recompile.
  // A successful compile (no error) clears the key so the next failure can fire.
  const errorSignature = errorLines.map((e) => `${e.line}:${e.text}`).join('|');
  const firedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!compileError) {
      firedForRef.current = null;
      return;
    }
    if (!autoFix || !canFix || compiling || !onFix) return;
    const key = errorSignature || compileError.message;
    if (firedForRef.current === key) return;
    firedForRef.current = key;
    onFix();
  }, [compileError, errorSignature, autoFix, canFix, compiling, onFix]);

  if (!compileError) {
    if (lastCompiledAt == null) return null;
    return (
      <div
        data-testid="compile-summary-bar"
        className="flex items-center justify-between gap-3 border-t border-stone-200 bg-white px-3 py-1.5 text-[11px] text-stone-500"
      >
        <span data-testid="compile-timestamp">Compiled {formatCompiledAt(lastCompiledAt)}</span>
        {fixable ? <AutoFixToggle enabled={autoFix} onToggle={toggleAutoFix} /> : null}
      </div>
    );
  }

  return (
    <div
      data-testid="compile-summary-bar"
      className="border-t border-red-200 bg-red-50 text-[11px] text-red-700"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          data-testid="compile-summary-expand"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide compile errors' : 'Show compile errors'}
          className="inline-flex items-center gap-1 truncate text-left font-medium text-red-700 transition-colors hover:text-red-900"
        >
          {expanded ? (
            <CaretDownIcon size={12} weight="bold" aria-hidden />
          ) : (
            <CaretRightIcon size={12} weight="bold" aria-hidden />
          )}
          <span className="truncate" title={summarize(compileError, errorLines)}>
            {summarize(compileError, errorLines)}
          </span>
        </button>

        {stale ? (
          <span
            data-testid="compile-stale-badge"
            className="shrink-0 rounded border border-stone-300 bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-stone-500"
            title="Showing the last successful build"
          >
            stale
          </span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {lastCompiledAt != null ? (
            <span data-testid="compile-timestamp" className="text-stone-500">
              Compiled {formatCompiledAt(lastCompiledAt)}
            </span>
          ) : null}
          {fixInFlight ? (
            <span
              data-testid="compile-autofixing"
              className="inline-flex items-center gap-1 font-medium text-indigo-600"
            >
              <CircleNotchIcon size={12} weight="bold" className="animate-spin" aria-hidden />
              Auto-fixing…
            </span>
          ) : fixable ? (
            <button
              type="button"
              data-testid="compile-fix-with-sunny"
              disabled={!canFix || compiling}
              onClick={onFix}
              className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2 py-0.5 font-medium text-red-700 transition-colors hover:bg-red-100 disabled:pointer-events-none disabled:opacity-40"
            >
              <SparkleIcon size={12} weight="fill" aria-hidden />
              Fix with Sunny
            </button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-red-200 px-3 py-2">
          {errorLines.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {errorLines.map((entry) => (
                <button
                  key={`${entry.line}:${entry.text}`}
                  type="button"
                  onClick={() => onNavigateToLine?.(entry.line)}
                  className="rounded-md border border-red-200 bg-white/70 px-2 py-1 text-left font-mono text-[11px] text-red-800 transition-colors hover:bg-white"
                  title={entry.text}
                >
                  l.{entry.line}
                </button>
              ))}
            </div>
          ) : null}
          {logText ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-red-800/90">
              {logText.split('\n').slice(-40).join('\n')}
            </pre>
          ) : null}
          {fixable ? (
            <div className="mt-2 flex justify-end">
              <AutoFixToggle enabled={autoFix} onToggle={toggleAutoFix} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AutoFixToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-testid="compile-autofix-toggle"
      role="switch"
      aria-checked={enabled}
      onClick={onToggle}
      className="shrink-0 text-[11px] text-stone-500 underline-offset-2 transition-colors hover:text-stone-700 hover:underline"
    >
      Auto-fix on failure: {enabled ? 'on' : 'off'}
    </button>
  );
}
