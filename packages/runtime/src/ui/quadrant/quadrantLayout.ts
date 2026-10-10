/**
 * Pixel layout for the 2x2: where the plot sits, how the axis captions wrap,
 * and which side of its dot each point label goes on so labels stay inside
 * the chart and off each other. Pure; text width comes from `measure`.
 */

import { quadrantFraction, quadrantRange, type QuadrantLabels, type QuadrantPoint } from '../../core/quadrantModel';

export type MeasureText = (text: string, fontSize: number, bold?: boolean) => number;

export const QUADRANT_FONT = 14;
export const QUADRANT_PINNED_FONT = 15;
/** Line height, and the drop from a label box's top to its text baseline. */
export const QUADRANT_LINE = Math.round(QUADRANT_FONT * 1.3);
export const QUADRANT_BASELINE = Math.round(QUADRANT_LINE * 0.78);
const LINE = QUADRANT_LINE;
const DOT_GAP = 7;
const EDGE = 4;

export interface Rect { x: number; y: number; w: number; h: number }

export interface PlacedLabel {
  point: QuadrantPoint;
  cx: number;
  cy: number;
  /** Text anchor point and alignment. */
  tx: number;
  ty: number;
  anchor: 'start' | 'middle' | 'end';
  text: string;
  /** A line from the dot to a label that had to sit away from it. */
  leader?: { x1: number; y1: number; x2: number; y2: number };
}

export interface QuadrantLayout {
  plot: Rect;
  xLines: string[];
  yLines: string[];
  corners: { text: string; x: number; y: number; anchor: 'start' | 'end' }[];
  points: PlacedLabel[];
}

/** Rough width when no canvas is available (tests, headless). */
export const estimateTextWidth: MeasureText = (text, fontSize, bold) => text.length * fontSize * (bold ? 0.6 : 0.56);

/** Cuts `text` with an ellipsis until it fits `max`. */
export function fitText(text: string, max: number, fontSize: number, measure: MeasureText, bold?: boolean): string {
  if (measure(text, fontSize, bold) <= max) return text;
  let end = text.length;
  while (end > 1 && measure(`${text.slice(0, end).trimEnd()}...`, fontSize, bold) > max) end -= 1;
  return `${text.slice(0, end).trimEnd()}...`;
}

/** One line if it fits, else two lines split at the most balanced space, each cut to fit. */
export function wrapCaption(text: string, max: number, fontSize: number, measure: MeasureText): string[] {
  if (measure(text, fontSize) <= max) return [text];
  const words = text.split(' ');
  let best: [string, string] | null = null;
  let bestWidth = Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const pair: [string, string] = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const width = Math.max(measure(pair[0], fontSize), measure(pair[1], fontSize));
    if (width < bestWidth) { best = pair; bestWidth = width; }
  }
  if (!best) return [fitText(text, max, fontSize, measure)];
  return best.map((line) => fitText(line, max, fontSize, measure));
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function layoutQuadrant(
  width: number,
  height: number,
  points: readonly QuadrantPoint[],
  labels: QuadrantLabels,
  measure: MeasureText = estimateTextWidth,
): QuadrantLayout {
  // The y caption may take two lines; reserve for what it will need.
  const yProbe = labels.yLabel ? wrapCaption(labels.yLabel, height - 40, QUADRANT_FONT, measure) : [];
  const xProbe = labels.xLabel ? wrapCaption(labels.xLabel, width - 40, QUADRANT_FONT, measure) : [];
  const left = yProbe.length ? 10 + yProbe.length * LINE : EDGE * 2;
  const bottom = xProbe.length ? 10 + xProbe.length * LINE : EDGE * 2;
  const plot: Rect = { x: left, y: EDGE * 2, w: Math.max(40, width - left - EDGE * 2), h: Math.max(40, height - bottom - EDGE * 2) };
  const xLines = labels.xLabel ? wrapCaption(labels.xLabel, plot.w, QUADRANT_FONT, measure) : [];
  const yLines = labels.yLabel ? wrapCaption(labels.yLabel, plot.h, QUADRANT_FONT, measure) : [];

  const cornerMax = plot.w / 2 - 12;
  const cornerSpots = [
    { x: plot.x + 6, y: plot.y + LINE + 1, anchor: 'start' },
    { x: plot.x + plot.w - 6, y: plot.y + LINE + 1, anchor: 'end' },
    { x: plot.x + 6, y: plot.y + plot.h - 7, anchor: 'start' },
    { x: plot.x + plot.w - 6, y: plot.y + plot.h - 7, anchor: 'end' },
  ] as const;
  const taken: Rect[] = [];
  const corners: QuadrantLayout['corners'] = [];
  (labels.quadrants ?? []).slice(0, 4).forEach((raw, index) => {
    if (!raw) return;
    const spot = cornerSpots[index];
    const text = fitText(raw, cornerMax, QUADRANT_FONT, measure);
    const w = measure(text, QUADRANT_FONT);
    taken.push({ x: spot.anchor === 'start' ? spot.x : spot.x - w, y: spot.y - QUADRANT_FONT, w, h: LINE });
    corners.push({ text, x: spot.x, y: spot.y, anchor: spot.anchor });
  });

  const xRange = quadrantRange(points.map((point) => point.x));
  const yRange = quadrantRange(points.map((point) => point.y));
  const dots = points.map((point) => ({
    point,
    cx: plot.x + quadrantFraction(point.x, xRange) * plot.w,
    cy: plot.y + (1 - quadrantFraction(point.y, yRange)) * plot.h,
  }));
  for (const dot of dots) taken.push({ x: dot.cx - 5, y: dot.cy - 5, w: 10, h: 10 });

  // Labels stay right of the y caption and above the x caption.
  const area: Rect = { x: plot.x + 2, y: 2, w: width - plot.x - 4, h: plot.y + plot.h - 2 };
  const clampInto = (box: Rect): Rect => ({
    ...box,
    x: Math.min(Math.max(box.x, area.x), area.x + area.w - box.w),
    y: Math.min(Math.max(box.y, area.y), area.y + area.h - box.h),
  });

  // Every label's possible spots: right of the dot first, then left, above,
  // below, the diagonals, and one line further out for crowded clusters.
  const labelled = dots.map(({ point, cx, cy }) => {
    const font = point.pinned ? QUADRANT_PINNED_FONT : QUADRANT_FONT;
    const text = fitText(point.label, area.w, font, measure, point.pinned);
    const w = measure(text, font, point.pinned);
    const above = cy - 6 - LINE;
    const below = cy + 7;
    const level = cy - LINE / 2;
    // Each spot aligns the text toward the dot, so a width estimate that is
    // off (no font metrics headless) never opens a gap between dot and label.
    const raw: Array<{ box: Rect; anchor: PlacedLabel['anchor'] }> = [
      { box: { x: cx + DOT_GAP, y: level, w, h: LINE }, anchor: 'start' },
      { box: { x: cx - DOT_GAP - w, y: level, w, h: LINE }, anchor: 'end' },
      { box: { x: cx - w / 2, y: above, w, h: LINE }, anchor: 'middle' },
      { box: { x: cx - w / 2, y: below, w, h: LINE }, anchor: 'middle' },
      { box: { x: cx + 2, y: above, w, h: LINE }, anchor: 'start' },
      { box: { x: cx - 2 - w, y: above, w, h: LINE }, anchor: 'end' },
      { box: { x: cx + 2, y: below, w, h: LINE }, anchor: 'start' },
      { box: { x: cx - 2 - w, y: below, w, h: LINE }, anchor: 'end' },
      { box: { x: cx - w / 2, y: above - LINE, w, h: LINE }, anchor: 'middle' },
      { box: { x: cx - w / 2, y: below + LINE, w, h: LINE }, anchor: 'middle' },
    ];
    // Judged where each label will really sit: pushed inside the chart.
    const options = raw.map((candidate, index) => {
      const box = clampInto(candidate.box);
      const drift = Math.abs(box.x - candidate.box.x) + Math.abs(box.y - candidate.box.y);
      return { box, anchor: candidate.anchor, bias: drift * 2 + index * 2 };
    });
    return { point, cx, cy, text, options, choice: 0 };
  });

  const costOf = (index: number, box: Rect): number => {
    let collisions = taken.reduce((sum, other) => sum + overlap(box, other), 0);
    labelled.forEach((other, otherIndex) => {
      if (otherIndex !== index) collisions += overlap(box, other.options[other.choice].box);
    });
    return collisions * 10;
  };
  const pick = (index: number) => {
    const label = labelled[index];
    let bestCost = Infinity;
    label.options.forEach((option, optionIndex) => {
      const cost = costOf(index, option.box) + option.bias;
      if (cost < bestCost) { bestCost = cost; label.choice = optionIndex; }
    });
  };

  // Greedy first (pinned points choose first so the highlighted label gets the
  // best spot), then a few passes where each label moves given all the others.
  const order = labelled.map((_, index) => index)
    .sort((a, b) => Number(labelled[b].point.pinned) - Number(labelled[a].point.pinned));
  const placedSoFar = new Set<number>();
  for (const index of order) {
    const label = labelled[index];
    let bestCost = Infinity;
    label.options.forEach((option, optionIndex) => {
      let collisions = taken.reduce((sum, other) => sum + overlap(option.box, other), 0);
      placedSoFar.forEach((other) => { collisions += overlap(option.box, labelled[other].options[labelled[other].choice].box); });
      const cost = collisions * 10 + option.bias;
      if (cost < bestCost) { bestCost = cost; label.choice = optionIndex; }
    });
    placedSoFar.add(index);
  }
  for (let pass = 0; pass < 4; pass += 1) for (const index of order) pick(index);

  const placed = labelled.map(({ point, cx, cy, text, options, choice }): PlacedLabel => {
    const { box, anchor } = options[choice];
    const tx = anchor === 'start' ? box.x : anchor === 'end' ? box.x + box.w : box.x + box.w / 2;
    // Nearest point of the label box to the dot; far enough away earns a leader.
    const nx = Math.min(Math.max(cx, box.x), box.x + box.w);
    const ny = Math.min(Math.max(cy, box.y), box.y + box.h);
    const gap = Math.hypot(nx - cx, ny - cy);
    const leader = gap > DOT_GAP + 6
      ? { x1: cx + ((nx - cx) / gap) * 5, y1: cy + ((ny - cy) / gap) * 5, x2: nx, y2: ny }
      : undefined;
    return { point, cx, cy, tx, ty: box.y + QUADRANT_BASELINE, anchor, text, ...(leader ? { leader } : {}) };
  });

  return { plot, xLines, yLines, corners, points: placed };
}
