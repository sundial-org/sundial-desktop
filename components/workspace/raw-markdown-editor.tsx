'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { proseMirrorToMarkdown as serializeMarkdown } from '@/lib/markdown/serializer';
import { markdownToProseMirror } from '@/lib/markdown/codec';

const WRITE_BACK_DEBOUNCE_MS = 600;

interface RawMarkdownEditorProps {
  editor: Editor;
  readOnly?: boolean;
}

/**
 * An editable raw-Markdown view that syncs bidirectionally with the
 * underlying Tiptap/Yjs editor.
 *
 * - Serializes ProseMirror → Markdown on mount and on remote changes
 * - Parses edited Markdown → HTML → ProseMirror on a debounce
 * - Preserves cursor position across remote updates where possible
 */
export function RawMarkdownEditor({ editor, readOnly = false }: RawMarkdownEditorProps) {
  const [value, setValue] = useState(() => serializeMarkdown(editor.state.doc));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Cached nearest scrollable ancestor of the textarea (resolved once, not per keystroke). */
  const scrollerRef = useRef<HTMLElement | null>(null);
  const writeBackTimerRef = useRef<NodeJS.Timeout | null>(null);
  /** Flag to skip the next editor update callback (our own write-back). */
  const suppressNextSync = useRef(false);
  /** Track whether the textarea is focused (user is actively editing). */
  const isFocused = useRef(false);

  // ── Remote changes → refresh textarea ──────────────────────────────
  useEffect(() => {
    const handleUpdate = () => {
      if (suppressNextSync.current) {
        suppressNextSync.current = false;
        return;
      }

      const md = serializeMarkdown(editor.state.doc);

      if (isFocused.current) {
        // If user is editing, only update if the text actually differs
        // (avoids fighting the cursor on every remote keystroke)
        setValue((prev) => (prev === md ? prev : md));
      } else {
        setValue(md);
      }
    };

    editor.on('update', handleUpdate);
    return () => {
      editor.off('update', handleUpdate);
    };
  }, [editor]);

  // ── Clean up debounce timer on unmount ─────────────────────────────
  useEffect(() => {
    return () => {
      if (writeBackTimerRef.current) clearTimeout(writeBackTimerRef.current);
    };
  }, []);

  // ── Write markdown back to ProseMirror ─────────────────────────────
  const writeBackToEditor = useCallback(
    (md: string) => {
      if (readOnly) return;

      // Go through the single markdown↔Y.Doc codec (markdown_yjs), NOT a
      // markdown→HTML→DOM build: the HTML path renders `$…$` math and `![…]`
      // images, so the DOM parser would write KaTeX/`<img>` back into the doc
      // and silently drop the literal Markdown markers (see lib/markdown/codec.ts).
      const doc = markdownToProseMirror(md);

      suppressNextSync.current = true;
      editor.commands.setContent(doc.toJSON(), { emitUpdate: false });
    },
    [editor, readOnly],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setValue(next);

      if (writeBackTimerRef.current) clearTimeout(writeBackTimerRef.current);
      writeBackTimerRef.current = setTimeout(() => {
        writeBackToEditor(next);
      }, WRITE_BACK_DEBOUNCE_MS);
    },
    [writeBackToEditor],
  );

  const handleFocus = useCallback(() => {
    isFocused.current = true;
  }, []);

  const handleBlur = useCallback(() => {
    isFocused.current = false;
    // Immediately flush any pending write-back on blur
    if (writeBackTimerRef.current) {
      clearTimeout(writeBackTimerRef.current);
      writeBackTimerRef.current = null;
    }
    writeBackToEditor(textareaRef.current?.value ?? value);
  }, [value, writeBackToEditor]);

  // Handle Tab key for indentation
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const v = ta.value;
      const updated = v.substring(0, start) + '  ' + v.substring(end);
      setValue(updated);
      // Restore cursor
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }, []);

  // Auto-resize textarea to fit content (fallback for browsers without fieldSizing)
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Reading scrollHeight while height is 'auto' forces a reflow that clamps the
    // enclosing scroll container's scrollTop (the textarea briefly collapses below
    // the viewport). Save and restore it, otherwise the doc jumps to the top on
    // every resize — on each keystroke, and when toggling into this raw view. The
    // scroller is stable for the textarea's lifetime, so resolve it once and reuse.
    let scroller = scrollerRef.current;
    if (!scroller || !scroller.contains(ta)) {
      scroller = ta.parentElement;
      while (scroller) {
        const oy = getComputedStyle(scroller).overflowY;
        if (oy === 'auto' || oy === 'scroll') break;
        scroller = scroller.parentElement;
      }
      scrollerRef.current = scroller;
    }
    const savedTop = scroller?.scrollTop;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(360, ta.scrollHeight)}px`;
    if (scroller && savedTop != null) scroller.scrollTop = savedTop;
  }, []);

  // Layout effect (not passive) so the textarea reaches its final height before
  // the browser paints — the parent's scroll-restore layout effect (raw ↔ source
  // toggle) then measures against the correct scrollHeight, with no flash of a
  // short textarea and no scroll-to-top clamp.
  useLayoutEffect(() => {
    autoResize();
  }, [value, autoResize]);

  return (
    <div className="raw-markdown-editor relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        readOnly={readOnly}
        spellCheck={false}
        className={`
          w-full min-h-[360px] resize-none overflow-hidden
          bg-white border border-stone-200 rounded-xl shadow-[0_1px_2px_rgba(28,25,23,0.05)]
          px-5 py-4 font-mono text-[13px] leading-[1.7] text-stone-700
          placeholder:text-stone-400
          focus:outline-none focus:ring-2 focus:ring-stone-200/60 focus:border-stone-300
          transition-all duration-150
          ${readOnly ? 'opacity-60 cursor-not-allowed bg-stone-50' : ''}
        `}
        style={{ tabSize: 2 }}
        placeholder="Write markdown here..."
      />
    </div>
  );
}
