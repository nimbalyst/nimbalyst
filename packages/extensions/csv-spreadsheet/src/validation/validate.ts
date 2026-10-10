/**
 * Check values against data validation rules and look up the rule for a cell.
 */

import { isNumericCellValue, parseNumber, parseTemporalStrict } from '../utils/formatters';
import { localCalendarDate } from '../utils/calendarDate';
import { parseRangeKey, rangeContains, type RangeBounds } from '../conditional/rangeKeys';
import type {
  CheckboxValidationRule,
  ListOption,
  ValidationResult,
  ValidationRule,
  ValidationRules,
} from './types';

const VALID: ValidationResult = { valid: true };

/** A number as typed, allowing `$1,200`, `(5)` and `50%`; rejects `12abc`. */
function strictNumber(value: string): number | null {
  const bare = value.replace(/^\((.*)\)$/, '$1').replace(/[$€£¥\s]/g, '');
  return isNumericCellValue(bare) ? parseNumber(value) : null;
}

function localDay(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** An ISO `YYYY-MM-DD` date as a local calendar day, or null when it is not a real date. */
export function isoDay(text: string | undefined): number | null {
  const match = text ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim()) : null;
  return match ? localCalendarDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]))?.getTime() ?? null : null;
}

function describeBounds(min: string | number | undefined, max: string | number | undefined): string {
  if (min !== undefined && max !== undefined) return `between ${min} and ${max}`;
  if (min !== undefined) return `at least ${min}`;
  if (max !== undefined) return `at most ${max}`;
  return 'any value';
}

function inBounds(value: number, min: number | null | undefined, max: number | null | undefined): boolean {
  return (min === undefined || min === null || value >= min) && (max === undefined || max === null || value <= max);
}

function checkboxValues(rule: CheckboxValidationRule): { checked: string; unchecked: string; custom: boolean } {
  const custom = rule.checkedValue !== undefined || rule.uncheckedValue !== undefined;
  return { checked: rule.checkedValue ?? 'TRUE', unchecked: rule.uncheckedValue ?? 'FALSE', custom };
}

function sameCheckboxValue(rule: CheckboxValidationRule, value: string, target: string): boolean {
  return checkboxValues(rule).custom ? value.trim() === target : value.trim().toUpperCase() === target;
}

/** Whether `value` is the rule's checked value. */
export function isCheckboxChecked(rule: CheckboxValidationRule, value: string): boolean {
  return sameCheckboxValue(rule, value, checkboxValues(rule).checked);
}

/** The value to write when the checkbox is set to `checked`. */
export function checkboxValueFor(rule: CheckboxValidationRule, checked: boolean): string {
  const values = checkboxValues(rule);
  return checked ? values.checked : values.unchecked;
}

function invalid(rule: ValidationRule, generated: string): ValidationResult {
  return { valid: false, message: rule.message ?? generated };
}

/** Check one value. Blank values are always valid. */
export function validateCellValue(rule: ValidationRule, value: string): ValidationResult {
  const text = value.trim();
  if (text === '') return VALID;

  switch (rule.kind) {
    case 'list':
      return rule.options.some((option) => option.value.trim() === text)
        ? VALID
        : invalid(rule, `Choose one of: ${rule.options.map((option) => option.value).join(', ')}.`);

    case 'checkbox': {
      const { checked, unchecked } = checkboxValues(rule);
      return sameCheckboxValue(rule, text, checked) || sameCheckboxValue(rule, text, unchecked)
        ? VALID
        : invalid(rule, `Enter ${checked} or ${unchecked}.`);
    }

    case 'numberRange': {
      const number = strictNumber(text);
      const noun = rule.integerOnly ? 'a whole number' : 'a number';
      const inverted = rule.operator === 'notBetween';
      const expectation = `${noun} ${inverted ? 'not ' : ''}${describeBounds(rule.min, rule.max)}`;
      if (number === null || (rule.integerOnly && !Number.isInteger(number))) {
        return invalid(rule, `Enter ${expectation}.`);
      }
      const inside = inBounds(number, rule.min, rule.max);
      return inside !== inverted ? VALID : invalid(rule, `Enter ${expectation}.`);
    }

    case 'dateRange': {
      const date = parseTemporalStrict(text);
      const expectation = `a date ${describeBounds(rule.min, rule.max)}`;
      if (!date) return invalid(rule, `Enter ${expectation}.`);
      return inBounds(localDay(date.getTime()), isoDay(rule.min), isoDay(rule.max))
        ? VALID
        : invalid(rule, `Enter ${expectation}.`);
    }

    case 'textLength':
      return inBounds(text.length, rule.min, rule.max)
        ? VALID
        : invalid(rule, `Enter text ${describeBounds(rule.min, rule.max)} characters long.`);
  }
}

interface CompiledRule {
  key: string;
  bounds: RangeBounds;
  rule: ValidationRule;
}

const compiledCache = new WeakMap<ValidationRules, CompiledRule[]>();

/** Parsed once per rules object (metadata is replaced, not mutated, on change). */
function compile(rules: ValidationRules): CompiledRule[] {
  let compiled = compiledCache.get(rules);
  if (!compiled) {
    compiled = [];
    for (const [key, rule] of Object.entries(rules)) {
      const bounds = parseRangeKey(key);
      if (bounds) compiled.push({ key, bounds, rule });
    }
    compiled.reverse();
    compiledCache.set(rules, compiled);
  }
  return compiled;
}

/** The rule governing a cell, with its range key; the later entry wins on overlap. */
export function findValidationRule(
  rules: ValidationRules | undefined,
  row: number,
  col: number,
): { key: string; rule: ValidationRule } | null {
  if (!rules) return null;
  for (const entry of compile(rules)) {
    if (rangeContains(entry.bounds, row, col)) return { key: entry.key, rule: entry.rule };
  }
  return null;
}

/** Dropdown options for a cell, or null when it has no list rule. */
export function listOptionsForCell(
  rules: ValidationRules | undefined,
  row: number,
  col: number,
): ListOption[] | null {
  const found = findValidationRule(rules, row, col);
  return found?.rule.kind === 'list' ? found.rule.options : null;
}
