'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { MagicWandIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import {
  MAX_REWRITE_TEXT_CHARS,
  REWRITE_AXES,
  createRewriteStreamParser,
  type RewriteAxisId,
} from '@/lib/workspace/rewrite-variants';
import type { RewriteSelectionCapture } from '@/lib/workspace/rewrite-anchor';
import { PopupResizeHandle, usePopupFrame } from '@/components/workspace/use-popup-frame';

/* The anchor/codec chain is heavy and the editor mounts this popup
 * everywhere — so this file stays a light shell (the window-event
 * listener must be attached from first render: a lazily-mounted popup races
 * the first click) and pulls its internals on open. Loaded well before the
 * first variant finishes streaming. */
type HeavyDeps = {
  applyRewrite: typeof import('@/lib/workspace/rewrite-anchor').applyRewrite;
  readTextAtCapture: typeof import('@/lib/workspace/rewrite-anchor').readTextAtCapture;
  canonicalizeMarkdown: (markdown: string) => string;
};
let heavyDepsPromise: Promise<HeavyDeps> | null = null;
function loadHeavyDeps(): Promise<HeavyDeps> {
  heavyDepsPromise ??= Promise.all([
    import('@/lib/workspace/rewrite-anchor'),
    import('@/lib/crdt-js/markdown_yjs.mjs'),
  ]).then(([anchor, codec]) => ({
    applyRewrite: anchor.applyRewrite,
    readTextAtCapture: anchor.readTextAtCapture,
    canonicalizeMarkdown: codec.canonicalizeMarkdown as (markdown: string) => string,
  }));
  return heavyDepsPromise;
}

/* ── Paragraph review popup ───────────────────────────────────────────
 *  Opened by the bubble menu's Rewrite button (`sundial:open-rewrite-review`
 *  with the selection pre-captured, including Yjs relative positions). Four
 *  axis-labeled rewrite variants stream in parallel and render as clean
 *  prose rows (landing-page style); 1–4 or click applies one through the editor's
 *  normal transaction path (attributed in doc_edits like typing), Esc
 *  dismisses. Every path logs an outcome — the preference record is the
 *  point of the feature.
 * ─────────────────────────────────────────────────────────────────── */

type VariantSlot = {
  axis: string;
  /** Card label — adaptive (server-picked per passage), with the canonical
   *  axis labels as fallback for old start events. */
  label: string;
  text: string;
  done: boolean;
  error: string | null;
};

type OpenState = {
  capture: RewriteSelectionCapture;
  path: string | null;
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

const POPUP_WIDTH = 480;
const POPUP_CLEARANCE = 320;
const POST_EDIT_CHECK_MS = 30_000;

const AXIS_LABELS: Record<RewriteAxisId, string> = Object.fromEntries(
  REWRITE_AXES.map((axis) => [axis.id, axis.label]),
) as Record<RewriteAxisId, string>;

function VariantCard({
  index,
  slot,
  original,
  disabled,
  deps,
  onPick,
}: {
  index: number;
  slot: VariantSlot;
  original: string;
  disabled: boolean;
  deps: HeavyDeps | null;
  onPick: () => void;
}) {
  // Landing-page "Reformulate" style: the variant reads as clean prose, not
  // an inline diff (product decision, Aug 2026 — diffs were hard to read).
  const unchanged = useMemo(() => {
    if (!deps || !slot.done || slot.error) return false;
    const canonical = (markdown: string) => deps.canonicalizeMarkdown(markdown).trim();
    return canonical(slot.text.trim()) === canonical(original);
  }, [deps, slot.done, slot.error, slot.text, original]);
  const pickable = deps !== null && slot.done && !slot.error && !unchanged && !disabled;

  return (
    <button
      type="button"
      data-testid={`rewrite-variant-${index}`}
      disabled={!pickable}
      onClick={onPick}
      className={`group flex w-full gap-2.5 px-3 py-2 text-left transition-colors ${
        pickable ? 'cursor-pointer hover:bg-beige-50' : 'cursor-default'
      }`}
    >
      <kbd className="mt-1 flex h-[18px] w-[18px] flex-none items-center justify-center rounded border border-stone-200 text-[11px] text-stone-500 group-hover:border-beige-400 group-hover:text-beige-600">
        {index + 1}
      </kbd>
      <span className="min-w-0 flex-1">
        <span className="mb-0.5 flex items-center gap-1.5">
          <span className="text-[10.5px] font-medium uppercase tracking-wide text-stone-400">
            {slot.label}
          </span>
          {!slot.done && !slot.error && (
            <SpinnerGapIcon className="h-3 w-3 animate-spin text-stone-400" />
          )}
          {slot.error && <span className="text-[11px] text-red-500">failed</span>}
          {unchanged && <span className="text-[11px] text-stone-400">no change suggested</span>}
        </span>
        {slot.error ? (
          <span className="block text-[13px] text-stone-400">{slot.error}</span>
        ) : !unchanged ? (
          <span className="block whitespace-pre-wrap text-[14px] leading-6 text-stone-700">
            {slot.text || '…'}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function EditorRewritePopup({
  editor,
  projectId,
  filePath,
}: {
  editor: Editor;
  projectId: string | null;
  filePath: string | null;
}) {
  const apiFetch = useApiFetch();
  const [state, setState] = useState<OpenState | null>(null);
  // Mirror for async callbacks that must detect a close/reopen across an
  // await (pick's deps load).
  const stateRef = useRef<OpenState | null>(null);
  stateRef.current = state;
  const [deps, setDeps] = useState<HeavyDeps | null>(null);
  const [slots, setSlots] = useState<VariantSlot[] | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [applying, setApplying] = useState(false);
  const [instruction, setInstruction] = useState('');

  const boxRef = useRef<HTMLDivElement | null>(null);
  // Each open allocates a fresh state object, so `state` doubles as the
  // drag/resize reset key.
  const { frameStyle, startMove, startResize } = usePopupFrame(boxRef, state);
  const abortRef = useRef<AbortController | null>(null);
  const invocationIdRef = useRef<string | null>(null);
  const openedAtRef = useRef(0);
  const outcomeSentRef = useRef(false);
  const textsRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One pending chose-then-edited check PER chosen invocation — a second
  // choice within the window must not cancel the first one's check, and an
  // unmount (file switch) runs pending checks early instead of dropping them.
  const postEditChecksRef = useRef<Map<ReturnType<typeof setTimeout>, () => void>>(new Map());

  const postOutcome = useCallback(
    (payload: Record<string, unknown>) => {
      const invocationId = payload.invocationId ?? invocationIdRef.current;
      if (!projectId || !invocationId) return;
      const send = () =>
        apiFetch('/api/workspace/rewrite-variants/outcome', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // keepalive: the dismiss on a tab close must still reach the log.
          keepalive: true,
          body: JSON.stringify({ projectId, ...payload, invocationId }),
        });
      // The invocation id is CLIENT-allocated, so a dismissal during the very
      // first request can race the server's stub insert — one delayed retry
      // covers the 404 window without dropping the outcome.
      void send()
        .then((response) => {
          if (response.status === 404) {
            return new Promise((resolve) => setTimeout(resolve, 1500)).then(send);
          }
          return response;
        })
        .catch(() => {});
    },
    [apiFetch, projectId],
  );

  /** Log the terminal outcome for the CURRENT invocation exactly once. */
  const sendOutcome = useCallback(
    // 'none' has no UI path by DESIGN: the explicit "None of these" button
    // was removed as clutter (product decision, Aug 2026) — walking away IS
    // the rejection signal, recorded as 'dismissed'. The enum value stays
    // for old rows and a possible future surface.
    (outcome: 'chosen' | 'none' | 'dismissed' | 'stale' | 'regenerated', extra?: Record<string, unknown>) => {
      if (outcomeSentRef.current) return;
      outcomeSentRef.current = true;
      postOutcome({ outcome, timeToOutcomeMs: Date.now() - openedAtRef.current, ...extra });
    },
    [postOutcome],
  );

  const runGeneration = useCallback(
    (capture: RewriteSelectionCapture, path: string | null, userInstruction: string | null) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      // Allocate the invocation id HERE, not on the server's start event: a
      // dismissal while "Generating…" must still carry an id, or the stub row
      // stays permanently unlabeled and biases the preference data.
      const invocationId = crypto.randomUUID();
      invocationIdRef.current = invocationId;
      outcomeSentRef.current = false;
      openedAtRef.current = Date.now();
      textsRef.current = [];
      setSlots(null);
      setStreamError(null);
      setStale(false);
      if (capture.text.length > MAX_REWRITE_TEXT_CHARS) {
        setStreamError('Selection is too long to rewrite. Pick a shorter passage.');
        return;
      }

      const flushTexts = () => {
        flushTimerRef.current = null;
        setSlots((prev) =>
          prev ? prev.map((slot, i) => ({ ...slot, text: textsRef.current[i] ?? '' })) : prev,
        );
      };
      const scheduleFlush = () => {
        if (flushTimerRef.current === null) flushTimerRef.current = setTimeout(flushTexts, 60);
      };
      let sawStart = false;
      let sawDone = false;
      // The server persists each variant BEFORE its variant-done, so a done
      // card is always safely pickable; only cards still streaming when the
      // protocol breaks off must fail (never spin forever).
      const failUnfinished = (message: string) => {
        setSlots((prev) =>
          prev
            ? prev.map((slot, i) =>
                slot.done
                  ? slot
                  : { ...slot, text: textsRef.current[i] ?? '', done: true, error: message },
              )
            : prev,
        );
      };
      const parser = createRewriteStreamParser((event) => {
        if (event.type === 'start') {
          sawStart = true;
          textsRef.current = event.slots.map(() => '');
          setSlots(
            event.slots.map(({ axis, label }) => ({
              axis,
              label: label ?? AXIS_LABELS[axis as RewriteAxisId] ?? axis,
              text: '',
              done: false,
              error: null,
            })),
          );
        } else if (event.type === 'delta') {
          textsRef.current[event.slot] = (textsRef.current[event.slot] ?? '') + event.text;
          scheduleFlush();
        } else if (event.type === 'variant-reset') {
          // The streamed attempt echoed the original — the server discarded
          // it and is regenerating; clear this card's buffer.
          textsRef.current[event.slot] = '';
          scheduleFlush();
        } else if (event.type === 'variant-done') {
          setSlots((prev) =>
            prev
              ? prev.map((slot, i) =>
                  i === event.slot ? { ...slot, text: textsRef.current[i] ?? '', done: true } : slot,
                )
              : prev,
          );
        } else if (event.type === 'variant-error') {
          setSlots((prev) =>
            prev
              ? prev.map((slot, i) =>
                  i === event.slot ? { ...slot, done: true, error: event.message } : slot,
                )
              : prev,
          );
        } else if (event.type === 'error') {
          // The server explicitly failed to persist the variant set — a
          // choice against an incomplete record is degraded training data,
          // so NOTHING stays pickable (unlike a mere transport break, where
          // each variant-done card is individually persisted).
          setSlots((prev) =>
            prev ? prev.map((slot) => ({ ...slot, done: true, error: slot.error ?? 'failed to save' })) : prev,
          );
          setStreamError('Rewrites could not be saved. Try again.');
          sawDone = true;
        } else if (event.type === 'done') {
          sawDone = true;
        }
      });

      void (async () => {
        const response = await apiFetch('/api/workspace/rewrite-variants', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            projectId,
            invocationId,
            filePath: path,
            text: capture.text,
            instruction: userInstruction,
            contextBefore: capture.contextBefore,
            contextAfter: capture.contextAfter,
          }),
        });
        if (!response.ok || !response.body) {
          const reason = await response
            .json()
            .then((data: { error?: string }) => data?.error)
            .catch(() => null);
          throw new Error(
            reason === 'signin_required'
              ? 'Sign in to use rewrites.'
              : reason === 'out_of_credits'
                ? 'Out of credits.'
                : reason === 'selection_too_long'
                  ? 'Selection is too long to rewrite. Pick a shorter passage.'
                  : reason === 'too_many_rewrites'
                    ? 'Previous rewrites are still generating. Give them a moment.'
                    : 'Rewrites are unavailable right now.',
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
        // A clean EOF is not completion: an intermediary can end the response
        // mid-protocol. Completed (= persisted) cards stay; the rest fail
        // visibly rather than spin forever.
        if (!sawStart) throw new Error('Rewrites are unavailable right now.');
        if (!sawDone && !controller.signal.aborted) failUnfinished('stream ended early');
      })().catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // A transport exception mid-stream (dropped connection, proxy reset)
        // is the same case as a clean early EOF: completed cards are already
        // persisted server-side and stay pickable; only unfinished ones fail.
        if (sawStart) {
          failUnfinished('connection lost');
          return;
        }
        setStreamError(error instanceof Error ? error.message : 'Rewrites are unavailable right now.');
      });
    },
    [apiFetch, projectId],
  );

  // Open on the bubble menu's event (scoped to this editor instance).
  useEffect(() => {
    const onOpen = (event: Event) => {
      if (editor.isDestroyed || !editor.isEditable) return;
      const detail = (event as CustomEvent<{ capture?: RewriteSelectionCapture; source?: Element }>)
        .detail;
      if (!detail?.capture) return;
      if (detail.source && detail.source !== editor.view.dom) return;
      let coords = { left: 8, top: 0, bottom: 8 };
      try {
        coords = editor.view.coordsAtPos(editor.state.selection.from);
      } catch {
        // jsdom / detached view: keep the fallback corner position.
      }
      // Open on whichever side actually has room, and never taller than that
      // room — a fixed floor would push the footer off a short viewport.
      const roomBelow = window.innerHeight - coords.bottom - 24;
      const roomAbove = coords.top - 24;
      const flipUp = roomBelow < POPUP_CLEARANCE && roomAbove > roomBelow;
      // No floor beyond the room itself — a floor would push the footer past
      // the viewport edge on short screens.
      const maxHeight = Math.round(
        Math.max(0, Math.min(flipUp ? roomAbove : roomBelow, window.innerHeight - 32)),
      );
      // Never wider than the viewport — a fixed 480px would push the cards
      // and footer off-screen on phones.
      const width = Math.min(POPUP_WIDTH, window.innerWidth - 16);
      setState({
        capture: detail.capture,
        path: filePath,
        left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)),
        width,
        maxHeight,
        ...(flipUp ? { bottom: window.innerHeight - coords.top + 8 } : { top: coords.bottom + 8 }),
      });
      setInstruction('');
      setApplying(false);
      // Heavy internals load while the variants stream — far before a pick.
      void loadHeavyDeps().then(setDeps);
      runGeneration(detail.capture, filePath, null);
    };
    window.addEventListener('sundial:open-rewrite-review', onOpen);
    return () => window.removeEventListener('sundial:open-rewrite-review', onOpen);
  }, [editor, filePath, runGeneration]);

  const open = state !== null;

  const close = useCallback(
    (outcome: 'dismissed' | null) => {
      if (outcome) sendOutcome(outcome);
      abortRef.current?.abort();
      setState(null);
      setSlots(null);
    },
    [sendOutcome],
  );

  const pick = useCallback(
    async (index: number) => {
      if (!state || !slots) return;
      const slot = slots[index];
      if (!slot?.done || slot.error || applying) return;
      // Deps start loading on open, but a fast pick (digit shortcut right as
      // the cards finish) can beat the dynamic import — resolve it here
      // instead of silently dropping the input. Memoized: awaits once ever.
      const invocationAtPick = invocationIdRef.current;
      const loaded = deps ?? (await loadHeavyDeps());
      // The popup may have closed OR regenerated across the await — state
      // survives a regeneration, so compare the invocation too (an old pick
      // must not apply and log 'chosen' against the new run).
      if (stateRef.current !== state || invocationIdRef.current !== invocationAtPick) return;
      const canonical = (markdown: string) => loaded.canonicalizeMarkdown(markdown).trim();
      const variantText = slot.text.trim();
      if (!variantText || canonical(variantText) === canonical(state.capture.text)) return;
      setApplying(true);
      const appliedCapture = loaded.applyRewrite(editor, state.capture, variantText);
      if (!appliedCapture) {
        setApplying(false);
        setStale(true);
        sendOutcome('stale', { chosenSlot: index });
        return;
      }
      sendOutcome('chosen', { chosenSlot: index });
      // Chose-then-edited: re-read the applied span shortly after; a drift
      // from the chosen variant is the highest-signal label we record.
      const invocationId = invocationIdRef.current;
      const runCheck = () => {
        if (editor.isDestroyed) return;
        const current = loaded.readTextAtCapture(editor, appliedCapture);
        if (current !== null && canonical(current) !== canonical(variantText)) {
          postOutcome({ invocationId, postEditText: current });
        }
      };
      const timer = setTimeout(() => {
        postEditChecksRef.current.delete(timer);
        runCheck();
      }, POST_EDIT_CHECK_MS);
      postEditChecksRef.current.set(timer, runCheck);
      close(null);
    },
    [applying, close, deps, editor, postOutcome, sendOutcome, slots, state],
  );

  const regenerate = useCallback(() => {
    const trimmed = instruction.trim();
    if (!state || !trimmed) return;
    // The superseded invocation gets its own terminal outcome before the
    // re-run replaces it.
    sendOutcome('regenerated');
    runGeneration(state.capture, state.path, trimmed);
  }, [instruction, runGeneration, sendOutcome, state]);

  // Keyboard: 1–4 pick, Esc dismisses (inner inputs close first). Capture
  // phase + preventDefault so digits never reach the editor as typing.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close('dismissed');
        return;
      }
      const target = event.target as HTMLElement | null;
      const inField =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (inField) return;
      if (event.key >= '1' && event.key <= '4' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        void pick(Number(event.key) - 1);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions);
  }, [open, close, pick]);

  // Outside-click dismissal, same idiom as the ask popup / slash menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as unknown;
      if (target instanceof Node && boxRef.current?.contains(target)) return;
      close('dismissed');
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () =>
      window.removeEventListener('pointerdown', onPointerDown, {
        capture: true,
      } as EventListenerOptions);
  }, [open, close]);

  // Grab focus so 1–4 land here, not in the editor.
  useEffect(() => {
    if (open) boxRef.current?.focus();
  }, [open]);

  // Unmount with the popup open (file switch remounts the keyed editor) is a
  // dismissal too — without recording it the stub row stays outcome-null and
  // biases the log. Refs, because the [] cleanup must see the LATEST state.
  const openRef = useRef(false);
  openRef.current = state !== null;
  const sendOutcomeRef = useRef(sendOutcome);
  sendOutcomeRef.current = sendOutcome;
  useEffect(
    () => () => {
      if (openRef.current) sendOutcomeRef.current('dismissed');
      abortRef.current?.abort();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      // Sample pending chose-then-edited checks NOW — child cleanup runs
      // before the parent destroys the editor, and nothing can read the
      // applied span after that.
      for (const [timer, check] of postEditChecksRef.current) {
        clearTimeout(timer);
        check();
      }
      postEditChecksRef.current.clear();
    },
    [],
  );

  if (!state) return null;

  return (
    <div
      ref={boxRef}
      tabIndex={-1}
      data-testid="rewrite-review-popup"
      className="fixed z-50 flex flex-col rounded-xl border border-stone-200 bg-white shadow-[0_4px_16px_rgba(28,25,23,0.14)] focus:outline-none"
      style={{
        left: state.left,
        top: state.top,
        bottom: state.bottom,
        width: state.width,
        maxHeight: state.maxHeight,
        ...frameStyle,
      }}
    >
      <div
        onPointerDown={startMove}
        className="flex cursor-grab select-none items-center gap-2 border-b border-stone-100 px-3 py-2 active:cursor-grabbing"
      >
        <MagicWandIcon className="h-4 w-4 text-beige-600" weight="fill" />
        <span className="text-[14px] font-semibold text-stone-800">Rewrite suggestions</span>
        <span className="text-[12px] text-stone-400">· pick one</span>
      </div>

      <div className="flex-1 divide-y divide-stone-100 overflow-y-auto py-0.5">
        {streamError ? (
          <p className="px-3 py-2 text-[12px] text-stone-500">{streamError}</p>
        ) : !slots ? (
          <p className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-stone-400">
            <SpinnerGapIcon className="h-3.5 w-3.5 animate-spin" /> Reading the passage…
          </p>
        ) : (
          slots.map((slot, index) => (
            <VariantCard
              key={index}
              index={index}
              slot={slot}
              original={state.capture.text}
              disabled={applying || stale}
              deps={deps}
              onPick={() => void pick(index)}
            />
          ))
        )}
        {stale && (
          <p className="mx-2 my-1 rounded-md bg-amber-50 px-2 py-1.5 text-[12px] text-amber-700">
            The text changed while rewriting. Nothing was applied.
          </p>
        )}
      </div>

      <div className="border-t border-stone-100 p-2">
        {/* Always visible — no disclosure to hunt for. Enter regenerates all
            four suggestions steered by whatever is typed here. */}
        <input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              regenerate();
            }
          }}
          placeholder="Steer the suggestions… (Enter regenerates)"
          className="w-full rounded-md border border-stone-200 px-2 py-1.5 text-[13px] text-stone-800 placeholder:text-stone-400 focus:border-beige-400 focus:outline-none"
        />
      </div>
      <PopupResizeHandle onPointerDown={startResize} />
    </div>
  );
}
