/**
 * Test for larger document with section reordering
 * Tests diff handling when "Best Practices" section is moved from later in doc to after Overview
 */

import { describe, it, expect } from 'vitest';
import { largeDocumentDiff } from '../../utils/largeDocumentDiff';

describe('Larger document with section additions', () => {
  it('should handle large document diff without errors', () => {
    /**
     * Tests that large documents with section reordering work correctly.
     * The larger test files have HorizontalRuleNodes (***) throughout.
     * This ensures all node types can receive diff states properly.
     */

    const { result } = largeDocumentDiff('test');
    expect(result.success, result.errors.join('\n')).toBe(true);

    // Verify diff states were applied (not all unchanged)
    const nodesWithDiffState = result.withDiff.nodes.filter(n => n.diffState !== null);
    expect(nodesWithDiffState.length, 'Should have nodes with diff states applied').toBeGreaterThan(0);

    // Verify that "Best Practices" content appears in the diff somewhere
    // It might be marked as added, removed, or modified depending on how the diff algorithm handles section moves
    const bestPracticesNodes = result.withDiff.nodes.filter(n =>
      n.text.includes('Best Practices')
    );

    expect(bestPracticesNodes.length, 'Should have Best Practices nodes').toBeGreaterThan(0);

    // At least one Best Practices node should have a diff state
    const bestPracticesWithDiff = bestPracticesNodes.filter(n => n.diffState !== null);
    expect(bestPracticesWithDiff.length, 'Best Practices should be marked as changed').toBeGreaterThan(0);

    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });
});
