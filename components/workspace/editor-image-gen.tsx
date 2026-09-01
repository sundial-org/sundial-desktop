'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { ArrowsClockwiseIcon, ImagesSquareIcon, SpinnerGapIcon, XIcon } from '@phosphor-icons/react';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import {
  IMAGE_CANDIDATES,
  createImageStreamParser,
} from '@/lib/workspace/generate-image';
import { capturePosition, resolvePosition } from '@/lib/workspace/rewrite-anchor';
import { PopupResizeHandle, usePopupFrame } from '@/components/workspace/use-popup-frame';

/* ── /image generation popup ──────────────────────────────────────────
 *  Opened by the "/image" slash item at the caret. Four candidates
 *  generate in parallel and fill a pick grid as each lands (Midjourney
 *  idiom); clicking one uploads it through the workspace's normal image
 *  path and inserts it where "/image" was typed. An empty prompt derives
 *  one from the surrounding document.
 * ─────────────────────────────────────────────────────────────────── */

type OpenState = {
  /** Caret position where the image should land (clamped at insert). */
  pos: number;
  /** Yjs-relative capture of that position — survives edits made before the
   *  caret while candidates generate/upload; `pos` is the fallback. */
  anchor: Record<string, unknown> | null;
  /** Document text around the caret — context for empty-prompt derivation. */
  context: string;
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

type SlotState =
  | { status: 'pending' }
  | { status: 'ready'; dataUrl: string }
  | { status: 'error'; message: string };

const POPUP_WIDTH = 380;
const POPUP_CLEARANCE = 330;

export function EditorImageGenPopup({
  editor,
  projectId,
  filePath,
  upload,
  insertAt,
}: {
  editor: Editor;
  projectId: string | null;
  filePath: string | null;
  /** The workspace's image uploader (same one drops/pastes use). */
  upload?: (file: File) => Promise<{ src: string; alt: string } | null>;
  /** Inserts an uploaded image as an Image node (wired to insertImages by
   *  the editor — a prop, not an import, to avoid a module cycle). */
  insertAt: (pos: number, image: { src: string; alt: string }) => void;
}) {
  const apiFetch = useApiFetch();
  const [state, setState] = useState<OpenState | null>(null);
  // Mirror for async continuations (pick's blob fetch + upload) that must
  // detect a dismissal across an await.
  const stateRef = useRef<OpenState | null>(null);
  stateRef.current = state;
  const [prompt, setPrompt] = useState('');
  const [effectivePrompt, setEffectivePrompt] = useState<string | null>(null);
  const [slots, setSlots] = useState<SlotState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inserting, setInserting] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { frameStyle, startMove, startResize } = usePopupFrame(boxRef, state);
  const abortRef = useRef<AbortController | null>(null);

  // File/workspace switches unmount the keyed editor without close() — kill
  // any in-flight generation so the server stops paid work for a dead popup.
  useEffect(() => () => abortRef.current?.abort(), []);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Bumped by every generate() — pending picks compare it after their upload
  // await so a regeneration invalidates them (state alone doesn't change).
  const generationRef = useRef(0);
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  const generate = useCallback(
    (userPrompt: string, context: string) => {
      abortRef.current?.abort();
      generationRef.current += 1;
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setEffectivePrompt(null);
      setSlots(Array.from({ length: IMAGE_CANDIDATES }, () => ({ status: 'pending' as const })));
      const parser = createImageStreamParser((event) => {
        if (event.type === 'prompt') {
          setEffectivePrompt(event.text);
        } else if (event.type === 'image') {
          setSlots((prev) =>
            prev
              ? prev.map((slot, i) =>
                  i === event.slot ? { status: 'ready', dataUrl: event.dataUrl } : slot,
                )
              : prev,
          );
        } else if (event.type === 'image-error') {
          setSlots((prev) =>
            prev
              ? prev.map((slot, i) =>
                  i === event.slot ? { status: 'error', message: event.message } : slot,
                )
              : prev,
          );
        } else if (event.type === 'error') {
          setError('Image generation failed. Try again.');
        }
      });
      void (async () => {
        const response = await apiFetch('/api/workspace/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ projectId, filePath, prompt: userPrompt, context }),
        });
        if (!response.ok || !response.body) {
          const reason = await response
            .json()
            .then((data: { error?: string }) => data?.error)
            .catch(() => null);
          throw new Error(
            reason === 'signin_required'
              ? 'Sign in to generate images.'
              : reason === 'out_of_credits'
                ? 'Out of credits.'
                : 'Image generation failed. Try again.',
          );
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.flush();
        // Anything still pending at EOF failed silently upstream.
        setSlots((prev) =>
          prev
            ? prev.map((slot) =>
                slot.status === 'pending' ? { status: 'error', message: 'no image' } : slot,
              )
            : prev,
        );
      })().catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Image generation failed. Try again.');
        setSlots(null);
      });
    },
    [apiFetch, filePath, projectId],
  );

  // Open on the slash item's event (scoped to this editor instance).
  useEffect(() => {
    const onOpen = (event: Event) => {
      if (editor.isDestroyed || !editor.isEditable) return;
      const detail = (event as CustomEvent<{ prompt?: string; source?: Element }>).detail;
      if (detail?.source && detail.source !== editor.view.dom) return;
      const pos = editor.state.selection.from;
      let coords = { left: 8, top: 0, bottom: 8 };
      try {
        coords = editor.view.coordsAtPos(pos);
      } catch {
        // jsdom / detached view: keep the fallback corner position.
      }
      // Context for empty prompts: text around the caret.
      const doc = editor.state.doc;
      const context = doc.textBetween(
        Math.max(0, pos - 3000),
        Math.min(doc.content.size, pos + 1000),
        '\n',
        ' ',
      );
      const roomBelow = window.innerHeight - coords.bottom - 24;
      const roomAbove = coords.top - 24;
      const flipUp = roomBelow < POPUP_CLEARANCE && roomAbove > roomBelow;
      const maxHeight = Math.round(
        Math.max(0, Math.min(flipUp ? roomAbove : roomBelow, window.innerHeight - 32)),
      );
      const width = Math.min(POPUP_WIDTH, window.innerWidth - 16);
      const initialPrompt = detail?.prompt?.trim() ?? '';
      // A previous generation may still be streaming (reopen via bare
      // "/image" never calls generate, which is what usually aborts it) —
      // kill it so stale candidates can't fill the new popup's grid.
      abortRef.current?.abort();
      setState({
        pos,
        anchor: capturePosition(editor, pos),
        context,
        left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)),
        width,
        maxHeight,
        ...(flipUp ? { bottom: window.innerHeight - coords.top + 8 } : { top: coords.bottom + 8 }),
      });
      setPrompt(initialPrompt);
      setSlots(null);
      setError(null);
      setInserting(null);
      // "/image a red fox" generates immediately; bare "/image" waits for
      // input (Enter with an empty field generates from context).
      if (initialPrompt) generate(initialPrompt, context);
      else setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener('sundial:open-image-gen', onOpen);
    return () => window.removeEventListener('sundial:open-image-gen', onOpen);
  }, [editor, generate]);

  const open = state !== null;

  const close = useCallback(() => {
    abortRef.current?.abort();
    setState(null);
    setSlots(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && boxRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
    };
  }, [open, close]);

  const pick = useCallback(
    async (slot: number, dataUrl: string) => {
      if (!state || inserting !== null) return;
      const uploader = uploadRef.current;
      if (!uploader) return;
      setInserting(slot);
      const generation = generationRef.current;
      try {
        const blob = await fetch(dataUrl).then((r) => r.blob());
        const alt = (effectivePrompt ?? prompt ?? 'generated image').slice(0, 120);
        const slug =
          alt
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48) || 'generated';
        const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
        const file = new File([blob], `${slug}.${extension}`, { type: blob.type || 'image/png' });
        const uploaded = await uploader(file);
        // Esc/click-away closed the popup, or Regenerate started a new
        // batch, while the upload was pending — a superseded pick must not
        // mutate the document afterward.
        if (stateRef.current !== state || generationRef.current !== generation) return;
        if (!uploaded || editor.isDestroyed) {
          setInserting(null);
          setError('Upload failed. Try another image.');
          return;
        }
        const resolved = resolvePosition(editor, state.anchor) ?? state.pos;
        insertAt(Math.min(resolved, editor.state.doc.content.size), { src: uploaded.src, alt });
        close();
      } catch {
        setInserting(null);
        setError('Upload failed. Try another image.');
      }
    },
    [close, editor, effectivePrompt, insertAt, inserting, prompt, state],
  );

  if (!state) return null;

  const generating = slots !== null && slots.some((slot) => slot.status === 'pending');

  return (
    <div
      ref={boxRef}
      data-testid="image-gen-popup"
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_4px_16px_rgba(28,25,23,0.16)]"
      style={{
        left: state.left,
        width: state.width,
        maxHeight: state.maxHeight,
        ...(state.top !== undefined ? { top: state.top } : {}),
        ...(state.bottom !== undefined ? { bottom: state.bottom } : {}),
        ...frameStyle,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        onPointerDown={startMove}
        className="flex cursor-grab select-none items-center gap-2 border-b border-stone-100 px-3 py-2 active:cursor-grabbing"
      >
        <ImagesSquareIcon className="h-4 w-4 text-beige-600" weight="regular" />
        <span className="text-[12px] font-semibold text-stone-800">Generate image</span>
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className="ml-auto rounded-md p-1 text-stone-400 hover:text-stone-600"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1.5 px-3 pt-2">
        <input
          ref={inputRef}
          data-testid="image-gen-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              generate(prompt.trim(), state.context);
            }
          }}
          placeholder="Describe the image (empty uses the doc context)"
          className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1 text-[12px] text-stone-800 placeholder:text-stone-400 focus:border-beige-400 focus:outline-none"
        />
        <button
          type="button"
          data-testid="image-gen-go"
          aria-label={slots ? 'Regenerate' : 'Generate'}
          disabled={generating}
          onClick={() => generate(prompt.trim(), state.context)}
          className="flex items-center gap-1 rounded-lg bg-beige-600 px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40"
        >
          {slots ? <ArrowsClockwiseIcon className="h-3.5 w-3.5" /> : null}
          {slots ? '' : 'Generate'}
        </button>
      </div>
      {effectivePrompt && effectivePrompt !== prompt && (
        <p className="px-3 pt-1 text-[10.5px] italic text-stone-400" title={effectivePrompt}>
          {effectivePrompt.length > 120 ? `${effectivePrompt.slice(0, 120)}…` : effectivePrompt}
        </p>
      )}
      {error && <p className="px-3 pt-1.5 text-[11px] text-red-500">{error}</p>}

      {slots && (
        <div className="grid grid-cols-2 gap-1.5 p-3">
          {slots.map((slot, index) => (
            <div
              key={index}
              className="relative aspect-square overflow-hidden rounded-lg border border-stone-100 bg-stone-50"
            >
              {slot.status === 'pending' && (
                <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-stone-100 to-stone-200" />
              )}
              {slot.status === 'error' && (
                <div className="flex h-full items-center justify-center p-2 text-center text-[10px] text-stone-400">
                  failed
                </div>
              )}
              {slot.status === 'ready' && (
                <button
                  type="button"
                  data-testid={`image-gen-slot-${index}`}
                  disabled={inserting !== null}
                  onClick={() => void pick(index, slot.dataUrl)}
                  className="group h-full w-full"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- data URL preview */}
                  <img
                    src={slot.dataUrl}
                    alt={`candidate ${index + 1}`}
                    className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
                  />
                  {inserting === index && (
                    <span className="absolute inset-0 flex items-center justify-center bg-white/60">
                      <SpinnerGapIcon className="h-5 w-5 animate-spin text-beige-600" />
                    </span>
                  )}
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/40 to-transparent p-1 text-center text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                    insert
                  </span>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!slots && (
        <p className="px-3 pb-3 pt-1.5 text-[11px] text-stone-400">
          Enter to generate 4 candidates · pick one to insert it
        </p>
      )}
      <PopupResizeHandle onPointerDown={startResize} />
    </div>
  );
}
