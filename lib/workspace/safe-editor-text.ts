// Reading getText() on a *destroyed* Tiptap editor throws — it dereferences a
// torn-down view ("Cannot read properties of null (reading 'nodes')"). The
// workspace keeps a ref to the active text editor (markdown Tiptap or the code
// editor handle) that can dangle on a destroyed markdown editor when the editor
// panel is closed (e.g. review-only) and no new editor mounts to replace it — so
// a later read (LaTeX compile source, file download) would hit the dead editor.
// This centralises the guard: absent/destroyed/throwing → null.

export type TextEditorLike = {
  getText: () => string;
  isDestroyed?: boolean;
};

export function safeGetEditorText(editor: TextEditorLike | null | undefined): string | null {
  if (!editor || editor.isDestroyed) return null;
  try {
    return editor.getText();
  } catch {
    return null;
  }
}
