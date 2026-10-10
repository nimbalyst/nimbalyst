/**
 * `set_format`: column number/date formats and cell-range styles, as one
 * `setMeta` command (one undo step even when both are set).
 */

import type { ExtensionAITool } from '@nimbalyst/extension-sdk';
import type { CellStyle, ColumnFormat } from '../types';
import { applyStyleToRange } from '../cells/cellStyles';
import { columnIndexToLetter } from '../utils/csvParser';
import { parseA1Range, parseColumnLetter, rangeName, resolveRange } from './a1';
import { MAX_TOOL_CELLS, flashWritten, usedSize, withAgent } from './toolSupport';

const COLUMN_TYPES = ['text', 'number', 'currency', 'percentage', 'date', 'datetime', 'time', 'boolean', 'url', 'tracker'];
const COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
const ALIGNMENTS = ['left', 'center', 'right'];
const VERTICAL_ALIGNMENTS = ['top', 'middle', 'bottom'];
const isColor: FieldCheck = (value) => oneOf(COLORS)(value) || (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value));
const COLOR_EXPECTED = `${COLORS.join(', ')} or a #rrggbb hex color`;

type FieldCheck = (value: unknown) => boolean;
const oneOf = (values: readonly string[]): FieldCheck => (value) => typeof value === 'string' && values.includes(value);
const isBoolean: FieldCheck = (value) => typeof value === 'boolean';

const FORMAT_FIELDS: Record<keyof ColumnFormat, { check: FieldCheck; expected: string }> = {
  type: { check: oneOf(COLUMN_TYPES), expected: COLUMN_TYPES.join(', ') },
  decimals: { check: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10, expected: 'an integer from 0 to 10' },
  showThousandsSeparator: { check: isBoolean, expected: 'true or false' },
  currency: { check: oneOf(['USD', 'EUR', 'GBP', 'JPY', 'CNY']), expected: 'USD, EUR, GBP, JPY, CNY' },
  dateFormat: { check: oneOf(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MMM D, YYYY']), expected: 'MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, MMM D, YYYY' },
  timeFormat: { check: oneOf(['h:mm A', 'h:mm:ss A', 'HH:mm', 'HH:mm:ss']), expected: 'h:mm A, h:mm:ss A, HH:mm, HH:mm:ss' },
  pattern: { check: (v) => typeof v === 'string' && v.length > 0 && v.length <= 64, expected: 'a token pattern such as "YYYY-MM-DD HH:mm"' },
  numberStyle: { check: oneOf(['standard', 'plain', 'scientific', 'accounting']), expected: 'standard, plain, scientific, accounting' },
  negativeStyle: { check: oneOf(['minus', 'parens', 'red', 'parens-red']), expected: 'minus, parens, red, parens-red' },
  valuesAreFractions: { check: isBoolean, expected: 'true or false' },
  booleanStyle: { check: oneOf(['true-false', 'yes-no', 'check']), expected: 'true-false, yes-no, check' },
  align: { check: oneOf(ALIGNMENTS), expected: ALIGNMENTS.join(', ') },
};

const STYLE_FIELDS: Record<keyof CellStyle, { check: FieldCheck; expected: string }> = {
  bold: { check: isBoolean, expected: 'true or false' },
  italic: { check: isBoolean, expected: 'true or false' },
  underline: { check: isBoolean, expected: 'true or false' },
  strikethrough: { check: isBoolean, expected: 'true or false' },
  textColor: { check: isColor, expected: COLOR_EXPECTED },
  fillColor: { check: isColor, expected: COLOR_EXPECTED },
  align: { check: (v) => v === null || oneOf(ALIGNMENTS)(v), expected: `${ALIGNMENTS.join(', ')} or null` },
  verticalAlign: { check: oneOf(VERTICAL_ALIGNMENTS), expected: VERTICAL_ALIGNMENTS.join(', ') },
};

function checkFields<T>(name: string, value: unknown, fields: Record<string, { check: FieldCheck; expected: string }>): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error(`${name} sets nothing`);
  for (const [key, field] of entries) {
    const spec = fields[key];
    if (!spec) throw new Error(`${name}.${key} is not a known field; use ${Object.keys(fields).join(', ')}`);
    if (!spec.check(field)) throw new Error(`${name}.${key} must be ${spec.expected}; got ${JSON.stringify(field)}`);
  }
  return value as T;
}

function parseColumns(text: unknown): { start: number; end: number } {
  if (typeof text !== 'string') throw new Error('columns must be a column letter or span such as "C" or "B:D"');
  const [first, last = first] = text.split(':');
  const a = parseColumnLetter(first.trim(), 'columns');
  const b = parseColumnLetter(last.trim(), 'columns');
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

const setFormatTool: ExtensionAITool = {
  name: 'csv-spreadsheet.set_format',
  scope: 'global',
  access: { kind: 'editor-write' },
  description: 'Format columns and style cells. columns + format sets how a column\'s values are typed and displayed (number, currency, percentage, date, time, boolean, url, ...); the format replaces the column\'s existing one and needs a type; format null clears it. range + style layers bold, italic, underline, strikethrough, textColor, fillColor, align and verticalAlign over an A1 range; false or "default" removes a property. Whole-column ranges ("B:B") style the rows used today. Stored values are never changed. Both parts together are one undo step.',
  inputSchema: {
    type: 'object',
    properties: {
      columns: { type: 'string', description: 'Column or span to format, e.g. "C" or "B:D".' },
      format: {
        type: 'object',
        description: `Column format, or null to clear it. type: ${COLUMN_TYPES.join(', ')}. Optional: decimals, showThousandsSeparator, currency, dateFormat, timeFormat, pattern, numberStyle, negativeStyle, valuesAreFractions (percentage), booleanStyle, align.`,
      },
      range: { type: 'string', description: 'A1 range to style, e.g. "A1:F1".' },
      style: { type: 'object', description: `Cell style. Colors: ${COLOR_EXPECTED}. align: ${ALIGNMENTS.join(', ')}. verticalAlign: ${VERTICAL_ALIGNMENTS.join(', ')}.` },
    },
  },
  handler: (params, context) => withAgent(context, async (agent) => {
    const hasFormat = params.columns !== undefined || params.format !== undefined;
    const hasStyle = params.range !== undefined || params.style !== undefined;
    if (!hasFormat && !hasStyle) throw new Error('Pass columns with format, range with style, or both');
    if (hasFormat && (params.columns === undefined || params.format === undefined)) throw new Error('columns and format go together');
    if (hasStyle && (params.range === undefined || params.style === undefined)) throw new Error('range and style go together');

    const columns = hasFormat ? parseColumns(params.columns) : null;
    const format = hasFormat && params.format !== null ? checkFields<ColumnFormat>('format', params.format, FORMAT_FIELDS) : null;
    if (format && format.type === undefined) throw new Error('format.type is required; the format replaces the column\'s existing one');
    const range = hasStyle ? parseA1Range(params.range) : null;
    const style = hasStyle ? { ...checkFields<CellStyle>('style', params.style, STYLE_FIELDS) } : null;
    if (style && (style as { align?: unknown }).align === null) delete (style as { align?: unknown }).align;

    let styledRange: string | null = null;
    let flashCells: { row: number; column: number }[] = [];
    const result = await agent.run(({ state }) => {
      const used = usedSize(state);
      const patch: { columnFormats?: Record<number, ColumnFormat>; cellStyles?: typeof state.meta.cellStyles } = {};
      flashCells = [];
      if (columns) {
        if (columns.end - columns.start + 1 > 1_000) throw new Error('columns spans more than 1000 columns');
        const formats = { ...state.meta.columnFormats };
        for (let col = columns.start; col <= columns.end; col += 1) {
          if (format) formats[col] = { ...format };
          else delete formats[col];
          for (let row = state.meta.headerRowCount; row < used.rows; row += 1) flashCells.push({ row, column: col });
        }
        patch.columnFormats = formats;
      }
      if (range && style) {
        const bounds = resolveRange(range, used.rows, used.cols);
        const cellCount = (bounds.endRow - bounds.startRow + 1) * (bounds.endCol - bounds.startCol + 1);
        if (cellCount > MAX_TOOL_CELLS * 100) throw new Error(`range covers ${cellCount} cells; style at most ${MAX_TOOL_CELLS * 100} per call`);
        styledRange = rangeName(bounds);
        patch.cellStyles = applyStyleToRange(state.meta.cellStyles ?? {}, bounds, style);
        for (let row = bounds.startRow; row <= bounds.endRow && flashCells.length < MAX_TOOL_CELLS; row += 1) {
          for (let col = bounds.startCol; col <= bounds.endCol; col += 1) flashCells.push({ row, column: col });
        }
      }
      return { type: 'setMeta', patch };
    });

    if (result.changed) await flashWritten(agent, flashCells);
    return {
      changed: result.changed,
      ...(columns ? {
        formattedColumns: `${columnIndexToLetter(columns.start)}:${columnIndexToLetter(columns.end)}`,
        format: format ?? null,
      } : {}),
      ...(styledRange ? { styledRange, style } : {}),
    };
  }),
};

export const formatTools: ExtensionAITool[] = [setFormatTool];
