import type { StructuralEdit } from '../structure/structuralEdit';
import { shiftRangeRecord } from '../conditional/rangeKeys';
import type { ValidationRules } from './types';

/**
 * Validation rules rewritten for a structural edit. Each range key follows its
 * cells (see `shiftRangeKey`): rules on fully deleted ranges are dropped, and a
 * range split by a move yields one entry per piece. Entry order is preserved
 * because later entries win; if two land on the same key, the later rule
 * replaces the earlier one and takes the later position.
 */
export function shiftValidationRulesForStructuralEdit(
  rules: ValidationRules,
  edit: StructuralEdit,
): ValidationRules {
  return shiftRangeRecord(rules, edit);
}
