/**
 * Evaluate conditional formats for the visible part of the grid.
 *
 * Cost is O(visible cells x formats) per call, plus one pass over each color
 * scale's ranges to find min/max (and a sort only when a stop is a
 * percentile). That pass lives in `prepareConditionalFormats` so a renderer can
 * keep the result while the data is unchanged and re-run only the cheap part on
 * scroll.
 */

import type { NormalizedSelectionRange } from '../types';
import { isNumericCellValue, parseNumber, parseTemporalStrict } from '../utils/formatters';
import { localCalendarDate } from '../utils/calendarDate';
import { cellKey, intersectRanges, parseRangeKey, type RangeBounds } from './rangeKeys';
import {
  CUSTOM_FORMULA_NOTE,
  type ColorScalePoint,
  type ColorScaleRule,
  type ConditionalCellSnapshot,
  type ConditionalFormat,
  type ConditionalStylePatch,
  type DateRule,
  type DiscreteConditionalRule,
  type GetConditionalCell,
  type HexColor,
  type ValueCompareRule,
} from './types';

export interface ConditionalExtent {
  rowCount: number;
  colCount: number;
}

export interface SkippedFormat {
  id: string;
  reason: string;
}

type Rgb = [number, number, number];

interface ResolvedStop {
  value: number;
  rgb: Rgb;
}

interface PreparedFormat {
  format: ConditionalFormat;
  bounds: RangeBounds[];
  /** Color scales only; null when the ranges hold no numbers. */
  stops?: ResolvedStop[] | null;
}

export interface PreparedConditionalFormats {
  formats: PreparedFormat[];
  skipped: SkippedFormat[];
}

export interface ConditionalEvaluation {
  /** Keyed by `cellKey(row, col)`. Cells with no applicable format are absent. */
  styles: Map<string, ConditionalStylePatch>;
  /** Formats that were not evaluated, with a user-facing reason. */
  skipped: SkippedFormat[];
}

// ---------------------------------------------------------------------------
// Cell coercion

function cellNumber(cell: ConditionalCellSnapshot): number | null {
  if (typeof cell.numeric === 'number') return Number.isFinite(cell.numeric) ? cell.numeric : null;
  return isNumericCellValue(cell.raw) ? parseNumber(cell.raw) : null;
}

function ruleNumber(value: number | string | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return value !== undefined && isNumericCellValue(value) ? parseNumber(value) : null;
}

/** A formula that evaluates to an empty string counts as blank, as in Sheets. */
function isBlank(cell: ConditionalCellSnapshot): boolean {
  const raw = cell.raw.trim();
  return raw === '' || (raw.startsWith('=') && cell.display.trim() === '');
}

function cellDate(cell: ConditionalCellSnapshot): number | null {
  if (typeof cell.date === 'number') return Number.isFinite(cell.date) ? cell.date : null;
  const parsed = parseTemporalStrict(cell.display) ?? parseTemporalStrict(cell.raw);
  return parsed ? parsed.getTime() : null;
}

function startOfDay(ms: number): Date {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day;
}

function parseIsoDay(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return null;
  return localCalendarDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]))?.getTime() ?? null;
}

// ---------------------------------------------------------------------------
// Discrete rules

function matchesValueCompare(rule: ValueCompareRule, cell: ConditionalCellSnapshot): boolean {
  if (isBlank(cell)) return false;
  const actual = cellNumber(cell);
  const expected = ruleNumber(rule.value);

  if (rule.operator === 'between' || rule.operator === 'notBetween') {
    const other = ruleNumber(rule.value2);
    if (actual === null || expected === null || other === null) return false;
    const inside = actual >= Math.min(expected, other) && actual <= Math.max(expected, other);
    return rule.operator === 'between' ? inside : !inside;
  }

  if (actual !== null && expected !== null) {
    switch (rule.operator) {
      case '>': return actual > expected;
      case '>=': return actual >= expected;
      case '<': return actual < expected;
      case '<=': return actual <= expected;
      case '=': return actual === expected;
      case '!=': return actual !== expected;
    }
  }
  if (rule.operator !== '=' && rule.operator !== '!=') return false;
  const equal = cell.display.trim().toLowerCase() === String(rule.value).trim().toLowerCase();
  return rule.operator === '=' ? equal : !equal;
}

function matchesDate(rule: DateRule, cell: ConditionalCellSnapshot, now: number): boolean {
  const value = cellDate(cell);
  if (value === null) return false;
  const day = startOfDay(value).getTime();
  const today = startOfDay(now);

  const shifted = (apply: (date: Date) => void): number => {
    const copy = new Date(today);
    apply(copy);
    return copy.getTime();
  };

  switch (rule.when) {
    case 'today': return day === today.getTime();
    case 'yesterday': return day === shifted((d) => d.setDate(d.getDate() - 1));
    case 'tomorrow': return day === shifted((d) => d.setDate(d.getDate() + 1));
    case 'pastWeek': return day >= shifted((d) => d.setDate(d.getDate() - 7)) && day <= today.getTime();
    case 'pastMonth': return day >= shifted((d) => d.setMonth(d.getMonth() - 1)) && day <= today.getTime();
    case 'pastYear': return day >= shifted((d) => d.setFullYear(d.getFullYear() - 1)) && day <= today.getTime();
    case 'on':
    case 'before':
    case 'after': {
      const target = parseIsoDay(rule.date);
      if (target === null) return false;
      if (rule.when === 'on') return day === target;
      return rule.when === 'before' ? day < target : day > target;
    }
  }
}

/** Whether a discrete rule matches one cell. `now` is epoch ms for date rules. */
export function matchesDiscreteRule(
  rule: DiscreteConditionalRule,
  cell: ConditionalCellSnapshot,
  now: number = Date.now(),
): boolean {
  switch (rule.kind) {
    case 'valueCompare':
      return matchesValueCompare(rule, cell);
    case 'textContains':
    case 'textNotContains':
    case 'textStartsWith':
    case 'textEndsWith': {
      const text = cell.display.toLowerCase();
      const needle = rule.value.toLowerCase();
      if (rule.kind === 'textContains') return text.includes(needle);
      if (rule.kind === 'textNotContains') return !text.includes(needle);
      if (rule.kind === 'textStartsWith') return text.startsWith(needle);
      return text.endsWith(needle);
    }
    case 'isEmpty':
      return isBlank(cell);
    case 'notEmpty':
      return !isBlank(cell);
    case 'dateIs':
      return matchesDate(rule, cell, now);
    case 'customFormula':
      return false;
  }
}

// ---------------------------------------------------------------------------
// Color scales

function parseHex(color: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function toHex(rgb: Rgb): HexColor {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** PERCENTILE.INC over ascending `sorted`. */
function percentile(sorted: Float64Array, p: number): number {
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

interface ScaleStats {
  min: number;
  max: number;
  sorted: Float64Array | null;
}

function collectScaleStats(
  rule: ColorScaleRule,
  bounds: readonly RangeBounds[],
  getCell: GetConditionalCell,
): ScaleStats | null {
  const needsSorted = [rule.min, rule.mid, rule.max].some((point) => point?.type === 'percentile');
  const values: number[] = [];
  let min = Infinity;
  let max = -Infinity;
  // Overlapping ranges must not count a cell twice, but the common case is one
  // range, so only pay for the set when there is more than one.
  const seen = bounds.length > 1 ? new Set<string>() : null;

  for (const range of bounds) {
    for (let row = range.startRow; row <= range.endRow; row++) {
      for (let col = range.startCol; col <= range.endCol; col++) {
        if (seen) {
          const key = cellKey(row, col);
          if (seen.has(key)) continue;
          seen.add(key);
        }
        const cell = getCell(row, col);
        if (!cell) continue;
        const value = cellNumber(cell);
        if (value === null) continue;
        if (value < min) min = value;
        if (value > max) max = value;
        if (needsSorted) values.push(value);
      }
    }
  }
  if (min === Infinity) return null;
  return { min, max, sorted: needsSorted ? Float64Array.from(values).sort() : null };
}

function resolvePoint(point: ColorScalePoint, stats: ScaleStats): number {
  switch (point.type) {
    case 'min': return stats.min;
    case 'max': return stats.max;
    case 'number': return point.value ?? 0;
    case 'percent': return stats.min + (stats.max - stats.min) * ((point.value ?? 0) / 100);
    case 'percentile': return percentile(stats.sorted!, point.value ?? 0);
  }
}

/** Interpolated hex for `value` against resolved stops (ascending). */
function colorAt(stops: readonly ResolvedStop[], value: number): HexColor {
  if (value <= stops[0].value) return toHex(stops[0].rgb);
  for (let i = 1; i < stops.length; i++) {
    const low = stops[i - 1];
    const high = stops[i];
    if (value > high.value) continue;
    const span = high.value - low.value;
    const t = span === 0 ? 1 : (value - low.value) / span;
    return toHex([0, 1, 2].map((c) => low.rgb[c] + (high.rgb[c] - low.rgb[c]) * t) as Rgb);
  }
  return toHex(stops[stops.length - 1].rgb);
}

// ---------------------------------------------------------------------------
// Prepare + evaluate

function clampToExtent(bounds: RangeBounds, extent: ConditionalExtent | undefined): RangeBounds | null {
  if (!extent) return bounds;
  return intersectRanges(bounds, {
    startRow: 0,
    startCol: 0,
    endRow: extent.rowCount - 1,
    endCol: extent.colCount - 1,
  });
}

/**
 * Parse every format's ranges and compute color-scale stops. Keep the result
 * while the data and formats are unchanged; pass it back to
 * `evaluateConditionalFormats` on each repaint. `extent` clamps whole-column
 * style ranges (`A1:A1048576`) to the data so stats do not walk empty rows.
 */
export function prepareConditionalFormats(
  formats: readonly ConditionalFormat[],
  getCell: GetConditionalCell,
  extent?: ConditionalExtent,
): PreparedConditionalFormats {
  const prepared: PreparedFormat[] = [];
  const skipped: SkippedFormat[] = [];

  for (const format of formats) {
    if (format.rule.kind === 'customFormula') {
      skipped.push({ id: format.id, reason: CUSTOM_FORMULA_NOTE });
      continue;
    }
    const bounds: RangeBounds[] = [];
    for (const key of format.ranges) {
      const parsed = parseRangeKey(key);
      const clamped = parsed && clampToExtent(parsed, extent);
      if (clamped) bounds.push(clamped);
    }
    if (format.rule.kind !== 'colorScale') {
      prepared.push({ format, bounds });
      continue;
    }

    const rule = format.rule;
    const points = rule.mid ? [rule.min, rule.mid, rule.max] : [rule.min, rule.max];
    const colors = points.map((point) => parseHex(point.color));
    if (colors.some((rgb) => rgb === null)) {
      skipped.push({ id: format.id, reason: 'A color scale stop has an invalid color.' });
      continue;
    }
    const stats = collectScaleStats(rule, bounds, getCell);
    const stops = stats
      ? points
        .map((point, i) => ({ value: resolvePoint(point, stats), rgb: colors[i]! }))
        .sort((a, b) => a.value - b.value)
      : null;
    prepared.push({ format, bounds, stops });
  }
  return { formats: prepared, skipped };
}

/**
 * Style patches for every cell in `visible` that a format applies to.
 *
 * Formats are tried in order and the first that applies to a cell wins. A
 * discrete rule applies when it matches (even with an empty style, which then
 * blocks later formats, as in Sheets); a color scale applies to numeric cells.
 *
 * `prepared` must come from the same `formats` and data; when omitted it is
 * computed here, which re-walks every color scale's ranges.
 */
export function evaluateConditionalFormats(
  formats: readonly ConditionalFormat[],
  getCell: GetConditionalCell,
  visible: NormalizedSelectionRange,
  options: { now?: number; prepared?: PreparedConditionalFormats; extent?: ConditionalExtent } = {},
): ConditionalEvaluation {
  const prepared = options.prepared ?? prepareConditionalFormats(formats, getCell, options.extent);
  const now = options.now ?? Date.now();
  const styles = new Map<string, ConditionalStylePatch>();
  const claimed = new Set<string>();

  for (const { format, bounds, stops } of prepared.formats) {
    const rule = format.rule;
    if (rule.kind === 'colorScale' && !stops) continue;
    const style = format.style ?? {};
    const hasStyle = Object.keys(style).length > 0;

    for (const range of bounds) {
      const area = intersectRanges(range, visible);
      if (!area) continue;
      for (let row = area.startRow; row <= area.endRow; row++) {
        for (let col = area.startCol; col <= area.endCol; col++) {
          const key = cellKey(row, col);
          if (claimed.has(key)) continue;
          const cell = getCell(row, col) ?? { raw: '', display: '' };

          if (rule.kind === 'colorScale') {
            const value = cellNumber(cell);
            if (value === null) continue;
            claimed.add(key);
            styles.set(key, { fillColor: colorAt(stops!, value) });
            continue;
          }
          if (!matchesDiscreteRule(rule, cell, now)) continue;
          claimed.add(key);
          if (hasStyle) styles.set(key, style);
        }
      }
    }
  }
  return { styles, skipped: prepared.skipped };
}
