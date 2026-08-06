import { columnLetterToIndex } from './csvParser';

export type FormulaErrorCode =
  | '#VALUE!'
  | '#NAME?'
  | '#REF!'
  | '#DIV/0!'
  | '#CIRC!'
  | '#ERROR!'
  | '#N/A'
  | '#NUM!'
  | '#NULL!'
  | '#LIMIT!';

export const FORMULA_LIMITS = {
  maxFormulaLength: 8_192,
  maxReferenceRows: 1_048_576,
  maxReferenceColumns: 16_384,
  maxAstDepth: 64,
  maxAstNodes: 2_048,
  maxDependencyDepth: 256,
  maxRangeCells: 100_000,
  maxEvaluationOperations: 10_000,
  maxDependencyScanCells: 500_000,
} as const;

export interface FormulaReference {
  col: number;
  row: number;
  colAbsolute: boolean;
  rowAbsolute: boolean;
}

export type BinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '^'
  | '&'
  | '='
  | '<>'
  | '<'
  | '>'
  | '<='
  | '>=';

export type FormulaAst =
  | { type: 'literal'; value: string | number | boolean }
  | { type: 'name'; name: string }
  | { type: 'reference'; reference: FormulaReference }
  | { type: 'range'; start: FormulaReference; end: FormulaReference }
  | { type: 'unary'; operator: '+' | '-'; operand: FormulaAst }
  | { type: 'percent'; operand: FormulaAst }
  | { type: 'binary'; operator: BinaryOperator; left: FormulaAst; right: FormulaAst }
  | { type: 'call'; name: string; args: FormulaAst[] };

export interface FormulaReferenceArea {
  start: FormulaReference;
  end: FormulaReference;
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'identifier'; value: string }
  | { kind: 'reference'; value: string }
  | { kind: 'operator'; value: BinaryOperator | '%' }
  | { kind: 'leftParen' }
  | { kind: 'rightParen' }
  | { kind: 'comma' }
  | { kind: 'colon' }
  | { kind: 'eof' };

export class FormulaParseError extends Error {
  constructor(readonly code: FormulaErrorCode = '#VALUE!') {
    super(code);
  }
}

const CELL_REFERENCE_PATTERN = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/;
const WORD_CHARACTER_PATTERN = /[A-Za-z0-9_.$]/;

export function parseCellReference(reference: string): FormulaReference | null {
  const match = CELL_REFERENCE_PATTERN.exec(reference);
  if (!match) return null;

  // Excel-compatible bounds also keep conversion of attacker-controlled digit/letter runs finite.
  if (match[2].length > 3 || match[4].length > 7) return null;

  const rowNumber = Number.parseInt(match[4], 10);
  const col = columnLetterToIndex(match[2]);
  if (
    !Number.isFinite(rowNumber)
    || rowNumber < 1
    || rowNumber > FORMULA_LIMITS.maxReferenceRows
    || !Number.isFinite(col)
    || col < 0
    || col >= FORMULA_LIMITS.maxReferenceColumns
  ) {
    return null;
  }

  return {
    col,
    row: rowNumber - 1,
    colAbsolute: match[1] === '$',
    rowAbsolute: match[3] === '$',
  };
}

export function parseFormulaExpression(expression: string): FormulaAst {
  if (expression.length > FORMULA_LIMITS.maxFormulaLength) {
    throw new FormulaParseError('#LIMIT!');
  }

  const ast = new FormulaParser(tokenize(expression)).parse();
  validateAstBudgets(ast);
  return ast;
}

export function collectReferenceAreas(ast: FormulaAst): FormulaReferenceArea[] {
  const references: FormulaReferenceArea[] = [];

  const visit = (node: FormulaAst): void => {
    switch (node.type) {
      case 'reference':
        references.push({ start: node.reference, end: node.reference });
        break;
      case 'range':
        references.push({ start: node.start, end: node.end });
        break;
      case 'unary':
      case 'percent':
        visit(node.operand);
        break;
      case 'binary':
        visit(node.left);
        visit(node.right);
        break;
      case 'call':
        node.args.forEach(visit);
        break;
      case 'literal':
      case 'name':
        break;
    }
  };

  visit(ast);
  return references;
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const character = expression[index];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === '"') {
      const result = readString(expression, index + 1);
      tokens.push({ kind: 'string', value: result.value });
      index = result.nextIndex;
      continue;
    }

    if (/\d/.test(character) || (character === '.' && /\d/.test(expression[index + 1] ?? ''))) {
      const result = readNumber(expression, index);
      tokens.push({ kind: 'number', value: result.value });
      index = result.nextIndex;
      continue;
    }

    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (end < expression.length && WORD_CHARACTER_PATTERN.test(expression[end])) {
        end += 1;
      }

      const word = expression.slice(index, end);
      if (CELL_REFERENCE_PATTERN.test(word)) {
        tokens.push({ kind: 'reference', value: word });
      } else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(word)) {
        tokens.push({ kind: 'identifier', value: word });
      } else {
        throw new FormulaParseError(word.includes('$') ? '#REF!' : '#VALUE!');
      }
      index = end;
      continue;
    }

    const pair = expression.slice(index, index + 2);
    if (pair === '<>' || pair === '<=' || pair === '>=') {
      tokens.push({ kind: 'operator', value: pair });
      index += 2;
      continue;
    }

    if ('+-*/^%&=<>'.includes(character)) {
      tokens.push({ kind: 'operator', value: character as BinaryOperator | '%' });
      index += 1;
      continue;
    }

    if (character === '(') tokens.push({ kind: 'leftParen' });
    else if (character === ')') tokens.push({ kind: 'rightParen' });
    else if (character === ',') tokens.push({ kind: 'comma' });
    else if (character === ':') tokens.push({ kind: 'colon' });
    else throw new FormulaParseError();
    index += 1;
  }

  tokens.push({ kind: 'eof' });
  return tokens;
}

function readString(expression: string, startIndex: number): { value: string; nextIndex: number } {
  let value = '';
  let index = startIndex;

  while (index < expression.length) {
    const character = expression[index];
    if (character === '"') {
      if (expression[index + 1] === '"') {
        value += '"';
        index += 2;
        continue;
      }
      return { value, nextIndex: index + 1 };
    }

    if (character === '\\' && expression[index + 1] === '"') {
      value += '"';
      index += 2;
      continue;
    }

    value += character;
    index += 1;
  }

  throw new FormulaParseError();
}

function readNumber(expression: string, startIndex: number): { value: number; nextIndex: number } {
  let index = startIndex;
  while (/\d/.test(expression[index] ?? '')) index += 1;

  if (expression[index] === '.') {
    index += 1;
    while (/\d/.test(expression[index] ?? '')) index += 1;
  }

  if (/[eE]/.test(expression[index] ?? '')) {
    const exponentStart = index;
    index += 1;
    if (/[+-]/.test(expression[index] ?? '')) index += 1;
    const digitStart = index;
    while (/\d/.test(expression[index] ?? '')) index += 1;
    if (digitStart === index) index = exponentStart;
  }

  const value = Number(expression.slice(startIndex, index));
  if (!Number.isFinite(value)) throw new FormulaParseError();
  return { value, nextIndex: index };
}

class FormulaParser {
  private index = 0;
  private parseDepth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): FormulaAst {
    const ast = this.parseComparison();
    if (this.current().kind !== 'eof') throw new FormulaParseError();
    return ast;
  }

  private parseComparison(): FormulaAst {
    let left = this.parseConcatenation();
    while (this.isOperator('=', '<>', '<', '>', '<=', '>=')) {
      const operator = this.consumeOperator() as BinaryOperator;
      left = { type: 'binary', operator, left, right: this.parseConcatenation() };
    }
    return left;
  }

  private parseConcatenation(): FormulaAst {
    let left = this.parseAdditive();
    while (this.isOperator('&')) {
      const operator = this.consumeOperator() as '&';
      left = { type: 'binary', operator, left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): FormulaAst {
    let left = this.parseMultiplicative();
    while (this.isOperator('+', '-')) {
      const operator = this.consumeOperator() as '+' | '-';
      left = { type: 'binary', operator, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): FormulaAst {
    let left = this.parseUnary();
    while (this.isOperator('*', '/')) {
      const operator = this.consumeOperator() as '*' | '/';
      left = { type: 'binary', operator, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): FormulaAst {
    return this.withParseDepth(() => {
      if (this.isOperator('+', '-')) {
        const operator = this.consumeOperator() as '+' | '-';
        return { type: 'unary', operator, operand: this.parseUnary() };
      }
      return this.parsePower();
    });
  }

  private parsePower(): FormulaAst {
    const left = this.parsePercent();
    if (!this.isOperator('^')) return left;
    this.consumeOperator();
    return { type: 'binary', operator: '^', left, right: this.parseUnary() };
  }

  private parsePercent(): FormulaAst {
    let expression = this.parsePrimary();
    while (this.isOperator('%')) {
      this.consumeOperator();
      expression = { type: 'percent', operand: expression };
    }
    return expression;
  }

  private parsePrimary(): FormulaAst {
    const token = this.current();

    if (token.kind === 'number' || token.kind === 'string') {
      this.index += 1;
      return { type: 'literal', value: token.value };
    }

    if (token.kind === 'reference') {
      this.index += 1;
      const start = parseCellReference(token.value);
      if (!start) throw new FormulaParseError('#REF!');

      if (this.current().kind !== 'colon') return { type: 'reference', reference: start };
      this.index += 1;
      const endToken = this.current();
      if (endToken.kind !== 'reference') throw new FormulaParseError('#REF!');
      this.index += 1;
      const end = parseCellReference(endToken.value);
      if (!end) throw new FormulaParseError('#REF!');
      if (rangeCellCount(start, end) > FORMULA_LIMITS.maxRangeCells) {
        throw new FormulaParseError('#LIMIT!');
      }
      return { type: 'range', start, end };
    }

    if (token.kind === 'identifier') {
      this.index += 1;
      const name = token.value.toUpperCase();
      if (this.current().kind === 'leftParen') return this.parseCall(name);
      if (name === 'TRUE' || name === 'FALSE') {
        return { type: 'literal', value: name === 'TRUE' };
      }
      return { type: 'name', name };
    }

    if (token.kind === 'leftParen') {
      this.index += 1;
      const expression = this.parseComparison();
      this.expect('rightParen');
      return expression;
    }

    throw new FormulaParseError();
  }

  private parseCall(name: string): FormulaAst {
    this.expect('leftParen');
    const args: FormulaAst[] = [];

    if (this.current().kind !== 'rightParen') {
      do {
        args.push(this.parseComparison());
        if (this.current().kind !== 'comma') break;
        this.index += 1;
        if (this.current().kind === 'rightParen') throw new FormulaParseError();
      } while (this.current().kind !== 'rightParen');
    }

    this.expect('rightParen');
    return { type: 'call', name, args };
  }

  private current(): Token {
    return this.tokens[this.index];
  }

  private isOperator(...operators: Array<BinaryOperator | '%'>): boolean {
    const token = this.current();
    return token.kind === 'operator' && operators.includes(token.value);
  }

  private consumeOperator(): BinaryOperator | '%' {
    const token = this.current();
    if (token.kind !== 'operator') throw new FormulaParseError();
    this.index += 1;
    return token.value;
  }

  private expect(kind: Token['kind']): void {
    if (this.current().kind !== kind) throw new FormulaParseError();
    this.index += 1;
  }

  private withParseDepth<T>(parse: () => T): T {
    this.parseDepth += 1;
    if (this.parseDepth > FORMULA_LIMITS.maxAstDepth) {
      throw new FormulaParseError('#LIMIT!');
    }
    try {
      return parse();
    } finally {
      this.parseDepth -= 1;
    }
  }
}

function rangeCellCount(start: FormulaReference, end: FormulaReference): number {
  return (Math.abs(end.row - start.row) + 1) * (Math.abs(end.col - start.col) + 1);
}

function validateAstBudgets(ast: FormulaAst): void {
  const pending: Array<{ node: FormulaAst; depth: number }> = [{ node: ast, depth: 1 }];
  let nodeCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    nodeCount += 1;
    if (
      nodeCount > FORMULA_LIMITS.maxAstNodes
      || current.depth > FORMULA_LIMITS.maxAstDepth
    ) {
      throw new FormulaParseError('#LIMIT!');
    }

    const nextDepth = current.depth + 1;
    switch (current.node.type) {
      case 'unary':
      case 'percent':
        pending.push({ node: current.node.operand, depth: nextDepth });
        break;
      case 'binary':
        pending.push(
          { node: current.node.left, depth: nextDepth },
          { node: current.node.right, depth: nextDepth }
        );
        break;
      case 'call':
        for (const argument of current.node.args) {
          pending.push({ node: argument, depth: nextDepth });
        }
        break;
      case 'literal':
      case 'name':
      case 'reference':
      case 'range':
        break;
    }
  }
}
