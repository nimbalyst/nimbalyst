// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { shiftValidationRulesForStructuralEdit } from '../shift';
import type { ValidationRule, ValidationRules } from '../types';
import {
  checkboxValueFor,
  findValidationRule,
  isCheckboxChecked,
  listOptionsForCell,
  validateCellValue,
} from '../validate';
import { parseListOptions, rejectedEntry, setValidationRule, toggleCheckboxes } from '../entry';

const valid = (rule: ValidationRule, value: string) => validateCellValue(rule, value).valid;

describe('validateCellValue', () => {
  it('accepts blanks for every rule and uses the custom message when given', () => {
    const rule: ValidationRule = { kind: 'textLength', mode: 'reject', max: 3, message: 'Too long' };
    expect(validateCellValue(rule, '   ')).toEqual({ valid: true });
    expect(validateCellValue(rule, 'abcd')).toEqual({ valid: false, message: 'Too long' });
    expect(validateCellValue({ kind: 'list', mode: 'warn', options: [{ value: 'Open' }, { value: 'Done' }] }, 'open'))
      .toEqual({ valid: false, message: 'Choose one of: Open, Done.' });
  });

  it('checks number ranges strictly, including integer-only and notBetween', () => {
    const range: ValidationRule = { kind: 'numberRange', mode: 'reject', min: 1, max: 1000 };
    expect(valid(range, '$1,000')).toBe(true);
    expect(valid(range, '12abc')).toBe(false);
    expect(valid(range, '(5)')).toBe(false);
    expect(valid({ ...range, integerOnly: true }, '2.5')).toBe(false);
    expect(valid({ ...range, operator: 'notBetween' }, '5000')).toBe(true);
    expect(validateCellValue({ ...range, operator: 'notBetween' }, '5').message).toBe('Enter a number not between 1 and 1000.');
    expect(valid({ kind: 'numberRange', mode: 'warn', min: 0 }, '-1')).toBe(false);
  });

  it('checks dates by calendar day and text length on trimmed text', () => {
    const dates: ValidationRule = { kind: 'dateRange', mode: 'reject', min: '2026-01-01', max: '2026-12-31' };
    expect(valid(dates, '2026-12-31 23:59')).toBe(true);
    expect(valid(dates, '2027-01-01')).toBe(false);
    expect(valid(dates, 'soon')).toBe(false);
    expect(valid({ kind: 'textLength', mode: 'reject', min: 2, max: 3 }, '  ab  ')).toBe(true);
  });

  // R2-5: `new Date(2026, 1, 31)` rolls to March 3, inside the range.
  it('R2-5 rejects dates that do not exist on the calendar', () => {
    const dates: ValidationRule = { kind: 'dateRange', mode: 'reject', min: '2026-01-01', max: '2026-12-31' };
    expect(valid(dates, '2026-02-31')).toBe(false);
    expect(valid(dates, '2/30/2026')).toBe(false);
    expect(valid(dates, '31.4.2026')).toBe(false);
    expect(valid(dates, '2028-02-29')).toBe(false);
    expect(valid({ ...dates, max: '2028-12-31' }, '2028-02-29')).toBe(true);
    // A bound that is not a real day is no bound, rather than a rolled one.
    expect(valid({ kind: 'dateRange', mode: 'reject', max: '2026-02-31' }, '2026-03-02')).toBe(true);
  });

  it('checkboxes accept TRUE/FALSE case-insensitively by default and custom values exactly', () => {
    const plain: ValidationRule = { kind: 'checkbox', mode: 'reject' };
    expect(valid(plain, 'true')).toBe(true);
    expect(valid(plain, 'yes')).toBe(false);
    expect(isCheckboxChecked(plain, 'True')).toBe(true);
    expect(checkboxValueFor(plain, false)).toBe('FALSE');

    const custom = { kind: 'checkbox', mode: 'reject', checkedValue: 'Yes', uncheckedValue: 'No' } as const;
    expect(valid(custom, 'Yes')).toBe(true);
    expect(valid(custom, 'yes')).toBe(false);
    expect(isCheckboxChecked(custom, 'No')).toBe(false);
    expect(checkboxValueFor(custom, true)).toBe('Yes');
  });
});

describe('rule lookup and structural edits', () => {
  const status: ValidationRule = { kind: 'list', mode: 'reject', options: [{ value: 'Open', color: 'green' }] };
  const done: ValidationRule = { kind: 'checkbox', mode: 'reject' };
  const rules: ValidationRules = { 'B2:B100': status, 'B5': done, 'C2:C3': { kind: 'textLength', mode: 'warn', max: 5 } };

  it('finds the later rule on overlap and returns list options only for list rules', () => {
    expect(findValidationRule(rules, 4, 1)).toEqual({ key: 'B5', rule: done });
    expect(findValidationRule(rules, 1, 1)?.key).toBe('B2:B100');
    expect(findValidationRule(rules, 0, 1)).toBeNull();
    expect(listOptionsForCell(rules, 9, 1)).toEqual([{ value: 'Open', color: 'green' }]);
    expect(listOptionsForCell(rules, 4, 1)).toBeNull();
    expect(listOptionsForCell(undefined, 4, 1)).toBeNull();
  });

  it('shifts, shrinks and drops rule ranges, keeping later-wins order', () => {
    expect(shiftValidationRulesForStructuralEdit(rules, { type: 'deleteRows', at: 1, count: 3 })).toEqual({
      'B2:B97': status,
      'B2': done,
    });
    const cols = shiftValidationRulesForStructuralEdit(rules, { type: 'insertCols', at: 0, count: 1 });
    expect(Object.keys(cols)).toEqual(['C2:C100', 'C5', 'D2:D3']);
    expect(findValidationRule(cols, 4, 2)?.rule).toBe(done);
  });
});

describe('validation on entry', () => {
  const rules: ValidationRules = {
    'B2:B10': { kind: 'numberRange', mode: 'reject', min: 0, max: 10 },
    'C2:C10': { kind: 'list', mode: 'warn', options: [{ value: 'Open' }] },
    'D2:D10': { kind: 'checkbox', mode: 'reject' },
  };

  it('refuses a reject-mode value, lets warn-mode values and unruled cells through', () => {
    expect(rejectedEntry(rules, [{ row: 1, col: 1, value: '11' }])).toEqual({ row: 1, col: 1, message: expect.any(String) });
    expect(rejectedEntry(rules, [{ row: 1, col: 1, value: '5' }, { row: 1, col: 2, value: 'Nope' }, { row: 0, col: 1, value: 'x' }])).toBeNull();
  });

  it('toggles a checkbox selection the way Sheets does: any unchecked means check all', () => {
    const cells = [{ row: 1, col: 3, value: 'TRUE' }, { row: 2, col: 3, value: '' }, { row: 1, col: 1, value: '3' }];
    expect(toggleCheckboxes(rules, cells)).toEqual([{ row: 1, col: 3, value: 'TRUE' }, { row: 2, col: 3, value: 'TRUE' }]);
    expect(toggleCheckboxes(rules, [{ row: 1, col: 3, value: 'true' }]).map((c) => c.value)).toEqual(['FALSE']);
  });

  it('replaces rules a new rule covers and keeps the rest; null removes', () => {
    const range = { startRow: 1, endRow: 9, startCol: 2, endCol: 3 };
    const next = setValidationRule(rules, range, { kind: 'textLength', mode: 'warn', max: 5 });
    expect(Object.keys(next)).toEqual(['B2:B10', 'C2:D10']);
    expect(Object.keys(setValidationRule(rules, range, null))).toEqual(['B2:B10']);
    expect(parseListOptions('Open\nDone, Open\n\n')).toEqual(['Open', 'Done']);
  });

  it('R3-4: clearing a subrange removes the rule there and keeps it on the rest of the range', () => {
    const cleared = setValidationRule(rules, { startRow: 4, endRow: 4, startCol: 1, endCol: 1 }, null);
    expect(Object.keys(cleared)).toEqual(['B2:B4', 'B6:B10', 'C2:C10', 'D2:D10']);
    expect(rejectedEntry(cleared, [{ row: 4, col: 1, value: '99' }])).toBeNull();
    expect(rejectedEntry(cleared, [{ row: 3, col: 1, value: '99' }])).not.toBeNull();
  });
});
