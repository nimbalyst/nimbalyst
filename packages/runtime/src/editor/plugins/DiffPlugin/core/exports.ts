/**
 * Core exports from the diff functionality
 */

// Core diff types
export type { Change } from './diffPluginUtils';

// Plugin utilities (needed for React plugin and toolbar)
export {
  $approveDiffs,
  $hasDiffNodes,
  $rejectDiffs,
  $approveChangeGroup,
  $rejectChangeGroup,
  APPLY_DIFF_COMMAND,
  APPROVE_DIFF_COMMAND,
  REJECT_DIFF_COMMAND,
  CLEAR_DIFF_TAG_COMMAND,
  INCREMENTAL_APPROVAL_COMMAND,
} from './diffPluginUtils';

// DiffState utilities for diff tracking
export {
  $getDiffState,
  $setDiffState,
  $clearDiffState,
  $hasDiffState,
  LiveNodeKeyState,
} from './DiffState';
export type { DiffStateType } from './DiffState';

// Main API - the primary entry point
export { applyMarkdownDiff, applyMarkdownReplace } from './diffUtils';
export type { TextReplacement, TextReplacementInput } from './diffUtils';

// Testing utilities
export { NodeStructureValidator } from './NodeStructureValidator';
export { generateUnifiedDiff } from './standardDiffFormat';

export { diffHandlerRegistry } from '../handlers';
export { NoopDiffHandler } from '../handlers/NoopDiffHandler';

export { DiffError } from './DiffError';

// Change grouping for approval bar
export { groupDiffChanges, scrollToChangeGroup } from './diffChangeGroups';
export type { DiffChangeGroup } from './diffChangeGroups';