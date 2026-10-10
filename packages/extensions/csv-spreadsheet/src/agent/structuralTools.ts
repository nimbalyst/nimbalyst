/**
 * Structural tools: insert and delete rows and columns. Each is one
 * `structural` command, so every formula and the header/frozen/format/style
 * metadata are rewritten the same way the grid's own menu does it, and the
 * edit is one undo step.
 */

import type { AIToolContext, ExtensionAITool, ExtensionToolResult } from '@nimbalyst/extension-sdk';
import { isFormulaText, type SheetState } from '../commands/sheetState';
import { rewriteFormulaForStructuralEdit } from '../structure/rewriteFormula';
import type { StructuralEdit } from '../structure/structuralEdit';
import { columnIndexToLetter } from '../utils/csvParser';
import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, parseColumnLetter } from './a1';
import { MAX_STRUCTURAL_COUNT, flashWritten, positiveCount, usedSize, withAgent } from './toolSupport';

type Kind = 'insertRows' | 'deleteRows' | 'insertCols' | 'deleteCols';

/** How the edit changes the formulas that survive it. */
function formulaImpact(state: SheetState, edit: StructuralEdit) {
  const removed = (index: number) => index >= edit.at && index < edit.at + edit.count;
  let rewritten = 0;
  let broken = 0;
  for (const [r, row] of state.rows.entries()) {
    if (edit.type === 'deleteRows' && removed(r)) continue;
    for (const [c, value] of row.entries()) {
      if (edit.type === 'deleteCols' && removed(c)) continue;
      if (!isFormulaText(value)) continue;
      const next = rewriteFormulaForStructuralEdit(value, edit);
      if (next === value) continue;
      rewritten += 1;
      if (next.includes('#REF!') && !value.includes('#REF!')) broken += 1;
    }
  }
  return { formulasRewritten: rewritten, formulasBrokenToRef: broken };
}

function parseRowNumber(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_SHEET_ROWS) {
    throw new Error(`row must be a 1-based row number; got ${JSON.stringify(value)}`);
  }
  return (value as number) - 1;
}

function label(kind: Kind, at: number, count: number): string {
  if (kind === 'insertRows' || kind === 'deleteRows') return `${at + 1}:${at + count}`;
  return `${columnIndexToLetter(at)}:${columnIndexToLetter(at + count - 1)}`;
}

async function runStructural(kind: Kind, params: Record<string, unknown>, context: AIToolContext): Promise<ExtensionToolResult> {
  return withAgent(context, async (agent) => {
    const rows = kind === 'insertRows' || kind === 'deleteRows';
    const at = rows ? parseRowNumber(params.row) : parseColumnLetter(params.column);
    const count = positiveCount(params.count, 'count');
    if (!rows && at + count > MAX_SHEET_COLUMNS) throw new Error('The edit reaches past the last column of the sheet');

    let impact = { formulasRewritten: 0, formulasBrokenToRef: 0 };
    let width = 0;
    let height = 0;
    const edit = { type: kind, at, count } as StructuralEdit;
    const result = await agent.run(({ state }) => {
      const used = usedSize(state);
      width = used.cols;
      height = used.rows;
      const limit = rows ? used.rows : used.cols;
      const unit = rows ? 'row' : 'column';
      const name = (index: number) => (rows ? String(index + 1) : columnIndexToLetter(index));
      if (kind.startsWith('insert') && at > limit) {
        throw new Error(`Cannot insert before ${unit} ${name(at)}; the sheet ends at ${unit} ${name(limit - 1)}, so insert at ${name(limit)} or earlier`);
      }
      // Inserting pushes everything after `at` along, so the whole extent has to fit.
      const axisMax = rows ? MAX_SHEET_ROWS : MAX_SHEET_COLUMNS;
      if (kind.startsWith('insert') && limit + count > axisMax) {
        throw new Error(`Inserting ${count} ${unit}(s) would push the sheet past the last ${unit} (${rows ? MAX_SHEET_ROWS : columnIndexToLetter(MAX_SHEET_COLUMNS - 1)}); it already uses ${limit}`);
      }
      if (kind.startsWith('delete') && at + count > limit) {
        throw new Error(`Cannot delete ${unit}s ${label(kind, at, count)}; the sheet ends at ${unit} ${name(Math.max(0, limit - 1))}`);
      }
      impact = formulaImpact(state, edit);
      return { type: 'structural', edit };
    });

    if (kind === 'insertRows') {
      const cells = [];
      for (let r = at; r < at + count; r += 1) for (let c = 0; c < width; c += 1) cells.push({ row: r, column: c });
      await flashWritten(agent, cells);
    } else if (kind === 'insertCols') {
      const cells = [];
      for (let r = 0; r < height; r += 1) for (let c = at; c < at + count; c += 1) cells.push({ row: r, column: c });
      await flashWritten(agent, cells);
    }

    const { meta } = result.after.state;
    return {
      [kind.startsWith('insert') ? 'inserted' : 'deleted']: label(kind, at, count),
      count,
      ...impact,
      headerRowCount: meta.headerRowCount,
      frozenColumnCount: meta.frozenColumnCount,
      columnCount: meta.columnCount,
    };
  });
}

const countSchema = { type: 'number' as const, default: 1, description: `How many, 1 to ${MAX_STRUCTURAL_COUNT}.` };
const rowSchema = { type: 'number' as const, description: '1-based row number (header rows included).' };
const columnSchema = { type: 'string' as const, description: 'Column letter, e.g. "C".' };
const REWRITE_NOTE = 'Formulas that reference shifted cells are rewritten, and header rows, frozen columns, column formats and cell styles move with their cells. One undo step.';

function structuralTool(kind: Kind, name: string, description: string): ExtensionAITool {
  const rows = kind === 'insertRows' || kind === 'deleteRows';
  return {
    name,
    scope: 'global',
    access: { kind: 'editor-write' },
    description: `${description} ${REWRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: rows ? { row: rowSchema, count: countSchema } : { column: columnSchema, count: countSchema },
      required: [rows ? 'row' : 'column'],
    },
    handler: (params, context) => runStructural(kind, params, context),
  };
}

export const structuralTools: ExtensionAITool[] = [
  structuralTool('insertRows', 'csv-spreadsheet.insert_rows', 'Insert blank rows so the first new row has the given row number. Use the row after the last used row to append.'),
  structuralTool('deleteRows', 'csv-spreadsheet.delete_rows', 'Delete count rows starting at the given row number. Formulas that pointed only into deleted rows become #REF! (reported in formulasBrokenToRef).'),
  structuralTool('insertCols', 'csv-spreadsheet.insert_cols', 'Insert blank columns so the first new column has the given letter. Use the column after the last used column to append.'),
  structuralTool('deleteCols', 'csv-spreadsheet.delete_cols', 'Delete count columns starting at the given column letter. Formulas that pointed only into deleted columns become #REF! (reported in formulasBrokenToRef).'),
];
