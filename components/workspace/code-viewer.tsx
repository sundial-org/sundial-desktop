'use client';

import { useMemo, useState, useEffect, useRef, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { EditorSkeleton } from './editor-skeleton';
import { THEME_CHANGE_EVENT } from '@/lib/theme';

/* ── Lazy-load Monaco (prevents SSR, code-splits ~1 MB bundle) ──── */

export const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => <EditorSkeleton variant="code" className="h-full min-h-[360px]" />,
});

/** Warm Monaco (the lazy React chunk + the CDN AMD bundle) before the first
 *  mount, so a code/LaTeX doc's editor download overlaps the Y.Doc sync
 *  instead of queueing behind it (the mount is gated on `synced`). Idempotent:
 *  the loader caches its init promise and MonacoEditor reuses it. */
export function preloadMonaco() {
  void import('@monaco-editor/react')
    .then(({ loader }) => loader.init())
    .catch(() => {});
}

/* ── App-theme-following Monaco theme ──────────────────────────── */

export const MONACO_DARK_THEME = 'sundial-dark';

// Register via `beforeMount` on every MonacoEditor. vs-dark syntax colors on
// the app's dark panel surface (globals.css `.dark` --color-white/stone remap)
// so the editor doesn't float as a lighter slab on the dark chrome.
export function defineMonacoThemes(monaco: typeof import('monaco-editor')) {
  monaco.editor.defineTheme(MONACO_DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#23201d',
      'editorGutter.background': '#23201d',
      'editorLineNumber.foreground': '#8a8175',
      'editorLineNumber.activeForeground': '#bcb3a4',
      'editorWidget.background': '#2a2723',
      'editorWidget.border': '#3d3831',
      'editorIndentGuide.background1': '#38342e',
    },
  });
}

const subscribeToTheme = (onChange: () => void) => {
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
};
const getMonacoTheme = () =>
  document.documentElement.classList.contains('dark') ? MONACO_DARK_THEME : 'vs';

/** Monaco theme name tracking the app's resolved light/dark mode, live. */
export function useMonacoTheme(): string {
  return useSyncExternalStore(subscribeToTheme, getMonacoTheme, () => 'vs');
}

export const CODE_EDITOR_SURFACE_CLASS =
  'overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.05)]';

/* ── File extension → Monaco language mapping ──────────────────── */

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.env': 'ini',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.xml': 'xml',
  '.svg': 'xml',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.r': 'r',
  '.R': 'r',
  '.lua': 'lua',
  '.dockerfile': 'dockerfile',
  '.tf': 'hcl',
  '.hcl': 'hcl',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.tex': 'latex',
  '.bib': 'latex',
  '.cls': 'latex',
  '.sty': 'latex',
  '.bst': 'latex',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'plaintext',
  '.log': 'plaintext',
  '.csv': 'plaintext',
  '.tsv': 'plaintext',
  '.conf': 'ini',
  '.properties': 'ini',
  '.scala': 'scala',
  '.dart': 'dart',
  '.m': 'objective-c',
  '.mm': 'objective-c',
  '.pl': 'perl',
  '.pm': 'perl',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.clj': 'clojure',
  '.zig': 'zig',
  '.v': 'v',
  '.sol': 'sol',
};

export function getCodeLanguage(path: string): string {
  // Special cases for files without extensions
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'shell';
  if (name === '.gitignore' || name === '.dockerignore') return 'ini';

  const ext = path.match(/\.[^./]+$/)?.[0]?.toLowerCase() ?? '';
  return EXT_TO_LANGUAGE[ext] ?? 'plaintext';
}

/* ── Language label for UI display ────────────────────────────── */

const LANGUAGE_LABELS: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kotlin: 'Kotlin',
  r: 'R',
  lua: 'Lua',
  scala: 'Scala',
  dart: 'Dart',
  'objective-c': 'Objective-C',
  perl: 'Perl',
  elixir: 'Elixir',
  erlang: 'Erlang',
  clojure: 'Clojure',
  zig: 'Zig',
  json: 'JSON',
  yaml: 'YAML',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'LESS',
  xml: 'XML',
  sql: 'SQL',
  shell: 'Shell',
  ini: 'Config',
  dockerfile: 'Dockerfile',
  hcl: 'HCL',
  graphql: 'GraphQL',
  latex: 'LaTeX',
  markdown: 'Markdown',
  plaintext: 'Plain Text',
  sol: 'Solidity',
};

export function getLanguageLabel(path: string): string {
  const lang = getCodeLanguage(path);
  return LANGUAGE_LABELS[lang] ?? lang;
}

export function getCodeEditorOptions(readOnly: boolean) {
  return {
    readOnly,
    domReadOnly: readOnly,
    minimap: { enabled: false },
    lineNumbers: 'on' as const,
    scrollBeyondLastLine: false,
    wordWrap: 'on' as const,
    fontSize: 13,
    lineHeight: 20,
    padding: { top: 12, bottom: 12 },
    renderLineHighlight: 'none' as const,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    scrollbar: {
      vertical: 'auto' as const,
      horizontal: 'auto' as const,
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
    },
    contextmenu: !readOnly,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    cursorStyle: 'line-thin' as const,
    folding: true,
    foldingHighlight: false,
    bracketPairColorization: { enabled: true },
    guides: { indentation: true, bracketPairs: false },
    renderWhitespace: 'none' as const,
    quickSuggestions: !readOnly,
    suggestOnTriggerCharacters: !readOnly,
    // Ghost-text AI completions ride Monaco's inline-suggest channel, which is
    // separate from the suggest widget above; never offer them in a read-only
    // surface, where there is nothing to accept into.
    inlineSuggest: { enabled: !readOnly },
    acceptSuggestionOnEnter: readOnly ? ('off' as const) : ('on' as const),
    tabCompletion: readOnly ? ('off' as const) : ('on' as const),
    parameterHints: { enabled: !readOnly },
    codeLens: false,
    lightbulb: { enabled: 'off' as unknown as undefined },
    hover: { enabled: readOnly ? false : true },
    links: true,
    matchBrackets: 'always' as const,
    automaticLayout: true,
  };
}

/* ── CodeViewer component ─────────────────────────────────────── */

interface CodeViewerProps {
  filePath: string;
  /** Live text content fed from a CRDT-backed editor. When provided,
   *  the viewer uses this directly and skips the host fetch. */
  value?: string | null;
  /** Workspace project id. Required when `value` is not provided so the
   *  viewer can fetch the file's plain text from the live host. */
  workspaceId?: string;
  className?: string;
  /** Override Monaco's height. Defaults to a window-measured value that
   *  fills the page; pass "100%" or a fixed number when embedding inside a
   *  fixed-height container (e.g. a modal). */
  height?: number | string;
}

export function CodeViewer({ filePath, value, workspaceId, className, height }: CodeViewerProps) {
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const monacoTheme = useMonacoTheme();
  const language = useMemo(() => getCodeLanguage(filePath), [filePath]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [editorHeight, setEditorHeight] = useState<number>(500);

  // When `value` is provided by a live CRDT editor, use it directly
  const hasLiveValue = value !== undefined;
  const content = hasLiveValue ? (value ?? '') : fetchedContent;

  // Measure available height for the editor. Skipped when a height override
  // is supplied by the caller.
  useEffect(() => {
    if (height !== undefined) return;
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      // Leave 16px bottom margin
      const available = window.innerHeight - rect.top - 16;
      setEditorHeight(Math.max(300, available));
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener('resize', measure);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [height]);

  // Fetch plain text from the live host when no live value is provided.
  useEffect(() => {
    if (hasLiveValue) {
      setLoading(false);
      return;
    }
    if (!workspaceId || !filePath) {
      setFetchedContent('');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setFetchedContent(null);

    const qs = new URLSearchParams({ projectId: workspaceId, path: filePath });
    fetch(`/api/workspace/file-content?${qs.toString()}`, { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setFetchedContent('');
          setLoading(false);
          return;
        }
        const body = (await res.json()) as {
          ok?: boolean;
          exists?: boolean;
          content?: string;
        };
        if (cancelled) return;
        setFetchedContent(body?.ok && body.exists !== false ? (body.content ?? '') : '');
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setFetchedContent('');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath, hasLiveValue]);

  if (loading || content === null) {
    return (
      <div ref={containerRef} className={`${CODE_EDITOR_SURFACE_CLASS} ${className ?? ''}`}>
        <EditorSkeleton variant="code" className="min-h-[360px]" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`${CODE_EDITOR_SURFACE_CLASS} ${className ?? ''}`}>
      <MonacoEditor
        height={height ?? editorHeight}
        language={language}
        value={content}
        theme={monacoTheme}
        beforeMount={defineMonacoThemes}
        options={getCodeEditorOptions(true)}
      />
    </div>
  );
}
