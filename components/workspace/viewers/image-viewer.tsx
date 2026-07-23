'use client';

import { useCallback, useRef, useState } from 'react';
import { MinusIcon, PlusIcon } from '@phosphor-icons/react';
import { IconTooltip } from '@/components/collab-bubbles';

interface ImageViewerProps {
  src: string;
  alt: string;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

export function ImageViewer({ src, alt }: ImageViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + ZOOM_STEP) * 100) / 100));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - ZOOM_STEP) * 100) / 100));
  }, []);

  const handleFit = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleActualSize = useCallback(() => {
    if (!imgRef.current || !containerRef.current) return;
    const { naturalWidth, naturalHeight } = imgRef.current;
    const rect = containerRef.current.getBoundingClientRect();
    if (!naturalWidth || !naturalHeight) return;
    // Figure out how much the fit-contain shrinks the image, then invert it
    const fitScale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
    setZoom(fitScale < 1 ? 1 / fitScale : 1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((z + delta) * 100) / 100)));
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY };
      panOffsetRef.current = { ...pan };
    },
    [pan]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning) return;
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      setPan({
        x: panOffsetRef.current.x + dx,
        y: panOffsetRef.current.y + dy,
      });
    },
    [isPanning]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const zoomPercent = Math.round(zoom * 100);
  const isFit = zoom === 1 && pan.x === 0 && pan.y === 0;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            className="relative group/tip p-1.5 rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <MinusIcon className="w-3.5 h-3.5" weight="bold" />
            <IconTooltip label="Zoom out" />
          </button>
          <span className="px-2 text-xs text-stone-500 tabular-nums min-w-[3rem] text-center font-mono">
            {zoomPercent}%
          </span>
          <button
            type="button"
            onClick={handleZoomIn}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            className="relative group/tip p-1.5 rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <PlusIcon className="w-3.5 h-3.5" weight="bold" />
            <IconTooltip label="Zoom in" />
          </button>
          <div className="w-px h-4 bg-stone-200 mx-1" />
          <button
            type="button"
            onClick={handleFit}
            aria-label="Fit to view"
            className={`relative group/tip px-2 py-1 text-xs rounded-lg border transition-colors ${
              isFit
                ? 'border-stone-400 bg-stone-100 text-stone-700'
                : 'border-stone-200 text-stone-500 hover:bg-stone-50'
            }`}
          >
            Fit
            <IconTooltip label="Fit to view" />
          </button>
          <button
            type="button"
            onClick={handleActualSize}
            aria-label="Actual size (1:1 pixels)"
            className="relative group/tip px-2 py-1 text-xs rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-50 transition-colors"
          >
            1:1
            <IconTooltip label="Actual size" />
          </button>
        </div>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-stone-400 hover:text-stone-600 transition-colors"
        >
          Open full image
        </a>
      </div>

      {/* Image container */}
      <div
        ref={containerRef}
        className="border border-stone-200 rounded-xl overflow-hidden bg-[repeating-conic-gradient(#f5f5f4_0%_25%,#fff_0%_50%)] bg-[length:16px_16px] relative"
        style={{ height: '70vh', cursor: isPanning ? 'grabbing' : zoom > 1 ? 'grab' : 'default' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          className="w-full h-full flex items-center justify-center overflow-hidden"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px)`,
            transition: isPanning ? 'none' : 'transform 0.15s ease-out',
          }}
        >
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            className="select-none pointer-events-none"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              transform: `scale(${zoom})`,
              transformOrigin: 'center center',
              transition: isPanning ? 'none' : 'transform 0.15s ease-out',
            }}
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}
