'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  ArrowCounterClockwiseIcon,
  CircleDashedIcon,
  DotsNineIcon,
  GlobeHemisphereWestIcon,
  SpinnerGapIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  MORPH_AXES,
  MORPH_AXIS_BY_ID,
  MORPH_AXIS_RANGE,
  MAX_MORPH_TEXT_CHARS,
  type MorphAxisId,
  type MorphRequestVariant,
} from '@/lib/workspace/ai-morph';
import { useMorphCache } from '@/components/workspace/use-morph-cache';
import type { RewriteSelectionCapture } from '@/lib/workspace/rewrite-anchor';
import { PopupResizeHandle, usePopupFrame } from '@/components/workspace/use-popup-frame';

/* ── Prism popup ──────────────────────────────────────────────────────
 *  Rotate a selection's MEANING in feature space (after thesephist's Prism):
 *  a draggable dial over two semantic axes, quantized to a 5×5 grid of
 *  positions; the passage re-renders live as the knob moves. Speed comes
 *  from prefetch — landing on a cell requests its neighbors, so the next
 *  step is usually already cached. Two dial displays (grid pad / ring), a
 *  toggle switches them. Apply routes through the same markdown-preserving
 *  anchor path as the rewrite popup; everything else is preview-only.
 * ─────────────────────────────────────────────────────────────────── */

type ApplyDeps = {
  applyRewrite: typeof import('@/lib/workspace/rewrite-anchor').applyRewrite;
};
let applyDepsPromise: Promise<ApplyDeps> | null = null;
function loadApplyDeps(): Promise<ApplyDeps> {
  applyDepsPromise ??= import('@/lib/workspace/rewrite-anchor').then((anchor) => ({
    applyRewrite: anchor.applyRewrite,
  }));
  return applyDepsPromise;
}

type OpenState = {
  capture: RewriteSelectionCapture;
  path: string | null;
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

const POPUP_WIDTH = 460;
const POPUP_CLEARANCE = 280;
const DIAL_SIZE = 176;
const GRID = MORPH_AXIS_RANGE * 2 + 1; // 5

type Pos = { x: number; y: number };
/** Three interchangeable dials over the same 5×5 morph grid: grid pad, ring
 *  compass, and a draggable globe (the thesephist-Prism homage). All share
 *  one variant cache — switching dials keeps every morph already fetched. */
type DialMode = 'pad' | 'ring' | 'sphere';
const DIAL_MODES: { mode: DialMode; icon: typeof DotsNineIcon; label: string }[] = [
  { mode: 'pad', icon: DotsNineIcon, label: 'Grid dial' },
  { mode: 'ring', icon: CircleDashedIcon, label: 'Ring dial' },
  { mode: 'sphere', icon: GlobeHemisphereWestIcon, label: 'Globe dial' },
];

const MODE_STORAGE_KEY = 'sundial:prism-dial-mode';

/* Sphere projection: grid cells sit on a globe at fixed longitudes (x·30°)
 * and latitudes (y·27°); dragging spins the globe and the cell facing the
 * viewer is the active morph. Orthographic projection, front hemisphere
 * emphasized by size/opacity. The steps tile the full sphere (see
 * SPHERE_LATTICE) so there is never a bald patch mid-spin. */
const SPHERE_LONG_STEP = 30;
const SPHERE_LAT_STEP = 27;
const DEG = Math.PI / 180;

function sphereProjectAngles(longDeg: number, latDeg: number, yaw: number, pitch: number) {
  const long = (longDeg + yaw) * DEG;
  const lat = (latDeg + pitch) * DEG;
  return {
    sx: Math.cos(lat) * Math.sin(long),
    sy: Math.sin(lat),
    sz: Math.cos(lat) * Math.cos(long),
  };
}

function sphereProject(cell: Pos, yaw: number, pitch: number) {
  return sphereProjectAngles(cell.x * SPHERE_LONG_STEP, cell.y * SPHERE_LAT_STEP, yaw, pitch);
}

/** Decorative lattice covering the WHOLE globe at the same spacing as the
 *  grid: 12 longitudes × latitudes to ±81°, minus the positions the live
 *  5×5 cells occupy. Purely visual — the morph grid stays ±2. */
const SPHERE_LATTICE: { long: number; lat: number }[] = [];
for (let li = -6; li < 6; li += 1) {
  for (let la = -3; la <= 3; la += 1) {
    const long = li * SPHERE_LONG_STEP;
    const lat = la * SPHERE_LAT_STEP;
    if (Math.abs(li) <= 2 && Math.abs(la) <= 2) continue; // live cells
    SPHERE_LATTICE.push({ long, lat });
  }
}

/** Ring positions: 8 compass directions × 2 intensities, all living on the
 *  same 5×5 grid the pad uses — the two dials share one variant cache. */
const RING_DIRECTIONS: Pos[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
];

function clampStep(value: number): number {
  return Math.max(-MORPH_AXIS_RANGE, Math.min(MORPH_AXIS_RANGE, Math.round(value)));
}

export function prismVariantKey(xAxis: MorphAxisId, yAxis: MorphAxisId, pos: Pos): string {
  return `${xAxis}|${yAxis}:${pos.x},${pos.y}`;
}

/** The cell itself plus its in-range cardinal neighbors — one prefetch wave
 *  (≤5 variants, under the route's cap). Exported for tests. */
export function prismPrefetchWave(
  xAxis: MorphAxisId,
  yAxis: MorphAxisId,
  pos: Pos,
): MorphRequestVariant[] {
  const cells: Pos[] = [
    pos,
    { x: pos.x + 1, y: pos.y },
    { x: pos.x - 1, y: pos.y },
    { x: pos.x, y: pos.y + 1 },
    { x: pos.x, y: pos.y - 1 },
  ];
  return cells
    .filter(
      (cell) =>
        Math.abs(cell.x) <= MORPH_AXIS_RANGE &&
        Math.abs(cell.y) <= MORPH_AXIS_RANGE &&
        !(cell.x === 0 && cell.y === 0),
    )
    .map((cell) => ({
      key: prismVariantKey(xAxis, yAxis, cell),
      spec: {
        axes: [
          { id: xAxis, value: cell.x },
          { id: yAxis, value: cell.y },
        ],
      },
    }));
}

function AxisSelect({
  value,
  exclude,
  onChange,
  label,
}: {
  value: MorphAxisId;
  exclude: MorphAxisId;
  onChange: (id: MorphAxisId) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-stone-500">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as MorphAxisId)}
        className="rounded-md border border-stone-200 bg-white px-1 py-0.5 text-[11px] font-medium text-stone-700 focus:outline-none"
      >
        {MORPH_AXES.filter((axis) => axis.id === value || axis.id !== exclude).map((axis) => (
          <option key={axis.id} value={axis.id}>
            {axis.neg} ↔ {axis.pos}
          </option>
        ))}
      </select>
    </label>
  );
}

export function EditorPrismPopup({
  editor,
  projectId,
  filePath,
}: {
  editor: Editor;
  projectId: string | null;
  filePath: string | null;
}) {
  const [state, setState] = useState<OpenState | null>(null);
  const [xAxis, setXAxis] = useState<MorphAxisId>('tone');
  const [yAxis, setYAxis] = useState<MorphAxisId>('energy');
  const [pos, setPos] = useState<Pos>({ x: 0, y: 0 });
  const [mode, setMode] = useState<DialMode>('pad');
  const [dragging, setDragging] = useState(false);
  const [stale, setStale] = useState(false);
  const [applying, setApplying] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { frameStyle, startMove, startResize } = usePopupFrame(boxRef, state);
  const dialRef = useRef<HTMLDivElement | null>(null);

  const capture = state?.capture ?? null;
  const morph = useMorphCache({
    projectId,
    filePath: state?.path ?? null,
    capture,
  });
  // Ref so the open handler (bound once per editor) can reset without
  // re-registering the window listener each render.
  const morphRef = useRef(morph);
  morphRef.current = morph;

  const prefetch = useCallback(
    (at: Pos) => morphRef.current.request(prismPrefetchWave(xAxis, yAxis, at)),
    [xAxis, yAxis],
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
      const roomBelow = window.innerHeight - coords.bottom - 24;
      const roomAbove = coords.top - 24;
      const flipUp = roomBelow < POPUP_CLEARANCE && roomAbove > roomBelow;
      const maxHeight = Math.round(
        Math.max(0, Math.min(flipUp ? roomAbove : roomBelow, window.innerHeight - 32)),
      );
      const width = Math.min(POPUP_WIDTH, window.innerWidth - 16);
      morphRef.current.reset();
      setPos({ x: 0, y: 0 });
      setStale(false);
      setApplying(false);
      setState({
        capture: detail.capture,
        path: filePath,
        left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)),
        width,
        maxHeight,
        ...(flipUp ? { bottom: window.innerHeight - coords.top + 8 } : { top: coords.bottom + 8 }),
      });
      try {
        const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
        if (DIAL_MODES.some((entry) => entry.mode === stored)) setMode(stored as DialMode);
      } catch {
        // Storage unavailable — keep the in-memory default.
      }
      void loadApplyDeps();
    };
    window.addEventListener('sundial:open-prism', onOpen);
    return () => window.removeEventListener('sundial:open-prism', onOpen);
  }, [editor, filePath]);

  const open = state !== null;

  // First prefetch wave the moment the popup opens (and again on axis swap):
  // the four ±1 neighbors, so the first knob step is already streaming.
  useEffect(() => {
    if (!open || !capture) return;
    if (capture.text.length > MAX_MORPH_TEXT_CHARS) return;
    prefetch({ x: 0, y: 0 });
  }, [open, capture, prefetch]);

  // Swapping an axis re-keys the whole grid — a knob left at (2,1) would sit
  // on data that no longer exists. Back to the original, which needs none.
  useEffect(() => {
    setPos({ x: 0, y: 0 });
  }, [xAxis, yAxis]);

  const close = useCallback(() => {
    morphRef.current.reset();
    setState(null);
  }, []);

  // Esc closes; outside pointerdown closes.
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

  const setDialMode = useCallback((next: DialMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Best-effort persistence only.
    }
  }, []);

  const moveTo = useCallback(
    (next: Pos) => {
      setPos((current) => {
        if (current.x === next.x && current.y === next.y) return current;
        prefetch(next);
        return next;
      });
    },
    [prefetch],
  );

  /** Pointer position → nearest grid cell (pad) or nearest ring position. */
  const posFromPointer = useCallback(
    (event: { clientX: number; clientY: number }): Pos => {
      const dial = dialRef.current?.getBoundingClientRect();
      if (!dial) return { x: 0, y: 0 };
      const relX = (event.clientX - dial.left) / dial.width - 0.5;
      const relY = (event.clientY - dial.top) / dial.height - 0.5;
      if (mode === 'pad') {
        return {
          x: clampStep(relX * 2 * (MORPH_AXIS_RANGE + 0.5)),
          y: clampStep(-relY * 2 * (MORPH_AXIS_RANGE + 0.5)),
        };
      }
      const radius = Math.hypot(relX, relY);
      if (radius < 0.1) return { x: 0, y: 0 };
      const angle = Math.atan2(-relY, relX);
      const sector = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
      const direction = RING_DIRECTIONS[sector];
      const intensity = radius > 0.34 ? 2 : 1;
      return { x: direction.x * intensity, y: direction.y * intensity };
    },
    [mode],
  );

  // Sphere rotation is continuous while dragging (the globe spins smoothly);
  // the active morph is the quantized cell facing the viewer. Between drags
  // the rotation snaps to the active cell, so keyboard/pad moves stay in sync.
  const [sphereRot, setSphereRot] = useState({ yaw: 0, pitch: 0 });
  const sphereDragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  useEffect(() => {
    if (!dragging) {
      setSphereRot({ yaw: pos.x * SPHERE_LONG_STEP, pitch: pos.y * SPHERE_LAT_STEP });
    }
  }, [pos, dragging]);

  const onDialPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      (event.target as Element).setPointerCapture?.(event.pointerId);
      setDragging(true);
      if (mode === 'sphere') {
        sphereDragRef.current = {
          x: event.clientX,
          y: event.clientY,
          yaw: sphereRot.yaw,
          pitch: sphereRot.pitch,
        };
      } else {
        moveTo(posFromPointer(event));
      }
    },
    [mode, moveTo, posFromPointer, sphereRot],
  );
  const onDialPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      if (mode === 'sphere') {
        const origin = sphereDragRef.current;
        if (!origin) return;
        // Drag right/up moves toward the right/top pole labels — same
        // semantic direction as the pad, even if a physical globe would
        // spin the other way.
        const yaw = Math.max(
          -MORPH_AXIS_RANGE * SPHERE_LONG_STEP,
          Math.min(MORPH_AXIS_RANGE * SPHERE_LONG_STEP, origin.yaw + (event.clientX - origin.x) * 0.6),
        );
        const pitch = Math.max(
          -MORPH_AXIS_RANGE * SPHERE_LAT_STEP,
          Math.min(MORPH_AXIS_RANGE * SPHERE_LAT_STEP, origin.pitch - (event.clientY - origin.y) * 0.6),
        );
        setSphereRot({ yaw, pitch });
        moveTo({
          x: clampStep(yaw / SPHERE_LONG_STEP),
          y: clampStep(pitch / SPHERE_LAT_STEP),
        });
      } else {
        moveTo(posFromPointer(event));
      }
    },
    [dragging, mode, moveTo, posFromPointer],
  );
  const onDialPointerUp = useCallback(() => {
    sphereDragRef.current = null;
    setDragging(false);
  }, []);

  const atOrigin = pos.x === 0 && pos.y === 0;
  const currentKey = capture ? prismVariantKey(xAxis, yAxis, pos) : '';
  const currentEntry = atOrigin ? null : morph.get(currentKey);
  const previewText = atOrigin
    ? (capture?.text ?? '')
    : currentEntry && currentEntry.text
      ? currentEntry.text
      : '';
  const previewStreaming = !atOrigin && currentEntry?.status === 'streaming';
  const previewError = !atOrigin && currentEntry?.status === 'error' ? (currentEntry.message ?? 'The preview failed.') : null;
  const applicable =
    !atOrigin && currentEntry?.status === 'done' && !!currentEntry.text.trim() && !applying;

  const apply = useCallback(() => {
    if (!state || !applicable || !currentEntry) return;
    setApplying(true);
    void loadApplyDeps().then(({ applyRewrite }) => {
      const applied = applyRewrite(editor, state.capture, currentEntry.text.trim());
      if (!applied) {
        setApplying(false);
        setStale(true);
        return;
      }
      close();
    });
  }, [applicable, close, currentEntry, editor, state]);

  const xAxisDef = MORPH_AXIS_BY_ID.get(xAxis)!;
  const yAxisDef = MORPH_AXIS_BY_ID.get(yAxis)!;

  const positionLabel = useMemo(() => {
    if (atOrigin) return 'original';
    const parts: string[] = [];
    if (pos.x !== 0) parts.push(`${pos.x > 0 ? xAxisDef.pos : xAxisDef.neg} ${Math.abs(pos.x)}`);
    if (pos.y !== 0) parts.push(`${pos.y > 0 ? yAxisDef.pos : yAxisDef.neg} ${Math.abs(pos.y)}`);
    return parts.join(' · ');
  }, [atOrigin, pos, xAxisDef, yAxisDef]);

  if (!state || !capture) return null;

  const tooLong = capture.text.length > MAX_MORPH_TEXT_CHARS;
  // Knob position in dial coordinates (both modes place cells on the grid).
  const knobLeft = 50 + (pos.x / (MORPH_AXIS_RANGE + 0.6)) * 50;
  const knobTop = 50 - (pos.y / (MORPH_AXIS_RANGE + 0.6)) * 50;

  const cellState = (cell: Pos): 'origin' | 'ready' | 'streaming' | 'idle' | 'error' => {
    if (cell.x === 0 && cell.y === 0) return 'origin';
    const entry = morph.get(prismVariantKey(xAxis, yAxis, cell));
    if (!entry) return 'idle';
    if (entry.status === 'done') return 'ready';
    if (entry.status === 'error') return 'error';
    return 'streaming';
  };
  const CELL_DOT: Record<ReturnType<typeof cellState>, string> = {
    origin: 'bg-stone-400',
    ready: 'bg-beige-400',
    streaming: 'bg-beige-300 animate-pulse',
    error: 'bg-red-300',
    idle: 'bg-stone-200',
  };
  // Same states as SVG fills, for the globe's projected dots. CSS vars so
  // the dark-mode palette remap reaches into the SVG.
  const CELL_FILL: Record<ReturnType<typeof cellState>, string> = {
    origin: 'var(--color-stone-400)',
    ready: 'var(--beige-dark)',
    streaming: 'var(--beige-med)',
    error: 'var(--color-red-200)',
    idle: 'var(--color-stone-200)',
  };
  const ALL_CELLS: Pos[] = Array.from({ length: GRID * GRID }, (_, i) => ({
    x: (i % GRID) - MORPH_AXIS_RANGE,
    y: Math.floor(i / GRID) - MORPH_AXIS_RANGE,
  }));

  return (
    <div
      ref={boxRef}
      data-testid="prism-popup"
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
        <AxisSelect value={xAxis} exclude={yAxis} onChange={setXAxis} label="↔" />
        <AxisSelect value={yAxis} exclude={xAxis} onChange={setYAxis} label="↕" />
        <div className="ml-auto flex items-center gap-0.5">
          {DIAL_MODES.map(({ mode: dialMode, icon: Icon, label }) => (
            <button
              key={dialMode}
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={mode === dialMode}
              data-testid={`prism-mode-${dialMode}`}
              onClick={() => setDialMode(dialMode)}
              className={`rounded-md p-1 ${mode === dialMode ? 'bg-stone-100 text-stone-800' : 'text-stone-400 hover:text-stone-600'}`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="ml-1 rounded-md p-1 text-stone-400 hover:text-stone-600"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {tooLong ? (
        <p className="px-3 py-4 text-[12px] text-stone-500">
          Selection is too long for live morphing. Pick a shorter passage.
        </p>
      ) : morph.fatalError ? (
        <p className="px-3 py-4 text-[12px] text-stone-500">{morph.fatalError}</p>
      ) : (
        <>
          <div className="flex min-h-0 gap-3 p-3">
            <div className="flex shrink-0 flex-col items-center gap-1">
                <span className="text-[10px] text-stone-400">{yAxisDef.pos}</span>
                <div className="flex items-center gap-1">
                  <span className="w-12 text-right text-[10px] text-stone-400">{xAxisDef.neg}</span>
                  <div
                    ref={dialRef}
                    data-testid="prism-dial"
                    role="slider"
                    aria-label="Meaning dial"
                    aria-valuetext={positionLabel}
                    tabIndex={0}
                    className={`relative touch-none select-none ${
                      mode === 'sphere'
                        ? ''
                        : `border border-stone-200 bg-stone-50 ${mode === 'ring' ? 'rounded-full' : 'rounded-xl'}`
                    } ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                    style={{ width: DIAL_SIZE, height: DIAL_SIZE }}
                    onPointerDown={onDialPointerDown}
                    onPointerMove={onDialPointerMove}
                    onPointerUp={onDialPointerUp}
                    onPointerCancel={onDialPointerUp}
                    onKeyDown={(event) => {
                      const delta: Record<string, Pos> = {
                        ArrowRight: { x: 1, y: 0 },
                        ArrowLeft: { x: -1, y: 0 },
                        ArrowUp: { x: 0, y: 1 },
                        ArrowDown: { x: 0, y: -1 },
                      };
                      const step = delta[event.key];
                      if (!step) return;
                      event.preventDefault();
                      moveTo({ x: clampStep(pos.x + step.x), y: clampStep(pos.y + step.y) });
                    }}
                  >
                    {mode === 'sphere' ? (
                      /* The globe: cells live on a sphere; drag spins it and
                         the cell facing you is the active morph. */
                      <svg viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`} width={DIAL_SIZE} height={DIAL_SIZE}>
                        <defs>
                          <radialGradient id="prism-sphere-shade" cx="36%" cy="30%" r="75%">
                            <stop offset="0%" stopColor="var(--color-white)" />
                            <stop offset="70%" stopColor="var(--color-stone-100)" />
                            <stop offset="100%" stopColor="var(--color-stone-300)" />
                          </radialGradient>
                        </defs>
                        <circle
                          cx={DIAL_SIZE / 2}
                          cy={DIAL_SIZE / 2}
                          r={DIAL_SIZE / 2 - 4}
                          fill="url(#prism-sphere-shade)"
                          stroke="var(--color-stone-200)"
                        />
                        {/* Full-globe lattice first (decorative), so the
                            sphere never shows a bald patch mid-spin. */}
                        {SPHERE_LATTICE.map(({ long, lat }) => {
                          const projected = sphereProjectAngles(long, lat, -sphereRot.yaw, -sphereRot.pitch);
                          if (projected.sz <= 0.05) return null;
                          const r = DIAL_SIZE / 2 - 14;
                          return (
                            <circle
                              key={`lattice:${long},${lat}`}
                              cx={DIAL_SIZE / 2 + projected.sx * r}
                              cy={DIAL_SIZE / 2 - projected.sy * r}
                              r={1.6 + projected.sz * 1.2}
                              fill="var(--color-stone-300)"
                              opacity={0.25 + projected.sz * 0.55}
                            />
                          );
                        })}
                        {ALL_CELLS.map((cell) => {
                          const projected = sphereProject(cell, -sphereRot.yaw, -sphereRot.pitch);
                          if (projected.sz <= 0.05) return null;
                          const r = DIAL_SIZE / 2 - 14;
                          const px = DIAL_SIZE / 2 + projected.sx * r;
                          const py = DIAL_SIZE / 2 - projected.sy * r;
                          const active = cell.x === pos.x && cell.y === pos.y;
                          return (
                            <circle
                              key={`${cell.x},${cell.y}`}
                              cx={px}
                              cy={py}
                              r={active ? 5 : 2 + projected.sz * 1.6}
                              fill={active ? 'var(--beige-ink)' : CELL_FILL[cellState(cell)]}
                              opacity={0.3 + projected.sz * 0.7}
                              stroke={active ? 'var(--color-white)' : 'none'}
                              strokeWidth={active ? 1.5 : 0}
                            />
                          );
                        })}
                      </svg>
                    ) : (
                      <>
                        {/* Position markers: every reachable cell in the current mode. */}
                        {(mode === 'pad'
                          ? ALL_CELLS
                          : [
                              { x: 0, y: 0 },
                              ...RING_DIRECTIONS.flatMap((direction) => [
                                { x: direction.x, y: direction.y },
                                { x: direction.x * 2, y: direction.y * 2 },
                              ]),
                            ]
                        ).map((cell) => (
                          <span
                            key={`${cell.x},${cell.y}`}
                            className={`absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${CELL_DOT[cellState(cell)]}`}
                            style={{
                              left: `${50 + (cell.x / (MORPH_AXIS_RANGE + 0.6)) * 50}%`,
                              top: `${50 - (cell.y / (MORPH_AXIS_RANGE + 0.6)) * 50}%`,
                            }}
                          />
                        ))}
                        {/* The knob. */}
                        <span
                          data-testid="prism-knob"
                          className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-beige-600 shadow-md transition-all duration-100"
                          style={{ left: `${knobLeft}%`, top: `${knobTop}%` }}
                        />
                      </>
                    )}
                  </div>
                  <span className="w-12 text-[10px] text-stone-400">{xAxisDef.pos}</span>
                </div>
                <span className="text-[10px] text-stone-400">{yAxisDef.neg}</span>
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg bg-stone-50/60 p-2">
              {previewError ? (
                <p className="text-[13px] text-red-500">{previewError} Move the dial to retry.</p>
              ) : (
                <p
                  key={atOrigin ? 'original' : currentKey}
                  className={`whitespace-pre-wrap text-[15px] leading-6 text-stone-800 ${
                    previewStreaming ? 'opacity-80' : 'animate-[fadeIn_120ms_ease-out]'
                  }`}
                >
                  {previewText || '…'}
                  {previewStreaming && (
                    <SpinnerGapIcon className="ml-1 inline h-3 w-3 animate-spin text-stone-400" />
                  )}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-stone-100 px-3 py-2">
            {stale && (
              <span className="text-[11px] text-amber-600">
                The text changed under this morph. Reselect and try again.
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Back to original"
                onClick={() => moveTo({ x: 0, y: 0 })}
                disabled={atOrigin}
                className="rounded-md p-1.5 text-stone-400 enabled:hover:text-stone-600 disabled:opacity-40"
              >
                <ArrowCounterClockwiseIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-testid="prism-apply"
                onClick={apply}
                disabled={!applicable}
                className="rounded-lg bg-beige-600 px-3 py-1 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}
      <PopupResizeHandle onPointerDown={startResize} />
    </div>
  );
}
