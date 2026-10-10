// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { QuadrantPoint } from '../../../core/quadrantModel';
import { estimateTextWidth, layoutQuadrant, QUADRANT_BASELINE, QUADRANT_FONT, QUADRANT_LINE, type Rect } from '../quadrantLayout';

const point = (label: string, x: number, y: number): QuadrantPoint => ({ id: label, label, x, y, pinned: false });

function labelBox(placed: ReturnType<typeof layoutQuadrant>['points'][number]): Rect {
  const w = estimateTextWidth(placed.text, QUADRANT_FONT);
  const x = placed.anchor === 'start' ? placed.tx : placed.anchor === 'end' ? placed.tx - w : placed.tx - w / 2;
  return { x, y: placed.ty - QUADRANT_BASELINE, w, h: QUADRANT_LINE };
}

describe('2x2 layout', () => {
  it('keeps labels and captions inside the chart and off each other', () => {
    const width = 520;
    const layout = layoutQuadrant(width, 360, [
      point('Salesforce Personalization', 0.15, 0.88),
      point('Adobe Target and AJO', 0.1, 0.84),
      point('Dynamic Yield', 0.2, 0.8),
      point('Cloudflare Flagship', 0.75, 0.1),
      point('LaunchDarkly', 0.6, 0.3),
      point('PostHog', 0.9, 0.29),
    ], {
      xLabel: 'Marketer-first, closed -> Developer-first, open',
      yLabel: 'Batch or attribute targeting -> Realtime behavioral decisioning at scale',
    });

    const boxes = layout.points.map(labelBox);
    for (const box of boxes) {
      // Right of the y caption, inside the right edge.
      expect(box.x).toBeGreaterThanOrEqual(layout.plot.x);
      expect(box.x + box.w).toBeLessThanOrEqual(width);
    }
    const overlaps = (a: Rect, b: Rect) =>
      Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(overlaps(boxes[i], boxes[j]), `${layout.points[i].text} / ${layout.points[j].text}`).toBe(false);
      }
    }

    // Too long for the plot's height: wrapped onto two lines, nothing dropped.
    expect(layout.yLines).toHaveLength(2);
    expect(layout.yLines.join(' ')).toBe('Batch or attribute targeting -> Realtime behavioral decisioning at scale');
    for (const line of layout.yLines) expect(estimateTextWidth(line, QUADRANT_FONT)).toBeLessThanOrEqual(layout.plot.h);
  });
});
