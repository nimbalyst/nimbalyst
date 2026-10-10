/**
 * Validation at the moment of entry, and the rule edits the validation dialog
 * makes. Pure, so the reject/warn decision is testable without a grid.
 *
 * `reject` refuses a typed value: the command is not run and the user sees
 * the rule's message. `warn` lets it through; the cell then carries the red
 * corner marker `cellProperties` paints for any invalid value.
 */

import type { NormalizedSelectionRange } from '../types';
import { parseRangeKey, rangeKeyOf } from '../cells/cellStyles';
import { removeRange } from '../cells/rangeMath';
import { checkboxValueFor, findValidationRule, isCheckboxChecked, validateCellValue } from './validate';
import type { ValidationRule, ValidationRules } from './types';

export interface Rejection {
  row: number;
  col: number;
  message: string;
}

/** The first typed write a `reject` rule refuses, or null when every write may go in. */
export function rejectedEntry(
  rules: ValidationRules,
  writes: readonly { row: number; col: number; value: string }[],
): Rejection | null {
  for (const write of writes) {
    const rule = findValidationRule(rules, write.row, write.col)?.rule;
    if (!rule || rule.mode !== 'reject') continue;
    const result = validateCellValue(rule, write.value);
    if (!result.valid) return { row: write.row, col: write.col, message: result.message ?? 'Invalid value' };
  }
  return null;
}

/**
 * Space / click on checkbox cells: when any selected checkbox is unchecked
 * they all become checked, otherwise they all clear (as in Sheets).
 */
export function toggleCheckboxes(
  rules: ValidationRules,
  cells: readonly { row: number; col: number; value: string }[],
): { row: number; col: number; value: string }[] {
  const boxes = cells.flatMap((cell) => {
    const rule = findValidationRule(rules, cell.row, cell.col)?.rule;
    return rule?.kind === 'checkbox' ? [{ ...cell, rule }] : [];
  });
  const check = boxes.some(({ rule, value }) => !isCheckboxChecked(rule, value));
  return boxes.map(({ row, col, rule }) => ({ row, col, value: checkboxValueFor(rule, check) }));
}

function covers(outer: NormalizedSelectionRange, key: string): boolean {
  const bounds = parseRangeKey(key);
  return !!bounds && bounds.startRow >= outer.startRow && bounds.endRow <= outer.endRow
    && bounds.startCol >= outer.startCol && bounds.endCol <= outer.endCol;
}

/**
 * Set the rule for a selection, replacing rules it covers entirely. With null,
 * remove validation from the selection: rules it overlaps are cut around it and
 * keep the rest of their range.
 */
export function setValidationRule(
  rules: ValidationRules,
  range: NormalizedSelectionRange,
  rule: ValidationRule | null,
): ValidationRules {
  if (!rule) return removeRange(rules, range);
  const next: ValidationRules = {};
  for (const [key, existing] of Object.entries(rules)) {
    if (!covers(range, key)) next[key] = existing;
  }
  next[rangeKeyOf(range)] = rule;
  return next;
}

/** Parse the dialog's one-option-per-line list text, dropping blanks and duplicates. */
export function parseListOptions(text: string): string[] {
  return [...new Set(text.split(/\r?\n|,/).map((line) => line.trim()).filter((line) => line !== ''))];
}
