'use client';

import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { SparkleIcon } from '@phosphor-icons/react';

/* ── Inline "Ask Sunny" popup ─────────────────────────────────────────
 *  A minimal one-line prompt anchored at the caret: type an instruction,
 *  Enter sends it as a full chat turn with the captured selection (or the
 *  current paragraph) quoted as anchor context. Opened by the bubble menu's
 *  Ask Sunny button and by a bare "/ai" via `sundial:open-inline-ask`;
 *  submission goes through `sundial:add-chat-context` with `instruction`
 *  set, which the workspace page sends immediately instead of pinning.
 *  Pure event dispatch — never mutates the document; Sunny's reply lands
 *  as reviewable suggestions like any other turn.
 * ─────────────────────────────────────────────────────────────────── */

type AskState = {
  /** Quoted anchor context (selection or caret anchor); may be empty. */
  text: string;
  /** Caret placement relative to `text` ("/ai" path); absent for selections. */
  caret?: 'inside' | 'after' | 'start';
  path: string | null;
  left: number;
  /** One of the two is set — `bottom` when flipped above the caret. */
  top?: number;
  bottom?: number;
};

const POPUP_WIDTH = 336;
// Room the popup needs below the caret before it flips above (input row +
// quote line + margins) — same idiom as the slash menu's flipUp.
const POPUP_CLEARANCE = 96;

export function EditorAskInput({ editor }: { editor: Editor }) {
  const [state, setState] = useState<AskState | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onOpen = (event: Event) => {
      if (editor.isDestroyed || !editor.isEditable) return;
      const detail = (event as CustomEvent<{
        text?: string;
        caret?: AskState['caret'];
        path?: string | null;
        /** The dispatching editor's view DOM — several editable editors can
         *  be mounted at once (main + diff review), and each mounts its own
         *  EditorAskInput on this global event; only the originating one may
         *  open (Codex P2 on #790). */
        source?: Element;
      }>).detail;
      if (detail?.source && detail.source !== editor.view.dom) return;
      // Anchor at the caret (dispatchers collapse the selection first, so
      // this is the end of the asked-about span).
      let coords = { left: 8, top: 0, bottom: 8 };
      try {
        coords = editor.view.coordsAtPos(editor.state.selection.from);
      } catch {
        // jsdom / detached view: keep the fallback corner position.
      }
      const flipUp =
        coords.bottom + POPUP_CLEARANCE > window.innerHeight && coords.top > POPUP_CLEARANCE;
      setState({
        text: detail?.text?.trim() ?? '',
        caret: detail?.caret,
        path: detail?.path ?? null,
        left: Math.max(8, Math.min(coords.left, window.innerWidth - POPUP_WIDTH - 8)),
        ...(flipUp
          ? { bottom: window.innerHeight - coords.top + 8 }
          : { top: coords.bottom + 8 }),
      });
      setValue('');
    };
    window.addEventListener('sundial:open-inline-ask', onOpen);
    return () => window.removeEventListener('sundial:open-inline-ask', onOpen);
  }, [editor]);

  const open = state !== null;
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Same outside-dismissal idiom as the slash menu: the popup lives outside
  // Tiptap's mount, so clicks elsewhere would otherwise leave it floating.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as unknown;
      if (target instanceof Node && boxRef.current?.contains(target)) return;
      setState(null);
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () =>
      window.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
  }, [open]);

  if (!state) return null;

  const close = (refocusEditor: boolean) => {
    setState(null);
    if (refocusEditor && !editor.isDestroyed) editor.commands.focus();
  };

  const submit = () => {
    const instruction = value.trim();
    if (!instruction) return;
    window.dispatchEvent(
      new CustomEvent('sundial:add-chat-context', {
        detail: {
          text: state.text,
          caret: state.caret,
          path: state.path,
          instruction,
          forceNew: false,
          toggle: false,
        },
      }),
    );
    setState(null);
  };

  return (
    <div
      ref={boxRef}
      data-testid="inline-ask-popup"
      className="fixed z-50 rounded-xl border border-stone-200 bg-white p-1.5 shadow-[0_2px_8px_rgba(28,25,23,0.12)]"
      style={{ left: state.left, top: state.top, bottom: state.bottom, width: POPUP_WIDTH }}
    >
      {state.text && (
        <div className="truncate border-l-2 border-stone-200 px-2 pb-1 pt-0.5 text-[11px] italic text-stone-400">
          {state.text}
        </div>
      )}
      <div className="flex items-center gap-1.5 px-1">
        <SparkleIcon className="h-4 w-4 shrink-0 text-[#8a6d3b]" weight="fill" />
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close(true);
            }
          }}
          placeholder={state.text ? 'Ask Sunny to edit this…' : 'Ask Sunny to write here…'}
          className="w-full bg-transparent py-1 text-[13px] text-stone-800 placeholder:text-stone-400 focus:outline-none"
        />
        <kbd className="shrink-0 text-[10px] text-stone-300">⏎</kbd>
      </div>
    </div>
  );
}
