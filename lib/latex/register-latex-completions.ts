import { createLatexCompletionProvider, type LatexProjectContext } from '@/lib/latex/monaco-latex-completion';

/**
 * Register-once Monaco wiring for LaTeX (W3.acomplete). Monaco ships no `latex`
 * language, so an editor opened with language="latex" silently falls back to
 * `plaintext` — both syntax highlighting and the completion provider go dark.
 * On the first editor mount we register the language id, a Monarch tokenizer
 * (highlighting), and a single completion provider fed a module-level project
 * context the editor host refreshes as files load. Registering once keeps the
 * provider stable so suggestions don't duplicate across editor remounts.
 */

let registered = false;
let projectContext: LatexProjectContext = {};

export function setLatexProjectContext(context: LatexProjectContext): void {
  projectContext = context;
}

// Minimal LaTeX highlighting: comments, control sequences, environment names,
// and inline/display math. Token names map to the `vs` theme's default palette.
const LATEX_TOKENIZER: import('monaco-editor').languages.IMonarchLanguage = {
  defaultToken: '',
  tokenizer: {
    root: [
      [/%.*$/, 'comment'],
      [/(\\(?:begin|end))(\s*)(\{)([^}]*)(\})/, ['keyword', 'white', 'delimiter.curly', 'type', 'delimiter.curly']],
      [/\\[a-zA-Z@]+\*?/, 'keyword'],
      [/\\./, 'keyword'],
      [/\$\$/, { token: 'string', next: '@displaymath' }],
      [/\$/, { token: 'string', next: '@inlinemath' }],
      [/[{}]/, 'delimiter.curly'],
      [/[[\]]/, 'delimiter.square'],
    ],
    inlinemath: [
      [/\\[a-zA-Z@]+/, 'keyword'],
      [/\\./, 'keyword'],
      [/\$/, { token: 'string', next: '@pop' }],
      [/[^\\$]+/, 'string'],
    ],
    displaymath: [
      [/\\[a-zA-Z@]+/, 'keyword'],
      [/\\./, 'keyword'],
      [/\$\$/, { token: 'string', next: '@pop' }],
      [/[^\\$]+/, 'string'],
    ],
  },
};

export function registerLatexCompletions(monaco: typeof import('monaco-editor')): void {
  if (registered) return;
  registered = true;
  if (!monaco.languages.getLanguages().some((l) => l.id === 'latex')) {
    monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls'], aliases: ['LaTeX', 'tex'] });
    monaco.languages.setMonarchTokensProvider('latex', LATEX_TOKENIZER);
  }
  monaco.languages.registerCompletionItemProvider(
    'latex',
    createLatexCompletionProvider(monaco, () => projectContext),
  );
}

/** Test-only: reset module state between cases. */
export function __resetLatexCompletionsForTest(): void {
  registered = false;
  projectContext = {};
}
