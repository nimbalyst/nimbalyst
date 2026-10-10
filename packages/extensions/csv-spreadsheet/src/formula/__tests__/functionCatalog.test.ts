// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { getSupportedFunctions } from '../../utils/formulaEngine';
import { FUNCTION_CATALOG, getFunctionEntry, paramIndexForArgument } from '../functionCatalog';

describe('function catalog', () => {
  it('has exactly one entry per function the engine accepts', () => {
    expect([...FUNCTION_CATALOG.keys()].sort()).toEqual(getSupportedFunctions());
  });

  it('maps arguments past the signature onto the repeating group', () => {
    const sumifs = getFunctionEntry('sumifs')!;
    const names = [0, 1, 2, 3, 4, 5, 6].map((index) => sumifs.params[paramIndexForArgument(sumifs, index)].name);
    expect(names).toEqual([
      'sum_range', 'criteria_range1', 'criterion1', 'criteria_range2', 'criterion2', 'criteria_range2', 'criterion2',
    ]);
    expect(paramIndexForArgument(getFunctionEntry('ROUND')!, 2)).toBe(-1);
  });
});
