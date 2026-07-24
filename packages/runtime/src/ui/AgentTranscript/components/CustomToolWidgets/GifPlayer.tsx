/**
 * GIF Player component with play/pause and frame scrubbing controls.
 *
 * Uses gifuct-js to decode GIF frames and renders them onto a canvas,
 * giving full control over playback.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { parseGIF, decompressFrames } from 'gifuct-js';

interface GifPlayerProps {
  /** GIF data as a data URI (data:image/gif;base64,...) or file:// URL */
  src: string;
  /** Alt text for accessibility */
  alt?: string;
  /** Additional CSS class for the container */
  className?: string;
}

interface DecodedFrame {
  imageData: ImageData;
  delay: number; // in ms
}

/**
 * Decode a GIF from an ArrayBuffer into an array of full-composite frames.
 */
function decodeGif(buffer: ArrayBuffer, canvas: HTMLCanvasElement): DecodedFrame[] {
  const gif = parseGIF(buffer);
  const frames = decompressFrames(gif, true);

  if (frames.length === 0) return [];

  const { width, height } = gif.lsd;
  canvas.width = width;
  canvas.height = height;

  // Compositing canvas - accumulates the visible frame
  const compCanvas = document.createElement('canvas');
  compCanvas.width = width;
  compCanvas.height = height;
  const compCtx = compCanvas.getContext('2d')!;

  // Patch canvas - holds the current frame's patch for alpha-correct compositing
  const patchCanvas = document.createElement('canvas');
  const patchCtx = patchCanvas.getContext('2d')!;

  const decoded: DecodedFrame[] = [];

  for (const frame of frames) {
    const { dims, patch, disposalType } = frame;

    // Save compositing canvas state before drawing (for disposal type 3)
    let previousState: ImageData | null = null;
    if (disposalType === 3) {
      previousState = compCtx.getImageData(0, 0, width, height);
    }

    // Render the frame patch onto a temporary canvas
    patchCanvas.width = dims.width;
    patchCanvas.height = dims.height;
    const patchData = new ImageData(
      new Uint8ClampedArray(patch),
      dims.width,
      dims.height
    );
    patchCtx.putImageData(patchData, 0, 0);

    // Composite the patch onto the main canvas using drawImage
    // (respects alpha, unlike putImageData which overwrites)
    compCtx.drawImage(patchCanvas, dims.left, dims.top);

    // Snapshot the composited frame
    const composited = compCtx.getImageData(0, 0, width, height);
    decoded.push({
      imageData: composited,
      delay: Math.max(frame.delay * 10, 20), // gifuct delay is in 1/100s; minimum 20ms
    });

    // Handle disposal method for next frame
    if (disposalType === 2) {
      // Restore to background - clear the frame area
      compCtx.clearRect(dims.left, dims.top, dims.width, dims.height);
    } else if (disposalType === 3 && previousState) {
      // Restore to previous state
      compCtx.putImageData(previousState, 0, 0);
    }
    // disposalType 0 or 1: leave in place (do nothing)
  }

  return decoded;
}

export const GifPlayer: React.FC<GifPlayerProps> = ({ src, alt, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frames, setFrames] = useState<DecodedFrame[]>([]);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const accumulatorRef = useRef<number>(0);

  // Decode the GIF
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        let buffer: ArrayBuffer;

        if (src.startsWith('data:')) {
          // Data URI - extract base64 and decode
          const base64 = src.split(',')[1];
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          buffer = bytes.buffer;
        } else {
          // File URL or path - fetch it
          const response = await fetch(src);
          buffer = await response.arrayBuffer();
        }

        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        const decoded = decodeGif(buffer, canvas);
        if (decoded.length === 0) {
          setError('No frames found in GIF');
          setLoading(false);
          return;
        }

        setFrames(decoded);
        setCurrentFrame(0);
        setLoading(false);

        // Draw first frame
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.putImageData(decoded[0].imageData, 0, 0);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to decode GIF');
          setLoading(false);
        }
      }
    };

    load();
    return () => { cancelled = true; };
  }, [src]);

  // Animation loop
  useEffect(() => {
    if (!isPlaying || frames.length <= 1) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    lastTimeRef.current = performance.now();
    accumulatorRef.current = 0;

    let frameIndex = currentFrame;

    const tick = (now: number) => {
      const delta = now - lastTimeRef.current;
      lastTimeRef.current = now;
      accumulatorRef.current += delta;

      const frameDelay = frames[frameIndex].delay;
      if (accumulatorRef.current >= frameDelay) {
        accumulatorRef.current -= frameDelay;
        frameIndex = (frameIndex + 1) % frames.length;
        ctx.putImageData(frames[frameIndex].imageData, 0, 0);
        setCurrentFrame(frameIndex);
      }

      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, frames]);

  // Draw frame when scrubbing (not playing)
  const drawFrame = useCallback((index: number) => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const clampedIndex = Math.max(0, Math.min(index, frames.length - 1));
    ctx.putImageData(frames[clampedIndex].imageData, 0, 0);
    setCurrentFrame(clampedIndex);
  }, [frames]);

  const togglePlayPause = useCallback(() => {
    setIsPlaying(prev => !prev);
  }, []);

  const handleScrub = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const index = parseInt(e.target.value, 10);
    setIsPlaying(false);
    drawFrame(index);
  }, [drawFrame]);

  // Calculate total duration and current time for display
  const totalDuration = frames.reduce((sum, f) => sum + f.delay, 0);
  const currentTime = frames.slice(0, currentFrame).reduce((sum, f) => sum + f.delay, 0);

  const formatTime = (ms: number) => {
    const seconds = ms / 1000;
    return seconds.toFixed(1) + 's';
  };

  if (error) {
    return null; // Let the parent fall back to regular img tag
  }

  return (
    <div className={`gif-player flex flex-col ${className || ''}`}>
      <canvas
        ref={canvasRef}
        className="max-w-full h-auto block"
        role="img"
        aria-label={alt || 'Animated GIF'}
        style={{ display: loading ? 'none' : 'block' }}
      />
      {loading && (
        <div className="flex items-center justify-center p-4 bg-nim-secondary rounded-md border border-nim">
          <span className="text-nim-muted text-sm">Decoding GIF...</span>
        </div>
      )}
      {!loading && frames.length > 1 && (
        <div
          className="flex items-center gap-2 px-2 py-1.5 bg-nim-secondary rounded-b-md border border-t-0 border-nim"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={togglePlayPause}
            className="flex items-center justify-center w-6 h-6 rounded text-nim-muted hover:text-nim hover:bg-nim-hover transition-colors shrink-0"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <rect x="2" y="1" width="3" height="10" rx="0.5" />
                <rect x="7" y="1" width="3" height="10" rx="0.5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <path d="M2.5 1.5 L10.5 6 L2.5 10.5 Z" />
              </svg>
            )}
          </button>
          <input
            type="range"
            min={0}
            max={frames.length - 1}
            value={currentFrame}
            onChange={handleScrub}
            className="flex-1 h-1 accent-[var(--nim-primary)] cursor-pointer"
            aria-label="GIF frame position"
          />
          <span className="text-[10px] text-nim-faint font-mono tabular-nums shrink-0 min-w-[4.5rem] text-right">
            {formatTime(currentTime)} / {formatTime(totalDuration)}
          </span>
        </div>
      )}
    </div>
  );
};
