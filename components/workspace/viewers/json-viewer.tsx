'use client';

import { useCallback, useMemo, useState } from 'react';
import { CaretRightIcon, WarningIcon } from '@phosphor-icons/react';

interface JSONViewerProps {
  content: string;
  fileName: string;
}

// Recursively render a JSON value as a collapsible tree
function JSONNode({ name, value, depth, defaultOpen }: {
  name?: string;
  value: unknown;
  depth: number;
  defaultOpen: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArray = Array.isArray(value);
  const isExpandable = isObject || isArray;

  const entries = useMemo(() => {
    if (isArray) return value.map((v, i) => [String(i), v] as const);
    if (isObject) return Object.entries(value as Record<string, unknown>);
    return [];
  }, [value, isArray, isObject]);

  const toggle = useCallback(() => setIsOpen((o) => !o), []);

  const renderValue = (v: unknown) => {
    if (v === null) return <span className="text-rose-400 italic">null</span>;
    if (v === undefined) return <span className="text-stone-400 italic">undefined</span>;
    if (typeof v === 'boolean') return <span className="text-violet-500">{String(v)}</span>;
    if (typeof v === 'number') return <span className="text-blue-500">{String(v)}</span>;
    if (typeof v === 'string') {
      const display = v.length > 200 ? v.slice(0, 200) + '...' : v;
      return <span className="text-emerald-600">&quot;{display}&quot;</span>;
    }
    return <span className="text-stone-500">{String(v)}</span>;
  };

  if (!isExpandable) {
    return (
      <div className="flex items-start gap-1 py-0.5" style={{ paddingLeft: depth * 16 }}>
        {name !== undefined && (
          <span className="text-stone-500 shrink-0">{name}: </span>
        )}
        <span className="font-mono text-xs">{renderValue(value)}</span>
      </div>
    );
  }

  const bracket = isArray ? ['[', ']'] : ['{', '}'];
  const childCount = entries.length;
  const summary = `${childCount} ${isArray ? 'item' : 'key'}${childCount !== 1 ? 's' : ''}`;

  return (
    <div>
      <div
        className="flex items-center gap-1 py-0.5 cursor-pointer hover:bg-stone-50/50 rounded transition-colors select-none"
        style={{ paddingLeft: depth * 16 }}
        onClick={toggle}
      >
        <CaretRightIcon
          className={`w-3 h-3 text-stone-400 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
          weight="bold"
        />
        {name !== undefined && (
          <span className="text-stone-500 shrink-0">{name}: </span>
        )}
        <span className="text-stone-400 font-mono text-xs">
          {bracket[0]}
          {!isOpen && <span className="text-stone-400"> {summary} </span>}
          {!isOpen && bracket[1]}
        </span>
      </div>
      {isOpen && (
        <>
          {entries.map(([key, val]) => (
            <JSONNode
              key={key}
              name={isArray ? undefined : key}
              value={val}
              depth={depth + 1}
              defaultOpen={depth < 1}
            />
          ))}
          <div
            className="text-stone-400 font-mono text-xs py-0.5"
            style={{ paddingLeft: depth * 16 }}
          >
            {bracket[1]}
          </div>
        </>
      )}
    </div>
  );
}

export function JSONViewer({ content, fileName }: JSONViewerProps) {
  const [showSource, setShowSource] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const parsed = useMemo(() => {
    try {
      return { data: JSON.parse(content), error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  }, [content]);

  const handleCopy = useCallback(async () => {
    try {
      const formatted = parsed.data ? JSON.stringify(parsed.data, null, 2) : content;
      await navigator.clipboard.writeText(formatted);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    } catch {
      // ignore
    }
  }, [content, parsed.data]);

  if (parsed.error) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-rose-500">
          <WarningIcon className="w-3.5 h-3.5" weight="regular" />
          Invalid JSON: {parsed.error}
        </div>
        <div className="border border-stone-200 rounded-xl overflow-hidden bg-stone-900">
          <div className="overflow-x-auto max-h-[65vh] p-4">
            <pre className="text-xs text-stone-300 font-mono whitespace-pre-wrap break-all leading-relaxed">
              {content}
            </pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-stone-100 rounded-lg p-0.5">
          <button
            type="button"
            onClick={() => setShowSource(false)}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              !showSource
                ? 'bg-white text-stone-700 shadow-sm'
                : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            Tree
          </button>
          <button
            type="button"
            onClick={() => setShowSource(true)}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              showSource
                ? 'bg-white text-stone-700 shadow-sm'
                : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            Source
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="px-2 py-1 text-xs rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-50 transition-colors"
          >
            {copyFeedback ? 'Copied!' : 'Copy'}
          </button>
          <span className="text-xs text-stone-400">{fileName}</span>
        </div>
      </div>

      {/* Content */}
      {showSource ? (
        <div className="border border-stone-200 rounded-xl overflow-hidden bg-stone-900">
          <div className="overflow-x-auto max-h-[65vh] p-4">
            <pre className="text-xs text-stone-300 font-mono whitespace-pre-wrap break-all leading-relaxed">
              {JSON.stringify(parsed.data, null, 2)}
            </pre>
          </div>
        </div>
      ) : (
        <div className="border border-stone-200 rounded-xl overflow-hidden bg-white">
          <div className="overflow-auto max-h-[65vh] p-3 text-xs font-mono">
            <JSONNode
              value={parsed.data}
              depth={0}
              defaultOpen={true}
            />
          </div>
        </div>
      )}
    </div>
  );
}
