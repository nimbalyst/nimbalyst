/**
 * The 2x2 as a static SVG string, for places with no React or DOM (shared
 * links are rendered to HTML in the main process). Same layout as
 * `QuadrantChart`; colors are CSS classes the host page styles.
 */

import type { QuadrantLabels, QuadrantPoint } from '../../core/quadrantModel';
import { estimateTextWidth, layoutQuadrant, QUADRANT_FONT, QUADRANT_LINE, QUADRANT_PINNED_FONT, type MeasureText } from './quadrantLayout';

export const QUADRANT_SVG_WIDTH = 720;
export const QUADRANT_SVG_HEIGHT = 360;

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function quadrantSvgMarkup(
  points: readonly QuadrantPoint[],
  labels: QuadrantLabels,
  size: { width?: number; height?: number } = {},
  measure: MeasureText = estimateTextWidth,
): string {
  const width = size.width ?? QUADRANT_SVG_WIDTH;
  const height = size.height ?? QUADRANT_SVG_HEIGHT;
  const layout = layoutQuadrant(width, height, points, labels, measure);
  const { plot } = layout;
  const yCenter = plot.y + plot.h / 2;
  const parts: string[] = [];
  parts.push(`<line class="q-grid" x1="${plot.x + plot.w / 2}" y1="${plot.y}" x2="${plot.x + plot.w / 2}" y2="${plot.y + plot.h}"/>`);
  parts.push(`<line class="q-grid" x1="${plot.x}" y1="${yCenter}" x2="${plot.x + plot.w}" y2="${yCenter}"/>`);
  parts.push(`<rect class="q-grid" x="${plot.x}" y="${plot.y}" width="${plot.w}" height="${plot.h}" fill="none"/>`);
  layout.corners.forEach((corner, index) => {
    parts.push(`<text class="q-corner q-corner-${index}" x="${corner.x}" y="${corner.y}" font-size="${QUADRANT_FONT}" text-anchor="${corner.anchor}">${escapeXml(corner.text)}</text>`);
  });
  for (const { point, cx, cy, tx, ty, anchor, text, leader } of layout.points) {
    const cls = point.pinned ? 'q-point q-pinned' : 'q-point';
    const font = point.pinned ? QUADRANT_PINNED_FONT : QUADRANT_FONT;
    parts.push(
      `<g class="${cls}"><title>${escapeXml(`${point.label} (${point.x}, ${point.y})`)}</title>`
      + (leader ? `<line class="q-leader" x1="${leader.x1}" y1="${leader.y1}" x2="${leader.x2}" y2="${leader.y2}"/>` : '')
      + `<circle cx="${cx}" cy="${cy}" r="${point.pinned ? 5 : 3.5}"/>`
      + `<text x="${tx}" y="${ty}" font-size="${font}"${point.pinned ? ' font-weight="600"' : ''} text-anchor="${anchor}">${escapeXml(text)}</text></g>`,
    );
  }
  if (layout.xLines.length) {
    const x = plot.x + plot.w / 2;
    const spans = layout.xLines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : QUADRANT_LINE}">${escapeXml(line)}</tspan>`).join('');
    parts.push(`<text class="q-caption" x="${x}" y="${plot.y + plot.h + QUADRANT_LINE + 5}" font-size="${QUADRANT_FONT}" text-anchor="middle">${spans}</text>`);
  }
  if (layout.yLines.length) {
    const x = plot.x - 8 - (layout.yLines.length - 1) * QUADRANT_LINE;
    const spans = layout.yLines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : QUADRANT_LINE}">${escapeXml(line)}</tspan>`).join('');
    parts.push(`<text class="q-caption" x="${x}" y="${yCenter}" font-size="${QUADRANT_FONT}" text-anchor="middle" transform="rotate(-90 ${x} ${yCenter})">${spans}</text>`);
  }
  const label = escapeXml([labels.yLabel, labels.xLabel].filter(Boolean).join(' by ') || '2x2 chart');
  return `<svg class="quadrant-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-label="${label}">${parts.join('')}</svg>`;
}
