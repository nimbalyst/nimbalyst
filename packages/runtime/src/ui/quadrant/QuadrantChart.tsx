/**
 * The 2x2 drawing, shared by the static fenced block and the query view.
 * Drawn at its frame's real pixel size so text stays at a fixed size (a
 * scaled viewBox blew labels up on wide pages). The frame fills its
 * container's width and takes `height`. Label placement lives in
 * `quadrantLayout.ts`. Colors come from `--nim-*` variables so it follows
 * the theme.
 */

import React, { useLayoutEffect, useMemo, useRef, useState, type JSX, type MutableRefObject } from 'react';

import type { QuadrantLabels, QuadrantPoint } from '../../core/quadrantModel';
import {
  estimateTextWidth,
  layoutQuadrant,
  QUADRANT_FONT,
  QUADRANT_LINE as LINE,
  QUADRANT_PINNED_FONT,
  type MeasureText,
} from './quadrantLayout';

export const DEFAULT_QUADRANT_HEIGHT = 360;
const FALLBACK_WIDTH = 640;
/** Top-left, top-right, bottom-left, bottom-right, as in the mockup. */
const QUADRANT_COLORS = ['var(--nim-purple)', 'var(--nim-success)', 'var(--nim-warning)', 'var(--nim-primary)'];

export interface QuadrantChartProps extends QuadrantLabels {
  points: readonly QuadrantPoint[];
  /** Drawing height in px; the width follows the container. */
  height?: number;
  /** The sized frame, for a container that measures it. */
  frameRef?: MutableRefObject<HTMLDivElement | null>;
  /** Opens an item's page when a query point is clicked. */
  onOpenPoint?: (id: string) => void;
}

let canvasContext: CanvasRenderingContext2D | null | undefined;
const measureText: MeasureText = (text, fontSize, bold) => {
  if (canvasContext === undefined) {
    try {
      canvasContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    } catch {
      canvasContext = null;
    }
  }
  if (!canvasContext) return estimateTextWidth(text, fontSize, bold);
  const family = typeof document === 'undefined' ? 'sans-serif' : getComputedStyle(document.body).fontFamily || 'sans-serif';
  canvasContext.font = `${bold ? 600 : 400} ${fontSize}px ${family}`;
  return canvasContext.measureText(text).width;
};

export function QuadrantChart({
  points, xLabel, yLabel, quadrants, height: frameHeight = DEFAULT_QUADRANT_HEIGHT, frameRef, onOpenPoint,
}: QuadrantChartProps): JSX.Element {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = frameRef ?? ownRef;
  const [{ width, height }, setSize] = useState({ width: FALLBACK_WIDTH, height: frameHeight });
  useLayoutEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const read = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      if (next.width <= 0 || next.height <= 0) return;
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [wrapRef]);

  const layout = useMemo(
    () => layoutQuadrant(width, height, points, { xLabel, yLabel, quadrants }, measureText),
    [width, height, points, xLabel, yLabel, quadrants],
  );
  const { plot } = layout;
  const yCenter = plot.y + plot.h / 2;

  return (
    <div
      ref={wrapRef}
      className="quadrant-chart-frame w-full overflow-hidden"
      style={{ height: `${frameHeight}px` }}
    >
      <svg
        className="quadrant-chart block select-none"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={[yLabel, xLabel].filter(Boolean).join(' by ') || '2x2 chart'}
        data-testid="quadrant-chart"
      >
        <line x1={plot.x + plot.w / 2} y1={plot.y} x2={plot.x + plot.w / 2} y2={plot.y + plot.h} style={{ stroke: 'var(--nim-border)' }} />
        <line x1={plot.x} y1={yCenter} x2={plot.x + plot.w} y2={yCenter} style={{ stroke: 'var(--nim-border)' }} />
        <rect x={plot.x} y={plot.y} width={plot.w} height={plot.h} fill="none" style={{ stroke: 'var(--nim-border)' }} />
        {layout.corners.map((corner, index) => (
          <text key={index} x={corner.x} y={corner.y} fontSize={QUADRANT_FONT} textAnchor={corner.anchor} style={{ fill: QUADRANT_COLORS[index] }}>
            {corner.text}
          </text>
        ))}
        {layout.points.map(({ point, cx, cy, tx, ty, anchor, text, leader }) => {
          const open = !point.pinned && onOpenPoint ? () => onOpenPoint(point.id) : undefined;
          const color = point.pinned ? 'var(--nim-primary)' : 'var(--nim-text-muted)';
          return (
            <g
              key={point.id}
              className={open ? 'quadrant-chart-point cursor-pointer' : 'quadrant-chart-point'}
              data-pinned={point.pinned ? 'true' : undefined}
              onClick={open}
            >
              <title>{`${point.label} (${point.x}, ${point.y})`}</title>
              {leader ? <line x1={leader.x1} y1={leader.y1} x2={leader.x2} y2={leader.y2} style={{ stroke: color, strokeWidth: 1, opacity: 0.5 }} /> : null}
              <circle cx={cx} cy={cy} r={point.pinned ? 5 : 3.5} style={{ fill: color }} />
              <text
                x={tx}
                y={ty}
                fontSize={point.pinned ? QUADRANT_PINNED_FONT : QUADRANT_FONT}
                fontWeight={point.pinned ? 600 : undefined}
                textAnchor={anchor}
                style={{ fill: color }}
              >
                {text}
              </text>
            </g>
          );
        })}
        {layout.xLines.length ? (
          <text x={plot.x + plot.w / 2} y={plot.y + plot.h + LINE + 5} fontSize={QUADRANT_FONT} textAnchor="middle" style={{ fill: 'var(--nim-text-faint)' }}>
            {layout.xLines.map((line, index) => (
              <tspan key={index} x={plot.x + plot.w / 2} dy={index === 0 ? 0 : LINE}>{line}</tspan>
            ))}
          </text>
        ) : null}
        {layout.yLines.length ? (
          <text
            x={plot.x - 8 - (layout.yLines.length - 1) * LINE}
            y={yCenter}
            fontSize={QUADRANT_FONT}
            textAnchor="middle"
            transform={`rotate(-90 ${plot.x - 8 - (layout.yLines.length - 1) * LINE} ${yCenter})`}
            style={{ fill: 'var(--nim-text-faint)' }}
          >
            {layout.yLines.map((line, index) => (
              <tspan key={index} x={plot.x - 8 - (layout.yLines.length - 1) * LINE} dy={index === 0 ? 0 : LINE}>{line}</tspan>
            ))}
          </text>
        ) : null}
      </svg>
    </div>
  );
}
