import type { EditorContextItem } from '@nimbalyst/extension-sdk';

import type { CalcSheetLine, EvaluatedCalcSheet, ParsedCalcSheetDocument } from './types';

const TEXT_LIMIT = 320;
const DESCRIPTION_LIMIT = 1_600;
const MAX_DEPENDENCIES = 32;
export const MAX_CALC_SHEET_CONTEXT_ITEMS = 24;

export interface CalcSheetSelectionRange {
  startLineNumber: number;
  endLineNumber: number;
}

export interface BuildCalcSheetSelectionContextItemsOptions {
  parsed: ParsedCalcSheetDocument;
  evaluation: EvaluatedCalcSheet;
  selection: CalcSheetSelectionRange | null;
  modelLineOffset?: number;
}

function bounded(value: unknown, limit = TEXT_LIMIT): string {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 14))}… [truncated]`;
}

function boundedDependencies(values: readonly string[]): string[] {
  return values.slice(0, MAX_DEPENDENCIES).map((value) => bounded(value, 120));
}

function bindingItem(
  line: CalcSheetLine,
  evaluation: EvaluatedCalcSheet,
): EditorContextItem | null {
  if (!line.binding) return null;

  const lineNumber = line.index + 1;
  const name = bounded(line.binding.name, 160);
  const expression = bounded(line.binding.expression, 800);
  const result = evaluation.bindings.get(line.binding.name);
  const dependencies = boundedDependencies(result?.dependencies ?? []);
  const description = bounded([
    `Selected calc sheet ${result?.classification ?? 'formula'} "${name}" at line ${lineNumber}.`,
    `Expression: ${expression}.`,
    result?.formatted ? `Result: ${bounded(result.formatted, 320)}.` : '',
    dependencies.length > 0 ? `Dependencies: ${dependencies.join(', ')}.` : '',
    result?.error ? `Error: ${bounded(result.error, 480)}.` : '',
    `Source: ${bounded(line.raw, 800)}.`,
  ].filter(Boolean).join(' '), DESCRIPTION_LIMIT);

  return {
    id: `calc-sheet-cell:${lineNumber}`,
    label: bounded(`L${lineNumber} · ${name}`, 120),
    icon: 'functions',
    groupLabel: 'calc sheet cells',
    description,
    data: {
      lineNumber,
      kind: 'binding',
      source: bounded(line.raw, 800),
      binding: {
        name,
        expression,
        formatter: line.binding.formatter
          ? {
              name: bounded(line.binding.formatter.name, 120),
              args: line.binding.formatter.args.slice(0, 16).map((arg) => bounded(arg, 160)),
            }
          : null,
      },
      evaluation: result
        ? {
            classification: result.classification,
            formatted: bounded(result.formatted, 320),
            dependencies,
            error: result.error ? bounded(result.error, 480) : null,
          }
        : null,
    },
    includeData: true,
  };
}

function assertionItem(
  line: CalcSheetLine,
  parsed: ParsedCalcSheetDocument,
  evaluation: EvaluatedCalcSheet,
): EditorContextItem | null {
  if (!line.assertion) return null;

  const lineNumber = line.index + 1;
  const assertionIndex = parsed.lines
    .slice(0, line.index + 1)
    .filter((candidate) => candidate.kind === 'assert').length - 1;
  const result = evaluation.assertions[assertionIndex];
  const expression = bounded(line.assertion.expression, 800);
  const dependencies = boundedDependencies(result?.dependencies ?? []);

  return {
    id: `calc-sheet-cell:${lineNumber}`,
    label: `L${lineNumber} · assertion`,
    icon: 'fact_check',
    groupLabel: 'calc sheet cells',
    description: bounded([
      `Selected calc sheet assertion at line ${lineNumber}.`,
      `Expression: ${expression}.`,
      result ? `Result: ${result.passed ? 'passed' : 'failed'} (${bounded(result.formatted, 320)}).` : '',
      dependencies.length > 0 ? `Dependencies: ${dependencies.join(', ')}.` : '',
      result?.error ? `Error: ${bounded(result.error, 480)}.` : '',
      `Source: ${bounded(line.raw, 800)}.`,
    ].filter(Boolean).join(' '), DESCRIPTION_LIMIT),
    data: {
      lineNumber,
      kind: 'assert',
      source: bounded(line.raw, 800),
      assertion: { expression },
      evaluation: result
        ? {
            passed: result.passed,
            formatted: bounded(result.formatted, 320),
            dependencies,
            error: result.error ? bounded(result.error, 480) : null,
          }
        : null,
    },
    includeData: true,
  };
}

function invalidFormulaItem(line: CalcSheetLine): EditorContextItem | null {
  if (line.kind !== 'unknown') return null;
  const lineNumber = line.index + 1;
  const source = bounded(line.raw, 800);
  const parseError = bounded(line.parseError || 'Unrecognized formula', 480);
  return {
    id: `calc-sheet-cell:${lineNumber}`,
    label: `L${lineNumber} · invalid formula`,
    icon: 'warning',
    groupLabel: 'calc sheet cells',
    description: bounded(
      `Selected invalid calc sheet formula at line ${lineNumber}. Error: ${parseError}. Source: ${source}.`,
      DESCRIPTION_LIMIT,
    ),
    data: {
      lineNumber,
      kind: 'unknown',
      source,
      parseError,
    },
    includeData: true,
  };
}

function buildLineItem(
  line: CalcSheetLine,
  parsed: ParsedCalcSheetDocument,
  evaluation: EvaluatedCalcSheet,
): EditorContextItem | null {
  if (line.kind === 'binding') return bindingItem(line, evaluation);
  if (line.kind === 'assert') return assertionItem(line, parsed, evaluation);
  if (line.kind === 'unknown') return invalidFormulaItem(line);
  return null;
}

export function buildCalcSheetSelectionContextItems({
  parsed,
  evaluation,
  selection,
  modelLineOffset = 0,
}: BuildCalcSheetSelectionContextItemsOptions): EditorContextItem[] {
  if (!selection) return [];

  const firstModelLine = Math.min(selection.startLineNumber, selection.endLineNumber);
  const lastModelLine = Math.max(selection.startLineNumber, selection.endLineNumber);
  const firstBodyIndex = Math.max(0, firstModelLine - modelLineOffset - 1);
  const lastBodyIndex = Math.min(parsed.lines.length - 1, lastModelLine - modelLineOffset - 1);
  if (lastBodyIndex < firstBodyIndex) return [];

  const items: EditorContextItem[] = [];
  let meaningfulLineCount = 0;
  for (let index = firstBodyIndex; index <= lastBodyIndex; index += 1) {
    const item = buildLineItem(parsed.lines[index], parsed, evaluation);
    if (!item) continue;
    meaningfulLineCount += 1;
    if (items.length < MAX_CALC_SHEET_CONTEXT_ITEMS) items.push(item);
  }

  const omittedItemCount = meaningfulLineCount - items.length;
  if (omittedItemCount > 0) {
    const firstLineNumber = firstBodyIndex + 1;
    const lastLineNumber = lastBodyIndex + 1;
    items.push({
      id: `calc-sheet-selection:${firstLineNumber}-${lastLineNumber}:omitted`,
      label: `+${omittedItemCount} more cells`,
      icon: 'more_horiz',
      groupLabel: 'calc sheet cells',
      description: `The selection from calc sheet lines ${firstLineNumber}-${lastLineNumber} contains ${omittedItemCount} additional formula cells omitted from structured context.`,
      data: {
        firstLineNumber,
        lastLineNumber,
        omittedItemCount,
      },
      includeData: true,
    });
  }
  return items;
}
