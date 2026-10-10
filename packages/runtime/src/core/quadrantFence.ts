/**
 * The static 2x2 block's markdown: a fenced block anyone can write by hand.
 *
 *   ```2x2
 *   x: Marketer-first, closed -> Developer-first, open
 *   y: Batch -> Realtime decisioning
 *   quadrants: Enterprise suites | Opportunity | Guidance | Dev-first
 *   width: 640
 *   height: 420
 *   - Salesforce: 0.15, 0.85
 *   - UserCurrent: 0.85, 0.9 !
 *   ```
 *
 * Quadrants are top-left, top-right, bottom-left, bottom-right. A trailing `!`
 * draws the point highlighted. `width` and `height` are the drawing's size in
 * px, set by dragging the selected block's handles; no `width` fills the column. The node keeps the body text verbatim, so the
 * markdown round-trips exactly and a line this parser skips is not lost.
 */

import { quadrantNumber, type QuadrantLabels, type QuadrantPoint } from './quadrantModel';

// The fence language and the inserted default live in QuadrantNodeCore. Do not
// re-export them here: this parser is imported by the Electron main process
// (share export), which must not reach the Lexical node graph.

export interface ParsedQuadrantFence {
  labels: QuadrantLabels;
  points: QuadrantPoint[];
  /** Point lines without two numbers. */
  skipped: number;
  /** Drawing size in px, when the body sets one. */
  width?: number;
  height?: number;
}

export const MIN_QUADRANT_WIDTH = 240;
export const MIN_QUADRANT_HEIGHT = 200;
export const MAX_QUADRANT_HEIGHT = 1200;

/**
 * The body with its `width:` / `height:` lines set (added before the points
 * if missing). A null removes the line: no width fills the column, no height
 * uses the default.
 */
export function setQuadrantFenceSize(body: string, size: { width: number | null; height: number | null }): string {
  let lines = body.split('\n');
  const put = (key: 'width' | 'height', value: number | null) => {
    const re = new RegExp(`^\\s*${key}\\s*:`, 'i');
    const existing = lines.findIndex((raw) => re.test(raw));
    if (value === null) {
      if (existing >= 0) lines = lines.filter((_, index) => index !== existing);
      return;
    }
    const line = `${key}: ${Math.round(value)}`;
    if (existing >= 0) {
      lines[existing] = line;
      return;
    }
    const firstPoint = lines.findIndex((raw) => raw.trim().startsWith('-'));
    lines.splice(firstPoint >= 0 ? firstPoint : lines.length, 0, line);
  };
  put('width', size.width);
  put('height', size.height);
  return lines.join('\n');
}

const POINT_RE = /^-\s+(.+):\s*([^,]+),\s*(\S+?)\s*(!)?\s*$/;

export function parseQuadrantFence(body: string): ParsedQuadrantFence {
  const labels: QuadrantLabels = {};
  const points: QuadrantPoint[] = [];
  let skipped = 0;
  let width: number | undefined;
  let height: number | undefined;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('-')) {
      const match = POINT_RE.exec(line);
      const x = match ? quadrantNumber(match[2]) : null;
      const y = match ? quadrantNumber(match[3]) : null;
      if (!match || x === null || y === null) {
        skipped += 1;
        continue;
      }
      points.push({ id: `p${points.length}`, label: match[1].trim(), x, y, pinned: match[4] === '!' });
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'x') labels.xLabel = value;
    else if (key === 'y') labels.yLabel = value;
    else if (key === 'quadrants') labels.quadrants = value.split('|').map((part) => part.trim());
    else if (key === 'width') {
      const parsed = quadrantNumber(value);
      if (parsed !== null) width = Math.max(MIN_QUADRANT_WIDTH, parsed);
    } else if (key === 'height') {
      const parsed = quadrantNumber(value);
      if (parsed !== null) height = Math.min(MAX_QUADRANT_HEIGHT, Math.max(MIN_QUADRANT_HEIGHT, parsed));
    }
  }
  return {
    labels,
    points,
    skipped,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}
