import type { editor as MonacoEditorType } from 'monaco-editor';
import type { LatexMarker } from '@/lib/workspace/latex-log-navigation';

export const LATEX_COMPILE_MARKER_OWNER = 'latex-compile';

/**
 * Replace one model's LaTeX diagnostics and gutter bars. `onVisible` runs only
 * after Monaco confirms at least one owned marker exists and the matching
 * gutter collection has been installed. The callback receives that exact
 * requested set so consumers can require a specific diagnostic signature.
 */
export function installLatexCompileMarkers({
  monaco,
  editor,
  model,
  markers,
  onVisible,
}: {
  monaco: typeof import('monaco-editor');
  editor: Pick<MonacoEditorType.IStandaloneCodeEditor, 'createDecorationsCollection'>;
  model: Pick<MonacoEditorType.ITextModel, 'getLineCount' | 'getLineMaxColumn' | 'uri'>;
  markers: LatexMarker[];
  onVisible?: (markers: readonly LatexMarker[]) => void;
}): MonacoEditorType.IEditorDecorationsCollection {
  monaco.editor.setModelMarkers(
    model as MonacoEditorType.ITextModel,
    LATEX_COMPILE_MARKER_OWNER,
    markers.map((marker) => ({
      severity:
        marker.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : monaco.MarkerSeverity.Warning,
      message: marker.message,
      startLineNumber: marker.line,
      startColumn: 1,
      endLineNumber: marker.line,
      endColumn: model.getLineMaxColumn(Math.min(marker.line, model.getLineCount())),
    })),
  );
  const gutter = editor.createDecorationsCollection(
    markers.map((marker) => ({
      range: new monaco.Range(marker.line, 1, marker.line, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: `latex-compile-gutter latex-compile-gutter-${marker.severity}`,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })),
  );
  if (
    markers.length > 0 &&
    monaco.editor.getModelMarkers({
      owner: LATEX_COMPILE_MARKER_OWNER,
      resource: model.uri,
    }).length > 0
  ) {
    onVisible?.(markers);
  }
  return gutter;
}
