/**
 * Formula parser facade. The implementation lives in `./engine/`:
 * `ast.ts` (types, limits, errors), `tokenizer.ts`, and `astParser.ts`.
 */

export {
  FORMULA_LIMITS,
  FormulaParseError,
  type BinaryOperator,
  type FormulaAst,
  type FormulaErrorCode,
  type FormulaReference,
  type FormulaReferenceArea,
} from './engine/ast';
export { parseCellReference } from './engine/tokenizer';
export { collectReferenceAreas, parseFormulaExpression } from './engine/astParser';
