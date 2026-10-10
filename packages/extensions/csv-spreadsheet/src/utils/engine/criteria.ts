/**
 * Linear-time replacements for formula.js criteria functions (COUNTIF, SUMIFS,
 * MATCH, ...). formula.js compiles criteria into expressions and wildcards into
 * regular expressions; these match them directly with bounded work.
 */

import { FORMULA_LIMITS } from './ast';
import { FormulaEvaluationError, normalizeErrorCode } from './errors';

export function linearMatch(lookupValue: unknown, lookupArray: unknown, matchType: unknown = 1): number {
  const values = flattenFormulaValues(lookupArray);
  const normalizedMatchType = Number(matchType);
  if (!lookupArray || ![-1, 0, 1].includes(normalizedMatchType)) {
    throw new FormulaEvaluationError('#N/A');
  }

  let candidateIndex = -1;
  let candidateValue: unknown;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (normalizedMatchType === 0) {
      const matches = typeof lookupValue === 'string' && typeof value === 'string'
        ? linearGlobMatch(lookupValue, value)
        : value === lookupValue;
      if (matches) return index + 1;
      continue;
    }

    if (value === lookupValue) return index + 1;
    const comparison = compareCriteriaValues(value, lookupValue);
    const isCandidate = normalizedMatchType === 1 ? comparison < 0 : comparison > 0;
    if (!isCandidate) continue;
    if (
      candidateIndex < 0
      || (normalizedMatchType === 1 && compareCriteriaValues(value, candidateValue) > 0)
      || (normalizedMatchType === -1 && compareCriteriaValues(value, candidateValue) < 0)
    ) {
      candidateIndex = index;
      candidateValue = value;
    }
  }

  if (candidateIndex >= 0) return candidateIndex + 1;
  throw new FormulaEvaluationError('#N/A');
}

export function linearCountIf(range: unknown, criteria: unknown): number {
  return flattenFormulaValues(range).filter((value) => matchesCriteria(value, criteria)).length;
}

export function linearCountIfs(...args: unknown[]): number {
  const { ranges, criteria, length } = parseCriteriaPairs(args);
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    if (ranges.every((range, rangeIndex) => matchesCriteria(range[index], criteria[rangeIndex]))) {
      count += 1;
    }
  }
  return count;
}

export function linearSumIf(range: unknown, criteria: unknown, sumRange?: unknown): number {
  const criteriaValues = flattenFormulaValues(range);
  const sumValues = sumRange === undefined ? criteriaValues : flattenFormulaValues(sumRange);
  let sum = 0;
  for (let index = 0; index < criteriaValues.length; index += 1) {
    if (matchesCriteria(criteriaValues[index], criteria)) sum += aggregateNumber(sumValues[index]);
  }
  return sum;
}

export function linearSumIfs(sumRange: unknown, ...args: unknown[]): number {
  const sumValues = flattenFormulaValues(sumRange);
  const { ranges, criteria, length } = parseCriteriaPairs(args, sumValues.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    if (ranges.every((range, rangeIndex) => matchesCriteria(range[index], criteria[rangeIndex]))) {
      sum += aggregateNumber(sumValues[index]);
    }
  }
  return sum;
}

export function linearAverageIf(range: unknown, criteria: unknown, averageRange?: unknown): number {
  const criteriaValues = flattenFormulaValues(range);
  const averageValues = averageRange === undefined
    ? criteriaValues
    : flattenFormulaValues(averageRange);
  const matches: number[] = [];
  for (let index = 0; index < criteriaValues.length; index += 1) {
    if (matchesCriteria(criteriaValues[index], criteria)) {
      const value = finiteAggregateNumber(averageValues[index]);
      if (value !== null) matches.push(value);
    }
  }
  if (matches.length === 0) throw new FormulaEvaluationError('#DIV/0!');
  return matches.reduce((sum, value) => sum + value, 0) / matches.length;
}

export function linearAverageIfs(averageRange: unknown, ...args: unknown[]): number {
  const averageValues = flattenFormulaValues(averageRange);
  const { ranges, criteria, length } = parseCriteriaPairs(args, averageValues.length);
  const matches: number[] = [];
  for (let index = 0; index < length; index += 1) {
    if (ranges.every((range, rangeIndex) => matchesCriteria(range[index], criteria[rangeIndex]))) {
      const value = finiteAggregateNumber(averageValues[index]);
      if (value !== null) matches.push(value);
    }
  }
  if (matches.length === 0) throw new FormulaEvaluationError('#DIV/0!');
  return matches.reduce((sum, value) => sum + value, 0) / matches.length;
}

export function linearExtremaIfs(kind: 'min' | 'max', extremaRange: unknown, ...args: unknown[]): number {
  const extremaValues = flattenFormulaValues(extremaRange);
  const { ranges, criteria, length } = parseCriteriaPairs(args, extremaValues.length);
  const matches: number[] = [];
  for (let index = 0; index < length; index += 1) {
    if (ranges.every((range, rangeIndex) => matchesCriteria(range[index], criteria[rangeIndex]))) {
      const value = finiteAggregateNumber(extremaValues[index]);
      if (value !== null) matches.push(value);
    }
  }
  if (matches.length === 0) return 0;
  return kind === 'max' ? Math.max(...matches) : Math.min(...matches);
}

function parseCriteriaPairs(
  args: unknown[],
  expectedLength?: number
): { ranges: unknown[][]; criteria: unknown[]; length: number } {
  if (args.length === 0 || args.length % 2 !== 0) throw new FormulaEvaluationError('#VALUE!');
  const ranges: unknown[][] = [];
  const criteria: unknown[] = [];
  for (let index = 0; index < args.length; index += 2) {
    ranges.push(flattenFormulaValues(args[index]));
    criteria.push(args[index + 1]);
  }
  const length = expectedLength ?? ranges[0].length;
  if (ranges.some((range) => range.length !== length)) throw new FormulaEvaluationError('#VALUE!');
  return { ranges, criteria, length };
}

function matchesCriteria(value: unknown, criteria: unknown): boolean {
  if (criteria instanceof Error) throw new FormulaEvaluationError(normalizeErrorCode(criteria.message));
  if (typeof criteria !== 'string') return value === criteria;
  if (criteria.length > FORMULA_LIMITS.maxFormulaLength) throw new FormulaEvaluationError('#LIMIT!');

  const operatorMatch = /^(<=|>=|<>|=|<|>)(.*)$/s.exec(criteria);
  const operator = operatorMatch?.[1] ?? '=';
  const operandText = operatorMatch?.[2] ?? criteria;
  const numericOperand = operandText.trim() === '' ? null : Number(operandText);
  const numericValue = typeof value === 'number' ? value : Number(value);
  const bothNumeric = numericOperand !== null
    && Number.isFinite(numericOperand)
    && Number.isFinite(numericValue)
    && value !== null
    && value !== '';

  if ((operator === '=' || operator === '<>') && containsGlob(operandText)) {
    const matches = typeof value === 'string' && linearGlobMatch(operandText, value);
    return operator === '=' ? matches : !matches;
  }

  const comparison = bothNumeric
    ? numericValue - numericOperand
    : compareCriteriaValues(value, operandText);
  switch (operator) {
    case '=': return comparison === 0;
    case '<>': return comparison !== 0;
    case '<': return comparison < 0;
    case '>': return comparison > 0;
    case '<=': return comparison <= 0;
    case '>=': return comparison >= 0;
    default: return false;
  }
}

function containsGlob(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' || character === '?') return true;
    if (character === '~' && ['*', '?', '~'].includes(pattern[index + 1] ?? '')) return true;
  }
  return false;
}

function linearGlobMatch(pattern: string, input: string): boolean {
  if (pattern.length > FORMULA_LIMITS.maxFormulaLength) throw new FormulaEvaluationError('#LIMIT!');
  const tokens: Array<string | '*' | '?'> = [];
  const normalizedPattern = pattern.toLocaleLowerCase();
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (
      character === '~'
      && index + 1 < normalizedPattern.length
      && ['*', '?', '~'].includes(normalizedPattern[index + 1])
    ) {
      tokens.push(normalizedPattern[index + 1]);
      index += 1;
    } else if (character === '*' || character === '?') {
      if (character !== '*' || tokens[tokens.length - 1] !== '*') tokens.push(character);
    } else {
      tokens.push(character);
    }
  }

  const text = input.toLocaleLowerCase();
  let tokenIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let starTextIndex = -1;
  while (textIndex < text.length) {
    const token = tokens[tokenIndex];
    if (token === '?' || token === text[textIndex]) {
      tokenIndex += 1;
      textIndex += 1;
    } else if (token === '*') {
      starIndex = tokenIndex;
      starTextIndex = textIndex;
      tokenIndex += 1;
    } else if (starIndex >= 0) {
      tokenIndex = starIndex + 1;
      starTextIndex += 1;
      textIndex = starTextIndex;
    } else {
      return false;
    }
  }
  while (tokens[tokenIndex] === '*') tokenIndex += 1;
  return tokenIndex === tokens.length;
}

function flattenFormulaValues(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [value];
  const flattened: unknown[] = [];
  const pending = [...value].reverse();
  while (pending.length > 0) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) pending.push(item[index]);
    } else {
      flattened.push(item);
    }
  }
  return flattened;
}

function aggregateNumber(value: unknown): number {
  return finiteAggregateNumber(value) ?? 0;
}

function finiteAggregateNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compareCriteriaValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  const leftText = left === null || left === undefined ? '' : String(left).toLocaleLowerCase();
  const rightText = right === null || right === undefined ? '' : String(right).toLocaleLowerCase();
  return leftText.localeCompare(rightText);
}
