export type CalcSheetSyntaxTokenKind =
  | 'comment'
  | 'heading-marker'
  | 'heading-text'
  | 'keyword'
  | 'variable-definition'
  | 'variable'
  | 'unit'
  | 'function'
  | 'formatter'
  | 'number'
  | 'operator';

export interface CalcSheetSyntaxToken {
  start: number;
  end: number;
  kind: CalcSheetSyntaxTokenKind;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const UNIT_SEQUENCE = /((?:[A-Za-z][A-Za-z0-9_]*)(?:\^\d+)?(?:\s*[/*]\s*[A-Za-z][A-Za-z0-9_]*(?:\^\d+)?)*)/y;

const KEYWORDS = new Set(['assert', 'true', 'false']);
const BUILTIN_FUNCTIONS = new Set([
  'abs',
  'ceil',
  'exp',
  'floor',
  'log',
  'log10',
  'max',
  'min',
  'pow',
  'round',
  'sign',
  'sqrt',
  'to',
]);

function pushToken(
  tokens: CalcSheetSyntaxToken[],
  start: number,
  end: number,
  kind: CalcSheetSyntaxTokenKind,
): void {
  if (end <= start) return;
  tokens.push({ start, end, kind });
}

function skipString(line: string, start: number): number {
  const quote = line[start];
  let cursor = start + 1;

  while (cursor < line.length) {
    if (line[cursor] === quote && line[cursor - 1] !== '\\') {
      return cursor + 1;
    }
    cursor++;
  }

  return line.length;
}

function scanIdentifier(
  line: string,
  start: number,
): { end: number; value: string } | null {
  IDENTIFIER.lastIndex = start;
  const match = IDENTIFIER.exec(line);
  if (!match || match.index !== start) return null;
  return {
    end: start + match[0].length,
    value: match[0],
  };
}

function scanNumber(line: string, start: number): { end: number; value: string } | null {
  NUMBER.lastIndex = start;
  const match = NUMBER.exec(line);
  if (!match || match.index !== start) return null;
  return {
    end: start + match[0].length,
    value: match[0],
  };
}

function scanUnit(line: string, start: number): { start: number; end: number } | null {
  let cursor = start;
  while (cursor < line.length && /\s/.test(line[cursor])) {
    cursor++;
  }

  UNIT_SEQUENCE.lastIndex = cursor;
  const match = UNIT_SEQUENCE.exec(line);
  if (!match || match.index !== cursor) return null;

  return {
    start: cursor,
    end: cursor + match[1].length,
  };
}

function nextNonWhitespaceIndex(line: string, start: number): number {
  let cursor = start;
  while (cursor < line.length && /\s/.test(line[cursor])) {
    cursor++;
  }
  return cursor;
}

function scanExpression(
  line: string,
  start: number,
  tokens: CalcSheetSyntaxToken[],
): void {
  let cursor = start;
  let expectFormatter = false;

  while (cursor < line.length) {
    const char = line[cursor];

    if (/\s/.test(char)) {
      cursor++;
      continue;
    }

    if (line.startsWith('->', cursor)) {
      pushToken(tokens, cursor, cursor + 2, 'operator');
      cursor += 2;
      expectFormatter = true;
      continue;
    }

    if (char === '"' || char === '\'') {
      cursor = skipString(line, cursor);
      expectFormatter = false;
      continue;
    }

    const number = scanNumber(line, cursor);
    if (number) {
      pushToken(tokens, cursor, number.end, 'number');
      cursor = number.end;
      const unit = scanUnit(line, cursor);
      if (unit) {
        pushToken(tokens, unit.start, unit.end, 'unit');
        cursor = unit.end;
      }
      expectFormatter = false;
      continue;
    }

    const identifier = scanIdentifier(line, cursor);
    if (identifier) {
      const nextIndex = nextNonWhitespaceIndex(line, identifier.end);
      const isCall = line[nextIndex] === '(';

      let kind: CalcSheetSyntaxTokenKind = 'variable';
      if (expectFormatter) {
        kind = 'formatter';
      } else if (KEYWORDS.has(identifier.value)) {
        kind = 'keyword';
      } else if (isCall || BUILTIN_FUNCTIONS.has(identifier.value)) {
        kind = 'function';
      }

      pushToken(tokens, cursor, identifier.end, kind);
      cursor = identifier.end;
      expectFormatter = false;
      continue;
    }

    if ('=+-*/^><'.includes(char)) {
      pushToken(tokens, cursor, cursor + 1, 'operator');
      cursor++;
      expectFormatter = false;
      continue;
    }

    cursor++;
    expectFormatter = false;
  }
}

export function tokenizeCalcSheetLine(line: string): CalcSheetSyntaxToken[] {
  const tokens: CalcSheetSyntaxToken[] = [];

  const commentMatch = line.match(/^(\s*)(\/\/.*)$/);
  if (commentMatch) {
    const start = commentMatch[1].length;
    pushToken(tokens, start, line.length, 'comment');
    return tokens;
  }

  const headingMatch = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
  if (headingMatch) {
    const markerStart = headingMatch[1].length;
    const markerEnd = markerStart + headingMatch[2].length;
    const textStart = markerEnd + headingMatch[3].length;
    pushToken(tokens, markerStart, markerEnd, 'heading-marker');
    pushToken(tokens, textStart, line.length, 'heading-text');
    return tokens;
  }

  const assertMatch = line.match(/^(\s*)(assert)\b/);
  if (assertMatch) {
    const keywordStart = assertMatch[1].length;
    const keywordEnd = keywordStart + assertMatch[2].length;
    pushToken(tokens, keywordStart, keywordEnd, 'keyword');
    scanExpression(line, keywordEnd, tokens);
    return tokens;
  }

  const bindingMatch = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)(=)/);
  if (bindingMatch) {
    const nameStart = bindingMatch[1].length;
    const nameEnd = nameStart + bindingMatch[2].length;
    const operatorStart = nameEnd + bindingMatch[3].length;
    const operatorEnd = operatorStart + bindingMatch[4].length;
    pushToken(tokens, nameStart, nameEnd, 'variable-definition');
    pushToken(tokens, operatorStart, operatorEnd, 'operator');
    scanExpression(line, operatorEnd, tokens);
    return tokens;
  }

  scanExpression(line, 0, tokens);
  return tokens;
}
