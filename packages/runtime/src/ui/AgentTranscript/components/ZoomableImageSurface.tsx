import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { copyImageToClipboard } from '../../../utils/clipboard';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

type ZoomMode = 'fit' | 'custom';

export interface ZoomableImageSurfaceProps {
  src: string;
  alt: string;
  copyFilePath?: string;
  className?: string;
  imageClassName?: string;
  toolbarLabel?: React.ReactNode;
  toolbarExtras?: React.ReactNode;
  showControls?: boolean;
  defaultMode?: 'fit' | 'actual';
  minScale?: number;
  maxScale?: number;
  onImageLoad?: (dimensions: { width: number; height: number }) => void;
  onImageError?: () => void;
}

export const ZoomableImageSurface: React.FC<ZoomableImageSurfaceProps> = ({
  src,
  alt,
  copyFilePath,
  className = '',
  imageClassName = '',
  toolbarLabel,
  toolbarExtras,
  showControls = true,
  defaultMode = 'fit',
  minScale = 0.1,
  maxScale = 8,
  onImageLoad,
  onImageError,
}) => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const scaleRef = useRef(1);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    startDistance: number;
    startScale: number;
    anchor: { imageX: number; imageY: number } | null;
  } | null>(null);
  const pendingAnchorRef = useRef<{ imageX: number; imageY: number; clientX: number; clientY: number } | null>(null);
  const [anchorVersion, setAnchorVersion] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [zoomMode, setZoomMode] = useState<ZoomMode>(defaultMode === 'actual' ? 'custom' : 'fit');
  const [customScale, setCustomScale] = useState(defaultMode === 'actual' ? 1 : 1);
  const [dragState, setDragState] = useState<{
    pointerId: number;
    startX: number;
    startY: number;
    startScrollLeft: number;
    startScrollTop: number;
  } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setViewportSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoomMode(defaultMode === 'actual' ? 'custom' : 'fit');
    setCustomScale(defaultMode === 'actual' ? 1 : 1);
    setNaturalSize(null);
    setCopyState('idle');
  }, [defaultMode, src]);

  useEffect(() => {
    if (copyState !== 'copied' && copyState !== 'error') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const fitScale = useMemo(() => {
    if (!naturalSize || viewportSize.width <= 0 || viewportSize.height <= 0) {
      return 1;
    }

    return Math.min(
      viewportSize.width / naturalSize.width,
      viewportSize.height / naturalSize.height,
      1,
    );
  }, [naturalSize, viewportSize.height, viewportSize.width]);

  const effectiveScale = zoomMode === 'fit'
    ? fitScale
    : clamp(customScale, minScale, maxScale);

  const renderedWidth = naturalSize ? naturalSize.width * effectiveScale : 0;
  const renderedHeight = naturalSize ? naturalSize.height * effectiveScale : 0;
  const contentWidth = Math.max(viewportSize.width, renderedWidth);
  const contentHeight = Math.max(viewportSize.height, renderedHeight);
  const canPan = renderedWidth > viewportSize.width + 1 || renderedHeight > viewportSize.height + 1;
  const zoomPercent = Math.round(effectiveScale * 100);

  const setScale = (nextScale: number) => {
    setZoomMode('custom');
    setCustomScale(clamp(nextScale, minScale, maxScale));
  };

  const handleZoomStep = (multiplier: number) => {
    const baseScale = zoomMode === 'fit' ? fitScale : customScale;
    setScale(baseScale * multiplier);
  };

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    const dimensions = {
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
    setNaturalSize(dimensions);
    onImageLoad?.(dimensions);
  };

  const handleCopyImage = async () => {
    try {
      setCopyState('copying');
      await copyImageToClipboard({ src, filePath: copyFilePath });
      setCopyState('copied');
    } catch (error) {
      console.error('[ZoomableImageSurface] Failed to copy image:', error);
      setCopyState('error');
    }
  };

  // Zoom around a screen point: the image pixel under (clientX, clientY) stays
  // under that point after the re-render. The scroll correction runs in a
  // layout effect because the new image rect only exists after render.
  scaleRef.current = effectiveScale;

  const captureAnchor = (clientX: number, clientY: number) => {
    const imgRect = imageRef.current?.getBoundingClientRect();
    const scale = scaleRef.current;
    if (!imgRect || scale <= 0) return null;
    return {
      imageX: (clientX - imgRect.left) / scale,
      imageY: (clientY - imgRect.top) / scale,
    };
  };

  const zoomAround = (
    nextScale: number,
    anchor: { imageX: number; imageY: number } | null,
    clientX: number,
    clientY: number,
  ) => {
    pendingAnchorRef.current = anchor ? { ...anchor, clientX, clientY } : null;
    setScale(nextScale);
    setAnchorVersion((v) => v + 1);
  };
  const zoomAroundRef = useRef(zoomAround);
  zoomAroundRef.current = zoomAround;

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    const viewport = viewportRef.current;
    const imgRect = imageRef.current?.getBoundingClientRect();
    pendingAnchorRef.current = null;
    if (!anchor || !viewport || !imgRect) return;
    viewport.scrollLeft += imgRect.left + anchor.imageX * effectiveScale - anchor.clientX;
    viewport.scrollTop += imgRect.top + anchor.imageY * effectiveScale - anchor.clientY;
  }, [anchorVersion, effectiveScale]);

  // Trackpad pinch arrives as ctrl+wheel; Safari also emits gesture* events
  // that would zoom the whole page. Both need non-passive native listeners.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const anchor = captureAnchor(event.clientX, event.clientY);
      zoomAroundRef.current(scaleRef.current * Math.exp(-event.deltaY * 0.01), anchor, event.clientX, event.clientY);
    };
    const preventGesture = (event: Event) => event.preventDefault();

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    viewport.addEventListener('gesturestart', preventGesture);
    viewport.addEventListener('gesturechange', preventGesture);
    return () => {
      viewport.removeEventListener('wheel', handleWheel);
      viewport.removeEventListener('gesturestart', preventGesture);
      viewport.removeEventListener('gesturechange', preventGesture);
    };
  }, []);

  const startDrag = (pointerId: number, clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setDragState({
      pointerId,
      startX: clientX,
      startY: clientY,
      startScrollLeft: viewport.scrollLeft,
      startScrollTop: viewport.scrollTop,
    });
  };

  const pointerMidpoint = () => {
    const [a, b] = Array.from(pointersRef.current.values());
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture?.(event.pointerId);

    if (pointersRef.current.size === 2) {
      // Second finger down: switch from panning to pinching.
      setDragState(null);
      const mid = pointerMidpoint();
      if (mid.distance > 0) {
        pinchRef.current = {
          startDistance: mid.distance,
          startScale: scaleRef.current,
          anchor: captureAnchor(mid.x, mid.y),
        };
      }
      return;
    }

    if (pointersRef.current.size === 1 && canPan) {
      startDrag(event.pointerId, event.clientX, event.clientY);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const mid = pointerMidpoint();
      // Anchor stays fixed to the image point under the starting midpoint, so
      // moving both fingers together pans while spreading them zooms.
      zoomAround(pinch.startScale * (mid.distance / pinch.startDistance), pinch.anchor, mid.x, mid.y);
      return;
    }

    if (!dragState || dragState.pointerId !== event.pointerId) return;

    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.scrollLeft = dragState.startScrollLeft - (event.clientX - dragState.startX);
    viewport.scrollTop = dragState.startScrollTop - (event.clientY - dragState.startY);
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    viewportRef.current?.releasePointerCapture?.(event.pointerId);

    if (pinchRef.current && pointersRef.current.size < 2) {
      pinchRef.current = null;
      // Lifting one finger of a pinch hands off to a one-finger pan.
      const [remaining] = Array.from(pointersRef.current.entries());
      if (remaining) {
        startDrag(remaining[0], remaining[1].x, remaining[1].y);
      }
      return;
    }

    if (dragState?.pointerId === event.pointerId) {
      setDragState(null);
    }
  };

  return (
    <div className={`flex h-full min-h-0 flex-col bg-[var(--nim-bg)] ${className}`.trim()}>
      {showControls && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-2">
          <div className="min-w-0 flex-1 text-sm text-[var(--nim-text-muted)]">
            {toolbarLabel}
          </div>
          {toolbarExtras ? (
            <div className="flex shrink-0 items-center gap-2">
              {toolbarExtras}
            </div>
          ) : null}
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-xs text-[var(--nim-text)] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={() => setZoomMode('fit')}
            >
              Fit
            </button>
            <button
              type="button"
              className="rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-xs text-[var(--nim-text)] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={() => setScale(1)}
            >
              100%
            </button>
            <button
              type="button"
              className="rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-xs text-[var(--nim-text)] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={() => handleZoomStep(1 / 1.25)}
            >
              -
            </button>
            <div
              className="min-w-[3.5rem] rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-center font-mono text-xs text-[var(--nim-text)]"
              aria-live="polite"
              data-testid="zoomable-image-zoom"
            >
              {zoomPercent}%
            </div>
            <button
              type="button"
              className="rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-xs text-[var(--nim-text)] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={() => handleZoomStep(1.25)}
            >
              +
            </button>
            <button
              type="button"
              className="rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-xs text-[var(--nim-text)] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void handleCopyImage()}
              disabled={copyState === 'copying'}
            >
              {copyState === 'copying'
                ? 'Copying...'
                : copyState === 'copied'
                  ? 'Copied'
                  : copyState === 'error'
                    ? 'Copy failed'
                    : 'Copy image'}
            </button>
          </div>
        </div>
      )}

      <div
        ref={viewportRef}
        className={`flex-1 overflow-auto overscroll-contain touch-none bg-[var(--nim-bg)] p-4 select-none ${canPan ? (dragState ? 'cursor-grabbing' : 'cursor-grab') : ''}`.trim()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        data-testid="zoomable-image-viewport"
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: contentWidth > 0 ? `${contentWidth}px` : '100%',
            height: contentHeight > 0 ? `${contentHeight}px` : '100%',
          }}
        >
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            onLoad={handleImageLoad}
            onError={onImageError}
            draggable={false}
            data-testid="zoomable-image"
            className={`block max-w-none rounded-lg shadow-[0_4px_24px_rgba(0,0,0,0.3)] ${imageClassName}`.trim()}
            style={
              naturalSize
                ? {
                    width: `${renderedWidth}px`,
                    height: `${renderedHeight}px`,
                  }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
};
