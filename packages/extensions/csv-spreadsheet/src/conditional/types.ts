/**
 * Conditional formatting rules, as stored in sheet metadata.
 *
 * A format applies one rule to one or more A1 range keys (see `rangeKeys.ts`).
 * Formats are ordered: for any cell, the first format whose rule matches wins,
 * whether it is a discrete rule or a color scale. This is the Sheets model.
 */

import type { CellColor, ColumnType, HexColor } from '../types';

/** `#rrggbb`. Color scales interpolate in this space. */
export type { HexColor };

/**
 * Discrete rules may use the theme palette (readable in both themes) or a raw
 * hex color. Color scales always produce hex.
 */
export type ConditionalColor = CellColor | HexColor;

export interface ConditionalStylePatch {
  textColor?: ConditionalColor;
  fillColor?: ConditionalColor;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
}

export type CompareOperator = '>' | '>=' | '<' | '<=' | '=' | '!=';

/**
 * Compares the cell against `value`. Numeric when both sides are numbers;
 * otherwise `=` / `!=` compare text case-insensitively and the ordered
 * operators never match. `between` / `notBetween` use `value` and `value2`
 * inclusively, in either order. Blank cells never match a value rule.
 */
export interface ValueCompareRule {
  kind: 'valueCompare';
  operator: CompareOperator | 'between' | 'notBetween';
  value: number | string;
  value2?: number | string;
}

/** Case-insensitive match on the displayed text. */
export interface TextRule {
  kind: 'textContains' | 'textNotContains' | 'textStartsWith' | 'textEndsWith';
  value: string;
}

/** Blank means the raw value is empty or whitespace. */
export interface EmptinessRule {
  kind: 'isEmpty' | 'notEmpty';
}

export type RelativeDate = 'today' | 'yesterday' | 'tomorrow' | 'pastWeek' | 'pastMonth' | 'pastYear';

/**
 * Calendar-day comparison in local time. `pastWeek` is the seven days before
 * today plus today; `pastMonth` / `pastYear` go back one calendar month / year
 * from today, inclusive. `on` / `before` / `after` take an ISO `YYYY-MM-DD`.
 */
export type DateRule =
  | { kind: 'dateIs'; when: RelativeDate }
  | { kind: 'dateIs'; when: 'on' | 'before' | 'after'; date: string };

/**
 * Stored so files round-trip, but not evaluated: it never matches, and the
 * evaluator reports it in `skipped` with `CUSTOM_FORMULA_NOTE`.
 */
export interface CustomFormulaRule {
  kind: 'customFormula';
  formula: string;
}

/**
 * Where a color-scale stop sits. `min` / `max` are the range's own extremes;
 * `number` is a literal; `percent` is a fraction of the way from min to max
 * (0-100); `percentile` is PERCENTILE.INC over the range's numeric cells (0-100).
 */
export interface ColorScalePoint {
  type: 'min' | 'max' | 'number' | 'percent' | 'percentile';
  value?: number;
  color: HexColor;
}

/**
 * Fills numeric cells with a color interpolated between two or three stops.
 * Non-numeric and blank cells are left alone (and do not count as a match, so a
 * later format can still style them). Statistics come from every numeric cell
 * in the format's ranges, not just the visible ones.
 */
export interface ColorScaleRule {
  kind: 'colorScale';
  min: ColorScalePoint;
  mid?: ColorScalePoint;
  max: ColorScalePoint;
}

export type DiscreteConditionalRule =
  | ValueCompareRule
  | TextRule
  | EmptinessRule
  | DateRule
  | CustomFormulaRule;

export type ConditionalRule = DiscreteConditionalRule | ColorScaleRule;

export interface ConditionalFormat {
  id: string;
  /** A1 range keys, e.g. `['B2:B100', 'D2:D100']`. */
  ranges: string[];
  rule: ConditionalRule;
  /** Applied when a discrete rule matches. Ignored for color scales. */
  style?: ConditionalStylePatch;
}

/**
 * What the evaluator needs to know about a cell. `numeric` is the computed
 * number when there is one (formulas included); when absent the evaluator
 * falls back to parsing `raw`. `date` is epoch milliseconds for temporal
 * values; when absent dates are parsed from `display` then `raw`.
 */
export interface ConditionalCellSnapshot {
  raw: string;
  display: string;
  numeric?: number | null;
  date?: number | null;
  type?: ColumnType;
}

export type GetConditionalCell = (row: number, col: number) => ConditionalCellSnapshot | null | undefined;

export const CUSTOM_FORMULA_NOTE = 'Custom formula rules are saved with the file but are not evaluated yet, so they never apply a style.';
