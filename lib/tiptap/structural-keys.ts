import { Extension } from '@tiptap/core';
import { yUndoPluginKey } from '@tiptap/y-tiptap';

/**
 * Structural keys are their own undo steps. y-prosemirror's Y.UndoManager
 * merges any two transactions within 500ms of each other by wall clock, so
 * "Enter, Tab, Cmd-Z" undid both. Close the capture group before AND after
 * the key (the after happens in a microtask, once the key's transaction has
 * synced into the Y.Doc) so the key sits alone in the undo stack and typing
 * resumes a fresh group. Always returns false: the real handlers run next.
 */
export const UndoBoundaries = Extension.create({
  name: 'undoBoundaries',
  priority: 200,
  addKeyboardShortcuts() {
    const boundary = () => {
      const um = yUndoPluginKey.getState(this.editor.state)?.undoManager;
      if (!um) return false;
      um.stopCapturing();
      queueMicrotask(() => um.stopCapturing());
      return false;
    };
    return { Enter: boundary, 'Shift-Enter': boundary, Tab: boundary, 'Shift-Tab': boundary };
  },
});

/**
 * Tab while editing never leaves the editor (the Docs/Notion contract): when
 * no handler claims it — `sinkListItem` refuses on a first item, and outside
 * lists nothing binds Tab at all — the browser moves focus to the next
 * control and the caret vanishes. Runs after ListItem / Table
 * (priority < 100): swallow only what they declined. Read-only views keep
 * native tabbing (the editor is a page element there, not a typing surface).
 */
export const EditorTabGuard = Extension.create({
  name: 'editorTabGuard',
  priority: 90,
  addKeyboardShortcuts() {
    const editing = () => this.editor.isEditable;
    return { Tab: editing, 'Shift-Tab': editing };
  },
});
