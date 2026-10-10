/**
 * `set_validation`: data validation rules on an A1 range, as one `setMeta`
 * command (one undo step). The rule is checked in full before anything is
 * written; null removes validation from the range and keeps it on the rest of
 * any wider rule the range cuts through.
 */

import type { ExtensionAITool } from '@nimbalyst/extension-sdk';
import type { CellColor } from '../types';
import type { ListOption, ValidationRule } from '../validation/types';
import { setValidationRule } from '../validation/entry';
import { isoDay, validateCellValue } from '../validation/validate';
import { parseRangeKey } from '../cells/cellStyles';
import { overlaps } from '../cells/rangeMath';
import { cellName, parseA1Range, rangeName, resolveRange, type CellBounds } from './a1';
import { MAX_TOOL_CELLS, clipText, flashWritten, usedSize, withAgent } from './toolSupport';

const KINDS = ['list', 'checkbox', 'numberRange', 'dateRange', 'textLength'] as const;
const LIST_COLORS: readonly CellColor[] = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
const MAX_LIST_OPTIONS = 500;
const MAX_TEXT = 500;
const MAX_INVALID_LISTED = 10;

/** Fields each kind accepts, beyond `kind`, `mode` and `message`. */
const KIND_FIELDS: Record<typeof KINDS[number], readonly string[]> = {
  list: ['options'],
  checkbox: ['checkedValue', 'uncheckedValue'],
  numberRange: ['min', 'max', 'operator', 'integerOnly'],
  dateRange: ['min', 'max'],
  textLength: ['min', 'max'],
};

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT) {
    throw new Error(`${name} must be non-empty text of at most ${MAX_TEXT} characters`);
  }
  return value;
}

function bounds<T>(rule: Record<string, unknown>, check: (value: unknown) => value is T, expected: string, order: (value: T) => number): void {
  for (const key of ['min', 'max']) {
    if (rule[key] !== undefined && !check(rule[key])) throw new Error(`rule.${key} must be ${expected}; got ${JSON.stringify(rule[key])}`);
  }
  if (rule.min === undefined && rule.max === undefined) throw new Error('rule needs min, max or both');
  if (rule.min !== undefined && rule.max !== undefined && order(rule.min as T) > order(rule.max as T)) {
    throw new Error('rule.min must not be greater than rule.max');
  }
}

function listOptions(value: unknown): ListOption[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_OPTIONS) {
    throw new Error(`rule.options must be a list of 1 to ${MAX_LIST_OPTIONS} options`);
  }
  const options = value.map((option, i): ListOption => {
    if (typeof option === 'string') return { value: text(option, `rule.options[${i}]`).trim() };
    if (typeof option !== 'object' || option === null) throw new Error(`rule.options[${i}] must be text or { value, color }`);
    const { value: optionValue, color, ...rest } = option as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new Error(`rule.options[${i}].${Object.keys(rest)[0]} is not a known field; use value, color`);
    if (color !== undefined && !LIST_COLORS.includes(color as CellColor)) {
      throw new Error(`rule.options[${i}].color must be ${LIST_COLORS.join(', ')}`);
    }
    return { value: text(optionValue, `rule.options[${i}].value`).trim(), ...(color ? { color: color as CellColor } : {}) };
  });
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.value)) throw new Error(`rule.options lists "${option.value}" twice`);
    seen.add(option.value);
  }
  return options;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isLength = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isIsoDate = (value: unknown): value is string => typeof value === 'string' && isoDay(value) !== null;

/** Check a rule object in full and return it in stored form. */
export function parseValidationRule(value: unknown): ValidationRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('rule must be an object or null');
  const rule = value as Record<string, unknown>;
  const kind = rule.kind as typeof KINDS[number];
  if (!KINDS.includes(kind)) throw new Error(`rule.kind must be ${KINDS.join(', ')}; got ${JSON.stringify(rule.kind)}`);
  const allowed = new Set(['kind', 'mode', 'message', ...KIND_FIELDS[kind]]);
  for (const key of Object.keys(rule)) {
    if (!allowed.has(key)) throw new Error(`rule.${key} is not a known field for ${kind}; use ${[...allowed].join(', ')}`);
  }
  const mode = rule.mode ?? 'warn';
  if (mode !== 'reject' && mode !== 'warn') throw new Error('rule.mode must be reject or warn');
  const base = { mode, ...(rule.message !== undefined ? { message: text(rule.message, 'rule.message') } : {}) } as const;

  switch (kind) {
    case 'list':
      return { kind, ...base, options: listOptions(rule.options) };
    case 'checkbox': {
      const checkedValue = rule.checkedValue === undefined ? undefined : text(rule.checkedValue, 'rule.checkedValue');
      const uncheckedValue = rule.uncheckedValue === undefined ? undefined : text(rule.uncheckedValue, 'rule.uncheckedValue');
      if (checkedValue !== undefined && checkedValue === uncheckedValue) throw new Error('rule.checkedValue and rule.uncheckedValue must differ');
      return { kind, ...base, ...(checkedValue !== undefined ? { checkedValue } : {}), ...(uncheckedValue !== undefined ? { uncheckedValue } : {}) };
    }
    case 'numberRange': {
      bounds(rule, isNumber, 'a finite number', (n) => n);
      if (rule.operator !== undefined && rule.operator !== 'between' && rule.operator !== 'notBetween') {
        throw new Error('rule.operator must be between or notBetween');
      }
      if (rule.integerOnly !== undefined && typeof rule.integerOnly !== 'boolean') throw new Error('rule.integerOnly must be true or false');
      const { kind: _kind, mode: _mode, message: _message, ...fields } = rule;
      return { kind, ...base, ...fields } as ValidationRule;
    }
    case 'dateRange':
    case 'textLength': {
      if (kind === 'dateRange') bounds(rule, isIsoDate, 'a real date as YYYY-MM-DD', (d) => isoDay(d) ?? 0);
      else bounds(rule, isLength, 'a whole number of characters, 0 or more', (n) => n);
      return {
        kind, ...base,
        ...(rule.min !== undefined ? { min: rule.min } : {}),
        ...(rule.max !== undefined ? { max: rule.max } : {}),
      } as ValidationRule;
    }
  }
}

/** Validation entries that touch `bounds`, in precedence order (later wins), for read tools. */
export function validationIn(rules: Readonly<Record<string, ValidationRule>>, bounds: CellBounds, limit = 50) {
  const touching = Object.entries(rules).filter(([key]) => {
    const range = parseRangeKey(key);
    return range !== null && overlaps(range, bounds);
  });
  return {
    validation: touching.slice(0, limit).map(([range, rule]) => ({ range, rule })),
    validationTruncated: touching.length > limit,
  };
}

const setValidationTool: ExtensionAITool = {
  name: 'csv-spreadsheet.set_validation',
  scope: 'global',
  access: { kind: 'editor-write' },
  description: 'Set data validation on an A1 range, or remove it with rule null. kind: list (options: text or { value, color }; cells show a dropdown), checkbox (optional checkedValue / uncheckedValue, default TRUE / FALSE), numberRange (min, max, operator between|notBetween, integerOnly), dateRange (min, max as YYYY-MM-DD), textLength (min, max characters). mode: reject refuses invalid entries, warn (default) keeps them and marks the cell. Optional message replaces the generated one. A new rule replaces rules entirely inside the range and wins where it overlaps others; removing cuts the range out of wider rules. Blank cells are always valid. Stored values are never changed; the result counts existing values the rule would flag. One undo step.',
  inputSchema: {
    type: 'object',
    properties: {
      range: { type: 'string', description: 'A1 range, e.g. "C2:C200" or "D:D".' },
      rule: { type: 'object', description: `Rule object with kind (${KINDS.join(', ')}), optional mode and message, and the kind's fields; null removes validation from the range.` },
    },
    required: ['range', 'rule'],
  },
  handler: (params, context) => withAgent(context, async (agent) => {
    if (params.rule === undefined) throw new Error('rule is required; pass null to remove validation');
    const requested = parseA1Range(params.range);
    const rule = params.rule === null ? null : parseValidationRule(params.rule);

    let target: CellBounds | null = null;
    let flashCells: { row: number; column: number }[] = [];
    const invalid: { cell: string; raw: unknown; message: string }[] = [];
    let invalidCount = 0;
    const result = await agent.run(({ state }) => {
      const used = usedSize(state);
      const bounds = resolveRange(requested, used.rows, used.cols);
      const cellCount = (bounds.endRow - bounds.startRow + 1) * (bounds.endCol - bounds.startCol + 1);
      if (cellCount > MAX_TOOL_CELLS * 100) throw new Error(`range covers ${cellCount} cells; validate at most ${MAX_TOOL_CELLS * 100} per call`);
      target = bounds;
      flashCells = [];
      invalid.length = 0;
      invalidCount = 0;
      for (let row = bounds.startRow; row <= bounds.endRow && flashCells.length < MAX_TOOL_CELLS; row += 1) {
        for (let col = bounds.startCol; col <= bounds.endCol; col += 1) {
          flashCells.push({ row, column: col });
          const raw = state.rows[row]?.[col] ?? '';
          const check = rule ? validateCellValue(rule, raw) : { valid: true };
          if (check.valid) continue;
          invalidCount += 1;
          if (invalid.length < MAX_INVALID_LISTED) invalid.push({ cell: cellName(row, col), raw: clipText(raw), message: check.message ?? 'Invalid value' });
        }
      }
      return { type: 'setMeta', patch: { validation: setValidationRule(state.meta.validation, bounds, rule) } };
    });

    if (result.changed) await flashWritten(agent, flashCells);
    return {
      changed: result.changed,
      range: target ? rangeName(target) : null,
      rule,
      ...(rule ? { existingCellsChecked: flashCells.length, existingInvalidCount: invalidCount, existingInvalid: invalid } : {}),
    };
  }),
};

export const validationTools: ExtensionAITool[] = [setValidationTool];
