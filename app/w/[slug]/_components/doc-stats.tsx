'use client';

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';

/**
 * Live word/char counts for the status pill. Self-contained on purpose: the
 * count changes on every keystroke, so holding it in the workspace page's
 * state re-rendered the entire page tree on every keystroke — here the update
 * re-renders only this span, coalesced to one recount per frame.
 */
export function DocStatsSpan({ editor }: { editor: Editor | null }) {
  const [stats, setStats] = useState<{ words: number; chars: number } | null>(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      setStats(null);
      return;
    }
    const compute = () => {
      const text = editor.state.doc.textContent;
      setStats({
        words: text.trim() ? text.trim().split(/\s+/).length : 0,
        chars: text.length,
      });
    };
    compute();
    // textContent + the split are two O(doc) string passes — per keystroke
    // that's real drag on long docs, and nobody reads a live word count at
    // typing speed. One trailing recount per 500ms window.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (timer != null) return;
      timer = setTimeout(() => {
        timer = null;
        if (!editor.isDestroyed) compute();
      }, 500);
    };
    editor.on('update', onUpdate);
    return () => {
      if (timer != null) clearTimeout(timer);
      editor.off('update', onUpdate);
    };
  }, [editor]);

  if (!stats) return null;
  return (
    <span>
      {stats.words.toLocaleString()} words · {stats.chars.toLocaleString()} characters ·{' '}
    </span>
  );
}
