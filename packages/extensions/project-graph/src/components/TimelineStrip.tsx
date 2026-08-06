import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ProjectGraphNode } from '../types';

export interface TimelineStripProps {
  nodes: ReadonlyArray<ProjectGraphNode>;
  /** Min/max createdAt across all dated nodes. */
  range: { min: number; max: number };
  /** Current playhead in epoch ms. */
  currentTime: number;
  onChange: (t: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  /** Speed in ms-of-history per real second. */
  speed: number;
  onSpeedChange: (speed: number) => void;
}

const HISTOGRAM_BUCKETS = 120;

interface Bucket {
  /** Inclusive lower bound in epoch ms. */
  start: number;
  /** New-node count in this bucket. */
  count: number;
  /** Bug closures in this bucket. */
  closes: number;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function speedLabel(msPerSec: number): string {
  // Express in human units: "12h/sec", "3d/sec", "2w/sec".
  const second = 1000;
  const minute = 60 * second;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (msPerSec >= week) return `${(msPerSec / week).toFixed(1)}w/s`;
  if (msPerSec >= day) return `${(msPerSec / day).toFixed(1)}d/s`;
  if (msPerSec >= hour) return `${(msPerSec / hour).toFixed(1)}h/s`;
  if (msPerSec >= minute) return `${(msPerSec / minute).toFixed(0)}m/s`;
  return `${(msPerSec / second).toFixed(0)}s/s`;
}

export function TimelineStrip(props: TimelineStripProps) {
  const { nodes, range, currentTime, onChange, playing, onTogglePlay, speed, onSpeedChange } = props;

  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // Bucket new nodes + bug closures into a fixed-width histogram. Recomputes
  // when nodes or range change; this is the hot path for large snapshots so
  // keep the loop tight.
  const buckets = useMemo<Bucket[]>(() => {
    const arr: Bucket[] = new Array(HISTOGRAM_BUCKETS);
    for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
      arr[i] = { start: range.min + (i / HISTOGRAM_BUCKETS) * (range.max - range.min), count: 0, closes: 0 };
    }
    const span = range.max - range.min;
    if (span <= 0) return arr;
    for (const n of nodes) {
      if (n.createdAt != null) {
        const idx = Math.min(HISTOGRAM_BUCKETS - 1, Math.max(0, Math.floor(((n.createdAt - range.min) / span) * HISTOGRAM_BUCKETS)));
        arr[idx]!.count++;
      }
      if (n.closedAt != null && n.closedAt >= range.min && n.closedAt <= range.max) {
        const idx = Math.min(HISTOGRAM_BUCKETS - 1, Math.max(0, Math.floor(((n.closedAt - range.min) / span) * HISTOGRAM_BUCKETS)));
        arr[idx]!.closes++;
      }
    }
    return arr;
  }, [nodes, range.min, range.max]);

  const maxBucketCount = useMemo(() => {
    let max = 0;
    for (const b of buckets) {
      const total = b.count + b.closes;
      if (total > max) max = total;
    }
    return max;
  }, [buckets]);

  const progressPct = useMemo(() => {
    const span = range.max - range.min;
    if (span <= 0) return 100;
    const pct = ((currentTime - range.min) / span) * 100;
    return Math.max(0, Math.min(100, pct));
  }, [currentTime, range.min, range.max]);

  const handlePointer = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onChange(range.min + ratio * (range.max - range.min));
  }, [onChange, range.min, range.max]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    handlePointer(e.clientX);
  }, [handlePointer]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    handlePointer(e.clientX);
  }, [handlePointer]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  // Tick labels: 5 evenly spaced.
  const ticks = useMemo(() => {
    const span = range.max - range.min;
    if (span <= 0) return [];
    return [0, 0.25, 0.5, 0.75, 1].map(r => ({ pct: r * 100, label: formatDate(range.min + r * span) }));
  }, [range.min, range.max]);

  // Wheel on the track shifts time backward/forward by 2% per notch.
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const span = range.max - range.min;
    const step = (e.deltaY > 0 ? 1 : -1) * span * 0.02;
    onChange(Math.max(range.min, Math.min(range.max, currentTime + step)));
  }, [currentTime, range.min, range.max, onChange]);

  // Keyboard: when timeline has focus, arrow keys nudge.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ae = document.activeElement;
      if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return;
      if (e.key === ' ' && (ae as HTMLElement | null)?.closest?.('.pg-timeline')) {
        e.preventDefault();
        onTogglePlay();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onTogglePlay]);

  return (
    <div className="pg-timeline" tabIndex={0}>
      <button
        type="button"
        className="pg-timeline-play"
        onClick={onTogglePlay}
        title={playing ? 'Pause (space)' : 'Play (space)'}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14"><rect x="3" y="2" width="3" height="10" fill="currentColor" /><rect x="8" y="2" width="3" height="10" fill="currentColor" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 1.5 L12 7 L3 12.5 Z" fill="currentColor" /></svg>
        )}
      </button>

      <div
        className="pg-timeline-track"
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        role="slider"
        aria-valuemin={range.min}
        aria-valuemax={range.max}
        aria-valuenow={currentTime}
        aria-label="Project history timeline"
      >
        <div className="pg-timeline-histogram" aria-hidden="true">
          {buckets.map((b, i) => {
            const total = b.count + b.closes;
            const h = maxBucketCount === 0 ? 0 : (total / maxBucketCount) * 100;
            const createH = maxBucketCount === 0 ? 0 : (b.count / maxBucketCount) * 100;
            return (
              <div key={i} className="pg-timeline-bar" style={{ height: `${h}%` }}>
                <div className="pg-timeline-bar-create" style={{ height: `${createH}%` }} />
                <div className="pg-timeline-bar-close" style={{ height: `${h - createH}%` }} />
              </div>
            );
          })}
        </div>

        <div className="pg-timeline-fill" style={{ width: `${progressPct}%` }} />

        <div className="pg-timeline-playhead" style={{ left: `${progressPct}%` }} aria-hidden="true">
          <div className="pg-timeline-playhead-flag">{formatDateTime(currentTime)}</div>
        </div>

        <div className="pg-timeline-ticks" aria-hidden="true">
          {ticks.map((t, i) => (
            <div key={i} className="pg-timeline-tick" style={{ left: `${t.pct}%` }}>
              <span>{t.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="pg-timeline-controls">
        <select
          className="pg-timeline-speed"
          value={speed}
          onChange={e => onSpeedChange(Number(e.target.value))}
          title="Playback speed"
        >
          {[
            { v: 60 * 60 * 1000, l: '1h/s' },
            { v: 6 * 60 * 60 * 1000, l: '6h/s' },
            { v: 24 * 60 * 60 * 1000, l: '1d/s' },
            { v: 3 * 24 * 60 * 60 * 1000, l: '3d/s' },
            { v: 7 * 24 * 60 * 60 * 1000, l: '1w/s' },
            { v: (range.max - range.min) / 60, l: 'Fit 60s' },
          ].map(opt => (
            <option key={opt.l} value={opt.v}>{opt.l}</option>
          ))}
        </select>
        <button
          type="button"
          className="pg-timeline-now"
          onClick={() => onChange(range.max)}
          title="Snap to latest"
        >
          Now
        </button>
      </div>
      <div className="pg-timeline-speed-readout" title="Current speed">{speedLabel(speed)}</div>
    </div>
  );
}
