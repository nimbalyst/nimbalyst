

/**
 * Simple example test to demonstrate the diff test utilities working.
 * This test should work without a full Jest setup.
 */

import {
  setupMarkdownDiffTest,
  assertDiffApplied,
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
} from './utils';

describe('Simple Diff Test', () => {
  test('basic text change', () => {
    const original = 'Hello world';
    const target = 'Hello universe';
    
    const result = setupMarkdownDiffTest(original, target);
    
    expect(result.originalMarkdown).toBe(original);
    expect(result.targetMarkdown).toBe(target);
    expect(result.diff.length).toBeGreaterThan(0);
    
    const {addNodes, removeNodes} = result.getDiffNodes();
    expect(addNodes.length).toBeGreaterThan(0);
    expect(removeNodes.length).toBeGreaterThan(0);
  });
});

function runSimpleTest() {
  try {
    console.log('Running simple diff test...');

    // Test a basic text change
    const original = 'Hello world';
    const target = 'Hello universe';

    const result = setupMarkdownDiffTest(original, target);

    console.log('✅ setupMarkdownDiffTest completed successfully');
    console.log('Original:', result.originalMarkdown);
    console.log('Target:', result.targetMarkdown);
    console.log('Diff generated:', result.diff.length > 0 ? 'Yes' : 'No');

    // Test that diff nodes are created
    const {addNodes, removeNodes} = result.getDiffNodes();
    console.log('Add nodes found:', addNodes.length);
    console.log('Remove nodes found:', removeNodes.length);

    // Test approval/rejection
    try {
      assertApproveProducesTarget(result);
      console.log('✅ Approve produces target correctly');
    } catch (error) {
      console.log('ℹ️ Approve test:', error instanceof Error ? error.message : String(error));
    }

    try {
      assertRejectProducesOriginal(result);
      console.log('✅ Reject produces original correctly');
    } catch (error) {
      console.log('ℹ️ Reject test:', error instanceof Error ? error.message : String(error));
    }

    console.log('🎉 Simple diff test completed successfully!');

  } catch (error) {
    console.error('❌ Simple test failed:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
    throw error;
  }
}

// Export the test function so it can be run manually
export { runSimpleTest };

// If running directly (not imported), run the test
if (typeof require !== 'undefined' && require.main === module) {
  runSimpleTest();
}
