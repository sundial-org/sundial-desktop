import type { languages, editor, Position, IRange } from 'monaco-editor';
import {
  getLatexCompletions,
  type LatexCompletionContext,
  type LatexCompletionKind,
} from '@/lib/latex/latex-completions';

/**
 * Monaco adapter for the pure completion engine (W3.acomplete). The engine in
 * `latex-completions.ts` does all the context detection and ranking; this file
 * is the thin glue that reads the line prefix from a Monaco model, calls the
 * engine, and maps its `from`/`items` onto a Monaco completion list. Kept
 * separate so the engine stays editor-free and unit-testable, and so wiring it
 * into the editor is a single `registerCompletionItemProvider` call.
 *
 * `getProjectContext` is supplied by the editor host so labels / `.bib` entries
 * / file paths refresh as the project changes without rebuilding the provider.
 */

export type LatexProjectContext = Omit<LatexCompletionContext, 'linePrefix'>;

/** Trigger after the chars that open a completable context, plus letters. */
const TRIGGER_CHARACTERS = ['\\', '{', ',', '/'];

function monacoKind(
  monaco: typeof import('monaco-editor'),
  kind: LatexCompletionKind,
): languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'command':
      return K.Function;
    case 'environment':
      return K.Keyword;
    case 'ref':
      return K.Reference;
    case 'cite':
      return K.Value;
    case 'file':
      return K.File;
  }
}

export function createLatexCompletionProvider(
  monaco: typeof import('monaco-editor'),
  getProjectContext: () => LatexProjectContext,
): languages.CompletionItemProvider {
  return {
    triggerCharacters: TRIGGER_CHARACTERS,
    provideCompletionItems(
      model: editor.ITextModel,
      position: Position,
    ): languages.ProviderResult<languages.CompletionList> {
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const result = getLatexCompletions({ linePrefix, ...getProjectContext() });
      if (!result || result.items.length === 0) return { suggestions: [] };

      // Engine `from` is a 0-based column; Monaco columns are 1-based.
      const range: IRange = {
        startLineNumber: position.lineNumber,
        startColumn: result.from + 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };

      const suggestions: languages.CompletionItem[] = result.items.map((item) => ({
        label: item.label,
        kind: monacoKind(monaco, item.kind),
        insertText: item.insertText,
        detail: item.detail,
        range,
      }));
      return { suggestions };
    },
  };
}
