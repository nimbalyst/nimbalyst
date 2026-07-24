import { evaluateCalcSheet } from '../evaluator';
import { parseCalcSheetDocument } from '../parser';
import {
  buildCalcSheetSelectionContextItems,
  MAX_CALC_SHEET_CONTEXT_ITEMS,
} from '../selectionContext';

describe('calc sheet selection context', () => {
  it('maps the selected formula line to a bounded AI context item', () => {
    const parsed = parseCalcSheetDocument([
      'price = 149 USD',
      'seats = 120',
      'mrr = price * seats -> currency(USD, 0)',
    ].join('\n'));
    const evaluation = evaluateCalcSheet(parsed.lines, parsed.frontmatter);

    const items = buildCalcSheetSelectionContextItems({
      parsed,
      evaluation,
      selection: { startLineNumber: 3, endLineNumber: 3 },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'calc-sheet-cell:3',
      label: 'L3 · mrr',
      icon: 'functions',
      groupLabel: 'calc sheet cells',
      includeData: true,
      data: {
        lineNumber: 3,
        kind: 'binding',
        binding: {
          name: 'mrr',
          expression: 'price * seats',
        },
        evaluation: {
          classification: 'formula',
          formatted: '$17,880',
          dependencies: ['price', 'seats'],
        },
      },
    });
    expect(items[0].description).toContain('Result: $17,880.');
    expect(() => JSON.stringify(items[0].data)).not.toThrow();
  });

  it('returns one item per meaningful selected line and ignores headings and blanks', () => {
    const parsed = parseCalcSheetDocument([
      '# Inputs',
      '',
      'price = 149 USD',
      'seats = 120',
      'assert price > 0 USD',
    ].join('\n'));
    const evaluation = evaluateCalcSheet(parsed.lines, parsed.frontmatter);

    const items = buildCalcSheetSelectionContextItems({
      parsed,
      evaluation,
      selection: { startLineNumber: 1, endLineNumber: 5 },
    });

    expect(items.map((item) => item.id)).toEqual([
      'calc-sheet-cell:3',
      'calc-sheet-cell:4',
      'calc-sheet-cell:5',
    ]);
    expect(items[2]).toMatchObject({
      label: 'L5 · assertion',
      icon: 'fact_check',
      data: {
        kind: 'assert',
        evaluation: { passed: true },
      },
    });
  });

  it('keeps a stable cell id while refreshing a selected formula result', () => {
    const initial = parseCalcSheetDocument('price = 100 USD');
    const updated = parseCalcSheetDocument('price = 125 USD');
    const selection = { startLineNumber: 1, endLineNumber: 1 };
    const [initialItem] = buildCalcSheetSelectionContextItems({
      parsed: initial,
      evaluation: evaluateCalcSheet(initial.lines, initial.frontmatter),
      selection,
    });
    const [updatedItem] = buildCalcSheetSelectionContextItems({
      parsed: updated,
      evaluation: evaluateCalcSheet(updated.lines, updated.frontmatter),
      selection,
    });

    expect(updatedItem.id).toBe(initialItem.id);
    expect(updatedItem.description).not.toBe(initialItem.description);
    expect(updatedItem.description).toContain('Result: $125.00.');
  });

  it('maps collaborative Monaco line numbers past the hidden frontmatter', () => {
    const parsed = parseCalcSheetDocument([
      '---',
      'baseCurrency: USD',
      '---',
      '',
      'price = 149 USD',
      'total = price * 2',
    ].join('\n'));
    const evaluation = evaluateCalcSheet(parsed.lines, parsed.frontmatter);

    expect(buildCalcSheetSelectionContextItems({
      parsed,
      evaluation,
      selection: { startLineNumber: parsed.bodyStartLine + 2, endLineNumber: parsed.bodyStartLine + 2 },
      modelLineOffset: parsed.bodyStartLine,
    })[0]?.label).toBe('L2 · price');
    expect(buildCalcSheetSelectionContextItems({
      parsed,
      evaluation,
      selection: { startLineNumber: 2, endLineNumber: 2 },
      modelLineOffset: parsed.bodyStartLine,
    })).toEqual([]);
  });

  it('includes malformed selected formulas without exposing unbounded text', () => {
    const hostile = `not a formula ${'x'.repeat(5_000)}\u0000secret`;
    const parsed = parseCalcSheetDocument(hostile);
    const evaluation = evaluateCalcSheet(parsed.lines, parsed.frontmatter);

    const [item] = buildCalcSheetSelectionContextItems({
      parsed,
      evaluation,
      selection: { startLineNumber: 1, endLineNumber: 1 },
    });
    const serialized = JSON.stringify(item.data);

    expect(item).toMatchObject({
      id: 'calc-sheet-cell:1',
      label: 'L1 · invalid formula',
      icon: 'warning',
      includeData: true,
    });
    expect(item.description.length).toBeLessThanOrEqual(1_600);
    expect(serialized.length).toBeLessThan(2_000);
    expect(serialized).not.toContain('\u0000');
  });

  it('caps large selections and reports how many formula cells were omitted', () => {
    const content = Array.from(
      { length: MAX_CALC_SHEET_CONTEXT_ITEMS + 5 },
      (_, index) => `value_${index} = ${index}`,
    ).join('\n');
    const parsed = parseCalcSheetDocument(content);
    const evaluation = evaluateCalcSheet(parsed.lines, parsed.frontmatter);

    const items = buildCalcSheetSelectionContextItems({
      parsed,
      evaluation,
      selection: { startLineNumber: 1, endLineNumber: parsed.lines.length },
    });

    expect(items).toHaveLength(MAX_CALC_SHEET_CONTEXT_ITEMS + 1);
    expect(items.at(-1)).toMatchObject({
      label: '+5 more cells',
      icon: 'more_horiz',
      data: { omittedItemCount: 5 },
    });
  });

  it('clears context for an empty or non-formula selection', () => {
    const parsed = parseCalcSheetDocument('# Inputs\n\n// note');
    const evaluation = evaluateCalcSheet(parsed.lines, parsed.frontmatter);

    expect(buildCalcSheetSelectionContextItems({
      parsed,
      evaluation,
      selection: null,
    })).toEqual([]);
    expect(buildCalcSheetSelectionContextItems({
      parsed,
      evaluation,
      selection: { startLineNumber: 1, endLineNumber: 3 },
    })).toEqual([]);
  });
});
