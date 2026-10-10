/**
 * Shared plumbing for the spreadsheet agent tools.
 *
 * Tools run against the mounted editor (`editor-read` / `editor-write`
 * access): the host mounts a hidden editor when the file is not open, so the
 * same command path, undo stack and collab publication apply either way.
 */

import type { AIToolContext, ExtensionToolResult } from '@nimbalyst/extension-sdk';
import type { AgentSheetView, SpreadsheetAgentAccess, SpreadsheetEditorAPI } from '../editorAPI';
import { contentRowCount, type SheetState } from '../commands/sheetState';
import { columnIndexToLetter } from '../utils/csvParser';
import { cellName } from './a1';

/** Most cells one call may read or write; matches apply_formula's limit. */
export const MAX_TOOL_CELLS = 10_000;
/** Longest text returned for one cell before it is cut. */
export const MAX_RETURNED_TEXT = 1_000;
/** Longest value one cell may be written with. */
export const MAX_CELL_TEXT = 32_767;
export const MAX_FORMULA_LENGTH = 8_192;
/** Most rows or columns one structural call may insert or delete. */
export const MAX_STRUCTURAL_COUNT = 1_000;
/** Most cells a write flashes; past this the flash is noise. */
export const MAX_FLASH_CELLS = 2_000;

export function getAgent(context: AIToolContext): SpreadsheetAgentAccess | null {
  return (context.editorAPI as SpreadsheetEditorAPI | undefined)?.agent ?? null;
}

export function getEditor(context: AIToolContext): SpreadsheetEditorAPI | null {
  return (context.editorAPI as SpreadsheetEditorAPI | undefined) ?? null;
}

export function noEditorError(context: AIToolContext): ExtensionToolResult {
  const path = context.activeFilePath;
  return {
    success: false,
    error: path
      ? `Could not connect to the spreadsheet editor for ${path}. Try the tool again after the editor finishes loading.`
      : 'No spreadsheet file was provided. Pass filePath for an existing .csv or .tsv file.',
  };
}

export function errorResult(error: unknown): ExtensionToolResult {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

/** Run a tool body against the agent surface, turning throws into error results. */
export async function withAgent(
  context: AIToolContext,
  body: (agent: SpreadsheetAgentAccess) => Promise<Record<string, unknown>>,
): Promise<ExtensionToolResult> {
  const agent = getAgent(context);
  if (!agent) return noEditorError(context);
  try {
    return { success: true, data: await body(agent) };
  } catch (error) {
    return errorResult(error);
  }
}

/** Rows and columns that hold anything (never fewer than the declared columns). */
export function usedSize(state: SheetState): { rows: number; cols: number } {
  const rows = Math.max(state.meta.headerRowCount, contentRowCount(state.rows));
  let cols = state.meta.columnCount;
  for (let r = 0; r < rows; r += 1) {
    const row = state.rows[r] ?? [];
    for (let c = row.length - 1; c >= cols; c -= 1) {
      if (row[c] !== '') { cols = c + 1; break; }
    }
  }
  return { rows, cols };
}

export function clipText<T>(value: T): T | string {
  if (typeof value !== 'string' || value.length <= MAX_RETURNED_TEXT) return value;
  return `${value.slice(0, MAX_RETURNED_TEXT)}… [truncated ${value.length - MAX_RETURNED_TEXT} chars]`;
}

/** Header label for a column: the last non-blank header cell, else its letter. */
export function columnName(view: AgentSheetView, col: number): string {
  for (let row = view.state.meta.headerRowCount - 1; row >= 0; row -= 1) {
    const label = view.display(row, col);
    if (label !== null && String(label).trim() !== '') return String(clipText(String(label).trim()));
  }
  return columnIndexToLetter(col);
}

export function positiveCount(value: unknown, name: string, max = MAX_STRUCTURAL_COUNT): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}; got ${JSON.stringify(value)}`);
  }
  return value as number;
}

/** Flash written cells, at most `MAX_FLASH_CELLS` of them. */
export async function flashWritten(
  agent: SpreadsheetAgentAccess,
  cells: readonly { row: number; column: number }[],
): Promise<void> {
  await agent.flash(cells.length > MAX_FLASH_CELLS ? cells.slice(0, MAX_FLASH_CELLS) : cells);
}

/** Up to `limit` cells as `{ cell, raw, displayed }` for a tool result. */
export function sampleCells(
  view: AgentSheetView,
  cells: readonly { row: number; column: number }[],
  limit = 10,
) {
  return cells.slice(0, limit).map(({ row, column }) => ({
    cell: cellName(row, column),
    raw: clipText(view.state.rows[row]?.[column] ?? ''),
    displayed: clipText(view.display(row, column)),
  }));
}
