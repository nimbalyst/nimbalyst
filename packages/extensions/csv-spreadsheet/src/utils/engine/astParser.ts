/**
 * Recursive-descent formula parser and AST walkers.
 */

import {
  FORMULA_LIMITS,
  FormulaParseError,
  type BinaryOperator,
  type FormulaAst,
  type FormulaReference,
  type FormulaReferenceArea,
  type Token,
} from './ast';
import { parseCellReference, tokenize } from './tokenizer';
import { NAMED_RANGE_REF_ERROR, resolveName } from './names';

/**
 * `namedRanges` turns a defined name into the range it names, so everything
 * downstream (dependencies, incremental recalc, evaluation) sees a plain
 * reference. An undefined name stays a `name` node and evaluates to `#NAME?`.
 */
export function parseFormulaExpression(expression: string, namedRanges?: Readonly<Record<string, string>>): FormulaAst {
  if (expression.length > FORMULA_LIMITS.maxFormulaLength) {
    throw new FormulaParseError('#LIMIT!');
  }

  const ast = new FormulaParser(tokenize(expression), namedRanges).parse();
  validateAstBudgets(ast);
  return ast;
}

/** The node a defined name stands for: its range, or `#REF!` once the range was deleted. */
function namedRangeNode(target: string): FormulaAst {
  if (target !== NAMED_RANGE_REF_ERROR) {
    try {
      const ast = new FormulaParser(tokenize(target)).parse();
      if (ast.type === 'reference' || ast.type === 'range') return ast;
    } catch {
      // A hand-edited target that is not a range reads as a broken reference.
    }
  }
  return { type: 'error', code: '#REF!' };
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
      case 'error':
        break;
    }
  };

  visit(ast);
  return references;
}

class FormulaParser {
  private index = 0;
  private parseDepth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly namedRanges?: Readonly<Record<string, string>>,
  ) {}

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

    if (token.kind === 'error') {
      this.index += 1;
      return { type: 'error', code: token.code };
    }

    if (token.kind === 'axisRange') {
      // No cell-count budget here: the open axis is clamped to the used range
      // at evaluation, which is where the range budget is charged.
      this.index += 1;
      return { type: 'range', start: token.start, end: token.end, axis: token.axis };
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
      const target = resolveName(this.namedRanges, name);
      return target === undefined ? { type: 'name', name } : namedRangeNode(target);
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
      case 'error':
      case 'reference':
      case 'range':
        break;
    }
  }
}
