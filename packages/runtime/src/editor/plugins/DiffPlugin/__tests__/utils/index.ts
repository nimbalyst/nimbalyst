
// Re-export test configuration
export * from './testConfig';

// Re-export diff test utilities
export {
  setupMarkdownDiffTest,
  setupMarkdownDiffTestLegacy,
  assertDiffApplied,
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
  getAllNodes,
  hasDiffMarkers,
  getEditorTextContent
} from './diffTestUtils';

// Export types separately to comply with isolatedModules
export type {
  ComprehensiveDiffTestResult,
  DiffTestOptions,
  DiffTestResult
} from './diffTestUtils';

// Re-export replace test utilities with renamed functions to avoid conflicts
export {
  setupMarkdownReplaceTest,
  assertApproveProducesTarget as assertApproveProducesTargetReplace,
  assertRejectProducesOriginal as assertRejectProducesOriginalReplace
} from './replaceTestUtils';

// Export replace test types
export type {
  ComprehensiveReplaceTestResult,
  ReplaceTestOptions
} from './replaceTestUtils';

// Re-export tree debug utilities
export {
  printEditorTree,
  printDiffStateSummary
} from './treeDebugUtils';
