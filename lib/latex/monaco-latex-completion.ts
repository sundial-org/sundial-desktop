import type { languages, editor, Position, IRange } from 'monaco-editor';
import {
  getLatexCompletions,
  type LatexCompletionContext,
  type LatexCompletionKind,
} from '@/lib/latex/latex-completions';
import {
  clampSuffix,
  MAX_PREFIX_CHARS,
  MAX_SUFFIX_CHARS,
  MAX_SUFFIX_LINES,
} from '@/lib/workspace/autocomplete/engine';

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

export type LatexProjectContext = Omit<
  LatexCompletionContext,
  'linePrefix' | 'suffix' | 'suffixTruncated'
>;

/** Trigger after characters that open or continue a completable context. */
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
      const prefixStartColumn = Math.max(1, position.column - MAX_PREFIX_CHARS);
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: prefixStartColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      // Syntax completion runs on each trigger character, so never read the
      // whole document. The bounded suffix is enough to spot an adjacent `}`
      // or an already-balanced \end without regressing large-paper typing.
      const lineCount = model.getLineCount();
      const lastLine = Math.min(lineCount, position.lineNumber + MAX_SUFFIX_LINES - 1);
      const startOffset = model.getOffsetAt(position);
      const lineBoundOffset = model.getOffsetAt({
        lineNumber: lastLine,
        column: model.getLineMaxColumn(lastLine),
      });
      const suffixEndOffset = Math.min(lineBoundOffset, startOffset + MAX_SUFFIX_CHARS);
      const suffixEnd = model.getPositionAt(suffixEndOffset);
      const rawSuffix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: suffixEnd.lineNumber,
        endColumn: suffixEnd.column,
      });
      const suffix = clampSuffix(rawSuffix);
      const documentEndOffset = model.getOffsetAt({
        lineNumber: lineCount,
        column: model.getLineMaxColumn(lineCount),
      });

      const result = getLatexCompletions({
        linePrefix,
        suffix,
        suffixTruncated: suffixEndOffset < documentEndOffset || suffix.length < rawSuffix.length,
        ...getProjectContext(),
      });
      if (!result || result.items.length === 0) return { suggestions: [] };

      // Engine `from` is a 0-based column; Monaco columns are 1-based.
      const suggestions: languages.CompletionItem[] = result.items.map((item) => ({
        label: item.label,
        kind: monacoKind(monaco, item.kind),
        insertText: item.insertText,
        insertTextRules: item.insertMode === 'snippet'
          ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            | monaco.languages.CompletionItemInsertTextRule.KeepWhitespace
          : undefined,
        command: item.retrigger
          ? { id: 'editor.action.triggerSuggest', title: 'Trigger suggestions' }
          : undefined,
        detail: item.detail,
        range: {
          startLineNumber: position.lineNumber,
          startColumn: prefixStartColumn + result.from,
          endLineNumber: position.lineNumber,
          endColumn: position.column + (item.replaceSuffixChars ?? 0),
        } satisfies IRange,
      }));
      return { suggestions };
    },
  };
}
