import { splitCalcSheetDocument } from './frontmatter';
import type {
  CalcFormatterSpec,
  CalcSheetBinding,
  CalcSheetLine,
  ParsedCalcSheetDocument,
} from './types';

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function splitFormatter(raw: string): { expression: string; formatter: string | null } {
  let depth = 0;
  let inString = false;

  for (let i = 0; i < raw.length - 1; i++) {
    const char = raw[i];
    const next = raw[i + 1];
    if (char === '"' && raw[i - 1] !== '\\') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '(' || char === '[' || char === '{') depth++;
    if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && char === '-' && next === '>') {
      return {
        expression: raw.slice(0, i).trim(),
        formatter: raw.slice(i + 2).trim(),
      };
    }
  }

  return {
    expression: raw.trim(),
    formatter: null,
  };
}

function splitArguments(raw: string): string[] {
  if (!raw.trim()) return [];
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"' && raw[i - 1] !== '\\') {
      inString = !inString;
      current += char;
      continue;
    }
    if (!inString && (char === '(' || char === '[' || char === '{')) {
      depth++;
      current += char;
      continue;
    }
    if (!inString && (char === ')' || char === ']' || char === '}')) {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (!inString && depth === 0 && char === ',') {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

function parseFormatter(raw: string | null): CalcFormatterSpec | null {
  if (!raw) return null;
  const match = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)$/);
  if (!match) {
    return {
      name: raw,
      args: [],
    };
  }

  return {
    name: match[1],
    args: splitArguments(match[2]),
  };
}

function parseBinding(raw: string): CalcSheetBinding | null {
  const eqIndex = raw.indexOf('=');
  if (eqIndex <= 0) return null;
  const left = raw.slice(0, eqIndex).trim();
  if (!IDENTIFIER_REGEX.test(left)) return null;

  const right = raw.slice(eqIndex + 1).trim();
  if (!right) return null;

  const { expression, formatter } = splitFormatter(right);
  if (!expression) return null;

  return {
    name: left,
    expression,
    formatter: parseFormatter(formatter),
  };
}

function parseLine(raw: string, index: number): CalcSheetLine {
  if (!raw.trim()) {
    return { index, raw, kind: 'blank' };
  }
  if (/^\s*\/\//.test(raw)) {
    return { index, raw, kind: 'comment' };
  }

  const sectionMatch = raw.match(/^\s*#{1,6}\s+(.*)$/);
  if (sectionMatch) {
    return {
      index,
      raw,
      kind: 'section',
      sectionTitle: sectionMatch[1].trim(),
    };
  }

  const assertMatch = raw.match(/^\s*assert\s+(.+)$/);
  if (assertMatch) {
    return {
      index,
      raw,
      kind: 'assert',
      assertion: { expression: assertMatch[1].trim() },
    };
  }

  const binding = parseBinding(raw);
  if (binding) {
    return {
      index,
      raw,
      kind: 'binding',
      binding,
    };
  }

  return {
    index,
    raw,
    kind: 'unknown',
    parseError: 'Unrecognized line',
  };
}

export function parseCalcSheetDocument(content: string): ParsedCalcSheetDocument {
  const base = splitCalcSheetDocument(content);
  const lines = base.body
    .split(/\r?\n/)
    .map((line, index) => parseLine(line, index));
  return {
    ...base,
    lines,
  };
}
