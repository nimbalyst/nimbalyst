/**
 * Data validation rules, stored in sheet metadata keyed by A1 range
 * (`B2:B100`), the same way `cellStyles` is. Where ranges overlap, the later
 * entry wins.
 *
 * Blank cells are always valid, as in Sheets: validation constrains what is
 * entered, not whether something is.
 */

import type { CellColor } from '../types';

/** `reject` refuses the edit; `warn` keeps it and marks the cell. */
export type ValidationMode = 'reject' | 'warn';

interface ValidationRuleBase {
  mode: ValidationMode;
  /** Shown instead of the generated message when the value is invalid. */
  message?: string;
}

export interface ListOption {
  value: string;
  /** Chip color in the cell and dropdown. */
  color?: CellColor;
}

/** Value must equal one of `options` (trimmed, case-sensitive). */
export interface ListValidationRule extends ValidationRuleBase {
  kind: 'list';
  options: ListOption[];
}

/**
 * Cell renders as a checkbox. Only the two values are valid; they default to
 * `TRUE` / `FALSE`, which match case-insensitively. Custom values match exactly.
 */
export interface CheckboxValidationRule extends ValidationRuleBase {
  kind: 'checkbox';
  checkedValue?: string;
  uncheckedValue?: string;
}

/** Inclusive bounds; either may be omitted. `notBetween` inverts the check. */
export interface NumberRangeValidationRule extends ValidationRuleBase {
  kind: 'numberRange';
  min?: number;
  max?: number;
  operator?: 'between' | 'notBetween';
  integerOnly?: boolean;
}

/** Inclusive ISO `YYYY-MM-DD` bounds compared by local calendar day. */
export interface DateRangeValidationRule extends ValidationRuleBase {
  kind: 'dateRange';
  min?: string;
  max?: string;
}

/** Inclusive bounds on the character count of the trimmed value. */
export interface TextLengthValidationRule extends ValidationRuleBase {
  kind: 'textLength';
  min?: number;
  max?: number;
}

export type ValidationRule =
  | ListValidationRule
  | CheckboxValidationRule
  | NumberRangeValidationRule
  | DateRangeValidationRule
  | TextLengthValidationRule;

/** Rules keyed by A1 range key. Later entries win where ranges overlap. */
export type ValidationRules = Record<string, ValidationRule>;

export interface ValidationResult {
  valid: boolean;
  /** Present only when `valid` is false. */
  message?: string;
}
